import { randomBytes } from 'node:crypto';

interface Clip {
  audio: Buffer; expires: number; allowed: () => boolean;
  fetched: Promise<void>; resolve: () => void; reject: (error: Error) => void;
}
// Device firmware cannot attach auth headers to notify downloads. A short-lived,
// unguessable capability grants access to exactly one clip, bound to its live session.
export class NotificationAudioCache {
  private clips = new Map<string, Clip>(); private bytes = 0;
  constructor(private now = Date.now, private maxBytes = 24 * 1048576, private ttl = 120000) {}
  remove(id: string) {
    const clip = this.clips.get(id); if (!clip) return;
    this.clips.delete(id); this.bytes -= clip.audio.length; clip.reject(new Error('通知音频已失效'));
  }
  private expire() { for (const [id, clip] of this.clips) if (clip.expires <= this.now() || !clip.allowed()) this.remove(id); }
  add(audio: Buffer, allowed: () => boolean) {
    this.expire();
    if (!audio.length || audio.length > this.maxBytes || this.bytes + audio.length > this.maxBytes || this.clips.size >= 20) throw new Error('通知音频缓存已满');
    let resolve!: () => void; let reject!: (error: Error) => void;
    const fetched = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    void fetched.catch(() => {});
    const id = randomBytes(32).toString('hex');
    this.clips.set(id, { audio, expires: this.now() + this.ttl, allowed, fetched, resolve, reject }); this.bytes += audio.length;
    return id;
  }
  get(id: string) { this.expire(); const clip = this.clips.get(id); clip?.resolve(); return clip?.audio; }
  async waitForFetch(id: string, signal: AbortSignal) {
    const clip = this.clips.get(id); if (!clip) throw new Error('通知音频已失效');
    signal.throwIfAborted();
    let cancel!: () => void;
    const aborted = new Promise<never>((_ok, fail) => { cancel = () => fail(new Error('通知音频下载等待已取消或超时')); signal.addEventListener('abort', cancel, { once: true }); });
    try { await Promise.race([clip.fetched, aborted]); signal.throwIfAborted(); }
    finally { signal.removeEventListener('abort', cancel); }
  }
  clear() { for (const id of this.clips.keys()) this.remove(id); }
}
