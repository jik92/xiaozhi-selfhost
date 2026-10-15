export async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时`)), ms); })]); }
  finally { clearTimeout(timer); }
}
export interface ResetPort {
  setSignals(signals: { dataTerminalReady: boolean; requestToSend: boolean }): Promise<void>;
  close(): Promise<void>;
}
export async function resetAndRelease(port: ResetPort, transport: { disconnect(): Promise<void> }, log: (message: string) => void, pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  let resetSent = false;
  try {
    // esptool-js 0.7.0 HardReset only deasserts RTS. Assert, hold, then release
    // EN with DTR low; do not use the library's incomplete reset sequence.
    log('重启设备：释放下载引脚，发送 RTS 复位脉冲…');
    await bounded(port.setSignals({ dataTerminalReady: false, requestToSend: true }), 2000, '发送复位信号');
    await pause(150);
    await bounded(port.setSignals({ dataTerminalReady: false, requestToSend: false }), 2000, '释放复位信号');
    resetSent = true;
    log('复位信号已发送。正在释放浏览器串口…');
  } catch { log('配置已写入；USB 复位未确认，请拔插 USB 或按设备 RESET 键。'); }
  try { await bounded(transport.disconnect(), 2500, '释放串口'); }
  catch {
    // Native USB can disappear between resetting and closing its streams.
    try { await bounded(port.close(), 1000, '关闭串口'); }
    catch { log('设备 USB 端口已变化或尚未释放；必要时刷新页面并拔插 USB。'); }
  }
  log('本地配置已保存，等待设备联网后访问 OTA。');
  return resetSent;
}
