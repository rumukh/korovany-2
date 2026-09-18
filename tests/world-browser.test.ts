import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import {
  evaluate, launchBrowser, openPage, screenshot, until, type CdpSession, type LaunchedBrowser,
} from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeTestBrowser } from './browser-cleanup';

const preview = `<!doctype html><html><head><link rel="icon" href="data:,"><style>
html,body {margin:0;overflow:hidden;background:#b6cbba} canvas {display:block}
#title {position:fixed;left:24px;top:20px;padding:10px 16px;background:#151e1bdd;color:#efe6d2;font:18px Georgia}
</style></head><body><canvas></canvas><div id="title"></div><script type="module">
import * as THREE from 'three';
import { generateWorld } from '/src/game/world.ts';
import { createWorldScenery } from '/src/view/world.ts';
import { ViewResources } from '/src/view/resources.ts';
import { FollowCamera } from '/src/view/camera.ts';
import { lightWorld, positionSun, skyEnvironment } from '/src/view/atmosphere.ts';
import { WorldPostprocessing } from '/src/view/postprocessing.ts';
import { createActor, createWagon } from '/src/view/actors.ts';
const world = generateWorld('view-frontier');
const resources = new ViewResources(new THREE.TextureLoader(),8);
const scenery = createWorldScenery(resources, world);
const canvas = document.querySelector('canvas');
const renderer = new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});
renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
const scene = new THREE.Scene();
scene.add(scenery.group);
const environment = skyEnvironment(renderer,scenery.group);
scene.environment = environment.texture;
scene.environmentIntensity = 0.55;
const sun = lightWorld(scene);
const camera = new FollowCamera(canvas);
camera.resize(innerWidth,innerHeight);
camera.zoom(10000);
const post = new WorldPostprocessing(renderer,scene,camera.camera);
post.resize(innerWidth,innerHeight,1);
renderer.info.autoReset = false;
let modelStage;
let disposedInstances = 0;
let instanceCount = 0;
scenery.group.traverse(object => {
  if (object.isInstancedMesh) { instanceCount++; object.addEventListener('dispose',()=>disposedInstances++); }
});
function renderLocation(id,low=false) {
  scenery.group.visible = true;
  if (modelStage) modelStage.visible = false;
  resources.assertTextures();
  const place = world.exploration.locations.find(place=>place.id===id);
  if (!place) throw new Error('Unknown preview location: '+id);
  scenery.heroPosition.set(place.x,1.15,place.z);
  scenery.update(4,false);
  scenery.setQuality(low);
  camera.reset();
  camera.update(place,0);
  positionSun(sun,place.x,place.z);
  renderer.shadowMap.enabled = !low;
  renderer.info.reset();
  if (low) renderer.render(scene,camera.camera);
  else post.render();
  document.querySelector('#title').textContent = place.name.en+' / '+place.name.ru;
  const gl = renderer.getContext();
  const pixels = new Uint8Array(32*32*4);
  gl.readPixels(Math.floor(innerWidth/2)-16,Math.floor(innerHeight/2)-16,32,32,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  let brightness = 0;
  for(let i=0;i<pixels.length;i+=4) brightness += pixels[i]+pixels[i+1]+pixels[i+2];
  return {calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,
    geometries:renderer.info.memory.geometries,programs:renderer.info.programs.length,
    contextLost:gl.isContextLost(),pixelBrightness:brightness,
    sky:scenery.group.getObjectByName('world-sky').position.toArray()};
}
window.worldPreview = {renderLocation,get textures() {return resources.textureStatus;},renderModels() {
  if (!modelStage) {
    modelStage = new THREE.Group();
    scene.add(modelStage);
    for (const [index,faction] of ['elf','guard','villain'].entries()) {
      const actor = createActor(resources,'hero',faction,true);
      actor.root.position.set(-4+index*2.5,0,0);
      actor.root.rotation.y = 0.3;
      actor.animate({time:1,moving:0,attacking:0,winding:0,dodging:false,dead:false,reducedMotion:true});
      modelStage.add(actor.root);
    }
    const wagon = createWagon(resources,true);
    wagon.root.position.set(5,0,-1);
    wagon.root.rotation.y = -0.5;
    modelStage.add(wagon.root);
    const floor = new THREE.Mesh(resources.geometry('model-stage',()=>new THREE.BoxGeometry(24,0.1,16)),
      resources.material('#92956b',{surface:'ground'}));
    floor.position.set(1,-0.09,0);
    floor.receiveShadow = true;
    modelStage.add(floor);
  }
  modelStage.visible = true;
  scenery.group.visible = false;
  positionSun(sun,0,0);
  camera.camera.position.set(12,8,16);
  camera.camera.lookAt(1,1,0);
  camera.camera.updateMatrixWorld();
  renderer.shadowMap.enabled = true;
  post.render();
  document.querySelector('#title').textContent = 'Frontier equipment / Снаряжение каравана';
},benchmark() {
  const samples = [];
  for (let frame=0;frame<18;frame++) {
    const start = performance.now();
    renderLocation('roadward');
    renderer.getContext().finish();
    if (frame>=3) samples.push(performance.now()-start);
  }
  samples.sort((a,b)=>a-b);
  return {medianMs:samples[7],p95Ms:samples[14]};
},dispose() {
  scenery.dispose(); resources.dispose(); sun.shadow.dispose(); environment.dispose(); post.dispose(); renderer.dispose();
  return {instanceCount,disposedInstances};
}};
renderLocation('roadward');
</script></body></html>`;

describe.runIf(process.env.KOROVANY_WORLD_BROWSER === '1')('expanded world WebGL presentation', () => {
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
        name: 'world-visual-acceptance',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__world-preview') return next();
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            server.transformIndexHtml('/__world-preview', preview).then(html => response.end(html), next);
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('World preview server has no local URL');
    expect((await fetch(`${origin}__world-preview`)).status).toBe(200);
    browser = await launchBrowser({ viewport: { width: 1440, height: 900 } });
    cdp = await openPage(browser.port, `${origin}__world-preview`, { width: 1440, height: 900 });
    await until(cdp, 'Boolean(window.worldPreview)', Boolean, 45_000);
    await until(cdp, 'window.worldPreview.textures.pending === 0', Boolean, 30_000);
    expect(await evaluate(cdp, 'window.worldPreview.textures.error')).toBeNull();
  }, 60_000);

  afterAll(async () => {
    cdp?.close();
    try {
      if (browser) await closeTestBrowser(browser);
    } finally {
      await server?.close();
    }
  }, 60_000);

  test('renders every regional look and distant landmark without shader errors or resource growth', async () => {
    if (!cdp) throw new Error('World browser was not initialized');
    const locations = [
      'roadward', 'greenhollow', 'stag-shrine', 'mirecross', 'drowned-archive', 'saltmarket',
      'tide-observatory', 'cinderwell', 'glass-quarry', 'crownbridge', 'bell-foundry',
      'high-pass', 'old-fort', 'palace-citadel', 'star-monastery', 'frozen-beacon', 'hollow-village', 'name-well', 'last-archive',
    ];
    const metrics: { location: string; calls: number; triangles: number; geometries: number; programs: number }[] = [];
    for (const location of locations) {
      const stats = await evaluate<{
        calls: number; triangles: number; geometries: number; programs: number;
        contextLost: boolean; pixelBrightness: number; sky: number[];
      }>(cdp, `window.worldPreview.renderLocation(${JSON.stringify(location)})`);
      expect(stats.contextLost).toBe(false);
      expect(stats.pixelBrightness).toBeGreaterThan(100000);
      metrics.push({ location, calls: stats.calls, triangles: stats.triangles, geometries: stats.geometries, programs: stats.programs });
      if (captures) await screenshot(cdp, join(captures, `${location}.png`));
    }
    console.info('World render metrics', JSON.stringify(metrics));
    for (const stats of metrics) {
      expect.soft(stats.calls, stats.location).toBeLessThan(250);
      expect.soft(stats.triangles, stats.location).toBeLessThan(500000);
      expect.soft(stats.geometries, stats.location).toBeLessThanOrEqual(20);
      // Includes the fort's stone/cloth cutaway shader variants.
      expect.soft(stats.programs, stats.location).toBeLessThanOrEqual(23);
    }
    // First visits compile material variants lazily; revisiting must not grow the warmed cache.
    const warmed = metrics.at(-1)!;
    for (const location of locations) {
      const stats = await evaluate<{ geometries: number; programs: number }>(
        cdp, `window.worldPreview.renderLocation(${JSON.stringify(location)})`);
      expect.soft(stats.geometries, location).toBeLessThanOrEqual(warmed.geometries);
      expect.soft(stats.programs, location).toBeLessThanOrEqual(warmed.programs);
    }
    expect(cdp.diagnostics).toEqual([]);
    if (process.env.KOROVANY_WORLD_BENCHMARK === '1') {
      console.info('Software renderer frame timing', await evaluate(cdp, 'window.worldPreview.benchmark()'));
    }
    await evaluate(cdp, 'window.worldPreview.renderModels()');
    if (captures) await screenshot(cdp, join(captures, 'equipment.png'));
    expect(cdp.diagnostics).toEqual([]);
    const low = await evaluate<{ calls: number }>(cdp, "window.worldPreview.renderLocation('last-archive',true)");
    expect(low.calls).toBeLessThan(metrics.at(-1)!.calls);
    const disposal = await evaluate<{ instanceCount: number; disposedInstances: number }>(cdp, 'window.worldPreview.dispose()');
    expect(disposal.disposedInstances).toBe(disposal.instanceCount);
  }, 120_000);
});
