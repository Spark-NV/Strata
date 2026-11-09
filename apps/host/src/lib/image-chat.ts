/**
 * Image chats: each message is a description, each reply the images the image model draws for it (server/image-model.mjs through
 * POST /api/images/generate). The reply shows the live preview and the step while it is drawn, then the images. The chat's own
 * settings (size, steps, guidance, count, what to avoid, a fixed seed, the LoRAs that are on) are kept on the chat.
 *
 * A message can carry pictures to edit (attached, dropped, pasted, or a reply's image through "Edit"): they go to the model in
 * order, and the prompt names them <image1>, <image2>. They are scaled down here first: the first to about 1 MP, the others to
 * about 0.6 MP. Full-size second pictures made the model ignore the prompt in a test on this setup, and the BFS swap LoRAs ask
 * for 0.59 MP references. An edit draws at the first picture's shape, with the edit steps and guidance (25 and 1: guidance 4
 * burnt the colours of an edit in the same test).
 */
import { useSyncExternalStore } from 'react';
import { api, streamPost } from './client';
import { flushSessions, getState, pushToast, registerImageHooks, storeInternals } from './store';
import type { ChatMessage, ImageJob, ImageLora, ImageRef, ImageSettings, Session } from './types';
import { imageRun } from './image-run';
export { imageRun };

const { patchSession, markTurn, uid } = storeInternals;

/** Sizes offered in an Image chat: the model's own sizes, a little smaller so an image takes about half a minute. */
export const IMAGE_SIZES: { label: string; width: number; height: number }[] = [
  { label: 'Square', width: 1024, height: 1024 },
  { label: 'Portrait 3:4', width: 896, height: 1184 },
  { label: 'Landscape 4:3', width: 1184, height: 896 },
  { label: 'Tall 9:16', width: 768, height: 1344 },
  { label: 'Wide 16:9', width: 1344, height: 768 },
  { label: 'Large square', width: 1536, height: 1536 },
  { label: 'Full square', width: 2048, height: 2048 },
];
export const MAX_PICTURES = 4;
const FIRST_PIXELS = 1024 * 1024, OTHER_PIXELS = 768 * 768;

export function imageSettingsOf(session: Session | null | undefined): ImageSettings {
  const d = getState().imageModel?.defaults;
  return { width: d?.width ?? 1024, height: d?.height ?? 1024, steps: d?.steps ?? 40, cfg: d?.cfg ?? 4, n: 1, negative: '', seed: null, editSteps: 25, editCfg: 1, loras: [], ...session?.imageSettings };
}
export function setImageSettings(sessionId: string, patch: Partial<ImageSettings>) {
  patchSession(sessionId, s => ({ ...s, imageSettings: { ...imageSettingsOf(s), ...patch } }));
  void flushSessions();
}

/** Saves a LoRA's strength, steps and guidance into its .strata.json as its defaults; this chat then follows them. */
export async function saveLoraDefaults(sessionId: string, file: string, values: { strength: number; steps: number | null; cfg: number | null }) {
  await api.post('/api/image-model/lora', { file, ...values });
  const session = sessionOf(sessionId);
  if (session) setImageSettings(sessionId, { loras: imageSettingsOf(session).loras.map(c => (c.file === file ? { file, strength: values.strength } : c)) });
  loadImageExtras(true);
}

/* ------------------------------------------------------------------------------------------------- the LoRA folder */

let extras: { loras: ImageLora[]; editing: boolean } = { loras: [], editing: false };
let extrasAsked = 0;
const extraListeners = new Set<() => void>();
export function loadImageExtras(force = false) {
  if (!force && Date.now() - extrasAsked < 30_000) return;
  extrasAsked = Date.now();
  void api.get<typeof extras>('/api/image-model/extras').then(e => { extras = e; for (const fn of extraListeners) fn(); }).catch(() => undefined);
}
/** The LoRAs the host found, and whether pictures can be edited. */
export function useImageExtras() {
  return useSyncExternalStore(fn => { extraListeners.add(fn); loadImageExtras(); return () => extraListeners.delete(fn); }, () => extras);
}

/* ------------------------------------------------------------------------------------- pictures waiting to be sent */

const pending = new Map<string, ImageRef[]>();
const pendingListeners = new Set<() => void>();
const NO_REFS: ImageRef[] = [];
const changed = () => { for (const fn of pendingListeners) fn(); };
export function usePendingPictures(sessionId: string | undefined) {
  return useSyncExternalStore(fn => { pendingListeners.add(fn); return () => pendingListeners.delete(fn); }, () => (sessionId ? pending.get(sessionId) ?? NO_REFS : NO_REFS));
}
export function removePicture(sessionId: string, index: number) {
  pending.set(sessionId, (pending.get(sessionId) ?? []).filter((_, i) => i !== index)); changed();
}
export function movePictureFirst(sessionId: string, index: number) {
  const list = [...(pending.get(sessionId) ?? [])]; const [p] = list.splice(index, 1);
  if (p) { pending.set(sessionId, [p, ...list]); changed(); }
}

/** A picture scaled so it has at most `pixels` pixels, its sides multiples of 32 (the model needs that), as a PNG. */
async function scaled(blob: Blob, pixels: number): Promise<{ data: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const k = Math.min(1, Math.sqrt(pixels / (bitmap.width * bitmap.height)));
  const width = Math.max(32, Math.floor(bitmap.width * k / 32) * 32), height = Math.max(32, Math.floor(bitmap.height * k / 32) * 32);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The picture could not be read.'))), 'image/png'));
  const bytes = new Uint8Array(await png.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(s), width, height };
}

/** Attaches pictures (files, or the images of a reply) to the chat's next message, after the ones already there. */
export async function addPictures(sessionId: string, blobs: Blob[]) {
  const images = blobs.filter(b => /^image\/(png|jpeg|webp|gif|bmp)$/.test(b.type));
  if (blobs.length && !images.length) { pushToast('info', 'Only pictures can be attached here', 'Attach a PNG, JPEG or WebP picture to edit.'); return; }
  for (const blob of images) {
    const now = pending.get(sessionId) ?? [];
    if (now.length >= MAX_PICTURES) { pushToast('info', 'At most 4 pictures', 'Remove one to attach another.'); return; }
    try {
      const pic = await scaled(blob, now.length ? OTHER_PIXELS : FIRST_PIXELS);
      const { name } = await api.post<{ name: string }>('/api/images/ref', { data: pic.data });
      pending.set(sessionId, [...(pending.get(sessionId) ?? []), { name, url: `/api/images/file/${name}`, width: pic.width, height: pic.height }]);
      changed();
    } catch (e) { pushToast('error', 'The picture was not attached', e instanceof Error ? e.message : String(e)); }
  }
}
/** "Edit": a reply's image becomes a picture of the next message. */
export async function editImage(sessionId: string, url: string) {
  try { await addPictures(sessionId, [await (await fetch(url)).blob()]); }
  catch (e) { pushToast('error', 'The picture was not attached', e instanceof Error ? e.message : String(e)); }
}

/** The size an edit draws at: the first picture's shape, about one megapixel. */
export function editSize(first: ImageRef) {
  const k = Math.sqrt(FIRST_PIXELS / (first.width * first.height));
  const side = (v: number) => Math.min(2048, Math.max(256, Math.round(v * k / 32) * 32));
  return { width: side(first.width), height: side(first.height) };
}

const sessionOf = (id: string | null) => getState().sessions.find(s => s.id === id);

/** Draws the images for `prompt` (and its pictures) into the reply `targetId` (a new reply when it is not given). */
async function draw(sessionId: string, prompt: string, refs: ImageRef[], targetId?: string) {
  const session = sessionOf(sessionId);
  if (!session) return;
  const settings = imageSettingsOf(session);
  const known = new Set(extras.loras.map(l => l.file));
  const size = refs.length ? editSize(refs[0]) : { width: settings.width, height: settings.height };
  const body = {
    prompt, negative: settings.negative, n: settings.n, seed: settings.seed, ...size,
    ...(({ steps, cfg }) => ({ steps, cfg }))(imageRun(settings, extras.loras, refs.length > 0)),
    loras: settings.loras.filter(l => !extras.loras.length || known.has(l.file)).map(({ file, strength }) => ({ file, strength })), refs: refs.map(r => r.name),
  };
  const job: ImageJob = { phase: 'waiting', ...size, step: 0, steps: body.steps, index: 0, n: settings.n, preview: null };
  const id = targetId ?? uid('m');
  const reply: ChatMessage = { id, role: 'assistant', content: '', at: new Date().toISOString(), streaming: true, image: job, model: getState().imageModel?.name ?? undefined };
  patchSession(sessionId, s => ({ ...s, updatedAt: new Date().toISOString(), messages: targetId ? s.messages.map(m => (m.id === id ? reply : m)) : [...s.messages, reply] }));
  const patch = (fn: (m: ChatMessage) => ChatMessage) => patchSession(sessionId, s => ({ ...s, messages: s.messages.map(m => (m.id === id ? fn(m) : m)) }));
  const abort = new AbortController();
  markTurn(sessionId, { abort, agent: false });
  const started = performance.now();
  const media: NonNullable<ChatMessage['media']> = [];
  try {
    await streamPost('/api/images/generate', body, frame => {
      const type = String(frame.type);
      if (type === 'phase') {
        const phase = frame.phase === 'freeing' ? 'freeing' : frame.phase === 'loading' || frame.phase === 'ready' ? 'loading' : null;
        if (phase) patch(m => ({ ...m, image: { ...m.image!, phase } }));
      } else if (type === 'progress') {
        patch(m => ({ ...m, image: { ...m.image!, phase: 'drawing', step: Number(frame.step) || 0, steps: Number(frame.steps) || m.image!.steps, index: Number(frame.index) || 0, preview: typeof frame.preview === 'string' ? frame.preview : m.image!.preview } }));
      } else if (type === 'image') {
        const seed = Number(frame.seed);
        media.push({ kind: 'image', src: `/api/images/file/${String(frame.file)}`, title: `${size.width}×${size.height} · seed ${seed}` });
        patch(m => ({ ...m, media: [...media], image: { ...m.image!, preview: null } }));
      } else if (type === 'done') {
        const r = frame.request as NonNullable<ImageJob['request']> | undefined;
        patch(m => ({ ...m, streaming: false, durationMs: Math.round(performance.now() - started), image: { ...m.image!, phase: 'done', preview: null, seconds: Number(frame.seconds) || undefined, request: r } }));
      } else if (type === 'error') patch(m => ({ ...m, error: String(frame.message ?? 'The image failed.') }));
    }, abort.signal);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') patch(m => ({ ...m, error: e instanceof Error ? e.message : String(e) }));
  } finally {
    // Stopped or failed: the images already made stay; the preview goes.
    patch(m => ({ ...m, streaming: false, image: m.image ? { ...m.image, phase: 'done', preview: null } : m.image, ...(m.media?.length || m.error ? {} : abort.signal.aborted ? { content: 'Stopped.' } : {}) }));
    markTurn(sessionId, null);
    void flushSessions();
  }
}

export async function imageSend(text: string) {
  const id = getState().activeSession;
  const prompt = text.trim();
  if (!id || !prompt) return;
  if (!getState().imageModel?.enabled) { pushToast('info', 'No image model is set up', 'Set STRATA_IMAGE_SERVER and the model files in the launcher.'); return; }
  const refs = pending.get(id) ?? [];
  if (refs.length && !extras.editing) { pushToast('info', 'Editing is not set up', 'Set STRATA_IMAGE_VISION (the text encoder\'s vision file) in the launcher to edit pictures.'); return; }
  pending.delete(id); changed();
  const msg: ChatMessage = { id: uid('m'), role: 'user', content: prompt, at: new Date().toISOString(), ...(refs.length ? { imageRefs: refs } : {}) };
  patchSession(id, s => ({ ...s, updatedAt: new Date().toISOString(), messages: [...s.messages, msg], ...(s.defaultTitle ? { title: prompt.length > 48 ? `${prompt.slice(0, 47)}…` : prompt, defaultTitle: false } : {}) }));
  await draw(id, prompt, refs);
}

/** Ask again: the same description and pictures drawn again (a new seed unless the chat has a fixed one), in place of the reply. */
async function imageRetry(sessionId: string, messageId?: string) {
  const s = sessionOf(sessionId);
  if (!s) return;
  const at = messageId ? s.messages.findIndex(m => m.id === messageId) : s.messages.length - 1;
  const target = s.messages[at];
  const asked = [...s.messages.slice(0, at)].reverse().find(m => m.role === 'user');
  if (!asked?.content) return;
  await draw(sessionId, asked.content, asked.imageRefs ?? [], target?.role === 'assistant' ? target.id : undefined);
}

registerImageHooks({ send: imageSend, retry: imageRetry });
