/**
 * Persisted turns (RESPONSE5.md, items 3 to 5): the ledger on disk and the turns running now.
 *
 *   <data folder>/chats/turns.json   { v: 1, turns: { <turnId>: { chatId, replyId, kind, state, requestId, rev, at, endedAt, error, code, status } } }
 *
 * - `turnId` names one press of a button. A repeat of the same turnId (the phone never heard back) never starts a second turn: a running
 *   turn is joined, a finished one is answered from the chat. Records are kept 24 hours and survive a restart.
 * - `state`: running | done | error | stopped | refused (refused: nothing started; `status` and `error` are the answer it got).
 * - A turn that was `running` when the host stopped is returned by `interrupted()` at start, so its reply can be closed.
 * - Each running turn keeps its frames in memory (at most 5,000, with text pieces joined) and has subscribers: the request that started it
 *   and any repeat that joined. `onIdle` runs when the last subscriber leaves (the caller decides whether that stops the turn).
 */
import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const KEEP_MS = 24 * 3600_000;
const MAX_FRAMES = 5000;

export function createTurnLedger({ file, now = () => Date.now(), changed = () => {} }) {
  let turns = {};
  try { const parsed = JSON.parse(readFileSync(file, 'utf8')); if (parsed?.v === 1 && parsed.turns && typeof parsed.turns === 'object') turns = parsed.turns; } catch { /* first start */ }
  const stranded = Object.entries(turns).filter(([, t]) => t.state === 'running').map(([turnId, t]) => ({ turnId, ...t }));
  const runs = new Map();   // turnId -> run

  function save() {
    const cutoff = now() - KEEP_MS;
    for (const [id, t] of Object.entries(turns)) if (t.state !== 'running' && (t.endedAt ?? t.at ?? 0) < cutoff) delete turns[id];
    try { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify({ v: 1, turns }), { mode: 0o600 }); renameSync(tmp, file); } catch { /* kept in memory */ }
  }
  const view = (turnId, t) => ({ turnId, chatId: t.chatId, replyId: t.replyId, kind: t.kind, state: t.state, requestId: t.requestId ?? null, rev: t.rev ?? null, ...(t.error ? { error: t.error } : {}), ...(t.code ? { code: t.code } : {}) });

  function createRun(turnId) {
    const frames = [];
    const subs = new Set();
    let endedResolve;
    const ended = new Promise(r => { endedResolve = r; });
    let onIdle = () => {};
    let finished = false;
    return {
      turnId,
      ended,
      get finished() { return finished; },
      set onIdle(fn) { onIdle = fn; },
      push(frame) {
        const last = frames.at(-1);
        if (last && (frame.type === 'delta' || frame.type === 'reasoning') && last.type === frame.type && Object.keys(frame).length === 2 && Object.keys(last).length === 2) last.text += frame.text;
        else if (frame.type !== 'beat') { frames.push(frame.type === 'delta' || frame.type === 'reasoning' ? { ...frame } : frame); if (frames.length > MAX_FRAMES) frames.splice(1, frames.length - MAX_FRAMES); }
        for (const fn of [...subs]) { try { fn(frame); } catch { subs.delete(fn); } }
      },
      /** Send everything so far to `fn`, then the live frames, until `signal` aborts. */
      subscribe(fn, signal) {
        for (const f of frames) fn(f);
        subs.add(fn);
        signal?.addEventListener('abort', () => { subs.delete(fn); if (!subs.size && !finished) onIdle(); }, { once: true });
      },
      finish() { finished = true; subs.clear(); endedResolve(); },
    };
  }

  return {
    get: turnId => (turns[turnId] ? view(turnId, turns[turnId]) : null),
    /** The running turn writing `replyId` in `chatId`, if any. */
    writing(chatId, replyId) {
      for (const [id, t] of Object.entries(turns)) if (t.state === 'running' && t.chatId === chatId && t.replyId === replyId) return view(id, t);
      return null;
    },
    /** True while a running turn writes this message (the chat store never lets a save replace it). */
    isLive(chatId, messageId) {
      for (const [id, t] of Object.entries(turns)) if (t.state === 'running' && t.chatId === chatId && (t.replyId === messageId || runs.get(id)?.replyIds?.().includes(messageId))) return true;
      return false;
    },
    running: chatId => Object.entries(turns).filter(([, t]) => t.state === 'running' && (!chatId || t.chatId === chatId)).map(([id, t]) => view(id, t)),
    run: turnId => runs.get(turnId) ?? null,
    /** The newest turn of a chat (Stop sent again after it ended). */
    lastFor(chatId) {
      let best = null;
      for (const [id, t] of Object.entries(turns)) if (t.chatId === chatId && t.state !== 'refused' && (!best || (t.at ?? 0) >= (best.t.at ?? 0))) best = { id, t };
      return best ? view(best.id, best.t) : null;
    },
    /** Start a turn: its record (state running) and its run. */
    begin({ turnId, chatId, replyId, kind, requestId }) {
      turns[turnId] = { chatId, replyId, kind, state: 'running', requestId, at: now() };
      save();
      const run = createRun(turnId);
      runs.set(turnId, run);
      changed(view(turnId, turns[turnId]));
      return run;
    },
    update(turnId, values) { if (turns[turnId]) { Object.assign(turns[turnId], values); save(); } },
    /** Close a turn: done, error or stopped (with the chat's revision that holds the final reply). */
    end(turnId, { state, error = null, code = null, rev = null }) {
      const t = turns[turnId];
      if (!t) return;
      Object.assign(t, { state, endedAt: now(), ...(error ? { error } : {}), ...(code ? { code } : {}), ...(rev !== null ? { rev } : {}) });
      save();
      runs.get(turnId)?.finish();
      runs.delete(turnId);
      changed(view(turnId, t));
    },
    /** A turn refused before it started: a repeat of it gets the same answer. */
    refuse({ turnId, chatId, replyId, kind, status, error, code }) {
      turns[turnId] = { chatId, replyId, kind, state: 'refused', status, error, code, at: now(), endedAt: now() };
      save();
    },
    refusal: turnId => (turns[turnId]?.state === 'refused' ? { status: turns[turnId].status, error: turns[turnId].error, code: turns[turnId].code } : null),
    /** Turns that were running when the host last stopped (read once at start). */
    interrupted: () => stranded.splice(0),
  };
}
