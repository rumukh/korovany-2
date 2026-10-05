import * as THREE from 'three';
import type { Obstacle, WorldBlueprint } from '../game/types';
import { fbm } from '../game/world-v3';
import type { Terrain } from './terrain';
import { WORLD_SURFACES, type WorldSurface } from './world-assets';
import type { TerrainControl } from './world-materials';

/** Terrain chunks: 128 m squares of 2 m quads, so a view draws about a dozen of them. */
export const TERRAIN_CHUNK = 128;
export const TERRAIN_SPACING = 2;
/** The drawn ground reaches this far beyond the authoritative bounds; a flat apron and the fog cover the rest. */
export const TERRAIN_MARGIN = 128;
/** Control map texels per side over the world bounds. */
export const CONTROL_SIZE = 1024;
/**
 * Regional ground: a base layer that replaces the meadow inside a region (meeting the meadow again at the borders it
 * shares with other regions) and an overlay in noise patches above `patches`; meadow survives in a few patches too.
 */
export const REGION_GROUND: Readonly<Record<string, { base: WorldSurface; overlay?: WorldSurface; patches?: number }>> = {
  fenlands: { base: 'reedmud' },
  saltcoast: { base: 'coldgrass', overlay: 'pebbles', patches: 0.6 },
  ashsteppe: { base: 'ash' },
  frostspine: { base: 'coldgrass', overlay: 'snow', patches: 0.53 },
  hollowvale: { base: 'coldgrass' },
};
/** Stone towns whose squares and streets are cobbled (the mud and road layers turn to cobbles near the centre). */
export const COBBLED_PLACES: ReadonlySet<string> = new Set(['crownbridge', 'saltmarket', 'cinderwell']);
/** Depth of the river channel below the water plane, reached this far inside its banks. */
const RIVER_DEPTH = 1.6;
const RIVER_SHELF = 4;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Drawn ground height: the presentation relief, with the river channel carved below its water plane. */
export function drawnHeight(world: WorldBlueprint, terrain: Terrain, x: number, z: number): number {
  const river = world.river;
  const inside = Math.min(x - river.minX, river.maxX - x, z - river.minZ, river.maxZ - z);
  if (inside > 0 && !world.bridges.some(b => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ)) {
    return -RIVER_DEPTH * smoothstep(0, RIVER_SHELF, inside);
  }
  return terrain.height(x, z);
}

/** The square the terrain chunks cover: the bounds plus the margin, rounded out to whole chunks. */
export function terrainExtent(world: WorldBlueprint): { x0: number; z0: number; x1: number; z1: number } {
  const { minX, minZ, maxX, maxZ } = world.bounds;
  return {
    x0: Math.floor((minX - TERRAIN_MARGIN) / TERRAIN_CHUNK) * TERRAIN_CHUNK,
    z0: Math.floor((minZ - TERRAIN_MARGIN) / TERRAIN_CHUNK) * TERRAIN_CHUNK,
    x1: Math.ceil((maxX + TERRAIN_MARGIN) / TERRAIN_CHUNK) * TERRAIN_CHUNK,
    z1: Math.ceil((maxZ + TERRAIN_MARGIN) / TERRAIN_CHUNK) * TERRAIN_CHUNK,
  };
}

/**
 * The flat far-view apron around the chunks: a square `size` wide with a hole `overlap` metres inside the chunks'
 * extent, so no ground pixel is shaded by both the apron and a chunk (the terrain shader is the costliest in a frame).
 */
export function apronGeometry(world: WorldBlueprint, size: number, overlap = 1): THREE.BufferGeometry {
  const { x0, z0, x1, z1 } = terrainExtent(world);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, half = size / 2;
  const outer = [cx - half, cz - half, cx + half, cz + half];
  const inner = [x0 + overlap, z0 + overlap, x1 - overlap, z1 - overlap];
  // Four bands: south and north across the full width, west and east between them.
  const bands = [
    [outer[0], outer[1], outer[2], inner[1]], [outer[0], inner[3], outer[2], outer[3]],
    [outer[0], inner[1], inner[0], inner[3]], [inner[2], inner[1], outer[2], inner[3]],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  for (const [ax, az, bx, bz] of bands) {
    // Counter-clockwise seen from above (+Y), so the faces point up.
    positions.push(ax!, 0, az!, ax!, 0, bz!, bx!, 0, az!, bx!, 0, az!, ax!, 0, bz!, bx!, 0, bz!);
    for (let vertex = 0; vertex < 6; vertex++) normals.push(0, 1, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** One merged mesh per chunk, positions in world space; adjacent chunks share their edge vertices exactly. */
export function terrainChunks(world: WorldBlueprint, terrain: Terrain, material: THREE.Material): THREE.Mesh[] {
  const { x0, z0, x1, z1 } = terrainExtent(world);
  const n = TERRAIN_CHUNK / TERRAIN_SPACING;
  const index: number[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const a = r * (n + 1) + c, b = a + 1, d = a + n + 1, e = d + 1;
      // Alternate the diagonal so the 2 m grid never reads as parallel creases.
      if ((r + c) % 2 === 0) index.push(a, d, b, b, d, e);
      else index.push(a, d, e, a, e, b);
    }
  }
  const meshes: THREE.Mesh[] = [];
  for (let cz = z0; cz < z1; cz += TERRAIN_CHUNK) {
    for (let cx = x0; cx < x1; cx += TERRAIN_CHUNK) {
      // Heights on a (n + 3)^2 grid with a one-vertex border, so normals match across chunk edges.
      const side = n + 3;
      const heights = new Float32Array(side * side);
      for (let r = 0; r < side; r++) {
        for (let c = 0; c < side; c++) {
          heights[r * side + c] = drawnHeight(world, terrain, cx + (c - 1) * TERRAIN_SPACING, cz + (r - 1) * TERRAIN_SPACING);
        }
      }
      const positions = new Float32Array((n + 1) * (n + 1) * 3);
      const normals = new Float32Array((n + 1) * (n + 1) * 3);
      for (let r = 0; r <= n; r++) {
        for (let c = 0; c <= n; c++) {
          const v = (r * (n + 1) + c) * 3;
          const h = (rr: number, cc: number) => heights[(rr + 1) * side + cc + 1]!;
          positions[v] = cx + c * TERRAIN_SPACING;
          positions[v + 1] = h(r, c);
          positions[v + 2] = cz + r * TERRAIN_SPACING;
          const dx = (h(r, c + 1) - h(r, c - 1)) / (2 * TERRAIN_SPACING);
          const dz = (h(r + 1, c) - h(r - 1, c)) / (2 * TERRAIN_SPACING);
          const length = Math.hypot(dx, 1, dz);
          normals[v] = -dx / length;
          normals[v + 1] = 1 / length;
          normals[v + 2] = -dz / length;
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.setIndex(index);
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `terrain:${cx}:${cz}`;
      mesh.receiveShadow = true;
      meshes.push(mesh);
    }
  }
  return meshes;
}

interface Raster {
  data: Float32Array;
  size: number;
  minX: number;
  minZ: number;
  cell: number;
}

/** Applies `value` (0..1, max-combined) to every texel centre within the axis-aligned box. */
function paint(raster: Raster, x0: number, z0: number, x1: number, z1: number, value: (x: number, z: number) => number): void {
  const { size, minX, minZ, cell, data } = raster;
  const c0 = Math.max(0, Math.floor((x0 - minX) / cell)), c1 = Math.min(size - 1, Math.ceil((x1 - minX) / cell));
  const r0 = Math.max(0, Math.floor((z0 - minZ) / cell)), r1 = Math.min(size - 1, Math.ceil((z1 - minZ) / cell));
  for (let r = r0; r <= r1; r++) {
    const z = minZ + (r + 0.5) * cell;
    for (let c = c0; c <= c1; c++) {
      const v = value(minX + (c + 0.5) * cell, z);
      const i = r * size + c;
      if (v > data[i]!) data[i] = v;
    }
  }
}

/** Distance outside an oriented rectangle (0 inside), in its own frame (local X = (cos h, -sin h)). */
function boxDistance(x: number, z: number, cx: number, cz: number, halfX: number, halfZ: number, heading: number): number {
  const dx = x - cx, dz = z - cz, c = Math.cos(heading), s = Math.sin(heading);
  const lx = Math.abs(dx * c - dz * s) - halfX, lz = Math.abs(dx * s + dz * c) - halfZ;
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0);
}

function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

function footprintOf(o: Obstacle): { halfX: number; halfZ: number; heading: number } {
  return o.shape ?? { halfX: o.radius, halfZ: o.radius, heading: 0 };
}

/**
 * The ground layer weights of a v3 world: forest floor under canopies, trampled mud around buildings, yards, camps and
 * river banks, the roads, and the strip fields with their furrow headings. Deterministic and computed at load.
 */
export function terrainControl(world: WorldBlueprint): TerrainControl {
  const { minX, minZ, maxX, maxZ } = world.bounds;
  const size = CONTROL_SIZE;
  const cell = Math.max(maxX - minX, maxZ - minZ) / size;
  const raster = (): Raster => ({ data: new Float32Array(size * size), size, minX, minZ, cell });
  const forest = raster(), mud = raster(), road = raster(), field = raster();
  const heading = new Uint8Array(size * size), stubble = new Uint8Array(size * size);
  for (const o of world.obstacles) {
    if (o.kind === 'tree') {
      const reach = Math.min(6.5, Math.max(2.8, o.height * 0.3));
      paint(forest, o.x - reach, o.z - reach, o.x + reach, o.z + reach,
        (x, z) => 1 - smoothstep(reach * 0.45, reach, Math.hypot(x - o.x, z - o.z)));
    } else if (o.kind === 'wall' && o.model?.startsWith('kit-') && o.model !== 'kit-fence' && o.model !== 'kit-wall') {
      const f = footprintOf(o), reach = Math.hypot(f.halfX, f.halfZ) + 5;
      paint(mud, o.x - reach, o.z - reach, o.x + reach, o.z + reach,
        (x, z) => 0.85 * (1 - smoothstep(0.5, 4.5, boxDistance(x, z, o.x, o.z, f.halfX, f.halfZ, f.heading))));
    } else if (o.kind === 'wall' && (o.model === 'kit-fence' || o.model === 'kit-wall') && o.id.endsWith('-back')) {
      // The yard or an inn's courtyard: from the building's back wall to its back fence or wall.
      const house = world.obstacles.find(h => h.id === o.id.replace(/-(yard|court)-/, '-house-').replace(/-back$/, ''));
      if (!house?.shape) continue;
      const hx = (o.x + house.x) / 2, hz = (o.z + house.z) / 2;
      const depth = Math.hypot(o.x - house.x, o.z - house.z) - house.shape.halfX;
      const reach = Math.hypot(depth, house.shape.halfZ) + 2;
      paint(mud, hx - reach, hz - reach, hx + reach, hz + reach,
        (x, z) => 0.6 * (1 - smoothstep(-0.5, 1.5, boxDistance(x, z, hx, hz, depth / 2, house.shape!.halfZ + 0.6, house.shape!.heading))));
    }
  }
  for (const site of world.sites) {
    const reach = site.radius + 6;
    paint(mud, site.x - reach, site.z - reach, site.x + reach, site.z + reach,
      (x, z) => 0.7 * (1 - smoothstep(site.radius * 0.6, reach, Math.hypot(x - site.x, z - site.z))));
  }
  for (const place of world.exploration?.locations ?? []) {
    const reach = Math.min(place.radius, 16) + 4;
    paint(mud, place.x - reach, place.z - reach, place.x + reach, place.z + reach,
      (x, z) => 0.55 * (1 - smoothstep(reach * 0.4, reach, Math.hypot(x - place.x, z - place.z))));
  }
  const river = world.river;
  paint(mud, river.minX - 4, river.minZ - 4, river.maxX + 4, river.maxZ + 4, (x, z) => {
    const outside = Math.max(river.minX - x, x - river.maxX, river.minZ - z, z - river.maxZ);
    return 0.9 * (1 - smoothstep(0.5, 3.5, outside));
  });
  const node = (id: string) => world.roads.nodes.find(n => n.id === id)!;
  for (const edge of world.roads.edges) {
    const a = node(edge.from), b = node(edge.to), half = edge.width / 2, reach = half + 1.5;
    paint(road, Math.min(a.x, b.x) - reach, Math.min(a.z, b.z) - reach, Math.max(a.x, b.x) + reach, Math.max(a.z, b.z) + reach,
      (x, z) => 1 - smoothstep(half - 0.6, half + 0.9, segmentDistance(x, z, a.x, a.z, b.x, b.z)));
  }
  for (const f of world.fields ?? []) {
    const reach = Math.hypot(f.halfX, f.halfZ) + 1;
    const furrow = Math.round(((f.heading % Math.PI + Math.PI) % Math.PI) / Math.PI * 255);
    const r0 = Math.max(0, Math.floor((f.z - reach - minZ) / cell)), r1 = Math.min(size - 1, Math.ceil((f.z + reach - minZ) / cell));
    const c0 = Math.max(0, Math.floor((f.x - reach - minX) / cell)), c1 = Math.min(size - 1, Math.ceil((f.x + reach - minX) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = boxDistance(minX + (c + 0.5) * cell, minZ + (r + 0.5) * cell, f.x, f.z, f.halfX, f.halfZ, f.heading);
        const v = 1 - smoothstep(-0.6, 0.4, d);
        const i = r * size + c;
        if (v > field.data[i]!) field.data[i] = v;
        // Nearest-texel attributes cover the soft edge too, so it never samples a neighbour's heading.
        if (d < 1) {
          heading[i] = furrow;
          stubble[i] = f.crop === 'stubble' ? 255 : 0;
        }
      }
    }
  }
  const weights = new Uint8Array(size * size * 4);
  const fields = new Uint8Array(size * size * 4);
  const ground = regionalGround(world, size, cell);
  for (let i = 0; i < size * size; i++) {
    const roadWeight = road.data[i]!;
    const keep = 1 - roadWeight;
    let fieldWeight = field.data[i]! * keep;
    let mudWeight = mud.data[i]! * keep * (1 - fieldWeight);
    let forestWeight = forest.data[i]! * keep * (1 - fieldWeight) * (1 - mudWeight * 0.7);
    const total = roadWeight + fieldWeight + mudWeight + forestWeight;
    const scale = total > 1 ? 1 / total : 1;
    fieldWeight *= scale;
    mudWeight *= scale;
    forestWeight *= scale;
    weights[i * 4] = Math.round(forestWeight * 255);
    weights[i * 4 + 1] = Math.round(mudWeight * 255);
    weights[i * 4 + 2] = Math.round(roadWeight * scale * 255);
    weights[i * 4 + 3] = Math.round(fieldWeight * 255);
    fields[i * 4] = heading[i]!;
    fields[i * 4 + 1] = stubble[i]!;
    fields[i * 4 + 2] = ground.baseLayer[i]!;
    fields[i * 4 + 3] = ground.overlayLayer[i]!;
  }
  const texture = (data: Uint8Array<ArrayBuffer>, filter: THREE.MagnificationTextureFilter): THREE.DataTexture => {
    const result = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    result.colorSpace = THREE.NoColorSpace;
    result.magFilter = filter;
    result.minFilter = filter;
    result.generateMipmaps = false;
    result.wrapS = result.wrapT = THREE.ClampToEdgeWrapping;
    result.needsUpdate = true;
    return result;
  };
  return {
    weights: texture(weights, THREE.LinearFilter), fields: texture(fields, THREE.NearestFilter), ground: texture(ground.weights, THREE.LinearFilter),
    minX, minZ, size: cell * size,
  };
}

/**
 * Regional ground weights (R: the region's base layer, G: its overlay, B: cobbles) and, per texel, the surface layer
 * indices of the base and the overlay. Weights reach 0 a few metres before a border shared with another region, so the
 * nearest-sampled indices only change where neither layer shows.
 */
function regionalGround(world: WorldBlueprint, size: number, cell: number):
  { weights: Uint8Array<ArrayBuffer>; baseLayer: Uint8Array; overlayLayer: Uint8Array } {
  const { minX, minZ, maxX, maxZ } = world.bounds;
  const weights = new Uint8Array(size * size * 4);
  const baseLayer = new Uint8Array(size * size), overlayLayer = new Uint8Array(size * size);
  const regions = world.exploration?.regions ?? [];
  // Patch noise on a coarse grid (4 texels), interpolated: two octave sums per grid point instead of per texel.
  let seed = 2166136261;
  for (const c of `korovany2:v3:${world.seed}:ground`) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619);
  const step = 4, grid = Math.ceil(size / step) + 1;
  const patchNoise = new Float32Array(grid * grid), meadowNoise = new Float32Array(grid * grid);
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      const x = minX + c * step * cell, z = minZ + r * step * cell;
      patchNoise[r * grid + c] = fbm(x / 46, z / 46, seed, 3);
      meadowNoise[r * grid + c] = fbm(x / 70 + 31.7, z / 70 - 12.3, seed ^ 0x5bd1e995, 2);
    }
  }
  const sample = (noise: Float32Array, row: number, column: number): number => {
    const fr = row / step, fc = column / step, r0 = Math.floor(fr), c0 = Math.floor(fc), tr = fr - r0, tc = fc - c0;
    const at = (r: number, c: number) => noise[Math.min(grid - 1, r) * grid + Math.min(grid - 1, c)]!;
    const top = at(r0, c0) + (at(r0, c0 + 1) - at(r0, c0)) * tc, bottom = at(r0 + 1, c0) + (at(r0 + 1, c0 + 1) - at(r0 + 1, c0)) * tc;
    return top + (bottom - top) * tr;
  };
  const layer = (name: WorldSurface): number => WORLD_SURFACES.indexOf(name);
  for (const region of regions) {
    const rule = Object.hasOwn(REGION_GROUND, region.id) ? REGION_GROUND[region.id]! : undefined;
    if (!rule) continue;
    const b = region.bounds;
    const c0 = Math.max(0, Math.floor((b.minX - minX) / cell)), c1 = Math.min(size - 1, Math.floor((b.maxX - minX) / cell));
    const r0 = Math.max(0, Math.floor((b.minZ - minZ) / cell)), r1 = Math.min(size - 1, Math.floor((b.maxZ - minZ) / cell));
    // Only borders shared with other regions fade; the world's edge does not.
    const open = (edge: number, bound: number) => (Math.abs(edge - bound) < 1 ? Infinity : 0);
    for (let r = r0; r <= r1; r++) {
      const z = minZ + (r + 0.5) * cell;
      for (let c = c0; c <= c1; c++) {
        const x = minX + (c + 0.5) * cell;
        if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
        const inside = Math.min(x - b.minX + open(b.minX, minX), b.maxX - x + open(b.maxX, maxX),
          z - b.minZ + open(b.minZ, minZ), b.maxZ - z + open(b.maxZ, maxZ));
        const fade = smoothstep(5, 28, inside);
        const i = r * size + c;
        const base = fade * (1 - 0.75 * smoothstep(0.66, 0.74, sample(meadowNoise, r, c)));
        weights[i * 4] = Math.round(base * 255);
        baseLayer[i] = layer(rule.base);
        if (rule.overlay) {
          const patch = smoothstep(rule.patches! - 0.04, rule.patches! + 0.04, sample(patchNoise, r, c));
          weights[i * 4 + 1] = Math.round(fade * patch * 255);
          overlayLayer[i] = layer(rule.overlay);
        }
      }
    }
  }
  for (const place of world.exploration?.locations ?? []) {
    if (!COBBLED_PLACES.has(place.id)) continue;
    const reach = 54;
    const c0 = Math.max(0, Math.floor((place.x - reach - minX) / cell)), c1 = Math.min(size - 1, Math.ceil((place.x + reach - minX) / cell));
    const r0 = Math.max(0, Math.floor((place.z - reach - minZ) / cell)), r1 = Math.min(size - 1, Math.ceil((place.z + reach - minZ) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(minX + (c + 0.5) * cell - place.x, minZ + (r + 0.5) * cell - place.z);
        const i = r * size + c;
        weights[i * 4 + 2] = Math.max(weights[i * 4 + 2]!, Math.round((1 - smoothstep(30, reach, d)) * 255));
      }
    }
  }
  return { weights, baseLayer, overlayLayer };
}
