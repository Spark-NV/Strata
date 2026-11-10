/**
 * The chats, saved by the host as files (owner decision 11-04: the browser's 5 MB storage limit is gone).
 *
 *   <data folder>/chats/index.json         { v: 1, chats: [{ id, rev, createdAt, updatedAt, bytes, title, origin? }] }
 *   <data folder>/chats/<id>.json          { "v": 1, "rev": N, "savedAt": ISO, "origin"?: { via, at }, "session": { ...the chat exactly as the page sent it... } }
 *   <data folder>/chats/conflicts/         the version a later save displaced when two windows saved the same chat from an older copy
 *   <data folder>/chats/index.deleted.json { v: 1, deleted: { <id>: ISO } }: chats the person deleted. A save of one of them is refused
 *                                          (410, code `deleted`), so a window that still holds an old copy cannot bring it back.
 *
 * - One file per chat. A save writes a temporary file next to it, flushes it and renames it over the chat: a crash or a full disk
 *   in the middle leaves the older file whole. Temporary files left by a crash are removed at the next start.
 * - `rev` counts the saves of a chat. A save that names a `baseRev` older than the stored one (a second window saved first) is still
 *   written, but the version it displaces is kept in conflicts/ first, so nothing is lost.
 * - The index is a list for fast start. If it is missing or does not match the files it is rebuilt from the files; a file that cannot
 *   be read is reported and left exactly as it is.
 * - Nothing is cut: the chat is stored byte for byte as received (a text splice, no re-serialising).
 * - Merging (chat-merge.mjs): each chat has a side file <id>.meta.json with the revision and a hash of every version of each message and
 *   top-level field. A save based on an older revision is merged by message id instead of replacing the file, so a device that saves an
 *   older copy never drops what another device or Strata added meanwhile. Strata's own writes (a persisted turn, a PATCH) go through
 *   `update`, on the newest file.
 * - `origin` says where the chat was started (origin.mjs: the iPhone app, the web page from away, this PC or another program). Strata writes
 *   it once, with the first save, outside the session, so no device's later save can change or drop it. Chats from before have none.
 * - Owner-only: the folder is created private (POSIX 0700 and files 0600; on Windows the folder gets a protected ACL that its files
 *   inherit), the same level as the rest of the profile.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { open, readFile, rename, unlink, mkdir, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { advanceMeta, baselineMeta, emptyMeta, mergeChat, mergePatch, readMeta } from './chat-merge.mjs';

export const CHAT_FORMAT = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|index|import|conflicts)(\.|$)/i;
const KEEP_CONFLICTS = 5;

export class ChatStoreError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

/** The disk operations, replaceable in tests to make a disk full, a permission failure or a crash in the middle of a write. */
export const realIo = {
  async writeFile(path, text) {
    const handle = await open(path, 'w', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  },
  rename, unlink, copyFile, readFile, readdir, mkdir,
};

const VIA = new Set(['ios-app', 'remote-web', 'pc', 'remote-api', 'local-api']);
/** An origin as stored ({ via, at }), or null for anything else. */
export const validOrigin = o => (o && typeof o === 'object' && VIA.has(o.via) && typeof o.at === 'string' ? { via: o.via, at: o.at } : null);

/** The first 160 characters of the last message with text, and who wrote it. */
function previewOf(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const text = typeof msgs[i]?.content === 'string' ? msgs[i].content.trim() : '';
    if (text) return { role: String(msgs[i].role ?? ''), text: Array.from(text.slice(0, 400)).slice(0, 160).join('') };
  }
  return null;
}

export const validChatId = id => typeof id === 'string' && ID.test(id) && !RESERVED.test(id);

/** Map a failed disk operation to what the page is told: a full disk and a refused write are different words for the same "not saved". */
export function storeFailure(error) {
  if (error instanceof ChatStoreError) return error;
  const code = error?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EFBIG') return new ChatStoreError('The disk is full.', 507, 'disk-full');
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new ChatStoreError('Strata may not write its chat folder.', 403, 'permission');
  return new ChatStoreError(error?.message ?? 'The chat could not be written.', 500, code ?? 'write-failed');
}

export function createChatStore({ dir, io = realIo, privateDir = () => {}, now = () => new Date() }) {
  const root = join(dir, 'chats');
  const conflictsDir = join(root, 'conflicts');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { privateDir(root); } catch { /* the folder is inside the profile; the tighter ACL is best effort */ }
  let tmpCount = 0;
  let index = new Map();   // id -> entry
  const damaged = new Set();
  // Deleted chats: an id is never reused (new chats get new random ids), so a save of one of these is an old copy coming back.
  const deletedFile = join(root, 'index.deleted.json');
  let deleted = {};
  try { const parsed = JSON.parse(readFileSync(deletedFile, 'utf8')); if (parsed?.deleted && typeof parsed.deleted === 'object') deleted = parsed.deleted; } catch { /* none yet */ }

  const fileOf = id => join(root, `${id}.json`);
  const metaOf = id => join(root, `${id}.meta.json`);
  // Which replies a running turn is writing (set by the turn ledger): a save never replaces them.
  let liveReply = () => false;
  let onRemove = () => {};
  const bytesOf = text => Buffer.byteLength(text, 'utf8');
  // What a chat list needs without opening each chat (phase 3): its kind, flags, how many messages and the last words.
  const entryOf = (id, rev, session, bytes, origin = null) => {
    const msgs = Array.isArray(session?.messages) ? session.messages : [];
    return { id, rev, createdAt: session?.createdAt ?? null, updatedAt: session?.updatedAt ?? null, bytes, title: typeof session?.title === 'string' ? session.title.slice(0, 200) : '',
      ...(typeof session?.profile === 'string' ? { profile: session.profile } : {}), pinned: session?.pinned === true, archived: session?.archived === true,
      lastReadAt: typeof session?.lastReadAt === 'string' ? session.lastReadAt : null, messages: msgs.length, preview: previewOf(msgs), ...(origin ? { origin } : {}) };
  };
  // Changes since a cursor (phase 3): a counter for this run of the host; a cursor from an earlier run gets the whole list.
  const boot = Math.random().toString(36).slice(2, 8);
  let changeCount = 0;
  const changedAt = new Map(), deletedAt = new Map();   // id -> change number
  const cursor = () => `c_${boot}_${changeCount}`;

  // A chain, so saves of one host never overlap: the file, the index and the conflicts folder change one save at a time.
  let chain = Promise.resolve();
  const queue = work => { const run = chain.then(work, work); chain = run.catch(() => {}); return run; };

  function loadSync() {
    // Temporary files from a write that never finished.
    let names = [];
    try { names = readdirSync(root); } catch { /* empty */ }
    for (const name of names) if (/\.tmp-\d+-\d+$/.test(name)) { try { unlinkSync(join(root, name)); } catch { /* left */ } }
    const files = names.filter(n => n.endsWith('.json') && !n.endsWith('.meta.json') && n !== 'index.json' && n !== 'index.deleted.json' && n !== 'turns.json' && !/\.tmp-/.test(n)).map(n => n.slice(0, -5)).filter(validChatId);
    let saved = null;
    try { const parsed = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')); if (parsed?.v === CHAT_FORMAT && Array.isArray(parsed.chats)) saved = parsed.chats; } catch { /* rebuilt below */ }
    const map = new Map();
    // Entries written before the list had kinds and previews (no `messages`) are read again from their files, once.
    if (saved) for (const e of saved) if (e && validChatId(e.id) && files.includes(e.id) && Number.isInteger(e.messages)) map.set(e.id, e);
    // Files the index does not know (a crash before the index was written, an index lost): read from the files.
    for (const id of files) {
      if (map.has(id)) continue;
      try {
        const parsed = JSON.parse(readFileSync(fileOf(id), 'utf8'));
        if (parsed?.v !== CHAT_FORMAT || !parsed.session || parsed.session.id !== id) throw new Error('not a chat file');
        map.set(id, entryOf(id, Number(parsed.rev) || 1, parsed.session, statSync(fileOf(id)).size, validOrigin(parsed.origin)));
      } catch { damaged.add(id); }
    }
    index = map;
  }
  loadSync();

  async function writeAtomic(path, text) {
    const temp = `${path}.tmp-${process.pid}-${++tmpCount}`;
    try {
      await io.writeFile(temp, text);
      for (let attempt = 0; ; attempt++) {
        try { await io.rename(temp, path); break; }
        catch (e) { if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e; await new Promise(r => setTimeout(r, 40 * (attempt + 1))); }   // an antivirus scan holds the file for a moment on Windows
      }
    } catch (e) {
      try { await io.unlink(temp); } catch { /* nothing to remove */ }
      throw e;
    }
  }

  async function writeIndex() {
    const list = [...index.values()];
    try { await writeAtomic(join(root, 'index.json'), JSON.stringify({ v: CHAT_FORMAT, savedAt: now().toISOString(), chats: list })); }
    catch { /* only a list: it is rebuilt from the files when it does not match */ }
  }

  async function keepDisplaced(id, rev) {
    try {
      await io.mkdir(conflictsDir, { recursive: true });
      await io.copyFile(fileOf(id), join(conflictsDir, `${id}.rev${rev}.json`));
      const mine = (await io.readdir(conflictsDir)).filter(n => n.startsWith(`${id}.rev`)).sort((a, b) => Number(a.match(/rev(\d+)/)?.[1]) - Number(b.match(/rev(\d+)/)?.[1]));
      for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_CONFLICTS))) { try { await io.unlink(join(conflictsDir, old)); } catch { /* left */ } }
    } catch (e) {
      throw storeFailure(e);   // not saved rather than saved over the only copy of the other window's work
    }
  }

  /** The side file of a chat; one saved before side files existed gets a baseline from its stored copy (everything counts as old). */
  async function metaFor(id, storedSession) {
    try { const m = readMeta(await io.readFile(metaOf(id), 'utf8')); if (m) return m; } catch { /* none yet */ }
    if (storedSession !== undefined) return storedSession ? baselineMeta(storedSession, now().getTime()) : emptyMeta();
    if (!index.has(id)) return emptyMeta();
    try { return baselineMeta(JSON.parse(await io.readFile(fileOf(id), 'utf8')).session, now().getTime()); } catch { return emptyMeta(); }
  }
  async function writeMeta(id, meta) {
    try { await writeAtomic(metaOf(id), JSON.stringify(meta)); }
    catch { try { await io.unlink(metaOf(id)); } catch { /* the next save builds it again */ } }
  }
  async function storedSession(id) {
    const parsed = JSON.parse(await io.readFile(fileOf(id), 'utf8'));
    if (parsed?.v !== CHAT_FORMAT || !parsed.session) throw new ChatStoreError('The stored chat cannot be read.', 500, 'damaged');
    return parsed.session;
  }
  /** Write `session` as the next revision (inside the queue). */
  async function writeRevision(id, session, text, { persisted = [], meta, origin = null } = {}) {
    const current = index.get(id);
    const rev = (current?.rev ?? 0) + 1;
    // Where the chat was started: set by its first save only, then carried by every later one.
    const from = current ? current.origin ?? null : validOrigin(origin);
    const file = `{"v":${CHAT_FORMAT},"rev":${rev},"savedAt":${JSON.stringify(now().toISOString())},${from ? `"origin":${JSON.stringify(from)},` : ''}"session":${text}}`;
    try { await writeAtomic(fileOf(id), file); } catch (e) { throw storeFailure(e); }
    const bytes = bytesOf(file);
    index.set(id, entryOf(id, rev, session, bytes, from));
    changedAt.set(id, ++changeCount); deletedAt.delete(id);
    damaged.delete(id);
    await writeIndex();
    await writeMeta(id, advanceMeta(meta, session, rev, { persisted, now: now().getTime() }));
    return { rev, bytes };
  }

  return {
    root,
    /** `fn(chatId, messageId)` is true for a reply a running turn is writing. */
    setLive(fn) { liveReply = fn; },
    /** Called with the id of a chat the person deleted (its pictures go with it). */
    setOnRemove(fn) { onRemove = fn; },
    /** The chats, newest first. */
    list({ deletedSince = null } = {}) {
      const chats = [...index.values()].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || a.id.localeCompare(b.id));
      if (deletedSince === null) return { v: CHAT_FORMAT, chats, damaged: [...damaged], cursor: cursor() };
      // Asked for (a device that was away): the chats deleted since then, so it drops its copies of them.
      const gone = Object.entries(deleted).filter(([, at]) => String(at) > deletedSince).map(([id, at]) => ({ id, at })).sort((a, b) => a.at.localeCompare(b.at));
      return { v: CHAT_FORMAT, chats, damaged: [...damaged], deleted: gone, now: now().toISOString(), cursor: cursor() };
    },
    /** Only what changed since `since` (a cursor from an earlier answer); everything, with full: true, when it cannot tell. */
    changes(since) {
      const m = /^c_([a-z0-9]+)_(\d+)$/.exec(String(since ?? ''));
      if (!m || m[1] !== boot || Number(m[2]) > changeCount) return { v: CHAT_FORMAT, cursor: cursor(), changed: this.list().chats, deleted: [], full: true };
      const n = Number(m[2]);
      const changed = [...index.values()].filter(e => (changedAt.get(e.id) ?? 0) > n);
      const deleted = [...deletedAt].filter(([, at]) => at > n).map(([id]) => id);
      return { v: CHAT_FORMAT, cursor: cursor(), changed, deleted, full: false };
    },
    /** A chat with only its last `last` messages, or the `limit` messages before `before` (phase 3: long chats in pages). */
    async page(id, { last = null, before = null, limit = 50 } = {}) {
      const text = await this.read(id);
      if (text === null) return null;
      const file = JSON.parse(text);
      const msgs = Array.isArray(file.session?.messages) ? file.session.messages : [];
      if (before !== null) {
        const end = msgs.findIndex(m => m?.id === before);
        if (end < 0) throw new ChatStoreError('That message is not in this chat.', 404, 'no-message');
        const from = Math.max(0, end - limit);
        return { id, rev: file.rev, messages: msgs.slice(from, end), messagesFrom: from, more: from > 0 };
      }
      const from = Math.max(0, msgs.length - last);
      // `partial` marks a copy that is missing messages: a whole-chat save of it is refused, so it can never delete the older ones.
      return { ...file, session: { ...file.session, messages: msgs.slice(from), ...(from > 0 ? { partial: { messagesFrom: from, messagesTotal: msgs.length } } : {}) }, messagesTotal: msgs.length, messagesFrom: from };
    },
    has: id => index.has(id),
    wasDeleted: id => Object.hasOwn(deleted, id),
    origin: id => index.get(id)?.origin ?? null,
    rev: id => index.get(id)?.rev ?? 0,
    /** The stored file text of a chat ({"v","rev","savedAt","session"}), or null. */
    async read(id) {
      if (!validChatId(id) || !index.has(id)) return null;
      try { return await io.readFile(fileOf(id), 'utf8'); }
      catch (e) { if (e?.code === 'ENOENT') { index.delete(id); return null; } throw storeFailure(e); }
    },
    /**
     * Save one chat. `sessionText` is the chat's JSON as the page wrote it. Resolves { id, rev, bytes, conflict }.
     * Rejects with a ChatStoreError (status 400 for a chat that is not a chat, 507 disk full, 403 refused, 500 other): nothing was changed.
     */
    save(id, sessionText, { baseRev = null, returnChat = false, origin = null } = {}) {
      if (!validChatId(id)) return Promise.reject(new ChatStoreError('That is not a chat id.', 400, 'bad-id'));
      let session;
      try { session = JSON.parse(sessionText); } catch { return Promise.reject(new ChatStoreError('The chat must be JSON.', 400, 'bad-json')); }
      if (!session || typeof session !== 'object' || Array.isArray(session) || session.id !== id) return Promise.reject(new ChatStoreError('The chat does not match its id.', 400, 'bad-chat'));
      const body = sessionText.trim();
      if (Object.hasOwn(deleted, id)) return Promise.reject(new ChatStoreError('This chat was deleted.', 410, 'deleted'));
      if (session.partial) return Promise.reject(new ChatStoreError('This copy of the chat holds only its last messages; change it with PATCH or messages.', 400, 'partial-chat'));
      return queue(async () => {
        const current = index.get(id);
        const stale = !!current && baseRev !== null && Number(baseRev) !== current.rev;
        if (!stale) {
          const meta = await metaFor(id);
          const { rev, bytes } = await writeRevision(id, session, body, { meta, origin });
          return { id, rev, bytes, conflict: false };
        }
        // Saved from an older copy: the version it would displace is kept (as before), and the save is merged by message id.
        await keepDisplaced(id, current.rev);
        let stored;
        try { stored = await storedSession(id); } catch (e) { throw storeFailure(e); }
        const meta = await metaFor(id, stored);
        const result = mergeChat({ stored, incoming: session, base: Number(baseRev), meta, live: mid => liveReply(id, mid) });
        const text = result.changed ? JSON.stringify(result.session) : body;
        const { rev, bytes } = await writeRevision(id, result.session, text, { meta });
        // `rev` is the revision the saving device's copy matches: after a merge that added what it did not have, that is still its base,
        // so its next save is merged too and it never drops those messages. `storedRev` is the chat's real revision.
        return { id, rev: result.changed && !returnChat ? Number(baseRev) : rev, storedRev: rev, bytes, conflict: result.conflict, merged: true, changed: result.changed, ...(returnChat ? { session: result.session } : {}) };
      });
    },
    /**
     * Strata's own write: `fn(session)` returns the changed chat (or null for no change), applied to the newest file. `persisted` names
     * messages a persisted turn wrote. Resolves { id, rev, session } or null when nothing changed. 404 / 410 when the chat is gone.
     */
    update(id, fn, { persisted = [] } = {}) {
      if (!validChatId(id)) return Promise.reject(new ChatStoreError('That is not a chat id.', 400, 'bad-id'));
      return queue(async () => {
        if (Object.hasOwn(deleted, id)) throw new ChatStoreError('This chat was deleted.', 410, 'deleted');
        if (!index.has(id)) throw new ChatStoreError('No such chat.', 404, 'not-found');
        let stored;
        try { stored = await storedSession(id); } catch (e) { throw storeFailure(e); }
        const next = fn(structuredClone(stored));
        if (!next) return null;
        if (next.id !== id) throw new ChatStoreError('The chat does not match its id.', 400, 'bad-chat');
        const meta = await metaFor(id, stored);
        const { rev } = await writeRevision(id, next, JSON.stringify(next), { persisted, meta });
        return { id, rev, session: next };
      });
    },
    /** JSON Merge Patch on the top-level fields of a chat (never `messages` or `id`). */
    patch(id, patch, { baseRev = null } = {}) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return Promise.reject(new ChatStoreError('The patch must be a JSON object.', 400, 'bad-patch'));
      if (Object.hasOwn(patch, 'messages')) return Promise.reject(new ChatStoreError('Messages cannot be patched here.', 400, 'use-messages'));
      if (Object.hasOwn(patch, 'id')) return Promise.reject(new ChatStoreError('A chat id cannot be changed.', 400, 'bad-patch'));
      const readOnly = Object.keys(patch).length > 0 && Object.keys(patch).every(k => k === 'lastReadAt');
      const conflict = baseRev !== null && index.has(id) && Number(baseRev) !== index.get(id).rev;
      return this.update(id, session => {
        const next = mergePatch(session, patch);
        next.id = id; next.messages = session.messages;
        if (!readOnly && !Object.hasOwn(patch, 'updatedAt')) next.updatedAt = now().toISOString();
        return next;
      }).then(r => (r ? { id, rev: r.rev, conflict, readOnly } : { id, rev: index.get(id)?.rev ?? 0, conflict, readOnly }));
    },
    /**
     * Add, change or remove messages (phase 2): `upsert` replaces a message with the same id as a whole, or adds it (after `after`, else at
     * the end); `remove` deletes by id, unknown ids are ignored. On the newest file, so nothing anyone else saved is lost. The same request
     * twice changes nothing the second time. 409 turn-running when it would touch a reply a running turn is writing.
     */
    messages(id, { upsert = [], remove = [], after = null } = {}, { baseRev = null } = {}) {
      if (!Array.isArray(upsert) || !Array.isArray(remove)) return Promise.reject(new ChatStoreError('upsert and remove must be lists.', 400, 'bad-messages'));
      for (const m of upsert) if (!m || typeof m !== 'object' || Array.isArray(m) || !validChatId(m.id) || typeof m.role !== 'string') return Promise.reject(new ChatStoreError('Each message needs an id and a role.', 400, 'bad-messages'));
      if (new Set(upsert.map(m => m.id)).size !== upsert.length || upsert.some(m => remove.includes(m.id))) return Promise.reject(new ChatStoreError('A message id appears twice.', 400, 'bad-messages'));
      if (remove.some(r => typeof r !== 'string') || (after !== null && typeof after !== 'string')) return Promise.reject(new ChatStoreError('remove must list ids, and after must be an id.', 400, 'bad-messages'));
      for (const mid of [...upsert.map(m => m.id), ...remove]) if (liveReply(id, mid)) return Promise.reject(new ChatStoreError('A reply that is still being written cannot be changed.', 409, 'turn-running'));
      const conflict = baseRev !== null && index.has(id) && Number(baseRev) !== index.get(id).rev;
      return this.update(id, session => {
        const list = Array.isArray(session.messages) ? session.messages : [];
        const byId = new Map(upsert.map(m => [m.id, m]));
        const gone = new Set(remove);
        const next = list.filter(m => !gone.has(m?.id)).map(m => byId.get(m?.id) ?? m);
        const fresh = upsert.filter(m => !list.some(x => x?.id === m.id));
        const at = after === null ? -1 : next.findIndex(m => m?.id === after);
        if (at >= 0) next.splice(at + 1, 0, ...fresh); else next.push(...fresh);
        if (JSON.stringify(next) === JSON.stringify(list)) return null;
        return { ...session, messages: next, updatedAt: now().toISOString() };
      }).then(r => (r ? { id, rev: r.rev, conflict } : { id, rev: index.get(id)?.rev ?? 0, conflict, unchanged: true }));
    },
    /** Delete a chat (the person deleted it). A chat that is not there is already gone. */
    remove(id) {
      if (!validChatId(id)) return Promise.reject(new ChatStoreError('That is not a chat id.', 400, 'bad-id'));
      return queue(async () => {
        try { await io.unlink(fileOf(id)); } catch (e) { if (e?.code !== 'ENOENT') throw storeFailure(e); }
        try { await io.unlink(metaOf(id)); } catch { /* none */ }
        try { onRemove(id); } catch { /* its pictures are cleaned up later */ }
        const had = index.delete(id);
        changedAt.delete(id); deletedAt.set(id, ++changeCount);
        deleted = { ...deleted, [id]: now().toISOString() };
        try { await writeAtomic(deletedFile, JSON.stringify({ v: CHAT_FORMAT, deleted })); } catch (e) { throw storeFailure(e); }
        await writeIndex();
        return { id, removed: had };
      });
    },
    /** Chats from the browser's old storage: every one the host does not have yet is saved; the ones it has are left alone. */
    async importMany(sessions, { origin = null } = {}) {
      const imported = [], skipped = [], failed = [];
      for (const session of Array.isArray(sessions) ? sessions : []) {
        const id = session?.id;
        if (!validChatId(id)) { failed.push({ id: String(id ?? ''), error: 'not a chat id' }); continue; }
        if (index.has(id) || Object.hasOwn(deleted, id)) { skipped.push(id); continue; }
        try { await this.save(id, JSON.stringify(session), { origin }); imported.push(id); }
        catch (e) { failed.push({ id, error: e.message, code: e.code }); if (e.code === 'disk-full') break; }
      }
      return { imported, skipped, failed };
    },
    /** Wait until every save queued so far is on disk (tests, shutdown). */
    idle: () => chain,
  };
}
