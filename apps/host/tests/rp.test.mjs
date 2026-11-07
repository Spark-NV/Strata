// Roleplay (server/rp/): cards in and out, World Info, macros, the prompt's order and budget, group turns; memory and profile agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLANK_PNG, bookFromExternal, bookToWorldInfo, characterFromCard, characterToCard, normalizeBook, normalizeCharacter, pngWithCard, readImport } from '../server/rp/cards.mjs';
import { activateWorldInfo, buildRpPrompt, finishReply, selectSpeaker, substitute } from '../server/rp/prompt.mjs';
import { createRpStore, normalizeRpSettings } from '../server/rp/store.mjs';
import { createMemoryStore, memoryPrompt } from '../server/memory.mjs';
import { applyProfileToAgentBody, normalizeProfile, toolAllowed } from '../server/profiles.mjs';

const settings = normalizeRpSettings({});
const mira = normalizeCharacter({ name: 'Mira', description: '{{char}} is a thief who distrusts {{user}}.', personality: 'sly', scenario: 'Rain.', exampleDialogues: '<START>\n{{user}}: Hi\n{{char}}: Hm.', depthPrompt: { text: 'Short sentences.', depth: 1 } });
const book = normalizeBook({ name: 'City', entries: [
  { keys: ['harbor'], content: 'The harbor belongs to the Gulls.' },
  { keys: ['gulls'], content: 'Gulls wear grey.' },
  { keys: ['ship'], secondaryKeys: ['storm'], selectiveLogic: 'not_any', content: 'Ships sail at dawn.' },
  { constant: true, content: 'Magic is rare.', position: 'after_char' },
  { keys: ['tower'], content: 'At depth.', position: 'depth', depth: 0, role: 'user' },
] });

test('a V2 card survives PNG export and import, embedded lorebook and character note included', () => {
  const c = normalizeCharacter({ ...mira, book, alternateGreetings: ['Hello', 'Yo'] });
  const back = readImport(pngWithCard(BLANK_PNG, c), 'mira.png');
  assert.equal(back.kind, 'character');
  assert.equal(back.character.name, 'Mira');
  assert.deepEqual(back.character.alternateGreetings, ['Hello', 'Yo']);
  assert.equal(back.character.depthPrompt.text, 'Short sentences.');
  assert.equal(back.character.book.entries.length, 5);
  assert.equal(back.character.book.entries[4].position, 'depth');
  assert.equal(characterToCard(c, { v3: true }).spec, 'chara_card_v3');
});

test('V1 cards and SillyTavern World Info files are read', () => {
  assert.equal(characterFromCard({ name: 'Old', char_persona: 'p', char_greeting: 'hi' }).firstMessage, 'hi');
  const wi = bookToWorldInfo(book);
  const again = bookFromExternal(wi);
  assert.deepEqual(again.entries.map(e => [e.keys, e.position, e.constant]), book.entries.map(e => [e.keys, e.position, e.constant]));
  assert.equal(readImport(Buffer.from(JSON.stringify(wi)), 'city.json').kind, 'lorebook');
});

test('macros: names, variables, dice, a stable pick, comments and trim', () => {
  const vars = {};
  assert.equal(substitute('{{user}} meets {{char}}{{// note}}', { char: 'Mira', user: 'Sam' }), 'Sam meets Mira');
  assert.equal(substitute('{{setvar::n::2}}{{addvar::n::3}}{{getvar::n}}', { vars }), '5');
  const roll = Number(substitute('{{roll:2d6}}', {}));
  assert.ok(roll >= 2 && roll <= 12);
  const a = substitute('{{pick::x::y::z}}', { chatId: 'c1' }), b = substitute('{{pick::x::y::z}}', { chatId: 'c1' });
  assert.equal(a, b);
  assert.equal(substitute('A\n\n{{trim}}\n\nB', {}), 'AB');
});

test('World Info: keys, recursion, NOT ANY, constants, depth entries and the budget', () => {
  const wi = activateWorldInfo({ books: [book], wi: settings.worldInfo, history: [{ text: 'Meet me at the harbor. The ship leaves.' }], budget: 1000 });
  const texts = [...wi.before, ...wi.after];
  assert.ok(texts.includes('The harbor belongs to the Gulls.'));
  assert.ok(texts.includes('Gulls wear grey.'), 'recursion: the first entry names the second');
  assert.ok(texts.includes('Ships sail at dawn.'), 'NOT ANY: no storm');
  assert.ok(wi.after.includes('Magic is rare.'));
  const stormy = activateWorldInfo({ books: [book], wi: settings.worldInfo, history: [{ text: 'The ship in the storm.' }], budget: 1000 });
  assert.ok(![...stormy.before, ...stormy.after].includes('Ships sail at dawn.'));
  const tight = activateWorldInfo({ books: [book], wi: settings.worldInfo, history: [{ text: 'harbor ship' }], budget: 8 });
  assert.ok(tight.dropped.length > 0);
});

test('the prompt: one system message in order, the chat, notes at their depth, stops and the newest message always kept', () => {
  const r = buildRpPrompt({ settings, characters: [mira], speakerId: mira.id, persona: { name: 'Sam', description: 'A guard.', position: 'prompt' }, books: [book],
    history: [{ role: 'assistant', content: 'Hm.' }, { role: 'user', content: 'The tower, now.' }], authorsNote: { text: 'NOTE', depth: 1, interval: 1, role: 'system', position: 'depth' }, contextMax: 32768 });
  const sys = r.messages[0].content;
  assert.equal(r.messages[0].role, 'system');
  assert.ok(sys.indexOf('You are Mira') < sys.indexOf('A guard.') && sys.indexOf('A guard.') < sys.indexOf('Mira is a thief who distrusts Sam.'));
  assert.ok(sys.includes('Sam: Hi\nMira: Hm.'), 'examples with names filled in');
  const last = r.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.ok(r.messages.some(m => m.role === 'system' && m.content.includes('NOTE')));
  assert.ok(r.messages.some(m => m.role === 'user' && m.content === 'At depth.'));
  assert.deepEqual(r.stop, ['\nSam:']);
  const tiny = buildRpPrompt({ settings: { ...settings, responseReserve: 256 }, characters: [mira], speakerId: mira.id, persona: null, books: [], history: [{ role: 'user', content: 'x'.repeat(5000) }], authorsNote: null, contextMax: 500 });
  assert.ok(tiny.messages.some(m => m.role === 'user' && m.content.length === 5000));
});

test('groups: names on messages, the nudge, and who speaks next', () => {
  const ana = normalizeCharacter({ name: 'Ana Ruiz', talkativeness: 0 });
  const r = buildRpPrompt({ settings, characters: [mira, ana], speakerId: ana.id, persona: null, books: [], history: [{ role: 'user', content: 'hi' }], authorsNote: null, contextMax: 32768 });
  assert.ok(r.messages.some(m => m.content === 'User: hi'));
  assert.ok(r.messages.at(-1).content.includes('only as Ana Ruiz'));
  assert.ok(r.stop.includes('\nMira:'));
  const next = selectSpeaker({ characters: [mira, ana], messages: [{ role: 'user', content: 'What do you think, Ana?' }] });
  assert.equal(next, ana.id);
  assert.equal(selectSpeaker({ characters: [mira, ana], messages: [{ role: 'assistant', characterId: mira.id, content: 'x' }], strategy: 'list' }), ana.id);
});

test('replacements and trimming an unfinished sentence', () => {
  const s = { ...settings, trimIncomplete: true, replacements: [{ id: 'a', name: '', find: 'colour', replace: 'color', flags: 'g', on: 'output', enabled: true }] };
  assert.equal(finishReply('A colour. And then she', s), 'A color.');
});

test('the library store keeps one file per item and the settings', () => {
  const rp = createRpStore({ dataDir: mkdtempSync(join(tmpdir(), 'strata-rp-')) });
  const c = rp.characters.save({ name: 'Kai' });
  assert.equal(rp.characters.get(c.id).name, 'Kai');
  rp.characters.setImage(c.id, BLANK_PNG);
  assert.equal(rp.characters.image(c.id).type, 'image/png');
  rp.saveSettings({ ...rp.settings(), userName: 'Sam', promptOrder: [{ id: 'chatHistory', enabled: true }, { id: 'main', enabled: true }] });
  assert.equal(rp.settings().userName, 'Sam');
  assert.equal(rp.settings().promptOrder.length, 11, 'missing pieces come back');
  rp.characters.remove(c.id);
  assert.equal(rp.characters.get(c.id), null);
});

test('memory is saved, given to a profile, and its tools follow the profile switches', () => {
  const mem = createMemoryStore({ dataDir: mkdtempSync(join(tmpdir(), 'strata-mem-')) });
  mem.add('Likes metric units');
  mem.add('likes metric units');
  assert.equal(mem.list().length, 1, 'no duplicates');
  assert.ok(memoryPrompt(mem.list(), true).includes('Likes metric units'));
  const chat = normalizeProfile('chat', {});
  assert.equal(toolAllowed(chat, 'mcp__memory__remember'), true);
  assert.equal(toolAllowed(normalizeProfile('rp', {}), 'mcp__memory__remember'), false);
  assert.equal(toolAllowed(normalizeProfile('chat', { memory: { read: true, write: false } }), 'mcp__memory__remember'), false);
});

test('a helper started as @name gets that agent\'s instructions and only its tools', () => {
  const code = normalizeProfile('code', {});
  const body = applyProfileToAgentBody({ messages: [{ role: 'system', content: 'H' }, { role: 'user', content: '@explorer find the parser' }], tools: ['write', 'read', 'grep', 'bash'].map(name => ({ type: 'function', function: { name } })) }, code);
  assert.ok(body.messages[0].content.includes('You are the @explorer agent.'));
  assert.deepEqual(body.tools.map(t => t.function.name), ['read', 'grep', 'bash']);
  const main = applyProfileToAgentBody({ messages: [{ role: 'system', content: 'H' }, { role: 'user', content: 'fix it' }] }, code, { memory: 'MEMORY' });
  assert.ok(main.messages[0].content.includes('- @reviewer:'));
  assert.ok(main.messages[0].content.endsWith('MEMORY'));
  assert.equal(normalizeProfile('code', { systemPrompt: '' }).systemPrompt.startsWith('Work like'), true, 'an old empty prompt takes the new default');
  assert.equal(normalizeProfile('code', { systemPrompt: '', rev: 2 }).systemPrompt, '', 'an empty prompt saved on purpose stays empty');
});
