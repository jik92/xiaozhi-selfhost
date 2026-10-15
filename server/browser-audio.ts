import { randomUUID } from 'node:crypto';
import type { BrowserAudioEvent } from '../shared/browser-audio';

// Temporary copies of the exact audio sent to devices; no speech is synthesized twice.
export class BrowserAudioCache {
  private entries = new Map<string, { data: Buffer; expires: number }>();
  private bytes = 0;
  constructor(private now = Date.now, private maxBytes = 24 * 1024 * 1024, private ttlMs = 120000) {}
  private remove(id: string) { const item = this.entries.get(id); if (item) { this.bytes -= item.data.length; this.entries.delete(id); } }
  private expire() { for (const [id, item] of this.entries) if (item.expires <= this.now()) this.remove(id); }
  add(deviceId: string, audio: Buffer, text: string): BrowserAudioEvent | undefined {
    this.expire(); if (audio.length > this.maxBytes) return;
    while (this.bytes + audio.length > this.maxBytes || this.entries.size >= 20) this.remove(this.entries.keys().next().value!);
    const id = randomUUID(); this.entries.set(id, { data: audio, expires: this.now() + this.ttlMs }); this.bytes += audio.length;
    return { id, deviceId, url: `/api/browser-audio/${id}`, text };
  }
  get(id: string) { this.expire(); return this.entries.get(id)?.data; }
  clear() { this.entries.clear(); this.bytes = 0; }
}
