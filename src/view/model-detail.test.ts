import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import type { Obstacle, WorldLocation } from '../game/types';
import { createActor, createWagon, type ActorLook } from './actors';
import { locationStructure, regionThemes } from './region-scenery';
import { ViewResources } from './resources';

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  root.traverse(object => {
    if (object instanceof THREE.Mesh) result.push(object);
  });
  return result;
}

describe('crafted frontier models', () => {
  test('keeps rounded faction rigs bounded and resets animated poses without reallocating meshes', () => {
    const resources = new ViewResources();
    const looks: ActorLook[] = ['hero', 'guard', 'archer', 'brute', 'boss'];
    for (const faction of ['elf', 'guard', 'villain'] as const) {
      for (const look of looks) {
        const actor = createActor(resources, look, faction, true);
        const parts = meshes(actor.root);
        expect(parts.length, `${faction}:${look}`).toBeLessThan(100);
        expect(parts.filter(part => part.geometry instanceof THREE.IcosahedronGeometry).length).toBeGreaterThan(12);
        for (const reducedMotion of [false, true]) {
          actor.animate({ time: 4, moving: 1, attacking: 0.5, winding: 0.7, dodging: true, dead: true, reducedMotion });
          actor.root.updateMatrixWorld(true);
          actor.root.traverse(object => expect(object.matrixWorld.elements.every(Number.isFinite)).toBe(true));
        }
        actor.animate({ time: 0, moving: 0, attacking: 0, winding: 0, dodging: false, dead: false, reducedMotion: true });
        expect(actor.root.getObjectByName('actor-body')!.rotation.z).toBe(0);
        expect(actor.root.getObjectByName('actor-body')!.position.y).toBe(0);
        expect(actor.root.getObjectByName('actor-torso')!.rotation.x).toBe(0);
        expect(meshes(actor.root)).toEqual(parts);
        if (look === 'hero') {
          expect(actor.root.getObjectByName(faction === 'elf' ? 'actor-bow' : 'actor-shield')).toBeDefined();
          expect(actor.height).toBe(2.35);
        }
      }
    }
    resources.dispose();
  });

  test('uses open, eight-spoke wagon wheels with shared geometry and distance-driven rotation', () => {
    const resources = new ViewResources();
    const wagon = createWagon(resources, true);
    const other = createWagon(resources, false);
    const wheels = wagon.root.getObjectsByProperty('name', 'wagon-wheel');
    expect(wheels).toHaveLength(4);
    expect(meshes(wagon.root).length).toBeLessThan(130);
    wagon.root.updateMatrixWorld(true);
    const spokeGeometry = (wheels[0]!.getObjectByName('wagon-wheel-spokes') as THREE.Mesh).geometry;
    expect(spokeGeometry.getAttribute('position').count).toBe(4 * 24);
    for (const model of [wagon, other]) {
      for (const wheel of model.root.getObjectsByProperty('name', 'wagon-wheel')) {
        expect((wheel.getObjectByName('wagon-wheel-spokes') as THREE.Mesh).geometry).toBe(spokeGeometry);
      }
    }
    const wheel = wheels[0]!;
    const direction = new THREE.Vector3(-1, 0, 0).transformDirection(wheel.matrixWorld);
    const gapOrigin = new THREE.Vector3(1, Math.cos(Math.PI / 8) * 0.26, Math.sin(Math.PI / 8) * 0.26).applyMatrix4(wheel.matrixWorld);
    expect(new THREE.Raycaster(gapOrigin, direction).intersectObjects(wheel.children, false)).toHaveLength(0);
    const rimOrigin = new THREE.Vector3(1, 0.49, 0).applyMatrix4(wheel.matrixWorld);
    expect(new THREE.Raycaster(rimOrigin, direction).intersectObjects(wheel.children, false).length).toBeGreaterThan(0);
    wagon.animate(0.525, 3, false, 1);
    for (const wheel of wheels) expect(wheel.rotation.x).toBeCloseTo(1);
    wagon.animate(-0.525, 5, true, 0);
    for (const wheel of wheels) expect(wheel.rotation.x).toBeCloseTo(0);
    expect(wagon.root.getObjectByName('wagon-ox-head')!.rotation.x).toBe(0);
    const canopy = wagon.root.getObjectByName('wagon-canopy') as THREE.Mesh;
    expect(canopy.geometry.getAttribute('position').count).toBeGreaterThan(300);
    expect(canopy.geometry).toBe((other.root.getObjectByName('wagon-canopy') as THREE.Mesh).geometry);
    const disposed = vi.fn();
    spokeGeometry.addEventListener('dispose', disposed);
    resources.dispose();
    resources.dispose();
    expect(disposed).toHaveBeenCalledOnce();
  });

  test('fits gables, dormers, frames and segmented arches within their circular collision footprint', () => {
    const resources = new ViewResources();
    const point = new THREE.Vector3();
    const examples: Array<[string, WorldLocation['kind']]> = [
      ['frontier-inn', 'inn'], ['frontier-hall', 'settlement'], ['reed-chapel', 'landmark'],
      ['bell-foundry', 'landmark'], ['name-well', 'landmark'], ['stag-shrine', 'shrine'],
      ['frozen-beacon', 'landmark'], ['wreckers-rest', 'inn'], ['glass-quarry', 'landmark'], ['ash-cairn', 'landmark'],
    ];
    for (const [regionId, theme] of Object.entries(regionThemes)) {
      for (const [id, kind] of examples) {
        const place: WorldLocation = { id, kind, regionId, x: 20, z: 35, radius: 22, fastTravel: false, name: { en: '', ru: '' }, description: { en: '', ru: '' } };
        const obstacle: Obstacle = { id: `${id}-building-0`, kind: 'wall', x: 27, z: 11, radius: 2.8, height: kind === 'landmark' ? 17 : 5, variant: 0 };
        const model = locationStructure(resources, obstacle, place, theme);
        model.updateMatrixWorld(true);
        expect(meshes(model).length).toBeLessThan(100);
        for (const mesh of meshes(model)) {
          const positions = mesh.geometry.getAttribute('position');
          for (let index = 0; index < positions.count; index++) {
            point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
            expect(Math.hypot(point.x - obstacle.x, point.z - obstacle.z), `${regionId}:${id}`).toBeLessThanOrEqual(obstacle.radius + 0.05);
          }
        }
        if (id === 'frontier-inn') {
          expect(model.getObjectByName('gabled-roof')).toBeDefined();
          expect(model.getObjectByName('dormer-roof')).toBeDefined();
          expect(model.getObjectsByProperty('name', 'framed-window')).toHaveLength(3);
        }
        if (id === 'bell-foundry' || id === 'stag-shrine') {
          expect(model.getObjectByName('segmented-arch')!.children).toHaveLength(9);
        }
        if (id === 'glass-quarry' || id === 'ash-cairn') {
          const stones = meshes(model).filter(mesh => mesh.geometry instanceof THREE.IcosahedronGeometry);
          expect(stones.length).toBeGreaterThan(0);
          for (const stone of stones) {
            const material = stone.material as THREE.MeshStandardMaterial;
            expect(material).toBe(resources.material(`#${material.color.getHexString()}`, { side: THREE.FrontSide, surface: 'rock' }));
          }
        }
      }
    }
    resources.dispose();
  });
});
