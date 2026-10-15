import { expect, test } from 'bun:test';
import { md5 } from 'js-md5';
import { SerialFlasher } from '../src/serial';
import { PASSPORT_FIRMWARE } from '../shared/firmware';
import { provisionNvs, readNvsString } from '../shared/nvs';

test('Passport full flash backs up NVS, provisions its board, verifies merged write and readback, then resets', async () => {
  const file = Bun.file(`public/firmware/${PASSPORT_FIRMWARE.name}`);
  const firmware = new File([await file.arrayBuffer()], file.name!);
  const flash = new Uint8Array(8 * 1048576).fill(255);
  flash.set(new Uint8Array(await file.arrayBuffer()).subarray(0x8000, 0x9000), 0x8000);
  new DataView(flash.buffer).setUint32(0x8000 + 8, 0x6000, true);
  let original = provisionNvs(new Uint8Array(0x6000).fill(255), [{ namespace: 'board', key: 'uuid', value: 'preserved' }]);
  for (let i = 0; i < 7; i++) original = provisionNvs(original, [{ namespace: 'vendor', key: 'profile', value: `${i}:` + 'x'.repeat(1800) }]);
  flash.set(original, 0x9000);
  let packets: Uint8Array[] = []; let backedUp = false; let requestedBoard = ''; let writes = 0; let released = false;
  const originalFetch = globalThis.fetch; const originalDocument = globalThis.document;
  const originalCreate = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:test';
  globalThis.document = { createElement: () => ({ click() { backedUp = true; } }) } as any;
  globalThis.fetch = (async (_url: any, init: RequestInit) => {
    requestedBoard = JSON.parse(String(init.body)).board;
    return Response.json({ changes: [{ namespace: 'wifi', key: 'ota_url', value: 'http://local/xiaozhi/ota/' }], otaUrl: 'http://local/xiaozhi/ota/' });
  }) as any;
  const logs: string[] = []; const stages: number[] = [];
  const flasher = new SerialFlasher(s => logs.push(s), p => stages.push(p));
  flasher.chip = { name: 'ESP32-C3', mac: 'aa:bb:cc:00:00:01', flashSize: flash.length };
  flasher.port = { async setSignals() {} } as any;
  flasher.transport = { async disconnect() { released = true; } } as any;
  flasher.loader = {
    IS_STUB: true, chip: { IMAGE_CHIP_ID: 5 }, ESP_READ_FLASH: 0xd2,
    async checkCommand(_desc: string, _cmd: number, command: Uint8Array) {
      const d = new DataView(command.buffer); const bytes = flash.slice(d.getUint32(0, true), d.getUint32(0, true) + d.getUint32(4, true));
      packets = []; for (let i = 0; i < bytes.length; i += 4096) packets.push(bytes.slice(i, i + 4096));
      packets.push(new Uint8Array(md5.array(bytes)));
    },
    transport: { async read() { return packets.shift()!; }, async write() {} },
    async writeFlash(options: any) {
      expect(backedUp).toBe(true); writes++;
      for (const part of options.fileArray) {
        expect(options.eraseAll).toBe(false);
        flash.set(part.data, part.address);
        expect(options.calculateMD5Hash(part.data)).toBe(md5(part.data));
      }
    },
  } as any;
  try {
    const id = await flasher.flash({ board: 'ai-passport', firmware, transport: 'websocket' });
    expect(id).toBe('aa:bb:cc:00:00:01'); expect(requestedBoard).toBe('ai-passport'); expect(writes).toBe(1);
    expect(readNvsString(flash.slice(0x9000, 0xd000), 'board', 'uuid')).toBe('preserved');
    expect(readNvsString(flash.slice(0x9000, 0xd000), 'wifi', 'ota_url')).toBe('http://local/xiaozhi/ota/');
    expect(flash.subarray(0xc000, 0xd000).every(b => b === 255)).toBe(true);
    expect(logs.join(' ')).toContain('24576 → 16384');
    expect(released).toBe(true); expect(stages.at(-1)).toBe(95); expect(logs.join(' ')).toContain('配置校验通过');
  } finally { globalThis.fetch = originalFetch; globalThis.document = originalDocument; URL.createObjectURL = originalCreate; }
});
