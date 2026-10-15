import { createHash, createHmac } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import manifest from './read-tools.json';

export const bridgeConfigSchema = z.object({
  url: z.string().url().refine(value => {
    const u = new URL(value);
    return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)));
  }),
  signingKeyFile: z.string().min(1),
  scope: z.object({
    agentId: z.enum(['industrial-customer-assistant', 'middle-platform-engineer', 'remote-support-engineer']),
    identityRef: z.string().min(1).max(200), tenantId: z.string().min(1).max(200),
  }).strict(),
  allowedTools: z.array(z.string().refine(name => manifest.tools.includes(name))).min(1).max(32),
}).strict();
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;
export type Scope = BridgeConfig['scope'] & { purpose: 'control-read'; traceId: string; recordId?: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function grantId(tool: string, input: Record<string, unknown>, actionKey: string) {
  return `platform:${createHash('sha256').update(canonical([tool, input, actionKey])).digest('hex')}`;
}
export function issueToken(key: string, scope: Scope, now = Date.now()) {
  if (Buffer.byteLength(key) < 32) throw new Error('MCP signing key must be at least 32 bytes');
  const body = Buffer.from(JSON.stringify({ issuer: 'moment-runtime', audience: 'moment-business-mcp', issuedAt: now, expiresAt: now + 120000, scope })).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

/** 协议适配只连接独立 Bridge；IAM 身份、参数校验、业务审计仍由 registry 执行。 */
export class MomentBridge {
  constructor(readonly config: BridgeConfig, private readonly key: string) { bridgeConfigSchema.parse(config); issueToken(key, this.scope()); }
  private scope(): Scope { return { ...this.config.scope, purpose: 'control-read', traceId: crypto.randomUUID() }; }
  private async using<T>(scope: Scope, run: (client: Client) => Promise<T>) {
    const client = new Client({ name: 'xiaozhi-selfhost', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: { redirect: 'error' },
      fetch: (input, init) => {
        const request = new Request(input, init);
        request.headers.set('Authorization', `Bearer ${issueToken(this.key, scope)}`);
        return fetch(request, { redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) });
      },
    });
    try { await client.connect(transport, { timeout: 10000 }); return await run(client); }
    finally { await client.close(); }
  }
  async tools() {
    return this.using(this.scope(), async client => {
      const tools = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.listTools({ cursor }, { timeout: 10000 });
        for (const tool of page.tools) {
          if (!this.config.allowedTools.includes(tool.name) || !manifest.tools.includes(tool.name)) continue;
          const contract = tool._meta?.['moment-factory/contract'];
          if (!contract || typeof contract !== 'object' || !('version' in contract) || contract.version !== `openapi-${manifest.contractSha256}`) continue;
          const input = tool.inputSchema.properties?.input;
          if (!input || typeof input !== 'object' || !('type' in input) || input.type !== 'object') continue;
          tools.push({ name: tool.name, description: tool.description, inputSchema: input as typeof tool.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false } });
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('MCP cursor repeated');
        if (cursor) seen.add(cursor);
        if (seen.size > 32) throw new Error('Too many MCP pages');
      } while (cursor);
      return tools;
    });
  }
  async call(name: string, input: Record<string, unknown>) {
    if (!this.config.allowedTools.includes(name) || !manifest.tools.includes(name)) throw new Error('Tool is not in the read-only allowlist');
    // 不复用发现权限；独立 Bridge 在执行时再次核验真实 IAM 和 exact grant。
    const actionKey = crypto.randomUUID();
    const scope = { ...this.scope(), recordId: grantId(name, input, actionKey) };
    return this.using(scope, client => client.callTool({ name, arguments: { context: { ...scope, actionKey }, input, mode: 'execute' } }, undefined, { timeout: 12000 }));
  }
}
