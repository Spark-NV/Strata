/**
 * Character cards and lorebooks in the formats other roleplay apps use, read and written.
 *
 *   - Character cards: Tavern V1 (flat JSON), V2 (`chara_card_v2`) and V3 (`chara_card_v3`), as JSON or inside a PNG
 *     (`tEXt` chunks named `chara` (V2, base64 JSON) and `ccv3` (V3)). Export writes both chunks into the avatar, as
 *     SillyTavern does, so either kind of reader takes the file.
 *   - Lorebooks: SillyTavern's World Info JSON (`entries` keyed by uid) and the V2 `character_book` inside a card.
 *
 * The app's own shapes are plain (see `normalizeCharacter`, `normalizeBook`). Fields the app does not use are kept under `extra`, so a card
 * that is imported and exported again loses nothing.
 */
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const str = (v, max = 200_000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const num = (v, d, lo = -Infinity, hi = Infinity) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const list = v => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(',') : []).map(x => str(x, 2000).trim()).filter(Boolean);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

/* ------------------------------------------------------------------------------------------------ lorebooks */

export const ENTRY_POSITIONS = ['before_char', 'after_char', 'an_top', 'an_bottom', 'depth', 'em_top', 'em_bottom'];
export const SELECTIVE_LOGIC = ['and_any', 'not_all', 'not_any', 'and_all'];
export const ROLES = ['system', 'user', 'assistant'];

export function normalizeEntry(e = {}, i = 0) {
  return {
    uid: Number.isInteger(e.uid) ? e.uid : i,
    comment: str(e.comment, 500),
    keys: list(e.keys),
    secondaryKeys: list(e.secondaryKeys),
    selectiveLogic: SELECTIVE_LOGIC.includes(e.selectiveLogic) ? e.selectiveLogic : 'and_any',
    content: str(e.content),
    constant: bool(e.constant, false),
    enabled: bool(e.enabled, true),
    position: ENTRY_POSITIONS.includes(e.position) ? e.position : 'before_char',
    depth: num(e.depth, 4, 0, 1000) | 0,
    role: ROLES.includes(e.role) ? e.role : 'system',
    order: num(e.order, 100, -100000, 100000) | 0,
    probability: num(e.probability, 100, 0, 100),
    caseSensitive: typeof e.caseSensitive === 'boolean' ? e.caseSensitive : null,
    matchWholeWords: typeof e.matchWholeWords === 'boolean' ? e.matchWholeWords : null,
    scanDepth: e.scanDepth == null || e.scanDepth === '' ? null : num(e.scanDepth, null, 0, 1000) | 0,
    excludeRecursion: bool(e.excludeRecursion, false),
    preventRecursion: bool(e.preventRecursion, false),
    group: str(e.group, 200),
    sticky: num(e.sticky, 0, 0, 1000) | 0,
    cooldown: num(e.cooldown, 0, 0, 1000) | 0,
    delay: num(e.delay, 0, 0, 1000) | 0,
    ...(e.extra && typeof e.extra === 'object' ? { extra: e.extra } : {}),
  };
}

export function normalizeBook(b = {}) {
  const entries = (Array.isArray(b.entries) ? b.entries : []).map(normalizeEntry);
  // Every entry has its own uid (two from a merged file would edit each other).
  const seen = new Set();
  let next = entries.reduce((n, e) => Math.max(n, e.uid + 1), 0);
  for (const e of entries) { if (seen.has(e.uid)) e.uid = next++; seen.add(e.uid); }
  return {
    id: typeof b.id === 'string' && /^[\w-]{1,80}$/.test(b.id) ? b.id : randomUUID(),
    name: str(b.name, 200).trim() || 'Untitled lorebook',
    description: str(b.description, 4000),
    scanDepth: b.scanDepth == null || b.scanDepth === '' ? null : num(b.scanDepth, null, 0, 1000) | 0,
    tokenBudget: b.tokenBudget == null || b.tokenBudget === '' ? null : num(b.tokenBudget, null, 0, 1_000_000) | 0,
    recursive: bool(b.recursive, true),
    entries,
    ...(b.extra && typeof b.extra === 'object' ? { extra: b.extra } : {}),
  };
}

const ST_POS = ['before_char', 'after_char', 'an_top', 'an_bottom', 'depth', 'em_top', 'em_bottom'];

/** SillyTavern World Info JSON (or a V2 character_book) into the app's book. */
export function bookFromExternal(data, fallbackName = 'Imported lorebook') {
  if (!data || typeof data !== 'object') throw new Error('This file is not a lorebook.');
  const raw = Array.isArray(data.entries) ? data.entries : data.entries && typeof data.entries === 'object' ? Object.values(data.entries) : null;
  if (!raw) throw new Error('This file has no lorebook entries.');
  const v2 = Array.isArray(data.entries);   // character_book: an array with snake_case fields
  const entries = raw.map((e, i) => {
    const x = e.extensions ?? {};
    const logic = Number.isInteger(e.selectiveLogic) ? e.selectiveLogic : Number.isInteger(x.selectiveLogic) ? x.selectiveLogic : 0;
    const posNum = Number.isInteger(e.position) ? e.position : Number.isInteger(x.position) ? x.position : null;
    const position = posNum != null ? ST_POS[posNum] ?? 'before_char' : e.position === 'after_char' ? 'after_char' : 'before_char';
    const roleNum = Number.isInteger(e.role) ? e.role : Number.isInteger(x.role) ? x.role : 0;
    const useProb = e.useProbability ?? x.useProbability ?? true;
    return normalizeEntry({
      uid: Number.isInteger(e.uid) ? e.uid : Number.isInteger(e.id) ? e.id : i,
      comment: e.comment ?? e.name ?? '',
      keys: e.key ?? e.keys ?? [],
      secondaryKeys: e.keysecondary ?? e.secondary_keys ?? [],
      selectiveLogic: SELECTIVE_LOGIC[logic] ?? 'and_any',
      content: e.content ?? '',
      constant: !!e.constant,
      enabled: v2 ? e.enabled !== false : !e.disable,
      position,
      depth: e.depth ?? x.depth ?? 4,
      role: ROLES[roleNum] ?? 'system',
      order: e.order ?? e.insertion_order ?? 100,
      probability: useProb ? (e.probability ?? x.probability ?? 100) : 100,
      caseSensitive: e.caseSensitive ?? e.case_sensitive ?? x.case_sensitive ?? null,
      matchWholeWords: e.matchWholeWords ?? x.match_whole_words ?? null,
      scanDepth: e.scanDepth ?? x.scan_depth ?? null,
      excludeRecursion: !!(e.excludeRecursion ?? x.exclude_recursion),
      preventRecursion: !!(e.preventRecursion ?? x.prevent_recursion),
      group: e.group ?? x.group ?? '',
      sticky: e.sticky ?? x.sticky ?? 0,
      cooldown: e.cooldown ?? x.cooldown ?? 0,
      delay: e.delay ?? x.delay ?? 0,
    }, i);
  });
  return normalizeBook({ name: data.name || fallbackName, description: data.description ?? '', scanDepth: data.scan_depth ?? null, tokenBudget: data.token_budget ?? null, recursive: data.recursive_scanning ?? true, entries });
}

/** The app's book as SillyTavern World Info JSON. */
export function bookToWorldInfo(book) {
  const entries = {};
  for (const e of book.entries) {
    entries[e.uid] = {
      uid: e.uid, key: e.keys, keysecondary: e.secondaryKeys, comment: e.comment, content: e.content, constant: e.constant,
      selective: e.secondaryKeys.length > 0, selectiveLogic: SELECTIVE_LOGIC.indexOf(e.selectiveLogic), order: e.order,
      position: ST_POS.indexOf(e.position), disable: !e.enabled, depth: e.depth, role: ROLES.indexOf(e.role),
      probability: e.probability, useProbability: e.probability < 100, caseSensitive: e.caseSensitive, matchWholeWords: e.matchWholeWords,
      scanDepth: e.scanDepth, excludeRecursion: e.excludeRecursion, preventRecursion: e.preventRecursion, group: e.group,
      sticky: e.sticky, cooldown: e.cooldown, delay: e.delay,
    };
  }
  return { name: book.name, description: book.description, entries };
}

/** The app's book as a V2 `character_book`. */
export function bookToCharacterBook(book) {
  return {
    name: book.name, description: book.description, scan_depth: book.scanDepth ?? undefined, token_budget: book.tokenBudget ?? undefined,
    recursive_scanning: book.recursive, extensions: {},
    entries: book.entries.map(e => ({
      id: e.uid, keys: e.keys, secondary_keys: e.secondaryKeys, comment: e.comment, content: e.content, constant: e.constant,
      selective: e.secondaryKeys.length > 0, insertion_order: e.order, enabled: e.enabled,
      position: e.position === 'after_char' ? 'after_char' : 'before_char', use_regex: true,
      extensions: { position: ST_POS.indexOf(e.position), depth: e.depth, role: ROLES.indexOf(e.role), probability: e.probability, useProbability: e.probability < 100,
        selectiveLogic: SELECTIVE_LOGIC.indexOf(e.selectiveLogic), case_sensitive: e.caseSensitive, match_whole_words: e.matchWholeWords, scan_depth: e.scanDepth,
        exclude_recursion: e.excludeRecursion, prevent_recursion: e.preventRecursion, group: e.group, sticky: e.sticky, cooldown: e.cooldown, delay: e.delay },
    })),
  };
}

/* ----------------------------------------------------------------------------------------------- characters */

export function normalizeCharacter(c = {}) {
  const depth = c.depthPrompt && typeof c.depthPrompt === 'object' ? c.depthPrompt : {};
  return {
    id: typeof c.id === 'string' && /^[\w-]{1,80}$/.test(c.id) ? c.id : randomUUID(),
    name: str(c.name, 200).trim() || 'Unnamed',
    avatar: c.avatar === true,
    description: str(c.description),
    personality: str(c.personality),
    scenario: str(c.scenario),
    firstMessage: str(c.firstMessage),
    alternateGreetings: (Array.isArray(c.alternateGreetings) ? c.alternateGreetings : []).map(g => str(g)).filter(g => g.trim()),
    exampleDialogues: str(c.exampleDialogues),
    systemPrompt: str(c.systemPrompt),
    postHistoryInstructions: str(c.postHistoryInstructions),
    creatorNotes: str(c.creatorNotes),
    creator: str(c.creator, 200),
    characterVersion: str(c.characterVersion, 100),
    tags: list(c.tags).slice(0, 100),
    talkativeness: num(c.talkativeness, 0.5, 0, 1),
    favorite: bool(c.favorite, false),
    depthPrompt: { text: str(depth.text), depth: num(depth.depth, 4, 0, 1000) | 0, role: ROLES.includes(depth.role) ? depth.role : 'system' },
    book: c.book ? normalizeBook(c.book) : null,
    lorebookIds: (Array.isArray(c.lorebookIds) ? c.lorebookIds : []).filter(x => typeof x === 'string').slice(0, 50),
    createdAt: typeof c.createdAt === 'string' ? c.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(c.extra && typeof c.extra === 'object' ? { extra: c.extra } : {}),
  };
}

/** Any Tavern card JSON (V1, V2, V3) into the app's character. */
export function characterFromCard(card) {
  if (!card || typeof card !== 'object') throw new Error('This file is not a character card.');
  const d = card.spec === 'chara_card_v2' || card.spec === 'chara_card_v3' ? card.data ?? {} : card.data && typeof card.data === 'object' && card.data.name ? card.data : card;
  if (typeof d.name !== 'string' && typeof d.char_name !== 'string') throw new Error('This card has no character name.');
  const x = d.extensions ?? {};
  const known = new Set(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings', 'character_book', 'tags', 'creator', 'character_version', 'extensions', 'char_name', 'char_persona', 'world_scenario', 'char_greeting', 'example_dialogue']);
  const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !known.has(k)));
  return normalizeCharacter({
    name: d.name ?? d.char_name,
    description: d.description ?? d.char_persona ?? '',
    personality: d.personality ?? '',
    scenario: d.scenario ?? d.world_scenario ?? '',
    firstMessage: d.first_mes ?? d.char_greeting ?? '',
    alternateGreetings: d.alternate_greetings ?? [],
    exampleDialogues: d.mes_example ?? d.example_dialogue ?? '',
    systemPrompt: d.system_prompt ?? '',
    postHistoryInstructions: d.post_history_instructions ?? '',
    creatorNotes: d.creator_notes ?? x.creator_notes ?? '',
    creator: d.creator ?? '',
    characterVersion: d.character_version ?? '',
    tags: d.tags ?? [],
    talkativeness: x.talkativeness ?? 0.5,
    favorite: !!x.fav,
    depthPrompt: x.depth_prompt ? { text: x.depth_prompt.prompt ?? '', depth: x.depth_prompt.depth ?? 4, role: x.depth_prompt.role ?? 'system' } : undefined,
    book: d.character_book ? bookFromExternal(d.character_book, `${d.name ?? 'Character'}'s lorebook`) : null,
    extra: { card: { extensions: Object.fromEntries(Object.entries(x).filter(([k]) => !['talkativeness', 'fav', 'depth_prompt'].includes(k))), fields: rest, spec: card.spec ?? 'v1' } },
  });
}

/** The app's character as a V2 card (the shape every app reads); `v3` gives the V3 spelling of the same data. */
export function characterToCard(c, { v3 = false } = {}) {
  const keep = c.extra?.card ?? {};
  const data = {
    ...(keep.fields ?? {}),
    name: c.name, description: c.description, personality: c.personality, scenario: c.scenario, first_mes: c.firstMessage,
    mes_example: c.exampleDialogues, creator_notes: c.creatorNotes, system_prompt: c.systemPrompt, post_history_instructions: c.postHistoryInstructions,
    alternate_greetings: c.alternateGreetings, tags: c.tags, creator: c.creator, character_version: c.characterVersion,
    extensions: { ...(keep.extensions ?? {}), talkativeness: String(c.talkativeness), fav: c.favorite,
      ...(c.depthPrompt?.text ? { depth_prompt: { prompt: c.depthPrompt.text, depth: c.depthPrompt.depth, role: c.depthPrompt.role } } : {}) },
    ...(c.book ? { character_book: bookToCharacterBook(c.book) } : {}),
  };
  if (v3) return { spec: 'chara_card_v3', spec_version: '3.0', data: { ...data, group_only_greetings: data.group_only_greetings ?? [] } };
  return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

/* ------------------------------------------------------------------------------------------------------ PNG */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export const isPng = buf => Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIG);

function chunks(buf) {
  if (!isPng(buf)) throw new Error('This file is not a PNG picture.');
  const out = [];
  for (let at = 8; at + 12 <= buf.length;) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
    if (at + 12 + len > buf.length) break;
    out.push({ type, data: buf.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/** The text chunks of a PNG (`tEXt`, and `zTXt` / `iTXt` for writers that compress), keyword -> text. */
export function pngText(buf) {
  const out = {};
  for (const { type, data } of chunks(buf)) {
    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') continue;
    const z = data.indexOf(0);
    if (z < 0) continue;
    const key = data.toString('latin1', 0, z);
    try {
      if (type === 'tEXt') out[key] = data.toString('latin1', z + 1);
      else if (type === 'zTXt') out[key] = inflateSync(data.subarray(z + 2)).toString('latin1');
      else {
        const compressed = data[z + 1] === 1;
        let p = z + 3; p = data.indexOf(0, p) + 1; p = data.indexOf(0, p) + 1;   // language tag, translated keyword
        const body = data.subarray(p);
        out[key] = (compressed ? inflateSync(body) : body).toString('utf8');
      }
    } catch { /* a damaged chunk is skipped */ }
  }
  return out;
}

const decode64 = s => JSON.parse(Buffer.from(String(s).trim(), 'base64').toString('utf8'));

/** The card inside a PNG: V3 (`ccv3`) when present, else V2/V1 (`chara`). */
export function cardFromPng(buf) {
  const t = pngText(buf);
  const key = Object.keys(t).find(k => k.toLowerCase() === 'ccv3') ?? Object.keys(t).find(k => k.toLowerCase() === 'chara');
  if (!key) throw new Error('This picture has no character card in it.');
  try { return decode64(t[key]); } catch { throw new Error('The character card in this picture is damaged.'); }
}

function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG with the card written into it (old card chunks removed, the picture untouched). */
export function pngWithCard(buf, character) {
  const kept = chunks(buf).filter(c => !((c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') && /^(chara|ccv3)\0/i.test(c.data.toString('latin1', 0, 6))));
  const text = (key, obj) => chunk('tEXt', Buffer.concat([Buffer.from(`${key}\0`, 'latin1'), Buffer.from(Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'), 'latin1')]));
  const out = [PNG_SIG];
  for (const c of kept) {
    if (c.type === 'IEND') out.push(text('chara', characterToCard(character)), text('ccv3', characterToCard(character, { v3: true })));
    out.push(chunk(c.type, c.data));
  }
  return Buffer.concat(out);
}

/** A 1x1 grey PNG, for exporting a card that has no picture. */
export const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+P9/PQAI2gOSmm0fYQAAAABJRU5ErkJggg==', 'base64');

/** Any imported file: a card PNG, a card JSON, or a lorebook JSON. */
export function readImport(buf, filename = '') {
  if (isPng(buf)) return { kind: 'character', character: characterFromCard(cardFromPng(buf)), avatar: buf };
  let data;
  try { data = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw new Error('This file is neither a PNG card nor JSON.'); }
  const card = data && typeof data === 'object' && (data.spec || data.data || 'first_mes' in data || 'char_name' in data);
  if (!card && data?.entries && typeof data.entries === 'object') {
    return { kind: 'lorebook', book: bookFromExternal(data, String(filename).replace(/\.[^.]+$/, '') || 'Imported lorebook') };
  }
  return { kind: 'character', character: characterFromCard(data), avatar: null };
}
