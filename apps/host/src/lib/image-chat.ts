/**
 * Image chats: each message is a description, each reply the images the image model draws for it (server/image-model.mjs through
 * POST /api/images/generate). The reply shows the live preview and the step while it is drawn, then the images. The chat's own
 * settings (size, steps, guidance, count, what to avoid, a fixed seed) are kept on the chat.
 */
import { streamPost } from './client';
import { flushSessions, getState, pushToast, registerImageHooks, storeInternals } from './store';
import type { ChatMessage, ImageJob, ImageSettings, Session } from './types';

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

export function imageSettingsOf(session: Session | null | undefined): ImageSettings {
  const d = getState().imageModel?.defaults;
  return { width: d?.width ?? 1024, height: d?.height ?? 1024, steps: d?.steps ?? 40, cfg: d?.cfg ?? 4, n: 1, negative: '', seed: null, ...session?.imageSettings };
}
export function setImageSettings(sessionId: string, patch: Partial<ImageSettings>) {
  patchSession(sessionId, s => ({ ...s, imageSettings: { ...imageSettingsOf(s), ...patch } }));
  void flushSessions();
}

const sessionOf = (id: string | null) => getState().sessions.find(s => s.id === id);

/** Draws the images for `prompt` into the reply `targetId` (a new reply when it is not given). */
async function draw(sessionId: string, prompt: string, targetId?: string) {
  const session = sessionOf(sessionId);
  if (!session) return;
  const settings = imageSettingsOf(session);
  const job: ImageJob = { phase: 'waiting', width: settings.width, height: settings.height, step: 0, steps: settings.steps, index: 0, n: settings.n, preview: null };
  const id = targetId ?? uid('m');
  const reply: ChatMessage = { id, role: 'assistant', content: '', at: new Date().toISOString(), streaming: true, image: job, model: getState().imageModel?.name ?? undefined };
  patchSession(sessionId, s => ({ ...s, updatedAt: new Date().toISOString(), messages: targetId ? s.messages.map(m => (m.id === id ? reply : m)) : [...s.messages, reply] }));
  const patch = (fn: (m: ChatMessage) => ChatMessage) => patchSession(sessionId, s => ({ ...s, messages: s.messages.map(m => (m.id === id ? fn(m) : m)) }));
  const abort = new AbortController();
  markTurn(sessionId, { abort, agent: false });
  const started = performance.now();
  const media: NonNullable<ChatMessage['media']> = [];
  try {
    await streamPost('/api/images/generate', { prompt, ...settings }, frame => {
      const type = String(frame.type);
      if (type === 'phase') {
        const phase = frame.phase === 'freeing' ? 'freeing' : frame.phase === 'loading' || frame.phase === 'ready' ? 'loading' : null;
        if (phase) patch(m => ({ ...m, image: { ...m.image!, phase } }));
      } else if (type === 'progress') {
        patch(m => ({ ...m, image: { ...m.image!, phase: 'drawing', step: Number(frame.step) || 0, steps: Number(frame.steps) || m.image!.steps, index: Number(frame.index) || 0, preview: typeof frame.preview === 'string' ? frame.preview : m.image!.preview } }));
      } else if (type === 'image') {
        const seed = Number(frame.seed);
        media.push({ kind: 'image', src: `/api/images/file/${String(frame.file)}`, title: `${settings.width}×${settings.height} · seed ${seed}` });
        patch(m => ({ ...m, media: [...media], image: { ...m.image!, preview: null } }));
      } else if (type === 'done') {
        const r = frame.request as { width: number; height: number; steps: number; cfg: number; seed: number; negative: string } | undefined;
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
  const msg: ChatMessage = { id: uid('m'), role: 'user', content: prompt, at: new Date().toISOString() };
  patchSession(id, s => ({ ...s, updatedAt: new Date().toISOString(), messages: [...s.messages, msg], ...(s.defaultTitle ? { title: prompt.length > 48 ? `${prompt.slice(0, 47)}…` : prompt, defaultTitle: false } : {}) }));
  await draw(id, prompt);
}

/** Ask again: the same description drawn again (a new seed unless the chat has a fixed one), in place of the reply. */
async function imageRetry(sessionId: string, messageId?: string) {
  const s = sessionOf(sessionId);
  if (!s) return;
  const at = messageId ? s.messages.findIndex(m => m.id === messageId) : s.messages.length - 1;
  const target = s.messages[at];
  const prompt = [...s.messages.slice(0, at)].reverse().find(m => m.role === 'user')?.content;
  if (!prompt) return;
  await draw(sessionId, prompt, target?.role === 'assistant' ? target.id : undefined);
}

registerImageHooks({ send: imageSend, retry: imageRetry });
