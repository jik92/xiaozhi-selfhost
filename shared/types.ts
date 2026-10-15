import { z } from 'zod';
import { FRIEND_ROLE } from './roles';
import type { AiTask } from './tasks';

const httpUrl = z.string().url().refine(v => /^https?:/.test(v), '请输入 HTTP / HTTPS 地址');
export const SettingsSchema = z.object({
  publicHostMode: z.enum(['auto', 'manual']).default('auto'),
  publicHost: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.\-]+$/, '仅填写 IP 或主机名，不含端口'),
  defaultTransport: z.enum(['websocket', 'mqtt']),
  wakePrefix: z.string().trim().max(80, '语音前缀最多 80 个字符').default(''),
  wakeGreeting: z.string().trim().max(200, '唤醒回复最多 200 个字符').default('我在，请说。'),
  activeRoleId: z.string().max(80).default(''),
  roles: z.array(z.object({
    id: z.string().min(1).max(80), name: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(8000),
    voices: z.object({ edge: z.string().trim().min(1).max(128), openai: z.string().trim().min(1).max(128) }),
  })).max(20).default(() => [structuredClone(FRIEND_ROLE)]),
  speech: z.object({
    recognitionSpeed: z.enum(['slow', 'normal', 'fast']).default('normal'),
    replySpeed: z.enum(['slow', 'normal', 'fast']).default('normal'),
    pitch: z.enum(['low', 'normal', 'high']).default('normal'),
  }).default({ recognitionSpeed: 'normal', replySpeed: 'normal', pitch: 'normal' }),
  llm: z.object({ baseUrl: httpUrl, apiKey: z.string().max(2048), model: z.string().min(1).max(128), systemPrompt: z.string().max(8000) }),
  asr: z.object({ type: z.enum(['qwen', 'openai']), baseUrl: httpUrl, apiKey: z.string().max(2048), model: z.string().min(1).max(128) }),
  tts: z.object({ type: z.enum(['edge', 'openai']), baseUrl: httpUrl, apiKey: z.string().max(2048), model: z.string().max(128), voice: z.string().min(1).max(128) }),
  voiceprint: z.object({ enabled: z.boolean(), mode: z.enum(['local', 'remote']).default('local'), baseUrl: z.union([httpUrl, z.literal('')]), apiKey: z.string().max(2048), threshold: z.number().min(0).max(1) }),
  vad: z.object({ threshold: z.number().min(0.001).max(1), silenceMs: z.number().int().min(300).max(5000) }),
}).superRefine((settings, ctx) => {
  if (new Set(settings.roles.map(r => r.id)).size !== settings.roles.length) ctx.addIssue({ code: 'custom', path: ['roles'], message: '角色 ID 不能重复' });
  if (settings.activeRoleId && !settings.roles.some(r => r.id === settings.activeRoleId)) ctx.addIssue({ code: 'custom', path: ['activeRoleId'], message: '请选择有效角色' });
});
export type Settings = z.infer<typeof SettingsSchema>;
export interface Device { id: string; name: string; board: string; firmware: string; transport: 'websocket' | 'mqtt'; online: boolean; state: string; lastSeen: number; speaker?: string; inputFrames: number; outputFrames: number; }
export interface LogEvent { id: number; time: number; level: 'info' | 'success' | 'warn' | 'error'; scope: string; message: string; deviceId?: string; }
export interface ChatMessage { id: number; deviceId: string; role: string; text: string; time: number; speaker?: string; audioUrl?: string; }
export interface McpEndpoint { id: string; name: string; url: string; transport: 'http' | 'sse'; token: string; }
export interface Speaker { id: string; name: string; description: string; enrolled: boolean; }
export interface Snapshot { devices: Device[]; logs: LogEvent[]; messages: ChatMessage[]; settings: Settings; tasks: AiTask[]; endpoints: Omit<McpEndpoint, 'token'>[]; speakers: Speaker[]; connection: { host: string; port: number; mqttPort: number; udpPort: number; otaUrl: string; websocketUrl: string; }; health: { ffmpeg: boolean; aiConfigured: boolean; voiceprintModel: boolean; }; }
export type Json = Record<string, any>;
