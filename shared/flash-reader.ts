import { md5 } from 'js-md5';

// Stub READ_FLASH is a stream: command status, data/ACK pairs, then a 16-byte MD5.
// esptool-js 0.7.0 readFlash returns before consuming the MD5. The next command
// then reads that digest as its response, which desynchronizes the serial link.
export interface FlashReadLink {
  ESP_READ_FLASH: number;
  checkCommand(description: string, command: number, data: Uint8Array): Promise<unknown>;
  transport: { read(timeout: number): Promise<Uint8Array>; write(data: Uint8Array): Promise<void> };
}
export async function readFlashVerified(loader: FlashReadLink, address: number, size: number, progress?: (read: number, total: number) => void, signal?: AbortSignal) {
  if (!Number.isInteger(address) || address < 0 || !Number.isInteger(size) || size <= 0 || size > 128 * 1024) throw new Error('Flash 读取范围无效');
  signal?.throwIfAborted();
  const command = new Uint8Array(16); const view = new DataView(command.buffer);
  [address, size, 4096, 1].forEach((value, i) => view.setUint32(i * 4, value, true));
  await loader.checkCommand('read flash', loader.ESP_READ_FLASH, command);
  const output = new Uint8Array(size); let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    const packet = await loader.transport.read(8000);
    signal?.throwIfAborted();
    if (!packet.length || packet.length !== Math.min(4096, size - offset)) throw new Error(`Flash 数据长度异常：${packet.length} 字节`);
    output.set(packet, offset); offset += packet.length;
    const ack = new Uint8Array(4); new DataView(ack.buffer).setUint32(0, offset, true); await loader.transport.write(ack);
    progress?.(offset, size);
  }
  const digest = await loader.transport.read(8000); signal?.throwIfAborted();
  if (digest.length !== 16) throw new Error('Flash 读取结束校验包长度异常');
  const expected = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (md5(output) !== expected) throw new Error('Flash 读取 MD5 校验失败，已停止后续写入');
  return output;
}
