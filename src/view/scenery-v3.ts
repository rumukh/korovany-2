import * as THREE from 'three';
import type { Obstacle, Vec2, WorldBlueprint } from '../game/types';
import { isWalkable } from '../game/world';
import { crags, LOCATION_CLEARING, RING_STYLE, V3_BUILDINGS, V3_MODULES, V3_PROPS } from '../game/world-v3';
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
import { distanceToSegment } from './world';
import { addBridge, legacyWall, makeSky, makeWater, type WorldScenery } from './world';
import { V3_GRADE } from './atmosphere';

/** Distance bands, in metres from the camera. Shadows are cast only by what can shade the hero's surroundings. */
const BANDS = {
  building: { shadow: 95, far: 235 },
  prop: { shadow: 60, far: 160 },
  rock: { shadow: 60, far: 200 },
  /** Trees with a middle level of detail switch to it at `lod1`; impostors take over at `near`. */
  tree: { lod1: 24, near: 58, far: 235 },
  /** Undergrowth: small, so it never casts shadows; whole within 30 m (beyond any gameplay camera's hero), gone by 70 m. */
  plant: { lod1: 30, near: 45, far: 70 },
  /** Crags are mountains: a separate long-range field, so their reach never widens the forest's. */
  crag: { shadow: 150, far: 560 },
} as const;
/** Share of a region's trees that get a clump of undergrowth at their foot. */
const UNDERGROWTH_SHARE: Readonly<Record<string, number>> = {
  greenmarch: 0.9, hollowvale: 0.9, fenlands: 0.4, frostspine: 0.15, heartlands: 0.15, crownlands: 0.15, saltcoast: 0.05, ashsteppe: 0.05,
};
/**
 * Canopies and trunks dither away in a cone around the camera-to-hero sightline: 3-6 m wide at the hero, twice that at
 * the camera, so forest never hides the hero or the ground around them (the architecture cutaway is 1.6-3.2 m).
 */
const CANOPY_CUTAWAY = { radius: [3, 6] as const, widen: 1 };
/** Crags stand 11-30 m tall, so a crag between the camera and the hero opens a cone like a canopy's, not a keyhole. */
const CRAG_CUTAWAY = { radius: [3.5, 7] as const, widen: 1 };

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
 * Bracken and bramble clumps at the foot of trees (presentation only, never obstacles), deterministic from the world:
 * a regional share of trees gets one, on walkable ground clear of roads, fields, places and sites.
 */
export function undergrowth(world: WorldBlueprint): { id: 'plant-bracken' | 'plant-bramble'; variant: number; x: number; z: number;
  heading: number; scale: number }[] {
  const random = seededRandom(Math.floor(hashId(`${world.seed}:undergrowth`) * 4294967296));
  const regions = world.exploration?.regions ?? [];
  const node = new Map(world.roads.nodes.map(n => [n.id, n]));
  const roads = world.roads.edges.map(edge => ({ a: node.get(edge.from)!, b: node.get(edge.to)!, half: edge.width / 2 }));
  const places = world.exploration?.locations ?? [];
  const inField = (p: Vec2): boolean => (world.fields ?? []).some(f => {
    const dx = p.x - f.x, dz = p.z - f.z, c = Math.cos(f.heading), s = Math.sin(f.heading);
    return Math.abs(dx * c - dz * s) < f.halfX + 1 && Math.abs(dx * s + dz * c) < f.halfZ + 1;
  });
  const result: ReturnType<typeof undergrowth> = [];
  for (const o of world.obstacles) {
    if (o.kind !== 'tree') continue;
    const region = regions.find(r => o.x >= r.bounds.minX && o.x <= r.bounds.maxX && o.z >= r.bounds.minZ && o.z <= r.bounds.maxZ);
    const share = region && Object.hasOwn(UNDERGROWTH_SHARE, region.id) ? UNDERGROWTH_SHARE[region.id]! : 0.1;
    if (random() >= share) continue;
    const angle = random() * Math.PI * 2, reach = o.radius + 1 + random() * 2.5;
    const p = { x: o.x + Math.sin(angle) * reach, z: o.z + Math.cos(angle) * reach };
    const bramble = (region?.id === 'greenmarch' || region?.id === 'hollowvale') && random() < 0.35;
    const id = bramble ? 'plant-bramble' : 'plant-bracken';
    const variant = Math.floor(random() * TREE_VARIANTS[id]);
    const heading = random() * Math.PI * 2, scale = 0.8 + random() * 0.45;
    if (!isWalkable(world, p, 0.35) || inField(p)) continue;
    if (roads.some(road => distanceToSegment(p, road.a, road.b) < road.half + 1)) continue;
    if (places.some(place => Math.hypot(p.x - place.x, p.z - place.z) < LOCATION_CLEARING + 2)) continue;
    if (world.sites.some(site => Math.hypot(p.x - site.x, p.z - site.z) < site.radius + 4)) continue;
    result.push({ id, variant, x: p.x, z: p.z, heading, scale });
  }
  return result;
}

/**
 * Far mountains behind the ring (presentation only): its crags at 2.4 to 5.2 times their size in two rows wholly outside
 * the bounds (so no drawn rock ever stands where the hero can walk), styled like the ring of the region they face; the
 * Salt Coast's edge stays open. Deterministic from the world; only crag models the world already uses.
 */
export function farMountains(world: WorldBlueprint): { id: WorldModelId; x: number; z: number; heading: number; scale: number }[] {
  const random = seededRandom(Math.floor(hashId(`${world.seed}:far-mountains`) * 4294967296));
  const { minX, maxX, minZ, maxZ } = world.bounds;
  const regions = world.exploration?.regions ?? [];
  const present = new Set(world.obstacles.map(o => o.model));
  const sides = [
    { a: { x: minX, z: maxZ }, b: { x: maxX, z: maxZ }, inward: { x: 0, z: -1 } },
    { a: { x: maxX, z: maxZ }, b: { x: maxX, z: minZ }, inward: { x: -1, z: 0 } },
    { a: { x: maxX, z: minZ }, b: { x: minX, z: minZ }, inward: { x: 0, z: 1 } },
    { a: { x: minX, z: minZ }, b: { x: minX, z: maxZ }, inward: { x: 1, z: 0 } },
  ];
  const result: ReturnType<typeof farMountains> = [];
  for (const side of sides) {
    const length = Math.hypot(side.b.x - side.a.x, side.b.z - side.a.z);
    const d = { x: (side.b.x - side.a.x) / length, z: (side.b.z - side.a.z) / length };
    for (const row of [0, 1]) {
      let along = -40 + random() * 30;
      while (along < length + 40) {
        const edge = { x: side.a.x + d.x * along, z: side.a.z + d.z * along };
        const probe = { x: Math.min(maxX - 1, Math.max(minX + 1, edge.x + side.inward.x * 20)), z: Math.min(maxZ - 1, Math.max(minZ + 1, edge.z + side.inward.z * 20)) };
        const region = regions.find(r => probe.x >= r.bounds.minX && probe.x <= r.bounds.maxX && probe.z >= r.bounds.minZ && probe.z <= r.bounds.maxZ);
        const style = region && Object.hasOwn(RING_STYLE, region.id) ? RING_STYLE[region.id]! : undefined;
        const id = style ? crags(style)[Math.floor(random() * 4)]! : undefined;
        if (!id || !present.has(id)) {
          along += 30;
          continue;
        }
        const scale = row === 0 ? 2.4 + random() * 1.4 : 3.4 + random() * 1.8;
        const reach = V3_BUILDINGS[id].width / 2 * scale;
        const out = reach + (row === 0 ? 4 + random() * 16 : 70 + random() * 50);
        result.push({ id: id as WorldModelId, x: edge.x - side.inward.x * out, z: edge.z - side.inward.z * out, heading: random() * Math.PI * 2, scale });
        along += reach * (0.8 + random() * 0.5);
      }
    }
  }
  return result;
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
  const cragRock = resources.ownMaterial('world-kit-crag', kitMaterial(surfaces, heroPosition, CRAG_CUTAWAY));
  const depth = resources.depthMaterial();
  const kinds: ScatterKind[] = [];
  const kindOf = new Map<string, number>();
  const cragKinds: ScatterKind[] = [];
  const cragKindOf = new Map<string, number>();
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
  /** Crags draw from their own long-range field: shadows within 150 m, the whole mountain out to 560 m. */
  const cragKind = (id: WorldModelId): number => {
    const known = cragKindOf.get(id);
    if (known !== undefined) return known;
    const mesh = assets.require(id).scene.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const geometry = placedGeometry(resources, id, mesh);
    cragKinds.push({ radius: radiusOf(geometry), parts: [
      { name: `${id}:near`, geometry, material: cragRock, near: 0, far: BANDS.crag.shadow, castShadow: true, depthMaterial: depth },
      { name: `${id}:far`, geometry, material: cragRock, near: BANDS.crag.shadow, far: BANDS.crag.far, castShadow: false },
    ] });
    cragKindOf.set(id, cragKinds.length - 1);
    return cragKinds.length - 1;
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
      // Undergrowth uses the plant bands and casts no shadow; trees with a middle level of detail get a third band.
      const plant = id.startsWith('plant-');
      const t = plant ? BANDS.plant : BANDS.tree;
      const wood = part('lod0-wood'), leaves = part('lod0-leaves'), impostor = part('impostor');
      const middle = model.scene.getObjectByName(`lod1-wood-${variant}`) instanceof THREE.Mesh;
      const split = middle ? t.lod1 : t.near;
      const parts: ScatterPart[] = [
        { name: `${key}:wood`, ...wood, near: 0, far: split, castShadow: !plant, depthMaterial: depth },
        { name: `${key}:leaves`, ...leaves, near: 0, far: split, castShadow: !plant },
      ];
      if (middle) {
        parts.push({ name: `${key}:wood1`, ...part('lod1-wood'), near: split, far: t.near, castShadow: !plant, depthMaterial: depth },
          { name: `${key}:leaves1`, ...part('lod1-leaves'), near: split, far: t.near, castShadow: !plant });
      }
      parts.push({ name: `${key}:impostor`, ...impostor, near: t.near, far: t.far, castShadow: false });
      return define(key, parts);
    }
    throw new Error(`World model ${id} is not scenery.`);
  };

  const legacy = new WorldChunks(resources, 'world-structures');
  const fortMaterials = new Map<THREE.Material, THREE.Material>();
  const placements: { kind: number; matrix: THREE.Matrix4 }[] = [];
  const cragPlacements: { kind: number; matrix: THREE.Matrix4 }[] = [];
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
    if (kind === 'kit' && id.startsWith('rock-crag-')) {
      // A crag stands on the lowest ground under its talus (its flat foot sinks into higher ground), turned by its id.
      let low = y;
      for (const [reach, count] of [[o.radius * 0.5, 6], [o.radius * 0.95, 12]] as const) {
        for (let index = 0; index < count; index++) {
          const angle = index / count * Math.PI * 2;
          low = Math.min(low, terrain.height(o.x + Math.sin(angle) * reach, o.z + Math.cos(angle) * reach));
        }
      }
      cragPlacements.push({ kind: cragKind(id), matrix: matrix(o.x, low - 0.35, o.z, hashId(o.id) * Math.PI * 2) });
    } else if (kind === 'kit') {
      // Round towers are circles: they turn by a stable hash of their id.
      placements.push({ kind: kindFor(id), matrix: matrix(o.x, y, o.z, o.shape ? o.shape.heading : hashId(o.id) * Math.PI * 2) });
    } else if (kind === 'prop') {
      placements.push({ kind: kindFor(id), matrix: matrix(o.x, y, o.z, o.shape ? o.shape.heading : hashId(o.id) * Math.PI * 2) });
    } else if (kind === 'rock' && id !== 'rock-boulder') {
      // W3 forest floor at the obstacle's scale: logs (boxes along local Z) pitched to the ground between their ends.
      const k = kindFor(id, o.variant % ROCK_VARIANTS);
      const spec = V3_PROPS[id as 'rock-mossy' | 'wood-stump' | 'wood-log'];
      if (o.shape && 'length' in spec) {
        const scale = o.shape.halfZ * 2 / spec.length, h = o.shape.heading;
        const reach = o.shape.halfZ * 0.8, ax = Math.sin(h) * reach, az = Math.cos(h) * reach;
        const y0 = terrain.height(o.x - ax, o.z - az), y1 = terrain.height(o.x + ax, o.z + az);
        const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), h)
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.atan2(y1 - y0, reach * 2)));
        placements.push({ kind: k, matrix: new THREE.Matrix4().compose(new THREE.Vector3(o.x, (y0 + y1) / 2 - 0.06 * scale, o.z), turn,
          new THREE.Vector3(scale, scale, scale)) });
      } else if ('radius' in spec) {
        const scale = o.radius / spec.radius;
        const sink = id === 'rock-mossy' ? 0.22 * o.height : 0.03;
        placements.push({ kind: k, matrix: matrix(o.x, y - sink, o.z, hashId(o.id) * Math.PI * 2, scale) });
      }
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
  for (const peak of farMountains(world)) {
    cragPlacements.push({ kind: cragKind(peak.id), matrix: matrix(peak.x, terrain.height(peak.x, peak.z) - 1.5 * peak.scale, peak.z, peak.heading, peak.scale) });
  }
  for (const plant of undergrowth(world)) {
    placements.push({ kind: kindFor(plant.id, plant.variant), matrix: matrix(plant.x, terrain.height(plant.x, plant.z) - 0.05, plant.z, plant.heading, plant.scale) });
  }
  const scatter = new ScatterField(group, kinds, 'world-scatter');
  for (const { kind, matrix: m } of placements) scatter.add(kind, m);
  const pools = scatter.finish();
  const mountains = new ScatterField(group, cragKinds, 'world-crags');
  for (const { kind, matrix: m } of cragPlacements) mountains.add(kind, m);
  mountains.finish();

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
  // The horizon beyond the far mountains: low, dark hills in the fog.
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
      mountains.update(heroPosition, camera);
    },
    setQuality(low): void {
      if (low === lowQuality) return;
      lowQuality = low;
      scatter.setDistanceScale(low ? 0.72 : 1);
      mountains.setDistanceScale(low ? 0.72 : 1);
    },
    warm(x, y, z) {
      const near = scatter.warm(x, y, z), far = mountains.warm(x, y, z);
      return { objects: [...near.objects, ...far.objects], restore: () => { near.restore(); far.restore(); } };
    },
    dispose(): void {
      for (const mesh of staticMeshes) mesh.dispose();
      for (const mesh of terrainMeshes) mesh.geometry.dispose();
      scatter.dispose();
      mountains.dispose();
      group.removeFromParent();
    },
  };
}
