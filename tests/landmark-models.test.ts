import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { createCampaign } from '../src/game';
import type { Obstacle, WorldBlueprint, WorldLocation } from '../src/game/types';
import {
  LANDMARK_IDS, LANDMARK_PLACES, landmarkModelFor, ModelLibrary, type LandmarkModelId, type ModelId, type ModelSource,
} from '../src/view/models';
import { locationStructure, themeAt } from '../src/view/region-scenery';
import { ViewResources } from '../src/view/resources';
import { imageBytes, imageSize, parseGlbWithoutTextures, readGlb } from './glb';

const glb = (id: ModelId) => new Uint8Array(readFileSync(new URL(`../public/models/${id}/${id}.glb`, import.meta.url)));
const nodeSource: ModelSource = { load: id => parseGlbWithoutTextures(glb(id)) };

function landmarkBuildings(world: WorldBlueprint): { obstacle: Obstacle; place: WorldLocation; id: LandmarkModelId }[] {
  const result = [];
  for (const obstacle of world.obstacles) {
    const place = world.exploration?.locations.find(candidate => obstacle.id.startsWith(`${candidate.id}-building-`));
    const id = place ? landmarkModelFor(place.id, obstacle.variant) : undefined;
    if (place && id) result.push({ obstacle, place, id });
  }
  return result;
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse(object => { if (object instanceof THREE.Mesh) meshes.push(object); });
  return meshes;
}

describe('cooked signature landmarks', () => {
  test.each(LANDMARK_IDS)('%s: one static mesh and material within budget, with WebP base colour, normal and ORM maps', id => {
    const document = readGlb(glb(id));
    expect(document.json.skins ?? []).toHaveLength(0);
    expect(document.json.animations ?? []).toHaveLength(0);
    expect(document.json.meshes).toHaveLength(1);
    expect(document.json.meshes![0]!.primitives).toHaveLength(1);
    const primitive = document.json.meshes![0]!.primitives[0]!;
    expect(primitive.attributes.NORMAL).toBeDefined();
    expect(primitive.attributes.TANGENT).toBeDefined();
    expect(document.json.accessors![primitive.indices!]!.count / 3).toBeLessThanOrEqual(15_000);
    expect(document.json.materials).toHaveLength(1);
    const material = document.json.materials![0]! as {
      normalTexture?: { index: number }; occlusionTexture?: { index: number };
      pbrMetallicRoughness?: { baseColorTexture?: { index: number }; metallicRoughnessTexture?: { index: number } };
    };
    const slots = {
      base: material.pbrMetallicRoughness?.baseColorTexture, normal: material.normalTexture,
      orm: material.pbrMetallicRoughness?.metallicRoughnessTexture, occlusion: material.occlusionTexture,
    };
    for (const [slot, reference] of Object.entries(slots)) {
      expect(reference, slot).toBeDefined();
      const texture = document.json.textures![reference!.index]!;
      const source = texture.extensions?.['EXT_texture_webp']?.source ?? texture.source!;
      const size = imageSize(imageBytes(document, source));
      expect(size.format, slot).toBe('webp');
      expect(size.width, slot).toBeGreaterThanOrEqual(512);
      expect(size.width, slot).toBeLessThanOrEqual(1024);
    }
  });

  test('every landmark location shows its cooked model, inside each authoritative building footprint and above ground', async () => {
    const library = new ModelLibrary(nodeSource, LANDMARK_IDS);
    await library.ready;
    const resources = new ViewResources(undefined, 1, library);
    const world = createCampaign({ seed: 'landmarks', faction: 'guard', runId: 'landmarks' }).snapshot().world;
    const point = new THREE.Vector3();
    const used = new Set<LandmarkModelId>();
    try {
      const buildings = landmarkBuildings(world);
      expect(new Set(buildings.map(building => building.place.id))).toEqual(new Set(Object.keys(LANDMARK_PLACES)));
      for (const { obstacle, place, id } of buildings) {
        used.add(id);
        const structure = locationStructure(resources, obstacle, place, themeAt(world, place));
        structure.updateMatrixWorld(true);
        const meshes = meshesOf(structure);
        expect(meshes.map(mesh => mesh.name), obstacle.id).toEqual([id]);
        const template = meshesOf(library.get(id)!.scene)[0]!;
        // The library's geometry and material are shared, so the world's static batches draw each landmark instanced.
        expect(meshes[0]!.geometry).toBe(template.geometry);
        expect(meshes[0]!.material).toBe(template.material);
        expect(meshes[0]!.castShadow).toBe(true);
        expect(meshes[0]!.customDepthMaterial).toBe(resources.modelDepthMaterial());
        const positions = meshes[0]!.geometry.getAttribute('position');
        let top = 0;
        for (let index = 0; index < positions.count; index++) {
          point.fromBufferAttribute(positions, index).applyMatrix4(meshes[0]!.matrixWorld);
          expect(Math.hypot(point.x - obstacle.x, point.z - obstacle.z), obstacle.id).toBeLessThanOrEqual(obstacle.radius + 0.05);
          expect(point.y, obstacle.id).toBeGreaterThan(-0.05);
          top = Math.max(top, point.y);
        }
        // A landmark, not a ground decal: it rises higher than its footprint's radius.
        expect(top, obstacle.id).toBeGreaterThan(obstacle.radius);
      }
      expect([...used].sort()).toEqual([...LANDMARK_IDS].sort());
      // The Star Monastery's other buildings and every location without a landmark keep their procedural structures.
      const monastery = world.obstacles.filter(obstacle => obstacle.id.startsWith('star-monastery-building-') && obstacle.variant !== 0);
      expect(monastery.length).toBeGreaterThan(0);
      for (const obstacle of monastery) {
        const place = world.exploration!.locations.find(candidate => candidate.id === 'star-monastery')!;
        const meshes = meshesOf(locationStructure(resources, obstacle, place, themeAt(world, place)));
        expect(meshes.some(mesh => (LANDMARK_IDS as readonly string[]).includes(mesh.name))).toBe(false);
        expect(meshes.length).toBeGreaterThan(1);
      }
    } finally {
      resources.dispose();
      library.dispose();
    }
  }, 60_000);

  test('without a model library the procedural structures stay, for DOM-free scenery', () => {
    const resources = new ViewResources();
    const world = createCampaign({ seed: 'landmarks', faction: 'guard', runId: 'landmarks' }).snapshot().world;
    try {
      for (const { obstacle, place } of landmarkBuildings(world)) {
        const meshes = meshesOf(locationStructure(resources, obstacle, place, themeAt(world, place)));
        expect(meshes.length, obstacle.id).toBeGreaterThan(1);
        expect(meshes.some(mesh => (LANDMARK_IDS as readonly string[]).includes(mesh.name)), obstacle.id).toBe(false);
      }
    } finally {
      resources.dispose();
    }
  });

  test.each(LANDMARK_IDS)('a missing %s fails the library instead of falling back to the procedural structure', async missing => {
    const source: ModelSource = { load: async id => {
      if (id === missing) throw new Error('404 Not Found');
      return nodeSource.load(id);
    } };
    const library = new ModelLibrary(source, LANDMARK_IDS);
    await expect(library.ready).rejects.toThrow(new RegExp(`${missing}\\.glb: 404 Not Found`));
    expect(library.status.error).toMatch(missing);
    const resources = new ViewResources(undefined, 1, library);
    const world = createCampaign({ seed: 'landmarks', faction: 'guard', runId: 'landmarks' }).snapshot().world;
    try {
      const building = landmarkBuildings(world).find(entry => entry.id === missing)!;
      expect(() => locationStructure(resources, building.obstacle, building.place, themeAt(world, building.place))).toThrow(missing);
    } finally {
      resources.dispose();
      library.dispose();
    }
  });
});
