import type { Vec2, WorldBlueprint, WorldLake } from '../game/types';
import { isWalkable, lakeClearance } from '../game/world';
import { seededRandom } from './resources';
import { TREE_VARIANTS } from './world-assets';
import { waterTint, type WaterTint } from './waters';

/**
 * Lake shores and the sea's edge (presentation only, never obstacles), deterministic from the world: reed beds in the
 * shallows and along the banks, drowned trees and stumps standing in the meres and pools, and boulders in the surf off the
 * Salt Coast. `sink` lowers a piece below the level shore (the water plane hides its foot).
 */
export interface ShorePiece {
  id: 'plant-reeds' | 'tree-deadoak' | 'tree-deadbirch' | 'wood-stump' | 'rock-boulder';
  variant: number;
  x: number;
  z: number;
  heading: number;
  /** Uniform scale for reeds and stumps; for drowned trees the height in metres; for boulders the radius in metres. */
  scale: number;
  sink: number;
}

/**
 * Per water: the share of shore steps (every 1.6 m) that get a reed clump, the weights of the three reed variants (tall
 * reed, medium, low rushes), drowned trees and stumps per 1,000 m2 of water, and boulders per 100 m of sea coast.
 */
export const SHORES: Readonly<Record<WaterTint, { reeds: number; variants: readonly [number, number, number]; drowned: number; stumps: number }>> = {
  river: { reeds: 0, variants: [0, 0, 0], drowned: 0, stumps: 0 },
  mere: { reeds: 0.72, variants: [0.5, 0.35, 0.15], drowned: 1.1, stumps: 1.6 },
  pool: { reeds: 0.42, variants: [0.3, 0.4, 0.3], drowned: 0.8, stumps: 0.6 },
  steppe: { reeds: 0.3, variants: [0.1, 0.3, 0.6], drowned: 0.6, stumps: 0 },
  tarn: { reeds: 0.16, variants: [0, 0.2, 0.8], drowned: 0, stumps: 0 },
  sea: { reeds: 0, variants: [0, 0, 0], drowned: 0, stumps: 0 },
};
/** Rocky points per 100 m of sea coast: clusters of three to seven boulders from the waterline out into the surf. */
export const SEA_ROCKS = 2.4;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function area(shore: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < shore.length; i++) {
    const p = shore[i]!, q = shore[(i + 1) % shore.length]!;
    sum += p.x * q.z - q.x * p.z;
  }
  return Math.abs(sum) / 2;
}

/** A random point in the water between `inner` and `outer` metres inside the shore, or undefined after a few tries. */
function inWater(lake: WorldLake, random: () => number, inner: number, outer: number): Vec2 | undefined {
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = lake.shore[Math.floor(random() * lake.shore.length)]!;
    const t = random();
    const p = { x: a.x + (lake.x - a.x) * t, z: a.z + (lake.z - a.z) * t };
    const depth = -lakeClearance(lake, p);
    if (depth >= inner && depth <= outer) return p;
  }
  return undefined;
}

export function shoreDressing(world: WorldBlueprint): ShorePiece[] {
  const random = seededRandom(hash(`${world.seed}:shores`));
  const out: ShorePiece[] = [];
  const pick = (weights: readonly number[]): number => {
    let r = random() * weights.reduce((sum, w) => sum + w, 0);
    for (let i = 0; i < weights.length; i++) if ((r -= weights[i]!) < 0) return i;
    return weights.length - 1;
  };
  for (const lake of world.lakes ?? []) {
    const tint = waterTint(world, lake);
    if (lake.kind === 'sea') {
      // Rocky points: a few clusters of boulders from the waterline out into the surf, along the coast inside the bounds.
      const coast = lake.shore.filter(p => p.x < world.bounds.maxX - 1);
      let length = 0;
      for (let i = 0; i + 1 < coast.length; i++) length += Math.hypot(coast[i + 1]!.x - coast[i]!.x, coast[i + 1]!.z - coast[i]!.z);
      const points = Math.round(length / 100 * SEA_ROCKS);
      for (let k = 0; k < points; k++) {
        const i = Math.floor(random() * (coast.length - 1));
        const a = coast[i]!, b = coast[i + 1]!, step = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const n = { x: (b.z - a.z) / step, z: -(b.x - a.x) / step };
        for (let r = 0, count = 3 + Math.floor(random() * 5); r < count; r++) {
          // Seaward is to the right of the coast, which runs south to north.
          const reach = random() * 10, side = (random() - 0.5) * 12;
          const p = { x: a.x + n.x * reach + (b.x - a.x) / step * side, z: a.z + n.z * reach + (b.z - a.z) / step * side };
          const radius = 0.7 + random() * 1.9;
          // Rocks never collide, so they stand in the water: at most their rim reaches the strip the hero cannot enter.
          if (lakeClearance(lake, p) > 0.7 - radius) continue;
          out.push({ id: 'rock-boulder', variant: Math.floor(random() * 4), x: p.x, z: p.z, heading: random() * Math.PI * 2, scale: radius, sink: radius * 0.4 });
        }
      }
      continue;
    }
    const plan = SHORES[tint];
    // Reed beds: runs of shore where a slow noise round the perimeter stays high get clumps every 0.9 m, two deep (mostly
    // standing in the shallows, a few on the bank, where the hero could stand); elsewhere only a stray clump.
    const phase = random() * 100, threshold = 1 - 2 * plan.reeds;
    let walked = 0;
    lake.shore.forEach((a, i) => {
      const b = lake.shore[(i + 1) % lake.shore.length]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      for (let s = 0; s < length; s += 0.9) {
        const along = walked + s;
        const bed = Math.sin(along * 0.07 + phase) * 0.7 + Math.sin(along * 0.19 + phase * 1.7) * 0.3;
        if (plan.reeds === 0 || (bed < threshold && random() > 0.06)) continue;
        for (let deep = 0; deep < 2; deep++) {
          const t = (s + (random() - 0.5) * 0.8) / length;
          const at = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
          const d = Math.hypot(at.x - lake.x, at.z - lake.z);
          const offset = deep === 0 ? -0.2 - random() * 1.4 : random() < 0.75 ? -1.4 - random() * 1.8 : 0.3 + random() * 0.9;
          const p = { x: at.x + (at.x - lake.x) / d * offset, z: at.z + (at.z - lake.z) / d * offset };
          if (offset > 0 && !isWalkable(world, p, 0.4)) continue;
          out.push({ id: 'plant-reeds', variant: pick(plan.variants), x: p.x, z: p.z, heading: random() * Math.PI * 2, scale: 0.85 + random() * 0.4, sink: 0.05 });
        }
      }
      walked += length;
    });
    const water = area(lake.shore) / 1000;
    for (let k = 0; k < Math.min(6, Math.round(water * plan.drowned)); k++) {
      const p = inWater(lake, random, 2.5, 10);
      if (!p) continue;
      const id = random() < 0.3 ? 'tree-deadbirch' : 'tree-deadoak';
      out.push({ id, variant: Math.floor(random() * TREE_VARIANTS[id]), x: p.x, z: p.z, heading: random() * Math.PI * 2, scale: 6 + random() * 5, sink: 0.6 });
    }
    for (let k = 0; k < Math.min(8, Math.round(water * plan.stumps)); k++) {
      const p = inWater(lake, random, 0.8, 6);
      if (!p) continue;
      out.push({ id: 'wood-stump', variant: Math.floor(random() * 4), x: p.x, z: p.z, heading: random() * Math.PI * 2, scale: 0.8 + random() * 0.5, sink: 0.25 });
    }
  }
  return out;
}
