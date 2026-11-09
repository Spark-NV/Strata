// Remote access (server/remote-access.mjs): the whole app behind one key. Apps send the key, a browser signs in once and gets a
// cookie; wrong keys are limited; /v1/* wakes the pinned model; everything else reaches the host as the local app would send it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_FAILS_PER_ADDRESS, addressKind, authOf, createFailures, createRemoteAccess, remoteConfig, sessionValue } from '../server/remote-access.mjs';

const KEY = 'k'.repeat(20) + '0123456789abcdef';

function files(t) {
  const dir = mkdtempSync(join(tmpdir(), 'strata-remote-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'cert.pem'), 'cert');
  writeFileSync(join(dir, 'key.pem'), 'key');
  return dir;
}

test('the config file: off without it, a short key or a missing certificate is refused', t => {
  const dir = files(t);
  const env = { STRATA_REMOTE_CONFIG: join(dir, 'remote.json') };
  const write = o => writeFileSync(env.STRATA_REMOTE_CONFIG, JSON.stringify(o));
  assert.equal(remoteConfig({}), null);
  write({ key: KEY, cert: join(dir, 'cert.pem'), certKey: join(dir, 'key.pem') });
  assert.deepEqual(remoteConfig(env), { file: env.STRATA_REMOTE_CONFIG, key: KEY, port: 8443, host: '0.0.0.0', cert: join(dir, 'cert.pem'), certKey: join(dir, 'key.pem'), failImage: null, allow: ['lan', 'cloudflare'] });
  write({ enabled: false, key: 'x' });
  assert.equal(remoteConfig(env), null);
  write({ key: 'short', cert: join(dir, 'cert.pem'), certKey: join(dir, 'key.pem') });
  assert.throws(() => remoteConfig(env), /at least 32/);
  write({ key: KEY, cert: join(dir, 'missing.pem'), certKey: join(dir, 'key.pem') });
  assert.throws(() => remoteConfig(env), /"cert"/);
  write({ key: KEY, port: 70000, cert: join(dir, 'cert.pem'), certKey: join(dir, 'key.pem') });
  assert.throws(() => remoteConfig(env), /not a port/);
  write({ key: KEY, allow: ['everyone'], cert: join(dir, 'cert.pem'), certKey: join(dir, 'key.pem') });
  assert.throws(() => remoteConfig(env), /"allow"/);
  writeFileSync(env.STRATA_REMOTE_CONFIG, '{ nope');
  assert.throws(() => remoteConfig(env), /JSON/);
});

test('the key: a Bearer header, x-api-key or the sign-in cookie; nothing else', () => {
  assert.equal(authOf({ headers: { authorization: `Bearer ${KEY}` } }, KEY), 'key');
  assert.equal(authOf({ headers: { 'x-api-key': KEY } }, KEY), 'key');
  assert.equal(authOf({ headers: { cookie: `a=1; session=${sessionValue(KEY)}` } }, KEY), 'cookie');
  assert.equal(authOf({ headers: { cookie: `session=${KEY}` } }, KEY), null, 'the cookie is not the key itself');
  assert.equal(authOf({ headers: { authorization: `Bearer ${KEY}x` } }, KEY), null);
  assert.equal(authOf({ headers: {} }, KEY), null);
  assert.notEqual(sessionValue(KEY), sessionValue(KEY + 'x'), 'a new key signs browsers out');
});

test('who may connect: the home network and Cloudflare, nobody else', () => {
  for (const a of ['127.0.0.1', '192.168.1.1', '::ffff:192.168.1.50', '10.2.3.4', '172.20.0.1', '::1', 'fe80::1']) assert.equal(addressKind(a), 'lan', a);
  for (const a of ['172.70.1.2', '104.23.0.9', '162.158.5.5', '2606:4700::1']) assert.equal(addressKind(a), 'cloudflare', a);
  for (const a of ['73.95.149.111', '8.8.8.8', '172.32.0.1', '2001:db8::1', '', undefined, 'nonsense']) assert.equal(addressKind(a), null, String(a));
});

test('wrong keys: ten per address in 15 minutes, then that address waits', () => {
  let t = 0;
  const f = createFailures(() => t);
  for (let i = 0; i < MAX_FAILS_PER_ADDRESS; i++) f.add('a');
  assert.equal(f.blocked('a'), true);
  assert.equal(f.blocked('b'), false);
  t += 15 * 60_000 + 1;
  assert.equal(f.blocked('a'), false);
});

async function rig(t, { pinnedUp = true, allow } = {}) {
  const seen = [];
  const host = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { seen.push({ to: 'host', method: req.method, url: req.url, headers: req.headers, body }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, url: req.url })); });
  });
  const model = http.createServer((req, res) => { seen.push({ to: 'model', url: req.url, headers: req.headers }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); });
  await new Promise(r => host.listen(0, '127.0.0.1', r));
  await new Promise(r => model.listen(0, '127.0.0.1', r));
  let woke = 0;
  const pinned = { base: `http://127.0.0.1:${model.address().port}/v1`, ensure: async () => { woke++; if (!pinnedUp) throw new Error('The model server does not answer.'); } };
  const dir = files(t);
  const logs = [];
  const remote = createRemoteAccess({ config: { key: KEY, port: 0, host: '127.0.0.1', cert: join(dir, 'cert.pem'), certKey: join(dir, 'key.pem'), allow }, localPort: host.address().port, pinned,
    log: l => logs.push(l), serverFactory: (_options, handler) => http.createServer(handler) });
  await remote.start();
  t.after(async () => { await remote.stop(); host.close(); model.close(); });
  const base = `http://127.0.0.1:${remote.port()}`;
  return { base, seen, woke: () => woke, logs };
}

test('an app with the key reaches the host as the local app, with the key and cookies left behind', async t => {
  const { base, seen } = await rig(t);
  const r = await fetch(`${base}/api/chats?x=1`, { headers: { authorization: `Bearer ${KEY}`, 'x-strata-client': 'ios', origin: 'https://sprinkler.example' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, url: '/api/chats?x=1' });
  const h = seen.at(-1).headers;
  assert.equal(h['x-strata-client'], 'ios');
  assert.equal(h.authorization, undefined);
  assert.match(h.host, /^127\.0\.0\.1:\d+$/);
  assert.equal(h.origin, `http://${h.host}`, 'the host sees its own address as the origin');
  assert.equal(h['x-strata-remote'], '1', 'the host knows the request came from away (no folder window on the PC)');
  await fetch(`${base}/api/folders`, { headers: { authorization: `Bearer ${KEY}`, 'x-strata-remote': '0' } });
  assert.equal(seen.at(-1).headers['x-strata-remote'], '1', 'a client cannot say it is local');
  assert.equal((await fetch(`${base}/api/app/quit`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'x-strata-client': 'ios' } })).status, 403, 'the app is not quit from away');
  const post = await fetch(`${base}/api/images/generate`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: '{"prompt":"a cat"}' });
  assert.equal(post.status, 200);
  assert.equal(seen.at(-1).body, '{"prompt":"a cat"}');
});

test('without the key: API calls get 401, a browser is sent to sign in, and signing in sets the cookie', async t => {
  const { base, seen } = await rig(t);
  assert.equal((await fetch(`${base}/api/chats`)).status, 401);
  const page = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/login');
  assert.match(await (await fetch(`${base}/login`)).text(), /<title>Login<\/title>/);
  const wrong = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ password: 'nope' }), redirect: 'manual' });
  assert.equal(wrong.status, 401);
  const right = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ password: KEY }), redirect: 'manual' });
  assert.equal(right.status, 303);
  const cookie = right.headers.get('set-cookie');
  assert.match(cookie, /^session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  const value = cookie.split(';')[0];
  assert.equal((await fetch(`${base}/`, { headers: { cookie: value } })).status, 200);
  assert.equal(seen.at(-1).headers.cookie, undefined, 'the sign-in cookie stays here');
  const host = new URL(base).host;
  assert.equal((await fetch(`${base}/api/chats/a`, { method: 'POST', headers: { cookie: value, origin: `http://${host}` }, body: '{}' })).status, 200);
  assert.equal((await fetch(`${base}/api/chats/a`, { method: 'POST', headers: { cookie: value, origin: 'https://evil.example' }, body: '{}' })).status, 403, 'another site cannot use the cookie');
});

test('a stranger learns nothing: the page, the refusals and the headers never name the app', async t => {
  const { base } = await rig(t);
  const answers = [
    await fetch(`${base}/login`), await fetch(`${base}/api/chats`), await fetch(`${base}/v1/models`), await fetch(`${base}/favicon.ico`),
    await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ password: 'nope' }) }), await fetch(`${base}/login`, { method: 'PUT' }),
    await fetch(`${base}/api/chats`, { method: 'OPTIONS' }), await fetch(`${base}/logout`, { redirect: 'manual' }),
    await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' }),
  ];
  for (const r of answers) {
    const text = `${[...r.headers].map(h => h.join(': ')).join('\n')}\n${await r.text()}`;
    assert.doesNotMatch(text, /strata|remote|\bkey\b|bearer|\bapi\b|model|qwen|token/i, `${r.url} ${r.status}:\n${text}`);
  }
  const page = await (await fetch(`${base}/login`)).text();
  assert.match(page, /<title>Login<\/title>/);
  assert.doesNotMatch(page, /<h1|<label|Password/, 'only a box and a button');
  assert.match(page, /<input name="password" type="password"[^>]*><button type="submit">Login<\/button>/);
});

test('a wrong password shows the picture the config names, inline', async t => {
  const dir = files(t);
  writeFileSync(join(dir, 'no.webp'), 'RIFFpicture');
  const remote = createRemoteAccess({ config: { key: KEY, port: 0, host: '127.0.0.1', cert: join(dir, 'cert.pem'), certKey: join(dir, 'key.pem'), failImage: join(dir, 'no.webp') },
    localPort: 1, log: () => {}, serverFactory: (_o, h) => http.createServer(h) });
  await remote.start();
  t.after(() => remote.stop());
  const page = await (await fetch(`http://127.0.0.1:${remote.port()}/login`, { method: 'POST', body: new URLSearchParams({ password: 'nope' }) })).text();
  assert.match(page, new RegExp(`<img src="data:image/webp;base64,${Buffer.from('RIFFpicture').toString('base64')}"`));
  assert.match(page, /magic word/);
  const env = { STRATA_REMOTE_CONFIG: join(dir, 'remote.json') };
  writeFileSync(env.STRATA_REMOTE_CONFIG, JSON.stringify({ key: KEY, cert: join(dir, 'cert.pem'), certKey: join(dir, 'key.pem'), failImage: join(dir, 'missing.webp') }));
  assert.throws(() => remoteConfig(env), /"failImage"/);
});

test('too many wrong keys from one address are refused; the right key still works, so nobody can lock the owner out', async t => {
  const { base, logs } = await rig(t);
  for (let i = 0; i < MAX_FAILS_PER_ADDRESS; i++) assert.equal((await fetch(`${base}/api/chats`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/api/chats`, { headers: { authorization: 'Bearer wrong' } })).status, 429);
  assert.equal((await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ password: 'nope' }) })).status, 429);
  assert.equal((await fetch(`${base}/api/chats`, { headers: { authorization: `Bearer ${KEY}` } })).status, 200);
  assert.equal((await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ password: KEY }), redirect: 'manual' })).status, 303);
  assert.ok(logs.some(l => l.includes('wrong key')));
});

test('a made-up CF-Connecting-IP from outside Cloudflare does not give a fresh count of tries', async t => {
  const { base } = await rig(t);
  for (let i = 0; i < MAX_FAILS_PER_ADDRESS; i++) await fetch(`${base}/api/chats`, { headers: { authorization: 'Bearer wrong', 'cf-connecting-ip': `9.9.9.${i}` } });
  assert.equal((await fetch(`${base}/api/chats`, { headers: { authorization: 'Bearer wrong', 'cf-connecting-ip': '9.9.9.200' } })).status, 429);
});

test('a connection from outside the allowed networks is closed before anything is read', async t => {
  const { base, seen } = await rig(t, { allow: ['cloudflare'] });
  await assert.rejects(fetch(`${base}/login`));
  await assert.rejects(fetch(`${base}/api/chats`, { headers: { authorization: `Bearer ${KEY}` } }));
  assert.equal(seen.length, 0);
});

test('connection headers and smuggling attempts are not passed on', async t => {
  const { base, seen } = await rig(t);
  const r = await fetch(`${base}/api/chats`, { headers: { authorization: `Bearer ${KEY}`, 'x-strata-client': 'ios', te: 'trailers', 'proxy-authorization': 'x' } });
  assert.equal(r.status, 200);
  const h = seen.at(-1).headers;
  for (const name of ['te', 'proxy-authorization']) assert.equal(h[name], undefined, name);
  for (const p of ['/api//app/quit', '/API/app/quit', '/api/app/quit/', '/v1/../api/app/quit', '/v1/%2e%2e/api/app/quit']) {
    const q = await fetch(`${base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` } });
    if (q.status === 200) assert.notEqual(seen.at(-1).url, '/api/app/quit', p);
  }
  assert.ok(!seen.some(x => x.url === '/api/app/quit'), 'quit never reaches the host');
});

test('/v1 wakes the pinned model and reaches it; a model that cannot start is a 503', async t => {
  const { base, seen, woke } = await rig(t);
  const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(r.status, 200);
  assert.equal(woke(), 1);
  assert.equal(seen.at(-1).to, 'model');
  assert.equal(seen.at(-1).url, '/v1/models');
  assert.equal(seen.at(-1).headers.authorization, undefined);
  const down = await rig(t, { pinnedUp: false });
  const d = await fetch(`${down.base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: '{}' });
  assert.equal(d.status, 503);
  assert.match((await d.json()).error, /does not answer/);
});
