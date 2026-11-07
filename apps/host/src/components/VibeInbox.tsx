import { tr } from '../lib/i18n';
/**
 * A Vibe chat's answer panel: what the Head is waiting for, with room to read it. Opened from the pulsing "Needs your answer" button in
 * the Vibe bar (or the line that stands in for the dock above the message box). It shows the Head's latest message as formatted text,
 * its questions (the same cards as the dock, wider), and for the brief the whole BRIEF.md with Approve, Deny, or changes in your own words.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/client';
import { pendingApprovals } from '../lib/approvals';
import { askQuestion } from '../lib/ask';
import { resolveTool, sendMessage, useStore } from '../lib/store';
import type { AgentAsk } from '../lib/agent-ask';
import type { Session } from '../lib/types';
import { ApprovalCard } from './ApprovalCard';
import { Markdown } from './Markdown';
import { QuestionCard } from './QuestionCard';
import { Btn, Icon, IconBtn } from './ui';

const NO_ASKS: AgentAsk[] = [];
/** The event the bar and the dock line send to open the panel (screens/Chat.tsx listens). */
export const OPEN_VIBE_INBOX = 'strata:vibe-inbox';
export const openVibeInbox = () => window.dispatchEvent(new Event(OPEN_VIBE_INBOX));

/** How many things the Head is waiting for in this chat: its questions and its approval cards. */
export function useVibeWaiting(session: Session | null | undefined) {
  const asks = useStore(s => (session ? s.agentAsks[session.id] : undefined)) ?? NO_ASKS;
  const approvals = useMemo(() => pendingApprovals(session), [session]);
  return { asks, approvals, count: asks.length + approvals.length };
}

export function VibeInbox({ session, onClose }: { session: Session; onClose: () => void }) {
  const { asks, approvals, count } = useVibeWaiting(session);
  const lastText = useMemo(() => [...session.messages].reverse().find(m => m.role === 'assistant' && m.content?.trim())?.content ?? '', [session.messages]);
  const brief = approvals.find(a => a.tool.ask?.id === 'vibe-start');
  const others = approvals.filter(a => a !== brief);
  return <aside className="ts-panel vibe-inbox" id="vibe-content" aria-label={tr('Needs your answer')}>
    <div className="vibe-inbox__head"><b>{tr(count ? 'Needs your answer' : 'Nothing waiting')}</b><IconBtn name="x" title={tr('Close')} onClick={onClose} size={16} /></div>
    {!count ? <p className="small muted">{tr('The Head is not waiting for you right now. When it needs an answer, the Vibe bar shows it and it appears here.')}</p> : null}
    {count && lastText ? <section className="vibe-inbox__said"><p className="xs muted">{tr('What the Head says')}</p><div className="document-markdown"><Markdown text={lastText} /></div></section> : null}
    {brief ? <BriefDecision session={session} messageId={brief.messageId} toolId={brief.tool.id} summary={brief.tool.args?.summary} /> : null}
    {asks.map(a => <QuestionCard key={a.callId} sessionId={session.id} ask={a} />)}
    {others.map(({ messageId, tool }) => <div key={tool.id}><p className="xs muted">{tr(tool.ask ? askQuestion(tool.ask) : tool.name)}</p><ApprovalCard messageId={messageId} tool={tool} /></div>)}
  </aside>;
}

/** The brief, formatted, with the three ways to answer it. Changes in your own words: the card is denied and your words reach the Head as its next message. */
function BriefDecision({ session, messageId, toolId, summary }: { session: Session; messageId: string; toolId: string; summary?: unknown }) {
  const [text, setText] = useState<string | null>(null);
  const [changes, setChanges] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.get<{ text: string }>(`/api/vibe/book?chatId=${encodeURIComponent(session.id)}&page=brief`).then(r => { if (live) setText(r.text); }, () => { if (live) setText(''); });
    return () => { live = false; };
  }, [session.id, toolId]);
  const answer = async (yes: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (!yes && changes.trim()) await sendMessage(`Changes to the brief before you start:\n\n${changes.trim()}`);
      resolveTool(messageId, toolId, yes);
    } finally { setBusy(false); }
  };
  return <section className="vibe-inbox__brief">
    <div className="vibe-inbox__q"><Icon name="check" size={18} /><b>{tr('Approve the brief and start building?')}</b></div>
    {typeof summary === 'string' && summary.trim() ? <div className="document-markdown vibe-inbox__summary"><Markdown text={summary} /></div> : null}
    {text === null ? <p className="small muted">{tr('Loading…')}</p> : text ? <details className="vibe-inbox__full" open><summary>{tr('The whole brief')}</summary><div className="document-markdown"><Markdown text={text} /></div></details> : null}
    <textarea className="vibe-inbox__changes" rows={3} value={changes} disabled={busy} placeholder={tr('Want something different? Write it here and press Request changes.')} onChange={e => setChanges(e.target.value)} />
    <div className="vibe-inbox__acts">
      <Btn size="sm" disabled={busy} onClick={() => void answer(false)}>{tr(changes.trim() ? 'Request changes' : 'Deny')}</Btn>
      <Btn size="sm" variant="primary" disabled={busy || !!changes.trim()} onClick={() => void answer(true)}>{tr('Approve and build')}</Btn>
    </div>
  </section>;
}
