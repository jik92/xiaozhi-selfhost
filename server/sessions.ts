import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type OpusScript from 'opusscript';
import type { Store } from './store';
import { Providers } from './providers';
import { McpManager } from './mcp';
import { createDecoder, rms, pcmToWav, encodePcm, toPcm } from './audio';
import type { Json } from '../shared/types';
import { runConversation, trimHistory } from './conversation';
import { recognitionSilence } from '../shared/roles';

// A null result means that this utterance should not trigger a conversation.
export function wakeCommand(text: string, prefix: string): string | null {
  text = text.trim(); prefix = prefix.trim();
  if (!prefix) return text || null;
  if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  return text.slice(prefix.length).replace(/^[\s，,。.!！?？、:：;；]+/u, '').trim() || null;
}

export interface Link { kind: 'websocket' | 'mqtt'; json: (data: Json) => void; audio: (frame: Buffer, timestamp: number) => void; close: () => void; }
export class DeviceSession {
  sessionId = randomUUID(); decoder: OpusScript = createDecoder();
  inputRate = 16000; frameMs = 60; version = 1; listening = false; busy = false;
  pcm: Buffer[] = []; pcmBytes = 0; lastVoice = 0; heard = false; mode = 'auto';
  controller?: AbortController; alive = true; tools: Json[] = []; history: Json[] = [];
  wakeGreetingController?: AbortController;
  browserAudioId?: string;
  pending = new Map<number, { resolve: (value: Json) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  nextRpc = 1; timer: ReturnType<typeof setInterval>; lastSeen = Date.now();
  constructor(public id: string, public link: Link, private store: Store, private providers: Providers, private mcp: McpManager) {
    this.store.device(id, { online: true, state: 'connected', transport: link.kind, lastSeen: Date.now() });
    this.store.log('success', link.kind === 'mqtt' ? 'MQTT' : 'WebSocket', '设备已连接', id);
    this.timer = setInterval(() => {
      if (this.listening && this.mode !== 'manual' && this.heard && Date.now() - this.lastVoice > recognitionSilence(this.store.settings)) void this.finishAudio();
      if (Date.now() - this.lastSeen > 5 * 60_000 && this.link.kind === 'websocket') this.link.close();
    }, 100);
    this.timer.unref();
  }
  send(data: Json) { if (this.alive) this.link.json({ session_id: this.sessionId, ...data }); }
  state(state: string) { this.store.device(this.id, { state, lastSeen: Date.now() }); }
  hello(msg: Json, extra: Json = {}) {
    const p = msg.audio_params || {};
    const rate = Number(p.sample_rate || 16000); this.decoder.delete(); this.decoder = createDecoder(rate); this.inputRate = rate;
    const duration = Number(p.frame_duration || 60); if (![20, 40, 60].includes(duration)) throw new Error('只支持 20 / 40 / 60ms 音频帧');
    this.frameMs = duration; this.version = Number(msg.version || 1);
    this.send({ type: 'hello', transport: this.link.kind === 'mqtt' ? 'udp' : 'websocket', version: this.version, audio_params: { format: 'opus', sample_rate: 24000, channels: 1, frame_duration: this.frameMs }, ...extra });
    this.state('idle');
    if (msg.features?.mcp) void this.discoverTools();
  }
  async discoverTools() {
    try {
      await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'xiaozhi-local', version: '0.1.0' } });
      this.send({ type: 'mcp', payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
      const response = await this.rpc('tools/list', {}); this.tools = response.tools || [];
      this.store.log('success', 'MCP', `发现 ${this.tools.length} 个设备工具`, this.id); this.store.emit('tools', { deviceId: this.id, tools: this.tools });
    } catch (error) { if (this.alive) this.store.log('warn', 'MCP', `设备工具发现失败：${String(error)}`, this.id); }
  }
  rpc(method: string, params: Json): Promise<Json> {
    const id = this.nextRpc++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('设备 MCP 调用超时')); }, 10000);
      this.pending.set(id, { resolve, reject, timer }); this.send({ type: 'mcp', payload: { jsonrpc: '2.0', id, method, params } });
    });
  }
  async control(msg: Json) {
    this.lastSeen = Date.now();
    switch (msg.type) {
      case 'hello': this.hello(msg); break;
      case 'listen':
        if (msg.state === 'start') {
          // Firmware may send start immediately after detect. Keep its greeting alive.
          if (!this.wakeGreetingController || this.controller !== this.wakeGreetingController) this.abort();
          this.listening = true; this.mode = msg.mode || 'auto'; this.pcm = []; this.pcmBytes = 0; this.heard = false;
          if (!this.wakeGreetingController) this.state('listening');
        }
        else if (msg.state === 'stop') await this.finishAudio();
        else if (msg.state === 'detect') await this.detectWakeWord(msg);
        break;
      case 'abort': this.abort(); this.state('idle'); break;
      case 'goodbye': this.abort(); this.state('idle'); break;
      case 'ping': this.send({ type: 'pong' }); break;
      case 'text': case 'chat': if (typeof msg.text === 'string') await this.chat(msg.text); break;
      case 'mcp': {
        const p = msg.payload; const pending = p && this.pending.get(p.id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(p.id); p.error ? pending.reject(new Error(String(p.error.message || 'MCP 调用失败'))) : pending.resolve(p.result || {}); }
        break;
      }
    }
  }
  async detectWakeWord(msg: Json) {
    this.abort(); this.heard = false; this.listening = true; this.mode = msg.mode || 'auto'; this.state('listening');
    if (typeof msg.text !== 'string' || !msg.text.trim()) return;
    const word = msg.text.trim().slice(0, 80);
    this.store.log('success', '唤醒', `设备检测到唤醒词：${word}（由固件识别）`, this.id);
    this.send({ type: 'stt', text: word });
    const greeting = this.store.settings.wakeGreeting;
    if (!greeting) return;
    const controller = new AbortController(); this.controller = controller; this.wakeGreetingController = controller; this.busy = true;
    try {
      this.store.message(this.id, 'assistant', greeting);
      await this.speak(greeting, controller);
    } catch (error) { this.fail(error, controller); }
    finally {
      if (this.controller === controller) {
        this.wakeGreetingController = undefined; this.busy = false; this.state(this.listening ? 'listening' : 'idle');
      }
    }
  }
  audio(frame: Buffer) {
    this.lastSeen = Date.now();
    if (!this.listening || this.busy || frame.length > 4096) return;
    const pcm = Buffer.from(this.decoder.decode(frame));
    if (rms(pcm) > this.store.settings.vad.threshold) { this.heard = true; this.lastVoice = Date.now(); }
    this.pcm.push(pcm); this.pcmBytes += pcm.length;
    const device = this.store.devices.get(this.id); if (device) device.inputFrames++;
    if (this.pcmBytes > this.inputRate * 2 * 25) void this.finishAudio();
  }
  async finishAudio() {
    if (!this.listening || this.busy) return;
    this.listening = false;
    const pcm = Buffer.concat(this.pcm); this.pcm = []; this.pcmBytes = 0;
    if (!this.heard || pcm.length < this.inputRate / 5) { this.state('idle'); return; }
    this.busy = true; const controller = new AbortController(); this.controller = controller; this.state('recognizing');
    try {
      const wav = pcmToWav(pcm, this.inputRate);
      const [text, speaker] = await Promise.all([this.providers.transcribe(wav, controller.signal), this.providers.identify(wav, controller.signal).catch(e => { this.store.log('warn', '声纹', String(e), this.id); return undefined; })]);
      if (controller.signal.aborted) return;
      this.store.device(this.id, { speaker });
      if (text) {
        this.send({ type: 'stt', text });
        const command = wakeCommand(text, this.store.settings.wakePrefix);
        if (command === null) {
          this.store.log('info', '唤醒', '语音未匹配唤醒前缀或未包含指令，已跳过对话', this.id);
          return;
        }
        this.busy = false; await this.chat(command, speaker, controller);
      }
    } catch (error) { this.fail(error, controller); }
    finally { if (this.controller === controller) { this.busy = false; this.state('idle'); } }
  }
  async chat(text: string, speaker?: string, previous?: AbortController) {
    if (this.busy) throw new Error('设备正在处理上一条请求');
    text = text.trim().slice(0, 4000); if (!text) throw new Error('请输入对话内容');
    const controller = previous || new AbortController(); this.controller = controller; this.busy = true; this.state('thinking');
    const checkpoint = this.history.length;
    try {
      const answer = await runConversation({ store: this.store, providers: this.providers, mcp: this.mcp, deviceId: this.id, text, speaker, signal: controller.signal, history: this.history, tools: this.tools, callDevice: (name, args) => this.rpc('tools/call', { name, arguments: args }) });
      await this.speak(answer, controller);
      trimHistory(this.history);
    } catch (error) { this.history.splice(checkpoint); this.fail(error, controller); }
    finally { if (this.controller === controller) { this.busy = false; this.state('idle'); } }
  }
  async speak(text: string, existing?: AbortController) {
    if (!existing && this.busy) throw new Error('设备忙，请先停止当前播报');
    const controller = existing || new AbortController(); this.controller = controller;
    if (!existing) this.busy = true;
    try {
      const audio = await this.providers.synthesize(text, controller.signal); await this.play(audio, text, controller);
      if (!existing) this.store.message(this.id, 'broadcast', text);
    } finally { if (!existing && this.controller === controller) { this.busy = false; this.state('idle'); } }
  }
  async play(audio: Uint8Array, text = '', existing?: AbortController) {
    if (!existing && this.busy) throw new Error('设备忙，请先停止当前播报');
    const controller = existing || new AbortController(); this.controller = controller; if (!existing) this.busy = true;
    let relayId: string | undefined; let completed = false;
    try {
      const pcm = await toPcm(audio, 24000, controller.signal); const frames = encodePcm(pcm, this.frameMs);
      controller.signal.throwIfAborted(); this.state('speaking');
      const browserAudio = this.store.browserAudio.add(this.id, pcmToWav(pcm, 24000), text);
      relayId = browserAudio?.id; this.browserAudioId = relayId;
      if (browserAudio) this.store.emit('audio', browserAudio);
      this.send({ type: 'tts', state: 'start' }); if (text) this.send({ type: 'tts', state: 'sentence_start', text });
      const start = performance.now();
      for (let i = 0; i < frames.length; i++) {
        controller.signal.throwIfAborted(); if (!this.alive) break;
        const wait = start + i * this.frameMs - performance.now(); if (wait > 0) await delay(wait, undefined, { signal: controller.signal });
        this.link.audio(frames[i]!, i * this.frameMs);
        const device = this.store.devices.get(this.id); if (device) device.outputFrames++;
      }
      if (!controller.signal.aborted) { this.send({ type: 'tts', state: 'sentence_end', text }); this.send({ type: 'tts', state: 'stop' }); completed = true; }
    } finally {
      if (relayId && this.browserAudioId === relayId) {
        if (!completed) this.store.emit('audio-stop', { deviceId: this.id, id: relayId });
        this.browserAudioId = undefined;
      }
      if (!existing && this.controller === controller) { this.busy = false; this.state('idle'); }
    }
  }
  abort() { if (this.browserAudioId) { this.store.emit('audio-stop', { deviceId: this.id, id: this.browserAudioId }); this.browserAudioId = undefined; } this.controller?.abort(); this.controller = undefined; this.wakeGreetingController = undefined; this.busy = false; this.listening = false; this.pcm = []; this.pcmBytes = 0; this.send({ type: 'tts', state: 'stop' }); }
  fail(error: unknown, controller?: AbortController) { if (!this.alive || controller?.signal.aborted) return; const message = this.store.redact(String(error)); this.store.log('error', '对话', message, this.id); this.send({ type: 'tts', state: 'stop' }); this.send({ type: 'alert', status: 'error', message, emotion: 'sad' }); }
  close() { if (!this.alive) return; this.alive = false; this.abort(); clearInterval(this.timer); this.decoder.delete(); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('设备已断开')); } this.pending.clear(); this.store.device(this.id, { online: false, state: 'offline' }); this.store.log('info', '设备', '连接已断开', this.id); }
}

export class SessionManager {
  sessions = new Map<string, DeviceSession>();
  constructor(public store: Store, public providers: Providers, public mcp: McpManager) {}
  open(id: string, link: Link) { const old = this.sessions.get(id); if (old) { old.close(); old.link.close(); } const session = new DeviceSession(id, link, this.store, this.providers, this.mcp); this.sessions.set(id, session); return session; }
  get(id: string) { const s = this.sessions.get(id); if (!s?.alive) throw new Error('设备尚未连接，请先配网并唤醒设备'); return s; }
  close(id: string, expected?: DeviceSession) { const s = this.sessions.get(id); if (expected && s !== expected) return; s?.close(); this.sessions.delete(id); }
  async runTask(deviceId: string, text: string, signal: AbortSignal) {
    const candidate = this.sessions.get(deviceId);
    const live = candidate?.alive && !candidate.busy && !candidate.listening ? candidate : undefined;
    const controller = new AbortController();
    const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) controller.abort();
    if (live) { live.controller = controller; live.busy = true; live.state('thinking'); }
    try {
      const answer = await runConversation({ store: this.store, providers: this.providers, mcp: this.mcp, deviceId, text, signal: controller.signal,
        history: live?.history || [], tools: live?.tools, callDevice: live ? (name, args) => live.rpc('tools/call', { name, arguments: args }) : undefined });
      let delivery: 'played' | 'offline' | 'busy' = candidate?.alive ? 'busy' : 'offline';
      if (live?.alive && live.controller === controller) {
        try { await live.speak(answer, controller); delivery = 'played'; }
        catch (error) { controller.signal.throwIfAborted(); this.store.log('warn', '定时任务', `结果已保存，播报失败：${String(error)}`, deviceId); delivery = live.alive ? 'busy' : 'offline'; }
      }
      if (live) trimHistory(live.history);
      return { text: answer, delivery };
    } finally {
      signal.removeEventListener('abort', cancel);
      if (live?.controller === controller) { live.busy = false; live.state('idle'); }
    }
  }
  closeAll() { for (const s of this.sessions.values()) { s.close(); s.link.close(); } this.sessions.clear(); }
}
