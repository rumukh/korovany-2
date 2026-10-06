import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createCampaign, generateWorld } from '../src/game';
import type { GameSnapshot, WorldBlueprint } from '../src/game/types';
import { isWalkable } from '../src/game/world';
import { Presentation } from '../src/view';
import { V3_GRADE } from '../src/view/atmosphere';
import { ViewResources } from '../src/view/resources';
import { AIR_EDGE, REGION_AIR, regionWeights, targetAir, WEATHER_COUNTS, weatherDensity } from '../src/view/weather';
import { SURFACE_SIZE, WorldAssetLibrary, worldAssetIds, type WorldAssetSource, type WorldModelId } from '../src/view/world-assets';
import { parseGlbWithoutTextures } from './glb';

// W5: each wild region's air (the fog grade the sky's horizon follows) and its weather (leaves, ash, snow, fen wisps),
// presentation only and version 3 only.
const shipped = new URL('../public/world/', import.meta.url);
const nodeSource: WorldAssetSource = {
  model: (id: WorldModelId) => parseGlbWithoutTextures(new Uint8Array(readFileSync(new URL(`${id}/${id}.glb`, shipped)))),
  image: async () => ({ width: SURFACE_SIZE, height: SURFACE_SIZE, data: new Uint8ClampedArray(SURFACE_SIZE * SURFACE_SIZE * 4).fill(128) }),
};

async function presentation(version: 2 | 3) {
  const snapshot = createCampaign({ seed: 'weather', faction: 'guard', runId: 'weather', worldVersion: version }).snapshot();
  const library = new WorldAssetLibrary(nodeSource);
  await library.request(worldAssetIds(snapshot.world));
  return { snapshot, library, view: new Presentation(snapshot.world, new ViewResources(undefined, 1, undefined, library)) };
}

/** A walkable spot deep inside a region (at least 60 m from its border). */
function deepIn(world: WorldBlueprint, id: string): { x: number; z: number } {
  const b = world.exploration!.regions.find(region => region.id === id)!.bounds;
  for (let r = 0; r < 120; r += 3) {
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * Math.PI * 2, p = { x: (b.minX + b.maxX) / 2 + Math.sin(a) * r, z: (b.minZ + b.maxZ) / 2 + Math.cos(a) * r };
      if (Math.min(p.x - b.minX, b.maxX - p.x, p.z - b.minZ, b.maxZ - p.z) >= 60 && isWalkable(world, p, 1)) return p;
    }
  }
  throw new Error(`no walkable spot deep in ${id}`);
}

const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.25, 290);
function at(view: Presentation, snapshot: GameSnapshot, p: { x: number; z: number }, seconds: number, reducedMotion = false): void {
  const frame = structuredClone(snapshot);
  frame.player.x = p.x;
  frame.player.z = p.z;
  for (let i = 0; i < seconds * 30; i++) {
    frame.tick += 1;
    view.update(frame, 1 / 30, camera, reducedMotion);
  }
}

describe('W5 regional air and weather (DOM-free)', () => {
  test('region weights are 1 deep inside a region and ease to 0 across its last 40 m', () => {
    const world = generateWorld('weather', 3);
    const fen = world.exploration!.regions.find(region => region.id === 'fenlands')!.bounds;
    const deep = deepIn(world, 'fenlands');
    expect(regionWeights(world, deep).get('fenlands')).toBe(1);
    // 10 m inside the fens' east border (it meets the heartlands): partly fen air.
    const z = (fen.minZ + fen.maxZ) / 2;
    const edge = regionWeights(world, { x: fen.maxX - 10, z }).get('fenlands')!;
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(0.5);
    expect(regionWeights(world, { x: fen.maxX - AIR_EDGE - 1, z }).get('fenlands')).toBe(1);
    // The heartlands keep the base grade; each wild region has its own air and kinds.
    expect(REGION_AIR.heartlands).toBeUndefined();
    const color = new THREE.Color();
    expect(targetAir(new Map([['heartlands', 1]]), color)).toEqual({ near: V3_GRADE.fogNear, far: V3_GRADE.fogFar });
    expect(color.getHexString()).toBe(V3_GRADE.fog.slice(1));
    const fens = targetAir(new Map([['fenlands', 1]]), color);
    expect(color.getHexString()).toBe(REGION_AIR.fenlands!.fog.slice(1));
    expect(fens.near).toBeLessThan(V3_GRADE.fogNear);
    expect(fens.far).toBeLessThan(V3_GRADE.fogFar);
    // Darker airs are reached too (a component sum, not a clamped subtraction).
    targetAir(new Map([['greenmarch', 1]]), color);
    expect(color.getHexString()).toBe(REGION_AIR.greenmarch!.fog.slice(1));
    expect(weatherDensity(new Map([['ashsteppe', 1]]))).toEqual({ leaves: 0, ash: 1, snow: 0, wisps: 0 });
    expect(weatherDensity(new Map([['frostspine', 1]]))).toEqual({ leaves: 0, ash: 0, snow: 1, wisps: 0 });
    expect(weatherDensity(new Map([['fenlands', 1]]))).toEqual({ leaves: 0, ash: 0, snow: 0, wisps: 1 });
    expect(weatherDensity(new Map([['hollowvale', 1]]))).toEqual({ leaves: 1, ash: 0, snow: 0, wisps: 0 });
    expect(weatherDensity(new Map([['heartlands', 1]]))).toEqual({ leaves: 0, ash: 0, snow: 0, wisps: 0 });
  });

  test('a version 3 presentation eases its fog and sky to each region, shows the weather only with motion at high quality', async () => {
    const { snapshot, library, view } = await presentation(3);
    const weather = view.weather!;
    expect(weather).toBeDefined();
    expect(view.scene.getObjectByName('world-weather')).toBe(weather.points);
    const total = Object.values(WEATHER_COUNTS).reduce((sum, count) => sum + count, 0);
    expect(weather.points.geometry.getAttribute('position').count).toBe(total);
    const fog = view.scene.fog as THREE.Fog;
    const horizon = () => {
      let colour: THREE.Color | undefined;
      view.scenery.group.traverse(object => {
        const material = (object as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
        if (material?.isShaderMaterial && material.uniforms.horizon) colour = material.uniforms.horizon.value as THREE.Color;
      });
      return colour!;
    };
    // Home (heartlands): the base grade, no particles.
    const home = snapshot.world.sites.find(site => site.kind === 'home')!;
    at(view, snapshot, home, 1);
    expect(fog.color.getHexString()).toBe(V3_GRADE.fog.slice(1));
    expect(weather.points.visible).toBe(false);
    for (const [region, kind] of [['fenlands', 'wisps'], ['ashsteppe', 'ash'], ['frostspine', 'snow'], ['greenmarch', 'leaves']] as const) {
      const spot = deepIn(snapshot.world, region);
      at(view, snapshot, spot, 12);
      const air = REGION_AIR[region]!;
      const target = new THREE.Color(air.fog);
      expect(Math.abs(fog.color.r - target.r) + Math.abs(fog.color.g - target.g) + Math.abs(fog.color.b - target.b), region).toBeLessThan(0.01);
      expect(fog.near, region).toBeCloseTo(air.near, 0);
      expect(fog.far, region).toBeCloseTo(air.far, 0);
      // The sky's horizon and the background are the fog's colour: no seam where the ground meets the sky.
      expect(horizon().getHexString(), region).toBe(fog.color.getHexString());
      expect((view.scene.background as THREE.Color).getHexString(), region).toBe(fog.color.getHexString());
      expect(weather.points.visible, region).toBe(true);
      const density = (weather.points.material as THREE.ShaderMaterial).uniforms.uDensity!.value as number[];
      expect(density[['leaves', 'ash', 'snow', 'wisps'].indexOf(kind)], `${region} ${kind}`).toBe(1);
      expect(density.filter(value => value > 0), region).toHaveLength(1);
      // Reduced motion keeps the air but stills the weather; so does low quality.
      at(view, snapshot, spot, 0.1, true);
      expect(weather.points.visible, `${region} reduced motion`).toBe(false);
      expect(fog.near, region).toBeCloseTo(air.near, 0);
      view.setQuality(true);
      at(view, snapshot, spot, 0.1);
      expect(weather.points.visible, `${region} low quality`).toBe(false);
      view.setQuality(false);
    }
    // Back home the air clears again.
    at(view, snapshot, home, 12);
    expect(fog.color.getHexString()).toBe(V3_GRADE.fog.slice(1));
    expect(fog.near).toBeCloseTo(V3_GRADE.fogNear, 1);
    let disposed = false;
    weather.points.geometry.addEventListener('dispose', () => { disposed = true; });
    view.dispose();
    expect(disposed).toBe(true);
    library.dispose();
  }, 120_000);

  test('the particle cloud is the same for every load of a world', async () => {
    const one = await presentation(3), two = await presentation(3);
    const a = one.view.weather!.points.geometry.getAttribute('position').array;
    const b = two.view.weather!.points.geometry.getAttribute('position').array;
    expect(Array.from(a)).toEqual(Array.from(b));
    for (const { view, library } of [one, two]) { view.dispose(); library.dispose(); }
  }, 120_000);

  test('version 2 presentations have no weather and keep their own fog', async () => {
    const { snapshot, view } = await presentation(2);
    expect(view.weather).toBeUndefined();
    expect(view.scene.getObjectByName('world-weather')).toBeUndefined();
    const fog = view.scene.fog as THREE.Fog;
    const before = { color: fog.color.getHexString(), near: fog.near, far: fog.far };
    at(view, snapshot, { x: -300, z: 0 }, 2);
    expect({ color: fog.color.getHexString(), near: fog.near, far: fog.far }).toEqual(before);
    view.dispose();
  }, 60_000);
});
