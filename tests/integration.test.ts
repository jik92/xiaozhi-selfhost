import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import mqtt from 'mqtt';
import { startApp } from '../server/index';
import { pcmToWav, encodePcm, createDecoder, toPcm } from '../server/audio';
import { encryptUdp, decryptUdp } from '../server/protocol';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { FRIEND_ROLE } from '../shared/roles';
import { DINGTALK_TOPIC } from '../server/dingtalk';

async function freePort() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return port; }
async function until(predicate: () => boolean, timeout = 8000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw new Error('等待集成结果超时'); await Bun.sleep(15); } }
function tone(rate = 24000, seconds = 0.25) { const pcm = Buffer.alloc(Math.floor(rate * seconds) * 2); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.sin(i * 2 * Math.PI * 330 / rate) * 8000, i * 2); return pcm; }

describe('real network integration (mocked AI, real transports and codecs)', () => {
  let app: Awaited<ReturnType<typeof startApp>>; let upstream: ReturnType<typeof Bun.serve>; let directory: string; let base: string; let mqttPort: number; let udpPort: number;
  let mcpHost: ReturnType<typeof Bun.serve>; let mcpServer: McpServer;
  const seen: string[] = [];
  let lastChat: any; let lastSpeech: any;
  beforeAll(async () => {
    directory = mkdtempSync(`${tmpdir()}/xiaozhi-integration-`); mqttPort = await freePort(); udpPort = await freePort();
    upstream = Bun.serve({ port: 0, async fetch(req) {
      const path = new URL(req.url).pathname; const body = await req.json() as any; seen.push(path);
      if (path === '/v1/audio/speech') { lastSpeech = body; return new Response(new Uint8Array(pcmToWav(tone())), { headers: { 'Content-Type': 'audio/wav' } }); }
      if (body.model === 'asr-test') return Response.json({ choices: [{ message: { role: 'assistant', content: '你好小智' } }] });
      lastChat = body; return Response.json({ choices: [{ message: { role: 'assistant', content: '你好，这是本地回复。' } }] });
    } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    mcpServer = new McpServer({ name: 'test-tools', version: '1.0.0' });
    mcpServer.registerTool('sum', { description: '相加', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
    await mcpServer.connect(transport); mcpHost = Bun.serve({ port: 0, fetch: req => transport.handleRequest(req) });
    app = await startApp({ port: 0, mqttPort, udpPort, dataDir: directory }); base = `http://127.0.0.1:${app.server.port}`;
    const c = structuredClone(app.store.settings); c.publicHost = '127.0.0.1'; c.publicHostMode = 'manual';
    c.llm = { ...c.llm, baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: 'private-llm-key', model: 'chat-test' };
    c.asr = { ...c.asr, baseUrl: c.llm.baseUrl, apiKey: 'private-asr-key', model: 'asr-test' };
    c.tts = { ...c.tts, type: 'openai', baseUrl: c.llm.baseUrl, apiKey: 'private-tts-key', voice: 'test' };
    app.store.saveSettings(c);
  });
  afterAll(async () => { await app?.close(); upstream?.stop(true); mcpHost?.stop(true); await mcpServer?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  async function request(path: string, body?: unknown) { return fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  async function register(id: string, transport = 'websocket') { const r = await request('/api/provision', { id, transport, board: 'wha103' }); expect(r.ok).toBe(true); return r.json() as Promise<any>; }

  test('run-now task leaves standby listening and sends device audio; scheduled tasks do not interrupt', async () => {
    const id = 'task-audio-device'; await register(id);
    const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/xiaozhi/v1/?device_id=${id}&token=${app.store.token(id)}`);
    const frames: Buffer[] = []; const control: any[] = [];
    ws.onmessage = event => { if (typeof event.data === 'string') control.push(JSON.parse(event.data)); else frames.push(Buffer.from(event.data)); };
    let taskId = '';
    try {
      await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', audio_params: { frame_duration: 60 } }));
      ws.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
      await until(() => app.manager.get(id).listening);
      const task = app.tasks.save({ name: '任务播报回归', prompt: '请播报当前时间', deviceId: id, enabled: false, schedule: { kind: 'interval', seconds: 3600 } }); taskId = task.id;
      await app.tasks.trigger(task.id, true);
      expect(app.tasks.list().find(t => t.id === task.id)?.lastDelivery).toBe('busy');
      expect(app.manager.get(id).listening).toBe(true); expect(frames).toHaveLength(0);
      expect((await request(`/api/tasks/${task.id}/run`, {})).status).toBe(202);
      await until(() => app.tasks.list().find(t => t.id === task.id)?.lastStatus === 'success');
      expect(app.tasks.list().find(t => t.id === task.id)?.lastDelivery).toBe('played');
      await until(() => control.some(m => m.type === 'tts' && m.state === 'sentence_end'));
      expect(frames.length).toBeGreaterThan(0); expect(app.manager.get(id).listening).toBe(false);
      app.manager.get(id).busy = true;
      const before = frames.length; await app.tasks.trigger(task.id);
      expect(app.tasks.list().find(t => t.id === task.id)?.lastDelivery).toBe('busy'); expect(frames).toHaveLength(before);
    } finally { if (taskId) app.tasks.remove(taskId); ws.close(); }
  });

  test('DingTalk callback → current role → TTS → device Opus without chat tools or a browser action', async () => {
    const id = 'dingtalk-device'; await register(id);
    const original = structuredClone(app.store.settings);
    app.store.saveSettings({ ...original, activeRoleId: FRIEND_ROLE.id });
    const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/xiaozhi/v1/?device_id=${id}&token=${app.store.token(id)}`);
    const control: any[] = []; const frames: Buffer[] = [];
    ws.onmessage = event => { if (typeof event.data === 'string') control.push(JSON.parse(event.data)); else frames.push(Buffer.from(event.data)); };
    try {
      await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', audio_params: { sample_rate: 16000, frame_duration: 60 } }));
      await until(() => control.some(m => m.type === 'hello'));
      const config = { enabled: false, clientId: 'test-client', clientSecret: 'private-ding-secret', deviceId: id };
      const saved = await fetch(base + '/api/dingtalk', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      expect(saved.ok).toBe(true); expect(await saved.text()).not.toContain('private-ding-secret');
      expect(await (await request('/api/dingtalk')).text()).not.toContain('private-ding-secret');
      expect((await fetch(base + '/api/dingtalk', { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
      // Inject a real protocol callback, with simulated credentials; never open a live DingTalk connection.
      app.store.set('dingtalk', { ...config, enabled: true });
      const acks: any[] = [];
      app.dingtalk.frame(JSON.stringify({ type: 'CALLBACK', headers: { topic: DINGTALK_TOPIC, messageId: 'stream-test' }, data: JSON.stringify({ msgId: 'notice-test', createAt: Date.now(), conversationType: '1', senderNick: '同事', senderStaffId: 'sender-1', text: { content: '下午三点开会' }, msgtype: 'text' }) }), { readyState: 1, send: s => acks.push(JSON.parse(s)), close() {}, addEventListener() {} });
      expect(acks[0].code).toBe(200);
      await until(() => app.dingtalk.snapshot().records[0]?.state === 'played');
      expect(lastChat.messages[0].content).toContain(FRIEND_ROLE.prompt);
      expect(lastChat.messages[1].content).toContain('下午三点开会'); expect(lastChat.tools).toBeUndefined();
      expect(lastSpeech.voice).toBe(FRIEND_ROLE.voices.openai);
      expect(frames.length).toBeGreaterThan(0); expect(control.some(m => m.type === 'tts' && m.state === 'stop')).toBe(true);
      expect(app.store.messages().some(m => m.deviceId === id && m.role === 'broadcast')).toBe(true);
    } finally { app.store.set('dingtalk', { enabled: false }); app.store.saveSettings(original); ws.close(); }
  });

  test('snapshots, provisioning and OTA all use the current address after network changes', async () => {
    const original = app.store.connectionHost;
    let current = '192.168.0.194'; app.store.connectionHost = () => current;
    try {
      for (const host of ['192.168.0.194', '10.1.2.191']) {
        current = host;
        const snapshot = await (await request('/api/snapshot')).json() as any;
        expect(snapshot.connection.host).toBe(host);
        const config = await (await request('/api/provision', { id: 'dynamic-passport', transport: 'mqtt', board: 'ai-passport' })).json() as any;
        expect(config.changes).toContainEqual({ namespace: 'wifi', key: 'ota_url', value: `http://${host}:${app.server.port}/xiaozhi/ota/` });
        expect(config.changes).toContainEqual({ namespace: 'websocket', key: 'url', value: `ws://${host}:${app.server.port}/xiaozhi/v1/` });
        expect(config.changes).toContainEqual({ namespace: 'mqtt', key: 'endpoint', value: `${host}:${mqttPort}` });
        const ota = await (await fetch(base + '/xiaozhi/ota/', { method: 'POST', headers: { 'device-id': 'dynamic-passport' }, body: '{}' })).json() as any;
        expect(ota.mqtt.endpoint).toBe(`${host}:${mqttPort}`);
      }
    } finally { app.store.connectionHost = original; }
  });

  test('Passport provisioning retains board identity and serves local OTA for both transports', async () => {
    for (const transport of ['websocket', 'mqtt']) {
      const id = `passport-${transport}`;
      const response = await request('/api/provision', { id, transport, board: 'ai-passport', ssid: 'Passport Wi-Fi', password: 'test-only' });
      expect(response.ok).toBe(true);
      const config = await response.json() as any;
      expect(config.changes).toContainEqual({ namespace: 'wifi', key: 'ssid', value: 'Passport Wi-Fi' });
      expect(config.changes).toContainEqual({ namespace: 'wifi', key: 'ota_url', value: `${base}/xiaozhi/ota/` });
      expect(app.store.devices.get(id)?.board).toBe('ai-passport');
      const ota = await (await fetch(base + '/xiaozhi/ota/', { method: 'POST', headers: { 'device-id': id }, body: JSON.stringify({ application: { version: '2.5.0' }, board: { type: 'ai-passport' } }) })).json() as any;
      if (transport === 'websocket') expect(ota.websocket.token).toBe(app.store.token(id));
      else expect(ota.mqtt.password).toBe(app.store.token(id));
      expect(app.store.devices.get(id)?.state).toBe('ready');
    }
  });

  test('local management hides secrets, blocks foreign origins; OTA only provisions registered devices', async () => {
    const settings = await (await request('/api/snapshot')).text(); expect(settings).not.toContain('private-llm-key'); expect(settings).toContain('••••••••');
    expect((await fetch(base + '/api/snapshot', { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await fetch(base + '/xiaozhi/ota/', { method: 'POST', headers: { 'device-id': 'unknown' }, body: '{}' })).status).toBe(403);
    await register('cc:00:00:00:00:01');
    const ota = await (await fetch(base + '/xiaozhi/ota/', { method: 'POST', headers: { 'device-id': 'cc:00:00:00:00:01' }, body: JSON.stringify({ application: { version: '2.0.5' } }) })).json() as any;
    expect(ota.websocket.url).toContain(String(app.server.port)); expect(ota.websocket.token).toBe(app.store.token('cc:00:00:00:00:01')); expect(ota.firmware.url).toBe('');
    app.store.log('error', 'test', 'upstream private-llm-key Bearer test-token');
    expect(await (await request('/api/snapshot')).text()).not.toContain('test-token');
  });

  test('WebSocket microphone → ASR → chat → TTS → real Opus; active audio and cleanup', async () => {
    const id = 'cc:00:00:00:00:02'; await register(id);
    const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/xiaozhi/v1/?device_id=${encodeURIComponent(id)}&token=${app.store.token(id)}`);
    const control: any[] = []; const frames: Buffer[] = [];
    ws.onmessage = e => { if (typeof e.data === 'string') control.push(JSON.parse(e.data)); else frames.push(Buffer.from(e.data)); };
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: 1, audio_params: { sample_rate: 16000, frame_duration: 60 } }));
    await until(() => control.some(m => m.type === 'hello')); expect(control.find(m => m.type === 'hello').audio_params.sample_rate).toBe(24000);
    // Firmware sends the detected word separately, often followed immediately by start.
    ws.send(JSON.stringify({ type: 'listen', state: 'detect', text: '小薇同学' }));
    ws.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    await until(() => frames.length > 0 && control.some(m => m.type === 'tts' && m.state === 'sentence_end'));
    expect(control.some(m => m.type === 'stt' && m.text === '小薇同学')).toBe(true);
    expect(control.some(m => m.type === 'tts' && m.state === 'sentence_start' && m.text === app.store.settings.wakeGreeting)).toBe(true);
    await until(() => !app.manager.get(id).busy);
    expect(app.manager.get(id).listening).toBe(true);
    control.length = 0; frames.length = 0;
    ws.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'manual' }));
    for (const frame of encodePcm(tone(16000, 0.6), 60, 16000)) ws.send(new Uint8Array(frame));
    ws.send(JSON.stringify({ type: 'listen', state: 'stop' }));
    await until(() => frames.length > 0 && control.some(m => m.type === 'tts' && m.state === 'sentence_end'));
    expect(control.some(m => m.type === 'stt' && m.text === '你好小智')).toBe(true);
    const decoder = createDecoder(24000); try { expect(decoder.decode(frames[0]!).length).toBe(2880); } finally { decoder.delete(); }
    expect(seen).toContain('/v1/chat/completions'); expect(seen).toContain('/v1/audio/speech');
    await until(() => !app.manager.get(id).busy);
    const before = frames.length; expect((await request(`/api/devices/${encodeURIComponent(id)}/speak`, { text: '主动播报测试' })).status).toBe(202);
    await until(() => frames.length > before && !app.manager.get(id).busy);
    ws.close(); await until(() => !app.manager.sessions.has(id)); expect(app.store.devices.get(id)?.online).toBe(false);
  }, 15000);

  test('MQTT control + encrypted UDP audio upstream and downstream', async () => {
    const id = 'cc:00:00:00:00:03'; await register(id, 'mqtt');
    const client = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`, { clientId: 'test-mqtt-client', username: id, password: app.store.token(id), protocolVersion: 4, reconnectPeriod: 0 });
    const controls: any[] = []; client.on('message', (_, payload) => controls.push(JSON.parse(payload.toString())));
    await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('error', reject); }); await client.subscribeAsync(`xiaozhi/${id}/down`);
    await client.publishAsync(`xiaozhi/${id}/up`, JSON.stringify({ type: 'hello', version: 3, audio_params: { sample_rate: 16000, frame_duration: 60 } }));
    await until(() => controls.some(m => m.type === 'hello'));
    const hello = controls.find(m => m.type === 'hello'); expect(hello.transport).toBe('udp');
    const key = Buffer.from(hello.udp.key, 'hex'); const nonce = Buffer.from(hello.udp.nonce, 'hex'); const udp = createSocket('udp4'); const received: Buffer[] = [];
    udp.on('message', packet => received.push(packet)); udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
    try {
      await client.publishAsync(`xiaozhi/${id}/up`, JSON.stringify({ type: 'listen', state: 'start', mode: 'manual' }));
      await Bun.sleep(20); const input = encodePcm(tone(16000, 0.6), 60, 16000);
      for (let i = 0; i < input.length; i++) { udp.send(encryptUdp(input[i]!, key, nonce, i + 1, i * 60), udpPort, '127.0.0.1'); await Bun.sleep(3); }
      await client.publishAsync(`xiaozhi/${id}/up`, JSON.stringify({ type: 'listen', state: 'stop' }));
      await until(() => received.length > 0 && controls.some(m => m.type === 'tts' && m.state === 'sentence_end'));
      const decoded = decryptUdp(received[0]!, key, 0); const codec = createDecoder(24000); try { expect(codec.decode(decoded.frame).length).toBe(2880); } finally { codec.delete(); }
      expect(app.store.devices.get(id)?.inputFrames).toBe(input.length);
    } finally { udp.close(); await client.endAsync(); }
    await until(() => !app.manager.sessions.has(id));
  }, 15000);

  test('Passport standby MQTT receives task and DingTalk notify audio without hello or UDP', async () => {
    const id = 'passport-standby';
    expect((await request('/api/provision', { id, board: 'ai-passport', transport: 'mqtt' })).ok).toBe(true);
    const client = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`, { clientId: 'standby-test', username: id, password: app.store.token(id), protocolVersion: 4, reconnectPeriod: 0 });
    const controls: any[] = []; const downloads: Buffer[] = []; const urls: string[] = []; const errors: unknown[] = [];
    let taskId = ''; let downloadEnabled = true;
    client.on('message', (_topic, payload) => {
      const message = JSON.parse(payload.toString()); controls.push(message);
      if (message.type === 'notify') {
        urls.push(message.audio_url);
        if (!downloadEnabled) return;
        void fetch(message.audio_url).then(async response => {
          expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('audio/ogg');
          expect(response.headers.get('cache-control')).toContain('no-store'); downloads.push(Buffer.from(await response.arrayBuffer()));
        }).catch(error => errors.push(error));
      }
    });
    try {
      await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('error', reject); });
      await client.subscribeAsync(`xiaozhi/${id}/down`);
      expect(app.manager.get(id).link.audioReady!()).toBe(false); expect(app.manager.canNotify(app.manager.get(id))).toBe(true);
      const task = app.tasks.save({ name: '待机播报', deviceId: id, prompt: '播报当前时间', enabled: false, schedule: { kind: 'interval', seconds: 3600 } }); taskId = task.id;
      await app.tasks.trigger(task.id);
      expect(app.tasks.list().find(t => t.id === task.id)?.lastDelivery).toBe('notified');
      expect(downloads).toHaveLength(1); expect(downloads[0]!.subarray(0, 4).toString()).toBe('OggS');
      expect((await toPcm(downloads[0]!)).length).toBeGreaterThan(1000);
      expect((await fetch(urls[0]!)).status).toBe(404);
      app.store.set('dingtalk', { enabled: true, clientId: 'standby-client', clientSecret: 'mock-only', deviceId: id });
      app.dingtalk.receive({ msgtype: 'text', msgId: 'standby-notice', createAt: Date.now(), conversationType: '1', text: { content: '会议即将开始' }, senderNick: '同事' });
      await until(() => app.dingtalk.snapshot().records.find(r => r.deviceId === id)?.state === 'notified');
      expect(downloads).toHaveLength(2); expect(controls.filter(m => m.type === 'notify')).toHaveLength(2);
      expect(controls.some(m => m.type === 'hello' || m.type === 'tts')).toBe(false);
      expect(app.manager.get(id).link.audioReady!()).toBe(false); expect(app.store.devices.get(id)?.inputFrames).toBe(0);
      expect(errors).toEqual([]);
      expect((await fetch(base + `/xiaozhi/notify-audio/${'0'.repeat(64)}.ogg`)).status).toBe(404);
      downloadEnabled = false;
      const controller = new AbortController(); const cancelled = app.manager.notify(id, '同事', '取消测试', controller.signal);
      void cancelled.catch(() => {});
      await until(() => urls.length === 3);
      expect((await fetch(urls[2]!, { method: 'HEAD' })).status).toBe(405);
      controller.abort(); await expect(cancelled).rejects.toThrow();
      expect((await fetch(urls[2]!)).status).toBe(404); expect(app.manager.get(id).busy).toBe(false);
      // A reachable MQTT client which never fetches audio must not be marked delivered.
      const cache = app.manager.notificationAudio; const originalWait = cache.waitForFetch;
      cache.waitForFetch = (clip, signal) => originalWait.call(cache, clip, AbortSignal.any([signal, AbortSignal.timeout(30)]));
      try {
        await app.tasks.trigger(task.id);
        expect(app.tasks.list().find(t => t.id === task.id)?.lastDelivery).toBe('failed');
        expect((await fetch(urls.at(-1)!)).status).toBe(404);
      } finally { cache.waitForFetch = originalWait; }
    } finally { app.store.set('dingtalk', { enabled: false }); if (taskId) app.tasks.remove(taskId); await client.endAsync(); }
  }, 15000);

  test('actual MCP HTTP initialization, tools/list and tools/call', async () => {
    const r = await request('/api/mcp', { name: 'test', url: `http://127.0.0.1:${mcpHost.port}/mcp`, transport: 'http', token: '' }); const config = await r.json() as any;
    const tools = await (await request(`/api/mcp/${config.id}/tools`)).json() as any; expect(tools.tools[0].name).toBe('sum');
    const result = await (await request(`/api/mcp/${config.id}/call`, { name: 'sum', arguments: { a: 3, b: 7 } })).json() as any; expect(result.content[0].text).toBe('10');
    await fetch(base + `/api/mcp/${config.id}`, { method: 'DELETE' });
  });
});
