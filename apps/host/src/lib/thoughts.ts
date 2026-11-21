import type { ChatMessage, ToolCall } from './types';

/**
 * Where the model's thinking is shown (Settings → Appearance → Chat activity):
 * 'inline' the closed line above each reply (as before), 'panel' live in the side panel instead, 'hidden' not at all.
 */
export type ThoughtsView = 'inline' | 'panel' | 'hidden';
export const THOUGHTS_VIEWS: ThoughtsView[] = ['inline', 'panel', 'hidden'];
export const validThoughtsView = (value: unknown): value is ThoughtsView => THOUGHTS_VIEWS.includes(value as ThoughtsView);

/** The side panel's tab id for a chat. */
export const thoughtsTabId = (chatId: string) => `thoughts:${chatId}`;

/** The reply whose thinking the panel shows: the newest assistant reply that has some, or the one being written now. */
export function thoughtsReply(messages: ChatMessage[] | undefined): ChatMessage | null {
  const list = messages ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role !== 'assistant') continue;
    if (m.reasoning || m.streaming) return m;
  }
  return null;
}

/** True while the reply is still thinking (no answer text yet in this step, the reply still streaming). */
export const thinkingNow = (m: ChatMessage | null) => !!m?.streaming && !!m.reasoning && m.reasoningMs === undefined && !m.content;

/** The tool cards an activity line stands for, in the order they ran. A line saved before the ids were sent has none. */
export function groupTools(toolIds: string[] | undefined, tools: ToolCall[] | undefined): ToolCall[] {
  if (!toolIds?.length || !tools?.length) return [];
  const byId = new Map(tools.map(t => [t.id, t]));
  return toolIds.flatMap(id => { const t = byId.get(id); return t ? [t] : []; });
}

/** What one step was, in one line: the command for a shell call, else the file or address it was on, else its preview. */
export function stepText(t: ToolCall): string {
  const cmd = t.args?.command;
  if (t.scope === 'shell' && typeof cmd === 'string' && cmd.trim()) return cmd.trim();
  return (t.target || t.preview || '').trim();
}

/** A step's output, cut to a size a list can show. */
export function stepOutput(t: ToolCall, max = 6000): string {
  const out = (t.result ?? '').trimEnd();
  return out.length > max ? `${out.slice(0, max)}\n…` : out;
}
