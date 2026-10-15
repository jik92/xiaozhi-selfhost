import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { GrafanaMonitor, monitorConfigSchema } from './monitor';
import { createMonitorHandler } from './host';

export async function readPrivateFile(filename: string) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 128 * 1024 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid private file');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
async function main() {
  const filename = path.resolve(process.env.SERVER_MONITOR_CONFIG ?? 'data/server-monitor/config.json');
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  let raw = '{}';
  try { raw = await readPrivateFile(filename); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const config = monitorConfigSchema.parse(JSON.parse(raw));
  const grafanaToken = (await readPrivateFile(path.resolve(path.dirname(filename), config.grafanaTokenFile))).trim();
  if (!grafanaToken || /[\r\n]/.test(grafanaToken)) throw new Error('Invalid Grafana token');
  const tokenFile = path.resolve(process.env.SERVER_MONITOR_TOKEN_FILE ?? path.join(path.dirname(filename), 'mcp.token'));
  try { await writeFile(tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  const secret = (await readPrivateFile(tokenFile)).trim();
  const port = Number(process.env.SERVER_MONITOR_PORT ?? 8793);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 30, fetch: createMonitorHandler(secret, new GrafanaMonitor(config, grafanaToken)) });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await server.stop(true); process.exit(0); });
  console.log(`Server monitor MCP: http://127.0.0.1:${port}/mcp (read-only; Grafana ${config.grafanaUrl})`);
}
if (import.meta.main) main().catch(() => { console.error('Server monitor MCP startup failed; check private configuration, token file permissions and port.'); process.exit(1); });
