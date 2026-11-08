import { useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/client';
import { IMAGE_SIZES, imageSettingsOf, setImageSettings } from '../lib/image-chat';
import { retryLast, useStore } from '../lib/store';
import type { ChatMessage, ImageModelState, Session } from '../lib/types';
import type { PreviewArtifact } from '../lib/artifacts';
import { ChatMedia } from './ChatMedia';
import { CopyBtn } from './CopyBtn';
import { ErrorNotice, Icon, IconBtn, Select } from './ui';

/** What the image model is doing, in a few words (the chat's toolbar and the sidebar chip). */
export function imageModelLine(m: ImageModelState | null): string {
    if (!m?.enabled) return tr('Not set up');
    if (m.phase === 'ready') return m.job ? tr('Drawing · step {0} of {1}', [m.job.step, m.job.steps]) : tr('Loaded · ready');
    if (m.phase === 'freeing') return tr('Stopping the text model…');
    if (m.phase === 'loading') return tr('Loading the image model…');
    if (m.phase === 'stopping') return tr('Unloading…');
    if (m.phase === 'error') return m.error ?? tr('Not running');
    return tr('Not loaded · loads when you write');
}

/** The Image chat's toolbar badge: the model, its state, and Unload while it is loaded. */
export function ImageModelBadge() {
    const m = useStore(s => s.imageModel);
    const loaded = m?.phase === 'ready' && !m.job;
    return <span className="image-model-badge" data-phase={m?.phase ?? 'disabled'}>
        <Icon name="image" size={16}/>
        <span className="image-model-badge__name">{m?.name ?? tr('Image model')}</span>
        <span className="muted xs">{imageModelLine(m)}</span>
        {loaded ? <button type="button" className="image-model-badge__unload" title={tr('Unload the image model and free its memory')} onClick={() => void api.post('/api/image-model/unload', {}).catch(() => undefined)}>{tr('Unload')}</button> : null}
    </span>;
}

const sizeValue = (w: number, h: number) => `${w}x${h}`;

/** The composer's controls in an Image chat: size, steps, guidance, how many, what to avoid and a fixed seed. */
export function ImageControls({ session, disabled }: { session: Session | null; disabled: boolean }) {
    const settings = imageSettingsOf(session);
    const [more, setMore] = useState(false);
    if (!session) return null;
    const set = (patch: Partial<typeof settings>) => setImageSettings(session.id, patch);
    const sizes = IMAGE_SIZES.map(s => ({ value: sizeValue(s.width, s.height), label: `${s.label} · ${s.width}×${s.height}` }));
    const current = sizeValue(settings.width, settings.height);
    if (!sizes.some(s => s.value === current)) sizes.push({ value: current, label: `${settings.width}×${settings.height}` });
    const num = (v: string, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) && v.trim() !== '' ? Math.min(hi, Math.max(lo, n)) : d; };
    return <div className="image-controls">
        <div className="image-controls__row">
            <Select ariaLabel={tr('Image size')} value={current} options={sizes} disabled={disabled} translateLabels={false} onChange={v => { const [w, h] = v.split('x').map(Number); set({ width: w, height: h }); }}/>
            <Select ariaLabel={tr('How many images')} value={String(settings.n)} options={[1, 2, 3, 4].map(n => ({ value: String(n), label: n === 1 ? tr('1 image') : tr('{0} images', [n]) }))} disabled={disabled} onChange={v => set({ n: Number(v) })}/>
            <button type="button" className="st-btn st-btn--ghost st-btn--sm" aria-expanded={more} onClick={() => setMore(v => !v)}><Icon name="chevron" size={13} className={more ? 'is-open' : ''}/>{tr('Settings')}</button>
        </div>
        {more ? <div className="image-controls__more">
            <label className="image-controls__field"><span className="xs muted">{tr('Steps')}</span><input className="st-input" type="number" min={1} max={100} value={settings.steps} disabled={disabled} onChange={e => set({ steps: Math.round(num(e.target.value, 1, 100, settings.steps)) })}/></label>
            <label className="image-controls__field"><span className="xs muted">{tr('Guidance')}</span><input className="st-input" type="number" min={1} max={20} step={0.5} value={settings.cfg} disabled={disabled} onChange={e => set({ cfg: num(e.target.value, 1, 20, settings.cfg) })}/></label>
            <label className="image-controls__field"><span className="xs muted">{tr('Seed (empty: a new one each time)')}</span><input className="st-input" type="number" min={0} value={settings.seed ?? ''} disabled={disabled} onChange={e => set({ seed: e.target.value.trim() === '' ? null : Math.round(num(e.target.value, 0, 2 ** 31 - 1, 0)) })}/></label>
            <label className="image-controls__field image-controls__field--wide"><span className="xs muted">{tr('Leave out (negative prompt)')}</span><input className="st-input" type="text" value={settings.negative} disabled={disabled} placeholder={tr('blurry, text, watermark…')} onChange={e => set({ negative: e.target.value })}/></label>
        </div> : null}
    </div>;
}

const PHASE_TEXT: Record<string, string> = {
    waiting: 'Getting ready…',
    freeing: 'Stopping the text model to free the GPU…',
    loading: 'Loading the image model…',
};

/** A reply in an Image chat: the live preview and step while it draws, then the images, what made them, and Ask again. */
export function ImageReply({ message: m, isLast, onPreview }: { message: ChatMessage; isLast: boolean; onPreview: (a: PreviewArtifact) => void }) {
    const streaming = useStore(s => s.streaming);
    const job = m.image!;
    const drawing = m.streaming && job.phase === 'drawing';
    const r = job.request;
    return <div className="st-msg st-msg--assistant image-reply" data-message-id={m.id} data-error={m.error ? 'true' : undefined}>
        {m.error ? <div className="st-bubble"><ErrorNotice message={m.error}/></div> : null}
        {m.media?.length ? <ChatMedia items={m.media} onPreview={onPreview}/> : null}
        {m.streaming ? <div className="image-reply__live" role="status">
            {drawing ? <>
                <div className="image-reply__preview" style={{ aspectRatio: `${job.width ?? 1} / ${job.height ?? 1}` }}>{job.preview ? <img src={job.preview} alt={tr('Preview of the image being drawn')}/> : <span className="image-reply__shimmer"/>}</div>
                <div className="image-reply__progress"><span>{job.n > 1 ? tr('Image {0} of {1} · step {2} of {3}', [job.index + 1, job.n, job.step, job.steps]) : tr('Step {0} of {1}', [job.step, job.steps])}</span><span className="image-reply__bar"><span style={{ width: `${job.steps ? job.step / job.steps * 100 : 0}%` }}/></span></div>
            </> : <div className="image-reply__progress"><span className="image-reply__spinner" aria-hidden="true"/><span>{tr(PHASE_TEXT[job.phase] ?? 'Starting…')}</span></div>}
        </div> : null}
        {!m.streaming && !m.media?.length && m.content ? <div className="st-bubble"><p>{tr(m.content)}</p></div> : null}
        {!m.streaming ? <div className="st-msg__meta">
            {r ? <span className="xs muted image-reply__info">{tr('{0}×{1} · {2} steps · guidance {3} · seed {4}', [r.width, r.height, r.steps, r.cfg, r.seed])}{job.seconds ? ` · ${job.seconds} s` : ''}</span> : null}
            <span className="st-msg__actions">
                {r ? <CopyBtn text={String(r.seed)} label="Seed" title="Copy the seed"/> : null}
                {isLast ? <IconBtn name="refresh" title={tr('Draw again')} disabled={streaming} onClick={() => void retryLast(m.id)}/> : null}
            </span>
        </div> : null}
    </div>;
}

/** An empty Image chat: what to write. */
export function ImageEmpty() {
    const m = useStore(s => s.imageModel);
    return <div className="image-empty">
        <Icon name="image" size={28}/>
        <h2 className="h4">{tr('Describe an image')}</h2>
        <p className="small muted">{tr('Write what the picture should show: the subject, the setting, the light and the style. Words in quotes are drawn as text.')}</p>
        <p className="xs muted">{m?.enabled ? tr('{0} loads when you start writing. The text model is stopped while it is loaded, and starts again when you write in another chat.', [m.name ?? 'The image model']) : tr('No image model is set up.')}</p>
    </div>;
}
