// What a persisted turn writes (server/turn-record.mjs) must match what the desktop writes: the helper copies give the desktop's results,
// a recorded reply has the desktop's fields, and the history Strata builds from the chat is the one the desktop sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as server from '../server/turn-record.mjs';

async function loadTs(path) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const answer = await loadTs('../src/lib/answer-text.ts');
const deliverables = await loadTs('../src/lib/deliverables.ts');
const agents = await loadTs('../src/lib/agents.ts');
const titles = await loadTs('../src/lib/title-text.ts');
const photos = await loadTs('../src/lib/chat-photos.ts');

test('the helper copies give the desktop\'s results', () => {
  for (const t of ['', 'plain', '<think>x</think>answer', 'p> CEDAR-742', '/p> done', 'a <analysis foo="1">b</analysis> c', '<thin', 'x > y']) assert.equal(server.tidyAnswer(t), answer.tidyAnswer(t), t);
  const raws = [null, {}, { path: 'a/b.html', kind: 'html', status: 'changed', size: '12', lines: 3, added: 2, removed: 1 }, { path: 'x', kind: 'weird', lines: null }];
  for (const r of raws) assert.deepEqual(server.readDeliverable(r), deliverables.readDeliverable(r));
  const groups = [null, { id: 'g1', closed: false, line: 'Writing', files: [{ path: 'a.md' }], live: { label: 'Writing a.md', output: 'one\ntwo' } }, { id: 'g2', closed: true, live: { label: 'x' } }];
  for (const g of groups) assert.deepEqual(server.readGroup(g), deliverables.readGroup(g));
  assert.deepEqual(server.readSkills({ skills: [{ name: 'a', description: 'b' }, { name: '' }, 'x'] }), deliverables.readSkills({ skills: [{ name: 'a', description: 'b' }, { name: '' }, 'x'] }));
  let a = undefined, b = undefined;
  for (const piece of ['Hello', ' <think>', 'world</think>']) { a = server.appendText(a, piece); b = deliverables.appendText(b, piece); }
  assert.deepEqual(a, b);
  const g = deliverables.readGroup(groups[1]);
  assert.deepEqual(server.upsertGroup(a, g), deliverables.upsertGroup(b, g));
  const f1 = deliverables.readDeliverable(raws[2]), f2 = { ...f1, status: 'changed', added: 5 };
  assert.deepEqual(server.mergeDeliverable(server.mergeDeliverable(undefined, f1), f2), deliverables.mergeDeliverable(deliverables.mergeDeliverable(undefined, f1), f2));
  const frames = [{ id: 'h1', name: 'Helper', status: 'working', updatedAt: 1000 }, { id: 'h1', status: 'completed', updatedAt: 3000, tokens: 9 }, { id: '' }];
  let sa = [], da = [];
  for (const f of frames) { sa = server.updateAgent(sa, f, 5000); da = agents.updateAgent(da, f, 5000); }
  assert.deepEqual(sa, da);
  for (const t of ['short', 'x'.repeat(48), 'y'.repeat(60), `${'z'.repeat(45)}👨‍👩‍👧‍👦 family`]) assert.equal(server.shortTitle(t), titles.shortTitle(t), t);
  const msgs = [{ photos: [{}, {}] }, {}, { photos: [{}] }];
  for (const n of [0, 1, 3]) assert.deepEqual([...server.photoHistorySlots(msgs, n)], [...photos.photoHistorySlots(msgs, n)]);
});

test('the history Strata builds is the desktop\'s: no Time-skip, local or empty messages, the last 40, pictures named when not sent', () => {
  const messages = [
    { id: 'a', role: 'user', content: 'first' },
    { id: 'b', role: 'assistant', content: 'reply' },
    { id: 'c', role: 'assistant', content: '   ' },
    { id: 'd', role: 'assistant', content: 'trial', timeSkipId: 't1' },
    { id: 'e', role: 'user', content: 'note', local: true },
    { id: 'f', role: 'system', content: 'sys' },
    { id: 'g', role: 'user', content: 'look', iosPhotos: [{ uploadId: 'u1', name: 'IMG_1.jpg' }] },
  ];
  assert.deepEqual(server.chatHistory(messages), [
    { role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' },
    { role: 'user', content: "look\n[Earlier pictures: IMG_1.jpg. Their pixels are outside this model's image context; ask to reattach them if needed.]" },
  ]);
  const seen = server.chatHistory(messages, { canSeePictures: true, pictureData: id => (id === 'u1' ? 'data:image/jpeg;base64,AAAA' : null) });
  assert.deepEqual(seen.at(-1), { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] });
  const long = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `t${i}` }));
  assert.equal(server.chatHistory(long).length, 40);
  assert.equal(server.chatHistory(long)[0].content, 't10');
  // A picture only on the desktop (no upload id yet) is named, never sent.
  assert.match(server.chatHistory([{ role: 'user', content: 'x', photos: [{ id: 'p', name: 'desk.png' }] }], { canSeePictures: true, pictureData: () => 'data:x' })[0].content, /Earlier pictures: desk\.png/);
  assert.deepEqual(server.rpHistory([{ role: 'user', content: 'hi', name: 'Me', at: 'T', local: false }, { role: 'assistant', content: 'n', local: true }, { role: 'system', content: 's' }]),
    [{ role: 'user', content: 'hi', characterId: undefined, name: 'Me', hidden: undefined, at: 'T' }]);
});

test('a recorded Code reply has what the desktop saves: text, reasoning, tools, files, activity, stats; nothing left streaming', () => {
  const rec = server.createChatRecorder({ replyId: 'r1' });
  const frames = [
    { type: 'queued', requestId: 'req-1' },
    { type: 'start', model: 'Qwen', contextMax: 260000, agent: true, skills: ['s'] },
    { type: 'reasoning', text: 'Let me ' }, { type: 'reasoning', text: 'think' },
    { type: 'delta', text: 'Reading ' },
    { type: 'activity-group', group: undefined, id: 'g1', closed: false, line: 'Read hello.py', files: [] },
    { type: 'agent-tool', tool: { id: 't1', name: 'read', state: 'running' } },
    { type: 'agent-tool', tool: { id: 't1', state: 'done', result: 'ok' } },
    { type: 'deliverable', path: 'hello.py', kind: 'code', status: 'changed', added: 1 },
    { type: 'delta', text: 'done.' },
    { type: 'agent', agent: { id: 'h1', name: 'Explorer', status: 'completed', updatedAt: 1 } },
    { type: 'done', tokensIn: 100, tokensOut: 20, durationMs: 900, ttftMs: 50, usageSource: 'reported', tps: 80 },
  ];
  for (const f of frames) rec.apply(f);
  const chat = rec.into({ id: 's', tokensIn: 5, tokensOut: 1, messages: [{ id: 'u', role: 'user', content: 'go' }, { id: 'r1', role: 'assistant', content: '', streaming: true }] }, { end: { state: 'done' } });
  const reply = chat.messages[1];
  assert.equal(reply.content, 'Reading done.');
  assert.equal(reply.reasoning, 'Let me think');
  assert.equal(reply.requestId, 'req-1');
  assert.equal(reply.model, 'Qwen');
  assert.equal(reply.streaming, false);
  assert.deepEqual(reply.tools, [{ id: 't1', name: 'read', state: 'done', result: 'ok', live: true }]);
  assert.equal(reply.deliverables[0].path, 'hello.py');
  assert.deepEqual(reply.blocks.map(b => b.kind), ['text', 'group', 'text']);
  assert.deepEqual([reply.tokens, reply.inputTokens, reply.usageSource, reply.durationMs, reply.ttftMs], [20, 100, 'reported', 900, 50]);
  assert.deepEqual([chat.tokensIn, chat.tokensOut], [105, 21]);
  assert.equal(chat.agents[0].name, 'Explorer');
});

test('a reply cut off by a lost connection is closed with the reason; roleplay swipes and continues land in the target reply; pictures never keep the preview', () => {
  const rec = server.createChatRecorder({ replyId: 'r' });
  rec.apply({ type: 'delta', text: 'half' });
  const cut = rec.into({ id: 's', messages: [{ id: 'r', role: 'assistant', content: '', streaming: true }] }, { end: { state: 'stopped', error: 'lost', code: 'connection-lost' } });
  assert.deepEqual([cut.messages[0].content, cut.messages[0].streaming, cut.messages[0].error, cut.messages[0].errorCode], ['half', false, 'lost', 'connection-lost']);

  const swipe = server.createRpRecorder({ replyId: 'x', target: { kind: 'swipe', messageId: 'r' } });
  for (const f of [{ type: 'rp-speaker', id: 'c1', name: 'Mira' }, { type: 'delta', text: ' New' }, { type: 'rp-final', content: 'New version', vars: { mood: 'ok' } }]) swipe.apply(f);
  const rpChat = swipe.into({ id: 's', rp: { vars: {} }, messages: [{ id: 'r', role: 'assistant', content: '', swipes: ['Old', ''], swipeReasoning: ['', ''], swipeIndex: 1, streaming: true }] }, { end: { state: 'done' } });
  assert.deepEqual(rpChat.messages[0].swipes, ['Old', 'New version']);
  assert.equal(rpChat.messages[0].content, 'New version');
  assert.equal(rpChat.messages[0].characterId, 'c1');
  assert.deepEqual(rpChat.rp.vars, { mood: 'ok' });

  const more = server.createRpRecorder({ replyId: 'x', target: { kind: 'continue', messageId: 'r' }, base: 'She smiled' });
  more.apply({ type: 'rp-final', content: 'and left.' });
  assert.equal(more.into({ id: 's', messages: [{ id: 'r', role: 'assistant', content: 'She smiled' }] }, { end: { state: 'done' } }).messages[0].content, 'She smiled and left.');
  assert.equal(server.createRpRecorder({ replyId: null, target: { kind: 'impersonate' } }).into({ id: 's', messages: [] }), null, 'impersonate saves nothing');

  const img = server.createImageRecorder({ replyId: 'r', size: { width: 512, height: 512 } });
  for (const f of [{ type: 'phase', phase: 'loading' }, { type: 'progress', step: 3, steps: 8, preview: 'data:image/png;base64,BIG' }, { type: 'image', file: 'abc.png', seed: 7 }, { type: 'done', seconds: 4 }]) img.apply(f);
  const pic = img.into({ id: 's', messages: [{ id: 'r', role: 'assistant', content: '', streaming: true, image: { phase: 'waiting', preview: null } }] }).messages[0];
  assert.equal(pic.image.preview, null);
  assert.equal(pic.image.phase, 'done');
  assert.deepEqual(pic.media, [{ kind: 'image', src: '/api/images/file/abc.png', title: '512×512 · seed 7' }]);
  assert.equal(pic.streaming, false);
});
