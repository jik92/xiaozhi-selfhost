import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function unwrapAudio(data: Buffer, version: number) {
  if (version === 2) {
    if (data.length < 16 || data.readUInt16BE(0) !== 2 || data.readUInt16BE(2) !== 0 || data.readUInt32BE(12) !== data.length - 16) throw new Error('无效的 WebSocket v2 音频包');
    return data.subarray(16);
  }
  if (version === 3) {
    if (data.length < 4 || data[0] !== 0 || data.readUInt16BE(2) !== data.length - 4) throw new Error('无效的 WebSocket v3 音频包');
    return data.subarray(4);
  }
  return data;
}
export function wrapAudio(data: Buffer, version: number, timestamp = 0) {
  if (version === 2) { const h = Buffer.alloc(16); h.writeUInt16BE(2); h.writeUInt32BE(timestamp >>> 0, 8); h.writeUInt32BE(data.length, 12); return Buffer.concat([h, data]); }
  if (version === 3) { const h = Buffer.alloc(4); h.writeUInt16BE(data.length, 2); return Buffer.concat([h, data]); }
  return data;
}
export function newUdpKey(ssrc: number) { const nonce = Buffer.alloc(16); nonce[0] = 1; nonce.writeUInt32BE(ssrc >>> 0, 4); return { key: randomBytes(16), nonce }; }
export function encryptUdp(frame: Buffer, key: Buffer, nonce: Buffer, sequence: number, timestamp: number) {
  const h = Buffer.from(nonce); h.writeUInt16BE(frame.length, 2); h.writeUInt32BE(timestamp >>> 0, 8); h.writeUInt32BE(sequence >>> 0, 12);
  const cipher = createCipheriv('aes-128-ctr', key, h); return Buffer.concat([h, cipher.update(frame), cipher.final()]);
}
export function decryptUdp(packet: Buffer, key: Buffer, previous: number) {
  if (packet.length < 17 || packet[0] !== 1 || packet.readUInt16BE(2) !== packet.length - 16) throw new Error('无效的 UDP 音频包');
  const sequence = packet.readUInt32BE(12); if (sequence <= previous) throw new Error('UDP 音频包重放或乱序');
  const cipher = createDecipheriv('aes-128-ctr', key, packet.subarray(0, 16));
  return { sequence, frame: Buffer.concat([cipher.update(packet.subarray(16)), cipher.final()]) };
}
