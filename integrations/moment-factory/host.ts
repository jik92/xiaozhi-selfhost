import { timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { MomentBridge } from './bridge';

const timezoneInput = z.object({ timezone: z.string().max(100).default('Asia/Shanghai').refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }) }).strict();
const baseTools: Tool[] = [
  { name: 'get_current_time', description: '查询当前真实日期和时间，默认上海时区。', inputSchema: { type: 'object', properties: { timezone: { type: 'string', default: 'Asia/Shanghai' } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'moment_connection_status', description: '检查欧尼博本地 MCP 连接及真实业务工具授权；businessReady=false 时不能声称已查询工单。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } },
];
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
export function createMomentHandler(secret: string, bridge?: MomentBridge) {
  if (Buffer.byteLength(secret) < 32) throw new Error('MCP token must be at least 32 bytes');
  const expected = Buffer.from(`Bearer ${secret}`);
  return async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== '/mcp') return new Response(null, { status: 404 });
    const supplied = Buffer.from(request.headers.get('authorization') ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return new Response(null, { status: 401 });
    if (request.headers.has('origin')) return new Response(null, { status: 403 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const deadline = setTimeout(() => { void reader?.cancel().catch(() => {}); }, 15000);
    try {
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }); }
        chunks.push(value);
      }
    } catch { return new Response(null, { status: 400 }); }
    finally { clearTimeout(deadline); reader?.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return new Response(null, { status: 400 }); }
    const server = new Server({ name: 'moment-factory-xiaozhi', version: '1' }, { capabilities: { tools: {} } });
    const businessTools = async () => { try { return await bridge?.tools() ?? []; } catch { return []; } };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...baseTools, ...await businessTools()] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        const input = params.arguments ?? {};
        if (params.name === 'get_current_time') {
          const { timezone } = timezoneInput.parse(input);
          const now = new Date();
          return text({ utc: now.toISOString(), timezone, local: new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(now) });
        }
        if (params.name === 'moment_connection_status') {
          z.object({}).strict().parse(input);
          const tools = (await businessTools()).map(t => t.name);
          return text({ connected: true, businessReady: tools.length > 0, readOnly: true, tools,
            message: tools.length ? '已授权只读业务查询' : '尚未绑定有效的独立 Agent IAM 身份，当前仅支持连接检查和时间查询' });
        }
        if (!bridge || !(await businessTools()).some(t => t.name === params.name)) throw new Error('Unavailable tool');
        return await bridge.call(params.name, input);
      } catch { return { isError: true, content: [{ type: 'text', text: '工具不可用、参数无效或身份权限已失效；未执行业务写入。' }] }; }
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
