import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { toPcm, rms } from './audio';
import type { Store } from './store';

export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export class LocalSpeaker {
  worker?: Worker; nextId = 1;
  pending = new Map<number, { resolve: (embedding: number[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private store: Store) {}
  available() { return existsSync(resolve(process.env.VOICEPRINT_MODEL || 'data/models/speaker.onnx')); }
  async embedding(wav: Uint8Array, minimumSeconds = 1) {
    if (!this.available()) throw new Error('本地声纹模型未安装，请运行 bun run setup:voiceprint');
    const pcm = await toPcm(wav, 16000);
    if (pcm.length < 32000 * minimumSeconds || rms(pcm) < 0.003) throw new Error('声纹样本太短或音量太低，请使用清晰的单人录音');
    const samples = new Float32Array(pcm.length / 2); for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    if (!this.worker) {
      this.worker = new Worker(new URL('./speaker-worker.ts', import.meta.url).href);
      this.worker.onmessage = (event: MessageEvent<{ id: number; embedding: number[]; error?: string }>) => {
        const p = this.pending.get(event.data.id); if (!p) return; clearTimeout(p.timer); this.pending.delete(event.data.id);
        event.data.error ? p.reject(new Error(event.data.error)) : p.resolve(event.data.embedding);
      };
      this.worker.onerror = () => { this.close(); this.store.log('error', '声纹', '本地声纹运行时加载失败，请检查 sherpa-onnx-node 是否支持当前系统'); };
    }
    if (this.pending.size >= 4) throw new Error('声纹处理繁忙，请稍后再试');
    const id = this.nextId++;
    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本地声纹提取超时')); }, 30000);
      this.pending.set(id, { resolve, reject, timer }); this.worker!.postMessage({ id, samples }, [samples.buffer]);
    });
  }
  async enroll(id: string, wav: Uint8Array) { const vector = await this.embedding(wav, 3); this.store.set(`embedding:${id}`, vector); return vector.length; }
  async identify(wav: Uint8Array) {
    const samples = this.store.speakers().filter(s => s.enrolled && this.store.get(`embedding:${s.id}`)); if (!samples.length) return;
    const vector = await this.embedding(wav);
    const matches = samples.map(s => ({ name: s.name, score: cosine(vector, this.store.get(`embedding:${s.id}`)) })).sort((a, b) => b.score - a.score);
    return matches[0]!.score >= this.store.settings.voiceprint.threshold ? matches[0]!.name : undefined;
  }
  close() { this.worker?.terminate(); this.worker = undefined; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('声纹运行时已关闭')); } this.pending.clear(); }
}
