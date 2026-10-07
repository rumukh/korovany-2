import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createCampaign } from '../src/game';
import { CORPSE_SLOPE, Presentation } from '../src/view';
import { V3_GRADE } from '../src/view/atmosphere';
import { crowHomes, flockHomes } from '../src/view/fauna';
import { ViewResources } from '../src/view/resources';
import { terrainFor } from '../src/view/terrain';
import { SURFACE_SIZE, WorldAssetLibrary, worldAssetIds, type WorldAssetSource, type WorldModelId } from '../src/view/world-assets';
import { parseGlbWithoutTextures } from './glb';
import { fakeSurfaceAlbedo } from './world-surfaces';

const shipped = new URL('../public/world/', import.meta.url);
/** Node source: the shipped GLBs through three's meshopt decoder (no textures), and mid-grey surface layers. */
const nodeSource: WorldAssetSource = {
  model: (id: WorldModelId) => parseGlbWithoutTextures(new Uint8Array(readFileSync(new URL(`${id}/${id}.glb`, shipped)))),
  image: async () => ({ width: SURFACE_SIZE, height: SURFACE_SIZE, data: new Uint8ClampedArray(SURFACE_SIZE * SURFACE_SIZE * 4).fill(128) }),
  surfaceAlbedo: async () => fakeSurfaceAlbedo(),
};

async function presentation(version: 2 | 3) {
  const snapshot = createCampaign({ seed: 'v3-view', faction: 'elf', runId: 'v3-view', worldVersion: version }).snapshot();
  const library = new WorldAssetLibrary(nodeSource);
  await library.request(worldAssetIds(snapshot.world));
  const resources = new ViewResources(undefined, 1, undefined, library);
  return { snapshot, library, presentation: new Presentation(snapshot.world, resources) };
}

describe('version 3 presentation (DOM-free)', () => {
  test('builds terrain, scatter pools, flocks and flags; actors and the sun follow the ground', async () => {
    const { snapshot, library, presentation: view } = await presentation(3);
    const terrain = terrainFor(snapshot.world);
    expect(view.terrain).toBe(terrain);
    const chunks: THREE.Mesh[] = [];
    const pools: THREE.InstancedMesh[] = [];
    view.scene.traverse(object => {
      if (object instanceof THREE.InstancedMesh) pools.push(object);
      else if (object instanceof THREE.Mesh && object.name.startsWith('terrain:')) chunks.push(object);
    });
    expect(chunks.length).toBeGreaterThan(60);
    expect(view.scene.getObjectByName('world-apron')).toBeDefined();
    expect(pools.some(pool => pool.name.startsWith('kit-cottage-a:0'))).toBe(true);
    expect(pools.some(pool => pool.name.includes(':impostor'))).toBe(true);
    // Quantized props keep their cooked size (a transformed normalized attribute would clamp them to a 2 m cube).
    const hay = pools.find(pool => pool.name === 'prop-haystack:0:near')!;
    hay.geometry.computeBoundingBox();
    expect(hay.geometry.boundingBox!.max.y).toBeCloseTo(3.19, 1);
    expect(hay.geometry.boundingBox!.max.x - hay.geometry.boundingBox!.min.x).toBeGreaterThan(3.3);
    expect(view.fauna?.count).toBeGreaterThan(20);
    for (const site of snapshot.world.sites) expect(view.scenery.flagAnchors.get(site.id), site.id).toBeDefined();
    expect((view.scene.fog as THREE.Fog).color.getHexString()).toBe(V3_GRADE.fog.slice(1));

    // Put the hero on raised ground: the root, the sun target and the cutaway focus all follow the relief.
    let raised = { x: 0, z: 0, height: 0 };
    for (let z = -400; z <= 400 && raised.height < 1.5; z += 7) {
      for (let x = -400; x <= 400 && raised.height < 1.5; x += 7) {
        const height = terrain.height(x, z);
        if (height > raised.height) raised = { x, z, height };
      }
    }
    expect(raised.height).toBeGreaterThan(1.5);
    const frame = structuredClone(snapshot);
    frame.player.x = raised.x;
    frame.player.z = raised.z;
    const soldier = frame.actors.find(actor => actor.kind === 'soldier')!;
    soldier.x = raised.x + 1.5;
    soldier.z = raised.z;
    frame.tick += 1;
    const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.25, 290);
    camera.position.set(raised.x, raised.height + 12, raised.z - 22);
    camera.lookAt(raised.x, raised.height, raised.z);
    camera.updateMatrixWorld();
    view.update(frame, 1 / 60, camera, true);
    const actor = view.scene.getObjectByName(`actor:${soldier.id}`)!;
    expect(actor.position.y).toBeCloseTo(terrain.height(soldier.x, soldier.z) + 0.08, 6);
    expect(view.sun.target.position.y).toBeCloseTo(raised.height, 6);
    expect(view.scenery.heroPosition.y).toBeCloseTo(raised.height + 1.15, 6);

    // A corpse on a slope lies along it: its up axis is the terrain normal (refinement 3); a living soldier stays upright.
    let sloped = { x: 0, z: 0, slope: 0 };
    for (let z = -400; z <= 400 && sloped.slope < CORPSE_SLOPE * 2; z += 3) {
      for (let x = -400; x <= 400 && sloped.slope < CORPSE_SLOPE * 2; x += 3) {
        const slope = terrain.slope(x, z);
        if (slope > sloped.slope) sloped = { x, z, slope };
      }
    }
    expect(sloped.slope).toBeGreaterThan(CORPSE_SLOPE * 2);
    const up = (object: THREE.Object3D) => new THREE.Vector3(0, 1, 0).applyQuaternion(object.quaternion);
    const pose = (state: 'idle' | 'dead') => {
      const next = structuredClone(frame);
      const body = next.actors.find(candidate => candidate.id === soldier.id)!;
      Object.assign(body, { x: sloped.x, z: sloped.z, heading: 0.7, state, hp: state === 'dead' ? 0 : body.maxHp });
      next.tick += 1;
      view.update(next, 1 / 60, camera, true);
      return up(view.scene.getObjectByName(`actor:${soldier.id}`)!);
    };
    const normal = terrain.normal(sloped.x, sloped.z);
    expect(pose('idle').toArray().map(v => +v.toFixed(6))).toEqual([0, 1, 0]);
    const lying = pose('dead');
    expect(lying.angleTo(new THREE.Vector3(normal.x, normal.y, normal.z))).toBeLessThan(1e-5);
    // The heading still points the body the same way across the slope.
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(view.scene.getObjectByName(`actor:${soldier.id}`)!.quaternion);
    expect(Math.atan2(forward.x, forward.z)).toBeCloseTo(0.7, 1);

    // Flocks out of sight leave the scene graph (three walks every attached node's matrices each frame) and return
    // whole when the hero comes near; none is lost. Crows count as flocks too.
    const flock = view.scene.getObjectByName('world-fauna')!;
    const homes = flockHomes(snapshot.world);
    const crows = crowHomes(snapshot.world);
    expect(view.fauna!.crowCount).toBe(crows.reduce((sum, home) => sum + home.count, 0));
    let away: { x: number; z: number } | undefined;
    for (let z = -440; z <= 440 && !away; z += 20) {
      for (let x = -440; x <= 440 && !away; x += 20) {
        if ([...homes, ...crows].every(home => Math.hypot(home.x - x, home.z - z) > 160)) away = { x, z };
      }
    }
    expect(away).toBeDefined();
    const at = (point: { x: number; z: number }) => {
      const next = structuredClone(frame);
      next.player.x = point.x;
      next.player.z = point.z;
      next.tick += 1;
      view.update(next, 1 / 60, camera, true);
    };
    at(away!);
    expect(flock.children).toHaveLength(0);
    at(homes[0]!);
    const near = flock.children.filter(sheep => sheep.name.startsWith(`sheep:${homes[0]!.id}:`));
    expect(near).toHaveLength(homes[0]!.count);
    for (const sheep of flock.children) {
      expect(sheep.visible).toBe(true);
      expect(Math.hypot(sheep.position.x - homes[0]!.x, sheep.position.z - homes[0]!.z)).toBeLessThan(120);
    }
    expect(view.fauna!.count).toBe(homes.reduce((sum, home) => sum + home.count, 0));

    // Every instance pool and static batch is released with the presentation.
    let disposed = 0;
    for (const pool of pools) pool.addEventListener('dispose', () => disposed++);
    view.dispose();
    expect(disposed).toBe(pools.length);
    library.dispose();
  }, 120_000);

  test('version 2 presentations keep the flat ground, their lights and no world assets', async () => {
    const { snapshot, presentation: view } = await presentation(2);
    expect(worldAssetIds(snapshot.world)).toEqual([]);
    expect(view.terrain.flat).toBe(true);
    expect(view.fauna).toBeUndefined();
    expect((view.scene.fog as THREE.Fog).color.getHexString()).not.toBe(V3_GRADE.fog.slice(1));
    expect(view.scene.getObjectByName('world-v3')).toBeUndefined();
    view.dispose();
  }, 60_000);
});
