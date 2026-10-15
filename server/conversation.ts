import type { Store } from './store';
import type { Providers } from './providers';
import type { McpManager } from './mcp';
import type { Json } from '../shared/types';
import { rolePrompt } from '../shared/roles';

export function trimHistory(history: Json[]) {
  // Preserve complete turns, including every tool call/result pair.
  while (history.length > 24) { const next = history.findIndex((m, i) => i > 0 && m.role === 'user'); if (next < 0) break; history.splice(0, next); }
}

export async function runConversation(input: {
  store: Store; providers: Providers; mcp: McpManager; deviceId: string; text: string; signal: AbortSignal;
  history: Json[]; tools?: Json[]; speaker?: string; callDevice?: (name: string, args: Json) => Promise<Json>;
}) {
  const { store, providers, mcp, deviceId, signal, history, speaker } = input;
  const text = input.text.trim().slice(0, 4000); if (!text) throw new Error('请输入对话内容');
  const checkpoint = history.length;
  store.message(deviceId, 'user', text, speaker); history.push({ role: 'user', content: text });
  try {
    const remote = await mcp.available();
    const deviceTools = input.tools || [];
    const deviceName = (name: string) => `device__${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const tools = [
      ...remote.map(t => ({ type: 'function', function: { name: t.name, description: t.tool.description || t.tool.name, parameters: t.tool.inputSchema } })),
      ...deviceTools.map(t => ({ type: 'function', function: { name: deviceName(t.name), description: t.description || t.name, parameters: t.inputSchema } })),
    ];
    let answer = '';
    for (let turn = 0; turn < 4; turn++) {
      signal.throwIfAborted();
      const reply = await providers.chat([{ role: 'system', content: rolePrompt(store.settings, speaker) }, ...history], tools, signal);
      history.push(reply);
      if (!reply.tool_calls?.length) { answer = String(reply.content || '').trim(); break; }
      for (const call of reply.tool_calls) {
        signal.throwIfAborted(); let result: unknown;
        try {
          const args = JSON.parse(call.function.arguments || '{}');
          const target = remote.find(t => t.name === call.function.name);
          const deviceTool = deviceTools.find(t => deviceName(t.name) === call.function.name);
          if (target) result = await mcp.call(target.id, target.tool.name, args, signal);
          else if (deviceTool && input.callDevice) result = await input.callDevice(deviceTool.name, args);
          else throw new Error('工具不存在');
        } catch (error) { signal.throwIfAborted(); result = { error: store.redact(String(error)) }; }
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    if (!answer) answer = '工具调用已结束，请再告诉我下一步需要做什么。';
    signal.throwIfAborted(); store.message(deviceId, 'assistant', answer);
    return answer;
  } catch (error) { history.splice(checkpoint); throw error; }
}
