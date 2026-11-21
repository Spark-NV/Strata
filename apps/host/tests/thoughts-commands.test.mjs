/** Chat activity settings: the model's thinking in a side panel, and activity lines that open to each command. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { ActivityGroups } from '../server/agent/deliverables.mjs';
import * as server from '../server/turn-record.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
async function lib(file) {
  const built = await build({ entryPoints: [fileURLToPath(new URL(`../${file}`, import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.json': 'json' }, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}

test('the host sends the tool ids of each activity line, in the order they ran, and denied calls are left out', () => {
  const out = [];
  const g = new ActivityGroups({ emit: f => out.push(f) });
  g.card({ id: 'a', name: 'bash', state: 'done' });
  g.card({ id: 'b', name: 'bash', state: 'denied' });
  g.card({ id: 'c', name: 'read', state: 'done' });
  g.text();
  g.card({ id: 'd', name: 'bash', state: 'error' });
  g.end();
  const closed = out.filter(f => f.closed);
  assert.deepEqual(closed.map(f => f.toolIds), [['a', 'c'], ['d']]);
});

test('both readers keep the tool ids the same way, and a line without them reads as before', async () => {
  const D = await lib('src/lib/deliverables.ts');
  const frame = { id: 'g1', closed: true, line: 'Ran 2 commands', files: [], toolIds: ['a', 7, '', 'b'] };
  assert.deepEqual(D.readGroup(frame).toolIds, ['a', 'b']);
  assert.deepEqual(server.readGroup(frame), D.readGroup(frame));
  assert.equal('toolIds' in D.readGroup({ id: 'g2', closed: true, line: 'Ran a command', files: [] }), false);
});

test('groupTools, stepText and stepOutput pick the line\'s steps and show the command', async () => {
  const T = await lib('src/lib/thoughts.ts');
  const tools = [
    { id: 'a', name: 'bash', scope: 'shell', args: { command: ' ls -la ' }, preview: 'ls', effect: '', state: 'done', result: 'x\n' },
    { id: 'b', name: 'read', scope: 'read', args: {}, target: 'src/a.ts', preview: 'read', effect: '', state: 'done' },
  ];
  assert.deepEqual(T.groupTools(['b', 'zz', 'a'], tools).map(t => t.id), ['b', 'a']);
  assert.deepEqual(T.groupTools(undefined, tools), []);
  assert.equal(T.stepText(tools[0]), 'ls -la');
  assert.equal(T.stepText(tools[1]), 'src/a.ts');
  assert.equal(T.stepOutput(tools[0]), 'x');
  assert.equal(T.stepOutput({ ...tools[0], result: 'y'.repeat(20) }, 5), 'yyyyy\n…');
});

test('the panel shows the newest reply that thinks, and the setting has three choices', async () => {
  const T = await lib('src/lib/thoughts.ts');
  const msgs = [
    { id: '1', role: 'assistant', content: 'a', reasoning: 'old', at: '' },
    { id: '2', role: 'user', content: 'q', at: '' },
    { id: '3', role: 'assistant', content: 'b', at: '' },
  ];
  assert.equal(T.thoughtsReply(msgs).id, '1');
  assert.equal(T.thoughtsReply([...msgs, { id: '4', role: 'assistant', content: '', streaming: true, at: '' }]).id, '4');
  assert.equal(T.thoughtsReply([]), null);
  assert.ok(T.validThoughtsView('panel') && T.validThoughtsView('hidden') && !T.validThoughtsView('side'));
});

test('the UI wires the settings, the panel tab and the opened steps', () => {
  const settings = read('src/screens/Settings.tsx'), chat = read('src/screens/Chat.tsx'), store = read('src/lib/store.ts'), act = read('src/components/Deliverables.tsx');
  assert.match(settings, /'Chat activity'/);
  assert.match(settings, /setThoughtsView\(value as ThoughtsView\)/);
  assert.match(settings, /setCommandDetails\(!prefs\.commandDetails\)/);
  assert.match(store, /thoughtsView: validThoughtsView\(parsed\.thoughtsView\) \? parsed\.thoughtsView : 'inline'/);
  assert.match(store, /commandDetails: parsed\.commandDetails !== false/);
  assert.match(chat, /m\.reasoning && thoughtsView === 'inline' \? <ReasoningBlock/);
  assert.match(chat, /<ThoughtsPanel session=\{session\}/);
  assert.match(chat, /steps=\{commandDetails \? groupTools\(b\.toolIds, m\.tools\) : undefined\}/);
  assert.match(act, /disabled=\{!canOpen\}/);
  assert.match(act, /<StepRow key=\{t\.id\} tool=\{t\}\/>/);
});
