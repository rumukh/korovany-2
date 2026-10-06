import type { Vec2, WorldBlueprint } from '../game/types';
import { MONSTER_RULES } from '../game/monsters';
import { lakeBounds, lakeClearance } from '../game/world';
import { fbm } from '../game/world-v3';

/**
 * Presentation-only ground relief for version 3 worlds. Collision stays the flat authoritative X/Z plane; this only
 * lifts what is drawn. Version 1 and 2 worlds are exactly flat (height 0 everywhere), so their rendering is unchanged.
 *
 * Relief is regional value-noise hills, limited by a 10 degree cone that rises from the ground that must stay level:
 * road corridors and their shoulders, the river banks, lakes and the sea with a 6 m bank, location clearings, every v3
 * footprint and field, the combat zones (military sites and homes, the villain's citadel arena) and the monster lairs'
 * hunting grounds. Roads, sites, the bridge decks, every shore and every fight stand on level ground; elsewhere the
 * walkable slope stays at most about 12 degrees.
 */
const CELL = 4;
/** Peak hill amplitude in metres per region. With NOISE_SCALE this bounds the relief's own slope to about 9 degrees. */
const RELIEF: Readonly<Record<string, { amplitude: number }>> = {
  heartlands: { amplitude: 3.2 },
  greenmarch: { amplitude: 4.5 },
  fenlands: { amplitude: 1.2 },
  saltcoast: { amplitude: 2.4 },
  ashsteppe: { amplitude: 3.6 },
  crownlands: { amplitude: 3.2 },
  frostspine: { amplitude: 6.5 },
  hollowvale: { amplitude: 5.2 },
};
/** One noise frequency for the whole map: hills about 190 m across. */
const NOISE_SCALE = 1 / 190;
/** Combat zones: no relief within this distance of a military site's edge, a home or the citadel arena. */
export const COMBAT_FLAT = 30;
/** Level ground round every lake and the sea, in metres beyond the shore. */
export const LAKE_BANK = 6;
/** Level ground round every monster lair: its pack's whole hunting ground (the leash plus a margin). */
export const LAIR_FLAT = MONSTER_RULES.leash + 5;
/** Relief rises from level ground no faster than this (a cone limit), so ramps never exceed the walkable slope. */
const MAX_RISE = Math.tan(10 * Math.PI / 180);
/** Distances beyond this do not matter: the highest hill is lower than MAX_RISE * FAR. */
const FAR = 90;

export interface Terrain {
  /** Ground height in metres at a world point; 0 for v1/v2 worlds. */
  height(x: number, z: number): number;
  /** Unit surface normal at a world point. */
  normal(x: number, z: number): { x: number; y: number; z: number };
  /** Slope in radians at a world point. */
  slope(x: number, z: number): number;
  readonly flat: boolean;
}

const FLAT: Terrain = {
  height: () => 0,
  normal: () => ({ x: 0, y: 1, z: 0 }),
  slope: () => 0,
  flat: true,
};

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

function seedNumber(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h | 0;
}

/**
 * Distance in metres from every CELL-metre grid point to the nearest ground that must stay level (0 inside it), capped
 * at FAR: road corridors with 3 m shoulders, river banks, lakes with their banks, location clearings, combat zones,
 * footprints, fields and the lairs' hunting grounds.
 */
function levelDistance(world: WorldBlueprint): { grid: Float32Array; columns: number; rows: number } {
  const { minX, minZ, maxX, maxZ } = world.bounds;
  const columns = Math.ceil((maxX - minX) / CELL) + 1, rows = Math.ceil((maxZ - minZ) / CELL) + 1;
  const grid = new Float32Array(columns * rows).fill(FAR);
  const apply = (x0: number, z0: number, x1: number, z1: number, value: (p: Vec2) => number): void => {
    const c0 = Math.max(0, Math.floor((x0 - minX) / CELL)), c1 = Math.min(columns - 1, Math.ceil((x1 - minX) / CELL));
    const r0 = Math.max(0, Math.floor((z0 - minZ) / CELL)), r1 = Math.min(rows - 1, Math.ceil((z1 - minZ) / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const index = r * columns + c;
        const v = value({ x: minX + c * CELL, z: minZ + r * CELL });
        if (v < grid[index]!) grid[index] = v;
      }
    }
  };
  const around = (cx: number, cz: number, inner: number): void =>
    apply(cx - inner - FAR, cz - inner - FAR, cx + inner + FAR, cz + inner + FAR, p => Math.max(0, Math.hypot(p.x - cx, p.z - cz) - inner));
  const node = (id: string) => world.roads.nodes.find(n => n.id === id)!;
  for (const edge of world.roads.edges) {
    const a = node(edge.from), b = node(edge.to), inner = edge.width / 2 + 3;
    apply(Math.min(a.x, b.x) - inner - FAR, Math.min(a.z, b.z) - inner - FAR, Math.max(a.x, b.x) + inner + FAR,
      Math.max(a.z, b.z) + inner + FAR, p => Math.max(0, segmentDistance(p, a, b) - inner));
  }
  const river = world.river;
  apply(river.minX, river.minZ - 14 - FAR, river.maxX, river.maxZ + 14 + FAR,
    p => Math.max(0, Math.max(river.minZ - p.z, p.z - river.maxZ) - 14));
  for (const site of world.sites) around(site.x, site.z, site.radius + COMBAT_FLAT);
  for (const place of world.exploration?.locations ?? []) {
    // The villain's citadel is a fortress arena; every other clearing keeps its radius plus 6 m level.
    around(place.x, place.z, place.id === 'palace-citadel' ? place.radius + COMBAT_FLAT : place.radius + 6);
  }
  for (const o of world.obstacles) if (o.kind === 'wall') around(o.x, o.z, o.radius + 3);
  for (const field of world.fields ?? []) around(field.x, field.z, Math.hypot(field.halfX, field.halfZ));
  for (const lake of world.lakes ?? []) {
    // Water lies level, with a level bank round it; the drawn ground carves the bed below the water plane.
    const box = lakeBounds(lake), reach = LAKE_BANK + FAR;
    apply(box.minX - reach, box.minZ - reach, box.maxX + reach, box.maxZ + reach, p => Math.max(0, lakeClearance(lake, p) - LAKE_BANK));
  }
  for (const lair of world.lairs ?? []) around(lair.x, lair.z, LAIR_FLAT);
  return { grid, columns, rows };
}

/** Polynomial smooth minimum with a blend width of `k` metres (removes the cone limit's crease). */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

const terrains = new Map<string, Terrain>();

/** The terrain of a world, cached by world id; exactly flat for v1/v2. */
export function terrainFor(world: WorldBlueprint): Terrain {
  if (world.version !== 3 || !world.exploration) return FLAT;
  const cached = world.id ? terrains.get(world.id) : undefined;
  if (cached) return cached;
  const { minX, minZ } = world.bounds;
  const { grid, columns, rows } = levelDistance(world);
  const seed = seedNumber(`korovany2:v3:${world.seed}:relief`);
  const regions = world.exploration.regions;
  const regionAmplitude = (x: number, z: number): number => {
    const region = regions.find(r => x >= r.bounds.minX && x <= r.bounds.maxX && z >= r.bounds.minZ && z <= r.bounds.maxZ);
    return (RELIEF[region?.id ?? 'heartlands'] ?? RELIEF.heartlands!).amplitude;
  };
  // Region amplitudes box-filtered over 80 m on a 20 m grid, then interpolated: continuous across borders.
  const AMP_CELL = 20;
  const ampColumns = Math.ceil((world.bounds.maxX - minX) / AMP_CELL) + 1, ampRows = Math.ceil((world.bounds.maxZ - minZ) / AMP_CELL) + 1;
  const amplitudes = new Float32Array(ampColumns * ampRows);
  for (let r = 0; r < ampRows; r++) {
    for (let c = 0; c < ampColumns; c++) {
      let sum = 0, count = 0;
      for (let dz = -40; dz <= 40; dz += 10) for (let dx = -40; dx <= 40; dx += 10) {
        sum += regionAmplitude(minX + c * AMP_CELL + dx, minZ + r * AMP_CELL + dz);
        count++;
      }
      amplitudes[r * ampColumns + c] = sum / count;
    }
  }
  const amplitudeAt = (x: number, z: number): number => {
    const fx = Math.min(ampColumns - 1.0001, Math.max(0, (x - minX) / AMP_CELL)), fz = Math.min(ampRows - 1.0001, Math.max(0, (z - minZ) / AMP_CELL));
    const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
    const at = (cc: number, rr: number) => amplitudes[rr * ampColumns + cc]!;
    const top = at(c, r) + (at(c + 1, r) - at(c, r)) * tx;
    const bottom = at(c, r + 1) + (at(c + 1, r + 1) - at(c, r + 1)) * tx;
    return top + (bottom - top) * tz;
  };
  const relief = (x: number, z: number): number => {
    // One global noise frequency; only the amplitude varies by region, smoothly (see amplitudeAt), so borders never
    // form cliffs or warp the noise.
    return (fbm(x * NOISE_SCALE, z * NOISE_SCALE, seed, 3) - 0.35) * amplitudeAt(x, z) * 2;
  };
  const levelDistanceAt = (x: number, z: number): number => {
    const fx = Math.min(columns - 1.0001, Math.max(0, (x - minX) / CELL)), fz = Math.min(rows - 1.0001, Math.max(0, (z - minZ) / CELL));
    const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
    const at = (cc: number, rr: number) => grid[rr * columns + cc]!;
    const top = at(c, r) + (at(c + 1, r) - at(c, r)) * tx;
    const bottom = at(c, r + 1) + (at(c + 1, r + 1) - at(c, r + 1)) * tx;
    // Bilinear interpolation of a distance field can overshoot by up to a cell diagonal near a level zone's edge.
    return Math.max(0, top + (bottom - top) * tz - CELL * 1.5);
  };
  const height = (x: number, z: number): number => {
    const limit = levelDistanceAt(x, z) * MAX_RISE;
    if (limit <= 0) return 0;
    // Relief never drops below the level ground it meets (no trenches) and rises from it along a 10 degree cone.
    return Math.max(0, smoothMin(Math.max(0, relief(x, z)), limit, 1.5));
  };
  const normal = (x: number, z: number): { x: number; y: number; z: number } => {
    const e = 0.75;
    const dx = (height(x + e, z) - height(x - e, z)) / (2 * e), dz = (height(x, z + e) - height(x, z - e)) / (2 * e);
    const length = Math.hypot(dx, 1, dz);
    return { x: -dx / length, y: 1 / length, z: -dz / length };
  };
  const terrain: Terrain = { height, normal, slope: (x, z) => Math.acos(Math.min(1, normal(x, z).y)), flat: false };
  if (world.id) {
    if (terrains.size >= 4) terrains.delete(terrains.keys().next().value!);
    terrains.set(world.id, terrain);
  }
  return terrain;
}
