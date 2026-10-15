import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ServerWebSocket } from 'bun';
import { Store } from './store';
import { Providers } from './providers';
import { McpManager } from './mcp';
import { SessionManager, type DeviceSession } from './sessions';
import { startMqtt } from './mqtt';
import { unwrapAudio, wrapAudio } from './protocol';
import { pcmToWav, toPcm } from './audio';
import type { Json, McpEndpoint, Speaker, Snapshot } from '../shared/types';
import { TaskScheduler } from './tasks';
import { BUILTIN_ID } from './builtin-tools';

const deviceIdSchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,80}$/);
const textSchema = z.object({ text: z.string().trim().min(1).max(4000) });
const json = (data: unknown, status = 200) => Response.json(data, { status });
type WsData = { kind: 'events'; listener?: (event: Json) => void } | { kind: 'device'; id: string; version: number; session?: DeviceSession };

export async function startApp(options: { port?: number; mqttPort?: number; udpPort?: number; dataDir?: string; transports?: boolean } = {}) {
  const port = options.port ?? Number(process.env.PORT || 18080); const mqttPort = options.mqttPort ?? Number(process.env.MQTT_PORT || 18883); const udpPort = options.udpPort ?? Number(process.env.UDP_PORT || 18884);
  const store = new Store(options.dataDir); const providers = new Providers(store); const mcp = new McpManager(store); const manager = new SessionManager(store, providers, mcp);
  const tasks = new TaskScheduler(store, (task, signal) => manager.runTask(task.deviceId, task.prompt, signal));
  const root = resolve('dist');
  let mqtt: Awaited<ReturnType<typeof startMqtt>> | undefined;
  let activePort = port;
  function connection(): Snapshot['connection'] { const host = store.settings.publicHost; return { host, port: activePort, mqttPort, udpPort, otaUrl: `http://${host}:${activePort}/xiaozhi/ota/`, websocketUrl: `ws://${host}:${activePort}/xiaozhi/v1/` }; }
  function snapshot(): Snapshot { return { devices: [...store.devices.values()], logs: store.db.query('SELECT * FROM logs ORDER BY id DESC LIMIT 150').all().reverse() as Snapshot['logs'], messages: store.messages(), settings: store.publicSettings(), tasks: tasks.list(), endpoints: store.endpoints().map(e => ({ ...e, token: e.token ? '••••••••' : '' })), speakers: store.speakers(), connection: connection(), health: { ffmpeg: !!Bun.which(process.env.FFMPEG_PATH || 'ffmpeg'), aiConfigured: !!store.settings.llm.apiKey, voiceprintModel: providers.speaker.available() } }; }
  const server = Bun.serve<WsData>({
    port, hostname: '0.0.0.0', maxRequestBodySize: 24 * 1024 * 1024, idleTimeout: 120,
    async fetch(req, server) {
      const url = new URL(req.url); const path = url.pathname;
      const ip = server.requestIP(req)?.address || '';
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
      const origin = req.headers.get('origin');
      const originHost = origin ? (() => { try { return new URL(origin).hostname; } catch { return ''; } })() : '';
      if ((path.startsWith('/api/') || path === '/events') && (!local || (origin && !['localhost', '127.0.0.1', '[::1]'].includes(originHost)))) return json({ error: '管理界面仅允许从本机 localhost 访问' }, 403);
      try {
        if (path === '/health') return json({ status: 'ok', service: 'xiaozhi-local', transports: { websocket: true, mqtt: !!mqtt, udp: !!mqtt } });
        if (path === '/events') { if (server.upgrade(req, { data: { kind: 'events' } })) return; return json({ error: '需要 WebSocket 连接' }, 400); }
        if (path === '/xiaozhi/v1/' || path === '/xiaozhi/v1') {
          const id = deviceIdSchema.parse(req.headers.get('device-id') || url.searchParams.get('device_id'));
          const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
          if (!store.verify(id, token)) return json({ error: '设备凭据无效，请通过刷写页面写入本地配置' }, 401);
          const version = Number(req.headers.get('protocol-version') || 1); if (![1, 2, 3].includes(version)) return json({ error: '不支持的协议版本' }, 400);
          if (manager.sessions.size >= 16 && !manager.sessions.has(id)) return json({ error: '本地设备会话已达上限' }, 503);
          if (server.upgrade(req, { data: { kind: 'device', id, version } })) return; return json({ error: '需要 WebSocket 连接' }, 400);
        }
        if (path === '/xiaozhi/ota/' || path === '/xiaozhi/ota') {
          if (req.method === 'GET') return json({ status: 'ok', message: '本地 OTA 接口运行正常', ...connection() });
          if (req.method !== 'POST') return json({ error: '不支持的方法' }, 405);
          const id = deviceIdSchema.parse(req.headers.get('device-id'));
          // Only locally provisioned devices receive a valid connection secret.
          const registered = store.get(`provision:${id}`); if (!registered) return json({ error: '请先在本地工作台登记或配置此设备' }, 403);
          const body = await req.json().catch(() => ({})) as Json;
          const transport = registered.transport || store.settings.defaultTransport;
          store.device(id, { board: String(body.board?.type || body.board?.name || registered.board || ''), firmware: String(body.application?.version || ''), transport, lastSeen: Date.now(), state: manager.sessions.has(id) ? store.devices.get(id)?.state : 'ready' });
          store.log('success', 'OTA', `已下发本地 ${transport === 'mqtt' ? 'MQTT+UDP' : 'WebSocket'} 连接参数`, id);
          const result: Json = { server_time: { timestamp: Date.now(), timezone_offset: 480 }, firmware: { version: String(body.application?.version || '0.0.0'), url: '' } };
          if (transport === 'mqtt') result.mqtt = { endpoint: `${store.settings.publicHost}:${mqttPort}`, client_id: `xiaozhi_${id.replaceAll(':', '_')}`, username: id, password: store.token(id), publish_topic: `xiaozhi/${id}/up`, subscribe_topic: `xiaozhi/${id}/down`, keepalive: 120 };
          else result.websocket = { url: connection().websocketUrl, token: store.token(id), version: 1 };
          return json(result);
        }
        if (path === '/api/snapshot') return json(snapshot());
        const userAudioRoute = path.match(/^\/api\/messages\/([1-9]\d{0,14})\/audio$/);
        if (userAudioRoute && req.method === 'GET') {
          const audio = store.userAudio(Number(userAudioRoute[1]));
          return audio ? new Response(new Uint8Array(audio), { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } }) : json({ error: '此消息没有保留原始录音' }, 404);
        }
        const browserAudioRoute = path.match(/^\/api\/browser-audio\/([a-zA-Z0-9-]+)$/);
        if (browserAudioRoute && req.method === 'GET') {
          const audio = store.browserAudio.get(browserAudioRoute[1]!);
          return audio ? new Response(new Uint8Array(audio), { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } }) : json({ error: '语音已过期' }, 404);
        }
        if (path === '/api/tasks' && req.method === 'GET') return json({ tasks: tasks.list() });
        if (path === '/api/tasks' && req.method === 'POST') return json(tasks.save(await req.json()), 201);
        const taskRoute = path.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)(?:\/(run|cancel))?$/);
        if (taskRoute) {
          const id = taskRoute[1]!;
          if (taskRoute[2] === 'run' && req.method === 'POST') {
            // trigger claims the run synchronously before its first await.
            if (!tasks.list().some(t => t.id === id)) return json({ error: '任务不存在' }, 404);
            tasks.assertRunnable(id);
            void tasks.trigger(id).catch(e => store.log('error', '定时任务', String(e)));
            return json({ queued: true }, 202);
          }
          if (taskRoute[2] === 'cancel' && req.method === 'POST') { tasks.cancel(id); return json({ ok: true }); }
          if (req.method === 'PUT' && !taskRoute[2]) return json(tasks.save(await req.json(), id));
          if (req.method === 'PATCH' && !taskRoute[2]) { const { enabled } = z.object({ enabled: z.boolean() }).parse(await req.json()); return json(tasks.enable(id, enabled)); }
          if (req.method === 'DELETE' && !taskRoute[2]) { tasks.remove(id); return json({ ok: true }); }
          return json({ error: '不支持的方法' }, 405);
        }
        if (path === '/api/settings' && req.method === 'PUT') { store.saveSettings(await req.json()); store.log('success', '设置', '本地设置已保存'); return json({ settings: store.publicSettings(), connection: connection() }); }
        if (path === '/api/ai/test' && req.method === 'POST') { const start = Date.now(); const result = await providers.chat([{ role: 'user', content: '请只回答：连接成功' }]); return json({ text: result.content, elapsed: Date.now() - start }); }
        if (path === '/api/tts/test' && req.method === 'POST') { const { text } = textSchema.parse(await req.json()); const audio = await providers.synthesize(text); return new Response(new Uint8Array(audio), { headers: { 'Content-Type': Buffer.from(audio).subarray(0, 4).toString() === 'RIFF' ? 'audio/wav' : 'audio/mpeg' } }); }
        if (path === '/api/asr/test' && req.method === 'POST') { const audio = await upload(req); const pcm = await toPcm(audio, 16000); return json({ text: await providers.transcribe(pcmToWav(pcm)) }); }
        if (path === '/api/provision' && req.method === 'POST') {
          const input = z.object({ id: deviceIdSchema, transport: z.enum(['websocket', 'mqtt']), board: z.string().max(100).default('wha103'), ssid: z.string().max(32).optional(), password: z.string().max(64).optional() }).parse(await req.json());
          if (input.ssid && Buffer.byteLength(input.ssid) > 32) throw new Error('Wi-Fi 名称不能超过 32 个 UTF-8 字节');
          const token = store.token(input.id); store.set(`provision:${input.id}`, { transport: input.transport, board: input.board });
          store.device(input.id, { board: input.board, transport: input.transport });
          const changes: { namespace: string; key: string; value: string | number }[] = [
            { namespace: 'wifi', key: 'ota_url', value: connection().otaUrl },
            { namespace: 'websocket', key: 'url', value: connection().websocketUrl }, { namespace: 'websocket', key: 'token', value: token }, { namespace: 'websocket', key: 'version', value: 1 },
            { namespace: 'mqtt', key: 'endpoint', value: input.transport === 'mqtt' ? `${store.settings.publicHost}:${mqttPort}` : '' },
            { namespace: 'mqtt', key: 'client_id', value: `xiaozhi_${input.id.replaceAll(':', '_')}` }, { namespace: 'mqtt', key: 'username', value: input.id }, { namespace: 'mqtt', key: 'password', value: token },
            { namespace: 'mqtt', key: 'publish_topic', value: `xiaozhi/${input.id}/up` }, { namespace: 'mqtt', key: 'subscribe_topic', value: `xiaozhi/${input.id}/down` }, { namespace: 'mqtt', key: 'keepalive', value: 120 },
          ];
          if (input.ssid) { changes.push({ namespace: 'wifi', key: 'ssid', value: input.ssid }, { namespace: 'wifi', key: 'password', value: input.password || '' }); }
          store.log('info', '刷写', '已生成本地连接配置，等待串口写入', input.id); return json({ changes, ...connection() });
        }
        if (path === '/api/mcp' && req.method === 'POST') {
          const input = z.object({ id: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(), name: z.string().min(1).max(80), url: z.string().url().refine(v => /^https?:/.test(v)), transport: z.enum(['http', 'sse']), token: z.string().max(2048).default('') }).parse(await req.json());
          if (input.id === BUILTIN_ID) throw new Error('内置工具不能被远程服务覆盖');
          if (!input.id && store.endpoints().length >= 8) throw new Error('本地工作台最多连接 8 个 MCP 服务');
          const id = input.id || `mcp_${crypto.randomUUID().slice(0, 8)}`; const old = store.endpoints().find(e => e.id === id);
          const item: McpEndpoint = { ...input, id, token: input.token === '••••••••' ? old?.token || '' : input.token };
          await mcp.disconnect(id); store.set('mcp', [...store.endpoints().filter(e => e.id !== id), item]); return json({ id });
        }
        const mcpRoute = path.match(/^\/api\/mcp\/([a-zA-Z0-9_-]+)(?:\/(tools|call))?$/);
        if (mcpRoute) {
          const id = mcpRoute[1]!;
          if (req.method === 'DELETE') { if (id === BUILTIN_ID) throw new Error('内置工具不能删除'); await mcp.disconnect(id); store.set('mcp', store.endpoints().filter(e => e.id !== id)); return json({ ok: true }); }
          if (mcpRoute[2] === 'tools') return json({ tools: await mcp.list(id) });
          if (mcpRoute[2] === 'call' && req.method === 'POST') { const input = z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}) }).parse(await req.json()); return json(await mcp.call(id, input.name, input.arguments)); }
        }
        if (path === '/api/speakers' && req.method === 'POST') { const input = z.object({ name: z.string().min(1).max(80), description: z.string().max(300).default('') }).parse(await req.json()); const speaker: Speaker = { ...input, id: `spk_${crypto.randomUUID().slice(0, 8)}`, enrolled: false }; store.set('speakers', [...store.speakers(), speaker]); return json(speaker); }
        const speakerRoute = path.match(/^\/api\/speakers\/([a-zA-Z0-9_-]+)(?:\/(enroll|identify))?$/);
        if (speakerRoute) {
          const id = speakerRoute[1]!; const speaker = store.speakers().find(s => s.id === id); if (!speaker) return json({ error: '说话人不存在' }, 404);
          if (req.method === 'DELETE') { store.set('speakers', store.speakers().filter(s => s.id !== id)); store.db.query('DELETE FROM kv WHERE key=?').run(`embedding:${id}`); return json({ ok: true }); }
          if (speakerRoute[2] === 'enroll' && req.method === 'POST') { const audio = await upload(req); const pcm = await toPcm(audio, 16000); if (pcm.length < 16000 * 2 * 3) throw new Error('声纹样本至少需要 3 秒'); await providers.enroll(id, pcmToWav(pcm)); store.set('speakers', store.speakers().map(s => s.id === id ? { ...s, enrolled: true } : s)); return json({ ok: true }); }
        }
        const deviceRoute = path.match(/^\/api\/devices\/([^/]+)\/(chat|speak|audio|abort|tools|call|rename)$/);
        if (deviceRoute) {
          const id = decodeURIComponent(deviceRoute[1]!); const action = deviceRoute[2];
          if (action === 'rename') { const { name } = z.object({ name: z.string().min(1).max(80) }).parse(await req.json()); return json(store.device(id, { name })); }
          const session = manager.get(id);
          if (action === 'tools') return json({ tools: session.tools });
          if (req.method !== 'POST') return json({ error: '需要 POST' }, 405);
          if (action === 'abort') { session.abort(); session.state('idle'); return json({ ok: true }); }
          if (action === 'call') { const input = z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }).parse(await req.json()); if (!session.tools.some(t => t.name === input.name)) throw new Error('此设备未声明该工具'); return json(await session.rpc('tools/call', input)); }
          if (action === 'audio') { const audio = await upload(req); void session.play(audio).catch(e => session.fail(e)); return json({ queued: true }, 202); }
          const { text } = textSchema.parse(await req.json());
          if (session.busy) return json({ error: '设备正在处理请求，请先停止播报' }, 409);
          if (action === 'chat') void session.chat(text).catch(e => session.fail(e));
          else void session.speak(text).catch(e => session.fail(e));
          return json({ queued: true }, 202);
        }
        if (path.startsWith('/api/')) return json({ error: '接口不存在' }, 404);
        if (req.method !== 'GET' || !local) return json({ error: '页面仅限本机访问' }, 403);
        const filePath = resolve(root, `.${path}`);
        if (filePath !== root && !filePath.startsWith(root + sep)) return json({ error: '无效路径' }, 400);
        const file = Bun.file(filePath); if (await file.exists() && !path.endsWith('/')) return new Response(file);
        const index = Bun.file(`${root}/index.html`); if (await index.exists()) return new Response(index);
        return new Response('开发界面：http://localhost:5178；生产模式请先运行 bun run build。', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      } catch (error) {
        const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}：${i.message}`).join('；') : error instanceof Error ? error.message : '请求处理失败';
        return json({ error: store.redact(message) }, 400);
      }
    },
    websocket: {
      maxPayloadLength: 64 * 1024, backpressureLimit: 1024 * 1024, closeOnBackpressureLimit: true,
      open(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === 'events') { ws.send(JSON.stringify({ type: 'snapshot', data: snapshot() })); const listener = (event: Json) => ws.send(JSON.stringify(event)); ws.data.listener = listener; store.listeners.add(listener); return; }
        const data = ws.data;
        data.session = manager.open(data.id, { kind: 'websocket', json: msg => { ws.send(JSON.stringify(msg)); }, audio: (frame, timestamp) => { if (ws.send(wrapAudio(frame, data.session?.version || data.version, timestamp)) < 0) throw new Error('设备音频下行拥塞'); }, close: () => ws.close() }); data.session.version = data.version;
      },
      message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
        if (ws.data.kind !== 'device') return;
        const session = ws.data.session!;
        try { if (typeof message === 'string') { const msg = JSON.parse(message); void session.control(msg).catch(e => session.fail(e)); } else session.audio(unwrapAudio(Buffer.from(message), session.version)); }
        catch (e) { store.log('warn', '协议', String(e), session.id); }
      },
      close(ws: ServerWebSocket<WsData>) { if (ws.data.kind === 'events') { if (ws.data.listener) store.listeners.delete(ws.data.listener); } else manager.close(ws.data.id, ws.data.session); },
    },
  });
  activePort = server.port!;
  try { if (options.transports !== false) mqtt = await startMqtt(store, manager, mqttPort, udpPort); }
  catch (e) { await tasks.close(); server.stop(true); store.close(); throw e; }
  store.log('success', '网关', `本地服务已启动 ${connection().otaUrl}`);
  return { server, store, manager, providers, mcp, tasks, connection, async close() { await tasks.close(); manager.closeAll(); mqtt?.close(); providers.speaker.close(); await mcp.close(); server.stop(true); store.close(); } };
}
async function upload(req: Request) { const form = await req.formData(); const file = form.get('file'); if (!(file instanceof File) || !file.size || file.size > 20 * 1024 * 1024) throw new Error('请选择小于 20MB 的音频文件'); return new Uint8Array(await file.arrayBuffer()); }

if (import.meta.main) {
  const app = await startApp();
  console.log(`\n小智本地工作台\n  管理界面 http://localhost:${app.server.port}\n  OTA ${app.connection().otaUrl}\n  MQTT :${app.connection().mqttPort} / UDP :${app.connection().udpPort}\n`);
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
}
