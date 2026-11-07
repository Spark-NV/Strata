import { tr } from '../lib/i18n';
/**
 * The roleplay library: characters, personas and lorebooks.
 *
 * Characters: import SillyTavern / Tavern cards (PNG with the card inside, or JSON; V1, V2 and V3), write your own, export them back
 * as a PNG card or JSON, start a chat with one, or tick several for a group chat. Personas: who you play (name, description, picture).
 * Lorebooks: World Info, imported from or exported to SillyTavern's JSON.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { pushToast } from '../lib/store';
import { useLocation } from '../lib/router';
import { avatarUrl, deleteCharacter, deleteLorebook, deletePersona, duplicateCharacter, importRpFile, loadRpLibrary, newRpChat, saveCharacter, saveLorebook, savePersona, saveRpSettings, setRpAvatar, useRpLibrary } from '../lib/rp';
import type { RpCharacter, RpLorebook, RpPersona } from '../lib/types';
import { Btn, Dialog, ErrorNotice, Field, Icon, IconBtn, Select } from '../components/ui';
import { RpAvatar } from '../components/RpChat';
import { LorebookEditor } from '../components/RpLorebookEditor';

type Tab = 'characters' | 'personas' | 'lorebooks';
const blankCharacter = (): Partial<RpCharacter> => ({ name: '', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], exampleDialogues: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '', characterVersion: '', tags: [], talkativeness: 0.5, favorite: false, depthPrompt: { text: '', depth: 4, role: 'system' }, book: null, lorebookIds: [] });
const blankBook = (): RpLorebook => ({ id: '', name: 'New lorebook', description: '', scanDepth: null, tokenBudget: null, recursive: true, entries: [] });
const failed = (e: unknown) => pushToast('error', 'That did not work', e instanceof Error ? e.message : String(e));

function Text({ label, hint, value, onChange, rows = 4, placeholder }: { label: string; hint?: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return <Field label={tr(label)} hint={hint ? tr(hint) : undefined} wide><textarea className="st-input" rows={rows} style={{ width: '100%' }} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></Field>;
}

function PictureButton({ onPick, label }: { onPick: (f: File | null) => void; label: string }) {
  const input = useRef<HTMLInputElement>(null);
  return <><Btn size="sm" icon="image" onClick={() => input.current?.click()}>{tr(label)}</Btn>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ''; }} /></>;
}

function CharacterEditor({ initial, onClose }: { initial: Partial<RpCharacter>; onClose: () => void }) {
  const lib = useRpLibrary();
  const [c, setC] = useState<Partial<RpCharacter>>(initial);
  const [tab, setTab] = useState<'main' | 'greetings' | 'advanced' | 'lore'>('main');
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<RpCharacter>) => setC(x => ({ ...x, ...p }));
  async function save(close = true) {
    if (!c.name?.trim()) { pushToast('info', 'Give the character a name', 'The name is what the model is told to play.'); return null; }
    setBusy(true);
    try { const saved = await saveCharacter(c); setC(saved); if (close) onClose(); return saved; } catch (e) { failed(e); return null; } finally { setBusy(false); }
  }
  const tags = (c.tags ?? []).join(', ');
  return <Dialog open wide title={c.id ? c.name || tr('Character') : tr('New character')} onClose={onClose}
    actions={<>
      {c.id ? <Btn variant="ghost" icon="trash" onClick={async () => { if (!confirm(tr('Delete {0}? Its chats stay, without the character.', [c.name ?? '']))) return; await deleteCharacter(c.id!).catch(failed); onClose(); }}>{tr('Delete')}</Btn> : null}
      {c.id ? <Btn icon="download" onClick={() => { window.location.href = `/api/rp/characters/${c.id}/export?format=png`; }}>{tr('Export PNG')}</Btn> : null}
      {c.id ? <Btn onClick={() => { window.location.href = `/api/rp/characters/${c.id}/export?format=json`; }}>{tr('Export JSON')}</Btn> : null}
      <Btn variant="primary" disabled={busy} onClick={() => void save()}>{tr('Save')}</Btn>
      <Btn variant="primary" icon="chat" disabled={busy} onClick={async () => { const s = await save(false); if (s) { onClose(); newRpChat([s.id]); } }}>{tr('Save and chat')}</Btn>
    </>}>
    <div className="rp-editor">
      <div className="row" style={{ gap: 14, marginBottom: 12 }}>
        <RpAvatar kind="characters" id={c.id} name={c.name || '?'} has={c.avatar} size={84} />
        <div className="stack" style={{ gap: 6, flex: 1 }}>
          <input className="st-input" style={{ fontSize: 18, fontWeight: 600 }} placeholder={tr('Name')} aria-label={tr('Name')} value={c.name ?? ''} onChange={e => set({ name: e.target.value })} />
          <div className="row" style={{ gap: 8 }}>
            <PictureButton label="Picture" onPick={async f => { const s = c.id ? c as RpCharacter : await save(false); if (s) { await setRpAvatar('characters', s.id, f).catch(failed); const fresh = (await loadRpLibrary()).characters.find(x => x.id === s.id); if (fresh) setC(fresh); } }} />
            {c.avatar && c.id ? <Btn size="sm" variant="ghost" onClick={async () => { await setRpAvatar('characters', c.id!, null).catch(failed); set({ avatar: false }); }}>{tr('Remove picture')}</Btn> : null}
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={!!c.favorite} onChange={e => set({ favorite: e.target.checked })} />{tr('Favorite')}</label>
          </div>
        </div>
      </div>
      <div className="row" role="tablist" style={{ gap: 6, marginBottom: 10 }}>
        {(['main', 'greetings', 'advanced', 'lore'] as const).map(t => <Btn key={t} size="sm" variant={tab === t ? 'primary' : 'secondary'} onClick={() => setTab(t)}>{tr({ main: 'Character', greetings: 'Greetings and examples', advanced: 'Prompt overrides', lore: 'Lorebook' }[t])}</Btn>)}
      </div>
      {tab === 'main' ? <div className="st-card st-card--flush">
        <Text label="Description" hint="Who the character is: looks, background, how they talk. Always sent. {{char}} and {{user}} work." rows={10} value={c.description ?? ''} onChange={v => set({ description: v })} />
        <Text label="Personality" hint="A short summary of the personality." rows={3} value={c.personality ?? ''} onChange={v => set({ personality: v })} />
        <Text label="Scenario" hint="Where and when the story starts, and the situation." rows={3} value={c.scenario ?? ''} onChange={v => set({ scenario: v })} />
        <Field label={tr('Tags')} hint={tr('Comma-separated, for finding characters.')} wide><input className="st-input" style={{ width: '100%' }} defaultValue={tags} onBlur={e => set({ tags: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} /></Field>
        <Text label="Creator's notes" hint="Not sent to the model." rows={3} value={c.creatorNotes ?? ''} onChange={v => set({ creatorNotes: v })} />
        <Field label={tr('Creator')}><input className="st-input" style={{ width: 220 }} value={c.creator ?? ''} onChange={e => set({ creator: e.target.value })} /></Field>
        <Field label={tr('Version')}><input className="st-input" style={{ width: 120 }} value={c.characterVersion ?? ''} onChange={e => set({ characterVersion: e.target.value })} /></Field>
      </div> : null}
      {tab === 'greetings' ? <div className="st-card st-card--flush">
        <Text label="First message" hint="How the character opens a new chat." rows={8} value={c.firstMessage ?? ''} onChange={v => set({ firstMessage: v })} />
        {(c.alternateGreetings ?? []).map((g, i) => <Field key={i} label={tr('Alternate greeting {0}', [i + 1])} hint={tr('Shown as another version (swipe) of the first message.')} wide>
          <div className="row" style={{ gap: 6, width: '100%', alignItems: 'flex-start' }}>
            <textarea className="st-input" rows={5} style={{ flex: 1 }} value={g} onChange={e => set({ alternateGreetings: (c.alternateGreetings ?? []).map((x, j) => (j === i ? e.target.value : x)) })} />
            <IconBtn name="trash" title={tr('Remove greeting')} onClick={() => set({ alternateGreetings: (c.alternateGreetings ?? []).filter((_, j) => j !== i) })} size={16} />
          </div>
        </Field>)}
        <div style={{ padding: 12 }}><Btn size="sm" icon="plus" onClick={() => set({ alternateGreetings: [...(c.alternateGreetings ?? []), ''] })}>{tr('Add an alternate greeting')}</Btn></div>
        <Text label="Example dialogues" hint="How the character talks. Start each example with <START>, then lines like {{user}}: … and {{char}}: …. They give way first when the chat fills the context." rows={10} value={c.exampleDialogues ?? ''} onChange={v => set({ exampleDialogues: v })} placeholder={'<START>\n{{user}}: Who are you?\n{{char}}: *smirks* Someone you shouldn’t trust.'} />
      </div> : null}
      {tab === 'advanced' ? <div className="st-card st-card--flush">
        <Text label="Main prompt override" hint="Replaces the main prompt (Settings → Roleplay) for this character when “Prefer the character’s prompts” is on. {{original}} puts the main prompt in." rows={5} value={c.systemPrompt ?? ''} onChange={v => set({ systemPrompt: v })} />
        <Text label="Post-history instructions" hint="Sent after the chat, last: the strongest place for a rule. {{original}} puts the global ones in." rows={4} value={c.postHistoryInstructions ?? ''} onChange={v => set({ postHistoryInstructions: v })} />
        <Text label="Character's note" hint="Inserted inside the chat at a depth, every reply (SillyTavern's character note / depth prompt)." rows={3} value={c.depthPrompt?.text ?? ''} onChange={v => set({ depthPrompt: { ...(c.depthPrompt ?? { depth: 4, role: 'system' }), text: v } as RpCharacter['depthPrompt'] })} />
        <Field label={tr("Note depth and role")}>
          <div className="row" style={{ gap: 8 }}>
            <input className="st-input" type="number" min={0} style={{ width: 80 }} aria-label={tr('Depth')} value={c.depthPrompt?.depth ?? 4} onChange={e => set({ depthPrompt: { ...(c.depthPrompt ?? { text: '', role: 'system' }), depth: Math.max(0, Number(e.target.value) | 0) } as RpCharacter['depthPrompt'] })} />
            <Select value={c.depthPrompt?.role ?? 'system'} onChange={v => set({ depthPrompt: { ...(c.depthPrompt ?? { text: '', depth: 4 }), role: v } as RpCharacter['depthPrompt'] })} options={[{ value: 'system', label: 'System' }, { value: 'user', label: 'User' }, { value: 'assistant', label: 'Assistant' }]} ariaLabel={tr('Role')} />
          </div>
        </Field>
        <Field label={tr('Talkativeness')} hint={tr('In a group: how often this character speaks up when nobody named them.')}>
          <input type="range" min={0} max={1} step={0.05} value={c.talkativeness ?? 0.5} onChange={e => set({ talkativeness: Number(e.target.value) })} aria-label={tr('Talkativeness')} /> <span className="small">{Math.round((c.talkativeness ?? 0.5) * 100)}%</span>
        </Field>
      </div> : null}
      {tab === 'lore' ? <div className="stack">
        <div className="st-card st-card--flush">
          <Field label={tr('Linked lorebooks')} hint={tr('Lorebooks from the library that are always in play with this character.')} wide>
            <div className="stack" style={{ gap: 4 }}>{(lib?.lorebooks ?? []).length ? lib!.lorebooks.map(b => <label key={b.id} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={(c.lorebookIds ?? []).includes(b.id)} onChange={e => set({ lorebookIds: e.target.checked ? [...(c.lorebookIds ?? []), b.id] : (c.lorebookIds ?? []).filter(x => x !== b.id) })} />{b.name}</label>) : <span className="small muted">{tr('No lorebooks in the library yet.')}</span>}</div>
          </Field>
        </div>
        <h3 className="h5">{tr('The character’s own lorebook')}</h3>
        <p className="small muted">{tr('Saved inside the card, so it travels with an export. Imported cards bring theirs here.')}</p>
        <LorebookEditor embedded book={c.book ?? { ...blankBook(), name: `${c.name || 'Character'}'s lorebook` }} onChange={book => set({ book })} />
      </div> : null}
    </div>
  </Dialog>;
}

function CharactersTab() {
  const lib = useRpLibrary();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Partial<RpCharacter> | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const file = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => (lib?.characters ?? []).filter(c => !query.trim() || `${c.name} ${c.tags.join(' ')} ${c.creator}`.toLowerCase().includes(query.toLowerCase())), [lib, query]);
  async function onFiles(files: FileList | null) {
    for (const f of [...(files ?? [])]) {
      try { const got = await importRpFile(f); pushToast('success', got.kind === 'character' ? tr('Imported {0}', [got.item.name]) : tr('Imported the lorebook {0}', [got.item.name]), undefined); }
      catch (e) { pushToast('error', tr('Could not import {0}', [f.name]), e instanceof Error ? e.message : String(e)); }
    }
  }
  return <div className="stack">
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <input className="st-input" style={{ flex: 1, minWidth: 180 }} placeholder={tr('Search by name or tag')} aria-label={tr('Search characters')} value={query} onChange={e => setQuery(e.target.value)} />
      <Btn icon="download" onClick={() => file.current?.click()}>{tr('Import')}</Btn>
      <input ref={file} type="file" multiple accept=".png,.json,image/png,application/json" hidden onChange={e => { void onFiles(e.target.files); e.target.value = ''; }} />
      <Btn variant="primary" icon="plus" onClick={() => setEditing(blankCharacter())}>{tr('New character')}</Btn>
    </div>
    {picked.length > 1 ? <div className="rp-groupbar"><span className="small">{tr('{0} picked', [picked.length])}</span><Btn variant="primary" size="sm" icon="chat" onClick={() => { const ids = picked; setPicked([]); setTimeout(() => newRpChat(ids), 0); }}>{tr('Start a group chat')}</Btn><Btn size="sm" variant="ghost" onClick={() => setPicked([])}>{tr('Clear')}</Btn></div> : null}
    {!shown.length ? <div className="rp-empty"><p>{tr(lib?.characters.length ? 'No character matches.' : 'No characters yet. Import a card from SillyTavern, Chub or any Tavern app (PNG or JSON), or write one.')}</p></div> : null}
    <div className="rp-grid">
      {shown.map(c => <div key={c.id} className="rp-card" data-picked={picked.includes(c.id) || undefined}>
        <button className="rp-card__main" onClick={() => newRpChat([c.id])} title={tr('Chat with {0}', [c.name])}>
          <span className="rp-card__img">{c.avatar ? <img src={avatarUrl('characters', c.id)} alt="" loading="lazy" /> : <RpAvatar kind="characters" name={c.name} size={64} />}</span>
          <span className="rp-card__name">{c.favorite ? '★ ' : ''}{c.name}</span>
          <span className="rp-card__desc xs muted">{(c.creatorNotes || c.description).replace(/\{\{char\}\}/gi, c.name).replace(/\{\{user\}\}/gi, lib?.settings.userName ?? 'you').replace(/\s+/g, ' ').slice(0, 110)}</span>
        </button>
        <div className="rp-card__actions">
          <label className="xs row" style={{ gap: 4 }} title={tr('Pick for a group chat')}><input type="checkbox" checked={picked.includes(c.id)} onChange={e => setPicked(e.target.checked ? [...picked, c.id] : picked.filter(x => x !== c.id))} />{tr('Group')}</label>
          <IconBtn name="pencil" title={tr('Edit {0}', [c.name])} onClick={() => setEditing(c)} size={15} />
          <IconBtn name="layers" title={tr('Duplicate')} onClick={() => void duplicateCharacter(c.id).catch(failed)} size={15} />
        </div>
      </div>)}
    </div>
    {editing ? <CharacterEditor initial={editing} onClose={() => setEditing(null)} /> : null}
  </div>;
}

function PersonasTab() {
  const lib = useRpLibrary();
  const [editing, setEditing] = useState<Partial<RpPersona> | null>(null);
  const set = (p: Partial<RpPersona>) => setEditing(x => (x ? { ...x, ...p } : x));
  const def = lib?.settings.defaultPersonaId ?? null;
  return <div className="stack">
    <p className="small muted">{tr('A persona is who you play: your name in the chat ({{user}}) and a description the model is given. Each chat can pick its own; the default is used for new chats.')}</p>
    <div className="row"><Btn variant="primary" icon="plus" onClick={() => setEditing({ name: '', description: '', position: 'prompt', depth: 2, role: 'system', lorebookId: null })}>{tr('New persona')}</Btn></div>
    <div className="st-card st-card--flush">
      {(lib?.personas ?? []).map(p => <div key={p.id} className="row rp-row" style={{ gap: 10 }}>
        <RpAvatar kind="personas" id={p.id} name={p.name} has={p.avatar} size={36} />
        <div style={{ flex: 1 }}><strong>{p.name}</strong>{def === p.id ? <span className="xs muted"> · {tr('default')}</span> : null}<div className="xs muted">{p.description.slice(0, 120)}</div></div>
        {def !== p.id && lib ? <Btn size="sm" onClick={() => void saveRpSettings({ ...lib.settings, defaultPersonaId: p.id }).catch(failed)}>{tr('Make default')}</Btn> : null}
        <IconBtn name="pencil" title={tr('Edit {0}', [p.name])} onClick={() => setEditing(p)} size={15} />
        <IconBtn name="trash" title={tr('Delete {0}', [p.name])} onClick={() => { if (confirm(tr('Delete the persona {0}?', [p.name]))) void deletePersona(p.id).catch(failed); }} size={15} />
      </div>)}
      {!lib?.personas.length ? <p className="small muted" style={{ padding: 12 }}>{tr('No personas yet: chats use the name in Settings → Roleplay ({0}).', [lib?.settings.userName ?? 'User'])}</p> : null}
    </div>
    {editing ? <Dialog open title={editing.id ? editing.name || tr('Persona') : tr('New persona')} onClose={() => setEditing(null)}
      actions={<Btn variant="primary" onClick={async () => { if (!editing.name?.trim()) return; try { await savePersona(editing); setEditing(null); } catch (e) { failed(e); } }}>{tr('Save')}</Btn>}>
      <div className="row" style={{ gap: 12, marginBottom: 10 }}>
        <RpAvatar kind="personas" id={editing.id} name={editing.name || '?'} has={editing.avatar} size={64} />
        {editing.id ? <PictureButton label="Picture" onPick={async f => { await setRpAvatar('personas', editing.id!, f).catch(failed); set({ avatar: true }); }} /> : <span className="small muted">{tr('Save first to add a picture.')}</span>}
      </div>
      <div className="st-card st-card--flush">
        <Field label={tr('Name')}><input className="st-input" style={{ width: 240 }} value={editing.name ?? ''} onChange={e => set({ name: e.target.value })} /></Field>
        <Text label="Description" hint="Who you are in the story. {{user}} and {{char}} work." rows={6} value={editing.description ?? ''} onChange={v => set({ description: v })} />
        <Field label={tr('Where')} hint={tr('In the prompt: with the character’s description. In the chat: at a depth, so it stays fresh.')}>
          <Select value={editing.position ?? 'prompt'} onChange={v => set({ position: v })} options={[{ value: 'prompt', label: 'In the prompt' }, { value: 'depth', label: 'In the chat, at a depth' }, { value: 'none', label: 'Not sent' }]} ariaLabel={tr('Where')} />
        </Field>
        {editing.position === 'depth' ? <Field label={tr('Depth')}><input className="st-input" type="number" min={0} style={{ width: 80 }} value={editing.depth ?? 2} onChange={e => set({ depth: Math.max(0, Number(e.target.value) | 0) })} /></Field> : null}
        <Field label={tr('Lorebook')} hint={tr('A lorebook always in play when you use this persona.')}>
          <Select value={editing.lorebookId ?? ''} onChange={v => set({ lorebookId: v || null })} translateLabels={false} options={[{ value: '', label: tr('None') }, ...(lib?.lorebooks ?? []).map(b => ({ value: b.id, label: b.name }))]} ariaLabel={tr('Lorebook')} />
        </Field>
      </div>
    </Dialog> : null}
  </div>;
}

function LorebooksTab() {
  const lib = useRpLibrary();
  const [editing, setEditing] = useState<RpLorebook | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const global = new Set(lib?.settings.worldInfo.globalBooks ?? []);
  const toggleGlobal = (id: string) => { if (!lib) return; const g = global.has(id) ? [...global].filter(x => x !== id) : [...global, id]; void saveRpSettings({ ...lib.settings, worldInfo: { ...lib.settings.worldInfo, globalBooks: g } }).catch(failed); };
  return <div className="stack">
    <p className="small muted">{tr('Lorebooks (World Info) hold lore that is only sent when it comes up: each entry has keys, and when a key appears in the recent chat its text is added to the prompt. A global lorebook is in every roleplay chat; others are added per chat, per character or per persona.')}</p>
    <div className="row" style={{ gap: 8 }}>
      <Btn variant="primary" icon="plus" onClick={() => setEditing(blankBook())}>{tr('New lorebook')}</Btn>
      <Btn icon="download" onClick={() => file.current?.click()}>{tr('Import')}</Btn>
      <input ref={file} type="file" accept=".json,application/json" hidden onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { const got = await importRpFile(f); pushToast('success', tr('Imported {0}', [got.item.name]), undefined); } catch (err) { failed(err); } }} />
    </div>
    <div className="st-card st-card--flush">
      {(lib?.lorebooks ?? []).map(b => <div key={b.id} className="row rp-row" style={{ gap: 10 }}>
        <Icon name="layers" />
        <div style={{ flex: 1 }}><strong>{b.name}</strong><div className="xs muted">{tr('{0} entries', [b.entries.length])}{b.description ? ` · ${b.description.slice(0, 80)}` : ''}</div></div>
        <label className="row xs" style={{ gap: 4 }}><input type="checkbox" checked={global.has(b.id)} onChange={() => toggleGlobal(b.id)} />{tr('Global')}</label>
        <IconBtn name="download" title={tr('Export {0}', [b.name])} onClick={() => { window.location.href = `/api/rp/lorebooks/${b.id}/export`; }} size={15} />
        <IconBtn name="pencil" title={tr('Edit {0}', [b.name])} onClick={() => setEditing(structuredClone(b))} size={15} />
        <IconBtn name="trash" title={tr('Delete {0}', [b.name])} onClick={() => { if (confirm(tr('Delete the lorebook {0}?', [b.name]))) void deleteLorebook(b.id).catch(failed); }} size={15} />
      </div>)}
      {!lib?.lorebooks.length ? <p className="small muted" style={{ padding: 12 }}>{tr('No lorebooks yet.')}</p> : null}
    </div>
    {editing ? <Dialog open wide title={editing.name || tr('Lorebook')} onClose={() => setEditing(null)}
      actions={<Btn variant="primary" disabled={busy} onClick={async () => { setBusy(true); try { await saveLorebook(editing.id ? editing : { ...editing, id: undefined }); setEditing(null); } catch (e) { failed(e); } finally { setBusy(false); } }}>{tr('Save')}</Btn>}>
      <LorebookEditor book={editing} onChange={setEditing} />
    </Dialog> : null}
  </div>;
}

export function CharactersScreen() {
  const loc = useLocation();
  const lib = useRpLibrary();
  const [err, setErr] = useState('');
  const tab: Tab = loc.param === 'personas' || loc.param === 'lorebooks' ? loc.param : 'characters';
  useEffect(() => { loadRpLibrary().catch(e => setErr(e instanceof Error ? e.message : String(e))); }, []);
  return <div className="screen rp-screen">
    <header className="screen__head"><h1 className="h2">{tr('Roleplay')}</h1></header>
    <div className="row" role="tablist" style={{ gap: 8, marginBottom: 14 }}>
      {(['characters', 'personas', 'lorebooks'] as const).map(t => <Btn key={t} variant={tab === t ? 'primary' : 'secondary'} onClick={() => { window.location.hash = `#/characters/${t}`; }}>{tr({ characters: 'Characters', personas: 'Personas', lorebooks: 'Lorebooks' }[t])}</Btn>)}
    </div>
    {err ? <ErrorNotice message={err} /> : !lib ? <p className="muted">{tr('Loading the library…')}</p> : tab === 'characters' ? <CharactersTab /> : tab === 'personas' ? <PersonasTab /> : <LorebooksTab />}
  </div>;
}
