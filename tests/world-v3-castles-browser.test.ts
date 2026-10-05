import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import {
  evaluate, launchBrowser, openPage, screenshot, until, type CdpSession, type LaunchedBrowser,
} from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeTestBrowser } from './browser-cleanup';

const WIDTH = 1280, HEIGHT = 720;

// A villain campaign: the Royal Citadel is the final arena and the Old Fort is home.
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
window.castles = state;
try {
  const campaign = createCampaign({ seed: 'world-v3-castles', faction: 'villain', runId: 'world-v3-castles', worldVersion: 3 });
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
  const place = id => world.exploration.locations.find(location => location.id === id);
  const citadel = place('palace-citadel');
  const skull = world.obstacles.find(o => o.model === 'prop-giant-skull');
  state.places = {
    courtyard: { x: citadel.x, z: citadel.z }, gate: { x: citadel.x, z: citadel.z - 45 }, 'old-fort': place('old-fort'),
    thornwatch: place('thornwatch'), remains: { x: skull.x + skull.radius + 4, z: skull.z },
  };
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

  // The hero stands behind an occluder (a citadel curtain or a cooked landmark) with the camera on the far side; the
  // hero's pixels are compared with and without the sightline cutaway, on a separate Presentation with plain rendering.
  const cutaway = async target => {
    const cutCanvas = document.createElement('canvas');
    cutCanvas.width = 720; cutCanvas.height = 500;
    const cutRenderer = new THREE.WebGLRenderer({ canvas: cutCanvas, antialias: false, preserveDrawingBuffer: true });
    cutRenderer.setPixelRatio(1);
    cutRenderer.setSize(720, 500, false);
    cutRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    const resources = new ViewResources(new THREE.TextureLoader(), 1, models, worldAssets);
    const presentation = new Presentation(world, resources);
    try {
      const occluder = world.obstacles.find(o => o.id === target);
      if (!occluder) throw new Error('no occluder ' + target);
      let inward, behind;
      if (occluder.shape) {
        // A curtain run: the hero stands 7 m inside it, the camera outside.
        const d = Math.hypot(citadel.x - occluder.x, citadel.z - occluder.z);
        inward = { x: (citadel.x - occluder.x) / d, z: (citadel.z - occluder.z) / d };
        behind = 7;
      } else {
        inward = { x: 0, z: 1 };
        behind = occluder.radius + 0.9;
      }
      const hero = { x: occluder.x + inward.x * behind, z: occluder.z + inward.z * behind };
      const camera = new FollowCamera(cutCanvas);
      camera.resize(720, 500);
      // The camera sits at the focus plus (sin yaw, cos yaw) times its horizontal distance: put it on the far side.
      camera.orbit(Math.atan2(-inward.x, -inward.z) - Math.PI);
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
      // Occluders with the cutaway: the scripted kit's pools and the cooked landmarks' static batches.
      const occluders = [];
      presentation.scene.traverse(object => {
        if (!object.isInstancedMesh) return;
        let parent = object.parent, structure = false;
        while (parent) { if (parent.name.startsWith('world-structures')) structure = true; parent = parent.parent; }
        if (object.material.name === 'world-kit' || structure) occluders.push(object);
      });
      const withCutaway = read();
      await nextTask();
      const plain = new Map(occluders.map(mesh => [mesh, mesh.material]));
      const opaque = new Map();
      for (const mesh of occluders) {
        if (!opaque.has(mesh.material)) opaque.set(mesh.material, mesh.material.clone());
        mesh.material = opaque.get(mesh.material);
      }
      const withoutCutaway = read();
      await nextTask();
      for (const [mesh, material] of plain) mesh.material = material;
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
      await nextTask();
      presentation.scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' });
      cutRenderer.toneMapping = THREE.NoToneMapping;
      const mask = read();
      presentation.scene.overrideMaterial = null;
      presentation.scene.background = background;
      presentation.scene.fog = fog;
      for (const object of hidden) object.visible = true;
      for (const material of opaque.values()) material.dispose();
      let heroPixels = 0, visibleWith = 0, visibleWithout = 0;
      for (let i = 0; i < 720 * 500; i++) {
        if (mask[i * 4] < 250) continue;
        heroPixels++;
        const near = frame => Math.max(...[0, 1, 2].map(c => Math.abs(frame[i * 4 + c] - alone[i * 4 + c]))) <= 24;
        if (near(withCutaway)) visibleWith++;
        if (near(withoutCutaway)) visibleWithout++;
      }
      return { target, heroPixels, visibleWith: visibleWith / heroPixels, visibleWithout: visibleWithout / heroPixels };
    } finally {
      presentation.dispose();
      cutRenderer.dispose();
    }
  };
  state.cutawayJob = null;
  state.startCutaway = target => {
    const job = { done: false, result: null, error: null };
    state.cutawayJob = job;
    cutaway(target).then(result => { job.result = result; }, error => { job.error = String(error?.stack ?? error); })
      .finally(() => { job.done = true; });
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

describe.runIf(process.env.KOROVANY_WORLD_BROWSER === '1')('version 3 castles, ruins and remains in WebGL', () => {
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
        name: 'world-v3-castles-acceptance',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__world-v3-castles') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            server.transformIndexHtml('/__world-v3-castles', preview).then(html => response.end(html), next);
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('World v3 castle preview server has no local URL');
    browser = await launchBrowser({ viewport: { width: WIDTH, height: HEIGHT } });
    cdp = await openPage(browser.port, `${origin}__world-v3-castles`, { width: WIDTH, height: HEIGHT });
    await until(cdp, 'Boolean(window.castles && (window.castles.ready || window.castles.error))', Boolean, 240_000);
    expect(await evaluate(cdp, 'window.castles.error')).toBeNull();
  }, 300_000);

  afterAll(async () => {
    cdp?.close();
    try {
      if (browser) await closeTestBrowser(browser);
    } finally {
      await server?.close();
    }
  }, 60_000);

  test('draws the citadel, the Old Fort, a ruin and remains at both qualities within budget, compiling no program after the first frame', async () => {
    if (!cdp) throw new Error('World v3 castle browser was not initialized');
    const places = Object.keys(await evaluate<Record<string, unknown>>(cdp, 'window.castles.places'));
    for (const quality of ['high', 'low'] as const) {
      const metrics: (Render & { place: string })[] = [];
      for (const place of places) {
        await evaluate(cdp, `(() => { const p = window.castles.places[${JSON.stringify(place)}]; return window.castles.startRender(p.x, p.z, '${quality}'); })()`);
        const job = await until<{ done: boolean; result: Render | null; error: string | null }>(cdp, 'window.castles.job', job => job.done, 240_000);
        if (job.error !== null || job.result === null) throw new Error(`${quality} ${place}: ${job.error}`);
        const stats = job.result;
        expect(stats.contextLost).toBe(false);
        expect(stats.brightness, place).toBeGreaterThan(64 * 64 * 3 * 12);
        metrics.push({ place, ...stats });
        if (captures) await screenshot(cdp, join(captures, `castles-${quality}-${place}.png`));
      }
      console.info(`World v3 castle render metrics (${quality})`, JSON.stringify(metrics));
      for (const stats of metrics) {
        expect.soft(stats.calls, `${quality} ${stats.place}`).toBeLessThanOrEqual(quality === 'high' ? 450 : 250);
        expect.soft(stats.triangles, `${quality} ${stats.place}`).toBeLessThanOrEqual(quality === 'high' ? 1_500_000 : 700_000);
      }
      // The load-time warm-up compiled every pooled part, the gate arches and the remains included (aegis-engine #6).
      expect(new Set(metrics.map(stats => stats.programs)).size, `${quality} programs ${metrics.map(s => s.programs)}`).toBe(1);
    }
    expect(cdp.diagnostics).toEqual([]);
  }, 600_000);

  test.each(['palace-citadel-curtain-4', 'ash-cairn-building-0'])('the camera-to-hero cutaway reveals the hero behind %s', async target => {
    if (!cdp) throw new Error('World v3 castle browser was not initialized');
    await evaluate(cdp, `window.castles.startCutaway(${JSON.stringify(target)})`);
    const job = await until<{ done: boolean; result: { heroPixels: number; visibleWith: number; visibleWithout: number } | null; error: string | null }>(
      cdp, 'window.castles.cutawayJob', job => job.done, 100_000);
    if (job.error !== null || job.result === null) throw new Error(`cutaway ${target}: ${job.error}`);
    const result = job.result;
    console.info('World v3 castle cutaway', JSON.stringify(result));
    expect(result.heroPixels).toBeGreaterThan(300);
    expect(result.visibleWithout).toBeLessThan(0.3);
    expect(result.visibleWith).toBeGreaterThan(0.85);
    expect(cdp.diagnostics).toEqual([]);
  }, 120_000);

  test('releases the view', async () => {
    if (!cdp) throw new Error('World v3 castle browser was not initialized');
    expect(await evaluate<boolean>(cdp, 'window.castles.dispose()')).toBe(true);
  }, 60_000);
});
