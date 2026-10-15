import { z } from 'zod';

export const TaskInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(4000),
  deviceId: z.string().regex(/^[a-zA-Z0-9:_-]{1,80}$/),
  enabled: z.boolean().default(true),
  schedule: z.object({
    kind: z.enum(['interval', 'scheduled', 'delay']),
    seconds: z.number().int().min(1).max(31536000).optional(),
    repeat: z.enum(['once', 'daily']).default('once'),
    runAt: z.number().int().positive().optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  }),
}).superRefine((task, ctx) => {
  const s = task.schedule;
  if (s.kind !== 'scheduled' && !s.seconds) ctx.addIssue({ code: 'custom', path: ['schedule', 'seconds'], message: '请输入间隔或延迟秒数' });
  if (s.kind === 'scheduled' && (s.repeat === 'daily' ? !s.time : !s.runAt)) ctx.addIssue({ code: 'custom', path: ['schedule'], message: '请选择触发时间' });
});
export type TaskInput = z.infer<typeof TaskInputSchema>;
export interface AiTask extends TaskInput {
  id: string;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus: 'idle' | 'running' | 'success' | 'error';
  lastResult?: string;
  lastError?: string;
  lastDelivery?: 'played' | 'notified' | 'offline' | 'busy' | 'failed';
  runCount: number;
}
export function nextTaskTime(schedule: TaskInput['schedule'], now: number) {
  if (schedule.kind !== 'scheduled') return now + schedule.seconds! * 1000;
  if (schedule.repeat === 'once') {
    if (schedule.runAt! <= now) throw new Error('触发时间必须晚于当前时间');
    return schedule.runAt!;
  }
  // Schedules use Beijing time (UTC+8), independent of the server's local timezone.
  const day = 86400000, offset = 8 * 3600000;
  const [hours, minutes] = schedule.time!.split(':').map(Number);
  const at = Math.floor((now + offset) / day) * day - offset + (hours! * 60 + minutes!) * 60000;
  return at > now ? at : at + day;
}
