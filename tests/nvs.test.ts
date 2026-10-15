import { describe, expect, test } from 'bun:test';
import { crc32, provisionNvs, readNvs, readNvsString, partitions } from '../shared/nvs';

describe('ESP-IDF NVS v2 provisioning', () => {
  test('matches ESP-IDF zlib CRC seed and preserves other values', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xd202d277);
    const original = provisionNvs(new Uint8Array(0x4000).fill(255), [
      { namespace: 'wifi', key: 'ssid', value: '测试网络' }, { namespace: 'wifi', key: 'password', value: 'private-value' },
      { namespace: 'board', key: 'uuid', value: 'board-identity' },
    ]);
    const before = original.slice();
    const updated = provisionNvs(original, [{ namespace: 'wifi', key: 'ota_url', value: 'http://192.168.1.1:18080/xiaozhi/ota/' }, { namespace: 'websocket', key: 'version', value: 1 }]);
    expect(original).toEqual(before);
    expect(readNvsString(updated, 'wifi', 'ssid')).toBe('测试网络');
    expect(readNvsString(updated, 'wifi', 'password')).toBe('private-value');
    expect(readNvsString(updated, 'board', 'uuid')).toBe('board-identity');
    expect(readNvsString(updated, 'wifi', 'ota_url')).toContain('18080');
    expect(readNvs(updated).find(e => e.key === 'version')?.type).toBe(0x14);
  });
  test('overwrites by appending, invalidates old entries, survives page rollover', () => {
    let data = new Uint8Array(0x5000).fill(255);
    for (let i = 0; i < 35; i++) data = provisionNvs(data, [{ namespace: 'wifi', key: 'ota_url', value: `http://192.168.1.2/${i}/` }]);
    expect(readNvsString(data, 'wifi', 'ota_url')).toBe('http://192.168.1.2/34/');
    expect(readNvs(data).filter(e => e.key === 'ota_url')).toHaveLength(1);
  });
  test('rejects corrupt/encrypted data and full partitions before returning an image', () => {
    const original = provisionNvs(new Uint8Array(0x3000).fill(255), [{ namespace: 'wifi', key: 'ssid', value: 'ok' }]);
    const bad = original.slice(); bad[29] = bad[29]! ^ 1;
    expect(() => provisionNvs(bad, [{ namespace: 'wifi', key: 'ota_url', value: 'test' }])).toThrow('校验');
    let data = original;
    expect(() => { for (let i = 0; i < 20; i++) data = provisionNvs(data, [{ namespace: 'wifi', key: 'ota_url', value: 'a'.repeat(1800) }]); }).toThrow('空间不足');
    expect(() => partitions(new Uint8Array(4096))).toThrow('分区表');
  });
});
