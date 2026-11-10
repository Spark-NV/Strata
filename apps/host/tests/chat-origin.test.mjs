// Where a chat or project was started (server/origin.mjs), and a chat deleted on one device: gone everywhere, never brought back, and a
// reply still being written in it stops (server/chat-store.mjs, server/persisted-turn.mjs, server/projects.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originOf } from '../server/origin.mjs';
import { createChatStore } from '../server/chat-store.mjs';
import { createTurnLedger } from '../server/turn-ledger.mjs';
import { createPersistedTurns } from '../server/persisted-turn.mjs';
import { createChatRecorder } from '../server/turn-record.mjs';
import { createProjects } from '../server/projects.mjs';
import { readBody } from '../server/util.mjs';

const req = headers => ({ headers });
const chat = (id, extra = {}) => JSON.stringify({ id, title: 'T', messages: [], ...extra });
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'strata-origin-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('origin: the iPhone app, the web page from away, this PC, and other programs', () => {
  const at = new Date('2026-11-09T12:00:00.000Z');
  assert.deepEqual(originOf(req({ 'x-strata-client': 'ios', 'x-strata-remote': '1' }), at), { via: 'ios-app', at: '2026-11-09T12:00:00.000Z' });
  assert.equal(originOf(req({ 'x-strata-client': 'ui', 'x-strata-remote': '1' })).via, 'remote-web');
  assert.equal(originOf(req({ 'x-strata-client': 'ui' })).via, 'pc');
  assert.equal(originOf(req({ 'x-strata-client': 'probe', 'x-strata-remote': '1' })).via, 'remote-api');
  assert.equal(originOf(req({ 'x-strata-client': 'probe' })).via, 'local-api');
});

test('a chat\'s origin is set by its first save only: no later save, merge, update or patch changes or drops it', async t => {
  const dir = temp(t);
  const store = createChatStore({ dir });
  const phone = { via: 'ios-app', at: '2026-11-09T12:00:00.000Z' };
  await store.save('s_o', chat('s_o'), { origin: phone });
  await store.save('s_o', chat('s_o', { title: 'Renamed on the PC' }), { origin: { via: 'pc', at: '2026-11-09T13:00:00.000Z' } });
  await store.save('s_o', chat('s_o', { title: 'Old copy' }), { baseRev: 1, origin: { via: 'pc', at: 'x' } });
  await store.update('s_o', s => ({ ...s, messages: [{ id: 'm_1', role: 'user', content: 'hi' }] }));
  await store.patch('s_o', { pinned: true });
  const file = JSON.parse(await store.read('s_o'));
  assert.deepEqual(file.origin, phone);
  assert.equal(file.session.origin, undefined, 'the chat itself is stored as the device sent it');
  assert.deepEqual(store.list().chats[0].origin, phone);
  await store.save('s_n', chat('s_n'));
  assert.equal(JSON.parse(await store.read('s_n')).origin, undefined, 'a save that names no origin stores none');
  // The index is rebuilt from the files: the origin comes back from the file.
  unlinkSync(join(store.root, 'index.json'));
  assert.deepEqual(createChatStore({ dir }).list().chats.find(c => c.id === 's_o').origin, phone);
});

test('deletedSince: a device that was away learns which chats went; without it the list is as before', async t => {
  let clock = new Date('2026-11-09T10:00:00.000Z');
  const store = createChatStore({ dir: temp(t), now: () => clock });
  for (const id of ['s_a', 's_b', 's_c']) await store.save(id, chat(id));
  await store.remove('s_a');
  clock = new Date('2026-11-09T11:00:00.000Z');
  await store.remove('s_b');
  assert.equal(store.list().deleted, undefined);
  const since = store.list({ deletedSince: '2026-11-09T10:30:00.000Z' });
  assert.deepEqual(since.deleted, [{ id: 's_b', at: '2026-11-09T11:00:00.000Z' }]);
  assert.deepEqual(since.chats.map(c => c.id), ['s_c']);
  assert.equal(since.now, '2026-11-09T11:00:00.000Z');
  await assert.rejects(store.save('s_b', chat('s_b'), { baseRev: 1 }), e => e.status === 410 && e.code === 'deleted');
});

test('a chat deleted while Strata writes a reply in it: the turn stops, its watchers get `deleted`, and the chat is not written back', async t => {
  const dir = temp(t);
  const store = createChatStore({ dir });
  const ledger = createTurnLedger({ file: join(store.root, 'turns.json') });
  let release; const held = new Promise(r => { release = r; });
  let started; const running = new Promise(r => { started = r; });
  const persisted = createPersistedTurns({ chatStore: store, ledger, emitChat: () => {}, saveEveryMs: 10 });
  const server = http.createServer(async (rq, res) => {
    const body = await readBody(rq);
    await persisted.handle({ res, body, kind: 'chat', stopOnLeave: false,
      prepare: s => ({ session: { ...s, messages: [...s.messages, body.userMessage, { id: body.replyId, role: 'assistant', content: '', streaming: true }] }, replyId: body.replyId, messageIds: [body.userMessage.id, body.replyId] }),
      recorder: p => createChatRecorder({ replyId: p.replyId }),
      execute: async ({ onFrame, signal }) => {
        onFrame({ type: 'delta', text: 'Hello' }); started();
        await Promise.race([held, new Promise(r => signal.addEventListener('abort', r, { once: true }))]);
      } });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  await store.save('s_d', chat('s_d'));
  const reply = fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', body: JSON.stringify({ sessionId: 's_d', turnId: 't_del1', persist: true, replyId: 'm_r1', userMessage: { id: 'm_u1', role: 'user', content: 'Hi' } }) });
  await running;
  await new Promise(r => setTimeout(r, 30));   // a periodic save happens while it runs
  await store.remove('s_d');
  await persisted.stop('s_d');
  const frames = (await (await reply).text()).trim().split('\n').map(l => JSON.parse(l));
  const { seq, ...last } = frames.at(-1);
  assert.deepEqual(last, { type: 'error', message: 'This chat was deleted.', code: 'deleted' });
  assert.ok(seq > 1);
  assert.equal(frames.some(f => f.type === 'saved' && f.final), false);
  assert.deepEqual([ledger.get('t_del1').state, ledger.get('t_del1').code], ['stopped', 'deleted']);
  await store.idle();
  assert.equal(await store.read('s_d'), null, 'nothing brought it back');
  assert.equal(store.list().chats.length, 0);
  release();
});

test('a project keeps the origin of where it was first added, however it is used after', t => {
  const dir = temp(t);
  const folder = join(dir, 'p'); mkdirSync(folder);
  const projects = createProjects({ file: join(dir, 'recent-projects.json') });
  const phone = { via: 'ios-app', at: '2026-11-09T12:00:00.000Z' };
  projects.touch(folder, phone);
  projects.touch(folder, { via: 'pc', at: 'later' });
  projects.add(folder, { via: 'pc', at: 'later' });
  assert.deepEqual(projects.list()[0].origin, phone);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'recent-projects.json'), 'utf8')).projects[0].origin, phone);
});
