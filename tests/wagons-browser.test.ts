import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import {
  evaluate, openPage, screenshot, until, type CdpSession, type LaunchedBrowser,
} from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeTestBrowser, launchTestBrowser } from './browser-cleanup';
import { navigateTestPage } from './browser-navigation';

const harness = `<!doctype html><html><head><link rel="icon" href="data:,"><style>
html,body{margin:0;overflow:hidden;background:#151e1b}canvas{display:block}</style></head><body><canvas></canvas>
<script type="module">
import * as THREE from 'three';
import { createCampaign } from '/src/game/index.ts';
import { compileFrame, Presentation } from '/src/view/index.ts';
import { ViewResources } from '/src/view/resources.ts';
import { ModelLibrary, gltfModelSource } from '/src/view/models.ts';
import { FollowCamera } from '/src/view/camera.ts';
import { positionSun, skyEnvironment } from '/src/view/atmosphere.ts';
const WAGON_MODELS = ['prop-wagon-convoy', 'prop-wagon-shipment', 'char-draft-ox', 'prop-cargo-load'];
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
let presentation, environment, snapshot, shipment, kept;
const probe = document.createElement('canvas').getContext('webgl2');
function decode(id, key, texture) {
  const image = texture.image;
  const gl = probe;
  const handle = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, handle);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, handle, 0);
  const data = new Uint8Array(image.width * image.height * 4);
  gl.readPixels(0, 0, image.width, image.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.deleteFramebuffer(framebuffer);
  gl.deleteTexture(handle);
  let low = 255, high = 0;
  for (let i = 0; i < data.length; i += 4) { low = Math.min(low, data[i + 1]); high = Math.max(high, data[i + 1]); }
  return { id, key, width: image.width, height: image.height, range: high - low };
}
const onePixel = new Uint8Array(4);
function settle() {
  renderer.getContext().readPixels(0, 0, 1, 1, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, onePixel);
}
function pixels() {
  const gl = renderer.getContext();
  const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return data;
}
function draw() {
  renderer.info.reset();
  renderer.render(presentation.scene, camera.camera);
  settle();
  return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs.length,
    shaderErrors, contextLost: renderer.getContext().isContextLost() };
}
function wagons() {
  return [presentation.convoy, presentation.actorVisuals.get('enemy-caravan').wagon];
}
window.wagonHarness = {
  state,
  textures() {
    const found = [];
    for (const id of WAGON_MODELS) {
      const seen = new Set();
      library.get(id).scene.traverse(object => {
        if (!object.isMesh) return;
        for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap']) {
          const texture = object.material[key];
          if (texture && !seen.has(texture.uuid)) { seen.add(texture.uuid); found.push(decode(id, key, texture)); }
        }
      });
    }
    return found;
  },
  /** A faction's run with both wagons staged side by side ahead of the hero, at the gameplay camera distance. */
  open(faction, warm = true) {
    const campaign = createCampaign({ seed: 'wagon-browser', faction, runId: 'wagon-browser-' + faction });
    snapshot = campaign.snapshot();
    snapshot.narrative = undefined;
    shipment = snapshot.actors.find(actor => actor.id === 'enemy-caravan');
    snapshot.actors = [shipment];
    snapshot.convoy.x = snapshot.player.x - 3.5; snapshot.convoy.z = snapshot.player.z + 9; snapshot.convoy.heading = Math.PI / 2;
    shipment.x = snapshot.player.x + 3.5; shipment.z = snapshot.player.z + 14; shipment.heading = -Math.PI / 2;
    presentation?.dispose();
    presentation = new Presentation(snapshot.world, new ViewResources(new THREE.TextureLoader(), 8, library), environment?.texture);
    environment ??= skyEnvironment(renderer, presentation.scenery.group);
    presentation.scene.environment = environment.texture;
    camera.reset();
    camera.update(snapshot.player, 0);
    positionSun(presentation.sun, snapshot.player.x, snapshot.player.z);
    presentation.update(snapshot, 1 / 60, camera.camera, false);
    const warmup = warm ? presentation.warmModels(renderer, snapshot.player.x, snapshot.player.z,
      () => compileFrame(renderer, presentation.scene, camera.camera, null)) : null;
    return { warmup, ...draw() };
  },
  get textureStatus() { return presentation?.resources.textureStatus; },
  /** Advances whole ticks: the convoy and the shipment drive along their headings at the given speeds. */
  step({ convoy = 0, shipmentSpeed = 0, ticks = 1, disabled = false, cargo = 30, reducedMotion = false } = {}) {
    for (let tick = 0; tick < ticks; tick++) {
      snapshot.tick += 1;
      snapshot.elapsed = snapshot.tick / 60;
      snapshot.convoy.x += Math.sin(snapshot.convoy.heading) * convoy / 60;
      snapshot.convoy.z += Math.cos(snapshot.convoy.heading) * convoy / 60;
      shipment.x += Math.sin(shipment.heading) * shipmentSpeed / 60;
      shipment.z += Math.cos(shipment.heading) * shipmentSpeed / 60;
      snapshot.convoy.disabled = disabled;
      snapshot.convoy.hp = disabled ? 0 : snapshot.convoy.maxHp;
      snapshot.convoy.cargo = cargo;
      presentation.update(snapshot, 1 / 60, camera.camera, reducedMotion);
    }
    const [convoyWagon, shipmentWagon] = wagons();
    return { ...draw(), convoyGait: convoyWagon.animal.activeClip, shipmentGait: shipmentWagon.animal.activeClip,
      procedural: Boolean(presentation.scene.getObjectByName('wagon-cart')),
      lean: convoyWagon.root.getObjectByName('wagon-lean').rotation.z,
      cargo: convoyWagon.root.getObjectByName('prop-cargo-load').visible };
  },
  /** Draws one frame with both wagons shown or hidden: for draw-call accounting and pixel comparisons. */
  frame(shown) {
    for (const wagon of wagons()) wagon.root.visible = shown;
    const stats = draw();
    for (const wagon of wagons()) wagon.root.visible = true;
    return stats;
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
  programs() {
    const hash = text => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0; return h.toString(16); };
    return (renderer.info.programs ?? []).map(program => program.name + ' #' + hash(program.cacheKey));
  },
  dispose() {
    presentation.dispose();
    library.dispose();
    environment.dispose();
    presentation.sun.shadow.dispose();
    const after = { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
    renderer.dispose();
    return { after };
  },
};
</script></body></html>`;

describe.runIf(process.env.KOROVANY_BROWSER === '1')('cooked wagons and the draft ox in the browser', () => {
  let server: ViteDevServer | undefined;
  let broken: ViteDevServer | undefined;
  let missing = '';
  let browser: LaunchedBrowser | undefined;
  let cdp: CdpSession | undefined;
  const captures = process.env.KOROVANY_CAPTURE_DIR;

  beforeAll(async () => {
    if (captures) await mkdir(captures, { recursive: true });
    server = await createServer({
      configFile: false,
      optimizeDeps: { include: ['three'] },
      plugins: [{
        name: 'wagon-harness',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/__wagons') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            vite.transformIndexHtml('/__wagons', harness).then(html => response.end(html), next);
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('Wagon harness server has no URL');
    browser = await launchTestBrowser({ viewport: { width: 1280, height: 800 } });
    cdp = await openPage(browser.port, `${origin}__wagons`, { width: 1280, height: 800 });
    await until(cdp, 'Boolean(window.wagonHarness && (window.wagonHarness.state.ready || window.wagonHarness.state.error))', Boolean, 60_000);
    expect(await evaluate(cdp, 'window.wagonHarness.state.error')).toBeNull();
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

  test('decodes the wagon, ox and cargo textures and renders both wagons with their oxen on the warmed programs', async () => {
    if (!cdp) throw new Error('Browser was not initialized');
    const textures = await evaluate<{ id: string; key: string; width: number; range: number }[]>(cdp, 'window.wagonHarness.textures()');
    expect(new Set(textures.map(texture => texture.id)).size).toBe(4);
    for (const texture of textures) {
      expect(texture.width, `${texture.id}:${texture.key}`).toBeGreaterThanOrEqual(256);
      expect(texture.range, `${texture.id}:${texture.key}`).toBeGreaterThan(8);
    }
    const opened = await evaluate<{ shaderErrors: number; warmup: { programsBefore: number; programsAfter: number } }>(
      cdp, "window.wagonHarness.open('villain')");
    await until(cdp, 'window.wagonHarness.textureStatus.pending === 0', Boolean, 30_000);
    expect(opened.shaderErrors).toBe(0);
    // Upload the world textures that finished loading, so later frames measure only the wagons.
    await evaluate(cdp, 'window.wagonHarness.step({ ticks: 1 }) && 0');
    const warmed = await evaluate<string[]>(cdp, 'window.wagonHarness.programs()');
    const standing = await evaluate<{ programs: number; shaderErrors: number; convoyGait: string; shipmentGait: string; procedural: boolean }>(
      cdp, 'window.wagonHarness.step({ ticks: 2 })');
    expect(standing.procedural).toBe(false);
    expect(standing.convoyGait).toBe('Idle');
    const shown = await evaluate<{ calls: number; triangles: number }>(cdp, 'window.wagonHarness.frame(true)');
    const hidden = await evaluate<{ calls: number; triangles: number }>(cdp, 'window.wagonHarness.frame(false)');
    // Body, two axles, harness and ox (and the convoy's cargo), each drawn in the lit and shadow passes: at most seven
    // draws per wagon and pass, against 93 meshes for the procedural wagon.
    expect(shown.calls - hidden.calls).toBeGreaterThan(0);
    expect(shown.calls - hidden.calls).toBeLessThanOrEqual(2 * 7 * 2);
    await evaluate(cdp, 'window.wagonHarness.frame(false)');
    await evaluate(cdp, 'window.wagonHarness.keep()');
    await evaluate(cdp, 'window.wagonHarness.frame(true)');
    const visible = await evaluate<number>(cdp, 'window.wagonHarness.changed()');
    expect(visible).toBeGreaterThan(3000);
    if (captures) await screenshot(cdp, join(captures, 'wagons-standing.png'));
    // Driving: the convoy canters at its road speed, the shipment trots; neither creates a program.
    const driving = await evaluate<{ programs: number; shaderErrors: number; convoyGait: string; shipmentGait: string }>(
      cdp, 'window.wagonHarness.step({ convoy: 5.15, shipmentSpeed: 4, ticks: 40 })');
    expect(driving.convoyGait).toBe('Canter');
    expect(driving.shipmentGait).toBe('Trot');
    await evaluate(cdp, 'window.wagonHarness.keep()');
    await evaluate(cdp, 'window.wagonHarness.step({ convoy: 5.15, shipmentSpeed: 4, ticks: 6 })');
    expect(await evaluate<number>(cdp, 'window.wagonHarness.changed()')).toBeGreaterThan(500);
    if (captures) await screenshot(cdp, join(captures, 'wagons-driving.png'));
    // Disabled without cargo: the convoy leans and its bed empties.
    const disabled = await evaluate<{ lean: number; cargo: boolean; programs: number; shaderErrors: number; convoyGait: string }>(
      cdp, 'window.wagonHarness.step({ disabled: true, cargo: 0, ticks: 30, reducedMotion: true })');
    expect(disabled.lean).toBeCloseTo(0.085, 5);
    expect(disabled.cargo).toBe(false);
    expect(disabled.convoyGait).toBe('Idle');
    if (captures) await screenshot(cdp, join(captures, 'wagons-disabled.png'));
    const after = await evaluate<string[]>(cdp, 'window.wagonHarness.programs()');
    for (const state of [standing, driving, disabled]) expect(state.shaderErrors).toBe(0);
    expect(after, 'programs created after warm-up').toEqual(warmed);
    const disposal = await evaluate<{ after: { geometries: number; textures: number } }>(cdp, 'window.wagonHarness.dispose()');
    expect(disposal.after.geometries).toBe(0);
    expect(disposal.after.textures).toBe(0);
    expect(cdp.diagnostics).toEqual([]);
  }, 180_000);

  test.each(['char-draft-ox', 'prop-wagon-shipment'])(
    'stops with a visible asset failure, and no procedural wagon, when %s is missing', async id => {
      missing = id;
      broken ??= await createServer({
        configFile: false,
        plugins: [{
          name: 'missing-model',
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
      if (!broken.httpServer?.listening) await broken.listen();
      const origin = broken.resolvedUrls?.local[0];
      if (!origin || !browser) throw new Error('Missing-model server has no URL');
      const page = await openPage(browser.port, 'about:blank', { width: 1024, height: 700 });
      try {
        await navigateTestPage(page, origin, "window.korovany && window.korovany.inspect().overlay === 'fatal'", 60_000);
        const state = await evaluate<{ overlay: string; running: boolean; models: { error: string | null } }>(page, 'window.korovany.inspect()');
        expect(state.overlay).toBe('fatal');
        expect(state.running).toBe(false);
        expect(state.models.error).toContain(`models/${id}/${id}.glb`);
        expect(page.diagnostics.some(entry => /status of 404/.test(entry)), JSON.stringify(page.diagnostics)).toBe(true);
        expect(page.diagnostics.filter(entry => entry.startsWith('uncaught'))).toEqual([]);
        if (captures) await screenshot(page, join(captures, `wagon-missing-${id}.png`));
      } finally {
        page.close();
      }
    }, 90_000);
});
