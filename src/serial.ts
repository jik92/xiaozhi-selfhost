import { ESPLoader, Transport } from 'esptool-js';
import { md5 } from 'js-md5';
import { partitions, provisionNvs, type Partition } from '../shared/nvs';
import { readFlashVerified } from '../shared/flash-reader';
import { resetAndRelease, bounded } from '../shared/serial-reset';

export interface ChipInfo { name: string; mac: string; flashSize: number; }
function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export class SerialFlasher {
  port?: SerialPort; transport?: Transport; loader?: ESPLoader; chip?: ChipInfo; monitor?: ReadableStreamDefaultReader<Uint8Array>; operation?: AbortController;
  constructor(private log: (text: string) => void, private progress: (value: number, step: string) => void) {}
  async connect() {
    if (!('serial' in navigator) || !window.isSecureContext) throw new Error('请使用 Chrome 打开 http://localhost:5178 或 HTTPS 页面');
    this.port = await navigator.serial.requestPort();
    this.transport = new Transport(this.port, false);
    this.loader = new ESPLoader({ transport: this.transport, baudrate: 115200, serialOptions: { bufferSize: 65536 }, terminal: { clean() {}, write: this.log, writeLine: this.log } });
    this.loader.FLASH_READ_TIMEOUT = 8000;
    try {
      this.progress(3, '识别芯片'); const name = await this.loader.main();
      const mac = (await this.loader.chip.readMac(this.loader)).toLowerCase();
      const id = await this.loader.readFlashId(); const flashSize = 2 ** ((id >> 16) & 255);
      if (!Number.isFinite(flashSize) || flashSize < 1024 * 1024 || flashSize > 128 * 1024 * 1024) throw new Error('无法可靠识别 Flash 容量');
      this.chip = { name, mac, flashSize }; this.log(`${name} · ${mac} · ${flashSize / 1048576} MB`); this.progress(8, '设备已识别'); return this.chip;
    } catch (error) { await this.disconnect(); throw error; }
  }
  async flash(options: { firmware?: File; transport: 'websocket' | 'mqtt'; ssid?: string; password?: string }) {
    const loader = this.loader; if (!loader || !this.chip) throw new Error('请先连接串口');
    if (!/ESP32-C3/i.test(this.chip.name)) throw new Error('当前自动配网配置针对 WHA103 / ESP32-C3；其他板型需要对应的配置适配');
    if (!loader.IS_STUB) throw new Error('Flash 读取需要已启动的下载程序，请重新连接设备');
    this.operation = new AbortController(); const signal = this.operation.signal;
    this.progress(10, '读取分区表'); this.log('读取分区表：0x8000，4096 字节（115200 baud）…');
    const table = await readFlashVerified(loader, 0x8000, 0x1000, undefined, signal); const current = partitions(table);
    this.log('分区表读取完成，MD5 校验通过。');
    const oldNvs = current.find(p => p.type === 1 && p.subtype === 2);
    if (!oldNvs || oldNvs.encrypted || oldNvs.size > 128 * 1024) throw new Error('没有找到可安全更新的非加密 NVS 分区');
    this.log(`备份 NVS：0x${oldNvs.offset.toString(16)}，${oldNvs.size} 字节…`);
    const original = await readFlashVerified(loader, oldNvs.offset, oldNvs.size, (read, total) => { this.progress(12 + Math.floor(read / total * 6), `备份 NVS ${read}/${total} 字节`); this.log(`NVS 已读取 ${read}/${total} 字节`); }, signal);
    // Backup before generating or writing anything. It contains Wi-Fi credentials; keep it private.
    download(original, `xiaozhi-nvs-${this.chip.mac.replaceAll(':', '')}-${Date.now()}.bin`);
    this.log('原有 NVS 已下载备份，Wi-Fi 与其他分区数据将保留。');
    let target: Partition = oldNvs; let image: Uint8Array | undefined;
    if (options.firmware) {
      image = new Uint8Array(await options.firmware.arrayBuffer());
      if (image.length < 0x9000 || image.length > this.chip.flashSize || image[0] !== 0xe9) throw new Error('请选择从 0x0 开始的完整合并固件，且文件大小不能超过 Flash 容量');
      const chipId = new DataView(image.buffer).getUint16(12, true);
      if (chipId !== loader.chip.IMAGE_CHIP_ID) throw new Error('固件目标芯片与连接设备不匹配，已停止刷写');
      const nvs = partitions(image.subarray(0x8000, 0x9000)).find(p => p.type === 1 && p.subtype === 2);
      if (!nvs || nvs.encrypted || nvs.size !== oldNvs.size || nvs.offset + nvs.size > this.chip.flashSize) throw new Error('新旧 NVS 布局不兼容，请使用与当前板型和分区布局一致的固件');
      target = nvs;
    }
    const response = await fetch('/api/provision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.chip.mac, board: 'wha103', ...options, firmware: undefined }) });
    const config = await response.json(); if (!response.ok) throw new Error(config.error || '生成配置失败');
    const updated = provisionNvs(original, config.changes);
    this.progress(20, '写入固件与本地地址');
    const write = async (data: Uint8Array, address: number, start: number, range: number) => loader.writeFlash({ fileArray: [{ data, address }], flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', eraseAll: false, compress: true, calculateMD5Hash: bytes => md5(bytes), reportProgress: (_, written, total) => this.progress(start + Math.floor(written / total * range), '写入 Flash') });
    if (image) await write(image, 0, 20, 45);
    await write(updated, target.offset, image ? 65 : 20, image ? 15 : 60);
    this.progress(85, '回读校验配置');
    this.log('写入完成，正在回读 NVS 并校验 MD5…');
    const check = await readFlashVerified(loader, target.offset, target.size, (read, total) => this.progress(85 + Math.floor(read / total * 7), `回读校验 ${read}/${total} 字节`), signal);
    if (!check.every((value, i) => value === updated[i])) throw new Error('配置回读校验失败；已保留备份，请不要断开设备');
    this.log(`配置校验通过；OTA → ${config.otaUrl}`);
    this.progress(93, '配置已校验，正在重启并释放串口');
    const resetSent = await resetAndRelease(this.port!, this.transport!, this.log);
    this.loader = undefined; this.transport = undefined; this.operation = undefined;
    this.progress(95, resetSent ? '复位信号已发送，等待本地 OTA 接入' : '配置已保存，请拔插 USB 后等待本地 OTA 接入'); return this.chip.mac;
  }
  async disconnect() {
    this.operation?.abort(); this.operation = undefined;
    if (this.monitor) { await this.monitor.cancel().catch(() => {}); this.monitor = undefined; }
    if (this.loader && this.transport && this.port) await resetAndRelease(this.port, this.transport, this.log);
    else {
      try { if (this.transport) await bounded(this.transport.disconnect(), 2500, '释放串口'); } catch { /* Already closed by USB reset. */ }
      try { if (this.port?.readable) await bounded(this.port.close(), 1000, '关闭串口'); } catch { /* The reader may be finishing cancellation. */ }
    }
    this.loader = undefined; this.transport = undefined;
  }
  async readLogs() {
    await this.disconnect(); if (!this.port) this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    this.monitor = this.port.readable!.getReader(); const reader = this.monitor; const decoder = new TextDecoder();
    try { while (true) { const { value, done } = await reader.read(); if (done) break; if (value) this.log(decoder.decode(value, { stream: true })); } }
    finally { reader.releaseLock(); this.monitor = undefined; await this.port.close().catch(() => {}); }
  }
}
