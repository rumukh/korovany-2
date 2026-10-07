import * as THREE from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { MonsterSpecies, WorldBlueprint } from '../game/types';
import { monsterLairs } from '../game/world';
import { textureTranscoder } from './textures';

/**
 * Version 3 world assets: buildings, props, trees, rocks and animals. This registry is separate from the cooked
 * characters and story props (`MODEL_IDS` in models.ts): its own ids, files under `public/world/`, provenance under
 * `scripts/world/assets/` and its own budgets and tests. Version 1 and 2 worlds load none of it.
 */
export type WorldModelKind = 'kit' | 'prop' | 'tree' | 'rock' | 'fauna';

export const WORLD_MODELS = {
  'kit-cottage-a': { kind: 'kit' },
  'kit-cottage-b': { kind: 'kit' },
  'kit-cottage-c': { kind: 'kit' },
  'kit-longhouse': { kind: 'kit' },
  'kit-barn': { kind: 'kit' },
  'kit-shed': { kind: 'kit' },
  'kit-fence': { kind: 'kit' },
  'kit-stonehouse': { kind: 'kit' },
  'kit-brickhouse': { kind: 'kit' },
  'kit-townhouse-a': { kind: 'kit' },
  'kit-townhouse-b': { kind: 'kit' },
  'kit-inn': { kind: 'kit' },
  'kit-stable': { kind: 'kit' },
  'kit-chapel': { kind: 'kit' },
  'kit-chapel-fen': { kind: 'kit' },
  'kit-smithy': { kind: 'kit' },
  'kit-watchtower': { kind: 'kit' },
  'kit-stall': { kind: 'kit' },
  'kit-stilthut': { kind: 'kit' },
  'kit-saltshed': { kind: 'kit' },
  'kit-boathut': { kind: 'kit' },
  'kit-kiln': { kind: 'kit' },
  'kit-wall': { kind: 'kit' },
  'kit-curtain': { kind: 'kit' },
  'kit-curtain-ruin': { kind: 'kit' },
  'kit-tower-round': { kind: 'kit' },
  'kit-tower-square': { kind: 'kit' },
  'kit-tower-ruin': { kind: 'kit' },
  'kit-keep': { kind: 'kit' },
  'kit-gate-arch': { kind: 'kit' },
  'kit-ruin-chapel': { kind: 'kit' },
  'kit-ruin-house': { kind: 'kit' },
  'kit-camp-tower': { kind: 'kit' },
  /** W4b: the barrow ghouls' long barrow (build_kit_w4.py). */
  'kit-barrow': { kind: 'kit' },
  'prop-haystack': { kind: 'prop' },
  'prop-woodpile': { kind: 'prop' },
  'prop-barrels': { kind: 'prop' },
  'prop-scarecrow': { kind: 'prop' },
  'prop-hay-cart': { kind: 'prop' },
  'prop-bellpost': { kind: 'prop' },
  'prop-gibbet': { kind: 'prop' },
  'prop-wayside-shrine': { kind: 'prop' },
  'prop-handcart': { kind: 'prop' },
  'prop-crates': { kind: 'prop' },
  'prop-gravestones': { kind: 'prop' },
  'prop-gravestone': { kind: 'prop' },
  'prop-grave-ward': { kind: 'prop' },
  'prop-signpost': { kind: 'prop' },
  'prop-trough': { kind: 'prop' },
  'prop-anvil': { kind: 'prop' },
  'prop-lantern-post': { kind: 'prop' },
  'prop-net-rack': { kind: 'prop' },
  'prop-stocks': { kind: 'prop' },
  'prop-beehives': { kind: 'prop' },
  'prop-giant-skull': { kind: 'prop' },
  'prop-giant-ribs': { kind: 'prop' },
  'prop-standing-stones': { kind: 'prop' },
  'prop-troll-gibbet': { kind: 'prop' },
  'tree-spruce': { kind: 'tree' },
  'tree-birch': { kind: 'tree' },
  'tree-deadoak': { kind: 'tree' },
  'tree-blackpine': { kind: 'tree' },
  'tree-twistedoak': { kind: 'tree' },
  'tree-deadbirch': { kind: 'tree' },
  /** Undergrowth, drawn in the tree layout (stems, cards and a small impostor) but only as presentation near the hero. */
  'plant-bracken': { kind: 'tree' },
  'plant-bramble': { kind: 'tree' },
  /** W3b reed beds along the lakes' shores, in the same layout (build_nature_w3b.py). */
  'plant-reeds': { kind: 'tree' },
  'rock-boulder': { kind: 'rock' },
  'rock-mossy': { kind: 'rock' },
  'wood-log': { kind: 'rock' },
  'wood-stump': { kind: 'rock' },
  'rock-crag-moss-a': { kind: 'kit' },
  'rock-crag-moss-b': { kind: 'kit' },
  'rock-crag-moss-c': { kind: 'kit' },
  'rock-crag-moss-d': { kind: 'kit' },
  'rock-crag-snow-a': { kind: 'kit' },
  'rock-crag-snow-b': { kind: 'kit' },
  'rock-crag-snow-c': { kind: 'kit' },
  'rock-crag-snow-d': { kind: 'kit' },
  'rock-crag-bare-a': { kind: 'kit' },
  'rock-crag-bare-b': { kind: 'kit' },
  'rock-crag-bare-c': { kind: 'kit' },
  'rock-crag-bare-d': { kind: 'kit' },
  'char-sheep': { kind: 'fauna' },
  'char-crow': { kind: 'fauna' },
  'char-crow-flight': { kind: 'fauna' },
  /** W3b herds in the wilds: red deer hinds in the forests, feral goats on the crags (cook_quadruped.py). */
  'char-deer': { kind: 'fauna' },
  'char-goat': { kind: 'fauna' },
  /** W4 monsters: the grave wolf (cook_monster_quadruped.py); the barrow ghoul and the bog troll (cook_monster_biped.py). */
  'char-wolf': { kind: 'fauna' },
  'char-ghoul': { kind: 'fauna' },
  'char-troll': { kind: 'fauna' },
} as const satisfies Record<string, { kind: WorldModelKind }>;
export type WorldModelId = keyof typeof WORLD_MODELS;
export const WORLD_MODEL_IDS = Object.keys(WORLD_MODELS) as WorldModelId[];

/**
 * Layers of the two world surface texture arrays, in layer order. Kit, tree-bark and rock meshes carry the layer index
 * plus 0.5 in UV1.x (the Blender generators share this order; build_kit.py's LAYERS are the first seven).
 */
export const WORLD_SURFACES = ['daub', 'timber', 'thatch', 'shingle', 'rubble', 'planks', 'dark',
  'meadow', 'forest', 'mud', 'road', 'field', 'granite', 'bark-spruce', 'bark-birch',
  'ashlar', 'slate', 'lime', 'tarred', 'brick', 'reedmud', 'pebbles', 'ash', 'snow', 'cobbles', 'coldgrass', 'castle', 'mossruin',
  'darkforest', 'cliff', 'bark-pine', 'moss'] as const;
export type WorldSurface = typeof WORLD_SURFACES[number];
/** Every surface layer is a square tiling image of this many pixels. */
export const SURFACE_SIZE = 512;
/** Physical size in metres covered by one tile of each layer (the generators' UV0 scale). */
export const SURFACE_METRES: Readonly<Record<WorldSurface, number>> = {
  daub: 2, timber: 1, thatch: 2, shingle: 2, rubble: 2, planks: 2, dark: 1,
  meadow: 4, forest: 4, mud: 4, road: 4, field: 4, granite: 2, 'bark-spruce': 1, 'bark-birch': 1,
  ashlar: 2, slate: 2, lime: 2, tarred: 2, brick: 2, reedmud: 4, pebbles: 4, ash: 4, snow: 4, cobbles: 4, coldgrass: 4,
  castle: 3, mossruin: 2, darkforest: 4, cliff: 4, 'bark-pine': 1, moss: 2,
};
/**
 * How each layer's grayscale height map becomes its surface data (`deriveSurface`): tangent normals from the height
 * gradient times `relief`, and roughness around `roughness` (crevices rougher, raised detail slightly smoother).
 * scripts/world/pipeline/surface_arrays_ktx2.py derives the shipped surface arrays the same way, from the recipe's copy
 * of these values.
 */
export const SURFACE_FINISH: Readonly<Record<WorldSurface, { relief: number; roughness: number }>> = {
  daub: { relief: 2.2, roughness: 0.93 }, timber: { relief: 3, roughness: 0.84 }, thatch: { relief: 4, roughness: 0.96 },
  shingle: { relief: 3.5, roughness: 0.88 }, rubble: { relief: 5, roughness: 0.9 }, planks: { relief: 3, roughness: 0.85 },
  dark: { relief: 1, roughness: 0.95 }, meadow: { relief: 2.5, roughness: 0.96 }, forest: { relief: 3, roughness: 0.97 },
  mud: { relief: 2, roughness: 0.72 }, road: { relief: 3, roughness: 0.9 }, field: { relief: 4, roughness: 0.95 },
  granite: { relief: 4, roughness: 0.93 }, 'bark-spruce': { relief: 5, roughness: 0.92 }, 'bark-birch': { relief: 4, roughness: 0.9 },
  ashlar: { relief: 4, roughness: 0.9 }, slate: { relief: 3, roughness: 0.78 }, lime: { relief: 2, roughness: 0.93 },
  tarred: { relief: 3, roughness: 0.8 }, brick: { relief: 4, roughness: 0.9 }, reedmud: { relief: 2.5, roughness: 0.76 },
  pebbles: { relief: 5, roughness: 0.86 }, ash: { relief: 2, roughness: 0.97 }, snow: { relief: 2, roughness: 0.74 },
  cobbles: { relief: 5, roughness: 0.86 }, coldgrass: { relief: 3, roughness: 0.96 },
  castle: { relief: 4.5, roughness: 0.91 }, mossruin: { relief: 4, roughness: 0.94 },
  darkforest: { relief: 3, roughness: 0.97 }, cliff: { relief: 4.5, roughness: 0.92 },
  'bark-pine': { relief: 5, roughness: 0.93 }, moss: { relief: 2.5, roughness: 0.97 },
};
/** The grazing animals' clips: the sheep's, which the deer and goat share. */
export const FAUNA_CLIPS = ['Idle', 'Graze', 'Walk', 'Run', 'Startle'] as const;
/**
 * A monster's clips, the game's enemy state machine: Idle, Walk and Run by ground speed, Windup, Strike and Recovery
 * scrubbed by the simulation's progress through those states, Hit played additively on a wound and Death held at its
 * last frame.
 */
export const MONSTER_CLIPS = ['Idle', 'Walk', 'Run', 'Windup', 'Strike', 'Recovery', 'Hit', 'Death'] as const;
/** Each monster species' model. */
export const MONSTER_MODELS: Readonly<Record<MonsterSpecies, WorldModelId>> = { wolf: 'char-wolf', ghoul: 'char-ghoul', troll: 'char-troll' };
/**
 * The clips of every fauna model other than the sheep. The crows were the first (the perched model's and the flying
 * model's: the view swaps the two at take-off and landing); the name stays for the world-asset suite, which reads the
 * clip set of each non-sheep fauna model from here.
 */
export const CROW_CLIPS = {
  'char-crow': ['Perch', 'Peck'], 'char-crow-flight': ['Fly', 'Glide', 'TakeOff'], 'char-deer': FAUNA_CLIPS, 'char-goat': FAUNA_CLIPS,
  'char-wolf': MONSTER_CLIPS, 'char-ghoul': MONSTER_CLIPS, 'char-troll': MONSTER_CLIPS,
} as const;
/**
 * A tree species file holds one group per variant (`variant-0` ...), each with named meshes: bark-layered wood and
 * alpha-tested leaf cards for the near band, and a three-card impostor (two crossed side views and a top view) beyond it.
 */
export const TREE_PARTS = ['lod0-wood', 'lod0-leaves', 'impostor'] as const;
/** The middle band's parts, which W3 species (and the W0 trees from their W3 re-cook) carry as well. */
export const TREE_LOD1_PARTS = ['lod1-wood', 'lod1-leaves'] as const;
export const TREE_VARIANTS: Readonly<Record<'tree-spruce' | 'tree-birch' | 'tree-deadoak' | 'tree-blackpine' | 'tree-twistedoak'
  | 'tree-deadbirch' | 'plant-bracken' | 'plant-bramble' | 'plant-reeds', number>> = {
  'tree-spruce': 3, 'tree-birch': 2, 'tree-deadoak': 2, 'tree-blackpine': 3, 'tree-twistedoak': 2, 'tree-deadbirch': 2,
  'plant-bracken': 3, 'plant-bramble': 2, 'plant-reeds': 3,
};
/** Undergrowth the presentation scatters round forest trees (never obstacles). */
export const UNDERGROWTH = ['plant-bracken', 'plant-bramble'] as const;
/**
 * What the presentation stands along every v3 world's water (shores.ts, never obstacles): reed beds, drowned dead trees
 * and stumps, and boulders in the surf.
 */
export const SHORE_MODELS = ['plant-reeds', 'tree-deadoak', 'tree-deadbirch', 'wood-stump', 'rock-boulder'] as const;
export const ROCK_VARIANTS = 4;

export function worldModelUrl(id: WorldModelId): string {
  return `${import.meta.env.BASE_URL}world/${id}/${id}.glb`;
}

/** A layer's cooked grayscale height map, from which `deriveSurface` derives its tangent normals at load. */
export function surfaceUrl(surface: WorldSurface): string {
  return `${import.meta.env.BASE_URL}world/surfaces/${surface}-height.webp`;
}

/**
 * The albedo surface array, GPU-compressed (Basis Universal UASTC in KTX2): one SURFACE_SIZE layer per WORLD_SURFACES
 * entry, sRGB colour with the layer's roughness in alpha, with a full mip chain. It ships as SURFACE_ALBEDO_PARTS files
 * of consecutive layers, each within the world's 8 MiB per-file budget, which `WorldAssetLibrary` joins into one array
 * at load. scripts/world/pipeline/surface_albedo_ktx2.py builds them from the layers' cooked albedo and height WebPs in
 * `public/world/surfaces/` (the game no longer loads the albedo WebPs; the roughness is derived offline exactly as
 * `deriveSurface` derives it).
 */
export const SURFACE_ALBEDO_PARTS = 2;
/** Layers in each albedo part: part `p` holds layers `p * SURFACE_ALBEDO_PART_LAYERS` onward. */
export const SURFACE_ALBEDO_PART_LAYERS = WORLD_SURFACES.length / SURFACE_ALBEDO_PARTS;
export function surfaceAlbedoUrl(part: number): string {
  return `${import.meta.env.BASE_URL}world/surfaces/surfaces-albedo-${part}.ktx2`;
}
/** Mip levels of the albedo array: SURFACE_SIZE down to 1 x 1. */
export const SURFACE_LEVELS = Math.log2(SURFACE_SIZE) + 1;

/** Decoded opaque RGBA pixels, top row first. */
export interface SurfacePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface WorldAssetSource {
  model(id: WorldModelId): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>;
  /** One part of the albedo surface array (`surfaceAlbedoUrl`) with its mip chain, as the KTX2 transcoder returns it. */
  surfaceAlbedo(part: number): Promise<THREE.Texture>;
  image(url: string): Promise<SurfacePixels>;
}

/** Browser source: three's GLTFLoader with the bundled meshopt decoder, the page's shared KTX2 transcoder (`textures.ts`)
 * for the models' compressed maps and the albedo parts, and height maps decoded by the browser. */
export function gltfWorldSource(): WorldAssetSource {
  const transcoder = textureTranscoder();
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(transcoder);
  return {
    model: id => loader.loadAsync(worldModelUrl(id)),
    surfaceAlbedo: part => transcoder.loadAsync(surfaceAlbedoUrl(part)),
    async image(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('no 2D canvas');
        context.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
      } finally {
        bitmap.close();
      }
    },
  };
}

export interface WorldModel {
  readonly id: WorldModelId;
  readonly scene: THREE.Object3D;
  readonly clips: ReadonlyMap<string, THREE.AnimationClip>;
  readonly bounds: THREE.Box3;
}

export interface WorldSurfaces {
  /** sRGB colour with the layer's roughness in alpha (an sRGB texture's alpha stays linear), one layer per WORLD_SURFACES entry. */
  readonly albedo: THREE.CompressedArrayTexture;
  /** RG8 linear data: tangent-space normal X and Y (0.5 = flat). */
  readonly surface: THREE.DataArrayTexture;
}

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  root.traverse(object => {
    if (object instanceof THREE.Mesh) result.push(object);
  });
  return result;
}

/**
 * Tangent normal (R, G; +v along increasing rows) and roughness (B) of one tiling layer from its height map (rows
 * top-down as the image, values 0..1), written as RGBA8 into `target` at `offset`. Gradients wrap, so the result tiles.
 * The albedo array carries this function's roughness precomputed: surface_arrays_ktx2.py is an exact port of it (the
 * world asset tests check the two agree), while the normals are still derived at load from the height maps.
 */
export function deriveSurface(heights: Float32Array, size: number, finish: { relief: number; roughness: number },
  target: Uint8Array, offset: number): void {
  const strength = finish.relief * size / 128;
  for (let y = 0; y < size; y++) {
    const up = ((y + 1) % size) * size, down = ((y + size - 1) % size) * size, row = y * size;
    for (let x = 0; x < size; x++) {
      const right = (x + 1) % size, left = (x + size - 1) % size;
      const du = (heights[row + right]! - heights[row + left]!) * strength;
      const dv = (heights[up + x]! - heights[down + x]!) * strength;
      const inverse = 1 / Math.sqrt(du * du + dv * dv + 1);
      const i = offset + (row + x) * 4;
      target[i] = Math.round((0.5 - du * inverse * 0.5) * 255);
      target[i + 1] = Math.round((0.5 - dv * inverse * 0.5) * 255);
      target[i + 2] = Math.round(Math.min(1, Math.max(0.3, finish.roughness + (0.5 - heights[row + x]!) * 0.12)) * 255);
      target[i + 3] = 255;
    }
  }
}

/**
 * An albedo part must be a texture array of SURFACE_ALBEDO_PART_LAYERS SURFACE_SIZE layers in sRGB, with its full mip
 * chain (precomputed: nothing is generated at load). Rows stay top-down: v = 0 is the image's top edge, the glTF
 * convention the kit, tree and rock UVs follow.
 */
function albedoPart(part: number, texture: THREE.Texture): THREE.CompressedArrayTexture {
  const url = surfaceAlbedoUrl(part);
  if (!(texture as THREE.CompressedArrayTexture).isCompressedArrayTexture) throw new Error(`${url} is not a texture array`);
  const layers = texture as THREE.CompressedArrayTexture;
  const { width, height, depth } = layers.image;
  if (width !== SURFACE_SIZE || height !== SURFACE_SIZE) throw new Error(`${url} is ${width}x${height}, expected ${SURFACE_SIZE}x${SURFACE_SIZE}`);
  if (depth !== SURFACE_ALBEDO_PART_LAYERS) throw new Error(`${url} has ${depth} layers, expected ${SURFACE_ALBEDO_PART_LAYERS}`);
  const levels = layers.mipmaps?.length ?? 0;
  if (levels !== SURFACE_LEVELS) throw new Error(`${url} has ${levels} mip levels, expected ${SURFACE_LEVELS}`);
  if (layers.colorSpace !== THREE.SRGBColorSpace) throw new Error(`${url} is not sRGB`);
  return layers;
}

/**
 * One array of every layer from the albedo parts, in order: at each mip level a part's layers follow the previous part's.
 * The transcoder gives every part the same GPU format (all are UASTC with alpha), which this checks.
 */
function joinAlbedo(parts: readonly THREE.CompressedArrayTexture[]): THREE.CompressedArrayTexture {
  const first = parts[0]!;
  parts.forEach((part, index) => {
    if (part.format !== first.format || part.type !== first.type) {
      throw new Error(`${surfaceAlbedoUrl(index)} was transcoded to another format than ${surfaceAlbedoUrl(0)}`);
    }
  });
  const mipmaps = first.mipmaps!.map((level, index) => {
    const data = new Uint8Array(parts.reduce((bytes, part) => bytes + part.mipmaps![index]!.data.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      const layers = part.mipmaps![index]!.data;
      data.set(new Uint8Array(layers.buffer, layers.byteOffset, layers.byteLength), offset);
      offset += layers.byteLength;
    }
    return { data, width: level.width, height: level.height };
  });
  const albedo = new THREE.CompressedArrayTexture(mipmaps, SURFACE_SIZE, SURFACE_SIZE, WORLD_SURFACES.length, first.format, first.type);
  albedo.colorSpace = THREE.SRGBColorSpace;
  return albedo;
}

function validate(id: WorldModelId, scene: THREE.Object3D, clips: ReadonlyMap<string, THREE.AnimationClip>): void {
  const parts = meshes(scene);
  const kind = WORLD_MODELS[id].kind;
  const layered = (mesh: THREE.Mesh): void => {
    if (!mesh.geometry.getAttribute('uv') || !mesh.geometry.getAttribute('uv1')) throw new Error(`mesh ${mesh.name} has no surface UVs`);
  };
  if (kind === 'kit') {
    if (parts.length !== 1 || parts[0] instanceof THREE.SkinnedMesh) throw new Error('expected one static kit mesh');
    layered(parts[0]!);
  } else if (kind === 'prop') {
    if (parts.length !== 1 || parts[0] instanceof THREE.SkinnedMesh || Array.isArray(parts[0]!.material)) {
      throw new Error('expected one static mesh with one material');
    }
    if (!(parts[0]!.material instanceof THREE.MeshStandardMaterial)) throw new Error('prop material is not physically based');
  } else if (kind === 'tree') {
    const variants = TREE_VARIANTS[id as keyof typeof TREE_VARIANTS];
    for (let variant = 0; variant < variants; variant++) {
      const group = scene.getObjectByName(`variant-${variant}`);
      if (!group) throw new Error(`missing tree variant-${variant}`);
      const own = meshes(group);
      for (const name of TREE_PARTS) if (!own.some(mesh => mesh.name === `${name}-${variant}`)) throw new Error(`missing ${name}-${variant}`);
      layered(own.find(mesh => mesh.name === `lod0-wood-${variant}`)!);
    }
  } else if (kind === 'rock') {
    for (let variant = 0; variant < ROCK_VARIANTS; variant++) {
      const mesh = parts.find(candidate => candidate.name === `variant-${variant}`);
      if (!mesh) throw new Error(`missing rock variant-${variant}`);
      layered(mesh);
    }
  } else {
    const bodies = parts.filter(mesh => mesh instanceof THREE.SkinnedMesh);
    if (bodies.length !== 1 || parts.length !== 1) throw new Error(`expected one skinned body, found ${bodies.length} of ${parts.length}`);
    const expected: readonly string[] = id in CROW_CLIPS ? CROW_CLIPS[id as keyof typeof CROW_CLIPS] : FAUNA_CLIPS;
    for (const clip of expected) if (!clips.has(clip)) throw new Error(`missing animation clip ${clip}`);
  }
  for (const mesh of parts) if (!mesh.geometry.getAttribute('normal')) throw new Error(`mesh ${mesh.name} has no cooked normals`);
}

/**
 * Every world model a world can present: all of a v3 world's obstacle and decor models, its sheep when it has
 * pastures, the crows, deer and goats, which every v3 world has (crows gather on fields, graveyards and gibbets; deer
 * herds keep to the forests and goats to the crags), the monsters of its lairs and haunts, the undergrowth scattered
 * round its trees and what stands along its shores.
 */
export function worldAssetIds(world: Pick<WorldBlueprint, 'version' | 'obstacles' | 'fields' | 'decor' | 'lairs' | 'haunts'>): WorldModelId[] {
  if (world.version !== 3) return [];
  const ids = new Set<string>(['char-crow', 'char-crow-flight', 'char-deer', 'char-goat', ...UNDERGROWTH, ...SHORE_MODELS]);
  // Flocks graze on stubble fields (fauna.ts flockHomes).
  if (world.fields?.some(field => field.crop === 'stubble')) ids.add('char-sheep');
  for (const lair of monsterLairs(world)) ids.add(MONSTER_MODELS[lair.species]);
  for (const obstacle of world.obstacles) if (obstacle.model) ids.add(obstacle.model);
  for (const decor of world.decor ?? []) ids.add(decor.model);
  for (const id of ids) if (!(id in WORLD_MODELS)) throw new Error(`World obstacle model ${id} is not a registered world asset.`);
  return WORLD_MODEL_IDS.filter(id => ids.has(id));
}

export interface WorldAssetStatus {
  pending: number;
  loaded: number;
  total: number;
  error: string | null;
}

/**
 * Page-lifetime owner of the parsed world models and the surface texture arrays, like `ModelLibrary` for characters:
 * presentations borrow them and only this library disposes them. `request` loads models (and, the first time, the
 * surfaces) and keeps everything once parsed; a failure is kept for `status`, `isReady` and `assert`. There is no
 * primitive fallback.
 */
export class WorldAssetLibrary {
  private readonly models = new Map<WorldModelId, WorldModel>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly requested: string[] = [];
  private loadedCount = 0;
  private arrays: WorldSurfaces | undefined;
  private failure: Error | undefined;
  private pendingCount = 0;
  private disposed = false;

  constructor(private readonly source: WorldAssetSource) {}

  /** Starts loading what was never requested and resolves once all of `ids` and the surfaces are loaded. */
  request(ids: readonly WorldModelId[]): Promise<void> {
    if (!ids.length) return Promise.resolve();
    const all = Promise.all([this.track('surfaces', () => this.loadSurfaces()), ...ids.map(id => this.track(id, () => this.loadModel(id)))])
      .then(() => undefined);
    all.catch(() => undefined);
    return all;
  }

  private track(key: string, load: () => Promise<void>): Promise<void> {
    const existing = this.loads.get(key);
    if (existing) return existing;
    this.requested.push(key);
    this.pendingCount++;
    const loading = (async () => {
      try {
        await load();
        this.loadedCount++;
      } catch (cause) {
        const what = key === 'surfaces' ? 'world surface textures' : `world model ${worldModelUrl(key as WorldModelId)}`;
        const error = new Error(`Could not load ${what}: ${cause instanceof Error ? cause.message : String(cause)}. Reload to retry.`, { cause });
        this.failure ??= error;
        throw error;
      } finally {
        this.pendingCount--;
      }
    })();
    loading.catch(() => undefined);
    this.loads.set(key, loading);
    return loading;
  }

  private async loadModel(id: WorldModelId): Promise<void> {
    const gltf = await this.source.model(id);
    const clips = new Map(gltf.animations.map(clip => [clip.name, clip] as const));
    validate(id, gltf.scene, clips);
    gltf.scene.updateMatrixWorld(true);
    const model: WorldModel = { id, scene: gltf.scene, clips, bounds: new THREE.Box3().setFromObject(gltf.scene) };
    if (this.disposed) WorldAssetLibrary.release(model);
    else this.models.set(id, model);
  }

  private async loadSurfaces(): Promise<void> {
    const size = SURFACE_SIZE, texels = size * size;
    const normals = new Uint8Array(texels * 2 * WORLD_SURFACES.length);
    const heights = new Float32Array(texels);
    const derived = new Uint8Array(texels * 4);
    const albedoLoads = Promise.allSettled(Array.from({ length: SURFACE_ALBEDO_PARTS }, (_, part) => this.source.surfaceAlbedo(part)));
    const heightLoads = Promise.allSettled([Promise.all(WORLD_SURFACES.map(async (name, index) => {
      const url = surfaceUrl(name);
      const pixels = await this.source.image(url);
      if (pixels.width !== size || pixels.height !== size) throw new Error(`${url} is ${pixels.width}x${pixels.height}, expected ${size}x${size}`);
      // Rows stay top-down: v = 0 is the image's top edge, the glTF convention the kit, tree and rock UVs follow.
      for (let i = 0; i < texels; i++) heights[i] = pixels.data[i * 4]! / 255;
      deriveSurface(heights, size, SURFACE_FINISH[name], derived, 0);
      // The data array keeps only the normal's X and Y (the roughness rides in the albedo's alpha): two bytes a texel.
      for (let i = 0, offset = index * texels * 2; i < texels; i++) {
        normals[offset + i * 2] = derived[i * 4]!;
        normals[offset + i * 2 + 1] = derived[i * 4 + 1]!;
      }
    }))]);
    const [parts, [heightLoad]] = await Promise.all([albedoLoads, heightLoads]);
    const loaded = parts.flatMap(load => load.status === 'fulfilled' ? [load.value] : []);
    try {
      for (const load of parts) if (load.status === 'rejected') throw load.reason;
      if (heightLoad!.status === 'rejected') throw heightLoad!.reason;
      const albedo = joinAlbedo(loaded.map((texture, part) => albedoPart(part, texture)));
      const surface = new THREE.DataArrayTexture(normals, size, size, WORLD_SURFACES.length);
      surface.format = THREE.RGFormat;
      surface.colorSpace = THREE.NoColorSpace;
      surface.generateMipmaps = true;
      for (const texture of [albedo, surface]) {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.anisotropy = 8;
        texture.needsUpdate = true;
      }
      if (this.disposed) {
        albedo.dispose();
        surface.dispose();
      } else this.arrays = { albedo, surface };
    } finally {
      // The parts were never uploaded: the joined array holds copies of their layers.
      for (const texture of loaded) texture.dispose();
    }
  }

  get status(): WorldAssetStatus {
    return { pending: this.pendingCount, loaded: this.loadedCount, total: this.requested.length, error: this.failure?.message ?? null };
  }

  /** True once everything requested has loaded and nothing failed. */
  get isReady(): boolean {
    return !this.failure && this.loadedCount === this.requested.length;
  }

  assert(): void {
    if (this.failure) throw this.failure;
  }

  get(id: WorldModelId): WorldModel | undefined {
    return this.models.get(id);
  }

  require(id: WorldModelId): WorldModel {
    this.assert();
    const model = this.models.get(id);
    if (!model) throw new Error(`World model ${id} was used before it finished loading.`);
    return model;
  }

  surfaces(): WorldSurfaces {
    this.assert();
    if (!this.arrays) throw new Error('The world surface textures were used before they finished loading.');
    return this.arrays;
  }

  private static release(model: WorldModel): void {
    const textures = new Set<THREE.Texture>();
    model.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
        material.dispose();
      }
      if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
    });
    for (const texture of textures) texture.dispose();
  }

  /** Frees GPU copies owned by the current renderer while keeping parsed data for the next one. */
  releaseGpu(): void {
    for (const model of this.models.values()) WorldAssetLibrary.release(model);
    this.arrays?.albedo.dispose();
    this.arrays?.surface.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseGpu();
    this.models.clear();
    this.arrays = undefined;
  }
}
