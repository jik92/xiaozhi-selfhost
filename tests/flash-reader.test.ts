import { expect, test } from 'bun:test';
import { md5 } from 'js-md5';
import { readFlashVerified, type FlashReadLink } from '../shared/flash-reader';

function stub(chunks: Uint8Array[]) {
  const packets: Uint8Array[] = []; const commands: Uint8Array[] = []; const acks: number[] = [];
  const link: FlashReadLink = { ESP_READ_FLASH: 0xd2,
    async checkCommand(_, opcode, command) {
      expect(opcode).toBe(0xd2); if (packets.length) throw new Error('Previous MD5 was not consumed');
      commands.push(command); const bytes = chunks.shift()!;
      for (let i = 0; i < bytes.length; i += 4096) packets.push(bytes.slice(i, i + 4096));
      packets.push(Uint8Array.from(md5.array(bytes))); return 0;
    }, transport: { async read(timeout) { expect(timeout).toBe(8000); const p = packets.shift(); if (!p) throw new Error('timeout'); return p; }, async write(ack) { acks.push(new DataView(ack.buffer, ack.byteOffset).getUint32(0, true)); } },
  };
  return { link, packets, acks, commands };
}
test('two consecutive reads consume their final MD5 and ACK every data frame', async () => {
  const a = new Uint8Array(4096).fill(0x34); const b = new Uint8Array(16384).fill(0xff);
  const s = stub([a, b]); expect(await readFlashVerified(s.link, 0x8000, a.length)).toEqual(a); expect(s.packets).toHaveLength(0);
  expect(await readFlashVerified(s.link, 0x9000, b.length)).toEqual(b); expect(s.packets).toHaveLength(0);
  expect(s.acks).toEqual([4096, 4096, 8192, 12288, 16384]);
  const cmd = new DataView(s.commands[0]!.buffer); expect(cmd.getUint32(0, true)).toBe(0x8000); expect(cmd.getUint32(12, true)).toBe(1);
});
test('bad final MD5 aborts before returning a usable flash image', async () => {
  const s = stub([new Uint8Array(4096)]); const read = s.link.transport.read;
  s.link.transport.read = async timeout => { const p = await read(timeout); return p.length === 16 ? new Uint8Array(16) : p; };
  expect(readFlashVerified(s.link, 0x8000, 4096)).rejects.toThrow('MD5');
});
test('disconnected stream and cancellation fail instead of starting a second command', async () => {
  const s = stub([new Uint8Array(4096)]); s.link.transport.read = async () => { throw new Error('timeout'); };
  await expect(readFlashVerified(s.link, 0x8000, 4096)).rejects.toThrow('timeout');
  const controller = new AbortController(); controller.abort(); await expect(readFlashVerified(s.link, 0x8000, 4096, undefined, controller.signal)).rejects.toThrow();
  expect(s.commands).toHaveLength(1);
});
