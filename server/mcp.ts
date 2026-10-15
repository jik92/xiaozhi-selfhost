import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Store } from './store';
import type { Json } from '../shared/types';
import { BUILTIN_ID, BUILTIN_TOOLS, runBuiltin } from './builtin-tools';

export class McpManager {
  clients = new Map<string, Client>();
  constructor(private store: Store) {}
  async connect(id: string) {
    const existing = this.clients.get(id); if (existing) return existing;
    const config = this.store.endpoints().find(e => e.id === id); if (!config) throw new Error('MCP 服务不存在');
    const headers = config.token ? { Authorization: `Bearer ${config.token}` } : undefined;
    const client = new Client({ name: 'xiaozhi-local', version: '0.1.0' });
    const transport = config.transport === 'sse' ? new SSEClientTransport(new URL(config.url), { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => { const merged = new Headers(init?.headers); if (config.token) merged.set('Authorization', `Bearer ${config.token}`); return fetch(input, { ...init, headers: merged }); } } }) : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } });
    try { await client.connect(transport, { timeout: 10000 }); } catch (e) { await transport.close().catch(() => {}); throw e; }
    this.clients.set(id, client); client.onclose = () => { this.clients.delete(id); };
    this.store.log('success', 'MCP', `${config.name} 已连接`); return client;
  }
  async list(id: string) { return id === BUILTIN_ID ? structuredClone(BUILTIN_TOOLS) : (await (await this.connect(id)).listTools({}, { timeout: 10000 })).tools; }
  async call(id: string, name: string, args: Json, signal?: AbortSignal) {
    this.store.log('info', 'MCP', `调用 ${id === BUILTIN_ID ? '本地内置工具' : this.store.endpoints().find(e => e.id === id)?.name} / ${name}`);
    const result = id === BUILTIN_ID ? await runBuiltin(name, args, signal) : await (await this.connect(id)).callTool({ name, arguments: args }, undefined, { timeout: 20000, signal });
    return JSON.parse(this.store.redact(JSON.stringify(result)));
  }
  async available() {
    const items: { id: string; name: string; tool: Json }[] = BUILTIN_TOOLS.map(tool => ({ id: BUILTIN_ID, name: `${BUILTIN_ID}__${tool.name}`, tool }));
    for (const e of this.store.endpoints()) {
      try { for (const tool of await this.list(e.id)) items.push({ id: e.id, name: `${e.id}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64), tool }); }
      catch (error) { this.store.log('warn', 'MCP', `跳过不可用服务 ${e.name}：${String(error)}`); }
    }
    return items;
  }
  async disconnect(id: string) { await this.clients.get(id)?.close(); this.clients.delete(id); }
  async close() { await Promise.allSettled([...this.clients.values()].map(c => c.close())); this.clients.clear(); }
}
