import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { Providers } from '../server/providers';
import { DeviceSession } from '../server/sessions';
import type { McpManager } from '../server/mcp';
import { pcmToWav, toPcm } from '../server/audio';
import { edgeSpeechOptions, FRIEND_ROLE, recognitionSilence, rolePrompt, speechVoice } from '../shared/roles';
import type { Json } from '../shared/types';

function tone() {
  const pcm = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / 24000)), i * 2);
  return pcmToWav(pcm, 24000);
}
function frequency(pcm: Buffer) {
  let crossings = 0;
  // Use the middle of the waveform to avoid filter start/end effects.
  const start = Math.floor(pcm.length / 8 / 2) * 2, end = Math.floor(pcm.length * 7 / 8 / 2) * 2;
  for (let i = start + 2; i < end; i += 2) if (pcm.readInt16LE(i - 2) <= 0 && pcm.readInt16LE(i) > 0) crossings++;
  return crossings / ((end - start) / 48000);
}

describe('role and speech settings', () => {
  let directory: string; let store: Store; let providers: Providers; let upstream: ReturnType<typeof Bun.serve>;
  let received: Json = {};
  beforeAll(() => {
    directory = mkdtempSync(`${tmpdir()}/xiaozhi-roles-`); store = new Store(directory); providers = new Providers(store);
    upstream = Bun.serve({ port: 0, async fetch(req) { received = await req.json() as Json; return new Response(new Uint8Array(tone()), { headers: { 'Content-Type': 'audio/wav' } }); } });
  });
  afterAll(() => { upstream.stop(true); providers.speaker.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });

  test('legacy settings keep their original prompt, voice and silence duration', () => {
    const legacy: any = structuredClone(store.settings);
    delete legacy.roles; delete legacy.activeRoleId; delete legacy.speech;
    store.saveSettings(legacy);
    expect(store.settings.activeRoleId).toBe('');
    expect(rolePrompt(store.settings)).toBe(store.settings.llm.systemPrompt);
    expect(speechVoice(store.settings)).toBe(store.settings.tts.voice);
    expect(recognitionSilence(store.settings)).toBe(store.settings.vad.silenceMs);
    expect(store.settings.roles[0]?.prompt).toBe(FRIEND_ROLE.prompt);
  });

  test('role selection changes prompt and provider-specific voice, and validates references', () => {
    const settings = { ...store.settings, activeRoleId: FRIEND_ROLE.id };
    store.saveSettings(settings);
    expect(rolePrompt(store.settings, '小明')).toContain(FRIEND_ROLE.prompt);
    expect(rolePrompt(store.settings, '小明')).toContain('当前说话人：小明');
    expect(speechVoice(store.settings)).toBe('zh-TW-HsiaoChenNeural');
    expect(() => store.saveSettings({ ...settings, activeRoleId: 'missing' })).toThrow();
    expect(() => store.saveSettings({ ...settings, roles: [FRIEND_ROLE, FRIEND_ROLE] })).toThrow();
    store.saveSettings({ ...settings, speech: { recognitionSpeed: 'fast', replySpeed: 'slow', pitch: 'high' } });
    expect(edgeSpeechOptions(store.settings)).toEqual({ voice: 'zh-TW-HsiaoChenNeural', lang: 'zh-TW', rate: '-20%', pitch: '+10Hz' });
    expect(recognitionSilence(store.settings)).toBe(400);
    store.saveSettings({ ...store.settings, speech: { ...store.settings.speech, recognitionSpeed: 'slow' } });
    expect(recognitionSilence(store.settings)).toBe(1200);
    expect(() => store.saveSettings({ ...store.settings, speech: { ...store.settings.speech, pitch: 'extreme' } })).toThrow();
  });

  test('role and speech choices persist across a database reopen', () => {
    const reopened = new Store(directory);
    try { expect(reopened.settings.roles).toEqual(store.settings.roles); expect(reopened.settings.activeRoleId).toBe(FRIEND_ROLE.id); expect(reopened.settings.speech).toEqual(store.settings.speech); }
    finally { reopened.close(); }
  });

  test('the actual dialogue path uses the active role and can return to the default assistant', async () => {
    const requests: Json[][] = [];
    const mockProviders = { chat: async (messages: Json[]) => { requests.push(structuredClone(messages)); return { role: 'assistant', content: '你好！' }; } } as unknown as Providers;
    const session = new DeviceSession('role-test', { kind: 'websocket', json: () => {}, audio: () => {}, close: () => {} }, store, mockProviders, { available: async () => [] } as unknown as McpManager);
    session.speak = async () => {};
    try {
      await session.chat('你好'); expect(requests[0]![0]!.content).toContain(FRIEND_ROLE.prompt);
      store.saveSettings({ ...store.settings, activeRoleId: '' });
      await session.chat('你好'); expect(requests[1]![0]!.content).toBe(store.settings.llm.systemPrompt);
    } finally { session.close(); }
  });

  test('compatible TTS uses the role voice; speed changes duration and pitch changes frequency independently', async () => {
    store.saveSettings({ ...store.settings, activeRoleId: FRIEND_ROLE.id, tts: { ...store.settings.tts, type: 'openai', baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: 'test' } });
    for (const [replySpeed, pitch, duration, hz] of [
      ['normal', 'normal', 1, 440], ['slow', 'low', 1.25, 392], ['fast', 'high', 1 / 1.2, 494], ['normal', 'high', 1, 494],
    ] as const) {
      store.saveSettings({ ...store.settings, speech: { recognitionSpeed: 'normal', replySpeed, pitch } });
      const audio = await providers.synthesize('测试');
      expect(received.voice).toBe('alloy'); expect(received.input).toBe('测试');
      const pcm = await toPcm(audio);
      expect(Math.abs(pcm.length / 48000 - duration)).toBeLessThan(0.08);
      expect(Math.abs(frequency(pcm) - hz)).toBeLessThan(8);
    }
  }, 10000);
});
