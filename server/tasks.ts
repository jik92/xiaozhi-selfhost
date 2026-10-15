import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import { TaskInputSchema, nextTaskTime, type AiTask } from '../shared/tasks';

type Result = { text: string; delivery: 'played' | 'offline' | 'busy' };
export class TaskScheduler {
  private running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private store: Store, private run: (task: AiTask, signal: AbortSignal) => Promise<Result>, private now = Date.now, autoStart = true) {
    const tasks = this.list(); let recovered = false;
    for (const task of tasks) if (task.lastStatus === 'running') { task.lastStatus = 'error'; task.lastError = '服务重启中断执行，未自动重放'; recovered = true; }
    if (recovered) this.write(tasks);
    if (autoStart) { this.timer = setInterval(() => this.tick(), 1000); this.timer.unref(); this.tick(); }
  }
  list(): AiTask[] { return this.store.get('aiTasks') || []; }
  private write(tasks: AiTask[]) { this.store.set('aiTasks', tasks); this.store.emit('tasks', tasks); }
  save(input: unknown, id?: string) {
    const data = TaskInputSchema.parse(input);
    if (!this.store.devices.has(data.deviceId)) throw new Error('请选择已登记设备');
    const tasks = this.list(), old = id ? tasks.find(t => t.id === id) : undefined;
    if (id && !old) throw new Error('任务不存在');
    if (id && this.running.has(id)) throw new Error('任务正在执行，请等待完成后修改');
    if (!id && tasks.length >= 100) throw new Error('最多创建 100 个任务');
    const task: AiTask = { ...old, ...data, id: id || randomUUID(), nextRunAt: data.enabled ? nextTaskTime(data.schedule, this.now()) : undefined, lastStatus: old?.lastStatus || 'idle', runCount: old?.runCount || 0 };
    this.write([...tasks.filter(t => t.id !== task.id), task]); return task;
  }
  enable(id: string, enabled: boolean) {
    const tasks = this.list(), task = tasks.find(t => t.id === id); if (!task) throw new Error('任务不存在');
    task.nextRunAt = enabled ? nextTaskTime(task.schedule, this.now()) : undefined; task.enabled = enabled;
    this.write(tasks); return task;
  }
  remove(id: string) { this.running.get(id)?.controller.abort(); this.write(this.list().filter(t => t.id !== id)); }
  cancel(id: string) { this.running.get(id)?.controller.abort(); }
  assertRunnable(id: string) {
    if (this.stopped) throw new Error('定时服务已停止');
    if (this.running.has(id)) throw new Error('任务正在执行');
    if (this.running.size >= 3) throw new Error('同时最多执行 3 个任务');
    if (!this.list().some(t => t.id === id)) throw new Error('任务不存在');
  }
  tick() {
    if (this.stopped) return;
    const now = this.now();
    for (const task of this.list()) if (task.enabled && task.nextRunAt !== undefined && task.nextRunAt <= now && !this.running.has(task.id)) {
      if (this.running.size >= 3) break;
      void this.trigger(task.id, true);
    }
  }
  async trigger(id: string, scheduled = false) {
    this.assertRunnable(id);
    const tasks = this.list(), task = tasks.find(t => t.id === id); if (!task) throw new Error('任务不存在');
    task.lastRunAt = this.now(); task.lastStatus = 'running'; task.lastError = undefined; task.runCount++;
    // Claim once-only tasks before side effects, so a restart cannot replay a Bash action.
    if (scheduled || task.schedule.kind === 'delay' || (task.schedule.kind === 'scheduled' && task.schedule.repeat === 'once')) {
      if (task.schedule.kind === 'interval' || (task.schedule.kind === 'scheduled' && task.schedule.repeat === 'daily')) task.nextRunAt = nextTaskTime(task.schedule, this.now());
      else { task.enabled = false; task.nextRunAt = undefined; }
    }
    this.write(tasks);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5 * 60_000); timer.unref();
    let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
    this.running.set(id, { controller, done });
    this.store.log('info', '定时任务', `开始：${task.name}`, task.deviceId);
    try {
      const result = await this.run(structuredClone(task), controller.signal); controller.signal.throwIfAborted();
      const latest = this.list(), current = latest.find(t => t.id === id);
      if (current) { current.lastStatus = 'success'; current.lastResult = result.text.slice(0, 16000); current.lastDelivery = result.delivery; this.write(latest); }
      this.store.log('success', '定时任务', `完成：${task.name}（${result.delivery === 'played' ? '已播报' : result.delivery === 'offline' ? '设备离线，结果已保存' : '设备忙，结果已保存'}）`, task.deviceId);
    } catch (error) {
      const message = this.store.redact(controller.signal.aborted ? '任务已取消或执行超时' : String(error));
      const latest = this.list(), current = latest.find(t => t.id === id);
      if (current) { current.lastStatus = 'error'; current.lastError = message; this.write(latest); }
      this.store.log('error', '定时任务', `${task.name}：${message}`, task.deviceId);
    } finally { clearTimeout(timer); this.running.delete(id); finish(); }
  }
  async close() { this.stopped = true; clearInterval(this.timer); const running = [...this.running.values()]; for (const item of running) item.controller.abort(); await Promise.allSettled(running.map(item => item.done)); }
}
