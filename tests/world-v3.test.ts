import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createCampaign, restoreCampaign, type FactionId } from '../src/game';
import {
  distance, findRoadRoute, generateWorld, isWalkable, moveWithCollision, obstacleClearance, segmentClearance,
} from '../src/game/world';
import { COMBAT_YARD, LOCATION_CLEARING, V3_BUILDINGS, V3_FENCE, V3_PROPS, V3_TREES } from '../src/game/world-v3';
import type { Obstacle, Vec2, WorldBlueprint } from '../src/game/types';

const FACTIONS: FactionId[] = ['elf', 'guard', 'villain'];
const KIT = new Set<string>([...Object.keys(V3_BUILDINGS), V3_FENCE.model, ...Object.keys(V3_PROPS), 'rock-boulder', ...Object.keys(V3_TREES)]);

function blockedSamples(world: WorldBlueprint, points: Vec2[], radius: number): Vec2[] {
  const blocked: Vec2[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const steps = Math.max(1, Math.ceil(distance(a, b) * 2));
    for (let step = 0; step <= steps; step++) {
      const p = { x: a.x + (b.x - a.x) * step / steps, z: a.z + (b.z - a.z) * step / steps };
      if (!isWalkable(world, p, radius)) blocked.push(p);
    }
  }
  return blocked;
}

/** Exhaustive reference for the v3 rule: the broadphase must give exactly the same answers. */
function bruteWalkable(world: WorldBlueprint, p: Vec2, radius: number): boolean {
  const reference = { ...world, version: 2 as const, obstacles: [] };
  return isWalkable(reference, p, radius) && !world.obstacles.some(o => obstacleClearance(o, p) < radius);
}

describe('world version 3 generation', () => {
  test.each([0, 42, 'the-unwritten-road'])('is deterministic, keeps the v2 geography and story places for %s', seed => {
    const started = performance.now();
    const world = generateWorld(seed, 3);
    const elapsed = performance.now() - started;
    const v2 = generateWorld(seed, 2);
    expect(world.version).toBe(3);
    expect(world.id).toMatch(/^k2-v3-[0-9a-f]+$/);
    expect(generateWorld(seed, 3)).toEqual(world);
    expect(generateWorld(`${seed}-other`, 3).id).not.toBe(world.id);
    for (const key of ['bounds', 'roads', 'river', 'bridges', 'sites', 'biomes', 'exploration'] as const) expect(world[key]).toEqual(v2[key]);
    expect(world.obstacles.length).toBeGreaterThan(3000);
    expect(world.obstacles.length).toBeLessThan(12000);
    expect(new Set(world.obstacles.map(o => o.id)).size).toBe(world.obstacles.length);
    console.info(`v3 world ${seed}: ${world.obstacles.length} obstacles, ${world.fields!.length} fields, ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(5000);
  });

  test('every v3 obstacle has a finite shape inside its bounding radius and a known presentation model', () => {
    const world = generateWorld('shapes', 3);
    for (const o of world.obstacles) {
      expect(Number.isFinite(o.x) && Number.isFinite(o.z) && o.radius > 0 && o.height > 0, o.id).toBe(true);
      if (o.shape) {
        expect(o.shape.kind, o.id).toBe('box');
        expect(o.shape.halfX > 0 && o.shape.halfZ > 0 && Number.isFinite(o.shape.heading), o.id).toBe(true);
        expect(o.radius, o.id).toBeCloseTo(Math.hypot(o.shape.halfX, o.shape.halfZ), 9);
      }
      // v2 structures kept until W2 (ruins, shrines, landmarks, the Old Fort and the military posts) have no model.
      if (o.model !== undefined) expect(KIT.has(o.model), `${o.id} ${o.model}`).toBe(true);
      else expect(o.kind, o.id).toBe('wall');
    }
  });

  test('rebuilds every settlement and inn at the heroic scale without overlapping solids', () => {
    const world = generateWorld('settlements', 3);
    const places = world.exploration!.locations.filter(l => (l.kind === 'settlement' || l.kind === 'inn') && l.id !== 'old-fort');
    for (const place of places) {
      const houses = world.obstacles.filter(o => o.id.startsWith(`${place.id}-house-`));
      expect(houses.length, place.id).toBeGreaterThanOrEqual(place.kind === 'inn' ? 3 : 6);
      if (place.id === 'greenhollow') expect(houses.length).toBeGreaterThanOrEqual(12);
      expect(world.obstacles.some(o => o.id.startsWith(`${place.id}-building-`)), place.id).toBe(false);
      for (const house of houses) {
        const size = V3_BUILDINGS[house.model as keyof typeof V3_BUILDINGS];
        expect(house.shape!.halfX * 2).toBeCloseTo(size.width, 9);
        expect(house.shape!.halfZ * 2).toBeCloseTo(size.length, 9);
        expect(obstacleClearance(house, place), house.id).toBeGreaterThanOrEqual(LOCATION_CLEARING);
      }
    }
    const solids = world.obstacles.filter(o => o.shape);
    const corners = (o: Obstacle): Vec2[] => {
      const c = Math.cos(o.shape!.heading), s = Math.sin(o.shape!.heading);
      return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) => {
        const lx = a! * o.shape!.halfX, lz = b! * o.shape!.halfZ;
        return { x: o.x + lx * c + lz * s, z: o.z - lx * s + lz * c };
      });
    };
    const overlap = (a: Obstacle, b: Obstacle): boolean => {
      for (const h of [a.shape!.heading, b.shape!.heading]) {
        for (const axis of [{ x: Math.cos(h), z: -Math.sin(h) }, { x: Math.sin(h), z: Math.cos(h) }]) {
          const pa = corners(a).map(p => p.x * axis.x + p.z * axis.z), pb = corners(b).map(p => p.x * axis.x + p.z * axis.z);
          if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
        }
      }
      return true;
    };
    for (let i = 0; i < solids.length; i++) {
      for (let j = i + 1; j < solids.length; j++) {
        const a = solids[i]!, b = solids[j]!;
        if (distance(a, b) > a.radius + b.radius) continue;
        expect(overlap(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
    for (const site of world.sites.filter(s => s.kind !== 'home')) {
      for (const o of world.obstacles.filter(o => o.shape)) {
        expect(obstacleClearance(o, site), `${o.id} in ${site.id}'s combat yard`).toBeGreaterThanOrEqual(site.radius + COMBAT_YARD);
      }
    }
    expect(world.fields!.length).toBeGreaterThan(20);
  });

  test.each([0, 1, 42, 'bridge-corners', 'northern-roads', 'wet-season'])('keeps every road, bridge and clearing traversable at convoy width for %s', seed => {
    const world = generateWorld(seed, 3);
    const byId = new Map(world.roads.nodes.map(n => [n.id, n]));
    for (const edge of world.roads.edges) {
      expect(blockedSamples(world, [byId.get(edge.from)!, byId.get(edge.to)!], 1.5), `${seed}: ${edge.from} -> ${edge.to}`).toEqual([]);
    }
    for (const place of world.exploration!.locations) {
      for (let i = 0; i < 16; i++) {
        const angle = i / 16 * Math.PI * 2;
        expect(isWalkable(world, { x: place.x + 3 * Math.cos(angle), z: place.z + 3 * Math.sin(angle) }, 1.5), place.id).toBe(true);
      }
    }
    const body = { x: 0, z: -54 };
    for (const place of world.exploration!.locations) {
      for (const waypoint of findRoadRoute(world, body, place.id)) {
        moveWithCollision(world, body, waypoint.x - body.x, waypoint.z - body.z, 1.5);
        expect(distance(body, waypoint), place.id).toBeLessThan(0.001);
      }
    }
  });
});

describe('version 3 collision', () => {
  test('the broadphase gives exactly the exhaustive answer', () => {
    const world = generateWorld('broadphase', 3);
    let state = 12345;
    const random = (): number => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 4294967296; };
    let blocked = 0;
    for (let i = 0; i < 20000; i++) {
      // Half the samples land next to an obstacle's edge, where mistakes would show.
      const near = world.obstacles[Math.floor(random() * world.obstacles.length)]!;
      const p = i % 2 ? { x: random() * 980 - 490, z: random() * 980 - 490 }
        : { x: near.x + (random() * 2 - 1) * (near.radius + 2), z: near.z + (random() * 2 - 1) * (near.radius + 2) };
      const radius = [0, 0.16, 0.65, 0.7, 1.3, 1.5, 2.5][i % 7]!;
      const fast = isWalkable(world, p, radius);
      expect(fast, `${p.x},${p.z} r${radius}`).toBe(bruteWalkable(world, p, radius));
      if (!fast) blocked++;
    }
    expect(blocked).toBeGreaterThan(2000);
  });

  test('rectangles block bodies and swept projectiles exactly at their edges', () => {
    const house: Obstacle = { id: 'house', kind: 'wall', x: 10, z: 20, radius: Math.hypot(3, 5), height: 9, variant: 0,
      shape: { kind: 'box', halfX: 3, halfZ: 5, heading: Math.PI / 2 } };
    // A heading of pi/2 turns local +Z (length) to world +X and local +X (width) to world -Z.
    expect(obstacleClearance(house, { x: 10, z: 20 })).toBeCloseTo(-3, 9);
    expect(obstacleClearance(house, { x: 16, z: 20 })).toBeCloseTo(1, 9);
    expect(obstacleClearance(house, { x: 10, z: 24 })).toBeCloseTo(1, 9);
    expect(obstacleClearance(house, { x: 18, z: 26 })).toBeCloseTo(Math.hypot(3, 3), 9);
    expect(segmentClearance(house, { x: 0, z: 20 }, { x: 30, z: 20 })).toBe(0);
    expect(segmentClearance(house, { x: 0, z: 25 }, { x: 30, z: 25 })).toBeCloseTo(2, 9);
    // Separated: the closest pair is the corner (15, 23) and the segment's interior point (18.5, 26.5).
    expect(segmentClearance(house, { x: 18, z: 27 }, { x: 20, z: 25 })).toBeCloseTo(3.5 * Math.SQRT2, 9);
    const world: WorldBlueprint = { ...generateWorld('boxes', 3), obstacles: [house], id: 'k2-v3-unit-box' };
    expect(isWalkable(world, { x: 10, z: 23.7 }, 0.65)).toBe(true);
    expect(isWalkable(world, { x: 10, z: 23.7 }, 0.75)).toBe(false);
    const body = { x: 10, z: 30 };
    moveWithCollision(world, body, 0, -10, 0.65);
    // 0.25 m substeps stop at the last position at least 0.65 m from the wall at z = 23.
    expect(body.z).toBeCloseTo(23.75, 9);
  });
});

describe('version 3 campaigns', () => {
  test.each(FACTIONS)('a %s campaign starts, places its residents and survives exact save and restore', faction => {
    const game = createCampaign({ seed: `v3-${faction}`, faction, runId: `v3-${faction}`, worldVersion: 3 });
    for (let tick = 0; tick < 240; tick++) game.step({ move: { x: Math.sin(tick / 40), z: 1 }, sprint: tick % 2 === 0 });
    const snapshot = game.snapshot();
    expect(snapshot.world.version).toBe(3);
    expect(snapshot.world.id).toMatch(new RegExp(`^k2-v3-[0-9a-f]+-${faction}-campaign3$`));
    expect(snapshot.narrative!.npcs.length).toBeGreaterThan(0);
    for (const npc of snapshot.narrative!.npcs) expect(isWalkable(snapshot.world, npc, 0.65), npc.id).toBe(true);
    const save = game.serialize();
    expect(save.version).toBe(3);
    const restored = restoreCampaign(JSON.parse(JSON.stringify(save)));
    expect(restored.snapshot()).toEqual(snapshot);
    expect(() => restoreCampaign({ ...save, worldId: `${save.worldId}x` })).toThrow('Saved world does not match');
  });
});

describe('v1 and v2 stay byte-identical', () => {
  // Recorded at main 9d0fea7 with the Phase 0 baseline script (identical to the 23bd6c0 baseline).
  const baseline: Record<string, string> = {
    'world:v1:0': 'k2-v1-1a4066b7', 'world:v2:0': 'k2-v2-3bc2f87b', 'world:v1:1': 'k2-v1-59efc101', 'world:v2:1': 'k2-v2-3c7959c4',
    'world:v1:42': 'k2-v1-1b76bcfc', 'world:v2:42': 'k2-v2-b089ed4d', 'world:v1:the-unwritten-road': 'k2-v1-c47f2d4c',
    'world:v2:the-unwritten-road': 'k2-v2-4527b1b', 'world:v1:ROAD-II': 'k2-v1-523c4622', 'world:v2:ROAD-II': 'k2-v2-be829e75',
    'save:v1:elf': 'a1d11592b415a043ba150b796dceb2351616bcd3cdb6ca21c0f1cfa17b11ae62',
    'snapshot:v1:elf': '6cbaa7a298aaa4e879b2889f635fa2affa1645c1d831e96e0f520dbd1b9e990e',
    'save:v1:guard': 'facc2a245843020ad4add3c521711dfcee4032dd0babe38ae607318657e37196',
    'snapshot:v1:guard': '8f83b7fa9418dee972294e78f3ac55da8496f2eecd2269a2531293e3f65be056',
    'save:v1:villain': 'ed5b0e56189fd89fd105adeaf55494b335789e3e386017781b6b4ff0f001e5aa',
    'snapshot:v1:villain': 'e20a9eb3dc1f0a6ac7332449ef5ae177b1ba09ee3cc4470cf2ab0d0d99698ace',
    'save:v2:elf': '765ebb807b8dd602a48bc60032189e7aa4b6eaba4310f3e12d19cb47669df87b',
    'snapshot:v2:elf': '241bd290cb80a71c4685f6975b89e56af51a4d5c3ca535a23655c84729a2163d',
    'save:v2:guard': 'b9ff0e6ffeeff5644a170924306fe90dbccf62029f11c8147f03fa523310b832',
    'snapshot:v2:guard': 'd47f1b4132201f95f6e0f99acc9541803d6a56b4bd0577fea2666ea49c4fc7d9',
    'save:v2:villain': '737ee38a5a34bcb7a1c57d8dd40522c3efd56db1db07cabf42342745320c345e',
    'snapshot:v2:villain': 'fd2840d7733f898b1fa90f22bf1a142cbe345f99d69a2a6bb38ddb25dca5cb8f',
  };
  const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  test('world ids, saves and snapshots match the recorded baseline', () => {
    const out: Record<string, string> = {};
    for (const seed of [0, 1, 42, 'the-unwritten-road', 'ROAD-II']) {
      out[`world:v1:${seed}`] = generateWorld(seed, 1).id;
      out[`world:v2:${seed}`] = generateWorld(seed).id;
    }
    for (const worldVersion of [1, 2] as const) for (const faction of FACTIONS) {
      const game = createCampaign({ seed: 'hash-baseline', faction, runId: 'hash-baseline', worldVersion });
      for (let tick = 0; tick < 900; tick++) {
        const phase = Math.floor(tick / 150);
        game.step({ move: { x: Math.sin(phase), z: Math.cos(phase) }, sprint: phase % 2 === 0, attack: tick % 40 < 20,
          dodge: tick % 97 === 0, special: tick % 301 === 0, interact: phase === 3 });
      }
      out[`save:v${worldVersion}:${faction}`] = sha(game.serialize());
      out[`snapshot:v${worldVersion}:${faction}`] = sha(game.snapshot());
    }
    expect(out).toEqual(baseline);
  });
});
