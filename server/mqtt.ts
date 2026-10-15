import { createServer, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import type { Store } from './store';
import type { SessionManager, DeviceSession } from './sessions';
import { newUdpKey, encryptUdp, decryptUdp } from './protocol';

export function mqttPacket(type: number, body: Buffer) {
  const length: number[] = []; let n = body.length;
  do { let digit = n % 128; n = Math.floor(n / 128); if (n) digit |= 128; length.push(digit); } while (n);
  return Buffer.concat([Buffer.from([type, ...length]), body]);
}
export function mqttString(text: string) { const b = Buffer.from(text); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); }
export function readMqttPacket(data: Buffer): { type: number; body: Buffer; consumed: number } | undefined {
  if (data.length < 2) return;
  let size = 0; let multiplier = 1;
  for (let i = 1; i <= 4; i++) {
    if (i >= data.length) return;
    const d = data[i]!; size += (d & 127) * multiplier;
    if (size > 64 * 1024) throw new Error('MQTT 消息过大');
    if (!(d & 128)) { if (data.length < i + 1 + size) return; return { type: data[0]!, body: data.subarray(i + 1, i + 1 + size), consumed: i + 1 + size }; }
    multiplier *= 128;
  }
  throw new Error('无效的 MQTT 长度');
}
function reader(data: Buffer) {
  let offset = 0;
  return { string() { if (offset + 2 > data.length) throw new Error('MQTT 数据不完整'); const n = data.readUInt16BE(offset); offset += 2; if (offset + n > data.length) throw new Error('MQTT 字符串不完整'); const v = data.subarray(offset, offset + n).toString(); offset += n; return v; }, byte() { if (offset >= data.length) throw new Error('MQTT 数据不完整'); return data[offset++]!; }, word() { if (offset + 2 > data.length) throw new Error('MQTT 数据不完整'); const n = data.readUInt16BE(offset); offset += 2; return n; }, rest() { return data.subarray(offset); }, get offset() { return offset; } };
}
interface UdpChannel { session: DeviceSession; key: Buffer; nonce: Buffer; incoming: number; outgoing: number; address: string; peer?: { address: string; port: number }; }

export async function startMqtt(store: Store, manager: SessionManager, mqttPort = 1883, udpPort = 8884) {
  const udp = createSocket('udp4'); const channels = new Map<number, UdpChannel>(); const sockets = new Set<Socket>();
  let counter = 1;
  udp.on('message', (packet, peer) => {
    if (packet.length < 16) return;
    const c = channels.get(packet.readUInt32BE(4)); if (!c || !c.session.alive || peer.address !== c.address) return;
    try {
      const { frame, sequence } = decryptUdp(packet, c.key, c.incoming);
      // Bind to the first learned peer. AES-CTR has no MAC; never roam based on arbitrary datagrams.
      if (c.peer && (c.peer.address !== peer.address || c.peer.port !== peer.port)) return;
      c.incoming = sequence; c.peer = { address: peer.address, port: peer.port }; c.session.audio(frame);
    } catch { /* Invalid or replayed datagrams are dropped without flooding logs. */ }
  });
  udp.on('error', e => store.log('error', 'UDP', e.message));
  await new Promise<void>((resolve, reject) => { udp.once('error', reject); udp.bind(udpPort, '0.0.0.0', () => { udp.off('error', reject); resolve(); }); });
  const server = createServer(socket => {
    sockets.add(socket); socket.setTimeout(360000); socket.on('timeout', () => socket.destroy());
    let buffer = Buffer.alloc(0); let id = ''; let session: DeviceSession | undefined; let channelId: number | undefined;
    let chain = Promise.resolve();
    const send = (type: number, body: Buffer) => { if (!socket.destroyed) { if (socket.writableLength > 512 * 1024) throw new Error('MQTT 下行拥塞'); socket.write(mqttPacket(type, body)); } };
    const down = (data: any) => send(0x30, Buffer.concat([mqttString(`xiaozhi/${id}/down`), Buffer.from(JSON.stringify(data))]));
    const onPacket = async (type: number, body: Buffer) => {
      const kind = type >> 4;
      if (kind === 1) {
        if (session) throw new Error('重复的 MQTT CONNECT');
        const r = reader(body); if (r.string() !== 'MQTT' || r.byte() !== 4) { send(0x20, Buffer.from([0, 1])); socket.end(); return; }
        const flags = r.byte(); r.word(); const clientId = r.string();
        if (flags & 4) { r.string(); r.string(); }
        const username = flags & 128 ? r.string() : ''; const password = flags & 64 ? r.string() : '';
        if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(username) || !store.verify(username, password) || clientId.length > 200) { send(0x20, Buffer.from([0, 5])); socket.end(); return; }
        if (manager.sessions.size >= 16 && !manager.sessions.has(username)) { send(0x20, Buffer.from([0, 3])); socket.end(); return; }
        id = username; send(0x20, Buffer.from([0, 0]));
        session = manager.open(id, { kind: 'mqtt', json: down, close: () => socket.end(), controlReady: () => !socket.destroyed, audioReady: () => channelId !== undefined && !!channels.get(channelId)?.peer, audio: (frame, timestamp) => {
          const channel = channelId !== undefined ? channels.get(channelId) : undefined;
          if (!channel?.peer) throw new Error('UDP 音频通道尚未建立，请先唤醒设备');
          udp.send(encryptUdp(frame, channel.key, channel.nonce, ++channel.outgoing, timestamp), channel.peer.port, channel.peer.address);
        } });
        return;
      }
      if (!session) throw new Error('请先认证 MQTT 连接');
      if (kind === 12) { session.lastSeen = Date.now(); send(0xd0, Buffer.alloc(0)); return; }
      if (kind === 14) { socket.end(); return; }
      if (kind === 8) {
        const r = reader(body); const packetId = r.word(); const results: number[] = [];
        while (r.offset < body.length) { const topic = r.string(); r.byte(); results.push(topic === `xiaozhi/${id}/down` ? 0 : 0x80); }
        const h = Buffer.alloc(2); h.writeUInt16BE(packetId); send(0x90, Buffer.concat([h, Buffer.from(results)])); return;
      }
      if (kind !== 3) return;
      const qos = (type >> 1) & 3; if (qos > 1 || (type & 1)) throw new Error('仅支持非保留 QoS 0 / 1 消息');
      const r = reader(body); const topic = r.string(); const packetId = qos ? r.word() : 0;
      if (topic !== `xiaozhi/${id}/up`) throw new Error('不能访问其他设备主题');
      if (qos) { const ack = Buffer.alloc(2); ack.writeUInt16BE(packetId); send(0x40, ack); }
      const msg = JSON.parse(r.rest().toString());
      if (msg.type === 'hello') {
        if (channelId !== undefined) channels.delete(channelId);
        channelId = counter++ >>> 0;
        const crypto = newUdpKey(channelId); channels.set(channelId, { session, ...crypto, incoming: 0, outgoing: 0, address: (socket.remoteAddress || '').replace(/^::ffff:/, '') });
        session.hello(msg, { udp: { server: store.connectionHost(), port: udpPort, key: crypto.key.toString('hex'), nonce: crypto.nonce.toString('hex') } });
      } else {
        if (msg.type === 'goodbye' && channelId !== undefined) { channels.delete(channelId); channelId = undefined; }
        void session.control(msg).catch(e => session?.fail(e));
      }
    };
    socket.on('data', data => {
      try {
        buffer = Buffer.concat([buffer, Buffer.from(data)]); if (buffer.length > 128 * 1024) throw new Error('MQTT 缓冲超限');
        for (;;) { const packet = readMqttPacket(buffer); if (!packet) break; buffer = buffer.subarray(packet.consumed); chain = chain.then(() => onPacket(packet.type, packet.body)).catch(e => { store.log('warn', 'MQTT', String(e), id); socket.destroy(); }); }
      } catch { socket.destroy(); }
    });
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); if (channelId !== undefined) channels.delete(channelId); if (session) manager.close(id, session); });
  });
  server.on('error', e => store.log('error', 'MQTT', e.message));
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(mqttPort, '0.0.0.0', () => { server.off('error', reject); resolve(); }); }); }
  catch (error) { udp.close(); throw error; }
  store.log('success', '网关', `MQTT :${mqttPort} / UDP :${udpPort} 已启动`);
  return { close() { for (const socket of sockets) socket.destroy(); server.close(); udp.close(); channels.clear(); } };
}
