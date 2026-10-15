// ESP-IDF NVS v2 page format. Updates are appended; unrelated entries and blobs stay byte-for-byte intact.
const encoder = new TextEncoder(); const decoder = new TextDecoder();
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
export function crc32(bytes: Uint8Array, seed = 0xffffffff) {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (const byte of bytes) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function entryCrc(e: Uint8Array) { const b = new Uint8Array(28); b.set(e.subarray(0, 4)); b.set(e.subarray(8), 4); return crc32(b); }
function state(page: Uint8Array, slot: number) { return (page[32 + Math.floor(slot / 4)]! >> ((slot % 4) * 2)) & 3; }
function mark(page: Uint8Array, slot: number, value: number) { const i = 32 + Math.floor(slot / 4); const shift = slot % 4 * 2; page[i] = (page[i]! & ~(3 << shift)) | value << shift; }
function keyOf(e: Uint8Array) { const key = e.subarray(8, 24); const end = key.indexOf(0); return decoder.decode(end < 0 ? key : key.subarray(0, end)); }
export interface NvsEntry { page: number; slot: number; namespace: number; key: string; type: number; span: number; entry: Uint8Array; payload: Uint8Array; }
export function readNvs(data: Uint8Array) {
  if (data.length < 0x3000 || data.length % 4096) throw new Error('NVS 分区大小无效');
  const entries: NvsEntry[] = [];
  const pages = Array.from({ length: data.length / 4096 }, (_, i) => ({ index: i, data: data.subarray(i * 4096, (i + 1) * 4096) })).filter(p => view(p.data).getUint32(0, true) !== 0xffffffff).sort((a, b) => view(a.data).getUint32(4, true) - view(b.data).getUint32(4, true));
  for (const p of pages) {
    const d = view(p.data);
    if (![0xfffffffe, 0xfffffffc].includes(d.getUint32(0, true)) || p.data[8] !== 0xfe || d.getUint32(28, true) !== crc32(p.data.subarray(4, 28))) throw new Error('NVS 页格式或校验不匹配；不支持加密、损坏或正在回收的分区');
    for (let slot = 0; slot < 126;) {
      if (state(p.data, slot) !== 2) { slot++; continue; }
      const entry = p.data.subarray(64 + slot * 32, 96 + slot * 32); const span = entry[2]!;
      if (span < 1 || slot + span > 126 || view(entry).getUint32(4, true) !== entryCrc(entry)) throw new Error('NVS 条目校验失败，已停止写入');
      entries.push({ page: p.index, slot, namespace: entry[0]!, type: entry[1]!, key: keyOf(entry), span, entry, payload: p.data.subarray(96 + slot * 32, 64 + (slot + span) * 32) }); slot += span;
    }
  }
  return entries;
}
export function readNvsString(data: Uint8Array, namespace: string, key: string) {
  const entries = readNvs(data); const ns = entries.filter(e => e.namespace === 0 && e.key === namespace).at(-1)?.entry[24];
  const e = entries.filter(e => e.namespace === ns && e.key === key).at(-1);
  if (!e || e.type !== 0x21) return;
  const size = view(e.entry).getUint16(24, true); const bytes = e.payload.subarray(0, size);
  if (crc32(bytes) !== view(e.entry).getUint32(28, true)) throw new Error('NVS 字符串校验失败');
  return decoder.decode(bytes.subarray(0, Math.max(0, size - 1)));
}
export function provisionNvs(original: Uint8Array, changes: { namespace: string; key: string; value: string | number }[]) {
  const data = original.slice(); const entries = readNvs(data);
  const namespaceIds = new Map(entries.filter(e => e.namespace === 0 && e.type === 1).map(e => [e.key, e.entry[24]!]));
  let maxId = Math.max(0, ...namespaceIds.values());
  const pages = Array.from({ length: data.length / 4096 }, (_, i) => data.subarray(i * 4096, (i + 1) * 4096));
  let sequence = Math.max(0, ...pages.filter(p => view(p).getUint32(0, true) !== 0xffffffff).map(p => view(p).getUint32(4, true)));
  function write(entry: Uint8Array, payload = new Uint8Array()) {
    const span = entry[2]!;
    let target = pages.filter(p => view(p).getUint32(0, true) === 0xfffffffe).sort((a, b) => view(b).getUint32(4, true) - view(a).getUint32(4, true)).find(p => {
      const used = Array.from({ length: 126 }, (_, i) => state(p, i)); const last = used.findLastIndex(s => s !== 3); return last + 1 + span <= 126;
    });
    if (!target) {
      const empty = pages.filter(p => p.every(v => v === 0xff));
      if (empty.length < 2) throw new Error('NVS 空间不足，已停止操作；请通过设备配网页面修改 OTA 地址');
      for (const p of pages) if (view(p).getUint32(0, true) === 0xfffffffe) view(p).setUint32(0, 0xfffffffc, true);
      target = empty[0]!; const d = view(target); d.setUint32(0, 0xfffffffe, true); d.setUint32(4, ++sequence, true); target[8] = 0xfe; d.setUint32(28, crc32(target.subarray(4, 28)), true);
    }
    let last = -1; for (let i = 0; i < 126; i++) if (state(target, i) !== 3) last = i;
    const slot = last + 1; view(entry).setUint32(4, entryCrc(entry), true);
    target.set(entry, 64 + slot * 32); if (payload.length) target.set(payload, 96 + slot * 32);
    for (let i = 0; i < span; i++) mark(target, slot + i, 2);
  }
  function header(namespace: number, key: string, type: number, span: number) {
    if (encoder.encode(key).length > 15 || key.includes('\0')) throw new Error('NVS 键名不能超过 15 字节');
    const e = new Uint8Array(32).fill(0xff); e[0] = namespace; e[1] = type; e[2] = span; e.fill(0, 8, 24); e.set(encoder.encode(key), 8); return e;
  }
  for (const change of changes) {
    let ns = namespaceIds.get(change.namespace);
    if (ns === undefined) { ns = ++maxId; if (ns > 254) throw new Error('NVS 命名空间已满'); const e = header(0, change.namespace, 1, 1); e[24] = ns; write(e); namespaceIds.set(change.namespace, ns); }
    if (typeof change.value === 'string') {
      const bytes = encoder.encode(change.value + '\0'); if (bytes.length > 2048) throw new Error('配置值过长');
      const span = 1 + Math.ceil(bytes.length / 32); const e = header(ns, change.key, 0x21, span); const d = view(e); d.setUint16(24, bytes.length, true); d.setUint32(28, crc32(bytes), true); write(e, bytes);
    } else { const e = header(ns, change.key, 0x14, 1); view(e).setInt32(24, change.value, true); write(e); }
    for (const old of entries) if (old.namespace === ns && old.key === change.key) for (let i = 0; i < old.span; i++) mark(pages[old.page]!, old.slot + i, 0);
  }
  readNvs(data); return data;
}
export interface Partition { name: string; type: number; subtype: number; offset: number; size: number; encrypted: boolean; }
export function partitions(bytes: Uint8Array): Partition[] {
  const result: Partition[] = []; const d = view(bytes);
  for (let i = 0; i + 32 <= bytes.length; i += 32) {
    if (d.getUint16(i, true) !== 0x50aa) break;
    const name = bytes.subarray(i + 12, i + 28); const end = name.indexOf(0);
    result.push({ name: decoder.decode(end < 0 ? name : name.subarray(0, end)), type: bytes[i + 2]!, subtype: bytes[i + 3]!, offset: d.getUint32(i + 4, true), size: d.getUint32(i + 8, true), encrypted: !!(d.getUint32(i + 28, true) & 1) });
  }
  if (!result.length) throw new Error('没有找到有效分区表；仅支持默认 0x8000 分区表布局'); return result;
}
