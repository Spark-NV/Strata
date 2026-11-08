// Tool calls the model wrote as text (server/agent/text-tool-calls.mjs, through the agent's model proxy in llm-shape.mjs): a guessed
// name for an offered tool becomes a real call of that tool, any other name a call nothing answers but "unknown tool", and text that is
// not a call at the end of the reply passes through unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLlmProxy } from '../server/agent/llm-shape.mjs';
import { createStreamRewriter, matchArgs, parseCalls, resolveName, rewriteCompletion, toolIndex } from '../server/agent/text-tool-calls.mjs';
import { applyProfileToAgentBody, normalizeProfile, DEFAULT_PROFILES } from '../server/profiles.mjs';

const fn = (name, props) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: props } } });
const TOOLS = [
  fn('read', { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }),
  fn('bash', { command: { type: 'string' }, description: { type: 'string' }, timeoutMs: { type: 'number' } }),
  fn('edit', { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }),
  fn('todo_write', { todos: { type: 'array' } }),
];
const index = toolIndex(TOOLS);
const READ_FILE = '<tool_call>\n<function=read_file>\n<parameter=file_path>\n/home/p/src/a.ts\n</parameter>\n<parameter=offset>\n40\n</parameter>\n</function>\n</tool_call>';

test('guessed names and parameter names find the offered tool; an unknown one finds nothing', () => {
  for (const name of ['read', 'read_file', 'file_read', 'ReadFile', 'view_file', 'Read']) assert.equal(resolveName(name, index), 'read', name);
  for (const name of ['run_command', 'shell', 'execute']) assert.equal(resolveName(name, index), 'bash', name);
  assert.equal(resolveName('str_replace', index), 'edit');
  assert.equal(resolveName('skill', index), null);
  assert.equal(resolveName('write_file', index), null, 'an alias of a tool this request does not offer finds nothing');
  assert.deepEqual(matchArgs({ path: '/x', offset: '40' }, index.get('read')), { file_path: '/x', offset: 40 });
  assert.deepEqual(matchArgs({ cmd: 'ls' }, index.get('bash')), { command: 'ls' });
  assert.deepEqual(matchArgs({ todos: '[{"content":"a"}]' }, index.get('todo_write')), { todos: [{ content: 'a' }] });
});

test('both written forms parse; anything else around them is not a call', () => {
  assert.deepEqual(parseCalls(READ_FILE), [{ name: 'read_file', args: { file_path: '/home/p/src/a.ts', offset: '40' } }]);
  assert.deepEqual(parseCalls('<tool_call>{"name": "bash", "arguments": {"command": "ls"}}</tool_call>\n'), [{ name: 'bash', args: { command: 'ls' } }]);
  assert.equal(parseCalls(`${READ_FILE}\nand then I will explain`), null, 'text after the call: a reply that quotes the format');
  assert.equal(parseCalls('<tool_call>\n<function=read>\n<parameter=file_path>\nx'), null, 'cut off');
  assert.equal(parseCalls(`${READ_FILE}\n${READ_FILE}`).length, 2);
});

test('a whole completion: the text call becomes a real one, the words before it stay', () => {
  const obj = { id: 'c', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `Let me look.\n${READ_FILE}` } }] };
  const fixed = rewriteCompletion(obj, index);
  const m = fixed.choices[0].message;
  assert.equal(fixed.choices[0].finish_reason, 'tool_calls');
  assert.equal(m.content, 'Let me look.');
  assert.equal(m.tool_calls[0].function.name, 'read');
  assert.deepEqual(JSON.parse(m.tool_calls[0].function.arguments), { file_path: '/home/p/src/a.ts', offset: 40 });
  const plain = { choices: [{ message: { content: 'No calls here.' } }] };
  assert.equal(rewriteCompletion(plain, index), plain);
});

/** Streams `pieces` (content deltas) through the rewriter as the model server would send them; returns the events that came out. */
function stream(pieces, { finish = 'stop', extraEvents = [] } = {}) {
  let out = '';
  const rw = createStreamRewriter(index, s => { out += s; });
  const ev = obj => `data: ${JSON.stringify(obj)}\n\n`;
  const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm' };
  let wire = ev({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  for (const p of pieces) wire += ev({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
  wire += ev({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  for (const e of extraEvents) wire += ev({ ...base, ...e });
  wire += 'data: [DONE]\n\n';
  // Cut the wire at odd places: the rewriter must not care where network chunks end.
  for (let i = 0; i < wire.length; i += 37) rw.push(wire.slice(i, i + 37));
  rw.end();
  return { out, wire, events: out.split('\n\n').filter(Boolean).map(e => e.replace(/^data: /, '')).filter(e => e !== '[DONE]').map(e => JSON.parse(e)) };
}
const said = events => events.map(e => e.choices?.[0]?.delta?.content ?? '').join('');
const calls = events => events.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? []);
const finishOf = events => events.map(e => e.choices?.[0]?.finish_reason).filter(Boolean);

test('a stream without a text call passes byte for byte', () => {
  const { out, wire } = stream(['Hello ', 'there, <b>bold</b> and a < sign.']);
  assert.equal(out, wire);
});

test('a streamed text call, split across pieces, goes out as a real call of the offered tool', () => {
  const { events } = stream(['I will read it. <to', 'ol_call>\n<function=read_file>\n<parameter=path>\n/home/p/a.ts\n</param', 'eter>\n</function>\n</tool_call>']);
  assert.equal(said(events), 'I will read it. ');
  const [c] = calls(events);
  assert.equal(c.function.name, 'read');
  assert.deepEqual(JSON.parse(c.function.arguments), { file_path: '/home/p/a.ts' });
  assert.deepEqual(finishOf(events), ['tool_calls']);
});

test('a call of a tool this helper does not have runs nothing: it becomes an unknown tool the Harness answers with an error', () => {
  const { events } = stream(['<tool_call>\n<function=skill>\n<parameter=name>\ncode-review\n</parameter>\n</function>\n</tool_call>']);
  const [c] = calls(events);
  assert.equal(c.function.name, 'unavailable_skill');
  assert.deepEqual(finishOf(events), ['tool_calls']);
});

test('a text that only quotes the format, with words after it, is left as text', () => {
  const text = 'The format is <tool_call><function=x></function></tool_call> and that is all.';
  const { events } = stream([text]);
  assert.equal(said(events), text);
  assert.equal(calls(events).length, 0);
  assert.deepEqual(finishOf(events), ['stop']);
});

test('through the proxy: the model server returns the call as text, the Harness receives a real call', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = d => res.write(`data: ${JSON.stringify({ id: 'u', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, ...d }] })}\n\n`);
    ev({ delta: { content: READ_FILE }, finish_reason: null });
    ev({ delta: {}, finish_reason: 'stop' });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const proxy = createLlmProxy({ targetOf: () => `http://127.0.0.1:${upstream.address().port}/v1`, samplingNow: () => null });
  const front = http.createServer((req, res) => { const m = /^\/api\/internal\/agent-llm\/([^/]+)(\/.*)$/.exec(req.url); proxy(req, res, m[1], m[2]); });
  await new Promise(r => front.listen(0, '127.0.0.1', r));
  t.after(() => { front.close(); upstream.close(); });
  const text = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: front.address().port, path: '/api/internal/agent-llm/k/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, res => { let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve(s)); });
    r.on('error', reject); r.end(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'go' }], tools: TOOLS }));
  });
  const events = text.split('\n\n').filter(Boolean).map(e => e.replace(/^data: /, '')).filter(e => e !== '[DONE]').map(e => JSON.parse(e));
  assert.equal(calls(events)[0].function.name, 'read');
  assert.deepEqual(finishOf(events), ['tool_calls']);
  assert.match(text, /\[DONE\]/);
});

test('every Vibe helper keeps send_message, and one without the skill tool is not shown the skill list', () => {
  const p = normalizeProfile('vibe', DEFAULT_PROFILES.vibe);
  const tools = ['bash', 'read', 'write', 'send_message', 'skill', 'subagent'].map(n => fn(n, {}));
  const catalog = '<system-reminder>\nThe following skills are available:\n<available_skills>\n- `code-review`: Reviews code.\n</available_skills>\nUse the skill tool.\n</system-reminder>';
  const body = who => applyProfileToAgentBody({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: `@${who} go` }, { role: 'user', content: catalog }], tools }, p);
  const checker = body('checker'), builder = body('builder');
  const names = b => b.tools.map(t => t.function.name);
  assert.ok(names(checker).includes('send_message'));
  assert.ok(!names(checker).includes('skill') && !names(checker).includes('subagent'));
  assert.match(checker.messages.at(-1).content, /No saved skills are available/);
  assert.ok(names(builder).includes('skill') && names(builder).includes('send_message'));
  assert.match(builder.messages.at(-1).content, /code-review/, 'a builder has the skill tool and keeps the list');
});
