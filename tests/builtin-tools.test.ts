import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bashCommand, parseSearchResults, runBuiltin } from '../server/builtin-tools';
import { startApp } from '../server/index';
import type { Json } from '../shared/types';

test('time and web search results have structured output and validate input', async () => {
  const time = JSON.parse((await runBuiltin('get_current_time', { timezone: 'Asia/Shanghai' })).content[0].text);
  expect(time.timezone).toBe('Asia/Shanghai'); expect(Number.isFinite(Date.parse(time.iso))).toBe(true);
  await expect(runBuiltin('get_current_time', { timezone: 'invalid-zone' })).rejects.toThrow();
  expect(parseSearchResults('<rss><channel><item><title>A &amp; B</title><link>https://example.org/</link><description>结果</description></item><item><link>javascript:bad()</link></item></channel></rss>', 5)).toEqual([{ title: 'A & B', url: 'https://example.org/', snippet: '结果' }]);
  expect(() => parseSearchResults('<html>captcha</html>', 5)).toThrow();
  await expect(runBuiltin('websearch', { query: '' })).rejects.toThrow();
});
test('Bash captures exit code, both output streams, truncation, timeout and cancellation', async () => {
  const cwd = process.cwd();
  const output = await bashCommand("printf 'ok'; printf 'error' >&2; exit 7", cwd, 5);
  expect(output.stdout).toBe('ok'); expect(output.stderr).toBe('error'); expect(output.exitCode).toBe(7);
  const large = await bashCommand("head -c 20000 /dev/zero | tr '\\0' x", cwd, 5);
  expect(large.truncated).toBe(true); expect(large.stdout.length).toBe(16384);
  const timeout = await bashCommand('sleep 20', cwd, 1); expect(timeout.timedOut).toBe(true);
  const controller = new AbortController(); const pending = bashCommand('sleep 20', cwd, 10, controller.signal); controller.abort();
  await expect(pending).rejects.toThrow('取消');
  await expect(bashCommand('pwd', '/definitely-not-a-directory-xiaozhi', 1)).rejects.toThrow();
}, 10000);

test('an offline scheduled user message invokes built-in MCP through the real AI loop and stores its answer', async () => {
  const dir = mkdtempSync(`${tmpdir()}/xiaozhi-task-api-`); let calls = 0; const received: Json[] = [];
  const upstream = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as Json; received.push(body); calls++;
    return Response.json({ choices: [{ message: calls === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'clock', type: 'function', function: { name: 'builtin__get_current_time', arguments: '{"timezone":"Asia/Shanghai"}' } }] } : { role: 'assistant', content: '已经查到当前时间。' } }] });
  } });
  const app = await startApp({ port: 0, dataDir: dir, transports: false });
  const base = `http://127.0.0.1:${app.server.port}/api`;
  try {
    app.store.device('offline-device');
    app.store.saveSettings({ ...app.store.settings, llm: { ...app.store.settings.llm, apiKey: 'private-test-key', baseUrl: `http://127.0.0.1:${upstream.port}` } });
    const tools = await (await fetch(`${base}/mcp/builtin/tools`)).json() as Json;
    expect(tools.tools.map((t: Json) => t.name)).toEqual(['get_current_time', 'websearch', 'bash']);
    const created = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '离线任务', deviceId: 'offline-device', prompt: '现在几点？', schedule: { kind: 'delay', seconds: 60 } }) });
    expect(created.status).toBe(201); const task = await created.json() as Json;
    const start = await fetch(`${base}/tasks/${task.id}/run`, { method: 'POST' }); expect(start.status).toBe(202);
    for (let i = 0; i < 100 && app.tasks.list()[0]?.lastStatus === 'running'; i++) await Bun.sleep(10);
    expect(app.tasks.list()[0]?.lastStatus).toBe('success'); expect(app.tasks.list()[0]?.lastDelivery).toBe('offline');
    expect(app.tasks.list()[0]?.enabled).toBe(false); expect(app.tasks.list()[0]?.lastResult).toBe('已经查到当前时间。');
    expect(app.store.devices.get('offline-device')?.online).toBe(false); expect(app.manager.sessions.size).toBe(0);
    expect(received[0]?.messages.some((m: Json) => m.role === 'user' && m.content === '现在几点？')).toBe(true);
    expect(received[0]?.tools.some((t: Json) => t.function.name === 'builtin__bash')).toBe(true);
    expect(received[1]?.messages.some((m: Json) => m.role === 'tool' && m.content.includes('Asia/Shanghai'))).toBe(true);
    expect((await fetch(`${base}/mcp/builtin`, { method: 'DELETE' })).status).toBe(400);
    const redacted = await app.mcp.call('builtin', 'bash', { command: 'printf private-test-key' }); expect(JSON.stringify(redacted)).not.toContain('private-test-key');
    const removed = await fetch(`${base}/tasks/${task.id}`, { method: 'DELETE' }); expect(removed.ok).toBe(true); expect(app.tasks.list()).toEqual([]);
  } finally { await app.close(); upstream.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
