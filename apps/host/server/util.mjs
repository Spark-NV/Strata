/** Shared helpers for the Strata host. */
import { gunzipSync } from 'node:zlib';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { whichCommand } from './platform-paths.mjs';

export const exec = promisify(execFile);
export const uid = (prefix = 'id') => `${prefix}_${randomUUID().slice(0, 8)}`;
export const nowIso = () => new Date().toISOString();
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const round = (n, d = 1) => Number(n.toFixed(d));

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function error(res, status, message, extra = {}) {
  json(res, status, { error: message, ...extra });
}

/**
 * Two secrets compared in constant time (#4535). Both sides are hashed first, so the comparison always runs over two
 * 32-byte digests: neither the content nor the length of the given value can end it early. Anything that is not a
 * non-empty string never matches (an empty secret is "not set", not "equal to an empty header").
 */
export function sameSecret(given, wanted) {
  const ok = typeof given === 'string' && typeof wanted === 'string' && given.length > 0 && wanted.length > 0;
  const digest = value => createHash('sha256').update(typeof value === 'string' ? value : '', 'utf8').digest();
  return timingSafeEqual(digest(given), digest(wanted)) && ok;
}

/**
 * The request's URL, or null when the request cannot be read as one (#4397). The Host header is the caller's: an empty
 * value, one with a space, a path, credentials or an unclosed bracket used to make `new URL` throw before the routing
 * try/catch and end the whole process. A missing Host (HTTP/1.0) is read as localhost; a good one keeps its port and IPv6 form.
 */
export function requestUrl(req) {
  const host = req.headers?.host;
  try {
    let authority = 'localhost';
    if (host !== undefined) {
      if (typeof host !== 'string' || !host.trim() || /[\s/?#@\\]/.test(host)) return null;
      const base = new URL(`http://${host}`);
      if (!base.host || base.username || base.password || base.search || base.hash || base.pathname !== '/') return null;
      authority = host;
    }
    return new URL(req.url ?? '/', `http://${authority}`);
  } catch {
    return null;
  }
}

/** The answer to a request that could not be read as a URL: bounded, and the connection closes. */
export function badRequest(res) {
  if (res.headersSent) return res.end();
  const payload = '{"error":"bad_host"}';
  res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store', connection: 'close' });
  res.end(payload);
}

export async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = unzipped(req, Buffer.concat(chunks), limit).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Body must be JSON');
  }
}

/** Run a command, returning stdout or '' when it is missing or fails. */
export async function probe(cmd, args = [], timeout = 4000) {
  try {
    const { stdout } = await exec(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Where `binary` is on PATH, or null. `/usr/bin/env which` on POSIX, System32\where.exe on Windows (first match). */
export async function which(binary, { env = process.env, platform = process.platform, run = probe } = {}) {
  const { command, args } = whichCommand(binary, env, platform);
  const out = await run(command, args);
  return out.split(/\r?\n/)[0].trim() || null;
}

/** Minimal SSE hub. */
export class EventHub {
  #clients = new Map();   // res -> { topics: Set | null, monitorEveryMs, lastMonitor, ids }
  // The events sent lately (never `monitor`), so a client that reconnects gets what it missed: at least 10 minutes or 1,000 events.
  #log = [];
  #count = 0;
  #boot = Math.random().toString(36).slice(2, 8);
  #keepMs;
  #keepCount;

  constructor({ keepMs = 10 * 60_000, keepCount = 1000 } = {}) { this.#keepMs = keepMs; this.#keepCount = keepCount; }

  /**
   * One live event stream. With no options every event is sent, as always. `topics` (a list of event names) sends only those, so a phone
   * on a weak connection does not get the large `monitor` event every second (about 220 MB an hour); `monitorEveryMs` thins `monitor`
   * out when it is asked for. A `: ping` comment line every 15 seconds says the stream is alive either way.
   *
   * `ids` (asked with topics or ids=1, never for the desktop's page): every event but `monitor` carries an SSE `id:`. A reconnect that
   * names the last one (`lastEventId`, from the Last-Event-ID header) first gets the events it missed, or one `event: reset` when they
   * are no longer kept (or the host restarted), and the client reloads.
   */
  add(res, { topics = null, monitorEveryMs = 0, ids = false, lastEventId = null } = {}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const want = { topics: topics ? new Set(topics) : null, monitorEveryMs: Math.max(0, Number(monitorEveryMs) || 0), lastMonitor: 0, ids: !!ids };
    if (want.ids && lastEventId) {
      const m = /^([a-z0-9]+)-(\d+)$/.exec(String(lastEventId));
      const n = m ? Number(m[2]) : -1;
      const oldest = this.#log[0]?.n ?? this.#count + 1;
      if (!m || m[1] !== this.#boot || n > this.#count || n < oldest - 1) res.write(`id: ${this.#boot}-${this.#count}\nevent: reset\ndata: {}\n\n`);
      else for (const e of this.#log) if (e.n > n && (!want.topics || want.topics.has(e.event))) res.write(`id: ${this.#boot}-${e.n}\n${e.frame}`);
    }
    this.#clients.set(res, want);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => {
      clearInterval(ping);
      this.#clients.delete(res);
    });
  }

  send(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    const now = Date.now();
    let id = null;
    if (event !== 'monitor') {
      const n = ++this.#count;
      id = `id: ${this.#boot}-${n}\n`;
      this.#log.push({ n, event, frame, at: now });
      while (this.#log.length > 20 * this.#keepCount || (this.#log.length > this.#keepCount && now - this.#log[0].at >= this.#keepMs)) this.#log.shift();
    }
    for (const [res, want] of this.#clients) {
      if (want.topics && !want.topics.has(event)) continue;
      if (event === 'monitor' && want.monitorEveryMs) { if (now - want.lastMonitor < want.monitorEveryMs) continue; want.lastMonitor = now; }
      try {
        res.write(want.ids && id ? id + frame : frame);
      } catch {
        this.#clients.delete(res);
      }
    }
  }

  get size() {
    return this.#clients.size;
  }
}

/**
 * The options of an /api/events request (none: everything, as before): `topics`, `monitorEveryMs`, and event ids with replay (with
 * topics, or ids=1) from the Last-Event-ID header or `lastEventId`.
 */
export function eventOptions(searchParams, headers = {}) {
  const raw = searchParams.get('topics');
  const topics = raw === null ? null : raw.split(',').map(t => t.trim()).filter(Boolean);
  const ids = topics !== null || searchParams.get('ids') === '1';
  const last = headers['last-event-id'] ?? searchParams.get('lastEventId');
  return { topics, monitorEveryMs: Number(searchParams.get('monitorEveryMs')) || 0, ...(ids ? { ids: true, lastEventId: typeof last === 'string' && last ? last : null } : {}) };
}

/** The raw bytes of a request body (an upload), up to `limit`. */
export async function readRaw(req, limit = 16 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('That upload is too big.');
    chunks.push(chunk);
  }
  return unzipped(req, Buffer.concat(chunks), limit);
}

/** A body sent with `content-encoding: gzip` (a phone saving data), unpacked; at most `limit` bytes once unpacked. */
function unzipped(req, bytes, limit) {
  if (String(req.headers?.['content-encoding'] ?? '').toLowerCase() !== 'gzip' || !bytes.length) return bytes;
  try { return gunzipSync(bytes, { maxOutputLength: limit }); }
  catch (e) { throw Object.assign(new Error(e?.code === 'ERR_BUFFER_TOO_LARGE' ? 'Request body too large' : 'The gzip body could not be unpacked.'), { status: 400, code: 'bad-gzip' }); }
}
