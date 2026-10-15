import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { BrowserSpeechPlayer, type PlaybackState } from '../src/browser-audio';
import { BrowserAudioCache } from '../server/browser-audio';
import { startApp } from '../server/index';
import { pcmToWav, toPcm } from '../server/audio';
import type { BrowserAudioEvent } from '../shared/browser-audio';

class FakeAudio extends EventTarget {
  src = ''; calls = 0; paused = 0; blocked = false;
  play() { this.calls++; return this.blocked ? Promise.reject(new DOMException('gesture needed', 'NotAllowedError')) : Promise.resolve(); }
  pause() { this.paused++; }
  removeAttribute() { this.src = ''; }
  load() {}
}
const clip = (id: string, deviceId = 'a'): BrowserAudioEvent => ({ id, deviceId, url: `/api/browser-audio/${id}`, text: id });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('web playback queues new replies, ignores duplicates and only follows the selected device', async () => {
  const audio = new FakeAudio(); const states: PlaybackState[] = []; const player = new BrowserSpeechPlayer(audio as unknown as HTMLAudioElement, state => states.push(state));
  player.configure('a', true); player.enqueue(clip('first')); player.enqueue(clip('first')); player.enqueue(clip('other', 'b')); player.enqueue(clip('second'));
  await flush(); expect(audio.calls).toBe(1); expect(audio.src).toContain('first'); expect(states.at(-1)?.status).toBe('playing');
  audio.dispatchEvent(new Event('ended')); await flush(); expect(audio.calls).toBe(2); expect(audio.src).toContain('second');
  player.interrupt({ deviceId: 'b' }); expect(audio.src).toContain('second');
  player.interrupt({ deviceId: 'a', id: 'first' }); expect(audio.src).toContain('second');
  player.interrupt({ deviceId: 'a', id: 'second' }); expect(audio.src).toBe(''); expect(states.at(-1)?.status).toBe('idle');
  player.dispose();
});
test('autoplay denial keeps the reply available for one-click resume; disabling or leaving clears playback', async () => {
  const audio = new FakeAudio(); const states: PlaybackState[] = []; const player = new BrowserSpeechPlayer(audio as unknown as HTMLAudioElement, state => states.push(state));
  audio.blocked = true; player.configure('a', true); player.enqueue(clip('blocked')); player.enqueue(clip('queued')); await flush();
  expect(states.at(-1)?.status).toBe('blocked'); expect(audio.src).toContain('blocked');
  audio.blocked = false; player.resume(); await flush(); expect(states.at(-1)?.status).toBe('playing');
  player.configure('b', true); expect(audio.src).toBe('');
  player.enqueue(clip('not-selected')); expect(audio.calls).toBe(2);
  player.configure('b', false); player.enqueue(clip('muted', 'b')); expect(audio.calls).toBe(2);
  player.configure('b', true); player.enqueue(clip('new', 'b')); await flush();
  player.dispose(); expect(audio.src).toBe(''); audio.dispatchEvent(new Event('ended')); player.enqueue(clip('disposed', 'b')); expect(audio.calls).toBe(3);
});
test('a late play promise cannot revive a stopped voice', async () => {
  const audio = new FakeAudio(); let resolve!: () => void; const states: PlaybackState[] = [];
  audio.play = () => new Promise<void>(done => { resolve = done; });
  const player = new BrowserSpeechPlayer(audio as unknown as HTMLAudioElement, state => states.push(state)); player.configure('a', true); player.enqueue(clip('late'));
  player.stop(); resolve(); await flush(); expect(states.at(-1)?.status).toBe('idle'); player.dispose();
});
test('temporary browser audio has a memory bound and expires without persistent storage', () => {
  let now = 1000; const cache = new BrowserAudioCache(() => now, 10, 100);
  const first = cache.add('a', Buffer.from('123456'), 'one')!;
  const second = cache.add('a', Buffer.from('abcdef'), 'two')!;
  expect(cache.get(first.id)).toBeUndefined(); expect(cache.get(second.id)?.toString()).toBe('abcdef');
  expect(cache.add('a', Buffer.alloc(11), 'too big')).toBeUndefined();
  now += 100; expect(cache.get(second.id)).toBeUndefined();
});

test('the live event stream exposes the exact synthesized audio once, and abort stops browser playback', async () => {
  const dir = mkdtempSync(`${tmpdir()}/xiaozhi-browser-audio-`); const app = await startApp({ port: 0, dataDir: dir, transports: false });
  const base = `http://127.0.0.1:${app.server.port}`; const events: any[] = [];
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/events'); ws.onmessage = event => events.push(JSON.parse(String(event.data)));
  const session = app.manager.open('browser-audio-test', { kind: 'websocket', json: () => {}, audio: () => {}, close: () => {} });
  let calls = 0; const pcm = Buffer.alloc(24000 * 2 / 5, 1);
  app.providers.synthesize = async () => { calls++; return pcmToWav(pcm, 24000); };
  async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(10); } throw new Error('等待音频事件超时'); }
  try {
    await once(ws, 'open'); await session.speak('你好'); await until(() => events.some(e => e.type === 'audio'));
    const ready = events.find(e => e.type === 'audio').data;
    expect(calls).toBe(1); expect(ready.deviceId).toBe(session.id); expect(ready.text).toBe('你好');
    const response = await fetch(base + ready.url); expect(response.ok).toBe(true); expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(await toPcm(new Uint8Array(await response.arrayBuffer()))).toEqual(pcm);
    expect((await fetch(base + ready.url, { headers: { Origin: 'https://foreign.example' } })).status).toBe(403);
    expect((await fetch(base + '/api/browser-audio/missing')).status).toBe(404);
    app.providers.synthesize = async () => pcmToWav(Buffer.alloc(48000), 24000);
    const playing = session.speak('打断测试').then(() => false, () => true);
    await until(() => events.filter(e => e.type === 'audio').length === 2); session.abort(); expect(await playing).toBe(true);
    const second = events.filter(e => e.type === 'audio')[1].data;
    await until(() => events.some(e => e.type === 'audio-stop' && e.data.id === second.id));
  } finally { ws.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
