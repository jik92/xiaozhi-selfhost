import { expect, test } from 'bun:test';
import { BOARDS, PASSPORT_FIRMWARE, validateBoard, validateMergedFirmware, resizeNvs } from '../shared/firmware';
import { provisionNvs, readNvsString, readNvs, compactNvs } from '../shared/nvs';

const image = new Uint8Array(await Bun.file(`public/firmware/${PASSPORT_FIRMWARE.name}`).arrayBuffer());
test('bundled Passport firmware has the pinned digest and a valid 8 MB C3 layout', async () => {
  expect(image.length).toBe(PASSPORT_FIRMWARE.size);
  expect(new Bun.CryptoHasher('sha256').update(image).digest('hex')).toBe(PASSPORT_FIRMWARE.sha256);
  const p = validateMergedFirmware(image, 5, 8 * 1048576, 'ai-passport');
  expect(p.offset).toBe(0x9000); expect(p.size).toBe(0x4000);
  validateBoard('ai-passport', { name: 'ESP32-C3 (QFN32)', flashSize: 8 * 1048576 });
  expect(BOARDS['ai-passport'].label).toBe('FoloToy AI Passport');
});
test('rejects wrong chips, insufficient capacity, foreign boards, app-only and truncated firmware', () => {
  expect(() => validateBoard('ai-passport', { name: 'ESP32-S3', flashSize: 8 * 1048576 })).toThrow('芯片');
  expect(() => validateBoard('ai-passport', { name: 'ESP32-C3', flashSize: 4 * 1048576 })).toThrow('8 MB');
  expect(() => validateMergedFirmware(image, 9, 8 * 1048576, 'ai-passport')).toThrow('芯片');
  expect(() => validateMergedFirmware(image, 5, 4 * 1048576, 'ai-passport')).toThrow('容量');
  expect(() => validateMergedFirmware(image.subarray(0, 0x30000), 5, 8 * 1048576, 'ai-passport')).toThrow('完整应用');
  const foreign = image.slice(); const marker = new TextEncoder().encode('ai-passport');
  for (let i = 0; i <= foreign.length - marker.length; i++) if (marker.every((v, j) => foreign[i + j] === v)) foreign.fill(0, i, i + marker.length);
  expect(() => validateMergedFirmware(foreign, 5, 8 * 1048576, 'ai-passport')).toThrow('板型');
});
test('NVS size changes preserve credentials and identity without truncating populated pages', () => {
  const original = provisionNvs(new Uint8Array(0x6000).fill(255), [
    { namespace: 'wifi', key: 'ssid', value: 'Passport Wi-Fi' },
    { namespace: 'board', key: 'uuid', value: 'private-identity' },
  ]);
  const smaller = resizeNvs(original, 0x4000);
  const updated = provisionNvs(smaller, [{ namespace: 'wifi', key: 'ota_url', value: 'http://192.168.1.2:18080/xiaozhi/ota/' }]);
  expect(readNvsString(updated, 'wifi', 'ssid')).toBe('Passport Wi-Fi');
  expect(readNvsString(updated, 'board', 'uuid')).toBe('private-identity');
  expect(readNvsString(original, 'wifi', 'ota_url')).toBeUndefined();
  expect(resizeNvs(smaller, 0x6000)).toEqual(original);
  const populated = original.slice(); populated[0x5000] = 0;
  expect(() => resizeNvs(populated, 0x4000)).toThrow();
});

test('24 KB → 16 KB migration compacts live entries and keeps an erased page for IDF', () => {
  let original = provisionNvs(new Uint8Array(0x6000).fill(255), [{ namespace: 'board', key: 'uuid', value: 'preserved-identity' }]);
  // Churn spreads records over four pages, reproducing the observed device layout.
  for (let i = 0; i < 7; i++) original = provisionNvs(original, [{ namespace: 'vendor', key: 'profile', value: `${i}:` + 'x'.repeat(1800) }]);
  expect(Array.from({ length: 4 }, (_, i) => original.subarray(i * 4096, (i + 1) * 4096).some(b => b !== 255)).every(Boolean)).toBe(true);
  const before = original.slice(); const result = resizeNvs(original, 0x4000);
  expect(original).toEqual(before);
  expect(result.subarray(0x3000).every(b => b === 255)).toBe(true);
  expect(readNvs(result).map(e => [e.namespace, e.key, [...e.entry], [...e.payload]])).toEqual(readNvs(original).map(e => [e.namespace, e.key, [...e.entry], [...e.payload]]));
  const configured = provisionNvs(result, [{ namespace: 'wifi', key: 'ota_url', value: 'http://local/xiaozhi/ota/' }]);
  expect(readNvsString(configured, 'board', 'uuid')).toBe('preserved-identity');
  expect(readNvsString(configured, 'vendor', 'profile')).toBe('6:' + 'x'.repeat(1800));
  expect(readNvsString(configured, 'wifi', 'ota_url')).toBe('http://local/xiaozhi/ota/');
  expect(configured.subarray(0x3000).every(b => b === 255)).toBe(true);
});

test('migration refuses insufficient space for live records and the IDF spare page', () => {
  let original = new Uint8Array(0x6000).fill(255);
  for (let i = 0; i < 5; i++) original = provisionNvs(original, [{ namespace: 'vendor', key: `value${i}`, value: 'x'.repeat(1800) }]);
  expect(() => compactNvs(original, 0x3000)).toThrow('空闲页');
});
