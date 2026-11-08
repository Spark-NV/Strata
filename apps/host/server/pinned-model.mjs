/**
 * The one model this app uses: a Strata server the person already runs (a systemd user service), pinned by the launcher.
 *
 *   STRATA_PIN_BASE_URL   the server's OpenAI address, e.g. http://127.0.0.1:8082/v1 (unset: the feature is off, the app is upstream's)
 *   STRATA_PIN_SERVICE    the systemd --user unit that serves it, started when the server does not answer
 *   STRATA_PIN_NAME       the name shown for it (default: the model id the server reports)
 *
 * At start and before every turn: if the server does not answer, the service is started and waited for; the model id and context the
 * server reports are written into one saved API connection, and every chat runs on that connection. release() stops the service to
 * give its memory back (model-release.mjs decides when: idle, or a game starting); the next ensure() starts it again.
 */
import { execFile } from 'node:child_process';

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** `systemctl --user <verb> <unit>`; resolves to the error text, or null when it worked. */
const runSystemctl = (verb, unit) => new Promise(resolve => execFile('systemctl', ['--user', verb, unit], { timeout: 60_000 }, err => resolve(err ? err.message : null)));

export function pinConfig(env = process.env) {
  const base = String(env.STRATA_PIN_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return { base, service: String(env.STRATA_PIN_SERVICE ?? '').trim() || null, name: String(env.STRATA_PIN_NAME ?? '').trim() || null };
}

export function createPinnedModel({ config, modelProviders, log = console.log, fetchImpl = fetch, systemctl = runSystemctl }) {
  let state = { enabled: !!config, phase: config ? 'checking' : 'off', name: config?.name ?? null, modelId: null, connectionId: null, error: null, context: null, released: null };
  let starting = null, stopping = null, usedAt = 0;
  const listeners = new Set();
  const set = patch => { state = { ...state, ...patch }; for (const fn of listeners) fn(state); };
  const healthUrl = () => config.base.replace(/\/v1$/, '') + '/health';

  async function answers() {
    try { const r = await fetchImpl(healthUrl(), { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; }
  }
  const startService = () => systemctl('start', config.service);
  /** The server's model id and window, written into the pinned connection (created once, updated when they change). */
  async function adopt() {
    const r = await fetchImpl(`${config.base}/models`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`The model server answered ${r.status} for its model list.`);
    const row = (await r.json())?.data?.[0];
    if (!row?.id) throw new Error('The model server lists no model.');
    const context = Number(row.meta?.n_ctx) || null;
    const vision = Array.isArray(row.architecture?.input_modalities) ? row.architecture.input_modalities.includes('image') : null;
    const name = config.name ?? row.id;
    const existing = modelProviders.list().connections.find(c => c.kind === 'custom' && c.baseUrl.replace(/\/+$/, '') === config.base);
    const model = { id: row.id, name, contextMax: context, maxOutput: null, vision, reasoning: true };
    const same = existing && existing.models.length === 1 && existing.models[0].id === row.id && existing.models[0].contextMax === context && existing.name === name;
    const saved = same ? modelProviders.list() : modelProviders.save({ ...(existing ? { id: existing.id } : {}), kind: 'custom', name, protocol: 'openai-chat', baseUrl: config.base, models: [model] });
    const conn = saved.connections.find(c => c.kind === 'custom' && c.baseUrl.replace(/\/+$/, '') === config.base);
    set({ phase: 'ready', modelId: row.id, connectionId: conn.id, name, context, error: null, released: null });
  }
  /** Ready to serve a turn: the server answers (started if needed) and the connection names its model. */
  async function ensure() {
    if (!config) return null;
    usedAt = Date.now();
    if (starting) return starting;
    starting = (async () => {
      try {
        if (stopping) await stopping;
        if (!(await answers())) {
          if (!config.service) throw new Error(`The model server at ${config.base} does not answer.`);
          set({ phase: 'starting', error: null, released: null });
          log(`pinned model ·  starting ${config.service}`);
          const err = await startService();
          if (err) throw new Error(`Could not start ${config.service}: ${err}`);
          const until = Date.now() + 15 * 60_000;   // loading the experts into RAM takes a minute or two
          while (!(await answers())) { if (Date.now() > until) throw new Error(`${config.service} did not answer within 15 minutes.`); await sleep(2000); }
        }
        await adopt();
        return { connectionId: state.connectionId, modelId: state.modelId };
      } catch (e) {
        set({ phase: 'error', error: e.message });
        throw e;
      } finally { starting = null; }
    })();
    return starting;
  }
  /**
   * Stops the service so its GPU memory and RAM are free; `reason` is 'idle' or 'game' and `detail` what the app shows with it (the
   * minutes, the game's name). Not while it is starting; a chat sent meanwhile waits for the stop and then starts it again.
   */
  async function release(reason, detail = null) {
    if (!config?.service || starting) return false;
    if (stopping) return stopping;
    stopping = (async () => {
      set({ phase: 'stopping', error: null });
      log(`pinned model ·  releasing ${config.service} (${reason}${detail ? `: ${detail}` : ''})`);
      const err = await systemctl('stop', config.service);
      if (err) { set({ phase: 'error', error: `Could not stop ${config.service}: ${err}` }); return false; }
      set({ phase: 'released', released: { reason, detail, at: Date.now() } });
      return true;
    })().finally(() => { stopping = null; });
    return stopping;
  }
  return {
    state: () => state,
    release,
    /** When a chat last asked for the model (ensure), in ms. */
    usedAt: () => usedAt,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    ensure,
    /** The pinned selection without waiting (null until the first ensure() found the model). */
    selection: () => (state.connectionId && state.modelId ? { connectionId: state.connectionId, modelId: state.modelId } : null),
  };
}
