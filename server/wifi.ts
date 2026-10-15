import { fileURLToPath } from 'node:url';
import type { WifiNetwork, WifiScan } from '../shared/wifi';

// Keep the strongest access point for each SSID/band; dual-band names remain distinguishable.
export function normalizeNetworks(networks: WifiNetwork[]): WifiNetwork[] {
  const unique = new Map<string, WifiNetwork>();
  for (const network of networks) {
    if (!network.ssid || Buffer.byteLength(network.ssid) > 32 || !Number.isFinite(network.signal)) continue;
    const key = JSON.stringify([network.ssid, network.band]);
    if (!unique.has(key) || unique.get(key)!.signal < network.signal) unique.set(key, network);
  }
  return [...unique.values()].sort((a, b) => Number(b.band === '2.4GHz') - Number(a.band === '2.4GHz') || b.signal - a.signal || a.ssid.localeCompare(b.ssid));
}

let pending: Promise<WifiScan> | undefined;
let cached: { at: number; result: WifiScan } | undefined;
export function scanWifi(): Promise<WifiScan> {
  if (cached && Date.now() - cached.at < 15000) return Promise.resolve(cached.result);
  if (pending) return pending;
  pending = scan().then(result => { cached = { at: Date.now(), result }; return result; }).finally(() => { pending = undefined; });
  return pending;
}

async function scan(): Promise<WifiScan> {
  if (process.platform !== 'darwin') throw new Error('Wi-Fi 扫描目前支持 macOS，请手动输入网络名称');
  if (!Bun.which('swift')) throw new Error('扫描需要 Swift 命令行工具，请安装 Xcode Command Line Tools，或手动输入网络名称');
  const child = Bun.spawn(['swift', fileURLToPath(new URL('../scripts/scan-wifi.swift', import.meta.url))], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error('扫描未完成：请检查 Swift 命令行工具与 Wi-Fi 权限，也可手动输入');
    const result = JSON.parse(stdout) as WifiScan & { error?: string };
    if (result.error) throw new Error(result.error);
    if (!Array.isArray(result.networks)) throw new Error('Wi-Fi 扫描返回无效结果');
    return { networks: normalizeNetworks(result.networks), warning: result.warning || undefined };
  } finally { clearTimeout(timer); }
}
