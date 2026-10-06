import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import {
  evaluate, openPage, screenshot, until, type CdpSession, type LaunchedBrowser,
} from '../vendor/aegis-engine/packages/render-three/src/browser';
import { LANDMARK_IDS, LANDMARK_PLACES, PICKUP_IDS } from '../src/view/models';
import { closeTestBrowser, launchTestBrowser } from './browser-cleanup';
import { navigateTestPage } from './browser-navigation';

const harness = `<!doctype html><html><head><link rel="icon" href="data:,"><style>
html,body{margin:0;overflow:hidden;background:#151e1b}canvas{display:block}</style></head><body><canvas></canvas>
<script type="module">
import * as THREE from 'three';
import { createCampaign } from '/src/game/index.ts';
import { compileFrame, Presentation } from '/src/view/index.ts';
import { ViewResources } from '/src/view/resources.ts';
import { ModelLibrary, gltfModelSource, LANDMARK_IDS, landmarkModelFor, PICKUPS } from '/src/view/models.ts';
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
let presentation, environment, snapshot, kept;
const onePixel = new Uint8Array(4);
// WebGL returns before the GPU draws; reading one pixel charges each frame to the evaluation that drew it.
function settle() { renderer.getContext().readPixels(0, 0, 1, 1, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, onePixel); }
function render() {
  renderer.info.reset();
  presentation.update(snapshot, 1 / 60, camera.camera, false);
  renderer.render(presentation.scene, camera.camera);
  settle();
  return { calls: renderer.info.render.calls, textures: renderer.info.memory.textures, shaderErrors,
    contextLost: renderer.getContext().isContextLost() };
}
function pixels() {
  const gl = renderer.getContext();
  const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return data;
}
const hash = text => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0; return h.toString(16); };
function templateOf(id) {
  let found;
  library.get(id).scene.traverse(object => { if (object.isMesh) found ??= object; });
  return found;
}
/** The world's instanced static batches that draw a landmark (they share the library's geometry). */
function instancesOf(id) {
  const geometry = templateOf(id).geometry;
  const meshes = [];
  presentation.scene.traverse(object => { if (object.isInstancedMesh && object.geometry === geometry) meshes.push(object); });
  return meshes;
}
/** Program cache keys compiled for every landmark and pickup material so far. */
function landmarkPrograms() {
  const keys = [];
  for (const id of [...LANDMARK_IDS, ...Object.values(PICKUPS).map(pickup => pickup.id)]) {
    const programs = renderer.properties.get(templateOf(id).material).programs;
    if (programs) for (const key of programs.keys()) keys.push(id + ' #' + hash(key));
  }
  return keys.sort();
}
function aim(x, z) {
  snapshot.player.x = x; snapshot.player.z = z;
  camera.reset();
  camera.update(snapshot.player, 0);
  positionSun(presentation.sun, x, z);
}
window.propHarness = {
  state,
  /** A guard run warmed at its start exactly as the game warms it before play, then one frame there. */
  start() {
    const campaign = createCampaign({ seed: 'landmark-browser', faction: 'guard', runId: 'landmark-browser' });
    snapshot = campaign.snapshot();
    snapshot.narrative = undefined;
    snapshot.actors = [];
    presentation?.dispose();
    presentation = new Presentation(snapshot.world, new ViewResources(new THREE.TextureLoader(), 8, library), environment?.texture);
    environment ??= skyEnvironment(renderer, presentation.scenery.group);
    presentation.scene.environment = environment.texture;
    aim(snapshot.player.x, snapshot.player.z);
    presentation.update(snapshot, 1 / 60, camera.camera, false);
    const warmup = presentation.warmModels(renderer, snapshot.player.x, snapshot.player.z,
      () => compileFrame(renderer, presentation.scene, camera.camera, null));
    return { warmup, programs: landmarkPrograms(), ...render() };
  },
  get textureStatus() { return presentation?.resources.textureStatus; },
  frame() { return { programs: landmarkPrograms(), ...render() }; },
  /** Stands the hero 8 m south of a location's first landmark building, the follow camera looking north at it. */
  visit(place) {
    const building = snapshot.world.obstacles.find(o => o.id.startsWith(place + '-building-') && landmarkModelFor(place, o.variant));
    aim(building.x, building.z + 8);
    const stats = render();
    const id = landmarkModelFor(place, building.variant);
    return { ...stats, id, instances: instancesOf(id).reduce((sum, mesh) => sum + mesh.count, 0), programs: landmarkPrograms() };
  },
  /** Draws one frame with a landmark's instances shown or hidden, for keep() and changed(). */
  landmarkFrame(id, shown) {
    const meshes = instancesOf(id);
    for (const mesh of meshes) mesh.visible = shown;
    render();
    for (const mesh of meshes) mesh.visible = true;
    return true;
  },
  /** Two pickups of every kind 5-9 m in front of the hero, standing in open ground; draws one frame. */
  pickups(reducedMotion = false) {
    const kinds = Object.keys(PICKUPS);
    snapshot.pickups = kinds.flatMap((kind, index) => [0, 1].map(copy => ({
      id: 'browser-' + kind + '-' + copy, kind, amount: 1, x: snapshot.player.x - 3 + index * 3, z: snapshot.player.z - 5 - copy * 4 })));
    renderer.info.reset();
    presentation.update(snapshot, 1 / 60, camera.camera, reducedMotion);
    renderer.render(presentation.scene, camera.camera);
    settle();
    const counts = Object.fromEntries(kinds.map(kind => [kind, presentation.scene.getObjectByName(PICKUPS[kind].id + ':pickups')?.count ?? 0]));
    return { counts, programs: landmarkPrograms(), textures: renderer.info.memory.textures, shaderErrors };
  },
  /** Draws one frame with the cooked pickup pools shown or hidden, for keep() and changed(). */
  pickupFrame(shown) {
    const pools = Object.values(PICKUPS).map(pickup => presentation.scene.getObjectByName(pickup.id + ':pickups'));
    for (const pool of pools) pool.visible = shown;
    renderer.render(presentation.scene, camera.camera);
    settle();
    for (const pool of pools) pool.visible = true;
    return true;
  },
  keep() { kept = pixels(); return true; },
  changed() {
    const now = pixels();
    let count = 0;
    for (let i = 0; i < now.length; i += 4) {
      if (Math.abs(now[i] - kept[i]) + Math.abs(now[i + 1] - kept[i + 1]) + Math.abs(now[i + 2] - kept[i + 2]) > 24) count++;
    }
    return count;
  },
  setQuality(low) { presentation.setQuality(low); return true; },
  dispose() {
    presentation.dispose();
    const kept = { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
    library.dispose();
    environment.dispose();
    presentation.sun.shadow.dispose();
    const after = { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
    renderer.dispose();
    return { kept, after };
  },
};
</script></body></html>`;

describe.runIf(process.env.KOROVANY_BROWSER === '1')('cooked landmarks and pickups in the browser', () => {
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
        name: 'prop-harness',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/__props') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            vite.transformIndexHtml('/__props', harness).then(html => response.end(html), next);
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('Prop harness server has no URL');
    browser = await launchTestBrowser({ viewport: { width: 1280, height: 800 } });
    cdp = await openPage(browser.port, `${origin}__props`, { width: 1280, height: 800 });
    await until(cdp, 'Boolean(window.propHarness && (window.propHarness.state.ready || window.propHarness.state.error))', Boolean, 60_000);
    expect(await evaluate(cdp, 'window.propHarness.state.error')).toBeNull();
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

  test('warmed at the start of a run, every landmark and pickup draws with no program compiled or texture uploaded on first sight', async () => {
    if (!cdp) throw new Error('Browser was not initialized');
    const start = await evaluate<{ programs: string[]; shaderErrors: number; warmup: { programsBefore: number; programsAfter: number } }>(
      cdp, 'window.propHarness.start()');
    await until(cdp, 'window.propHarness.textureStatus.pending === 0', Boolean, 30_000);
    // Upload the world textures that finished loading, so visits measure only the landmarks' first appearance.
    const warmed = await evaluate<{ programs: string[]; textures: number; shaderErrors: number }>(cdp, 'window.propHarness.frame()');
    console.info('Prop warm-up', JSON.stringify({ warmup: start.warmup, programs: warmed.programs.length, textures: warmed.textures }));
    // Every landmark and pickup material compiled its program at warm-up (one instanced program, shared through its cache key).
    for (const id of [...LANDMARK_IDS, ...PICKUP_IDS]) expect(warmed.programs.some(key => key.startsWith(`${id} #`)), id).toBe(true);
    for (const place of Object.keys(LANDMARK_PLACES)) {
      const visit = await evaluate<{ id: string; instances: number; programs: string[]; textures: number; shaderErrors: number; contextLost: boolean }>(
        cdp, `window.propHarness.visit(${JSON.stringify(place)})`);
      expect(visit.shaderErrors, place).toBe(0);
      expect(visit.contextLost, place).toBe(false);
      expect(visit.instances, place).toBeGreaterThan(0);
      expect(visit.programs, `${place}: landmark programs after warm-up`).toEqual(warmed.programs);
      expect(visit.textures, `${place}: textures after warm-up`).toBe(warmed.textures);
      await evaluate(cdp, `window.propHarness.landmarkFrame(${JSON.stringify(visit.id)}, false) && window.propHarness.keep()`);
      await evaluate(cdp, `window.propHarness.landmarkFrame(${JSON.stringify(visit.id)}, true)`);
      expect(await evaluate<number>(cdp, 'window.propHarness.changed()'), `${place} draws ${visit.id}`).toBeGreaterThan(3000);
      if (captures) await screenshot(cdp, join(captures, `landmark-${place}.png`));
    }
    // Pickups: every kind is drawn from its cooked model on the warmed programs, uploading no texture on first sight.
    const pickups = await evaluate<{ counts: Record<string, number>; programs: string[]; textures: number; shaderErrors: number }>(
      cdp, 'window.propHarness.pickups()');
    expect(pickups.shaderErrors).toBe(0);
    expect(pickups.counts).toEqual({ coin: 2, health: 2, supply: 2 });
    expect(pickups.programs, 'pickup programs after warm-up').toEqual(warmed.programs);
    expect(pickups.textures, 'textures after warm-up').toBe(warmed.textures);
    await evaluate(cdp, 'window.propHarness.pickupFrame(false) && window.propHarness.keep()');
    await evaluate(cdp, 'window.propHarness.pickupFrame(true)');
    expect(await evaluate<number>(cdp, 'window.propHarness.changed()'), 'pickups draw').toBeGreaterThan(300);
    if (captures) await screenshot(cdp, join(captures, 'pickups.png'));
    // Low quality drops shadows and bloom but keeps the landmark, with no shader error.
    await evaluate(cdp, 'window.propHarness.setQuality(true)');
    const low = await evaluate<{ id: string; shaderErrors: number }>(cdp, "window.propHarness.visit('bell-foundry')");
    expect(low.shaderErrors).toBe(0);
    await evaluate(cdp, `window.propHarness.landmarkFrame(${JSON.stringify(low.id)}, false) && window.propHarness.keep()`);
    await evaluate(cdp, `window.propHarness.landmarkFrame(${JSON.stringify(low.id)}, true)`);
    expect(await evaluate<number>(cdp, 'window.propHarness.changed()')).toBeGreaterThan(3000);
    // The presentation releases only its own resources; the page-lifetime library owns the landmark geometry and maps.
    const disposal = await evaluate<{ kept: { geometries: number; textures: number }; after: { geometries: number; textures: number } }>(
      cdp, 'window.propHarness.dispose()');
    expect(disposal.kept.geometries).toBeGreaterThan(0);
    expect(disposal.kept.textures).toBeGreaterThan(0);
    expect(disposal.after.geometries).toBe(0);
    expect(disposal.after.textures).toBe(0);
    expect(cdp.diagnostics).toEqual([]);
  }, 240_000);

  test('stops the game with a visible asset failure, and no procedural stand-in, when a landmark is missing', async () => {
    const missing = LANDMARK_IDS[0]!;
    broken = await createServer({
      configFile: false,
      plugins: [{
        name: 'missing-landmark',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (!request.url?.includes(`/models/${missing}/${missing}.glb`)) return next();
            response.statusCode = 404;
            response.end('missing for test');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await broken.listen();
    const origin = broken.resolvedUrls?.local[0];
    if (!origin || !browser) throw new Error('Missing-landmark server has no URL');
    const page = await openPage(browser.port, 'about:blank', { width: 1024, height: 700 });
    try {
      await navigateTestPage(page, origin, "window.korovany && window.korovany.inspect().overlay === 'fatal'", 60_000);
      const state = await evaluate<{ overlay: string; running: boolean; models: { error: string | null } }>(page, 'window.korovany.inspect()');
      expect(state.overlay).toBe('fatal');
      expect(state.running).toBe(false);
      expect(state.models.error).toContain(`models/${missing}/${missing}.glb`);
      expect(page.diagnostics.some(entry => /status of 404/.test(entry)), JSON.stringify(page.diagnostics)).toBe(true);
      expect(page.diagnostics.filter(entry => entry.startsWith('uncaught'))).toEqual([]);
    } finally {
      page.close();
    }
  }, 90_000);
});
