import type { EntitySnapshot, WorldSnapshot } from '@aegis/core';
import { FACTIONS } from './config';
import { assertRecord, boundedNumber, validatedUpgrades } from './profile';
import { Combatant, type ActorData, type CampaignData } from './state';
import type { GameInput, WorldBlueprint } from './types';
import { distance, isWalkable, projectSegment } from './world';

function shape<T>(value: unknown, template: T, path: string): asserts value is T {
  if (template === null) {
    if (value !== null) throw new Error(`Invalid ${path}`);
  } else if (typeof template === 'number') {
    boundedNumber(value, path, -1_000_000_000, 1_000_000_000);
  } else if (typeof template === 'string') {
    if (typeof value !== 'string' || value.length > 160) throw new Error(`Invalid ${path}`);
  } else if (typeof template === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`Invalid ${path}`);
  } else if (Array.isArray(template)) {
    if (!Array.isArray(value) || value.length > 256) throw new Error(`Invalid ${path} array`);
    for (let i = 0; i < value.length; i++) {
      if (template[0] === undefined) throw new Error(`Unexpected ${path} entries`);
      shape(value[i], template[0], `${path}[${i}]`);
    }
  } else {
    assertRecord(template, path);
    assertRecord(value, path);
    if (Object.keys(value).length !== Object.keys(template).length ||
        Object.keys(value).some(k => !(k in template))) throw new Error(`Unexpected fields in ${path}`);
    for (const key of Object.keys(template)) shape(value[key], template[key], `${path}.${key}`);
  }
}

function oneOf(value: unknown, choices: readonly unknown[], path: string): void {
  if (!choices.includes(value)) throw new Error(`Invalid ${path}`);
}
function same(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) throw new Error(`Inconsistent ${path}`);
}
function timer(value: number, path: string, max = 60): void {
  boundedNumber(value, path, 0, max);
}
function unique(ids: readonly string[], path: string): void {
  if (new Set(ids).size !== ids.length || ids.some(id => !id)) throw new Error(`Duplicate/empty ${path}`);
}
function jsonBudget(value: unknown): void {
  let count = 0;
  const active = new WeakSet<object>();
  const visit = (node: unknown, depth: number): void => {
    if (++count > 25_000 || depth > 20) throw new Error('Save exceeds structural limits');
    if (typeof node === 'number' && !Number.isFinite(node)) throw new Error('Save contains non-finite values');
    if (typeof node === 'string' && node.length > 160) throw new Error('Save string exceeds limit');
    if (node === null || typeof node !== 'object') return;
    if (active.has(node)) throw new Error('Save contains a cycle');
    active.add(node);
    for (const child of Object.values(node)) visit(child, depth + 1);
    active.delete(node);
  };
  visit(value, 0);
}

export function validateSavedWorld(value: unknown, initial: CampaignData, blueprint: WorldBlueprint,
  initialActors: ActorData[], validateInput: (value: unknown) => GameInput): WorldSnapshot {
  jsonBudget(value);
  assertRecord(value, 'Engine save');
  if (value.version !== 1) throw new Error('Unsupported engine snapshot');
  const tick = boundedNumber(value.tick, 'tick', 0, 10_000_000, true);
  assertRecord(value.resources, 'resources');
  const resources = value.resources;
  if (Object.keys(resources).sort().join(',') !== 'KorovanyCampaign,KorovanyIntent') throw new Error('Unexpected game resources');
  const input = validateInput(resources.KorovanyIntent);
  const raw = resources.KorovanyCampaign;
  assertRecord(raw, 'Campaign resource');
  assertRecord(raw.convoy, 'convoy');
  const template: CampaignData = {
    ...initial,
    convoy: { ...initial.convoy, destination: raw.convoy.destination === null ? null : '',
      route: [{ x: 0, z: 0 }] },
    pickups: [{ id: '', kind: 'coin', x: 0, z: 0, amount: 1 }],
    projectiles: [{ id: '', x: 0, z: 0, heading: 0, owner: 'player', faction: 'elf',
      kind: 'arrow', radius: 0.1, remaining: 0, vx: 0, vz: 0, damage: 1 }],
    effects: [{ id: '', x: 0, z: 0, heading: 0, faction: 'elf', kind: 'hit', radius: 1, remaining: 0, duration: 1 }],
    events: [{ id: 1, tick: 0, kind: 'attack', key: '', x: 0, z: 0, amount: 0, targetId: '' }],
    rewards: raw.rewards === null ? null : { runId: '', claimed: false, renown: 0, victory: false },
  };
  shape(raw, template, 'campaign');
  const s = raw;
  same(s.seed, initial.seed, 'seed'); same(s.runId, initial.runId, 'run ID');
  same(s.faction, initial.faction, 'faction'); same(s.worldId, blueprint.id, 'world ID');
  oneOf(s.phase, ['playing', 'victory', 'defeat'], 'phase');
  const p = s.player, cart = s.convoy, faction = FACTIONS[s.faction];
  validatedUpgrades(p.upgrades);
  same(p.id, 'player', 'player ID');
  same(p.maxHp, faction.maxHp + p.upgrades.vitality * 30, 'hero max HP');
  same(p.maxStamina, 100, 'max stamina'); same(p.damage, faction.damage + p.upgrades.damage * 8, 'damage');
  same(p.speed, faction.speed, 'speed'); same(p.radius, 0.65, 'player radius');
  boundedNumber(p.hp, 'hero HP', 0, p.maxHp); boundedNumber(p.stamina, 'stamina', 0, 100);
  boundedNumber(p.coins, 'coins', 0, 10_000, true); boundedNumber(p.supplies, 'supplies', 0, 90, true);
  boundedNumber(p.kills, 'kills', 0, 18, true); same(p.level, 1 + Math.floor(p.kills / 4), 'level');
  boundedNumber(p.heading, 'heading', -Math.PI, Math.PI);
  if (!isWalkable(blueprint, p, p.radius)) throw new Error('Player is outside walkable world');
  oneOf(p.state, ['idle', 'moving', 'attack', 'dodge', 'dead'], 'player state');
  timer(p.attackCooldown, 'attack cooldown', faction.attackCooldown);
  timer(p.abilityCooldown, 'ability cooldown', faction.abilityCooldown);
  timer(p.abilityDuration, 'ability duration', 5); timer(p.dodgeCooldown, 'dodge cooldown', 0.85);
  timer(p.invulnerable, 'invulnerability', 0.3);
  same(cart.id, 'convoy', 'convoy ID'); same(cart.faction, s.faction, 'convoy faction');
  const baseHp = s.faction === 'guard' ? 280 : s.faction === 'villain' ? 250 : 210;
  same(cart.maxHp, baseHp + p.upgrades.logistics * 50, 'convoy HP');
  same(cart.capacity, 120 + p.upgrades.logistics * 30, 'capacity');
  same(cart.speed, (s.faction === 'elf' ? 5.6 : 4.7) + p.upgrades.logistics * 0.45, 'convoy speed');
  same(cart.radius, 1.5, 'convoy radius');
  boundedNumber(cart.hp, 'convoy HP', 0, cart.maxHp); boundedNumber(cart.cargo, 'cargo', 0, cart.capacity, true);
  boundedNumber(cart.repairProgress, 'repair progress', 0, 1); boundedNumber(cart.delivered, 'delivered', 0, 90, true);
  boundedNumber(cart.heading, 'convoy heading', -Math.PI, Math.PI);
  oneOf(cart.mode, ['hold', 'follow', 'return', 'route'], 'convoy mode');
  if (cart.destination !== null && !blueprint.roads.nodes.some(n => n.id === cart.destination)) throw new Error('Unknown route destination');
  if ((cart.mode === 'route' || cart.mode === 'return') && cart.destination === null) throw new Error('Missing convoy destination');
  const onRoad = (point: { x: number; z: number }): boolean => blueprint.roads.edges.some(e => {
    const a = blueprint.roads.nodes.find(n => n.id === e.from)!;
    const b = blueprint.roads.nodes.find(n => n.id === e.to)!;
    return distance(point, projectSegment(point, a, b)) < 0.01;
  });
  if (!onRoad(cart) || !isWalkable(blueprint, cart, cart.radius)) throw new Error('Convoy is off the road');
  if (cart.route.length > 16 || cart.route.some(point => !onRoad(point))) throw new Error('Invalid convoy path');
  const path = [cart, ...cart.route];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!;
    const steps = Math.max(1, Math.ceil(distance(a, b)));
    for (let j = 1; j < steps; j++) {
      if (!onRoad({ x: a.x + (b.x - a.x) * j / steps, z: a.z + (b.z - a.z) * j / steps })) {
        throw new Error('Convoy path cuts across terrain');
      }
    }
  }
  if (cart.hp === 0 && !cart.disabled) throw new Error('Wreck must be disabled');
  same(s.outposts.length, 3, 'outpost count');
  unique(s.outposts.map(post => post.id), 'outpost IDs');
  for (const post of s.outposts) {
    const base = initial.outposts.find(p => p.id === post.id);
    if (!base) throw new Error('Unknown outpost');
    for (const key of ['x', 'z', 'nameKey', 'faction', 'captureRadius', 'supplyRequired'] as const) same(post[key], base[key], `post ${key}`);
    oneOf(post.owner, ['enemy', 'player'], 'post owner');
    boundedNumber(post.captureProgress, 'capture progress', 0, 1);
    boundedNumber(post.defendersRemaining, 'defenders', 0, 3, true);
    if ((post.owner === 'player') !== (post.captureProgress === 1)) throw new Error('Inconsistent capture progress');
    if (post.owner === 'player' && post.defendersRemaining !== 0) throw new Error('Captured post has defenders');
    if (post.supplied && post.owner !== 'player') throw new Error('Enemy post cannot be supplied');
  }
  same(cart.delivered, s.outposts.filter(p => p.supplied).length * 30, 'delivery count');
  same(cart.cargo + p.supplies + cart.delivered + s.pickups.filter(p => p.kind === 'supply').reduce((n, p) => n + p.amount, 0),
    s.raidComplete ? 120 : 30, 'supply conservation');
  for (const key of ['id', 'x', 'z', 'bossId'] as const) same(s.fortress[key], initial.fortress[key], `fortress ${key}`);
  same(s.fortress.unlocked, s.raidComplete && cart.delivered >= 60, 'fortress unlock');
  boundedNumber(s.fortress.reinforcementWaves, 'reinforcement waves', 0, 1, true);
  boundedNumber(s.spawnSequence, 'spawn sequence', 0, 3, true);
  same(s.spawnSequence, s.fortress.reinforcementWaves * 3, 'spawn count');
  boundedNumber(s.eventSequence, 'event sequence', 0, 10_000_000, true);
  boundedNumber(s.transientSequence, 'transient sequence', 0, 10_000_000, true);
  timer(s.followTimer, 'follow timer', 1); timer(s.convoyWeaponTimer, 'convoy weapon timer', 2.5);
  timer(s.reinforcementTimer, 'reinforcement timer', 2.1);
  if (Math.hypot(s.dodgeDirection.x, s.dodgeDirection.z) > 1.00001) throw new Error('Invalid dodge vector');
  if (s.pickups.length > 40 || s.projectiles.length > 96 || s.effects.length > 48 || s.events.length > 32) throw new Error('Transient limits exceeded');
  const point = (at: { x: number; z: number }): void => {
    boundedNumber(at.x, 'position.x', -71, 71); boundedNumber(at.z, 'position.z', -71, 71);
  };
  for (const item of s.pickups) {
    point(item); oneOf(item.kind, ['coin', 'health', 'supply'], 'pickup kind');
    boundedNumber(item.amount, 'pickup amount', 1, 90, true);
  }
  for (const projectile of s.projectiles) {
    point(projectile); oneOf(projectile.owner, ['player', 'enemy'], 'projectile owner');
    oneOf(projectile.faction, ['elf', 'guard', 'villain'], 'projectile faction');
    oneOf(projectile.kind, ['arrow', 'bolt', 'siege'], 'projectile kind');
    boundedNumber(projectile.damage, 'projectile damage', 1, 150); timer(projectile.remaining, 'projectile life', 2);
    boundedNumber(projectile.radius, 'projectile radius', 0.1, 0.5);
    boundedNumber(projectile.heading, 'projectile heading', -Math.PI, Math.PI);
    const speed = Math.hypot(projectile.vx, projectile.vz);
    boundedNumber(speed, 'projectile speed', 17.99999, 28.00001);
    if (Math.abs(projectile.vx - Math.sin(projectile.heading) * speed) > 0.00001 ||
        Math.abs(projectile.vz - Math.cos(projectile.heading) * speed) > 0.00001) throw new Error('Inconsistent projectile heading');
    if (projectile.owner === 'player') same(projectile.faction, s.faction, 'friendly projectile faction');
  }
  for (const item of s.effects) {
    point(item); oneOf(item.faction, ['elf', 'guard', 'villain'], 'effect faction');
    oneOf(item.kind, ['slash', 'volley', 'cleave', 'shield', 'hit', 'heal', 'capture', 'delivery', 'explosion'], 'effect kind');
    timer(item.remaining, 'effect life', item.duration); timer(item.duration, 'effect duration', 1);
    boundedNumber(item.radius, 'effect radius', 0, 20);
    boundedNumber(item.heading, 'effect heading', -Math.PI, Math.PI);
  }
  for (let i = 0; i < s.events.length; i++) {
    const event = s.events[i]!;
    point(event); boundedNumber(event.id, 'event ID', 1, s.eventSequence, true);
    boundedNumber(event.tick, 'event tick', 0, tick, true); boundedNumber(event.amount, 'event amount', 0, 10_000);
    oneOf(event.kind, ['attack', 'hurt', 'kill', 'pickup', 'capture', 'delivery', 'raid', 'convoy', 'repair', 'upgrade', 'ability', 'fortress', 'victory', 'defeat', 'notice'], 'event kind');
    oneOf(event.key, ['event.attack', 'event.hurt', 'event.kill', 'event.coin', 'event.health',
      'event.supply', 'event.capture', 'event.delivery', 'event.raid', 'event.convoy', 'event.disabled',
      'event.repair', 'event.upgrade', 'event.ability', 'event.fortress', 'event.victory', 'event.defeat',
      'notice.location', 'notice.coins', 'notice.max', 'notice.destination'], 'event localization key');
    same(event.id, s.eventSequence - s.events.length + i + 1, 'event history sequence');
    if (i > 0 && (event.id <= s.events[i - 1]!.id || event.tick < s.events[i - 1]!.tick)) throw new Error('Unordered event history');
  }
  unique([...s.pickups, ...s.projectiles, ...s.effects].map(item => item.id), 'transient IDs');
  const transientIds = new Set<number>();
  for (const item of [...s.pickups, ...s.projectiles, ...s.effects]) {
    const id = /^(pickup|projectile|effect)-(\d+)$/.exec(item.id);
    if (!id || Number(id[2]) < 1 || Number(id[2]) > s.transientSequence || transientIds.has(Number(id[2]))) throw new Error('Invalid transient ID');
    transientIds.add(Number(id[2]));
  }
  if ((s.phase === 'playing') !== (s.rewards === null)) throw new Error('Inconsistent terminal rewards');
  if (s.phase === 'playing' && (p.hp === 0 || s.fortress.bossDefeated)) throw new Error('Invalid playing outcome');
  if (s.phase === 'defeat' && (p.hp !== 0 || p.state !== 'dead')) throw new Error('Invalid defeat');
  if (s.phase === 'victory' && (p.hp <= 0 || !s.fortress.bossDefeated || !s.fortress.unlocked)) throw new Error('Invalid victory');
  if (s.rewards) {
    same(s.rewards.runId, s.runId, 'reward run ID'); same(s.rewards.claimed, false, 'reward claim');
    same(s.rewards.victory, s.phase === 'victory', 'reward outcome');
    same(s.rewards.renown, (s.phase === 'victory' ? 60 : 5) + s.outposts.filter(p => p.owner === 'player').length * 10 + Math.floor(p.kills / 3), 'reward amount');
  }
  if (!Array.isArray(value.entities) || value.entities.length > 18) throw new Error('Invalid actor count');
  const entities: EntitySnapshot[] = [];
  const actorIds: string[] = [];
  const aliveByPost = new Map<string, number>();
  for (const entry of value.entities) {
    assertRecord(entry, 'entity'); assertRecord(entry.components, 'components');
    if (typeof entry.id !== 'string' || !/^\d{1,20}$/.test(entry.id)) throw new Error('Invalid entity ID');
    if (Object.keys(entry.components).join(',') !== 'KorovanyCombatant') throw new Error('Unexpected component');
    const rawActor = entry.components.KorovanyCombatant;
    assertRecord(rawActor, 'actor');
    const actorTemplate = Combatant.create({ target: rawActor.target === null ? null : 'player' });
    shape(rawActor, actorTemplate, 'actor');
    const a = rawActor;
    const reinforcement = /^reinforcement-([123])$/.exec(a.id);
    const original = initialActors.find(original => original.id === a.id);
    if (original) {
      for (const key of ['kind', 'siteId', 'faction', 'maxHp', 'radius', 'damage', 'speed', 'attackRange'] as const) {
        same(a[key], original[key], `actor ${a.id} ${key}`);
      }
      if (a.siteId !== 'raid' || a.id === 'enemy-caravan' || tick === 0) {
        same(a.home.x, original.home.x, 'actor home X'); same(a.home.z, original.home.z, 'actor home Z');
      } else if (a.id !== 'enemy-caravan') {
        boundedNumber(a.home.x, 'raid escort home X', 6.9, 42.1); same(a.home.z, -24, 'raid escort home Z');
      }
    } else if (reinforcement && Number(reinforcement[1]) <= s.spawnSequence) {
      same(a.kind, 'soldier', 'reinforcement kind'); same(a.siteId, 'fortress', 'reinforcement site');
      same(a.faction, 'villain', 'reinforcement faction');
      same(a.home.x, (Number(reinforcement[1]) - 2) * 3, 'reinforcement home X');
      same(a.home.z, s.fortress.z + 5, 'reinforcement home Z');
    } else throw new Error('Unknown actor identity');
    point(a); point(a.home); point(a.attackPoint);
    boundedNumber(a.heading, 'actor heading', -Math.PI, Math.PI);
    oneOf(a.kind, ['soldier', 'archer', 'captain', 'boss', 'caravan'], 'actor kind');
    oneOf(a.faction, ['elf', 'guard', 'villain'], 'actor faction');
    oneOf(a.state, ['idle', 'chase', 'windup', 'attack', 'recovery', 'dead'], 'actor state');
    oneOf(a.target, ['player', 'convoy', null], 'actor target');
    const post = initial.outposts.find(post => post.id === a.siteId);
    if (!post && a.siteId !== 'raid' && a.siteId !== 'fortress') throw new Error('Invalid actor site');
    const expectedHp = a.kind === 'boss' ? 480 : a.kind === 'caravan' ? 170 : a.kind === 'captain' ? 90 : a.kind === 'archer' ? 48 : 60;
    same(a.maxHp, expectedHp, 'actor max HP');
    boundedNumber(a.hp, 'actor HP', 0, a.maxHp);
    same(a.state === 'dead', a.hp === 0, 'actor death');
    same(a.radius, a.kind === 'caravan' ? 1.5 : a.kind === 'boss' ? 1.3 : 0.7, 'actor radius');
    same(a.damage, a.kind === 'boss' ? 24 : a.kind === 'captain' ? 17 : a.kind === 'archer' ? 10 : 12, 'actor damage');
    same(a.speed, a.kind === 'boss' ? 3.6 : a.kind === 'archer' ? 3 : 3.5, 'actor speed');
    same(a.attackRange, a.kind === 'archer' ? 14 : a.kind === 'boss' ? 4.3 : 2.4, 'actor range');
    timer(a.cooldown, 'actor cooldown', 2.6); timer(a.stateTime, 'AI state timer', 1.1); timer(a.deadTime, 'corpse age', 8.1);
    oneOf(a.patrolDirection, [-1, 1], 'patrol direction');
    if (!isWalkable(blueprint, a, a.radius)) throw new Error('Actor outside walkable geometry');
    if (a.hp > 0) aliveByPost.set(a.siteId, (aliveByPost.get(a.siteId) ?? 0) + 1);
    actorIds.push(a.id);
    entities.push({ id: entry.id, components: { KorovanyCombatant: a } });
  }
  unique(actorIds, 'actor IDs');
  const allowedIds = new Set([
    ...initial.outposts.flatMap(post => [`${post.id}-soldier`, `${post.id}-archer`, `${post.id}-captain`]),
    'enemy-caravan', 'raid-guard-1', 'raid-guard-2', 'boss', 'fortress-guard--1', 'fortress-guard-1',
    ...Array.from({ length: s.spawnSequence }, (_, i) => `reinforcement-${i + 1}`),
  ]);
  if (actorIds.some(id => !allowedIds.has(id))) throw new Error('Unknown actor ID');
  same(p.kills + entities.filter(e => {
    const data = e.components.KorovanyCombatant;
    assertRecord(data, 'actor');
    return typeof data.hp === 'number' && data.hp > 0;
  }).length, 15 + s.spawnSequence, 'kill conservation');
  for (const post of s.outposts) same(post.defendersRemaining, aliveByPost.get(post.id) ?? 0, 'defender count');
  const livingCaravan = entities.some(e => {
    const a = e.components.KorovanyCombatant;
    assertRecord(a, 'actor');
    return a.id === 'enemy-caravan' && typeof a.hp === 'number' && a.hp > 0;
  });
  same(s.raidComplete, !livingCaravan, 'raid outcome');
  const livingBoss = entities.some(e => {
    const a = e.components.KorovanyCombatant;
    assertRecord(a, 'actor');
    return a.id === 'boss' && typeof a.hp === 'number' && a.hp > 0;
  });
  same(s.fortress.bossDefeated, !livingBoss, 'boss outcome');
  assertRecord(value.prng, 'PRNG');
  if (!Array.isArray(value.prng.s) || value.prng.s.length !== 4) throw new Error('Invalid PRNG');
  const words = value.prng.s.map((word, i) => boundedNumber(word, `PRNG word ${i}`, 0, 0xffffffff, true));
  if (words.every(word => word === 0)) throw new Error('Degenerate PRNG state');
  assertRecord(value.allocator, 'allocator');
  if (!Array.isArray(value.allocator.slots) || value.allocator.slots.length > 18 ||
      !Array.isArray(value.allocator.free) || value.allocator.free.length > 18) throw new Error('Invalid allocator');
  const slots = value.allocator.slots.map((slot, i) => boundedNumber(slot, `slot ${i}`, 0, 0xffffffff, true));
  const free = value.allocator.free.map((slot, i) => boundedNumber(slot, `free slot ${i}`, 0, 17, true));
  return {
    version: 1, tick, entities, resources: { KorovanyCampaign: s, KorovanyIntent: input },
    prng: { s: words }, allocator: { slots, free },
  };
}
