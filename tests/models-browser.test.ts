import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import {
  evaluate, launchBrowser, openPage, screenshot, until, type CdpSession, type LaunchedBrowser,
} from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeTestBrowser } from './browser-cleanup';
import { navigateTestPage } from './browser-navigation';

const harness = `<!doctype html><html><head><link rel="icon" href="data:,"><style>
html,body{margin:0;overflow:hidden;background:#151e1b}canvas{display:block}</style></head><body><canvas></canvas>
<script type="module">
import * as THREE from 'three';
import { createCampaign } from '/src/game/index.ts';
import { Presentation } from '/src/view/index.ts';
import { ViewResources } from '/src/view/resources.ts';
import { ModelLibrary, gltfModelSource } from '/src/view/models.ts';
import { FollowCamera } from '/src/view/camera.ts';
import { positionSun, skyEnvironment } from '/src/view/atmosphere.ts';
const canvas = document.querySelector('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false;
let shaderErrors = 0;
renderer.debug.onShaderError = () => { shaderErrors++; };
const library = new ModelLibrary(gltfModelSource());
const state = { ready: false, error: null };
library.ready.then(() => { state.ready = true; }, error => { state.error = String(error.message ?? error); });
const camera = new FollowCamera(canvas);
camera.resize(innerWidth, innerHeight);
let presentation, environment, snapshot, soldierTemplate;
function texturesOf(root) {
  const found = new Map();
  root.traverse(object => {
    if (!object.isMesh) return;
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
      const texture = object.material[key];
      if (texture) found.set(texture.uuid, { key, texture, material: object.material.name });
    }
  });
  return [...found.values()];
}
function decode({ key, texture, material }) {
  const image = texture.image;
  const probe = document.createElement('canvas');
  probe.width = image.width; probe.height = image.height;
  const context = probe.getContext('2d');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, probe.width, probe.height).data;
  let low = 255, high = 0, alphaLow = 255, alphaHigh = 0;
  for (let i = 0; i < data.length; i += 4) {
    low = Math.min(low, data[i + 1]); high = Math.max(high, data[i + 1]);
    alphaLow = Math.min(alphaLow, data[i + 3]); alphaHigh = Math.max(alphaHigh, data[i + 3]);
  }
  return { key, material, width: image.width, height: image.height, range: high - low, alphaRange: alphaHigh - alphaLow,
    colorSpace: texture.colorSpace };
}
function render() {
  renderer.info.reset();
  presentation.update(snapshot, 1 / 60, camera.camera, false);
  renderer.render(presentation.scene, camera.camera);
  const gl = renderer.getContext();
  return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs.length,
    geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, shaderErrors, contextLost: gl.isContextLost() };
}
function pixels() {
  const gl = renderer.getContext();
  const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
  const data = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return data;
}
window.modelHarness = {
  state,
  textures() {
    return ['char-line-soldier', 'prop-echo-well'].flatMap(id => texturesOf(library.get(id).scene).map(entry => ({ id, ...decode(entry) })));
  },
  open(place, warm = true) {
    const campaign = createCampaign({ seed: 'model-browser', faction: 'guard', runId: 'model-browser' });
    snapshot = campaign.snapshot();
    snapshot.narrative = undefined;
    soldierTemplate = structuredClone(snapshot.actors.find(actor => actor.kind === 'soldier'));
    // No soldier is on screen until scene() adds them, so first-appearance program growth is measurable.
    snapshot.actors = snapshot.actors.filter(actor => actor.kind !== 'soldier');
    if (place) {
      const location = snapshot.world.exploration.locations.find(candidate => candidate.id === place);
      snapshot.player.x = location.x; snapshot.player.z = location.z - 9;
    }
    presentation?.dispose();
    presentation = new Presentation(snapshot.world, new ViewResources(new THREE.TextureLoader(), 8, library), environment?.texture);
    environment ??= skyEnvironment(renderer, presentation.scenery.group);
    presentation.scene.environment = environment.texture;
    camera.reset();
    camera.update(snapshot.player, 0);
    positionSun(presentation.sun, snapshot.player.x, snapshot.player.z);
    let warmup = null;
    if (warm) {
      presentation.update(snapshot, 1 / 60, camera.camera, false);
      warmup = presentation.warmModels(renderer, snapshot.player.x, snapshot.player.z,
        () => renderer.render(presentation.scene, camera.camera));
    }
    return { ...render(), warmup };
  },
  get textureStatus() { return presentation?.resources.textureStatus; },
  programs() {
    const hash = text => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0; return h.toString(16); };
    return (renderer.info.programs ?? []).map(program => program.name + ' #' + hash(program.cacheKey) + ' ' +
      (program.cacheKey.startsWith('depth') ? program.cacheKey.replace(/\s+/g, ' ') : program.cacheKey.replace(/\s+/g, ' ').slice(0, 120)));
  },
  scene(soldiers) {
    const template = soldierTemplate;
    snapshot.actors = snapshot.actors.filter(actor => actor.kind !== 'soldier');
    const layout = [['elf','hostile','windup'],['guard','friendly','idle'],['villain','hostile','attack'],['villain','friendly','chase'],['guard','neutral','dead']];
    for (let index = 0; index < soldiers; index++) {
      const [faction, allegiance, state] = layout[index % layout.length];
      snapshot.actors.push({ ...structuredClone(template), id: 'browser-soldier-' + index, faction, allegiance, state,
        stateTime: 0.2, hp: state === 'dead' ? 0 : template.maxHp * 0.7,
        x: snapshot.player.x - 4 + index * 2, z: snapshot.player.z + 5 + (index % 2), heading: Math.PI });
    }
    const first = performance.now();
    renderer.info.reset();
    presentation.update(snapshot, 1 / 60, camera.camera, false);
    const updated = performance.now();
    renderer.render(presentation.scene, camera.camera);
    const gl = renderer.getContext();
    gl.finish();
    const stats = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs.length,
      geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, shaderErrors, contextLost: gl.isContextLost() };
    stats.firstUpdateMs = updated - first;
    stats.firstFrameMs = performance.now() - first;
    const again = performance.now();
    render();
    stats.secondFrameMs = performance.now() - again;
    return stats;
  },
  difference(soldiers) {
    this.scene(0);
    const empty = pixels();
    this.scene(soldiers);
    const full = pixels();
    let changed = 0;
    for (let i = 0; i < empty.length; i += 4) {
      if (Math.abs(empty[i] - full[i]) + Math.abs(empty[i + 1] - full[i + 1]) + Math.abs(empty[i + 2] - full[i + 2]) > 24) changed++;
    }
    return changed;
  },
  dispose() {
    const before = { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
    presentation.dispose();
    library.dispose();
    environment.dispose();
    presentation.sun.shadow.dispose();
    const after = { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs.length };
    renderer.dispose();
    return { before, after };
  },
};
</script></body></html>`;

describe.runIf(process.env.KOROVANY_BROWSER === '1')('cooked models in the browser', () => {
  let server: ViteDevServer | undefined;
  let broken: ViteDevServer | undefined;
  let browser: LaunchedBrowser | undefined;
  let cdp: CdpSession | undefined;
  const captures = process.env.KOROVANY_CAPTURE_DIR;

  beforeAll(async () => {
    if (captures) await mkdir(captures, { recursive: true });
    server = await createServer({
      configFile: false,
      optimizeDeps: { include: ['three'] },
      plugins: [{
        name: 'model-harness',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/__models') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            vite.transformIndexHtml('/__models', harness).then(html => response.end(html), next);
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('Model harness server has no URL');
    browser = await launchBrowser({ viewport: { width: 1280, height: 800 } });
    cdp = await openPage(browser.port, `${origin}__models`, { width: 1280, height: 800 });
    await until(cdp, 'Boolean(window.modelHarness && (window.modelHarness.state.ready || window.modelHarness.state.error))', Boolean, 60_000);
    expect(await evaluate(cdp, 'window.modelHarness.state.error')).toBeNull();
  }, 90_000);

  afterAll(async () => {
    cdp?.close();
    try {
      if (browser) await closeTestBrowser(browser);
    } finally {
      await server?.close();
      await broken?.close();
    }
  }, 60_000);

  test('decodes every shipped texture and renders dyed soldiers and the Echo Well through the game presenter', async () => {
    if (!cdp) throw new Error('Browser was not initialized');
    const textures = await evaluate<{ id: string; key: string; material: string; width: number; height: number; range: number; alphaRange: number }[]>(
      cdp, 'window.modelHarness.textures()');
    expect(textures.length).toBeGreaterThanOrEqual(6);
    for (const texture of textures) {
      expect(texture.width, `${texture.id}:${texture.key}`).toBeGreaterThanOrEqual(256);
      expect(texture.range, `${texture.id}:${texture.key}`).toBeGreaterThan(8);
    }
    expect(textures.find(texture => texture.id === 'char-line-soldier' && texture.key === 'map' && texture.material === 'body')?.alphaRange)
      .toBeGreaterThan(128);
    const base = await evaluate<{ programs: number; shaderErrors: number; warmup: { programsBefore: number; programsAfter: number; milliseconds: number } }>(
      cdp, 'window.modelHarness.open()');
    await until(cdp, 'window.modelHarness.textureStatus.pending === 0', Boolean, 30_000);
    // Upload the world textures that finished loading, so the next frame measures only a soldier's first appearance.
    await evaluate(cdp, 'window.modelHarness.scene(0) && 0');
    const warmed = await evaluate<string[]>(cdp, 'window.modelHarness.programs()');
    const first = await evaluate<{ programs: number; shaderErrors: number; calls: number; firstFrameMs: number; secondFrameMs: number }>(
      cdp, 'window.modelHarness.scene(1)');
    const created = (await evaluate<string[]>(cdp, 'window.modelHarness.programs()')).filter(name => !warmed.includes(name));
    const all = await evaluate<{ programs: number; shaderErrors: number; calls: number; contextLost: boolean }>(cdp, 'window.modelHarness.scene(10)');
    console.info('Model program growth after warm-up', JSON.stringify({ warmup: base.warmup, base: base.programs, oneSoldier: first.programs,
      tenSoldiers: all.programs, firstFrameMs: first.firstFrameMs, firstUpdateMs: (first as unknown as { firstUpdateMs: number }).firstUpdateMs, secondFrameMs: first.secondFrameMs, calls: all.calls }));
    expect(all.contextLost).toBe(false);
    expect(all.shaderErrors).toBe(0);
    // Warmed at load: no program is created when the first soldier appears, and every faction, allegiance, corpse
    // and telegraphed state shares those programs.
    expect(created, 'programs created on first appearance').toEqual([]);
    expect(first.programs).toBe(base.programs);
    expect(all.programs).toBe(base.programs);
    expect(await evaluate<number>(cdp, 'window.modelHarness.difference(5)')).toBeGreaterThan(2000);
    if (captures) await screenshot(cdp, join(captures, 'model-soldiers.png'));
    const well = await evaluate<{ shaderErrors: number }>(cdp, "window.modelHarness.open('name-well')");
    await until(cdp, 'window.modelHarness.textureStatus.pending === 0', Boolean, 30_000);
    expect(well.shaderErrors).toBe(0);
    if (captures) await screenshot(cdp, join(captures, 'model-echo-well.png'));
    const disposal = await evaluate<{ before: { geometries: number; textures: number }; after: { geometries: number; textures: number } }>(
      cdp, 'window.modelHarness.dispose()');
    expect(disposal.after.geometries).toBe(0);
    expect(disposal.after.textures).toBe(0);
    expect(cdp.diagnostics).toEqual([]);
  }, 120_000);

  test('a disabled-warming control creates the model programs on first appearance instead, within the program budget', async () => {
    if (!browser || !server) throw new Error('Browser was not initialized');
    const origin = server.resolvedUrls?.local[0];
    // A fresh page is a fresh renderer and program cache.
    const page = await openPage(browser.port, `${origin}__models`, { width: 1280, height: 800 });
    try {
      await until(page, 'Boolean(window.modelHarness && (window.modelHarness.state.ready || window.modelHarness.state.error))', Boolean, 60_000);
      const base = await evaluate<{ programs: number }>(page, 'window.modelHarness.open(undefined, false)');
      await until(page, 'window.modelHarness.textureStatus.pending === 0', Boolean, 30_000);
      const before = await evaluate<string[]>(page, 'window.modelHarness.programs()');
      const first = await evaluate<{ programs: number; shaderErrors: number; firstFrameMs: number }>(page, 'window.modelHarness.scene(1)');
      const created = (await evaluate<string[]>(page, 'window.modelHarness.programs()')).filter(name => !before.includes(name));
      const all = await evaluate<{ programs: number }>(page, 'window.modelHarness.scene(10)');
      console.info('Model program growth without warm-up', JSON.stringify({ base: base.programs, oneSoldier: first.programs, tenSoldiers: all.programs,
        firstFrameMs: first.firstFrameMs, created: created.map(name => name.slice(0, 60)) }));
      expect(first.shaderErrors).toBe(0);
      // Measured without warm-up: the dyed body and items programs, four shadow-depth variants and the shared unlit
      // health-bar program appear with the first soldier. The load-time warm-up compiles all of them before gameplay.
      expect(first.programs - base.programs).toBeGreaterThan(0);
      expect(first.programs - base.programs).toBeLessThanOrEqual(7);
      expect(all.programs).toBe(first.programs);
      await evaluate(page, 'window.modelHarness.dispose()');
    } finally {
      page.close();
    }
  }, 120_000);

  test('stops with a visible asset failure, and no procedural stand-in, when a model file is missing', async () => {
    broken = await createServer({
      configFile: false,
      plugins: [{
        name: 'missing-model',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (!request.url?.includes('/models/char-line-soldier/char-line-soldier.glb')) return next();
            response.statusCode = 404;
            response.end('missing for test');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await broken.listen();
    const origin = broken.resolvedUrls?.local[0];
    if (!origin || !browser) throw new Error('Missing-model server has no URL');
    const page = await openPage(browser.port, 'about:blank', { width: 1024, height: 700 });
    try {
      await navigateTestPage(page, origin, "window.korovany && window.korovany.inspect().overlay === 'fatal'", 60_000);
      const state = await evaluate<{ overlay: string; running: boolean; models: { error: string | null; loaded: number } }>(
        page, 'window.korovany.inspect()');
      expect(state.overlay).toBe('fatal');
      expect(state.running).toBe(false);
      expect(state.models.error).toMatch(/models\/char-line-soldier\/char-line-soldier\.glb/);
      const heading = await evaluate<string>(page, "document.querySelector('.fatal-panel h2, .fatal-panel h1')?.textContent ?? ''");
      expect(heading).toMatch(/3D models|трёхмерные модели/);
      // The missing file was requested and the failure was handled: the browser logged the 404, nothing threw uncaught.
      expect(page.diagnostics.some(entry => /status of 404/.test(entry)), JSON.stringify(page.diagnostics)).toBe(true);
      expect(page.diagnostics.filter(entry => entry.startsWith('uncaught'))).toEqual([]);
      if (captures) await screenshot(page, join(captures, 'model-missing.png'));
    } finally {
      page.close();
    }
  }, 90_000);
});
