/**
 * Merging two saves of one chat by message id (RESPONSE5.md, item 6), so a device that saves an older copy never drops what another
 * device or Strata itself added meanwhile.
 *
 * Each chat has a side file, <id>.meta.json, kept by the chat store:
 *
 *   { v: 1, rev,
 *     messages: { <id>: { added: rev, changes: [[rev, hash, time], ...], persisted?: true } },
 *     fields:   { <name>: [[rev, hash, time], ...] },          every top-level field of the chat except `messages`
 *     deleted:  { <id>: [rev, time] } }                          messages removed, kept 30 days
 *
 * `hash` is the first 64 bits of the SHA-256 of the canonical JSON (keys sorted, no spaces) of the message or field. Every saved version
 * is recorded, so the merge knows what a message was at any recent base revision and can tell "the device did not touch it" (its copy
 * equals the copy at its base: the stored one wins) from "the device changed it too" (a real conflict: the device's copy wins and the
 * stored one is kept in conflicts/ by the store). History is kept per message and field for 30 days, at most 200 entries.
 *
 * Two rules need no history: a reply a running turn is writing is never replaced by a save, and an old copy that is still `streaming`
 * never replaces a reply that a persisted turn has finished.
 */
import { createHash } from 'node:crypto';

export const META_FORMAT = 1;
const KEEP_CHANGES = 200;
const KEEP_MS = 30 * 24 * 3600_000;
/** Fields every save changes: the newer value is taken and they never count as a conflict. */
const LATEST = new Set(['updatedAt', 'lastReadAt']);

/** JSON with object keys sorted at every level, so two copies that differ only in key order hash the same. */
export function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export const hashOf = value => `h:${createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16)}`;

export const emptyMeta = () => ({ v: META_FORMAT, rev: 0, messages: {}, fields: {}, deleted: {} });

export function readMeta(raw) {
  try {
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (m?.v !== META_FORMAT || typeof m.messages !== 'object' || typeof m.fields !== 'object') return null;
    return { v: META_FORMAT, rev: Number(m.rev) || 0, messages: m.messages ?? {}, fields: m.fields ?? {}, deleted: m.deleted ?? {} };
  } catch { return null; }
}

const messagesOf = session => (Array.isArray(session?.messages) ? session.messages.filter(m => m && typeof m.id === 'string') : []);
const fieldNames = session => Object.keys(session ?? {}).filter(k => k !== 'messages');
const trim = (list, now) => {
  let out = list.length > KEEP_CHANGES ? list.slice(-KEEP_CHANGES) : list;
  // The newest entry always stays, however old: it is what the message is now.
  if (out.length > 1) { const keep = out.filter((e, i) => i === out.length - 1 || now - (e[2] ?? now) <= KEEP_MS); out = keep; }
  return out;
};

/**
 * The side file after `session` was saved as revision `rev`. `persisted` names messages Strata itself wrote in this save (a persisted
 * turn), so the streaming rule can tell them apart. Messages missing from `previous` meta are new at `rev`.
 */
export function advanceMeta(meta, session, rev, { persisted = [], now = Date.now() } = {}) {
  const next = { v: META_FORMAT, rev, messages: { ...meta.messages }, fields: { ...meta.fields }, deleted: { ...meta.deleted } };
  const seen = new Set();
  for (const m of messagesOf(session)) {
    seen.add(m.id);
    const h = hashOf(m);
    const entry = next.messages[m.id];
    if (!entry) next.messages[m.id] = { added: rev, changes: [[rev, h, now]] };
    else if (entry.changes.at(-1)?.[1] !== h) next.messages[m.id] = { ...entry, changes: trim([...entry.changes, [rev, h, now]], now) };
    delete next.deleted[m.id];
  }
  for (const id of persisted) if (next.messages[id]) next.messages[id] = { ...next.messages[id], persisted: true };
  for (const id of Object.keys(next.messages)) if (!seen.has(id)) { delete next.messages[id]; next.deleted[id] = [rev, now]; }
  for (const [id, [, at]] of Object.entries(next.deleted)) if (now - (at ?? now) > KEEP_MS) delete next.deleted[id];
  const names = new Set(fieldNames(session));
  for (const name of new Set([...names, ...Object.keys(next.fields)])) {
    const h = names.has(name) ? hashOf(session[name]) : 'absent';
    const list = next.fields[name] ?? [];
    if (list.at(-1)?.[1] !== h) next.fields[name] = trim([...list, [rev, h, now]], now);
  }
  return next;
}

/** A side file for a chat saved before side files existed: everything counts as already there at revision 0. */
export function baselineMeta(session, now = Date.now()) {
  return { ...advanceMeta(emptyMeta(), session, 0, { now }), rev: 0 };
}

/** What a message or field was at revision `base`: its hash, null when it did not exist then, undefined when history does not reach back. */
function hashAt(changes, base, added = 0) {
  if (added > base) return null;
  let found;
  for (const [rev, h] of changes) { if (rev <= base) found = h; else break; }
  return found;
}
const lastRev = changes => changes.at(-1)?.[0] ?? 0;

/**
 * Merge `incoming` (a device's copy, based on revision `base`) into `stored` (the chat as it is now, described by `meta`).
 * `live(id)` is true for a reply a running turn is writing. Returns { session, conflict, changed } where `changed` says the result
 * differs from `incoming` (the device's copy is missing something it should now show).
 */
export function mergeChat({ stored, incoming, base, meta, live = () => false }) {
  let conflict = false;
  const storedMsgs = messagesOf(stored), incomingMsgs = messagesOf(incoming);
  const storedById = new Map(storedMsgs.map(m => [m.id, m]));
  const incomingIds = new Set(incomingMsgs.map(m => m.id));

  const pick = (s, i) => {
    if (live(s.id)) return s;
    const entry = meta.messages[s.id];
    if (!entry || lastRev(entry.changes) <= base) return i;   // only this device changed it since its base
    const hi = hashOf(i);
    if (hi === hashOf(s)) return s;
    if (entry.persisted && !s.streaming && i.streaming) return s;   // an old copy of a reply that has since finished
    const atBase = hashAt(entry.changes, base, entry.added);
    if (atBase && hi === atBase) return s;                          // the device sent back what it had: the stored copy is newer
    conflict = true;
    return i;
  };

  const out = [];
  for (const i of incomingMsgs) {
    const s = storedById.get(i.id);
    if (s) { out.push(pick(s, i)); continue; }
    const gone = meta.deleted[i.id];
    if (gone && gone[0] > base) continue;   // removed by someone else after this device's base
    out.push(i);
  }
  // Messages the device does not have: kept when it never saw them (added after its base) or a turn is writing them; otherwise it deleted them.
  for (let k = 0; k < storedMsgs.length; k++) {
    const s = storedMsgs[k];
    if (incomingIds.has(s.id)) continue;
    const entry = meta.messages[s.id];
    if (!(live(s.id) || (entry && entry.added > base))) continue;
    let at = 0;
    for (let p = k - 1; p >= 0; p--) { const idx = out.findIndex(m => m.id === storedMsgs[p].id); if (idx >= 0) { at = idx + 1; break; } }
    out.splice(at, 0, s);
  }

  const session = {};
  for (const name of new Set([...fieldNames(incoming), ...fieldNames(stored)])) {
    const has = { s: Object.hasOwn(stored ?? {}, name), i: Object.hasOwn(incoming ?? {}, name) };
    let take;
    if (LATEST.has(name)) take = String(incoming?.[name] ?? '') >= String(stored?.[name] ?? '') ? 'i' : 's';
    else {
      const list = meta.fields[name] ?? [];
      if (!list.length || lastRev(list) <= base) take = 'i';
      else {
        const hi = has.i ? hashOf(incoming[name]) : 'absent', hs = has.s ? hashOf(stored[name]) : 'absent';
        const atBase = hashAt(list, base);
        if (hi === hs || (atBase && hi === atBase)) take = 's';
        else { take = 'i'; conflict = true; }
      }
    }
    if (has[take]) session[name] = take === 'i' ? incoming[name] : stored[name];
  }
  session.messages = out;
  return { session, conflict, changed: canonical(session) !== canonical(incoming) };
}

/** RFC 7396 JSON Merge Patch: objects merge, null removes, everything else (arrays included) replaces. */
export function mergePatch(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}
