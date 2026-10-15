import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { DingTalkNotifications, DINGTALK_TOPIC, type StreamSocket } from '../server/dingtalk';
import type { SessionManager } from '../server/sessions';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function until(predicate: () => boolean) { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw new Error('timeout'); await Bun.sleep(5); } }
class Socket implements StreamSocket {
  readyState = 0; sent: any[] = []; handlers = new Map<string, ((e: any) => void)[]>();
  addEventListener(type: string, callback: (e: any) => void) { this.handlers.set(type, [...this.handlers.get(type) || [], callback]); }
  emit(type: string, event = {}) { for (const callback of this.handlers.get(type) || []) callback(event); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
}
function setup() {
  const directory = mkdtempSync(`${tmpdir()}/dingtalk-test-`); const store = new Store(directory); store.device('test-device');
  const delivered: any[] = []; const session = { alive: true, busy: false, listening: false };
  const manager = { sessions: new Map([['test-device', session]]), notify: async (...args: any[]) => { delivered.push(args.slice(0, 3)); } } as unknown as SessionManager;
  const sockets: Socket[] = []; const requests: any[] = [];
  const service = new DingTalkNotifications(store, manager, {
    fetch: (async (_: string, init: any) => { requests.push(JSON.parse(init.body)); return Response.json({ endpoint: 'wss://wss-open-connection.dingtalk.com/connect', ticket: 'private-ticket' }); }) as typeof fetch,
    socket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
  });
  cleanups.push(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  service.save({ enabled: true, clientId: 'test-client', clientSecret: 'private-client-secret', deviceId: 'test-device' });
  const message = (id = 'message-1', extra = {}) => ({ msgId: id, createAt: Date.now(), conversationType: '2', conversationId: 'group-1', senderStaffId: 'user-1', senderNick: '测试发送人', isInAtList: true, msgtype: 'text', text: { content: '请提醒我下班取快递' }, ...extra });
  return { store, manager, service, sockets, requests, session, delivered, message };
}

test('Stream registration, ping echo, immediate callback ACK and persistent message dedup', async () => {
  const f = setup(); await until(() => f.sockets.length === 1); const socket = f.sockets[0]!;
  expect(f.requests[0].subscriptions).toEqual([{ type: 'CALLBACK', topic: DINGTALK_TOPIC }]);
  socket.readyState = 1; socket.emit('open'); expect(f.service.status).toBe('connected');
  socket.emit('message', { data: JSON.stringify({ type: 'SYSTEM', headers: { topic: 'ping', messageId: 'ping-1' }, data: '{"opaque":"echo"}' }) });
  expect(JSON.parse(socket.sent[0].data)).toEqual({ opaque: 'echo' });
  const callback = JSON.stringify({ type: 'CALLBACK', headers: { topic: DINGTALK_TOPIC, messageId: 'callback-1' }, data: JSON.stringify(f.message()) });
  socket.emit('message', { data: callback }); socket.emit('message', { data: callback });
  await until(() => f.service.snapshot().records[0]?.state === 'played');
  expect(socket.sent[1].code).toBe(200); expect(socket.sent[1].headers.messageId).toBe('callback-1'); expect(f.delivered).toHaveLength(1);
  f.service.receive(f.message()); expect(f.delivered).toHaveLength(1);
  expect(JSON.stringify(f.service.snapshot())).not.toContain('private-client-secret');
  f.service.save({ ...f.service.snapshot().config, clientSecret: '' }); expect(f.service.config().clientSecret).toBe('private-client-secret');
  expect(() => f.service.save({ ...f.service.snapshot().config, clientId: 'other-client' })).toThrow('更换 Client ID');
});

test('scope filters, group mentions, text-only, timestamp and single-chat support', async () => {
  const f = setup(); f.service.save({ ...f.service.config(), conversationId: 'group-1', userIds: ['user-1'] });
  for (const extra of [{ conversationId: 'other' }, { senderStaffId: 'other' }, { isInAtList: false }, { msgtype: 'image' }, { createAt: Date.now() - 11 * 60_000 }, { createAt: Date.now() + 120_000 }, { createAt: 'invalid' }]) f.service.receive(f.message(crypto.randomUUID(), extra));
  expect(f.service.snapshot().records).toHaveLength(0);
  f.service.receive(f.message('single', { conversationType: '1', isInAtList: false }));
  await until(() => f.service.snapshot().records[0]?.state === 'played'); expect(f.delivered).toHaveLength(1);
});

test('offline and busy devices queue, expire, and configuration changes cancel queued notifications', async () => {
  const f = setup(); f.session.alive = false; f.service.receive(f.message());
  expect(f.service.snapshot().records[0]?.state).toBe('queued'); expect(f.delivered).toHaveLength(0);
  f.session.alive = true; f.session.busy = true; await f.service.drain(); expect(f.delivered).toHaveLength(0);
  f.session.busy = false; f.session.listening = true; await f.service.drain(); expect(f.delivered).toHaveLength(0);
  f.session.listening = false; await f.service.drain(); expect(f.delivered).toHaveLength(1);
  f.session.alive = false; f.service.receive(f.message('expire'));
  f.store.db.query("UPDATE dingtalk_notifications SET created=? WHERE state='queued'").run(Date.now() - 11 * 60_000);
  await f.service.drain(); expect(f.service.snapshot().records.find(r => r.state === 'expired')).toBeDefined();
  f.service.receive(f.message('cancel')); f.service.save({ ...f.service.config(), enabled: false });
  expect(f.service.snapshot().records.find(r => r.state === 'skipped')).toBeDefined(); expect(f.service.status).toBe('disabled');
});

test('callback failure returns retry code; reconnect and old socket messages do not duplicate work', async () => {
  const f = setup(); await until(() => f.sockets.length === 1); const socket = f.sockets[0]!;
  f.session.alive = false;
  for (let i = 0; i < 50; i++) f.service.receive(f.message(`queue-${i}`));
  f.service.frame(JSON.stringify({ type: 'CALLBACK', headers: { topic: DINGTALK_TOPIC, messageId: 'overflow' }, data: JSON.stringify(f.message('overflow')) }), socket);
  expect(socket.sent.at(-1).code).toBe(500);
  socket.emit('error'); expect(f.service.status).toBe('reconnecting');
  f.service.save({ ...f.service.config(), enabled: false });
  socket.emit('message', { data: JSON.stringify({ type: 'CALLBACK', headers: { topic: DINGTALK_TOPIC }, data: JSON.stringify(f.message('late')) }) });
  expect(f.service.snapshot().records).toHaveLength(50); expect(f.service.status).toBe('disabled');
});

test('interrupted playback is marked unknown after restart and never replayed', async () => {
  const f = setup(); f.session.alive = false; f.service.receive(f.message());
  f.store.db.query("UPDATE dingtalk_notifications SET state='playing'").run();
  await f.service.close();
  const next = new DingTalkNotifications(f.store, f.manager); cleanups.unshift(async () => { await next.close(); });
  expect(next.snapshot().records[0]?.state).toBe('unknown'); await next.drain(); expect(f.delivered).toHaveLength(0);
});

test('disabling cancels active delivery; credential redaction applies to generic logs', async () => {
  const f = setup(); let started = false;
  f.manager.notify = async (_id, _sender, _text, signal) => {
    started = true;
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    return 'played';
  };
  f.service.receive(f.message()); await until(() => started);
  expect(f.service.snapshot().records[0]?.state).toBe('playing');
  expect(f.store.redact('error private-client-secret')).toBe('error [已隐藏]');
  f.service.save({ ...f.service.config(), enabled: false });
  await until(() => f.service.snapshot().records[0]?.state === 'skipped');
  await f.service.drain(); expect(f.delivered).toHaveLength(0);
});
