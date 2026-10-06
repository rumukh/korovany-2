import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createCampaign } from '../src/game';
import { generateWorld, isWalkable } from '../src/game/world';
import { Presentation } from '../src/view';
import { herdHomes } from '../src/view/herds';
import { ViewResources } from '../src/view/resources';
import { SURFACE_SIZE, WorldAssetLibrary, worldAssetIds, type WorldAssetSource, type WorldModelId } from '../src/view/world-assets';
import { parseGlbWithoutTextures } from './glb';

const shipped = new URL('../public/world/', import.meta.url);
const nodeSource: WorldAssetSource = {
  model: (id: WorldModelId) => parseGlbWithoutTextures(new Uint8Array(readFileSync(new URL(`${id}/${id}.glb`, shipped)))),
  image: async () => ({ width: SURFACE_SIZE, height: SURFACE_SIZE, data: new Uint8ClampedArray(SURFACE_SIZE * SURFACE_SIZE * 4).fill(128) }),
};
const DEER_REGIONS = ['greenmarch', 'hollowvale', 'heartlands', 'crownlands'];
const GOAT_REGIONS = ['frostspine', 'crownlands', 'ashsteppe'];

describe('version 3 deer and goat herds', () => {
  test('herd homes are deterministic, in their own lands, in the open and away from people', () => {
    let deer = 0, goats = 0;
    for (const seed of ['herds-a', 'herds-b', 'herds-c']) {
      const world = generateWorld(seed, 3);
      const homes = herdHomes(world);
      expect(homes).toEqual(herdHomes(generateWorld(seed, 3)));
      const region = (x: number, z: number) => world.exploration!.regions.find(r => x >= r.bounds.minX && x <= r.bounds.maxX && z >= r.bounds.minZ && z <= r.bounds.maxZ)!.id;
      for (const home of homes) {
        expect(isWalkable(world, home, 3), home.id).toBe(true);
        expect(home.breed === 'deer' ? DEER_REGIONS : GOAT_REGIONS, home.id).toContain(region(home.x, home.z));
        for (const place of [...world.exploration!.locations, ...world.sites]) {
          expect(Math.hypot(place.x - home.x, place.z - home.z) - place.radius, `${home.id} near ${place.id}`).toBeGreaterThanOrEqual(45);
        }
        for (const other of homes) if (other !== home) expect(Math.hypot(other.x - home.x, other.z - home.z)).toBeGreaterThanOrEqual(60);
        const near = world.obstacles.filter(o => Math.hypot(o.x - home.x, o.z - home.z) < 30);
        if (home.breed === 'deer') {
          expect(near.filter(o => o.kind === 'tree' && Math.hypot(o.x - home.x, o.z - home.z) < 20).length, home.id).toBeGreaterThanOrEqual(6);
          expect(home.count).toBeGreaterThanOrEqual(3);
          expect(home.count).toBeLessThanOrEqual(6);
          deer++;
        } else {
          expect(world.obstacles.some(o => o.model?.startsWith('rock-crag-') && Math.hypot(o.x - home.x, o.z - home.z) - o.radius < 22), home.id).toBe(true);
          expect(home.count).toBeGreaterThanOrEqual(4);
          expect(home.count).toBeLessThanOrEqual(7);
          goats++;
        }
      }
    }
    // Most of the planned herds (9 deer and 6 goat herds a world) find a home on every seed.
    expect(deer).toBeGreaterThanOrEqual(3 * 6);
    expect(goats).toBeGreaterThanOrEqual(3 * 4);
    expect(herdHomes(generateWorld('herds-a', 2))).toEqual([]);
    expect(herdHomes(generateWorld('herds-a', 1))).toEqual([]);
  });

  test('a version 3 presentation loads the deer and goat, hides far herds, shows near ones posed, and alarms a herd', async () => {
    const snapshot = createCampaign({ seed: 'v3-herds', faction: 'elf', runId: 'v3-herds', worldVersion: 3 }).snapshot();
    const ids = worldAssetIds(snapshot.world);
    expect(ids).toEqual(expect.arrayContaining(['char-deer', 'char-goat']));
    expect(worldAssetIds(createCampaign({ seed: 'v3-herds', faction: 'elf', runId: 'v3-herds', worldVersion: 2 }).snapshot().world)).toEqual([]);
    const library = new WorldAssetLibrary(nodeSource);
    await library.request(ids);
    const view = new Presentation(snapshot.world, new ViewResources(undefined, 1, undefined, library));
    const homes = herdHomes(snapshot.world);
    expect(view.herds!.count).toBe(homes.reduce((sum, home) => sum + home.count, 0));
    const group = view.scene.getObjectByName('world-herds')!;
    const camera = new THREE.PerspectiveCamera();
    const frame = structuredClone(snapshot);
    const at = (point: { x: number; z: number }, dt = 1 / 60) => {
      frame.player.x = point.x;
      frame.player.z = point.z;
      frame.tick += 1;
      view.update(frame, dt, camera, false);
    };
    // Far from every herd nothing is attached (three walks every attached node's matrices each frame).
    let away: { x: number; z: number } | undefined;
    for (let z = -440; z <= 440 && !away; z += 20) {
      for (let x = -440; x <= 440 && !away; x += 20) if (homes.every(home => Math.hypot(home.x - x, home.z - z) > 200)) away = { x, z };
    }
    at(away!);
    expect(group.children).toHaveLength(0);
    for (const breed of ['deer', 'goat'] as const) {
      const home = homes.find(candidate => candidate.breed === breed)!;
      // The hero stands 30 m off: the herd is drawn, posed on the ground, and grazing or idle, not fleeing.
      const watch = { x: home.x + 30, z: home.z };
      at(watch);
      const herd = group.children.filter(animal => animal.name.startsWith(`${breed}:${home.id}:`));
      expect(herd, breed).toHaveLength(home.count);
      for (const animal of herd) {
        expect(animal.visible).toBe(true);
        expect(Math.abs(animal.position.y - view.terrain.height(animal.position.x, animal.position.z))).toBeLessThan(1e-6);
      }
      // Walking into the herd alarms it: within a second every animal has moved away from the hero.
      const before = herd.map(animal => Math.hypot(animal.position.x - home.x, animal.position.z - home.z) + 0);
      const starts = herd.map(animal => animal.position.clone());
      for (let step = 0; step < 90; step++) at({ x: home.x, z: home.z }, 1 / 60);
      const moved = herd.filter((animal, index) => animal.position.distanceTo(starts[index]!) > 0.5).length;
      expect(moved, `${breed} herd of ${herd.length} fled (${before.length})`).toBe(herd.length);
    }
    view.dispose();
    expect(view.scene.getObjectByName('world-herds')).toBeUndefined();
    library.dispose();
  });
});
