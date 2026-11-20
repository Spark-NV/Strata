// Releasing the pinned model (server/model-release.mjs, server/pinned-model.mjs): a game starting stops it at once, 30 minutes with no
// model work stop it, anything working keeps it, and the next chat starts it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivityLog, createGameWatch, createModelReleaser, gameOf, IDLE_BY_HAND, releaseConfig, scanGames } from '../server/model-release.mjs';
import { readFileSync } from 'node:fs';
import { createPinnedModel } from '../server/pinned-model.mjs';

const STEAM = ['/home/u/.local/share/Steam/ubuntu12_32/reaper', 'SteamLaunch', 'AppId=1091500', '--', '/home/u/.local/share/Steam/steamapps/common/SteamLinuxRuntime_sniper/_v2-entry-point', '--verb=waitforexitandrun', '--', '/home/u/.local/share/Steam/steamapps/common/Proton 9.0 (Beta)/proton', 'waitforexitandrun', '/home/u/.local/share/Steam/steamapps/common/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe'];

test('games are found by how they start, and other programs are not games', () => {
  assert.deepEqual(gameOf(STEAM, 'reaper'), { id: 'steam:1091500', name: 'Cyberpunk 2077' });
  assert.deepEqual(gameOf(['/x/reaper', 'SteamLaunch', 'AppId=570', '--', '/x/steamapps/common/dota 2 beta/game/dota.sh'], 'reaper'), { id: 'steam:570', name: 'dota 2 beta' });
  assert.equal(gameOf(['/x/reaper', 'SteamLaunch', 'AppId=0', '--', 'tool'], 'reaper'), null);
  assert.deepEqual(gameOf(['lutris-wrapper: Diablo IV'], 'lutris-wrapper'), { id: 'lutris:Diablo IV', name: 'Diablo IV' });
  assert.deepEqual(gameOf(['python3', '/usr/bin/umu-run', '/games/Witcher3/bin/witcher3.exe'], 'umu-run'), { id: 'umu:witcher3', name: 'witcher3' });
  assert.deepEqual(gameOf(['gamescope', '-W', '2560', '--', 'game'], 'gamescope'), { id: 'gamescope', name: 'gamescope' });
  assert.deepEqual(gameOf(['/opt/minecraft/java'], 'java', ['java']), { id: 'process:java', name: 'java' });
  for (const [argv, comm] of [[['/home/u/.local/share/Steam/ubuntu12_32/steam', '-silent'], 'steam'], [['./steamwebhelper', '-lang=en_US'], 'steamwebhelp'], [['/usr/bin/kwin_wayland'], 'kwin_wayland'], [['node', 'server.mjs'], 'node']]) assert.equal(gameOf(argv, comm), null, comm);
});

test('the scan reads this user\'s processes and skips ones that vanish', () => {
  const proc = mkdtempSync(join(tmpdir(), 'strata-proc-'));
  try {
    const add = (pid, argv, comm) => { mkdirSync(join(proc, pid)); writeFileSync(join(proc, pid, 'cmdline'), argv.join('\0') + '\0'); writeFileSync(join(proc, pid, 'comm'), comm + '\n'); };
    add('100', STEAM, 'reaper');
    add('101', ['/x/Cyberpunk2077.exe'], 'Cyberpunk2077.e');
    add('102', ['node'], 'node');
    mkdirSync(join(proc, '103'));          // ended between the listing and the read
    mkdirSync(join(proc, 'self'));
    assert.deepEqual([...scanGames({ proc, uid: null })], [['steam:1091500', 'Cyberpunk 2077']]);
  } finally { rmSync(proc, { recursive: true, force: true }); }
});

test('settings: 30 minutes and game release by default, both can be turned off', () => {
  assert.deepEqual(releaseConfig({}), { idleMs: 30 * 60_000, gameRelease: true, extraGames: [] });
  assert.deepEqual(releaseConfig({ STRATA_PIN_IDLE_MIN: '0', STRATA_PIN_GAME_RELEASE: '0', STRATA_PIN_GAMES: 'java, hl2_linux' }), { idleMs: 0, gameRelease: false, extraGames: ['java', 'hl2_linux'] });
});

/** A pinned model stand-in: its phase, and the releases asked of it. */
function fakePinned(phase = 'ready') {
  const p = { phase, released: [], ensured: 0, used: 0 };
  return Object.assign(p, {
    state: () => ({ phase: p.phase }),
    usedAt: () => p.used,
    async release(reason, detail) { p.released.push([reason, detail]); p.phase = 'released'; return true; },
    async ensure() { p.ensured += 1; p.phase = 'ready'; },
  });
}
const idleMetrics = (requests = []) => ({ live: { state: 'idle', queued: 0 }, requests });

test('a game that starts releases the model at once; one already running when the app started does not', async () => {
  let games = new Map([['steam:1', 'Old game']]);
  const pinned = fakePinned();
  const r = createModelReleaser({ pinned, idleMs: 30 * 60_000, gameRelease: true, games: () => games, metrics: async () => idleMetrics() });
  assert.equal(await r.tick(), null, 'the game was there before the watch: not starting');
  games = new Map([['steam:1', 'Old game'], ['steam:2', 'Elden Ring']]);
  assert.equal(await r.tick(), 'game');
  assert.deepEqual(pinned.released, [['game', 'Elden Ring']]);
});

test('a chat started while a game runs keeps the model: only a newly started game releases it', async () => {
  const games = new Map([['steam:2', 'Elden Ring']]);
  const pinned = fakePinned('released');
  let up = false;
  const r = createModelReleaser({ pinned, idleMs: 30 * 60_000, gameRelease: true, games: () => games, metrics: async () => (up ? idleMetrics() : null) });
  await r.tick();
  up = true; pinned.phase = 'ready';   // the person sent a message, the model started
  assert.equal(await r.tick(), null);
  assert.deepEqual(pinned.released, []);
});

test('30 minutes idle releases it; generating, queued, an agent turn, a chat or a request from another app keep it', async () => {
  let t = 1_000_000_000_000, metrics = idleMetrics(), busy = false;
  const pinned = fakePinned();
  const r = createModelReleaser({ pinned, idleMs: 30 * 60_000, gameRelease: false, games: () => new Map(), metrics: async () => metrics, agentBusy: () => busy, now: () => t });
  await r.tick();                                  // first seen up: the clock starts now
  t += 29 * 60_000; assert.equal(await r.tick(), null);
  metrics = { live: { state: 'generating', queued: 0 }, requests: [] }; assert.equal(await r.tick(), null);
  metrics = idleMetrics(); t += 29 * 60_000; assert.equal(await r.tick(), null, '29 minutes after generating');
  metrics = { live: { state: 'idle', queued: 1 }, requests: [] }; assert.equal(await r.tick(), null);
  metrics = idleMetrics(); busy = true; t += 31 * 60_000; assert.equal(await r.tick(), null, 'an agent turn runs (a long command, the model waits)');
  busy = false; t += 29 * 60_000; assert.equal(await r.tick(), null);
  metrics = idleMetrics([{ time: (t - 60_000) / 1000, duration_s: 30 }]); t += 20 * 60_000; assert.equal(await r.tick(), null, 'another app asked 21 minutes ago');
  pinned.used = t; t += 29 * 60_000; assert.equal(await r.tick(), null, 'a chat 29 minutes ago');
  t += 60_000; assert.equal(await r.tick(), 'idle');
  assert.deepEqual(pinned.released, [['idle', '30 min']]);
});

test('started from outside while released (the Terminal, systemctl): taken back as ready, not stopped again', async () => {
  const pinned = fakePinned('released');
  const r = createModelReleaser({ pinned, idleMs: 30 * 60_000, gameRelease: true, games: () => new Map(), metrics: async () => idleMetrics() });
  await r.tick();
  assert.equal(pinned.ensured, 1);
  assert.equal(pinned.phase, 'ready');
  assert.deepEqual(pinned.released, []);
});

test('nothing happens while the model is starting or stopping, or when it does not answer', async () => {
  for (const phase of ['starting', 'stopping']) {
    const pinned = fakePinned(phase);
    let asked = 0;
    const r = createModelReleaser({ pinned, idleMs: 1, gameRelease: true, games: () => new Map(), metrics: async () => { asked += 1; return idleMetrics(); } });
    assert.equal(await r.tick(), null); assert.equal(asked, 0, phase);
  }
  const pinned = fakePinned();
  const r = createModelReleaser({ pinned, idleMs: 1, gameRelease: true, games: () => new Map(), metrics: async () => null });
  assert.equal(await r.tick(), null);
  assert.deepEqual(pinned.released, []);
});

test('the pinned model: release stops the service and says why; the next chat starts it again', async (t) => {
  let running = true;
  const server = http.createServer((req, res) => {
    if (!running) { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/health' ? '{"status":"ok"}' : JSON.stringify({ data: [{ id: 'm', meta: { n_ctx: 32768 } }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const calls = [];
  const systemctl = async (verb, unit) => { calls.push(`${verb} ${unit}`); running = verb === 'start'; return null; };
  const saved = [];
  const modelProviders = { list: () => ({ connections: saved }), save: c => { saved.splice(0, saved.length, { id: 'c1', ...c }); return { connections: saved }; } };
  const pinned = createPinnedModel({ config: { base: `http://127.0.0.1:${server.address().port}/v1`, service: 'model.service', name: null }, modelProviders, log: () => {}, systemctl });
  await pinned.ensure();
  assert.equal(pinned.state().phase, 'ready');
  assert.deepEqual(calls, [], 'already running: not started');
  assert.ok(pinned.usedAt() > 0);
  assert.equal(await pinned.release('game', 'Elden Ring'), true);
  assert.equal(pinned.state().phase, 'released');
  assert.deepEqual({ reason: pinned.state().released.reason, detail: pinned.state().released.detail }, { reason: 'game', detail: 'Elden Ring' });
  assert.deepEqual(calls, ['stop model.service']);
  await pinned.ensure();
  assert.deepEqual(calls, ['stop model.service', 'start model.service']);
  assert.equal(pinned.state().phase, 'ready');
  assert.equal(pinned.state().released, null);
});

test('a release is refused while the model is starting, and a chat sent during a release waits for it and starts it again', async () => {
  let running = false, release;
  const order = [];
  const systemctl = (verb) => { order.push(verb); if (verb === 'stop') return new Promise(r => { release = () => { running = false; r(null); }; }); running = true; return Promise.resolve(null); };
  const fetchImpl = async (url) => {
    if (!running) throw new Error('refused');
    return { ok: true, json: async () => ({ data: [{ id: 'm' }] }) };
  };
  const modelProviders = { list: () => ({ connections: [{ id: 'c1', kind: 'custom', baseUrl: 'http://x/v1', name: 'm', models: [{ id: 'm', contextMax: null }] }] }), save: () => modelProviders.list() };
  const pinned = createPinnedModel({ config: { base: 'http://x/v1', service: 's', name: null }, modelProviders, log: () => {}, fetchImpl, systemctl });
  const starting = pinned.ensure();
  assert.equal(await pinned.release('idle', '30 min'), false, 'starting: not released');
  await starting;
  const stopping = pinned.release('idle', '30 min');
  const chat = pinned.ensure();
  release();
  await stopping; await chat;
  assert.deepEqual(order, ['start', 'stop', 'start']);
  assert.equal(pinned.state().phase, 'ready');
});

test('a game launched while the model starts, or while it is slow to answer, is still caught once it answers', async () => {
  let games = new Map(), answers = true;
  const pinned = fakePinned();
  const r = createModelReleaser({ pinned, idleMs: 0, gameRelease: true, games: () => games, metrics: async () => (answers ? idleMetrics() : null) });
  await r.tick();
  pinned.phase = 'starting'; games = new Map([['steam:3', 'Hades']]);
  assert.equal(await r.tick(), null);
  pinned.phase = 'ready'; answers = false;          // up, but /metrics is slow right after loading
  assert.equal(await r.tick(), null);
  assert.equal(await r.tick(), null);
  answers = true;
  assert.equal(await r.tick(), 'game');
  assert.deepEqual(pinned.released, [['game', 'Hades']]);
});

test('a model that stopped answering for good (it crashed) is taken as down: a game seen then does not release the next start', async () => {
  let answers = true;
  const games = new Map();
  const pinned = fakePinned();
  const r = createModelReleaser({ pinned, idleMs: 0, gameRelease: true, games: () => games, metrics: async () => (answers ? idleMetrics() : null) });
  await r.tick();
  answers = false; games.set('steam:4', 'Hollow Knight');
  for (let i = 0; i < 3; i++) await r.tick();
  answers = true;                                     // the person sent a message, the model started again
  assert.equal(await r.tick(), null);
  assert.deepEqual(pinned.released, []);
});

test('the app starts the model and a game launches before it is up: released once it is up', async () => {
  let games = new Map();
  const pinned = fakePinned('starting');
  const r = createModelReleaser({ pinned, idleMs: 0, gameRelease: true, games: () => games, metrics: async () => idleMetrics() });
  assert.equal(await r.tick(), null);
  games = new Map([['steam:5', 'Celeste']]);
  assert.equal(await r.tick(), null);
  pinned.phase = 'ready';
  assert.equal(await r.tick(), 'game');
});

test('the activity log: time running and stopped by reason, kept in a file across app starts, old days dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strata-activity-'));
  try {
    const file = join(dir, 'model-activity.json');
    const H = 60 * 60_000, D = 24 * H;
    let t = 1_000 * D;
    const log = createActivityLog({ file, now: () => t });
    assert.equal(log.current(), null);
    log.up(); t += 2 * H;
    log.down('idle', '30 min'); t += H;
    log.up(); log.up(); t += H;                      // a repeated state is one event
    log.down('game', 'Elden Ring'); t += 3 * H;
    log.down('other');                               // already stopped: not a new event
    assert.deepEqual(log.totals(1_000 * D), { running: 3 * H, idle: H, game: 3 * H, image: 0, other: 0 });
    assert.deepEqual(log.current(), { up: false, since: 1_000 * D + 4 * H, reason: 'game', detail: 'Elden Ring' });
    const again = createActivityLog({ file, now: () => t });
    assert.deepEqual(again.totals(1_000 * D), log.totals(1_000 * D), 'read back from the file');
    t += 10 * D; again.up();
    assert.deepEqual(again.events().map(e => e.up), [false, true], 'older than 8 days dropped, but the state before the window is kept');
    assert.equal(again.totals(t - 7 * D).game, 7 * D, 'the last 7 days of the stop still count as stopped for the game');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status for the Monitor: idle time while up and not working, none while working or stopped; stops are logged with their reason', async () => {
  let t = 1_000_000_000_000, metrics = idleMetrics();
  const pinned = fakePinned();
  const activity = createActivityLog({ now: () => t });
  const r = createModelReleaser({ pinned, idleMs: 30 * 60_000, gameRelease: false, games: () => new Map(), metrics: async () => metrics, now: () => t, activity });
  await r.tick();
  t += 10 * 60_000; await r.tick();
  assert.equal(r.status().idleMs, 10 * 60_000);
  assert.equal(r.status().idleLimitMs, 30 * 60_000);
  assert.equal(r.status().current.up, true);
  metrics = { live: { state: 'generating', queued: 0 }, requests: [] }; await r.tick();
  assert.equal(r.status().idleMs, null); assert.equal(r.status().working, true);
  metrics = idleMetrics(); t += 30 * 60_000; await r.tick();
  assert.deepEqual(pinned.released, [['idle', '30 min']]);
  const s = r.status();
  assert.deepEqual([s.current.up, s.current.reason, s.idleMs], [false, 'idle', null]);
  assert.equal(s.today.running + s.today.idle >= 0, true);
  assert.equal(s.week.running, 40 * 60_000);
});

test('a stop the app did not make (systemctl, a crash) is logged as other after a few looks', async () => {
  let answers = true;
  const pinned = fakePinned();
  const activity = createActivityLog();
  const r = createModelReleaser({ pinned, idleMs: 0, gameRelease: false, games: () => new Map(), metrics: async () => (answers ? idleMetrics() : null), activity });
  await r.tick();
  answers = false;
  await r.tick(); await r.tick();
  assert.equal(activity.current().up, true, 'slow for two looks: still up');
  await r.tick();
  assert.deepEqual([activity.current().up, activity.current().reason], [false, 'other']);
});

test('"Idle now" is the same idle stop at once, logged as idle, and the next chat starts the model again', async () => {
  let t = 1_000_000_000_000;
  const pinned = fakePinned();
  const activity = createActivityLog({ now: () => t });
  const r = createModelReleaser({ pinned, idleMs: 30 * 60_000, gameRelease: false, games: () => new Map(), metrics: async () => (pinned.phase === 'ready' ? idleMetrics() : null), activity, now: () => t });
  await r.tick();
  t += 60_000;                                     // one minute of use, far from the 30
  assert.equal(await r.idleNow(), 'idle');
  assert.deepEqual(pinned.released, [['idle', IDLE_BY_HAND]]);
  assert.deepEqual(activity.current(), { up: false, since: t, reason: 'idle', detail: IDLE_BY_HAND });
  assert.equal(await r.idleNow(), null, 'a stopped model is left as it is');
  for (const phase of ['starting', 'stopping', 'error']) { pinned.phase = phase; assert.equal(await r.idleNow(), null, phase); }
  pinned.phase = 'released';
  await pinned.ensure();                           // a chat, or typing (wakePinned -> /api/pinned/start)
  t += 5_000;
  await r.tick();
  assert.equal(activity.current().up, true);
  assert.equal(pinned.released.length, 1);
});

test('the status chip opens a menu that idles the pinned model through the same release, and typing wakes it as after any idle', () => {
  const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const bar = read('src/app/Sidebar.tsx'), store = read('src/lib/store.ts'), index = read('server/index.mjs');
  assert.match(bar, /className="enginechip"[^>]*aria-haspopup=\{pinned\?\.enabled && !imageActive \? 'dialog' : undefined\}/);
  assert.match(bar, /if \(pinned\?\.enabled && !imageActive\) \{ setIdleError\(null\); setModelMenu\(true\); \} else go\(/, 'without a pinned model the chip still opens Models');
  assert.match(bar, /<Dialog open=\{modelMenu && !!pinned\?\.enabled\}/);
  assert.match(bar, /disabled=\{pinned\?\.phase !== 'ready' \|\| idling\}/, 'only a running model can be idled');
  assert.match(bar, /pinned\?\.phase === 'released' \? <Btn variant="primary" onClick=\{\(\) => \{ startPinned\(\);/);
  assert.match(store, /api\.post<PinnedModelState>\('\/api\/pinned\/idle'/);
  assert.match(index, /path === '\/api\/pinned\/idle' && method === 'POST'[\s\S]{0,400}releaser\.idleNow\(\)/, 'the route calls the releaser, not a stop of its own');
  // The released state is the one wakePinned() starts again when the person types.
  assert.match(store, /export function wakePinned\(\) \{\n  const p = state\.pinned;\n  if \(!p\?\.enabled \|\| p\.phase !== 'released'/);
  assert.equal(read('src/lib/store.ts').includes(`IDLE_BY_HAND = '${IDLE_BY_HAND}'`), true, 'the web UI and the host agree on the marker');
});

test('game release can be turned off: no game stops the model, the choice is kept, and games running when it is turned on again do not count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'strata-gamewatch-'));
  try {
    const file = join(dir, 'game-release.json');
    let running = new Map();
    const watch = createGameWatch({ scan: () => new Map(running), file });
    const pinned = fakePinned();
    const r = createModelReleaser({ pinned, idleMs: 30 * 60_000, gameRelease: true, games: () => watch.games(), metrics: async () => idleMetrics() });
    await r.tick();
    assert.deepEqual(watch.set(false), { allowed: true, enabled: false });
    running = new Map([['steam:1', 'Modded game']]);   // the agent launches the game it works on
    assert.equal(await r.tick(), null);
    assert.deepEqual(pinned.released, []);
    assert.equal(createGameWatch({ scan: () => running, file }).state().enabled, false, 'still off after an app restart');
    watch.set(true);                                      // turned on while that game runs: it is not "starting"
    assert.equal(await r.tick(), null);
    running = new Map([['steam:1', 'Modded game'], ['steam:2', 'Another game']]);
    assert.equal(await r.tick(), 'game');
    assert.deepEqual(pinned.released, [['game', 'Another game']]);
    running = new Map();                                  // the hidden game ends; launched again later, it counts
    watch.games();
    running = new Map([['steam:1', 'Modded game']]);
    assert.deepEqual([...watch.games().keys()], ['steam:1']);
    assert.deepEqual(createGameWatch({ scan: () => running, allowed: false }).set(true), { allowed: false, enabled: false }, 'STRATA_PIN_GAME_RELEASE=0 keeps it off');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the status menu has the game release switch, kept by the host', () => {
  const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const bar = read('src/app/Sidebar.tsx'), index = read('server/index.mjs');
  assert.match(bar, /role="switch" aria-label=\{tr\("Stop the model when a game starts"\)\} aria-checked=\{gameRelease\.enabled\}/);
  assert.match(index, /const runningGames = \(\) => gameWatch\.games\(\);/, 'the pinned and the image model both read the switch');
  assert.match(index, /path === '\/api\/pinned\/game-release' && method === 'PUT'/);
});
