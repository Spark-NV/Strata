/**
 * Token usage of the agent's model calls, read from the Harness's own session logs (agent/home/sessions/<folder>/<session>/session.v4.jsonl.zstd).
 *
 * Every model call the Harness makes is one `assistant/message` record with the provider's usage: `inputTokens` (prompt tokens the model
 * had to read: a cache miss), `cacheReadTokens` (prompt tokens reused from the cache: a hit) and `outputTokens` (thinking and answer).
 * A context compaction is one more call, in its `compaction/summary` record. Nothing here is estimated.
 *
 * The calls are summed per session into buckets keyed by local day, hour and prompt size, so the page can price them with off-peak hours
 * and long-context rates without the host sending every call. A file is read again only when its size or time changed.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompress } from 'node:zlib';
import { promisify } from 'node:util';

const unzstdOne = promisify(zstdDecompress);

/**
 * The Harness appends to its log one zstd frame at a time. Node 24 (the app's runtime) decompresses only the first frame of a buffer, so
 * the frames are found by walking their headers and decompressed one by one.
 */
export function zstdFrames(buf) {
  const frames = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const magic = buf.readUInt32LE(p);
    if ((magic & 0xfffffff0) === 0x184d2a50) { p += 8 + buf.readUInt32LE(p + 4); continue; }   // a skippable frame
    if (magic !== 0xfd2fb528) break;
    const start = p, fhd = buf[p + 4];
    const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
    p += 5 + (single ? 0 : 1) + [0, 1, 2, 4][dictFlag] + [single ? 1 : 0, 2, 4, 8][fcsFlag];
    for (;;) {
      if (p + 3 > buf.length) return frames;   // a frame still being written
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      const type = (h >> 1) & 3, size = h >> 3;
      p += 3 + (type === 1 ? 1 : size);
      if (h & 1) break;
    }
    if (checksum) p += 4;
    if (p > buf.length) break;
    frames.push(buf.subarray(start, p));
  }
  return frames;
}
async function unzstd(buf) {
  const parts = [];
  for (const frame of zstdFrames(buf)) { try { parts.push(await unzstdOne(frame)); } catch { /* a damaged frame is skipped */ } }
  return Buffer.concat(parts);
}
const USAGE = /"usage":(\{[^{}]*\})/;
const TIME = /"time":(\d+)/;
/** Prompt size tiers: up to 100K, up to 200K, above 200K tokens (the thresholds cloud price lists use). */
const tierOf = prompt => (prompt > 200_000 ? 2 : prompt > 100_000 ? 1 : 0);
const pad = n => String(n).padStart(2, '0');
const dayOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** One session log's calls: { title, model, first, last, totals, buckets: { 'YYYY-MM-DD|H|tier': [calls, miss, hit, out] } } */
export function summarizeSession(text) {
  const out = { title: '', model: '', first: null, last: null, totals: { calls: 0, miss: 0, hit: 0, out: 0, compactions: 0 }, buckets: {} };
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const head = text.slice(start, Math.min(end, start + 48));
    const call = head.startsWith('{"type":"assistant/message"'), compaction = head.startsWith('{"type":"compaction/summary"');
    if (call || compaction) {
      const line = text.slice(start, end);
      const u = USAGE.exec(line), t = TIME.exec(line);
      if (u) {
        try {
          const usage = JSON.parse(u[1]);
          const miss = Number(usage.inputTokens) || 0, hit = Number(usage.cacheReadTokens) || 0, gen = Number(usage.outputTokens) || 0;
          const time = t ? Number(t[1]) : null;
          const when = new Date(time ?? Date.now());
          const key = `${dayOf(when)}|${when.getHours()}|${tierOf(miss + hit)}`;
          const b = out.buckets[key] ?? (out.buckets[key] = [0, 0, 0, 0]);
          b[0] += 1; b[1] += miss; b[2] += hit; b[3] += gen;
          out.totals.calls += 1; out.totals.miss += miss; out.totals.hit += hit; out.totals.out += gen;
          if (compaction) out.totals.compactions += 1;
          if (time) { out.first = out.first === null ? time : Math.min(out.first, time); out.last = out.last === null ? time : Math.max(out.last, time); }
        } catch { /* a damaged record is skipped */ }
      }
    } else if (head.startsWith('{"type":"session/title"') || head.startsWith('{"type":"model/selection"')) {
      try {
        const j = JSON.parse(text.slice(start, end));
        if (j.type === 'session/title' && typeof j.data?.title === 'string') out.title = j.data.title;
        if (j.type === 'model/selection' && typeof j.data?.model === 'string') out.model = j.data.model;
      } catch { /* skipped */ }
    }
    start = end + 1;
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.home            the Harness home (agent/home)
 * @param {string} o.sessionsFile    agent/sessions.json: chatId -> { sessionId }
 * @param {() => Array<{id:string,title?:string}>} o.chats   the chat list, for names
 */
export function createTokenUsage({ home, sessionsFile, chats = () => [] }) {
  const cache = new Map();   // path -> { size, mtime, summary }
  let running = null;

  async function scan() {
    const root = join(home, 'sessions');
    const files = [];
    if (existsSync(root)) {
      for (const folder of readdirSync(root)) {
        let entries = [];
        try { entries = readdirSync(join(root, folder)); } catch { continue; }
        for (const s of entries) {
          if (!s.startsWith('session-')) continue;
          const path = join(root, folder, s, 'session.v4.jsonl.zstd');
          try { const st = statSync(path); files.push({ path, sessionId: s, folder, size: st.size, mtime: st.mtimeMs }); } catch { /* none */ }
        }
      }
    }
    let map = {};
    try { map = JSON.parse(readFileSync(sessionsFile, 'utf8')) ?? {}; } catch { map = {}; }
    const chatOf = new Map(Object.entries(map).map(([chatId, v]) => [v?.sessionId, chatId]));
    const titles = new Map((chats() ?? []).map(c => [c.id, c.title || c.defaultTitle || '']));
    const sessions = [];
    for (const f of files) {
      let entry = cache.get(f.path);
      if (!entry || entry.size !== f.size || entry.mtime !== f.mtime) {
        try {
          const text = (await unzstd(readFileSync(f.path))).toString('utf8');
          entry = { size: f.size, mtime: f.mtime, summary: summarizeSession(text) };
          cache.set(f.path, entry);
        } catch { continue; }
        await new Promise(r => setImmediate(r));   // keep the host answering while a big log is read
      }
      const s = entry.summary;
      if (!s.totals.calls) continue;
      const chatId = chatOf.get(f.sessionId) ?? null;
      sessions.push({ id: f.sessionId, chatId, chatTitle: chatId ? titles.get(chatId) ?? '' : '', title: s.title, model: s.model, first: s.first, last: s.last, totals: s.totals, buckets: s.buckets });
    }
    sessions.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
    return { at: Date.now(), timeZoneOffsetMin: -new Date().getTimezoneOffset(), sessions };
  }

  return {
    /** All agent sessions with model calls, newest first. Concurrent asks share one scan. */
    snapshot() {
      running ??= scan().finally(() => { running = null; });
      return running;
    },
  };
}
