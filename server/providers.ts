import { EdgeTTS } from 'node-edge-tts';
import type { Store } from './store';
import type { Json } from '../shared/types';
import { LocalSpeaker } from './speaker';

export function endpoint(base: string, path: string) { return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`; }
async function checked(response: Response) {
  if (!response.ok) {
    // Never include the request or upstream response body: providers sometimes echo credentials.
    throw new Error(`上游接口返回 HTTP ${response.status}，请检查地址、模型、密钥和额度`);
  }
  return response;
}
function requestSignal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000); }

export class Providers {
  speaker: LocalSpeaker;
  constructor(private store: Store) { this.speaker = new LocalSpeaker(store); }
  async chat(messages: Json[], tools: Json[] = [], signal?: AbortSignal): Promise<Json> {
    const c = this.store.settings.llm;
    if (!c.apiKey) throw new Error('请先在 AI 设置中配置大模型密钥');
    const response = await checked(await fetch(endpoint(c.baseUrl, 'chat/completions'), {
      method: 'POST', signal: requestSignal(signal), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ model: c.model, messages, max_tokens: 500, stream: false, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
    }));
    const data = await response.json() as Json;
    if (!data.choices?.[0]?.message) throw new Error('上游没有返回有效的模型回答');
    return data.choices[0].message;
  }
  async transcribe(wav: Buffer, signal?: AbortSignal): Promise<string> {
    const c = this.store.settings.asr;
    if (!c.apiKey) throw new Error('请先配置语音识别密钥');
    if (c.type === 'qwen') {
      const r = await checked(await fetch(endpoint(c.baseUrl, 'chat/completions'), {
        method: 'POST', signal: requestSignal(signal), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` } }] }], asr_options: { enable_itn: true, language: 'zh' }, stream: false }),
      }));
      const data = await r.json() as Json; return String(data.choices?.[0]?.message?.content || '').trim();
    }
    const body = new FormData(); body.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav'); body.set('model', c.model);
    const r = await checked(await fetch(endpoint(c.baseUrl, 'audio/transcriptions'), { method: 'POST', body, headers: { Authorization: `Bearer ${c.apiKey}` }, signal: requestSignal(signal) }));
    return String((await r.json() as Json).text || '').trim();
  }
  async synthesize(text: string, signal?: AbortSignal): Promise<Uint8Array> {
    const c = this.store.settings.tts;
    if (signal?.aborted) throw new Error('操作已取消');
    if (c.type === 'edge') {
      const tts = new EdgeTTS({ voice: c.voice, lang: 'zh-CN', timeout: 20000, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' });
      const buffers: Buffer[] = [];
      for await (const piece of tts.streamAudio(text)) { if (signal?.aborted) throw new Error('操作已取消'); if (Buffer.isBuffer(piece)) buffers.push(piece); }
      if (!buffers.length) throw new Error('Edge TTS 没有返回音频，可切换兼容语音合成接口');
      return Buffer.concat(buffers);
    }
    if (!c.apiKey) throw new Error('请配置语音合成密钥');
    const r = await checked(await fetch(endpoint(c.baseUrl, 'audio/speech'), { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' }, signal: requestSignal(signal), body: JSON.stringify({ model: c.model, voice: c.voice, input: text, response_format: 'mp3' }) }));
    return new Uint8Array(await r.arrayBuffer());
  }
  async identify(wav: Buffer, signal?: AbortSignal): Promise<string | undefined> {
    const c = this.store.settings.voiceprint;
    const speakers = this.store.speakers().filter(s => s.enrolled);
    if (!c.enabled || !speakers.length) return;
    if (c.mode === 'local') return this.speaker.identify(wav);
    if (!c.baseUrl) throw new Error('声纹服务地址未配置');
    const body = new FormData(); body.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'voice.wav'); body.set('speaker_ids', speakers.map(s => s.id).join(','));
    const r = await checked(await fetch(endpoint(c.baseUrl, 'voiceprint/identify'), { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}` }, body, signal: requestSignal(signal) }));
    const result = await r.json() as Json;
    return Number(result.score) >= c.threshold ? speakers.find(s => s.id === result.speaker_id)?.name : undefined;
  }
  async enroll(id: string, wav: Uint8Array) {
    const c = this.store.settings.voiceprint;
    if (c.mode === 'local') return this.speaker.enroll(id, wav);
    if (!c.baseUrl) throw new Error('请先配置声纹服务地址');
    const body = new FormData(); body.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'voice.wav'); body.set('speaker_id', id);
    return checked(await fetch(endpoint(c.baseUrl, 'voiceprint/register'), { method: 'POST', body, headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(30000) }));
  }
}
