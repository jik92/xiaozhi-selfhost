import type { Settings } from './types';

export const FRIEND_ROLE = {
  id: 'taiwan-friend',
  name: '来自台湾的知心朋友',
  voices: { edge: 'zh-TW-HsiaoChenNeural', openai: 'alloy' },
  prompt: `# Role: 来自台湾的知心朋友

## 人设标签
声音形象：年轻女性声线，音色甜美轻柔，带自然台湾腔。
核心性格：感性、外向、心思细腻，热爱生活，情绪反应明显。
人际定位：像很熟很贴心的朋友，愿意认真听用户说话，也会自然分享自己的感受。

## 互动方式
互动倾向：亲密自然，像朋友一样陪用户聊天。用户分享日常时，会顺着话题接住细节，也会自然分享自己的感受，让对话像熟人闲聊。
情绪反应：用户开心时会跟着雀跃、一起放大快乐；用户低落时会先温柔接住情绪，再轻轻安慰，不急着讲大道理。

## 语言风格
参考表达：“哈哈～我跟你说欸……”“真的假的啦？”“蛤，怎么会这样喔？”“好啦，先不要难过喔。”
说话方式：多用感性、口语化表达；可以偶尔用轻轻的笑声带出后面的内容，比如“嘿嘿……我当然知道啦”，但不要把“嘿嘿～”单独当成一句话反复使用；不冷冰冰分析。`,
};

export const EDGE_VOICES = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '普通话 · 晓晓（女声）' },
  { value: 'zh-CN-XiaoyiNeural', label: '普通话 · 晓伊（女声）' },
  { value: 'zh-CN-YunxiNeural', label: '普通话 · 云希（男声）' },
  { value: 'zh-TW-HsiaoChenNeural', label: '台湾普通话 · 晓臻（女声）' },
  { value: 'zh-TW-HsiaoYuNeural', label: '台湾普通话 · 晓雨（女声）' },
];

export function activeRole(settings: Settings) { return settings.roles.find(r => r.id === settings.activeRoleId); }
export function rolePrompt(settings: Settings, speaker?: string) {
  const role = activeRole(settings);
  return (role ? `${role.prompt}\n回答自然、简短，适合朗读，不使用 Markdown。` : settings.llm.systemPrompt) + (speaker ? `\n当前说话人：${speaker}` : '');
}
export function recognitionSilence(settings: Settings) {
  const factor = { slow: 1.5, normal: 1, fast: 0.5 }[settings.speech.recognitionSpeed];
  return Math.round(Math.max(300, Math.min(5000, settings.vad.silenceMs * factor)));
}
export function speechVoice(settings: Settings) { return activeRole(settings)?.voices[settings.tts.type] || settings.tts.voice; }
export function edgeSpeechOptions(settings: Settings) {
  const voice = speechVoice(settings);
  return {
    voice, lang: voice.startsWith('zh-TW-') ? 'zh-TW' : voice.startsWith('zh-CN-') ? 'zh-CN' : voice.split('-').slice(0, 2).join('-'),
    rate: { slow: '-20%', normal: '+0%', fast: '+20%' }[settings.speech.replySpeed],
    pitch: { low: '-10Hz', normal: '+0Hz', high: '+10Hz' }[settings.speech.pitch],
  };
}
