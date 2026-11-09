// Merging saves by message id (server/chat-merge.mjs, server/chat-store.mjs): a device saving an older copy never drops what Strata or
// another device added, a real edit on both sides keeps both versions, and a base older than the history behaves as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStore } from '../server/chat-store.mjs';
import { canonical, hashOf, mergePatch } from '../server/chat-merge.mjs';

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'strata-merge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createChatStore({ dir }) };
}
const chat = (messages, extra = {}) => ({ id: 's_m', title: 'T', updatedAt: '2026-11-09T00:00:00.000Z', messages, ...extra });
const put = (store, session, baseRev = null, options = {}) => store.save('s_m', JSON.stringify(session), { baseRev, ...options });
const now = async store => JSON.parse(await store.read('s_m'));
const u = (id, content = id) => ({ id, role: 'user', content });
const a = (id, content = id, more = {}) => ({ id, role: 'assistant', content, ...more });
const conflicts = dir => { try { return readdirSync(join(dir, 'chats', 'conflicts')); } catch { return []; } };

test('the stale desktop: a partial reply sent back after Strata finished the turn keeps the final reply, with no conflict', async t => {
  const { store } = rig(t);
  const r1 = await put(store, chat([u('u1')]));
  // Strata writes the phone's turn: the message and the reply placeholder, then a part of the reply, then the finished reply.
  await store.update('s_m', s => ({ ...s, messages: [...s.messages, u('u2'), a('r2', '', { streaming: true })] }), { persisted: ['r2'] });
  const partial = await store.update('s_m', s => ({ ...s, messages: s.messages.map(m => (m.id === 'r2' ? { ...m, content: 'Half of it' } : m)) }), { persisted: ['r2'] });
  const desktopCopy = (await now(store)).session;   // the desktop reloaded here: it holds the partial reply
  await store.update('s_m', s => ({ ...s, messages: s.messages.map(m => (m.id === 'r2' ? { ...m, content: 'The whole answer.', streaming: false } : m)) }), { persisted: ['r2'] });
  // The desktop changes the title from its older copy.
  const saved = await put(store, { ...desktopCopy, title: 'Renamed' }, partial.rev);
  assert.equal(saved.conflict, false);
  const after = (await now(store)).session;
  assert.equal(after.messages.find(m => m.id === 'r2').content, 'The whole answer.');
  assert.equal(after.messages.find(m => m.id === 'r2').streaming, false);
  assert.equal(after.title, 'Renamed');
  assert.equal(r1.rev, 1);
});

test('an older copy that is still streaming never replaces a finished persisted reply, even when its base is older than the history', async t => {
  const { store } = rig(t);
  await put(store, chat([u('u1'), a('r1', '', { streaming: true })]));
  await store.update('s_m', s => ({ ...s, messages: s.messages.map(m => (m.id === 'r1' ? { ...m, content: 'Done.', streaming: false } : m)) }), { persisted: ['r1'] });
  const saved = await put(store, chat([u('u1'), a('r1', 'Do', { streaming: true })]), 0);
  assert.equal(saved.conflict, false);
  assert.equal((await now(store)).session.messages[1].content, 'Done.');
});

test('a real edit on both sides: the incoming one wins and the other version is kept in conflicts/', async t => {
  const { store, dir } = rig(t);
  const base = await put(store, chat([u('u1'), a('r1', 'first answer')]));
  await put(store, chat([u('u1'), a('r1', 'edited on the phone')]), base.rev);
  const saved = await put(store, chat([u('u1'), a('r1', 'edited on the desktop')]), base.rev);
  assert.equal(saved.conflict, true);
  assert.equal((await now(store)).session.messages[1].content, 'edited on the desktop');
  const kept = conflicts(dir).map(f => JSON.parse(readFileSync(join(dir, 'chats', 'conflicts', f), 'utf8')).session.messages[1].content);
  assert.ok(kept.includes('edited on the phone'), 'the phone\'s version is kept');
});

test('a base older than the hash history behaves as before: the incoming copy wins', async t => {
  const { store, dir } = rig(t);
  await put(store, chat([u('u1'), a('r1', 'v1')]));
  // A chat saved before side files existed: no side file, so the first save makes a baseline in which everything is old.
  rmSync(join(dir, 'chats', 's_m.meta.json'));
  const second = await put(store, chat([u('u1'), a('r1', 'v2')]), 1);
  assert.equal(second.merged, undefined, 'an up-to-date save is a plain save');
  const meta = JSON.parse(readFileSync(join(dir, 'chats', 's_m.meta.json'), 'utf8'));
  // Throw away the history of r1 before revision 2, as if it had aged out.
  meta.messages.r1.changes = meta.messages.r1.changes.filter(([rev]) => rev >= 2);
  writeFileSync(join(dir, 'chats', 's_m.meta.json'), JSON.stringify(meta));
  const third = await put(store, chat([u('u1'), a('r1', 'v1 edited')]), 0);
  assert.equal(third.conflict, true);
  assert.equal((await now(store)).session.messages[1].content, 'v1 edited');
});

test('deletions and additions: what a device deleted stays deleted, what it never saw is kept in place, what someone else deleted is not brought back', async t => {
  const { store } = rig(t);
  const base = await put(store, chat([u('u1'), a('r1'), u('u2'), a('r2')]));
  // Strata adds a message after r1 (in the middle) and deletes r2, from the newest file.
  await store.update('s_m', s => ({ ...s, messages: [s.messages[0], s.messages[1], a('x1', 'added by Strata'), s.messages[2]] }));
  // The device, still at the base, deletes u1 and edits u2; it still has r2.
  const saved = await put(store, chat([a('r1'), u('u2', 'u2 edited'), a('r2')]), base.rev);
  const ids = (await now(store)).session.messages.map(m => m.id);
  assert.deepEqual(ids, ['r1', 'x1', 'u2'], 'u1 deleted by the device, x1 kept after r1, r2 stays deleted');
  assert.equal((await now(store)).session.messages[2].content, 'u2 edited');
  assert.equal(saved.changed, true);
  assert.equal(saved.rev, base.rev, 'the device\'s copy still lacks x1, so its rev stays its base');
  assert.ok(saved.storedRev > base.rev);
  const back = await put(store, chat([a('r1'), u('u2', 'u2 edited'), a('r2')]), base.rev, { returnChat: true });
  assert.deepEqual(back.session.messages.map(m => m.id), ['r1', 'x1', 'u2'], '?return=chat gives the merged chat');
  assert.equal(back.rev, back.storedRev);
});

test('a reply a running turn is writing is never replaced or deleted by a save', async t => {
  const { dir } = rig(t);
  const store = createChatStore({ dir });
  store.setLive((chatId, id) => chatId === 's_m' && id === 'r1');
  const base = await put(store, chat([u('u1'), a('r1', '', { streaming: true })]));
  await store.update('s_m', s => ({ ...s, messages: s.messages.map(m => (m.id === 'r1' ? { ...m, content: 'writing…' } : m)) }));
  await put(store, chat([u('u1')]), base.rev);
  assert.equal((await now(store)).session.messages[1].content, 'writing…');
  await put(store, chat([u('u1'), a('r1', 'mine')]), base.rev);
  assert.equal((await now(store)).session.messages[1].content, 'writing…');
});

test('PATCH: top-level fields only, objects merge, null removes; the read marker alone does not change updatedAt', async t => {
  const { store } = rig(t);
  await put(store, chat([u('u1')], { preferences: { thinking: 'High', offline: false }, pinned: false }));
  const r = await store.patch('s_m', { title: 'New', preferences: { offline: true }, pinned: null });
  const s1 = (await now(store)).session;
  assert.deepEqual([s1.title, s1.preferences, 'pinned' in s1, s1.messages.length], ['New', { thinking: 'High', offline: true }, false, 1]);
  assert.notEqual(s1.updatedAt, '2026-11-09T00:00:00.000Z');
  assert.equal(r.readOnly, false);
  const read = await store.patch('s_m', { lastReadAt: '2026-11-09T05:00:00.000Z' });
  assert.equal(read.readOnly, true);
  assert.equal((await now(store)).session.updatedAt, s1.updatedAt);
  await assert.rejects(store.patch('s_m', { messages: [] }), e => e.code === 'use-messages' && e.status === 400);
  await assert.rejects(store.patch('s_none', { title: 'x' }), e => e.status === 404);
  assert.deepEqual(mergePatch({ a: [1], b: { c: 1, d: 2 } }, { a: [2], b: { d: null, e: 3 } }), { a: [2], b: { c: 1, e: 3 } });
});

test('hashes ignore key order; the side file is removed with the chat', async t => {
  const { store, dir } = rig(t);
  assert.equal(hashOf({ a: 1, b: { c: 2, d: [1, { e: 1, f: 2 }] } }), hashOf({ b: { d: [1, { f: 2, e: 1 }], c: 2 }, a: 1 }));
  assert.equal(canonical({ b: 1, a: undefined }), '{"b":1}');
  await put(store, chat([u('u1')]));
  await store.remove('s_m');
  assert.deepEqual(readdirSync(join(dir, 'chats')).filter(f => f.startsWith('s_m')), []);
});
