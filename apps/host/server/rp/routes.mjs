/**
 * The roleplay API: the library (characters, personas, lorebooks), import and export of cards and lorebooks, the roleplay settings,
 * the prompt inspector and generation.
 *
 *   GET    /api/rp/library                         everything in the library, and the settings
 *   POST   /api/rp/characters                      create or save a character (body: the character)
 *   DELETE /api/rp/characters/:id
 *   POST   /api/rp/characters/:id/duplicate
 *   GET    /api/rp/characters/:id/avatar           the picture
 *   PUT    /api/rp/characters/:id/avatar           {data: base64}
 *   GET    /api/rp/characters/:id/export?format=png|json   a card SillyTavern and other apps read (PNG carries V2 and V3)
 *   POST   /api/rp/personas, DELETE /api/rp/personas/:id, GET|PUT /api/rp/personas/:id/avatar
 *   POST   /api/rp/lorebooks, DELETE /api/rp/lorebooks/:id, GET /api/rp/lorebooks/:id/export   (SillyTavern World Info JSON)
 *   POST   /api/rp/import                          {filename, data: base64}: a card (PNG or JSON) or a lorebook
 *   PUT    /api/rp/settings, POST /api/rp/settings/reset
 *   POST   /api/rp/preview                         the prompt a generation would send, and what went in
 *   POST   /api/rp/generate                        one reply (NDJSON frames: rp-speaker, start, reasoning, delta, done, rp-final, error)
 */
import { json, error, readBody } from '../util.mjs';
import { BLANK_PNG, bookToWorldInfo, characterToCard, isPng, pngWithCard, readImport } from './cards.mjs';
import { buildRpPrompt, finishReply, selectSpeaker } from './prompt.mjs';
import { normalizeAuthorsNote } from './store.mjs';
import { isPrivateHost } from '../agent/llm-shape.mjs';
import { offlineModelRefusal } from '../profiles.mjs';

const MODES = ['normal', 'continue', 'impersonate'];

function fileName(name, ext) { return `${String(name || 'character').replace(/[^\p{L}\p{N} _.-]+/gu, '').trim().slice(0, 80) || 'character'}.${ext}`; }

export function createRpRoutes({ rp, modelProviders, pinned, profileStore, profileSampling, log = () => {} }) {
  /** The chat's own settings (from the page) resolved against the library. */
  function resolveChat(chat = {}) {
    const settings = rp.settings();
    const characters = (Array.isArray(chat.characterIds) ? chat.characterIds : []).map(id => rp.characters.get(id)).filter(Boolean);
    const personaId = typeof chat.personaId === 'string' ? chat.personaId : settings.defaultPersonaId;
    const persona = personaId ? rp.personas.get(personaId) : null;
    const bookIds = new Set([...settings.worldInfo.globalBooks, ...(Array.isArray(chat.lorebookIds) ? chat.lorebookIds : []), ...characters.flatMap(c => c.lorebookIds), ...(persona?.lorebookId ? [persona.lorebookId] : [])]);
    const books = [...bookIds].map(id => rp.lorebooks.get(id)).filter(Boolean);
    for (const c of characters) if (c.book?.entries.length) books.push({ ...c.book, id: `char-${c.id}`, name: c.book.name || `${c.name}'s lorebook` });
    const muted = Array.isArray(chat.muted) ? chat.muted.map(String) : [];
    return { settings, characters, persona, books, muted, authorsNote: normalizeAuthorsNote(chat.authorsNote ?? settings.authorsNote), vars: chat.vars && typeof chat.vars === 'object' ? { ...chat.vars } : {} };
  }

  function history(raw) {
    return (Array.isArray(raw) ? raw : []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map(m => ({
      role: m.role, content: m.content.slice(0, 400_000), characterId: typeof m.characterId === 'string' ? m.characterId : undefined,
      name: typeof m.name === 'string' ? m.name : undefined, hidden: m.hidden === true, at: typeof m.at === 'string' ? m.at : undefined,
    }));
  }

  async function plan(body) {
    const c = resolveChat(body.chat);
    const msgs = history(body.history);
    const mode = MODES.includes(body.mode) ? body.mode : 'normal';
    let speakerId = typeof body.speakerId === 'string' ? body.speakerId : null;
    if (mode === 'continue') speakerId = [...msgs].reverse().find(m => m.role === 'assistant')?.characterId ?? speakerId;
    if (!speakerId || !c.characters.some(x => x.id === speakerId)) speakerId = c.characters.length > 1 ? selectSpeaker({ characters: c.characters, messages: msgs, strategy: c.settings.group.strategy, allowSelfResponses: c.settings.group.allowSelfResponses, muted: c.muted }) : c.characters[0]?.id ?? null;
    const selection = pinned ? await pinned.ensure() : body.remoteModel;
    if (!selection) throw new Error('Choose a model first.');
    const { connection, model } = modelProviders.resolve(selection);
    // Offline (the chat's switch): roleplay has no tools, so the one way out is a model on the internet; that is refused.
    if (body.offline === true && !isPrivateHost(connection.baseUrl)) throw Object.assign(new Error(offlineModelRefusal(model.name || connection.name)), { code: 'offline-model' });
    const built = buildRpPrompt({ settings: c.settings, characters: c.characters, speakerId, persona: c.persona, books: c.books, history: msgs, authorsNote: c.authorsNote, mode, contextMax: model.contextMax || 32768, vars: c.vars, chatId: String(body.sessionId ?? ''), model: model.name });
    return { ...built, selection, model, settings: c.settings, mode };
  }

  return async function handle(req, res, path, method, url) {
    if (!path.startsWith('/api/rp/')) return false;
    const parts = path.slice('/api/rp/'.length).split('/');
    const [area, id, sub] = parts;
    const coll = { characters: rp.characters, personas: rp.personas, lorebooks: rp.lorebooks }[area];
    try {
      if (area === 'library' && method === 'GET') {
        json(res, 200, { characters: rp.characters.list().sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt.localeCompare(a.updatedAt)), personas: rp.personas.list(), lorebooks: rp.lorebooks.list(), settings: rp.settings() });
        return true;
      }
      if (coll && !id && method === 'POST') { json(res, 200, coll.save(await readBody(req, 20 * 1024 * 1024))); return true; }
      if (coll && id && !sub && method === 'DELETE') { json(res, 200, { removed: coll.remove(id) }); return true; }
      if (coll && id && sub === 'duplicate' && method === 'POST') {
        const item = coll.get(id); if (!item) { error(res, 404, 'Not found.'); return true; }
        const copy = coll.save({ ...item, id: undefined, name: `${item.name} (copy)`, createdAt: undefined });
        const img = coll.image(id); if (img) { coll.setImage(copy.id, img.data); coll.save({ ...copy, avatar: true }); }
        json(res, 200, coll.get(copy.id)); return true;
      }
      if (coll && id && sub === 'avatar' && method === 'GET') {
        const img = coll.image(id); if (!img) { error(res, 404, 'No picture.'); return true; }
        res.writeHead(200, { 'content-type': img.type, 'cache-control': 'no-cache' }); res.end(img.data); return true;
      }
      if (coll && id && sub === 'avatar' && method === 'PUT') {
        const item = coll.get(id); if (!item) { error(res, 404, 'Not found.'); return true; }
        const body = await readBody(req, 30 * 1024 * 1024);
        if (body.data === null) { coll.removeImage(id); json(res, 200, coll.save({ ...item, avatar: false })); return true; }
        coll.setImage(id, Buffer.from(String(body.data ?? ''), 'base64'));
        json(res, 200, coll.save({ ...item, avatar: true })); return true;
      }
      if (area === 'characters' && id && sub === 'export' && method === 'GET') {
        const c = rp.characters.get(id); if (!c) { error(res, 404, 'Not found.'); return true; }
        if (url.searchParams.get('format') === 'json') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${encodeURIComponent(fileName(c.name, 'json'))}"` });
          res.end(JSON.stringify(characterToCard(c), null, 2)); return true;
        }
        const img = rp.characters.image(id);
        const png = pngWithCard(img && isPng(img.data) ? img.data : BLANK_PNG, c);
        res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': `attachment; filename="${encodeURIComponent(fileName(c.name, 'png'))}"` });
        res.end(png); return true;
      }
      if (area === 'lorebooks' && id && sub === 'export' && method === 'GET') {
        const b = rp.lorebooks.get(id); if (!b) { error(res, 404, 'Not found.'); return true; }
        res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${encodeURIComponent(fileName(b.name, 'json'))}"` });
        res.end(JSON.stringify(bookToWorldInfo(b), null, 2)); return true;
      }
      if (area === 'import' && method === 'POST') {
        const body = await readBody(req, 40 * 1024 * 1024);
        const got = readImport(Buffer.from(String(body.data ?? ''), 'base64'), String(body.filename ?? ''));
        if (got.kind === 'lorebook') { json(res, 200, { kind: 'lorebook', item: rp.lorebooks.save(got.book) }); return true; }
        let c = rp.characters.save(got.character);
        if (got.avatar) { rp.characters.setImage(c.id, got.avatar); c = rp.characters.save({ ...c, avatar: true }); }
        json(res, 200, { kind: 'character', item: c }); return true;
      }
      if (area === 'settings' && !id && method === 'PUT') { json(res, 200, rp.saveSettings(await readBody(req))); return true; }
      if (area === 'settings' && id === 'reset' && method === 'POST') { json(res, 200, rp.resetSettings()); return true; }
      if (area === 'preview' && method === 'POST') {
        const p = await plan(await readBody(req, 20 * 1024 * 1024));
        json(res, 200, { messages: p.messages, stop: p.stop, speaker: p.speaker, info: p.info }); return true;
      }
      if (area === 'generate' && method === 'POST') { await generate(req, res); return true; }
    } catch (e) {
      if (!res.headersSent) error(res, 400, e.message); else res.end();
      return true;
    }
    return false;
  };

  async function generate(req, res) {
    const body = await readBody(req, 20 * 1024 * 1024);
    let p;
    try { p = await plan(body); } catch (e) { error(res, e.code === 'offline-model' ? 409 : /model/i.test(e.message) ? 503 : 400, e.message); return; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
    const write = frame => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(frame)}\n`); };
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const profile = profileStore.get('rp');
    write({ type: 'rp-speaker', id: p.speaker.id, name: p.speaker.name, mode: p.mode, info: { tokens: p.info.tokens, droppedMessages: p.info.droppedMessages, worldInfo: p.info.worldInfo.activated.length } });
    const extra = { ...profileSampling(profile), ...(profile.maxTokens ? { max_tokens: profile.maxTokens } : {}), ...(profile.thinkingBudget > 0 ? { reasoning_budget_tokens: profile.thinkingBudget } : {}), ...(p.stop.length ? { stop: p.stop } : {}) };
    const thinking = body.thinking === 'off' ? 'off' : (typeof body.thinking === 'string' ? body.thinking : profile.effort).toLowerCase();
    let text = '';
    try {
      await modelProviders.stream({ selection: p.selection, prompt: p.messages, thinking, extra, signal: controller.signal, onFrame: frame => {
        if (frame.type === 'delta') text += frame.text;
        write({ ...frame, model: p.model.name, contextMax: p.model.contextMax, remoteModel: true });
      } });
      let final = text;
      if (p.namePrefix && final.trimStart().startsWith(p.namePrefix)) final = final.trimStart().slice(p.namePrefix.length).trimStart();
      if (p.mode !== 'continue') final = final.replace(/^\s+/, '');
      write({ type: 'rp-final', content: finishReply(final, p.settings, 'output'), vars: p.vars });
    } catch (e) {
      const message = controller.signal.aborted ? 'Stopped. What was written so far is kept.' : e.message;
      if (text) write({ type: 'rp-final', content: text, vars: p.vars, partial: true });
      write({ type: 'error', message });
      log(`rp ·  generation failed: ${e.message}`);
    }
    res.end();
  }
}
