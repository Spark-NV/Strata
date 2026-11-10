// Phases 2 and 3 for weak connections: message edits without sending the whole chat, a chat list that sends only what changed, long chats
// in pages, uploads that are safe to send again, and gzip request bodies (server/chat-store.mjs, upload-keys.mjs, util.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStore } from '../server/chat-store.mjs';
import { createUploadKeys } from '../server/upload-keys.mjs';
import { readBody, readRaw } from '../server/util.mjs';

const store = t => { const dir = mkdtempSync(join(tmpdir(), 'strata-p3-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return createChatStore({ dir }); };
const msg = (id, content, role = 'user') => ({ id, role, content });
const chat = (id, messages, extra = {}) => JSON.stringify({ id, title: 'T', messages, ...extra });
const ids = async (s, id) => JSON.parse(await s.read(id)).session.messages.map(m => m.id);

test('messages: upsert replaces in place or adds (after a message, else at the end), remove deletes, the same request twice changes nothing', async t => {
  const s = store(t);
  await s.save('s_m', chat('s_m', [msg('m_1', 'a'), msg('m_2', 'b', 'assistant'), msg('m_3', 'c')]));
  const r1 = await s.messages('s_m', { upsert: [{ ...msg('m_2', 'edited', 'assistant'), swipes: ['b', 'edited'], swipeIndex: 1 }, msg('m_9', 'new')], remove: ['m_3', 'm_unknown'], after: 'm_1' });
  assert.deepEqual(await ids(s, 's_m'), ['m_1', 'm_9', 'm_2']);
  assert.equal(JSON.parse(await s.read('s_m')).session.messages[2].content, 'edited');
  const again = await s.messages('s_m', { upsert: [{ ...msg('m_2', 'edited', 'assistant'), swipes: ['b', 'edited'], swipeIndex: 1 }, msg('m_9', 'new')], remove: ['m_3'], after: 'm_1' });
  assert.equal(again.rev, r1.rev, 'repeated: nothing new');
  assert.equal(again.unchanged, true);
  await s.messages('s_m', { upsert: [msg('m_10', 'end')] });
  assert.deepEqual(await ids(s, 's_m'), ['m_1', 'm_9', 'm_2', 'm_10']);
  await assert.rejects(s.messages('s_m', { upsert: [{ content: 'no id' }] }), e => e.status === 400);
  await assert.rejects(s.messages('s_m', { upsert: [msg('m_1', 'x')], remove: ['m_1'] }), e => e.code === 'bad-messages');
  s.setLive((c, m) => m === 'm_2');
  await assert.rejects(s.messages('s_m', { remove: ['m_2'] }), e => e.status === 409 && e.code === 'turn-running');
  await assert.rejects(s.messages('s_nope', { remove: ['m_1'] }), e => e.status === 404);
});

test('chat list: kind, flags, count and the last words per chat; only what changed since a cursor; an unknown cursor gets everything', async t => {
  const s = store(t);
  await s.save('s_a', chat('s_a', [msg('m_1', 'hello'), msg('m_2', '  The answer is here.  ', 'assistant'), { id: 'm_3', role: 'assistant', content: '' }], { profile: 'vibe', pinned: true, lastReadAt: '2026-11-10T00:00:00.000Z' }));
  await s.save('s_b', chat('s_b', []));
  const all = s.list();
  const a = all.chats.find(c => c.id === 's_a');
  assert.deepEqual([a.profile, a.pinned, a.archived, a.lastReadAt, a.messages, a.preview], ['vibe', true, false, '2026-11-10T00:00:00.000Z', 3, { role: 'assistant', text: 'The answer is here.' }]);
  assert.equal(all.chats.find(c => c.id === 's_b').profile, undefined, 'no profile: a Chat chat');
  assert.equal(all.chats.find(c => c.id === 's_b').preview, null);
  const cursor = all.cursor;
  assert.deepEqual(s.changes(cursor), { v: 1, cursor, changed: [], deleted: [], full: false }, 'nothing changed');
  await s.patch('s_b', { title: 'B' });
  await s.remove('s_a');
  const d = s.changes(cursor);
  assert.deepEqual([d.changed.map(c => c.id), d.deleted, d.full], [['s_b'], ['s_a'], false]);
  assert.deepEqual(s.changes(d.cursor).changed, []);
  const stale = s.changes('c_other_3');
  assert.deepEqual([stale.full, stale.changed.map(c => c.id)], [true, ['s_b']]);
  assert.equal(s.changes(null).full, true);
});

test('long chats in pages: the last N with the total; older ones before a message; a paged copy can never be saved whole', async t => {
  const s = store(t);
  const list = Array.from({ length: 120 }, (_, i) => msg(`m_${i}`, `n${i}`));
  await s.save('s_l', chat('s_l', list));
  const last = await s.page('s_l', { last: 50 });
  assert.deepEqual([last.messagesTotal, last.messagesFrom, last.session.messages.length, last.session.messages[0].id], [120, 70, 50, 'm_70']);
  assert.deepEqual(last.session.partial, { messagesFrom: 70, messagesTotal: 120 });
  const older = await s.page('s_l', { before: 'm_70', limit: 50 });
  assert.deepEqual([older.messages[0].id, older.messages.at(-1).id, older.messagesFrom, older.more], ['m_20', 'm_69', 20, true]);
  const first = await s.page('s_l', { before: 'm_20', limit: 50 });
  assert.deepEqual([first.messages.length, first.more], [20, false]);
  const whole = await s.page('s_l', { last: 500 });
  assert.equal(whole.session.partial, undefined, 'every message there: not partial');
  await assert.rejects(s.save('s_l', JSON.stringify(last.session), { baseRev: last.rev }), e => e.code === 'partial-chat');
  assert.equal((await ids(s, 's_l')).length, 120);
  await assert.rejects(s.page('s_l', { before: 'm_nope' }), e => e.status === 404);
});

test('upload keys: the same bytes and key give the same answer for 24 hours; a key that does not match the bytes is refused', () => {
  let clock = 0;
  const keys = createUploadKeys({ now: () => clock });
  const bytes = Buffer.from('picture');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const req = key => ({ headers: key === undefined ? {} : { 'x-strata-upload-key': key } });
  assert.equal(keys.keyOf(req(undefined), bytes), null);
  assert.equal(keys.keyOf(req(sha.toUpperCase()), bytes), sha);
  assert.throws(() => keys.keyOf(req('0'.repeat(64)), bytes), e => e.status === 400 && e.code === 'bad-upload-key');
  keys.set('ref', sha, 'abc.png');
  assert.equal(keys.get('ref', sha), 'abc.png');
  assert.equal(keys.get('ref', sha, () => false), null, 'gone from the disk: stored again');
  assert.equal(keys.get('upload:s_x', sha), null, 'per place');
  clock += 25 * 3600_000;
  assert.equal(keys.get('ref', sha), null);
});

test('gzip request bodies are unpacked (JSON and raw), with the size limit on the unpacked bytes', async () => {
  const body = (bytes, headers = {}) => Object.assign(Readable.from([bytes]), { headers });
  const json = { id: 's_z', messages: Array.from({ length: 100 }, (_, i) => ({ id: `m_${i}`, content: 'same text '.repeat(20) })) };
  const packed = gzipSync(JSON.stringify(json));
  assert.deepEqual(await readBody(body(packed, { 'content-encoding': 'gzip' })), json);
  assert.equal((await readRaw(body(packed, { 'content-encoding': 'gzip' }))).toString(), JSON.stringify(json));
  assert.equal((await readRaw(body(Buffer.from('plain')))).toString(), 'plain', 'without the header: as before');
  await assert.rejects(readBody(body(packed, { 'content-encoding': 'gzip' }), 1000), /too large/);
  await assert.rejects(readBody(body(Buffer.from('not gzip'), { 'content-encoding': 'gzip' })), e => e.code === 'bad-gzip');
});
