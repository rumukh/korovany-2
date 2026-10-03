import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { createCampaign } from '../src/game';
import type { GameSnapshot, PickupSnapshot } from '../src/game/types';
import { WorldEffects } from '../src/view/effects';
import { ModelLibrary, PICKUP_IDS, PICKUPS, type ModelId, type ModelSource, type PickupKind } from '../src/view/models';
import { ViewResources } from '../src/view/resources';
import { imageBytes, imageSize, parseGlbWithoutTextures, readGlb } from './glb';

const glb = (id: ModelId) => new Uint8Array(readFileSync(new URL(`../public/models/${id}/${id}.glb`, import.meta.url)));
const nodeSource: ModelSource = { load: id => parseGlbWithoutTextures(glb(id)) };
const KINDS = Object.keys(PICKUPS) as PickupKind[];

function withPickups(): GameSnapshot {
  const snapshot = createCampaign({ seed: 'pickups', faction: 'guard', runId: 'pickups' }).snapshot();
  snapshot.pickups = KINDS.flatMap((kind, index): PickupSnapshot[] => [0, 1].map(copy => ({
    id: `test-${kind}-${copy}`, kind, amount: 1, x: snapshot.player.x + index * 3, z: snapshot.player.z + 4 + copy * 3,
  })));
  snapshot.effects = [];
  snapshot.projectiles = [];
  return snapshot;
}

function pool(scene: THREE.Object3D, kind: PickupKind): THREE.InstancedMesh {
  return scene.getObjectByName(`${PICKUPS[kind].id}:pickups`) as THREE.InstancedMesh;
}

/** World-space bounds of one instance of a cooked pickup pool. */
function instanceBounds(mesh: THREE.InstancedMesh, index: number): THREE.Box3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.clone().applyMatrix4(matrix);
}

describe('cooked pickups', () => {
  test.each(PICKUP_IDS)('%s: one small static mesh and material within budget, with WebP base colour, normal and ORM maps', id => {
    const document = readGlb(glb(id));
    expect(document.json.skins ?? []).toHaveLength(0);
    expect(document.json.animations ?? []).toHaveLength(0);
    expect(document.json.meshes).toHaveLength(1);
    expect(document.json.meshes![0]!.primitives).toHaveLength(1);
    const primitive = document.json.meshes![0]!.primitives[0]!;
    expect(primitive.attributes.NORMAL).toBeDefined();
    expect(primitive.attributes.TANGENT).toBeDefined();
    expect(document.json.accessors![primitive.indices!]!.count / 3).toBeLessThanOrEqual(6_000);
    expect(document.json.materials).toHaveLength(1);
    const material = document.json.materials![0]! as {
      normalTexture?: { index: number }; occlusionTexture?: { index: number };
      pbrMetallicRoughness?: { baseColorTexture?: { index: number }; metallicRoughnessTexture?: { index: number } };
    };
    for (const reference of [material.pbrMetallicRoughness?.baseColorTexture, material.normalTexture,
      material.pbrMetallicRoughness?.metallicRoughnessTexture, material.occlusionTexture]) {
      expect(reference).toBeDefined();
      const texture = document.json.textures![reference!.index]!;
      const size = imageSize(imageBytes(document, texture.extensions?.['EXT_texture_webp']?.source ?? texture.source!));
      expect(size.format).toBe('webp');
      expect(size.width).toBeGreaterThanOrEqual(256);
      expect(size.width).toBeLessThanOrEqual(1024);
    }
  });

  test('each pickup kind draws its cooked model at the procedural pickup\'s size and height, with no instance colour', async () => {
    const library = new ModelLibrary(nodeSource, PICKUP_IDS);
    await library.ready;
    const resources = new ViewResources(undefined, 1, library);
    const scene = new THREE.Scene();
    const effects = new WorldEffects(resources, scene);
    try {
      const snapshot = withPickups();
      effects.update(snapshot, 1 / 60, 0, true);
      for (const kind of KINDS) {
        const mesh = pool(scene, kind);
        const template = (() => { let found: THREE.Mesh | undefined; library.get(PICKUPS[kind].id)!.scene.traverse(o => { if (o instanceof THREE.Mesh) found ??= o; }); return found!; })();
        expect(mesh.count, kind).toBe(2);
        // The library's own geometry and material, no per-instance colour: no extra shader variant.
        expect(mesh.geometry).toBe(template.geometry);
        expect(mesh.material).toBe(template.material);
        expect(mesh.instanceColor, kind).toBeNull();
        expect(mesh.castShadow).toBe(true);
        expect(mesh.customDepthMaterial).toBe(resources.depthMaterial());
        const placed = snapshot.pickups.filter(pickup => pickup.kind === kind);
        placed.forEach((pickup, index) => {
          const bounds = instanceBounds(mesh, index);
          const size = bounds.getSize(new THREE.Vector3());
          const centre = bounds.getCenter(new THREE.Vector3());
          // Reduced motion: no bob, so the lowest point is at the specified lift. Turning about the vertical only widens
          // the horizontal bounds (by at most sqrt 2).
          expect(Math.max(size.x, size.y, size.z), kind).toBeLessThanOrEqual(PICKUPS[kind].size * 1.42);
          expect(Math.max(size.x, size.y, size.z), kind).toBeGreaterThanOrEqual(PICKUPS[kind].size * 0.7);
          expect(centre.x, kind).toBeCloseTo(pickup.x, 1);
          expect(centre.z, kind).toBeCloseTo(pickup.z, 1);
          expect(bounds.min.y, kind).toBeCloseTo(PICKUPS[kind].lift, 2);
        });
      }
      // With reduced motion, no effects and no projectiles, nothing else is drawn: the procedural pickups are not used.
      const others = scene.children.filter(child => child instanceof THREE.InstancedMesh && !child.name.endsWith(':pickups') && child.count > 0);
      expect(others.map(child => child.name)).toEqual([]);
    } finally {
      effects.dispose();
      resources.dispose();
      library.dispose();
    }
  }, 60_000);

  test('the coin purse bobs and spins as the coin did, the satchel and crate only bob; reduced motion holds them still', async () => {
    const library = new ModelLibrary(nodeSource, PICKUP_IDS);
    await library.ready;
    const resources = new ViewResources(undefined, 1, library);
    const scene = new THREE.Scene();
    const effects = new WorldEffects(resources, scene);
    const matrices = (kind: PickupKind) => {
      const matrix = new THREE.Matrix4();
      pool(scene, kind).getMatrixAt(0, matrix);
      return matrix.toArray();
    };
    try {
      const snapshot = withPickups();
      const times = [0, 0.5, 1, 1.5, 2, 2.5];
      const frames = times.map(time => {
        effects.update(snapshot, 1 / 60, time, false);
        return Object.fromEntries(KINDS.map(kind => [kind, matrices(kind)]));
      });
      const range = (values: number[]) => Math.max(...values) - Math.min(...values);
      for (const kind of KINDS) {
        // Every kind bobs by the procedural pickups' cosmetic curve (0.08 m amplitude, period 2.5 s).
        expect(range(frames.map(frame => frame[kind]![13]!)), kind).toBeGreaterThan(0.1);
        // Only the coin purse spins (1.3 rad/s); the satchel and crate keep their fixed heading.
        const headings = frames.map(frame => Math.atan2(frame[kind]![8]!, frame[kind]![10]!));
        if (PICKUPS[kind].spins) expect(range(headings), kind).toBeGreaterThan(0.5);
        else for (const value of headings) expect(value, kind).toBeCloseTo(PICKUPS[kind].yaw, 5);
      }
      const still = [0.3, 1.1].map(time => {
        effects.update(snapshot, 1 / 60, time, true);
        return KINDS.map(kind => matrices(kind));
      });
      expect(still[0]).toEqual(still[1]);
    } finally {
      effects.dispose();
      resources.dispose();
      library.dispose();
    }
  }, 60_000);

  test('without a model library the procedural pickups stay, for DOM-free presentation', () => {
    const resources = new ViewResources();
    const scene = new THREE.Scene();
    const effects = new WorldEffects(resources, scene);
    try {
      effects.update(withPickups(), 1 / 60, 0, true);
      expect(scene.children.some(child => child.name.endsWith(':pickups'))).toBe(false);
      const drawn = scene.children.filter(child => child instanceof THREE.InstancedMesh && child.count > 0);
      expect(drawn.length).toBeGreaterThanOrEqual(3);
    } finally {
      effects.dispose();
      resources.dispose();
    }
  });

  test.each(PICKUP_IDS)('a missing %s fails the library instead of falling back to the procedural pickup', async missing => {
    const library = new ModelLibrary({ load: async id => {
      if (id === missing) throw new Error('404 Not Found');
      return nodeSource.load(id);
    } }, PICKUP_IDS);
    await expect(library.ready).rejects.toThrow(new RegExp(`${missing}\\.glb: 404 Not Found`));
    const resources = new ViewResources(undefined, 1, library);
    try {
      expect(() => new WorldEffects(resources, new THREE.Scene())).toThrow(missing);
    } finally {
      resources.dispose();
      library.dispose();
    }
  });

  test('disposing the effects removes the pickup pools and keeps the library geometry and materials', async () => {
    const library = new ModelLibrary(nodeSource, PICKUP_IDS);
    await library.ready;
    const resources = new ViewResources(undefined, 1, library);
    const scene = new THREE.Scene();
    const effects = new WorldEffects(resources, scene);
    const released: string[] = [];
    for (const id of PICKUP_IDS) {
      library.get(id)!.scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.addEventListener('dispose', () => released.push(`${id}:geometry`));
        (object.material as THREE.Material).addEventListener('dispose', () => released.push(`${id}:material`));
      });
    }
    effects.update(withPickups(), 1 / 60, 0, false);
    effects.dispose();
    expect(scene.children.filter(child => child.name.endsWith(':pickups'))).toEqual([]);
    expect(released).toEqual([]);
    resources.dispose();
    library.dispose();
    expect(released.length).toBe(PICKUP_IDS.length * 2);
  });
});
