/**
 * Running a persisted turn (RESPONSE5.md, items 3, 4 and 11): Strata writes the person's message and the reply into the chat itself,
 * whether or not any client is still connected, and a repeat of the same `turnId` never starts a second turn.
 *
 *   1. A repeat: a running turn is joined (its frames so far, then live); a finished one is answered from the chat; a refused one gets
 *      the same refusal.
 *   2. Before anything else (before the model wakes): one save with the message (or the rewind) and the reply placeholder.
 *   3. The stream starts at once: `queued`, `saved` (final: false), then the turn's own frames. The kind's `execute` sends `status`
 *      (waking) while the model starts.
 *   4. While the turn runs the reply is saved at most every 5 seconds; at the end it is saved once more, finished, and `saved` (final:
 *      true) is the last frame.
 *
 * `stopOnLeave`: the turn stops when the last connection watching it is gone. Since phase 2 no kind uses it: Chat, Code, Vibe, roleplay
 * and pictures keep running without a connection, and every persisted turn is stopped with /api/chat/stop (or /api/rp/stop, /api/images/stop).
 * Every frame carries `seq`; a client that lost the stream picks it up with `after` (the same request again, or an attach).
 */
import { randomUUID } from 'node:crypto';
import { error } from './util.mjs';
import { keepStreamAlive } from './stream-beat.mjs';
import { validMessageId, validTurnId } from './turn-record.mjs';

const SAVE_EVERY_MS = 5000;
export const CONNECTION_LOST = 'The connection was lost, so this reply stopped. What was written so far is kept; ask again for the rest.';

/** An error a prepare step throws: refused before anything started. */
export const CHAT_DELETED = 'This chat was deleted.';
export const refusal = (status, message, code) => Object.assign(new Error(message), { status, code });

const NDJSON = { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' };

export function createPersistedTurns({ chatStore, ledger, emitChat = () => {}, log = () => {}, saveEveryMs = SAVE_EVERY_MS }) {
  const stops = new Map();   // chatId -> { turnId, kind, abort, ended }

  /** Why a persisted request cannot be taken, or null. */
  function check(body) {
    if (typeof body.sessionId !== 'string' || !body.sessionId) return refusal(400, 'sessionId is required.', 'bad-message');
    if (!validTurnId(body.turnId)) return refusal(400, 'turnId is required: a fresh id for each press, reused only by a retry of that press.', 'bad-message');
    if (body.replyId !== undefined && !validMessageId(body.replyId)) return refusal(400, 'replyId is not a valid message id.', 'bad-message');
    return null;
  }

  function stream(res) {
    res.writeHead(200, NDJSON);
    keepStreamAlive(res);
    const client = new AbortController();
    res.on('close', () => { if (!res.writableEnded) client.abort(); });
    const write = frame => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(frame)}\n`); };
    return { client, write };
  }

  /** A client picks up a turn (running, or ended less than 10 minutes ago): the frames after `after` (all for null), then live ones. */
  async function join(res, run, after = null) {
    const { client, write } = stream(res);
    run.subscribe(write, client.signal, after);
    if (!run.finished) await Promise.race([run.ended, new Promise(r => client.signal.addEventListener('abort', r, { once: true }))]);
    if (!res.writableEnded) res.end();
  }
  const afterOf = value => (Number.isInteger(value) && value >= 0 ? value : null);

  /**
   * Pick up a turn by `turnId` or by a `requestId` it sent (its own, or the agent's): POST /api/chat/attach, /api/rp/attach and
   * /api/images/attach. Answers false when the turn is not a persisted one (the caller tries the agent's own attach).
   */
  async function attach(res, { turnId = null, requestId = null, after = null, chatId = null }) {
    const known = turnId ? ledger.get(turnId) : requestId ? ledger.byRequest(requestId) : null;
    if (!known || (chatId && known.chatId !== chatId)) return false;
    const run = ledger.run(known.turnId);
    if (run) { await join(res, run, afterOf(after)); return true; }
    if (known.state === 'running') { error(res, 409, 'That turn is still being written.', { code: 'turn-running' }); return true; }
    if (known.state === 'refused') { const r = ledger.refusal(known.turnId); error(res, r.status, r.error, { code: r.code }); return true; }
    await replay(res, known);
    return true;
  }

  /** A finished turn asked again: its reply from the chat, as a short stream. */
  async function replay(res, known) {
    const text = await chatStore.read(known.chatId);
    const file = text ? JSON.parse(text) : null;
    const reply = file?.session?.messages?.find(m => m.id === known.replyId) ?? null;
    const { write } = stream(res);
    write({ type: 'start', resumed: true, requestId: known.requestId, turnId: known.turnId, model: reply?.model ?? '', contextMax: reply?.contextMax ?? 0 });
    if (known.kind === 'impersonate') write({ type: 'rp-final', content: known.text ?? '' });
    else if (reply) {
      write({ type: 'resync', content: reply.content ?? '', reasoning: reply.reasoning ?? '' });
      for (const tool of reply.tools ?? []) write({ type: 'agent-tool', tool });
      for (const m of reply.media ?? []) if (typeof m.src === 'string') write({ type: 'image', file: m.src.split('/').pop(), title: m.title });
      if (known.kind === 'rp') write({ type: 'rp-final', content: reply.content ?? '', vars: file.session.rp?.vars ?? {} });
    }
    const failed = known.state !== 'done' ? (reply?.error ?? known.error ?? (known.state === 'stopped' ? 'Stopped.' : 'The reply failed.')) : null;
    write(failed ? { type: 'error', message: failed, ...(reply?.errorCode ?? known.code ? { code: reply?.errorCode ?? known.code } : {}) }
      : { type: 'done', tokensIn: reply?.inputTokens ?? null, tokensOut: reply?.tokens ?? null, durationMs: reply?.durationMs ?? null, usageSource: reply?.usageSource ?? 'unavailable' });
    write({ type: 'saved', rev: file?.rev ?? known.rev ?? null, messageIds: known.replyId ? [known.replyId] : [], final: true });
    res.end();
  }

  /**
   * One persisted request. `prepare(session)` returns { session, messageIds, replyId? , ...anything execute needs } or throws
   * refusal(...); `recorder(prepared)` builds the reply from frames; `execute({ onFrame, signal, prepared, requestId })` runs the turn.
   */
  async function handle({ res, body, kind, prepare, recorder, execute, stopOnLeave = false }) {
    const bad = check(body);
    if (bad) return error(res, bad.status, bad.message, { code: bad.code });
    const chatId = body.sessionId, turnId = body.turnId;

    const known = ledger.get(turnId);
    if (known) {
      if (known.chatId !== chatId) return error(res, 409, 'That turnId belongs to another chat.', { code: 'id-taken' });
      const refused = ledger.refusal(turnId);
      if (refused) return error(res, refused.status, refused.error, { code: refused.code });
      const run = ledger.run(turnId);
      if (run) return join(res, run, afterOf(body.after));
      if (known.state === 'running') return error(res, 409, 'That turn is still being written.', { code: 'turn-running' });
      return replay(res, known);
    }

    let prepared = null;
    let first;
    try {
      first = await chatStore.update(chatId, session => {
        prepared = prepare(session);
        const writing = prepared.replyId ? ledger.writing(chatId, prepared.replyId) : null;
        if (writing) throw refusal(409, 'Another turn is still writing that reply.', 'turn-running');
        return prepared.session;
      });
    } catch (e) {
      const status = e.status ?? 400, code = e.code ?? 'bad-message';
      if (code !== 'turn-running') ledger.refuse({ turnId, chatId, replyId: prepared?.replyId ?? body.replyId ?? null, kind, status, error: e.message, code });
      return error(res, status, e.message, { code });
    }
    const rev = first?.rev ?? chatStore.rev(chatId);
    emitChat(chatId, rev);

    const requestId = `req-${randomUUID()}`;
    const replyId = prepared.replyId ?? null;
    const run = ledger.begin({ turnId, chatId, replyId, kind, requestId });
    const rec = recorder(prepared);
    run.replyIds = rec.replyIds;
    const { client, write } = stream(res);
    run.subscribe(write, client.signal);

    const turnAbort = new AbortController();
    let lost = false, stoppedByPerson = false, cancelled = false, sawError = null;
    // The reply so far, for a client that resumes later than the kept frames reach.
    let soFar = { content: '', reasoning: '' };
    run.snapshot = () => soFar;
    run.requestIds.add(requestId);
    if (stopOnLeave) run.onIdle = () => { lost = true; turnAbort.abort(); };
    stops.set(chatId, { turnId, kind, stopOnLeave, abort: () => { stoppedByPerson = true; turnAbort.abort(); }, ended: run.ended });

    run.push({ type: 'queued', requestId, turnId });
    run.push({ type: 'saved', rev, messageIds: prepared.messageIds ?? (replyId ? [replyId] : []), final: false });

    let lastRev = rev, timer = null, saving = Promise.resolve();
    const gone = () => chatStore.wasDeleted?.(chatId) === true;
    const flush = end => {
      saving = saving.then(async () => {
        if (gone()) return;   // the person deleted the chat: nothing is written back
        const r = await chatStore.update(chatId, s => rec.into(s, { end }), { persisted: rec.replyIds() });
        if (r) { lastRev = r.rev; emitChat(chatId, r.rev); }
      }).catch(e => log(`persisted turn · could not save ${chatId}: ${e.message}`));
      return saving;
    };
    const onFrame = frame => {
      if (!frame || typeof frame !== 'object') return;
      // A turn stopped from somewhere else (the desktop's Stop goes to the agent directly) ends with a cancelled done: stopped, not done.
      if (frame.type === 'done' && (frame.cancelled === true || frame.finishReason === 'aborted')) cancelled = true;
      if (frame.type === 'delta') soFar = { ...soFar, content: soFar.content + (frame.text ?? '') };
      else if (frame.type === 'reasoning') soFar = { ...soFar, reasoning: soFar.reasoning + (frame.text ?? '') };
      else if (frame.type === 'resync') soFar = { content: frame.content ?? '', reasoning: frame.reasoning ?? '' };
      // Waiting for the person (an approval, a question): the list's badge comes from the `turns` event.
      if (frame.type === 'status') ledger.waiting(turnId, /^waiting/.test(String(frame.code ?? '')));
      else if (frame.type === 'agent-question') ledger.waiting(turnId, true);
      else if (frame.type === 'agent-question-end') ledger.waiting(turnId, false);
      if (frame.type === 'error') sawError = { message: String(frame.message ?? 'The reply failed.'), code: typeof frame.code === 'string' ? frame.code : null };
      run.push(frame);
      rec.apply(frame);
      if (!timer && frame.type !== 'beat') timer = setTimeout(() => { timer = null; void flush(null); }, saveEveryMs);
    };

    try { await execute({ onFrame, signal: turnAbort.signal, prepared, requestId, turnId }); }
    catch (e) { if (!turnAbort.signal.aborted && e?.name !== 'AbortError') onFrame({ type: 'error', message: e?.message ?? String(e), ...(e?.code ? { code: e.code } : {}) }); }
    if (timer) { clearTimeout(timer); timer = null; }

    if (gone()) {
      // Deleted while it ran (delete stops it): the watchers are told, and nothing is saved.
      await saving;
      run.push({ type: 'error', message: CHAT_DELETED, code: 'deleted' });
      ledger.end(turnId, { state: 'stopped', error: CHAT_DELETED, code: 'deleted', rev: null });
      if (stops.get(chatId)?.turnId === turnId) stops.delete(chatId);
      if (!res.writableEnded) res.end();
      return undefined;
    }
    const state = stoppedByPerson || lost || cancelled ? 'stopped' : sawError ? 'error' : 'done';
    const end = { state, error: lost ? CONNECTION_LOST : null, code: lost ? 'connection-lost' : null };
    await flush(end);
    if (kind === 'impersonate') ledger.update(turnId, { text: rec.text?.() ?? '' });
    run.push({ type: 'saved', rev: lastRev, messageIds: rec.replyIds(), final: true });
    ledger.end(turnId, { state, error: end.error ?? sawError?.message ?? null, code: end.code ?? sawError?.code ?? null, rev: lastRev });
    if (stops.get(chatId)?.turnId === turnId) stops.delete(chatId);
    void client;
    if (!res.writableEnded) res.end();
    return undefined;
  }

  return {
    check,
    handle,
    attach,
    /** Stop the chat's persisted turn (an agent turn is stopped by the agent as well): resolves once it has ended, or null when there is none. */
    stop(chatId) {
      const s = stops.get(chatId);
      if (!s) return null;
      s.abort();
      return s.ended.then(() => ({ stopped: true, turnId: s.turnId }));
    },
  };
}
