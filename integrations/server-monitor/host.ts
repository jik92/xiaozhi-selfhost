import { timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GrafanaMonitor } from './monitor';

const tools: Tool[] = [
  ['server_monitor_overview', '检查所有服务器、CPU、内存、根分区磁盘、容器采集及 PostgreSQL/Redis。用户要求检查服务器并播报时调用；按 speech 用当前角色播报，必须说明告警和数据缺失。'],
  ['server_monitor_node', '检查指定服务器，node 必须使用概览中返回的节点名称。'],
  ['server_monitor_alerts', '获取服务器当前告警和缺失指标，用于简短语音播报。'],
  ['server_monitor_connection_status', '实际查询监控指标，验证 Grafana 授权及数据可用性。'],
].map(([name, description]): Tool => ({ name: name!, description, inputSchema: { type: 'object', properties: name === 'server_monitor_node' ? { node: { type: 'string', description: '监控中的完整节点名称' } } : {}, ...(name === 'server_monitor_node' ? { required: ['node'] } : {}), additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }));

export function createMonitorHandler(secret: string, monitor: GrafanaMonitor) {
  if (Buffer.byteLength(secret) < 32) throw new Error('MCP token must be at least 32 bytes');
  const expected = Buffer.from(`Bearer ${secret}`);
  return async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== '/mcp') return new Response(null, { status: 404 });
    const supplied = Buffer.from(request.headers.get('authorization') ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return new Response(null, { status: 401 });
    if (request.headers.has('origin')) return new Response(null, { status: 403 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0; let expired = false;
    const deadline = setTimeout(() => { expired = true; void reader?.cancel().catch(() => {}); }, 15000);
    try {
      if (reader) for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 128 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }); }
        chunks.push(value);
      }
    } catch { return new Response(null, { status: 400 }); }
    finally { clearTimeout(deadline); reader?.releaseLock(); }
    if (expired) return new Response(null, { status: 408 });
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return new Response(null, { status: 400 }); }
    const server = new Server({ name: 'xiaozhi-server-monitor', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        if (!tools.some(t => t.name === params.name)) throw new Error('unknown tool');
        const input = (params.name === 'server_monitor_node' ? z.object({ node: z.string().min(1).max(120) }).strict() : z.object({}).strict()).parse(params.arguments ?? {});
        const report = await monitor.overview(request.signal);
        let output: unknown = report;
        if (params.name === 'server_monitor_node') {
          const node = report.nodes.find(n => n.name === ('node' in input ? input.node : ''));
          if (!node) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: '未找到节点', availableNodes: report.nodes.map(n => n.name) }) }] };
          output = { queriedAt: report.queriedAt, node, thresholds: report.thresholds, alerts: report.alerts.filter(a => a.message.startsWith(`${node.name} `)), unknowns: report.unknowns.filter(a => a.startsWith(`${node.name} `)) };
        } else if (params.name === 'server_monitor_alerts') output = { queriedAt: report.queriedAt, status: report.status, alerts: report.alerts, unknowns: report.unknowns, speech: report.speech };
        else if (params.name === 'server_monitor_connection_status') output = { connected: true, source: report.source, queriedAt: report.queriedAt, status: report.status, discoveredNodes: report.discoveredNodes, scrapeUp: report.scrapeUp, unknowns: report.unknowns };
        return { content: [{ type: 'text', text: JSON.stringify(output) }] };
      } catch { return { isError: true, content: [{ type: 'text', text: '监控查询失败或参数无效；请检查服务日志、Grafana 只读凭据和数据源。无法确认服务器状态。' }] }; }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body), signal: request.signal }), { parsedBody: body });
      const output = await response.arrayBuffer();
      return new Response(output.byteLength ? output : null, { status: response.status, headers: response.headers });
    } finally { await server.close(); }
  };
}
