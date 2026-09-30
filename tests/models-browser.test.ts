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
import { ModelLibrary, gltfModelSource, MODEL_IDS } from '/src/view/models.ts';
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
let presentation, environment, snapshot, soldierTemplate, campaign, kept;
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
// Textures are read back through WebGL, as the renderer samples them: a 2D canvas premultiplies alpha and loses the
// colour under a zero dye mask, which is every undyed texel (all of a hero's body).
const probe = document.createElement('canvas').getContext('webgl2');
function decode({ key, texture, material }) {
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
  settle();
  const gl = renderer.getContext();
  return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs.length,
    geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, shaderErrors, contextLost: gl.isContextLost() };
}
// WebGL returns before the GPU draws; waiting here charges each frame to the DevTools evaluation that drew it, so no
// later call inherits queued software-GL frames (each evaluation must answer within 30 s).
const onePixel = new Uint8Array(4);
function settle() {
  const gl = renderer.getContext();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, onePixel);
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
    return MODEL_IDS.flatMap(id => texturesOf(library.get(id).scene).map(entry => ({ id, ...decode(entry) })));
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
      // The game's own warm-up draw: real lights, fog and shadow maps, one scissored pixel of shading.
      warmup = presentation.warmModels(renderer, snapshot.player.x, snapshot.player.z,
        () => compileFrame(renderer, presentation.scene, camera.camera, null));
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
    this.place(soldiers);
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
  place(soldiers) {
    const template = soldierTemplate;
    snapshot.actors = snapshot.actors.filter(actor => actor.kind !== 'soldier');
    const layout = [['elf','hostile','windup'],['guard','friendly','idle'],['villain','hostile','attack'],['villain','friendly','chase'],['guard','neutral','dead']];
    for (let index = 0; index < soldiers; index++) {
      const [faction, allegiance, state] = layout[index % layout.length];
      snapshot.actors.push({ ...structuredClone(template), id: 'browser-soldier-' + index, faction, allegiance, state,
        stateTime: 0.2, hp: state === 'dead' ? 0 : template.maxHp * 0.7,
        x: snapshot.player.x - 4 + index * 2, z: snapshot.player.z + 5 + (index % 2), heading: Math.PI });
    }
  },
  // Pixel comparisons take one frame per call: software GL (CI) draws a frame in seconds, and one DevTools
  // evaluation must answer within 30 s.
  /** Draws one frame with this many soldiers. */
  stage(soldiers) {
    this.place(soldiers);
    render();
    return true;
  },
  /** Keeps the current frame's pixels for changed(). */
  keep() {
    kept = pixels();
    return true;
  },
  /**
   * The cooked roster in front of the camera: an archer, a captain and both bosses, in several factions, allegiances
   * and telegraphed states; shown = false removes them again. Draws one frame.
   */
  roster(shown = true) {
    snapshot.actors = snapshot.actors.filter(actor => !actor.id.startsWith('browser-roster-'));
    if (shown) {
      const layout = [['archer', 'elf', 'hostile', 'windup', -5, 6], ['captain', 'villain', 'friendly', 'attack', -1.5, 7],
        ['boss', 'villain', 'hostile', 'windup', 3, 9], ['boss', 'guard', 'hostile', 'recovery', 8, 7], ['archer', 'guard', 'friendly', 'idle', -7.5, 8]];
      for (const [kind, faction, allegiance, state, dx, dz] of layout) {
        snapshot.actors.push({ ...structuredClone(soldierTemplate), id: 'browser-roster-' + kind + '-' + faction, kind, faction, allegiance, state,
          stateTime: 0.2, radius: kind === 'boss' ? 1.3 : 0.7, attackRange: kind === 'archer' ? 14 : kind === 'boss' ? 4.3 : 2.4,
          x: snapshot.player.x + dx, z: snapshot.player.z + dz, heading: Math.PI });
      }
    }
    return render();
  },
  /** Pixels of the current frame that differ from the kept frame by more than 24 levels of RGB. */
  changed() {
    const now = pixels();
    let count = 0;
    for (let i = 0; i < now.length; i += 4) {
      if (Math.abs(now[i] - kept[i]) + Math.abs(now[i + 1] - kept[i + 1]) + Math.abs(now[i + 2] - kept[i + 2]) > 24) count++;
    }
    return count;
  },
  /** A faction's run with its cooked hero at the gameplay camera distance, warmed as the game warms it. */
  hero(faction) {
    campaign = createCampaign({ seed: 'model-browser', faction, runId: 'model-browser-' + faction });
    snapshot = campaign.snapshot();
    presentation?.dispose();
    presentation = new Presentation(snapshot.world, new ViewResources(new THREE.TextureLoader(), 8, library), environment?.texture);
    environment ??= skyEnvironment(renderer, presentation.scenery.group);
    presentation.scene.environment = environment.texture;
    camera.reset();
    camera.update(snapshot.player, 0);
    positionSun(presentation.sun, snapshot.player.x, snapshot.player.z);
    presentation.update(snapshot, 1 / 60, camera.camera, false);
    const warmup = presentation.warmModels(renderer, snapshot.player.x, snapshot.player.z,
      () => compileFrame(renderer, presentation.scene, camera.camera, null));
    settle();
    // The first full frame is heroStep's, after the world textures finish loading.
    return { shaderErrors, warmup };
  },
  /** Steps the real campaign with one input and renders; dead forces the defeat pose. */
  heroStep(input, ticks = 1, dead = false) {
    for (let tick = 0; tick < ticks; tick++) {
      campaign.step(input);
      snapshot = campaign.snapshot();
      if (dead) { snapshot.player.state = 'dead'; snapshot.player.hp = 0; }
      presentation.update(snapshot, 1 / 60, camera.camera, false);
    }
    camera.update(snapshot.player, 0);
    positionSun(presentation.sun, snapshot.player.x, snapshot.player.z);
    renderer.info.reset();
    renderer.render(presentation.scene, camera.camera);
    settle();
    const character = presentation.hero.character;
    return { calls: renderer.info.render.calls, programs: renderer.info.programs.length, shaderErrors,
      clip: character.activeClip, overlay: character.overlay?.clip ?? null };
  },
  /** Program cache keys held by the hero's own materials, including the shared model shadow-depth material. */
  heroPrograms() {
    const hash = text => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0; return h.toString(16); };
    const keys = new Set();
    presentation.scene.getObjectByName('hero').traverse(object => {
      if (!object.isMesh) return;
      for (const material of [object.material, object.customDepthMaterial]) {
        const programs = material && renderer.properties.get(material).programs;
        if (programs) for (const key of programs.keys()) keys.add(material.name + ' #' + hash(key));
      }
    });
    return [...keys].sort();
  },
  /** Draws one frame with the hero model (not its rings) shown or hidden, for keep() and changed(). */
  heroFrame(faction, shown) {
    const model = presentation.scene.getObjectByName('char-hero-' + faction);
    model.visible = shown;
    renderer.render(presentation.scene, camera.camera);
    settle();
    model.visible = true;
    return true;
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
  /** The model the missing-asset server answers with 404. */
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
    // Every model's base colour, normal and occlusion/roughness/metal maps decoded, for all nine models.
    expect(new Set(textures.map(texture => texture.id)).size).toBe(9);
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
    await evaluate(cdp, 'window.modelHarness.stage(0)');
    await evaluate(cdp, 'window.modelHarness.keep()');
    await evaluate(cdp, 'window.modelHarness.stage(5)');
    expect(await evaluate<number>(cdp, 'window.modelHarness.changed()')).toBeGreaterThan(2000);
    if (captures) await screenshot(cdp, join(captures, 'model-soldiers.png'));
    // The rest of the cooked roster (archers, a captain and both bosses) shares the warmed programs: the Palace Marshal
    // is not in this guard run, so its first appearance uploads textures but compiles nothing.
    const roster = await evaluate<{ programs: number; shaderErrors: number; calls: number; contextLost: boolean }>(cdp, 'window.modelHarness.roster(true)');
    expect(roster.shaderErrors).toBe(0);
    expect(roster.contextLost).toBe(false);
    expect(roster.programs).toBe(base.programs);
    if (captures) await screenshot(cdp, join(captures, 'model-roster.png'));
    await evaluate(cdp, 'window.modelHarness.keep()');
    await evaluate(cdp, 'window.modelHarness.roster(false)');
    expect(await evaluate<number>(cdp, 'window.modelHarness.changed()')).toBeGreaterThan(4000);
    const well = await evaluate<{ shaderErrors: number }>(cdp, "window.modelHarness.open('name-well')");
    await until(cdp, 'window.modelHarness.textureStatus.pending === 0', Boolean, 30_000);
    expect(well.shaderErrors).toBe(0);
    if (captures) await screenshot(cdp, join(captures, 'model-echo-well.png'));
    const disposal = await evaluate<{ before: { geometries: number; textures: number }; after: { geometries: number; textures: number } }>(
      cdp, 'window.modelHarness.dispose()');
    expect(disposal.after.geometries).toBe(0);
    expect(disposal.after.textures).toBe(0);
    expect(cdp.diagnostics).toEqual([]);
  }, 180_000);

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

  test('renders each faction\'s cooked hero through the game presenter, with no program growth across its states', async () => {
    if (!browser || !server) throw new Error('Browser was not initialized');
    const origin = server.resolvedUrls?.local[0];
    const page = await openPage(browser.port, `${origin}__models`, { width: 1280, height: 800 });
    try {
      await until(page, 'Boolean(window.modelHarness && (window.modelHarness.state.ready || window.modelHarness.state.error))', Boolean, 60_000);
      expect(await evaluate(page, 'window.modelHarness.state.error')).toBeNull();
      for (const faction of ['elf', 'guard', 'villain']) {
        const opened = await evaluate<{ shaderErrors: number; warmup: { programsBefore: number; programsAfter: number } }>(
          page, `window.modelHarness.hero('${faction}')`);
        await until(page, 'window.modelHarness.textureStatus.pending === 0', Boolean, 30_000);
        expect(opened.shaderErrors, faction).toBe(0);
        // Upload the world textures that finished loading; every hero state must then reuse the warmed programs.
        const base = await evaluate<{ programs: number }>(page, 'window.modelHarness.heroStep({}, 1)');
        const warmed = await evaluate<string[]>(page, 'window.modelHarness.heroPrograms()');
        const states: { clip: string; overlay: string | null; programs: number; shaderErrors: number; calls: number }[] = [];
        states.push(await evaluate(page, 'window.modelHarness.heroStep({ move: { x: 0, z: 1 } }, 20)'));
        states.push(await evaluate(page, 'window.modelHarness.heroStep({ attack: true, move: { x: 0, z: 1 } }, 1)'));
        states.push(await evaluate(page, 'window.modelHarness.heroStep({ move: { x: 1, z: 0 }, aim: { x: 0, z: 1 } }, 20)'));
        states.push(await evaluate(page, 'window.modelHarness.heroStep({}, 30)'));
        states.push(await evaluate(page, 'window.modelHarness.heroStep({ special: true }, 1)'));
        states.push(await evaluate(page, 'window.modelHarness.heroStep({ dodge: true, move: { x: -1, z: 0 } }, 6)'));
        states.push(await evaluate(page, 'window.modelHarness.heroStep({}, 60)'));
        await evaluate(page, `window.modelHarness.heroFrame('${faction}', true)`);
        await evaluate(page, 'window.modelHarness.keep()');
        await evaluate(page, `window.modelHarness.heroFrame('${faction}', false)`);
        const standing = await evaluate<number>(page, 'window.modelHarness.changed()');
        if (captures) {
          await evaluate(page, `window.modelHarness.heroFrame('${faction}', true)`);
          await screenshot(page, join(captures, `model-hero-${faction}.png`));
        }
        states.push(await evaluate(page, 'window.modelHarness.heroStep({}, 70, true)'));
        const after = await evaluate<string[]>(page, 'window.modelHarness.heroPrograms()');
        console.info('Hero states', faction, JSON.stringify({ warmup: opened.warmup, base: base.programs, standing, warmed, states }));
        expect(states.map(state => state.clip)).toEqual(['Run', 'Run', 'RunLeft', 'Idle', 'Idle', 'Dodge', 'Idle', 'Death']);
        expect(states[1]!.overlay).toBe('Attack');
        expect(states[4]!.overlay).toBe('Ability');
        // The hero's materials compiled at warm-up (lit dyed body and items, shadow depth) and never again.
        expect(warmed.length).toBeGreaterThanOrEqual(2);
        expect(after, `${faction} hero programs after warm-up`).toEqual(warmed);
        for (const state of states) expect(state.shaderErrors).toBe(0);
        // The model fills a readable part of the frame at the gameplay camera distance.
        expect(standing, faction).toBeGreaterThan(800);
      }
      const disposal = await evaluate<{ after: { geometries: number; textures: number } }>(page, 'window.modelHarness.dispose()');
      expect(disposal.after.geometries).toBe(0);
      expect(disposal.after.textures).toBe(0);
      expect(page.diagnostics).toEqual([]);
    } finally {
      page.close();
    }
    // Three faction runs on software GL in CI; every step is still bounded by the 30 s DevTools reply deadline.
  }, 300_000);

  test.each(['char-line-soldier', 'char-hero-villain', 'char-boss-marshal'])(
    'stops with a visible asset failure, and no procedural stand-in, when %s is missing', async id => {
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
        const state = await evaluate<{ overlay: string; running: boolean; models: { error: string | null; loaded: number } }>(
          page, 'window.korovany.inspect()');
        expect(state.overlay).toBe('fatal');
        expect(state.running).toBe(false);
        expect(state.models.error).toContain(`models/${id}/${id}.glb`);
        const heading = await evaluate<string>(page, "document.querySelector('.fatal-panel h2, .fatal-panel h1')?.textContent ?? ''");
        expect(heading).toMatch(/3D models|трёхмерные модели/);
        // The missing file was requested and the failure was handled: the browser logged the 404, nothing threw uncaught.
        expect(page.diagnostics.some(entry => /status of 404/.test(entry)), JSON.stringify(page.diagnostics)).toBe(true);
        expect(page.diagnostics.filter(entry => entry.startsWith('uncaught'))).toEqual([]);
        if (captures) await screenshot(page, join(captures, `model-missing-${id}.png`));
      } finally {
        page.close();
      }
    }, 90_000);
});
