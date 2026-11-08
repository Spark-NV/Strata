/**
 * One helper's conversation, for the person to read ("View conversation" in the Subagents list, src/components/HelperConversation.tsx).
 *
 * It reads the Harness's saved session file (<home>/sessions/<folder>/<helperId>/session.v4.jsonl.zstd) and nothing else: no RPC, no
 * stream, no lock. Watching a helper can never change what it or the Head does. The Harness appends to the file while the helper works,
 * so asking again with `after` (the last seq the page has) gives the new lines.
 *
 * What is kept is the talk, not the work: the Head's task and later messages, the helper's own words, its messages to the Head, its
 * report, and one short line per command it ran or thing it looked up. File reads, writes and edits, tool output and the Harness's own
 * notices (time, skills, background jobs) are left out. Its thinking is kept apart (`thinking`) so the page can hide it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const FILE = 'session.v4.jsonl.zstd';
const ID = /^[\w.:@-]{1,160}$/;
const MAX_TEXT = 20_000;
/** Harness notices that are bookkeeping, not part of the conversation. */
const QUIET = new Set(['time-context', 'runtime-context', 'skill-catalog', 'compact-checkpoint', 'tool-jobs', 'subagent-settled']);
/** Tools whose calls are part of the work and would only clutter the conversation. */
const HIDDEN_TOOLS = new Set(['read', 'write', 'edit', 'multi_edit', 'apply_patch', 'glob', 'grep', 'ls', 'read_image', 'job_output', 'todo_write', 'list_agents']);

const clip = (text, max = MAX_TEXT) => { const t = String(text ?? ''); return t.length > max ? `${t.slice(0, max)}\n\n… (${t.length - max} more characters)` : t; };
const one = (text, max = 200) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const textOf = content => (Array.isArray(content) ? content : []).filter(p => p?.type === 'text').map(p => p.text ?? '').join('');
const argsOf = raw => { try { const a = typeof raw === 'string' ? JSON.parse(raw) : raw; return a && typeof a === 'object' ? a : {}; } catch { return {}; } };

const MAGIC = 0xfd2fb528;
/**
 * The Harness appends one zstd frame per write. Node 24 (the app's runtime) decodes only the first frame of a buffer, so the frames are
 * found here (each frame's length is in its headers) and decoded one by one. A last frame the Harness is still writing is left out.
 */
export function decodeFrames(buf) {
  const out = [];
  let at = 0;
  while (at + 8 <= buf.length) {
    const magic = buf.readUInt32LE(at);
    if ((magic & 0xfffffff0) === 0x184d2a50) { at += 8 + buf.readUInt32LE(at + 4); continue; }   // a skippable frame
    if (magic !== MAGIC) break;
    const fhd = buf[at + 4], single = (fhd >> 5) & 1, fcsFlag = fhd >> 6, dictFlag = fhd & 3, checksum = (fhd >> 2) & 1;
    let pos = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][dictFlag] + [single ? 1 : 0, 2, 4, 8][fcsFlag];
    let last = false;
    while (!last) {
      if (pos + 3 > buf.length) return Buffer.concat(out);
      const h = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
      last = (h & 1) === 1;
      const type = (h >> 1) & 3, size = h >>> 3;
      pos += 3 + (type === 1 ? 1 : size);
    }
    pos += checksum ? 4 : 0;
    if (pos > buf.length) break;
    out.push(zstdDecompressSync(buf.subarray(at, pos)));
    at = pos;
  }
  return Buffer.concat(out);
}

export class HelperTranscripts {
  /** @param {{home:string}} options  the Harness's DSH_HOME */
  constructor({ home }) {
    this.home = home;
    this.paths = new Map();   // session id -> file
    this.cache = new Map();   // file -> { mtimeMs, size, rows }
  }

  file(id) {
    const known = this.paths.get(id);
    if (known && existsSync(known)) return known;
    const base = join(this.home, 'sessions');
    let folders = [];
    try { folders = readdirSync(base); } catch { return null; }
    for (const folder of folders) {
      const path = join(base, folder, id, FILE);
      if (existsSync(path)) { this.paths.set(id, path); return path; }
    }
    return null;
  }

  rows(path) {
    const st = statSync(path);
    const hit = this.cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rows;
    let text;
    try { text = decodeFrames(readFileSync(path)).toString('utf8'); } catch { return hit?.rows ?? []; }
    const rows = [];
    for (const line of text.split('\n')) { if (!line) continue; try { rows.push(JSON.parse(line)); } catch { /* a cut line */ } }
    this.cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, rows });
    return rows;
  }

  header(id) {
    const path = this.file(id);
    if (!path) return null;
    const rows = this.rows(path);
    return { path, rows, head: rows.find(r => r.type === 'session') ?? null };
  }

  /**
   * @param {{parentSessionId:string, helperId:string, after?:number}} request
   * @returns {{id, name, running, updatedAt, last, items}}
   */
  read({ parentSessionId, helperId, after = -1 }) {
    const id = String(helperId ?? '');
    if (!ID.test(id) || !parentSessionId) throw Object.assign(new Error('That helper is not known.'), { code: 'helper-unknown' });
    const found = this.header(id);
    if (!found?.head) throw Object.assign(new Error('This helper has no saved conversation yet.'), { code: 'helper-missing' });
    // Only a helper of this chat (or a helper of one of its helpers) can be read from it.
    let parent = found.head.parentSession, depth = 0;
    while (parent && parent !== parentSessionId && depth++ < 4) parent = this.header(parent)?.head?.parentSession;
    if (parent !== parentSessionId) throw Object.assign(new Error('That helper is not part of this chat.'), { code: 'helper-unknown' });
    return project(found.rows, { id, parentSessionId: found.head.parentSession, after: Number.isFinite(+after) ? +after : -1 });
  }
}

/** The saved rows of one helper session as conversation items. Pure, so tests can feed it rows. */
export function project(rows, { id, parentSessionId, after = -1 }) {
  const items = [];
  let name = 'Helper', running = false, updatedAt = 0, last = -1, gotTask = false, lastSay = null;
  for (const r of rows) {
    const seq = Number(r.seq ?? -1), at = r.time ?? 0, d = r.data ?? {};
    if (at > updatedAt) updatedAt = at;
    if (seq > last) last = seq;
    const push = item => { if (seq > after) items.push({ seq, at, ...item }); };
    switch (r.type) {
      case 'subagent/descriptor': if (d.label) name = one(d.label, 60); break;
      case 'turn/start': running = true; break;
      case 'turn/end': running = false; if (lastSay) lastSay.kind = 'report'; lastSay = null; break;
      case 'user/message': {
        const kind = d.source?.kind ?? 'user';
        if (QUIET.has(kind)) break;
        let text = textOf(d.content);
        if (!text.trim() || text.trimStart().startsWith('<project_book>')) break;
        if (kind === 'agent-message') {
          text = text.replace(/^Agent \S+ sent a message:\s*/, '');
          push({ kind: d.source?.senderSessionId === parentSessionId ? 'from-head' : 'from-helper', text: clip(text) });
        } else if (kind === 'user') {
          push({ kind: gotTask ? 'from-head' : 'task', text: clip(text) });
          gotTask = true;
        }
        break;
      }
      case 'assistant/message':
        for (const p of d.message?.content ?? []) {
          if (p.type === 'reasoning' && p.text?.trim()) push({ kind: 'thinking', text: clip(p.text) });
          else if (p.type === 'text' && p.text?.trim()) { push({ kind: 'says', text: clip(p.text) }); if (seq > after) lastSay = items.at(-1); }
          else if (p.type === 'tool-call') { const step = stepOf(p.name, argsOf(p.arguments)); if (step) push(step); }
        }
        break;
      default: break;
    }
  }
  return { id, name, running, updatedAt, last, items };
}

/** One short line for a tool call worth seeing, or null for the ones that are only work. */
export function stepOf(name, a) {
  if (HIDDEN_TOOLS.has(name)) return null;
  if (name === 'send_message') return { kind: 'to-agent', text: clip(a.message ?? a.content ?? a.text ?? '') };
  if (name === 'bash' || name === 'shell') return { kind: 'step', text: one(a.description || a.command), detail: one(a.command, 400) };
  if (name === 'web_search') return { kind: 'step', text: `Searched the web: ${one(a.query, 160)}` };
  if (name === 'web_fetch') return { kind: 'step', text: `Opened ${one(a.url, 160)}` };
  if (name === 'subagent' || name === 'subagent_fork') return { kind: 'step', text: `Handed work to a helper: ${one(a.description || a.prompt, 160)}` };
  if (name === 'vibe_review') {
    const findings = (Array.isArray(a.findings) ? a.findings : []).map(f => `- ${typeof f === 'string' ? f : JSON.stringify(f)}`).join('\n');
    return { kind: 'review', text: clip(`Review: **${a.verdict === 'pass' ? 'pass' : 'fail'}**${a.checked ? `\n\nChecked: ${a.checked}` : ''}${findings ? `\n\n${findings}` : ''}`) };
  }
  if (String(name).startsWith('vibe_')) return { kind: 'step', text: `${name.replace('vibe_', 'Vibe ')}` };
  if (name === 'ask_user_question') return { kind: 'step', text: 'Asked you a question' };
  return null;
}
