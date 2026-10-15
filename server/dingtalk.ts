import { createHash } from 'node:crypto';
import { DingTalkConfigSchema, type DingTalkConfig, type DingTalkRecord, type DingTalkSnapshot } from '../shared/dingtalk';
import type { Store } from './store';
import type { SessionManager } from './sessions';
import type { Json } from '../shared/types';

export const DINGTALK_TOPIC = '/v1.0/im/bot/messages/get';
const OPEN = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
const TTL = 10 * 60_000;
export interface StreamSocket {
  readyState: number; send(data: string): unknown; close(): unknown;
  addEventListener(type: string, listener: (event: any) => void): void;
}
export class DingTalkNotifications {
  status: DingTalkSnapshot['status'] = 'disabled'; error = '';
  lastSender?: DingTalkSnapshot['lastSender'];
  private generation = 0; private socket?: StreamSocket; private request?: AbortController;
  private retry?: ReturnType<typeof setTimeout>; private timer: ReturnType<typeof setInterval>;
  private active?: Promise<void>; private controller?: AbortController;
  private closed = false;
  constructor(private store: Store, private manager: SessionManager, private network: {
    fetch: typeof fetch; socket: (url: string) => StreamSocket;
  } = { fetch: globalThis.fetch, socket: url => new WebSocket(url) as unknown as StreamSocket }) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS dingtalk_notifications (
      id TEXT PRIMARY KEY, created INTEGER NOT NULL, deviceId TEXT NOT NULL,
      sender TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
    ); UPDATE dingtalk_notifications SET state='unknown', error='服务重启，未重复播报' WHERE state='playing';`);
    this.timer = setInterval(() => { void this.drain(); }, 1000); this.timer.unref();
  }
  config(): DingTalkConfig { return DingTalkConfigSchema.parse(this.store.get('dingtalk') || {}); }
  snapshot(): DingTalkSnapshot {
    const { clientSecret, ...config } = this.config();
    return { config: { ...config, hasSecret: !!clientSecret }, status: this.status, error: this.error, lastSender: this.lastSender,
      records: this.store.db.query('SELECT * FROM dingtalk_notifications ORDER BY created DESC, rowid DESC LIMIT 50').all() as DingTalkRecord[] };
  }
  save(input: unknown) {
    const old = this.config();
    const next = DingTalkConfigSchema.parse(input);
    if (!next.clientSecret) {
      if (next.clientId !== old.clientId && old.clientSecret) throw new Error('更换 Client ID 时请填写对应的 Client Secret');
      next.clientSecret = old.clientSecret;
    }
    if (next.enabled && (!next.clientId || !next.clientSecret || !next.deviceId)) throw new Error('启用前请填写 Client ID、Client Secret 并选择目标设备');
    if (next.deviceId && !this.store.devices.has(next.deviceId)) throw new Error('请选择已登记的目标设备');
    this.store.set('dingtalk', next);
    this.store.db.query("UPDATE dingtalk_notifications SET state='skipped', error='设置已变更，未继续播报' WHERE state='queued'").run();
    this.restart(); return this.snapshot();
  }
  restart() {
    this.closed = false; const generation = ++this.generation;
    clearTimeout(this.retry); this.request?.abort(); const socket = this.socket; this.socket = undefined; socket?.close();
    this.controller?.abort(); this.error = '';
    if (!this.config().enabled) { this.status = 'disabled'; return; }
    this.status = 'connecting'; void this.connect(generation);
  }
  private reconnect(generation: number) {
    if (this.closed || generation !== this.generation) return;
    this.request?.abort(); const socket = this.socket; this.socket = undefined; socket?.close();
    this.status = 'reconnecting'; this.error = 'Stream 连接中断或失败，请检查应用凭据、机器人发布状态和网络';
    clearTimeout(this.retry); this.retry = setTimeout(() => { void this.connect(generation); }, 5000); this.retry.unref();
  }
  private async connect(generation: number) {
    if (this.closed || generation !== this.generation) return;
    const controller = new AbortController(); this.request = controller;
    try {
      const c = this.config();
      const response = await this.network.fetch(OPEN, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        body: JSON.stringify({ clientId: c.clientId, clientSecret: c.clientSecret, subscriptions: [{ type: 'CALLBACK', topic: DINGTALK_TOPIC }], ua: 'xiaozhi-selfhost/0.1', localIp: '' }) });
      if (!response.ok) throw new Error('Stream 注册失败');
      const connection = await response.json() as Json; const endpoint = new URL(connection.endpoint);
      if (endpoint.protocol !== 'wss:' || !endpoint.hostname.endsWith('.dingtalk.com') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || typeof connection.ticket !== 'string' || !connection.ticket) throw new Error('无效的 Stream 网关');
      if (generation !== this.generation || this.closed) return;
      endpoint.searchParams.set('ticket', connection.ticket);
      const socket = this.network.socket(endpoint.toString()); this.socket = socket;
      const handshake = setTimeout(() => { if (this.socket === socket && socket.readyState !== 1) this.reconnect(generation); }, 15000); handshake.unref();
      socket.addEventListener('open', () => { clearTimeout(handshake); if (generation !== this.generation || this.closed || this.socket !== socket) { socket.close(); return; } this.status = 'connected'; this.error = ''; });
      socket.addEventListener('message', event => {
        if (generation !== this.generation || this.closed || this.socket !== socket) return;
        try { this.frame(event.data, socket); } catch { this.error = '收到无法处理的 Stream 消息'; }
      });
      socket.addEventListener('close', () => { clearTimeout(handshake); if (this.socket === socket) this.reconnect(generation); });
      socket.addEventListener('error', () => { clearTimeout(handshake); if (this.socket === socket) this.reconnect(generation); });
    } catch { if (!controller.signal.aborted) this.reconnect(generation); }
  }
  frame(raw: unknown, socket: StreamSocket) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 256 * 1024) throw new Error('Stream 消息大小无效');
    const frame = JSON.parse(raw) as Json; const headers = frame.headers || {};
    const data = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data || {};
    let code = 200;
    if (frame.type === 'CALLBACK' && headers.topic === DINGTALK_TOPIC) {
      try { this.receive(data); } catch { code = 500; }
    }
    socket.send(JSON.stringify({ code, headers: { messageId: headers.messageId, contentType: 'application/json' }, message: code === 200 ? 'OK' : 'busy', data: JSON.stringify(frame.type === 'SYSTEM' ? data : { response: null }) }));
    if (frame.type === 'SYSTEM' && headers.topic === 'disconnect') socket.close();
  }
  receive(message: Json) {
    const c = this.config();
    if (!c.enabled || !message || message.msgtype !== 'text' || !['1', '2'].includes(String(message.conversationType))) return;
    if (String(message.conversationType) === '2' && message.isInAtList !== true) return;
    const conversationId = typeof message.conversationId === 'string' ? message.conversationId : '';
    const userId = typeof message.senderStaffId === 'string' ? message.senderStaffId : typeof message.senderId === 'string' ? message.senderId : '';
    this.lastSender = { conversationId, userId };
    if ((c.conversationId && conversationId !== c.conversationId) || (c.userIds.length && !c.userIds.includes(userId))) return;
    const text = typeof message.text?.content === 'string' ? message.text.content.trim() : '';
    const created = Number(message.createAt);
    if (!text || text.length > 4000 || typeof message.msgId !== 'string' || !message.msgId || !Number.isFinite(created) || created > Date.now() + 60_000 || Date.now() - created > TTL) return;
    const id = createHash('sha256').update(JSON.stringify([c.clientId, message.senderCorpId, conversationId, message.msgId])).digest('hex');
    if (this.store.db.query('SELECT id FROM dingtalk_notifications WHERE id=?').get(id)) return;
    const pending = this.store.db.query("SELECT COUNT(*) AS count FROM dingtalk_notifications WHERE state='queued'").get() as { count: number };
    if (pending.count >= 50) throw new Error('通知队列已满');
    this.store.db.query("INSERT INTO dingtalk_notifications(id,created,deviceId,sender,text,state) VALUES(?,?,?,?,?,'queued')").run(id, created, c.deviceId, String(message.senderNick || '钉钉用户').slice(0, 100), text);
    this.store.db.query("DELETE FROM dingtalk_notifications WHERE created<? AND state NOT IN ('queued','playing') AND id NOT IN (SELECT id FROM dingtalk_notifications ORDER BY created DESC LIMIT 500)").run(Date.now() - TTL);
    this.store.log('info', '钉钉通知', '收到文本消息，等待设备空闲后播报', c.deviceId);
    void this.drain();
  }
  private update(id: string, state: DingTalkRecord['state'], error = '') { this.store.db.query('UPDATE dingtalk_notifications SET state=?, error=? WHERE id=?').run(state, error, id); }
  async drain() {
    if (this.active || this.closed || !this.config().enabled) return;
    this.store.db.query("UPDATE dingtalk_notifications SET state='expired',error='超过 10 分钟未播报' WHERE state='queued' AND created<?").run(Date.now() - TTL);
    const row = this.store.db.query("SELECT * FROM dingtalk_notifications WHERE state='queued' ORDER BY created,rowid LIMIT 1").get() as DingTalkRecord | null;
    if (!row) return;
    const session = this.manager.sessions.get(row.deviceId);
    if (!session?.alive || session.busy || session.listening) return;
    if (session.link?.audioReady && !session.link.audioReady()) return;
    this.update(row.id, 'playing');
    const controller = new AbortController(); this.controller = controller;
    this.active = (async () => {
      try {
        await this.manager.notify(row.deviceId, row.sender, row.text, controller.signal);
        controller.signal.throwIfAborted(); this.update(row.id, 'played');
        this.store.log('success', '钉钉通知', '通知音频已发送到设备', row.deviceId);
      } catch {
        this.update(row.id, controller.signal.aborted ? 'skipped' : 'failed', controller.signal.aborted ? '播报已取消' : '播报失败，请检查设备连接和 AI / 语音配置');
        if (!controller.signal.aborted) this.store.log('error', '钉钉通知', '通知播报失败，请检查设备连接和 AI / 语音配置', row.deviceId);
      }
    })();
    try { await this.active; } finally { this.active = undefined; if (this.controller === controller) this.controller = undefined; }
  }
  async close() {
    this.closed = true; ++this.generation; clearInterval(this.timer); clearTimeout(this.retry);
    this.request?.abort(); const socket = this.socket; this.socket = undefined; socket?.close(); this.controller?.abort();
    await this.active;
  }
}
