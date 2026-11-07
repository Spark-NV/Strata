import { tr } from '../lib/i18n';
/**
 * A roleplay chat on screen: each message with its speaker's picture and name, swipes (‹ 2/5 ›, past the last one writes a new
 * version), edit in place, delete, hide from the prompt; and the bar above the chat: the cast (click a member to make them speak),
 * the persona, the author's note, the chat's lorebooks, Impersonate, Continue and the prompt inspector.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { branchFrom, useStore } from '../lib/store';
import { avatarUrl, rpDeleteMessage, rpDeleteSwipe, rpEditMessage, rpGenerate, rpPreview, rpSwipe, rpToggleHidden, setRpChat, useRpLibrary } from '../lib/rp';
import type { ChatMessage, RpAuthorsNote, RpCharacter, Session } from '../lib/types';
import { RpEditor, RpText } from './RpEditor';
import { ReasoningBlock } from './ReasoningBlock';
import { CopyBtn } from './CopyBtn';
import { FloatingMenu } from './FloatingMenu';
import { Btn, Dialog, ErrorNotice, Field, Icon, IconBtn, Select } from './ui';
import { go } from '../lib/store';

export function RpAvatar({ kind, id, name, has, size = 36 }: { kind: 'characters' | 'personas'; id?: string | null; name: string; has?: boolean; size?: number }) {
  const initials = name.split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
  return <span className="rp-avatar" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
    {has && id ? <img src={avatarUrl(kind, id)} alt="" loading="lazy" /> : initials}
  </span>;
}

function Menu({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return <><button ref={ref} className="st-btn st-btn--icon" aria-label={tr(label)} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}><Icon name="ellipsis" size={16} /></button>
    {open ? <FloatingMenu anchor={ref.current} title={tr(label)} onClose={() => setOpen(false)}><div onClick={() => setOpen(false)}>{children}</div></FloatingMenu> : null}</>;
}

function RpMessageView({ m, session, isLast }: { m: ChatMessage; session: Session; isLast: boolean }) {
  const lib = useRpLibrary();
  const streaming = useStore(s => s.streaming);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  useEffect(() => { if (!editing) setText(m.content); }, [m.content, editing]);
  const user = m.role === 'user';
  const persona = lib?.personas.find(p => p.id === (session.rp?.personaId ?? lib.settings.defaultPersonaId));
  const char: RpCharacter | undefined = !user ? lib?.characters.find(c => c.id === m.characterId) ?? (session.rp?.characterIds.length === 1 ? lib?.characters.find(c => c.id === session.rp!.characterIds[0]) : undefined) : undefined;
  const name = user ? m.name || persona?.name || lib?.settings.userName || 'You' : char?.name || m.name || 'Assistant';
  const swipes = m.swipes?.length ?? 1, idx = m.swipeIndex ?? 0;
  const greeting = !user && !session.messages.slice(0, session.messages.findIndex(x => x.id === m.id)).some(x => x.role === 'user');
  const canNew = !user && isLast && !greeting;
  const save = () => { rpEditMessage(session.id, m.id, text); setEditing(false); };
  return <div className={`rp-msg${user ? ' rp-msg--user' : ''}${m.hidden ? ' rp-msg--hidden' : ''}`} data-message-id={m.id}>
    <RpAvatar kind={user ? 'personas' : 'characters'} id={user ? persona?.id : char?.id} name={name} has={user ? persona?.avatar : char?.avatar} size={40} />
    <div className="rp-msg__body">
      <div className="rp-msg__head">
        <strong>{name}</strong>
        {m.hidden ? <span className="xs muted">{tr('Hidden from the prompt')}</span> : null}
        <span className="rp-msg__actions">
          {!editing ? <IconBtn name="pencil" title={tr('Edit')} disabled={m.streaming} onClick={() => { setText(m.content); setEditing(true); }} size={16} /> : null}
          <CopyBtn text={m.content} label="Message" title="Copy message" />
          <Menu label="More message actions">
            <button role="menuitem" className="menu__item" onClick={() => rpToggleHidden(session.id, m.id)}>{tr(m.hidden ? 'Show to the model again' : 'Hide from the model')}</button>
            <button role="menuitem" className="menu__item" onClick={() => branchFrom(m.id)}><Icon name="branch" />{tr('Branch from here')}</button>
            {!user && swipes > 1 ? <button role="menuitem" className="menu__item" onClick={() => rpDeleteSwipe(session.id, m.id)}>{tr('Delete this version')}</button> : null}
            <button role="menuitem" className="menu__item" onClick={() => rpDeleteMessage(session.id, m.id)}><Icon name="trash" />{tr('Delete message')}</button>
            {!isLast ? <button role="menuitem" className="menu__item" onClick={() => rpDeleteMessage(session.id, m.id, true)}>{tr('Delete this and everything after')}</button> : null}
            {m.tokens || m.tps || m.durationMs ? <p className="xs muted response-stats">{m.tokens ? `${m.tokens} tokens` : ''}{m.tps ? ` · ${m.tps.toFixed(1)} tok/s` : ''}</p> : null}
          </Menu>
        </span>
      </div>
      {m.reasoning ? <ReasoningBlock message={m} /> : null}
      {editing ? <div className="rp-edit">
        <div onKeyDown={e => { if (e.key === 'Escape') setEditing(false); }}><RpEditor value={text} onChange={setText} onSubmit={save} autoFocus label="Edit message" /></div>
        <div className="row" style={{ gap: 8 }}><Btn variant="primary" size="sm" onClick={save}>{tr('Save')}</Btn><Btn size="sm" onClick={() => setEditing(false)}>{tr('Cancel')}</Btn></div>
      </div> : <div className="rp-msg__text">
        {m.error ? <ErrorNotice message={m.error} /> : null}
        {m.content ? <RpText text={m.content} /> : m.streaming ? <span className="typing" aria-label={tr('Generating')}><i /><i /><i /></span> : null}
        {m.streaming && m.content ? <span className="caret" aria-hidden="true" /> : null}
      </div>}
      {!user && (swipes > 1 || canNew) && !editing ? <div className="rp-swipes">
        <IconBtn name="chevron" title={tr('Previous version')} disabled={idx === 0 || streaming} onClick={() => void rpSwipe(session.id, m.id, -1)} size={16} />
        <span className="xs muted">{idx + 1}/{swipes}</span>
        <IconBtn name="chevron" title={tr(idx === swipes - 1 && canNew ? 'Write another version' : 'Next version')} disabled={streaming || (idx === swipes - 1 && !canNew)} onClick={() => void rpSwipe(session.id, m.id, 1)} size={16} />
      </div> : null}
    </div>
  </div>;
}
export const RpMessage = memo(RpMessageView);

function AuthorsNoteDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const lib = useRpLibrary();
  const [note, setNote] = useState<RpAuthorsNote>(session.rp?.authorsNote ?? lib?.settings.authorsNote ?? { text: '', depth: 4, interval: 1, role: 'system', position: 'depth' });
  return <Dialog open title={tr("Author's note")} onClose={onClose} actions={<><Btn onClick={onClose}>{tr('Cancel')}</Btn><Btn variant="primary" onClick={() => { setRpChat(session.id, { authorsNote: note }); onClose(); }}>{tr('Save')}</Btn></>}>
    <p className="small muted" style={{ marginBottom: 10 }}>{tr('A note to the model that stays close to the end of the chat, so it keeps steering: the tone, where the story is going, what to remember. Macros like {{char}} work.')}</p>
    <textarea className="st-input" rows={6} style={{ width: '100%' }} value={note.text} onChange={e => setNote({ ...note, text: e.target.value })} placeholder={tr('[Style: slow-burn, descriptive. Mira is hiding that she knows the captain.]')} />
    <div className="st-card st-card--flush" style={{ marginTop: 12 }}>
      <Field label={tr('Where')} hint={tr('In the chat: this many messages from the end (0 is after the last one). Top: after the scenario.')}>
        <Select value={note.position} onChange={v => setNote({ ...note, position: v })} options={[{ value: 'depth', label: 'In the chat, at a depth' }, { value: 'top', label: 'Top, after the scenario' }, { value: 'bottom', label: 'Before the chat' }]} ariaLabel={tr('Where')} />
      </Field>
      <Field label={tr('Depth')}><input className="st-input" type="number" min={0} style={{ width: 90 }} value={note.depth} onChange={e => setNote({ ...note, depth: Math.max(0, Number(e.target.value) | 0) })} /></Field>
      <Field label={tr('Every N of your messages')} hint={tr('1: always. 0: never.')}><input className="st-input" type="number" min={0} style={{ width: 90 }} value={note.interval} onChange={e => setNote({ ...note, interval: Math.max(0, Number(e.target.value) | 0) })} /></Field>
      <Field label={tr('Sent as')}><Select value={note.role} onChange={v => setNote({ ...note, role: v })} options={[{ value: 'system', label: 'System' }, { value: 'user', label: 'User' }, { value: 'assistant', label: 'Assistant' }]} ariaLabel={tr('Sent as')} /></Field>
    </div>
  </Dialog>;
}

type Preview = Awaited<ReturnType<typeof rpPreview>>;
const PIECE_LABELS: Record<string, string> = { main: 'Main prompt', formatting: 'Text format', worldInfoBefore: 'World Info (before)', personaDescription: 'Persona', charDescription: 'Description', charPersonality: 'Personality', scenario: 'Scenario', auxiliary: 'Auxiliary', worldInfoAfter: 'World Info (after)', dialogueExamples: 'Examples', chatHistory: 'Chat', postHistory: 'Post-history' };
const pieceLabel = (p = '') => p.split(' + ').map(x => PIECE_LABELS[x] ?? x).join(' + ');
function InspectorDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [data, setData] = useState<Preview | null>(null), [err, setErr] = useState('');
  useEffect(() => { rpPreview(session).then(setData, e => setErr(e instanceof Error ? e.message : String(e))); }, [session.id]);
  return <Dialog open wide title={tr('Prompt inspector')} onClose={onClose}>
    {err ? <ErrorNotice message={err} /> : !data ? <p className="muted">{tr('Building the prompt…')}</p> : <div className="stack">
      <p className="small">{tr('Next speaker: {0}. About {1} tokens of a {2}-token window ({3} kept free for the reply).', [data.speaker.name, data.info.tokens.toLocaleString(), data.info.window.toLocaleString(), data.info.reserve.toLocaleString()])}
        {data.info.droppedMessages ? ' ' + tr('{0} older messages did not fit and were left out.', [data.info.droppedMessages]) : ''}
        {data.info.exampleBlocks ? ' ' + tr('Example dialogues: {0} of {1}.', [data.info.examples, data.info.exampleBlocks]) : ''}</p>
      <details open><summary className="h5">{tr('World Info: {0} entries, {1} tokens', [data.info.worldInfo.activated.length, data.info.worldInfo.tokens])}</summary>
        <ul className="small">{data.info.worldInfo.activated.map((a, i) => <li key={i}>{a.book} · {a.comment || '—'} · {a.position} · {a.tokens}</li>)}</ul>
        {data.info.worldInfo.dropped.length ? <p className="small muted">{tr('Over the budget, left out: {0}', [data.info.worldInfo.dropped.map(d => d.comment).join(', ')])}</p> : null}
      </details>
      <details><summary className="h5">{tr('Stop strings')}</summary><code className="small">{JSON.stringify(data.stop)}</code></details>
      <h3 className="h5">{tr('Messages')}</h3>
      {data.messages.map((msg, i) => <details key={i} className="rp-inspect" open={msg.role === 'system' && i === 0}>
        <summary><span className="xs muted">{msg.role}</span> {pieceLabel(data.info.pieces[i]?.piece)} <span className="xs muted">· {data.info.pieces[i]?.tokens}</span></summary>
        <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</pre>
      </details>)}
    </div>}
  </Dialog>;
}

function LorebooksDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const lib = useRpLibrary();
  const [ids, setIds] = useState<string[]>(session.rp?.lorebookIds ?? []);
  const global = new Set(lib?.settings.worldInfo.globalBooks ?? []);
  return <Dialog open title={tr('Lorebooks in this chat')} onClose={onClose} actions={<><Btn onClick={() => go('characters', 'lorebooks')}>{tr('Edit lorebooks')}</Btn><Btn variant="primary" onClick={() => { setRpChat(session.id, { lorebookIds: ids }); onClose(); }}>{tr('Save')}</Btn></>}>
    <p className="small muted" style={{ marginBottom: 10 }}>{tr('Ticked lorebooks are scanned in this chat, beside the global ones (Settings → Roleplay) and the characters’ own.')}</p>
    {!lib?.lorebooks.length ? <p className="muted">{tr('No lorebooks yet.')}</p> : lib.lorebooks.map(b => <label key={b.id} className="row" style={{ gap: 8, padding: '4px 0' }}>
      <input type="checkbox" checked={ids.includes(b.id) || global.has(b.id)} disabled={global.has(b.id)} onChange={e => setIds(e.target.checked ? [...ids, b.id] : ids.filter(x => x !== b.id))} />
      <span>{b.name}</span><span className="xs muted">{tr('{0} entries', [b.entries.length])}{global.has(b.id) ? ` · ${tr('global')}` : ''}</span>
    </label>)}
  </Dialog>;
}

function CastDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const lib = useRpLibrary();
  const [ids, setIds] = useState<string[]>(session.rp?.characterIds ?? []);
  const [muted, setMuted] = useState<string[]>(session.rp?.muted ?? []);
  return <Dialog open title={tr('Characters in this chat')} onClose={onClose} actions={<Btn variant="primary" disabled={!ids.length} onClick={() => { setRpChat(session.id, { characterIds: ids, muted: muted.filter(x => ids.includes(x)) }); onClose(); }}>{tr('Save')}</Btn>}>
    <p className="small muted" style={{ marginBottom: 10 }}>{tr('Two or more make a group chat. A muted member only speaks when you pick them.')}</p>
    {(lib?.characters ?? []).map(c => <div key={c.id} className="row" style={{ gap: 10, padding: '4px 0' }}>
      <input type="checkbox" aria-label={c.name} checked={ids.includes(c.id)} onChange={e => setIds(e.target.checked ? [...ids, c.id] : ids.filter(x => x !== c.id))} />
      <RpAvatar kind="characters" id={c.id} name={c.name} has={c.avatar} size={28} /><span style={{ flex: 1 }}>{c.name}</span>
      {ids.includes(c.id) && ids.length > 1 ? <label className="xs row" style={{ gap: 4 }}><input type="checkbox" checked={muted.includes(c.id)} onChange={e => setMuted(e.target.checked ? [...muted, c.id] : muted.filter(x => x !== c.id))} />{tr('Muted')}</label> : null}
    </div>)}
  </Dialog>;
}

/** The bar above a roleplay chat. */
export function RpBar({ session }: { session: Session }) {
  const lib = useRpLibrary();
  const streaming = useStore(s => s.streaming);
  const [dialog, setDialog] = useState<'note' | 'inspect' | 'books' | 'cast' | null>(null);
  if (!session.rp) return null;
  const cast = session.rp.characterIds.map(id => lib?.characters.find(c => c.id === id)).filter((c): c is RpCharacter => !!c);
  const group = cast.length > 1;
  const personaId = session.rp.personaId ?? lib?.settings.defaultPersonaId ?? '';
  const noteOn = !!session.rp.authorsNote?.text?.trim();
  const books = session.rp.lorebookIds?.length ?? 0;
  return <div className="rp-bar">
    <div className="rp-bar__cast">
      {cast.map(c => <button key={c.id} className="rp-bar__member" title={group ? tr('Make {0} speak now', [c.name]) : c.name} disabled={streaming || !group}
        data-muted={session.rp?.muted?.includes(c.id) || undefined} onClick={() => void rpGenerate(session.id, 'normal', { speakerId: c.id })}>
        <RpAvatar kind="characters" id={c.id} name={c.name} has={c.avatar} size={30} />{!group ? <span>{c.name}</span> : null}
      </button>)}
      {!cast.length ? <span className="small muted">{tr('The character of this chat was deleted.')}</span> : null}
      <IconBtn name="plus" title={tr('Characters in this chat')} onClick={() => setDialog('cast')} size={16} />
    </div>
    <div className="rp-bar__tools">
      <Select value={personaId || '__default'} onChange={v => setRpChat(session.id, { personaId: v === '__default' ? null : v })} ariaLabel={tr('Your persona')} translateLabels={false}
        options={[{ value: '__default', label: `${tr('Persona')}: ${lib?.settings.userName ?? 'User'}` }, ...(lib?.personas ?? []).map(p => ({ value: p.id, label: `${tr('Persona')}: ${p.name}` }))]} />
      <Btn size="sm" active={noteOn} onClick={() => setDialog('note')}>{tr("Author's note")}</Btn>
      <Btn size="sm" active={books > 0} onClick={() => setDialog('books')}>{books ? tr('Lorebooks ({0})', [books]) : tr('Lorebooks')}</Btn>
      <Btn size="sm" disabled={streaming} title={tr('The model writes your next message into the box')} onClick={() => void rpGenerate(session.id, 'impersonate')}>{tr('Impersonate')}</Btn>
      <Btn size="sm" disabled={streaming || session.messages[session.messages.length - 1]?.role !== 'assistant'} onClick={() => void rpGenerate(session.id, 'continue')}>{tr('Continue')}</Btn>
      {group ? <Btn size="sm" disabled={streaming} title={tr('The next character speaks without a message from you')} onClick={() => void rpGenerate(session.id, 'normal')}>{tr('Next speaker')}</Btn> : null}
      <IconBtn name="search" title={tr('Prompt inspector')} onClick={() => setDialog('inspect')} size={16} />
    </div>
    {dialog === 'note' ? <AuthorsNoteDialog session={session} onClose={() => setDialog(null)} /> : null}
    {dialog === 'inspect' ? <InspectorDialog session={session} onClose={() => setDialog(null)} /> : null}
    {dialog === 'books' ? <LorebooksDialog session={session} onClose={() => setDialog(null)} /> : null}
    {dialog === 'cast' ? <CastDialog session={session} onClose={() => setDialog(null)} /> : null}
  </div>;
}

/** Shown in an RP chat that has no character yet. */
export function RpEmpty() {
  return <div className="rp-empty">
    <p>{tr('Pick a character to start a roleplay, or import a SillyTavern card (PNG or JSON).')}</p>
    <Btn variant="primary" icon="skills" onClick={() => go('characters')}>{tr('Open characters')}</Btn>
  </div>;
}
