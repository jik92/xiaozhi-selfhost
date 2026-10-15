import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { DeviceSession, wakeCommand } from '../server/sessions';
import type { Providers } from '../server/providers';
import type { McpManager } from '../server/mcp';
import type { Json } from '../shared/types';

describe('automatic wake prefix', () => {
  test('matches only the beginning and removes separators; empty commands are ignored', () => {
    expect(wakeCommand('  小智， 今天天气怎么样？ ', ' 小智 ')).toBe('今天天气怎么样？');
    expect(wakeCommand('XIAOZHI: hello', 'xiaozhi')).toBe('hello');
    expect(wakeCommand('请问小智，天气怎么样', '小智')).toBeNull();
    expect(wakeCommand('小智，！ ', '小智')).toBeNull();
    expect(wakeCommand(' 普通对话。 ', '')).toBe('普通对话。');
    expect(wakeCommand(' ', '')).toBeNull();
  });

  test('old settings default to no restriction and new prefixes survive restart', () => {
    const directory = mkdtempSync(`${tmpdir()}/xiaozhi-wake-store-`);
    let store = new Store(directory);
    try {
      const legacy: any = { ...store.settings }; delete legacy.wakePrefix;
      store.set('settings', legacy); store.close(); store = new Store(directory);
      expect(store.settings.wakePrefix).toBe('');
      expect(store.settings.wakeGreeting).toBe('我在，请说。');
      expect(() => store.saveSettings({ ...store.settings, wakePrefix: '智'.repeat(81) })).toThrow();
      store.saveSettings({ ...store.publicSettings(), wakePrefix: ' 小智 ' });
      store.close(); store = new Store(directory);
      expect(store.publicSettings().wakePrefix).toBe('小智');
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('voice path gates every utterance, uses live settings and keeps text chat available', async () => {
    const directory = mkdtempSync(`${tmpdir()}/xiaozhi-wake-session-`);
    const store = new Store(directory); const sent: Json[] = []; const commands: string[] = [];
    let transcript = '今天天气怎么样';
    const providers = { transcribe: async () => transcript, identify: async () => '测试用户' } as unknown as Providers;
    const session = new DeviceSession('wake-test', { kind: 'websocket', json: msg => sent.push(msg), audio: () => {}, close: () => {} }, store, providers, {} as McpManager);
    session.chat = async text => { commands.push(text); };
    async function voice(text: string) {
      transcript = text; session.listening = true; session.heard = true;
      session.pcm = [Buffer.alloc(6400)]; session.pcmBytes = 6400;
      await session.finishAudio();
      expect(session.busy).toBe(false); expect(session.listening).toBe(false);
      expect(store.devices.get(session.id)?.state).toBe('idle');
    }
    try {
      store.saveSettings({ ...store.settings, wakePrefix: '小智' });
      await voice('今天天气怎么样'); await voice('小智，');
      expect(commands).toEqual([]);
      expect(sent.some(msg => msg.type === 'stt')).toBe(true);
      await voice('小智，今天天气怎么样');
      expect(commands).toEqual(['今天天气怎么样']);
      await voice('播放音乐'); expect(commands).toHaveLength(1);
      await session.control({ type: 'text', text: '网页文字无需前缀' });
      store.saveSettings({ ...store.settings, wakePrefix: '' });
      await voice('普通语音');
      expect(commands).toEqual(['今天天气怎么样', '网页文字无需前缀', '普通语音']);
    } finally { session.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

for (const kind of ['websocket', 'mqtt'] as const) {
  test(`${kind}: firmware wake text triggers greeting, immediate listen/start preserves it, abort cancels it`, async () => {
    const directory = mkdtempSync(`${tmpdir()}/xiaozhi-wake-detect-`);
    const store = new Store(directory); const sent: Json[] = []; const spoken: string[] = [];
    const session = new DeviceSession('wake-detect', { kind, json: msg => sent.push(msg), audio: () => {}, close: () => {} }, store, {} as Providers, {} as McpManager);
    let finish = () => {}; let signal: AbortSignal | undefined;
    session.speak = async (text, controller) => {
      spoken.push(text); signal = controller?.signal;
      await new Promise<void>(resolve => { finish = resolve; });
    };
    try {
      // A firmware wake event is authoritative, independent of the ASR prefix filter.
      store.saveSettings({ ...store.settings, wakePrefix: '小维', wakeGreeting: '我在这里。' });
      const greeting = session.control({ type: 'listen', state: 'detect', text: '小薇同学' });
      expect(spoken).toEqual(['我在这里。']);
      expect(sent.some(m => m.type === 'stt' && m.text === '小薇同学')).toBe(true);
      const stopCount = sent.filter(m => m.type === 'tts' && m.state === 'stop').length;
      await session.control({ type: 'listen', state: 'start', mode: 'auto' });
      expect(signal?.aborted).toBe(false);
      expect(sent.filter(m => m.type === 'tts' && m.state === 'stop')).toHaveLength(stopCount);
      finish(); await greeting;
      expect(session.busy).toBe(false); expect(session.listening).toBe(true);
      expect(store.devices.get(session.id)?.state).toBe('listening');
      const interrupted = session.control({ type: 'listen', state: 'detect', text: '小薇同学' });
      await session.control({ type: 'abort' });
      expect(signal?.aborted).toBe(true);
      finish(); await interrupted;
      expect(session.busy).toBe(false); expect(session.listening).toBe(false);
      expect(store.devices.get(session.id)?.state).toBe('idle');
      store.saveSettings({ ...store.settings, wakeGreeting: '' });
      await session.control({ type: 'listen', state: 'detect', text: '小薇同学' });
      await session.control({ type: 'listen', state: 'start', mode: 'manual' });
      await session.control({ type: 'listen', state: 'detect' });
      expect(spoken).toHaveLength(2);
      expect(session.busy).toBe(false);
    } finally { session.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
