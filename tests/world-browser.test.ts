import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import {
  evaluate, launchBrowser, openPage, screenshot, until, type CdpSession, type LaunchedBrowser,
} from '../vendor/aegis-engine/packages/render-three/src/browser';
import { closeOwnedBrowser } from '../vendor/aegis-engine/packages/render-three/src/testing/browser-lifecycle';

const preview = `<!doctype html><html><head><link rel="icon" href="data:,"><style>
html,body {margin:0;overflow:hidden;background:#b6cbba} canvas {display:block}
#title {position:fixed;left:24px;top:20px;padding:10px 16px;background:#151e1bdd;color:#efe6d2;font:18px Georgia}
</style></head><body><canvas></canvas><div id="title"></div><script type="module">
import * as THREE from 'three';
import { generateWorld } from '/src/game/world.ts';
import { createWorldScenery } from '/src/view/world.ts';
import { ViewResources } from '/src/view/resources.ts';
import { FollowCamera } from '/src/view/camera.ts';
const world = generateWorld('view-frontier');
const resources = new ViewResources();
const scenery = createWorldScenery(resources, world);
const canvas = document.querySelector('canvas');
const renderer = new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});
renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#b6cbba');
scene.fog = new THREE.Fog('#b6cbba',48,158);
scene.add(scenery.group,new THREE.HemisphereLight('#d3e2d6','#8d805b',1.55));
const sun = new THREE.DirectionalLight('#ffe1a1',2.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048,2048);
Object.assign(sun.shadow.camera,{left:-27,right:27,top:27,bottom:-27,near:1,far:115});
sun.shadow.bias = -0.00035;
sun.shadow.normalBias = 0.08;
scene.add(sun,sun.target);
const camera = new FollowCamera(canvas);
camera.resize(innerWidth,innerHeight);
camera.zoom(10000);
let disposedInstances = 0;
let instanceCount = 0;
scenery.group.traverse(object => {
  if (object.isInstancedMesh) { instanceCount++; object.addEventListener('dispose',()=>disposedInstances++); }
});
function renderLocation(id,low=false) {
  const place = world.exploration.locations.find(place=>place.id===id);
  if (!place) throw new Error('Unknown preview location: '+id);
  scenery.heroPosition.set(place.x,1.15,place.z);
  scenery.update(4,false);
  scenery.setQuality(low);
  camera.reset();
  camera.update(place,0);
  sun.position.set(place.x-32,48,place.z+24);
  sun.target.position.set(place.x,0,place.z);
  sun.target.updateMatrixWorld();
  renderer.render(scene,camera.camera);
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
window.worldPreview = {renderLocation,dispose() {
  scenery.dispose(); resources.dispose(); sun.shadow.dispose(); renderer.dispose();
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
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('World preview server has no local URL');
    expect((await fetch(`${origin}__world-preview`)).status).toBe(200);
    browser = await launchBrowser({ viewport: { width: 1440, height: 900 } });
    cdp = await openPage(browser.port, `${origin}__world-preview`, { width: 1440, height: 900 });
    await until(cdp, 'Boolean(window.worldPreview)', Boolean, 45_000);
  }, 60_000);

  afterAll(async () => {
    cdp?.close();
    if (browser) {
      await closeOwnedBrowser(browser);
      await rm(browser.profile, { recursive: true, force: true });
    }
    await server?.close();
  }, 30_000);

  test('renders every regional look and distant landmark without shader errors or resource growth', async () => {
    if (!cdp) throw new Error('World browser was not initialized');
    const locations = [
      'roadward', 'greenhollow', 'stag-shrine', 'mirecross', 'drowned-archive', 'saltmarket',
      'tide-observatory', 'cinderwell', 'glass-quarry', 'crownbridge', 'bell-foundry',
      'high-pass', 'star-monastery', 'frozen-beacon', 'hollow-village', 'name-well', 'last-archive',
    ];
    const metrics: { location: string; calls: number; triangles: number; geometries: number; programs: number }[] = [];
    for (const location of locations) {
      const stats = await evaluate<{
        calls: number; triangles: number; geometries: number; programs: number;
        contextLost: boolean; pixelBrightness: number; sky: number[];
      }>(cdp, `window.worldPreview.renderLocation(${JSON.stringify(location)})`);
      expect(stats.contextLost).toBe(false);
      expect(stats.pixelBrightness).toBeGreaterThan(100000);
      expect(stats.calls).toBeLessThan(180);
      expect(stats.triangles).toBeLessThan(100000);
      expect(stats.geometries).toBeLessThan(16);
      expect(stats.programs).toBeLessThan(12);
      metrics.push({ location, calls: stats.calls, triangles: stats.triangles, geometries: stats.geometries, programs: stats.programs });
      if (captures) await screenshot(cdp, join(captures, `${location}.png`));
    }
    expect(cdp.diagnostics).toEqual([]);
    const low = await evaluate<{ calls: number }>(cdp, "window.worldPreview.renderLocation('last-archive',true)");
    expect(low.calls).toBeLessThan(metrics.at(-1)!.calls);
    const disposal = await evaluate<{ instanceCount: number; disposedInstances: number }>(cdp, 'window.worldPreview.dispose()');
    expect(disposal.disposedInstances).toBe(disposal.instanceCount);
    console.info('World render metrics', JSON.stringify(metrics));
  }, 120_000);
});
