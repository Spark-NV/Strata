// The image model of Image chats (server/image-model.mjs): loading it stops the pinned text model first, a request is drawn with
// progress and saved, the text model starting unloads it, and idle time or a game starting unloads it too.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageModel, imageModelConfig, imageRequest, jobBody, serverArgs } from '../server/image-model.mjs';
import { createActivityLog } from '../server/model-release.mjs';
import { createPinnedModel } from '../server/pinned-model.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A stand-in for sd-server: answers only while "running", runs each job in three polls with a preview. */
async function fakeSdServer() {
  const s = { running: false, jobs: new Map(), bodies: [], cancelled: [] };
  const server = http.createServer((req, res) => {
    if (!s.running) { res.destroy(); return; }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/sdcpp/v1/capabilities') return send(200, { ok: true });
      if (req.url === '/sdcpp/v1/img_gen' && req.method === 'POST') {
        const id = `job_${s.jobs.size + 1}`;
        s.bodies.push(JSON.parse(raw));
        s.jobs.set(id, { polls: 0 });
        return send(202, { id, status: 'queued' });
      }
      const cancel = /^\/sdcpp\/v1\/jobs\/(\w+)\/cancel$/.exec(req.url);
      if (cancel) { s.cancelled.push(cancel[1]); s.jobs.get(cancel[1]).cancelled = true; return send(200, {}); }
      const poll = /^\/sdcpp\/v1\/jobs\/(\w+)$/.exec(req.url);
      if (poll) {
        const j = s.jobs.get(poll[1]);
        j.polls++;
        if (j.cancelled) return send(200, { status: 'cancelled' });
        if (j.polls >= 3) return send(200, { status: 'completed', result: { images: [{ index: 0, b64_json: PNG.toString('base64') }] } });
        return send(200, { status: 'generating', preview: { step: j.polls, total_steps: 2, b64_json: 'AAAA' } });
      }
      send(404, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  s.port = server.address().port;
  s.close = () => new Promise(r => server.close(r));
  return s;
}

/** spawn() for sd-server: the fake starts answering, and kill() ends it. */
function fakeSpawn(sd, calls) {
  return (exe, args) => {
    calls.push({ exe, args });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    sd.running = true;
    proc.kill = signal => { calls.push({ kill: signal }); sd.running = false; setImmediate(() => proc.emit('exit', null, signal)); return true; };
    return proc;
  };
}

function setup(t, { pinnedPhase = 'ready', idleMs = 0, games = () => new Map() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'strata-image-'));
  for (const f of ['sd-server', 'dit.gguf', 'llm.gguf', 'vae.safetensors']) writeFileSync(join(dir, f), 'x');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pinned = { phase: pinnedPhase, released: null, releases: [],
    state() { return { phase: this.phase, released: this.released }; },
    async release(reason, detail) { this.releases.push([reason, detail]); this.phase = 'released'; this.released = { reason, detail }; return true; },
    async ensure() { this.phase = 'ready'; },
    relabel(reason, detail) { this.released = { reason, detail }; } };
  return { dir, pinned, config: { exe: join(dir, 'sd-server'), diffusion: join(dir, 'dit.gguf'), llm: join(dir, 'llm.gguf'), vae: join(dir, 'vae.safetensors'), name: 'Qwen-Image-2.1', port: 0, args: [], steps: 40, cfg: 4 }, idleMs, games };
}

test('the config comes from the launcher, and nothing is set up without all four paths', () => {
  assert.equal(imageModelConfig({}), null);
  assert.equal(imageModelConfig({ STRATA_IMAGE_SERVER: '/x/sd-server', STRATA_IMAGE_DIFFUSION: '/m/d.gguf', STRATA_IMAGE_LLM: '/m/l.gguf' }), null);
  const c = imageModelConfig({ STRATA_IMAGE_SERVER: '/x/sd-server', STRATA_IMAGE_DIFFUSION: '/m/d.gguf', STRATA_IMAGE_LLM: '/m/l.gguf', STRATA_IMAGE_VAE: '/m/v.safetensors', STRATA_IMAGE_ARGS: '--fa  --offload-to-cpu', STRATA_IMAGE_STEPS: '30' });
  assert.equal(c.port, 8091); assert.equal(c.steps, 30); assert.equal(c.cfg, 4); assert.equal(c.name, 'Qwen-Image-2.1');
  assert.deepEqual(serverArgs(c), ['--listen-ip', '127.0.0.1', '--listen-port', '8091', '--diffusion-model', '/m/d.gguf', '--llm', '/m/l.gguf', '--vae', '/m/v.safetensors', '--diffusion-fa', '--fa', '--offload-to-cpu']);
});

test('a request is checked: sides are multiples of 32 within the limits, at most 4 images, a seed is always chosen', () => {
  const cfg = { steps: 40, cfg: 4 };
  assert.throws(() => imageRequest({ prompt: '  ' }, cfg), /Describe/);
  const r = imageRequest({ prompt: ' a fox ', width: 1000, height: 5000, n: 9, steps: 0, cfg: 'x', seed: '' }, cfg);
  assert.deepEqual({ ...r, seed: typeof r.seed }, { prompt: 'a fox', negative: '', width: 992, height: 2048, steps: 1, cfg: 4, n: 4, seed: 'number' });
  assert.equal(imageRequest({ prompt: 'a', seed: 7 }, cfg).seed, 7);
  // The page sends null for "a new seed each time" and for settings left as they are: never seed 0 or 0 steps.
  const seeds = new Set(Array.from({ length: 8 }, () => imageRequest({ prompt: 'a', seed: null, steps: null, cfg: null }, cfg)));
  assert.ok(new Set([...seeds].map(x => x.seed)).size > 1, 'a new seed each time');
  assert.deepEqual([...seeds].map(x => [x.steps, x.cfg])[0], [40, 4]);
  const body = jobBody({ ...r, seed: 10 }, 2);
  assert.equal(body.seed, 12); assert.equal(body.preview, 'proj'); assert.deepEqual(body.sample_params, { sample_method: 'euler', sample_steps: 1, guidance: { txt_cfg: 4 } });
});

test('loading stops the text model first; a request is drawn with progress and saved; Unload ends sd-server', async t => {
  const sd = await fakeSdServer(); t.after(sd.close);
  const env = setup(t), calls = [];
  const activity = createActivityLog();
  activity.up();
  const image = createImageModel({ config: { ...env.config, port: sd.port }, pinned: env.pinned, dataDir: env.dir, activity, spawnImpl: fakeSpawn(sd, calls) });
  const phases = [];
  image.onChange(s => phases.push(s.phase));
  const frames = [];
  const done = await image.generate({ prompt: 'a red fox', seed: 5, n: 2, width: 512, height: 512, steps: 2 }, f => frames.push(f));
  assert.deepEqual(env.pinned.releases, [['image', 'Qwen-Image-2.1']]);
  assert.equal(activity.current().reason, 'image');
  assert.deepEqual(phases.slice(0, 3), ['freeing', 'loading', 'ready']);
  assert.equal(calls[0].exe, env.config.exe);
  assert.deepEqual(done.images.map(i => i.seed), [5, 6]);
  assert.deepEqual(sd.bodies.map(b => [b.seed, b.width, b.sample_params.sample_steps]), [[5, 512, 2], [6, 512, 2]]);
  assert.ok(frames.some(f => f.type === 'progress' && f.step === 1 && f.steps === 2 && f.preview === 'data:image/png;base64,AAAA'));
  assert.deepEqual(frames.filter(f => f.type === 'image').map(f => f.seed), [5, 6]);
  for (const i of done.images) assert.deepEqual(readFileSync(image.file(i.file)), PNG);
  assert.equal(image.file('../../etc/passwd'), null);
  // A second request reuses the loaded model.
  await image.generate({ prompt: 'again', steps: 2 });
  assert.equal(calls.filter(c => c.exe).length, 1);
  assert.equal(await image.unload('person'), true);
  assert.equal(image.state().phase, 'off');
  assert.deepEqual(calls.at(-1), { kill: 'SIGTERM' });
});

test('stopping a request cancels its job on sd-server', async t => {
  const sd = await fakeSdServer(); t.after(sd.close);
  const env = setup(t, { pinnedPhase: 'released' }), calls = [];
  const image = createImageModel({ config: { ...env.config, port: sd.port }, pinned: env.pinned, dataDir: env.dir, spawnImpl: fakeSpawn(sd, calls) });
  const controller = new AbortController();
  const run = image.generate({ prompt: 'a fox', steps: 2 }, f => { if (f.type === 'progress' && f.step === 1) controller.abort(); }, controller.signal);
  await assert.rejects(run, e => e.name === 'AbortError');
  assert.deepEqual(env.pinned.releases, [], 'a stopped text model is not stopped again');
  assert.deepEqual(sd.cancelled, ['job_1']);
  assert.equal(image.state().job, null);
  await image.unload();
});

test('the pinned model starting again unloads the image model first', async t => {
  const sd = await fakeSdServer(); t.after(sd.close);
  const env = setup(t, { pinnedPhase: 'released' }), calls = [];
  const image = createImageModel({ config: { ...env.config, port: sd.port }, pinned: env.pinned, dataDir: env.dir, spawnImpl: fakeSpawn(sd, calls) });
  await image.load();
  assert.equal(image.state().phase, 'ready');
  const order = [];
  const health = http.createServer((req, res) => { order.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'qwen', meta: { n_ctx: 1000 } }] } : {})); });
  let up = false;
  const realFetch = (url, opts) => (up || !String(url).endsWith('/health') ? fetch(url, opts) : Promise.reject(new Error('down')));
  await new Promise(r => health.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => health.close(r)));
  const providers = { conns: [], list() { return { connections: this.conns }; }, save(c) { this.conns = [{ ...c, id: 'c1' }]; return this.list(); } };
  const pinned = createPinnedModel({ config: { base: `http://127.0.0.1:${health.address().port}/v1`, service: 'model.service', name: null }, modelProviders: providers, log: () => {}, fetchImpl: realFetch,
    systemctl: async (verb) => { order.push(`systemctl ${verb} (image ${image.state().phase})`); up = true; return null; },
    beforeStart: async () => { await image.unload('text'); } });
  await pinned.ensure();
  assert.equal(order[0], 'systemctl start (image off)');
  assert.equal(image.state().unloaded.reason, 'text');
  assert.equal(pinned.state().phase, 'ready');
});

test('idle time and a game starting unload the image model, and the text model stays stopped with that reason', async t => {
  const sd = await fakeSdServer(); t.after(sd.close);
  let clock = 1_000_000;
  const running = new Map([['steam:1', 'Old game']]);
  const env = setup(t, { pinnedPhase: 'ready' }), calls = [];
  const activity = createActivityLog({ now: () => clock });
  activity.up();
  const image = createImageModel({ config: { ...env.config, port: sd.port }, pinned: env.pinned, dataDir: env.dir, activity, idleMs: 30 * 60_000,
    games: () => running, now: () => clock, spawnImpl: fakeSpawn(sd, calls) });
  await image.load();
  // A game that was already running when it loaded is not "starting".
  assert.equal(await image.tick(), null);
  clock += 29 * 60_000;
  assert.equal(await image.tick(), null);
  clock += 2 * 60_000;
  assert.equal(await image.tick(), 'idle');
  assert.deepEqual(env.pinned.released, { reason: 'idle', detail: '30 min' });
  assert.equal(activity.current().reason, 'idle');
  await image.load();
  running.set('steam:2', 'Cyberpunk 2077');
  assert.equal(await image.tick(), 'game');
  assert.deepEqual(env.pinned.released, { reason: 'game', detail: 'Cyberpunk 2077' });
  assert.deepEqual(activity.totals(0, clock + 1).image > 0, true);
});

test('sd-server that ends while loading is an error with its last lines, and the next load starts it again', async t => {
  const env = setup(t, { pinnedPhase: 'released' });
  const procs = [];
  const spawnImpl = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => true; procs.push(p);
    setImmediate(() => { p.stderr.emit('data', 'CUDA error: out of memory\n'); p.emit('exit', 1); }); return p; };
  const image = createImageModel({ config: { ...env.config, port: 1 }, pinned: env.pinned, dataDir: env.dir, spawnImpl, fetchImpl: () => Promise.reject(new Error('refused')) });
  await assert.rejects(image.load(), /did not start\. CUDA error: out of memory/);
  assert.equal(image.state().phase, 'error');
  await assert.rejects(image.load(), /did not start/);
  assert.equal(procs.length, 2);
});
