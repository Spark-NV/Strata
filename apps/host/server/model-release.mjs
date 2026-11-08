/**
 * Gives the pinned model's memory back when it is not wanted, so the GPU and RAM are free for games; pinned-model.mjs starts it again
 * when a chat needs it (a message sent, or typing in the message box).
 *
 *   game  A game starting releases the model at once, even in the middle of a turn: the game comes first. Only a game that starts
 *         while the app watches counts, so a chat sent while a game runs starts the model and keeps it until it is idle.
 *         STRATA_PIN_GAME_RELEASE=0 turns this off; STRATA_PIN_GAMES adds process names (comma separated) that count as games.
 *   idle  No model work for STRATA_PIN_IDLE_MIN minutes (default 30, 0 turns it off): nothing generating or queued on the model
 *         server (so requests from other apps count too), no agent turn in the app, no chat sent through the app.
 *
 * A game is a Steam launch (the `reaper SteamLaunch AppId=…` process every Steam game runs under, Proton or native), a Lutris game
 * (`lutris-wrapper`), a Proton game started through umu (Heroic, Lutris, Faugus), gamescope, or a named process.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function releaseConfig(env = process.env) {
  const minutes = Number(env.STRATA_PIN_IDLE_MIN ?? 30);
  return {
    idleMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0,
    gameRelease: String(env.STRATA_PIN_GAME_RELEASE ?? '1') !== '0',
    extraGames: String(env.STRATA_PIN_GAMES ?? '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

const RUNTIME_DIR = /^(SteamLinuxRuntime|Proton|Steamworks Shared|Steam Controller Configs)/;
/** The game a process belongs to, from its arguments and its name (`comm`), or null. */
export function gameOf(argv, comm, extra = []) {
  const line = argv.join(' ');
  const steam = /\bSteamLaunch\b.*?\bAppId=(\d+)/.exec(line);
  if (steam) {
    if (steam[1] === '0') return null;
    const dir = argv.map(a => /steamapps\/common\/([^/]+)/.exec(a)?.[1]).find(d => d && !RUNTIME_DIR.test(d));
    return { id: `steam:${steam[1]}`, name: dir ?? `Steam game ${steam[1]}` };
  }
  const lutris = /^lutris-wrapper:?\s*(.*)$/.exec(line);
  if (lutris) return { id: `lutris:${lutris[1]}`, name: lutris[1] || 'Lutris game' };
  if (comm === 'umu-run' || /(^|\/)umu-run$/.test(argv[0] ?? '') || /(^|\/)umu-run$/.test(argv[1] ?? '')) {
    const exe = argv.map(a => /([^/\\]+)\.exe$/i.exec(a)?.[1]).find(Boolean);
    return { id: `umu:${exe ?? 'game'}`, name: exe ?? 'Proton game' };
  }
  if (comm === 'gamescope' || comm === 'gamescope-wl') return { id: 'gamescope', name: 'gamescope' };
  if (extra.includes(comm)) return { id: `process:${comm}`, name: comm };
  return null;
}

/** The games running now as a Map id -> name, from this user's processes in /proc. */
export function scanGames({ proc = '/proc', uid = process.getuid?.(), extra = [] } = {}) {
  const found = new Map();
  let pids;
  try { pids = readdirSync(proc).filter(p => /^\d+$/.test(p)); } catch { return found; }
  for (const pid of pids) {
    try {
      if (uid != null && statSync(join(proc, pid)).uid !== uid) continue;
      const argv = readFileSync(join(proc, pid, 'cmdline')).toString().split('\0').filter(Boolean);
      const comm = readFileSync(join(proc, pid, 'comm'), 'utf8').trim();
      const game = gameOf(argv, comm, extra);
      if (game && !found.has(game.id)) found.set(game.id, game.name);
    } catch { /* the process ended while it was read */ }
  }
  return found;
}

const MISSES_DOWN = 3;
const DAY = 24 * 60 * 60_000;
const KEEP_MS = 8 * DAY;

/**
 * When the model came up and when it stopped, and why, kept in a small file so the Monitor can show how long it ran and how long it was
 * stopped while idle or for games. Events: { at, up: true } or { at, up: false, reason: 'idle' | 'game' | 'other', detail }. 'other' is a
 * stop the app did not make (systemctl, the Terminal, a crash) or one it did not see (the app was closed). Older than 8 days is dropped,
 * except the last event before that, which says what the state was then.
 */
export function createActivityLog({ file = null, now = Date.now } = {}) {
  let events = [];
  if (file) {
    try { events = JSON.parse(readFileSync(file, 'utf8')).events.filter(e => Number.isFinite(e?.at) && typeof e.up === 'boolean'); } catch { events = []; }
  }
  const save = () => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ events }));
      renameSync(`${file}.tmp`, file);
    } catch { /* the log is a convenience; the watch goes on without it */ }
  };
  function add(event) {
    const last = events.at(-1);
    if (last && last.up === event.up) return;
    events.push(event);
    const cutoff = now() - KEEP_MS;
    const firstKept = events.findIndex(e => e.at >= cutoff);
    if (firstKept > 1) events = events.slice(firstKept - 1);
    save();
  }
  /** How long it ran and how long it was stopped (by reason) in [from, to], in ms. Time before the first event is not counted. */
  function totals(from, to = now()) {
    const out = { running: 0, idle: 0, game: 0, other: 0 };
    events.forEach((e, i) => {
      const start = Math.max(e.at, from), end = Math.min(events[i + 1]?.at ?? to, to);
      if (end <= start) return;
      out[e.up ? 'running' : (out[e.reason] !== undefined ? e.reason : 'other')] += end - start;
    });
    return out;
  }
  return {
    up: (at = now()) => add({ at, up: true }),
    down: (reason = 'other', detail = null, at = now()) => add({ at, up: false, reason, detail }),
    /** The state now: since when, and for a stop why. */
    current: () => { const e = events.at(-1); return e ? { up: e.up, since: e.at, reason: e.up ? null : e.reason, detail: e.up ? null : e.detail ?? null } : null; },
    totals,
    events: () => events.slice(),
  };
}

/**
 * The watcher. `tick()` runs every few seconds: `games()` gives the games running now, `metrics()` the model server's /metrics (null
 * when it does not answer), `agentBusy()` whether an agent turn is running in the app.
 */
export function createModelReleaser({ pinned, idleMs, gameRelease, games, metrics, agentBusy = () => false, now = Date.now, activity = createActivityLog({ now }), log = () => {} }) {
  let known = new Set(gameRelease ? games().keys() : []);   // the games seen; those running when the watch began are not "starting"
  let lastActive = 0;      // the last time the model did or was asked for work, in ms
  let up = false;
  let busy = false;        // working at the last look: generating, queued or an agent turn
  let missed = 0;          // looks in a row the model did not answer while the app has it as ready
  let ticking = false;

  async function tick() {
    if (ticking) return null;
    ticking = true;
    try {
      // A game counts as seen only once the model answered, or is known to be down: a game launched while the model starts, stops or
      // is slow to answer is still caught when it answers. A game seen while the model is down is not new any more, so a chat that
      // starts the model while the game runs keeps it.
      const phase = pinned.state().phase;
      if (phase === 'starting' || phase === 'stopping') return null;
      const current = gameRelease ? games() : new Map();
      const started = [...current].filter(([id]) => !known.has(id));
      const m = await metrics();
      if (!m) {
        // Ready but not answering: slow (a busy server) for a few looks, then taken as down (it crashed, or was stopped outside the app).
        missed = phase === 'ready' ? missed + 1 : MISSES_DOWN;
        if (missed >= MISSES_DOWN) {
          known = new Set(current.keys());
          if (up || !activity.current() || activity.current().up) activity.down('other');
          up = false; busy = false;
        }
        return null;
      }
      missed = 0;
      known = new Set(current.keys());
      if (!up) { up = true; lastActive = now(); activity.up(); }
      const stop = async (reason, detail) => {
        if (!(await pinned.release(reason, detail))) return null;
        up = false; busy = false;
        activity.down(reason, detail);
        return reason;
      };
      if (started.length) {
        log(`model release ·  game started: ${started.map(([, name]) => name).join(', ')}`);
        return stop('game', started[0][1]);
      }
      // Up while the app thinks it is released or broken: someone started it (the Terminal, systemctl). Take it back as ready.
      if (phase !== 'ready') { await pinned.ensure().catch(() => {}); return null; }
      const live = m.live ?? {};
      busy = (live.state && live.state !== 'idle') || Number(live.queued) > 0 || agentBusy();
      if (busy) lastActive = now();
      for (const r of m.requests ?? []) {
        const end = (Number(r.time) + (Number(r.duration_s) || 0)) * 1000;
        if (Number.isFinite(end) && end > lastActive) lastActive = end;
      }
      lastActive = Math.max(lastActive, pinned.usedAt());
      if (idleMs > 0 && now() - lastActive >= idleMs) {
        const minutes = Math.round(idleMs / 60_000);
        return stop('idle', `${minutes} min`);
      }
      return null;
    } finally { ticking = false; }
  }
  return {
    tick,
    /**
     * For the Monitor: running or stopped and since when (why, for a stop), how long it has had no work (null while working or stopped),
     * the idle limit, and how long it ran and was stopped today and in the last 7 days.
     */
    status() {
      const t = now(), midnight = new Date(t).setHours(0, 0, 0, 0);
      return {
        current: activity.current(),
        working: up && busy,
        idleMs: up && !busy ? Math.max(0, t - lastActive) : null,
        idleLimitMs: idleMs,
        today: activity.totals(midnight, t),
        week: activity.totals(t - 7 * DAY, t),
      };
    },
    /** Starts the watch; returns a function that stops it. */
    start(everyMs = 3000) {
      const timer = setInterval(() => { void tick().catch(e => log(`model release ·  ${e.message}`)); }, everyMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
