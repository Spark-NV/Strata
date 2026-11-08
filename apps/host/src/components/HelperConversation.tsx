import { tr } from '../lib/i18n';
/**
 * One helper's conversation in the side panel ("View conversation" in the Subagents list): the Head's task and messages, what the helper
 * says, its messages back and its report, with one short line per command it ran. File edits and tool output are left out
 * (server/agent/helper-transcript.mjs). Read-only: the page only reads the helper's saved session, so watching never changes its work.
 * While the helper works the panel asks for new lines every two seconds and follows the end when you are at the bottom.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../lib/client';
import type { Session } from '../lib/types';
import { Markdown } from './Markdown';
import { IconBtn } from './ui';

/** The event a helper row sends to open its conversation (screens/Chat.tsx listens). */
export const OPEN_HELPER_CONVERSATION = 'strata:helper-conversation';
export interface HelperRef { id: string; name: string }
export const openHelperConversation = (helper: HelperRef) => window.dispatchEvent(new CustomEvent<HelperRef>(OPEN_HELPER_CONVERSATION, { detail: helper }));
export const helperTabId = (id: string) => `helper:${id}`;

type Kind = 'task' | 'from-head' | 'from-helper' | 'to-agent' | 'says' | 'report' | 'review' | 'step' | 'thinking';
interface Item { seq: number; at: number; kind: Kind; text: string; detail?: string }
interface Reply { id: string; name: string; running: boolean; updatedAt: number; last: number; items: Item[] }

const WHO: Record<Kind, string> = {
  task: 'The Head’s task', 'from-head': 'From the Head', 'from-helper': 'From another helper', 'to-agent': 'Message to the Head',
  says: 'Helper', report: 'Report to the Head', review: 'Review', step: '', thinking: 'Thinking',
};
const LIVE_MS = 2000;
const time = (ms: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const pref = (key: string, fallback: boolean) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; } };
const keep = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* private window */ } };

export function HelperConversation({ session, helper, onClose }: { session: Session; helper: HelperRef; onClose: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [info, setInfo] = useState<{ name: string; running: boolean; updatedAt: number } | null>(null);
  const [problem, setProblem] = useState('');
  const [steps, setSteps] = useState(() => pref('strata.helperView.steps', true));
  const [thinking, setThinking] = useState(() => pref('strata.helperView.thinking', false));
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  // The row's own status, so a helper that finished is read once more (its last words become its report) and then left alone.
  const rowStatus = session.agents?.find(a => a.id === helper.id)?.status;

  useEffect(() => {
    let live = true, last = -1, timer = 0, wasRunning = false;
    setItems([]); setInfo(null); setProblem(''); atEnd.current = true;
    const load = async () => {
      try {
        const r = await api.get<Reply>(`/api/chat/helper/conversation?sessionId=${encodeURIComponent(session.id)}&helperId=${encodeURIComponent(helper.id)}&after=${last}`);
        if (!live) return;
        // When the helper stops, its last words are relabelled as its report: read the whole conversation once more.
        if (wasRunning && !r.running && last >= 0) { last = -1; wasRunning = false; return void load(); }
        setItems(prev => (last < 0 ? r.items : [...prev, ...r.items]));
        last = r.last; wasRunning = r.running;
        setInfo({ name: r.name, running: r.running, updatedAt: r.updatedAt }); setProblem('');
        if (r.running) timer = window.setTimeout(load, LIVE_MS);
      } catch (e) {
        if (!live) return;
        setProblem(e instanceof Error ? e.message : String(e));
        timer = window.setTimeout(load, LIVE_MS * 3);
      }
    };
    void load();
    return () => { live = false; window.clearTimeout(timer); };
  }, [session.id, helper.id, rowStatus]);

  // Follow new lines only when you were already at the bottom; scrolling up to read stops the follow.
  useLayoutEffect(() => { const el = scroller.current; if (el && atEnd.current) el.scrollTop = el.scrollHeight; }, [items, steps, thinking]);
  const onScroll = () => { const el = scroller.current; if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };

  const shown = items.filter(i => (i.kind === 'step' ? steps : i.kind === 'thinking' ? thinking : true));
  const name = info?.name || helper.name;
  return <aside className="ts-panel helper-convo" id="helper-content" aria-label={tr('Conversation with {0}', [name])}>
    <div className="helper-convo__head">
      <div className="helper-convo__title"><b title={name}>{name}</b>
        <span className="xs muted">{info ? (info.running ? <><span className="agent-live-dot" />{tr('Working · updates live')}</> : tr('Finished · last activity {0}', [time(info.updatedAt)])) : tr('Loading…')}</span></div>
      <IconBtn name="x" title={tr('Close')} onClick={onClose} size={16} />
    </div>
    <div className="helper-convo__opts xs">
      <label><input type="checkbox" checked={steps} onChange={e => { setSteps(e.target.checked); keep('strata.helperView.steps', e.target.checked); }} />{tr('Commands')}</label>
      <label><input type="checkbox" checked={thinking} onChange={e => { setThinking(e.target.checked); keep('strata.helperView.thinking', e.target.checked); }} />{tr('Thinking')}</label>
      <span className="muted">{tr('Read-only: watching does not change the helper’s work.')}</span>
    </div>
    <div className="helper-convo__list" ref={scroller} onScroll={onScroll}>
      {problem && !items.length ? <p className="small inline-error">{problem}</p> : null}
      {info && !shown.length ? <p className="small muted">{tr('Nothing said yet.')}</p> : null}
      {shown.map((i, n) => i.kind === 'step'
        ? <div key={`${i.seq}-${n}`} className="helper-convo__step xs" title={i.detail}><span>›</span>{i.text}</div>
        : i.kind === 'thinking'
          ? <details key={`${i.seq}-${n}`} className="helper-convo__think"><summary className="xs muted">{tr('Thinking')} · {time(i.at)}</summary><div className="document-markdown small"><Markdown text={i.text} /></div></details>
          : <div key={`${i.seq}-${n}`} className="helper-convo__msg" data-kind={i.kind}>
            <div className="xs muted helper-convo__who">{tr(WHO[i.kind])}{i.kind === 'says' ? ` · ${name}` : ''} · {time(i.at)}</div>
            <div className="document-markdown"><Markdown text={i.text} /></div>
          </div>)}
    </div>
  </aside>;
}
