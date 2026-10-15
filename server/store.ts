import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { localHost } from './network';
export { localHost } from './network';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { SettingsSchema, type Settings, type Device, type LogEvent, type Json, type McpEndpoint, type Speaker, type ChatMessage } from '../shared/types';
import { BrowserAudioCache } from './browser-audio';

export class Store {
  db: Database;
  devices = new Map<string, Device>();
  listeners = new Set<(event: Json) => void>();
  settings: Settings;
  secret: string;
  browserAudio = new BrowserAudioCache();
  constructor(public dir = process.env.DATA_DIR || 'data') {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(`${dir}/xiaozhi.sqlite`, { create: true });
    chmodSync(`${dir}/xiaozhi.sqlite`, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, time INTEGER, level TEXT, scope TEXT, message TEXT, deviceId TEXT);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, deviceId TEXT, role TEXT, text TEXT, time INTEGER, speaker TEXT);
      CREATE TABLE IF NOT EXISTS message_audio (messageId INTEGER PRIMARY KEY, audio BLOB NOT NULL);`);
    this.secret = this.get('secret') || randomBytes(32).toString('hex');
    this.set('secret', this.secret);
    this.settings = SettingsSchema.parse(this.get('settings') || {
      publicHost: localHost(), defaultTransport: 'websocket',
      llm: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: process.env.AI_API_KEY || '', model: process.env.AI_MODEL || 'qwen-flash', systemPrompt: '你是小智，一个运行在用户本地环境的中文语音助手。回答自然、简短，适合朗读。不要使用 Markdown。' },
      asr: { type: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: process.env.ASR_API_KEY || process.env.AI_API_KEY || '', model: 'qwen3-asr-flash' },
      tts: { type: 'edge', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'tts-1', voice: 'zh-CN-XiaoxiaoNeural' },
      voiceprint: { enabled: false, baseUrl: '', apiKey: '', threshold: 0.4 }, vad: { threshold: 0.015, silenceMs: 800 },
    });
    for (const device of this.get('devices') || []) this.devices.set(device.id, { ...device, online: false, state: 'offline' });
  }
  get(key: string): any { const row = this.db.query('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | null; return row ? JSON.parse(row.value) : undefined; }
  set(key: string, value: any) { this.db.query('INSERT OR REPLACE INTO kv VALUES (?,?)').run(key, JSON.stringify(value)); }
  emit(type: string, data: any) { for (const listener of this.listeners) listener({ type, data }); }
  log(level: LogEvent['level'], scope: string, message: string, deviceId?: string) {
    const safe = this.redact(message).slice(0, 1600);
    const time = Date.now();
    const result = this.db.query('INSERT INTO logs(time,level,scope,message,deviceId) VALUES (?,?,?,?,?)').run(time, level, scope, safe, deviceId || null);
    this.emit('log', { id: Number(result.lastInsertRowid), time, level, scope, message: safe, deviceId });
    this.db.exec('DELETE FROM logs WHERE id < (SELECT COALESCE(MAX(id),0)-2000 FROM logs)');
  }
  redact(text: string) {
    for (const key of [this.secret, this.get('dingtalk')?.clientSecret, ...Object.values(this.settings).map(v => typeof v === 'object' && v && 'apiKey' in v ? String(v.apiKey) : '')]) if (key) text = text.replaceAll(key, '[已隐藏]');
    return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').replace(/([?&](?:key|token)=)[^&\s]+/gi, '$1[已隐藏]');
  }
  device(id: string, patch: Partial<Device> = {}) {
    const existing = this.devices.get(id);
    const device: Device = { id, name: existing?.name || `小智 ${id.slice(-5)}`, board: '', firmware: '', transport: 'websocket', online: false, state: 'offline', lastSeen: Date.now(), inputFrames: 0, outputFrames: 0, ...existing, ...patch };
    this.devices.set(id, device); this.set('devices', [...this.devices.values()]); this.emit('device', device); return device;
  }
  message(deviceId: string, role: string, text: string, speaker?: string, userAudio?: Buffer) {
    const time = Date.now();
    const result = this.db.query('INSERT INTO messages(deviceId,role,text,time,speaker) VALUES (?,?,?,?,?)').run(deviceId, role, text, time, speaker || null);
    const id = Number(result.lastInsertRowid);
    const hasAudio = role === 'user' && userAudio && userAudio.length <= 3 * 1024 * 1024;
    if (hasAudio) this.db.query('INSERT INTO message_audio(messageId,audio) VALUES (?,?)').run(id, userAudio);
    this.emit('message', { id, deviceId, role, text, time, speaker, ...(hasAudio ? { audioUrl: `/api/messages/${id}/audio` } : {}) });
    this.db.exec('DELETE FROM messages WHERE id < (SELECT COALESCE(MAX(id),0)-5000 FROM messages)');
    this.db.exec(`DELETE FROM message_audio WHERE messageId NOT IN (SELECT id FROM messages);
      DELETE FROM message_audio WHERE messageId IN (
        SELECT messageId FROM (
          SELECT messageId, SUM(length(audio)) OVER (ORDER BY messageId DESC) AS totalBytes,
            ROW_NUMBER() OVER (ORDER BY messageId DESC) AS position FROM message_audio
        ) WHERE totalBytes > 67108864 OR position > 200
      );`);
  }
  messages(limit = 200): ChatMessage[] {
    return this.db.query(`SELECT m.*, CASE WHEN a.messageId IS NOT NULL THEN '/api/messages/' || m.id || '/audio' END AS audioUrl
      FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) m LEFT JOIN message_audio a ON a.messageId=m.id ORDER BY m.id`).all(limit) as ChatMessage[];
  }
  userAudio(id: number) {
    const row = this.db.query("SELECT a.audio FROM message_audio a JOIN messages m ON m.id=a.messageId WHERE m.id=? AND m.role='user'").get(id) as { audio: Uint8Array } | null;
    return row?.audio;
  }
  publicSettings() { const copy = structuredClone(this.settings); for (const p of [copy.llm, copy.asr, copy.tts, copy.voiceprint]) p.apiKey = p.apiKey ? '••••••••' : ''; return copy; }
  connectionHost() { return this.settings.publicHostMode === 'manual' ? this.settings.publicHost : localHost(); }
  saveSettings(input: unknown) {
    const next = SettingsSchema.parse(input);
    for (const k of ['llm', 'asr', 'tts', 'voiceprint'] as const) if (next[k].apiKey === '••••••••') next[k].apiKey = this.settings[k].apiKey;
    this.settings = next; this.set('settings', next); this.emit('settings', this.publicSettings());
  }
  token(id: string) { return createHmac('sha256', this.secret).update(id).digest('hex'); }
  verify(id: string, token: string) { const expected = this.token(id); return token.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(token)); }
  endpoints(): McpEndpoint[] { return this.get('mcp') || []; }
  speakers(): Speaker[] { return this.get('speakers') || []; }
  close() { this.browserAudio.clear(); this.db.close(); }
}
