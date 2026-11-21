import { useEffect, useRef, useState } from 'react';
import { tr } from '../lib/i18n';
import type { Session } from '../lib/types';
import { atBottom, thoughtDuration } from '../lib/reasoning';
import { thoughtsReply } from '../lib/thoughts';
import { Icon, IconBtn } from './ui';

/**
 * The model's thinking, live, in the side panel (Settings → Appearance → Chat activity → "Live in a side panel"). It shows the newest reply's
 * thinking as it is written and follows the newest line unless you scroll up to read.
 */
export function ThoughtsPanel({ session, onClose }: { session: Session; onClose: () => void }) {
  const reply = thoughtsReply(session.messages);
  const text = reply?.reasoning ?? '';
  const live = !!reply?.streaming;
  const body = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  useEffect(() => { setStick(true); }, [reply?.id]);
  useEffect(() => { if (stick && body.current) body.current.scrollTop = body.current.scrollHeight; }, [text, stick]);
  const took = thoughtDuration(reply?.reasoningMs);
  const status = live ? tr('Thinking · updates live') : took ? tr('Thought for {0}', [took]) : text ? tr('Last reply') : tr('Nothing yet');
  return <aside className="ts-panel thoughts-panel" id="thoughts-content" aria-label={tr('Model thinking')}>
    <div className="helper-convo__head">
      <div className="helper-convo__title"><b><Icon name="thinking" size={15}/> {tr('Thinking')}</b>
        <span className="xs muted">{live ? <span className="agent-live-dot" /> : null}{status}</span></div>
      <IconBtn name="x" title={tr('Close')} onClick={onClose} size={16} />
    </div>
    <div className="thoughts-panel__body" ref={body} tabIndex={0} aria-live="off" onScroll={e => setStick(atBottom(e.currentTarget))}>
      {text ? text : <p className="small muted">{tr('The model’s thinking shows here while it works.')}</p>}
    </div>
    {live && !stick ? <button type="button" className="rz__jump thoughts-panel__jump" onClick={() => setStick(true)}><Icon name="chevron" size={11}/>{tr('Jump to latest')}</button> : null}
  </aside>;
}
