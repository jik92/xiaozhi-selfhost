import { test, expect } from 'bun:test';
import { bounded, resetAndRelease } from '../shared/serial-reset';

test('reset pulses EN with DTR low before releasing the serial transport', async () => {
  const order: unknown[] = [];
  const sent = await resetAndRelease({ async setSignals(s) { order.push(s); }, async close() { order.push('close'); } }, { async disconnect() { order.push('disconnect'); } }, () => {}, async ms => { order.push(ms); });
  expect(sent).toBe(true);
  expect(order).toEqual([{ dataTerminalReady: false, requestToSend: true }, 150, { dataTerminalReady: false, requestToSend: false }, 'disconnect']);
});
test('USB disappearance does not undo successful flash or hang cleanup', async () => {
  const logs: string[] = []; let closed = false;
  const sent = await resetAndRelease({ async setSignals() { throw new Error('device disappeared'); }, async close() { closed = true; } }, { async disconnect() { throw new Error('reader already released'); } }, text => logs.push(text));
  expect(sent).toBe(false); expect(closed).toBe(true); expect(logs.some(l => l.includes('配置已写入'))).toBe(true);
});
test('a stuck Web Serial operation is bounded', async () => {
  await expect(bounded(new Promise(() => {}), 10, '释放串口')).rejects.toThrow('释放串口超时');
});
