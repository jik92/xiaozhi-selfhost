import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const destination = 'data/models/speaker.onnx';
const url = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';
await mkdir('data/models', { recursive: true, mode: 0o700 });
if (await Bun.file(destination).exists()) { console.log('声纹模型已就绪：', destination); process.exit(0); }
const source = process.argv[2];
console.log(source ? '导入指定的 ONNX 模型…' : '从 sherpa-onnx 官方 Release 下载声纹模型（约 28MB）…');
const bytes = source ? await Bun.file(source).arrayBuffer() : await (async () => { const r = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`模型下载失败：HTTP ${r.status}`); return r.arrayBuffer(); })();
if (bytes.byteLength < 1000000 || bytes.byteLength > 150000000) throw new Error('模型文件大小异常，未保存');
const hash = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
if (!source && hash !== 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2') throw new Error('官方模型 SHA256 与已验证版本不符，未保存');
await Bun.write(destination, bytes);
console.log('模型已安装：', destination, '\nSHA256:', hash);
