import { tr } from '../lib/i18n';
/**
 * Settings -> Memory: what the assistant remembers about you across chats (server/memory.mjs). Profiles decide who reads it and who may
 * save to it (Settings -> Profiles -> Memory and web). Every item can be edited or deleted here.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/client';
import { Btn, ErrorNotice, IconBtn } from './ui';

interface Item { id: string; text: string; createdAt: string; source: 'you' | 'assistant' }

export function SettingsMemory() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [text, setText] = useState(''), [error, setError] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const run = async (fn: () => Promise<{ items: Item[] } | Item | unknown>) => { setError(''); try { await fn(); setItems((await api.get<{ items: Item[] }>('/api/memory')).items); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  useEffect(() => { void run(async () => undefined); }, []);
  return <div className="stack stack--lg settings-body">
    <section className="settings-section">
      <h2 className="h3" style={{ marginBottom: 6 }}>{tr('Memory')}</h2>
      <p className="small muted">{tr('Short facts the assistant keeps about you across chats: your preferences, your projects, how you like answers. Chats in a profile with memory on get this list; the assistant adds to it when you tell it something lasting or ask it to remember.')}</p>
    </section>
    {error ? <ErrorNotice message={error} /> : null}
    <section className="settings-section">
      <div className="row" style={{ gap: 8 }}>
        <input className="st-input" style={{ flex: 1 }} placeholder={tr('Add a memory, e.g. “I prefer answers in metric units.”')} aria-label={tr('New memory')} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && text.trim()) void run(() => api.post('/api/memory', { text })).then(() => setText('')); }} />
        <Btn variant="primary" disabled={!text.trim()} onClick={() => void run(() => api.post('/api/memory', { text })).then(() => setText(''))}>{tr('Add')}</Btn>
      </div>
    </section>
    <section className="settings-section">
      <div className="st-card st-card--flush">
        {items === null ? <p className="small muted" style={{ padding: 12 }}>{tr('Loading…')}</p> : !items.length ? <p className="small muted" style={{ padding: 12 }}>{tr('Nothing saved yet.')}</p> : items.map(i => <div key={i.id} className="row rp-row" style={{ gap: 8 }}>
          {editing?.id === i.id ? <>
            <input className="st-input" style={{ flex: 1 }} autoFocus value={editing.text} aria-label={tr('Edit memory')} onChange={e => setEditing({ id: i.id, text: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') void run(() => api.put(`/api/memory/${i.id}`, { text: editing.text })).then(() => setEditing(null)); if (e.key === 'Escape') setEditing(null); }} />
            <Btn size="sm" variant="primary" onClick={() => void run(() => api.put(`/api/memory/${i.id}`, { text: editing.text })).then(() => setEditing(null))}>{tr('Save')}</Btn>
          </> : <>
            <span style={{ flex: 1 }}>{i.text}<span className="xs muted"> · {tr(i.source === 'assistant' ? 'saved by the assistant' : 'added by you')} · {new Date(i.createdAt).toLocaleDateString()}</span></span>
            <IconBtn name="pencil" title={tr('Edit memory')} onClick={() => setEditing({ id: i.id, text: i.text })} size={15} />
            <IconBtn name="trash" title={tr('Delete memory')} onClick={() => void run(() => api.del(`/api/memory/${i.id}`))} size={15} />
          </>}
        </div>)}
      </div>
      {items?.length ? <div style={{ marginTop: 10 }}><Btn variant="ghost" onClick={() => { if (confirm(tr('Delete every memory?'))) void run(() => api.del('/api/memory')); }}>{tr('Delete all')}</Btn></div> : null}
    </section>
  </div>;
}
