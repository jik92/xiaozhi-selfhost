import { expect, test } from 'bun:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { selectLocalHost } from '../server/network';
const address = (ip: string): NetworkInterfaceInfo => ({ address: ip, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${ip}/24` });

test('network discovery follows DHCP changes and ignores VPN and VM adapters', () => {
  const interfaces = { bridge100: [address('192.168.139.3')], utun4: [address('10.9.0.1')], en0: [address('192.168.0.194')] };
  expect(selectLocalHost(interfaces, 'utun4')).toBe('192.168.0.194');
  interfaces.en0 = [address('10.1.2.191')];
  expect(selectLocalHost(interfaces, 'en0')).toBe('10.1.2.191');
  expect(selectLocalHost({ bridge100: interfaces.bridge100, utun4: interfaces.utun4 })).toBe('127.0.0.1');
});
test('the default physical route wins with multiple LAN interfaces', () => {
  const interfaces = { en3: [address('192.168.5.2')], en0: [address('10.1.2.191')] };
  expect(selectLocalHost(interfaces, 'en0')).toBe('10.1.2.191');
  expect(selectLocalHost(interfaces, 'en3')).toBe('192.168.5.2');
});
