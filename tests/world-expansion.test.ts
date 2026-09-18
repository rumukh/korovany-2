import { describe, expect, test } from 'vitest';
import { distance, findRoadRoute, generateWorld, isWalkable, moveWithCollision } from '../src/game/world';
import type { Vec2, WorldBlueprint } from '../src/game/types';

const expectedRegions = ['heartlands', 'greenmarch', 'fenlands', 'saltcoast', 'ashsteppe', 'crownlands', 'frostspine', 'hollowvale'];
const expectedLocations = [
  'roadward', 'greenhollow', 'old-orchard', 'stag-shrine', 'thornwatch',
  'mirecross', 'drowned-archive', 'reed-chapel', 'lantern-ferry',
  'saltmarket', 'tide-observatory', 'wreckers-rest', 'cinderwell', 'glass-quarry', 'ash-cairn',
  'crownbridge', 'tax-vault', 'bell-foundry', 'high-pass', 'old-fort', 'palace-citadel', 'star-monastery', 'frozen-beacon',
  'hollow-village', 'name-well', 'last-archive',
];

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

describe('versioned world geography', () => {
  test.each([
    [0, 'k2-v1-1a4066b7', 168], [1, 'k2-v1-59efc101', 164], [42, 'k2-v1-1b76bcfc', 180],
    ['the-unwritten-road', 'k2-v1-c47f2d4c', 160], ['legacy-river', 'k2-v1-416ceab8', 165],
  ] as const)('preserves pre-expansion generator bytes for seed %s', (seed, hash, obstacles) => {
    const world = generateWorld(seed, 1);
    expect(world.id).toBe(hash);
    expect(world.obstacles).toHaveLength(obstacles);
    expect(world.exploration).toBeUndefined();
    expect(generateWorld(seed, 1)).toEqual(world);
  });

  test.each([0, 1, 42, 'the-unwritten-road'])('authors a deterministic 49x world for %s without losing military sites', seed => {
    const old = generateWorld(seed, 1);
    const world = generateWorld(seed);
    expect(world.version).toBe(2);
    expect(world.id).toMatch(/^k2-v2-/);
    expect(world).toEqual(generateWorld(seed, 2));
    expect(generateWorld(`${seed}-different`).id).not.toBe(world.id);
    const area = (b: WorldBlueprint['bounds']): number => (b.maxX - b.minX) * (b.maxZ - b.minZ);
    expect(area(world.bounds) / area(old.bounds)).toBe(49);
    expect(world.bounds).toEqual({ minX: -490, maxX: 490, minZ: -490, maxZ: 490 });
    expect(world.sites).toEqual(old.sites);
    expect(world.sites.filter(s => s.kind === 'outpost')).toHaveLength(3);
    for (const wall of old.obstacles.filter(o => o.kind === 'wall')) expect(world.obstacles).toContainEqual(wall);
    expect(world.obstacles.length).toBeGreaterThan(1000);
    expect(world.obstacles.length).toBeLessThanOrEqual(1400);
    expect(new Set(world.obstacles.map(o => o.id)).size).toBe(world.obstacles.length);
    expect(world.exploration!.regions.map(r => r.id)).toEqual(expectedRegions);
    expect(world.exploration!.locations.map(l => l.id)).toEqual(expectedLocations);
    expect(world.exploration!.locations.filter(l => l.fastTravel).length).toBeGreaterThanOrEqual(8);
    for (const region of world.exploration!.regions) {
      expect(region.name.en.length).toBeGreaterThan(5);
      expect(region.name.ru).toMatch(/[А-Яа-яЁё]/);
      expect(region.description.en.length).toBeGreaterThan(60);
      expect(world.obstacles.filter(o => o.x >= region.bounds.minX && o.x < region.bounds.maxX
        && o.z >= region.bounds.minZ && o.z < region.bounds.maxZ).length).toBeGreaterThan(20);
    }
    for (const place of world.exploration!.locations) {
      const region = world.exploration!.regions.find(r => r.id === place.regionId)!;
      expect(place.x).toBeGreaterThanOrEqual(region.bounds.minX);
      expect(place.x).toBeLessThanOrEqual(region.bounds.maxX);
      expect(place.z).toBeGreaterThanOrEqual(region.bounds.minZ);
      expect(place.z).toBeLessThanOrEqual(region.bounds.maxZ);
      expect(place.name.en.length).toBeGreaterThan(5);
      expect(place.name.ru).toMatch(/[А-Яа-яЁё]/);
      expect(place.description.en.length).toBeGreaterThan(60);
      expect(place.description.ru).toMatch(/[А-Яа-яЁё]/);
      expect(place.radius).toBeGreaterThanOrEqual(15);
      expect(world.roads.nodes).toContainEqual({ id: place.id, x: place.x, z: place.z });
      expect(world.obstacles.filter(o => o.id.startsWith(`${place.id}-building-`)).length).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < 16; i++) {
        const angle = i / 16 * Math.PI * 2;
        expect(isWalkable(world, { x: place.x + 3 * Math.cos(angle), z: place.z + 3 * Math.sin(angle) }, 1.5)).toBe(true);
      }
    }
  });
});

describe('expanded road and river traversal', () => {
  test.each([0, 1, 42, 'bridge-corners', 'northern-roads', 'wet-season'])('connects all roads with convoy-width clearance for %s', seed => {
    const world = generateWorld(seed);
    const byId = new Map(world.roads.nodes.map(n => [n.id, n]));
    expect(byId.size).toBe(world.roads.nodes.length);
    expect(world.roads.edges.length - world.roads.nodes.length + 1).toBeGreaterThanOrEqual(5);
    for (const edge of world.roads.edges) {
      expect(blockedSamples(world, [byId.get(edge.from)!, byId.get(edge.to)!], 1.5),
        `${seed}: ${edge.from} -> ${edge.to}`).toEqual([]);
    }
    const home = byId.get('home')!;
    for (const goal of world.roads.nodes) {
      const route = findRoadRoute(world, home, goal.id);
      if (goal.id !== 'home') expect(route.at(-1)).toEqual({ x: goal.x, z: goal.z });
    }
    expect(world.bridges).toHaveLength(3);
    for (const bridge of world.bridges) {
      const x = (bridge.minX + bridge.maxX) / 2;
      expect(blockedSamples(world, [{ x, z: -18 }, { x, z: 18 }], 1.5)).toEqual([]);
      expect(isWalkable(world, { x: bridge.minX + 1.49, z: 0 }, 1.5)).toBe(false);
      expect(isWalkable(world, { x: bridge.minX + 1.5, z: 0 }, 1.5)).toBe(true);
      expect(isWalkable(world, { x: bridge.maxX - 1.49, z: 0 }, 1.5)).toBe(false);
    }
    for (const x of [-470, -300, -200, -50, 50, 200, 300, 470]) {
      expect(isWalkable(world, { x, z: 0 }, 1.5)).toBe(false);
    }
  });

  test('retargets mid-bridge without taking a diagonal across water', () => {
    const world = generateWorld('retarget');
    for (const x of [-270, 0, 270]) for (const z of [-4, 0, 4]) {
      for (const destination of ['greenhollow', 'last-archive', 'home']) {
        const from = { x, z };
        expect(blockedSamples(world, [from, ...findRoadRoute(world, from, destination)], 1.5)).toEqual([]);
      }
    }
  });

  test('physically traverses the road to every location with substep collision, including distant corners', () => {
    const world = generateWorld('walking-tour');
    let walked = 0;
    for (const place of world.exploration!.locations) {
      const body = { x: 0, z: -54 };
      for (const waypoint of findRoadRoute(world, body, place.id)) {
        const length = distance(body, waypoint);
        walked += length;
        moveWithCollision(world, body, waypoint.x - body.x, waypoint.z - body.z, 1.5);
        expect(distance(body, waypoint), place.id).toBeLessThan(0.001);
      }
      expect(distance(body, place)).toBeLessThan(0.001);
    }
    expect(walked).toBeGreaterThan(10000);
  });
});
