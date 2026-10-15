import { expect, test } from 'bun:test';
import { normalizeNetworks } from '../server/wifi';

test('Wi-Fi choices retain SSIDs exactly, prefer 2.4GHz, and deduplicate strongest access points', () => {
  expect(normalizeNetworks([
    { ssid: '同名网络', signal: -20, band: '5/6GHz' },
    { ssid: '同名网络', signal: -80, band: '2.4GHz' },
    { ssid: '同名网络', signal: -40, band: '2.4GHz' },
    { ssid: ' Wi-Fi:客厅 ', signal: -30, band: '2.4GHz' },
    { ssid: '', signal: -10, band: '2.4GHz' },
    { ssid: '中'.repeat(11), signal: -10, band: '2.4GHz' },
  ])).toEqual([
    { ssid: ' Wi-Fi:客厅 ', signal: -30, band: '2.4GHz' },
    { ssid: '同名网络', signal: -40, band: '2.4GHz' },
    { ssid: '同名网络', signal: -20, band: '5/6GHz' },
  ]);
});
