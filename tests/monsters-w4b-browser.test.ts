import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import {
  evaluate, openPage, screenshot, until, type CdpSession, type LaunchedBrowser,
} from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeTestBrowser, launchTestBrowser } from './browser-cleanup';

const WIDTH = 1280, HEIGHT = 720;
/** Simulation ticks (1/60 s) between drawn frames of a hunt: 7.5 frames a second, at least three in every windup. */
const TICKS_PER_RENDER = 8;

// W4b: a real guard campaign in a version 3 world, staged by save editing (only the hero moves): a barrow-ghoul pack and a
// bog troll appear at their haunts, hunt the hero and die under the hero's blows, every few ticks drawn by the real view.
const preview = `<!doctype html><html><head><link rel="icon" href="data:,"><style>
html,body {margin:0;overflow:hidden;background:#000} canvas {display:block;width:${WIDTH}px;height:${HEIGHT}px}
</style></head><body><canvas id="view" width="${WIDTH}" height="${HEIGHT}"></canvas><script type="module">
import { createCampaign, restoreCampaign } from '/src/game/index.ts';
import { isWalkable, monsterLairs } from '/src/game/world.ts';
import { parseBeasts } from '/src/audio/manifest.ts';
import { createGameView, createRenderer, Presentation } from '/src/view/index.ts';
import { campaignModelIds, gltfModelSource, ModelLibrary } from '/src/view/models.ts';
import { gltfWorldSource, WorldAssetLibrary, worldAssetIds } from '/src/view/world-assets.ts';
const state = { ready: false, error: null };
window.beasts = state;
let presentation = null;
const update = Presentation.prototype.update;
Presentation.prototype.update = function (...args) { presentation = this; return update.apply(this, args); };
try {
  let session = createCampaign({ seed: 'wolves-a', faction: 'guard', runId: 'beasts-browser', worldVersion: 3 });
  const world = session.snapshot().world;
  const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const spot = (centre, reach, apart = 0) => {
    for (let i = 0; i < 144; i++) {
      const a = i / 144 * Math.PI * 2, p = { x: centre.x + Math.sin(a) * reach, z: centre.z + Math.cos(a) * reach };
      if (isWalkable(world, p, 0.65) && monsterLairs(world).every(l => l === centre || near(l, p) > apart)) return p;
    }
    throw new Error('no walkable spot');
  };
  const move = at => {
    const value = structuredClone(session.serialize());
    Object.assign(value.engine.resources.KorovanyCampaign.player, at);
    session = restoreCampaign(value);
  };
  const models = new ModelLibrary(gltfModelSource(), campaignModelIds(session.snapshot()));
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
  // Waits for the GPU between tasks (a fence polled from later tasks), so the page always answers the test's polls.
  const gpuIdle = async () => {
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    while (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise(resolve => setTimeout(resolve, 4));
    gl.deleteSync(fence);
  };
  for (let i = 0; i < 3; i++) { view.render(session.snapshot(), 1 / 60); await gpuIdle(); }
  state.warmup = view.warmup;
  const visuals = () => [...presentation.monsterVisuals.values()];
  /** Program keys of every material a monster visual draws with (and its depth variants, by three's material cache). */
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
  state.job = null;
  state.startHunt = species => {
    const job = { done: false, result: null, error: null };
    state.job = job;
    (async () => {
      try {
        const haunt = world.haunts.find(h => h.species === species);
        const pack = snapshot => (snapshot.monsters ?? []).filter(m => m.lairId === haunt.id);
        // The spawner looks once a second: the hero waits in the spawn band until the haunt's beasts appear.
        move(spot(haunt, 120, 170));
        for (let tick = 0; tick < 120 && !pack(session.snapshot()).length; tick++) session.step({});
        move(spot(haunt, 12));
        const keysBefore = new Set(renderer.info.programs.map(program => program.cacheKey));
        const clips = new Set(), maxHp = session.snapshot().player.maxHp;
        const result = { species, renders: 0, maxCalls: 0, maxTriangles: 0, maxBeasts: 0, mismatch: 0, seconds: 0 };
        const started = performance.now();
        let hunting = false, lowest = maxHp;
        for (let step = 0; step < 60 * 40; step += ${TICKS_PER_RENDER}) {
          const snapshot = session.snapshot();
          if (pack(snapshot).length && pack(snapshot).every(m => m.hp <= 0)) break;
          if (!hunting) hunting = pack(snapshot).some(m => m.state === 'windup');
          for (let i = 0; i < ${TICKS_PER_RENDER}; i++) {
            const s = session.snapshot();
            const prey = pack(s).filter(m => m.hp > 0).sort((a, b) => near(a, s.player) - near(b, s.player))[0];
            session.step(hunting && prey ? { attack: true, aim: { x: prey.x - s.player.x, z: prey.z - s.player.z } } : {});
            lowest = Math.min(lowest, session.snapshot().player.hp);
          }
          counters.calls = 0;
          counters.triangles = 0;
          const now = session.snapshot();
          view.render(now, ${TICKS_PER_RENDER} / 60);
          await gpuIdle();
          result.renders++;
          result.maxCalls = Math.max(result.maxCalls, counters.calls);
          result.maxTriangles = Math.max(result.maxTriangles, Math.round(counters.triangles));
          result.maxBeasts = Math.max(result.maxBeasts, visuals().length);
          if (visuals().length !== (now.monsters ?? []).length) result.mismatch++;
          for (const visual of visuals()) if (visual.monster.species === species) clips.add(visual.monster.activeClip);
        }
        for (let i = 0; i < 12; i++) { session.step({}); view.render(session.snapshot(), 1 / 10); await gpuIdle(); }
        result.seconds = Math.round((performance.now() - started) / 100) / 10;
        const final = session.snapshot();
        const fallen = pack(final);
        result.clips = [...clips].sort();
        result.dead = fallen.map(m => m.hp);
        result.deathHeld = fallen.every(m => presentation.monsterVisuals.get(m.id)?.monster.activeClip === 'Death');
        result.heights = fallen.map(m => presentation.monsterVisuals.get(m.id)?.monster.height ?? 0);
        result.dip = (maxHp - lowest) / maxHp;
        result.phase = final.phase;
        result.monsterProgramsCreated = monsterKeys().filter(key => !keysBefore.has(key)).length;
        result.monsterPrograms = monsterKeys().length;
        result.contextLost = gl.isContextLost();
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
  // Each new species' voices decode in the browser: mono Vorbis at 48 kHz, audible, as long as the manifest says.
  state.decodeVoices = async () => {
    const voices = parseBeasts(await (await fetch('/audio/beasts/manifest.json')).json()).filter(v => !v.id.startsWith('beast-wolf-'));
    const decoded = [];
    for (const voice of voices) {
      const bytes = await (await fetch('/' + voice.src)).arrayBuffer();
      const buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes);
      let peak = 0;
      for (const sample of buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
      decoded.push({ id: voice.id, rate: buffer.sampleRate, channels: buffer.numberOfChannels, duration: buffer.duration, expected: voice.duration, peak });
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
  species: string;
  renders: number;
  maxCalls: number;
  maxTriangles: number;
  maxBeasts: number;
  mismatch: number;
  seconds: number;
  clips: string[];
  dead: number[];
  deathHeld: boolean;
  heights: number[];
  dip: number;
  phase: string;
  monsterPrograms: number;
  monsterProgramsCreated: number;
  contextLost: boolean;
  brightness: number;
}

describe.runIf(process.env.KOROVANY_WORLD_BROWSER === '1')('version 3 barrow ghouls and bog trolls in WebGL', () => {
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
        name: 'beasts-acceptance',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__beasts') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            server.transformIndexHtml('/__beasts', preview).then(html => response.end(html), next);
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('Beast preview server has no local URL');
    browser = await launchTestBrowser({ viewport: { width: WIDTH, height: HEIGHT } });
    cdp = await openPage(browser.port, `${origin}__beasts`, { width: WIDTH, height: HEIGHT });
    await until(cdp, 'Boolean(window.beasts && (window.beasts.ready || window.beasts.error))', Boolean, 240_000);
    expect(await evaluate(cdp, 'window.beasts.error')).toBeNull();
  }, 300_000);

  afterAll(async () => {
    cdp?.close();
    try {
      if (browser) await closeTestBrowser(browser);
    } finally {
      await server?.close();
    }
  }, 60_000);

  for (const species of ['ghoul', 'troll'] as const) {
    test(`a ${species} hunt is drawn and dies on screen: every clip played, the dead held down, no new monster programs`, async () => {
      if (!cdp) throw new Error('Beast browser was not initialized');
      expect(await evaluate(cdp, 'window.beasts.warmup'), 'the load-time warm-up ran').toBeDefined();
      await evaluate(cdp, `window.beasts.startHunt(${JSON.stringify(species)})`);
      const job = await until<{ done: boolean; result: Hunt | null; error: string | null }>(cdp, 'window.beasts.job', job => job.done, 480_000);
      if (job.error !== null || job.result === null) throw new Error(job.error ?? 'no hunt result');
      const hunt = job.result;
      console.info(`W4b ${species} hunt metrics`, JSON.stringify(hunt));
      if (captures) await screenshot(cdp, join(captures, `beasts-${species}-after-hunt.png`));
      expect(hunt.contextLost).toBe(false);
      expect(hunt.phase).toBe('playing');
      expect(hunt.mismatch, 'one visual per monster in every frame').toBe(0);
      expect(hunt.dead.length).toBeGreaterThanOrEqual(species === 'troll' ? 1 : 3);
      expect(hunt.dead.every(hp => hp === 0)).toBe(true);
      expect(hunt.deathHeld).toBe(true);
      for (const clip of ['Idle', 'Windup', 'Death']) expect(hunt.clips, clip).toContain(clip);
      expect(hunt.clips.some(clip => clip === 'Run' || clip === 'Walk'), `moving clips in ${hunt.clips}`).toBe(true);
      // The cooked models stand at their sizes: the ghoul 2.6 m, the troll 4.4 m.
      for (const height of hunt.heights) expect(height).toBeCloseTo(species === 'troll' ? 4.4 : 2.6, 1);
      expect(hunt.dip).toBeGreaterThan(0);
      expect(hunt.dip).toBeLessThan(0.8);
      expect(hunt.brightness).toBeGreaterThan(64 * 64 * 3 * 12);
      // The warm-up drew one beast of each species the world's lairs and haunts keep (aegis-engine #6): no monster
      // material gains a program while it hunts and dies.
      expect(hunt.monsterPrograms).toBeGreaterThan(0);
      expect(hunt.monsterProgramsCreated, 'monster programs created during the hunt').toBe(0);
      expect.soft(hunt.maxCalls).toBeLessThanOrEqual(450);
      expect.soft(hunt.maxTriangles).toBeLessThanOrEqual(1_500_000);
      expect(cdp.diagnostics).toEqual([]);
    }, 600_000);
  }

  test('the ghouls\' and trolls\' synthesised voices decode as audible mono Vorbis at 48 kHz', async () => {
    if (!cdp) throw new Error('Beast browser was not initialized');
    const voices = await evaluate<{ id: string; rate: number; channels: number; duration: number; expected: number; peak: number }[]>(
      cdp, 'window.beasts.decodeVoices()');
    expect(voices.map(v => v.id)).toEqual(expect.arrayContaining(['beast-ghoul-howl', 'beast-ghoul-snarl', 'beast-ghoul-yelp',
      'beast-ghoul-death', 'beast-troll-howl', 'beast-troll-snarl', 'beast-troll-yelp', 'beast-troll-death']));
    for (const voice of voices) {
      expect(voice.rate, voice.id).toBe(48000);
      expect(voice.channels, voice.id).toBe(1);
      expect(Math.abs(voice.duration - voice.expected), voice.id).toBeLessThan(0.02);
      expect(voice.peak, voice.id).toBeGreaterThan(0.1);
      expect(voice.peak, voice.id).toBeLessThan(0.9);
    }
  }, 120_000);

  test('releases the view', async () => {
    if (!cdp) throw new Error('Beast browser was not initialized');
    expect(await evaluate<boolean>(cdp, 'window.beasts.dispose()')).toBe(true);
  }, 60_000);
});
