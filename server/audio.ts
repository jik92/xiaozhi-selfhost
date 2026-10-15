import OpusScript from 'opusscript';

export function pcmToWav(pcm: Buffer, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function rms(pcm: Buffer) { let energy = 0; for (let i = 0; i + 1 < pcm.length; i += 2) energy += (pcm.readInt16LE(i) / 32768) ** 2; return Math.sqrt(energy / Math.max(1, pcm.length / 2)); }
export function createDecoder(rate = 16000) {
  if (![8000, 12000, 16000, 24000, 48000].includes(rate)) throw new Error('不支持的音频采样率');
  return new OpusScript(rate as 16000, 1, OpusScript.Application.VOIP);
}
export async function toPcm(audio: Uint8Array, rate = 24000, signal?: AbortSignal, filters?: string) {
  signal?.throwIfAborted();
  const child = Bun.spawn([process.env.FFMPEG_PATH || 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', '180.1', ...(filters ? ['-af', filters] : []), '-f', 's16le', '-ac', '1', '-ar', String(rate), 'pipe:1'], { stdin: audio, stdout: 'pipe', stderr: 'pipe' });
  const cancel = () => child.kill();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 30000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    if (signal?.aborted) throw new Error('操作已取消');
    if (code !== 0) throw new Error(`音频转换失败：${err.slice(0, 200)}`);
    if (out.byteLength > rate * 2 * 180) throw new Error('音频不能超过 3 分钟');
    return Buffer.from(out);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
export function encodePcm(pcm: Buffer, frameMs = 60, rate = 24000) {
  const codec = createDecoder(rate); codec.setBitrate(24000);
  const samples = rate * frameMs / 1000;
  const frameBytes = samples * 2;
  const result: Buffer[] = [];
  try {
    for (let i = 0; i < pcm.length; i += frameBytes) {
      const frame = Buffer.alloc(frameBytes); pcm.copy(frame, 0, i, Math.min(pcm.length, i + frameBytes));
      result.push(Buffer.from(codec.encode(frame, samples)));
    }
    return result;
  } finally { codec.delete(); }
}

export async function pcmToOggOpus(pcm: Buffer, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!pcm.length || pcm.length > 24000 * 2 * 180) throw new Error('通知音频应为 3 分钟内的非空音频');
  const child = Bun.spawn([process.env.FFMPEG_PATH || 'ffmpeg', '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus',
    '-application', 'voip', '-b:a', '24k', '-frame_duration', '60', '-f', 'ogg', 'pipe:1'], { stdin: pcm, stdout: 'pipe', stderr: 'pipe' });
  const cancel = () => child.kill(); signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 30000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`通知音频编码失败：${err.slice(0, 200)}`);
    return Buffer.from(out);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
