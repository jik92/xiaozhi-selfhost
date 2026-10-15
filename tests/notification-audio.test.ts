import { expect, test } from 'bun:test';
import { NotificationAudioCache } from '../server/notification-audio';
import { pcmToOggOpus, toPcm } from '../server/audio';

test('notification clips require a random capability and expire with session or TTL', async () => {
  let now = 0; let allowed = true;
  const cache = new NotificationAudioCache(() => now, 100, 1000);
  const clip = Buffer.from('OggS-test'); const id = cache.add(clip, () => allowed);
  expect(id).toMatch(/^[a-f0-9]{64}$/); expect(cache.get('wrong')).toBeUndefined();
  const fetched = cache.waitForFetch(id, new AbortController().signal);
  expect(cache.get(id)).toEqual(clip); await fetched;
  allowed = false; expect(cache.get(id)).toBeUndefined();
  const next = cache.add(clip, () => true); now = 1000; expect(cache.get(next)).toBeUndefined();
  expect(() => cache.add(Buffer.alloc(101), () => true)).toThrow('缓存已满');
});

test('pending download waits abort or reject when revoked instead of marking playback successful', async () => {
  const cache = new NotificationAudioCache(); const id = cache.add(Buffer.from('test'), () => true);
  const controller = new AbortController(); const pending = cache.waitForFetch(id, controller.signal);
  controller.abort(); await expect(pending).rejects.toThrow('取消');
  const id2 = cache.add(Buffer.from('test'), () => true); const wait = cache.waitForFetch(id2, new AbortController().signal);
  cache.remove(id2); await expect(wait).rejects.toThrow('失效'); cache.clear();
});

test('notification audio is mono Ogg Opus and round-trips as usable audio', async () => {
  const pcm = Buffer.alloc(24000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 24000) * 8000), i * 2);
  const ogg = await pcmToOggOpus(pcm, new AbortController().signal);
  expect(ogg.subarray(0, 4).toString()).toBe('OggS');
  const head = ogg.indexOf('OpusHead'); expect(head).toBeGreaterThan(0); expect(ogg[head + 9]).toBe(1);
  const decoded = await toPcm(ogg); expect(Math.abs(decoded.length - pcm.length)).toBeLessThan(3000);
  const aborted = new AbortController(); aborted.abort(); await expect(pcmToOggOpus(pcm, aborted.signal)).rejects.toThrow();
});
