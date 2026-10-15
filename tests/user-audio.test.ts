import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startApp } from '../server/index';
import { Store } from '../server/store';
import { pcmToWav, toPcm } from '../server/audio';
import type { Json } from '../shared/types';

test('ASR user messages retain the actual recording and replay without resynthesizing, including after restart', async () => {
  const dir = mkdtempSync(`${tmpdir()}/xiaozhi-user-audio-`); let app = await startApp({ port: 0, dataDir: dir, transports: false });
  const events: Json[] = []; app.store.listeners.add(e => events.push(e));
  let synthesized = 0;
  const pcm = Buffer.alloc(16000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i * Math.PI / 15)), i * 2);
  app.providers.transcribe = async () => '原声测试'; app.providers.identify = async () => undefined;
  app.providers.chat = async () => ({ role: 'assistant', content: '收到。' });
  app.providers.synthesize = async () => { synthesized++; return pcmToWav(Buffer.alloc(4800), 24000); };
  const session = app.manager.open('recording-test', { kind: 'websocket', json: () => {}, audio: () => {}, close: () => {} });
  try {
    session.listening = true; session.heard = true; session.pcm = [pcm]; session.pcmBytes = pcm.length;
    await session.finishAudio();
    const user = app.store.messages().find(m => m.role === 'user')!;
    expect(user.audioUrl).toBe(`/api/messages/${user.id}/audio`);
    expect(events.find(e => e.type === 'message' && e.data.role === 'user')?.data.audioUrl).toBe(user.audioUrl);
    expect(events.filter(e => e.type === 'audio').every(e => e.data.url.startsWith('/api/browser-audio/'))).toBe(true);
    const base = `http://127.0.0.1:${app.server.port}`;
    const response = await fetch(base + user.audioUrl); expect(response.ok).toBe(true); expect(response.headers.get('content-type')).toBe('audio/wav');
    const wav = Buffer.from(await response.arrayBuffer()); expect(wav).toEqual(pcmToWav(pcm, 16000));
    expect(await toPcm(wav, 16000)).toEqual(pcm); expect(synthesized).toBe(1);
    expect((await fetch(base + user.audioUrl, { headers: { Origin: 'https://foreign.example' } })).status).toBe(403);
    app.store.message(session.id, 'user', '键盘输入'); const typed = app.store.messages().at(-1)!;
    expect(typed.audioUrl).toBeFalsy(); expect((await fetch(`${base}/api/messages/${typed.id}/audio`)).status).toBe(404);
    app.store.message(session.id, 'assistant', '回复', undefined, wav);
    expect(app.store.messages().at(-1)?.audioUrl).toBeFalsy();
    await app.close(); app = await startApp({ port: 0, dataDir: dir, transports: false });
    const persisted = await fetch(`http://127.0.0.1:${app.server.port}${user.audioUrl}`);
    expect(persisted.ok).toBe(true); expect(Buffer.from(await persisted.arrayBuffer())).toEqual(wav);
    const snapshot = await (await fetch(`http://127.0.0.1:${app.server.port}/api/snapshot`)).json() as Json;
    expect(snapshot.messages.find((m: Json) => m.id === user.id)?.audioUrl).toBe(user.audioUrl);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('recording retention removes older audio while keeping its text and recent clips', () => {
  const dir = mkdtempSync(`${tmpdir()}/xiaozhi-user-audio-retention-`); const store = new Store(dir);
  try {
    const wav = pcmToWav(Buffer.alloc(32), 16000);
    for (let i = 0; i < 201; i++) store.message('a', 'user', `message ${i}`, undefined, wav);
    const messages = store.messages(500);
    expect(messages).toHaveLength(201); expect(messages[0]?.audioUrl).toBeFalsy();
    expect(store.userAudio(messages[0]!.id)).toBeUndefined();
    expect(messages.at(-1)?.audioUrl).toBeTruthy();
    expect((store.db.query('SELECT COUNT(*) AS count FROM message_audio').get() as { count: number }).count).toBe(200);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
