import { tr } from '../lib/i18n';
/**
 * Recent projects, on a new Code chat's start screen (server/projects.mjs). Pick one and the chat works in that folder. Each project also
 * opens its AGENTS.md in the editor (created from a short template when missing), or has the assistant write one: a Code chat in that
 * folder that reads the project first, asks only what the code cannot tell it, and writes the file.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/client';
import { chooseChatFolder, setChatFolder, useChatFolder } from '../lib/chat-folder';
import { pushToast, sendMessage } from '../lib/store';
import { plainFailureText } from '../lib/plain-errors';
import type { Session } from '../lib/types';
import { Btn, Icon, IconBtn } from './ui';

interface Project { path: string; name: string; usedAt: string | null; exists: boolean; branch: string | null; instructions: string[] }

/** What the assistant is asked when it writes a project's AGENTS.md. */
export const AGENTS_FILE_PROMPT = `Write an AGENTS.md for this project: the instructions every AI coding agent (you included) reads before working here.

1. Look first. Explore the project yourself: the README, build and package files (package.json, pyproject.toml, Cargo.toml, go.mod, Makefile, CMakeLists.txt, ...), CI workflows, test folders, linter and formatter configs, any existing AGENTS.md / CLAUDE.md / QWEN.md / .cursorrules / copilot-instructions.md, and the recent git log for the commit style. Explore with the glob, grep and read tools (they need no approval); use the shell only to run a command such as the tests, one command per call.
2. Then ask me only what the code cannot tell you, with the ask_user_question tool: one round, at most 6 questions, each with likely answers to pick from. Worth asking: what the project is for and who uses it; which commands are the real ones when there are several; files, folders or generated code agents must never edit; what must pass before a change counts as done; preferences the linters do not enforce; known traps; whether agents may commit, push or install packages; and whether I also use tools that read their own file (Claude Code: CLAUDE.md, Qwen Code: QWEN.md, Gemini CLI: GEMINI.md).
3. Write AGENTS.md at the project root. Short and specific, under about 150 lines: exact copy-pasteable commands, the layout that matters, conventions, hard rules, how to check a change. Leave out generic advice any agent already knows. If an AGENTS.md exists, improve it and keep what is still true.
4. For each other tool I use, add a one-line pointer file instead of a copy (CLAUDE.md containing "@AGENTS.md"; QWEN.md or GEMINI.md saying "Read AGENTS.md.").
5. End with a short summary of what you wrote.`;

const ago = (iso: string | null) => {
  if (!iso) return tr('added');
  const d = (Date.now() - Date.parse(iso)) / 86_400_000;
  return d < 1 ? tr('today') : d < 2 ? tr('yesterday') : tr('{0} days ago', [Math.floor(d)]);
};

/** `simple`: only picking a folder (Vibe's start screen), without the AGENTS.md buttons. */
export function RecentProjects({ session, simple = false }: { session: Session; simple?: boolean }) {
  const current = useChatFolder(session.id);
  const [list, setList] = useState<Project[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<{ projects: Project[] }>('/api/projects').then(r => setList(r.projects), () => setList([]));
  useEffect(() => { void load(); }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e) { pushToast('error', tr('That did not work'), plainFailureText(e instanceof Error ? e.message : String(e)).message); }
    finally { setBusy(false); void load(); }
  };
  const use = (p: Project) => run(() => setChatFolder(session.id, p.path));
  const write = (p: Project) => run(async () => {
    await setChatFolder(session.id, p.path);
    await sendMessage(AGENTS_FILE_PROMPT, { shown: tr('Write an AGENTS.md for this project.'), title: `AGENTS.md · ${p.name}` });
  });
  const edit = (p: Project) => run(async () => {
    const r = await api.post<{ path: string; created: boolean; opened: boolean }>('/api/projects/agents-file', { path: p.path });
    pushToast(r.opened ? 'success' : 'info', r.created ? tr('Created {0}', [r.path]) : tr('Opened {0}', [r.path]), r.opened ? undefined : tr('No editor could be started. Open the file yourself.'));
  });
  if (list === null) return <p className="small muted">{tr('Loading…')}</p>;
  return <div className="projects">
    {!list.length ? <p className="small muted">{tr('No projects yet. Pick a folder: it is listed here from then on.')}</p> : null}
    {list.map(p => {
      const on = current?.path === p.path;
      const agents = p.instructions.includes('AGENTS.md');
      return <div key={p.path} className="projects__row" data-current={on || undefined} data-missing={!p.exists || undefined}>
        <button type="button" className="projects__main" disabled={busy || !p.exists} onClick={() => void use(p)} title={p.path}>
          <Icon name={on ? 'check' : 'folder'} size={16} />
          <span className="projects__name">{p.name}</span>
          <span className="projects__meta xs muted">{p.exists ? <>{p.branch ? `${p.branch} · ` : ''}{p.instructions.length ? p.instructions.join(', ') : tr('no agent instructions')} · {ago(p.usedAt)}</> : tr('folder not found')}</span>
        </button>
        {p.exists && !simple ? <>
          <Btn size="sm" variant="ghost" disabled={busy} title={tr(agents ? 'Open AGENTS.md in your editor' : 'Create AGENTS.md from a template and open it')} onClick={() => void edit(p)}>{tr(agents ? 'Edit AGENTS.md' : 'New AGENTS.md')}</Btn>
          <Btn size="sm" variant="ghost" disabled={busy || session.messages.length > 0} title={tr('The assistant reads the project, asks you what it cannot find out, and writes AGENTS.md')} onClick={() => void write(p)}>{tr(agents ? 'Improve with the assistant' : 'Write with the assistant')}</Btn>
        </> : null}
        <IconBtn name="x" title={tr('Remove from the list')} onClick={() => void run(() => api.del(`/api/projects?path=${encodeURIComponent(p.path)}`))} size={14} />
      </div>;
    })}
    {simple ? null : <div style={{ marginTop: 10 }}><Btn size="sm" icon="folder-plus" disabled={busy} onClick={() => void run(() => chooseChatFolder(session.id))}>{tr('Open another folder…')}</Btn></div>}
  </div>;
}
