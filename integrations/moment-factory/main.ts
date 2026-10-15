import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { bridgeConfigSchema, MomentBridge } from './bridge';
import { createMomentHandler } from './host';

export async function readPrivateFile(filename: string) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 128 * 1024 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid private file');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
async function main() {
  const token = (await readPrivateFile(process.env.MOMENT_VOICE_TOKEN_FILE ?? 'data/moment/mcp.token')).trim();
  let bridge: MomentBridge | undefined;
  if (process.env.MOMENT_VOICE_CONFIG) {
    const filename = path.resolve(process.env.MOMENT_VOICE_CONFIG);
    const config = bridgeConfigSchema.parse(JSON.parse(await readPrivateFile(filename)));
    const key = (await readPrivateFile(path.resolve(path.dirname(filename), config.signingKeyFile))).trim();
    bridge = new MomentBridge(config, key);
  }
  const port = Number(process.env.MOMENT_VOICE_PORT ?? 8792);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid MCP port');
  const handler = createMomentHandler(token, bridge);
  const server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 30, fetch: handler });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await server.stop(true); process.exit(0); });
  console.log(`Moment voice MCP: http://127.0.0.1:${port}/mcp (read-only)`);
}
if (import.meta.main) main().catch(() => { console.error('Moment MCP startup failed; check private configuration.'); process.exit(1); });
