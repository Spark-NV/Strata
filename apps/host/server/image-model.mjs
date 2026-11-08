/**
 * The image model of Image chats: Qwen-Image-2.1 served by stable-diffusion.cpp's sd-server, which keeps the denoiser, the text
 * encoder and the VAE loaded between images. It and the pinned text model never share the GPU: loading it stops the pinned model
 * first (pinned.release('image')), and the pinned model starting again (a chat written in another profile) unloads it first.
 *
 *   STRATA_IMAGE_SERVER      sd-server (stable-diffusion.cpp's examples/server); unset: there are no Image chats
 *   STRATA_IMAGE_DIFFUSION   the denoiser (gguf or safetensors)
 *   STRATA_IMAGE_LLM         the text encoder (Qwen3-VL-8B gguf)
 *   STRATA_IMAGE_VAE         the VAE (qwen_image_2.1_vae_bf16.safetensors)
 *   STRATA_IMAGE_NAME        the name shown for it (default Qwen-Image-2.1)
 *   STRATA_IMAGE_PORT        sd-server's port on 127.0.0.1 (default 8091)
 *   STRATA_IMAGE_ARGS        more sd-server arguments, space separated
 *   STRATA_IMAGE_STEPS, STRATA_IMAGE_CFG   the defaults of a new image (40 steps, guidance 4)
 *
 * Like the pinned model it is unloaded after the idle time (STRATA_PIN_IDLE_MIN) and when a game starts.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function imageModelConfig(env = process.env) {
  const exe = String(env.STRATA_IMAGE_SERVER ?? '').trim();
  const diffusion = String(env.STRATA_IMAGE_DIFFUSION ?? '').trim(), llm = String(env.STRATA_IMAGE_LLM ?? '').trim(), vae = String(env.STRATA_IMAGE_VAE ?? '').trim();
  if (!exe || !diffusion || !llm || !vae) return null;
  const n = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
  return {
    exe, diffusion, llm, vae,
    name: String(env.STRATA_IMAGE_NAME ?? '').trim() || 'Qwen-Image-2.1',
    port: n(env.STRATA_IMAGE_PORT, 8091),
    args: String(env.STRATA_IMAGE_ARGS ?? '').split(/\s+/).filter(Boolean),
    steps: n(env.STRATA_IMAGE_STEPS, 40),
    cfg: n(env.STRATA_IMAGE_CFG, 4),
  };
}

/** sd-server's command line for a config. */
export function serverArgs(config) {
  return ['--listen-ip', '127.0.0.1', '--listen-port', String(config.port),
    '--diffusion-model', config.diffusion, '--llm', config.llm, '--vae', config.vae, '--diffusion-fa', ...config.args];
}

export const SIZE_MIN = 256, SIZE_MAX = 2048;
/** A request from the page, every field checked: sides are multiples of 32 within the limits, at most 4 images. */
export function imageRequest(raw, config) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const prompt = String(src.prompt ?? '').trim();
  if (!prompt) throw new Error('Describe the image to make.');
  const side = v => Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round((Number(v) || 1024) / 32) * 32));
  const given = v => v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v));
  const int = (v, lo, hi, d) => (given(v) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  const seed = int(src.seed, 0, 2 ** 31 - 1, null);
  return {
    prompt: prompt.slice(0, 8000),
    negative: String(src.negative ?? '').slice(0, 4000),
    width: side(src.width), height: side(src.height),
    steps: int(src.steps, 1, 100, config.steps),
    cfg: given(src.cfg) ? Math.min(20, Math.max(1, Number(src.cfg))) : config.cfg,
    n: int(src.n, 1, 4, 1),
    seed: seed ?? Math.floor(Math.random() * 2 ** 31),
  };
}

/** The native job body (sd-server's /sdcpp/v1/img_gen) for one image of a request. */
export function jobBody(req, index = 0) {
  return {
    prompt: req.prompt, negative_prompt: req.negative, width: req.width, height: req.height, seed: req.seed + index, batch_count: 1,
    sample_params: { sample_method: 'euler', sample_steps: req.steps, guidance: { txt_cfg: req.cfg } },
    preview: 'proj', output_format: 'png',
  };
}

export function createImageModel({ config, pinned, dataDir, activity = null, idleMs = 0, games = () => new Map(), log = () => {},
  spawnImpl = spawn, fetchImpl = fetch, now = Date.now, readyTimeoutMs = 10 * 60_000 }) {
  const outDir = join(dataDir, 'generated-images');
  let state = { enabled: !!config, phase: config ? 'off' : 'disabled', name: config?.name ?? null, error: null, loadedAt: null,
    usedAt: null, job: null, unloaded: null, defaults: config ? { steps: config.steps, cfg: config.cfg, width: 1024, height: 1024 } : null };
  let child = null, loading = null, stopping = null, queue = Promise.resolve(), known = new Set(), timer = null;
  const listeners = new Set();
  const set = patch => { state = { ...state, ...patch }; for (const fn of listeners) fn(state); };
  const base = () => `http://127.0.0.1:${config.port}`;
  const tail = [];

  async function answers() {
    try { const r = await fetchImpl(`${base()}/sdcpp/v1/capabilities`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
  }
  /** The pinned text model gives the GPU back first; one that is starting is let finish, then stopped. */
  async function freeGpu() {
    if (!pinned) return;
    for (let i = 0; i < 3; i++) {
      const phase = pinned.state().phase;
      if (phase === 'released' || phase === 'off') return;
      if (phase === 'starting') { await pinned.ensure().catch(() => {}); continue; }
      if (await pinned.release('image', config.name)) { activity?.down('image', config.name); return; }
    }
    throw new Error('The text model could not be stopped to make room for the image model.');
  }

  /** Loaded and answering: the text model stopped, sd-server started and its files loaded. */
  async function load() {
    if (!config) throw new Error('No image model is set up.');
    if (state.phase === 'ready' && child) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        if (stopping) await stopping;
        for (const f of [config.exe, config.diffusion, config.llm, config.vae]) if (!existsSync(f)) throw new Error(`Missing image model file: ${f}`);
        set({ phase: 'freeing', error: null, unloaded: null });
        await freeGpu();
        set({ phase: 'loading' });
        log(`image model ·  loading ${config.name}`);
        tail.length = 0;
        const proc = spawnImpl(config.exe, serverArgs(config), { stdio: ['ignore', 'pipe', 'pipe'] });
        child = proc;
        const keep = chunk => { for (const line of String(chunk).split('\n')) if (line.trim()) { tail.push(line.trim()); if (tail.length > 40) tail.shift(); } };
        proc.stdout?.on('data', keep); proc.stderr?.on('data', keep);
        let exited = false;
        proc.on('exit', code => {
          exited = true;
          if (child !== proc) return;
          child = null;
          if (!stopping) {
            log(`image model ·  sd-server ended (${code})`);
            set({ phase: 'error', error: `The image model stopped (${code}). ${tail.slice(-3).join(' ')}`.trim(), job: null, loadedAt: null });
          }
        });
        const until = now() + readyTimeoutMs;
        while (!(await answers())) {
          if (exited) throw new Error(`The image model did not start. ${tail.slice(-3).join(' ')}`.trim());
          if (now() > until) throw new Error('The image model did not load within 10 minutes.');
          await sleep(1000);
        }
        known = new Set(games().keys());
        set({ phase: 'ready', loadedAt: now(), usedAt: now() });
      } catch (e) {
        if (child) { const c = child; child = null; c.kill('SIGKILL'); }
        set({ phase: 'error', error: e.message });
        throw e;
      } finally { loading = null; }
    })();
    return loading;
  }

  /** Stops sd-server; `reason` is 'text' (the text model is wanted), 'idle', 'game' or 'person'. */
  async function unload(reason = 'person', detail = null) {
    if (loading) await loading.catch(() => {});
    if (!child) { if (state.phase === 'error') set({ phase: 'off', error: null }); return false; }
    if (stopping) return stopping;
    stopping = (async () => {
      const proc = child;
      set({ phase: 'stopping' });
      log(`image model ·  unloading (${reason}${detail ? `: ${detail}` : ''})`);
      const gone = new Promise(r => proc.once('exit', r));
      proc.kill('SIGTERM');
      if (await Promise.race([gone.then(() => true), sleep(8000).then(() => false)]) === false) { proc.kill('SIGKILL'); await gone; }
      child = null;
      set({ phase: 'off', job: null, loadedAt: null, unloaded: { reason, detail, at: now() } });
      // The text model stays stopped after an idle or game unload: the Monitor shows why.
      if (reason === 'idle' || reason === 'game') { pinned?.relabel?.(reason, detail); activity?.down(reason, detail); }
      return true;
    })().finally(() => { stopping = null; });
    return stopping;
  }

  async function oneImage(req, index, onFrame, signal) {
    const r = await fetchImpl(`${base()}/sdcpp/v1/img_gen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(jobBody(req, index)), signal });
    if (!r.ok) throw new Error(`The image model refused the request (${r.status}): ${(await r.text().catch(() => '')).slice(0, 300)}`);
    const { id } = await r.json();
    let lastStep = -1;
    const cancel = () => { void fetchImpl(`${base()}/sdcpp/v1/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
        const j = await (await fetchImpl(`${base()}/sdcpp/v1/jobs/${id}`, { signal: AbortSignal.timeout(10_000) })).json();
        if (j.status === 'completed') {
          const b64 = j.result?.images?.[0]?.b64_json ?? j.result?.b64_json;
          if (!b64) throw new Error('The image model answered without an image.');
          return Buffer.from(b64, 'base64');
        }
        if (j.status === 'failed') throw new Error(`The image failed: ${j.error?.message ?? 'unknown error'}`);
        if (j.status === 'cancelled') throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
        const p = j.preview;
        if (p && p.step !== lastStep) {
          lastStep = p.step;
          set({ job: { ...state.job, step: p.step, steps: p.total_steps } });
          onFrame({ type: 'progress', index, step: p.step, steps: p.total_steps, preview: p.b64_json ? `data:image/png;base64,${p.b64_json}` : null });
        } else if (j.status === 'queued' && lastStep < 0) onFrame({ type: 'progress', index, step: 0, steps: req.steps, preview: null });
        await sleep(600);
      }
    } finally { signal?.removeEventListener('abort', cancel); }
  }

  function store(png) {
    mkdirSync(outDir, { recursive: true });
    const name = `${randomBytes(12).toString('hex')}.png`;
    writeFileSync(join(outDir, name), png);
    return name;
  }

  /**
   * Makes the images of one request, one at a time (each with seed + its index). `onFrame` gets { type: 'phase', phase } while the
   * model is made ready, { type: 'progress', index, step, steps, preview } while it draws and { type: 'image', index, file, seed }
   * for each image. Requests wait for each other.
   */
  function generate(raw, onFrame = () => {}, signal) {
    const req = imageRequest(raw, config ?? { steps: 40, cfg: 4 });
    const run = queue.then(async () => {
      if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
      if (state.phase !== 'ready') {
        onFrame({ type: 'phase', phase: pinned && !['released', 'off'].includes(pinned.state().phase) ? 'freeing' : 'loading' });
        const watch = s => onFrame({ type: 'phase', phase: s.phase });
        listeners.add(watch);
        try { await load(); } finally { listeners.delete(watch); }
      }
      const started = now();
      set({ job: { step: 0, steps: req.steps, index: 0, n: req.n, startedAt: started }, usedAt: now() });
      const images = [];
      try {
        for (let i = 0; i < req.n; i++) {
          set({ job: { ...state.job, index: i, step: 0 } });
          const png = await oneImage(req, i, onFrame, signal);
          const file = store(png);
          images.push({ file, seed: req.seed + i });
          onFrame({ type: 'image', index: i, file, seed: req.seed + i });
        }
      } finally { set({ job: null, usedAt: now() }); }
      return { images, request: req, seconds: Math.round((now() - started) / 100) / 10 };
    });
    queue = run.catch(() => {});
    return run;
  }

  /** Every few seconds while loaded: a game that starts, or the idle time passing, unloads it. */
  async function tick() {
    if (state.phase !== 'ready' || state.job) return null;
    const current = games();
    const started = [...current].find(([id]) => !known.has(id));
    known = new Set(current.keys());
    if (started) { await unload('game', started[1]); return 'game'; }
    if (idleMs > 0 && now() - (state.usedAt ?? now()) >= idleMs) { await unload('idle', `${Math.round(idleMs / 60_000)} min`); return 'idle'; }
    return null;
  }

  return {
    state: () => state,
    load, unload, generate, tick,
    /** A generated image's path, or null for a name that is not one. */
    file(name) {
      if (!/^[0-9a-f]{24}\.png$/.test(String(name))) return null;
      const p = join(outDir, name);
      return existsSync(p) ? p : null;
    },
    /** Marks the model as wanted (the person writes in an Image chat), so the idle time starts again. */
    touch() { if (state.phase === 'ready') set({ usedAt: now() }); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start(everyMs = 3000) {
      timer = setInterval(() => { void tick().catch(e => log(`image model ·  ${e.message}`)); }, everyMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    /** For the host's shutdown: no sd-server is left behind. */
    kill() { if (child) { child.kill('SIGKILL'); child = null; } },
  };
}
