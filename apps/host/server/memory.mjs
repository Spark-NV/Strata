/**
 * Memory: short facts about the person that last across chats (like ChatGPT's and Claude's memory).
 *
 *   <dataDir>/memory.json   { items: [{ id, text, createdAt, source: 'you' | 'assistant' }] }
 *
 * The person edits the list in Settings -> Memory. A profile with memory on gets the list in its system prompt (profiles.mjs) and, with
 * "can save" on, the agent tools remember / recall / forget (agent/memory-mcp.mjs, which writes the same file). Read fresh every time:
 * the file is small and two writers (this host and the tool server) share it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MEMORY_MAX_ITEMS = 500;
export const MEMORY_MAX_TEXT = 2000;

export function readMemory(file) {
  try { const items = JSON.parse(readFileSync(file, 'utf8'))?.items; return Array.isArray(items) ? items.filter(i => i && typeof i.text === 'string' && typeof i.id === 'string') : []; } catch { return []; }
}
export function writeMemory(file, items) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ items: items.slice(-MEMORY_MAX_ITEMS) }, null, 2));
  renameSync(tmp, file);
}
export function addMemory(file, text, source = 'you') {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_MAX_TEXT);
  if (!clean) throw new Error('A memory needs some text.');
  const items = readMemory(file);
  const same = items.find(i => i.text.toLowerCase() === clean.toLowerCase());
  if (same) return same;
  const item = { id: randomUUID().slice(0, 8), text: clean, createdAt: new Date().toISOString(), source };
  writeMemory(file, [...items, item]);
  return item;
}

/** The block a profile's system prompt gets. */
export function memoryPrompt(items, canSave) {
  if (!items.length && !canSave) return '';
  const lines = items.map(i => `- [${i.id}] ${i.text}`).join('\n');
  return [
    'Memory: what you know about the person from earlier chats. Use it when it is relevant; do not mention it otherwise.',
    items.length ? `<memory>\n${lines}\n</memory>` : '(Nothing saved yet.)',
    canSave ? 'When the person asks you to remember something, or states a lasting fact or preference about themselves or how they want you to work, save it with the remember tool (one short fact per call). Use forget when they ask you to forget something or a memory is wrong. Never save passwords, keys or other secrets.' : '',
  ].filter(Boolean).join('\n');
}

export function createMemoryStore({ dataDir }) {
  const file = join(dataDir, 'memory.json');
  if (!existsSync(file)) writeMemory(file, []);
  return {
    file,
    list: () => readMemory(file),
    add: (text, source) => addMemory(file, text, source),
    update(id, text) {
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_MAX_TEXT);
      if (!clean) throw new Error('A memory needs some text.');
      const items = readMemory(file);
      if (!items.some(i => i.id === id)) throw new Error('That memory is gone.');
      writeMemory(file, items.map(i => (i.id === id ? { ...i, text: clean } : i)));
    },
    remove(id) { writeMemory(file, readMemory(file).filter(i => i.id !== id)); },
    clear() { writeMemory(file, []); },
  };
}
