/**
 * Version 3 only: hostile monsters, the beasts of the borderland: grave wolves grown bold on empty roads and opened
 * graves, barrow ghouls drawn to the burials Raut's men dug up for bone ash, and bog trolls of the fens and passes. They
 * are beasts, not the dead: the Caller stays unseen and the missing crews never become monsters. Packs appear at the
 * wolves' lairs and the other beasts' haunts (`WorldBlueprint.lairs` and `haunts`) while the hero is 90-160 m away,
 * wander within 25 m, hunt the hero only (never the convoy or a shipment) and give up beyond their 35 m leash; idle
 * packs vanish beyond 240 m, and a place whose pack was killed out stays empty for 90-180 s. Packs, spawn points,
 * roaming and cooldowns draw on the simulation's seeded PRNG, so replays and saves stay deterministic. Version 1/2
 * campaigns have no lairs, no monster state and no monster system: none of this runs or draws there.
 */
import type { System, World } from '@aegis/core';
import { actors, campaign, Combatant, type ActorData, type CampaignData, type MonsterState } from './state';
import type { FactionId, MonsterSpecies, Obstacle, Vec2, WorldBlueprint, WorldLair } from './types';
import { distance, isWalkable, monsterLairs, moveWithCollision, nearbyObstacles, obstacleClearance, segmentClearance } from './world';

export interface MonsterSpec {
  hp: number;
  damage: number;
  /** Hunting speed; `walk` is the wandering pace. */
  speed: number;
  walk: number;
  radius: number;
  attackRange: number;
  /** Seconds of the telegraphed windup, the recovery after a strike and the cooldown between strikes. */
  windup: number;
  recovery: number;
  cooldown: number;
  /** The hero is noticed inside `aggro` metres. */
  aggro: number;
  /** Pack size, inclusive. */
  pack: readonly [number, number];
  /** Coins dropped by each beast. */
  coins: number;
}

export const MONSTERS: Readonly<Record<MonsterSpecies, Readonly<MonsterSpec>>> = {
  wolf: { hp: 48, damage: 8, speed: 6.0, walk: 1.3, radius: 0.6, attackRange: 1.9, windup: 0.35, recovery: 0.4, cooldown: 1.2,
    aggro: 18, pack: [3, 4], coins: 4 },
  /** A claw swipe from a lean, long-armed carrion beast, in threes and fours. */
  ghoul: { hp: 72, damage: 10, speed: 5.0, walk: 1.1, radius: 0.6, attackRange: 2.1, windup: 0.45, recovery: 0.5, cooldown: 1.4,
    aggro: 16, pack: [3, 4], coins: 6 },
  /** Alone: a slow, heavily telegraphed two-fisted slam that the hero can step out of; it takes a long fight to fell. */
  troll: { hp: 300, damage: 24, speed: 4.4, walk: 1.0, radius: 1.3, attackRange: 3.2, windup: 0.9, recovery: 1.0, cooldown: 2.4,
    aggro: 20, pack: [1, 1], coins: 20 },
};

export const MONSTER_RULES = {
  /** Monster entities at once, bodies included. */
  cap: 12,
  /** A pack appears when the hero is this far from its lair. */
  spawn: [90, 160],
  /** Wandering packs vanish beyond this distance from the hero. */
  despawn: 240,
  /** Wandering circle and hunting leash round the lair. */
  roam: 25,
  leash: 35,
  /** New pack members stand within this many metres of the lair's centre. */
  scatter: 6,
  /** Seconds between spawner checks, a wanderer's pause between moves, and a killed-out lair's quiet. */
  check: 1,
  pause: [2, 6],
  cooldown: [90, 180],
  /** Monster coins drop only while fewer pickups lie on the ground (saves keep at most 40 more for the campaign's). */
  dropRoom: 16,
} as const;

/** The placeholder `faction` every monster carries; it means nothing for monsters (they are never dyed). */
export const MONSTER_FACTION: FactionId = 'villain';

export function createMonsterState(world: WorldBlueprint): MonsterState {
  return { version: 1, sequence: 0, timer: 0, lairs: Object.fromEntries(monsterLairs(world).map(lair => [lair.id, { cooldown: 0 }])) };
}

export const monsterId = (n: number): string => `monster-${n}`;
/** The sequence number of a `monster-<n>` ID, or null. */
export function monsterNumber(id: unknown): number | null {
  const match = typeof id === 'string' ? /^monster-([1-9]\d{0,8})$/.exec(id) : null;
  return match ? Number(match[1]) : null;
}

function createMonster(world: World, s: CampaignData, lair: WorldLair, at: Vec2): void {
  const spec = MONSTERS[lair.species];
  world.spawn(Combatant({
    id: monsterId(++s.spawner!.sequence), kind: 'monster', species: lair.species, faction: MONSTER_FACTION, allegiance: 'hostile',
    siteId: lair.id, home: { x: lair.x, z: lair.z }, x: at.x, z: at.z, heading: world.random.range(-Math.PI, Math.PI),
    hp: spec.hp, maxHp: spec.hp, radius: spec.radius, damage: spec.damage, speed: spec.speed, attackRange: spec.attackRange,
    cooldown: world.random.range(0.4, 1.2), stateTime: world.random.range(0, 3), roam: { x: at.x, z: at.z },
  }));
}

/** The spawner (version 3 schedules only): cooldowns, vanishing far packs and new packs at lairs in the spawn band. */
export function monsterSpawner(blueprint: WorldBlueprint): System {
  const lairs = monsterLairs(blueprint);
  return {
    name: 'KorovanyMonsters', phase: 'postUpdate', after: ['KorovanyConquest'],
    run(ctx) {
      const s = campaign(ctx.world), m = s.spawner!, p = s.player;
      for (const lair of lairs) {
        const state = m.lairs[lair.id]!;
        state.cooldown = Math.max(0, state.cooldown - ctx.dt);
      }
      m.timer = Math.max(0, m.timer - ctx.dt);
      if (m.timer > 0) return;
      m.timer = MONSTER_RULES.check;
      for (const row of ctx.world.query({ has: [Combatant] })) {
        const a = row.get(Combatant);
        if (a.kind === 'monster' && a.hp > 0 && a.target === null && distance(a, p) > MONSTER_RULES.despawn) ctx.world.despawn(row.entity);
      }
      const present = actors(ctx.world).filter(a => a.kind === 'monster');
      let count = present.length;
      for (const lair of lairs) {
        if (m.lairs[lair.id]!.cooldown > 0 || present.some(a => a.siteId === lair.id)) continue;
        const d = distance(p, lair);
        if (d < MONSTER_RULES.spawn[0] || d > MONSTER_RULES.spawn[1]) continue;
        const spec = MONSTERS[lair.species];
        const size = ctx.world.random.int(spec.pack[0], spec.pack[1] + 1);
        if (count + size > MONSTER_RULES.cap) continue;
        const placed: Vec2[] = [];
        for (let i = 0; i < size; i++) {
          for (let attempt = 0; attempt < 12; attempt++) {
            const angle = ctx.world.random.range(0, Math.PI * 2), r = ctx.world.random.range(1, MONSTER_RULES.scatter);
            const at = { x: lair.x + Math.sin(angle) * r, z: lair.z + Math.cos(angle) * r };
            if (!isWalkable(blueprint, at, spec.radius) || placed.some(q => distance(q, at) < spec.radius * 2 + 0.5)) continue;
            placed.push(at);
            createMonster(ctx.world, s, lair, at);
            break;
          }
        }
        count += placed.length;
      }
    },
  };
}

/** A walkable point in a monster's wandering circle (its lair's centre if four draws miss). */
function roamPoint(world: World, blueprint: WorldBlueprint, a: ActorData): Vec2 {
  for (let attempt = 0; attempt < 4; attempt++) {
    const angle = world.random.range(0, Math.PI * 2), r = MONSTER_RULES.roam * 0.9 * Math.sqrt(world.random.nextFloat());
    const at = { x: a.home.x + Math.sin(angle) * r, z: a.home.z + Math.cos(angle) * r };
    if (isWalkable(blueprint, at, a.radius)) return at;
  }
  return { x: a.home.x, z: a.home.z };
}

/** Swerves, in radians, a blocked step tries along a solid: ever wider to the side the monster last chose
 * (`patrolDirection`), then to the other side. */
const SWERVES = [0.7, 1.4];

/**
 * Moves a monster up to `step` metres along the unit direction (dx, dz), sliding along solids. A step blocked straight
 * on follows the solid sideways instead (the tree, rock or fallen trunk in its way), round whichever end it chose
 * (`patrolDirection`) until the way ahead is free; it turns to the other end only when that way is blocked too. Returns
 * the ground gained along (dx, dz).
 */
function travel(blueprint: WorldBlueprint, a: ActorData, dx: number, dz: number, step: number): number {
  const start = { x: a.x, z: a.z }, heading = Math.atan2(dx, dz);
  const attempt = (swerve: number): { gain: number; moved: number; x: number; z: number } => {
    a.x = start.x;
    a.z = start.z;
    moveWithCollision(blueprint, a, Math.sin(heading + swerve) * step, Math.cos(heading + swerve) * step, a.radius);
    return { gain: (a.x - start.x) * dx + (a.z - start.z) * dz, moved: distance(start, a), x: a.x, z: a.z };
  };
  let best = attempt(0);
  if (best.gain < step * 0.5) {
    follow: for (const side of [a.patrolDirection, -a.patrolDirection]) {
      for (const swerve of SWERVES) {
        const tried = attempt(swerve * side);
        if (tried.moved >= step * 0.5 && tried.gain >= -step * 0.5) {
          best = tried;
          a.patrolDirection = side;
          break follow;
        }
        if (tried.gain > best.gain) best = tried;
      }
    }
  }
  a.x = best.x;
  a.z = best.z;
  return best.gain;
}

/**
 * The way round a solid box (a barrow, a giant's skull, a fallen trunk, a building) that stands between a monster and
 * `goal`: the shortest walk round it over its corners, pushed out by the monster's radius and a margin, in legs that
 * keep clear of the box. Returns the walk's next waypoint, or null when no box narrows the straight way below the
 * monster's width or no walk round it exists; `travel`'s swerves handle trees, boulders and other round solids.
 */
function detour(blueprint: WorldBlueprint, a: ActorData, goal: Vec2): Vec2 | null {
  // A leg ending at the goal may pass as close to the box as the goal itself stands (a hero pressed against its side).
  const width = (o: Obstacle): number => Math.min(a.radius * 0.9, obstacleClearance(o, goal) - 0.05);
  let blocking: Obstacle | null = null, nearest = Infinity;
  for (const o of nearbyObstacles(blueprint, Math.min(a.x, goal.x) - 2, Math.min(a.z, goal.z) - 2, Math.max(a.x, goal.x) + 2,
    Math.max(a.z, goal.z) + 2)) {
    if (!o.shape || segmentClearance(o, a, goal) >= width(o)) continue;
    const clearance = obstacleClearance(o, a);
    if (clearance < nearest) { nearest = clearance; blocking = o; }
  }
  if (!blocking) return null;
  const box = blocking, { heading, halfX, halfZ } = box.shape!, c = Math.cos(heading), s = Math.sin(heading);
  const margin = a.radius + 0.4;
  // Nodes: the monster, the box's walkable corners (local X runs along (cos h, -sin h), local Z along (sin h, cos h)), the goal.
  const nodes: Vec2[] = [{ x: a.x, z: a.z }];
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, -1], [-1, 1]] as const) {
    const lx = sx * (halfX + margin), lz = sz * (halfZ + margin);
    const corner = { x: box.x + lx * c + lz * s, z: box.z - lx * s + lz * c };
    if (isWalkable(blueprint, corner, a.radius)) nodes.push(corner);
  }
  nodes.push({ x: goal.x, z: goal.z });
  const last = nodes.length - 1, toGoal = width(box);
  const clear = (i: number, j: number): boolean => segmentClearance(box, nodes[i]!, nodes[j]!) >= (j === last ? toGoal : a.radius * 0.9);
  // Dijkstra over at most six nodes.
  const cost = nodes.map((_, i) => (i === 0 ? 0 : Infinity)), from = nodes.map(() => -1), done = nodes.map(() => false);
  for (;;) {
    let u = -1;
    for (let i = 0; i <= last; i++) if (!done[i] && cost[i]! < Infinity && (u < 0 || cost[i]! < cost[u]!)) u = i;
    if (u < 0 || u === last) break;
    done[u] = true;
    for (let v = 1; v <= last; v++) {
      if (done[v] || !clear(u, v)) continue;
      const through = cost[u]! + distance(nodes[u]!, nodes[v]!);
      if (through < cost[v]!) { cost[v] = through; from[v] = u; }
    }
  }
  if (cost[last] === Infinity) return null;
  const path: number[] = [];
  for (let at = last; at > 0; at = from[at]!) path.unshift(at);
  // The first waypoint the monster has not reached yet (it may already stand at a corner).
  for (const index of path) if (distance(a, nodes[index]!) > 0.3) return index === last ? null : nodes[index]!;
  return null;
}

/**
 * One monster's turn in the enemy AI: the soldiers' telegraphed windup, strike and recovery with its species' timings,
 * hunting the hero inside its aggro radius (or with its pack, `alerted`) while the hero stays inside the leash, and
 * wandering its circle otherwise. `bite` deals the strike's damage to the hero.
 */
export function monsterStep(world: World, s: CampaignData, blueprint: WorldBlueprint, a: ActorData, alerted: ReadonlySet<string>,
  pack: readonly ActorData[], dt: number, bite: () => void): void {
  const spec = MONSTERS[a.species!], p = s.player;
  if (a.state === 'windup') {
    if (a.stateTime > 0) return;
    a.state = 'attack';
    a.stateTime = 0.12;
    if (p.hp > 0 && distance(a, p) <= a.attackRange + p.radius && distance(a.attackPoint, p) < 2.3) bite();
    return;
  }
  if (a.state === 'attack') {
    if (a.stateTime === 0) { a.state = 'recovery'; a.stateTime = spec.recovery; }
    return;
  }
  if (a.state === 'recovery' && a.stateTime > 0) return;
  const range = distance(a, p);
  const hunting = p.hp > 0 && distance(p, a.home) < MONSTER_RULES.leash &&
    (range < spec.aggro || alerted.has(a.siteId) || (a.target === 'player' && range < spec.aggro * 2));
  if (!hunting) {
    if (a.target !== null) a.stateTime = 0;
    a.target = null;
    a.state = 'idle';
    if (a.stateTime > 0) return;
    const roam = a.roam!, d = distance(a, roam);
    if (d > 0.5) {
      const speed = distance(a, a.home) > MONSTER_RULES.roam ? a.speed * 0.6 : spec.walk;
      const step = Math.min(d, speed * dt), dx = (roam.x - a.x) / d, dz = (roam.z - a.z) / d;
      const before = { x: a.x, z: a.z };
      const gained = travel(blueprint, a, dx, dz, step);
      if (distance(before, a) > 1e-6) a.heading = Math.atan2(a.x - before.x, a.z - before.z);
      // Stuck even weaving round the solid: stop here and choose again (from outside its circle, head for the den).
      if (gained < step * 0.1) a.roam = distance(a, a.home) > MONSTER_RULES.roam ? { x: a.home.x, z: a.home.z } : { x: a.x, z: a.z };
      return;
    }
    a.roam = roamPoint(world, blueprint, a);
    a.stateTime = world.random.range(MONSTER_RULES.pause[0], MONSTER_RULES.pause[1]);
    return;
  }
  a.target = 'player';
  const dx = (p.x - a.x) / (range || 1), dz = (p.z - a.z) / (range || 1);
  a.heading = Math.atan2(dx, dz);
  if (range <= a.attackRange + p.radius && a.cooldown === 0) {
    a.state = 'windup';
    a.stateTime = spec.windup;
    a.cooldown = spec.cooldown;
    a.attackPoint = { x: p.x, z: p.z };
    return;
  }
  a.state = 'chase';
  // Close in on the hero, round any box in the way, weaving round other solids, while keeping apart from the rest of the
  // pack.
  let sx = 0, sz = 0;
  if (range > a.attackRange * 0.8) {
    const way = detour(blueprint, a, p);
    const gx = way ? way.x - a.x : dx, gz = way ? way.z - a.z : dz, g = Math.hypot(gx, gz) || 1;
    sx = gx / g;
    sz = gz / g;
  }
  for (const other of pack) {
    if (other === a || other.hp <= 0) continue;
    const d = distance(a, other), gap = a.radius + other.radius + 0.4;
    if (d > 1e-6 && d < gap) {
      const push = (gap - d) / gap * 1.5;
      sx += (a.x - other.x) / d * push;
      sz += (a.z - other.z) / d * push;
    }
  }
  const length = Math.hypot(sx, sz);
  if (length <= 1e-6) return;
  const before = { x: a.x, z: a.z };
  travel(blueprint, a, sx / length, sz / length, a.speed * dt);
  // Far off it runs where it goes; close in it keeps its eyes on the hero.
  if (range > a.attackRange + 1.5 && distance(before, a) > 1e-6) a.heading = Math.atan2(a.x - before.x, a.z - before.z);
}

/** Bookkeeping when a monster falls: its coins (while there is room on the ground) and its lair's quiet once the whole
 * pack is dead. Monster kills never count towards the hero's kills, level or renown. Returns the coins dropped. */
export function monsterSlain(world: World, s: CampaignData, a: ActorData): number {
  const coins = s.pickups.length < MONSTER_RULES.dropRoom ? MONSTERS[a.species!].coins : 0;
  if (coins) s.pickups.push({ id: `pickup-${++s.transientSequence}`, x: a.x, z: a.z, kind: 'coin', amount: coins });
  if (!actors(world).some(other => other.kind === 'monster' && other.siteId === a.siteId && other.hp > 0)) {
    s.spawner!.lairs[a.siteId]!.cooldown = world.random.range(MONSTER_RULES.cooldown[0], MONSTER_RULES.cooldown[1]);
  }
  return coins;
}
