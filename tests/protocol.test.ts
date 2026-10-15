import { describe, expect, test } from 'bun:test';
import { unwrapAudio, wrapAudio, newUdpKey, encryptUdp, decryptUdp } from '../server/protocol';
import { mqttPacket, readMqttPacket } from '../server/mqtt';
import { createDecoder, encodePcm, pcmToWav, toPcm } from '../server/audio';

describe('Xiaozhi wire protocols', () => {
  for (const v of [1, 2, 3]) test(`WebSocket v${v} binary audio`, () => { const frame = Buffer.from([1, 2, 3, 4]); expect(unwrapAudio(wrapAudio(frame, v, 250), v)).toEqual(frame); });
  test('rejects binary lengths and UDP replay, interoperates with AES-CTR header', () => {
    expect(() => unwrapAudio(Buffer.alloc(15), 2)).toThrow();
    const { key, nonce } = newUdpKey(1234); const frame = Buffer.from('opus-audio'); const packet = encryptUdp(frame, key, nonce, 1, 60);
    expect(packet.readUInt32BE(4)).toBe(1234); expect(decryptUdp(packet, key, 0).frame).toEqual(frame);
    expect(() => decryptUdp(packet, key, 1)).toThrow('重放'); const bad = Buffer.from(packet); bad.writeUInt16BE(123, 2); expect(() => decryptUdp(bad, key, 0)).toThrow();
  });
  test('MQTT stream parser handles fragmentation, rejects overlong packets', () => {
    const packet = mqttPacket(0x30, Buffer.alloc(1000)); expect(readMqttPacket(packet.subarray(0, 15))).toBeUndefined(); expect(readMqttPacket(packet)?.body.length).toBe(1000);
    expect(() => readMqttPacket(Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff]))).toThrow();
  });
  test('real PCM → Opus → PCM and FFmpeg conversion', async () => {
    const pcm = Buffer.alloc(24000 * 2 / 2); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.sin(i * 2 * Math.PI * 440 / 24000) * 6000, i * 2);
    const frames = encodePcm(pcm); const decoder = createDecoder(24000);
    try { expect(frames.length).toBe(9); expect(decoder.decode(frames[0]!).length).toBe(2880); } finally { decoder.delete(); }
    const converted = await toPcm(pcmToWav(pcm, 24000), 16000); expect(converted.length).toBe(16000);
  });
});
