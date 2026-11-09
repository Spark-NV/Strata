/**
 * What a persisted turn writes into the chat (RESPONSE5.md, item 3), and the history Strata builds from the chat (item 7).
 *
 * The reply is built from the turn's frames the way the desktop builds it (src/lib/store.ts sendMessage, src/lib/rp.ts rpGenerate,
 * src/lib/image-chat.ts draw), so a chat saved by Strata looks the same as one saved by the desktop. The small helpers below are copies
 * of the desktop's (answer-text.ts, deliverables.ts, agents.ts); tests/turn-record.test.mjs checks they give the same results, so the
 * two cannot drift apart.
 */

// ---- copies of the desktop's helpers ---------------------------------------------------------------------------------------------

const WRAPPER = '(?:think|thinking|thought|analysis|reasoning)';
const TAG = new RegExp(`</?${WRAPPER}(?:\\s[^<>]*)?/?>`, 'gi');
const LOST_LEAD = /^\s*\/?(?:p|br|div|span|li|ul|ol|h[1-6]|b|i|em|strong|code|pre|answer|reply|final|analysis|think|thinking|reasoning)>[ \t]+/i;
/** answer-text.ts tidyAnswer */
export function tidyAnswer(text) {
  if (!text) return text;
  let out = text;
  if (out.indexOf('>') !== -1) { out = out.replace(TAG, ''); out = out.replace(LOST_LEAD, ''); }
  return out;
}

const KINDS = ['html', 'markdown', 'pdf', 'csv', 'image', 'code', 'text', 'other'];
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** deliverables.ts readDeliverable */
export function readDeliverable(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw;
  if (typeof f.path !== 'string' || !f.path) return null;
  const name = typeof f.name === 'string' && f.name ? f.name : f.path.split(/[\\/]/).at(-1) ?? f.path;
  return { path: f.path, abs: typeof f.abs === 'string' ? f.abs : f.path, name, kind: KINDS.includes(String(f.kind)) ? f.kind : 'other',
    status: f.status === 'changed' ? 'changed' : 'created', size: num(f.size), lines: f.lines === null || f.lines === undefined ? null : num(f.lines), added: num(f.added), removed: num(f.removed) };
}
/** deliverables.ts readGroup */
export function readGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw;
  if (typeof g.id !== 'string' || !g.id) return null;
  const files = Array.isArray(g.files) ? g.files.flatMap(x => { const d = readDeliverable(x); return d ? [{ path: d.path, name: d.name, kind: d.kind, status: d.status, added: d.added, removed: d.removed }] : []; }) : [];
  const liveRaw = g.live && typeof g.live === 'object' ? g.live : null;
  const last = text => text.trim().split(/\r?\n/).at(-1).slice(0, 200);
  const live = liveRaw && g.closed !== true ? { ...(typeof liveRaw.label === 'string' && liveRaw.label ? { label: liveRaw.label.slice(0, 160) } : {}), ...(typeof liveRaw.output === 'string' && liveRaw.output.trim() ? { output: last(liveRaw.output) } : {}) } : undefined;
  return { id: g.id, closed: g.closed === true, line: typeof g.line === 'string' ? g.line : '', added: num(g.added), removed: num(g.removed), files, ...(live && (live.label || live.output) ? { live } : {}) };
}
/** deliverables.ts readSkills */
export function readSkills(raw) {
  const list = raw?.skills;
  if (!Array.isArray(list)) return [];
  return list.flatMap(s => (typeof s?.name === 'string' && s.name ? [{ name: s.name, description: typeof s.description === 'string' ? s.description : '' }] : [])).slice(0, 20);
}
/** deliverables.ts appendText */
export function appendText(blocks, text) {
  const list = blocks ?? [], last = list.at(-1);
  if (last?.kind === 'text') return [...list.slice(0, -1), { kind: 'text', text: tidyAnswer(last.text + text) }];
  return [...list, { kind: 'text', text: tidyAnswer(text) }];
}
/** deliverables.ts upsertGroup */
export function upsertGroup(blocks, group) {
  const list = blocks ?? [], at = list.findIndex(b => b.kind === 'group' && b.id === group.id);
  const next = { kind: 'group', ...group };
  return at >= 0 ? list.map((b, i) => (i === at ? next : b)) : [...list, next];
}
/** deliverables.ts mergeDeliverable */
export function mergeDeliverable(list, file) {
  const have = list ?? [], at = have.findIndex(f => f.path === file.path);
  const order = have.reduce((n, f) => Math.max(n, f.order ?? 0), 0) + 1;
  if (at < 0) return [...have, { ...file, order }];
  const old = have[at];
  return have.map((f, i) => (i === at ? { ...file, order, status: old.status === 'created' ? 'created' : file.status, added: old.added + file.added, removed: old.removed + file.removed } : f));
}
const STATUSES = new Set(['working', 'completed', 'failed', 'queued', 'cancelled']);
const metric = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
/** agents.ts updateAgent */
export function updateAgent(agents, frame, now = Date.now()) {
  if (!frame || typeof frame !== 'object') return agents;
  const next = frame;
  if (typeof next.id !== 'string' || !next.id.trim()) return agents;
  const previous = agents.find(a => a.id === next.id);
  const at = metric(next.updatedAt, now);
  if (previous?.updatedAt && at < previous.updatedAt) return agents;
  const previousDuration = (previous?.durationMs ?? 0) + (previous?.status === 'working' && previous.updatedAt ? Math.max(0, at - previous.updatedAt) : 0);
  const agent = { id: next.id, name: typeof next.name === 'string' ? next.name : previous?.name ?? 'Subagent', description: typeof next.description === 'string' ? next.description : previous?.description ?? '',
    status: STATUSES.has(String(next.status)) ? next.status : previous?.status ?? 'queued', durationMs: metric(next.durationMs, previousDuration), tokens: metric(next.tokens, previous?.tokens), updatedAt: at };
  return previous ? agents.map(a => (a.id === agent.id ? agent : a)) : [...agents, agent];
}
/** rp.ts joinContinuation */
export const joinContinuation = (base, more) => (!base || /\s$/.test(base) || /^[\s,.;:!?'")\]…—-]/.test(more) ? base + more : `${base} ${more}`);

/** title-text.ts shortTitle: the first message as the chat's title, cut at a whole character. */
export function shortTitle(text, width = 48) {
  if (text.length <= width) return text;
  const room = width - 1;
  let end = 0;
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (part.index + part.segment.length > room) break;
    end = part.index + part.segment.length;
  }
  return text.slice(0, end).trimEnd() + '…';
}

// ---- ids ---------------------------------------------------------------------------------------------------------------------------

export const validTurnId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{3,127}$/.test(v);
export const validMessageId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v);

/** The pictures a message carries: the phone's iosPhotos and the desktop's photos, each { name, uploadId }. */
export function photosOf(m) {
  const list = [...(Array.isArray(m?.photos) ? m.photos : []), ...(Array.isArray(m?.iosPhotos) ? m.iosPhotos : [])];
  return list.filter(p => p && typeof p === 'object').map(p => ({ name: typeof p.name === 'string' ? p.name : 'Picture', uploadId: typeof p.uploadId === 'string' ? p.uploadId : null }));
}

// ---- history from the chat ---------------------------------------------------------------------------------------------------------

/** store.ts photoHistorySlots: at most three pictures in the model's context, this turn's included, newest first. */
export function photoHistorySlots(messages, currentCount) {
  let room = Math.max(0, 3 - currentCount);
  const slots = new Set();
  for (let m = messages.length - 1; m >= 0 && room; m--) for (let p = (messages[m].photos?.length ?? 0) - 1; p >= 0 && room; p--) { slots.add(`${m}:${p}`); room--; }
  return slots;
}

/**
 * The history of a Chat, Code or Vibe turn, exactly as the desktop sends it (store.ts sendMessage): the messages before this turn that
 * are not Time-skip or local, user and assistant only, with text, the last 40. Pictures in the three-picture window are sent when the
 * model reads pictures and the picture is on the PC (`pictureData(uploadId)` gives a data URL); the rest are named in a note.
 */
export function chatHistory(messages, { currentPictures = 0, canSeePictures = false, pictureData = () => null } = {}) {
  const prior = (Array.isArray(messages) ? messages : [])
    .filter(m => !m.timeSkipId && !m.local)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .filter(m => typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content, photos: photosOf(m).length ? photosOf(m) : undefined }))
    .slice(-40);
  const slots = photoHistorySlots(prior, currentPictures);
  return prior.map((m, index) => {
    const wanted = canSeePictures ? (m.photos ?? []).filter((_, p) => slots.has(`${index}:${p}`)) : [];
    const included = wanted.map(p => ({ p, url: p.uploadId ? pictureData(p.uploadId) : null })).filter(x => x.url);
    const omitted = (m.photos ?? []).filter(p => !included.some(x => x.p === p));
    const text = m.content + (omitted.length ? `\n[Earlier pictures: ${omitted.map(p => p.name).join(', ')}. Their pixels are outside this model's image context; ask to reattach them if needed.]` : '');
    return { role: m.role, content: included.length ? [{ type: 'text', text }, ...included.map(x => ({ type: 'image_url', image_url: { url: x.url } }))] : text };
  });
}

/** rp.ts historyFor: the roleplay history (05). */
export function rpHistory(messages) {
  return (Array.isArray(messages) ? messages : []).filter(m => !m.local && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: m.content, characterId: m.characterId, name: m.name, hidden: m.hidden, at: m.at }));
}

// ---- the reply, from the frames ----------------------------------------------------------------------------------------------------

const replaceMessage = (session, id, fn) => ({ ...session, messages: session.messages.map(m => (m.id === id ? fn(m) : m)) });

/**
 * The recorder of a Chat, Code or Vibe turn (store.ts sendMessage's frame handling, the parts that are saved). `apply(frame)` takes each
 * frame; `into(session)` writes the state so far into a copy of the chat. A message delivered from the queue while a goal runs closes
 * this reply, adds the message and starts a new reply, as the desktop does.
 */
export function createChatRecorder({ replyId, now = () => new Date(), uid = () => `m_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}` }) {
  const replies = [{ id: replyId, patch: {} }];
  const added = [];   // [{ after: replyId, user: message, reply: message }]
  let agents = null, tokensIn = 0, tokensOut = 0, statsAvailable;
  let reasoningStartedAt = null;
  const started = Date.now();
  let cur = replies[0].patch;
  const get = k => cur[k];
  const set = values => Object.assign(cur, values);

  function apply(frame) {
    const type = frame?.type;
    if (type === 'delta') {
      const text = String(frame.text ?? '');
      const content = tidyAnswer((get('content') ?? '') + text);
      const values = { content };
      if (reasoningStartedAt && get('reasoningMs') === undefined) values.reasoningMs = Date.now() - reasoningStartedAt;
      if (get('blocks')) values.blocks = appendText(get('blocks'), text);
      set(values);
    } else if (type === 'reasoning') {
      reasoningStartedAt ??= Date.now();
      set({ reasoning: (get('reasoning') ?? '') + String(frame.text ?? '') });
    } else if (type === 'queued') set({ requestId: String(frame.requestId) });
    else if (type === 'start') {
      set({ demo: frame.demo === true, remoteModel: frame.remoteModel === true, ...(typeof frame.requestId === 'string' ? { requestId: frame.requestId } : {}), model: String(frame.model), contextMax: Number(frame.contextMax), skillsUsed: Array.isArray(frame.skills) ? frame.skills.map(String) : [] });
      if (frame.resumed === true) set({ error: undefined, errorCode: undefined });
    } else if (type === 'resync') {
      const said = String(frame.content ?? ''), thought = String(frame.reasoning ?? '');
      const have = get('content') ?? '';
      if (said) set(said.startsWith(have) ? { content: tidyAnswer(said), ...(get('blocks') && said.length > have.length ? { blocks: appendText(get('blocks'), said.slice(have.length)) } : {}) } : { content: tidyAnswer(said), blocks: undefined });
      if (thought && thought.length >= (get('reasoning') ?? '').length) set({ reasoning: thought });
    } else if (type === 'plan') {
      if (frame.event === 'proposed' && typeof frame.plan?.id === 'string') set({ planId: frame.plan.id });
    } else if (type === 'queued-message') {
      const sent = frame.message;
      if (frame.state === 'delivered' && typeof sent?.text === 'string') {
        set({ streaming: false });
        const before = replies.at(-1).id, next = { id: uid(), patch: {} };
        added.push({ after: before, user: { id: uid(), role: 'user', content: sent.text, at: now().toISOString() }, reply: { id: next.id, role: 'assistant', content: '', at: now().toISOString(), streaming: true } });
        replies.push(next); cur = next.patch; reasoningStartedAt = null;
      }
    } else if (type === 'agent-tool') {
      const tool = frame.tool;
      if (tool && typeof tool.id === 'string') {
        const tools = get('tools') ?? [];
        const existing = tools.find(t => t.id === tool.id);
        const next = { ...existing, ...tool, live: true };
        set({ tools: existing ? tools.map(t => (t.id === tool.id ? next : t)) : [...tools, next] });
      }
    } else if (type === 'agent') agents = updateAgent(agents ?? [], frame.agent);
    else if (type === 'deliverable') { const file = readDeliverable(frame); if (file) set({ deliverables: mergeDeliverable(get('deliverables'), file) }); }
    else if (type === 'skills-used') { const skills = readSkills(frame); if (skills.length) set({ skills }); }
    else if (type === 'activity-group') { const group = readGroup(frame); if (group) set({ blocks: upsertGroup(get('blocks') ?? (get('content') ? appendText(undefined, get('content')) : undefined), group) }); }
    else if (type === 'artifacts' && Array.isArray(frame.artifacts)) set({ artifacts: frame.artifacts });
    else if (type === 'native-tool') {
      const event = frame.event ?? {};
      if (event.id) {
        const tools = get('tools') ?? [];
        const existing = tools.find(t => t.id === event.id);
        const tool = { id: event.id, name: event.name ?? existing?.name ?? 'Connected tool', args: event.arguments ?? existing?.args ?? {}, preview: 'Authorized connected tool', effect: 'Access configured in the MCP server', scope: 'connected',
          state: event.event === 'result' ? (event.ok ? 'done' : 'error') : 'running', result: event.text, durationMs: event.ms };
        set({ tools: [...tools.filter(t => t.id !== tool.id), { ...existing, ...tool }] });
      }
    } else if (type === 'tool') set({ tools: [...(get('tools') ?? []), { ...frame.tool, state: 'proposed' }] });
    else if (type === 'stats') set({ ...(typeof frame.tokensOut === 'number' ? { tokens: frame.tokensOut } : {}), ...(typeof frame.tps === 'number' ? { tps: frame.tps } : {}), ...(typeof frame.promptTps === 'number' ? { promptTps: frame.promptTps } : {}) });
    else if (type === 'context') {
      const used = Number(frame.contextTokens), max = Number(frame.contextMax);
      if (Number.isFinite(used) && used > 0) set({ contextUsed: used, ...(Number.isFinite(max) && max > 0 ? { contextMax: max } : {}) });
    } else if (type === 'error') {
      set({ drafts: undefined, error: String(frame.message ?? 'Engine error'), streaming: false, ...(typeof frame.code === 'string' ? { errorCode: frame.code } : {}), ...(typeof frame.details === 'string' && frame.details ? { errorDetail: frame.details } : {}) });
    } else if (type === 'done') {
      tokensIn += Number(frame.tokensIn ?? 0); tokensOut += Number(frame.tokensOut ?? 0);
      statsAvailable = typeof frame.tokensIn === 'number' && typeof frame.tokensOut === 'number';
      set({ streaming: false, drafts: undefined, durationMs: Number(frame.durationMs ?? Date.now() - started),
        tokens: typeof frame.tokensOut === 'number' ? frame.tokensOut : undefined, ttftMs: typeof frame.ttftMs === 'number' ? frame.ttftMs : undefined,
        inputTokens: typeof frame.tokensIn === 'number' ? frame.tokensIn : undefined, contextUsed: typeof frame.contextTokens === 'number' ? frame.contextTokens : undefined,
        usageSource: frame.usageSource === 'reported' || frame.usageSource === 'demo' ? frame.usageSource : 'unavailable',
        ...(typeof frame.tps === 'number' ? { tps: frame.tps } : {}), ...(typeof frame.promptTps === 'number' ? { promptTps: frame.promptTps } : {}) });
    }
  }

  /** The chat with the turn so far. `end` (a closing state) makes sure no reply is left `streaming`. */
  function into(session, { end = null } = {}) {
    let out = session;
    for (const a of added) {
      if (out.messages.some(m => m.id === a.user.id)) continue;
      const at = out.messages.findIndex(m => m.id === a.after);
      const list = [...out.messages];
      list.splice(at < 0 ? list.length : at + 1, 0, a.user, a.reply);
      out = { ...out, messages: list };
    }
    for (const r of replies) {
      out = replaceMessage(out, r.id, m => {
        const next = { ...m, ...r.patch };
        for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
        if (end && next.streaming) {
          next.streaming = false;
          if (end.error && !next.error) { next.error = end.error; if (end.code) next.errorCode = end.code; }
        }
        if (end && next.durationMs === undefined) next.durationMs = Date.now() - started;
        return next;
      });
    }
    if (agents) out = { ...out, agents };
    if (end) out = { ...out, tokensIn: (Number(out.tokensIn) || 0) + tokensIn, tokensOut: (Number(out.tokensOut) || 0) + tokensOut, ...(statsAvailable !== undefined ? { statsAvailable: statsAvailable && out.messages.filter(m => m.role === 'assistant' && !m.streaming).every(m => typeof m.inputTokens === 'number') } : {}) };
    return out;
  }
  return { apply, into, replyIds: () => replies.map(r => r.id), ended: () => replies.at(-1).patch.streaming === false };
}

/**
 * The recorder of a roleplay turn (rp.ts rpGenerate). `target` is { kind: 'new' | 'swipe' | 'continue' | 'impersonate', messageId }.
 * Impersonate writes nothing. A swipe's new version and a continuation are written into the target reply, as the desktop does; `base`
 * is the target's text when a Continue started.
 */
export function createRpRecorder({ replyId, target, base = '' }) {
  const started = Date.now();
  let text = '', reasoning = '', final = null, error = null, vars = null, reasoningStarted = 0;
  const meta = {};
  function apply(frame) {
    const type = frame?.type;
    if (type === 'rp-speaker') { if (target.kind === 'new' || target.kind === 'swipe') { meta.characterId = String(frame.id ?? '') || undefined; meta.name = String(frame.name ?? ''); } }
    else if (type === 'delta') text += String(frame.text ?? '');
    else if (type === 'reasoning') { reasoning += String(frame.text ?? ''); reasoningStarted ||= Date.now(); }
    else if (type === 'start') { meta.model = String(frame.model ?? ''); meta.contextMax = Number(frame.contextMax) || undefined; }
    else if (type === 'rp-final') { final = String(frame.content ?? text); if (frame.vars && typeof frame.vars === 'object') vars = frame.vars; }
    else if (type === 'done') Object.assign(meta, { ...(typeof frame.tokensOut === 'number' ? { tokens: frame.tokensOut } : {}), ...(typeof frame.tokensIn === 'number' ? { inputTokens: frame.tokensIn } : {}), ...(typeof frame.tps === 'number' ? { tps: frame.tps } : {}), ...(typeof frame.ttftMs === 'number' ? { ttftMs: frame.ttftMs } : {}), usageSource: frame.usageSource === 'reported' ? 'reported' : 'unavailable' });
    else if (type === 'error') error = String(frame.message ?? 'The reply failed.');
  }
  /** The reply as the desktop leaves it at the end (`end`) or while it is written. */
  function into(session, { end = null } = {}) {
    if (target.kind === 'impersonate') return null;
    const out = final ?? text;
    let s = session;
    if (vars && s.rp) s = { ...s, rp: { ...s.rp, vars } };
    const id = target.kind === 'new' ? replyId : target.messageId;
    return replaceMessage(s, id, m => {
      const content = target.kind === 'continue' ? joinContinuation(base, out) : out;
      const next = { ...m, ...meta, content, reasoning: reasoning || (target.kind === 'continue' ? m.reasoning : undefined), streaming: !end, ...(error ? { error } : end?.error && !(final ?? text) ? { error: end.error } : {}),
        ...(end ? { durationMs: Date.now() - started } : {}), ...(reasoning && reasoningStarted && !m.reasoningMs && end ? { reasoningMs: Date.now() - reasoningStarted } : {}) };
      if (end?.code && !error && !(final ?? text)) next.errorCode = end.code;
      const idx = m.swipeIndex ?? 0;
      if (m.swipes?.length) { const swipes = [...m.swipes]; swipes[idx] = content; const sr = [...(m.swipeReasoning ?? [])]; sr[idx] = next.reasoning ?? ''; Object.assign(next, { swipes, swipeReasoning: sr }); }
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
      return next;
    });
  }
  return { apply, into, replyIds: () => (target.kind === 'impersonate' ? [] : [target.kind === 'new' ? replyId : target.messageId]), text: () => final ?? text };
}

/** The recorder of an Image chat turn (image-chat.ts draw): the pictures as they arrive, never the live preview (it is large). */
export function createImageRecorder({ replyId, size }) {
  const started = Date.now();
  const media = [];
  let phase = null, step = 0, steps = null, index = 0, error = null, done = null;
  function apply(frame) {
    const type = frame?.type;
    if (type === 'phase') { const p = frame.phase === 'freeing' ? 'freeing' : frame.phase === 'loading' || frame.phase === 'ready' ? 'loading' : null; if (p) phase = p; }
    else if (type === 'progress') { phase = 'drawing'; step = Number(frame.step) || 0; steps = Number(frame.steps) || steps; index = Number(frame.index) || 0; }
    else if (type === 'image') media.push({ kind: 'image', src: `/api/images/file/${String(frame.file)}`, title: `${size.width}×${size.height} · seed ${Number(frame.seed)}` });
    else if (type === 'done') done = { seconds: Number(frame.seconds) || undefined, request: frame.request };
    else if (type === 'error') error = String(frame.message ?? 'The image failed.');
  }
  function into(session, { end = null } = {}) {
    return replaceMessage(session, replyId, m => {
      const image = { ...(m.image ?? {}), ...(phase ? { phase } : {}), step, ...(steps ? { steps } : {}), index, preview: null };
      if (done) Object.assign(image, { phase: 'done', seconds: done.seconds, request: done.request });
      if (end) image.phase = 'done';
      const next = { ...m, image, ...(media.length ? { media: [...media] } : {}), streaming: !(end || done), ...(error ? { error } : {}) };
      if (done || end) next.durationMs = Date.now() - started;
      if (end && !media.length && !error) { if (end.error) { next.error = end.error; if (end.code) next.errorCode = end.code; } else if (end.state === 'stopped') next.content = 'Stopped.'; }
      return next;
    });
  }
  return { apply, into, replyIds: () => [replyId] };
}
