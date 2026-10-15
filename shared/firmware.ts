import { partitions, readNvs, compactNvs, type Partition } from './nvs';

export const BOARDS = {
  wha103: { label: 'WHA103', chip: 'ESP32-C3', minFlash: 0 },
  'ai-passport': { label: 'FoloToy AI Passport', chip: 'ESP32-C3', minFlash: 8 * 1048576 },
} as const;
export type BoardId = keyof typeof BOARDS;
export const PASSPORT_FIRMWARE = {
  name: 'folo-ai-passport-xiaozhi-v2.5.0.bin', version: 'v2.5.0-folo.1', size: 7616468,
  sha256: 'b51eb892c702debef613b9705e617db155aeeb7ea0e20331d44c55d2c4e21518',
  release: 'https://github.com/FoloToy/folo-ai-passport-xiaozhi/releases/tag/v2.5.0-folo.1',
  sourceCommit: '05b36eb2493967caaf87cdfeda83946e1f0c5d78',
};
export function validateBoard(board: BoardId, chip: { name: string; flashSize: number }) {
  if (!BOARDS[board] || !chip.name.toUpperCase().includes(BOARDS[board].chip)) throw new Error('所选板型与连接芯片不匹配，需要 ESP32-C3');
  if (chip.flashSize < BOARDS[board].minFlash) throw new Error('AI Passport 固件需要至少 8 MB Flash');
}
export function nvsPartition(table: Uint8Array, flashSize: number): Partition {
  const p = partitions(table).find(p => p.type === 1 && p.subtype === 2);
  if (!p || p.encrypted || p.size < 0x3000 || p.size > 128 * 1024 || p.size % 4096 || p.offset < 0x9000 || p.offset % 4096 || p.offset + p.size > flashSize) throw new Error('没有找到可安全更新的非加密 NVS 分区');
  return p;
}
export function validateMergedFirmware(image: Uint8Array, chipId: number | undefined, flashSize: number, board: BoardId) {
  if (image.length < 0x9000 || image.length > flashSize || image[0] !== 0xe9) throw new Error('请选择从 0x0 开始的完整合并固件，且文件大小不能超过 Flash 容量');
  if (new DataView(image.buffer, image.byteOffset, image.byteLength).getUint16(12, true) !== chipId) throw new Error('固件目标芯片与连接设备不匹配，已停止刷写');
  const table = image.subarray(0x8000, 0x9000);
  const parts = partitions(table).sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p.size || p.offset < 0x9000 || p.offset % 4096 || p.offset + p.size > flashSize || (i > 0 && parts[i - 1]!.offset + parts[i - 1]!.size > p.offset)) throw new Error('固件分区越界或重叠');
  }
  if (!parts.some(p => p.type === 0 && image[p.offset] === 0xe9 && p.offset + p.size <= image.length)) throw new Error('合并固件未包含完整应用分区');
  if (board === 'ai-passport' && !new TextDecoder().decode(image).includes('ai-passport')) throw new Error('固件缺少 AI Passport 板型标识，请选择 Passport 专用固件');
  return nvsPartition(table, flashSize);
}
// Preserve pages when possible; otherwise repack all live records, including blobs.
export function resizeNvs(original: Uint8Array, size: number) {
  readNvs(original);
  if (size < 0x3000 || size % 4096) throw new Error('NVS 分区大小无效');
  if (size < original.length && original.subarray(size).some(b => b !== 255)) return compactNvs(original, size);
  const result = new Uint8Array(size).fill(255); result.set(original.subarray(0, size));
  const hasEmptyPage = Array.from({ length: size / 4096 }, (_, i) => result.subarray(i * 4096, (i + 1) * 4096).every(b => b === 255)).some(Boolean);
  if (!hasEmptyPage) return compactNvs(original, size);
  readNvs(result); return result;
}
