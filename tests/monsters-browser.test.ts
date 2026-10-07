import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import {
  evaluate, openPage, screenshot, until, type CdpSession, type LaunchedBrowser,
} from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeTestBrowser, launchTestBrowser } from './browser-cleanup';

const WIDTH = 1280, HEIGHT = 720;
/** Simulation ticks (1/60 s) between drawn frames of the hunt: 7.5 frames a second, at least two in every battle windup. */
const TICKS_PER_RENDER = 8;

// W4a: a real guard campaign in a version 3 world, staged by save editing (only the hero moves): a grave-wolf pack
// appears at a den, runs at the hero and dies in the battle its contact opens, every few simulation ticks drawn by the
// real view.
const preview = `<!doctype html><html><head><link rel="icon" href="data:,"><style>
html,body {margin:0;overflow:hidden;background:#000} canvas {display:block;width:${WIDTH}px;height:${HEIGHT}px}
</style></head><body><canvas id="view" width="${WIDTH}" height="${HEIGHT}"></canvas><script type="module">
import { createCampaign, restoreCampaign, suggestCommand } from '/src/game/index.ts';
import { isWalkable } from '/src/game/world.ts';
import { parseBeasts } from '/src/audio/manifest.ts';
import { createGameView, createRenderer, Presentation } from '/src/view/index.ts';
import { campaignModelIds, gltfModelSource, ModelLibrary } from '/src/view/models.ts';
import { gltfWorldSource, WorldAssetLibrary, worldAssetIds } from '/src/view/world-assets.ts';
const state = { ready: false, error: null };
window.wolves = state;
let presentation = null;
const update = Presentation.prototype.update;
Presentation.prototype.update = function (...args) { presentation = this; return update.apply(this, args); };
try {
  // An honed blade keeps the battle (and the frames drawn of it) short.
  let session = createCampaign({ seed: 'wolves-browser', faction: 'guard', runId: 'wolves-browser', worldVersion: 3, upgrades: { damage: 1 } });
  const world = session.snapshot().world;
  const lair = world.lairs[0];
  const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const spot = (reach, apart = 0) => {
    for (let i = 0; i < 144; i++) {
      const a = i / 144 * Math.PI * 2, p = { x: lair.x + Math.sin(a) * reach, z: lair.z + Math.cos(a) * reach };
      if (isWalkable(world, p, 0.65) && world.lairs.every(l => l === lair || near(l, p) > apart)) return p;
    }
    throw new Error('no walkable spot');
  };
  const move = at => {
    const value = structuredClone(session.serialize());
    Object.assign(value.engine.resources.KorovanyCampaign.player, at);
    session = restoreCampaign(value);
  };
  move(spot(120, 170));
  session.step({});
  move(spot(14));
  const base = session.snapshot();
  const models = new ModelLibrary(gltfModelSource(), campaignModelIds(base));
  const worldAssets = new WorldAssetLibrary(gltfWorldSource());
  const loading = worldAssets.request(worldAssetIds(world));
  const canvas = document.getElementById('view');
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'high-performance' });
  const counters = { calls: 0, triangles: 0 };
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    const original = gl[name].bind(gl);
    gl[name] = (...args) => {
      counters.calls++;
      const count = name.startsWith('drawArrays') ? args[2] : args[1];
      const instances = name.endsWith('Instanced') ? args[name === 'drawArraysInstanced' ? 3 : 4] : 1;
      if (args[0] === gl.TRIANGLES) counters.triangles += count / 3 * instances;
      return original(...args);
    };
  }
  const renderer = createRenderer(canvas);
  const view = createGameView(canvas, world, { quality: 'high', reducedMotion: false, models, worldAssets, renderer });
  view.resize();
  await Promise.all([models.ready, loading]);
  const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
  // Waits for the GPU to finish everything drawn so far without blocking the page: a fence polled from later tasks
  // (a pixel read-back would hold the main thread until the GPU is done). Returns the milliseconds waited.
  const gpuIdle = async () => {
    const t0 = performance.now(), fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    while (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise(resolve => setTimeout(resolve, 4));
    gl.deleteSync(fence);
    return Math.round(performance.now() - t0);
  };
  // The first frames carry the warm-up and every upload of the load. The page waits for their GPU work between tasks, so
  // it answers the test's polls throughout (under SwiftShader on a CI runner this work takes tens of seconds).
  state.loadMs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    view.render(session.snapshot(), 1 / 60);
    const drawn = Math.round(performance.now() - t0);
    state.loadMs.push([drawn, await gpuIdle()]);
  }
  state.lair = lair;
  state.warmup = view.warmup;
  const visuals = () => [...presentation.monsterVisuals.values()];
  state.job = null;
  state.startHunt = () => {
    const job = { done: false, result: null, error: null };
    state.job = job;
    (async () => {
      try {
        const programsBefore = renderer.info.programs.length;
        const keysBefore = new Set(renderer.info.programs.map(program => program.cacheKey));
        // Program keys of every material a monster visual draws with (and its depth variants, by three's material cache).
        const monsterKeys = () => {
          const keys = new Set();
          for (const visual of visuals()) visual.root.traverse(object => {
            const materials = object.isMesh ? [object.material].flat() : [];
            for (const material of materials) {
              const programs = renderer.properties.get(material).programs;
              if (programs) for (const key of programs.keys()) keys.add(key);
            }
          });
          return [...keys];
        };
        const clips = new Set(), result = { renders: 0, maxCalls: 0, maxTriangles: 0, maxBeasts: 0, programsBefore, mismatch: 0, hpLost: 0,
          seconds: 0, slowestRenderMs: 0, slowestGpuMs: 0 };
        const started = performance.now();
        // One drawn frame per ${TICKS_PER_RENDER} simulation ticks; the page then waits for the GPU between tasks, so it
        // always answers the test's polls (under SwiftShader on a CI runner one 720p frame can take seconds).
        const draw = async (snapshot, dt) => {
          const t0 = performance.now(), programs = renderer.info.programs.length;
          view.render(snapshot, dt);
          const ms = Math.round(performance.now() - t0);
          if (ms > result.slowestRenderMs) {
            result.slowestRenderMs = ms;
            result.slowest = { render: result.renders, programs, compiled: renderer.info.programs.length - programs, effects: snapshot.effects.length };
          }
          result.slowestGpuMs = Math.max(result.slowestGpuMs, await gpuIdle());
        };
        const maxHp = session.snapshot().player.maxHp;
        // The hero waits for the pack (it is seen running in), then fights the battle its contact opens: suggested
        // commands, and a parry (a dodge for heavy blows) to every blow but the first, which wounds it. (A parried bite is
        // a whole move parried: its counter kills a wolf, so answering every bite would leave the hero unhurt.)
        let unanswered = 1;
        for (let step = 0; step < 60 * 90; step += ${TICKS_PER_RENDER}) {
          const snapshot = session.snapshot();
          const pack = (snapshot.monsters ?? []).filter(m => m.lairId === lair.id);
          if (pack.length && pack.every(m => m.hp <= 0)) break;
          for (let i = 0; i < ${TICKS_PER_RENDER}; i++) {
            const battle = session.snapshot().battle;
            if (battle?.phase === 'command') session.step({ battle: suggestCommand(battle) });
            let hit = battle?.phase === 'action' ? battle.action?.hits.find(h => h.target === 'hero' && h.outcome === 'pending' &&
              h.pressed === null && h.impact === battle.tick + 1) : undefined;
            if (hit && unanswered > 0) {
              unanswered--;
              hit = undefined;
            }
            session.step(hit ? hit.heavy ? { dodge: true } : { parry: true } : {});
          }
          counters.calls = 0;
          counters.triangles = 0;
          const now = session.snapshot();
          await draw(now, ${TICKS_PER_RENDER} / 60);
          result.renders++;
          result.maxCalls = Math.max(result.maxCalls, counters.calls);
          result.maxTriangles = Math.max(result.maxTriangles, Math.round(counters.triangles));
          result.maxBeasts = Math.max(result.maxBeasts, visuals().length);
          if (visuals().length !== (now.monsters ?? []).length) result.mismatch++;
          // The pack on screen before any combat effect (a slash, a hit) has appeared: nothing may have compiled yet.
          if (now.effects.length) result.effectSeen = true;
          if (result.programsAtSight === undefined && !result.effectSeen && visuals().length &&
              visuals().some(visual => visual.monster.activeClip === 'Run')) result.programsAtSight = renderer.info.programs.length;
          if (!result.effectSeen && result.programsAtSight !== undefined) result.programsBeforeEffects = renderer.info.programs.length;
          for (const visual of visuals()) clips.add(visual.monster.activeClip);
        }
        for (let i = 0; i < 12; i++) { session.step({}); await draw(session.snapshot(), 1 / 10); }
        result.seconds = Math.round((performance.now() - started) / 100) / 10;
        const final = session.snapshot();
        const fallen = (final.monsters ?? []).filter(m => m.lairId === lair.id);
        result.clips = [...clips].sort();
        result.dead = fallen.map(m => m.hp);
        result.deathHeld = fallen.every(m => presentation.monsterVisuals.get(m.id)?.monster.activeClip === 'Death');
        result.hpLost = (maxHp - final.player.hp) / maxHp;
        result.phase = final.phase;
        result.programsAfter = renderer.info.programs.length;
        const created = renderer.info.programs.map(program => program.cacheKey).filter(key => !keysBefore.has(key));
        result.newPrograms = created.length;
        result.monsterProgramsCreated = monsterKeys().filter(key => !keysBefore.has(key)).length;
        result.monsterPrograms = monsterKeys().length;
        result.contextLost = gl.isContextLost();
        // Read the frame back in the task that drew it, before the canvas is presented and its drawing buffer cleared.
        view.render(final, 1 / 60);
        const pixels = new Uint8Array(64 * 64 * 4);
        gl.readPixels(${WIDTH / 2} - 32, ${HEIGHT / 2} - 32, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        result.brightness = pixels.reduce((sum, value, index) => index % 4 === 3 ? sum : sum + value, 0);
        job.result = result;
      } catch (error) {
        job.error = String(error?.stack ?? error);
      }
      job.done = true;
    })();
    return true;
  };
  // The wolves' synthesised voices decode in the browser: mono Vorbis at 48 kHz, audible, as long as the manifest says.
  state.decodeVoices = async () => {
    const response = await fetch('/audio/beasts/manifest.json');
    const voices = parseBeasts(await response.json());
    const decoded = [];
    for (const voice of voices) {
      const bytes = await (await fetch('/' + voice.src)).arrayBuffer();
      const head = new Uint8Array(bytes, 0, Math.min(512, bytes.byteLength));
      const vorbis = [1, 118, 111, 114, 98, 105, 115];
      const at = head.findIndex((_, index) => vorbis.every((byte, offset) => head[index + offset] === byte));
      const rate = new DataView(bytes, at).getUint32(12, true), channels = new DataView(bytes, at).getUint8(11);
      const buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes);
      let peak = 0;
      for (const sample of buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
      decoded.push({ id: voice.id, rate, channels, duration: buffer.duration, expected: voice.duration, peak });
    }
    return decoded;
  };
  state.dispose = () => {
    view.dispose();
    renderer.dispose();
    worldAssets.dispose();
    models.dispose();
    return true;
  };
  state.ready = true;
} catch (error) {
  state.error = String(error?.stack ?? error);
}
</script></body></html>`;

interface Hunt {
  renders: number;
  maxCalls: number;
  maxTriangles: number;
  maxBeasts: number;
  mismatch: number;
  programsBefore: number;
  programsAtSight?: number;
  programsBeforeEffects?: number;
  programsAfter: number;
  newPrograms: number;
  monsterPrograms: number;
  monsterProgramsCreated: number;
  clips: string[];
  dead: number[];
  deathHeld: boolean;
  hpLost: number;
  phase: string;
  contextLost: boolean;
  brightness: number;
  seconds: number;
  slowestRenderMs: number;
  slowestGpuMs: number;
}

describe.runIf(process.env.KOROVANY_WORLD_BROWSER === '1')('version 3 grave wolves in WebGL', () => {
  let server: ViteDevServer | undefined;
  let browser: LaunchedBrowser | undefined;
  let cdp: CdpSession | undefined;
  const captures = process.env.KOROVANY_WORLD_CAPTURE_DIR;

  beforeAll(async () => {
    if (captures) await mkdir(captures, { recursive: true });
    server = await createServer({
      configFile: false,
      optimizeDeps: { include: ['three'] },
      plugins: [{
        name: 'monsters-acceptance',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__monsters') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            server.transformIndexHtml('/__monsters', preview).then(html => response.end(html), next);
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('Monster preview server has no local URL');
    browser = await launchTestBrowser({ viewport: { width: WIDTH, height: HEIGHT } });
    cdp = await openPage(browser.port, `${origin}__monsters`, { width: WIDTH, height: HEIGHT });
    await until(cdp, 'Boolean(window.wolves && (window.wolves.ready || window.wolves.error))', Boolean, 240_000);
    expect(await evaluate(cdp, 'window.wolves.error')).toBeNull();
    console.info('Grave wolf page: first frames (draw and sync, ms)', JSON.stringify(await evaluate(cdp, 'window.wolves.loadMs')));
  }, 300_000);

  afterAll(async () => {
    cdp?.close();
    try {
      if (browser) await closeTestBrowser(browser);
    } finally {
      await server?.close();
    }
  }, 60_000);

  test('a pack hunts and dies on screen: every beast drawn, every clip played, the dead held down, no new monster programs', async () => {
    if (!cdp) throw new Error('Monster browser was not initialized');
    const warmup = await evaluate<{ programsBefore: number; programsAfter: number } | undefined>(cdp, 'window.wolves.warmup');
    expect(warmup, 'the load-time warm-up ran').toBeDefined();
    await evaluate(cdp, 'window.wolves.startHunt()');
    const job = await until<{ done: boolean; result: Hunt | null; error: string | null }>(cdp, 'window.wolves.job', job => job.done, 480_000);
    if (job.error !== null || job.result === null) throw new Error(job.error ?? 'no hunt result');
    const hunt = job.result;
    console.info('Grave wolf hunt metrics', JSON.stringify(hunt));
    if (captures) await screenshot(cdp, join(captures, 'monsters-after-hunt.png'));
    expect(hunt.contextLost).toBe(false);
    expect(hunt.phase).toBe('playing');
    expect(hunt.mismatch, 'one visual per monster in every frame').toBe(0);
    expect(hunt.maxBeasts).toBeGreaterThanOrEqual(3);
    expect(hunt.dead.length).toBeGreaterThanOrEqual(3);
    expect(hunt.dead.every(hp => hp === 0)).toBe(true);
    expect(hunt.deathHeld).toBe(true);
    for (const clip of ['Idle', 'Windup', 'Death']) expect(hunt.clips, clip).toContain(clip);
    expect(hunt.clips.some(clip => clip === 'Run' || clip === 'Walk'), `moving clips in ${hunt.clips}`).toBe(true);
    expect(hunt.hpLost).toBeGreaterThan(0);
    expect(hunt.hpLost).toBeLessThan(0.6);
    expect(hunt.brightness).toBeGreaterThan(64 * 64 * 3 * 12);
    // The warm-up compiled the wolf's programs (aegis-engine #6): a pack appearing and running compiles nothing, and no
    // monster material gains a program while it fights and dies. (The combat effect pools, procedural instanced rings
    // and sparks, compile on the first fight as they always have; they are logged above, not part of this asset.)
    expect(hunt.programsAtSight, 'the pack was seen running before any combat effect').toBeDefined();
    expect(hunt.programsAtSight, 'shader programs when the pack first runs on screen').toBe(hunt.programsBefore);
    expect(hunt.programsBeforeEffects, 'shader programs until the first combat effect').toBe(hunt.programsBefore);
    expect(hunt.monsterPrograms).toBeGreaterThan(0);
    expect(hunt.monsterProgramsCreated, 'monster programs created during the hunt').toBe(0);
    expect.soft(hunt.maxCalls).toBeLessThanOrEqual(450);
    expect.soft(hunt.maxTriangles).toBeLessThanOrEqual(1_500_000);
    expect(cdp.diagnostics).toEqual([]);
  }, 600_000);

  test('the wolves\' synthesised voices decode as audible mono Vorbis at 48 kHz', async () => {
    if (!cdp) throw new Error('Monster browser was not initialized');
    const voices = await evaluate<{ id: string; rate: number; channels: number; duration: number; expected: number; peak: number }[]>(
      cdp, 'window.wolves.decodeVoices()');
    expect(voices.length).toBeGreaterThanOrEqual(4);
    for (const voice of voices) {
      expect(voice.rate, voice.id).toBe(48000);
      expect(voice.channels, voice.id).toBe(1);
      expect(Math.abs(voice.duration - voice.expected), voice.id).toBeLessThan(0.02);
      expect(voice.peak, voice.id).toBeGreaterThan(0.1);
      expect(voice.peak, voice.id).toBeLessThan(0.9);
    }
  }, 120_000);

  test('releases the view', async () => {
    if (!cdp) throw new Error('Monster browser was not initialized');
    expect(await evaluate<boolean>(cdp, 'window.wolves.dispose()')).toBe(true);
  }, 60_000);
});
