import { describe, expect, test } from 'vitest';
import { generateWorld } from '../game/world';
import { COMBAT_FLAT, terrainFor } from './terrain';
import { apronGeometry, terrainExtent } from './terrain-mesh';

const degrees = (radians: number): number => radians * 180 / Math.PI;

describe('version 3 presentation terrain', () => {
  test('v1 and v2 worlds stay exactly flat', () => {
    for (const version of [1, 2] as const) {
      const terrain = terrainFor(generateWorld('flat-check', version));
      expect(terrain.flat).toBe(true);
      for (let i = 0; i < 200; i++) {
        const x = (i * 37.3) % 900 - 450, z = (i * 91.7) % 900 - 450;
        expect(terrain.height(x, z)).toBe(0);
        expect(terrain.normal(x, z)).toEqual({ x: 0, y: 1, z: 0 });
      }
    }
  });

  test.each([0, 42, 'the-unwritten-road'])('keeps roads, river banks, clearings, footprints and combat zones level for %s', seed => {
    const world = generateWorld(seed, 3);
    const terrain = terrainFor(world);
    expect(terrain.flat).toBe(false);
    const node = (id: string) => world.roads.nodes.find(n => n.id === id)!;
    for (const edge of world.roads.edges) {
      const a = node(edge.from), b = node(edge.to);
      for (let t = 0; t <= 1; t += 0.02) {
        for (const side of [-1, 0, 1]) {
          const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          const nx = -(b.z - a.z) / length, nz = (b.x - a.x) / length;
          const x = a.x + (b.x - a.x) * t + nx * side * (edge.width / 2), z = a.z + (b.z - a.z) * t + nz * side * (edge.width / 2);
          expect(terrain.height(x, z), `${edge.from}-${edge.to} at ${t}`).toBeLessThan(0.05);
        }
      }
    }
    for (const site of world.sites) {
      for (let i = 0; i < 24; i++) {
        const angle = i / 24 * Math.PI * 2, r = (site.radius + COMBAT_FLAT - 4) * ((i % 3) + 1) / 3;
        expect(terrain.height(site.x + Math.cos(angle) * r, site.z + Math.sin(angle) * r), site.id).toBe(0);
      }
    }
    for (const place of world.exploration!.locations) {
      for (let i = 0; i < 16; i++) {
        const angle = i / 16 * Math.PI * 2;
        expect(terrain.height(place.x + Math.cos(angle) * place.radius, place.z + Math.sin(angle) * place.radius), place.id).toBe(0);
      }
    }
    for (const o of world.obstacles.filter(o => o.kind === 'wall')) {
      for (let i = 0; i < 8; i++) {
        const angle = i / 8 * Math.PI * 2;
        expect(terrain.height(o.x + Math.cos(angle) * o.radius, o.z + Math.sin(angle) * o.radius), o.id).toBe(0);
      }
    }
    for (const x of [-450, -200, 0, 200, 450]) for (const z of [-14, 0, 14]) expect(terrain.height(x, z)).toBe(0);
  });

  test('has real relief with walkable slopes everywhere', () => {
    const world = generateWorld('relief', 3);
    const terrain = terrainFor(world);
    const slopes: number[] = [];
    let highest = 0, raised = 0, samples = 0;
    for (let x = -480; x <= 480; x += 3.7) {
      for (let z = -480; z <= 480; z += 3.7) {
        const h = terrain.height(x, z);
        expect(Number.isFinite(h) && h >= 0).toBe(true);
        highest = Math.max(highest, h);
        if (h > 0.5) raised++;
        samples++;
        slopes.push(degrees(terrain.slope(x, z)));
      }
    }
    slopes.sort((a, b) => a - b);
    const p999 = slopes[Math.floor(slopes.length * 0.999)]!, max = slopes.at(-1)!;
    console.info(`terrain relief: highest ${highest.toFixed(1)} m, ${(raised / samples * 100).toFixed(0)}% raised, slope p99.9 ${p999.toFixed(1)} deg, max ${max.toFixed(1)} deg`);
    expect(highest).toBeGreaterThan(4);
    expect(raised / samples).toBeGreaterThan(0.2);
    expect(p999).toBeLessThan(12);
    expect(max).toBeLessThan(14);
  });

  test('the far apron frames the terrain chunks: it overlaps them only along a 1 m seam and faces up', () => {
    const world = generateWorld('apron', 3);
    const extent = terrainExtent(world);
    const geometry = apronGeometry(world, 4000);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    let area = 0, overlap = 0;
    for (let i = 0; i < position.count; i += 3) {
      const a = [position.getX(i), position.getZ(i)], b = [position.getX(i + 1), position.getZ(i + 1)], c = [position.getX(i + 2), position.getZ(i + 2)];
      // Counter-clockwise from above: the y component of (b - a) x (c - a) is positive.
      const cross = (b[1]! - a[1]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[1]! - a[1]!);
      expect(cross).toBeGreaterThan(0);
      area += cross / 2;
      for (let v = i; v < i + 3; v++) expect([normal.getX(v), normal.getY(v), normal.getZ(v)]).toEqual([0, 1, 0]);
      // The triangle's part inside the chunks' extent (bands are axis-aligned, so its box clipped to the extent).
      const xs = [a[0]!, b[0]!, c[0]!], zs = [a[1]!, b[1]!, c[1]!];
      const w = Math.min(Math.max(...xs), extent.x1) - Math.max(Math.min(...xs), extent.x0);
      const h = Math.min(Math.max(...zs), extent.z1) - Math.max(Math.min(...zs), extent.z0);
      if (w > 0 && h > 0) overlap += w * h / 2;
    }
    const inner = (extent.x1 - extent.x0) * (extent.z1 - extent.z0);
    const seam = 2 * (extent.x1 - extent.x0) + 2 * (extent.z1 - extent.z0);
    expect(area).toBeCloseTo(4000 * 4000 - inner + seam - 4, 0);
    expect(overlap).toBeLessThanOrEqual(seam);
  });
});
