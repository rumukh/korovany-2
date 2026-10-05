import type { WorldLocation, WorldRegion } from './narrative-types';
import type { BoxShape, Obstacle, Vec2, WorldBlueprint, WorldField } from './types';
import { distance, obstacleClearance, segmentClearance } from './world';

/**
 * Version 3 footprints at the heroic scale standard (a 2.25 m soldier is about 1.28 times a 1.75 m human): `width` is the
 * wall-to-wall depth along the building's local X (its front faces local +X, towards the road), `length` runs along
 * local Z, `height` is the ridge. Presentation models must keep their walls inside these rectangles; eaves may
 * overhang by at most 0.8 m above 3 m.
 */
export const V3_BUILDINGS = {
  'kit-cottage-a': { width: 6.5, length: 10, height: 9 },
  'kit-cottage-b': { width: 6.5, length: 10, height: 9.5 },
  'kit-cottage-c': { width: 7, length: 9, height: 8.5 },
  'kit-longhouse': { width: 8, length: 18, height: 10 },
  'kit-barn': { width: 9, length: 15, height: 11 },
  'kit-shed': { width: 4, length: 5, height: 4.5 },
} as const;
export type V3BuildingModel = keyof typeof V3_BUILDINGS;
export const V3_FENCE = { model: 'kit-fence', thickness: 0.24, height: 1.3 } as const;
/** Small solid props, at their cooked models' sizes: circles use `radius`, boxes `width` x `length`. */
export const V3_PROPS = {
  'prop-haystack': { radius: 1.78, height: 3.2 },
  'prop-barrels': { radius: 1.13, height: 1.4 },
  'prop-scarecrow': { radius: 1.02, height: 2.8 },
  'prop-woodpile': { width: 1.0, length: 3.2, height: 1.25 },
  'prop-hay-cart': { width: 2.3, length: 3.85, height: 1.9 },
} as const;
/** Tree species: trunk collider radius and height ranges (natural sizes; nature is not scaled up). */
export const V3_TREES = {
  'tree-spruce': { variants: 3, radius: [0.4, 0.65], height: [16, 26] },
  'tree-birch': { variants: 2, radius: [0.3, 0.45], height: [12, 18] },
  'tree-deadoak': { variants: 2, radius: [0.5, 0.75], height: [9, 14] },
} as const;
export type V3TreeSpecies = keyof typeof V3_TREES;

/** Military sites keep an open combat yard (their defenders are leashed 19-22 m to them) free of big blockers. */
export const COMBAT_YARD = 32;
/** Every location keeps an open centre for residents, travel arrivals and the 3 m approach. */
export const LOCATION_CLEARING = 12;

interface Segment { a: Vec2; b: Vec2; half: number }

/** Deterministic integer hash noise: identical on every platform (no PRNG sequence, no floating-point trig). */
function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const tx = x - x0, tz = z - z0;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = hash2(x0, z0, seed), b = hash2(x0 + 1, z0, seed), c = hash2(x0, z0 + 1, seed), d = hash2(x0 + 1, z0 + 1, seed);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
}
export function fbm(x: number, z: number, seed: number, octaves = 3): number {
  let total = 0, amplitude = 1, norm = 0, frequency = 1;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(x * frequency, z * frequency, seed + i * 101) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return total / norm;
}
function seedNumber(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h | 0;
}
/** A seeded uniform stream (mulberry32) for one placement purpose. */
function stream(text: string): { next(): number; range(a: number, b: number): number; pick<T>(items: readonly T[]): T } {
  let state = seedNumber(text) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, range: (a, b) => a + (b - a) * next(), pick: items => items[Math.min(items.length - 1, Math.floor(next() * items.length))]! };
}

function box(id: string, x: number, z: number, halfX: number, halfZ: number, heading: number, height: number,
  model: string, variant: number): Obstacle {
  const shape: BoxShape = { kind: 'box', halfX, halfZ, heading };
  return { id, kind: 'wall', x, z, radius: Math.hypot(halfX, halfZ), height, variant, shape, model };
}

function corners(o: Obstacle): Vec2[] {
  if (!o.shape) return [];
  const c = Math.cos(o.shape.heading), s = Math.sin(o.shape.heading);
  // Local X maps to (cos h, -sin h) and local Z to (sin h, cos h).
  return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => {
    const lx = sx! * o.shape!.halfX, lz = sz! * o.shape!.halfZ;
    return { x: o.x + lx * c + lz * s, z: o.z - lx * s + lz * c };
  });
}

/** True when two solid shapes come closer than `margin` (exact for circles; separating axes for two rectangles). */
function shapesOverlap(a: Obstacle, b: Obstacle, margin: number): boolean {
  if (!a.shape && !b.shape) return distance(a, b) < a.radius + b.radius + margin;
  if (!a.shape) return obstacleClearance(b, a) < a.radius + margin;
  if (!b.shape) return obstacleClearance(a, b) < b.radius + margin;
  const axes = [a.shape.heading, b.shape.heading].flatMap(h => [{ x: Math.cos(h), z: -Math.sin(h) }, { x: Math.sin(h), z: Math.cos(h) }]);
  const ca = corners(a), cb = corners(b);
  for (const axis of axes) {
    const project = (points: Vec2[]): [number, number] => {
      let min = Infinity, max = -Infinity;
      for (const p of points) { const v = p.x * axis.x + p.z * axis.z; min = Math.min(min, v); max = Math.max(max, v); }
      return [min, max];
    };
    const [a0, a1] = project(ca), [b0, b1] = project(cb);
    if (a1 + margin <= b0 || b1 + margin <= a0) return false;
  }
  return true;
}

/** Spatial hash used only while generating (the runtime broadphase is world.ts's grid). */
class Placement {
  private readonly cells = new Map<string, Obstacle[]>();
  constructor(readonly world: WorldBlueprint, readonly roads: Segment[], private readonly cell = 12) {
    for (const o of world.obstacles) this.index(o);
  }
  private index(o: Obstacle): void {
    const r = o.radius;
    for (let x = Math.floor((o.x - r) / this.cell); x <= Math.floor((o.x + r) / this.cell); x++) {
      for (let z = Math.floor((o.z - r) / this.cell); z <= Math.floor((o.z + r) / this.cell); z++) {
        const key = `${x}:${z}`;
        const list = this.cells.get(key);
        if (list) list.push(o); else this.cells.set(key, [o]);
      }
    }
  }
  near(p: Vec2, reach: number): Obstacle[] {
    const found = new Set<Obstacle>();
    for (let x = Math.floor((p.x - reach) / this.cell); x <= Math.floor((p.x + reach) / this.cell); x++) {
      for (let z = Math.floor((p.z - reach) / this.cell); z <= Math.floor((p.z + reach) / this.cell); z++) {
        for (const o of this.cells.get(`${x}:${z}`) ?? []) found.add(o);
      }
    }
    return [...found];
  }
  add(o: Obstacle): void {
    this.world.obstacles.push(o);
    this.index(o);
  }
  /** Fenced yards: trees and rocks (a positive structure margin) stay out of them. */
  readonly yards: WorldField[] = [];
  keepOut(o: Obstacle, margin: number): boolean {
    if (margin <= 0) return false;
    return this.yards.some(f => {
      const dx = o.x - f.x, dz = o.z - f.z, c = Math.cos(f.heading), s = Math.sin(f.heading);
      return Math.abs(dx * c - dz * s) < f.halfX + o.radius + 1 && Math.abs(dx * s + dz * c) < f.halfZ + o.radius + 1;
    });
  }
  /** Distance from an obstacle's solid shape to the nearest road surface (centreline minus half width). */
  roadClearance(o: Obstacle): number {
    let best = Infinity;
    for (const road of this.roads) best = Math.min(best, segmentClearance(o, road.a, road.b) - road.half);
    return best;
  }
}

function riverClear(world: WorldBlueprint, o: Obstacle, margin: number): boolean {
  const points = o.shape ? corners(o) : [{ x: o.x, z: o.z - o.radius }, { x: o.x, z: o.z + o.radius }];
  const minZ = Math.min(...points.map(p => p.z)), maxZ = Math.max(...points.map(p => p.z));
  return maxZ < world.river.minZ - margin || minZ > world.river.maxZ + margin;
}

function insideBounds(world: WorldBlueprint, o: Obstacle, margin: number): boolean {
  const points = o.shape ? corners(o) : [{ x: o.x - o.radius, z: o.z - o.radius }, { x: o.x + o.radius, z: o.z + o.radius }];
  return points.every(p => p.x > world.bounds.minX + margin && p.x < world.bounds.maxX - margin
    && p.z > world.bounds.minZ + margin && p.z < world.bounds.maxZ - margin);
}

/** Clearances in metres: to road surfaces, other locations' centres, military sites' edges, other obstacles, and the
 * extra margin trees and rocks keep from buildings and fences so crowns do not cut through roofs. */
interface Rules { road: number; location: number; site: number; obstacle: number; structure?: number }
/** Locations that become combat arenas in some campaign (the villain's royal-citadel fortress). */
const COMBAT_LOCATIONS = new Set(['palace-citadel']);

function fits(place: Placement, o: Obstacle, rules: Rules, own?: WorldLocation): boolean {
  const world = place.world;
  if (!insideBounds(world, o, 6) || !riverClear(world, o, 3)) return false;
  if (place.roadClearance(o) < rules.road) return false;
  for (const location of world.exploration!.locations) {
    const clearing = location === own ? LOCATION_CLEARING : Math.max(LOCATION_CLEARING, rules.location,
      COMBAT_LOCATIONS.has(location.id) ? COMBAT_YARD : 0);
    if (obstacleClearance(o, location) < clearing) return false;
  }
  if (place.keepOut(o, rules.structure ?? 0)) return false;
  for (const site of world.sites) {
    if (site.kind === 'home') continue;
    if (obstacleClearance(o, site) < site.radius + rules.site) return false;
  }
  for (const other of place.near(o, o.radius + rules.obstacle + (rules.structure ?? 0) + 8)) {
    if (shapesOverlap(o, other, rules.obstacle + (other.shape ? rules.structure ?? 0 : 0))) return false;
  }
  return true;
}

function roadSegments(world: WorldBlueprint): Segment[] {
  const node = (id: string) => world.roads.nodes.find(n => n.id === id)!;
  return world.roads.edges.map(edge => ({ a: node(edge.from), b: node(edge.to), half: edge.width / 2 }));
}

/** Unit directions of the roads that leave a location, with the free length to the next node. */
function roadsFrom(world: WorldBlueprint, place: WorldLocation): { dir: Vec2; length: number }[] {
  const result: { dir: Vec2; length: number }[] = [];
  for (const edge of world.roads.edges) {
    const other = edge.from === place.id ? edge.to : edge.to === place.id ? edge.from : null;
    if (!other) continue;
    const node = world.roads.nodes.find(n => n.id === other)!;
    const length = distance(node, place);
    result.push({ dir: { x: (node.x - place.x) / length, z: (node.z - place.z) / length }, length });
  }
  return result;
}

const BUILDING_RULES: Rules = { road: 3, location: 26, site: COMBAT_YARD, obstacle: 3 };
const FENCE_RULES: Rules = { road: 1.5, location: 18, site: COMBAT_YARD, obstacle: 0.4 };
const PROP_RULES: Rules = { road: 1.5, location: 18, site: COMBAT_YARD, obstacle: 0.8 };

function settlementPlan(place: WorldLocation): { count: number; weights: [V3BuildingModel, number][] } {
  if (place.kind === 'inn') {
    return { count: 4, weights: [['kit-longhouse', 3], ['kit-barn', 2], ['kit-shed', 2], ['kit-cottage-c', 1]] };
  }
  return {
    count: place.id === 'greenhollow' ? 16 : 11,
    weights: [['kit-cottage-a', 4], ['kit-cottage-b', 4], ['kit-cottage-c', 3], ['kit-longhouse', 2], ['kit-barn', 2], ['kit-shed', 2]],
  };
}

function weighted<T>(random: ReturnType<typeof stream>, weights: readonly (readonly [T, number])[]): T {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random.next() * total;
  for (const [item, weight] of weights) { roll -= weight; if (roll < 0) return item; }
  return weights[weights.length - 1]![0];
}

/** Houses face the road in rows on both sides, each with a fenced yard behind it, then strip fields beyond. */
function layoutSettlement(place: Placement, location: WorldLocation, seed: string): void {
  const world = place.world;
  const random = stream(`korovany2:v3:${seed}:${location.id}:layout`);
  const plan = settlementPlan(location);
  const ways = roadsFrom(world, location);
  let built = 0, serial = 0;
  const lots: { dir: Vec2; side: number; end: number }[] = [];
  for (const way of ways) for (const side of [-1, 1]) lots.push({ dir: way.dir, side, end: Math.min(way.length - 20, 95) });
  const cursors = lots.map(() => 14 + random.range(0, 4));
  for (let round = 0; round < 8 && built < plan.count; round++) {
    for (let lot = 0; lot < lots.length && built < plan.count; lot++) {
      const { dir, side, end } = lots[lot]!;
      for (let attempt = 0; attempt < 3; attempt++) {
        const model = weighted(random, plan.weights);
        const size = V3_BUILDINGS[model];
        const along = cursors[lot]! + size.length / 2;
        if (along + size.length / 2 > end) break;
        const perp = { x: dir.z * side, z: -dir.x * side };
        const setback = 4 + 3 + random.range(0, 2.5) + size.width / 2;
        const x = location.x + dir.x * along + perp.x * setback, z = location.z + dir.z * along + perp.z * setback;
        // The front (local +X) faces the road: (cos h, -sin h) = -perp.
        const heading = Math.atan2(perp.z, -perp.x) + random.range(-0.06, 0.06);
        const building = box(`${location.id}-house-${serial}`, x, z, size.width / 2, size.length / 2, heading, size.height,
          model, Math.floor(random.next() * 4));
        serial++;
        if (!fits(place, building, BUILDING_RULES, location)) { cursors[lot]! += 4; continue; }
        place.add(building);
        cursors[lot]! += size.length + random.range(4, 8);
        built++;
        yard(place, building, location, random);
        break;
      }
    }
  }
  if (built < Math.min(plan.count, 3)) throw new Error(`Cannot lay out the v3 settlement at ${location.id}`);
  fields(place, location, lots.map((lot, index) => ({ ...lot, start: cursors[index]! + 6 })), random);
}

/** A pale-fenced back yard (with a gate gap) and a woodpile against a gable wall. */
function yard(place: Placement, building: Obstacle, location: WorldLocation, random: ReturnType<typeof stream>): void {
  const shape = building.shape!;
  const depth = random.range(6, 10);
  const c = Math.cos(shape.heading), s = Math.sin(shape.heading);
  const localToWorld = (lx: number, lz: number): Vec2 => ({ x: building.x + lx * c + lz * s, z: building.z - lx * s + lz * c });
  const back = -shape.halfX - depth;
  const t = V3_FENCE.thickness / 2;
  const id = building.id.replace('-house-', '-yard-');
  const pieces: Obstacle[] = [];
  const backCentre = localToWorld(back, 0);
  pieces.push(box(`${id}-back`, backCentre.x, backCentre.z, t, shape.halfZ + 0.6, shape.heading, V3_FENCE.height, V3_FENCE.model, 0));
  const gate = 2.6;
  for (const end of [-1, 1]) {
    const gap = end === 1 ? gate : 0;
    const from = -shape.halfX - 0.5, to = back + 0.5;
    const length = from - to - gap;
    if (length < 1) continue;
    const mid = localToWorld(to + length / 2, end * (shape.halfZ + 0.6));
    pieces.push(box(`${id}-side-${end === 1 ? 'b' : 'a'}`, mid.x, mid.z, length / 2, t, shape.heading, V3_FENCE.height, V3_FENCE.model, 1));
  }
  if (!pieces.every(piece => fits(place, piece, FENCE_RULES, location))) return;
  for (const piece of pieces) place.add(piece);
  const centre = localToWorld(-shape.halfX - depth / 2, 0);
  place.yards.push({ id, x: centre.x, z: centre.z, halfX: depth / 2, halfZ: shape.halfZ + 0.6, heading: shape.heading, crop: 'stubble' });
  const gable = random.next() < 0.5 ? -1 : 1;
  const pile = localToWorld(-shape.halfX + 1.4, gable * (shape.halfZ + 2.0));
  const woodpile = box(`${id}-woodpile`, pile.x, pile.z, V3_PROPS['prop-woodpile'].width / 2, V3_PROPS['prop-woodpile'].length / 2,
    shape.heading + Math.PI / 2, V3_PROPS['prop-woodpile'].height, 'prop-woodpile', 0);
  if (fits(place, woodpile, PROP_RULES, location)) place.add(woodpile);
  if (random.next() < 0.45) {
    const at = localToWorld(shape.halfX + 2.0, -gable * (shape.halfZ - 1.2));
    const barrels: Obstacle = { id: `${id}-barrels`, kind: 'wall', x: at.x, z: at.z, radius: V3_PROPS['prop-barrels'].radius,
      height: V3_PROPS['prop-barrels'].height, variant: 0, model: 'prop-barrels' };
    if (fits(place, barrels, PROP_RULES, location)) place.add(barrels);
  }
}

/** Open strip fields (no collision) beyond the houses, with haystacks, a scarecrow and a hay cart. */
function fields(place: Placement, location: WorldLocation, lots: { dir: Vec2; side: number; end: number; start: number }[],
  random: ReturnType<typeof stream>): void {
  const world = place.world;
  let serial = 0;
  for (const lot of lots) {
    const perp = { x: lot.dir.z * lot.side, z: -lot.dir.x * lot.side };
    const length = random.range(34, 52);
    const heading = Math.atan2(perp.x, perp.z);
    let along = Math.max(lot.start, 40);
    for (let strip = 0; strip < 4 && along + 12 < lot.end + 25; strip++) {
      const width = random.range(9, 13);
      const setback = 4 + 6 + length / 2;
      const x = location.x + lot.dir.x * (along + width / 2) + perp.x * setback;
      const z = location.z + lot.dir.z * (along + width / 2) + perp.z * setback;
      along += width + 1.6;
      const probe = box('field-probe', x, z, width / 2, length / 2, heading, 0, '', 0);
      if (!fits(place, probe, { road: 1, location: 20, site: COMBAT_YARD, obstacle: 2 }, location)) continue;
      const field: WorldField = { id: `${location.id}-field-${serial++}`, x, z, halfX: width / 2, halfZ: length / 2, heading,
        crop: random.next() < 0.6 ? 'stubble' : 'furrow' };
      world.fields!.push(field);
      if (field.crop === 'stubble') {
        for (let stack = 0; stack < 3; stack++) {
          if (random.next() < 0.45) continue;
          const t = random.range(-0.7, 0.7) * field.halfZ, u = random.range(-0.5, 0.5) * field.halfX;
          const c = Math.cos(heading), s = Math.sin(heading);
          const hay: Obstacle = { id: `${field.id}-hay-${stack}`, kind: 'wall', x: x + u * c + t * s, z: z - u * s + t * c,
            radius: V3_PROPS['prop-haystack'].radius, height: V3_PROPS['prop-haystack'].height, variant: stack, model: 'prop-haystack' };
          if (fits(place, hay, PROP_RULES, location)) place.add(hay);
        }
      } else if (random.next() < 0.5) {
        const scarecrow: Obstacle = { id: `${field.id}-scarecrow`, kind: 'wall', x, z, radius: V3_PROPS['prop-scarecrow'].radius,
          height: V3_PROPS['prop-scarecrow'].height, variant: 0, model: 'prop-scarecrow' };
        if (fits(place, scarecrow, PROP_RULES, location)) place.add(scarecrow);
      }
    }
  }
  if (location.kind === 'settlement' && lots.length) {
    const lot = lots[0]!;
    const perp = { x: lot.dir.z * lot.side, z: -lot.dir.x * lot.side };
    const at = { x: location.x + lot.dir.x * 17 - perp.x * 7.5, z: location.z + lot.dir.z * 17 - perp.z * 7.5 };
    const cart = box(`${location.id}-hay-cart`, at.x, at.z, V3_PROPS['prop-hay-cart'].width / 2, V3_PROPS['prop-hay-cart'].length / 2,
      Math.atan2(lot.dir.x, lot.dir.z) + 0.4, V3_PROPS['prop-hay-cart'].height, 'prop-hay-cart', 0);
    if (fits(place, cart, PROP_RULES, location)) place.add(cart);
  }
}

interface Woodland { density: number; spacing: number; species: [V3TreeSpecies, number][]; scale: number }

/** Forest character per region: noise above `1 - density` is woodland, at `spacing` metres between trunks. */
const WOODLAND: Readonly<Record<string, Woodland>> = {
  heartlands: { density: 0.22, spacing: 7, species: [['tree-birch', 3], ['tree-deadoak', 2], ['tree-spruce', 1]], scale: 0.012 },
  greenmarch: { density: 0.62, spacing: 4.6, species: [['tree-spruce', 5], ['tree-birch', 3], ['tree-deadoak', 2]], scale: 0.009 },
  fenlands: { density: 0.38, spacing: 6, species: [['tree-birch', 5], ['tree-deadoak', 3], ['tree-spruce', 2]], scale: 0.011 },
  saltcoast: { density: 0.1, spacing: 10, species: [['tree-deadoak', 2], ['tree-birch', 1]], scale: 0.013 },
  ashsteppe: { density: 0.08, spacing: 14, species: [['tree-deadoak', 1]], scale: 0.013 },
  crownlands: { density: 0.2, spacing: 8, species: [['tree-birch', 2], ['tree-spruce', 2], ['tree-deadoak', 1]], scale: 0.012 },
  frostspine: { density: 0.3, spacing: 8, species: [['tree-spruce', 4], ['tree-deadoak', 1]], scale: 0.011 },
  hollowvale: { density: 0.66, spacing: 4.2, species: [['tree-spruce', 6], ['tree-deadoak', 2], ['tree-birch', 1]], scale: 0.009 },
};
const MAX_TREES = 9000;

function regionAt(world: WorldBlueprint, p: Vec2): WorldRegion | undefined {
  return world.exploration!.regions.find(r => p.x >= r.bounds.minX && p.x <= r.bounds.maxX && p.z >= r.bounds.minZ && p.z <= r.bounds.maxZ);
}

function insideField(world: WorldBlueprint, p: Vec2, margin: number): boolean {
  return world.fields!.some(f => {
    const dx = p.x - f.x, dz = p.z - f.z, c = Math.cos(f.heading), s = Math.sin(f.heading);
    return Math.abs(dx * c - dz * s) < f.halfX + margin && Math.abs(dx * s + dz * c) < f.halfZ + margin;
  });
}

/** Jittered-grid woodland: dense dark forest where regional noise is high, open woodland elsewhere. */
function vegetation(place: Placement, seed: string): void {
  const world = place.world;
  const random = stream(`korovany2:v3:${seed}:trees`);
  const noiseSeed = seedNumber(`korovany2:v3:${seed}:forest`);
  const trees: Obstacle[] = [];
  const cell = 4;
  const rules: Rules = { road: 2.5, location: 26, site: 24, obstacle: 2.2, structure: 3 };
  for (let gz = world.bounds.minZ + cell; gz < world.bounds.maxZ - cell && trees.length < MAX_TREES; gz += cell) {
    for (let gx = world.bounds.minX + cell; gx < world.bounds.maxX - cell && trees.length < MAX_TREES; gx += cell) {
      const p = { x: gx + random.range(-1.8, 1.8), z: gz + random.range(-1.8, 1.8) };
      const region = regionAt(world, p);
      const woods = WOODLAND[region?.id ?? 'heartlands']!;
      const noise = fbm(p.x * woods.scale, p.z * woods.scale, noiseSeed, 4);
      const threshold = 1 - woods.density;
      if (noise < threshold) continue;
      const depth = Math.min(1, (noise - threshold) / 0.18);
      // Dense cores keep the regional spacing; margins thin out to scattered trees.
      const spacing = woods.spacing / (0.35 + 0.65 * depth);
      if (random.next() > (cell * cell) / (spacing * spacing)) continue;
      if (insideField(world, p, 2)) continue;
      const species = weighted(random, woods.species);
      const spec = V3_TREES[species];
      const t = random.next();
      const radius = spec.radius[0] + (spec.radius[1] - spec.radius[0]) * t;
      const height = spec.height[0] + (spec.height[1] - spec.height[0]) * (0.6 * t + 0.4 * random.next());
      const variant = Math.floor(random.next() * spec.variants);
      const tree: Obstacle = { id: `tree-${trees.length}`, kind: 'tree', x: p.x, z: p.z, radius, height, variant, model: species };
      if (!fits(place, tree, rules)) continue;
      place.add(tree);
      trees.push(tree);
    }
  }
}

/** Scattered boulders, partly buried; more and larger in Frostspine and the Ash Steppe. */
function boulders(place: Placement, seed: string): void {
  const world = place.world;
  const random = stream(`korovany2:v3:${seed}:rocks`);
  const rules: Rules = { road: 2, location: 24, site: 22, obstacle: 1.5, structure: 1.5 };
  let placed = 0;
  for (let attempt = 0; attempt < 2400 && placed < 700; attempt++) {
    const p = { x: random.range(-478, 478), z: random.range(-478, 478) };
    const region = regionAt(world, p);
    const rocky = region?.biome === 'mountains' ? 1 : region?.biome === 'waste' ? 0.7 : region?.biome === 'coast' ? 0.45 : 0.25;
    if (random.next() > rocky) continue;
    const big = region?.biome === 'mountains' ? 4 : 2.6;
    const radius = random.range(0.8, big);
    const rock: Obstacle = { id: `rock-${placed}`, kind: 'rock', x: p.x, z: p.z, radius,
      height: radius * random.range(0.7, 1.3), variant: Math.floor(random.next() * 4), model: 'rock-boulder' };
    if (insideField(world, p, 2) || !fits(place, rock, rules)) continue;
    place.add(rock);
    placed++;
  }
}

/**
 * Version 3: the v2 geography, regions, locations, roads, river, bridges, sites and story stay; every settlement and
 * inn is rebuilt at the heroic scale with yards and fields, woodland becomes real forest, and boulders replace the
 * upright blobs. Ruins, shrines, landmarks, the Old Fort and the military posts keep their v2 structures until W2.
 */
export function buildWorldV3(world: WorldBlueprint): WorldBlueprint {
  const locations = world.exploration!.locations;
  const rebuilt = new Set(locations.filter(l => (l.kind === 'settlement' || l.kind === 'inn') && l.id !== 'old-fort').map(l => l.id));
  world.version = 3;
  world.id = '';
  world.fields = [];
  world.obstacles = world.obstacles.filter(o => {
    if (o.kind !== 'wall') return false;
    // The original home's walls have no home in story worlds (homes move to each faction's location).
    if (o.id.startsWith('home-wall-')) return false;
    const owner = locations.find(l => o.id.startsWith(`${l.id}-building-`));
    return !owner || !rebuilt.has(owner.id);
  });
  const place = new Placement(world, roadSegments(world));
  for (const location of locations) if (rebuilt.has(location.id)) layoutSettlement(place, location, world.seed);
  vegetation(place, world.seed);
  boulders(place, world.seed);
  let hash = 2166136261;
  for (const c of JSON.stringify(world)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  world.id = `k2-v3-${(hash >>> 0).toString(16)}`;
  return world;
}


