// The phone's lighter paths: the event stream with topics (no 60 KB monitor event every second unless asked), pictures kept by the chat
// that uses them, and the roleplay turn Strata saves (server/rp/routes.mjs prepareRpTurn).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventHub, eventOptions } from '../server/util.mjs';
import { createUploads } from '../server/chat-uploads.mjs';
import { prepareRpTurn } from '../server/rp/routes.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function fakeRes() {
  const out = [], closers = [];
  return { out, writeHead() {}, write(s) { out.push(s); }, on(name, fn) { if (name === 'close') closers.push(fn); }, close() { for (const fn of closers) fn(); } };
}

test('events: no topics sends everything as before; topics send only those; monitor can be thinned', () => {
  const hub = new EventHub();
  const all = fakeRes(), phone = fakeRes(), sheet = fakeRes();
  hub.add(all);
  hub.add(phone, eventOptions(new URLSearchParams('topics=chats,pinned,turns')));
  hub.add(sheet, eventOptions(new URLSearchParams('topics=monitor&monitorEveryMs=60000')));
  hub.send('monitor', { big: 'x'.repeat(100) });
  hub.send('monitor', { big: 'y' });
  hub.send('chats', { id: 's' });
  const names = r => r.out.filter(s => s.startsWith('event:')).map(s => s.split('\n')[0].slice(7));
  assert.deepEqual(names(all), ['monitor', 'monitor', 'chats']);
  assert.deepEqual(names(phone), ['chats']);
  assert.deepEqual(names(sheet), ['monitor'], 'the second monitor within a minute is skipped');
  assert.deepEqual(eventOptions(new URLSearchParams('')), { topics: null, monitorEveryMs: 0 });
  for (const r of [all, phone, sheet]) r.close();
});

test('pictures a saved message names belong to its chat: never swept, served as before, removed with the chat', t => {
  const dir = mkdtempSync(join(tmpdir(), 'strata-keep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const uploads = createUploads({ dir: join(dir, 'uploads'), folderOf: () => dir, attachments: { add() {} }, mediaDir: join(dir, 'media') });
  const [kept] = uploads.accept('s_k', { body: PNG, contentType: 'image/png', name: 'a.png' });
  const [loose] = uploads.accept('s_k', { body: PNG, contentType: 'image/png', name: 'b.png' });
  assert.equal(uploads.keep('s_k', [kept.id, 'nope']), 1);
  const old = new Date(Date.now() - 3 * 24 * 3600_000);
  for (const f of readdirSync(join(dir, 'uploads'))) utimesSync(join(dir, 'uploads', f), old, old);
  uploads.sweep();
  assert.ok(uploads.image(kept.id), 'the kept picture is still there');
  assert.match(uploads.dataUrl(kept.id), /^data:image\/png;base64,/);
  assert.equal(uploads.image(loose.id), null, 'a picture no chat kept is swept after a day');
  uploads.dropChat('s_k');
  assert.equal(uploads.image(kept.id), null);
  assert.equal(existsSync(join(dir, 'media', 's_k')), false);
});

test('roleplay turns Strata saves: a new reply, a swipe, a continue and impersonate, each by 05\'s rules', () => {
  const s = { id: 's_r', rp: { characterIds: ['c1'], vars: {} }, messages: [
    { id: 'g', role: 'assistant', content: 'Hi', characterId: 'c1' }, { id: 'u1', role: 'user', content: 'Yo', name: 'Me' }, { id: 'r1', role: 'assistant', content: 'Old', characterId: 'c1' }] };
  const fresh = prepareRpTurn({ replyId: 'r2', userMessage: { id: 'u2', role: 'user', content: 'Next', name: 'Me' } }, s);
  assert.deepEqual(fresh.session.messages.map(m => m.id), ['g', 'u1', 'r1', 'u2', 'r2']);
  assert.deepEqual(fresh.history.map(m => m.content), ['Hi', 'Yo', 'Old', 'Next'], 'the history ends with the person\'s new message');
  const swipe = prepareRpTurn({ rpTarget: { kind: 'swipe', messageId: 'r1' } }, s);
  assert.deepEqual(swipe.session.messages[2].swipes, ['Old', '']);
  assert.equal(swipe.session.messages[2].swipeIndex, 1);
  assert.deepEqual(swipe.history.map(m => m.id ?? m.content), ['Hi', 'Yo'], 'a swipe\'s history ends before the reply');
  assert.equal(swipe.speakerId, 'c1');
  const more = prepareRpTurn({ rpTarget: { kind: 'continue', messageId: 'r1' } }, s);
  assert.equal(more.base, 'Old');
  assert.equal(more.mode, 'continue');
  assert.throws(() => prepareRpTurn({ rpTarget: { kind: 'continue', messageId: 'g' } }, s), e => e.status === 400);
  assert.equal(prepareRpTurn({ rpTarget: { kind: 'impersonate' } }, s).session, null, 'impersonate saves nothing');
  assert.throws(() => prepareRpTurn({ replyId: 'r1' }, s), e => e.code === 'id-taken');
});
