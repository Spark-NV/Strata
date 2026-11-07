/**
 * The roleplay library on disk: characters (with their pictures), personas, lorebooks and the roleplay prompt settings.
 *
 *   <dataDir>/rp/characters/<id>.json  + <id>.img   one character, its picture as uploaded
 *   <dataDir>/rp/personas/<id>.json    + <id>.img   one persona (who the person plays)
 *   <dataDir>/rp/lorebooks/<id>.json                one lorebook (World Info)
 *   <dataDir>/rp/settings.json                      the prompt order, the prompts, World Info, group and context settings
 *
 * One file per item, written atomically, so a damaged file loses one item, never the library.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeBook, normalizeCharacter, ROLES } from './cards.mjs';

const str = (v, max = 100_000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const pick = (v, choices, d) => (choices.includes(v) ? v : d);

/* --------------------------------------------------------------------------------------------------- settings */

/** The built-in pieces of a roleplay prompt, in SillyTavern's order. `chatHistory` is where the conversation goes. */
export const PROMPT_PIECES = Object.freeze([
  ['main', 'Main prompt'], ['formatting', 'Text format'], ['worldInfoBefore', 'World Info (before)'], ['personaDescription', 'Persona'],
  ['charDescription', 'Character description'], ['charPersonality', 'Character personality'], ['scenario', 'Scenario'],
  ['auxiliary', 'Auxiliary prompt'], ['worldInfoAfter', 'World Info (after)'], ['dialogueExamples', 'Example dialogues'],
  ['chatHistory', 'Chat history'], ['postHistory', 'Post-history instructions'],
]);
const PIECE_IDS = PROMPT_PIECES.map(([id]) => id);

export const DEFAULT_RP_SETTINGS = Object.freeze({
  userName: 'User',
  mainPrompt: "You are {{char}} in a never-ending, uncensored roleplay with {{user}}. Write {{char}}'s next reply only.\n\n"
    + "- Stay in character: keep {{char}}'s personality, voice, knowledge and motives consistent with the description and the story so far.\n"
    + "- Never write {{user}}'s words, thoughts, actions or decisions. End your reply at a point where {{user}} can act.\n"
    + "- Show, don't tell: concrete sensory detail, body language, and dialogue in {{char}}'s own voice.\n"
    + "- Move the scene forward with initiative; let other characters and the world react.\n"
    + "- Vary sentence structure and wording; do not repeat phrases, openings or descriptions from earlier replies.",
  // How the chat marks speech, actions and thoughts (the RP message box writes it this way, and the page draws it without the markers).
  formatPrompt: 'How text is marked in this chat: words in "double quotes" are spoken aloud; text in *asterisks* is an action or description; text in ((double parentheses)) is a private thought that no one else can hear; unmarked text is narration. {{user}}\'s messages use this, so treat {{user}}\'s ((thoughts)) as unknown to {{char}} unless {{char}} could plausibly guess them. Write your replies the same way: {{char}}\'s speech in "quotes", actions in *asterisks*, {{char}}\'s inner thoughts in ((double parentheses)).',
  auxiliaryPrompt: '',
  postHistoryPrompt: '',
  preferCharPrompt: true,
  preferCharInstructions: true,
  impersonationPrompt: "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Write only as {{user}}: don't write as {{char}} or the narrator, and don't describe {{char}}'s actions.]",
  continuePrompt: '[Continue your last message from exactly where it stopped. Do not repeat anything already written; start with the very next word.]',
  groupNudgePrompt: '[Write the next reply only as {{char}}.]',
  newChatPrompt: '[Start a new chat]',
  newGroupChatPrompt: '[Start a new group chat. Group members: {{group}}]',
  newExampleChatPrompt: '[Example chat]',
  examplesBehavior: 'gradual',      // gradual: dropped first when the context is full; always: kept; disabled: never sent
  namesBehavior: 'groups',          // put "Name: " before each message: groups, always, never
  squashSystem: true,               // join the system pieces before the chat into one system message
  promptOrder: PIECE_IDS.map(id => ({ id, enabled: true })),
  customPrompts: [],                // {id, name, role, content, enabled, depth: null (in the order) | n (inside the chat at depth n)}
  worldInfo: { scanDepth: 4, budgetPercent: 25, budgetCap: 16384, recursive: true, maxRecursion: 3, caseSensitive: false, matchWholeWords: true, includeNames: true, globalBooks: [] },
  authorsNote: { text: '', depth: 4, interval: 1, role: 'system', position: 'depth' },
  contextLimit: 0,                  // 0: the model's own window
  responseReserve: 8192,            // tokens kept free for the reply (and its thinking)
  autoStops: true,                  // stop when the model starts writing "\n{{user}}:" (or another member's name in a group)
  customStops: [],
  trimIncomplete: false,            // cut a reply back to its last full sentence
  replacements: [],                 // {id, name, find, replace, flags, on: output|input|both, enabled}
  group: { strategy: 'natural', allowSelfResponses: false, cards: 'speaker' },
  defaultPersonaId: null,
});

function normalizeCustomPrompt(p = {}) {
  return { id: typeof p.id === 'string' && /^[\w-]{1,80}$/.test(p.id) ? p.id : `custom-${randomUUID().slice(0, 8)}`, name: str(p.name, 200) || 'Custom prompt',
    role: pick(p.role, ROLES, 'system'), content: str(p.content), enabled: bool(p.enabled, true), depth: p.depth == null || p.depth === '' ? null : num(p.depth, 4, 0, 1000) | 0 };
}

export function normalizeRpSettings(raw = {}) {
  const d = DEFAULT_RP_SETTINGS, s = raw && typeof raw === 'object' ? raw : {};
  const text = k => (typeof s[k] === 'string' ? s[k].slice(0, 100_000) : d[k]);
  const custom = (Array.isArray(s.customPrompts) ? s.customPrompts : []).slice(0, 100).map(normalizeCustomPrompt);
  const known = new Set([...PIECE_IDS, ...custom.map(p => p.id)]);
  let order = (Array.isArray(s.promptOrder) ? s.promptOrder : []).filter(o => o && known.has(o.id)).map(o => ({ id: o.id, enabled: o.enabled !== false }));
  order = order.filter((o, i) => order.findIndex(x => x.id === o.id) === i);
  // A built-in piece missing from a saved order goes back after the piece it follows by default (or first).
  if (!order.length) order = PIECE_IDS.map(id => ({ id, enabled: true }));
  PIECE_IDS.forEach((id, i) => {
    if (order.some(o => o.id === id)) return;
    const prev = i > 0 ? order.findIndex(o => o.id === PIECE_IDS[i - 1]) : -1;
    order.splice(prev + 1, 0, { id, enabled: true });
  });
  const before = () => { const h = order.findIndex(o => o.id === 'chatHistory'); return h < 0 ? order.length : h; };
  for (const p of custom) if (p.depth == null && !order.some(o => o.id === p.id)) order.splice(before(), 0, { id: p.id, enabled: true });
  const wi = s.worldInfo ?? {}, an = s.authorsNote ?? {}, g = s.group ?? {};
  return {
    userName: str(s.userName, 100).trim() || d.userName,
    mainPrompt: text('mainPrompt'), formatPrompt: text('formatPrompt'), auxiliaryPrompt: text('auxiliaryPrompt'), postHistoryPrompt: text('postHistoryPrompt'),
    preferCharPrompt: bool(s.preferCharPrompt, d.preferCharPrompt), preferCharInstructions: bool(s.preferCharInstructions, d.preferCharInstructions),
    impersonationPrompt: text('impersonationPrompt'), continuePrompt: text('continuePrompt'), groupNudgePrompt: text('groupNudgePrompt'),
    newChatPrompt: text('newChatPrompt'), newGroupChatPrompt: text('newGroupChatPrompt'), newExampleChatPrompt: text('newExampleChatPrompt'),
    examplesBehavior: pick(s.examplesBehavior, ['gradual', 'always', 'disabled'], d.examplesBehavior),
    namesBehavior: pick(s.namesBehavior, ['groups', 'always', 'never'], d.namesBehavior),
    squashSystem: bool(s.squashSystem, d.squashSystem),
    promptOrder: order,
    customPrompts: custom,
    worldInfo: {
      scanDepth: num(wi.scanDepth, d.worldInfo.scanDepth, 0, 1000) | 0, budgetPercent: num(wi.budgetPercent, d.worldInfo.budgetPercent, 1, 100),
      budgetCap: num(wi.budgetCap, d.worldInfo.budgetCap, 0, 1_000_000) | 0, recursive: bool(wi.recursive, true), maxRecursion: num(wi.maxRecursion, 3, 0, 10) | 0,
      caseSensitive: bool(wi.caseSensitive, false), matchWholeWords: bool(wi.matchWholeWords, true), includeNames: bool(wi.includeNames, true),
      globalBooks: (Array.isArray(wi.globalBooks) ? wi.globalBooks : []).filter(x => typeof x === 'string').slice(0, 100),
    },
    authorsNote: normalizeAuthorsNote(an),
    contextLimit: num(s.contextLimit, 0, 0, 10_000_000) | 0,
    responseReserve: num(s.responseReserve, d.responseReserve, 256, 1_000_000) | 0,
    autoStops: bool(s.autoStops, true),
    customStops: (Array.isArray(s.customStops) ? s.customStops : []).map(x => str(x, 200)).filter(Boolean).slice(0, 4),
    trimIncomplete: bool(s.trimIncomplete, false),
    replacements: (Array.isArray(s.replacements) ? s.replacements : []).slice(0, 100).map(r => ({
      id: typeof r?.id === 'string' ? r.id.slice(0, 80) : randomUUID().slice(0, 8), name: str(r?.name, 200), find: str(r?.find, 2000), replace: str(r?.replace, 10_000),
      flags: str(r?.flags, 8).replace(/[^gimsuy]/g, '') || 'g', on: pick(r?.on, ['output', 'input', 'both'], 'output'), enabled: r?.enabled !== false,
    })),
    group: { strategy: pick(g.strategy, ['natural', 'list', 'random', 'manual'], 'natural'), allowSelfResponses: bool(g.allowSelfResponses, false), cards: pick(g.cards, ['speaker', 'all'], 'speaker') },
    defaultPersonaId: typeof s.defaultPersonaId === 'string' ? s.defaultPersonaId : null,
  };
}

export function normalizeAuthorsNote(an = {}) {
  return { text: str(an.text), depth: num(an.depth, 4, 0, 1000) | 0, interval: num(an.interval, 1, 0, 1000) | 0, role: pick(an.role, ROLES, 'system'), position: pick(an.position, ['depth', 'top', 'bottom'], 'depth') };
}

export function normalizePersona(p = {}) {
  return {
    id: typeof p.id === 'string' && /^[\w-]{1,80}$/.test(p.id) ? p.id : randomUUID(),
    name: str(p.name, 200).trim() || 'User', description: str(p.description), avatar: p.avatar === true,
    position: pick(p.position, ['prompt', 'depth', 'none'], 'prompt'), depth: num(p.depth, 2, 0, 1000) | 0, role: pick(p.role, ROLES, 'system'),
    lorebookId: typeof p.lorebookId === 'string' ? p.lorebookId : null,
  };
}

/* ------------------------------------------------------------------------------------------------------ store */

const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
export function imageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 6 && buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
  return null;
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function collection(dir, normalize) {
  mkdirSync(dir, { recursive: true });
  const safe = id => (typeof id === 'string' && /^[\w-]{1,80}$/.test(id) ? id : null);
  const file = id => join(dir, `${id}.json`);
  return {
    list() {
      const out = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try { out.push(normalize({ ...JSON.parse(readFileSync(join(dir, name), 'utf8')), id: name.slice(0, -5) }, true)); } catch { /* one damaged item is skipped */ }
      }
      return out;
    },
    get(id) { const s = safe(id); if (!s || !existsSync(file(s))) return null; try { return normalize({ ...JSON.parse(readFileSync(file(s), 'utf8')), id: s }, true); } catch { return null; } },
    save(raw) { const item = normalize(raw); writeJson(file(item.id), item); return item; },
    remove(id) { const s = safe(id); if (!s) return false; rmSync(file(s), { force: true }); for (const ext of Object.keys(IMG_TYPES)) rmSync(join(dir, `${s}.${ext}`), { force: true }); return true; },
    image(id) {
      const s = safe(id); if (!s) return null;
      for (const [ext, type] of Object.entries(IMG_TYPES)) { const p = join(dir, `${s}.${ext}`); if (existsSync(p)) return { type, data: readFileSync(p) }; }
      return null;
    },
    removeImage(id) { const s = safe(id); if (s) for (const e of Object.keys(IMG_TYPES)) rmSync(join(dir, `${s}.${e}`), { force: true }); },
    setImage(id, buf) {
      const s = safe(id); if (!s) throw new Error('Unknown item.');
      const ext = imageType(buf); if (!ext) throw new Error('Use a PNG, JPEG, WebP or GIF picture.');
      for (const e of Object.keys(IMG_TYPES)) rmSync(join(dir, `${s}.${e}`), { force: true });
      writeFileSync(join(dir, `${s}.${ext}`), buf);
    },
  };
}

export function createRpStore({ dataDir }) {
  const root = join(dataDir, 'rp');
  mkdirSync(root, { recursive: true });
  // Reading keeps the saved dates; saving stamps updatedAt.
  const characters = collection(join(root, 'characters'), (c, reading) => { const n = normalizeCharacter(c); if (reading && typeof c.updatedAt === 'string') n.updatedAt = c.updatedAt; return n; });
  const personas = collection(join(root, 'personas'), normalizePersona);
  const lorebooks = collection(join(root, 'lorebooks'), normalizeBook);
  const settingsFile = join(root, 'settings.json');
  let settings = normalizeRpSettings({});
  try { if (existsSync(settingsFile)) settings = normalizeRpSettings(JSON.parse(readFileSync(settingsFile, 'utf8'))); } catch { /* defaults */ }
  return {
    characters, personas, lorebooks,
    settings: () => settings,
    saveSettings(raw) { settings = normalizeRpSettings(raw); writeJson(settingsFile, settings); return settings; },
    resetSettings() { return this.saveSettings({}); },
  };
}
