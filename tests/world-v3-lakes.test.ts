import { describe, expect, test } from 'vitest';
import { generateWorld } from '../src/game';
import type { Vec2, WorldBlueprint, WorldLake } from '../src/game/types';
import { isWalkable, lakeClearance, moveWithCollision } from '../src/game/world';
import { COMBAT_YARD, LAKE_RULES, SEA } from '../src/game/world-v3';

// W3b: lakes and the sea. Fen meres, forest and steppe pools, Frostspine tarns and a Heartlands pond are solid water like
// the river; the sea closes the Salt Coast, the one edge the mountain ring leaves open.
const worlds = ['lakes-a', 'lakes-b', 0, 42].map(seed => generateWorld(seed, 3));

function regionAt(world: WorldBlueprint, p: Vec2): string | undefined {
  return world.exploration!.regions.find(r => p.x >= r.bounds.minX && p.x <= r.bounds.maxX && p.z >= r.bounds.minZ && p.z <= r.bounds.maxZ)?.id;
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
  const t = length === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

/**
 * Independent reference: the even-odd rule by a horizontal ray, and the nearest edge by sampling it every 2 cm (edges whose
 * bounding box lies farther than the nearest vertex are skipped).
 */
function bruteClearance(lake: WorldLake, p: Vec2): number {
  let crossings = 0;
  const shore = lake.shore;
  let best = Math.min(...shore.map(v => Math.hypot(v.x - p.x, v.z - p.z)));
  for (let i = 0; i < shore.length; i++) {
    const a = shore[i]!, b = shore[(i + 1) % shore.length]!;
    if ((a.z <= p.z && b.z > p.z) || (b.z <= p.z && a.z > p.z)) {
      const x = a.x + (p.z - a.z) / (b.z - a.z) * (b.x - a.x);
      if (x > p.x) crossings++;
    }
    const gx = Math.max(Math.min(a.x, b.x) - p.x, 0, p.x - Math.max(a.x, b.x)), gz = Math.max(Math.min(a.z, b.z) - p.z, 0, p.z - Math.max(a.z, b.z));
    if (Math.hypot(gx, gz) > best) continue;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.02));
    for (let k = 0; k <= steps; k++) best = Math.min(best, Math.hypot(a.x + (b.x - a.x) * k / steps - p.x, a.z + (b.z - a.z) * k / steps - p.z));
  }
  return crossings % 2 ? -best : best;
}

/** Points along a shore every `step` metres. */
function along(lake: WorldLake, step: number): Vec2[] {
  const out: Vec2[] = [];
  lake.shore.forEach((a, i) => {
    const b = lake.shore[(i + 1) % lake.shore.length]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n });
  });
  return out;
}

const area = (shore: Vec2[]): number => Math.abs(shore.reduce((sum, p, i) => {
  const q = shore[(i + 1) % shore.length]!;
  return sum + p.x * q.z - q.x * p.z;
}, 0)) / 2;

describe('version 3 lakes and the sea', () => {
  test('only version 3 worlds have lakes, and they are deterministic', () => {
    for (const seed of [0, 'lakes-a']) {
      expect(generateWorld(seed, 1).lakes).toBeUndefined();
      expect(generateWorld(seed, 2).lakes).toBeUndefined();
      expect(generateWorld(seed, 3).lakes).toEqual(worlds.find(w => w.seed === String(seed))!.lakes);
    }
  });

  test('meres lie in the Fens, pools in the forests, the Crownlands, the Heartlands and the steppe, tarns in the Frostspine', () => {
    let hollowvale = 0;
    for (const world of worlds) {
      const lakes = world.lakes!;
      const count = (region: string, kind: WorldLake['kind']): number => lakes.filter(l => l.kind === kind && regionAt(world, l) === region).length;
      expect(lakes.length, String(world.seed)).toBeGreaterThanOrEqual(12);
      expect(count('fenlands', 'mere'), String(world.seed)).toBeGreaterThanOrEqual(4);
      const fens = lakes.filter(l => regionAt(world, l) === 'fenlands').map(l => Math.sqrt(area(l.shore) / Math.PI));
      expect(Math.max(...fens), String(world.seed)).toBeGreaterThanOrEqual(25);
      for (const region of ['greenmarch', 'crownlands', 'heartlands', 'ashsteppe']) expect(count(region, 'pool'), `${world.seed} ${region}`).toBeGreaterThanOrEqual(1);
      expect(count('frostspine', 'tarn'), String(world.seed)).toBeGreaterThanOrEqual(1);
      hollowvale += count('hollowvale', 'pool');
      expect(lakes.filter(l => l.kind === 'sea').map(l => l.id)).toEqual(['sea']);
      expect(new Set(lakes.map(l => l.id)).size).toBe(lakes.length);
      for (const lake of lakes) expect(lakeClearance(lake, lake), lake.id).toBeLessThan(0);
    }
    expect(hollowvale).toBeGreaterThanOrEqual(2);
  });

  test('lakes keep clear of roads, places, sites, fields, the river, the bounds and each other', () => {
    for (const world of worlds) {
      const node = new Map(world.roads.nodes.map(n => [n.id, n]));
      const inland = world.lakes!.filter(l => l.kind !== 'sea');
      for (const lake of inland) {
        const shore = along(lake, 0.5);
        for (const edge of world.roads.edges) {
          const a = node.get(edge.from)!, b = node.get(edge.to)!;
          expect(Math.min(...shore.map(p => segmentDistance(p, a, b))), `${lake.id} ${edge.from}`).toBeGreaterThanOrEqual(edge.width / 2 + LAKE_RULES.road - 0.05);
        }
        for (const place of world.exploration!.locations) expect(bruteClearance(lake, place), `${lake.id} ${place.id}`).toBeGreaterThanOrEqual(place.radius + LAKE_RULES.location - 0.01);
        for (const site of world.sites) expect(bruteClearance(lake, site), `${lake.id} ${site.id}`).toBeGreaterThanOrEqual(site.radius + COMBAT_YARD + LAKE_RULES.site - 0.01);
        expect(shore.every(p => p.z < world.river.minZ - LAKE_RULES.river || p.z > world.river.maxZ + LAKE_RULES.river), lake.id).toBe(true);
        expect(Math.min(...shore.map(p => Math.min(p.x - world.bounds.minX, world.bounds.maxX - p.x, p.z - world.bounds.minZ, world.bounds.maxZ - p.z))), lake.id)
          .toBeGreaterThanOrEqual(LAKE_RULES.bounds - 0.01);
        for (const f of world.fields ?? []) {
          const c = Math.cos(f.heading), s = Math.sin(f.heading);
          const intrudes = shore.some(p => {
            const dx = p.x - f.x, dz = p.z - f.z;
            return Math.abs(dx * c - dz * s) < f.halfX + LAKE_RULES.field - 0.01 && Math.abs(dx * s + dz * c) < f.halfZ + LAKE_RULES.field - 0.01;
          });
          expect(intrudes, `${lake.id} ${f.id}`).toBe(false);
          expect(bruteClearance(lake, f), `${lake.id} ${f.id}`).toBeGreaterThan(0);
        }
        for (const other of world.lakes!) {
          if (other === lake) continue;
          expect(Math.min(...shore.map(p => lakeClearance(other, p))), `${lake.id} ${other.id}`).toBeGreaterThanOrEqual(LAKE_RULES.lake - 0.05);
        }
      }
    }
  });

  test('every solid keeps at least 2 m from the water; only the mountain ring may stand in the sea', () => {
    for (const world of worlds) {
      let worst = { gap: Infinity, pair: '' };
      for (const o of world.obstacles) {
        for (const lake of world.lakes!) {
          if (lake.kind === 'sea' && o.id.startsWith('ring-')) continue;
          const gap = lakeClearance(lake, o) - o.radius;
          if (gap < worst.gap) worst = { gap, pair: `${o.id} ${lake.id}` };
        }
      }
      expect(worst.gap, worst.pair).toBeGreaterThanOrEqual(2 - 1e-9);
    }
  });

  test('water is solid: the shore distance is exact, walkability matches it and moving bodies stop at the shore', () => {
    let state = 2024;
    const random = (): number => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 4294967296; };
    for (const world of worlds.slice(0, 2)) {
      const dry = { ...world, lakes: [] };
      for (let i = 0; i < 1500; i++) {
        const lake = world.lakes![Math.floor(random() * world.lakes!.length)]!;
        const a = lake.shore[Math.floor(random() * lake.shore.length)]!;
        const p = { x: a.x + (random() * 2 - 1) * 3, z: a.z + (random() * 2 - 1) * 3 };
        expect(lakeClearance(lake, p), `${lake.id} ${p.x},${p.z}`).toBeCloseTo(bruteClearance(lake, p), 1);
        const radius = [0, 0.65, 1.3][i % 3]!;
        const wet = world.lakes!.some(l => bruteClearance(l, p) < radius - 0.02);
        const clear = world.lakes!.every(l => bruteClearance(l, p) >= radius + 0.02);
        if (wet) expect(isWalkable(world, p, radius), `${lake.id} ${p.x},${p.z} r${radius}`).toBe(false);
        if (clear) expect(isWalkable(world, p, radius), `${lake.id} ${p.x},${p.z} r${radius}`).toBe(isWalkable(dry, p, radius));
      }
      let stopped = 0;
      for (const lake of world.lakes!.filter(l => l.kind !== 'sea')) {
        for (const a of lake.shore.filter((_, k) => k % 6 === 0)) {
          const d = Math.hypot(a.x - lake.x, a.z - lake.z), ux = (a.x - lake.x) / d, uz = (a.z - lake.z) / d;
          const start = { x: a.x + ux * 6, z: a.z + uz * 6 };
          // Only clear approaches: nothing but the water on the way in.
          if (!Array.from({ length: 13 }, (_, k) => k / 2).every(k => isWalkable(dry, { x: a.x + ux * k, z: a.z + uz * k }, 0.7))) continue;
          if (!isWalkable(world, start, 0.7)) continue;
          const body = { ...start };
          for (let step = 0; step < 60; step++) moveWithCollision(world, body, -ux * 0.25, -uz * 0.25, 0.7);
          expect(lakeClearance(lake, body), lake.id).toBeGreaterThanOrEqual(0.7 - 1e-9);
          expect(lakeClearance(lake, body), lake.id).toBeLessThan(1.1);
          stopped++;
        }
      }
      expect(stopped, String(world.seed)).toBeGreaterThan(40);
    }
  });

  test('the sea closes the Salt Coast inside the bounds and keeps its places, roads and solids dry', () => {
    for (const world of worlds) {
      const sea = world.lakes!.find(l => l.kind === 'sea')!;
      const coast = world.exploration!.regions.find(r => r.id === 'saltcoast')!.bounds;
      const { maxX } = world.bounds;
      let inside = 0, total = 0;
      for (let z = coast.minZ + 1; z < coast.maxZ; z += 2) {
        expect(isWalkable(world, { x: maxX - 0.75, z }, 0.7), `z ${z}`).toBe(false);
        // The shore at this z: the westmost water along the line.
        let x = maxX;
        while (x > maxX - 80 && lakeClearance(sea, { x: x - 0.5, z }) < 0) x -= 0.5;
        total++;
        if (maxX - x >= 8) inside++;
      }
      expect(inside / total, String(world.seed)).toBeGreaterThanOrEqual(0.85);
      for (const place of world.exploration!.locations) expect(bruteClearance(sea, place), place.id).toBeGreaterThanOrEqual(place.radius + SEA.reach.location - 0.5);
      const node = new Map(world.roads.nodes.map(n => [n.id, n]));
      for (const edge of world.roads.edges) {
        const a = node.get(edge.from)!, b = node.get(edge.to)!;
        for (let t = 0; t <= 1; t += 0.01) {
          const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
          expect(lakeClearance(sea, p), `${edge.from}-${edge.to}`).toBeGreaterThanOrEqual(edge.width / 2 + SEA.reach.road - 0.5);
        }
      }
      expect(Math.max(...sea.shore.map(p => p.x))).toBeLessThanOrEqual(maxX + SEA.beyond);
    }
  });
});
