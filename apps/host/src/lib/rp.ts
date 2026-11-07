/**
 * Roleplay chats on the page: the library (characters, personas, lorebooks, settings) and every action of a roleplay chat — send,
 * swipe (another version of a reply, kept beside the others), continue, impersonate (the model writes the person's next message into
 * the box), edit, delete, hide from the prompt, and group turns (who speaks next, or a member made to speak).
 *
 * The host builds the prompt (server/rp/prompt.mjs) and streams one reply from /api/rp/generate; this file only keeps the chat.
 * A chat is a roleplay chat when it has `session.rp` (a profile 'rp' chat made from a character).
 */
import { api, streamPost } from './client';
import { flushSessions, getState, go, newSession, pushToast, registerRpHooks, storeInternals, useStore } from './store';
import type { ChatMessage, RpCharacter, RpChat, RpLibrary, RpLorebook, RpPersona, RpSettings, Session } from './types';

const { patchSession, markTurn, uid, setState, liveTurns } = storeInternals;

/* --------------------------------------------------------------------------------------------------- library */

export async function loadRpLibrary(): Promise<RpLibrary> {
  const lib = await api.get<RpLibrary>('/api/rp/library');
  setState({ rpLibrary: lib });
  return lib;
}
export function useRpLibrary(): RpLibrary | null { return useStore(s => s.rpLibrary); }
const refresh = () => loadRpLibrary().catch(() => undefined);

export async function saveCharacter(c: Partial<RpCharacter>) { const saved = await api.post<RpCharacter>('/api/rp/characters', c); await refresh(); return saved; }
export async function deleteCharacter(id: string) { await api.del(`/api/rp/characters/${id}`); await refresh(); }
export async function duplicateCharacter(id: string) { const c = await api.post<RpCharacter>(`/api/rp/characters/${id}/duplicate`, {}); await refresh(); return c; }
export async function savePersona(p: Partial<RpPersona>) { const saved = await api.post<RpPersona>('/api/rp/personas', p); await refresh(); return saved; }
export async function deletePersona(id: string) { await api.del(`/api/rp/personas/${id}`); await refresh(); }
export async function saveLorebook(b: Partial<RpLorebook>) { const saved = await api.post<RpLorebook>('/api/rp/lorebooks', b); await refresh(); return saved; }
export async function deleteLorebook(id: string) { await api.del(`/api/rp/lorebooks/${id}`); await refresh(); }
export async function saveRpSettings(s: RpSettings) { const saved = await api.put<RpSettings>('/api/rp/settings', s); await refresh(); return saved; }
export async function resetRpSettings() { const saved = await api.post<RpSettings>('/api/rp/settings/reset', {}); await refresh(); return saved; }

const toBase64 = (buf: ArrayBuffer) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

/** A card (PNG or JSON) or a lorebook (SillyTavern World Info JSON) from a file the person picked. */
export async function importRpFile(file: File): Promise<{ kind: 'character' | 'lorebook'; item: RpCharacter | RpLorebook }> {
  const got = await api.post<{ kind: 'character' | 'lorebook'; item: RpCharacter | RpLorebook }>('/api/rp/import', { filename: file.name, data: toBase64(await file.arrayBuffer()) });
  await refresh();
  return got;
}
export async function setRpAvatar(kind: 'characters' | 'personas', id: string, file: File | null) {
  await api.put(`/api/rp/${kind}/${id}/avatar`, { data: file ? toBase64(await file.arrayBuffer()) : null });
  avatarStamp = Date.now();
  await refresh();
}
let avatarStamp = Date.now();
export const avatarUrl = (kind: 'characters' | 'personas', id: string) => `/api/rp/${kind}/${id}/avatar?v=${avatarStamp}`;

/* ------------------------------------------------------------------------------------------------ the chats */

const plainMacros = (text: string, char: string, user: string) => text.replace(/\{\{char\}\}|<BOT>|<CHAR>/gi, char).replace(/\{\{user\}\}|<USER>/gi, user);

function userNameFor(lib: RpLibrary | null, rp: RpChat | undefined) {
  const persona = lib?.personas.find(p => p.id === (rp?.personaId ?? lib?.settings.defaultPersonaId));
  return persona?.name || lib?.settings.userName || 'User';
}

/** A new roleplay chat with these characters: each one's greeting (and its alternates as swipes) opens it. */
export function newRpChat(characterIds: string[]): string | null {
  const lib = getState().rpLibrary;
  const characters = characterIds.map(id => lib?.characters.find(c => c.id === id)).filter((c): c is RpCharacter => !!c);
  if (!characters.length || !lib) return null;
  const session = newSession('rp');
  const rp: RpChat = { characterIds: characters.map(c => c.id), personaId: lib.settings.defaultPersonaId, lorebookIds: [], authorsNote: { ...lib.settings.authorsNote }, vars: {}, muted: [] };
  const user = userNameFor(lib, rp);
  const at = new Date().toISOString();
  const greetings: ChatMessage[] = characters.flatMap(c => {
    const all = [c.firstMessage, ...c.alternateGreetings].filter(g => g.trim()).map(g => plainMacros(g, c.name, user));
    return all.length ? [{ id: uid('m'), role: 'assistant' as const, content: all[0], swipes: all, swipeIndex: 0, characterId: c.id, name: c.name, at }] : [];
  });
  patchSession(session.id, s => ({ ...s, rp, title: characters.map(c => c.name).join(', '), defaultTitle: false, messages: greetings }));
  go('chat', session.id);
  return session.id;
}

const sessionOf = (id: string | null) => getState().sessions.find(s => s.id === id);
const busy = (id: string) => liveTurns.has(id);

function historyFor(messages: ChatMessage[]) {
  return messages.filter(m => !m.local && (m.role === 'user' || m.role === 'assistant')).map(m => ({ role: m.role, content: m.content, characterId: m.characterId, name: m.name, hidden: m.hidden, at: m.at }));
}

const joinContinuation = (base: string, more: string) => (!base || /\s$/.test(base) || /^[\s,.;:!?'")\]…—-]/.test(more) ? base + more : `${base} ${more}`);

type Mode = 'normal' | 'swipe' | 'continue' | 'impersonate';

/**
 * One generation. normal: a new reply at the end; swipe: a new version of `targetId`; continue: more of the last reply;
 * impersonate: the person's next message, written into the box.
 */
export async function rpGenerate(sessionId: string, mode: Mode, opts: { speakerId?: string; targetId?: string } = {}) {
  const session = sessionOf(sessionId);
  if (!session?.rp || busy(sessionId)) return;
  const messages = session.messages;
  let targetId = '', base = '', history = historyFor(messages), speakerId = opts.speakerId;
  if (mode === 'swipe') {
    const at = messages.findIndex(m => m.id === opts.targetId);
    if (at < 0) return;
    const target = messages[at];
    history = historyFor(messages.slice(0, at));
    speakerId = speakerId ?? target.characterId;
    targetId = target.id;
    const swipes = target.swipes?.length ? [...target.swipes] : [target.content];
    const reasoning = target.swipeReasoning ? [...target.swipeReasoning] : [target.reasoning ?? ''];
    swipes.push(''); reasoning.push('');
    patchSession(sessionId, s => ({ ...s, messages: s.messages.map(m => (m.id === targetId ? { ...m, swipes, swipeReasoning: reasoning, swipeIndex: swipes.length - 1, content: '', reasoning: '', error: undefined, streaming: true } : m)) }));
  } else if (mode === 'continue') {
    const last = [...messages].reverse().find(m => m.role === 'assistant' && !m.local);
    if (!last || messages[messages.length - 1]?.id !== last.id) { pushToast('info', 'Nothing to continue', 'Continue adds to the last reply, and the last message is yours.'); return; }
    targetId = last.id; base = last.content; speakerId = last.characterId;
    patchSession(sessionId, s => ({ ...s, messages: s.messages.map(m => (m.id === targetId ? { ...m, streaming: true, error: undefined } : m)) }));
  } else if (mode === 'normal') {
    targetId = uid('m');
    const reply: ChatMessage = { id: targetId, role: 'assistant', content: '', at: new Date().toISOString(), streaming: true, remoteModel: true };
    patchSession(sessionId, s => ({ ...s, updatedAt: new Date().toISOString(), messages: [...s.messages, reply] }));
  }
  const abort = new AbortController();
  markTurn(sessionId, { abort, agent: false });
  const patch = (fn: (m: ChatMessage) => ChatMessage) => { if (targetId) patchSession(sessionId, s => ({ ...s, messages: s.messages.map(m => (m.id === targetId ? fn(m) : m)) })); };
  let text = '', reasoning = '', timer: ReturnType<typeof setTimeout> | null = null, final: string | null = null, reasoningStarted = 0;
  const show = () => {
    timer = null;
    if (mode === 'impersonate') return;
    patch(m => ({ ...m, content: mode === 'continue' ? joinContinuation(base, text) : text, reasoning: reasoning || m.reasoning, ...(reasoningStarted && !m.reasoningStartedAt ? { reasoningStartedAt: reasoningStarted } : {}) }));
  };
  const started = performance.now();
  try {
    await streamPost('/api/rp/generate', { sessionId, chat: session.rp, history, mode: mode === 'swipe' ? 'normal' : mode, speakerId, thinking: session.preferences?.thinking }, frame => {
      const type = String(frame.type);
      if (type === 'rp-speaker') { const id = String(frame.id ?? ''), name = String(frame.name ?? ''); if (mode === 'normal' || mode === 'swipe') patch(m => ({ ...m, characterId: id || undefined, name })); }
      else if (type === 'delta') { text += String(frame.text ?? ''); timer ??= setTimeout(show, 90); }
      else if (type === 'reasoning') { reasoning += String(frame.text ?? ''); reasoningStarted ||= Date.now(); timer ??= setTimeout(show, 90); }
      else if (type === 'start') patch(m => ({ ...m, model: String(frame.model ?? ''), contextMax: Number(frame.contextMax) || undefined }));
      else if (type === 'rp-final') {
        final = String(frame.content ?? text);
        if (frame.vars && typeof frame.vars === 'object') patchSession(sessionId, s => (s.rp ? { ...s, rp: { ...s.rp, vars: frame.vars as Record<string, string> } } : s));
      } else if (type === 'done') patch(m => ({ ...m, tokens: typeof frame.tokensOut === 'number' ? frame.tokensOut : m.tokens, inputTokens: typeof frame.tokensIn === 'number' ? frame.tokensIn : m.inputTokens, tps: typeof frame.tps === 'number' ? frame.tps : m.tps, ttftMs: typeof frame.ttftMs === 'number' ? frame.ttftMs : m.ttftMs, usageSource: frame.usageSource === 'reported' ? 'reported' : 'unavailable' }));
      else if (type === 'error') { const message = String(frame.message ?? 'The reply failed.'); if (mode === 'impersonate') pushToast('error', 'Impersonate failed', message); else patch(m => ({ ...m, error: message })); }
    }, abort.signal);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') { const message = e instanceof Error ? e.message : String(e); if (mode === 'impersonate') pushToast('error', 'Impersonate failed', message); else patch(m => ({ ...m, error: message })); }
  } finally {
    if (timer) clearTimeout(timer);
    const out = final ?? text;
    const thought = reasoning;
    if (mode === 'impersonate') { if (out.trim()) window.dispatchEvent(new CustomEvent('strata:compose', { detail: { sessionId, text: out.trim() } })); }
    else patch(m => {
      const content = mode === 'continue' ? joinContinuation(base, out) : out;
      const done: ChatMessage = { ...m, content, reasoning: thought || (mode === 'continue' ? m.reasoning : undefined), streaming: false, durationMs: Math.round(performance.now() - started), ...(thought && m.reasoningStartedAt && !m.reasoningMs ? { reasoningMs: Date.now() - m.reasoningStartedAt } : {}) };
      const idx = m.swipeIndex ?? 0;
      if (m.swipes?.length) { const swipes = [...m.swipes]; swipes[idx] = content; const sr = [...(m.swipeReasoning ?? [])]; sr[idx] = done.reasoning ?? ''; return { ...done, swipes, swipeReasoning: sr }; }
      return done;
    });
    markTurn(sessionId, null);
    void flushSessions();
  }
}

/** The person's message, then the reply (in a group: whoever's turn it is; a group set to manual waits for a pick). */
export async function rpSend(text: string) {
  const id = getState().activeSession;
  const session = sessionOf(id);
  if (!id || !session?.rp || busy(id)) return;
  const line = text.trim();
  const lib = getState().rpLibrary;
  // Commands of the roleplay box.
  if (/^\/(continue|cont)$/i.test(line)) return rpGenerate(id, 'continue');
  if (/^\/(impersonate|imp)$/i.test(line)) return rpGenerate(id, 'impersonate');
  if (/^\/(swipe|regen|regenerate)$/i.test(line)) return rpSwipe(id, session.messages[session.messages.length - 1]?.id ?? '', 1);
  const talk = /^\/(?:trigger|talk)\s*(.*)$/i.exec(line);
  if (talk) {
    const who = talk[1].trim().toLowerCase();
    const c = who ? lib?.characters.find(x => session.rp!.characterIds.includes(x.id) && x.name.toLowerCase().startsWith(who)) : undefined;
    return rpGenerate(id, 'normal', { speakerId: c?.id });
  }
  if (line) {
    const name = userNameFor(lib, session.rp);
    const msg: ChatMessage = { id: uid('m'), role: 'user', content: line, name, at: new Date().toISOString() };
    patchSession(id, s => ({ ...s, updatedAt: new Date().toISOString(), messages: [...s.messages, msg] }));
  }
  const manualGroup = session.rp.characterIds.length > 1 && lib?.settings.group.strategy === 'manual';
  if (!manualGroup || !line) await rpGenerate(id, 'normal');
}

/** Show the previous or next version of a reply; past the last version of the last reply, write a new one. */
export async function rpSwipe(sessionId: string, messageId: string, dir: -1 | 1) {
  const session = sessionOf(sessionId);
  const msgs = session?.messages ?? [];
  const at = msgs.findIndex(m => m.id === messageId);
  const m = msgs[at];
  if (!m || m.role !== 'assistant' || busy(sessionId)) return;
  const swipes = m.swipes?.length ? m.swipes : [m.content];
  const idx = m.swipeIndex ?? 0, next = idx + dir;
  if (next < 0) return;
  if (next < swipes.length) {
    patchSession(sessionId, s => ({ ...s, messages: s.messages.map(x => (x.id === messageId ? { ...x, swipes, swipeIndex: next, content: swipes[next], reasoning: x.swipeReasoning?.[next] || undefined, error: undefined } : x)) }));
    return;
  }
  // A greeting has only its alternates; any other last reply gets a new version.
  const greeting = !msgs.slice(0, at).some(x => x.role === 'user');
  if (at !== msgs.length - 1 || greeting) return;
  await rpGenerate(sessionId, 'swipe', { targetId: messageId });
}

export function rpEditMessage(sessionId: string, messageId: string, content: string) {
  patchSession(sessionId, s => ({ ...s, messages: s.messages.map(m => {
    if (m.id !== messageId) return m;
    if (!m.swipes?.length) return { ...m, content };
    const swipes = [...m.swipes]; swipes[m.swipeIndex ?? 0] = content;
    return { ...m, content, swipes };
  }) }));
  void flushSessions();
}
export function rpDeleteMessage(sessionId: string, messageId: string, andAfter = false) {
  patchSession(sessionId, s => { const at = s.messages.findIndex(m => m.id === messageId); return at < 0 ? s : { ...s, messages: andAfter ? s.messages.slice(0, at) : s.messages.filter(m => m.id !== messageId) }; });
  void flushSessions();
}
/** Delete only the version on screen (the reply keeps its others). */
export function rpDeleteSwipe(sessionId: string, messageId: string) {
  patchSession(sessionId, s => ({ ...s, messages: s.messages.map(m => {
    if (m.id !== messageId || !m.swipes || m.swipes.length < 2) return m;
    const i = m.swipeIndex ?? 0, swipes = m.swipes.filter((_, j) => j !== i), sr = (m.swipeReasoning ?? []).filter((_, j) => j !== i), ni = Math.min(i, swipes.length - 1);
    return { ...m, swipes, swipeReasoning: sr, swipeIndex: ni, content: swipes[ni], reasoning: sr[ni] || undefined };
  }) }));
}
export function rpToggleHidden(sessionId: string, messageId: string) {
  patchSession(sessionId, s => ({ ...s, messages: s.messages.map(m => (m.id === messageId ? { ...m, hidden: !m.hidden } : m)) }));
}
export function setRpChat(sessionId: string, patch: Partial<RpChat>) {
  patchSession(sessionId, s => (s.rp ? { ...s, rp: { ...s.rp, ...patch } } : s));
}
/** The prompt the next reply would be written from (the inspector). */
export async function rpPreview(session: Session) {
  return api.post<{ messages: { role: string; content: string }[]; stop: string[]; speaker: { id: string | null; name: string }; info: { tokens: number; window: number; reserve: number; droppedMessages: number; examples: number; exampleBlocks: number; worldInfo: { activated: { book: string; comment: string; position: string; tokens: number }[]; dropped: { book: string; comment: string }[]; tokens: number; budget: number }; pieces: { role: string; piece: string; tokens: number }[] } }>(
    '/api/rp/preview', { sessionId: session.id, chat: session.rp, history: historyFor(session.messages), mode: 'normal' });
}

// The chat box, Ask again and Continue send a roleplay chat here instead of the agent.
registerRpHooks({
  send: text => rpSend(text),
  retry: (sessionId, messageId) => { const s = sessionOf(sessionId); const last = s?.messages[s.messages.length - 1]; return rpSwipe(sessionId, messageId ?? last?.id ?? '', 1); },
  continue: sessionId => rpGenerate(sessionId, 'continue'),
});
