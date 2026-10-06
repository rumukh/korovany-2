import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createCampaign, generateWorld } from '../src/game';
import { isWalkable, lakeClearance } from '../src/game/world';
import { Presentation } from '../src/view';
import { ViewResources } from '../src/view/resources';
import { shoreDressing, SHORES } from '../src/view/shores';
import { LAKE_BANK, terrainFor } from '../src/view/terrain';
import { drawnHeight, LAKE_BEDS, SEA_REACH } from '../src/view/terrain-mesh';
import { riverToCoast, WATER_LEVEL, waterGeometry, waterTint } from '../src/view/waters';
import { SHORE_MODELS, SURFACE_SIZE, TREE_VARIANTS, WORLD_MODELS, WorldAssetLibrary, worldAssetIds, type WorldAssetSource,
  type WorldModelId } from '../src/view/world-assets';
import { parseGlbWithoutTextures } from './glb';

// W3b presentation of the water: the river, the lakes and the sea in one mesh, beds carved below it, level banks, and the
// reed beds, drowned trees and stumps and the sea's boulders, all presentation only.
const worlds = ['shores-a', 'shores-b'].map(seed => generateWorld(seed, 3));

const shipped = new URL('../public/world/', import.meta.url);
const nodeSource: WorldAssetSource = {
  model: (id: WorldModelId) => parseGlbWithoutTextures(new Uint8Array(readFileSync(new URL(`${id}/${id}.glb`, shipped)))),
  image: async () => ({ width: SURFACE_SIZE, height: SURFACE_SIZE, data: new Uint8ClampedArray(SURFACE_SIZE * SURFACE_SIZE * 4).fill(128) }),
};

describe('version 3 water presentation', () => {
  test('one water mesh holds the river to the coast, every lake and the open sea, every face looking up', () => {
    for (const world of worlds) {
      const geometry = waterGeometry(world);
      const position = geometry.getAttribute('position'), water = geometry.getAttribute('water');
      const index = geometry.getIndex()!;
      expect(index.count % 3).toBe(0);
      for (let i = 0; i < position.count; i++) {
        expect(position.getY(i)).toBeCloseTo(WATER_LEVEL, 6);
        expect(water.getX(i)).toBeGreaterThanOrEqual(0);
        expect(water.getX(i)).toBeLessThanOrEqual(1);
      }
      let area = 0;
      for (let t = 0; t < index.count; t += 3) {
        const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
        const ux = position.getX(b) - position.getX(a), uz = position.getZ(b) - position.getZ(a);
        const vx = position.getX(c) - position.getX(a), vz = position.getZ(c) - position.getZ(a);
        const up = uz * vx - ux * vz;
        expect(up, `triangle ${t / 3}`).toBeGreaterThanOrEqual(0);
        area += up / 2;
      }
      // Every lake's area is covered (its fan and band), plus the river and the open sea.
      const lakes = world.lakes!.filter(l => l.kind !== 'sea').reduce((sum, l) => sum + Math.abs(l.shore.reduce((s, p, i) => {
        const q = l.shore[(i + 1) % l.shore.length]!;
        return s + p.x * q.z - q.x * p.z;
      }, 0)) / 2, 0);
      expect(area).toBeGreaterThan(lakes + 900 * 10);
      let farthest = -Infinity;
      for (let i = 0; i < position.count; i++) farthest = Math.max(farthest, position.getX(i));
      expect(farthest).toBe(world.bounds.maxX + SEA_REACH);
      const river = riverToCoast(world), sea = world.lakes!.find(l => l.kind === 'sea')!;
      expect(river.maxX).toBeLessThan(world.bounds.maxX);
      expect(lakeClearance(sea, { x: river.maxX + 0.5, z: 0 })).toBeLessThan(0);
      expect(lakeClearance(sea, { x: river.maxX - 1, z: 0 })).toBeGreaterThan(0);
      expect(new Set(world.lakes!.map(l => waterTint(world, l)))).toEqual(new Set(['mere', 'pool', 'steppe', 'tarn', 'sea']));
    }
  });

  test('lakes lie level with a level bank, their beds carved below the water; the drawn ground leaves dry land as it was', () => {
    for (const world of worlds) {
      const terrain = terrainFor(world);
      for (const lake of world.lakes!) {
        const bed = LAKE_BEDS[lake.kind];
        for (const [k, a] of lake.shore.entries()) {
          if (k % 4) continue;
          if (lake.kind === 'sea' && a.x >= world.bounds.maxX) continue;
          const d = Math.hypot(a.x - lake.x, a.z - lake.z), ux = (a.x - lake.x) / d, uz = (a.z - lake.z) / d;
          for (const out of [0, 2, LAKE_BANK - 1.5]) {
            const p = { x: a.x + ux * out, z: a.z + uz * out };
            if (p.x > world.bounds.maxX || p.x < world.bounds.minX || p.z > world.bounds.maxZ || p.z < world.bounds.minZ) continue;
            if (lake.kind !== 'sea') expect(terrain.height(p.x, p.z), `${lake.id} bank +${out}`).toBe(0);
          }
          const inside = { x: a.x - ux * 1.5, z: a.z - uz * 1.5 };
          if (lake.kind !== 'sea' && lakeClearance(lake, inside) < -1) {
            expect(drawnHeight(world, terrain, inside.x, inside.z), lake.id).toBeLessThan(WATER_LEVEL - 0.05);
            expect(drawnHeight(world, terrain, lake.x, lake.z), lake.id).toBeCloseTo(-bed.depth, 1);
          }
        }
      }
      // Dry ground keeps the relief exactly; far out in the open sea the bed lies at its full depth.
      for (let i = 0; i < 400; i++) {
        const x = -480 + (i * 37) % 960, z = -480 + (i * 53) % 960;
        const wet = world.lakes!.some(l => lakeClearance(l, { x, z }) < 0) || Math.abs(z) < 6;
        if (!wet) expect(drawnHeight(world, terrain, x, z)).toBe(terrain.height(x, z));
      }
      expect(drawnHeight(world, terrain, world.bounds.maxX + 200, 10)).toBeCloseTo(-LAKE_BEDS.sea.depth, 3);
    }
  });

  test('reed beds, drowned trees, stumps and sea boulders are deterministic, registered, and keep to the water', () => {
    expect(WORLD_MODELS['plant-reeds'].kind).toBe('tree');
    expect(TREE_VARIANTS['plant-reeds']).toBe(3);
    for (const world of worlds) {
      expect(worldAssetIds(world)).toEqual(expect.arrayContaining([...SHORE_MODELS]));
      const pieces = shoreDressing(world);
      expect(shoreDressing(world)).toEqual(pieces);
      const count = (id: string): number => pieces.filter(p => p.id === id).length;
      expect(count('plant-reeds'), String(world.seed)).toBeGreaterThan(800);
      expect(count('tree-deadoak') + count('tree-deadbirch'), String(world.seed)).toBeGreaterThanOrEqual(6);
      expect(count('wood-stump'), String(world.seed)).toBeGreaterThanOrEqual(4);
      expect(count('rock-boulder'), String(world.seed)).toBeGreaterThanOrEqual(15);
      expect(world.obstacles.some(o => o.model === 'plant-reeds')).toBe(false);
      for (const piece of pieces) {
        const shore = Math.min(...world.lakes!.map(l => lakeClearance(l, piece)));
        if (piece.id === 'plant-reeds') {
          expect(shore, `reeds at ${piece.x},${piece.z}`).toBeGreaterThanOrEqual(-3.7);
          expect(shore, `reeds at ${piece.x},${piece.z}`).toBeLessThanOrEqual(1.3);
          if (shore > 0) expect(isWalkable(world, piece, 0.4)).toBe(true);
          expect(piece.variant).toBeLessThan(3);
        } else if (piece.id === 'rock-boulder') {
          expect(shore, `boulder at ${piece.x},${piece.z}`).toBeLessThanOrEqual(0.7 - piece.scale + 1e-9);
        } else {
          expect(shore, `${piece.id} at ${piece.x},${piece.z}`).toBeLessThanOrEqual(-0.8 + 1e-9);
        }
      }
      for (const place of world.exploration!.locations) {
        expect(pieces.every(p => Math.hypot(p.x - place.x, p.z - place.z) > place.radius + 10), place.id).toBe(true);
      }
    }
    // Tarns get only a few rushes, meres the densest reed beds.
    expect(SHORES.tarn.reeds).toBeLessThan(SHORES.pool.reeds);
    expect(SHORES.pool.reeds).toBeLessThan(SHORES.mere.reeds);
  });

  test('a version 3 presentation draws all water in one mesh on one program, and none of the v1/v2 river plane', async () => {
    const snapshot = createCampaign({ seed: 'v3-water', faction: 'guard', runId: 'v3-water', worldVersion: 3 }).snapshot();
    const library = new WorldAssetLibrary(nodeSource);
    await library.request(worldAssetIds(snapshot.world));
    const view = new Presentation(snapshot.world, new ViewResources(undefined, 1, undefined, library));
    const water = view.scene.getObjectByName('world-water') as THREE.Mesh;
    expect(water).toBeInstanceOf(THREE.Mesh);
    expect((water.material as THREE.Material).customProgramCacheKey()).toBe('korovany-water-v3');
    let planes = 0;
    view.scene.traverse(object => {
      if (object instanceof THREE.Mesh && !Array.isArray(object.material) && object.material.customProgramCacheKey?.() === 'frontier-water-v2') planes++;
    });
    expect(planes).toBe(0);
    view.dispose();
  });
});
