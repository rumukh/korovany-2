import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { WorldBlueprint } from '../game/types';
import { createActor, createWagon } from './actors';
import { BATTLE_FRAMING, FollowCamera } from './camera';
import { seededRandom, ViewResources } from './resources';
import { createWorldScenery, distanceToSegment, dressingFilter, isDressingAllowed } from './world';

function canvasBox() {
  return {
    getBoundingClientRect(): DOMRect {
      return { x: 40, y: 80, width: 1366, height: 768, top: 80, left: 40, right: 1406, bottom: 848, toJSON: () => ({}) };
    },
  };
}

function testWorld(): WorldBlueprint {
  return {
    version: 1, seed: 'view-unit-test', id: 'view-world',
    bounds: { minX: -70, maxX: 70, minZ: -70, maxZ: 70 },
    river: { minX: -70, maxX: 70, minZ: -5, maxZ: 5 },
    bridges: [{ minX: -5, maxX: 5, minZ: -8, maxZ: 8 }],
    roads: {
      nodes: [{ id: 'home', x: 0, z: -30 }, { id: 'post', x: 0, z: 30 }],
      edges: [{ from: 'home', to: 'post', width: 8 }],
    },
    sites: [{ id: 'home', nameKey: 'home', kind: 'home', faction: 'elf', radius: 5, x: 0, z: -30 }],
    obstacles: [
      { id: 'tree', kind: 'tree', x: 16, z: 16, radius: 1.4, height: 6, variant: 1 },
      { id: 'wall', kind: 'wall', x: 6, z: -38, radius: 1.8, height: 3, variant: 0 },
    ],
    biomes: [{ kind: 'forest', bounds: { minX: -70, maxX: 0, minZ: -70, maxZ: 70 } }],
  };
}

describe('shell-controlled camera', () => {
  it('keeps forward and right orthonormal throughout orbit', () => {
    const camera = new FollowCamera(canvasBox());
    for (let index = 0; index < 40; index += 1) {
      camera.orbit(0.3, 0.07);
      const { forward, right } = camera.getMoveBasis();
      expect(Math.hypot(forward.x, forward.z)).toBeCloseTo(1);
      expect(Math.hypot(right.x, right.z)).toBeCloseTo(1);
      expect(forward.x * right.x + forward.z * right.z).toBeCloseTo(0);
    }
  });

  it('unprojects client coordinates using the actual canvas offset', () => {
    const camera = new FollowCamera(canvasBox());
    camera.resize(1366, 768);
    camera.update({ x: 12, z: -24 }, 1 / 60);
    const point = new THREE.Vector3(12, 0, -24).project(camera.camera);
    const aim = camera.screenToWorld(40 + (point.x + 1) * 683, 80 + (1 - point.y) * 384);
    expect(aim?.x).toBeCloseTo(12, 5);
    expect(aim?.z).toBeCloseTo(-24, 5);
    expect(camera.screenToWorld(Number.NaN, 80)).toBeNull();
  });

  it('snaps on teleport/reset and caps dangerous orbit and zoom', () => {
    const camera = new FollowCamera(canvasBox());
    camera.resize(1366, 768);
    camera.orbit(100, -100);
    camera.zoom(-1e9);
    camera.update({ x: 60, z: 60 }, 0);
    expect(camera.camera.position.y).toBeGreaterThan(7);
    expect(camera.camera.position.distanceTo(new THREE.Vector3(60, 0.65, 60))).toBeCloseTo(18);
    expect(() => camera.orbit(Infinity)).toThrow('finite');
    expect(() => camera.zoom(NaN)).toThrow('finite');
  });

  it('frames a battle over the hero\'s shoulder, gives way to the player and restores pitch and distance afterwards', () => {
    const camera = new FollowCamera(canvasBox());
    camera.resize(1366, 768);
    camera.zoom(4000);
    camera.update({ x: 0, z: 0 }, 1 / 60);
    const road = camera.camera.position.clone();
    const focus = new THREE.Vector3(0, 0.65, 0);
    expect(road.distanceTo(focus)).toBeCloseTo(40);
    const heading = 2.1;
    camera.frameBattle(heading);
    camera.update({ x: 0, z: 0 }, 1 / 60);
    // It eases in rather than cutting.
    expect(camera.camera.position.distanceTo(focus)).toBeGreaterThan(BATTLE_FRAMING.distance + 1);
    for (let i = 0; i < 180; i++) camera.update({ x: 0, z: 0 }, 1 / 60);
    const framed = camera.camera.position;
    expect(framed.distanceTo(focus)).toBeCloseTo(BATTLE_FRAMING.distance, 3);
    expect(Math.cos(Math.atan2(framed.x, framed.z) - (heading + Math.PI + BATTLE_FRAMING.shoulder))).toBeCloseTo(1, 5);
    // Behind the hero: forward points the way the hero faces, towards the foe.
    const { forward } = camera.getMoveBasis();
    expect(forward.x * Math.sin(heading) + forward.z * Math.cos(heading)).toBeGreaterThan(Math.cos(BATTLE_FRAMING.shoulder) - 1e-6);
    camera.endBattle();
    for (let i = 0; i < 180; i++) camera.update({ x: 0, z: 0 }, 1 / 60);
    const elevation = (point: THREE.Vector3): number => Math.asin((point.y - focus.y) / point.distanceTo(focus));
    expect(camera.camera.position.distanceTo(focus)).toBeCloseTo(40, 3);
    expect(elevation(camera.camera.position)).toBeCloseTo(elevation(road), 3);
    // The player's own orbit takes over from a framing in progress; reduced motion frames at once.
    camera.frameBattle(0);
    camera.orbit(0.2);
    for (let i = 0; i < 180; i++) camera.update({ x: 0, z: 0 }, 1 / 60);
    expect(camera.camera.position.distanceTo(focus)).toBeCloseTo(40, 3);
    camera.endBattle();
    camera.setReducedMotion(true);
    camera.frameBattle(heading);
    camera.update({ x: 0, z: 0 }, 1 / 60);
    expect(camera.camera.position.distanceTo(focus)).toBeCloseTo(BATTLE_FRAMING.distance, 5);
    expect(() => camera.frameBattle(Number.NaN)).toThrow('finite');
  });
});

describe('authoritative scenery boundary', () => {
  it('keeps dressing out of roads, water, sites and obstacle footprints', () => {
    const world = testWorld();
    expect(isDressingAllowed(world, { x: 0, z: 12 })).toBe(false);
    expect(isDressingAllowed(world, { x: 30, z: 0 })).toBe(false);
    expect(isDressingAllowed(world, { x: 0, z: -32 })).toBe(false);
    expect(isDressingAllowed(world, { x: 16, z: 16 })).toBe(false);
    expect(isDressingAllowed(world, { x: 30, z: 30 })).toBe(true);
    expect(isDressingAllowed(world, { x: 71, z: 30 })).toBe(false);
  });

  it('handles degenerate road segments and reports broken graph references', () => {
    expect(distanceToSegment({ x: 3, z: 4 }, { x: 0, z: 0 }, { x: 0, z: 0 })).toBe(5);
    const world = testWorld();
    world.roads.edges[0] = { from: 'missing', to: 'post', width: 8 };
    expect(() => isDressingAllowed(world, { x: 30, z: 30 })).toThrow('unknown node');
    // The scenery build's filter reports it for the same points, and only for those that reach the roads.
    const allowed = dressingFilter(world);
    expect(() => allowed({ x: 30, z: 30 })).toThrow('unknown node');
    expect(allowed({ x: 71, z: 30 })).toBe(false);
  });

  it('builds deterministic scenery without changing the blueprint and releases instance buffers', () => {
    const world = testWorld();
    const before = JSON.stringify(world);
    const resources = new ViewResources();
    const scenery = createWorldScenery(resources, world);
    const instanceDisposals: ReturnType<typeof vi.fn>[] = [];
    scenery.group.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) {
        const disposed = vi.fn();
        object.addEventListener('dispose', disposed);
        instanceDisposals.push(disposed);
      }
    });
    expect(instanceDisposals.length).toBeGreaterThan(5);
    expect(instanceDisposals.length).toBeLessThan(90);
    expect(scenery.flagAnchors.get('home')?.x).toBeCloseTo(6.46);
    expect(JSON.stringify(world)).toBe(before);
    scenery.dispose();
    resources.dispose();
    expect(instanceDisposals.every((disposed) => disposed.mock.calls.length === 1)).toBe(true);
  });

  it('matches the exact bridge deck and keeps rails over blocked water, not land approaches', () => {
    const world = testWorld();
    const resources = new ViewResources();
    const scenery = createWorldScenery(resources, world);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    let deckFound = false;
    let rails = 0;
    scenery.group.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh) || !(object.geometry instanceof THREE.BoxGeometry)) return;
      for (let index = 0; index < object.count; index += 1) {
        object.getMatrixAt(index, matrix);
        matrix.decompose(position, quaternion, scale);
        if (Math.abs(position.y - 0.046) < 0.00001) {
          expect(position.x).toBe(0);
          expect(position.z).toBe(0);
          expect(scale.x).toBeCloseTo(10);
          expect(scale.z).toBeCloseTo(16);
          deckFound = true;
        }
        if (Math.abs(position.y - 0.68) < 0.00001) {
          expect(Math.abs(position.x) - scale.x / 2).toBeGreaterThan(5);
          expect(position.z - scale.z / 2).toBeGreaterThanOrEqual(-5);
          expect(position.z + scale.z / 2).toBeLessThanOrEqual(5);
          rails += 1;
        }
      }
    });
    expect(deckFound).toBe(true);
    expect(rails).toBe(2);
    scenery.dispose();
    resources.dispose();
  });
});

describe('procedural resources and rigs', () => {
  it('shares and disposes each material, geometry and texture exactly once', () => {
    const resources = new ViewResources();
    const geometry = resources.geometry('shared', () => new THREE.BoxGeometry());
    const material = resources.material('#ffffff');
    const texture = resources.ownTexture(new THREE.Texture());
    const depth = resources.depthMaterial();
    const disposed = vi.fn();
    geometry.addEventListener('dispose', disposed);
    material.addEventListener('dispose', disposed);
    texture.addEventListener('dispose', disposed);
    depth.addEventListener('dispose', disposed);
    expect(resources.depthMaterial()).toBe(depth);
    expect(resources.geometry('shared', () => new THREE.SphereGeometry())).toBe(geometry);
    expect(resources.material('#ffffff')).toBe(material);
    resources.dispose();
    resources.dispose();
    expect(disposed).toHaveBeenCalledTimes(4);
  });

  it('keeps seeded decoration stable between replays', () => {
    const a = seededRandom(123);
    const b = seededRandom(123);
    expect(Array.from({ length: 20 }, a)).toEqual(Array.from({ length: 20 }, b));
  });

  it('animates all faction heroes and the covered wagon without invalid transforms', () => {
    const resources = new ViewResources();
    for (const faction of ['elf', 'guard', 'villain'] as const) {
      const actor = createActor(resources, 'hero', faction, true);
      actor.animate({ moving: 1, time: 4, attacking: 0.5, winding: 0.7, dodging: true, dead: false, reducedMotion: false });
      actor.root.updateMatrixWorld(true);
      actor.root.traverse((part) => expect(part.matrixWorld.elements.every(Number.isFinite)).toBe(true));
    }
    const wagon = createWagon(resources, true);
    wagon.animate(3, 5, false, 1);
    wagon.animate(0, 5, false, 1);
    wagon.root.updateMatrixWorld(true);
    wagon.root.traverse((part) => expect(part.matrixWorld.elements.every(Number.isFinite)).toBe(true));
    resources.dispose();
  });
});
