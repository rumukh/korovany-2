import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import {
  evaluate, launchBrowser, openPage, screenshot, until, type CdpSession, type LaunchedBrowser,
} from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeTestBrowser } from './browser-cleanup';

const WIDTH = 1280, HEIGHT = 720;

const preview = `<!doctype html><html><head><link rel="icon" href="data:,"><style>
html,body {margin:0;overflow:hidden;background:#000} canvas {display:block;width:${WIDTH}px;height:${HEIGHT}px}
</style></head><body><canvas id="view" width="${WIDTH}" height="${HEIGHT}"></canvas><script type="module">
import * as THREE from 'three';
import { createCampaign } from '/src/game/index.ts';
import { createGameView, createRenderer, Presentation } from '/src/view/index.ts';
import { campaignModelIds, gltfModelSource, ModelLibrary } from '/src/view/models.ts';
import { ViewResources } from '/src/view/resources.ts';
import { FollowCamera } from '/src/view/camera.ts';
import { gltfWorldSource, WorldAssetLibrary, worldAssetIds } from '/src/view/world-assets.ts';
const state = { ready: false, error: null };
window.v3 = state;
try {
  const campaign = createCampaign({ seed: 'world-v3-browser', faction: 'elf', runId: 'world-v3', worldVersion: 3 });
  const base = campaign.snapshot();
  const models = new ModelLibrary(gltfModelSource(), campaignModelIds(base));
  const worldAssets = new WorldAssetLibrary(gltfWorldSource());
  const loading = worldAssets.request(worldAssetIds(base.world));
  const canvas = document.getElementById('view');
  // The view's own context (same attributes as createRenderer), with draw calls counted.
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
  const view = createGameView(canvas, base.world, { quality: 'high', reducedMotion: true, models, worldAssets, renderer });
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
  const place = id => base.world.exploration.locations.find(location => location.id === id);
  state.places = {
    home: { x: base.player.x, z: base.player.z }, greenhollow: place('greenhollow'), village: place('hollow-village'),
    crownbridge: place('crownbridge'), forest: { x: -230, z: -372 }, road: { x: 0, z: -110 },
  };
  state.renderAt = (x, z, quality) => {
    view.setQuality(quality);
    for (let i = 0; i < 2; i++) view.render(frame(x, z), 1 / 60);
    counters.calls = 0;
    counters.triangles = 0;
    view.render(frame(x, z), 1 / 60);
    const pixels = new Uint8Array(64 * 64 * 4);
    gl.readPixels(${WIDTH / 2} - 32, ${HEIGHT / 2} - 32, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let brightness = 0;
    for (let i = 0; i < pixels.length; i += 4) brightness += pixels[i] + pixels[i + 1] + pixels[i + 2];
    return { calls: counters.calls, triangles: Math.round(counters.triangles), programs: renderer.info.programs.length,
      brightness, contextLost: gl.isContextLost(), warmup: view.warmup };
  };

  // The camera-to-hero cutaway through a v3 house, measured on a separate Presentation with plain rendering.
  state.cutaway = () => {
    const cutCanvas = document.createElement('canvas');
    cutCanvas.width = 720; cutCanvas.height = 500;
    const cutRenderer = new THREE.WebGLRenderer({ canvas: cutCanvas, antialias: false, preserveDrawingBuffer: true });
    cutRenderer.setPixelRatio(1);
    cutRenderer.setSize(720, 500, false);
    cutRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    const resources = new ViewResources(new THREE.TextureLoader(), 1, models, worldAssets);
    const presentation = new Presentation(base.world, resources);
    try {
      const house = base.world.obstacles.find(o => o.model === 'kit-cottage-a' || o.model === 'kit-cottage-b');
      const reach = Math.max(house.shape.halfX, house.shape.halfZ);
      const hero = { x: house.x, z: house.z + reach + 1.6 };
      const camera = new FollowCamera(cutCanvas);
      camera.resize(720, 500);
      const snapshot = frame(hero.x, hero.z);
      snapshot.actors = snapshot.actors.filter(actor => Math.hypot(actor.x - hero.x, actor.z - hero.z) > 30);
      camera.update(hero, 0, presentation.terrain.height(hero.x, hero.z));
      presentation.update(snapshot, 1 / 60, camera.camera, true);
      const read = () => {
        cutRenderer.render(presentation.scene, camera.camera);
        const pixels = new Uint8Array(720 * 500 * 4);
        const context = cutRenderer.getContext();
        context.readPixels(0, 0, 720, 500, context.RGBA, context.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const kitPools = [];
      presentation.scene.traverse(object => { if (object.isInstancedMesh && object.material.name === 'world-kit') kitPools.push(object); });
      const withCutaway = read();
      const plain = new Map(kitPools.map(pool => [pool, pool.material]));
      const opaque = kitPools[0].material.clone();
      for (const pool of kitPools) pool.material = opaque;
      const withoutCutaway = read();
      for (const [pool, material] of plain) pool.material = material;
      // Hero pixels: the hero alone over black, unlit white.
      const heroRoot = presentation.scene.children.find(child => child.isGroup && child.getObjectByProperty('isSkinnedMesh', true)
        && Math.hypot(child.position.x - hero.x, child.position.z - hero.z) < 0.01);
      const keep = new Set();
      heroRoot.traverse(object => keep.add(object));
      const hidden = [];
      presentation.scene.traverseVisible(object => { if ((object.isMesh || object.isPoints || object.isLine || object.isSprite) && !keep.has(object)) hidden.push(object); });
      for (const object of hidden) object.visible = false;
      const background = presentation.scene.background, fog = presentation.scene.fog;
      presentation.scene.background = new THREE.Color('#000000');
      presentation.scene.fog = null;
      const alone = read();
      presentation.scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' });
      cutRenderer.toneMapping = THREE.NoToneMapping;
      const mask = read();
      presentation.scene.overrideMaterial = null;
      presentation.scene.background = background;
      presentation.scene.fog = fog;
      for (const object of hidden) object.visible = true;
      let heroPixels = 0, visibleWith = 0, visibleWithout = 0;
      for (let i = 0; i < 720 * 500; i++) {
        if (mask[i * 4] < 250) continue;
        heroPixels++;
        const near = frame => Math.max(...[0, 1, 2].map(c => Math.abs(frame[i * 4 + c] - alone[i * 4 + c]))) <= 24;
        if (near(withCutaway)) visibleWith++;
        if (near(withoutCutaway)) visibleWithout++;
      }
      return { heroPixels, visibleWith: visibleWith / heroPixels, visibleWithout: visibleWithout / heroPixels };
    } finally {
      presentation.dispose();
      cutRenderer.dispose();
    }
  };

  // A missing world model stops the view with an explicit asset error; there is no primitive fallback.
  state.missingAsset = async () => {
    const failing = new WorldAssetLibrary({ ...gltfWorldSource(), model: id => Promise.reject(new Error('HTTP 404 ' + id)) });
    await failing.request(['kit-barn']).catch(() => undefined);
    const canvas2 = document.createElement('canvas');
    canvas2.width = 64; canvas2.height = 64;
    const broken = createGameView(canvas2, base.world, { quality: 'low', reducedMotion: true, models, worldAssets: failing });
    try {
      broken.render(frame(base.player.x, base.player.z), 1 / 60);
      return 'rendered';
    } catch (error) {
      return String(error.message);
    } finally {
      broken.dispose();
      failing.dispose();
    }
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

describe.runIf(process.env.KOROVANY_WORLD_BROWSER === '1')('version 3 world WebGL presentation', () => {
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
        name: 'world-v3-acceptance',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__world-v3') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            server.transformIndexHtml('/__world-v3', preview).then(html => response.end(html), next);
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('World v3 preview server has no local URL');
    browser = await launchBrowser({ viewport: { width: WIDTH, height: HEIGHT } });
    cdp = await openPage(browser.port, `${origin}__world-v3`, { width: WIDTH, height: HEIGHT });
    await until(cdp, 'Boolean(window.v3 && (window.v3.ready || window.v3.error))', Boolean, 240_000);
    expect(await evaluate(cdp, 'window.v3.error')).toBeNull();
  }, 300_000);

  afterAll(async () => {
    cdp?.close();
    try {
      if (browser) await closeTestBrowser(browser);
    } finally {
      await server?.close();
    }
  }, 60_000);

  test('draws villages, forest and road at both qualities within budget, compiling no program after the first frame', async () => {
    if (!cdp) throw new Error('World v3 browser was not initialized');
    const places = Object.keys(await evaluate<Record<string, unknown>>(cdp, 'window.v3.places'));
    for (const quality of ['high', 'low'] as const) {
      const metrics: (Render & { place: string })[] = [];
      for (const place of places) {
        const stats = await evaluate<Render>(cdp,
          `(() => { const p = window.v3.places[${JSON.stringify(place)}]; return window.v3.renderAt(p.x, p.z, '${quality}'); })()`);
        expect(stats.contextLost).toBe(false);
        expect(stats.brightness, place).toBeGreaterThan(64 * 64 * 3 * 12);
        metrics.push({ place, ...stats });
        if (captures) await screenshot(cdp, join(captures, `v3-${quality}-${place}.png`));
      }
      console.info(`World v3 render metrics (${quality})`, JSON.stringify(metrics));
      for (const stats of metrics) {
        expect.soft(stats.calls, `${quality} ${stats.place}`).toBeLessThanOrEqual(quality === 'high' ? 450 : 250);
        expect.soft(stats.triangles, `${quality} ${stats.place}`).toBeLessThanOrEqual(quality === 'high' ? 1_500_000 : 700_000);
      }
      // Every program a place needs exists after the first frame at this quality (the load-time warm-up compiles every pooled
      // part, including species, impostors and props not yet in view): visiting every place compiles nothing new (aegis-engine #6).
      expect(new Set(metrics.map(stats => stats.programs)).size, `${quality} programs ${metrics.map(s => s.programs)}`).toBe(1);
    }
    expect(cdp.diagnostics).toEqual([]);
  }, 600_000);

  test('the camera-to-hero cutaway reveals the hero through a v3 house that hides it without the cutaway', async () => {
    if (!cdp) throw new Error('World v3 browser was not initialized');
    const result = await evaluate<{ heroPixels: number; visibleWith: number; visibleWithout: number }>(cdp, 'window.v3.cutaway()');
    console.info('World v3 cutaway', JSON.stringify(result));
    expect(result.heroPixels).toBeGreaterThan(300);
    expect(result.visibleWithout).toBeLessThan(0.3);
    expect(result.visibleWith).toBeGreaterThan(0.85);
    expect(cdp.diagnostics).toEqual([]);
  }, 120_000);

  test('a missing world model stops the view with an explicit asset error', async () => {
    if (!cdp) throw new Error('World v3 browser was not initialized');
    const message = await evaluate<string>(cdp, 'window.v3.missingAsset()');
    expect(message).toMatch(/Could not load world model .*kit-barn\.glb: HTTP 404 kit-barn/);
    expect(await evaluate<boolean>(cdp, 'window.v3.dispose()')).toBe(true);
  }, 120_000);
});
