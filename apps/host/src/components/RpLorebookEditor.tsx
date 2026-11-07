import { tr } from '../lib/i18n';
/**
 * A lorebook (World Info) editor: the book's own settings and every entry with all of SillyTavern's fields. Controlled: the parent
 * keeps the book and saves it (a global lorebook, or the one inside a character).
 */
import { useState } from 'react';
import type { RpEntry, RpLorebook } from '../lib/types';
import { Btn, Field, IconBtn, Select } from './ui';

const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
const POSITIONS = [
  { value: 'before_char', label: 'Before the character' }, { value: 'after_char', label: 'After the character' },
  { value: 'an_top', label: "Before the author's note" }, { value: 'an_bottom', label: "After the author's note" },
  { value: 'em_top', label: 'Before the example dialogues' }, { value: 'em_bottom', label: 'After the example dialogues' },
  { value: 'depth', label: 'In the chat, at a depth' },
] as const;
const LOGIC = [{ value: 'and_any', label: 'And any of' }, { value: 'and_all', label: 'And all of' }, { value: 'not_any', label: 'And none of' }, { value: 'not_all', label: 'And not all of' }] as const;
const TRI = [{ value: 'default', label: 'Global setting' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] as const;
const tri = (v: boolean | null) => (v === null ? 'default' : v ? 'yes' : 'no');
const fromTri = (v: string) => (v === 'default' ? null : v === 'yes');

export function newEntry(uid: number): RpEntry {
  return { uid, comment: '', keys: [], secondaryKeys: [], selectiveLogic: 'and_any', content: '', constant: false, enabled: true, position: 'before_char', depth: 4, role: 'system', order: 100, probability: 100, caseSensitive: null, matchWholeWords: null, scanDepth: null, excludeRecursion: false, preventRecursion: false, group: '', sticky: 0, cooldown: 0, delay: 0 };
}

function KeysInput({ value, onChange, label, placeholder }: { value: string[]; onChange: (v: string[]) => void; label: string; placeholder?: string }) {
  const [text, setText] = useState(value.join(', '));
  return <input className="st-input" style={{ width: '100%' }} aria-label={label} placeholder={placeholder} value={text} onChange={e => setText(e.target.value)} onBlur={() => onChange(list(text))} />;
}

function NumberBox({ value, onChange, label, min = 0, max = 100000, width = 90, blank = false }: { value: number | null; onChange: (v: number | null) => void; label: string; min?: number; max?: number; width?: number; blank?: boolean }) {
  return <input className="st-input" type="number" aria-label={label} style={{ width }} min={min} max={max} value={value ?? ''} placeholder={blank ? tr('Global') : undefined}
    onChange={e => { const t = e.target.value.trim(); if (t === '' && blank) onChange(null); else if (Number.isFinite(Number(t))) onChange(Math.min(max, Math.max(min, Math.round(Number(t))))); }} />;
}

function EntryEditor({ e, onChange, onDelete, onCopy }: { e: RpEntry; onChange: (e: RpEntry) => void; onDelete: () => void; onCopy: () => void }) {
  const set = (p: Partial<RpEntry>) => onChange({ ...e, ...p });
  const title = e.comment || e.keys.slice(0, 3).join(', ') || tr('New entry');
  return <details className="rp-entry" data-off={!e.enabled || undefined}>
    <summary>
      <input type="checkbox" aria-label={tr('Entry on')} checked={e.enabled} onClick={ev => ev.stopPropagation()} onChange={ev => set({ enabled: ev.target.checked })} />
      <span className="rp-entry__title">{title}</span>
      <span className="xs muted">{e.constant ? tr('Always on') : e.keys.length ? tr('{0} keys', [e.keys.length]) : tr('No keys')} · {tr('order {0}', [e.order])}</span>
      <IconBtn name="layers" title={tr('Duplicate entry')} onClick={onCopy} size={15} />
      <IconBtn name="trash" title={tr('Delete entry')} onClick={onDelete} size={15} />
    </summary>
    <div className="rp-entry__body">
      <Field label={tr('Title')} hint={tr('Only for you; not sent.')} wide><input className="st-input" style={{ width: '100%' }} value={e.comment} onChange={ev => set({ comment: ev.target.value })} /></Field>
      <Field label={tr('Keys')} hint={tr('Comma-separated. The entry turns on when one of them appears in the recent chat. /regex/i works too.')} wide><KeysInput label={tr('Keys')} value={e.keys} onChange={keys => set({ keys })} placeholder="harbor, docks, /ship(s)?/i" /></Field>
      <Field label={tr('Secondary keys')} hint={tr('Optional: a second condition on top of the keys.')} wide>
        <div className="row" style={{ gap: 8, width: '100%' }}><Select value={e.selectiveLogic} onChange={v => set({ selectiveLogic: v })} options={[...LOGIC]} ariaLabel={tr('Secondary key logic')} /><KeysInput label={tr('Secondary keys')} value={e.secondaryKeys} onChange={secondaryKeys => set({ secondaryKeys })} /></div>
      </Field>
      <Field label={tr('Content')} hint={tr('What is added to the prompt when the entry is on. Macros like {{char}} and {{user}} work.')} wide>
        <textarea className="st-input" rows={5} style={{ width: '100%' }} value={e.content} onChange={ev => set({ content: ev.target.value })} />
      </Field>
      <Field label={tr('Always on')} hint={tr('Sent every time, keys or not.')}><button className="st-toggle" role="switch" aria-checked={e.constant} aria-label={tr('Always on')} onClick={() => set({ constant: !e.constant })} /></Field>
      <Field label={tr('Where')}><Select value={e.position} onChange={v => set({ position: v })} options={[...POSITIONS]} ariaLabel={tr('Where')} /></Field>
      {e.position === 'depth' ? <Field label={tr('Depth and role')} hint={tr('How many messages from the end, and who it is sent as.')}>
        <div className="row" style={{ gap: 8 }}><NumberBox label={tr('Depth')} value={e.depth} onChange={v => set({ depth: v ?? 4 })} max={1000} /><Select value={e.role} onChange={v => set({ role: v })} options={[{ value: 'system', label: 'System' }, { value: 'user', label: 'User' }, { value: 'assistant', label: 'Assistant' }]} ariaLabel={tr('Role')} /></div>
      </Field> : null}
      <Field label={tr('Order')} hint={tr('Higher goes later (closer to the chat) and wins when the budget is full.')}><NumberBox label={tr('Order')} value={e.order} onChange={v => set({ order: v ?? 100 })} min={-100000} /></Field>
      <Field label={tr('Chance')} hint={tr('Percent of the times it would turn on that it does.')}><NumberBox label={tr('Chance')} value={e.probability} onChange={v => set({ probability: v ?? 100 })} max={100} /></Field>
      <Field label={tr('Scan depth')} hint={tr('How many recent messages are searched for the keys. Empty: the book’s or the global setting.')}><NumberBox label={tr('Scan depth')} value={e.scanDepth} onChange={v => set({ scanDepth: v })} max={1000} blank /></Field>
      <Field label={tr('Case-sensitive keys')}><Select value={tri(e.caseSensitive)} onChange={v => set({ caseSensitive: fromTri(v) })} options={[...TRI]} ariaLabel={tr('Case-sensitive keys')} /></Field>
      <Field label={tr('Whole words only')}><Select value={tri(e.matchWholeWords)} onChange={v => set({ matchWholeWords: fromTri(v) })} options={[...TRI]} ariaLabel={tr('Whole words only')} /></Field>
      <Field label={tr('Inclusion group')} hint={tr('Of the entries on at once with the same group, only the one with the highest order is sent.')}><input className="st-input" style={{ width: 180 }} value={e.group} onChange={ev => set({ group: ev.target.value })} /></Field>
      <Field label={tr('Delay')} hint={tr('Only after the chat has this many messages.')}><NumberBox label={tr('Delay')} value={e.delay} onChange={v => set({ delay: v ?? 0 })} max={1000} /></Field>
      <Field label={tr('Not triggered by other entries')} hint={tr('Recursion: other entries’ text cannot turn this one on.')}><button className="st-toggle" role="switch" aria-checked={e.excludeRecursion} aria-label={tr('Not triggered by other entries')} onClick={() => set({ excludeRecursion: !e.excludeRecursion })} /></Field>
      <Field label={tr('Does not trigger other entries')}><button className="st-toggle" role="switch" aria-checked={e.preventRecursion} aria-label={tr('Does not trigger other entries')} onClick={() => set({ preventRecursion: !e.preventRecursion })} /></Field>
    </div>
  </details>;
}

export function LorebookEditor({ book, onChange, embedded = false }: { book: RpLorebook; onChange: (b: RpLorebook) => void; embedded?: boolean }) {
  const [filter, setFilter] = useState('');
  const set = (p: Partial<RpLorebook>) => onChange({ ...book, ...p });
  const nextUid = () => book.entries.reduce((n, e) => Math.max(n, e.uid + 1), 0);
  const shown = book.entries.filter(e => !filter.trim() || `${e.comment} ${e.keys.join(' ')} ${e.content}`.toLowerCase().includes(filter.toLowerCase()));
  return <div className="stack">
    {!embedded ? <div className="st-card st-card--flush">
      <Field label={tr('Name')}><input className="st-input" style={{ width: 260 }} value={book.name} onChange={e => set({ name: e.target.value })} /></Field>
      <Field label={tr('Description')} wide><input className="st-input" style={{ width: '100%' }} value={book.description} onChange={e => set({ description: e.target.value })} /></Field>
      <Field label={tr('Scan depth')} hint={tr('Empty: the global setting (Settings → Roleplay).')}><NumberBox label={tr('Scan depth')} value={book.scanDepth} onChange={v => set({ scanDepth: v })} max={1000} blank /></Field>
      <Field label={tr('Token budget')} hint={tr('The most tokens this book may add. Empty: the global budget.')}><NumberBox label={tr('Token budget')} value={book.tokenBudget} onChange={v => set({ tokenBudget: v })} max={1000000} width={110} blank /></Field>
      <Field label={tr('Recursive')} hint={tr('An entry’s text can turn on other entries.')}><button className="st-toggle" role="switch" aria-checked={book.recursive} aria-label={tr('Recursive')} onClick={() => set({ recursive: !book.recursive })} /></Field>
    </div> : null}
    <div className="row" style={{ gap: 8 }}>
      <input className="st-input" style={{ flex: 1 }} placeholder={tr('Filter entries')} aria-label={tr('Filter entries')} value={filter} onChange={e => setFilter(e.target.value)} />
      <Btn icon="plus" onClick={() => set({ entries: [...book.entries, newEntry(nextUid())] })}>{tr('New entry')}</Btn>
    </div>
    {!book.entries.length ? <p className="small muted">{tr('No entries. An entry is a piece of lore (a place, a person, a rule) that is added to the prompt when its keys come up in the chat.')}</p> : null}
    {shown.map(e => <EntryEditor key={e.uid} e={e}
      onChange={next => set({ entries: book.entries.map(x => (x.uid === e.uid ? next : x)) })}
      onDelete={() => set({ entries: book.entries.filter(x => x.uid !== e.uid) })}
      onCopy={() => set({ entries: [...book.entries, { ...e, uid: nextUid(), comment: `${e.comment || e.keys[0] || ''} (copy)` }] })} />)}
  </div>;
}
