import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { createCampaign } from '../game';
import { generateWorld } from '../game/world';
import { FollowCamera } from './camera';
import { locationStructure, regionThemes, themeAt } from './region-scenery';
import { seededRandom, ViewResources } from './resources';
import { createWorldScenery, dressingFilter, isDressingAllowed } from './world';

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
    expect(meshes.reduce((count, mesh) => count + mesh.count, 0)).toBeLessThan(50000);
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
    const triangleCount = (): number => meshes.reduce((count, mesh) =>
      count + mesh.count * (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3, 0);
    const detailedTriangles = triangleCount();
    scenery.setQuality(true);
    expect(triangleCount()).toBeLessThan(detailedTriangles);
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

  test('the scenery build\'s dressing filter answers exactly as isDressingAllowed, at every reach', () => {
    const worlds = [
      generateWorld('dressing-filter', 1),
      generateWorld('dressing-filter', 2),
      createCampaign({ seed: 'dressing-filter', faction: 'villain', runId: 'dressing-filter' }).snapshot().world,
    ];
    const random = seededRandom(20261007);
    for (const world of worlds) {
      const allowed = dressingFilter(world);
      const { minX, maxX, minZ, maxZ } = world.bounds;
      const points: { x: number; z: number }[] = [];
      for (let i = 0; i < 5000; i++) points.push({ x: minX - 3 + random() * (maxX - minX + 6), z: minZ - 3 + random() * (maxZ - minZ + 6) });
      // Just inside and just outside each obstacle's and each road's reach, where a missed grid cell would show.
      for (const obstacle of world.obstacles) {
        const angle = random() * Math.PI * 2;
        for (const reach of [obstacle.radius + 0.5 - 1e-6, obstacle.radius + 0.5 + 1e-6]) {
          points.push({ x: obstacle.x + Math.sin(angle) * reach, z: obstacle.z + Math.cos(angle) * reach });
        }
      }
      for (const edge of world.roads.edges) {
        const start = world.roads.nodes.find(node => node.id === edge.from)!;
        const end = world.roads.nodes.find(node => node.id === edge.to)!;
        const length = Math.hypot(end.x - start.x, end.z - start.z) || 1;
        const along = random();
        for (const reach of [edge.width * 0.5 + 1.1 - 1e-6, edge.width * 0.5 + 1.1 + 1e-6]) {
          for (const side of [-1, 1]) {
            points.push({ x: start.x + (end.x - start.x) * along - (end.z - start.z) / length * reach * side,
              z: start.z + (end.z - start.z) * along + (end.x - start.x) / length * reach * side });
          }
        }
      }
      const mismatches = points.filter(point => allowed(point) !== isDressingAllowed(world, point));
      expect(mismatches, `${world.version} ${world.id}`).toEqual([]);
      expect(points.some(point => allowed(point)), 'some dressing is allowed').toBe(true);
    }
  });
});
