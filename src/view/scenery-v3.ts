import * as THREE from 'three';
import type { Obstacle, WorldBlueprint } from '../game/types';
import { V3_MODULES } from '../game/world-v3';
import { palette } from './palette';
import { StaticBatch } from './primitives';
import { seededRandom, type ViewResources } from './resources';
import { ScatterField, type ScatterKind, type ScatterPart } from './scatter';
import { applySightlineDither } from './sightline';
import { terrainFor } from './terrain';
import { apronGeometry, terrainChunks, terrainControl, TERRAIN_MARGIN } from './terrain-mesh';
import { WorldChunks } from './world-chunks';
import { applyEdgeFade, kitMaterial, terrainMaterial } from './world-materials';
import { ROCK_VARIANTS, TREE_VARIANTS, WORLD_MODELS, type WorldModelId } from './world-assets';
import { addBridge, legacyWall, makeSky, makeWater, type WorldScenery } from './world';
import { V3_GRADE } from './atmosphere';

/** Distance bands, in metres from the camera. Shadows are cast only by what can shade the hero's surroundings. */
const BANDS = {
  building: { shadow: 95, far: 235 },
  prop: { shadow: 60, far: 160 },
  rock: { shadow: 60, far: 200 },
  tree: { near: 58, far: 235 },
} as const;
/**
 * Canopies and trunks dither away in a cone around the camera-to-hero sightline: 3-6 m wide at the hero, twice that at
 * the camera, so forest never hides the hero or the ground around them (the architecture cutaway is 1.6-3.2 m).
 */
const CANOPY_CUTAWAY = { radius: [3, 6] as const, widen: 1 };

function hashId(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0) / 4294967296;
}

function meshNamed(root: THREE.Object3D, name: string): THREE.Mesh {
  const mesh = root.getObjectByName(name);
  if (!(mesh instanceof THREE.Mesh)) throw new Error(`World model part ${name} is missing.`);
  return mesh;
}

/**
 * A model mesh's geometry with its node transform inside the model baked in, shared by every instance. Quantized
 * attributes (KHR_mesh_quantization: normalized integer positions with the scale in the node) are expanded to floats
 * first; transforming them in place would clamp every position to the normalized range of plus or minus one.
 */
function placedGeometry(resources: ViewResources, key: string, mesh: THREE.Mesh): THREE.BufferGeometry {
  return resources.geometry(`world-part:${key}`, () => {
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry.clone();
    for (const name of ['position', 'normal', 'tangent']) {
      const attribute = geometry.getAttribute(name);
      if (!attribute || attribute.array instanceof Float32Array) continue;
      const values = new Float32Array(attribute.count * attribute.itemSize);
      for (let index = 0; index < attribute.count; index++) {
        for (let component = 0; component < attribute.itemSize; component++) {
          values[index * attribute.itemSize + component] = attribute.getComponent(index, component);
        }
      }
      geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
    }
    if (!mesh.matrixWorld.equals(new THREE.Matrix4())) geometry.applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingSphere();
    return geometry;
  });
}

/**
 * Version 3 scenery: the presentation heightfield with its splatted ground, the scripted kit (houses, castles and
 * ruins, with presentation-only gate arches), cooked props and remains, generated trees and boulders as
 * distance-banded instance pools, and the cooked landmarks kept from v2, which take the sightline cutaway here.
 */
export function createWorldSceneryV3(resources: ViewResources, world: WorldBlueprint): WorldScenery {
  const assets = resources.world;
  if (!assets) throw new Error('A version 3 world needs the world asset library.');
  const surfaces = assets.surfaces();
  const terrain = terrainFor(world);
  const group = new THREE.Group();
  group.name = 'world-v3';
  const heroPosition = new THREE.Vector3();
  const flagAnchors = new Map<string, THREE.Vector3>();
  const random = seededRandom(Math.floor(hashId(world.seed) * 4294967296));
  const sky = makeSky(resources, { zenith: V3_GRADE.zenith, horizon: V3_GRADE.fog, sun: V3_GRADE.sunOffset, overcast: 1.7, cloud: [0.5, 0.52, 0.53] });
  group.add(sky);

  const control = terrainControl(world);
  resources.ownTexture(control.weights);
  resources.ownTexture(control.fields);
  const groundMaterial = resources.ownMaterial('world-terrain', terrainMaterial(surfaces, control));
  const ground = new THREE.Group();
  ground.name = 'world-terrain';
  const terrainMeshes = terrainChunks(world, terrain, groundMaterial);
  ground.add(...terrainMeshes);
  // The apron is a frame around the chunks (world coordinates), 0.06 m lower; it only fills the fogged far view.
  const apron = new THREE.Mesh(resources.geometry('world-apron', () => apronGeometry(world, 4000)), groundMaterial);
  apron.name = 'world-apron';
  apron.position.y = -0.06;
  apron.receiveShadow = true;
  apron.renderOrder = -1;
  ground.add(apron);
  group.add(ground);

  const water = makeWater(resources, world.river);
  group.add(water.mesh);
  const structures = new StaticBatch(resources);
  for (const bridge of world.bridges) addBridge(bridge, world, structures);

  const kit = resources.ownMaterial('world-kit', kitMaterial(surfaces, heroPosition));
  const bark = resources.ownMaterial('world-kit-bark', kitMaterial(surfaces, heroPosition, CANOPY_CUTAWAY));
  const depth = resources.depthMaterial();
  const kinds: ScatterKind[] = [];
  const kindOf = new Map<string, number>();
  const radiusOf = (geometry: THREE.BufferGeometry): number => geometry.boundingSphere!.center.length() + geometry.boundingSphere!.radius;
  const define = (key: string, parts: ScatterPart[], hollow?: THREE.Box3): number => {
    kinds.push({ parts, radius: Math.max(...parts.map(part => radiusOf(part.geometry))), hollow });
    kindOf.set(key, kinds.length - 1);
    return kinds.length - 1;
  };
  const banded = (key: string, geometry: THREE.BufferGeometry, material: THREE.Material, band: { shadow: number; far: number },
    hollow?: THREE.Box3): number =>
    define(key, [
      { name: `${key}:near`, geometry, material, near: 0, far: band.shadow, castShadow: true, depthMaterial: depth },
      { name: `${key}:far`, geometry, material, near: band.shadow, far: band.far, castShadow: false },
    ], hollow);
  const cutawayMaterials = new Map<THREE.Material, THREE.Material>();
  /** A presentation-owned copy of a library material with the camera-to-hero cutaway. */
  const cutaway = (source: THREE.Material, key: string, strength: number,
    shape?: { radius: readonly [number, number]; widen: number }): THREE.Material => {
    let material = cutawayMaterials.get(source);
    if (!material) {
      material = resources.ownMaterial(`world-cutaway:${key}`, source.clone());
      applySightlineDither(material, heroPosition, strength, shape?.radius, shape?.widen);
      cutawayMaterials.set(source, material);
    }
    return material;
  };
  const kindFor = (id: WorldModelId, variant = 0): number => {
    const key = `${id}:${variant}`;
    const known = kindOf.get(key);
    if (known !== undefined) return known;
    const model = assets.require(id);
    const kind = WORLD_MODELS[id].kind;
    if (kind === 'kit') {
      const mesh = model.scene.getObjectByProperty('isMesh', true) as THREE.Mesh;
      const geometry = placedGeometry(resources, id, mesh);
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      // Kit walls are one-sided: a camera inside a building hides that building instead of showing its hollow inside.
      return banded(key, geometry, kit, BANDS.building, geometry.boundingBox!);
    }
    if (kind === 'rock') {
      const mesh = meshNamed(model.scene, `variant-${variant}`);
      return banded(key, placedGeometry(resources, key, mesh), kit, BANDS.rock);
    }
    if (kind === 'prop') {
      const mesh = model.scene.getObjectByProperty('isMesh', true) as THREE.Mesh;
      return banded(key, placedGeometry(resources, id, mesh), cutaway(mesh.material as THREE.Material, id, 1), BANDS.prop);
    }
    if (kind === 'tree') {
      const part = (name: string) => {
        const mesh = meshNamed(model.scene, `${name}-${variant}`);
        let material: THREE.Material = bark;
        if (!name.endsWith('wood')) {
          material = cutaway(mesh.material as THREE.Material, `${key}:${name}`, 1, CANOPY_CUTAWAY);
          // The cards' coverage is thickened for mipmapping; a lower cutoff keeps thin sprays at a distance.
          material.alphaTest = 0.38;
          if (name === 'impostor') applyEdgeFade(material);
        }
        return { geometry: placedGeometry(resources, `${key}:${name}`, mesh), material };
      };
      const wood = part('lod0-wood'), leaves = part('lod0-leaves'), impostor = part('impostor');
      const t = BANDS.tree;
      return define(key, [
        { name: `${key}:wood`, ...wood, near: 0, far: t.near, castShadow: true, depthMaterial: depth },
        { name: `${key}:leaves`, ...leaves, near: 0, far: t.near, castShadow: true },
        { name: `${key}:impostor`, ...impostor, near: t.near, far: t.far, castShadow: false },
      ]);
    }
    throw new Error(`World model ${id} is not scenery.`);
  };

  const legacy = new WorldChunks(resources, 'world-structures');
  const fortMaterials = new Map<THREE.Material, THREE.Material>();
  const placements: { kind: number; matrix: THREE.Matrix4 }[] = [];
  const matrix = (x: number, y: number, z: number, heading: number, sx = 1, sy = sx, sz = sx): THREE.Matrix4 =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading),
      new THREE.Vector3(sx, sy, sz));
  const place = (o: Obstacle): void => {
    const id = o.model as WorldModelId;
    const kind = WORLD_MODELS[id].kind;
    const y = terrain.height(o.x, o.z);
    const module = Object.hasOwn(V3_MODULES, id) ? V3_MODULES[id]! : 0;
    if (module) {
      // Boundary and curtain runs repeat their module along the box's longer side.
      const shape = o.shape!;
      const alongZ = shape.halfZ >= shape.halfX;
      const length = 2 * (alongZ ? shape.halfZ : shape.halfX);
      const heading = alongZ ? shape.heading : shape.heading + Math.PI / 2;
      const count = Math.max(1, Math.round(length / module));
      const axis = { x: Math.sin(heading), z: Math.cos(heading) };
      for (let index = 0; index < count; index++) {
        const along = -length / 2 + (index + 0.5) * length / count;
        // Ruined modules turn end for end at random so their broken tops do not repeat every 6 m.
        const turn = id === 'kit-curtain-ruin' && hashId(`${o.id}:${index}`) < 0.5 ? Math.PI : 0;
        placements.push({ kind: kindFor(id), matrix: matrix(o.x + axis.x * along, y, o.z + axis.z * along, heading + turn, 1, 1, length / count / module) });
      }
      return;
    }
    if (kind === 'kit') {
      // Round towers are circles: they turn by a stable hash of their id.
      placements.push({ kind: kindFor(id), matrix: matrix(o.x, y, o.z, o.shape ? o.shape.heading : hashId(o.id) * Math.PI * 2) });
    } else if (kind === 'prop') {
      placements.push({ kind: kindFor(id), matrix: matrix(o.x, y, o.z, o.shape ? o.shape.heading : hashId(o.id) * Math.PI * 2) });
    } else if (kind === 'rock') {
      const variant = o.variant % ROCK_VARIANTS;
      const k = kindFor(id, variant);
      const bounds = kinds[k]!.parts[0]!.geometry.boundingBox ?? (kinds[k]!.parts[0]!.geometry.computeBoundingBox(), kinds[k]!.parts[0]!.geometry.boundingBox!);
      const across = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 2;
      const tall = bounds.max.y;
      // Boulders sit a quarter sunk, so slopes never show a gap under them.
      placements.push({ kind: k, matrix: matrix(o.x, y - o.height * 0.25, o.z, hashId(o.id) * Math.PI * 2, o.radius / across, o.height / tall, o.radius / across) });
    } else if (kind === 'tree') {
      const variant = o.variant % TREE_VARIANTS[id as keyof typeof TREE_VARIANTS];
      const k = kindFor(id, variant);
      const wood = kinds[k]!.parts[0]!.geometry;
      if (!wood.boundingBox) wood.computeBoundingBox();
      const leaves = kinds[k]!.parts[1]!.geometry;
      if (!leaves.boundingBox) leaves.computeBoundingBox();
      const tall = Math.max(wood.boundingBox!.max.y, leaves.boundingBox!.max.y);
      placements.push({ kind: k, matrix: matrix(o.x, y - 0.2, o.z, hashId(o.id) * Math.PI * 2, o.height / tall) });
    }
  };
  for (const obstacle of world.obstacles) {
    if (obstacle.model) place(obstacle);
    else if (obstacle.kind === 'wall') {
      // Kept cooked landmarks (the bell frames, beacon, armillary, gates, cairn and wells) take the sightline cutaway.
      const structure = legacyWall(resources, world, obstacle, heroPosition, fortMaterials);
      structure.traverse(object => {
        if (object instanceof THREE.Mesh && !Array.isArray(object.material)) {
          object.material = cutaway(object.material, `landmark:${object.material.uuid}`, 1);
        }
      });
      legacy.at(obstacle).append(structure);
    } else throw new Error(`Version 3 obstacle ${obstacle.id} has no world model.`);
  }
  // Presentation-only pieces (gate arches) are drawn like the kit but never collide.
  for (const decor of world.decor ?? []) {
    placements.push({ kind: kindFor(decor.model as WorldModelId), matrix: matrix(decor.x, terrain.height(decor.x, decor.z), decor.z, decor.heading) });
  }
  const scatter = new ScatterField(group, kinds, 'world-scatter');
  for (const { kind, matrix: m } of placements) scatter.add(kind, m);
  const pools = scatter.finish();

  for (const site of world.sites) {
    structures.add('zone-ring', site.kind === 'home' ? palette.brass : palette.earth,
      [site.x, 0.022, site.z], [site.radius * 2, 1, site.radius * 2], [0, 0, 0], false);
    // A standard at the ring's edge: v3 combat yards are kept clear, so the pole never stands in a building.
    const angle = hashId(site.id) * Math.PI * 2;
    const x = site.x + Math.sin(angle) * site.radius * 0.8, z = site.z + Math.cos(angle) * site.radius * 0.8;
    const pole = 6.4;
    structures.add('box', palette.bark, [x, pole / 2, z], [0.12, pole, 0.12]);
    flagAnchors.set(site.id, new THREE.Vector3(x + 0.46, pole - 0.4, z));
  }
  // The horizon beyond the drawn ground: low, dark hills in the fog (mountain ranges come with W3).
  const { minX, minZ, maxX, maxZ } = world.bounds;
  const width = maxX - minX, depthZ = maxZ - minZ;
  const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
  for (let index = 0; index < 40; index += 1) {
    const angle = index / 40 * Math.PI * 2;
    const distance = (Math.max(width, depthZ) / 2 + TERRAIN_MARGIN + 30 + random() * 40) / Math.max(Math.abs(Math.sin(angle)), Math.abs(Math.cos(angle)));
    const height = 26 + random() * 34;
    structures.add('cone', index % 2 === 0 ? '#3f4a48' : '#46504c',
      [centerX + Math.sin(angle) * distance, height * 0.3 - 4, centerZ + Math.cos(angle) * distance],
      [70 + random() * 40, height, 60 + random() * 30], [0, angle, 0], false);
  }
  const staticMeshes = [...structures.finish(group), ...legacy.finish(group)];
  legacy.update(heroPosition);
  let lowQuality = false;

  return {
    group,
    heroPosition,
    flagAnchors,
    update(time, reducedMotion, camera): void {
      water.time.value = reducedMotion ? 0 : time;
      sky.position.set(heroPosition.x, 0, heroPosition.z);
      legacy.update(heroPosition);
      scatter.update(heroPosition, camera);
    },
    setQuality(low): void {
      if (low === lowQuality) return;
      lowQuality = low;
      scatter.setDistanceScale(low ? 0.72 : 1);
    },
    warm: (x, y, z) => scatter.warm(x, y, z),
    dispose(): void {
      for (const mesh of staticMeshes) mesh.dispose();
      for (const mesh of terrainMeshes) mesh.geometry.dispose();
      scatter.dispose();
      group.removeFromParent();
    },
  };
}
