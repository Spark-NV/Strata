/**
 * Vibe mode: the state the Head AI works under, kept by code so the rules hold whatever the model writes.
 *
 * Two kinds of state, kept apart:
 *   - The project book (committed with the project, `.strata/project/`): book.json plus BRIEF.md, DECISIONS.md and STATUS.md rendered
 *     from it for people. Goal, requirements (confirmed / assumed / open), scope, approach, concerns, milestones, checks, decisions,
 *     known issues and lessons (approaches that failed). Only the vibe tools write it; nobody edits it by hand.
 *   - The run state (the app's data folder, `<stateDir>/projects/<key>.json`, never in the repository): the stage, the work branch, the
 *     last check, the failure streak, which helper sessions changed files since the milestone began, reviews, the write lease.
 *
 * Stages: discover (nothing in the project changes; questions, research, the brief) -> build (after the person approved the brief, or
 * straight away for a small task) -> done (handed over). A new brief after `done` starts the next round at discover.
 *
 * Pure functions plus small synchronous file and git helpers. Imported by the vibe tools (plugins/strata-vibe.mjs) and the gate
 * (plugins/strata-gate.mjs) inside the Harness process, and by the bridge in the host. No Harness imports.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const BOOK_DIR = join('.strata', 'project');
export const STAGES = Object.freeze(['discover', 'build', 'done']);
export const SIZES = Object.freeze(['small', 'medium', 'large']);
export const REQ_STATUS = Object.freeze(['confirmed', 'assumed', 'open']);
/** Failed check runs in a row before the Head must rethink (a decision), and before it must ask the person. */
export const RETHINK_AFTER = 3;
export const ASK_AFTER = 5;
/** A "small" task that grows past this many changed files is not small. */
export const SMALL_MAX_FILES = 8;
/** Deleting more files than this in one milestone needs a decision. */
export const MASS_DELETE = 15;
/** Files larger than this are left out of git when it is set up. */
export const LARGE_FILE = 50 * 1024 * 1024;
const CHECK_TIMEOUT_MS = 15 * 60_000;
const TAIL = 4000;

/* ------------------------------------------------------------------------------------------------------- small helpers --- */

const now = () => new Date().toISOString();
const clean = (v, max = 2000) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);
/**
 * A list from what a model sent: an array, or a string that is really a list (a JSON array, possibly cut off with more JSON after it,
 * or one item per line or bullet). A model sometimes sends `"[\"a\", \"b\"], \"approach\": ..."` as one string.
 */
export function listOf(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  const text = String(v).trim();
  if (text.startsWith('[')) {
    try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed; } catch { /* cut off or followed by more: read the quoted items up to the closing bracket */ }
    const items = [];
    const re = /"((?:[^"\\]|\\.)*)"\s*(,|\])/g;
    let m;
    while ((m = re.exec(text))) { try { items.push(JSON.parse(`"${m[1]}"`)); } catch { items.push(m[1]); } if (m[2] === ']') break; }
    if (items.length) return items;
  }
  const lines = text.split(/\n+/).map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  return lines.length > 1 ? lines : [text];
}
const list = (v, max = 60, each = 1000) => listOf(v).map(x => clean(x, each)).filter(Boolean).slice(0, max);

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** The key of a project folder in the app's data folder. */
export const projectKey = root => createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);

/** Is `path` the folder `root` or inside it? */
export function inside(root, path) {
  if (!root || !path) return false;
  const rel = relative(resolve(root), resolve(root, String(path)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A folder Vibe must not turn into a project: the computer's root, the home folder itself, or a folder above home. */
export function unsafeRoot(root, { defaults = [] } = {}) {
  if (!root) return 'No project folder is chosen for this chat.';
  const r = resolve(root);
  const home = resolve(homedir());
  if (r === sep || r === resolve(dirname(r)) || /^[A-Za-z]:\\?$/.test(r)) return 'The project folder is the top of the disk.';
  if (r === home || inside(r, home)) return 'The project folder is the home folder (or above it).';
  for (const d of defaults) if (d && resolve(d) === r) return 'This chat is in the app\'s shared default folder, not a project folder of its own.';
  return null;
}

/* ------------------------------------------------------------------------------------------------------------ the book --- */

export function emptyBook() {
  return { version: 1, title: '', goal: '', size: null, requirements: [], outOfScope: [], approach: '', concerns: [], milestones: [], checks: { commands: [], none: '' }, protected: [], decisions: [], knownIssues: [], lessons: [], history: [], approvedAt: null, round: 1 };
}

export const bookFile = root => join(root, BOOK_DIR, 'book.json');

export function loadBook(root) {
  const raw = readJson(bookFile(root), null);
  return raw && typeof raw === 'object' ? { ...emptyBook(), ...raw } : emptyBook();
}

/** Write book.json and the three pages people read. */
export function saveBook(root, book) {
  writeJson(bookFile(root), book);
  writeText(join(root, BOOK_DIR, 'BRIEF.md'), renderBrief(book));
  writeText(join(root, BOOK_DIR, 'DECISIONS.md'), renderDecisions(book));
  writeText(join(root, BOOK_DIR, 'STATUS.md'), renderStatus(book));
  writeText(join(root, BOOK_DIR, 'README.md'), '# Project book\n\nKept by Strata\'s Vibe mode: the brief, the decisions and their reasons, and the progress of this project. It is written by the assistant through its project tools; editing it by hand is not needed.\n\n- [BRIEF.md](BRIEF.md): what the project is for and what it must do\n- [DECISIONS.md](DECISIONS.md): every decision, why, and what was rejected\n- [STATUS.md](STATUS.md): milestones, known problems and lessons\n');
}

const nextId = (items, prefix) => `${prefix}${items.reduce((n, x) => Math.max(n, Number(String(x.id ?? '').replace(/\D/g, '')) || 0), 0) + 1}`;

/**
 * Apply a brief update from the Head. Lists replace what was there when given (requirements are matched by id so their status can
 * change); text fields replace when given. After approval every change is also written to the history, so a requirement that moved
 * can always be traced.
 */
export function applyBrief(book, input = {}, { by = 'head' } = {}) {
  const out = { ...book };
  const changed = [];
  for (const key of ['title', 'goal', 'approach']) if (typeof input[key] === 'string' && input[key].trim()) { const v = clean(input[key], key === 'approach' ? 8000 : 2000); if (v !== out[key]) { out[key] = v; changed.push(key); } }
  if (SIZES.includes(input.size) && input.size !== out.size) { out.size = input.size; changed.push('size'); }
  if (typeof input.requirements === 'string') { try { input = { ...input, requirements: JSON.parse(input.requirements) }; } catch { /* not a list */ } }
  if (typeof input.milestones === 'string') { try { input = { ...input, milestones: JSON.parse(input.milestones) }; } catch { /* not a list */ } }
  if (typeof input.concerns === 'string') { try { input = { ...input, concerns: JSON.parse(input.concerns) }; } catch { /* not a list */ } }
  if (Array.isArray(input.requirements)) {
    const old = new Map(out.requirements.map(r => [r.id, r]));
    const next = [];
    for (const r of input.requirements.slice(0, 80)) {
      const text = clean(r?.text, 600);
      if (!text) continue;
      const status = REQ_STATUS.includes(r?.status) ? r.status : 'assumed';
      const id = r?.id && old.has(r.id) ? r.id : nextId([...out.requirements, ...next], 'R');
      next.push({ id, text, status, ...(clean(r?.why, 400) ? { why: clean(r.why, 400) } : {}), ...(status === 'open' && clean(r?.question, 400) ? { question: clean(r.question, 400) } : {}) });
    }
    out.requirements = next; changed.push('requirements');
  }
  if (input.outOfScope !== undefined) { out.outOfScope = list(input.outOfScope, 40, 400); changed.push('out of scope'); }
  if (input.protected !== undefined) { out.protected = list(input.protected, 40, 300); changed.push('protected files'); }
  if (Array.isArray(input.concerns)) {
    out.concerns = input.concerns.slice(0, 20).map(c => ({ about: clean(c?.about, 400), concern: clean(c?.concern, 800), better: clean(c?.better, 800) })).filter(c => c.concern);
    changed.push('concerns');
  }
  if (Array.isArray(input.milestones)) {
    const old = new Map(out.milestones.map(m => [m.id, m]));
    const next = [];
    for (const m of input.milestones.slice(0, 20)) {
      const title = clean(m?.title, 200);
      if (!title) continue;
      const id = m?.id && old.has(m.id) ? m.id : nextId([...out.milestones, ...next], 'M');
      const prev = old.get(id);
      next.push({ id, title, detail: clean(m?.detail, 1200), done: prev?.done ?? false, ...(prev?.doneAt ? { doneAt: prev.doneAt, summary: prev.summary } : {}) });
    }
    out.milestones = next; changed.push('milestones');
  }
  if (input.checks !== undefined) {
    const c = input.checks && typeof input.checks === 'object' && !Array.isArray(input.checks) ? input.checks : { commands: input.checks };
    out.checks = { commands: list(c.commands, 10, 500), none: clean(c.none, 600) };
    changed.push('checks');
  }
  if (changed.length && out.approvedAt) out.history = [...out.history, { at: now(), by, change: `Brief changed after approval: ${changed.join(', ')}${input.reason ? ` (${clean(input.reason, 300)})` : ''}` }].slice(-200);
  return { book: out, changed };
}

/** What is still missing before the brief can be shown to the person for approval. */
export function briefGaps(book) {
  const gaps = [];
  if (!book.goal) gaps.push('the goal, in the person\'s own words');
  if (!book.size) gaps.push('the size of the work (small, medium or large)');
  if (book.size !== 'small') {
    if (!book.requirements.length) gaps.push('the requirements');
    if (!book.approach) gaps.push('the approach');
    if (!book.milestones.length) gaps.push('at least one milestone');
  }
  if (!book.checks.commands.length && !book.checks.none) gaps.push('how the work is checked (commands that must pass, or why there are none)');
  return gaps;
}

export function addDecision(book, input = {}, { by = 'head' } = {}) {
  const d = {
    id: nextId(book.decisions, 'D'), at: now(), by: input.by === 'you' ? 'you' : by,
    title: clean(input.title, 200), choice: clean(input.choice, 1500), why: clean(input.why, 1500),
    ...(list(input.rejected, 8, 600).length ? { rejected: list(input.rejected, 8, 600) } : {}),
    ...(['scope', 'design', 'dependency', 'data', 'rethink', 'other'].includes(input.kind) ? { kind: input.kind } : {}),
    ...(input.replaces ? { replaces: clean(input.replaces, 20) } : {}),
  };
  const decisions = book.decisions.map(x => (d.replaces && x.id === d.replaces ? { ...x, replacedBy: d.id } : x));
  return { book: { ...book, decisions: [...decisions, d].slice(-300) }, decision: d };
}

export function addNote(book, input = {}) {
  const out = { ...book };
  if (clean(input.knownIssue)) out.knownIssues = [...out.knownIssues, { id: nextId(out.knownIssues, 'K'), at: now(), text: clean(input.knownIssue, 800) }].slice(-100);
  if (clean(input.resolved)) out.knownIssues = out.knownIssues.filter(k => k.id !== clean(input.resolved, 20));
  if (clean(input.lesson)) out.lessons = [...out.lessons, { at: now(), text: clean(input.lesson, 800) }].slice(-100);
  return out;
}

/* -------------------------------------------------------------------------------------------------------- the run state --- */

export function emptyRun(root) {
  return { root: resolve(root), stage: 'discover', branch: null, baseBranch: null, milestoneStart: null, writers: [], reviews: [], lastCheck: null, failStreak: 0, needRethink: false, needUser: false, lease: null, gitApproved: false, startedAt: now(), updatedAt: now() };
}
export const runFile = (stateDir, root) => join(stateDir, 'projects', `${projectKey(root)}.json`);
export function loadRun(stateDir, root) {
  const raw = readJson(runFile(stateDir, root), null);
  return raw && typeof raw === 'object' ? { ...emptyRun(root), ...raw } : emptyRun(root);
}
export function saveRun(stateDir, root, run) { writeJson(runFile(stateDir, root), { ...run, updatedAt: now() }); return run; }
export function updateRun(stateDir, root, fn) { const run = loadRun(stateDir, root); const next = fn(run) ?? run; return saveRun(stateDir, root, next); }

/** Which project folder a Harness session (the chat's own) works in: written by the host at the start of every Vibe turn. */
export const sessionFile = (stateDir, sessionId) => join(stateDir, 'sessions', `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);
export function bindSession(stateDir, sessionId, root) { if (sessionId && root) writeJson(sessionFile(stateDir, sessionId), { root: resolve(root), at: now() }); }
export function rootOfSession(stateDir, sessionId) { return readJson(sessionFile(stateDir, sessionId), null)?.root ?? null; }

/* ----------------------------------------------------------------------------------------------------------------- git --- */

export function git(root, args, { input } = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  return { ok: r.status === 0, code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || (r.error ? String(r.error.message) : '') };
}
export const gitTop = root => { const r = git(root, ['rev-parse', '--show-toplevel']); return r.ok ? resolve(r.out) : null; };
export const isRepoRoot = root => gitTop(root) === resolve(root);
export const head = root => { const r = git(root, ['rev-parse', 'HEAD']); return r.ok ? r.out : null; };
export const currentBranch = root => { const r = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']); return r.ok ? r.out : null; };
/** Changed or new files (not ignored), as `git status --porcelain` lines. */
export const dirty = root => { const r = git(root, ['status', '--porcelain', '--untracked-files=all', '--', '.']); return r.ok ? r.out.split('\n').filter(Boolean) : []; };

/** Commit everything that changed (the app's save point). Returns the new commit, or the current one when nothing changed. */
export function checkpoint(root, message) {
  if (!dirty(root).length) return { commit: head(root), made: false };
  const add = git(root, ['add', '-A', '--', '.']);
  if (!add.ok) return { error: add.err || 'git add failed' };
  const c = git(root, ['-c', 'user.useConfigOnly=false', ...identityArgs(root), 'commit', '-q', '--no-verify', '-m', clean(message, 2000) || 'Vibe save point']);
  if (!c.ok) return { error: c.err || 'git commit failed' };
  return { commit: head(root), made: true };
}
/** A commit needs a name and an email; when the person has none configured, the save points are signed as the app. */
export function identityArgs(root) {
  const name = git(root, ['config', 'user.name']).out, email = git(root, ['config', 'user.email']).out;
  return [...(name ? [] : ['-c', 'user.name=Strata Vibe']), ...(email ? [] : ['-c', 'user.email=vibe@strata.local'])];
}

export const slug = text => String(text || 'project').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'project';

/** Do two commits hold the same work? Changes to the project book alone do not count (closing a milestone writes the book). */
export function sameWork(root, a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return git(root, ['diff', '--quiet', a, b, '--', '.', `:(exclude)${BOOK_DIR.split(sep).join('/')}`]).code === 0;
}

/** Files changed since `from` (a commit): added, deleted, all, and whether a dependency list changed. */
export function changesSince(root, from) {
  if (!from) return { files: [], added: [], deleted: [], dependencies: [] };
  const r = git(root, ['diff', '--name-status', '--no-renames', '--relative', `${from}..HEAD`, '--', '.']);
  const rows = r.ok ? r.out.split('\n').filter(Boolean).map(l => l.split('\t')) : [];
  const files = rows.map(x => x[1]).filter(Boolean);
  const deps = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg|Cargo\.toml|go\.mod|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|.*\.csproj|pubspec\.yaml|Package\.swift)$/;
  return { files, added: rows.filter(x => x[0] === 'A').map(x => x[1]), deleted: rows.filter(x => x[0] === 'D').map(x => x[1]), dependencies: files.filter(f => deps.test(f) && !f.startsWith(BOOK_DIR.split(sep).join('/'))) };
}

/* ------------------------------------------------------------------------------------------------------- setting up git --- */

const GENERATED = ['node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'target', 'coverage', '__pycache__', '.pytest_cache', '.mypy_cache', '.venv', 'venv', 'env', '.tox', '.gradle', '.idea', '.DS_Store', 'Thumbs.db', '.cache', '.parcel-cache', '.turbo', 'vendor/bundle'];
const SECRET_NAME = /(^|\/)(\.env(\..+)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|service-account.*\.json|.*\.keystore|.*\.jks)$/i;
const SECRET_TEXT = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/;

/**
 * Look at a folder before git is set up in it: a repository it is already part of, secrets, generated folders, large files.
 * Walks at most `limit` files and never follows links.
 */
export function scanForGit(root, { limit = 20_000 } = {}) {
  const top = gitTop(root);
  const found = { root: resolve(root), parentRepo: top && top !== resolve(root) ? top : null, isRepo: top === resolve(root), secrets: [], generated: [], large: [], files: 0, truncated: false };
  if (found.isRepo || found.parentRepo) return found;
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.files >= limit) { found.truncated = true; return; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        if (GENERATED.includes(e.name)) { found.generated.push(`${r}/`); continue; }
        walk(join(dir, e.name), r);
        continue;
      }
      if (!e.isFile()) continue;
      found.files++;
      if (GENERATED.includes(e.name)) { found.generated.push(r); continue; }
      let size = 0;
      try { size = statSync(join(dir, e.name)).size; } catch { continue; }
      if (SECRET_NAME.test(r) && !/\.(example|sample|template)$/i.test(r)) { found.secrets.push(r); continue; }
      if (size > LARGE_FILE) { found.large.push({ path: r, mb: Math.round(size / 1048576) }); continue; }
      if (size < 512 * 1024) {
        try { if (SECRET_TEXT.test(readFileSync(join(dir, e.name), 'latin1'))) found.secrets.push(r); } catch { /* unreadable: not ours to judge */ }
      }
    }
  };
  walk(resolve(root), '');
  return found;
}

/** What the tools a project grows into leave behind (caches, installs, secrets, scratch work, local database files that hold the person's data): ignored from the start, even in an empty folder. */
export const BASE_IGNORES = ['node_modules/', '__pycache__/', '*.pyc', '.venv/', 'venv/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.cache/', 'coverage/', '.DS_Store', 'Thumbs.db', '.env', '.env.*', '!.env.example', '*.log', 'scratchpad/', 'tmp/', '*.db', '*.sqlite', '*.sqlite3', '*.db-journal'];

/** The .gitignore lines for a new repository: the usual leftovers plus what the scan found (added to an existing .gitignore, never replacing it). */
export function ignoreLines(scan) {
  return ['# Added by Strata Vibe when it set up save points', ...new Set([...BASE_IGNORES, ...scan.generated.map(g => `/${g}`), ...scan.secrets.map(s => `/${s}`), ...scan.large.map(l => `/${l.path}`)])];
}

/** Plain words for the person: what setting up git here will do. */
export function describeScan(scan) {
  const parts = [`Save points (git) were set up in ${scan.root}, so every step of the work can be undone.`];
  const leave = [...scan.secrets.map(s => `${s} (looks secret)`), ...scan.generated.map(g => `${g} (generated)`), ...scan.large.map(l => `${l.path} (${l.mb} MB)`)];
  if (leave.length) parts.push(`Left out of git: ${leave.slice(0, 12).join(', ')}${leave.length > 12 ? `, and ${leave.length - 12} more` : ''}.`);
  parts.push('Git here is only on this computer; nothing was uploaded.');
  return parts.join(' ');
}

export function initGit(root, scan) {
  const lines = ignoreLines(scan);
  if (lines.length) {
    const file = join(root, '.gitignore');
    const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const missing = lines.filter(l => l.startsWith('#') || !old.split('\n').includes(l));
    if (missing.length > 1) writeFileSync(file, `${old}${old && !old.endsWith('\n') ? '\n' : ''}${old ? '\n' : ''}${missing.join('\n')}\n`);
  }
  const init = git(root, ['init', '-q']);
  if (!init.ok) return { error: init.err || 'git init failed' };
  return checkpoint(root, 'Project as it was before Vibe');
}

/* ------------------------------------------------------------------------------------------------------------- checks --- */

/** Run one check command in the project folder (a shell command line), without blocking the process. */
export function runCommand(root, command, { timeoutMs = CHECK_TIMEOUT_MS, signal } = {}) {
  return new Promise(resolvePromise => {
    const started = Date.now();
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell' : 'bash', windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command], { cwd: root, env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, detached: !windows });
    let out = '';
    const take = d => { out += d.toString('utf8'); if (out.length > 400_000) out = out.slice(-200_000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    let killed = null;
    const kill = why => { if (killed) return; killed = why; try { if (windows) child.kill(); else process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const onAbort = () => kill('stopped');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', e => { out += `\n${e.message}`; });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      resolvePromise({ command, code: killed ? null : code, ok: !killed && code === 0, killed, seconds: Math.round((Date.now() - started) / 100) / 10, tail: out.slice(-TAIL) });
    });
  });
}

/* ------------------------------------------------------------------------------------------------------------- pages --- */

const statusWord = { confirmed: 'Confirmed by you', assumed: 'Assumed (decided for you; say if it is wrong)', open: 'Open question' };

export function renderBrief(b) {
  const L = [`# ${b.title || 'Project brief'}`, ''];
  if (b.approvedAt) L.push(`Approved ${b.approvedAt.slice(0, 10)}. Size: ${b.size ?? 'not set'}.`, ''); else L.push(`Draft (not approved yet). Size: ${b.size ?? 'not set'}.`, '');
  L.push('## What you want', '', b.goal || '_Not written yet._', '');
  for (const s of REQ_STATUS) {
    const rs = b.requirements.filter(r => r.status === s);
    if (!rs.length) continue;
    L.push(`## ${statusWord[s]}`, '');
    for (const r of rs) L.push(`- **${r.id}** ${r.text}${r.why ? ` _(why: ${r.why})_` : ''}${r.question ? `\n  - Question: ${r.question}` : ''}`);
    L.push('');
  }
  if (b.outOfScope.length) L.push('## Not part of this', '', ...b.outOfScope.map(x => `- ${x}`), '');
  if (b.approach) L.push('## How it will be built', '', b.approach, '');
  if (b.concerns.length) {
    L.push('## Concerns and better options', '');
    for (const c of b.concerns) L.push(`- ${c.about ? `**${c.about}:** ` : ''}${c.concern}${c.better ? `\n  - Better: ${c.better}` : ''}`);
    L.push('');
  }
  if (b.milestones.length) L.push('## Milestones', '', ...b.milestones.map(m => `- [${m.done ? 'x' : ' '}] **${m.id}** ${m.title}${m.detail ? `: ${m.detail}` : ''}`), '');
  L.push('## How the work is checked', '', ...(b.checks.commands.length ? b.checks.commands.map(c => `- \`${c}\``) : [`- No automatic checks: ${b.checks.none || 'not decided yet'}`]), '');
  if (b.protected.length) L.push('## Not to be changed', '', ...b.protected.map(p => `- ${p}`), '');
  return `${L.join('\n').trimEnd()}\n`;
}

export function renderDecisions(b) {
  const L = ['# Decisions', '', 'Every decision made for this project, newest last: what was chosen, why, and what was rejected. "You" means the person decided; "Head" means the assistant decided on its own.', ''];
  if (!b.decisions.length) L.push('_None yet._');
  for (const d of b.decisions) {
    L.push(`## ${d.id} ${d.title || 'Decision'}${d.replacedBy ? ` (replaced by ${d.replacedBy})` : ''}`, '', `${d.at.slice(0, 10)} · decided by ${d.by === 'you' ? 'you' : 'Head'}${d.kind ? ` · ${d.kind}` : ''}${d.replaces ? ` · replaces ${d.replaces}` : ''}`, '');
    if (d.choice) L.push(`**Chosen:** ${d.choice}`, '');
    if (d.why) L.push(`**Why:** ${d.why}`, '');
    if (d.rejected?.length) L.push('**Rejected:**', '', ...d.rejected.map(r => `- ${r}`), '');
  }
  if (b.history.length) L.push('## Changes to the approved brief', '', ...b.history.map(h => `- ${h.at.slice(0, 10)} (${h.by}): ${h.change}`), '');
  return `${L.join('\n').trimEnd()}\n`;
}

export function renderStatus(b) {
  const done = b.milestones.filter(m => m.done).length;
  const L = ['# Status', '', `${done} of ${b.milestones.length} milestones done.`, ''];
  if (b.milestones.length) L.push('## Milestones', '', ...b.milestones.map(m => `- [${m.done ? 'x' : ' '}] **${m.id}** ${m.title}${m.done && m.summary ? `\n  - ${m.doneAt?.slice(0, 10) ?? ''}: ${m.summary}` : ''}`), '');
  L.push('## Known problems', '', ...(b.knownIssues.length ? b.knownIssues.map(k => `- **${k.id}** ${k.text}`) : ['_None known._']), '');
  L.push('## Lessons (approaches that did not work)', '', ...(b.lessons.length ? b.lessons.map(l => `- ${l.at.slice(0, 10)}: ${l.text}`) : ['_None yet._']), '');
  return `${L.join('\n').trimEnd()}\n`;
}

/* ------------------------------------------------------------------------------------------- the summary every turn gets --- */

const STAGE_RULES = {
  discover: 'Stage: DISCOVER. Nothing in the project can change yet (the app refuses edits and changing commands). Understand the goal, research, ask the questions that matter, write the brief with vibe_brief, then vibe_start.',
  build: 'Stage: BUILD. The person approved the work. Builders change files without asking; the app saves a git checkpoint before each builder task. A milestone closes only through vibe_milestone_done, after vibe_check passes and an independent @checker review passes.',
  done: 'Stage: DONE. The last round was handed over. A new request starts the next round: update the brief with vibe_brief.',
};

/** The short block put in front of the person's message in a Vibe chat, so the project survives summaries and restarts. */
export function bookSummary(root, run, book, { max = 3500 } = {}) {
  const L = ['<project_book>', `Folder: ${root}`, STAGE_RULES[run.stage] ?? STAGE_RULES.discover];
  if (run.needUser) L.push(`BLOCKED: the checks failed ${run.failStreak} times in a row. Explain the problem to the person in plain words and ask how to go on. No changes until they answer.`);
  else if (run.needRethink) L.push(`RETHINK: the checks failed ${run.failStreak} times in a row. Stop repeating the same fix: record a different approach with vibe_decide (kind "rethink") before changing more files.`);
  if (run.branch) L.push(`Work branch: ${run.branch} (from ${run.baseBranch ?? 'the main branch'}).`);
  if (run.stage === 'build' && run.milestoneStart) L.push(`This milestone began at commit ${run.milestoneStart.slice(0, 10)} (its changes: git diff ${run.milestoneStart.slice(0, 10)}).`);
  if (book.title || book.goal) L.push(`Project: ${book.title || '(untitled)'}${book.size ? ` · size ${book.size}` : ''}${book.approvedAt ? ' · brief approved' : ' · brief not approved'}`);
  if (book.goal) L.push(`Goal: ${book.goal.slice(0, 600)}`);
  const open = book.requirements.filter(r => r.status === 'open');
  const counts = REQ_STATUS.map(s => `${book.requirements.filter(r => r.status === s).length} ${s}`).join(', ');
  if (book.requirements.length) L.push(`Requirements: ${counts}.`);
  if (open.length) L.push(`Open questions: ${open.slice(0, 6).map(r => `${r.id} ${r.question || r.text}`).join(' | ')}`);
  if (book.milestones.length) {
    const next = book.milestones.find(m => !m.done);
    L.push(`Milestones: ${book.milestones.map(m => `${m.done ? '[x]' : '[ ]'} ${m.id} ${m.title}`).join('; ')}`);
    if (next && run.stage === 'build') L.push(`Current milestone: ${next.id} ${next.title}`);
  }
  if (run.lastCheck) L.push(`Last check: ${run.lastCheck.ok ? 'passed' : 'FAILED'} (${run.lastCheck.at.slice(0, 16).replace('T', ' ')})${run.lastCheck.ok ? '' : `: ${run.lastCheck.results?.filter(r => !r.ok).map(r => r.command).join(', ')}`}`);
  const recent = book.decisions.filter(d => !d.replacedBy).slice(-6);
  if (recent.length) L.push(`Recent decisions (keep them unless the person changes them): ${recent.map(d => `${d.id} ${d.title}`).join('; ')}`);
  if (book.lessons.length) L.push(`Do not retry: ${book.lessons.slice(-5).map(l => l.text).join(' | ')}`);
  if (book.knownIssues.length) L.push(`Known problems: ${book.knownIssues.slice(-5).map(k => `${k.id} ${k.text}`).join(' | ')}`);
  L.push(`The full book: ${BOOK_DIR.split(sep).join('/')}/BRIEF.md, DECISIONS.md, STATUS.md (read them when you need detail).`, '</project_book>');
  let text = L.join('\n');
  if (text.length > max) text = `${text.slice(0, max - 40)}\n…\n</project_book>`;
  return text;
}

/** What the page shows about a Vibe chat's project (`GET /api/vibe/state`). */
export function publicState(root, run, book) {
  return {
    root, stage: run.stage, branch: run.branch, baseBranch: run.baseBranch, title: book.title, goal: book.goal, size: book.size, approved: !!book.approvedAt,
    milestones: book.milestones.map(m => ({ id: m.id, title: m.title, done: !!m.done })),
    requirements: REQ_STATUS.reduce((o, s) => ({ ...o, [s]: book.requirements.filter(r => r.status === s).length }), {}),
    decisions: book.decisions.length, knownIssues: book.knownIssues.length,
    lastCheck: run.lastCheck ? { ok: run.lastCheck.ok, at: run.lastCheck.at } : null,
    blocked: run.needUser ? 'ask' : run.needRethink ? 'rethink' : null,
    bookPath: existsSync(bookFile(root)) ? join(root, BOOK_DIR, 'BRIEF.md') : null,
    name: book.title || basename(root),
  };
}
