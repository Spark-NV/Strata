// The chat profiles (server/profiles.mjs): what a profile lets through, how an agent request is reshaped, and the gate's policy file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROFILES, applyProfileToAgentBody, createProfileStore, filterSkillCatalog, normalizeProfile, policyReader, skillAllowed, toolAllowed } from '../server/profiles.mjs';

const code = normalizeProfile('code', {
  skills: { all: false, allow: ['docx', 'pdf', 'xlsx'] }, tools: { groups: { search: false }, connected: false },
  sampling: { temperature: 0.7, top_k: 20 }, systemPrompt: 'CODE RULES', promptPlacement: 'add', agents: [],
});

test('a profile allows its tool groups, refuses the others, and keeps the Harness internals', () => {
  assert.equal(toolAllowed(code, 'bash'), true);
  assert.equal(toolAllowed(code, 'web_search'), false);
  assert.equal(toolAllowed(code, 'web_fetch'), true);
  assert.equal(toolAllowed(code, 'mcp__browser__browser_click'), false, 'connected tools follow their own switch');
  assert.equal(toolAllowed(code, 'working_directory'), true);
  const rp = normalizeProfile('rp', {});
  assert.equal(toolAllowed(rp, 'read'), false, 'a profile with tools off allows none');
  assert.equal(skillAllowed(rp, 'pdf'), false);
});

test('a skill allow-list trims the catalog the model sees', () => {
  assert.equal(skillAllowed(code, 'pdf'), true);
  assert.equal(skillAllowed(code, 'frontend-design'), false);
  const catalog = '<available_skills>\n- `pdf`: PDFs\n- `frontend-design`: UI\n- `docx`: Word\n</available_skills>';
  assert.equal(filterSkillCatalog(catalog, code), '<available_skills>\n- `pdf`: PDFs\n- `docx`: Word\n</available_skills>');
});

test('an agent request gets the prompt, sampling and tool list of its profile', () => {
  const body = applyProfileToAgentBody({
    messages: [{ role: 'system', content: 'HARNESS' }, { role: 'user', content: '<available_skills>\n- `frontend-design`: UI\n</available_skills>' }],
    tools: [{ type: 'function', function: { name: 'web_search' } }, { type: 'function', function: { name: 'bash' } }],
  }, code);
  assert.equal(body.messages[0].content, 'HARNESS\n\nCODE RULES');
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_k, 20);
  assert.deepEqual(body.tools.map(t => t.function.name), ['bash']);
  assert.equal(body.messages[1].content.includes('frontend-design'), false);
  const replaced = applyProfileToAgentBody({ messages: [{ role: 'system', content: 'HARNESS' }] }, { ...code, promptPlacement: 'replace' });
  assert.equal(replaced.messages[0].content, 'CODE RULES');
});

test('bad input takes the defaults, numbers are clamped', () => {
  const p = normalizeProfile('chat', { effort: 'Max', mode: 'yolo', sampling: { temperature: 9, top_k: 'x' }, thinkingBudget: -5 });
  assert.equal(p.effort, 'High');
  assert.equal(p.mode, 'manual');
  assert.equal(p.sampling.temperature, 2);
  assert.equal(p.sampling.top_k, null);
  assert.equal(p.thinkingBudget, 0);
});

test('the store saves profiles and tells the gate which session is in which profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strata-profiles-'));
  const store = createProfileStore({ dataDir: dir });
  store.save('code', { ...store.get('code'), systemPrompt: 'X' });
  store.bindSession('sess-1', 'code');
  const read = policyReader(store.policyFile);
  assert.equal(read('sess-1')?.systemPrompt, 'X');
  assert.equal(read('other'), null);
  assert.equal(createProfileStore({ dataDir: dir }).get('code').systemPrompt, 'X', 'a restart reads the saved profiles');
  writeFileSync(join(dir, 'profiles.json'), '{broken');
  assert.equal(createProfileStore({ dataDir: dir }).get('code').systemPrompt, DEFAULT_PROFILES.code.systemPrompt, 'a damaged file falls back to the defaults');
});
