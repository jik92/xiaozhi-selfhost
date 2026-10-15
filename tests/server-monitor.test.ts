import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GrafanaMonitor, monitorConfigSchema, QUERIES, summarize } from '../integrations/server-monitor/monitor';
import { createMonitorHandler } from '../integrations/server-monitor/host';

const now = 1792068080000;
const config = monitorConfigSchema.parse({ expectedNodeCount: 1, expectedNodes: ['test-node'] });
function frame(value: unknown, name = 'test-node', timestamp = now) {
  return { schema: { fields: [{ type: 'time' }, { type: 'number', labels: { node: name } }] }, data: { values: [[timestamp], [value]] } };
}
function fixture() {
  const values: Record<string, number> = { cpu: 20, memory: 40, disk: 60, containers: 3, pg_connections: 10, pg_connections_percent: 1, redis_memory_bytes: 1024, redis_clients: 2 };
  return { results: Object.fromEntries(Object.keys(QUERIES).map(key => [key, { status: 200, frames: [frame(values[key] ?? 1)] }])) };
}
test('monitor reports thresholds, worst partition and separate database health', () => {
  const data = fixture();
  expect(summarize(data, config, now).status).toBe('ok');
  data.results.disk!.frames.push(frame(96));
  data.results.pg_up!.frames = [frame(0)];
  const r = summarize(data, config, now);
  expect(r.status).toBe('critical');
  expect(r.nodes[0]!.disk!.value).toBe(96);
  expect(r.services[0]!.scrape).toBe('up');
  expect(r.services[0]!.health).toBe('down');
  expect(r.alerts).toHaveLength(2);
  expect(r.speech).toContain('96%');
});
test('missing, stale, invalid and failed metrics never produce healthy report', () => {
  const data = fixture();
  data.results.cpu!.frames = [frame(null)];
  data.results.memory!.frames = [frame(40, 'test-node', now - 121000)];
  data.results.disk!.frames = [frame(101)];
  data.results.pg_up!.frames = [];
  Object.assign(data.results.redis_up!, { error: 'private upstream diagnostic' });
  const r = summarize(data, config, now);
  expect(r.status).toBe('unknown');
  expect(r.nodes[0]!.cpu).toBeNull();
  expect(r.nodes[0]!.memory).toBeNull();
  expect(r.nodes[0]!.disk).toBeNull();
  expect(r.services[0]!.health).toBe('unknown');
  expect(r.speech).toContain('不能确认全部正常');
  expect(JSON.stringify(r)).not.toContain('private upstream diagnostic');
  expect(summarize({ results: {} }, config, now).status).toBe('unknown');
  expect(summarize({ results: { cpu: { frames: {} } } }, config, now).status).toBe('unknown');
});
test('batch uses fixed queries, coalesces requests, expires cache and sanitizes upstream errors', async () => {
  let count = 0; let clock = now; let fail = false;
  const request = (async (url: any, init: any) => {
    count++;
    expect(String(url)).toBe('https://monitor.ounirobot.com/api/ds/query');
    expect(init.headers.Authorization).toBe('Bearer private-test');
    expect(JSON.parse(init.body).queries.map((q: any) => q.expr)).toEqual(Object.values(QUERIES));
    return fail ? new Response('private-test secret error', { status: 401 }) : Response.json(fixture());
  }) as unknown as typeof fetch;
  const monitor = new GrafanaMonitor(config, 'private-test', request, () => clock);
  const [first, second] = await Promise.all([monitor.overview(), monitor.overview()]);
  expect(count).toBe(1);
  first.nodes.length = 0;
  expect(second.nodes.length).toBe(1);
  clock += 15001; fail = true;
  await expect(monitor.overview()).rejects.toThrow('Grafana 拒绝访问');
  expect(count).toBe(2);
  // Failed refresh must not serve the previous healthy report.
  await expect(monitor.overview()).rejects.toThrow('Grafana 拒绝访问');
  expect(count).toBe(3);
});
test('monitor bounds responses and rejects bad origins in configuration', async () => {
  expect(monitorConfigSchema.safeParse({ grafanaUrl: 'https://user:password@example.com/' }).success).toBe(false);
  expect(monitorConfigSchema.safeParse({ grafanaUrl: 'http://example.com/' }).success).toBe(false);
  const oversized = new GrafanaMonitor(config, 'test', (async () => new Response('x'.repeat(2 * 1048576 + 1))) as unknown as typeof fetch);
  await expect(oversized.overview()).rejects.toThrow('响应过大');
});
test('real MCP SDK authenticates, lists and calls readonly tools; invalid inputs cannot run arbitrary queries', async () => {
  let count = 0;
  const monitor = new GrafanaMonitor(config, 'secret-grafana', (async () => { count++; return Response.json(fixture()); }) as unknown as typeof fetch, () => now);
  const secret = 'test-mcp-'.repeat(8);
  const handler = createMonitorHandler(secret, monitor);
  expect((await handler(new Request('http://localhost/mcp', { method: 'POST' }))).status).toBe(401);
  expect((await handler(new Request('http://localhost/mcp', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, Origin: 'https://evil.example' } }))).status).toBe(403);
  expect((await handler(new Request('http://localhost/mcp', { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: 'x'.repeat(131073) }))).status).toBe(413);
  const host = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  const client = new Client({ name: 'monitor-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', host.url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(4);
    expect(tools.every(t => t.annotations?.readOnlyHint)).toBe(true);
    expect((await client.callTool({ name: 'server_monitor_overview', arguments: { expr: 'arbitrary' } })).isError).toBe(true);
    expect(count).toBe(0);
    const r = await client.callTool({ name: 'server_monitor_overview', arguments: {} });
    expect(r.isError).not.toBe(true);
    expect(JSON.stringify(r)).toContain('test-node');
    expect(JSON.stringify(r)).not.toContain('secret-grafana');
    expect((await client.callTool({ name: 'server_monitor_node', arguments: { node: 'missing' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'server_monitor_node', arguments: { node: 'test-node' } })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'delete_server', arguments: {} })).isError).toBe(true);
    expect(count).toBe(1);
  } finally { await client.close(); await host.stop(true); }
});
