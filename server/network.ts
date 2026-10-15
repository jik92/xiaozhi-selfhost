import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { spawnSync } from 'node:child_process';

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;
const privateIpv4 = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
export function selectLocalHost(interfaces: Interfaces, preferred?: string) {
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) => {
    if (/^(lo\d*|utun\d*|tun\d*|tap\d*|docker\d*|veth.*|bridge.*|br-.*|vmnet.*|vmenet.*|awdl.*|llw.*|ap\d*|tailscale.*|wg\d*)$/.test(name)) return [];
    return (addresses || []).filter(a => a.family === 'IPv4' && !a.internal && privateIpv4.test(a.address)).map(a => ({ name, address: a.address }));
  });
  return candidates.find(a => a.name === preferred)?.address
    || candidates.find(a => /^(en\d+|eth\d+|wlan\d+|wl\w+|enp\w+|ens\w+)$/.test(a.name))?.address
    || candidates[0]?.address || '127.0.0.1';
}
let route: { checked: number; name?: string } | undefined;
function defaultInterface() {
  if (route && Date.now() - route.checked < 2000) return route.name;
  let name: string | undefined;
  try {
    const result = process.platform === 'darwin'
      ? spawnSync('/sbin/route', ['-n', 'get', 'default'], { encoding: 'utf8', timeout: 500 })
      : process.platform === 'linux'
        ? spawnSync('ip', ['-4', 'route', 'show', 'default'], { encoding: 'utf8', timeout: 500 }) : undefined;
    if (result?.status === 0) name = result.stdout.match(/interface:\s*(\S+)|\bdev\s+(\S+)/)?.slice(1).find(Boolean);
  } catch { /* Fall back to physical interfaces if route discovery is unavailable. */ }
  route = { checked: Date.now(), name }; return name;
}
export function localHost() { return selectLocalHost(networkInterfaces(), defaultInterface()); }
