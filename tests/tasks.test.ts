import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { TaskScheduler } from '../server/tasks';
import { nextTaskTime, type TaskInput } from '../shared/tasks';

const input: TaskInput = { name: '测试任务', prompt: '获取现在的时间', deviceId: 'test-device', enabled: true, schedule: { kind: 'interval', seconds: 10, repeat: 'once' } };
const result = { text: '任务完成', delivery: 'offline' as const };
function fixture() {
  const dir = mkdtempSync(`${tmpdir()}/xiaozhi-tasks-`); const store = new Store(dir); store.device('test-device');
  return { store, clean: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(5); } throw new Error('任务测试等待超时'); }

describe('persistent task scheduling', () => {
  test('daily schedules use Beijing time, and once-only dates must be in the future', () => {
    const now = Date.parse('2026-10-15T00:00:00Z');
    expect(nextTaskTime({ kind: 'scheduled', repeat: 'daily', time: '09:00' }, now)).toBe(Date.parse('2026-10-15T01:00:00Z'));
    expect(nextTaskTime({ kind: 'scheduled', repeat: 'daily', time: '07:00' }, now)).toBe(Date.parse('2026-10-15T23:00:00Z'));
    expect(() => nextTaskTime({ kind: 'scheduled', repeat: 'once', runAt: now - 1 }, now)).toThrow();
  });
  test('intervals prevent overlapping runs and do not replay every missed tick', async () => {
    const f = fixture(); let now = 100000; let calls = 0; let finish = () => {};
    const scheduler = new TaskScheduler(f.store, async () => { calls++; await new Promise<void>(r => { finish = r; }); return result; }, () => now, false);
    try {
      const task = scheduler.save(input); now += 10000; scheduler.tick(); expect(calls).toBe(1);
      now += 50000; scheduler.tick(); expect(calls).toBe(1);
      finish(); await until(() => scheduler.list()[0]?.lastStatus === 'success'); scheduler.tick(); expect(calls).toBe(2);
      expect(scheduler.list()[0]?.nextRunAt).toBe(now + 10000);
      finish(); await until(() => scheduler.list()[0]?.lastStatus === 'success'); scheduler.tick(); expect(calls).toBe(2);
      scheduler.enable(task.id, false); now += 100000; scheduler.tick(); expect(calls).toBe(2);
      scheduler.enable(task.id, true); expect(scheduler.list()[0]?.nextRunAt).toBe(now + 10000);
    } finally { finish(); await scheduler.close(); f.clean(); }
  });
  test('delay countdown survives restart and executes only once, even when overdue', async () => {
    const f = fixture(); let now = 100000; let calls = 0;
    let scheduler = new TaskScheduler(f.store, async () => { calls++; return result; }, () => now, false);
    try {
      const task = scheduler.save({ ...input, schedule: { kind: 'delay', seconds: 5 } });
      await scheduler.close(); now += 60000;
      scheduler = new TaskScheduler(f.store, async () => { calls++; return result; }, () => now, false);
      expect(scheduler.list()[0]?.nextRunAt).toBe(105000);
      scheduler.tick(); await until(() => scheduler.list()[0]?.lastStatus === 'success');
      scheduler.tick(); now += 100000; scheduler.tick();
      expect(calls).toBe(1); expect(scheduler.list()[0]?.enabled).toBe(false); expect(scheduler.list()[0]?.lastDelivery).toBe('offline');
      await scheduler.trigger(task.id); expect(calls).toBe(2); expect(scheduler.list()[0]?.enabled).toBe(false);
    } finally { await scheduler.close(); f.clean(); }
  });
  test('interrupted once-only actions are recorded as errors and never replayed automatically', async () => {
    const f = fixture(); let calls = 0;
    const scheduler = new TaskScheduler(f.store, async () => { calls++; return result; }, () => 100000, false);
    try {
      const task = scheduler.save({ ...input, schedule: { kind: 'delay', seconds: 1 } });
      f.store.set('aiTasks', [{ ...task, enabled: false, nextRunAt: undefined, lastStatus: 'running', runCount: 1 }]);
      const restarted = new TaskScheduler(f.store, async () => { calls++; return result; }, () => 200000, false);
      restarted.tick(); expect(calls).toBe(0); expect(restarted.list()[0]?.lastStatus).toBe('error'); await restarted.close();
    } finally { await scheduler.close(); f.clean(); }
  });
  test('cancellation, deletion and failures persist honest outcomes without resurrecting a deleted task', async () => {
    const f = fixture();
    const scheduler = new TaskScheduler(f.store, async (_, signal) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }), () => 100000, false);
    try {
      const task = scheduler.save(input); const run = scheduler.trigger(task.id);
      expect(() => scheduler.assertRunnable(task.id)).toThrow();
      scheduler.cancel(task.id); await run; expect(scheduler.list()[0]?.lastStatus).toBe('error');
      const again = scheduler.trigger(task.id); scheduler.remove(task.id); await again;
      expect(scheduler.list()).toEqual([]);
      expect(() => scheduler.save({ ...input, deviceId: 'missing' })).toThrow();
      expect(() => scheduler.save({ ...input, schedule: { kind: 'interval', seconds: 0 } })).toThrow();
    } finally { await scheduler.close(); f.clean(); }
  });
});
