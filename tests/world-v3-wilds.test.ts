import { describe, expect, test } from 'vitest';
import { generateWorld } from '../src/game';
import type { Obstacle, Vec2, WorldBlueprint } from '../src/game/types';
import { isWalkable, obstacleClearance } from '../src/game/world';
import { crags, RING_STYLE, V3_BUILDINGS, V3_TREES, type CragStyle } from '../src/game/world-v3';
import { farMountains, undergrowth } from '../src/view/scenery-v3';
import { terrainControl } from '../src/view/terrain-mesh';
import { WORLD_SURFACES } from '../src/view/world-assets';

// W3a: the wild lands. A ring of crags closes the world but for the Salt Coast, massifs rise in the Frostspine,
// Greenmarch and Hollowvale become dark forests over a fallen-tree floor, and the open land gets woods and lone trees.
const worlds = ['wilds-a', 'wilds-b', 0].map(seed => generateWorld(seed, 3));
const FLOOR = new Set(['wood-log', 'wood-stump', 'rock-mossy']);
const isCrag = (o: Obstacle): boolean => o.model?.startsWith('rock-crag-') ?? false;

function regionAt(world: WorldBlueprint, p: Vec2): string | undefined {
  return world.exploration!.regions.find(r => p.x >= r.bounds.minX && p.x <= r.bounds.maxX && p.z >= r.bounds.minZ && p.z <= r.bounds.maxZ)?.id;
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
  const t = length === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

/** Gap between two solids' shapes (exact for circles; a box's outline is sampled every 0.25 m). */
function gap(a: Obstacle, b: Obstacle): number {
  if (!a.shape) return obstacleClearance(b, a) - a.radius;
  if (!b.shape) return obstacleClearance(a, b) - b.radius;
  const c = Math.cos(a.shape.heading), s = Math.sin(a.shape.heading);
  let best = Infinity;
  for (const [lx0, lz0, lx1, lz1] of [[1, 1, -1, 1], [-1, 1, -1, -1], [-1, -1, 1, -1], [1, -1, 1, 1]] as const) {
    const length = Math.hypot((lx1 - lx0) * a.shape.halfX, (lz1 - lz0) * a.shape.halfZ);
    for (let t = 0; t <= 1; t += 0.25 / Math.max(0.25, length)) {
      const lx = (lx0 + (lx1 - lx0) * t) * a.shape.halfX, lz = (lz0 + (lz1 - lz0) * t) * a.shape.halfZ;
      best = Math.min(best, obstacleClearance(b, { x: a.x + lx * c + lz * s, z: a.z - lx * s + lz * c }));
    }
  }
  return best;
}

/** The share of walkable cells (hero radius) in a square reached from the first one by a 4-way flood fill. */
function connected(world: WorldBlueprint, x0: number, z0: number, size: number, step = 0.5): { walkable: number; reached: number } {
  const n = Math.round(size / step);
  const walk = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) walk[i * n + j] = isWalkable(world, { x: x0 + j * step, z: z0 + i * step }, 0.7) ? 1 : 0;
  const start = walk.indexOf(1);
  const seen = new Uint8Array(n * n);
  const queue = [start];
  seen[start] = 1;
  let reached = 0;
  while (queue.length) {
    const cell = queue.pop()!;
    reached++;
    const i = Math.floor(cell / n), j = cell % n;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const k = ii * n + jj;
      if (walk[k] && !seen[k]) { seen[k] = 1; queue.push(k); }
    }
  }
  return { walkable: walk.reduce((sum, v) => sum + v, 0), reached };
}

/** The 40 m square of a region (away from its border) with the most trees. */
function densest(world: WorldBlueprint, region: string): { x: number; z: number; trees: number } {
  const bounds = world.exploration!.regions.find(r => r.id === region)!.bounds;
  const cells = new Map<string, number>();
  for (const o of world.obstacles) {
    if (o.kind !== 'tree' || o.x < bounds.minX + 60 || o.x > bounds.maxX - 60 || o.z < bounds.minZ + 60 || o.z > bounds.maxZ - 60) continue;
    const key = `${Math.floor(o.x / 40)}:${Math.floor(o.z / 40)}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const [key, trees] = [...cells.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const [cx, cz] = key.split(':').map(Number);
  return { x: cx! * 40 + 20, z: cz! * 40 + 20, trees };
}

describe('version 3 wild lands', () => {
  test('a ring of crags closes every edge of the world but the Salt Coast', () => {
    for (const world of worlds) {
      const { minX, maxX, minZ, maxZ } = world.bounds;
      const edge: Vec2[] = [];
      for (let t = minX + 2; t < maxX - 2; t += 2) edge.push({ x: t, z: maxZ - 3 }, { x: t, z: minZ + 3 });
      for (let t = minZ + 2; t < maxZ - 2; t += 2) edge.push({ x: minX + 3, z: t }, { x: maxX - 3, z: t });
      const coast = (p: Vec2): boolean => p.x > 0 && regionAt(world, { x: Math.min(p.x, maxX - 1), z: p.z }) === 'saltcoast';
      // The river leaves the world through the ring on the west: its mouth stays open.
      const closed = edge.filter(p => !coast(p) && Math.abs(p.z - (world.river.minZ + world.river.maxZ) / 2) > 30);
      const blocked = closed.filter(p => !isWalkable(world, p, 0.7)).length;
      expect(blocked / closed.length, String(world.seed)).toBeGreaterThanOrEqual(0.98);
      expect(world.obstacles.filter(o => isCrag(o) && o.x > maxX - 60 && regionAt(world, { x: maxX - 1, z: o.z }) === 'saltcoast')).toEqual([]);
    }
  });

  test('crags keep clear of every road, place and military site, and collide as their talus circle', () => {
    for (const world of worlds) {
      const node = new Map(world.roads.nodes.map(n => [n.id, n]));
      for (const o of world.obstacles.filter(isCrag)) {
        expect(o.shape, o.id).toBeUndefined();
        expect(o.radius, o.id).toBeCloseTo(V3_BUILDINGS[o.model as keyof typeof V3_BUILDINGS].width / 2, 9);
        for (const edge of world.roads.edges) {
          const clearance = segmentDistance(o, node.get(edge.from)!, node.get(edge.to)!) - o.radius - edge.width / 2;
          expect(clearance, `${o.id} to ${edge.from}-${edge.to}`).toBeGreaterThanOrEqual(10 - 1e-9);
        }
        for (const place of world.exploration!.locations) expect(obstacleClearance(o, place), `${o.id} to ${place.id}`).toBeGreaterThanOrEqual(place.radius + 8 - 1e-9);
        for (const site of world.sites) expect(obstacleClearance(o, site), `${o.id} to ${site.id}`).toBeGreaterThanOrEqual(site.radius + 8 - 1e-9);
      }
    }
  });

  test('massifs rise in the Frostspine, outcrops in the forests, the steppe and the north, each in its region\'s style', () => {
    for (const world of worlds) {
      const clusters = (region: string): number => new Set(world.obstacles.filter(o => o.id.startsWith(`crag-${region}-`))
        .map(o => o.id.split('-').slice(0, 3).join('-'))).size;
      expect(clusters('frostspine'), String(world.seed)).toBeGreaterThanOrEqual(5);
      for (const region of ['greenmarch', 'hollowvale', 'ashsteppe']) expect(clusters(region), `${world.seed} ${region}`).toBeGreaterThanOrEqual(2);
      const style = (o: Obstacle): CragStyle => o.model!.split('-')[2] as CragStyle;
      for (const o of world.obstacles.filter(o => o.id.startsWith('crag-frostspine-'))) expect(style(o)).toBe('snow');
      for (const o of world.obstacles.filter(o => o.id.startsWith('crag-ashsteppe-'))) expect(style(o)).toBe('bare');
      for (const o of world.obstacles.filter(o => o.id.startsWith('ring-'))) {
        const inside = { x: Math.min(world.bounds.maxX - 1, Math.max(world.bounds.minX + 1, o.x)), z: Math.min(world.bounds.maxZ - 1, Math.max(world.bounds.minZ + 1, o.z)) };
        expect(Object.values(RING_STYLE)).toContain(style(o));
        expect(regionAt(world, inside), o.id).not.toBe('saltcoast');
      }
    }
  });

  test('Greenmarch and Hollowvale are the dark forests: three times denser than any other region, led by black pines', () => {
    for (const world of worlds) {
      const perHectare = new Map<string, number>();
      for (const region of world.exploration!.regions) {
        const b = region.bounds;
        const trees = world.obstacles.filter(o => o.kind === 'tree' && o.x >= b.minX && o.x <= b.maxX && o.z >= b.minZ && o.z <= b.maxZ);
        perHectare.set(region.id, trees.length / ((b.maxX - b.minX) * (b.maxZ - b.minZ) / 1e4));
        if (region.id === 'greenmarch' || region.id === 'hollowvale') {
          const counts = new Map<string, number>();
          for (const tree of trees) counts.set(tree.model!, (counts.get(tree.model!) ?? 0) + 1);
          expect([...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0], `${world.seed} ${region.id}`).toBe('tree-blackpine');
        }
      }
      for (const forest of ['greenmarch', 'hollowvale']) {
        expect(perHectare.get(forest)!, `${world.seed} ${forest}`).toBeGreaterThan(100);
        for (const [region, density] of perHectare) if (region !== 'greenmarch' && region !== 'hollowvale') expect(density, region).toBeLessThan(perHectare.get(forest)! / 3);
      }
    }
  });

  test('the open lands have woods and lone trees', () => {
    for (const world of worlds) {
      for (const region of ['heartlands', 'crownlands', 'fenlands', 'saltcoast', 'ashsteppe', 'frostspine']) {
        const b = world.exploration!.regions.find(r => r.id === region)!.bounds;
        const trees = world.obstacles.filter(o => o.kind === 'tree' && o.x >= b.minX && o.x <= b.maxX && o.z >= b.minZ && o.z <= b.maxZ);
        expect(trees.length, `${world.seed} ${region}`).toBeGreaterThanOrEqual(30);
        expect(trees.filter(o => o.id.startsWith(`lone-${region}-`)).length, `${world.seed} ${region} lone trees`).toBeGreaterThanOrEqual(20);
      }
    }
  });

  test('every tree species, the whole forest floor and all twelve crags appear', () => {
    for (const world of worlds) {
      const models = new Set(world.obstacles.map(o => o.model));
      for (const species of Object.keys(V3_TREES)) expect(models, species).toContain(species);
      for (const piece of FLOOR) expect(models, piece).toContain(piece);
      for (const style of ['moss', 'snow', 'bare'] as const) for (const model of crags(style)) expect(models, model).toContain(model);
    }
  });

  test('the forest floor keeps at least 1.6 m from every other solid, so the hero always passes', () => {
    for (const world of worlds) {
      const floor = world.obstacles.filter(o => FLOOR.has(o.model ?? ''));
      expect(floor.length, String(world.seed)).toBeGreaterThan(300);
      expect(floor.filter(o => o.model === 'wood-log').every(o => o.shape && o.kind === 'rock')).toBe(true);
      for (const piece of floor) {
        for (const other of world.obstacles) {
          if (other === piece || Math.hypot(other.x - piece.x, other.z - piece.z) > piece.radius + other.radius + 2) continue;
          expect(gap(piece, other), `${piece.id} to ${other.id}`).toBeGreaterThanOrEqual(1.6 - 0.05);
        }
      }
    }
  });

  test('the densest dark forest stays one connected walk for the hero', () => {
    for (const world of worlds.slice(0, 2)) {
      for (const forest of ['greenmarch', 'hollowvale']) {
        const centre = densest(world, forest);
        expect(centre.trees, `${world.seed} ${forest}`).toBeGreaterThanOrEqual(25);
        const { walkable, reached } = connected(world, centre.x - 50, centre.z - 50, 100);
        expect(walkable, `${world.seed} ${forest}`).toBeGreaterThan(20000);
        expect(reached / walkable, `${world.seed} ${forest}`).toBeGreaterThanOrEqual(0.995);
      }
    }
  });

  test('undergrowth is presentation only: deterministic, and clear of roads, places, sites and solids', () => {
    for (const world of worlds) {
      const plants = undergrowth(world);
      expect(undergrowth(world)).toEqual(plants);
      expect(plants.length, String(world.seed)).toBeGreaterThan(2000);
      expect(new Set(plants.map(p => p.id))).toEqual(new Set(['plant-bracken', 'plant-bramble']));
      expect(world.obstacles.some(o => o.model?.startsWith('plant-'))).toBe(false);
      const node = new Map(world.roads.nodes.map(n => [n.id, n]));
      for (const plant of plants) {
        expect(isWalkable(world, plant, 0.35)).toBe(true);
        for (const edge of world.roads.edges) expect(segmentDistance(plant, node.get(edge.from)!, node.get(edge.to)!)).toBeGreaterThanOrEqual(edge.width / 2 + 1);
        for (const place of world.exploration!.locations) expect(Math.hypot(plant.x - place.x, plant.z - place.z)).toBeGreaterThanOrEqual(14);
      }
    }
  });

  test('far mountains stand wholly outside the bounds, styled like the ring, never on the Salt Coast', () => {
    for (const world of worlds) {
      const peaks = farMountains(world);
      expect(peaks.length, String(world.seed)).toBeGreaterThan(100);
      const { minX, maxX, minZ, maxZ } = world.bounds;
      const used = new Set(world.obstacles.map(o => o.model));
      for (const peak of peaks) {
        const reach = V3_BUILDINGS[peak.id as keyof typeof V3_BUILDINGS].width / 2 * peak.scale;
        const outside = Math.max(minX - peak.x, peak.x - maxX, minZ - peak.z, peak.z - maxZ);
        expect(outside, `${peak.id} at ${peak.x.toFixed(0)},${peak.z.toFixed(0)}`).toBeGreaterThanOrEqual(reach);
        expect(used).toContain(peak.id);
        if (peak.x > maxX) expect(regionAt(world, { x: maxX - 1, z: Math.min(maxZ - 1, Math.max(minZ + 1, peak.z)) })).not.toBe('saltcoast');
      }
    }
  });

  test('the dark forest floor is painted where trees stand close', () => {
    const world = worlds[0]!;
    const control = terrainControl(world);
    const size = control.weights.image.width;
    const sample = (texture: typeof control.ground, p: Vec2, channel: number): number => {
      const c = Math.min(size - 1, Math.floor((p.x - control.minX) / control.size * size));
      const r = Math.min(size - 1, Math.floor((p.z - control.minZ) / control.size * size));
      return (texture.image.data as Uint8Array)[(r * size + c) * 4 + channel]!;
    };
    for (const forest of ['greenmarch', 'hollowvale']) {
      const centre = densest(world, forest);
      expect(sample(control.ground, centre, 1), forest).toBeGreaterThan(200);
      expect(sample(control.fields, centre, 3), forest).toBe(WORLD_SURFACES.indexOf('darkforest'));
    }
    const home = world.sites.find(site => site.kind === 'home')!;
    expect(sample(control.ground, home, 1)).toBe(0);
  });
});
