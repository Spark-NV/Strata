import { tr } from '../lib/i18n';
/**
 * The bar above a Vibe chat (server/agent/vibe-state.mjs, /api/vibe/state): which stage the project is in, its milestones, the last
 * check, and the three pages of the project book. Read-only: the Head AI keeps the book; the person only reads it.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/client';
import { pushToast, useStore } from '../lib/store';
import type { PreviewArtifact } from '../lib/artifacts';
import type { Session } from '../lib/types';
import { Btn, Icon } from './ui';
import { openVibeInbox, useVibeWaiting } from './VibeInbox';

interface VibeState {
  root: string | null; stage?: 'discover' | 'build' | 'done'; branch?: string | null; baseBranch?: string | null; title?: string; name?: string; size?: string | null; approved?: boolean;
  milestones?: { id: string; title: string; done: boolean }[]; requirements?: Record<'confirmed' | 'assumed' | 'open', number>;
  lastCheck?: { ok: boolean; at: string } | null; blocked?: 'ask' | 'rethink' | null; bookPath?: string | null;
}

const STAGE: Record<string, { label: string; hint: string }> = {
  discover: { label: 'Planning', hint: 'Understanding what you want and researching. Nothing in the project changes until you approve the brief.' },
  build: { label: 'Building', hint: 'You approved the brief. Helpers build it milestone by milestone, with a git save point at every step.' },
  done: { label: 'Handed over', hint: 'The last round is finished. Ask for the next change and a new round starts.' },
};

export function VibeBar({ session, onPreview }: { session: Session; onPreview: (a: PreviewArtifact) => void }) {
  const streaming = useStore(s => s.streaming);
  const waiting = useVibeWaiting(session).count;
  const [state, setState] = useState<VibeState | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.get<VibeState>(`/api/vibe/state?chatId=${encodeURIComponent(session.id)}`).then(s => { if (live) setState(s); }, () => {});
    void load();
    // While the Head works the stage and the milestones move: follow them; once it stopped, one more read catches the end.
    const timer = window.setInterval(load, streaming ? 8000 : 20000);
    return () => { live = false; if (timer) window.clearInterval(timer); };
  }, [session.id, streaming, session.messages.length]);

  const open = async (page: 'brief' | 'decisions' | 'status') => {
    try {
      const r = await api.get<{ title: string; text: string }>(`/api/vibe/book?chatId=${encodeURIComponent(session.id)}&page=${page}`);
      onPreview({ id: `vibe-${session.id}-${page}`, kind: 'markdown', title: r.title, content: r.text });
    } catch { pushToast('info', tr('No project book yet'), tr('The Head writes it once it understands what you want.')); }
  };

  const answerBtn = waiting ? <button type="button" className="vibe-bar__answer" onClick={openVibeInbox} title={tr('Open what the Head is waiting for')}><Icon name="chat" size={15} />{tr('Needs your answer')}{waiting > 1 ? ` (${waiting})` : ''}</button> : null;
  if (!state?.root) return <div className="vibe-bar vibe-bar--intro"><Icon name="bolt" size={16} /><span className="small">{tr('Vibe: describe what you want to exist. The Head asks what matters, writes a brief for you to approve, then builds, checks and hands it over. Pick a project folder first (an empty one for something new).')}</span></div>;
  const stage = STAGE[state.stage ?? 'discover'] ?? STAGE.discover;
  const ms = state.milestones ?? [];
  const done = ms.filter(m => m.done).length;
  const current = ms.find(m => !m.done);
  return <div className="vibe-bar" data-stage={state.stage}>
    <div className="vibe-bar__main">
      <span className="vibe-bar__stage" title={tr(stage.hint)}><Icon name={state.stage === 'build' ? 'engine' : state.stage === 'done' ? 'check' : 'thinking'} size={15} />{tr(stage.label)}</span>
      <strong className="vibe-bar__name" title={state.root}>{state.title || state.name}</strong>
      {ms.length ? <span className="vibe-bar__ms" title={ms.map(m => `${m.done ? '✓' : '○'} ${m.title}`).join('\n')}>
        <span className="vibe-bar__dots">{ms.map(m => <i key={m.id} data-done={m.done || undefined} data-current={m === current || undefined} />)}</span>
        <span className="xs muted">{tr('{0} of {1} milestones', [done, ms.length])}{current && state.stage === 'build' ? ` · ${current.title}` : ''}</span>
      </span> : null}
      {state.lastCheck ? <span className="vibe-bar__check xs" data-ok={state.lastCheck.ok || undefined}>{tr(state.lastCheck.ok ? 'Checks pass' : 'Checks failing')}</span> : null}
      {answerBtn}
      {state.branch && state.stage !== 'discover' ? <span className="xs muted vibe-bar__branch" title={tr('The work stays on this git branch until you accept it')}><Icon name="branch" size={13} />{state.branch}</span> : null}
    </div>
    {state.bookPath ? <div className="vibe-bar__tools">
      <Btn size="sm" variant="ghost" onClick={() => void open('brief')}>{tr('Brief')}</Btn>
      <Btn size="sm" variant="ghost" onClick={() => void open('decisions')}>{tr('Decisions')}</Btn>
      <Btn size="sm" variant="ghost" onClick={() => void open('status')}>{tr('Status')}</Btn>
    </div> : null}
  </div>;
}
