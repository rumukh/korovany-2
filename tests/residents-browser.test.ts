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
import { compileFrame, Presentation } from '/src/view/index.ts';
import { ViewResources } from '/src/view/resources.ts';
import { ModelLibrary, RESIDENTS, gltfModelSource } from '/src/view/models.ts';
import { FollowCamera } from '/src/view/camera.ts';
import { positionSun, skyEnvironment } from '/src/view/atmosphere.ts';
const RESIDENT_MODELS = Object.values(RESIDENTS).map(resident => resident.id);
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
function people() {
  return snapshot.narrative.npcs.map(npc => presentation.scene.getObjectByName('resident:' + npc.id)).filter(Boolean);
}
window.residentHarness = {
  state,
  textures() {
    const found = [];
    for (const id of RESIDENT_MODELS) {
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
  /** The elf run's home, Greenhollow: Toman and Lida, the hero standing in front of Toman at the talk distance. */
  open(warm = true) {
    const campaign = createCampaign({ seed: 'resident-browser', faction: 'elf', runId: 'resident-browser' });
    snapshot = campaign.snapshot();
    snapshot.actors = [];
    const toman = snapshot.narrative.npcs.find(npc => npc.id === 'toman');
    snapshot.player.x = toman.x;
    snapshot.player.z = toman.z + 4;
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
    return { warmup, ...draw(), listed: snapshot.narrative.npcs.map(npc => npc.id) };
  },
  get textureStatus() { return presentation?.resources.textureStatus; },
  /** Advances render frames; 'talking' opens a conversation with that resident (the simulation stays paused). */
  step({ frames = 1, talking = null, reducedMotion = false } = {}) {
    snapshot.narrative.dialogue = talking ? { npcId: talking } : null;
    for (let frame = 0; frame < frames; frame++) presentation.update(snapshot, 1 / 60, camera.camera, reducedMotion);
    const clips = {};
    for (const npc of snapshot.narrative.npcs) clips[npc.id] = presentation.residents.model(npc.id)?.activeClip ?? 'procedural';
    return { ...draw(), clips };
  },
  /** Draws one frame with the residents shown or hidden: for draw-call accounting and pixel comparisons. */
  frame(shown) {
    for (const person of people()) person.visible = shown;
    const stats = draw();
    for (const person of people()) person.visible = true;
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

describe.runIf(process.env.KOROVANY_BROWSER === '1')('cooked residents in the browser', () => {
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
        name: 'resident-harness',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/__residents') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            vite.transformIndexHtml('/__residents', harness).then(html => response.end(html), next);
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('Resident harness server has no URL');
    browser = await launchBrowser({ viewport: { width: 1280, height: 800 } });
    cdp = await openPage(browser.port, `${origin}__residents`, { width: 1280, height: 800 });
    await until(cdp, 'Boolean(window.residentHarness && (window.residentHarness.state.ready || window.residentHarness.state.error))', Boolean, 60_000);
    expect(await evaluate(cdp, 'window.residentHarness.state.error')).toBeNull();
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

  test('decodes every resident texture and renders the cooked residents on the warmed programs, talking and still', async () => {
    if (!cdp) throw new Error('Browser was not initialized');
    const textures = await evaluate<{ id: string; key: string; width: number; range: number }[]>(cdp, 'window.residentHarness.textures()');
    expect(new Set(textures.map(texture => texture.id)).size).toBe(10);
    for (const texture of textures) {
      expect(texture.width, `${texture.id}:${texture.key}`).toBeGreaterThanOrEqual(512);
      expect(texture.range, `${texture.id}:${texture.key}`).toBeGreaterThan(8);
    }
    const opened = await evaluate<{ shaderErrors: number; listed: string[]; warmup: { programsBefore: number; programsAfter: number } }>(
      cdp, 'window.residentHarness.open()');
    expect(opened.listed).toEqual(expect.arrayContaining(['toman', 'lida']));
    await until(cdp, 'window.residentHarness.textureStatus.pending === 0', Boolean, 30_000);
    expect(opened.shaderErrors).toBe(0);
    // Upload the world textures that finished loading, so later frames measure only the residents.
    await evaluate(cdp, 'window.residentHarness.step() && 0');
    const warmed = await evaluate<string[]>(cdp, 'window.residentHarness.programs()');
    const standing = await evaluate<{ shaderErrors: number; clips: Record<string, string> }>(cdp, 'window.residentHarness.step({ frames: 30 })');
    expect(standing.clips).toMatchObject({ toman: 'Idle', lida: 'Idle' });
    const shown = await evaluate<{ calls: number }>(cdp, 'window.residentHarness.frame(true)');
    const hidden = await evaluate<{ calls: number }>(cdp, 'window.residentHarness.frame(false)');
    // One skinned body per cooked resident in the lit and shadow passes, plus each resident's ring and marker.
    const listed = opened.listed.length;
    expect(shown.calls - hidden.calls).toBeGreaterThan(0);
    expect(shown.calls - hidden.calls).toBeLessThanOrEqual(listed * (2 + 2));
    await evaluate(cdp, 'window.residentHarness.frame(false)');
    await evaluate(cdp, 'window.residentHarness.keep()');
    await evaluate(cdp, 'window.residentHarness.frame(true)');
    expect(await evaluate<number>(cdp, 'window.residentHarness.changed()')).toBeGreaterThan(3000);
    if (captures) await screenshot(cdp, join(captures, 'residents-standing.png'));
    // Toman's conversation: he gestures on render time while Lida keeps idling.
    const talking = await evaluate<{ shaderErrors: number; clips: Record<string, string> }>(
      cdp, "window.residentHarness.step({ frames: 60, talking: 'toman' })");
    expect(talking.clips).toMatchObject({ toman: 'Talk', lida: 'Idle' });
    await evaluate(cdp, 'window.residentHarness.keep()');
    await evaluate(cdp, "window.residentHarness.step({ frames: 20, talking: 'toman' })");
    expect(await evaluate<number>(cdp, 'window.residentHarness.changed()')).toBeGreaterThan(50);
    if (captures) await screenshot(cdp, join(captures, 'residents-talking.png'));
    // Reduced motion: the conversation shows no gestures, and nobody moves between frames.
    const still = await evaluate<{ shaderErrors: number; clips: Record<string, string> }>(
      cdp, "window.residentHarness.step({ frames: 5, talking: 'toman', reducedMotion: true })");
    expect(still.clips).toMatchObject({ toman: 'Idle', lida: 'Idle' });
    await evaluate(cdp, 'window.residentHarness.keep()');
    await evaluate(cdp, "window.residentHarness.step({ frames: 30, talking: 'toman', reducedMotion: true })");
    expect(await evaluate<number>(cdp, 'window.residentHarness.changed()')).toBe(0);
    const after = await evaluate<string[]>(cdp, 'window.residentHarness.programs()');
    for (const state of [standing, talking, still]) expect(state.shaderErrors).toBe(0);
    expect(after, 'programs created after warm-up').toEqual(warmed);
    const disposal = await evaluate<{ after: { geometries: number; textures: number } }>(cdp, 'window.residentHarness.dispose()');
    expect(disposal.after.geometries).toBe(0);
    expect(disposal.after.textures).toBe(0);
    expect(cdp.diagnostics).toEqual([]);
  }, 180_000);

  test('stops with a visible asset failure, and no procedural figure, when a resident model is missing', async () => {
    missing = 'char-resident-toman';
    broken = await createServer({
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
    await broken.listen();
    const origin = broken.resolvedUrls?.local[0];
    if (!origin || !browser) throw new Error('Missing-model server has no URL');
    const page = await openPage(browser.port, 'about:blank', { width: 1024, height: 700 });
    try {
      await navigateTestPage(page, origin, "window.korovany && window.korovany.inspect().overlay === 'fatal'", 60_000);
      const state = await evaluate<{ overlay: string; running: boolean; models: { error: string | null } }>(page, 'window.korovany.inspect()');
      expect(state.overlay).toBe('fatal');
      expect(state.running).toBe(false);
      expect(state.models.error).toContain(`models/${missing}/${missing}.glb`);
      expect(page.diagnostics.some(entry => /status of 404/.test(entry)), JSON.stringify(page.diagnostics)).toBe(true);
      expect(page.diagnostics.filter(entry => entry.startsWith('uncaught'))).toEqual([]);
      if (captures) await screenshot(page, join(captures, 'resident-missing.png'));
    } finally {
      page.close();
    }
  }, 90_000);
});
