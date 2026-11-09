import { useEffect, useRef, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/client';
import { IMAGE_SIZES, MAX_PICTURES, addPictures, editImage, imageRun, imageSettingsOf, movePictureFirst, removePicture, saveLoraDefaults, setImageSettings, useImageExtras, usePendingPictures } from '../lib/image-chat';
import { retryLast, useStore } from '../lib/store';
import type { ChatMessage, ImageLora, ImageModelState, ImageRef, ImageSettings, Session } from '../lib/types';
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

/** Pictures in order, each labelled as the prompt names it (<image1>, ...): attached to the next message, or sent with one. */
export function PictureStrip({ refs, onRemove, onFirst }: { refs: ImageRef[]; onRemove?: (i: number) => void; onFirst?: (i: number) => void }) {
    return <div className="image-pictures">{refs.map((r, i) => <figure key={r.name} className="image-pictures__item">
        <img src={r.url} alt={tr('Picture {0}', [i + 1])}/>
        <figcaption><span>{tr('Picture {0}', [i + 1])}</span><code>{`<image${i + 1}>`}</code></figcaption>
        {onRemove ? <button type="button" className="image-pictures__remove" title={tr('Remove this picture')} aria-label={tr('Remove picture {0}', [i + 1])} onClick={() => onRemove(i)}><Icon name="x" size={12}/></button> : null}
        {onFirst && i > 0 ? <button type="button" className="image-pictures__first" title={tr('Make this picture 1')} onClick={() => onFirst(i)}>{tr('Make 1st')}</button> : null}
    </figure>)}</div>;
}

/** One LoRA in the list: on or off, its strength, steps and guidance (saved as its defaults on request), what it is for and its prompt. */
function LoraRow({ lora, chosen, fallback, disabled, onToggle, onChange, onPrompt, onWord, onSave }: {
    lora: ImageLora; chosen: ImageSettings['loras'][number] | undefined; fallback: { steps: number; cfg: number }; disabled: boolean;
    onToggle: (on: boolean) => void; onChange: (patch: { strength?: number; steps?: number | null; cfg?: number | null }) => void; onPrompt: () => void; onWord: (word: string) => void;
    onSave: (values: { strength: number; steps: number | null; cfg: number | null }) => Promise<void>;
}) {
    const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | string>('idle');
    const strength = chosen?.strength ?? lora.strength;
    const steps = chosen?.steps === undefined ? lora.steps : chosen.steps;
    const cfg = chosen?.cfg === undefined ? lora.cfg : chosen.cfg;
    const words = [...(lora.prefix && !lora.triggers.some(w => w.toLowerCase() === lora.prefix!.toLowerCase()) ? [lora.prefix] : []), ...lora.triggers];
    const changed = strength !== lora.strength || steps !== lora.steps || cfg !== lora.cfg;
    const value = (v: string, lo: number, hi: number, whole: boolean) => { if (v.trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, whole ? Math.round(n) : n)) : undefined; };
    const save = () => { setSaving('saving'); onSave({ strength, steps, cfg }).then(() => setSaving('saved'), (e: unknown) => setSaving(e instanceof Error ? e.message : String(e))); };
    return <div className="image-lora" data-on={chosen ? true : undefined}>
        <label className="image-lora__head">
            <input type="checkbox" aria-label={lora.title} checked={!!chosen} disabled={disabled} onChange={e => onToggle(e.target.checked)}/>
            <strong>{lora.title}</strong>
            <span className="xs muted">{lora.kind === 'edit' ? tr('Needs pictures') : tr('Any image')}</span>
        </label>
        <p className="xs muted image-lora__about">{lora.description}</p>
        {lora.pictures.length ? <p className="xs image-lora__pictures">{lora.pictures.map((p, i) => <span key={i}><code>{`<image${i + 1}>`}</code> {p}</span>)}</p> : null}
        {words.length ? <p className="xs image-lora__words"><span className="muted">{tr('Trigger words')}</span>{words.map(w => w.toLowerCase() === lora.prefix?.toLowerCase()
            ? <span key={w} className="image-lora__word" title={tr('Added to the start of your prompt while this LoRA is on')}>{w} <span className="muted">{tr('(added for you)')}</span></span>
            : <button key={w} type="button" className="image-lora__word" disabled={disabled} title={tr('Add to your prompt')} onClick={() => onWord(w)}>{w}</button>)}</p> : null}
        <div className="image-lora__actions">
            <label className="image-lora__strength"><span className="xs muted">{tr('Strength')}</span><input className="st-input" type="number" min={-2} max={2} step={0.05} value={strength} disabled={disabled} onChange={e => { const v = value(e.target.value, -2, 2, false); if (v != null) onChange({ strength: v }); }}/></label>
            <label className="image-lora__strength" title={tr('Empty: the chat\'s steps ({0})', [fallback.steps])}><span className="xs muted">{tr('Steps')}</span><input className="st-input" type="number" min={1} max={100} value={steps ?? ''} placeholder={String(fallback.steps)} disabled={disabled} onChange={e => { const v = value(e.target.value, 1, 100, true); if (v !== undefined) onChange({ steps: v }); }}/></label>
            <label className="image-lora__strength" title={tr('Empty: the chat\'s guidance ({0})', [fallback.cfg])}><span className="xs muted">{tr('Guidance')}</span><input className="st-input" type="number" min={1} max={20} step={0.5} value={cfg ?? ''} placeholder={String(fallback.cfg)} disabled={disabled} onChange={e => { const v = value(e.target.value, 1, 20, false); if (v !== undefined) onChange({ cfg: v }); }}/></label>
            {changed ? <button type="button" className="st-btn st-btn--ghost st-btn--sm" disabled={disabled || saving === 'saving'} title={tr('Every chat then starts this LoRA with these values')} onClick={save}>{saving === 'saving' ? tr('Saving…') : tr('Save as its default')}</button>
                : saving === 'saved' ? <span className="xs muted">{tr('Saved')}</span> : null}
            {lora.prompt ? <button type="button" className="st-btn st-btn--ghost st-btn--sm" disabled={disabled} onClick={onPrompt}>{tr('Use its prompt')}</button> : null}
            {lora.source ? <a className="xs" href={lora.source} target="_blank" rel="noreferrer">{tr('Source')}</a> : null}
        </div>
        {saving !== 'idle' && saving !== 'saving' && saving !== 'saved' ? <p className="xs image-lora__error">{saving}</p> : null}
    </div>;
}

/**
 * The composer's controls in an Image chat: pictures to edit (attach, drop or paste), size, how many, the LoRAs, and the settings
 * (steps and guidance for new images and for edits, seed, what to leave out).
 */
export function ImageControls({ session, disabled, draft, onDraft }: { session: Session | null; disabled: boolean; draft: string; onDraft: (text: string) => void }) {
    const settings = imageSettingsOf(session);
    const [panel, setPanel] = useState<'none' | 'loras' | 'settings'>('none');
    const pictures = usePendingPictures(session?.id);
    const { loras, editing } = useImageExtras();
    const fileRef = useRef<HTMLInputElement>(null);
    const sessionId = session?.id;
    useEffect(() => {
        if (!sessionId) return;
        // Dropped or pasted files (DropZone, the message box) are pictures to edit here.
        const dropped = (e: Event) => { const files = (e as CustomEvent<File[]>).detail ?? []; if (files.length) void addPictures(sessionId, files); };
        window.addEventListener('strata:drop-files', dropped);
        return () => window.removeEventListener('strata:drop-files', dropped);
    }, [sessionId]);
    if (!session) return null;
    const set = (patch: Partial<typeof settings>) => setImageSettings(session.id, patch);
    const sizes = IMAGE_SIZES.map(s => ({ value: sizeValue(s.width, s.height), label: `${s.label} · ${s.width}×${s.height}` }));
    const current = sizeValue(settings.width, settings.height);
    if (!sizes.some(s => s.value === current)) sizes.push({ value: current, label: `${settings.width}×${settings.height}` });
    const num = (v: string, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) && v.trim() !== '' ? Math.min(hi, Math.max(lo, n)) : d; };
    const onCount = settings.loras.filter(l => loras.some(k => k.file === l.file)).length;
    const toggle = (lora: ImageLora, on: boolean) => set({ loras: on ? [...settings.loras.filter(l => l.file !== lora.file), { file: lora.file, strength: lora.strength }] : settings.loras.filter(l => l.file !== lora.file) });
    const edit = pictures.length > 0;
    const run = imageRun(settings, loras, edit);
    const runLine = tr('{0} steps · guidance {1}', [run.steps, run.cfg]);
    const done = <div className="image-controls__done"><button type="button" className="st-btn st-btn--secondary st-btn--sm" onClick={() => setPanel('none')}>{tr('Done')}</button></div>;
    return <div className="image-controls" onKeyDown={e => { if (e.key === 'Escape' && panel !== 'none') { e.stopPropagation(); setPanel('none'); } }}>
        {edit ? <div className="image-controls__pictures">
            <PictureStrip refs={pictures} onRemove={i => removePicture(session.id, i)} onFirst={i => movePictureFirst(session.id, i)}/>
            <p className="xs muted">{editing ? tr('Name them in the prompt as <image1>, <image2>… The result has the shape of picture 1.') : tr('Editing needs the vision file (STRATA_IMAGE_VISION) in the launcher.')}</p>
        </div> : null}
        <div className="image-controls__row">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) void addPictures(session.id, files); }}/>
            <button type="button" className="st-btn st-btn--ghost st-btn--sm" disabled={disabled || pictures.length >= MAX_PICTURES} title={tr('Attach pictures to edit or combine (or drop or paste them)')} onClick={() => fileRef.current?.click()}><Icon name="attach" size={15}/>{tr('Pictures')}</button>
            {edit ? <span className="xs muted image-controls__shape" title={run.from.length ? tr('Set by {0}', [run.from.join(', ')]) : undefined}>{tr('Edit · {0} steps · guidance {1}', [run.steps, run.cfg])}</span> : <Select ariaLabel={tr('Image size')} value={current} options={sizes} disabled={disabled} translateLabels={false} onChange={v => { const [w, h] = v.split('x').map(Number); set({ width: w, height: h }); }}/>}
            {!edit && run.from.length ? <span className="xs muted image-controls__shape" title={tr('Set by {0}', [run.from.join(', ')])}>{runLine}</span> : null}
            <Select ariaLabel={tr('How many images')} value={String(settings.n)} options={[1, 2, 3, 4].map(n => ({ value: String(n), label: n === 1 ? tr('1 image') : tr('{0} images', [n]) }))} disabled={disabled} onChange={v => set({ n: Number(v) })}/>
            {loras.length ? <button type="button" className="st-btn st-btn--ghost st-btn--sm" aria-expanded={panel === 'loras'} data-active={onCount > 0 || undefined} onClick={() => setPanel(p => (p === 'loras' ? 'none' : 'loras'))}><Icon name="chevron" size={13} className={panel === 'loras' ? 'is-open' : ''}/>{onCount ? tr('LoRAs ({0} on)', [onCount]) : tr('LoRAs')}</button> : null}
            <button type="button" className="st-btn st-btn--ghost st-btn--sm" aria-expanded={panel === 'settings'} onClick={() => setPanel(p => (p === 'settings' ? 'none' : 'settings'))}><Icon name="chevron" size={13} className={panel === 'settings' ? 'is-open' : ''}/>{tr('Settings')}</button>
        </div>
        {panel === 'loras' ? <div className="image-controls__loras">
            {loras.map(l => { const chosen = settings.loras.find(c => c.file === l.file); return <LoraRow key={l.file} lora={l} chosen={chosen} disabled={disabled}
                fallback={edit ? { steps: settings.editSteps, cfg: settings.editCfg } : { steps: settings.steps, cfg: settings.cfg }}
                onToggle={on => toggle(l, on)} onChange={patch => set({ loras: chosen ? settings.loras.map(c => (c.file === l.file ? { ...c, ...patch } : c)) : [...settings.loras, { file: l.file, strength: l.strength, ...patch }] })}
                onPrompt={() => onDraft(draft.trim() ? `${l.prompt} ${draft.trim()}` : l.prompt ?? '')}
                onWord={w => onDraft(draft.toLowerCase().includes(w.toLowerCase()) ? draft : draft.trim() ? `${draft.trimEnd()} ${w}` : w)}
                onSave={values => saveLoraDefaults(session.id, l.file, values)}/>; })}
        </div> : null}
        {panel === 'loras' ? done : null}
        {panel === 'settings' ? <div className="image-controls__more">
            {run.from.length ? <p className="xs muted image-controls__note">{tr('The LoRAs that are on set {0} now ({1}). Change them in the LoRA list.', [runLine, run.from.join(', ')])}</p> : null}
            <span className="xs image-controls__group">{tr('New images')}</span>
            <label className="image-controls__field"><span className="xs muted">{tr('Steps')}</span><input className="st-input" type="number" min={1} max={100} value={settings.steps} disabled={disabled} onChange={e => set({ steps: Math.round(num(e.target.value, 1, 100, settings.steps)) })}/></label>
            <label className="image-controls__field"><span className="xs muted">{tr('Guidance')}</span><input className="st-input" type="number" min={1} max={20} step={0.5} value={settings.cfg} disabled={disabled} onChange={e => set({ cfg: num(e.target.value, 1, 20, settings.cfg) })}/></label>
            <span className="xs image-controls__group">{tr('Edits (with pictures)')}</span>
            <label className="image-controls__field"><span className="xs muted">{tr('Steps')}</span><input className="st-input" type="number" min={1} max={100} value={settings.editSteps} disabled={disabled} onChange={e => set({ editSteps: Math.round(num(e.target.value, 1, 100, settings.editSteps)) })}/></label>
            <label className="image-controls__field"><span className="xs muted">{tr('Guidance')}</span><input className="st-input" type="number" min={1} max={20} step={0.5} value={settings.editCfg} disabled={disabled} onChange={e => set({ editCfg: num(e.target.value, 1, 20, settings.editCfg) })}/></label>
            <label className="image-controls__field image-controls__field--wide"><span className="xs muted">{tr('Seed (empty: a new one each time)')}</span><input className="st-input" type="number" min={0} value={settings.seed ?? ''} disabled={disabled} onChange={e => set({ seed: e.target.value.trim() === '' ? null : Math.round(num(e.target.value, 0, 2 ** 31 - 1, 0)) })}/></label>
            <label className="image-controls__field image-controls__field--wide"><span className="xs muted">{tr('Leave out (negative prompt; works with guidance above 1)')}</span><input className="st-input" type="text" value={settings.negative} disabled={disabled} placeholder={tr('blurry, text, watermark…')} onChange={e => set({ negative: e.target.value })}/></label>
        </div> : null}
        {panel === 'settings' ? done : null}
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
    const activeSession = useStore(s => s.activeSession);
    const job = m.image!;
    const drawing = m.streaming && job.phase === 'drawing';
    const r = job.request;
    return <div className="st-msg st-msg--assistant image-reply" data-message-id={m.id} data-error={m.error ? 'true' : undefined}>
        {m.error ? <div className="st-bubble"><ErrorNotice message={m.error}/></div> : null}
        {m.media?.length ? <ChatMedia items={m.media} onPreview={onPreview}/> : null}
        {m.media?.length && !m.streaming && activeSession ? <div className="image-reply__edit">{m.media.map((item, i) => <button key={item.src} type="button" className="st-btn st-btn--ghost st-btn--sm" disabled={streaming} title={tr('Attach this image to your next message to change it')} onClick={() => void editImage(activeSession, item.src)}><Icon name="pencil" size={14}/>{m.media!.length > 1 ? tr('Edit image {0}', [i + 1]) : tr('Edit this image')}</button>)}</div> : null}
        {m.streaming ? <div className="image-reply__live" role="status">
            {drawing ? <>
                <div className="image-reply__preview" style={{ aspectRatio: `${job.width ?? 1} / ${job.height ?? 1}` }}>{job.preview ? <img src={job.preview} alt={tr('Preview of the image being drawn')}/> : <span className="image-reply__shimmer"/>}</div>
                <div className="image-reply__progress"><span>{job.n > 1 ? tr('Image {0} of {1} · step {2} of {3}', [job.index + 1, job.n, job.step, job.steps]) : tr('Step {0} of {1}', [job.step, job.steps])}</span><span className="image-reply__bar"><span style={{ width: `${job.steps ? job.step / job.steps * 100 : 0}%` }}/></span></div>
            </> : <div className="image-reply__progress"><span className="image-reply__spinner" aria-hidden="true"/><span>{tr(PHASE_TEXT[job.phase] ?? 'Starting…')}</span></div>}
        </div> : null}
        {!m.streaming && !m.media?.length && m.content ? <div className="st-bubble"><p>{tr(m.content)}</p></div> : null}
        {!m.streaming ? <div className="st-msg__meta">
            {r ? <span className="xs muted image-reply__info">{tr('{0}×{1} · {2} steps · guidance {3} · seed {4}', [r.width, r.height, r.steps, r.cfg, r.seed])}{job.seconds ? ` · ${job.seconds} s` : ''}{r.refs?.length ? ` · ${tr(r.refs.length === 1 ? '1 picture' : '{0} pictures', [r.refs.length])}` : ''}{r.loras?.length ? ` · ${r.loras.map(l => `${l.title} ${l.strength}`).join(', ')}` : ''}</span> : null}
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
        <p className="small muted">{tr('Write what the picture should show: the subject, the setting, the light and the style. Words in quotes are drawn as text. To change a picture, attach it (or drop or paste it, or use Edit on an image here) and say what to change; with several, name them <image1>, <image2>. LoRAs add a style or a skill such as a face or outfit swap.')}</p>
        <p className="xs muted">{m?.enabled ? tr('{0} loads when you start writing. The text model is stopped while it is loaded, and starts again when you write in another chat.', [m.name ?? 'The image model']) : tr('No image model is set up.')}</p>
    </div>;
}
