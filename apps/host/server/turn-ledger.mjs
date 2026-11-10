/**
 * Persisted turns (RESPONSE5.md, items 3 to 5): the ledger on disk and the turns running now.
 *
 *   <data folder>/chats/turns.json   { v: 1, turns: { <turnId>: { chatId, replyId, kind, state, requestId, rev, at, endedAt, error, code, status } } }
 *
 * - `turnId` names one press of a button. A repeat of the same turnId (the phone never heard back) never starts a second turn: a running
 *   turn is joined, a finished one is answered from the chat. Records are kept 24 hours and survive a restart.
 * - `state`: running | done | error | stopped | refused (refused: nothing started; `status` and `error` are the answer it got).
 * - A turn that was `running` when the host stopped is returned by `interrupted()` at start, so its reply can be closed.
 * - Each turn keeps its frames in memory while it runs and for 10 minutes after it ends (at most 5,000, with text pieces joined), each
 *   numbered `seq` 1, 2, 3…, so a client that lost the stream asks for the frames after the last one it has (`after`). Subscribers are the
 *   request that started it and any repeat or attach. `onIdle` runs when the last subscriber leaves (the caller decides whether that stops
 *   the turn).
 */
import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const KEEP_MS = 24 * 3600_000;
const MAX_FRAMES = 5000;
const KEEP_FRAMES_MS = 10 * 60_000;

export function createTurnLedger({ file, now = () => Date.now(), changed = () => {}, keepFramesMs = KEEP_FRAMES_MS }) {
  let turns = {};
  try { const parsed = JSON.parse(readFileSync(file, 'utf8')); if (parsed?.v === 1 && parsed.turns && typeof parsed.turns === 'object') turns = parsed.turns; } catch { /* first start */ }
  const stranded = Object.entries(turns).filter(([, t]) => t.state === 'running').map(([turnId, t]) => ({ turnId, ...t }));
  const runs = new Map();   // turnId -> run

  function save() {
    const cutoff = now() - KEEP_MS;
    for (const [id, t] of Object.entries(turns)) if (t.state !== 'running' && (t.endedAt ?? t.at ?? 0) < cutoff) delete turns[id];
    try { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify({ v: 1, turns }), { mode: 0o600 }); renameSync(tmp, file); } catch { /* kept in memory */ }
  }
  const view = (turnId, t) => ({ turnId, chatId: t.chatId, replyId: t.replyId, kind: t.kind, state: t.state, requestId: t.requestId ?? null, rev: t.rev ?? null, ...(t.state === 'running' ? { waiting: !!t.waiting } : {}), ...(t.error ? { error: t.error } : {}), ...(t.code ? { code: t.code } : {}) });

  function createRun(turnId) {
    // Kept frames: { f, from, cuts }. A run of text pieces (delta or reasoning with nothing else) is joined into one frame; `cuts` holds the
    // text length after each piece, so a resume from the middle of the run sends exactly the missing part.
    const kept = [];
    let seq = 0, dropped = 0;
    const subs = new Set();
    let endedResolve;
    const ended = new Promise(r => { endedResolve = r; });
    let onIdle = () => {};
    let finished = false;
    const textOnly = frame => (frame.type === 'delta' || frame.type === 'reasoning') && Object.keys(frame).every(k => k === 'type' || k === 'text' || k === 'seq');
    /** The kept frames after `after` (all of them for null), or null when some of those are no longer kept. */
    function since(after) {
      if (after === null) return kept.map(k => k.f);
      if (after < dropped) return null;
      const out = [];
      for (const k of kept) {
        if (k.f.seq <= after) continue;
        if (k.cuts && after >= k.from) out.push({ ...k.f, text: k.f.text.slice(k.cuts[after - k.from]) });
        else out.push(k.f);
      }
      return out;
    }
    return {
      turnId,
      ended,
      replyIds: null,
      requestIds: new Set(),
      /** What the reply holds so far, for a resume that comes too late for the kept frames (set by the caller). */
      snapshot: () => null,
      get finished() { return finished; },
      get seq() { return seq; },
      set onIdle(fn) { onIdle = fn; },
      push(frame) {
        if (frame.type === 'beat') { for (const fn of [...subs]) { try { fn(frame); } catch { subs.delete(fn); } } return; }
        // Every frame is numbered (1, 2, 3… per turn). A frame's own `seq` (the agent's status lines) moves to `statusSeq`.
        const numbered = { ...frame, ...(frame.seq !== undefined ? { statusSeq: frame.seq } : {}), seq: ++seq };
        const last = kept.at(-1);
        if (last?.cuts && textOnly(frame) && last.f.type === frame.type) { last.f = { ...last.f, text: last.f.text + frame.text, seq }; last.cuts.push(last.f.text.length); }
        else {
          kept.push(textOnly(frame) ? { f: { type: frame.type, text: frame.text, seq }, from: seq, cuts: [String(frame.text).length] } : { f: numbered, from: seq });
          if (kept.length > MAX_FRAMES) { const gone = kept.splice(0, kept.length - MAX_FRAMES); dropped = gone.at(-1).f.seq; }
        }
        if (frame.requestId) this.requestIds.add(frame.requestId);
        for (const fn of [...subs]) { try { fn(numbered); } catch { subs.delete(fn); } }
      },
      /**
       * Send the frames after `after` (everything for null) to `fn`, then the live frames, until `signal` aborts. When the frames after
       * `after` are no longer kept, one `resync` with the reply so far comes first, then the kept frames that follow.
       */
      subscribe(fn, signal, after = null) {
        const missed = since(after);
        if (missed) for (const f of missed) fn(f);
        else {
          fn({ type: 'resync', ...(this.snapshot() ?? {}), seq: dropped });
          for (const f of since(dropped)) fn(f);
        }
        if (finished) return;
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
    /** A running turn now waits for the person (an approval or a question), or no longer does: told to the `turns` event. */
    waiting(turnId, value) {
      const t = turns[turnId];
      if (!t || t.state !== 'running' || !!t.waiting === value) return;
      t.waiting = value;
      changed(view(turnId, t));
    },
    /** The turn a requestId belongs to: its own, or one its frames named (the agent's). */
    byRequest(requestId) {
      for (const [id, t] of Object.entries(turns)) if (t.requestId === requestId || runs.get(id)?.requestIds.has(requestId)) return view(id, t);
      return null;
    },
    /** Close a turn: done, error or stopped (with the chat's revision that holds the final reply). */
    end(turnId, { state, error = null, code = null, rev = null }) {
      const t = turns[turnId];
      if (!t) return;
      Object.assign(t, { state, endedAt: now(), ...(error ? { error } : {}), ...(code ? { code } : {}), ...(rev !== null ? { rev } : {}) });
      delete t.waiting;
      save();
      const run = runs.get(turnId);
      run?.finish();
      // Its frames stay 10 minutes for a client that comes back (resume with `after`), then go.
      if (run) setTimeout(() => { if (runs.get(turnId) === run) runs.delete(turnId); }, keepFramesMs).unref?.();
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
