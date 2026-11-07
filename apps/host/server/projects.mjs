/**
 * Recent projects for Code chats: every folder a chat was pointed at, newest first, plus the person's own additions.
 *
 *   <dataDir>/recent-projects.json   { projects: [{ path, usedAt }] }
 *
 * Each listed project also says whether it has instructions for coding agents (AGENTS.md, or CLAUDE.md / QWEN.md / GEMINI.md), and its git
 * branch when it is a git checkout. `agentsFile` opens AGENTS.md in the person's editor (Kate, else the system's default), creating a short
 * starting file first when the project has none.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { refusedFolder } from './chat-files.mjs';

export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'QWEN.md', 'GEMINI.md', 'AGENTS.local.md'];
const MAX = 40;

const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };

function branchOf(dir) {
  try {
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 8);
  } catch { return null; }
}

/** The starting AGENTS.md: the headings a good one has, each with a line on what goes there. */
export function agentsTemplate(name) {
  return `# ${name}

Instructions for AI coding agents working in this repository (Strata, Codex, Claude Code, Qwen Code and others read this file).

## What this project is

<!-- One or two sentences: what it does and who uses it. -->

## Commands

<!-- The exact commands, copy-pasteable. -->
- Install:
- Build:
- Test (all / one file):
- Lint and format:
- Run:

## Layout

<!-- The folders that matter and what is in them. -->

## Conventions

<!-- Style the linters do not enforce: naming, error handling, comments, patterns to follow or avoid. -->

## Rules

<!-- What must never be done: files not to edit, generated code, secrets, commands not to run. -->

## Checking a change

<!-- What to run before saying a change is done, and what passing looks like. -->
`;
}

export function createProjects({ file, seed = [] }) {
  let list = [];
  try { const saved = JSON.parse(readFileSync(file, 'utf8'))?.projects; if (Array.isArray(saved)) list = saved.filter(p => p && typeof p.path === 'string'); } catch { /* first run */ }
  for (const p of seed) if (typeof p === 'string' && !list.some(x => x.path === p)) list.push({ path: p, usedAt: null });
  const save = () => {
    try { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify({ projects: list }, null, 2)); renameSync(tmp, file); } catch { /* kept in memory */ }
  };
  if (seed.length) save();
  const check = dir => {
    const target = resolve(String(dir ?? '').trim());
    if (!String(dir ?? '').trim() || !isDir(target)) throw new Error("That folder doesn't exist.");
    const why = refusedFolder(target);
    if (why) throw new Error(why);
    return target;
  };
  return {
    list() {
      return list.map(p => {
        const exists = isDir(p.path);
        return { path: p.path, name: basename(p.path) || p.path, usedAt: p.usedAt, exists, branch: exists ? branchOf(p.path) : null,
          instructions: exists ? INSTRUCTION_FILES.filter(f => existsSync(join(p.path, f))) : [] };
      });
    },
    /** A chat now works in this folder: it moves to the top. */
    touch(dir) {
      const target = check(dir);
      list = [{ path: target, usedAt: new Date().toISOString() }, ...list.filter(p => p.path !== target)].slice(0, MAX);
      save();
    },
    add(dir) { const target = check(dir); if (!list.some(p => p.path === target)) { list = [{ path: target, usedAt: null }, ...list].slice(0, MAX); save(); } },
    remove(dir) { list = list.filter(p => p.path !== dir); save(); },
    /** Open AGENTS.md in an editor, creating the starting file when the project has none. */
    openAgentsFile(dir, { editor = process.env.STRATA_EDITOR || 'kate' } = {}) {
      const target = check(dir);
      const path = join(target, 'AGENTS.md');
      let created = false;
      if (!existsSync(path)) { writeFileSync(path, agentsTemplate(basename(target))); created = true; }
      const open = cmd => new Promise(ok => {
        try {
          const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore' });
          child.once('error', () => ok(false));
          child.once('spawn', () => { child.unref(); ok(true); });
        } catch { ok(false); }
      });
      return open([editor, path]).then(async ok => ({ path, created, opened: ok || await open([process.platform === 'darwin' ? 'open' : 'xdg-open', path]) }));
    },
  };
}
