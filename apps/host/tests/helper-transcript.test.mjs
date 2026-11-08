// A helper's conversation for "View conversation" (server/agent/helper-transcript.mjs): read from the Harness's saved session file
// only, the talk kept and the work left out, new lines from `after`, and no helper of another chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { HelperTranscripts, decodeFrames, project } from '../server/agent/helper-transcript.mjs';

const HEAD = 'session-head';
const HELPER = '11111111-2222-3333-4444-555555555555';
const user = (seq, text, source = { kind: 'user' }) => ({ type: 'user/message', seq, time: 1000 + seq, data: { source, content: [{ type: 'text', text }] } });
const said = (seq, parts) => ({ type: 'assistant/message', seq, time: 1000 + seq, data: { message: { role: 'assistant', content: parts } } });
const call = (name, args) => ({ type: 'tool-call', id: `c-${name}`, name, arguments: JSON.stringify(args) });

const rows = [
  { type: 'session', version: 4, id: HELPER, parentSession: HEAD, delegationDepth: 1 },
  { type: 'subagent/descriptor', seq: 0, time: 1000, data: { label: 'Dragon flight layer' } },
  { type: 'turn/start', seq: 1, time: 1001, data: {} },
  user(2, 'Current runtime context.', { kind: 'runtime-context' }),
  user(3, '@builder make dragons fly'),
  said(4, [{ type: 'reasoning', text: 'Where is the scene?' }, { type: 'text', text: 'Reading the brief first.' }, call('bash', { command: 'cat BRIEF.md', description: 'Read the brief' }), call('read', { path: 'a.ts' })]),
  { type: 'tool/result', seq: 5, time: 1005, data: { message: { content: [{ type: 'text', text: 'lots of file text' }] } } },
  said(6, [call('write', { path: 'src/dragon.ts', content: 'export const x = 1;' }), call('edit', { path: 'b.ts' })]),
  user(7, `Agent ${HEAD} sent a message: Skip the skill step.`, { kind: 'agent-message', senderSessionId: HEAD }),
  user(8, 'background job bash-1 finished', { kind: 'tool-jobs' }),
  said(9, [call('vibe_review', { verdict: 'fail', findings: ['dragon.ts: no bank'], checked: 'npm test' }), { type: 'text', text: 'Done: dragons fly, tests pass.' }]),
  { type: 'turn/end', seq: 10, time: 1010, data: {} },
];

test('a helper conversation keeps the talk and one line per command, and leaves edits, output and notices out', () => {
  const r = project(rows, { id: HELPER, parentSessionId: HEAD });
  assert.equal(r.name, 'Dragon flight layer');
  assert.equal(r.running, false);
  assert.equal(r.last, 10);
  assert.deepEqual(r.items.map(i => i.kind), ['task', 'thinking', 'says', 'step', 'from-head', 'review', 'report']);
  assert.equal(r.items[0].text, '@builder make dragons fly');
  assert.equal(r.items[3].text, 'Read the brief');
  assert.equal(r.items[4].text, 'Skip the skill step.');
  assert.match(r.items[5].text, /\*\*fail\*\*[\s\S]*dragon\.ts: no bank/);
  assert.equal(r.items[6].text, 'Done: dragons fly, tests pass.');
  const all = JSON.stringify(r.items);
  for (const hidden of ['export const x', 'lots of file text', 'runtime context', 'background job', 'src/dragon.ts']) assert.ok(!all.includes(hidden), hidden);
});

test('after gives only the new lines, and a working helper is running', () => {
  const r = project(rows.slice(0, 6), { id: HELPER, parentSessionId: HEAD, after: 3 });
  assert.equal(r.running, true);
  assert.deepEqual(r.items.map(i => i.kind), ['thinking', 'says', 'step']);
});

test('the reader finds the saved file, reads it again only when it changed, and refuses a helper of another chat', () => {
  const home = mkdtempSync(join(tmpdir(), 'strata-helper-'));
  try {
    const dir = join(home, 'sessions', '--home-spark-proj--', HELPER);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(file, zstdCompressSync(Buffer.from(rows.slice(0, 6).map(r => JSON.stringify(r)).join('\n') + '\n')));
    const t = new HelperTranscripts({ home });
    const first = t.read({ parentSessionId: HEAD, helperId: HELPER });
    assert.equal(first.running, true);
    assert.equal(first.last, 4);
    // The Harness appends a second frame while the helper works.
    writeFileSync(file, Buffer.concat([zstdCompressSync(Buffer.from(rows.slice(0, 6).map(r => JSON.stringify(r)).join('\n') + '\n')), zstdCompressSync(Buffer.from(rows.slice(6).map(r => JSON.stringify(r)).join('\n') + '\n'))]));
    const next = t.read({ parentSessionId: HEAD, helperId: HELPER, after: first.last });
    assert.deepEqual(next.items.map(i => i.kind), ['from-head', 'review', 'report']);
    assert.equal(next.running, false);
    assert.throws(() => t.read({ parentSessionId: 'session-other', helperId: HELPER }), /not part of this chat/);
    assert.throws(() => t.read({ parentSessionId: HEAD, helperId: '../../etc' }), /not known/);
    assert.throws(() => t.read({ parentSessionId: HEAD, helperId: 'missing-helper' }), /no saved conversation/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a file of many zstd frames decodes whole (Node 24 reads only the first by itself), and a half-written last frame is left out', () => {
  const parts = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n'].map(t => zstdCompressSync(Buffer.from(t)));
  assert.equal(decodeFrames(Buffer.concat(parts)).toString(), '{"a":1}\n{"b":2}\n{"c":3}\n');
  const cut = Buffer.concat([parts[0], parts[1], parts[2].subarray(0, parts[2].length - 3)]);
  assert.equal(decodeFrames(cut).toString(), '{"a":1}\n{"b":2}\n');
  const big = zstdCompressSync(Buffer.from('x'.repeat(300_000) + '\n'));
  assert.equal(decodeFrames(Buffer.concat([big, parts[0]])).length, 300_001 + 8, 'a frame of many blocks');
});
