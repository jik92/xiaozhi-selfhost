import { z } from 'zod';

export const DingTalkConfigSchema = z.object({
  enabled: z.boolean().default(false),
  clientId: z.string().trim().max(200).default(''),
  clientSecret: z.string().trim().max(500).default(''),
  deviceId: z.string().max(80).default(''),
  conversationId: z.string().trim().max(300).default(''),
  userIds: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
});
export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>;
export interface DingTalkRecord { id: string; created: number; deviceId: string; sender: string; text: string; state: 'queued' | 'playing' | 'played' | 'notified' | 'failed' | 'expired' | 'skipped' | 'unknown'; error: string; }
export interface DingTalkSnapshot {
  config: Omit<DingTalkConfig, 'clientSecret'> & { hasSecret: boolean };
  status: 'disabled' | 'connecting' | 'connected' | 'reconnecting'; error: string;
  lastSender?: { conversationId: string; userId: string };
  records: DingTalkRecord[];
}
