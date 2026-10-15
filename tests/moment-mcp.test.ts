import { expect, test } from 'bun:test';
import { createHmac, createHash } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MomentBridge, bridgeConfigSchema } from '../integrations/moment-factory/bridge';
import { createMomentHandler } from '../integrations/moment-factory/host';
import { readPrivateFile } from '../integrations/moment-factory/main';
import manifest from '../integrations/moment-factory/read-tools.json';

const secret = 'voice-'.repeat(8);
const key = 'signing-'.repeat(8);
const name = manifest.tools[0]!;
async function connect(url: URL, token = secret) {
  const client = new Client({ name: 'voice-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

test('voice MCP works without registry and rejects unauthorized requests and invalid arguments', async () => {
  const handler = createMomentHandler(secret);
  expect((await handler(new Request('http://localhost/mcp', { method: 'POST' }))).status).toBe(401);
  const headers = { Authorization: `Bearer ${secret}` };
  expect((await handler(new Request('http://localhost/mcp', { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' } }))).status).toBe(403);
  expect((await handler(new Request('http://localhost/mcp', { method: 'POST', headers, body: 'x'.repeat(131073) }))).status).toBe(413);
  const host = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  const client = await connect(new URL('/mcp', host.url));
  try {
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['get_current_time', 'moment_connection_status']);
    expect((await client.callTool({ name: 'get_current_time', arguments: { timezone: 'Asia/Shanghai' } })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'get_current_time', arguments: { timezone: 'invalid' } })).isError).toBe(true);
    expect(JSON.stringify(await client.callTool({ name: 'moment_connection_status', arguments: {} }))).toContain('businessReady\\\":false');
    expect((await client.callTool({ name: 'platform.deleteDevice', arguments: {} })).isError).toBe(true);
  } finally { await client.close(); await host.stop(true); }
});

test('HTTP adapter uses fixed IAM scope and exact short-lived signed grant, and honors revocation', async () => {
  let enabled = true;
  let calls = 0;
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const raw = request.headers.get('authorization')?.slice(7) ?? '';
    const [body = '', signature] = raw.split('.');
    expect(signature).toBe(createHmac('sha256', key).update(body).digest('base64url'));
    const token = JSON.parse(Buffer.from(body, 'base64url').toString());
    expect(token.issuer).toBe('moment-runtime');
    expect(token.audience).toBe('moment-business-mcp');
    expect(token.expiresAt - token.issuedAt).toBe(120000);
    expect(token.scope.identityRef).toBe('dedicated-test-agent');
    const server = new Server({ name: 'registry-protocol-test', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: enabled ? [{ name, _meta: { 'moment-factory/contract': { version: `openapi-${manifest.contractSha256}` } }, inputSchema: { type: 'object', properties: { context: { type: 'object' }, input: { type: 'object', properties: { deviceId: { type: 'string' } }, additionalProperties: false } } } }, { name: 'platform.deleteDevice', inputSchema: { type: 'object', properties: {} } }] : [] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const args = params.arguments!;
      const context = args.context as Record<string, unknown>;
      expect(context.identityRef).toBe('dedicated-test-agent');
      expect(args.mode).toBe('execute');
      // input has one scalar field, so this independently checks the provider's canonical grant contract.
      const hash = createHash('sha256').update(JSON.stringify([name, { deviceId: '123' }, context.actionKey])).digest('hex');
      expect(token.scope.recordId).toBe(`platform:${hash}`);
      calls++;
      return { content: [{ type: 'text', text: '真实协议测试' }], structuredContent: { ok: true } };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      const output = await response.arrayBuffer();
      return new Response(output.byteLength ? output : null, { status: response.status, headers: response.headers });
    } finally { await server.close(); }
  } });
  const bridge = new MomentBridge({ url: new URL('/mcp', upstream.url).href, signingKeyFile: 'unused', scope: { agentId: 'industrial-customer-assistant', identityRef: 'dedicated-test-agent', tenantId: 'CUSTOMER:test' }, allowedTools: [name] }, key);
  const host = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createMomentHandler(secret, bridge) });
  const client = await connect(new URL('/mcp', host.url));
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name)).toContain(name);
    expect(tools.map(t => t.name)).not.toContain('platform.deleteDevice');
    expect(tools.find(t => t.name === name)?.inputSchema.properties).not.toHaveProperty('context');
    expect((await client.callTool({ name, arguments: { deviceId: '123' } })).isError).not.toBe(true);
    expect(calls).toBe(1);
    enabled = false;
    expect((await client.callTool({ name, arguments: { deviceId: '123' } })).isError).toBe(true);
    expect(calls).toBe(1);
    expect(bridgeConfigSchema.safeParse({ ...bridge.config, allowedTools: ['platform.deleteDevice'] }).success).toBe(false);
    expect(bridgeConfigSchema.safeParse({ ...bridge.config, url: 'http://example.com/mcp' }).success).toBe(false);
  } finally { await client.close(); await host.stop(true); await upstream.stop(true); }
});

test('private configuration rejects shared file permissions', async () => {
  const directory = await mkdtemp(`${tmpdir()}/moment-config-`);
  const file = `${directory}/config.json`;
  try {
    await writeFile(file, '{}', { mode: 0o600 });
    expect(await readPrivateFile(file)).toBe('{}');
    await chmod(file, 0o644);
    await expect(readPrivateFile(file)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true }); }
});
