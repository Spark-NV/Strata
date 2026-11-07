import { tr } from '../lib/i18n';
/**
 * Settings -> Profiles: the three chat profiles (Chat, Code, RP) of the sidebar, one at a time.
 *
 * Each profile is what every chat in its sidebar group starts with and runs under: its instructions, thinking level, sampling, whether it
 * has tools at all, its approval mode, and exactly which tools and skills it may use. The host owns the truth (GET/PUT /api/profiles,
 * server/profiles.mjs) and enforces the tool and skill rules itself; a change applies from the next message. Built from the same Field,
 * Select and switch pieces as Settings -> Tools.
 */
import { useEffect, useState } from 'react';
import { pushToast, resetProfile, saveProfile, useStore } from '../lib/store';
import type { ChatProfile, ChatProfileId, ProfileSampling } from '../lib/types';
import { Btn, ErrorNotice, Field, Select } from './ui';

const PROFILE_TABS: { id: ChatProfileId; label: string }[] = [{ id: 'chat', label: 'Chat' }, { id: 'code', label: 'Code' }, { id: 'vibe', label: 'Vibe' }, { id: 'rp', label: 'RP' }];
const AREAS = [{ id: 'computer', title: 'On this computer' }, { id: 'web', title: 'On the web' }, { id: 'together', title: 'Working on bigger jobs' }];
const SAMPLING: { key: keyof ProfileSampling; label: string; hint: string; step: number; min: number; max: number }[] = [
  { key: 'temperature', label: 'Temperature', hint: 'Higher is more varied, lower is more focused. Empty: the model card’s value (1.0 while thinking).', step: 0.05, min: 0, max: 2 },
  { key: 'top_p', label: 'Top P', hint: 'Only pick from the most likely words that add up to this share. Empty: 0.95.', step: 0.01, min: 0, max: 1 },
  { key: 'top_k', label: 'Top K', hint: 'Only pick from this many of the most likely words (1 to 64). Empty: 20.', step: 1, min: 1, max: 64 },
  { key: 'min_p', label: 'Min P', hint: 'Leave out words much less likely than the best one. Empty: off.', step: 0.01, min: 0, max: 1 },
  { key: 'presence_penalty', label: 'Presence penalty', hint: 'A nudge away from words already used. It also makes replies a little slower. Empty: off.', step: 0.05, min: 0, max: 2 },
  { key: 'frequency_penalty', label: 'Frequency penalty', hint: 'A nudge away from words in proportion to how often they were used. Empty: off.', step: 0.05, min: 0, max: 2 },
  { key: 'repetition_penalty', label: 'Repetition penalty', hint: 'Makes repeating the same words less likely. Empty: off (1.0).', step: 0.01, min: 0.5, max: 2 },
  { key: 'seed', label: 'Seed', hint: 'The same seed and message give the same reply. Empty: a new one each time.', step: 1, min: 0, max: 2147483647 },
];

function NumberInput({ value, onChange, step, min, max, placeholder, label }: { value: number | null; onChange: (v: number | null) => void; step: number; min: number; max: number; placeholder: string; label: string }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => { setText(value === null ? '' : String(value)); }, [value]);
  return <input className="st-input" style={{ width: 120 }} type="number" inputMode="decimal" aria-label={label} step={step} min={min} max={max} placeholder={placeholder} value={text}
    onChange={e => { setText(e.target.value); const n = e.target.value.trim() === '' ? null : Number(e.target.value); if (n === null || Number.isFinite(n)) onChange(n); }} />;
}

export function SettingsProfiles() {
  const state = useStore(s => s.profiles), skills = useStore(s => s.skills);
  const [tab, setTab] = useState<ChatProfileId>('chat');
  const [draft, setDraft] = useState<ChatProfile | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const saved = state?.profiles[tab] ?? null;
  // A new tab (or a change saved elsewhere) starts the editor from the saved profile.
  useEffect(() => { setDraft(saved ? structuredClone(saved) : null); setError(''); }, [tab, saved]);
  if (!state || !draft) return <div className="settings-body"><p className="muted">{tr('Loading the profiles…')}</p></div>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const patch = (p: Partial<ChatProfile>) => setDraft(d => (d ? { ...d, ...p } : d));
  const setGroup = (id: string, on: boolean) => patch({ tools: { ...draft.tools, groups: { ...draft.tools.groups, [id]: on } } });
  const setSampling = (key: keyof ProfileSampling, v: number | null) => patch({ sampling: { ...draft.sampling, [key]: v } });
  const toggleSkill = (name: string, on: boolean) => patch({ skills: { ...draft.skills, allow: on ? [...new Set([...draft.skills.allow, name])] : draft.skills.allow.filter(n => n !== name) } });
  async function save() {
    if (!draft) return;
    setBusy(true); setError('');
    try { await saveProfile(draft); pushToast('success', tr('{0} profile saved', [draft.name]), tr('New messages use it.')); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function reset() {
    setBusy(true); setError('');
    try { await resetProfile(tab); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const skillsOff = !draft.agent || draft.tools.groups.skills === false;
  return <div className="stack stack--lg settings-body">
    <section className="settings-section">
      <h2 className="h3" style={{ marginBottom: 6 }}>{tr('Profiles')}</h2>
      <p className="small muted" style={{ marginBottom: 12 }}>{tr('Each group in the sidebar is a profile. A new chat in a group starts with its profile, and every message in it is sent with the profile’s instructions, sampling, tools and skills.')}</p>
      <div className="row" role="tablist" aria-label={tr('Profile')} style={{ gap: 8 }}>
        {PROFILE_TABS.map(p => <Btn key={p.id} variant={tab === p.id ? 'primary' : 'secondary'} onClick={() => setTab(p.id)}>{state.profiles[p.id]?.name ?? p.label}</Btn>)}
      </div>
    </section>

    {error ? <ErrorNotice message={error} /> : null}

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr('Instructions')}</h2>
      <div className="st-card st-card--flush">
        <Field label={tr('Name')} hint={tr('The sidebar group’s name.')}>
          <input className="st-input" style={{ width: 220 }} value={draft.name} maxLength={40} onChange={e => patch({ name: e.target.value })} />
        </Field>
        <Field label={tr('System message')} hint={tr('What the model is told at the start of every message in this profile.')} wide>
          <textarea className="st-input" rows={10} style={{ width: '100%', minHeight: 180, fontFamily: 'var(--font-mono, monospace)', fontSize: 13 }} value={draft.systemPrompt} onChange={e => patch({ systemPrompt: e.target.value })} placeholder={tr('Empty: only the assistant’s own instructions.')} />
        </Field>
        <Field label={tr('With tools on')} hint={tr('Add keeps the assistant’s own instructions, which tell it how to use its tools. Replace removes them: only use it for a profile without tools.')}>
          <Select value={draft.promptPlacement} onChange={v => patch({ promptPlacement: v })} options={[{ value: 'add', label: 'Add to the assistant’s instructions' }, { value: 'replace', label: 'Replace them' }]} ariaLabel={tr('System message placement')} />
        </Field>
      </div>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr('Thinking')}</h2>
      <div className="st-card st-card--flush">
        <Field label={tr('Reasoning effort')} hint={tr('What a new chat in this profile starts with. Each chat can still change it in the message box.')}>
          <Select value={draft.effort} onChange={v => patch({ effort: v })} options={[{ value: 'Medium', label: 'Medium' }, { value: 'High', label: 'Extra High' }]} ariaLabel={tr('Reasoning effort')} />
        </Field>
        <Field label={tr('Thinking budget')} hint={tr('The most tokens one reply may think. 0: the server’s own limit (49,152, and always room left for the answer).')}>
          <NumberInput label={tr('Thinking budget')} value={draft.thinkingBudget} step={1024} min={0} max={262144} placeholder="0" onChange={v => patch({ thinkingBudget: v === null ? 0 : Math.max(0, Math.round(v)) })} />
        </Field>
      </div>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr('Sampling')}</h2>
      <div className="st-card st-card--flush">
        {SAMPLING.map(f => <Field key={f.key} label={tr(f.label)} hint={tr(f.hint)}>
          <NumberInput label={tr(f.label)} value={draft.sampling[f.key]} step={f.step} min={f.min} max={f.max} placeholder={tr('Default')} onChange={v => setSampling(f.key, v)} />
        </Field>)}
        <Field label={tr('Longest reply')} hint={tr('An output cap in tokens, thinking included. Empty: the app’s own.')}>
          <NumberInput label={tr('Longest reply')} value={draft.maxTokens} step={1024} min={1} max={262144} placeholder={tr('Default')} onChange={v => patch({ maxTokens: v === null ? null : Math.max(1, Math.round(v)) })} />
        </Field>
        <Field label={tr('Messages remembered')} hint={tr('Without tools: how many earlier messages are sent with each new one. 0: the whole chat.')}>
          <NumberInput label={tr('Messages remembered')} value={draft.historyLimit} step={10} min={0} max={10000} placeholder="0" onChange={v => patch({ historyLimit: v === null ? 0 : Math.max(0, Math.round(v)) })} />
        </Field>
      </div>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr('Tools and safety')}</h2>
      <div className="st-card st-card--flush">
        <Field label={tr('Tools')} hint={tr('Off: a plain conversation. The model cannot run anything, read files or search; only its words come back.')}>
          <button className="st-toggle" role="switch" aria-checked={draft.agent} aria-label={tr('Tools')} onClick={() => patch({ agent: !draft.agent })} />
        </Field>
        <Field label={tr('Approval mode')} hint={tr('What a new chat starts with. Manual asks before anything changes, Plan only reads, Bypass never asks.')}>
          <Select value={draft.mode} disabled={!draft.agent} onChange={v => patch({ mode: v })} options={[{ value: 'manual', label: 'Manual' }, { value: 'plan', label: 'Plan' }, { value: 'bypass', label: 'Bypass permissions' }]} ariaLabel={tr('Approval mode')} />
        </Field>
      </div>
      {AREAS.map(area => <div key={area.id} style={{ marginTop: 14 }}>
        <h3 className="h5 muted" style={{ marginBottom: 8 }}>{tr(area.title)}</h3>
        <div className="st-card st-card--flush">
          {state.toolGroups.filter(g => g.area === area.id).map(g => <Field key={g.id} label={tr(g.name)} hint={tr(g.about)}>
            <button className="st-toggle" role="switch" aria-checked={draft.tools.groups[g.id] !== false} aria-label={tr(g.name)} disabled={!draft.agent} onClick={() => setGroup(g.id, draft.tools.groups[g.id] === false)} />
          </Field>)}
          {area.id === 'together' ? <Field label={tr('Connected tools')} hint={tr('Tool servers (MCP), the browser and your own tools from Settings -> Tools.')}>
            <button className="st-toggle" role="switch" aria-checked={draft.tools.connected} aria-label={tr('Connected tools')} disabled={!draft.agent} onClick={() => patch({ tools: { ...draft.tools, connected: !draft.tools.connected } })} />
          </Field> : null}
        </div>
      </div>)}
      <p className="small muted" style={{ marginTop: 8 }}>{tr('A tool switched off here is not offered to the model, and is refused if it asks for it anyway. Settings -> Tools still decides what exists at all.')}</p>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr('Skills')}</h2>
      <div className="st-card st-card--flush">
        <Field label={tr('Every skill')} hint={tr(skillsOff ? 'This profile has the Skills tool off, so it uses no skills.' : 'On: all your skills. Off: only the ones ticked below.')}>
          <button className="st-toggle" role="switch" aria-checked={draft.skills.all} aria-label={tr('Every skill')} disabled={skillsOff} onClick={() => patch({ skills: { ...draft.skills, all: !draft.skills.all } })} />
        </Field>
        {!draft.skills.all && !skillsOff ? (skills.length ? skills.map(sk => <Field key={sk.id} label={sk.name} hint={sk.description}>
          <button className="st-toggle" role="switch" aria-checked={draft.skills.allow.includes(sk.name)} aria-label={sk.name} onClick={() => toggleSkill(sk.name, !draft.skills.allow.includes(sk.name))} />
        </Field>) : <p className="small muted" style={{ padding: '12px 16px' }}>{tr('No skills yet. Add them on the Skills page.')}</p>) : null}
      </div>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 10 }}>{tr('Memory and web')}</h2>
      <div className="st-card st-card--flush">
        <Field label={tr('Use memory')} hint={tr('Your saved memories (Settings → Memory) are given to the model in this profile.')}>
          <button className="st-toggle" role="switch" aria-checked={draft.memory.read} aria-label={tr('Use memory')} onClick={() => patch({ memory: { ...draft.memory, read: !draft.memory.read } })} />
        </Field>
        <Field label={tr('Save to memory')} hint={tr('The assistant may save and forget memories itself when you tell it something lasting or ask it to remember. Needs tools on.')}>
          <button className="st-toggle" role="switch" aria-checked={draft.memory.write} aria-label={tr('Save to memory')} disabled={!draft.agent} onClick={() => patch({ memory: { ...draft.memory, write: !draft.memory.write } })} />
        </Field>
        <Field label={tr('Search the web without asking')} hint={tr('In Manual mode, web searches and pages run without the once-per-chat question.')}>
          <button className="st-toggle" role="switch" aria-checked={draft.webWithoutAsking} aria-label={tr('Search the web without asking')} disabled={!draft.agent} onClick={() => patch({ webWithoutAsking: !draft.webWithoutAsking })} />
        </Field>
      </div>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 6 }}>{tr('Agents')}</h2>
      <p className="small muted" style={{ marginBottom: 10 }}>{tr('Specialists the assistant can hand work to with its helper tool. It is told their names and what they are for; a helper started as “@name …” gets that agent’s instructions and only its tools. Needs Helpers on.')}</p>
      {draft.agents.map((a, i) => <div key={i} className="st-card st-card--flush" style={{ marginBottom: 8 }}>
        <Field label={tr('Name')} hint={tr('Lowercase, used as @name.')}><div className="row" style={{ gap: 8 }}><input className="st-input" style={{ width: 180 }} value={a.name} onChange={e => patch({ agents: draft.agents.map((x, j) => (j === i ? { ...x, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') } : x)) })} /><Btn size="sm" variant="ghost" icon="trash" onClick={() => patch({ agents: draft.agents.filter((_, j) => j !== i) })}>{tr('Remove')}</Btn></div></Field>
        <Field label={tr('What it is for')} wide><input className="st-input" style={{ width: '100%' }} value={a.description} onChange={e => patch({ agents: draft.agents.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} /></Field>
        <Field label={tr('Instructions')} wide><textarea className="st-input" rows={5} style={{ width: '100%' }} value={a.instructions} onChange={e => patch({ agents: draft.agents.map((x, j) => (j === i ? { ...x, instructions: e.target.value } : x)) })} /></Field>
        <Field label={tr('Tools')} hint={tr('Tool groups or single tools, comma-separated (e.g. find, read, shell). Empty: every tool the profile has.')} wide>
          <input className="st-input" style={{ width: '100%' }} defaultValue={(a.tools ?? []).join(', ')} onBlur={e => { const t = e.target.value.split(',').map(x => x.trim()).filter(Boolean); patch({ agents: draft.agents.map((x, j) => (j === i ? { ...x, tools: t.length ? t : null } : x)) }); }} />
        </Field>
      </div>)}
      <Btn size="sm" icon="plus" onClick={() => patch({ agents: [...draft.agents, { name: 'helper', description: '', instructions: '', tools: null }] })}>{tr('Add an agent')}</Btn>
    </section>

    <section className="settings-section">
      <h2 className="h4" style={{ marginBottom: 6 }}>{tr('Commands')}</h2>
      <p className="small muted" style={{ marginBottom: 10 }}>{tr('Your own slash commands for this profile. Typing /name and some text sends the prompt with $ARGUMENTS replaced by the text (or the text added at the end).')}</p>
      {draft.commands.map((c, i) => <div key={i} className="st-card st-card--flush" style={{ marginBottom: 8 }}>
        <Field label={tr('Command')}><div className="row" style={{ gap: 8 }}><span className="small">/</span><input className="st-input" style={{ width: 160 }} value={c.name} onChange={e => patch({ commands: draft.commands.map((x, j) => (j === i ? { ...x, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') } : x)) })} /><Btn size="sm" variant="ghost" icon="trash" onClick={() => patch({ commands: draft.commands.filter((_, j) => j !== i) })}>{tr('Remove')}</Btn></div></Field>
        <Field label={tr('Description')} wide><input className="st-input" style={{ width: '100%' }} value={c.description} onChange={e => patch({ commands: draft.commands.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} /></Field>
        <Field label={tr('Prompt')} wide><textarea className="st-input" rows={4} style={{ width: '100%' }} value={c.prompt} onChange={e => patch({ commands: draft.commands.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)) })} /></Field>
      </div>)}
      <Btn size="sm" icon="plus" onClick={() => patch({ commands: [...draft.commands, { name: 'new', description: '', prompt: '$ARGUMENTS' }] })}>{tr('Add a command')}</Btn>
    </section>

    <div className="row" style={{ gap: 8, justifyContent: 'flex-end', position: 'sticky', bottom: 0, padding: '12px 0', background: 'var(--st-surface)' }}>
      <Btn onClick={() => void reset()} disabled={busy}>{tr('Reset to defaults')}</Btn>
      <Btn onClick={() => setDraft(saved ? structuredClone(saved) : null)} disabled={busy || !dirty}>{tr('Discard changes')}</Btn>
      <Btn variant="primary" onClick={() => void save()} disabled={busy || !dirty}>{tr(busy ? 'Saving…' : 'Save profile')}</Btn>
    </div>
  </div>;
}
