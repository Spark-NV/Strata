/**
 * Remote access: the whole app (its page, its API, the model's OpenAI and Anthropic API) on the network and from outside the
 * house, behind one key. An HTTPS listener in front of the host on 127.0.0.1:
 *
 *   - Every request needs the key: `Authorization: Bearer <key>` or `x-api-key: <key>` (apps, the iOS app, scripts), or the
 *     cookie the sign-in page sets after the key is typed once (a browser). Wrong keys are counted per address and overall.
 *   - /v1/* goes to the pinned model, started first when it sleeps or the image model has the GPU (pinned.ensure()).
 *   - Everything else goes to the host as if it came from the local app: same paths, same live events, same chats.
 *
 * Off unless STRATA_REMOTE_CONFIG names a JSON file: { "port": 8443, "key": "<at least 32 characters>", "cert": "<PEM file>",
 * "certKey": "<PEM file>", "host": "0.0.0.0", "allow": ["lan", "cloudflare"] }. There is no plain-HTTP mode: the key would
 * travel readable. `allow` says who may connect at all: the home network, Cloudflare's proxy, or "any" address. A connection
 * from anywhere else is closed before TLS, so the open port on the router only serves Cloudflare.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIPv4 } from 'node:net';

// Nothing a stranger sees names the app: the page, the paths, the cookie and the refusals are all plain.
const COOKIE = 'session';
const COOKIE_DAYS = 30;
const WINDOW_MS = 15 * 60_000;
export const MAX_FAILS_PER_ADDRESS = 10, MAX_FAILS_TOTAL = 100;

/** The remote access settings from the file STRATA_REMOTE_CONFIG names, checked; null when it is not set. Throws on a bad file. */
const PICTURE_TYPES = { '.webp': 'image/webp', '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

export function remoteConfig(env = process.env, read = path => readFileSync(path, 'utf8')) {
  const file = String(env.STRATA_REMOTE_CONFIG ?? '').trim();
  if (!file) return null;
  let raw;
  try { raw = JSON.parse(read(file)); } catch (e) { throw new Error(`Remote access: ${file} could not be read as JSON (${e.message}).`); }
  if (raw?.enabled === false) return null;
  const key = typeof raw?.key === 'string' ? raw.key.trim() : '';
  if (key.length < 32) throw new Error(`Remote access: "key" in ${file} must be at least 32 characters.`);
  const port = Number(raw.port ?? 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Remote access: "port" in ${file} is not a port.`);
  for (const name of ['cert', 'certKey']) if (typeof raw[name] !== 'string' || !existsSync(raw[name])) throw new Error(`Remote access: "${name}" in ${file} must name a PEM file that exists.`);
  const allow = raw.allow === undefined ? ['lan', 'cloudflare'] : raw.allow;
  if (!Array.isArray(allow) || !allow.length || allow.some(a => !ALLOW.includes(a))) throw new Error(`Remote access: "allow" in ${file} must list "lan", "cloudflare" or "any".`);
  const failImage = typeof raw.failImage === 'string' && raw.failImage.trim() ? raw.failImage.trim() : null;
  if (failImage && (!existsSync(failImage) || !PICTURE_TYPES[extname(failImage).toLowerCase()])) throw new Error(`Remote access: "failImage" in ${file} must name a .webp, .gif, .png or .jpg file that exists.`);
  return { file, failImage, key, port, host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : '0.0.0.0', cert: raw.cert, certKey: raw.certKey, allow };
}

const ALLOW = ['lan', 'cloudflare', 'any'];

// Cloudflare's addresses, from https://www.cloudflare.com/ips-v4 and /ips-v6 (2026-11-08).
const CLOUDFLARE = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14',
  '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32'];
const LAN = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'];
const blockList = ranges => {
  const list = new BlockList();
  for (const r of ranges) { const [ip, bits] = r.split('/'); list.addSubnet(ip, Number(bits), ip.includes(':') ? 'ipv6' : 'ipv4'); }
  return list;
};
const cloudflareList = blockList(CLOUDFLARE), lanList = blockList(LAN);
const plain = address => String(address ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
const inList = (list, address) => { const a = plain(address); try { return !!a && list.check(a, isIPv4(a) ? 'ipv4' : 'ipv6'); } catch { return false; } };
/** Which group a connecting address belongs to: 'lan', 'cloudflare' or null (anywhere else). */
export function addressKind(address) { return inList(lanList, address) ? 'lan' : inList(cloudflareList, address) ? 'cloudflare' : null; }

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
/** The sign-in cookie's value: made from the key, so it survives restarts and a new key signs every browser out. */
export const sessionValue = key => createHmac('sha256', key).update('strata-remote-session-v1').digest('base64url');

function cookieOf(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === COOKIE) return part.slice(at + 1).trim();
  }
  return null;
}
/** How the request proves the key: 'key' (a header), 'cookie' (signed in in a browser) or null. */
export function authOf(req, key) {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]?.trim();
  if (bearer && same(bearer, key)) return 'key';
  if (req.headers['x-api-key'] && same(String(req.headers['x-api-key']).trim(), key)) return 'key';
  const cookie = cookieOf(req);
  if (cookie && same(cookie, sessionValue(key))) return 'cookie';
  return null;
}

/** Wrong keys: at most MAX_FAILS_PER_ADDRESS per address and MAX_FAILS_TOTAL in all within 15 minutes, then no more tries. */
export function createFailures(now = Date.now) {
  const by = new Map();
  let all = [];
  const fresh = list => list.filter(t => now() - t < WINDOW_MS);
  return {
    blocked(address) { all = fresh(all); return all.length >= MAX_FAILS_TOTAL || fresh(by.get(address) ?? []).length >= MAX_FAILS_PER_ADDRESS; },
    add(address) { const t = now(); all = [...fresh(all), t]; by.set(address, [...fresh(by.get(address) ?? []), t]); if (by.size > 5000) by.clear(); },
  };
}

/** The login page: a password box and a button, nothing else. `note` is an HTML line above the form (a wrong password's picture). */
const LOGIN_PAGE = (note = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Login</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{display:flex;flex-direction:column;align-items:center;gap:16px;width:min(620px,calc(100vw - 32px))}img{max-width:100%;height:auto;border-radius:8px}
form{display:flex;flex-direction:column;gap:12px;width:min(360px,100%)}
input{font:inherit;padding:10px 12px;border:1px solid GrayText;border-radius:8px}button{font:inherit;padding:10px;border:0;border-radius:8px;background:#3b82f6;color:#fff;cursor:pointer}
p{margin:0;color:#e5484d;text-align:center}</style></head><body><main>${note}<form method="post" action="/login">
<input name="password" type="password" autocomplete="current-password" autofocus required><button type="submit">Login</button></form></main></body></html>`;

/** The address a wrong key is counted against: the caller Cloudflare names when the connection really is Cloudflare's, else the
 *  connection's own. Anyone else could write any CF-Connecting-IP to get a fresh count on every try. */
const addressOf = req => {
  const socket = plain(req.socket.remoteAddress);
  const named = String(req.headers['cf-connecting-ip'] ?? '').trim();
  return named && addressKind(socket) === 'cloudflare' ? `cf:${named}` : socket;
};
// Headers that belong to one connection, not to the request; they are not passed on.
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

/**
 * The listener. `localPort` is the host on 127.0.0.1; `pinned` (optional) is { base, ensure } of the pinned model for /v1/*.
 */
export function createRemoteAccess({ config, localPort, pinned = null, log = console.log, now = Date.now, serverFactory = null }) {
  const failures = createFailures(now);
  const allow = config.allow ?? ['lan', 'cloudflare'];
  // A wrong password shows the picture `failImage` names (inline, so it needs no address of its own), else one plain line.
  const failNote = (() => {
    if (!config.failImage) return '<p>Login failed.</p>';
    try {
      const data = readFileSync(config.failImage).toString('base64');
      return `<img src="data:${PICTURE_TYPES[extname(config.failImage).toLowerCase()]};base64,${data}" alt=""><p>Ah ah ah! You didn't say the magic word!</p>`;
    } catch { return '<p>Login failed.</p>'; }
  })();
  const allowed = address => allow.includes('any') || allow.includes(addressKind(address));
  let listener = null;

  function reply(res, status, body, headers = {}) {
    res.writeHead(status, { 'cache-control': 'no-store', ...headers });
    res.end(body);
  }
  const json = (res, status, body) => reply(res, status, JSON.stringify(body), { 'content-type': 'application/json' });
  /** A refusal that says only what the status says. */
  const refuse = (res, status) => reply(res, status, http.STATUS_CODES[status] ?? 'Error', { 'content-type': 'text/plain; charset=utf-8' });

  async function readForm(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) { size += c.length; if (size > 8192) throw new Error('too long'); chunks.push(c); }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  /** Passes the request on to `target` (a URL) and the answer back, streaming both ways; the caller leaving stops it. */
  function forward(req, res, target, headers) {
    const out = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, up => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    out.on('error', e => { if (!res.headersSent) json(res, 502, { error: `Strata did not answer: ${e.message}` }); else res.destroy(); });
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    req.pipe(out);
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url ?? '/', 'https://remote'); } catch { return refuse(res, 400); }
    const path = url.pathname, method = req.method ?? 'GET';
    const address = addressOf(req);
    const secure = 'Secure; ';
    res.setHeader('strict-transport-security', 'max-age=15552000');

    // Signing in and out in a browser.
    if (path === '/login') {
      if (method === 'GET') return reply(res, 200, LOGIN_PAGE(), { 'content-type': 'text/html; charset=utf-8' });
      if (method !== 'POST') return refuse(res, 405);
      let key = '';
      try { key = String((await readForm(req)).get('password') ?? '').trim(); } catch { return refuse(res, 413); }
      if (!same(key, config.key)) {
        if (failures.blocked(address)) return reply(res, 429, LOGIN_PAGE('<p>Too many attempts. Try again later.</p>'), { 'content-type': 'text/html; charset=utf-8' });
        failures.add(address);
        log(`remote access · wrong key from ${address}`);
        return reply(res, 401, LOGIN_PAGE(failNote), { 'content-type': 'text/html; charset=utf-8' });
      }
      return reply(res, 303, '', { location: '/', 'set-cookie': `${COOKIE}=${sessionValue(config.key)}; Path=/; HttpOnly; ${secure}SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}` });
    }
    if (path === '/logout') return reply(res, 303, '', { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; ${secure}SameSite=Strict; Max-Age=0` });

    // CORS for apps that run in a browser and send the key themselves: the preflight never carries it.
    if (method === 'OPTIONS') {
      return reply(res, 204, '', { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? '') || 'authorization, content-type', 'access-control-max-age': '600' });
    }

    // The right key always works, so a stranger's wrong keys can never lock the owner out; wrong ones are limited.
    const auth = authOf(req, config.key);
    if (!auth) {
      if (failures.blocked(address)) return refuse(res, 429);
      if (req.headers.authorization || req.headers['x-api-key'] || cookieOf(req)) { failures.add(address); log(`remote access · wrong key from ${address}`); }
      const page = method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/v1/') && String(req.headers.accept ?? '').includes('text/html');
      return page ? reply(res, 303, '', { location: '/login' }) : refuse(res, 401);
    }
    // A signed-in browser: a page of another site must not act with its cookie (the cookie is SameSite=Strict as well).
    if (auth === 'cookie' && !['GET', 'HEAD'].includes(method) && req.headers.origin) {
      let origin = null;
      try { origin = new URL(req.headers.origin).host; } catch { /* not a URL */ }
      if (origin !== req.headers.host) return json(res, 403, { error: 'Not allowed from another site.' });
    }

    // Quitting would end the app with no way to start it again from away; that stays on the PC.
    if (path === '/api/app/quit') return json(res, 403, { error: 'Quit Strata on the PC itself.' });

    const headers = { ...req.headers };
    for (const name of ['authorization', 'x-api-key', 'cookie', 'origin', 'referer', 'host', 'x-strata-remote', ...HOP]) delete headers[name];
    headers['x-forwarded-for'] = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '');
    // Tells the host this request came from away, so nothing waits on a window that opens on the PC's screen. Only this listener sets it.
    headers['x-strata-remote'] = '1';
    if (auth === 'key') res.setHeader('access-control-allow-origin', '*');

    if (path === '/v1' || path.startsWith('/v1/')) {
      if (!pinned) return forward(req, res, new URL(`http://127.0.0.1:${localPort}${url.pathname}${url.search}`), { ...headers, host: `127.0.0.1:${localPort}` });
      try { await pinned.ensure(); } catch (e) { return json(res, 503, { error: e.message }); }
      const target = new URL(`${pinned.base}${path.slice(3)}${url.search}`);
      return forward(req, res, target, { ...headers, host: target.host });
    }
    // The host sees what the local app sends: its own address as the origin of a page's request.
    const local = `127.0.0.1:${localPort}`;
    return forward(req, res, new URL(`http://${local}${url.pathname}${url.search}`), { ...headers, host: local, ...(req.headers.origin ? { origin: `http://${local}` } : {}) });
  }

  return {
    async start() {
      if (listener) return;
      const options = { cert: readFileSync(config.cert), key: readFileSync(config.certKey) };
      const handler = (req, res) => { handle(req, res).catch(() => { if (!res.headersSent) refuse(res, 500); else res.destroy(); }); };
      listener = serverFactory ? serverFactory(options, handler) : https.createServer(options, handler);
      // Only the allowed networks may connect: anyone else is cut off before TLS and never reaches the sign-in page.
      listener.on('connection', socket => { if (!allowed(socket.remoteAddress)) socket.destroy(); });
      // Long answers (an agent's turn, an image) stream; the default request timeout would cut them off.
      listener.requestTimeout = 0;
      listener.headersTimeout = 30_000;
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(config.port, config.host, resolve); });
      log(`remote access · https://${config.host === '0.0.0.0' ? '<this PC>' : config.host}:${config.port} (key required; from: ${allow.join(', ')})`);
    },
    async stop() {
      if (!listener) return;
      const current = listener; listener = null;
      current.closeAllConnections?.();
      await new Promise(resolve => current.close(resolve));
    },
    port: () => listener?.address()?.port ?? null,
    handle,
  };
}
