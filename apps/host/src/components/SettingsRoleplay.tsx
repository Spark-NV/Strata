import { tr } from '../lib/i18n';
/**
 * Settings -> Roleplay: how a roleplay prompt is built (server/rp/prompt.mjs), SillyTavern's prompt manager and its other settings.
 * The prompts, their order, custom prompts, example dialogues, names, World Info, the default author's note, the context, stops,
 * replacements (regex) and group chats. Sampling and thinking for roleplay are the RP profile's (Settings -> Profiles -> RP).
 */
import { useEffect, useState } from 'react';
import { pushToast } from '../lib/store';
import { loadRpLibrary, resetRpSettings, saveRpSettings, useRpLibrary } from '../lib/rp';
import type { RpCustomPrompt, RpReplacement, RpSettings } from '../lib/types';
import { Btn, ErrorNotice, Field, IconBtn, Select } from './ui';

const PIECES: Record<string, string> = {
  main: 'Main prompt', formatting: 'Text format', worldInfoBefore: 'World Info (before)', personaDescription: 'Persona', charDescription: 'Character description',
  charPersonality: 'Character personality', scenario: 'Scenario', auxiliary: 'Auxiliary prompt', worldInfoAfter: 'World Info (after)',
  dialogueExamples: 'Example dialogues', chatHistory: 'Chat history', postHistory: 'Post-history instructions',
};
const ROLE_OPTIONS = [{ value: 'system', label: 'System' }, { value: 'user', label: 'User' }, { value: 'assistant', label: 'Assistant' }] as const;

function Num({ value, onChange, label, min = 0, max = 10_000_000, width = 110 }: { value: number; onChange: (v: number) => void; label: string; min?: number; max?: number; width?: number }) {
  return <input className="st-input" type="number" aria-label={label} style={{ width }} min={min} max={max} value={value} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n))); }} />;
}
function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className="st-toggle" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}
function Prompt({ label, hint, value, onChange, rows = 4 }: { label: string; hint: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return <Field label={tr(label)} hint={tr(hint)} wide><textarea className="st-input" rows={rows} style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 13 }} value={value} onChange={e => onChange(e.target.value)} /></Field>;
}

export function SettingsRoleplay() {
  const lib = useRpLibrary();
  const [draft, setDraft] = useState<RpSettings | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (!lib) void loadRpLibrary().catch(e => setError(e instanceof Error ? e.message : String(e))); }, []);
  useEffect(() => { if (lib) setDraft(structuredClone(lib.settings)); }, [lib?.settings]);
  if (!draft || !lib) return <div className="settings-body">{error ? <ErrorNotice message={error} /> : <p className="muted">{tr('Loading…')}</p>}</div>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(lib.settings);
  const patch = (p: Partial<RpSettings>) => setDraft(d => (d ? { ...d, ...p } : d));
  const wi = (p: Partial<RpSettings['worldInfo']>) => patch({ worldInfo: { ...draft.worldInfo, ...p } });
  const move = (i: number, d: -1 | 1) => { const o = [...draft.promptOrder]; const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; patch({ promptOrder: o }); };
  const setCustom = (id: string, p: Partial<RpCustomPrompt>) => patch({ customPrompts: draft.customPrompts.map(c => (c.id === id ? { ...c, ...p } : c)) });
  const setRepl = (id: string, p: Partial<RpReplacement>) => patch({ replacements: draft.replacements.map(r => (r.id === id ? { ...r, ...p } : r)) });
  const customName = (id: string) => draft.customPrompts.find(c => c.id === id)?.name;
  async function save() {
    if (!draft) return;
    setBusy(true); setError('');
    try { await saveRpSettings(draft); pushToast('success', tr('Roleplay settings saved'), tr('The next reply uses them.')); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <div className="stack stack--lg settings-body">
    <section className="settings-section">
      <h2 className="h3" style={{ marginBottom: 6 }}>{tr('Roleplay')}</h2>
      <p className="small muted">{tr('How a roleplay prompt is put together, as in SillyTavern. Sampling, thinking and the longest reply are in Profiles → RP. Characters, personas and lorebooks are in the Roleplay screen (the RP group’s + in the sidebar).')}</p>
    </section>
    {error ? <ErrorNotice message={error} /> : null}

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr('Prompts')}</h2>
      <div className="st-card st-card--flush">
        <Field label={tr('Your name')} hint={tr('{{user}} when no persona is picked.')}><input className="st-input" style={{ width: 200 }} value={draft.userName} onChange={e => patch({ userName: e.target.value })} /></Field>
        <Prompt label="Main prompt" hint="The first instruction: who the model plays and how to write. {{char}}, {{user}} and the other macros work." rows={9} value={draft.mainPrompt} onChange={v => patch({ mainPrompt: v })} />
        <Prompt label="Text format" hint="Tells the model how speech, actions and thoughts are marked. The message box writes your text this way and the chat shows it without the markers." rows={4} value={draft.formatPrompt} onChange={v => patch({ formatPrompt: v })} />
        <Prompt label="Auxiliary prompt" hint="A second instruction block (SillyTavern’s NSFW / auxiliary prompt). Empty: not sent." value={draft.auxiliaryPrompt} onChange={v => patch({ auxiliaryPrompt: v })} />
        <Prompt label="Post-history instructions" hint="Sent after the chat, last, where it weighs the most (SillyTavern’s jailbreak). Empty: not sent." value={draft.postHistoryPrompt} onChange={v => patch({ postHistoryPrompt: v })} />
        <Field label={tr('Prefer the character’s prompts')} hint={tr('A card’s own main prompt and post-history instructions replace these ({{original}} puts these back in).')}>
          <div className="row" style={{ gap: 12 }}>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={draft.preferCharPrompt} onChange={e => patch({ preferCharPrompt: e.target.checked })} />{tr('Main prompt')}</label>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={draft.preferCharInstructions} onChange={e => patch({ preferCharInstructions: e.target.checked })} />{tr('Post-history')}</label>
          </div>
        </Field>
        <Prompt label="Impersonate prompt" hint="What Impersonate asks for (the model writes your next message)." rows={3} value={draft.impersonationPrompt} onChange={v => patch({ impersonationPrompt: v })} />
        <Prompt label="Continue prompt" hint="What Continue asks for." rows={2} value={draft.continuePrompt} onChange={v => patch({ continuePrompt: v })} />
        <Prompt label="Group nudge" hint="Sent last in a group chat, so only the right character answers." rows={2} value={draft.groupNudgePrompt} onChange={v => patch({ groupNudgePrompt: v })} />
        <Prompt label="New chat line" hint="Marks where the chat starts." rows={1} value={draft.newChatPrompt} onChange={v => patch({ newChatPrompt: v })} />
        <Prompt label="New group chat line" hint="The same for a group; {{group}} is the members." rows={1} value={draft.newGroupChatPrompt} onChange={v => patch({ newGroupChatPrompt: v })} />
        <Prompt label="Example chat line" hint="Put before each example dialogue." rows={1} value={draft.newExampleChatPrompt} onChange={v => patch({ newExampleChatPrompt: v })} />
      </div>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 6 }}>{tr('Prompt order')}</h2>
      <p className="small muted" style={{ marginBottom: 10 }}>{tr('The pieces of the prompt, top to bottom. Untick to leave one out. Pieces after the chat history are sent after it.')}</p>
      <div className="st-card st-card--flush">
        {draft.promptOrder.map((o, i) => <div key={o.id} className="row rp-row" style={{ gap: 8 }}>
          <input type="checkbox" aria-label={tr('Send {0}', [PIECES[o.id] ?? customName(o.id) ?? o.id])} checked={o.enabled} disabled={o.id === 'chatHistory'} onChange={e => patch({ promptOrder: draft.promptOrder.map(x => (x.id === o.id ? { ...x, enabled: e.target.checked } : x)) })} />
          <span style={{ flex: 1 }} className={o.id === 'chatHistory' ? 'strong' : undefined}>{tr(PIECES[o.id] ?? customName(o.id) ?? o.id)}{customName(o.id) ? <span className="xs muted"> · {tr('custom')}</span> : null}</span>
          <Btn size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}>{tr('Up')}</Btn>
          <Btn size="sm" variant="ghost" disabled={i === draft.promptOrder.length - 1} onClick={() => move(i, 1)}>{tr('Down')}</Btn>
        </div>)}
      </div>
      <h3 className="h5" style={{ margin: '14px 0 8px' }}>{tr('Custom prompts')}</h3>
      {draft.customPrompts.map(c => <div key={c.id} className="st-card st-card--flush" style={{ marginBottom: 8 }}>
        <Field label={tr('Name')}><div className="row" style={{ gap: 8 }}><input className="st-input" style={{ width: 200 }} value={c.name} onChange={e => setCustom(c.id, { name: e.target.value })} />
          <IconBtn name="trash" title={tr('Delete {0}', [c.name])} onClick={() => patch({ customPrompts: draft.customPrompts.filter(x => x.id !== c.id), promptOrder: draft.promptOrder.filter(o => o.id !== c.id) })} size={15} /></div></Field>
        <Prompt label="Text" hint="Macros work." value={c.content} onChange={v => setCustom(c.id, { content: v })} />
        <Field label={tr('Where')} hint={tr('In the order above, or inside the chat at a depth.')}>
          <div className="row" style={{ gap: 8 }}>
            <Select value={c.depth == null ? 'order' : 'depth'} onChange={v => { const depth = v === 'order' ? null : 4; setCustom(c.id, { depth }); patch({ customPrompts: draft.customPrompts.map(x => (x.id === c.id ? { ...x, depth } : x)), promptOrder: depth == null ? (draft.promptOrder.some(o => o.id === c.id) ? draft.promptOrder : [...draft.promptOrder.slice(0, -1), { id: c.id, enabled: true }, ...draft.promptOrder.slice(-1)]) : draft.promptOrder.filter(o => o.id !== c.id) }); }} options={[{ value: 'order', label: 'In the prompt order' }, { value: 'depth', label: 'In the chat, at a depth' }]} ariaLabel={tr('Where')} />
            {c.depth != null ? <Num label={tr('Depth')} value={c.depth} onChange={v => setCustom(c.id, { depth: Math.round(v) })} max={1000} width={80} /> : null}
            <Select value={c.role} onChange={v => setCustom(c.id, { role: v })} options={[...ROLE_OPTIONS]} ariaLabel={tr('Role')} />
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={c.enabled} onChange={e => setCustom(c.id, { enabled: e.target.checked })} />{tr('On')}</label>
          </div>
        </Field>
      </div>)}
      <Btn size="sm" icon="plus" onClick={() => { const id = `custom-${Math.random().toString(36).slice(2, 10)}`; const at = draft.promptOrder.findIndex(o => o.id === 'chatHistory'); const order = [...draft.promptOrder]; order.splice(at < 0 ? order.length : at, 0, { id, enabled: true }); patch({ customPrompts: [...draft.customPrompts, { id, name: 'Custom prompt', role: 'system', content: '', enabled: true, depth: null }], promptOrder: order }); }}>{tr('Add a custom prompt')}</Btn>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr('Chat formatting')}</h2>
      <div className="st-card st-card--flush">
        <Field label={tr('Example dialogues')} hint={tr('Give way: sent while there is room, dropped first when the chat fills the context.')}>
          <Select value={draft.examplesBehavior} onChange={v => patch({ examplesBehavior: v })} options={[{ value: 'gradual', label: 'Give way to the chat' }, { value: 'always', label: 'Always send' }, { value: 'disabled', label: 'Never send' }]} ariaLabel={tr('Example dialogues')} />
        </Field>
        <Field label={tr('Names before messages')} hint={tr('“Name: …” before each message. Groups need it so the model knows who said what.')}>
          <Select value={draft.namesBehavior} onChange={v => patch({ namesBehavior: v })} options={[{ value: 'groups', label: 'In group chats' }, { value: 'always', label: 'Always' }, { value: 'never', label: 'Never' }]} ariaLabel={tr('Names before messages')} />
        </Field>
        <Field label={tr('One system message')} hint={tr('Join the pieces before the chat into one system message (what most chat templates expect).')}><Toggle on={draft.squashSystem} onChange={v => patch({ squashSystem: v })} label={tr('One system message')} /></Field>
        <Field label={tr('Cut unfinished sentences')} hint={tr('A reply that stops mid-sentence is cut back to its last full sentence.')}><Toggle on={draft.trimIncomplete} onChange={v => patch({ trimIncomplete: v })} label={tr('Cut unfinished sentences')} /></Field>
        <Field label={tr('Stop at your name')} hint={tr('Stop the reply when the model starts writing your line ("\\nYou:"), or another member’s in a group.')}><Toggle on={draft.autoStops} onChange={v => patch({ autoStops: v })} label={tr('Stop at your name')} /></Field>
        <Field label={tr('More stop strings')} hint={tr('Comma-separated (at most 4 stops in all). Macros work.')} wide>
          <input className="st-input" style={{ width: '100%' }} defaultValue={draft.customStops.join(', ')} onBlur={e => patch({ customStops: e.target.value.split(',').map(x => x.trim()).filter(Boolean).slice(0, 4) })} />
        </Field>
      </div>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr('World Info')}</h2>
      <div className="st-card st-card--flush">
        <Field label={tr('Scan depth')} hint={tr('How many recent messages are searched for lorebook keys.')}><Num label={tr('Scan depth')} value={draft.worldInfo.scanDepth} onChange={v => wi({ scanDepth: Math.round(v) })} max={1000} width={80} /></Field>
        <Field label={tr('Budget')} hint={tr('The most of the context lorebooks may fill: a share of the window, and at most this many tokens (0: no cap).')}>
          <div className="row" style={{ gap: 8 }}><Num label={tr('Budget percent')} value={draft.worldInfo.budgetPercent} onChange={v => wi({ budgetPercent: v })} min={1} max={100} width={80} /><span className="small">%</span><Num label={tr('Budget cap')} value={draft.worldInfo.budgetCap} onChange={v => wi({ budgetCap: Math.round(v) })} max={1000000} /><span className="small">{tr('tokens')}</span></div>
        </Field>
        <Field label={tr('Recursive')} hint={tr('Entries’ text can turn on other entries, this many rounds.')}><div className="row" style={{ gap: 8 }}><Toggle on={draft.worldInfo.recursive} onChange={v => wi({ recursive: v })} label={tr('Recursive')} /><Num label={tr('Rounds')} value={draft.worldInfo.maxRecursion} onChange={v => wi({ maxRecursion: Math.round(v) })} max={10} width={70} /></div></Field>
        <Field label={tr('Case-sensitive keys')}><Toggle on={draft.worldInfo.caseSensitive} onChange={v => wi({ caseSensitive: v })} label={tr('Case-sensitive keys')} /></Field>
        <Field label={tr('Whole words only')} hint={tr('“cat” does not match “category”.')}><Toggle on={draft.worldInfo.matchWholeWords} onChange={v => wi({ matchWholeWords: v })} label={tr('Whole words only')} /></Field>
        <Field label={tr('Names in the scan')} hint={tr('Search “Name: message”, so a key can be a speaker’s name.')}><Toggle on={draft.worldInfo.includeNames} onChange={v => wi({ includeNames: v })} label={tr('Names in the scan')} /></Field>
        <Field label={tr('Global lorebooks')} hint={tr('In every roleplay chat.')} wide>
          <div className="stack" style={{ gap: 4 }}>{lib.lorebooks.length ? lib.lorebooks.map(b => <label key={b.id} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={draft.worldInfo.globalBooks.includes(b.id)} onChange={e => wi({ globalBooks: e.target.checked ? [...draft.worldInfo.globalBooks, b.id] : draft.worldInfo.globalBooks.filter(x => x !== b.id) })} />{b.name}</label>) : <span className="small muted">{tr('No lorebooks yet.')}</span>}</div>
        </Field>
      </div>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr("Author's note for new chats")}</h2>
      <div className="st-card st-card--flush">
        <Prompt label="Text" hint="Each chat can change its own in the bar above the chat." rows={3} value={draft.authorsNote.text} onChange={v => patch({ authorsNote: { ...draft.authorsNote, text: v } })} />
        <Field label={tr('Depth, every N messages, role')}>
          <div className="row" style={{ gap: 8 }}>
            <Num label={tr('Depth')} value={draft.authorsNote.depth} onChange={v => patch({ authorsNote: { ...draft.authorsNote, depth: Math.round(v) } })} max={1000} width={70} />
            <Num label={tr('Every N messages')} value={draft.authorsNote.interval} onChange={v => patch({ authorsNote: { ...draft.authorsNote, interval: Math.round(v) } })} max={1000} width={70} />
            <Select value={draft.authorsNote.role} onChange={v => patch({ authorsNote: { ...draft.authorsNote, role: v } })} options={[...ROLE_OPTIONS]} ariaLabel={tr('Role')} />
          </div>
        </Field>
      </div>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr('Context')}</h2>
      <div className="st-card st-card--flush">
        <Field label={tr('Context limit')} hint={tr('The most tokens a roleplay prompt may use. 0: the model’s whole window. A smaller one answers sooner in a very long chat; older messages are left out first.')}><Num label={tr('Context limit')} value={draft.contextLimit} onChange={v => patch({ contextLimit: Math.round(v) })} width={120} /></Field>
        <Field label={tr('Kept free for the reply')} hint={tr('Tokens held back for the reply and its thinking.')}><Num label={tr('Kept free for the reply')} value={draft.responseReserve} onChange={v => patch({ responseReserve: Math.round(v) })} min={256} width={120} /></Field>
      </div>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr('Group chats')}</h2>
      <div className="st-card st-card--flush">
        <Field label={tr('Who speaks next')} hint={tr('Natural: whoever was named, else by talkativeness. List: in turn. Manual: only who you click.')}>
          <Select value={draft.group.strategy} onChange={v => patch({ group: { ...draft.group, strategy: v } })} options={[{ value: 'natural', label: 'Natural' }, { value: 'list', label: 'In turn' }, { value: 'random', label: 'Random' }, { value: 'manual', label: 'Manual' }]} ariaLabel={tr('Who speaks next')} />
        </Field>
        <Field label={tr('Same character twice')} hint={tr('May the one who just spoke speak again?')}><Toggle on={draft.group.allowSelfResponses} onChange={v => patch({ group: { ...draft.group, allowSelfResponses: v } })} label={tr('Same character twice')} /></Field>
        <Field label={tr('Character cards sent')} hint={tr('Only the speaker’s, or every member’s (better consistency, a longer prompt).')}>
          <Select value={draft.group.cards} onChange={v => patch({ group: { ...draft.group, cards: v } })} options={[{ value: 'speaker', label: 'The speaker’s' }, { value: 'all', label: 'Every member’s' }]} ariaLabel={tr('Character cards sent')} />
        </Field>
      </div>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 6 }}>{tr('Replacements')}</h2>
      <p className="small muted" style={{ marginBottom: 10 }}>{tr('Find and replace with a regular expression, on the model’s replies, on your messages (before they are sent), or both. SillyTavern’s regex scripts.')}</p>
      {draft.replacements.map(r => <div key={r.id} className="st-card st-card--flush" style={{ marginBottom: 8 }}>
        <Field label={tr('Name')}><div className="row" style={{ gap: 8 }}><input className="st-input" style={{ width: 200 }} value={r.name} onChange={e => setRepl(r.id, { name: e.target.value })} /><label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={r.enabled} onChange={e => setRepl(r.id, { enabled: e.target.checked })} />{tr('On')}</label><IconBtn name="trash" title={tr('Delete {0}', [r.name || 'replacement'])} onClick={() => patch({ replacements: draft.replacements.filter(x => x.id !== r.id) })} size={15} /></div></Field>
        <Field label={tr('Find')} hint={tr('A regular expression, and its flags.')} wide><div className="row" style={{ gap: 8, width: '100%' }}><input className="st-input" style={{ flex: 1, fontFamily: 'var(--font-mono, monospace)' }} value={r.find} onChange={e => setRepl(r.id, { find: e.target.value })} /><input className="st-input" style={{ width: 60 }} aria-label={tr('Flags')} value={r.flags} onChange={e => setRepl(r.id, { flags: e.target.value })} /></div></Field>
        <Field label={tr('Replace with')} hint={tr('$1, $2 … are the groups.')} wide><input className="st-input" style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }} value={r.replace} onChange={e => setRepl(r.id, { replace: e.target.value })} /></Field>
        <Field label={tr('On')}><Select value={r.on} onChange={v => setRepl(r.id, { on: v })} options={[{ value: 'output', label: 'Replies' }, { value: 'input', label: 'My messages' }, { value: 'both', label: 'Both' }]} ariaLabel={tr('On')} /></Field>
      </div>)}
      <Btn size="sm" icon="plus" onClick={() => patch({ replacements: [...draft.replacements, { id: Math.random().toString(36).slice(2, 10), name: '', find: '', replace: '', flags: 'g', on: 'output', enabled: true }] })}>{tr('Add a replacement')}</Btn>
    </section>

    <div className="row settings-savebar" style={{ gap: 8, position: 'sticky', bottom: 0, padding: '12px 0', background: 'var(--st-surface)' }}>
      <Btn variant="primary" disabled={!dirty || busy} onClick={() => void save()}>{tr('Save')}</Btn>
      <Btn disabled={!dirty || busy} onClick={() => setDraft(structuredClone(lib.settings))}>{tr('Discard')}</Btn>
      <Btn variant="ghost" disabled={busy} onClick={async () => { if (!confirm(tr('Put every roleplay setting back to its default?'))) return; setBusy(true); try { await resetRpSettings(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }}>{tr('Reset to defaults')}</Btn>
    </div>
  </div>;
}
