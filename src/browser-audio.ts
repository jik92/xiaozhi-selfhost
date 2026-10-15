import type { BrowserAudioEvent, BrowserAudioStop } from '../shared/browser-audio';

export type PlaybackState = { status: 'idle' | 'loading' | 'playing' | 'blocked' | 'error'; error?: string; id?: string };
export class BrowserSpeechPlayer {
  private queue: BrowserAudioEvent[] = [];
  private current?: BrowserAudioEvent;
  private deviceId?: string;
  private enabled = true;
  private generation = 0;
  private disposed = false;
  private manual = false;
  constructor(private audio: HTMLAudioElement, private notify: (state: PlaybackState) => void) {
    audio.addEventListener('ended', this.ended); audio.addEventListener('error', this.failed);
  }
  configure(deviceId: string | undefined, enabled: boolean) {
    if (deviceId !== this.deviceId || !enabled) this.stop();
    this.deviceId = deviceId; this.enabled = enabled;
  }
  enqueue(event: BrowserAudioEvent) {
    if (this.disposed || !this.enabled || event.deviceId !== this.deviceId) return;
    if (this.current?.id === event.id || this.queue.some(item => item.id === event.id)) return;
    if (this.queue.length >= 10) this.queue.shift();
    this.queue.push(event); this.next();
  }
  playManual(event: BrowserAudioEvent) {
    if (this.disposed || event.deviceId !== this.deviceId) return;
    this.stop(); this.manual = true; this.current = event;
    this.audio.src = event.url; this.resume();
  }
  private next() {
    if (this.current || this.disposed) return;
    this.current = this.queue.shift(); if (!this.current) return;
    this.audio.src = this.current.url; this.resume();
  }
  resume() {
    if (!this.current || this.disposed || (!this.enabled && !this.manual)) return;
    const generation = ++this.generation, id = this.current.id; this.notify({ status: 'loading', id });
    // Called directly from the permission button's click handler when autoplay is blocked.
    void this.audio.play().then(() => {
      if (generation === this.generation && !this.disposed) this.notify({ status: 'playing', id });
    }).catch(error => {
      if (generation !== this.generation || this.disposed) return;
      if (error?.name === 'NotAllowedError') this.notify({ status: 'blocked', id });
      else this.failed();
    });
  }
  interrupt(event: BrowserAudioStop) { if (event.deviceId === this.deviceId) this.stop(event.id); }
  stop(id?: string) {
    this.queue = id ? this.queue.filter(item => item.id !== id) : [];
    if (id && this.current?.id !== id) return;
    this.generation++; this.current = undefined; this.manual = false;
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    if (!this.disposed) this.notify({ status: 'idle' });
    this.next();
  }
  private ended = () => { this.generation++; this.current = undefined; this.manual = false; this.notify({ status: 'idle' }); this.next(); };
  private failed = () => {
    if (!this.current || this.disposed) return;
    this.generation++; this.current = undefined; this.manual = false;
    this.notify({ status: 'error', error: '网页语音播放失败，请检查音频或网络连接' }); this.next();
  };
  dispose() {
    this.disposed = true; this.stop();
    this.audio.removeEventListener('ended', this.ended); this.audio.removeEventListener('error', this.failed);
  }
}
