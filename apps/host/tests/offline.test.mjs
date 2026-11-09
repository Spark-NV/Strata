// Offline chats (a Chat or Roleplay chat's switch, preferences.offline): no tool that reaches the web is offered or allowed, helpers
// included, and a model on the internet is refused; the turn runs on the chat-offline profile (server/profiles.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFFLINE_PROMPT, OFFLINE_REFUSAL, ROUTE_PROFILE_IDS, applyProfileToAgentBody, createProfileStore, isWebTool, normalizeProfile, offlineProfile, policyReader, toolAllowed, turnProfileId } from '../server/profiles.mjs';
import { createRpRoutes } from '../server/rp/routes.mjs';
import { createRpStore } from '../server/rp/store.mjs';

const chat = normalizeProfile('chat', {});
const off = offlineProfile(chat);

test('the offline profile has no web: search, fetch and connected tools are refused, everything else is as in Chat', () => {
  for (const name of ['web_search', 'web_fetch', 'mcp__browser__browser_navigate', 'mcp__strata-commands__x']) {
    assert.equal(toolAllowed(chat, name) || name.startsWith('mcp__'), true, `${name} is a Chat tool or a connected one`);
    assert.equal(toolAllowed(off, name), false, `${name} is refused offline`);
    assert.equal(isWebTool(name), true);
  }
  for (const name of ['todo_write', 'skill', 'ask_user_question', 'subagent', 'mcp__memory__recall', 'mcp__memory__remember']) assert.equal(toolAllowed(off, name), toolAllowed(chat, name), name);
  assert.equal(toolAllowed(off, 'bash'), false, 'Chat never had a shell');
  assert.equal(isWebTool('mcp__memory__recall'), false, 'memory stays on this computer');
  assert.equal(off.id, 'chat-offline');
  assert.equal(off.offline, true);
  assert.ok(off.systemPrompt.endsWith(OFFLINE_PROMPT));
  assert.ok(chat.agents.some(a => a.name === 'researcher'));
  assert.ok(!off.agents.some(a => a.name === 'researcher'), 'the web researcher is not offered');
  assert.deepEqual(off.agents, [], 'Chat has only the researcher')
});

test('an offline request offers the model no web tool and tells it it is offline', () => {
  const body = { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }],
    tools: ['web_search', 'web_fetch', 'todo_write', 'mcp__browser__browser_click'].map(name => ({ type: 'function', function: { name } })) };
  const shaped = applyProfileToAgentBody(body, off);
  assert.deepEqual(shaped.tools.map(t => t.function.name), ['todo_write']);
  assert.match(shaped.messages[0].content, /offline: you have no internet access/);
});

test('which profile a turn runs on: Chat offline gets its own, the others are unchanged', () => {
  assert.equal(turnProfileId('chat', true), 'chat-offline');
  assert.equal(turnProfileId(undefined, true), 'chat-offline', 'a chat from before profiles is a Chat');
  assert.equal(turnProfileId('chat', false), 'chat');
  assert.equal(turnProfileId('code', true), 'code', 'Code and Vibe have no offline switch');
  assert.equal(turnProfileId('nonsense', false), null);
  assert.ok(ROUTE_PROFILE_IDS.includes('chat-offline'));
});

test('the gate knows an offline chat: its sessions (and their helpers) get the offline profile, and it follows a changed Chat profile', async () => {
  const store = createProfileStore({ dataDir: mkdtempSync(join(tmpdir(), 'strata-offline-')) });
  store.bindSession('s-off', 'chat-offline');
  store.bindSession('s-on', 'chat');
  const read = policyReader(store.policyFile);
  assert.equal(read('s-off')?.offline, true);
  assert.equal(read('s-on')?.offline, undefined);
  store.save('chat', { ...store.get('chat'), systemPrompt: 'MINE' });
  assert.ok(store.resolve('chat-offline').systemPrompt.startsWith('MINE'), 'the offline copy is the saved Chat profile');
  assert.equal(store.resolve('rp-offline'), null);

  const { apply } = await import('../server/agent/plugins/strata-gate.mjs');
  let handler;
  const parent = { id: 's-off', header: { origin: 'user' } };
  const helper = { id: 'h1', header: { origin: 'subagent', parentSession: 's-off' }, append: () => {} };
  const online = { id: 's-on', header: { origin: 'user' } };
  apply({ on: (_e, h) => { handler = h; }, inject: () => {}, sessions: new Map([['s-off', parent], ['h1', helper], ['s-on', online]]),
    permissionPresets: { current: () => 'strata-bypass' }, approval: { overrideOf: () => 'never' } }, { policyFile: store.policyFile, web: { skipAsk: true } });
  const passed = [];
  const next = async () => { passed.push(1); return { kind: 'allow' }; };
  for (const session of [parent, helper]) {
    const r = await handler({ name: 'web_fetch', arguments: { url: 'https://example.com' }, agent: { session } }, next);
    assert.deepEqual(r, { kind: 'deny', reason: OFFLINE_REFUSAL }, `${session.id} is refused the web`);
  }
  assert.equal(passed.length, 0, 'nothing ran');
  const r = await handler({ name: 'todo_write', arguments: {}, agent: { session: parent } }, next);
  assert.notEqual(r?.kind, 'deny', 'other tools still work offline');
  const shell = await handler({ name: 'bash', arguments: { command: 'curl x' }, agent: { session: parent } }, next);
  assert.equal(shell.kind, 'deny');
  assert.notEqual(shell.reason, OFFLINE_REFUSAL, 'a tool Chat never had says so, not "offline"');
});

test('roleplay offline: a model on the internet is refused, one on this computer answers', async t => {
  const rp = createRpStore({ dataDir: mkdtempSync(join(tmpdir(), 'strata-rp-off-')) });
  const c = rp.characters.save({ name: 'Mira', firstMessage: 'Hi.' });
  const connections = {
    cloud: { id: 'cloud', name: 'Cloud', baseUrl: 'https://api.example.com/v1', models: [{ id: 'm', name: 'Big cloud model', contextMax: 8192 }] },
    here: { id: 'here', name: 'Here', baseUrl: 'http://127.0.0.1:8082/v1', models: [{ id: 'm', name: 'Local', contextMax: 8192 }] },
  };
  const modelProviders = {
    resolve: s => ({ connection: connections[s.connectionId], model: connections[s.connectionId].models[0] }),
    stream: async ({ onFrame }) => { onFrame({ type: 'delta', text: 'Hello there.' }); },
  };
  const profileStore = createProfileStore({ dataDir: mkdtempSync(join(tmpdir(), 'strata-rp-prof-')) });
  const routes = createRpRoutes({ rp, modelProviders, pinned: null, profileStore, profileSampling: () => ({}) });
  const server = http.createServer((req, res) => { const url = new URL(req.url, 'http://x'); void routes(req, res, url.pathname, req.method, url); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const send = connectionId => fetch(`http://127.0.0.1:${server.address().port}/api/rp/generate`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat: { characterIds: [c.id] }, history: [{ role: 'user', content: 'hi' }], remoteModel: { connectionId, modelId: 'm' }, offline: true }) });
  const refused = await send('cloud');
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /offline, and its model \(Big cloud model\) runs on the internet/);
  const ok = await send('here');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /"rp-final".*Hello there\./);
});
