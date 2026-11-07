// Vibe mode: the project book, the stages and the rules (server/agent/vibe-state.mjs, plugins/strata-vibe.mjs, the gate's vibeDecision).
// The tools run against a pretend Harness context in a temporary folder with real git, so the whole path is exercised: brief, approval,
// git set-up, checks, the independent review, a milestone, the hand-over and the merge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { apply as applyVibe } from '../server/agent/plugins/strata-vibe.mjs';
import { vibeDecision } from '../server/agent/plugins/strata-gate.mjs';
import { announcesQuestions } from '../server/agent/vibe-nudge.mjs';
import { DEFAULT_PROFILES, normalizeProfile, toolAllowed, applyProfileToAgentBody } from '../server/profiles.mjs';
import { applyBrief, bookSummary, briefGaps, emptyBook, emptyRun, loadRun, saveRun, scanForGit, unsafeRoot, bindSession, loadBook } from '../server/agent/vibe-state.mjs';

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function harness({ answers = [] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'vibe-test-'));
  const root = join(base, 'project');
  const stateDir = join(base, 'state');
  spawnSync('mkdir', ['-p', root]);
  const policyFile = join(base, 'policy.json');
  writeFileSync(policyFile, JSON.stringify({ profiles: { vibe: normalizeProfile('vibe', DEFAULT_PROFILES.vibe), code: normalizeProfile('code', DEFAULT_PROFILES.code) }, sessions: { head: 'vibe', other: 'code' } }));
  const sessions = new Map();
  const mk = (id, parent = null) => { const s = { id, header: parent ? { origin: 'subagent', parentSession: parent } : {} }; sessions.set(id, s); return s; };
  mk('head'); mk('builder1', 'head'); mk('checker1', 'head'); mk('other');
  const tools = new Map();
  const asked = [];
  const ctx = {
    tools: { register: def => tools.set(def.name, def) },
    workingDirectory: { ensure: async () => root },
    approval: { request: async ({ reason }) => { asked.push(reason); return answers.length ? answers.shift() : 'allowed-once'; } },
    sessions: { get: id => sessions.get(id) },
  };
  applyVibe(ctx, { stateDir, policyFile, defaults: [] });
  bindSession(stateDir, 'head', root);
  const call = (name, args = {}, as = 'head') => tools.get(name).execute(args, { agent: { session: sessions.get(as) }, name, callId: 'c1', signal: new AbortController().signal });
  return { base, root, stateDir, call, asked, tools, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('the Vibe profile offers the vibe tools and no other profile does', () => {
  const vibe = normalizeProfile('vibe', DEFAULT_PROFILES.vibe), code = normalizeProfile('code', DEFAULT_PROFILES.code);
  assert.equal(toolAllowed(vibe, 'vibe_start'), true);
  assert.equal(toolAllowed(code, 'vibe_start'), false);
  const body = { messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'vibe_start' } }, { type: 'function', function: { name: 'read' } }] };
  assert.deepEqual(applyProfileToAgentBody(body, code).tools.map(t => t.function.name), ['read']);
  assert.deepEqual(applyProfileToAgentBody(body, vibe).tools.map(t => t.function.name), ['vibe_start', 'read']);
  assert.match(applyProfileToAgentBody(body, vibe).messages[0].content, /Head of this software project/);
  assert.deepEqual(vibe.agents.map(a => a.name), ['builder', 'checker', 'researcher', 'explorer']);
});

test('a brief is complete only with goal, size, requirements, approach, milestones and checks', () => {
  let { book } = applyBrief(emptyBook(), { goal: 'A to-do app', size: 'medium' });
  assert.ok(briefGaps(book).length >= 3);
  ({ book } = applyBrief(book, { requirements: [{ text: 'Add tasks', status: 'confirmed' }, { text: 'Stored locally', status: 'assumed' }], approach: 'A web page', milestones: [{ title: 'Add and list' }], checks: { commands: ['npm test'] } }));
  assert.deepEqual(briefGaps(book), []);
  assert.deepEqual(book.requirements.map(r => r.id), ['R1', 'R2']);
  // ids survive an update, status can change, and after approval every change is in the history
  ({ book } = applyBrief({ ...book, approvedAt: 'x' }, { requirements: [{ id: 'R2', text: 'Stored locally', status: 'confirmed' }], reason: 'they said so' }));
  assert.equal(book.requirements[0].id, 'R2');
  assert.match(book.history.at(-1).change, /requirements \(they said so\)/);
  const small = applyBrief(emptyBook(), { goal: 'Fix the typo', size: 'small', checks: { none: 'a text change' } }).book;
  assert.deepEqual(briefGaps(small), []);
});

test('unsafe project folders are refused', () => {
  assert.ok(unsafeRoot('/'));
  assert.ok(unsafeRoot(process.env.HOME));
  assert.ok(unsafeRoot('/tmp/shared', { defaults: ['/tmp/shared'] }));
  assert.equal(unsafeRoot(join(process.env.HOME, 'projects', 'x')), null);
});

test('the gate: discover refuses changes, build allows them and asks only for what cannot be undone', () => {
  const discover = emptyRun('/p');
  assert.equal(vibeDecision({ name: 'read', arguments: { path: 'a' } }, discover), null);
  assert.equal(vibeDecision({ name: 'vibe_brief', arguments: {} }, discover), null);
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: 'ls' } }, discover), null);
  assert.equal(vibeDecision({ name: 'write', arguments: { file_path: 'a.js' } }, discover).kind, 'deny');
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: 'npm install' } }, discover).kind, 'deny');
  const build = { ...discover, stage: 'build' };
  const opts = { root: '/p', inBook: p => p.startsWith('.strata/project'), outside: p => p.startsWith('/etc') };
  assert.equal(vibeDecision({ name: 'write', arguments: { file_path: 'a.js' } }, build, opts).kind, 'allow');
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: 'npm install && npm test' } }, build, opts).kind, 'allow');
  // running tests does not make a session a builder; editing a file does
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: '.venv/bin/pytest -q' } }, build, opts).edits, false);
  assert.equal(vibeDecision({ name: 'edit', arguments: { file_path: 'a.py' } }, build, opts).edits, true);
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: 'git push origin main' } }, build, opts).kind, 'ask');
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: 'npm publish' } }, build, opts).kind, 'ask');
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: 'gh repo create x --public' } }, build, opts).kind, 'ask');
  // installing, sudo, cleaning and files outside the folder: no question in Vibe
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: 'sudo -n pacman -S --needed --noconfirm ffmpeg' } }, build, opts).kind, 'allow');
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: 'git clean -fdx' } }, build, opts).kind, 'allow');
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: 'rm -rf build' } }, build, opts).kind, 'allow');
  assert.equal(vibeDecision({ name: 'write', arguments: { file_path: '/etc/hosts' } }, build, opts).kind, 'allow');
  // while planning, a chain of look-only commands runs; one that changes something does not
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: 'ls -la; cat a 2>/dev/null || echo none; python3 --version' } }, discover), null);
  assert.equal(vibeDecision({ name: 'bash', arguments: { command: 'ls; touch a' } }, discover).kind, 'deny');
  assert.equal(vibeDecision({ name: 'edit', arguments: { file_path: '.strata/project/book.json' } }, build, opts).kind, 'deny');
  assert.equal(vibeDecision({ name: 'write', arguments: { file_path: 'a.js' } }, { ...build, needRethink: true }, opts).kind, 'deny');
  assert.equal(vibeDecision({ name: 'write', arguments: { file_path: 'a.js' } }, { ...build, needUser: true }, opts).kind, 'deny');
});

test('the git scan finds secrets, generated folders and a parent repository', () => {
  const base = mkdtempSync(join(tmpdir(), 'vibe-scan-'));
  try {
    spawnSync('mkdir', ['-p', join(base, 'node_modules', 'x'), join(base, 'src')]);
    writeFileSync(join(base, '.env'), 'KEY=1');
    writeFileSync(join(base, 'src', 'cfg.js'), 'const k = "ghp_' + 'a'.repeat(36) + '";');
    writeFileSync(join(base, 'src', 'ok.js'), 'console.log(1)');
    const scan = scanForGit(base);
    assert.deepEqual(scan.generated, ['node_modules/']);
    assert.deepEqual(scan.secrets.sort(), ['.env', 'src/cfg.js']);
    git(base, 'init', '-q');
    spawnSync('mkdir', ['-p', join(base, 'sub')]);
    assert.equal(scanForGit(join(base, 'sub')).parentRepo, base);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a whole Vibe project: brief, approval, git, checks, independent review, milestone, hand-over and merge', async () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, 'README.md'), '# demo\n');
    // outside a Vibe chat the tools say so
    assert.match(await h.call('vibe_status', {}, 'other'), /Vibe chats only/);
    // the brief, incomplete then complete
    assert.match(await h.call('vibe_brief', { goal: 'A greeting script', size: 'medium' }), /Still missing/);
    assert.match(await h.call('vibe_start'), /not complete/);
    await h.call('vibe_brief', { title: 'Greeter', requirements: [{ text: 'Prints hello', status: 'confirmed' }, { text: 'Which language?', status: 'open', question: 'English or Dutch?' }], approach: 'One shell script.', milestones: [{ title: 'Script prints hello' }], checks: { commands: ['test -f hello.sh && bash hello.sh | grep -q hello'] } });
    assert.match(await h.call('vibe_start'), /still open/);
    await h.call('vibe_brief', { requirements: [{ id: 'R1', text: 'Prints hello', status: 'confirmed' }, { id: 'R2', text: 'English', status: 'assumed' }] });
    assert.ok(existsSync(join(h.root, '.strata/project/BRIEF.md')));
    // helpers cannot run the Head's tools
    assert.match(await h.call('vibe_start', {}, 'builder1'), /Only the Head/);
    // approval card, then the git card; git is set up, a branch is made
    const started = await h.call('vibe_start', { summary: 'A script that greets.' });
    assert.match(started, /Approved/);
    assert.match(started, /Save points \(git\) were set up/);
    assert.equal(h.asked.length, 1);   // only the brief: git is set up without a question
    assert.match(h.asked[0], /Start building "Greeter"/);
    assert.equal(git(h.root, 'branch', '--show-current').stdout.trim(), 'vibe/greeter');
    assert.match(readFileSync(join(h.root, '.gitignore'), 'utf8'), /^__pycache__\/$/m);   // the usual leftovers are ignored even in an empty folder
    assert.equal(loadRun(h.stateDir, h.root).stage, 'build');
    // the milestone cannot close before checks and a review
    assert.match(await h.call('vibe_milestone_done', { summary: 'done' }), /checks have not passed/);
    // a failing check, then the fix
    assert.match(await h.call('vibe_check'), /FAIL/);
    writeFileSync(join(h.root, 'hello.sh'), 'echo hello\n');
    const run = loadRun(h.stateDir, h.root); saveRun(h.stateDir, h.root, { ...run, writers: ['builder1'] });   // the gate records who changed files
    assert.match(await h.call('vibe_check'), /All checks passed/);
    assert.match(await h.call('vibe_milestone_done', { summary: 'done' }), /no independent review/);
    // the builder may not review its own work; the Head may not review at all; a fresh checker may
    assert.match(await h.call('vibe_review', { verdict: 'pass' }, 'builder1'), /cannot be its reviewer/);
    assert.match(await h.call('vibe_review', { verdict: 'pass' }), /independent @checker/);
    assert.match(await h.call('vibe_review', { verdict: 'pass', checked: 'ran it' }, 'checker1'), /Review recorded \(pass\)/);
    assert.equal(loadRun(h.stateDir, h.root).reviews.at(-1).findings.length, 0);
    await h.call('vibe_review', { verdict: 'pass', findings: [{ file: 'hello.sh', problem: 'no shebang', fix: 'add one' }] }, 'checker1');
    assert.equal(loadRun(h.stateDir, h.root).reviews.at(-1).findings[0], 'file: hello.sh; problem: no shebang; fix: add one');
    assert.match(await h.call('vibe_milestone_done', { summary: 'The script prints hello.' }), /Every milestone is closed/);
    assert.equal(loadBook(h.root).milestones[0].done, true);
    // hand-over: merged into the branch it started from, with no card
    const finished = await h.call('vibe_finish', { summary: 'Run bash hello.sh.' });
    assert.match(finished, /Merged into/);
    assert.equal(h.asked.length, 1);   // the brief was the only card of the whole project
    assert.equal(loadRun(h.stateDir, h.root).stage, 'done');
    assert.notEqual(git(h.root, 'branch', '--show-current').stdout.trim(), 'vibe/greeter');
    assert.equal(readFileSync(join(h.root, 'hello.sh'), 'utf8'), 'echo hello\n');
    assert.match(readFileSync(join(h.root, '.strata/project/STATUS.md'), 'utf8'), /1 of 1 milestones done/);
    // a new brief after the hand-over starts the next round in discover
    await h.call('vibe_brief', { goal: 'Also greet in Dutch' });
    assert.equal(loadRun(h.stateDir, h.root).stage, 'discover');
  } finally { h.cleanup(); }
});

test('changing the checks after approval needs a recorded decision before the milestone closes', async () => {
  const h = harness();
  try {
    await h.call('vibe_brief', { title: 'C', goal: 'x', size: 'medium', requirements: [{ text: 'r', status: 'confirmed' }], approach: 'a', milestones: [{ title: 'm' }], checks: { commands: ['false'] } });
    await h.call('vibe_start');
    await h.call('vibe_brief', { checks: { commands: ['true'] }, reason: 'wrong path' });
    assert.match(await h.call('vibe_check'), /All checks passed/);
    await h.call('vibe_review', { verdict: 'pass' }, 'checker1');
    assert.match(await h.call('vibe_milestone_done', { summary: 's' }), /check commands changed/);
    await h.call('vibe_decide', { title: 'Check path', choice: 'use true', why: 'the old command pointed at the wrong place' });
    assert.match(await h.call('vibe_milestone_done', { summary: 's' }), /Every milestone is closed/);
    // a list sent as one string by the model is read as a list
    await h.call('vibe_brief', { outOfScope: '["Cloud sync", "Budgets"], "approach": "x' });
    assert.deepEqual(loadBook(h.root).outOfScope, ['Cloud sync', 'Budgets']);
  } finally { h.cleanup(); }
});

test('repeated failing checks block changes until a rethink, then until the person answers', async () => {
  const h = harness();
  try {
    await h.call('vibe_brief', { title: 'Fail', goal: 'x', size: 'small', checks: { commands: ['false'] } });
    assert.match(await h.call('vibe_start'), /Small task/);
    assert.equal(h.asked.length, 0);   // a small task asks nothing
    for (let i = 1; i < 3; i++) assert.match(await h.call('vibe_check'), /Failed \(\d in a row\)/);
    assert.match(await h.call('vibe_check'), /Do not try the same fix again/);
    assert.equal(loadRun(h.stateDir, h.root).needRethink, true);
    await h.call('vibe_decide', { title: 'New approach', choice: 'b', why: 'a failed', kind: 'rethink' });
    assert.equal(loadRun(h.stateDir, h.root).needRethink, false);
    await h.call('vibe_check');
    assert.match(await h.call('vibe_check'), /ask how to go on/);
    assert.equal(loadRun(h.stateDir, h.root).needUser, true);
    assert.match(await h.call('vibe_check'), /Ask the person/);
    assert.match(bookSummary(h.root, loadRun(h.stateDir, h.root), loadBook(h.root)), /BLOCKED/);
  } finally { h.cleanup(); }
});

test('the person\'s own unsaved changes are committed apart before the work starts, without a question', async () => {
  const h = harness();
  try {
    git(h.root, 'init', '-q');
    writeFileSync(join(h.root, 'a.txt'), 'one\n');
    git(h.root, 'add', '-A'); git(h.root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    writeFileSync(join(h.root, 'a.txt'), 'mine\n');
    await h.call('vibe_brief', { title: 'T', goal: 'x', size: 'medium', requirements: [{ text: 'r', status: 'confirmed' }], approach: 'a', milestones: [{ title: 'm' }], checks: { none: 'n' } });
    assert.match(await h.call('vibe_start'), /Your work before Vibe/);
    assert.equal(h.asked.length, 1);   // the brief only
    assert.equal(loadRun(h.stateDir, h.root).stage, 'build');
    assert.equal(readFileSync(join(h.root, 'a.txt'), 'utf8'), 'mine\n');
    assert.match(git(h.root, 'log', '--format=%s').stdout, /Your work before Vibe/);
  } finally { h.cleanup(); }
});

test('a reply that announces questions without asking them is caught; one that asks, or says something else, is not', () => {
  assert.equal(announcesQuestions('Fresh, empty project — so this is a greenfield build. Before I write the brief, a few questions that genuinely change what gets built.'), true);
  assert.equal(announcesQuestions('Before I start I need to know a couple of things.'), true);
  assert.equal(announcesQuestions('Where should backups go: a drive or the cloud? And how often?'), false);
  assert.equal(announcesQuestions('Done. The tests pass and the work is merged.'), false);
  assert.equal(announcesQuestions('Here is the plan:'), false);
});
