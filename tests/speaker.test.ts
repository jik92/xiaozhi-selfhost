import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { LocalSpeaker, cosine } from '../server/speaker';
import { pcmToWav } from '../server/audio';

test('cosine matching handles invalid dimensions and zero vectors', () => {
  expect(cosine([1, 0], [1, 0])).toBe(1); expect(cosine([1, 0], [0, 1])).toBe(0); expect(cosine([0, 0], [1, 1])).toBe(0); expect(cosine([1], [1, 2])).toBe(0);
});

test.skipIf(!existsSync(process.env.VOICEPRINT_MODEL || 'data/models/speaker.onnx'))('optional native ONNX worker extracts and matches embeddings (synthetic audio; not an accuracy benchmark)', async () => {
  const directory = mkdtempSync(`${tmpdir()}/xiaozhi-speaker-`); const store = new Store(directory); const speaker = new LocalSpeaker(store);
  const pcm = Buffer.alloc(16000 * 2 * 4);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE((Math.sin(i * 0.13) + Math.sin(i * 0.21)) * 5000, i * 2);
  const wav = pcmToWav(pcm);
  try {
    const length = await speaker.enroll('test', wav); expect(length).toBe(192);
    store.set('speakers', [{ id: 'test', name: 'synthetic-test', enrolled: true, description: 'test only' }]);
    store.settings.voiceprint.threshold = 0.99;
    expect(await speaker.identify(wav)).toBe('synthetic-test');
    const vector = store.get('embedding:test'); expect(vector.every(Number.isFinite)).toBe(true);
  } finally { speaker.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}, 15000);
