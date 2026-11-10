// Persisted turns (server/persisted-turn.mjs, server/turn-ledger.mjs) under a bad connection: the client goes away mid-turn, the same press
// is sent again, the host restarts in the middle, and a request is refused. The turn runs once, and the chat holds it exactly once.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStore } from '../server/chat-store.mjs';
import { createTurnLedger } from '../server/turn-ledger.mjs';
import { createPersistedTurns, refusal, CONNECTION_LOST } from '../server/persisted-turn.mjs';
import { createChatRecorder } from '../server/turn-record.mjs';
import { prepareChatTurn } from '../server/chat-turn.mjs';
import { readBody } from '../server/util.mjs';

const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };

async function rig(t, { stopOnLeave = false, ending = null, keepFramesMs = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'strata-persist-'));
  const store = createChatStore({ dir });
  const ledger = createTurnLedger({ file: join(store.root, 'turns.json'), keepFramesMs });
  store.setLive((c, m) => ledger.isLive(c, m));
  const events = [];
  const persisted = createPersistedTurns({ chatStore: store, ledger, emitChat: (id, rev) => events.push({ id, rev }), saveEveryMs: 20 });
  const runs = { count: 0, release: gate(), started: gate() };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    await persisted.handle({ res, body, kind: 'chat', stopOnLeave,
      prepare: s => {
        if (!body.userMessage) throw refusal(400, 'userMessage is required.', 'bad-message');
        const reply = { id: body.replyId, role: 'assistant', content: '', at: 'T', streaming: true };
        return { session: { ...s, messages: [...s.messages, body.userMessage, reply] }, replyId: body.replyId, messageIds: [body.userMessage.id, body.replyId] };
      },
      recorder: p => createChatRecorder({ replyId: p.replyId }),
      execute: async ({ onFrame, signal }) => {
        runs.count += 1;
        onFrame({ type: 'start', model: 'M', contextMax: 10 });
        onFrame({ type: 'delta', text: 'Hello' });
        runs.started.open();
        await Promise.race([runs.release.p, new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))]);
        onFrame({ type: 'delta', text: ' world.' });
        onFrame(ending ?? { type: 'done', tokensIn: 3, tokensOut: 2, durationMs: 5, usageSource: 'reported' });
      } });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  await store.save('s_p', JSON.stringify({ id: 's_p', title: 'T', messages: [] }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (extra = {}, signal) => fetch(base, { method: 'POST', body: JSON.stringify({ sessionId: 's_p', turnId: 't_one1', persist: true, replyId: 'm_r1', userMessage: { id: 'm_u1', role: 'user', content: 'Hi', at: '2026-11-09T01:00:00.000Z' }, ...extra }), signal });
  const frames = async res => (await res.text()).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const chat = async () => JSON.parse(await store.read('s_p')).session;
  return { dir, store, ledger, runs, send, frames, chat, events };
}

/** Read frames until `type` arrives, then drop the connection. */
async function readUntil(res, abort, type) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  const seen = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) seen.push(JSON.parse(line)); }
    if (seen.some(f => f.type === type)) { abort.abort(); break; }
  }
  return seen;
}

test('the stream starts with queued and saved before the model answers; the client leaves after the first delta and the turn still finishes and is saved once', async t => {
  const r = await rig(t);
  const abort = new AbortController();
  const res = await r.send({}, abort.signal);
  const seen = await readUntil(res, abort, 'delta').catch(() => []);
  assert.deepEqual(seen.slice(0, 2).map(f => f.type), ['queued', 'saved']);
  assert.equal(seen[1].final, false);
  assert.deepEqual(seen[1].messageIds, ['m_u1', 'm_r1']);
  const early = await r.chat();
  assert.deepEqual(early.messages.map(m => m.id), ['m_u1', 'm_r1'], 'the message and the placeholder are saved before the reply');
  r.runs.release.open();
  for (let i = 0; i < 50 && r.ledger.get('t_one1').state === 'running'; i++) await new Promise(x => setTimeout(x, 20));
  const after = await r.chat();
  assert.deepEqual(after.messages.map(m => m.id), ['m_u1', 'm_r1'], 'each exactly once');
  assert.equal(after.messages[1].content, 'Hello world.');
  assert.equal(after.messages[1].streaming, false);
  assert.equal(after.messages[0].at, '2026-11-09T01:00:00.000Z', 'the person\'s time is kept');
  assert.equal(r.ledger.get('t_one1').state, 'done');
  assert.equal(r.runs.count, 1);
});

test('the same press sent again: while running it joins the turn, after the end it gets the saved reply; never a second turn', async t => {
  const r = await rig(t);
  const first = r.send();
  await r.runs.started.p;
  const again = r.send();
  await new Promise(x => setTimeout(x, 50));
  r.runs.release.open();
  const [one, two] = await Promise.all([first.then(r.frames), again.then(r.frames)]);
  assert.equal(r.runs.count, 1);
  assert.equal(one.at(-1).type, 'saved'); assert.equal(one.at(-1).final, true);
  assert.ok(two.some(f => f.type === 'delta' && f.text.startsWith('Hello')), 'the joined stream gets the text so far');
  assert.equal(two.at(-1).final, true);
  // Within 10 minutes of the end the kept frames come again (text pieces joined), each with its number.
  const later = await r.frames(await r.send());
  assert.deepEqual(later.map(f => f.type), ['queued', 'saved', 'start', 'delta', 'done', 'saved']);
  assert.equal(later[3].text, 'Hello world.');
  assert.deepEqual(later.map(f => f.seq), [1, 2, 3, 5, 6, 7]);
  assert.equal(r.runs.count, 1);
  assert.equal((await r.chat()).messages.length, 2);
});

test('a second press on a reply a running turn is writing is refused with turn-running', async t => {
  const r = await rig(t);
  const first = r.send();
  await r.runs.started.p;
  const other = await r.send({ turnId: 't_two2', userMessage: { id: 'm_u2', role: 'user', content: 'Again' } });
  assert.equal(other.status, 409);
  assert.equal((await other.json()).code, 'turn-running');
  r.runs.release.open();
  await first;
  assert.equal(r.runs.count, 1);
});

test('a refused request is refused the same way when sent again, and GET-style state says so', async t => {
  const r = await rig(t);
  const res = await r.send({ turnId: 't_bad1', userMessage: undefined });
  assert.equal(res.status, 400);
  const again = await r.send({ turnId: 't_bad1', userMessage: undefined });
  assert.equal(again.status, 400);
  assert.equal(r.ledger.get('t_bad1').state, 'refused');
  assert.equal(r.ledger.get('t_never'), null, 'an unknown turn is unknown: safe to send');
  assert.equal(r.runs.count, 0);
});

test('a turn that stops on its own when the connection goes (roleplay, pictures, plain chat) is saved with the reason', async t => {
  const r = await rig(t, { stopOnLeave: true });
  const abort = new AbortController();
  await readUntil(await r.send({}, abort.signal), abort, 'delta').catch(() => []);
  for (let i = 0; i < 50 && r.ledger.get('t_one1').state === 'running'; i++) await new Promise(x => setTimeout(x, 20));
  const t1 = r.ledger.get('t_one1');
  assert.equal(t1.state, 'stopped');
  assert.equal(t1.code, 'connection-lost');
  const reply = (await r.chat()).messages[1];
  assert.deepEqual([reply.content, reply.streaming, reply.error, reply.errorCode], ['Hello', false, CONNECTION_LOST, 'connection-lost']);
});

test('a host restart in the middle: the turn is still known (not "unknown"), and is reported as interrupted at the next start', async t => {
  const r = await rig(t);
  const first = r.send();
  await r.runs.started.p;
  const reborn = createTurnLedger({ file: join(r.store.root, 'turns.json') });
  assert.equal(reborn.get('t_one1').state, 'running', 'a retry after a restart never sends the message twice');
  assert.deepEqual(reborn.interrupted().map(x => [x.turnId, x.replyId]), [['t_one1', 'm_r1']]);
  r.runs.release.open();
  await first;
});

test('the client leaves right after the first saved, before any text: a Chat turn still runs to its end and is saved whole, as done', async t => {
  const r = await rig(t);
  const abort = new AbortController();
  const seen = await readUntil(await r.send({}, abort.signal), abort, 'saved').catch(() => []);
  assert.deepEqual(seen.slice(0, 2).map(f => f.type), ['queued', 'saved']);
  await r.runs.started.p;
  r.runs.release.open();
  for (let i = 0; i < 50 && r.ledger.get('t_one1').state === 'running'; i++) await new Promise(x => setTimeout(x, 20));
  assert.equal(r.ledger.get('t_one1').state, 'done');
  const reply = (await r.chat()).messages[1];
  assert.deepEqual([reply.content, reply.streaming, reply.error, reply.errorCode], ['Hello world.', false, undefined, undefined]);
  assert.equal(r.runs.count, 1);
});

test('a turn cancelled from somewhere else (the desktop\'s Stop goes to the agent) is recorded as stopped, never as done', async t => {
  const r = await rig(t, { ending: { type: 'done', finishReason: 'aborted', cancelled: true, tokensIn: null, tokensOut: null, usageSource: 'unavailable', durationMs: 0 } });
  const first = r.send();
  await r.runs.started.p;
  r.runs.release.open();
  await (await first).text();
  assert.equal(r.ledger.get('t_one1').state, 'stopped');
  assert.equal((await r.chat()).messages[1].content, 'Hello world.', 'what was written is kept');
});

test('the first message names a new chat only while its title is the default one; a name the person chose stays', () => {
  const ask = { replyId: 'm_r1', userMessage: { id: 'm_u1', role: 'user', content: 'Say hi in two words' } };
  const named = prepareChatTurn(ask, { id: 's_t', title: '[test] probe', defaultTitle: false, messages: [] }).session;
  assert.deepEqual([named.title, named.defaultTitle], ['[test] probe', false]);
  const fresh = prepareChatTurn(ask, { id: 's_t', title: 'New conversation', defaultTitle: true, messages: [] }).session;
  assert.deepEqual([fresh.title, fresh.defaultTitle], ['Say hi in two words', false]);
  const older = prepareChatTurn(ask, { id: 's_t', title: 'New conversation', messages: [] }).session;
  assert.equal(older.title, 'Say hi in two words', 'a chat saved without the field is named, as before');
  const later = prepareChatTurn({ ...ask, replyId: 'm_r2', userMessage: { ...ask.userMessage, id: 'm_u2' } }, { ...fresh, messages: [{ id: 'm_u1', role: 'user', content: 'x' }] }).session;
  assert.equal(later.title, 'Say hi in two words', 'only the first message names it');
});

test('after the kept frames are gone, the same press gets the saved reply from the chat', async t => {
  const r = await rig(t, { keepFramesMs: 0 });
  const first = r.send();
  await r.runs.started.p;
  r.runs.release.open();
  await (await first).text();
  await new Promise(x => setTimeout(x, 10));
  const later = await r.frames(await r.send());
  assert.deepEqual(later.map(f => f.type), ['start', 'resync', 'done', 'saved']);
  assert.equal(later[1].content, 'Hello world.');
});

test('resume: every frame has a seq; the same press with `after` sends only what is missing, even from the middle of a text run', async t => {
  const r = await rig(t);
  const abort = new AbortController();
  const seen = await readUntil(await r.send({}, abort.signal), abort, 'delta').catch(() => []);
  assert.deepEqual(seen.map(f => f.seq), seen.map((_, i) => i + 1), 'numbered 1, 2, 3…');
  const lastSeq = seen.at(-1).seq;   // the "Hello" delta
  const resumed = r.send({ after: lastSeq });
  await new Promise(x => setTimeout(x, 30));
  r.runs.release.open();
  const rest = await r.frames(await resumed);
  assert.deepEqual(rest.map(f => [f.type, f.text ?? null]), [['delta', ' world.'], ['done', null], ['saved', null]], 'only the frames after it');
  const tail = await r.frames(await r.send({ after: lastSeq }));
  assert.equal(tail[0].text, ' world.', 'after the end too, from the middle of the joined text');
  assert.equal(r.ledger.byRequest(seen[0].requestId).turnId, 't_one1', 'a requestId names its turn (attach)');
  assert.equal(r.runs.count, 1);
});

test('a frame\'s own seq (the agent\'s status lines) is kept as statusSeq; waiting for the person is told in the turns event', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'strata-seq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const ledger = createTurnLedger({ file: join(dir, 'turns.json'), changed: v => events.push(v) });
  const run = ledger.begin({ turnId: 't_w1', chatId: 's_w', replyId: 'm_r', kind: 'chat', requestId: 'req-1' });
  const got = [];
  run.subscribe(f => got.push(f));
  run.push({ type: 'status', seq: 7, code: 'waiting-approval', text: 'Waiting' });
  assert.deepEqual([got[0].seq, got[0].statusSeq], [1, 7]);
  ledger.waiting('t_w1', true);
  ledger.waiting('t_w1', true);
  assert.deepEqual(events.map(e => [e.state, e.waiting]), [['running', false], ['running', true]], 'told once, when it changes');
  ledger.end('t_w1', { state: 'done' });
  assert.equal(events.at(-1).waiting, undefined);
});
