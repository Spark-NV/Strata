/**
 * The roleplay prompt: what SillyTavern's prompt manager builds for a chat-completion model, from the chat's characters, the person's
 * persona, the active lorebooks and the roleplay settings.
 *
 *   macros       {{char}} {{user}} {{persona}} {{description}} {{personality}} {{scenario}} {{group}} {{original}} {{time}} {{date}}
 *                {{weekday}} {{isodate}} {{isotime}} {{idle_duration}} {{lastMessage}} {{lastUserMessage}} {{lastCharMessage}} {{model}}
 *                {{random::a::b}} {{random:a,b}} {{pick::a::b}} (the same choice every time in one chat) {{roll:2d6+1}} {{newline}}
 *                {{trim}} {{noop}} {{// comment}} {{setvar::x::v}} {{getvar::x}} {{addvar::x::n}} {{incvar::x}} {{decvar::x}}, <USER> <BOT>
 *   World Info   keys (plain, whole-word or /regex/flags), secondary keys with AND ANY / AND ALL / NOT ANY / NOT ALL, constant entries,
 *                probability, delay, scan depth per entry/book/global, recursion with exclude/prevent, inclusion groups, a token budget,
 *                positions before/after the character, around the author's note, around the examples, or inside the chat at a depth
 *   injections   the author's note (every N user messages), the character's note, the persona and custom prompts at a depth
 *   context      the newest messages that fit the window after the fixed pieces and the reply reserve; example dialogues give way first
 *
 * Pure: no files, no network. `buildRpPrompt` returns the messages, the stop strings and what went in (for the prompt inspector).
 */

export const estimateTokens = text => Math.ceil(String(text ?? '').length / 3.4);

/* ------------------------------------------------------------------------------------------------------- macros */

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function options(body) { return body.includes('::') ? body.split('::') : body.split(/(?<!\\),/).map(x => x.replace(/\\,/g, ',')); }

function roll(spec, rand) {
  const m = /^\s*(\d*)d?(\d+)\s*([+-]\s*\d+)?\s*$/i.exec(spec);
  if (!m) return spec;
  const count = spec.toLowerCase().includes('d') ? Math.min(100, Number(m[1] || 1)) : 1, sides = Math.max(1, Number(m[2]));
  let total = Number((m[3] ?? '0').replace(/\s/g, ''));
  for (let i = 0; i < count; i++) total += 1 + Math.floor(rand() * sides);
  return String(total);
}

function idle(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} days`;
}

/**
 * Macros in `text`. `ctx.vars` (the chat's variables) is changed in place by setvar/addvar/incvar/decvar.
 * @param {string} text
 * @param {Record<string, any>} ctx
 */
export function substitute(text, ctx) {
  if (!text) return '';
  const rand = ctx.rand ?? Math.random;
  const vars = ctx.vars ?? (ctx.vars = {});
  const now = ctx.now ? new Date(ctx.now) : new Date();
  const simple = {
    char: ctx.char, bot: ctx.char, user: ctx.user, persona: ctx.persona, description: ctx.description, personality: ctx.personality,
    scenario: ctx.scenario, group: ctx.group, charifnotgroup: ctx.isGroup ? ctx.group : ctx.char, original: ctx.original, model: ctx.model,
    mesexamples: ctx.mesExamples, charprompt: ctx.charPrompt, charinstruction: ctx.charInstruction, charjailbreak: ctx.charInstruction,
    lastmessage: ctx.lastMessage, lastusermessage: ctx.lastUserMessage, lastcharmessage: ctx.lastCharMessage,
    time: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), date: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    weekday: now.toLocaleDateString('en-US', { weekday: 'long' }), isotime: now.toTimeString().slice(0, 5), isodate: now.toISOString().slice(0, 10),
    idle_duration: idle(ctx.idleMs), newline: '\n', noop: '',
  };
  let out = String(text).replace(/<USER>/gi, ctx.user ?? '').replace(/<BOT>|<CHAR>/gi, ctx.char ?? '');
  let offset = 0;
  // Innermost first, a few rounds, so {{getvar::{{char}}_mood}} and the like work.
  for (let round = 0; round < 5 && out.includes('{{'); round++) {
    const before = out;
    out = out.replace(/\{\{([^{}]*)\}\}/g, (whole, inner) => {
      const body = inner.trim();
      if (body.startsWith('//')) return '';
      const lower = body.toLowerCase();
      if (lower === 'trim') return '\u0000TRIM\u0000';
      if (Object.prototype.hasOwnProperty.call(simple, lower)) return String(simple[lower] ?? '');
      let m;
      if ((m = /^setvar::([^:]+)::([\s\S]*)$/i.exec(body))) { vars[m[1].trim()] = m[2]; return ''; }
      if ((m = /^getvar::([^:]+)$/i.exec(body))) return String(vars[m[1].trim()] ?? '');
      if ((m = /^addvar::([^:]+)::([\s\S]*)$/i.exec(body))) {
        const k = m[1].trim(), cur = vars[k], add = m[2];
        vars[k] = Number.isFinite(Number(cur ?? 0)) && Number.isFinite(Number(add)) ? String(Number(cur ?? 0) + Number(add)) : `${cur ?? ''}${add}`;
        return '';
      }
      if ((m = /^(inc|dec)var::([^:]+)$/i.exec(body))) { const k = m[2].trim(); vars[k] = String((Number(vars[k]) || 0) + (m[1].toLowerCase() === 'inc' ? 1 : -1)); return vars[k]; }
      if ((m = /^random(?:::|:)([\s\S]*)$/i.exec(body))) { const o = options(m[1]); return o[Math.floor(rand() * o.length)] ?? ''; }
      if ((m = /^pick(?:::|:)([\s\S]*)$/i.exec(body))) { const o = options(m[1]); return o[hash(`${ctx.chatId ?? ''}|${offset++}|${m[1]}`) % o.length] ?? ''; }
      if ((m = /^roll[: ](.+)$/i.exec(body))) return roll(m[1], rand);
      return whole;   // unknown: left as written
    });
    if (out === before) break;
  }
  return out.replace(/\s*\u0000TRIM\u0000\s*/g, '');
}

/* --------------------------------------------------------------------------------------------------- World Info */

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function keyMatcher(key, entry, wi) {
  const rx = /^\/([\s\S]+)\/([gimsuy]*)$/.exec(key);
  if (rx) { try { const re = new RegExp(rx[1], rx[2].replace('g', '')); return t => re.test(t); } catch { return () => false; } }
  const cs = entry.caseSensitive ?? wi.caseSensitive, whole = entry.matchWholeWords ?? wi.matchWholeWords;
  const k = cs ? key : key.toLowerCase();
  if (whole && !/\s/.test(k.trim())) {
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRe(k.trim())}(?:$|[^\\p{L}\\p{N}_])`, cs ? 'u' : 'iu');
    return t => re.test(t);
  }
  return t => (cs ? t : t.toLowerCase()).includes(k);
}

function entryMatches(entry, text, wi) {
  if (!entry.keys.length) return false;
  if (!entry.keys.some(k => keyMatcher(k, entry, wi)(text))) return false;
  if (!entry.secondaryKeys.length) return true;
  const hits = entry.secondaryKeys.map(k => keyMatcher(k, entry, wi)(text));
  switch (entry.selectiveLogic) {
    case 'and_all': return hits.every(Boolean);
    case 'not_any': return !hits.some(Boolean);
    case 'not_all': return !hits.every(Boolean);
    default: return hits.some(Boolean);
  }
}

/**
 * Which lorebook entries are active for this generation, grouped by where they go.
 * @param {{books: any[], wi: any, history: {text: string}[], budget: number, rand?: () => number, messageCount: number}} a
 */
export function activateWorldInfo({ books, wi, history, budget, rand = Math.random, messageCount = history.length }) {
  const all = [];
  for (const book of books) for (const entry of book.entries) if (entry.enabled && entry.content.trim()) all.push({ entry, book });
  const chatText = depth => history.slice(Math.max(0, history.length - depth)).map(m => m.text).join('\n');
  const active = new Map();
  const tryEntry = (item, extra) => {
    const { entry, book } = item;
    if (entry.delay > 0 && messageCount < entry.delay) return false;
    let hit = entry.constant;
    if (!hit) {
      const depth = entry.scanDepth ?? book.scanDepth ?? wi.scanDepth;
      const text = chatText(depth) + (extra && !entry.excludeRecursion ? `\n${extra}` : '');
      hit = !!text.trim() && entryMatches(entry, text, wi);
    }
    if (hit && entry.probability < 100 && rand() * 100 >= entry.probability) hit = false;
    return hit;
  };
  let recursionText = '';
  for (let round = 0; round <= (wi.recursive ? wi.maxRecursion : 0); round++) {
    const fresh = [];
    for (const item of all) {
      const key = `${item.book.id}:${item.entry.uid}`;
      if (active.has(key)) continue;
      if (round > 0 && !item.book.recursive) continue;
      if (tryEntry(item, round > 0 ? recursionText : '')) { active.set(key, item); fresh.push(item); }
    }
    if (!fresh.length) break;
    const more = fresh.filter(i => !i.entry.preventRecursion).map(i => i.entry.content).join('\n');
    if (!more) break;
    recursionText += `\n${more}`;
    if (round === 0 && !wi.recursive) break;
  }
  // An inclusion group keeps one entry: the one with the highest order.
  let picked = [...active.values()];
  const groups = new Map();
  for (const item of picked) {
    const g = item.entry.group.trim();
    if (!g) continue;
    const best = groups.get(g);
    if (!best || item.entry.order > best.entry.order) groups.set(g, item);
  }
  picked = picked.filter(i => !i.entry.group.trim() || groups.get(i.entry.group.trim()) === i);
  // The budget: constant entries and higher orders first.
  picked.sort((a, b) => Number(b.entry.constant) - Number(a.entry.constant) || b.entry.order - a.entry.order);
  let used = 0;
  const kept = [], dropped = [];
  for (const item of picked) {
    const t = estimateTokens(item.entry.content);
    const limit = item.book.tokenBudget ?? budget;
    if (limit > 0 && used + t > limit) { dropped.push(item); continue; }
    used += t; kept.push(item);
  }
  kept.sort((a, b) => a.entry.order - b.entry.order);
  const at = pos => kept.filter(i => i.entry.position === pos).map(i => i.entry.content);
  return {
    before: at('before_char'), after: at('after_char'), anTop: at('an_top'), anBottom: at('an_bottom'), emTop: at('em_top'), emBottom: at('em_bottom'),
    depth: kept.filter(i => i.entry.position === 'depth').map(i => ({ depth: i.entry.depth, role: i.entry.role, content: i.entry.content })),
    activated: kept.map(i => ({ book: i.book.name, uid: i.entry.uid, comment: i.entry.comment || i.entry.keys.slice(0, 3).join(', '), position: i.entry.position, tokens: estimateTokens(i.entry.content) })),
    dropped: dropped.map(i => ({ book: i.book.name, uid: i.entry.uid, comment: i.entry.comment || i.entry.keys.slice(0, 3).join(', ') })),
    tokens: used,
  };
}

/* ------------------------------------------------------------------------------------------------- group chats */

/** Who speaks next in a group. */
export function selectSpeaker({ characters, messages, strategy = 'natural', allowSelfResponses = false, muted = [], rand = Math.random }) {
  const members = characters.filter(c => !muted.includes(c.id));
  if (!members.length) return characters[0]?.id ?? null;
  const lastChar = [...messages].reverse().find(m => m.role === 'assistant' && m.characterId);
  const lastId = lastChar?.characterId ?? null;
  const others = members.filter(c => allowSelfResponses || c.id !== lastId);
  const pool = others.length ? others : members;
  if (strategy === 'list' || strategy === 'manual') {
    if (!lastId) return members[0].id;
    const at = members.findIndex(c => c.id === lastId);
    return members[(at + 1) % members.length].id;
  }
  if (strategy === 'random') return pool[Math.floor(rand() * pool.length)].id;
  // natural: a name in the last message speaks first; then each member's talkativeness; then anyone.
  const last = messages[messages.length - 1];
  if (last?.content) {
    const text = last.content.toLowerCase();
    const named = pool.map(c => ({ c, at: [c.name, c.name.split(/\s+/)[0]].map(n => text.indexOf(n.toLowerCase())).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? -1 }))
      .filter(x => x.at >= 0).sort((a, b) => a.at - b.at);
    if (named.length) return named[0].c.id;
  }
  const shuffled = [...pool].sort(() => rand() - 0.5);
  const talker = shuffled.find(c => rand() < c.talkativeness);
  return (talker ?? shuffled[0]).id;
}

/* ------------------------------------------------------------------------------------------------- the prompt */

function exampleBlocks(text) {
  return String(text ?? '').split(/<START>/i).map(b => b.trim()).filter(Boolean);
}

/** A reply as the person wants it: replacements applied, and cut back to its last full sentence when asked. */
export function finishReply(text, settings, on = 'output') {
  let out = String(text ?? '');
  for (const r of settings.replacements ?? []) {
    if (!r.enabled || !r.find || (r.on !== on && r.on !== 'both')) continue;
    try { out = out.replace(new RegExp(r.find, r.flags || 'g'), r.replace); } catch { /* a bad pattern is skipped */ }
  }
  if (on === 'output' && settings.trimIncomplete) {
    const m = /^[\s\S]*[.!?…"”*)\]~](?=\s|$)/.exec(out.trimEnd());
    if (m) out = m[0];
  }
  return out;
}

/**
 * The whole request for one roleplay generation.
 * @param {object} a
 * @param {any} a.settings   normalized roleplay settings
 * @param {any[]} a.characters  the chat's characters (one, or a group)
 * @param {string|null} a.speakerId  who writes this reply
 * @param {any|null} a.persona
 * @param {any[]} a.books    every lorebook in play (global, the chat's, the characters', the persona's)
 * @param {{role: string, content: string, characterId?: string, name?: string, hidden?: boolean, at?: string}[]} a.history  the chat so far
 * @param {any} a.authorsNote  this chat's author's note
 * @param {'normal'|'continue'|'impersonate'} a.mode
 * @param {number} a.contextMax   the model's window in tokens
 * @param {Record<string,string>} [a.vars]
 */
export function buildRpPrompt({ settings, characters, speakerId, persona, books, history, authorsNote, mode = 'normal', contextMax = 32768, vars = {}, chatId = '', model = '', now = Date.now(), rand = Math.random }) {
  const s = settings;
  const isGroup = characters.length > 1;
  const speaker = characters.find(c => c.id === speakerId) ?? characters[0] ?? { id: null, name: 'Assistant', description: '', personality: '', scenario: '', exampleDialogues: '', systemPrompt: '', postHistoryInstructions: '', depthPrompt: { text: '' } };
  const userName = persona?.name || s.userName;
  const visible = history.filter(m => !m.hidden && (m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim());
  const nameOf = m => (m.role === 'user' ? m.name || userName : m.name || characters.find(c => c.id === m.characterId)?.name || speaker.name);
  const lastOf = role => [...visible].reverse().find(m => m.role === role)?.content ?? '';
  const lastAt = visible.length ? Date.parse(visible[visible.length - 1].at ?? '') : NaN;
  const ctx = {
    char: speaker.name, user: userName, persona: persona?.description ?? '', description: speaker.description, personality: speaker.personality,
    scenario: speaker.scenario, group: characters.map(c => c.name).join(', '), isGroup, model, chatId, vars, now, rand,
    mesExamples: speaker.exampleDialogues, charPrompt: speaker.systemPrompt, charInstruction: speaker.postHistoryInstructions,
    lastMessage: visible[visible.length - 1]?.content ?? '', lastUserMessage: lastOf('user'), lastCharMessage: lastOf('assistant'),
    idleMs: Number.isFinite(lastAt) ? now - lastAt : NaN,
  };
  const sub = (text, extra = {}) => substitute(text, { ...ctx, ...extra });
  const withNames = s.namesBehavior === 'always' || (s.namesBehavior === 'groups' && isGroup);

  // World Info first: it reads the chat (with names, when asked) and fills several pieces.
  const window = (s.contextLimit > 0 ? Math.min(s.contextLimit, contextMax) : contextMax);
  const wiBudget = Math.floor(window * s.worldInfo.budgetPercent / 100);
  const wi = activateWorldInfo({
    books, wi: s.worldInfo, rand, messageCount: visible.length,
    history: visible.map(m => ({ text: s.worldInfo.includeNames ? `${nameOf(m)}: ${m.content}` : m.content })),
    budget: s.worldInfo.budgetCap > 0 ? Math.min(s.worldInfo.budgetCap, wiBudget) : wiBudget,
  });
  const join = parts => parts.map(p => String(p ?? '').trim()).filter(Boolean).join('\n');
  const describe = c => join([c.description && sub(c.description, { char: c.name, description: c.description })]);

  const mainText = s.preferCharPrompt && speaker.systemPrompt?.trim() ? sub(speaker.systemPrompt, { original: sub(s.mainPrompt) }) : sub(s.mainPrompt);
  const postText = s.preferCharInstructions && speaker.postHistoryInstructions?.trim() ? sub(speaker.postHistoryInstructions, { original: sub(s.postHistoryPrompt) }) : sub(s.postHistoryPrompt);
  const cards = isGroup && s.group.cards === 'all' ? characters : [speaker];
  const anText = join([...wi.anTop.map(t => sub(t)), authorsNote?.text ? sub(authorsNote.text) : '', ...wi.anBottom.map(t => sub(t))]);
  const userTurns = visible.filter(m => m.role === 'user').length;
  const anDue = !!anText && (authorsNote?.interval === 1 || (authorsNote?.interval > 0 && userTurns % authorsNote.interval === 0));
  const an = { text: anText, due: anDue, position: authorsNote?.position ?? 'depth', depth: authorsNote?.depth ?? 4, role: authorsNote?.role ?? 'system' };

  const piece = {
    main: mainText,
    worldInfoBefore: join(wi.before.map(t => sub(t))),
    personaDescription: persona && persona.position === 'prompt' && persona.description.trim() ? sub(persona.description) : '',
    charDescription: cards.length > 1 ? cards.map(c => (c.description.trim() ? `${c.name}: ${describe(c)}` : '')).filter(Boolean).join('\n\n') : describe(speaker),
    charPersonality: join(cards.map(c => (c.personality.trim() ? `${c.name}'s personality: ${sub(c.personality, { char: c.name })}` : ''))),
    scenario: join(cards.slice(0, 1).map(c => (c.scenario.trim() ? `Scenario: ${sub(c.scenario, { char: c.name })}` : ''))),
    auxiliary: sub(s.auxiliaryPrompt),
    worldInfoAfter: join(wi.after.map(t => sub(t))),
    postHistory: postText,
  };
  const customById = new Map(s.customPrompts.map(p => [p.id, p]));

  // The fixed pieces, in the person's order; where the chat goes is marked.
  const head = [], tail = [];
  let seenHistory = false, examplesAt = -1;
  for (const { id, enabled } of s.promptOrder) {
    if (!enabled) continue;
    if (id === 'chatHistory') { seenHistory = true; continue; }
    const into = seenHistory ? tail : head;
    if (id === 'dialogueExamples') { if (s.examplesBehavior !== 'disabled' && !seenHistory) examplesAt = head.length; continue; }
    const custom = customById.get(id);
    if (custom) { if (custom.enabled && custom.depth == null && custom.content.trim()) into.push({ role: custom.role, content: sub(custom.content), piece: custom.name }); continue; }
    const text = piece[id];
    if (text?.trim()) into.push({ role: 'system', content: text, piece: id });
    if (id === 'scenario' && an.due && an.position === 'top') into.push({ role: an.role, content: an.text, piece: "Author's note" });
  }
  if (an.due && an.position === 'bottom') head.push({ role: an.role, content: an.text, piece: "Author's note" });

  // Example dialogues, one block per <START>, with the World Info that goes around them.
  const blocks = exampleBlocks(speaker.exampleDialogues).map(b => `${sub(s.newExampleChatPrompt)}\n${sub(b)}`);
  const emTop = join(wi.emTop.map(t => sub(t))), emBottom = join(wi.emBottom.map(t => sub(t)));

  // Mode instructions at the very end.
  const ending = [];
  if (mode === 'continue' && s.continuePrompt.trim()) ending.push({ role: 'system', content: sub(s.continuePrompt), piece: 'Continue' });
  else if (mode === 'impersonate' && s.impersonationPrompt.trim()) ending.push({ role: 'system', content: sub(s.impersonationPrompt), piece: 'Impersonate' });
  else if (isGroup && s.groupNudgePrompt.trim()) ending.push({ role: 'system', content: sub(s.groupNudgePrompt), piece: 'Group nudge' });

  // In-chat injections at a depth.
  const injections = [];
  if (an.due && an.position === 'depth') injections.push({ depth: an.depth, role: an.role, content: an.text, piece: "Author's note" });
  if (speaker.depthPrompt?.text?.trim()) injections.push({ depth: speaker.depthPrompt.depth, role: speaker.depthPrompt.role, content: sub(speaker.depthPrompt.text), piece: "Character's note" });
  if (persona && persona.position === 'depth' && persona.description.trim()) injections.push({ depth: persona.depth, role: persona.role, content: sub(persona.description), piece: 'Persona' });
  for (const e of wi.depth) injections.push({ depth: e.depth, role: e.role, content: sub(e.content), piece: 'World Info' });
  for (const p of s.customPrompts) if (p.enabled && p.depth != null && p.content.trim()) injections.push({ depth: p.depth, role: p.role, content: sub(p.content), piece: p.name });

  // Budget: the window minus the reply reserve, the fixed pieces and the injections; then the newest messages; then examples.
  const cost = list => list.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
  let room = window - s.responseReserve - cost(head) - cost(tail) - cost(ending) - cost(injections) - estimateTokens(sub(isGroup ? s.newGroupChatPrompt : s.newChatPrompt));
  const always = s.examplesBehavior === 'always';
  const examples = [];
  if (examplesAt >= 0 && always) { for (const b of blocks) examples.push(b); room -= estimateTokens([emTop, ...examples, emBottom].join('\n')); }
  const chat = [];
  for (let i = visible.length - 1; i >= 0; i--) {
    const m = visible[i];
    const text = m.role === 'user' ? finishReply(m.content, s, 'input') : m.content;
    const content = withNames ? `${nameOf(m)}: ${text}` : text;
    const t = estimateTokens(content) + 4;
    // The newest message always goes, whatever its size.
    if (t > room && chat.length) break;
    room -= t;
    chat.unshift({ role: m.role, content });
  }
  const droppedMessages = visible.length - chat.length;
  if (examplesAt >= 0 && !always && droppedMessages === 0) for (const b of blocks) { const t = estimateTokens(b) + 4; if (t > room) break; room -= t; examples.push(b); }
  if (examplesAt >= 0 && examples.length) head.splice(examplesAt, 0, { role: 'system', content: join([emTop, ...examples, emBottom]), piece: 'dialogueExamples' });
  else if (examplesAt >= 0 && (emTop || emBottom)) head.splice(examplesAt, 0, { role: 'system', content: join([emTop, emBottom]), piece: 'World Info (examples)' });

  // Injections go between the messages: depth 0 after the last one, depth n before the n-th from the end. Same depth and role: one message.
  const byDepth = new Map();
  for (const inj of injections) {
    const d = Math.min(inj.depth, chat.length), key = `${d}|${inj.role}`;
    const cur = byDepth.get(key);
    byDepth.set(key, cur ? { ...cur, content: `${cur.content}\n${inj.content}`, piece: `${cur.piece}, ${inj.piece}` } : { ...inj, depth: d });
  }
  const withInjections = [];
  const depths = [...byDepth.values()];
  for (let i = 0; i <= chat.length; i++) {
    const depth = chat.length - i;
    for (const inj of depths.filter(x => x.depth === depth)) withInjections.push({ role: inj.role, content: inj.content, piece: inj.piece });
    if (i < chat.length) withInjections.push({ ...chat[i], piece: 'chatHistory' });
  }
  const startLine = sub(isGroup ? s.newGroupChatPrompt : s.newChatPrompt);
  const opener = startLine.trim() ? [{ role: 'system', content: startLine, piece: 'Chat start' }] : [];

  let messages = [...head, ...opener, ...withInjections, ...tail, ...ending];
  if (s.squashSystem) {
    // The system pieces before the first chat message become one system message.
    const firstChat = messages.findIndex(m => m.role !== 'system');
    const cut = firstChat < 0 ? messages.length : firstChat;
    const top = messages.slice(0, cut);
    if (top.length > 1) messages = [{ role: 'system', content: top.map(m => m.content).join('\n\n'), piece: top.map(m => m.piece).join(' + ') }, ...messages.slice(cut)];
  }
  if (!messages.some(m => m.role === 'user')) messages.push({ role: 'user', content: mode === 'impersonate' ? '[Begin.]' : `[${userName} waits for ${speaker.name} to begin.]`, piece: 'Opening' });

  // Stops: the model starting the person's line (or another member's) ends the reply.
  const stop = [];
  if (s.autoStops) {
    if (mode === 'impersonate') stop.push(`\n${speaker.name}:`);
    else { stop.push(`\n${userName}:`); for (const c of characters) if (c.id !== speaker.id) stop.push(`\n${c.name}:`); }
  }
  for (const x of s.customStops) stop.push(sub(x));
  const tokens = cost(messages);
  return {
    messages: messages.map(({ role, content }) => ({ role, content })),
    stop: [...new Set(stop.filter(Boolean))].slice(0, 4),
    speaker: { id: speaker.id, name: speaker.name },
    vars,
    info: {
      tokens, window, reserve: s.responseReserve, droppedMessages, examples: examples.length, exampleBlocks: blocks.length,
      worldInfo: { activated: wi.activated, dropped: wi.dropped, tokens: wi.tokens, budget: wiBudget },
      pieces: messages.map(m => ({ role: m.role, piece: m.piece, tokens: estimateTokens(m.content) + 4 })),
    },
    // What the model wrote may start with the speaker's own name: the page strips it.
    namePrefix: withNames ? `${mode === 'impersonate' ? userName : speaker.name}:` : null,
  };
}
