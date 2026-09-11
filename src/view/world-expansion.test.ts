import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { generateWorld } from '../game/world';
import { FollowCamera } from './camera';
import { locationStructure, regionThemes, themeAt } from './region-scenery';
import { ViewResources } from './resources';
import { createWorldScenery, isDressingAllowed } from './world';

const canvas = {
  getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, width: 1280, height: 800, top: 0, left: 0, right: 1280, bottom: 800, toJSON: () => ({}) };
  },
};

describe('kilometre-scale world presentation', () => {
  test('keeps shared resources and local draw submissions bounded through every region', () => {
    const world = generateWorld('view-frontier');
    const original = JSON.stringify(world);
    const resources = new ViewResources();
    const scenery = createWorldScenery(resources, world);
    const meshes: THREE.InstancedMesh[] = [];
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    let objects = 0;
    scenery.group.traverse(object => {
      objects++;
      if (object instanceof THREE.Mesh) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
      if (object instanceof THREE.InstancedMesh) meshes.push(object);
    });
    expect(objects).toBeLessThan(2500);
    expect(geometries.size).toBeLessThan(20);
    expect(materials.size).toBeLessThan(140);
    expect(meshes.reduce((count, mesh) => count + mesh.count, 0)).toBeLessThan(25000);
    expect(meshes.length).toBeGreaterThan(100);
    expect(meshes.every(mesh => mesh.boundingSphere && Number.isFinite(mesh.boundingSphere.radius))).toBe(true);
    const disposed = meshes.map(mesh => {
      const spy = vi.fn();
      mesh.addEventListener('dispose', spy);
      return spy;
    });
    const camera = new FollowCamera(canvas);
    camera.resize(1280, 800);
    const frustum = new THREE.Frustum();
    const sky = scenery.group.getObjectByName('world-sky')!;
    for (const place of world.exploration!.locations) {
      scenery.heroPosition.set(place.x, 1.15, place.z);
      scenery.update(5, false);
      camera.update(place, 1 / 60);
      scenery.group.updateMatrixWorld(true);
      frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.camera.projectionMatrix, camera.camera.matrixWorldInverse));
      let submissions = 0;
      scenery.group.traverseVisible(object => {
        if (object instanceof THREE.Mesh && (!object.frustumCulled || frustum.intersectsObject(object))) submissions++;
      });
      expect(submissions, place.id).toBeLessThan(450);
      expect(sky.position.x).toBe(place.x);
      expect(sky.position.z).toBe(place.z);
      expect(sky.position.distanceTo(camera.camera.position) + 240).toBeLessThan(camera.camera.far);
      const target = new THREE.Vector3(place.x, 0, place.z).project(camera.camera);
      const hit = camera.screenToWorld((target.x + 1) * 640, (1 - target.y) * 400);
      expect(hit?.x).toBeCloseTo(place.x, 4);
      expect(hit?.z).toBeCloseTo(place.z, 4);
      expect(isDressingAllowed(world, place)).toBe(false);
    }
    expect(scenery.group.children.some(child => child.name.startsWith('world-structures:') && !child.visible)).toBe(true);
    scenery.setQuality(true);
    expect(scenery.group.getObjectByName('world-details')?.visible).toBe(false);
    scenery.setQuality(false);
    expect(scenery.group.getObjectByName('world-details')?.visible).toBe(true);
    expect(JSON.stringify(world)).toBe(original);
    scenery.dispose();
    resources.dispose();
    expect(disposed.every(spy => spy.mock.calls.length === 1)).toBe(true);
  });

  test('has eight distinct region palettes and collision-matching authored buildings', () => {
    const world = generateWorld('building-footprints');
    const resources = new ViewResources();
    expect(new Set(Object.values(regionThemes).map(theme => theme.ground)).size).toBe(8);
    const point = new THREE.Vector3();
    for (const place of world.exploration!.locations) {
      const buildings = world.obstacles.filter(o => o.id.startsWith(`${place.id}-building-`));
      expect(buildings.length).toBeGreaterThanOrEqual(3);
      for (const obstacle of buildings) {
        const model = locationStructure(resources, obstacle, place, themeAt(world, place));
        model.updateMatrixWorld(true);
        let maxRadius = 0;
        model.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return;
          const positions = object.geometry.getAttribute('position');
          for (let i = 0; i < positions.count; i++) {
            point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
            maxRadius = Math.max(maxRadius, Math.hypot(point.x - obstacle.x, point.z - obstacle.z));
          }
        });
        expect(maxRadius, obstacle.id).toBeLessThanOrEqual(obstacle.radius + 0.05);
      }
    }
    resources.dispose();
  });

  test('rebuilds identical instance placements for the same seed', () => {
    const signature = (): string[] => {
      const resources = new ViewResources();
      const scenery = createWorldScenery(resources, generateWorld('stable-view'));
      const result: string[] = [];
      scenery.group.traverse(object => {
        if (!(object instanceof THREE.InstancedMesh)) return;
        let hash = 2166136261;
        const bytes = new Uint8Array(object.instanceMatrix.array.buffer);
        for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
        result.push(`${object.parent?.name}:${object.geometry.type}:${object.count}:${hash >>> 0}`);
      });
      scenery.dispose();
      resources.dispose();
      return result;
    };
    expect(signature()).toEqual(signature());
  });
});
