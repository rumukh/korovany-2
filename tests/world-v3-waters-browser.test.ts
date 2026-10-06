import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import {
  evaluate, openPage, screenshot, until, type CdpSession, type LaunchedBrowser,
} from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeTestBrowser, launchTestBrowser } from './browser-cleanup';

const WIDTH = 1280, HEIGHT = 720;

// W3b: a guard campaign. The great Fen mere with its reed beds and drowned trees, a forest pool, a Frostspine tarn, the
// sea off the Salt Coast and the river's mouth, at both qualities within the approved budgets, all water on one program.
const preview = `<!doctype html><html><head><link rel="icon" href="data:,"><style>
html,body {margin:0;overflow:hidden;background:#000} canvas {display:block;width:${WIDTH}px;height:${HEIGHT}px}
</style></head><body><canvas id="view" width="${WIDTH}" height="${HEIGHT}"></canvas><script type="module">
import { createCampaign } from '/src/game/index.ts';
import { createGameView, createRenderer } from '/src/view/index.ts';
import { campaignModelIds, gltfModelSource, ModelLibrary } from '/src/view/models.ts';
import { gltfWorldSource, WorldAssetLibrary, worldAssetIds } from '/src/view/world-assets.ts';
const state = { ready: false, error: null };
window.waters = state;
try {
  const campaign = createCampaign({ seed: 'world-v3-waters', faction: 'guard', runId: 'world-v3-waters', worldVersion: 3 });
  const base = campaign.snapshot();
  const world = base.world;
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
  const view = createGameView(canvas, world, { quality: 'high', reducedMotion: true, models, worldAssets, renderer });
  view.resize();
  await Promise.all([models.ready, loading, models.request(campaignModelIds(base))]);
  let tick = base.tick;
  const frame = (x, z) => {
    const snapshot = structuredClone(base);
    snapshot.tick = ++tick;
    snapshot.elapsed = tick / 60;
    snapshot.player.x = x;
    snapshot.player.z = z;
    return snapshot;
  };
  view.render(frame(base.player.x, base.player.z), 1 / 60);
  const regionOf = p => world.exploration.regions.find(r => p.x >= r.bounds.minX && p.x <= r.bounds.maxX && p.z >= r.bounds.minZ && p.z <= r.bounds.maxZ)?.id;
  const extent = lake => Math.max(...lake.shore.map(p => Math.hypot(p.x - lake.x, p.z - lake.z)));
  // The hero 5 m outside the lake's southernmost shore point, looking over the water (the default camera sits south).
  const shoreOf = lake => {
    const p = lake.shore.reduce((best, q) => (q.z < best.z ? q : best));
    const d = Math.hypot(p.x - lake.x, p.z - lake.z);
    return { x: p.x + (p.x - lake.x) / d * 5, z: p.z + (p.z - lake.z) / d * 5 };
  };
  const lakes = world.lakes;
  const mere = lakes.filter(l => l.kind === 'mere').sort((a, b) => extent(b) - extent(a))[0];
  const pool = lakes.find(l => l.kind === 'pool' && (regionOf(l) === 'greenmarch' || regionOf(l) === 'hollowvale'));
  const tarn = lakes.find(l => l.kind === 'tarn');
  const sea = lakes.find(l => l.kind === 'sea');
  const coast = sea.shore.reduce((best, q) => (Math.abs(q.z - 60) < Math.abs(best.z - 60) ? q : best));
  const mouth = sea.shore.reduce((best, q) => (Math.abs(q.z) < Math.abs(best.z) ? q : best));
  state.places = { mere: shoreOf(mere), pool: shoreOf(pool), tarn: shoreOf(tarn), sea: { x: coast.x - 6, z: coast.z }, mouth: { x: mouth.x - 14, z: 12 } };
  state.programKeys = () => renderer.info.programs.map(program => program.cacheKey);
  const settle = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
  state.job = null;
  state.startRender = (x, z, quality) => {
    const job = { done: false, result: null, error: null };
    state.job = job;
    (async () => {
      try {
        view.setQuality(quality);
        for (let i = 0; i < 2; i++) {
          view.render(frame(x, z), 1 / 60);
          settle();
          await nextTask();
        }
        counters.calls = 0;
        counters.triangles = 0;
        view.render(frame(x, z), 1 / 60);
        const pixels = new Uint8Array(64 * 64 * 4);
        gl.readPixels(${WIDTH / 2} - 32, ${HEIGHT / 2} - 32, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let brightness = 0;
        for (let i = 0; i < pixels.length; i += 4) brightness += pixels[i] + pixels[i + 1] + pixels[i + 2];
        job.result = { calls: counters.calls, triangles: Math.round(counters.triangles), programs: renderer.info.programs.length,
          brightness, contextLost: gl.isContextLost() };
      } catch (error) {
        job.error = String(error?.stack ?? error);
      }
      job.done = true;
    })();
    return true;
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

interface Render {
  calls: number;
  triangles: number;
  programs: number;
  brightness: number;
  contextLost: boolean;
}

describe.runIf(process.env.KOROVANY_WORLD_BROWSER === '1')('version 3 water in WebGL', () => {
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
        name: 'world-v3-waters-acceptance',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__world-v3-waters') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            server.transformIndexHtml('/__world-v3-waters', preview).then(html => response.end(html), next);
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('World v3 water preview server has no local URL');
    browser = await launchTestBrowser({ viewport: { width: WIDTH, height: HEIGHT } });
    cdp = await openPage(browser.port, `${origin}__world-v3-waters`, { width: WIDTH, height: HEIGHT });
    await until(cdp, 'Boolean(window.waters && (window.waters.ready || window.waters.error))', Boolean, 240_000);
    expect(await evaluate(cdp, 'window.waters.error')).toBeNull();
  }, 300_000);

  afterAll(async () => {
    cdp?.close();
    try {
      if (browser) await closeTestBrowser(browser);
    } finally {
      await server?.close();
    }
  }, 60_000);

  test('draws the Fen mere, a forest pool, a tarn, the sea and the river mouth at both qualities within budget, all water on one program', async () => {
    if (!cdp) throw new Error('World v3 water browser was not initialized');
    const places = Object.keys(await evaluate<Record<string, unknown>>(cdp, 'window.waters.places'));
    for (const quality of ['high', 'low'] as const) {
      const metrics: (Render & { place: string })[] = [];
      for (const place of places) {
        await evaluate(cdp, `(() => { const p = window.waters.places[${JSON.stringify(place)}]; return window.waters.startRender(p.x, p.z, '${quality}'); })()`);
        const job = await until<{ done: boolean; result: Render | null; error: string | null }>(cdp, 'window.waters.job', job => job.done, 240_000);
        if (job.error !== null || job.result === null) throw new Error(`${quality} ${place}: ${job.error}`);
        const stats = job.result;
        expect(stats.contextLost).toBe(false);
        expect(stats.brightness, place).toBeGreaterThan(64 * 64 * 3 * 12);
        metrics.push({ place, ...stats });
        if (captures) await screenshot(cdp, join(captures, `waters-${quality}-${place}.png`));
      }
      console.info(`World v3 water render metrics (${quality})`, JSON.stringify(metrics));
      for (const stats of metrics) {
        expect.soft(stats.calls, `${quality} ${stats.place}`).toBeLessThanOrEqual(quality === 'high' ? 450 : 250);
        expect.soft(stats.triangles, `${quality} ${stats.place}`).toBeLessThanOrEqual(quality === 'high' ? 1_500_000 : 700_000);
      }
      // The reeds and drowned trees are warmed pool parts, and the one water mesh draws from the first frame on.
      expect(new Set(metrics.map(stats => stats.programs)).size, `${quality} programs ${metrics.map(s => s.programs)}`).toBe(1);
    }
    const keys = await evaluate<string[]>(cdp, 'window.waters.programKeys()');
    // One water program per quality setting at most (the shadow variants differ between them).
    const water = keys.filter(key => key.includes('korovany-water-v3')).length;
    expect(water, 'water programs').toBeGreaterThanOrEqual(1);
    expect(water, 'water programs').toBeLessThanOrEqual(2);
    expect(keys.some(key => key.includes('frontier-water-v2')), 'the v1/v2 river program').toBe(false);
    expect(cdp.diagnostics).toEqual([]);
  }, 600_000);

  test('releases the view', async () => {
    if (!cdp) throw new Error('World v3 water browser was not initialized');
    expect(await evaluate<boolean>(cdp, 'window.waters.dispose()')).toBe(true);
  }, 60_000);
});
