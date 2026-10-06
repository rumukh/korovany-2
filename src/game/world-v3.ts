import type { WorldLocation, WorldRegion } from './narrative-types';
import type { BoxShape, MonsterSpecies, Obstacle, Vec2, WorldBlueprint, WorldField, WorldLair, WorldLake } from './types';
import { distance, lakeBounds, lakeClearance, obstacleClearance, projectSegment, segmentClearance } from './world';

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
  'kit-stonehouse': { width: 7, length: 10, height: 9 },
  'kit-brickhouse': { width: 7.5, length: 11, height: 9 },
  'kit-townhouse-a': { width: 7.5, length: 11, height: 14 },
  'kit-townhouse-b': { width: 10.5, length: 7.5, height: 13.5 },
  'kit-inn': { width: 10, length: 20, height: 14.5 },
  'kit-stable': { width: 6, length: 14, height: 6.5 },
  'kit-chapel': { width: 8.6, length: 22, height: 22.5 },
  'kit-chapel-fen': { width: 7.5, length: 18, height: 15.5 },
  'kit-smithy': { width: 8, length: 10, height: 8.5 },
  'kit-watchtower': { width: 5, length: 5, height: 15 },
  'kit-stall': { width: 2.6, length: 4, height: 3.3 },
  'kit-stilthut': { width: 6.5, length: 8, height: 8 },
  'kit-saltshed': { width: 7, length: 14, height: 9 },
  'kit-boathut': { width: 6, length: 12, height: 5 },
  'kit-kiln': { width: 6.5, length: 6.5, height: 11.5 },
  /** One 2 m module of dry-stone yard wall: wall runs repeat it along their length, like the fence. */
  'kit-wall': { width: 0.6, length: 2, height: 1.95 },
  /** W2 castles and ruins. One 6 m module of curtain wall (an 11.4 m wall-walk between crenellated parapets) and its
   * ruined variant: curtain runs repeat them along their length. */
  'kit-curtain': { width: 3.5, length: 6, height: 14 },
  'kit-curtain-ruin': { width: 3.5, length: 6, height: 9 },
  'kit-tower-round': { width: 9, length: 9, height: 30.5 },
  'kit-tower-square': { width: 8, length: 8, height: 24.5 },
  'kit-tower-ruin': { width: 9, length: 9, height: 15 },
  'kit-keep': { width: 15, length: 15, height: 35 },
  'kit-ruin-chapel': { width: 9, length: 20, height: 10 },
  'kit-ruin-house': { width: 7, length: 10, height: 7 },
  /** The military posts' timber watch towers, standing on the posts' original circular footings. */
  'kit-camp-tower': { width: 3.6, length: 3.6, height: 9.5 },
  /** W3 crags (build_nature_w3.py): fixed-size rock formations in three styles (moss, snow, bare) of four shapes, each
   * colliding as the circle of its scree talus. They form the mountain ring at the world's edge and the massifs. */
  'rock-crag-moss-a': { width: 18.65, length: 18.65, height: 22.85 },
  'rock-crag-moss-b': { width: 26.15, length: 26.15, height: 15.8 },
  'rock-crag-moss-c': { width: 28.75, length: 28.75, height: 11.3 },
  'rock-crag-moss-d': { width: 19.4, length: 19.4, height: 29.15 },
  'rock-crag-snow-a': { width: 18.7, length: 18.7, height: 23.4 },
  'rock-crag-snow-b': { width: 26.95, length: 26.95, height: 15.7 },
  'rock-crag-snow-c': { width: 29.15, length: 29.15, height: 12.2 },
  'rock-crag-snow-d': { width: 20.2, length: 20.2, height: 29.75 },
  'rock-crag-bare-a': { width: 17.9, length: 17.9, height: 22.45 },
  'rock-crag-bare-b': { width: 26.5, length: 26.5, height: 15.7 },
  'rock-crag-bare-c': { width: 28, length: 28, height: 11.55 },
  'rock-crag-bare-d': { width: 18.55, length: 18.55, height: 27.3 },
} as const;
export type V3BuildingModel = keyof typeof V3_BUILDINGS;
export type CragStyle = 'moss' | 'snow' | 'bare';
/** The crag models of a style, in shape order (a, b: spire and broad crag; c: low ridge; d: tall spire). */
export function crags(style: CragStyle): V3BuildingModel[] {
  return (['a', 'b', 'c', 'd'] as const).map(shape => `rock-crag-${style}-${shape}` as V3BuildingModel);
}
/** Round pieces collide as the circle of diameter `width` (their models stay inside it below 3 m), not a rectangle. */
export const V3_ROUND: ReadonlySet<string> = new Set<V3BuildingModel>(['kit-tower-round', 'kit-tower-ruin', 'kit-camp-tower',
  ...crags('moss'), ...crags('snow'), ...crags('bare')]);
/** Runs the presentation draws as a module repeated along the box's longer side: the module's length in metres. */
export const V3_MODULES: Readonly<Record<string, number>> = { 'kit-fence': 2, 'kit-wall': 2, 'kit-curtain': 6, 'kit-curtain-ruin': 6 };
/**
 * Presentation-only pieces (`WorldBlueprint.decor`), drawn but never colliding. A gate arch spans the road between two
 * round gate towers whose faces stand `span` metres apart: `width` is its depth through the gate (local X), each end
 * runs `embed` metres into a tower (along local Z), and nothing of it comes lower than `spring` metres.
 */
export const V3_DECOR = { 'kit-gate-arch': { width: 7, span: 10, embed: 3, spring: 6.8, height: 14 } } as const;
export type V3DecorModel = keyof typeof V3_DECOR;
export const V3_FENCE = { model: 'kit-fence', thickness: 0.24, height: 1.3 } as const;
/** Boundary runs the presentation draws as repeated 2 m modules along a box's longer side. */
export const V3_BOUNDARIES = {
  fence: V3_FENCE,
  wall: { model: 'kit-wall', thickness: V3_BUILDINGS['kit-wall'].width, height: V3_BUILDINGS['kit-wall'].height },
} as const;
/** Small solid props, at their cooked models' sizes: circles use `radius`, boxes `width` x `length`. */
export const V3_PROPS = {
  'prop-haystack': { radius: 1.78, height: 3.2 },
  'prop-barrels': { radius: 1.13, height: 1.4 },
  'prop-scarecrow': { radius: 1.02, height: 2.8 },
  'prop-woodpile': { width: 1.0, length: 3.2, height: 1.25 },
  'prop-hay-cart': { width: 2.3, length: 3.85, height: 1.9 },
  'prop-bellpost': { radius: 1.25, height: 4.55 },
  'prop-gibbet': { radius: 1.72, height: 5.65 },
  'prop-wayside-shrine': { radius: 0.57, height: 2.55 },
  'prop-handcart': { width: 1.7, length: 3.2, height: 1.3 },
  'prop-crates': { radius: 1.24, height: 1.75 },
  'prop-gravestones': { width: 2.2, length: 1.15, height: 1.4 },
  'prop-gravestone': { radius: 0.42, height: 1.35 },
  'prop-grave-ward': { width: 1.7, length: 3.25, height: 1.25 },
  'prop-signpost': { radius: 0.82, height: 3.45 },
  'prop-trough': { width: 0.9, length: 3.2, height: 0.9 },
  'prop-anvil': { radius: 0.8, height: 1.3 },
  'prop-lantern-post': { radius: 0.64, height: 3.45 },
  'prop-net-rack': { width: 1.4, length: 3.8, height: 2.2 },
  'prop-stocks': { width: 1.25, length: 2.6, height: 1.7 },
  'prop-beehives': { width: 1.0, length: 2.05, height: 1.8 },
  /** W2 remains in the wilds, of creatures far larger than any soldier, and standing stones at old holy places. */
  'prop-giant-skull': { width: 7.7, length: 9.0, height: 4.6 },
  'prop-giant-ribs': { width: 8.45, length: 13.0, height: 5.9 },
  'prop-standing-stones': { radius: 3.14, height: 5.6 },
  'prop-troll-gibbet': { width: 4.6, length: 6.15, height: 8.45 },
  /** W3 forest floor (build_nature_w3.py, four variants each, drawn at the obstacle's scale): mossy boulders and
   * broken stumps (circles) and fallen black pines lying along local Z. */
  'rock-mossy': { radius: 1.3, height: 1.65 },
  'wood-stump': { radius: 1.0, height: 1.45 },
  'wood-log': { width: 1.6, length: 9.0, height: 1.4 },
} as const;
export type V3PropModel = keyof typeof V3_PROPS;
/** Tree species: trunk collider radius and height ranges (natural sizes; nature is not scaled up). */
export const V3_TREES = {
  'tree-spruce': { variants: 3, radius: [0.4, 0.65], height: [16, 26] },
  'tree-birch': { variants: 2, radius: [0.3, 0.45], height: [12, 18] },
  'tree-deadoak': { variants: 2, radius: [0.5, 0.75], height: [9, 14] },
  /** W3 dark forest: tall black pines, old twisted oaks on buttress roots and dead birches. */
  'tree-blackpine': { variants: 3, radius: [0.45, 0.7], height: [18, 28] },
  'tree-twistedoak': { variants: 2, radius: [0.95, 1.3], height: [8, 13] },
  'tree-deadbirch': { variants: 2, radius: [0.3, 0.45], height: [9, 14] },
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
 * extra margin trees and rocks keep from buildings and fences so crowns do not cut through roofs. `own` replaces the
 * open centre a place keeps round itself (a fortress keeps its whole courtyard open for the fight there). */
interface Rules { road: number; location: number; site: number; obstacle: number; structure?: number; own?: number }
/** Locations that become combat arenas in some campaign (the villain's royal-citadel fortress). */
const COMBAT_LOCATIONS = new Set(['palace-citadel']);

function fits(place: Placement, o: Obstacle, rules: Rules, own?: WorldLocation): boolean {
  const world = place.world;
  if (!insideBounds(world, o, 6) || !riverClear(world, o, 3)) return false;
  // Lakes come before the wild lands: every later solid keeps its obstacle gap (at least 2 m) from the water.
  for (const lake of world.lakes ?? []) {
    const box = lakeBounds(lake), reach = o.radius + Math.max(2, rules.obstacle);
    if (o.x < box.minX - reach || o.x > box.maxX + reach || o.z < box.minZ - reach || o.z > box.maxZ + reach) continue;
    if (lakeClearance(lake, o) < reach) return false;
  }
  // Lairs too: their clearings stay open.
  for (const lair of world.lairs ?? []) if (obstacleClearance(o, lair) < lair.radius) return false;
  if (place.roadClearance(o) < rules.road) return false;
  for (const location of world.exploration!.locations) {
    const clearing = location === own ? rules.own ?? LOCATION_CLEARING : Math.max(LOCATION_CLEARING, rules.location,
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

interface PlacePlan {
  /** Buildings along the roads: `first` in order nearest the centre, then the regional mix by weight. */
  count: number;
  first: readonly V3BuildingModel[];
  weights: readonly (readonly [V3BuildingModel, number])[];
  /** Back yards of dwellings: pale fences or dry-stone walls. */
  yard: keyof typeof V3_BOUNDARIES;
  /** Market stalls round the centre. */
  stalls: number;
  /** Strip fields beyond the houses. */
  fields: boolean;
}

const TIMBER = [['kit-cottage-a', 4], ['kit-cottage-b', 4], ['kit-cottage-c', 3], ['kit-longhouse', 2], ['kit-barn', 2],
  ['kit-shed', 2]] as const;

/**
 * Regional building families: timber in Greenmarch, the Heartlands and Hollowvale, stilt huts in the Fens, salt sheds and
 * hull shelters on the Salt Coast, brick and a glass kiln in the Ash Steppe, two-storey townhouses in the Crownlands and
 * stone in Frostspine; inns with walled courtyards, and the Reed Chapel and Star Monastery rebuilt round chapels.
 */
const PLACE_PLANS: Readonly<Record<string, PlacePlan>> = {
  greenhollow: { count: 16, first: ['kit-smithy', 'kit-watchtower'], weights: TIMBER, yard: 'wall', stalls: 2, fields: true },
  'hollow-village': { count: 11, first: ['kit-watchtower'], weights: [...TIMBER, ['kit-stonehouse', 2]], yard: 'fence', stalls: 0,
    fields: true },
  mirecross: { count: 12, first: ['kit-smithy'], weights: [['kit-stilthut', 6], ['kit-longhouse', 2], ['kit-shed', 2], ['kit-cottage-a', 1]],
    yard: 'fence', stalls: 3, fields: true },
  saltmarket: { count: 12, first: ['kit-saltshed', 'kit-saltshed'], weights: [['kit-stonehouse', 3], ['kit-boathut', 2], ['kit-saltshed', 1],
    ['kit-cottage-c', 2], ['kit-shed', 1]], yard: 'wall', stalls: 4, fields: true },
  cinderwell: { count: 11, first: ['kit-kiln', 'kit-smithy'], weights: [['kit-brickhouse', 4], ['kit-stonehouse', 3], ['kit-shed', 2]],
    yard: 'wall', stalls: 2, fields: true },
  crownbridge: { count: 12, first: ['kit-watchtower', 'kit-smithy'], weights: [['kit-townhouse-a', 4], ['kit-townhouse-b', 4],
    ['kit-stonehouse', 2], ['kit-barn', 1]], yard: 'wall', stalls: 3, fields: true },
  roadward: { count: 4, first: ['kit-inn', 'kit-smithy'], weights: [['kit-barn', 1], ['kit-cottage-c', 1], ['kit-shed', 1]], yard: 'fence',
    stalls: 0, fields: true },
  'lantern-ferry': { count: 4, first: ['kit-inn'], weights: [['kit-stilthut', 3], ['kit-shed', 1]], yard: 'fence', stalls: 0, fields: true },
  'wreckers-rest': { count: 4, first: ['kit-boathut', 'kit-boathut', 'kit-saltshed'], weights: [['kit-stonehouse', 1], ['kit-shed', 1]],
    yard: 'wall', stalls: 0, fields: false },
  'high-pass': { count: 4, first: ['kit-stonehouse', 'kit-stable'], weights: [['kit-stonehouse', 2], ['kit-shed', 1]], yard: 'wall',
    stalls: 0, fields: false },
  'reed-chapel': { count: 3, first: ['kit-chapel-fen'], weights: [['kit-stilthut', 1]], yard: 'fence', stalls: 0, fields: false },
  'star-monastery': { count: 4, first: ['kit-chapel'], weights: [['kit-stonehouse', 1]], yard: 'wall', stalls: 0, fields: false },
};
/** Shrines rebuilt round a chapel; their first v2 structure (a cooked landmark) stays beside it. */
export const CHAPEL_SHRINES: ReadonlySet<string> = new Set(['reed-chapel', 'star-monastery']);
/** Dwellings, barns and sheds get a back yard; workshops, towers, halls and chapels stand free. */
const YARDED: ReadonlySet<V3BuildingModel> = new Set<V3BuildingModel>(['kit-cottage-a', 'kit-cottage-b', 'kit-cottage-c',
  'kit-longhouse', 'kit-barn', 'kit-shed', 'kit-stonehouse', 'kit-brickhouse', 'kit-townhouse-a', 'kit-townhouse-b', 'kit-stilthut']);

function placePlan(place: WorldLocation): PlacePlan {
  const plan = Object.hasOwn(PLACE_PLANS, place.id) ? PLACE_PLANS[place.id] : undefined;
  if (plan) return plan;
  return place.kind === 'inn'
    ? { count: 4, first: [], weights: [['kit-longhouse', 3], ['kit-barn', 2], ['kit-shed', 2], ['kit-cottage-c', 1]], yard: 'fence',
      stalls: 0, fields: true }
    : { count: 11, first: [], weights: TIMBER, yard: 'fence', stalls: 0, fields: true };
}

function weighted<T>(random: ReturnType<typeof stream>, weights: readonly (readonly [T, number])[]): T {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random.next() * total;
  for (const [item, weight] of weights) { roll -= weight; if (roll < 0) return item; }
  return weights[weights.length - 1]![0];
}

/**
 * Buildings face the road in rows on both sides: the place's landmark buildings first, then its regional mix, dwellings
 * with a fenced or walled yard behind them, an inn with a walled courtyard and stable; then market stalls round the centre
 * and strip fields beyond the houses.
 */
function layoutSettlement(place: Placement, location: WorldLocation, seed: string): void {
  const world = place.world;
  const random = stream(`korovany2:v3:${seed}:${location.id}:layout`);
  const plan = placePlan(location);
  const ways = roadsFrom(world, location);
  const queue = [...plan.first];
  let built = 0, serial = 0;
  const lots: { dir: Vec2; side: number; end: number }[] = [];
  for (const way of ways) for (const side of [-1, 1]) lots.push({ dir: way.dir, side, end: Math.min(way.length - 20, 95) });
  const cursors = lots.map(() => 14 + random.range(0, 4));
  for (let round = 0; round < 8 && built < plan.count; round++) {
    const head = queue[0];
    for (let lot = 0; lot < lots.length && built < plan.count; lot++) {
      const { dir, side, end } = lots[lot]!;
      for (let attempt = 0; attempt < 3; attempt++) {
        const model = queue[0] ?? weighted(random, plan.weights);
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
        if (queue[0] === model) queue.shift();
        cursors[lot]! += size.length + random.range(4, 8);
        built++;
        if (model === 'kit-inn') courtyard(place, building, location, random);
        else if (YARDED.has(model)) yard(place, building, location, random, plan.yard);
        buildingProps(place, building, location, random);
        break;
      }
    }
    // A landmark building that fits nowhere along these roads gives way to the regional mix.
    if (queue[0] !== undefined && queue[0] === head) queue.shift();
  }
  if (built < Math.min(plan.count, 3)) throw new Error(`Cannot lay out the v3 settlement at ${location.id}`);
  if (plan.stalls) stalls(place, location, plan.stalls, random);
  centreProps(place, location, random);
  if (plan.fields) fields(place, location, lots.map((lot, index) => ({ ...lot, start: cursors[index]! + 6 })), random);
}

/** A back yard fenced with pales or walled with dry stone (a gate gap on one side) and a woodpile against a gable wall. */
function yard(place: Placement, building: Obstacle, location: WorldLocation, random: ReturnType<typeof stream>,
  boundary: keyof typeof V3_BOUNDARIES): void {
  const shape = building.shape!;
  const run = V3_BOUNDARIES[boundary];
  const depth = random.range(6, 10);
  const c = Math.cos(shape.heading), s = Math.sin(shape.heading);
  const localToWorld = (lx: number, lz: number): Vec2 => ({ x: building.x + lx * c + lz * s, z: building.z - lx * s + lz * c });
  const back = -shape.halfX - depth;
  const t = run.thickness / 2;
  const id = building.id.replace('-house-', '-yard-');
  const pieces: Obstacle[] = [];
  const backCentre = localToWorld(back, 0);
  pieces.push(box(`${id}-back`, backCentre.x, backCentre.z, t, shape.halfZ + 0.6, shape.heading, run.height, run.model, 0));
  const gate = 2.6;
  for (const end of [-1, 1]) {
    const gap = end === 1 ? gate : 0;
    const from = -shape.halfX - 0.5, to = back + 0.5;
    const length = from - to - gap;
    if (length < 1) continue;
    const mid = localToWorld(to + length / 2, end * (shape.halfZ + 0.6));
    pieces.push(box(`${id}-side-${end === 1 ? 'b' : 'a'}`, mid.x, mid.z, length / 2, t, shape.heading, run.height, run.model, 1));
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
  yardProps(place, building, location, depth, random);
}

/** The inn's walled courtyard behind it, with a wagon gate beside the inn and the stable along the back wall. */
function courtyard(place: Placement, inn: Obstacle, location: WorldLocation, random: ReturnType<typeof stream>): void {
  const shape = inn.shape!;
  const run = V3_BOUNDARIES.wall;
  const depth = 17;
  const c = Math.cos(shape.heading), s = Math.sin(shape.heading);
  const at = (lx: number, lz: number): Vec2 => ({ x: inn.x + lx * c + lz * s, z: inn.z - lx * s + lz * c });
  const t = run.thickness / 2;
  const back = -shape.halfX - depth;
  const halfZ = shape.halfZ + 0.6;
  const id = inn.id.replace('-house-', '-court-');
  const pieces: Obstacle[] = [];
  const backCentre = at(back, 0);
  pieces.push(box(`${id}-back`, backCentre.x, backCentre.z, t, halfZ + t, shape.heading, run.height, run.model, 0));
  const gate = 4.5;
  for (const end of [-1, 1]) {
    // Side walls stop 2 cm short of the back wall, which runs on across their ends.
    const from = -shape.halfX - 0.5, to = back + t + 0.02;
    const length = from - to - (end === 1 ? gate : 0);
    const mid = at(to + length / 2, end * halfZ);
    pieces.push(box(`${id}-side-${end === 1 ? 'b' : 'a'}`, mid.x, mid.z, length / 2, t, shape.heading, run.height, run.model, 1));
  }
  if (!pieces.every(piece => fits(place, piece, FENCE_RULES, location))) {
    yard(place, inn, location, random, 'fence');
    return;
  }
  for (const piece of pieces) place.add(piece);
  const centre = at(-shape.halfX - depth / 2, 0);
  place.yards.push({ id, x: centre.x, z: centre.z, halfX: depth / 2, halfZ, heading: shape.heading, crop: 'stubble' });
  const size = V3_BUILDINGS['kit-stable'];
  const spot = at(back + t + 0.5 + size.width / 2, -halfZ + t + 0.5 + size.length / 2);
  const stable = box(`${inn.id}-stable`, spot.x, spot.z, size.width / 2, size.length / 2, shape.heading, size.height, 'kit-stable', 0);
  if (fits(place, stable, { ...BUILDING_RULES, obstacle: 0.3 }, location)) place.add(stable);
}

/** Market stalls on a ring round the centre, their counters towards it, clear of the roads. */
function stalls(place: Placement, location: WorldLocation, count: number, random: ReturnType<typeof stream>): void {
  const size = V3_BUILDINGS['kit-stall'];
  const rules: Rules = { road: 2.5, location: 18, site: COMBAT_YARD, obstacle: 1.2 };
  const start = random.next() * Math.PI * 2;
  let placed = 0;
  for (let step = 0; step < 24 && placed < count; step++) {
    const angle = start + step * (Math.PI * 2 / 24) * 7;
    const radius = 15.5 + random.range(0, 2);
    const x = location.x + Math.cos(angle) * radius, z = location.z + Math.sin(angle) * radius;
    // Local +X (the counter) faces the centre: (cos h, -sin h) = -(cos a, sin a).
    const heading = Math.atan2(Math.sin(angle), -Math.cos(angle));
    const stall = box(`${location.id}-stall-${placed}`, x, z, size.width / 2, size.length / 2, heading, size.height, 'kit-stall', 0);
    if (!fits(place, stall, rules, location)) continue;
    place.add(stall);
    placed++;
  }
}
/** A prop obstacle: circles take a presentation yaw from their id; boxes turn to `heading` (local Z along their length). */
function prop(id: string, model: V3PropModel, at: Vec2, heading: number, variant = 0): Obstacle {
  const spec = V3_PROPS[model];
  if ('radius' in spec) return { id, kind: 'wall', x: at.x, z: at.z, radius: spec.radius, height: spec.height, variant, model };
  return box(id, at.x, at.z, spec.width / 2, spec.length / 2, heading, spec.height, model, variant);
}

/** A point in a building's frame (local X out of its front, local Z along it). */
function local(building: Obstacle, lx: number, lz: number): Vec2 {
  const h = building.shape!.heading, c = Math.cos(h), s = Math.sin(h);
  return { x: building.x + lx * c + lz * s, z: building.z - lx * s + lz * c };
}

/** Adds the first candidate that fits; returns whether one did. */
function placeFirst(place: Placement, location: WorldLocation | undefined, rules: Rules, candidates: Obstacle[]): boolean {
  for (const candidate of candidates) {
    if (!fits(place, candidate, rules, location)) continue;
    place.add(candidate);
    return true;
  }
  return false;
}

/** Workshop and hall props: an anvil before each smithy, troughs at smithies and stables, lantern posts at inns, nets on
 * the coast and in the Fens, and a graveyard behind each chapel. */
function buildingProps(place: Placement, building: Obstacle, location: WorldLocation, random: ReturnType<typeof stream>): void {
  const shape = building.shape!;
  // Not '-house-': that prefix names the place's buildings.
  const id = building.id.replace('-house-', '-by-');
  const along = shape.heading + Math.PI / 2;
  if (building.model === 'kit-smithy') {
    // The anvil stands at the open front (it belongs to the forge, so it may come close), or else beside a gable.
    const near: Rules = { ...PROP_RULES, obstacle: 0.25 };
    placeFirst(place, location, near, [prop(`${id}-anvil`, 'prop-anvil', local(building, shape.halfX + 1.35, -1.4), 0),
      prop(`${id}-anvil`, 'prop-anvil', local(building, shape.halfX + 1.35, 1.6), 0),
      ...[-1, 1].map(end => prop(`${id}-anvil`, 'prop-anvil', local(building, shape.halfX - 1.4, end * (shape.halfZ + 1.4)), 0))]);
    placeFirst(place, location, PROP_RULES, [-1, 1].map(end => prop(`${id}-trough`, 'prop-trough',
      local(building, -shape.halfX + 2.4, end * (shape.halfZ + 1.5)), along)));
  } else if (building.model === 'kit-stable') {
    placeFirst(place, location, PROP_RULES, [prop(`${id}-trough`, 'prop-trough', local(building, shape.halfX + 2.0, 0), shape.heading)]);
  } else if (building.model === 'kit-inn') {
    placeFirst(place, location, PROP_RULES, [-1, 1].map(end => prop(`${id}-lantern`, 'prop-lantern-post',
      local(building, shape.halfX + 1.8, end * (shape.halfZ - 1.5)), 0)));
  } else if (building.model === 'kit-saltshed' || building.model === 'kit-boathut'
    || (building.model === 'kit-stilthut' && random.next() < 0.5)) {
    placeFirst(place, location, PROP_RULES, [-1, 1].map(end => prop(`${id}-nets`, 'prop-net-rack',
      local(building, 0, end * (shape.halfZ + 2.2)), along)));
  } else if (building.model === 'kit-chapel' || building.model === 'kit-chapel-fen') {
    graveyard(place, building, location, random);
  }
}

/** Graves in rows behind a chapel: round-topped stones and burial mounds with a salt line and a hand bell. */
function graveyard(place: Placement, chapel: Obstacle, location: WorldLocation, random: ReturnType<typeof stream>): void {
  const shape = chapel.shape!;
  const rules: Rules = { ...PROP_RULES, obstacle: 0.6 };
  let serial = 0;
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 5; column++) {
      const lz = -shape.halfZ + 2.5 + column * ((shape.halfZ * 2 - 5) / 4) + random.range(-0.4, 0.4);
      const lx = -shape.halfX - 3.2 - row * 4.2 + random.range(-0.3, 0.3);
      const roll = random.next();
      const model: V3PropModel = roll < 0.35 ? 'prop-gravestone' : roll < 0.7 ? 'prop-gravestones' : 'prop-grave-ward';
      // Stones face away from the chapel; mounds lie along the rows.
      const heading = model === 'prop-grave-ward' ? shape.heading : shape.heading + Math.PI / 2;
      const grave = prop(`${chapel.id.replace('-house-', '-by-')}-grave-${serial++}`, model, local(chapel, lx, lz),
        heading + random.range(-0.12, 0.12));
      if (fits(place, grave, rules, location)) place.add(grave);
    }
  }
}

/** Free directions round a place's centre: angles whose ray keeps at least `gap` radians from every road leaving it. */
function openAngles(world: WorldBlueprint, location: WorldLocation, count: number, gap: number, start: number): number[] {
  const roads = roadsFrom(world, location).map(way => Math.atan2(way.dir.z, way.dir.x));
  const angles: number[] = [];
  for (let i = 0; i < count; i++) {
    const angle = start + i * Math.PI * 2 / count;
    if (roads.every(road => Math.abs(Math.atan2(Math.sin(angle - road), Math.cos(angle - road))) > gap)) angles.push(angle);
  }
  return angles;
}

/** Bell posts, stocks, carts and crates round a place's centre (Hollow Village's bell is gone, as its lore says). */
function centreProps(place: Placement, location: WorldLocation, random: ReturnType<typeof stream>): void {
  const world = place.world;
  const at = (angle: number, radius: number): Vec2 => ({ x: location.x + Math.cos(angle) * radius, z: location.z + Math.sin(angle) * radius });
  const faceCentre = (angle: number): number => Math.atan2(Math.sin(angle), -Math.cos(angle));
  const angles = openAngles(world, location, 24, 0.3, random.next() * Math.PI * 2);
  const used: number[] = [];
  const take = (model: V3PropModel, radius: number, suffix: string, heading?: (angle: number) => number): void => {
    for (const angle of angles) {
      if (used.some(other => Math.abs(Math.atan2(Math.sin(angle - other), Math.cos(angle - other))) < 0.45)) continue;
      const candidate = prop(`${location.id}-${suffix}`, model, at(angle, radius), heading ? heading(angle) : faceCentre(angle));
      if (!fits(place, candidate, PROP_RULES, location)) continue;
      place.add(candidate);
      used.push(angle);
      return;
    }
  };
  const settlement = location.kind === 'settlement';
  if (settlement && location.id !== 'hollow-village') take('prop-bellpost', 13.6, 'bell');
  if (location.id === 'crownbridge' || location.id === 'greenhollow') take('prop-stocks', 14.2, 'stocks');
  if (settlement || location.id === 'roadward') {
    take('prop-handcart', 14.5, 'handcart', angle => angle + random.range(-0.6, 0.6));
    take('prop-crates', 14.2, 'crates');
  }
  if (location.id === 'crownbridge') take('prop-crates', 14.4, 'crates-b');
  if (location.id === 'lantern-ferry' || location.id === 'mirecross') {
    for (let i = 0; i < 3; i++) take('prop-lantern-post', 13.2, `lantern-${i}`);
  }
}

/** Beehives against the back fence or wall of some timber-country yards. */
function yardProps(place: Placement, building: Obstacle, location: WorldLocation, depth: number, random: ReturnType<typeof stream>): void {
  const region = regionAt(place.world, location)?.id;
  if (region !== 'greenmarch' && region !== 'heartlands' && region !== 'hollowvale') return;
  if (random.next() > 0.3) return;
  const shape = building.shape!;
  const hives = prop(`${building.id.replace('-house-', '-yard-')}-hives`, 'prop-beehives',
    local(building, -shape.halfX - depth + 1.4, random.range(-0.4, 0.4) * shape.halfZ), shape.heading);
  if (fits(place, hives, { ...PROP_RULES, obstacle: 0.4 }, location)) place.add(hives);
}

/**
 * Road furniture away from places: a signpost at every junction of three or more roads, a wayside shrine (Greenmarch,
 * the Heartlands, Hollowvale, the Fens) or a gibbet (Crown land, Frostspine, the Salt Coast and the Ash Steppe) at turns,
 * and three warded graves beside the covered Echo Well, where the lore buries Mara's three drivers.
 */
function roadsideProps(place: Placement, seed: string): void {
  const world = place.world;
  const random = stream(`korovany2:v3:${seed}:roadside`);
  const locations = world.exploration!.locations;
  const shrines = new Set(['greenmarch', 'heartlands', 'hollowvale', 'fenlands']);
  for (const node of world.roads.nodes) {
    if (locations.some(l => l.id === node.id) || world.sites.some(s => s.id === node.id)) continue;
    if (locations.some(l => distance(l, node) < 30)) continue;
    const edges = world.roads.edges.filter(edge => edge.from === node.id || edge.to === node.id);
    if (edges.length < 2) continue;
    const dirs = edges.map(edge => {
      const other = world.roads.nodes.find(n => n.id === (edge.from === node.id ? edge.to : edge.from))!;
      return Math.atan2(other.z - node.z, other.x - node.x);
    }).sort((a, b) => a - b);
    // The middle of the widest gap between the roads leaving the node.
    let best = 0, bestGap = -1;
    for (let i = 0; i < dirs.length; i++) {
      const a = dirs[i]!, b = i + 1 < dirs.length ? dirs[i + 1]! : dirs[0]! + Math.PI * 2;
      if (b - a > bestGap) { bestGap = b - a; best = (a + b) / 2; }
    }
    const region = regionAt(world, node)?.id ?? 'heartlands';
    const model: V3PropModel = edges.length >= 3 ? 'prop-signpost' : shrines.has(region) ? 'prop-wayside-shrine' : 'prop-gibbet';
    const variant = Math.floor(random.next() * 4);
    const candidates = [7, 9, 11].map(radius => prop(`roadside-${node.id}`, model,
      { x: node.x + Math.cos(best) * radius, z: node.z + Math.sin(best) * radius }, 0, variant));
    placeFirst(place, undefined, { ...PROP_RULES, location: 24 }, candidates);
  }
  const well = locations.find(l => l.id === 'name-well');
  if (well) {
    const start = random.next() * Math.PI * 2;
    let placed = 0;
    for (let step = 0; step < 16 && placed < 3; step++) {
      const angle = start + step * Math.PI / 8;
      const grave = prop(`name-well-grave-${placed}`, 'prop-grave-ward', { x: well.x + Math.cos(angle) * 15, z: well.z + Math.sin(angle) * 15 },
        -angle);
      if (fits(place, grave, { ...PROP_RULES, obstacle: 0.5 }, well)) { place.add(grave); placed++; }
    }
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

/**
 * Forest character per region: noise above `1 - density` is woodland, at `spacing` metres between trunks. Greenmarch
 * and Hollowvale are the dark forests: black pines over twisted oaks and dead birches, packed close in their cores.
 */
const WOODLAND: Readonly<Record<string, Woodland>> = {
  heartlands: { density: 0.36, spacing: 7, species: [['tree-birch', 3], ['tree-deadoak', 2], ['tree-twistedoak', 2], ['tree-spruce', 1]], scale: 0.012 },
  greenmarch: { density: 0.68, spacing: 3.9, species: [['tree-blackpine', 9], ['tree-spruce', 3], ['tree-twistedoak', 2], ['tree-deadbirch', 1],
    ['tree-birch', 1]], scale: 0.009 },
  fenlands: { density: 0.4, spacing: 6.5, species: [['tree-birch', 4], ['tree-deadbirch', 3], ['tree-deadoak', 2], ['tree-spruce', 1]], scale: 0.011 },
  saltcoast: { density: 0.31, spacing: 10, species: [['tree-deadoak', 2], ['tree-birch', 1]], scale: 0.013 },
  ashsteppe: { density: 0.31, spacing: 9, species: [['tree-deadoak', 2], ['tree-deadbirch', 1]], scale: 0.013 },
  crownlands: { density: 0.35, spacing: 8, species: [['tree-birch', 2], ['tree-spruce', 2], ['tree-deadoak', 1], ['tree-twistedoak', 1]], scale: 0.012 },
  frostspine: { density: 0.43, spacing: 6, species: [['tree-spruce', 3], ['tree-blackpine', 3], ['tree-deadoak', 1]], scale: 0.011 },
  hollowvale: { density: 0.72, spacing: 3.7, species: [['tree-blackpine', 9], ['tree-twistedoak', 3], ['tree-deadbirch', 1], ['tree-spruce', 2]],
    scale: 0.009 },
};
const MAX_TREES = 20000;

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

/** A kit building at a point: round pieces are circles of diameter `width`, the rest rectangles turned to `heading`. */
function building(id: string, model: V3BuildingModel, at: Vec2, heading: number, variant = 0): Obstacle {
  const size = V3_BUILDINGS[model];
  if (V3_ROUND.has(model)) return { id, kind: 'wall', x: at.x, z: at.z, radius: size.width / 2, height: size.height, variant, model };
  return box(id, at.x, at.z, size.width / 2, size.length / 2, heading, size.height, model, variant);
}

/** The heading that turns a piece at compass angle `angle` from a place's centre to face it (local +X inwards). */
function facing(angle: number): number {
  return Math.atan2(Math.cos(angle), -Math.sin(angle));
}

interface FortPlan {
  /** Towers and the keep, in world coordinates; round towers ignore `heading`. */
  towers: { model: V3BuildingModel; at: Vec2; heading: number }[];
  /** Curtain runs between two towers (indices into `towers`), each running a metre short of both towers' far faces. */
  runs: { from: number; to: number; model: 'kit-curtain' | 'kit-curtain-ruin' }[];
  /** Gate arches over a road between two round towers whose faces stand the arch's span apart. */
  gates: { from: number; to: number }[];
  /** Open ground round the centre where the place's own defenders fight: no piece comes closer. */
  yard: number;
}

/** How far a curtain run reaches into a tower: a metre short of its far side, so the run's end face stays hidden. */
function runInset(tower: Obstacle): number {
  return (tower.shape ? Math.min(tower.shape.halfX, tower.shape.halfZ) : tower.radius) - 1;
}

/**
 * An authored fortification: towers and a keep, curtain runs between neighbouring towers (boxes the presentation fills
 * with repeated 6 m modules) and gate arches as presentation-only decor. The plan is authored, so a piece that does
 * not fit is a generator error, not something to skip.
 */
function fortification(place: Placement, location: WorldLocation, plan: FortPlan): void {
  const rules: Rules = { road: 0.9, location: 26, site: COMBAT_YARD, obstacle: 1, own: plan.yard };
  const towers = plan.towers.map((tower, index) => building(`${location.id}-tower-${index}`, tower.model, tower.at, tower.heading, index));
  const pieces = [...towers];
  plan.runs.forEach((run, index) => {
    const a = towers[run.from]!, b = towers[run.to]!;
    const length = distance(a, b);
    const d = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
    const start = runInset(a), end = length - runInset(b);
    const size = V3_BUILDINGS[run.model];
    pieces.push(box(`${location.id}-curtain-${index}`, a.x + d.x * (start + end) / 2, a.z + d.z * (start + end) / 2, size.width / 2,
      (end - start) / 2, Math.atan2(d.x, d.z), size.height, run.model, index));
  });
  // Pieces of one fortification meet and overlap by design, so each is checked against the world before any is added.
  for (const piece of pieces) if (!fits(place, piece, rules, location)) throw new Error(`Cannot build ${piece.id} at ${location.id}`);
  for (const piece of pieces) place.add(piece);
  const arch = V3_DECOR['kit-gate-arch'];
  plan.gates.forEach((gate, index) => {
    const a = towers[gate.from]!, b = towers[gate.to]!;
    const span = distance(a, b) - a.radius - b.radius;
    if (a.shape || b.shape || Math.abs(span - arch.span) > 1e-6) throw new Error(`The gate at ${location.id} spans ${span} m, not ${arch.span} m`);
    place.world.decor!.push({ id: `${location.id}-gate-${index}`, model: 'kit-gate-arch', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2,
      heading: Math.atan2(b.x - a.x, b.z - a.z) });
  });
}

/**
 * The Royal Citadel: a curtain of round towers round a courtyard kept open for the villain's final battle (the Palace
 * Marshal is leashed 22 m to its centre), the keep in the north wall facing the courtyard, and the gatehouse arch over
 * the Crownbridge road. Its south-east curtain follows the Crownbridge-Bell Foundry road 2 m off its verge. Offsets in
 * metres east (x) and north (z) of the citadel's centre.
 */
const CITADEL = {
  towers: [
    ['kit-tower-round', 9.5, -33.8], ['kit-tower-round', -9.5, -33.8], ['kit-tower-round', 35.2, 9.2], ['kit-tower-round', 11.5, 33],
    ['kit-tower-round', -11.5, 33], ['kit-tower-round', -35, 9], ['kit-tower-round', -27, -24], ['kit-keep', 0, 38],
  ] as const,
  runs: [[0, 2], [2, 3], [4, 5], [5, 6], [6, 1]] as const,
  gates: [[1, 0]] as const,
  yard: 23.5,
};

function citadelPlan(location: WorldLocation): FortPlan {
  return {
    towers: CITADEL.towers.map(([model, x, z]) => ({ model, at: { x: location.x + x, z: location.z + z }, heading: facing(Math.atan2(x, z)) })),
    runs: CITADEL.runs.map(([from, to]) => ({ from, to, model: 'kit-curtain' })),
    gates: CITADEL.gates.map(([from, to]) => ({ from, to })),
    yard: CITADEL.yard,
  };
}

/**
 * The Old Fort, the mountain ruler's seat: a ring of round towers `radius` metres out with a gate over each road that
 * leaves it, towers about every 50 degrees between the gates, curtains between neighbours, the stretch opposite the
 * gates fallen to ruin round a broken tower, and a square keep standing inside the curtain farthest from the gates.
 */
function ringFortPlan(world: WorldBlueprint, location: WorldLocation, radius: number, yard: number): FortPlan {
  const arch = V3_DECOR['kit-gate-arch'];
  const half = V3_BUILDINGS['kit-tower-round'].width / 2;
  const flank = Math.asin((arch.span / 2 + half) / radius);
  const roads = roadsFrom(world, location).map(way => Math.atan2(way.dir.x, way.dir.z)).sort((a, b) => a - b);
  const ring: { angle: number; gate: boolean }[] = [];
  roads.forEach((road, index) => {
    const next = index + 1 < roads.length ? roads[index + 1]! : roads[0]! + Math.PI * 2;
    const from = road + flank, to = next - flank;
    if (to - from < 0.3) throw new Error(`The roads at ${location.id} leave no room between its gates`);
    ring.push({ angle: road - flank, gate: true }, { angle: from, gate: false });
    const between = Math.max(0, Math.round((to - from) / (50 * Math.PI / 180)) - 1);
    for (let k = 1; k <= between; k++) ring.push({ angle: from + (to - from) * k / (between + 1), gate: false });
  });
  const gap = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const fromGates = (angle: number): number => Math.min(...roads.map(road => gap(angle, road)));
  // The keep stands inside the curtain whose middle lies farthest from every gate.
  let keepRun = -1, keepAngle = 0;
  for (let index = 0; index < ring.length; index++) {
    if (ring[index]!.gate) continue;
    const a = ring[index]!.angle, b = ring[(index + 1) % ring.length]!.angle;
    const middle = a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) / 2;
    if (keepRun < 0 || fromGates(middle) > fromGates(keepAngle)) { keepRun = index; keepAngle = middle; }
  }
  // The broken tower is the inner tower (not a gate's) farthest from the keep; both curtains beside it are ruins too.
  let ruin = -1;
  ring.forEach((tower, index) => {
    const gateTower = tower.gate || ring[(index - 1 + ring.length) % ring.length]!.gate;
    if (!gateTower && (ruin < 0 || gap(tower.angle, keepAngle) > gap(ring[ruin]!.angle, keepAngle))) ruin = index;
  });
  const at = (angle: number, r: number): Vec2 => ({ x: location.x + Math.sin(angle) * r, z: location.z + Math.cos(angle) * r });
  const towers: FortPlan['towers'] = ring.map((tower, index) =>
    ({ model: index === ruin ? 'kit-tower-ruin' : 'kit-tower-round', at: at(tower.angle, radius), heading: facing(tower.angle) }));
  const runs: FortPlan['runs'] = [], gates: FortPlan['gates'] = [];
  ring.forEach((tower, index) => {
    const next = (index + 1) % ring.length;
    if (tower.gate) gates.push({ from: index, to: next });
    else runs.push({ from: index, to: next, model: index === ruin || next === ruin ? 'kit-curtain-ruin' : 'kit-curtain' });
  });
  // The keep's back stands 0.4 m inside the curtain behind it.
  const a = ring[keepRun]!.angle, b = ring[(keepRun + 1) % ring.length]!.angle;
  const inner = radius * Math.cos(gap(a, b) / 2) - V3_BUILDINGS['kit-curtain'].width / 2;
  const keep = V3_BUILDINGS['kit-tower-square'];
  towers.push({ model: 'kit-tower-square', at: at(keepAngle, inner - 0.4 - keep.width / 2), heading: facing(keepAngle) });
  return { towers, runs, gates, yard };
}

/**
 * The cooked landmark buildings v3 keeps of each place's v2 structures (by variant), and the radius each grows to where
 * the road beside it allows (the cooked model scales uniformly into its footprint).
 */
const LANDMARKS: Readonly<Record<string, { variants: readonly number[]; radius: number }>> = {
  'reed-chapel': { variants: [0], radius: 2.8 },
  'star-monastery': { variants: [0], radius: 2.8 },
  'bell-foundry': { variants: [0, 1], radius: 3.4 },
  'stag-shrine': { variants: [0], radius: 3.2 },
  'frozen-beacon': { variants: [0], radius: 2.8 },
  'tide-observatory': { variants: [0], radius: 3.4 },
  'glass-quarry': { variants: [0], radius: 3.6 },
  'ash-cairn': { variants: [0], radius: 3.8 },
  'name-well': { variants: [0], radius: 2.8 },
};

function ownerOf(world: WorldBlueprint, o: Obstacle): WorldLocation | undefined {
  return world.exploration!.locations.find(l => o.id.startsWith(`${l.id}-building-`));
}

/** Kept landmarks grow towards their radius, staying a metre off road verges and other structures. */
function growLandmarks(world: WorldBlueprint, roads: Segment[]): void {
  for (const o of world.obstacles) {
    const owner = ownerOf(world, o);
    const spec = owner && Object.hasOwn(LANDMARKS, owner.id) ? LANDMARKS[owner.id]! : undefined;
    if (!spec || spec.radius <= o.radius) continue;
    let room = spec.radius - o.radius;
    for (const road of roads) room = Math.min(room, segmentClearance(o, road.a, road.b) - road.half - 1);
    for (const other of world.obstacles) if (other !== o) room = Math.min(room, obstacleClearance(other, o) - o.radius - 1);
    if (room > 0) o.radius += room;
  }
}

/** Kit pieces and props of a ruin, landmark or shrine: `at` metres from its centre, `run` the length of a curtain run. */
interface ClusterPiece { model: V3BuildingModel | V3PropModel; at: number; run?: number }

/**
 * Ruins and holy places rebuilt round their story: Thornwatch's broken watchtower, the Old Cloister's and the Drowned
 * Archive's roofless halls, the Sealed Vault's strongroom tower and storehouse, the Glass Quarry's furnaces, the Tide
 * Observatory's tower, the Bell Foundry's furnace and forge, the Frozen Beacon's watch hut, and standing stones at the
 * Stag Shrine and the Ash Cairn (whose lore marks the mound's edge with white stones).
 */
const CLUSTERS: Readonly<Record<string, readonly ClusterPiece[]>> = {
  thornwatch: [{ model: 'kit-tower-ruin', at: 17 }, { model: 'kit-curtain-ruin', at: 18, run: 12 }, { model: 'kit-ruin-house', at: 24 },
    { model: 'kit-curtain-ruin', at: 21, run: 12 }],
  'last-archive': [{ model: 'kit-ruin-chapel', at: 23 }, { model: 'kit-ruin-house', at: 20 }, { model: 'kit-ruin-house', at: 25 },
    { model: 'kit-curtain-ruin', at: 18, run: 12 }],
  'drowned-archive': [{ model: 'kit-ruin-chapel', at: 22 }, { model: 'kit-ruin-house', at: 20 }, { model: 'kit-ruin-house', at: 25 }],
  'tax-vault': [{ model: 'kit-tower-square', at: 18 }, { model: 'kit-stonehouse', at: 21 }, { model: 'kit-ruin-house', at: 22 },
    { model: 'kit-curtain-ruin', at: 18, run: 12 }],
  'old-orchard': [{ model: 'kit-ruin-house', at: 19 }],
  'glass-quarry': [{ model: 'kit-kiln', at: 19 }, { model: 'kit-kiln', at: 23 }, { model: 'kit-ruin-house', at: 22 }],
  'tide-observatory': [{ model: 'kit-tower-round', at: 18 }, { model: 'kit-stonehouse', at: 22 }],
  'bell-foundry': [{ model: 'kit-kiln', at: 19 }, { model: 'kit-smithy', at: 22 }, { model: 'kit-stonehouse', at: 24 }],
  'frozen-beacon': [{ model: 'kit-shed', at: 17 }],
  'stag-shrine': [{ model: 'prop-standing-stones', at: 17 }],
  'ash-cairn': [{ model: 'prop-standing-stones', at: 17 }, { model: 'prop-standing-stones', at: 19 }],
};

/** Places each piece at the first free direction off the roads, facing the centre; curtain runs lie across it. */
function cluster(place: Placement, location: WorldLocation, seed: string, pieces: readonly ClusterPiece[]): void {
  const random = stream(`korovany2:v3:${seed}:${location.id}:cluster`);
  const angles = openAngles(place.world, location, 36, 0.3, random.next() * Math.PI * 2);
  const rules: Rules = { road: 2.5, location: 26, site: COMBAT_YARD, obstacle: 2 };
  pieces.forEach((spec, index) => {
    const id = `${location.id}-piece-${index}`;
    for (const angle of angles) {
      const r = spec.at + random.range(-1, 1);
      const at = { x: location.x + Math.cos(angle) * r, z: location.z + Math.sin(angle) * r };
      // Local +X towards the centre: (cos h, -sin h) = -(cos a, sin a).
      const heading = Math.atan2(Math.sin(angle), -Math.cos(angle)) + random.range(-0.12, 0.12);
      let piece: Obstacle;
      if (Object.hasOwn(V3_PROPS, spec.model)) piece = prop(id, spec.model as V3PropModel, at, heading, index);
      else if (spec.run) {
        const size = V3_BUILDINGS[spec.model as V3BuildingModel];
        piece = box(id, at.x, at.z, size.width / 2, spec.run / 2, heading, size.height, spec.model, index);
      } else piece = building(id, spec.model as V3BuildingModel, at, heading, index);
      if (!fits(place, piece, rules, location)) continue;
      place.add(piece);
      return;
    }
  });
}

/** The Old Orchard: rows of short dead oaks round the ruined farmhouse, bordered by a broken pale fence. */
function orchard(place: Placement, location: WorldLocation, seed: string): void {
  const random = stream(`korovany2:v3:${seed}:${location.id}:orchard`);
  const axis = roadsFrom(place.world, location)[0]!.dir;
  const across = { x: -axis.z, z: axis.x };
  const rules: Rules = { road: 3, location: 26, site: 24, obstacle: 1.2, structure: 2.5, own: 14 };
  let serial = 0;
  for (let row = -8; row <= 8; row++) {
    for (let column = -9; column <= 9; column++) {
      const u = column * 5.5 + random.range(-0.5, 0.5), v = row * 6.5 + random.range(-0.5, 0.5);
      const p = { x: location.x + axis.x * u + across.x * v, z: location.z + axis.z * u + across.z * v };
      const spot = random.next();
      const reach = distance(p, location);
      // A seventh of the trees are gone.
      if (reach < 15 || reach > 46 || spot < 0.14 || insideField(place.world, p, 2)) continue;
      const tree: Obstacle = { id: `${location.id}-tree-${serial}`, kind: 'tree', x: p.x, z: p.z, radius: 0.45 + spot * 0.15,
        height: 8 + spot * 2.5, variant: Math.floor(spot * 97) % V3_TREES['tree-deadoak'].variants, model: 'tree-deadoak' };
      if (!fits(place, tree, rules, location)) continue;
      place.add(tree);
      serial++;
    }
  }
  const start = random.next() * Math.PI * 2;
  for (let k = 0; k < 16; k++) {
    const angle = start + k * Math.PI / 8;
    const length = random.range(6, 11);
    if (random.next() < 0.35) continue;
    const at = { x: location.x + Math.cos(angle) * 50, z: location.z + Math.sin(angle) * 50 };
    // Local Z along the ring's tangent (-sin a, cos a).
    const fence = box(`${location.id}-fence-${k}`, at.x, at.z, V3_FENCE.thickness / 2, length / 2, Math.atan2(-Math.sin(angle), Math.cos(angle)),
      V3_FENCE.height, V3_FENCE.model, 0);
    if (fits(place, fence, { ...FENCE_RULES, own: 14 }, location)) place.add(fence);
  }
}

/** The military posts' four circular footings carry timber watch towers; their collision is unchanged. */
function campTowers(world: WorldBlueprint): void {
  const size = V3_BUILDINGS['kit-camp-tower'];
  for (const o of world.obstacles) {
    if (!world.sites.some(site => o.id.startsWith(`${site.id}-wall-`))) continue;
    if (o.shape || Math.abs(o.radius - size.width / 2) > 1e-9) throw new Error(`${o.id} is not a camp tower footing`);
    o.model = 'kit-camp-tower';
    o.height = size.height;
  }
}

/**
 * Remains in the wilds beside the roads: giant skulls and ribcages in the Ash Steppe and Hollowvale, troll gibbets on
 * the Frostspine roads, and standing stones in Greenmarch. `along` lays a piece's length along the road; otherwise its
 * length points at the road. Either way its front (local +X, or +Z for a piece facing the road) is towards the road.
 */
const REMAINS: readonly { model: V3PropModel; road: readonly [string, string]; along: boolean }[] = [
  { model: 'prop-giant-skull', road: ['ash-cairn', 'glass-quarry'], along: false },
  { model: 'prop-giant-skull', road: ['name-well', 'hollow-village'], along: false },
  { model: 'prop-giant-ribs', road: ['cinderwell', 'glass-quarry'], along: true },
  { model: 'prop-giant-ribs', road: ['southwest-turn', 'ash-cairn'], along: true },
  { model: 'prop-troll-gibbet', road: ['high-pass', 'old-fort'], along: true },
  { model: 'prop-troll-gibbet', road: ['star-monastery', 'frozen-beacon'], along: true },
  { model: 'prop-standing-stones', road: ['greenhollow', 'thornwatch'], along: true },
];

function remains(place: Placement, seed: string): void {
  const world = place.world;
  const random = stream(`korovany2:v3:${seed}:remains`);
  const node = (id: string): Vec2 => world.roads.nodes.find(n => n.id === id)!;
  const rules: Rules = { road: 5, location: 40, site: COMBAT_YARD, obstacle: 3, structure: 2 };
  REMAINS.forEach((spec, index) => {
    const a = node(spec.road[0]), b = node(spec.road[1]);
    const length = distance(a, b);
    const d = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
    const n = { x: d.z, z: -d.x };
    const size = V3_PROPS[spec.model];
    const reach = 'radius' in size ? size.radius : (spec.along ? size.width : size.length) / 2;
    const first = random.next() < 0.5 ? 1 : -1;
    for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
      for (const side of [first, -first]) {
        const offset = 4 + 8 + reach + random.range(0, 5);
        const at = { x: a.x + d.x * length * t + n.x * side * offset, z: a.z + d.z * length * t + n.z * side * offset };
        // Along: local Z along the road and local +X, (cos h, -sin h) = (d.z, -d.x) at h = atan2(d.x, d.z), towards it.
        const heading = spec.along ? Math.atan2(d.x, d.z) + (side > 0 ? Math.PI : 0) : Math.atan2(-side * n.x, -side * n.z);
        const piece = prop(`remains-${index}`, spec.model, at, heading, index);
        if (!fits(place, piece, rules)) continue;
        place.add(piece);
        return;
      }
    }
  });
}

/**
 * Lakes by region, largest first (radii in metres before their bays): a great mere and lesser meres in the Fens, black
 * pools in the dark forests and the Crownlands, tarns among the Frostspine crags, bitter pools on the Ash Steppe and a
 * pond in the Heartlands.
 */
export const LAKES: Readonly<Record<string, readonly { kind: 'mere' | 'pool' | 'tarn'; count: number; radius: readonly [number, number] }[]>> = {
  fenlands: [{ kind: 'mere', count: 1, radius: [32, 42] }, { kind: 'mere', count: 5, radius: [11, 20] }],
  hollowvale: [{ kind: 'pool', count: 2, radius: [20, 30] }],
  greenmarch: [{ kind: 'pool', count: 2, radius: [18, 28] }],
  frostspine: [{ kind: 'tarn', count: 2, radius: [15, 24] }],
  crownlands: [{ kind: 'pool', count: 1, radius: [15, 22] }],
  heartlands: [{ kind: 'pool', count: 1, radius: [11, 15] }],
  ashsteppe: [{ kind: 'pool', count: 2, radius: [10, 15] }],
};
/** Clearances in metres from a lake's shore: road surfaces, place and site edges (sites beyond their combat yard),
 * solids already standing (the mountain ring and crags included), fields, other lakes, the river's banks and the bounds. */
export const LAKE_RULES = { road: 12, location: 20, site: 8, obstacle: 6, field: 6, lake: 24, river: 20, bounds: 24 } as const;
const LAKE_SIDES = 48;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** A lake's shore: a star-shaped polygon round `centre`, stretched and turned, with irregular bays and points. */
function lakeShore(random: ReturnType<typeof stream>, centre: Vec2, radius: number): Vec2[] {
  const stretch = random.range(0.62, 0.95), turn = random.range(0, Math.PI);
  const waves = ([[2, 0.06, 0.16], [3, 0.04, 0.12], [5, 0.02, 0.06], [8, 0.01, 0.03]] as const)
    .map(([m, a0, a1]) => ({ m, a: random.range(a0, a1), phase: random.range(0, Math.PI * 2) }));
  const c = Math.cos(turn), s = Math.sin(turn);
  return Array.from({ length: LAKE_SIDES }, (_, k) => {
    const a = k / LAKE_SIDES * Math.PI * 2;
    const r = radius * (1 + waves.reduce((sum, w) => sum + w.a * Math.sin(w.m * a + w.phase), 0));
    const lx = Math.cos(a) * r, lz = Math.sin(a) * r * stretch;
    return { x: round2(centre.x + lx * c - lz * s), z: round2(centre.z + lx * s + lz * c) };
  });
}

/** Points along a lake's shore at most `step` metres apart. */
function shoreSamples(lake: WorldLake, step: number): Vec2[] {
  const out: Vec2[] = [];
  lake.shore.forEach((a, i) => {
    const b = lake.shore[(i + 1) % lake.shore.length]!;
    const n = Math.max(1, Math.ceil(distance(a, b) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n });
  });
  return out;
}

function fieldCorners(f: WorldField): Vec2[] {
  const c = Math.cos(f.heading), s = Math.sin(f.heading);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({
    x: f.x + u! * f.halfX * c + v! * f.halfZ * s, z: f.z - u! * f.halfX * s + v! * f.halfZ * c }));
}

/** True when a lake keeps LAKE_RULES from everything already in the world. */
function lakeFits(place: Placement, lake: WorldLake): boolean {
  const world = place.world, box = lakeBounds(lake), rules = LAKE_RULES;
  const b = world.bounds;
  if (box.minX < b.minX + rules.bounds || box.maxX > b.maxX - rules.bounds || box.minZ < b.minZ + rules.bounds || box.maxZ > b.maxZ - rules.bounds) return false;
  if (box.maxZ > world.river.minZ - rules.river && box.minZ < world.river.maxZ + rules.river) return false;
  for (const location of world.exploration!.locations) if (lakeClearance(lake, location) < location.radius + rules.location) return false;
  for (const site of world.sites) if (lakeClearance(lake, site) < site.radius + COMBAT_YARD + rules.site) return false;
  for (const node of world.roads.nodes) if (lakeClearance(lake, node) < 0) return false;
  const samples = shoreSamples(lake, 2);
  const span = Math.max(...lake.shore.map(p => distance(p, lake)));
  for (const road of place.roads) {
    if (distance(lake, projectSegment(lake, road.a, road.b)) > span + road.half + rules.road) continue;
    for (const p of samples) if (distance(p, projectSegment(p, road.a, road.b)) < road.half + rules.road) return false;
  }
  if (insideField(world, lake, rules.field)) return false;
  for (const field of world.fields ?? []) {
    if (Math.hypot(field.x - lake.x, field.z - lake.z) > Math.hypot(field.halfX, field.halfZ) + span + rules.field) continue;
    if (fieldCorners(field).some(p => lakeClearance(lake, p) < rules.field)) return false;
    const c = Math.cos(field.heading), s = Math.sin(field.heading);
    if (samples.some(p => {
      const dx = p.x - field.x, dz = p.z - field.z;
      return Math.abs(dx * c - dz * s) < field.halfX + rules.field && Math.abs(dx * s + dz * c) < field.halfZ + rules.field;
    })) return false;
  }
  for (const o of place.near(lake, span + rules.obstacle + 2)) if (lakeClearance(lake, o) < o.radius + rules.obstacle) return false;
  for (const other of world.lakes ?? []) {
    if (lakeClearance(lake, other) < 0 || samples.some(p => lakeClearance(other, p) < rules.lake)) return false;
  }
  return true;
}

/** Lakes and meres, placed after every settlement, castle, remain and crag and before the forests and forest floor; in
 * the dark forests a pool lies in a glade (low woodland noise), so the dense cores stay whole. */
function lakes(place: Placement, seed: string): void {
  const world = place.world;
  const random = stream(`korovany2:v3:${seed}:lakes`);
  const noiseSeed = seedNumber(`korovany2:v3:${seed}:forest`);
  for (const region of world.exploration!.regions) {
    const plans = Object.hasOwn(LAKES, region.id) ? LAKES[region.id]! : [];
    const woods = WOODLAND[region.id];
    const rb = region.bounds;
    // Dark forests: candidate centres come from the region's glades, scanned on a 10 m grid.
    const glades: Vec2[] = [];
    if (plans.length && woods && woods.density >= 0.6) {
      for (let z = rb.minZ + 5; z < rb.maxZ; z += 10) for (let x = rb.minX + 5; x < rb.maxX; x += 10) {
        if (fbm(x * woods.scale, z * woods.scale, noiseSeed, 4) <= 1 - woods.density + 0.08) glades.push({ x, z });
      }
      if (!glades.length) continue;
    }
    let made = 0;
    for (const plan of plans) {
      let placed = 0;
      for (let attempt = 0; attempt < 160 && placed < plan.count; attempt++) {
        const radius = random.range(plan.radius[0], plan.radius[1]);
        const glade = glades.length ? glades[Math.floor(random.next() * glades.length)]! : undefined;
        const centre = glade ? { x: round2(glade.x + random.range(-5, 5)), z: round2(glade.z + random.range(-5, 5)) }
          : { x: round2(random.range(rb.minX + radius, rb.maxX - radius)), z: round2(random.range(rb.minZ + radius, rb.maxZ - radius)) };
        const lake: WorldLake = { id: `lake-${region.id}-${made}`, kind: plan.kind, x: centre.x, z: centre.z, shore: lakeShore(random, centre, radius) };
        if (!lakeFits(place, lake)) continue;
        world.lakes!.push(lake);
        placed++;
        made++;
      }
    }
  }
}

/**
 * The sea off the Salt Coast: east of a shore of shingle bays and low points 20-40 m inside the bounds (never closer than
 * 2 m to them along the coast), its ends turning out past the bounds in the 12 m beyond the coast, where the mountain
 * ring takes over. Places, sites, roads, fields and every solid stay on dry land: the shore swings seaward round them.
 * The polygon closes along a line 12 m beyond the bounds.
 */
export const SEA = { inside: 30, beyond: 12, ends: 12, reach: { location: 18, site: 8, road: 10, obstacle: 6, field: 6 } } as const;

function sea(place: Placement, seed: string): void {
  const world = place.world;
  const region = world.exploration!.regions.find(r => r.id === 'saltcoast');
  if (!region) return;
  const random = stream(`korovany2:v3:${seed}:sea`);
  const edge = world.bounds.maxX, out = edge + SEA.beyond;
  const coast = region.bounds, z0 = coast.minZ - SEA.ends, z1 = coast.maxZ + SEA.ends;
  // Dry land: everything within reach of the shore's band must stay west of it.
  const keep: { x: number; z: number; reach: number }[] = [];
  const band = (p: Vec2): boolean => p.x > edge - 140 && p.z > z0 - 60 && p.z < z1 + 60;
  for (const l of world.exploration!.locations) if (band(l)) keep.push({ x: l.x, z: l.z, reach: l.radius + SEA.reach.location });
  for (const s of world.sites) if (band(s)) keep.push({ x: s.x, z: s.z, reach: s.radius + COMBAT_YARD + SEA.reach.site });
  for (const o of world.obstacles) if (band(o)) keep.push({ x: o.x, z: o.z, reach: o.radius + SEA.reach.obstacle });
  for (const road of place.roads) {
    const n = Math.ceil(distance(road.a, road.b) / 2);
    for (let k = 0; k <= n; k++) {
      const p = { x: road.a.x + (road.b.x - road.a.x) * k / n, z: road.a.z + (road.b.z - road.a.z) * k / n };
      if (band(p)) keep.push({ x: p.x, z: p.z, reach: road.half + SEA.reach.road });
    }
  }
  for (const f of world.fields ?? []) for (const p of fieldCorners(f)) if (band(p)) keep.push({ x: p.x, z: p.z, reach: SEA.reach.field });
  const phase = [random.range(0, Math.PI * 2), random.range(0, Math.PI * 2), random.range(0, Math.PI * 2)];
  const zs: number[] = [];
  for (let z = z0; z < z1; z += 3) zs.push(z);
  zs.push(z1);
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const shore = zs.map(z => {
    let x = edge - SEA.inside + 8 * Math.sin(z / 41 + phase[0]!) + 4.5 * Math.sin(z / 17 + phase[1]!) + 2 * Math.sin(z / 6.5 + phase[2]!);
    // Headlands round whatever must stay dry, sloping back to the shore line at about 30 degrees.
    for (const k of keep) {
      const dz = Math.abs(z - k.z);
      if (dz < k.reach) x = Math.max(x, k.x + Math.sqrt(k.reach * k.reach - dz * dz));
      x = Math.max(x, k.x + k.reach - 0.6 * Math.max(0, dz - k.reach * 0.5));
    }
    const end = Math.max(smooth(Math.min(1, Math.max(0, (z - coast.maxZ) / SEA.ends))), smooth(Math.min(1, Math.max(0, (coast.minZ - z) / SEA.ends))));
    x = Math.min(z >= coast.minZ && z <= coast.maxZ ? edge - 2 : out - 1, x + (out - x) * end);
    return { x: round2(z === z0 || z === z1 ? out : x), z: round2(z) };
  });
  const middle = shore[Math.floor(shore.length / 2)]!;
  world.lakes!.push({ id: 'sea', kind: 'sea', x: round2((middle.x + out) / 2), z: middle.z, shore });
}

/** Monster lairs by region: grave-wolf dens in the glades of the dark forests of Greenmarch and Hollowvale. */
export const LAIRS: Readonly<Record<string, readonly { species: MonsterSpecies; count: number }[]>> = {
  greenmarch: [{ species: 'wolf', count: 3 }],
  hollowvale: [{ species: 'wolf', count: 3 }],
};
/**
 * A lair is an open clearing of `radius` metres. Its centre keeps `settled` metres from the edges of settlements, inns,
 * and chapel shrines (beyond a pack's 35 m leash and 16 m aggro), `location` from every other story location, `site`
 * from military sites and homes, `road` from road surfaces (a pack roams 25 m, so it is sometimes seen from the road),
 * `lake` from water, `lair` from other lairs and `bounds` from the world's edge.
 */
export const LAIR_RULES = { radius: 10, settled: 100, location: 60, site: 100, road: 22, lake: 14, lair: 120, bounds: 60 } as const;

function lairFits(place: Placement, lair: WorldLair): boolean {
  const world = place.world, rules = LAIR_RULES, b = world.bounds;
  if (lair.x < b.minX + rules.bounds || lair.x > b.maxX - rules.bounds || lair.z < b.minZ + rules.bounds || lair.z > b.maxZ - rules.bounds) return false;
  if (lair.z > world.river.minZ - rules.lake && lair.z < world.river.maxZ + rules.lake) return false;
  for (const location of world.exploration!.locations) {
    const settled = location.kind === 'settlement' || location.kind === 'inn' || CHAPEL_SHRINES.has(location.id);
    if (distance(lair, location) - location.radius < (settled ? rules.settled : rules.location)) return false;
  }
  for (const site of world.sites) if (distance(lair, site) - site.radius < rules.site) return false;
  for (const road of place.roads) if (distance(lair, projectSegment(lair, road.a, road.b)) - road.half < rules.road) return false;
  for (const lake of world.lakes ?? []) if (lakeClearance(lake, lair) < rules.lake) return false;
  for (const other of world.lairs ?? []) if (distance(lair, other) < rules.lair) return false;
  if (insideField(world, lair, lair.radius + 4)) return false;
  for (const o of place.near(lair, lair.radius + 12)) if (obstacleClearance(o, lair) < lair.radius + 2) return false;
  return true;
}

/** Lairs, placed after the lakes and before the forests, in the glades of their regions' woodland (low woodland noise on
 * a 10 m grid), so the dense cores stay whole and the trees grow round each clearing; where a region has too few
 * fitting glades, a lair may lie anywhere in it, its clearing cut out of the forest. */
function lairs(place: Placement, seed: string): void {
  const world = place.world;
  const random = stream(`korovany2:v3:${seed}:lairs`);
  const noiseSeed = seedNumber(`korovany2:v3:${seed}:forest`);
  for (const region of world.exploration!.regions) {
    const plans = Object.hasOwn(LAIRS, region.id) ? LAIRS[region.id]! : [];
    const woods = WOODLAND[region.id];
    if (!plans.length || !woods) continue;
    const rb = region.bounds;
    const glades: Vec2[] = [], anywhere: Vec2[] = [];
    for (let z = rb.minZ + 5; z < rb.maxZ; z += 10) for (let x = rb.minX + 5; x < rb.maxX; x += 10) {
      anywhere.push({ x, z });
      if (fbm(x * woods.scale, z * woods.scale, noiseSeed, 4) <= 1 - woods.density + 0.08) glades.push({ x, z });
    }
    let made = 0;
    for (const plan of plans) {
      let placed = 0;
      for (let attempt = 0; attempt < 400 && placed < plan.count; attempt++) {
        const spots = attempt < 200 && glades.length ? glades : anywhere;
        const spot = spots[Math.floor(random.next() * spots.length)]!;
        const lair: WorldLair = { id: `lair-${region.id}-${made}`, species: plan.species, radius: LAIR_RULES.radius,
          x: round2(spot.x + random.range(-4, 4)), z: round2(spot.z + random.range(-4, 4)) };
        if (!lairFits(place, lair)) continue;
        world.lairs!.push(lair);
        den(place, lair, random);
        placed++;
        made++;
      }
    }
  }
}

/** A den on a lair clearing's rim: a fallen black pine lying along it and two mossy boulders, a third of the way round
 * from each other, all beyond the 6 m where a pack appears. */
function den(place: Placement, lair: WorldLair, random: ReturnType<typeof stream>): void {
  const start = random.range(0, Math.PI * 2);
  const log = V3_PROPS['wood-log'], s = random.range(0.75, 0.95), a = start;
  place.add({ ...box(`${lair.id}-den-0`, round2(lair.x + Math.sin(a) * 8.2), round2(lair.z + Math.cos(a) * 8.2), log.width / 2 * s,
    log.length / 2 * s, a + Math.PI / 2, log.height * s, 'wood-log', Math.floor(random.next() * 4)), kind: 'rock' });
  for (let k = 1; k <= 2; k++) {
    const b = start + k * 2.1 + random.range(-0.3, 0.3), rock = V3_PROPS['rock-mossy'], r = random.range(0.9, 1.2);
    place.add({ id: `${lair.id}-den-${k}`, kind: 'rock', x: round2(lair.x + Math.sin(b) * 8.4), z: round2(lair.z + Math.cos(b) * 8.4),
      radius: rock.radius * r, height: rock.height * r, variant: Math.floor(random.next() * 4), model: 'rock-mossy' });
  }
}

/** Lone trees across the open land, by region: gnarled oaks over the farms, dead birches in the fens, wind-killed oaks
 * on the coast, dead trees on the ash, pines on the Frostspine slopes. */
const SOLITARY: Readonly<Record<string, { count: number; species: [V3TreeSpecies, number][] }>> = {
  heartlands: { count: 60, species: [['tree-twistedoak', 3], ['tree-deadoak', 2], ['tree-birch', 1]] },
  crownlands: { count: 50, species: [['tree-twistedoak', 2], ['tree-deadoak', 2], ['tree-spruce', 1]] },
  fenlands: { count: 70, species: [['tree-deadbirch', 3], ['tree-deadoak', 1], ['tree-birch', 1]] },
  saltcoast: { count: 35, species: [['tree-deadoak', 3], ['tree-twistedoak', 1]] },
  ashsteppe: { count: 45, species: [['tree-deadoak', 3], ['tree-deadbirch', 2]] },
  frostspine: { count: 60, species: [['tree-blackpine', 3], ['tree-spruce', 2], ['tree-deadoak', 1]] },
};

function solitaryTrees(place: Placement, seed: string): void {
  const world = place.world;
  const random = stream(`korovany2:v3:${seed}:solitary`);
  const rules: Rules = { road: 4, location: 30, site: 30, obstacle: 4, structure: 4 };
  for (const region of world.exploration!.regions) {
    const plan = Object.hasOwn(SOLITARY, region.id) ? SOLITARY[region.id]! : undefined;
    if (!plan) continue;
    let placed = 0;
    for (let attempt = 0; attempt < plan.count * 12 && placed < plan.count; attempt++) {
      const b = region.bounds;
      const p = { x: random.range(b.minX + 8, b.maxX - 8), z: random.range(b.minZ + 8, b.maxZ - 8) };
      if (insideField(world, p, 3)) continue;
      const species = weighted(random, plan.species);
      const spec = V3_TREES[species];
      const t = random.next();
      const tree: Obstacle = { id: `lone-${region.id}-${placed}`, kind: 'tree', x: p.x, z: p.z,
        radius: spec.radius[0] + (spec.radius[1] - spec.radius[0]) * t, height: spec.height[0] + (spec.height[1] - spec.height[0]) * (0.5 + 0.5 * t),
        variant: Math.floor(random.next() * spec.variants), model: species };
      if (!fits(place, tree, rules)) continue;
      place.add(tree);
      placed++;
    }
  }
}

/** A W3 crag: a fixed-size rock formation colliding as the circle of its talus. */
function crag(id: string, model: V3BuildingModel, at: Vec2, variant = 0): Obstacle {
  const size = V3_BUILDINGS[model];
  return { id, kind: 'rock', x: at.x, z: at.z, radius: size.width / 2, height: size.height, variant, model };
}

/** The style of the mountain ring by region; the Salt Coast stays open to the sea. */
export const RING_STYLE: Readonly<Record<string, CragStyle>> = {
  frostspine: 'snow', crownlands: 'snow', hollowvale: 'moss', greenmarch: 'moss', ashsteppe: 'bare', fenlands: 'moss', heartlands: 'moss',
};

/**
 * The mountain ring that replaces the world's invisible edge: crags overlapping into a wall along every edge but the
 * Salt Coast's, their centres a little inside the bounds (the presentation adds far mountains behind them). It keeps
 * 10 m from the roads and 8 m from every place's radius, and leaves the river's mouth open.
 */
function mountainRing(place: Placement, seed: string): void {
  const world = place.world;
  const random = stream(`korovany2:v3:${seed}:ring`);
  const { minX, maxX, minZ, maxZ } = world.bounds;
  const sides = [
    { a: { x: minX, z: maxZ }, b: { x: maxX, z: maxZ }, inward: { x: 0, z: -1 } },
    { a: { x: maxX, z: maxZ }, b: { x: maxX, z: minZ }, inward: { x: -1, z: 0 } },
    { a: { x: maxX, z: minZ }, b: { x: minX, z: minZ }, inward: { x: 0, z: 1 } },
    { a: { x: minX, z: minZ }, b: { x: minX, z: maxZ }, inward: { x: 1, z: 0 } },
  ];
  const clear = (o: Obstacle): boolean => place.roadClearance(o) >= 10 && riverClear(world, o, 4)
    && world.exploration!.locations.every(l => obstacleClearance(o, l) >= l.radius + 8)
    && world.sites.every(s => obstacleClearance(o, s) >= s.radius + 8)
    && place.near(o, o.radius + 4).every(other => other.id.startsWith('ring-') || !shapesOverlap(o, other, 2));
  let index = 0;
  const turns: Record<CragStyle, number> = { moss: 0, snow: 0, bare: 0 };
  for (const side of sides) {
    const length = distance(side.a, side.b);
    const d = { x: (side.b.x - side.a.x) / length, z: (side.b.z - side.a.z) / length };
    let along = random.range(0, 8);
    while (along < length) {
      const edge = { x: side.a.x + d.x * along, z: side.a.z + d.z * along };
      const region = regionAt(world, { x: edge.x + side.inward.x * 5, z: edge.z + side.inward.z * 5 });
      const style = region && Object.hasOwn(RING_STYLE, region.id) ? RING_STYLE[region.id]! : undefined;
      if (!style) {
        along += 10;
        continue;
      }
      const shape = turns[style] % 4;
      const model = crags(style)[shape]!;
      const r = V3_BUILDINGS[model].width / 2;
      let placed = false;
      for (const inset of [random.range(0.15, 0.5), 0]) {
        const at = { x: edge.x + side.inward.x * inset * r, z: edge.z + side.inward.z * inset * r };
        // Ring crags may overlap each other (a continuous wall), never anything else.
        const piece = crag(`ring-${index}`, model, at, index);
        if (!clear(piece)) continue;
        place.add(piece);
        placed = true;
        turns[style]++;
        break;
      }
      index++;
      along += placed ? r * random.range(0.65, 0.9) : 6;
    }
  }
}

/** Crag clusters: the Frostspine massifs, and scattered outcrops in the forests, the Ash Steppe and the north. */
const OUTCROPS: Readonly<Record<string, { style: CragStyle; clusters: number; size: readonly [number, number] }>> = {
  frostspine: { style: 'snow', clusters: 9, size: [3, 6] },
  crownlands: { style: 'snow', clusters: 2, size: [1, 3] },
  hollowvale: { style: 'moss', clusters: 4, size: [1, 3] },
  greenmarch: { style: 'moss', clusters: 5, size: [1, 3] },
  ashsteppe: { style: 'bare', clusters: 5, size: [1, 3] },
  fenlands: { style: 'moss', clusters: 1, size: [1, 2] },
};

function massifs(place: Placement, seed: string): void {
  const world = place.world;
  const random = stream(`korovany2:v3:${seed}:massifs`);
  const rules: Rules = { road: 14, location: 46, site: 40, obstacle: 4, structure: 6 };
  for (const region of world.exploration!.regions) {
    const plan = Object.hasOwn(OUTCROPS, region.id) ? OUTCROPS[region.id]! : undefined;
    if (!plan) continue;
    let made = 0;
    for (let attempt = 0; attempt < 120 && made < plan.clusters; attempt++) {
      const b = region.bounds;
      const centre = { x: random.range(b.minX + 30, b.maxX - 30), z: random.range(b.minZ + 30, b.maxZ - 30) };
      const count = Math.round(random.range(plan.size[0], plan.size[1]));
      const pieces: Obstacle[] = [];
      for (let k = 0; k < count; k++) {
        const model = crags(plan.style)[Math.floor(random.next() * 4)]!;
        const r = V3_BUILDINGS[model].width / 2;
        const a = random.range(0, Math.PI * 2), reach = k === 0 ? 0 : random.range(0.6, 1.1) * (r + 8);
        pieces.push(crag(`crag-${region.id}-${made}-${k}`, model, { x: centre.x + Math.cos(a) * reach, z: centre.z + Math.sin(a) * reach }, k));
      }
      // A massif's crags may overlap each other, never anything else.
      if (!pieces.every(piece => fits(place, piece, rules))) continue;
      for (const piece of pieces) place.add(piece);
      made++;
    }
  }
}

/** How much forest floor each region's woodland cores get (fallen logs, stumps and mossy boulders). */
const FLOOR: Readonly<Record<string, number>> = {
  greenmarch: 1, hollowvale: 1, fenlands: 0.35, frostspine: 0.4, heartlands: 0.25, crownlands: 0.25, saltcoast: 0.1, ashsteppe: 0.15,
};

/** A forest-floor piece in a woodland core: `pick` chooses a fallen log (a box along local Z), a stump or a mossy boulder. */
function floorPiece(id: string, p: Vec2, model: 'wood-log' | 'wood-stump' | 'rock-mossy', random: ReturnType<typeof stream>): Obstacle {
  const s = model === 'wood-log' ? random.range(0.6, 1.0) : random.range(0.7, 1.15), variant = Math.floor(random.next() * 4);
  if (model === 'wood-log') {
    const spec = V3_PROPS['wood-log'];
    return { ...box(id, p.x, p.z, spec.width / 2 * s, spec.length / 2 * s, random.range(0, Math.PI * 2), spec.height * s, model, variant), kind: 'rock' };
  }
  const spec = V3_PROPS[model];
  return { id, kind: 'rock', x: p.x, z: p.z, radius: spec.radius * s, height: spec.height * s, variant, model };
}

/** Random points in woodland cores, weighted by each region's share of forest floor. */
function* coreSpots(world: WorldBlueprint, seed: string, random: ReturnType<typeof stream>, attempts: number): Generator<Vec2> {
  const noiseSeed = seedNumber(`korovany2:v3:${seed}:forest`);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const p = { x: random.range(-478, 478), z: random.range(-478, 478) };
    const region = regionAt(world, p);
    const woods = WOODLAND[region?.id ?? 'heartlands']!;
    const depth = (fbm(p.x * woods.scale, p.z * woods.scale, noiseSeed, 4) - (1 - woods.density)) / 0.18;
    if (depth < 0.3 || random.next() > (FLOOR[region?.id ?? 'heartlands'] ?? 0.2)) continue;
    if (insideField(world, p, 2)) continue;
    yield p;
  }
}

/** Every forest-floor piece keeps at least 1.6 m from any other solid, so the hero (1.4 m across) always passes. */
const FLOOR_RULES: Rules = { road: 2.5, location: 26, site: 24, obstacle: 1.6, structure: 3 };

/** Fallen black pines, laid in woodland cores before the trees grow round them. */
function fallenLogs(place: Placement, seed: string): void {
  const random = stream(`korovany2:v3:${seed}:logs`);
  let placed = 0;
  for (const p of coreSpots(place.world, seed, random, 6000)) {
    if (placed >= 160) break;
    const piece = floorPiece(`log-${placed}`, p, 'wood-log', random);
    if (!fits(place, piece, FLOOR_RULES)) continue;
    place.add(piece);
    placed++;
  }
}

/** Broken stumps and mossy boulders in the gaps between the trees of woodland cores. */
function forestFloor(place: Placement, seed: string): void {
  const random = stream(`korovany2:v3:${seed}:floor`);
  let placed = 0;
  for (const p of coreSpots(place.world, seed, random, 24000)) {
    if (placed >= 1100) break;
    const piece = floorPiece(`floor-${placed}`, p, random.next() < 0.6 ? 'wood-stump' : 'rock-mossy', random);
    if (!fits(place, piece, FLOOR_RULES)) continue;
    place.add(piece);
    placed++;
  }
}

/**
 * Version 3: the v2 geography, regions, locations, roads, river, bridges, sites and story stay; every place is rebuilt
 * at the heroic scale. Settlements and inns get their region's building family with yards, stalls and fields; the Reed
 * Chapel and the Star Monastery are rebuilt round chapels; the Royal Citadel and the Old Fort become castles; ruins,
 * shrines and landmarks are rebuilt round their cooked landmarks; the military posts get watch towers; remains of huge
 * creatures lie in the wilds; a ring of mountains closes the world (but for the coast), crags rise in massifs and
 * outcrops, lakes and the sea lie where nothing else stands, grave wolves den in the dark forests' glades, and woodland
 * becomes real forest, dark and dense in Greenmarch and Hollowvale, over fallen trunks, stumps and mossy boulders.
 */
export function buildWorldV3(world: WorldBlueprint): WorldBlueprint {
  const locations = world.exploration!.locations;
  const byId = (id: string): WorldLocation => locations.find(l => l.id === id)!;
  const settled = new Set(locations.filter(l => ((l.kind === 'settlement' || l.kind === 'inn') && l.id !== 'old-fort')
    || CHAPEL_SHRINES.has(l.id)).map(l => l.id));
  world.version = 3;
  world.id = '';
  world.fields = [];
  world.decor = [];
  world.lakes = [];
  world.lairs = [];
  world.obstacles = world.obstacles.filter(o => {
    if (o.kind !== 'wall') return false;
    // The original home's walls have no home in story worlds (homes move to each faction's location), and the Old
    // Fort's v2 perimeter gives way to its castle.
    if (o.id.startsWith('home-wall-') || o.id.startsWith('old-fort-wall-')) return false;
    const owner = ownerOf(world, o);
    return !owner || (Object.hasOwn(LANDMARKS, owner.id) && LANDMARKS[owner.id]!.variants.includes(o.variant));
  });
  const roads = roadSegments(world);
  growLandmarks(world, roads);
  campTowers(world);
  const place = new Placement(world, roads);
  fortification(place, byId('palace-citadel'), citadelPlan(byId('palace-citadel')));
  fortification(place, byId('old-fort'), ringFortPlan(world, byId('old-fort'), 30, 16.5));
  for (const location of locations) if (settled.has(location.id)) layoutSettlement(place, location, world.seed);
  for (const location of locations) {
    const pieces = Object.hasOwn(CLUSTERS, location.id) ? CLUSTERS[location.id] : undefined;
    if (pieces) cluster(place, location, world.seed, pieces);
  }
  orchard(place, byId('old-orchard'), world.seed);
  roadsideProps(place, world.seed);
  remains(place, world.seed);
  sea(place, world.seed);
  mountainRing(place, world.seed);
  massifs(place, world.seed);
  lakes(place, world.seed);
  lairs(place, world.seed);
  fallenLogs(place, world.seed);
  vegetation(place, world.seed);
  solitaryTrees(place, world.seed);
  forestFloor(place, world.seed);
  boulders(place, world.seed);
  let hash = 2166136261;
  for (const c of JSON.stringify(world)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  world.id = `k2-v3-${(hash >>> 0).toString(16)}`;
  return world;
}


