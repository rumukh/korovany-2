import { createPrng } from '@aegis/core';
import type { Bounds, Obstacle, RoadNode, Vec2, WorldBlueprint, WorldLake, WorldVersion } from './types';
import { expandWorld } from './world-expansion';
import { buildWorldV3 } from './world-v3';

export function normalizeSeed(seed: string | number): string {
  if ((typeof seed !== 'string' && typeof seed !== 'number') ||
      (typeof seed === 'number' && !Number.isSafeInteger(seed))) {
    throw new Error('Campaign seed must be a string or safe integer');
  }
  const result = String(seed).trim();
  if (!result || result.length > 80) throw new Error('Campaign seed must contain 1-80 characters');
  return result;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function projectSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return { x: a.x + t * dx, z: a.z + t * dz };
}

function inside(p: Vec2, r: Bounds, margin = 0): boolean {
  return p.x >= r.minX + margin && p.x <= r.maxX - margin &&
    p.z >= r.minZ + margin && p.z <= r.maxZ - margin;
}

export function isWalkable(world: WorldBlueprint, p: Vec2, radius = 0.65): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(radius) || radius < 0) return false;
  if (!inside(p, world.bounds, radius)) return false;
  const water = world.river;
  if (p.z + radius > water.minZ && p.z - radius < water.maxZ &&
      p.x + radius > water.minX && p.x - radius < water.maxX &&
      !world.bridges.some(b => p.x >= b.minX + radius && p.x <= b.maxX - radius &&
        p.z >= b.minZ - radius && p.z <= b.maxZ + radius)) return false;
  // Lakes are water like the river (only version 3 worlds have any).
  if (world.lakes && inLake(world, p, radius)) return false;
  if (world.version === 3) return !blockedV3(world, p, radius);
  return !world.obstacles.some(o => distance(p, o) < radius + o.radius);
}

const lakeBoxes = new WeakMap<WorldLake, Bounds>();

/** A lake's shore bounding box, cached per (immutable) lake. */
export function lakeBounds(lake: WorldLake): Bounds {
  let box = lakeBoxes.get(lake);
  if (!box) {
    box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const p of lake.shore) {
      box.minX = Math.min(box.minX, p.x); box.maxX = Math.max(box.maxX, p.x);
      box.minZ = Math.min(box.minZ, p.z); box.maxZ = Math.max(box.maxZ, p.z);
    }
    lakeBoxes.set(lake, box);
  }
  return box;
}

/**
 * Signed distance from `p` to a lake's shore, negative in the water: exact for the shore polygon (the nearest edge, and a
 * crossing-number test for the side).
 */
export function lakeClearance(lake: WorldLake, p: Vec2): number {
  const shore = lake.shore;
  let wet = false, best = Infinity;
  for (let i = 0, j = shore.length - 1; i < shore.length; j = i++) {
    const a = shore[i]!, b = shore[j]!;
    if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) wet = !wet;
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    const ex = p.x - a.x - dx * t, ez = p.z - a.z - dz * t;
    best = Math.min(best, ex * ex + ez * ez);
  }
  return wet ? -Math.sqrt(best) : Math.sqrt(best);
}

/** True when a body of `radius` at `p` would reach into a lake. */
function inLake(world: WorldBlueprint, p: Vec2, radius: number): boolean {
  for (const lake of world.lakes ?? []) {
    const box = lakeBounds(lake);
    if (p.x < box.minX - radius || p.x > box.maxX + radius || p.z < box.minZ - radius || p.z > box.maxZ + radius) continue;
    if (lakeClearance(lake, p) < radius) return true;
  }
  return false;
}

/**
 * Distance from `p` to an obstacle's solid boundary, negative inside. Circles keep the v1/v2 rule exactly; version 3
 * boxes use the exact rectangle.
 */
export function obstacleClearance(o: Obstacle, p: Vec2): number {
  if (!o.shape) return distance(p, o) - o.radius;
  const dx = p.x - o.x, dz = p.z - o.z;
  const c = Math.cos(o.shape.heading), s = Math.sin(o.shape.heading);
  const qx = Math.abs(dx * c - dz * s) - o.shape.halfX;
  const qz = Math.abs(dx * s + dz * c) - o.shape.halfZ;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
}

/** Shortest distance between segment a-b and an obstacle's solid boundary (0 when they touch or cross). */
export function segmentClearance(o: Obstacle, a: Vec2, b: Vec2): number {
  if (!o.shape) return Math.max(0, distance(o, projectSegment(o, a, b)) - o.radius);
  const c = Math.cos(o.shape.heading), s = Math.sin(o.shape.heading);
  const local = (p: Vec2): Vec2 => {
    const dx = p.x - o.x, dz = p.z - o.z;
    return { x: dx * c - dz * s, z: dx * s + dz * c };
  };
  const la = local(a), lb = local(b), hx = o.shape.halfX, hz = o.shape.halfZ;
  // Liang-Barsky clip against the rectangle: any surviving interval means the segment crosses it.
  let t0 = 0, t1 = 1;
  const dx = lb.x - la.x, dz = lb.z - la.z;
  const clips: [number, number][] = [[-dx, la.x + hx], [dx, hx - la.x], [-dz, la.z + hz], [dz, hz - la.z]];
  let crosses = true;
  for (const [p, q] of clips) {
    if (p === 0) { if (q < 0) { crosses = false; break; } continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) { crosses = false; break; } if (t > t0) t0 = t; }
    else { if (t < t0) { crosses = false; break; } if (t < t1) t1 = t; }
  }
  if (crosses) return 0;
  // Separated convex shapes: the closest pair includes a segment end or a rectangle corner.
  const pointBox = (p: Vec2): number => Math.hypot(Math.max(Math.abs(p.x) - hx, 0), Math.max(Math.abs(p.z) - hz, 0));
  let best = Math.min(pointBox(la), pointBox(lb));
  for (const corner of [{ x: hx, z: hz }, { x: -hx, z: hz }, { x: hx, z: -hz }, { x: -hx, z: -hz }]) {
    best = Math.min(best, distance(corner, projectSegment(corner, la, lb)));
  }
  return best;
}

/** Bodies wider than this fall back to the exhaustive v3 scan; every current body radius is at most 1.5 m. */
const GRID_REACH = 2;
const GRID_CELL = 16;
interface ObstacleGrid { minX: number; minZ: number; columns: number; rows: number; cells: number[][]; count: number }
const obstacleGrids = new Map<string, ObstacleGrid>();

function buildGrid(world: WorldBlueprint): ObstacleGrid {
  const { minX, minZ, maxX, maxZ } = world.bounds;
  const columns = Math.max(1, Math.ceil((maxX - minX) / GRID_CELL)), rows = Math.max(1, Math.ceil((maxZ - minZ) / GRID_CELL));
  const cells: number[][] = Array.from({ length: columns * rows }, () => []);
  world.obstacles.forEach((o, index) => {
    const reach = o.radius + GRID_REACH;
    const x0 = Math.max(0, Math.floor((o.x - reach - minX) / GRID_CELL)), x1 = Math.min(columns - 1, Math.floor((o.x + reach - minX) / GRID_CELL));
    const z0 = Math.max(0, Math.floor((o.z - reach - minZ) / GRID_CELL)), z1 = Math.min(rows - 1, Math.floor((o.z + reach - minZ) / GRID_CELL));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cells[z * columns + x]!.push(index);
  });
  return { minX, minZ, columns, rows, cells, count: world.obstacles.length };
}

/**
 * The exact broadphase of a version 3 world, cached by its content-hashed id. Generation-time worlds (empty id) and
 * worlds whose obstacle count no longer matches their cached grid are rebuilt rather than trusted.
 */
export function obstacleGrid(world: WorldBlueprint): ObstacleGrid {
  const cached = world.id ? obstacleGrids.get(world.id) : undefined;
  if (cached && cached.count === world.obstacles.length) return cached;
  const grid = buildGrid(world);
  if (world.id) {
    if (obstacleGrids.size >= 8) obstacleGrids.delete(obstacleGrids.keys().next().value!);
    obstacleGrids.set(world.id, grid);
  }
  return grid;
}

/** Obstacle indices whose solid shape may lie within GRID_REACH of the cells covering x0..x1, z0..z1. */
export function nearbyObstacles(world: WorldBlueprint, x0: number, z0: number, x1: number, z1: number): Obstacle[] {
  const grid = obstacleGrid(world);
  const cx0 = Math.max(0, Math.floor((x0 - grid.minX) / GRID_CELL)), cx1 = Math.min(grid.columns - 1, Math.floor((x1 - grid.minX) / GRID_CELL));
  const cz0 = Math.max(0, Math.floor((z0 - grid.minZ) / GRID_CELL)), cz1 = Math.min(grid.rows - 1, Math.floor((z1 - grid.minZ) / GRID_CELL));
  const found = new Set<number>();
  for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) for (const index of grid.cells[z * grid.columns + x]!) found.add(index);
  return [...found].sort((a, b) => a - b).map(index => world.obstacles[index]!);
}

function blockedV3(world: WorldBlueprint, p: Vec2, radius: number): boolean {
  if (radius > GRID_REACH) return world.obstacles.some(o => obstacleClearance(o, p) < radius);
  const grid = obstacleGrid(world);
  const cx = Math.min(grid.columns - 1, Math.max(0, Math.floor((p.x - grid.minX) / GRID_CELL)));
  const cz = Math.min(grid.rows - 1, Math.max(0, Math.floor((p.z - grid.minZ) / GRID_CELL)));
  // Every obstacle within GRID_REACH of p was inserted into p's cell, so one cell is exact.
  for (const index of grid.cells[cz * grid.columns + cx]!) {
    if (obstacleClearance(world.obstacles[index]!, p) < radius) return true;
  }
  return false;
}

/** Substeps prevent both sprint and dodge from tunnelling through collision. */
export function moveWithCollision(world: WorldBlueprint, body: Vec2, dx: number, dz: number, radius: number): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.25));
  for (let i = 0; i < steps; i++) {
    const x = body.x + dx / steps, z = body.z + dz / steps;
    if (isWalkable(world, { x, z }, radius)) { body.x = x; body.z = z; }
    else {
      if (isWalkable(world, { x, z: body.z }, radius)) body.x = x;
      if (isWalkable(world, { x: body.x, z }, radius)) body.z = z;
    }
  }
}

export function generateWorld(seed: string | number, version: WorldVersion = 2): WorldBlueprint {
  if (version !== 1 && version !== 2 && version !== 3) throw new Error('Unsupported world version');
  const legacy = generateLegacyWorld(seed);
  if (version === 1) return legacy;
  const expanded = expandWorld(legacy);
  return version === 2 ? expanded : buildWorldV3(expanded);
}

// Keep this generator and its serialization order unchanged for existing saves.
function generateLegacyWorld(seed: string | number): WorldBlueprint {
  const text = normalizeSeed(seed);
  const rng = createPrng(`korovany2:world:${text}`);
  const westZ = rng.int(-30, -18), eastZ = rng.int(20, 31), quarryZ = rng.int(21, 33);
  const nodes: RoadNode[] = [
    { id: 'home', x: 0, z: -54 }, { id: 'south', x: 0, z: -24 },
    { id: 'forest', x: -42, z: westZ }, { id: 'raid', x: 42, z: -24 },
    { id: 'bridge-south', x: 0, z: -8 }, { id: 'bridge-north', x: 0, z: 8 },
    { id: 'north', x: 0, z: 26 }, { id: 'palace', x: 42, z: eastZ },
    { id: 'quarry', x: -40, z: quarryZ }, { id: 'fortress', x: 0, z: 55 },
  ];
  const links = [
    ['home', 'south'], ['south', 'forest'], ['south', 'raid'], ['south', 'bridge-south'],
    ['bridge-south', 'bridge-north'], ['bridge-north', 'north'], ['north', 'palace'],
    ['north', 'quarry'], ['north', 'fortress'],
  ] as const;
  const node = (id: string): RoadNode => nodes.find(n => n.id === id)!;
  const bounds = { minX: -70, maxX: 70, minZ: -70, maxZ: 70 };
  const world: WorldBlueprint = {
    version: 1, seed: text, id: '', bounds,
    roads: { nodes, edges: links.map(([from, to]) => ({ from, to, width: 8 })) },
    river: { minX: -70, maxX: 70, minZ: -5, maxZ: 5 },
    bridges: [{ minX: -5, maxX: 5, minZ: -8, maxZ: 8 }],
    sites: [
      { ...node('home'), kind: 'home', faction: 'guard', nameKey: 'site.home', radius: 9 },
      { ...node('forest'), kind: 'outpost', faction: 'elf', nameKey: 'site.forest', radius: 8 },
      { ...node('palace'), kind: 'outpost', faction: 'guard', nameKey: 'site.palace', radius: 8 },
      { ...node('quarry'), kind: 'outpost', faction: 'villain', nameKey: 'site.quarry', radius: 8 },
      { ...node('raid'), kind: 'raid', faction: 'guard', nameKey: 'site.raid', radius: 8 },
      { ...node('fortress'), kind: 'fortress', faction: 'villain', nameKey: 'site.fortress', radius: 11 },
    ],
    biomes: [
      { kind: 'forest', bounds: { minX: -70, maxX: -15, minZ: -70, maxZ: 40 } },
      { kind: 'countryside', bounds: { minX: -15, maxX: 70, minZ: -70, maxZ: 40 } },
      { kind: 'mountains', bounds: { minX: -70, maxX: 70, minZ: 40, maxZ: 70 } },
    ],
    obstacles: [],
  };
  for (let i = 0; i < 420; i++) {
    const p = { x: rng.range(-66, 66), z: rng.range(-66, 66) };
    const kind = p.x < -12 && p.z < 40 ? 'tree' : 'rock';
    const radius = kind === 'tree' ? rng.range(0.6, 1.2) : rng.range(1, 2.4);
    if (Math.abs(p.z) < 10 || world.sites.some(s => distance(p, s) < s.radius + radius + 4) ||
        links.some(([a, b]) => distance(p, projectSegment(p, node(a), node(b))) < 6 + radius) ||
        world.obstacles.some(o => distance(p, o) < o.radius + radius + 1)) continue;
    world.obstacles.push({
      ...p, id: `scenery-${i}`, kind, radius,
      height: kind === 'tree' ? rng.range(5, 10) : rng.range(2, p.z > 40 ? 9 : 4),
      variant: rng.int(0, 4),
    });
  }
  for (const site of world.sites.filter(s => s.kind !== 'raid')) {
    for (const side of [-1, 1]) {
      for (const back of [-1, 1]) {
        world.obstacles.push({
          id: `${site.id}-wall-${side}-${back}`, kind: 'wall',
          x: site.x + side * 6, z: site.z + back * 8, radius: 1.8,
          height: site.kind === 'fortress' ? 7 : site.kind === 'home' ? 3 : 4.5, variant: back + side + 2,
        });
      }
    }
  }
  let hash = 2166136261;
  for (const c of JSON.stringify(world)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  world.id = `k2-v1-${(hash >>> 0).toString(16)}`;
  return world;
}

function nodeRoute(world: WorldBlueprint, start: string, goal: string): { points: Vec2[]; cost: number } {
  const nodes = world.roads.nodes;
  const costs = new Map(nodes.map(n => [n.id, Number.POSITIVE_INFINITY]));
  const previous = new Map<string, string>();
  const unvisited = new Set(nodes.map(n => n.id));
  costs.set(start, 0);
  while (unvisited.size) {
    const current = [...unvisited].sort((a, b) => costs.get(a)! - costs.get(b)!)[0]!;
    if (!Number.isFinite(costs.get(current))) throw new Error('Disconnected road graph');
    unvisited.delete(current);
    if (current === goal) break;
    for (const edge of world.roads.edges) {
      const next = edge.from === current ? edge.to : edge.to === current ? edge.from : null;
      if (!next || !unvisited.has(next)) continue;
      const cost = costs.get(current)! + distance(nodes.find(n => n.id === current)!, nodes.find(n => n.id === next)!);
      if (cost < costs.get(next)!) { costs.set(next, cost); previous.set(next, current); }
    }
  }
  const ids = [goal];
  while (ids[0] !== start) {
    const prev = previous.get(ids[0]!);
    if (!prev) throw new Error(`No road route from ${start} to ${goal}`);
    ids.unshift(prev);
  }
  return { points: ids.map(id => ({ x: nodes.find(n => n.id === id)!.x, z: nodes.find(n => n.id === id)!.z })), cost: costs.get(goal)! };
}

/** Starts at the nearest road segment, avoiding diagonal corner cutting on retarget. */
export function findRoadRoute(world: WorldBlueprint, from: Vec2, destination: string): Vec2[] {
  if (!world.roads.nodes.some(n => n.id === destination)) throw new Error(`Unknown road destination: ${destination}`);
  if (!Number.isFinite(from.x) || !Number.isFinite(from.z)) throw new Error('Invalid road origin');
  const candidates = world.roads.edges.map(edge => {
    const a = world.roads.nodes.find(n => n.id === edge.from)!;
    const b = world.roads.nodes.find(n => n.id === edge.to)!;
    const point = projectSegment(from, a, b);
    return { a, b, point, distance: distance(from, point) };
  }).sort((a, b) => a.distance - b.distance);
  const edge = candidates[0];
  if (!edge || edge.distance > 4) throw new Error('Convoy origin must be on the road graph');
  const a = nodeRoute(world, edge.a.id, destination), b = nodeRoute(world, edge.b.id, destination);
  const route = a.cost + distance(edge.point, edge.a) <= b.cost + distance(edge.point, edge.b) ? a : b;
  return [edge.point, ...route.points].filter((p, i, all) => distance(p, i === 0 ? from : all[i - 1]!) > 0.001);
}
