/**
 * Campaign battles. Nobody deals damage in the field: a hostile that reaches the hero (contact) or one the hero's swing
 * or arrow lands on (a first strike) opens a turn-based battle with timed defence (`./battle`). The battle runs inside
 * the world simulation, one battle tick per world tick while an action plays (on the hero's turn the world ticks but the
 * battle waits for a command), until every enemy falls (the field resumes) or the hero does (the campaign is lost).
 *
 * Participants: the trigger, its group (its post, raid, fortress or lair) within 30 m and other engaged hostiles within
 * 18 m (wandering monsters of other packs stay out), at most five; the fortress's one reinforcement wave may join the
 * final battle. Friendly troops within 22 m and the convoy's weapon fight beside the hero; the convoy and an escorted
 * shipment within 16 m are wards the enemies may strike instead of the hero.
 *
 * Saves: `CampaignData.battle` holds the battle record. The session saves the world as it stood when the battle began
 * (a checkpoint), so restoring a save taken mid-battle restarts that battle. The validator regenerates the record from
 * the saved world and rejects any difference.
 */
import type { System, World } from '@aegis/core';
import {
  battleSnapshot, ENEMY_KITS, HERO_KITS, joinBattle, RULES, startBattle, tickBattle,
  type AllyKind, type BattleActionState, type BattleDifficulty, type BattleLogEntry, type BattleOpening, type BattleSnapshot,
  type BattleState, type EnemyKind, type WardId,
} from './battle';
import { FACTIONS } from './config';
import { SHIPMENT_NAME } from './faction-campaigns';
import { MONSTER_RULES } from './monsters';
import { assertRecord } from './profile';
import { contactRange, countDefenders, createActor, defeatActor, effect, emit, hostileActive, resolveOutcome, type PendingStrike } from './rules';
import { actors, campaign, Intent, type ActorData, type CampaignData } from './state';
import type { ActorState, FactionId, LocalizedText, Position, Vec2, WorldBlueprint } from './types';
import { distance, isWalkable, moveWithCollision } from './world';

export const BATTLE_REACH = {
  /** The trigger's group joins from this far; other engaged hostiles from `nearby`. */
  group: 30,
  nearby: 18,
  /** Most enemies when a battle begins; the fortress's reinforcements may join up to the engine's limit. */
  enemies: 5,
  /** Friendly troops fight beside the hero from this far, at most `allyCount` of them. */
  allies: 22,
  allyCount: 3,
  /** The convoy (its weapon and as a ward) and an escorted shipment take part from this far. */
  wagons: 16,
  /** Melee enemies this close start in the close band. */
  close: 5,
} as const;

/** Battle options from the shell's settings; they apply to battles that begin afterwards. */
export interface BattleOptions {
  difficulty: BattleDifficulty;
  /** The player's measured input and display latency, 0-12 ticks. */
  latencyTicks: number;
}
export const DEFAULT_BATTLE_OPTIONS: Readonly<BattleOptions> = { difficulty: 'standard', latencyTicks: 0 };

/** A campaign battle's engine setup, with every field explicit. */
export interface CampaignBattleSetup {
  seed: number;
  faction: FactionId;
  enemies: { id: string; kind: EnemyKind; hp: number; band?: 'close' }[];
  allies: { id: string; kind: AllyKind }[];
  wards: { id: WardId; hp: number; maxHp: number }[];
  hero: { hp: number; maxHp: number; damage: number };
  difficulty: BattleDifficulty;
  opening: BattleOpening;
  latencyTicks: number;
}
/** An enemy's places on the battlefield: in the close band and in the far band. */
export interface BattleSlot { id: string; close: Vec2; far: Vec2 }
export interface BattleRecord {
  version: 1;
  /** The hostile whose contact or wound began the battle. */
  trigger: string;
  setup: CampaignBattleSetup;
  /** Where the hero stands, facing the trigger. */
  anchor: Position;
  stage: BattleSlot[];
  /** The fortress's reinforcement wave has joined. */
  reinforced: boolean;
  /** The last log entry and action shown in the world. */
  seen: { log: number; action: number };
  state: BattleState;
}

/** The battle as the shell shows it: the engine's snapshot and every participant's display name. */
export interface BattleView extends BattleSnapshot {
  names: Record<string, LocalizedText>;
}

/** The convoy's weapon fighting as an ally. */
export const CART_ALLY_ID = 'convoy-cart';
const SKILLS = new Set(['aimed-shot', 'volley', 'fall-back', 'shield-bash', 'bulwark', 'cleave', 'warcry']);
const IDLE: readonly [ActorState, number] = ['idle', 0];
/** Enemies walk to their places at this pace (metres per second). */
const STAGE_SPEED = 9;
/** Directions round an enemy's bearing tried for its places, in radians. */
const SPREAD = [0, 0.55, -0.55, 1.1, -1.1, 1.65, -1.65, 2.2, -2.2, 2.75, -2.75];
const dec = (v: number, dt: number): number => Math.max(0, v - dt);

/** The kit a hostile fights with. */
export function enemyKind(a: ActorData): EnemyKind {
  if (a.kind === 'monster') return a.species!;
  if (a.kind === 'boss') return a.faction === 'guard' ? 'marshal' : 'warlord';
  return a.kind;
}
const battleHp = (a: ActorData, kind: EnemyKind): number => Math.max(1, Math.round(ENEMY_KITS[kind].maxHp * a.hp / a.maxHp));
/** The hero's battle stats: campaign HP, and the kit's damage scaled by damage upgrades. */
function heroSpec(s: CampaignData): CampaignBattleSetup['hero'] {
  const p = s.player;
  return { hp: p.hp, maxHp: p.maxHp, damage: HERO_KITS[s.faction].damage * p.damage / FACTIONS[s.faction].damage };
}
const byDistance = (from: Vec2) => (left: ActorData, right: ActorData): number =>
  distance(left, from) - distance(right, from) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

function participants(s: CampaignData, all: readonly ActorData[], trigger: ActorData): ActorData[] {
  const p = s.player;
  // A wandering monster of another pack is not part of this fight until it hunts the hero.
  const engaged = (a: ActorData): boolean => a.kind !== 'monster' || a.target === 'player';
  const rest = all.filter(a => a !== trigger && hostileActive(s, a)).sort(byDistance(p));
  const group = rest.filter(a => a.siteId === trigger.siteId && distance(a, p) <= BATTLE_REACH.group);
  const others = rest.filter(a => a.siteId !== trigger.siteId && distance(a, p) <= BATTLE_REACH.nearby && engaged(a));
  return [trigger, ...group, ...others].slice(0, BATTLE_REACH.enemies);
}

function alliesOf(s: CampaignData, all: readonly ActorData[]): CampaignBattleSetup['allies'] {
  const p = s.player;
  const troops = all.filter(a => a.hp > 0 && a.allegiance === 'friendly' && a.kind !== 'caravan' && a.kind !== 'monster' &&
    a.kind !== 'boss' && distance(a, p) <= BATTLE_REACH.allies).sort(byDistance(p)).slice(0, BATTLE_REACH.allyCount)
    .map(a => ({ id: a.id, kind: a.kind as AllyKind }));
  const cart = s.convoy;
  if (s.faction !== 'guard' && cart.hp > 0 && !cart.disabled && distance(cart, p) <= BATTLE_REACH.wagons) {
    troops.push({ id: CART_ALLY_ID, kind: s.faction === 'elf' ? 'arrow-cart' : 'siege-cart' });
  }
  return troops;
}

/** The escorted shipment, while it travels under the hero's protection. */
function escortedShipment(s: CampaignData, all: readonly ActorData[]): ActorData | undefined {
  return s.military && !s.military.shipment.delivered
    ? all.find(a => a.id === 'enemy-caravan' && a.allegiance === 'friendly' && a.hp > 0) : undefined;
}

function wardsOf(s: CampaignData, all: readonly ActorData[]): CampaignBattleSetup['wards'] {
  const p = s.player, wards: CampaignBattleSetup['wards'] = [];
  if (s.convoy.hp > 0 && !s.convoy.disabled && distance(s.convoy, p) <= BATTLE_REACH.wagons) {
    wards.push({ id: 'convoy', hp: s.convoy.hp, maxHp: s.convoy.maxHp });
  }
  const wagon = escortedShipment(s, all);
  if (wagon && distance(wagon, p) <= BATTLE_REACH.wagons) wards.push({ id: 'shipment', hp: wagon.hp, maxHp: wagon.maxHp });
  return wards;
}

interface Body { at: Vec2; radius: number }
/** Bodies an enemy's places must keep clear of: the hero, the convoy and every other living actor near the hero. */
function bodiesAround(s: CampaignData, all: readonly ActorData[], anchor: Vec2, except: ReadonlySet<string>): Body[] {
  const bodies: Body[] = [{ at: { x: anchor.x, z: anchor.z }, radius: s.player.radius }];
  if (distance(s.convoy, anchor) < 14) bodies.push({ at: { x: s.convoy.x, z: s.convoy.z }, radius: s.convoy.radius });
  for (const a of all) {
    if (a.hp > 0 && !except.has(a.id) && distance(a, anchor) < 14) bodies.push({ at: { x: a.x, z: a.z }, radius: a.radius });
  }
  return bodies;
}

/** Each enemy's places: on its bearing from the hero (or turned aside when taken or blocked), walkable and clear of
 * others; a wagon, or an enemy with no room, keeps its own place. Monsters stay within their leash. */
function stageSlots(blueprint: WorldBlueprint, anchor: Position, heroRadius: number, enemies: readonly ActorData[],
  bodies: Body[]): BattleSlot[] {
  return enemies.map(a => {
    const own = { id: a.id, close: { x: a.x, z: a.z }, far: { x: a.x, z: a.z } };
    if (a.kind === 'caravan') {
      bodies.push({ at: own.close, radius: a.radius });
      return own;
    }
    const fits = (at: Vec2): boolean => isWalkable(blueprint, at, a.radius) &&
      (a.kind !== 'monster' || distance(at, a.home) <= MONSTER_RULES.leash + MONSTER_RULES.roam - 0.5) &&
      bodies.every(body => distance(body.at, at) >= body.radius + a.radius + 0.3);
    const bearing = distance(a, anchor) > 0.5 ? Math.atan2(a.x - anchor.x, a.z - anchor.z) : anchor.heading;
    let slot: BattleSlot = own;
    for (const turn of SPREAD) {
      const angle = bearing + turn;
      const point = (r: number): Vec2 => ({ x: anchor.x + Math.sin(angle) * r, z: anchor.z + Math.cos(angle) * r });
      const close = point(heroRadius + a.radius + 1.1);
      if (!fits(close)) continue;
      const far = [8, 6.5, 5].map(r => point(r + a.radius)).find(fits);
      if (far) { slot = { id: a.id, close, far }; break; }
    }
    bodies.push({ at: slot.close, radius: a.radius }, { at: slot.far, radius: a.radius });
    return slot;
  });
}

/**
 * The battle a trigger begins, computed from the world alone: the participants, the stage, the setup and the engine's
 * starting state. The engagement uses it to begin battles and the validator to check saved ones.
 */
export function planBattle(blueprint: WorldBlueprint, s: CampaignData, all: readonly ActorData[], triggerId: string,
  opening: BattleOpening, seed: number): BattleRecord {
  const p = s.player;
  const trigger = all.find(a => a.id === triggerId && hostileActive(s, a));
  if (!trigger) throw new Error('A battle needs an active hostile trigger');
  const enemies = participants(s, all, trigger);
  const anchor = { x: p.x, z: p.z, heading: Math.atan2(trigger.x - p.x, trigger.z - p.z) };
  const allies = alliesOf(s, all);
  const options = s.battleOptions ?? DEFAULT_BATTLE_OPTIONS;
  const setup: CampaignBattleSetup = {
    seed, faction: s.faction,
    enemies: enemies.map(a => {
      const kind = enemyKind(a);
      return { id: a.id, kind, hp: battleHp(a, kind),
        ...(!ENEMY_KITS[kind].ranged && distance(a, p) <= BATTLE_REACH.close ? { band: 'close' as const } : {}) };
    }),
    allies, wards: wardsOf(s, all), hero: heroSpec(s),
    difficulty: options.difficulty, opening, latencyTicks: options.latencyTicks,
  };
  const stage = stageSlots(blueprint, anchor, p.radius, enemies, bodiesAround(s, all, anchor, new Set(enemies.map(a => a.id))));
  return {
    version: 1, trigger: trigger.id, setup, anchor, stage, reinforced: false, seen: { log: 0, action: 0 },
    state: startBattle(setup),
  };
}

function beginBattle(world: World, blueprint: WorldBlueprint, s: CampaignData, all: readonly ActorData[], trigger: ActorData,
  opening: BattleOpening): void {
  const record = planBattle(blueprint, s, all, trigger.id, opening, world.random.nextUint32());
  s.battle = record;
  const p = s.player, byId = new Map(all.map(a => [a.id, a]));
  p.heading = record.anchor.heading;
  p.state = 'idle';
  p.invulnerable = 0;
  // Missiles in flight would hang in the air while the battle runs.
  s.projectiles = [];
  for (const e of record.setup.enemies) Object.assign(byId.get(e.id)!, { target: 'player', state: 'idle', stateTime: 0 });
  for (const ally of record.setup.allies) {
    const a = byId.get(ally.id);
    if (a) Object.assign(a, { target: null, state: 'idle', stateTime: 0 });
  }
  emit(world, s, 'battle', 'event.battle', p, record.setup.enemies.length, trigger.id);
}

/**
 * The engagement check, after the field's systems: a field attack that landed on a hostile this tick (`strike`) opens a
 * battle with a first strike; otherwise a hostile hunting the hero within contact range opens one, as an ambush when it
 * comes from behind the hero.
 */
export function engagementSystem(blueprint: WorldBlueprint, strike: PendingStrike): System {
  return {
    name: 'KorovanyEngagement', phase: 'postUpdate',
    run(ctx) {
      const s = campaign(ctx.world), struck = strike.target;
      strike.target = null;
      if (s.battle || s.phase !== 'playing' || s.player.hp <= 0) return;
      const p = s.player, all = actors(ctx.world);
      const first = struck === null ? undefined : all.find(a => a.id === struck && hostileActive(s, a));
      if (first) {
        beginBattle(ctx.world, blueprint, s, all, first, 'first-strike');
        return;
      }
      const contact = all.filter(a => hostileActive(s, a) && a.target === 'player' && distance(a, p) <= contactRange(a, p))
        .sort(byDistance(p))[0];
      if (!contact) return;
      const d = distance(contact, p) || 1;
      const facing = (Math.sin(p.heading) * (contact.x - p.x) + Math.cos(p.heading) * (contact.z - p.z)) / d;
      beginBattle(ctx.world, blueprint, s, all, contact, facing < -0.35 ? 'ambushed' : 'neutral');
    },
  };
}

/** Pose of a blow-dealing action: winding up to each blow, striking round its impact, recovering after the last. */
function blowPose(impacts: readonly number[], end: number, now: number): readonly [ActorState, number] {
  const next = impacts.find(impact => impact + 4 >= now);
  if (next === undefined) return ['recovery', Math.max(0, end - now) / 60];
  return now < next - 6 ? ['windup', (next - 6 - now) / 60] : ['attack', (next + 4 - now) / 60];
}
function actionPose(action: BattleActionState, now: number): readonly [ActorState, number] {
  if (action.hits.length) return blowPose(action.hits.map(hit => hit.impact), action.end, now);
  if (action.strikes.length) return blowPose(action.strikes.map(entry => entry.at), action.end, now);
  if (action.move === 'recover') return ['recovery', Math.max(0, action.end - now) / 60];
  return IDLE;
}
const face = (a: { x: number; z: number; heading: number }, at: Vec2): void => {
  if (distance(a, at) > 0.05) a.heading = Math.atan2(at.x - a.x, at.z - a.z);
};
/** Keeps a fallen or stranded enemy where saves accept it: on walkable ground and, for a monster, within its leash. */
function settle(blueprint: WorldBlueprint, a: ActorData, slot: BattleSlot | undefined): void {
  if (!slot) return;
  const valid = (at: Vec2): boolean => isWalkable(blueprint, at, a.radius) &&
    (a.kind !== 'monster' || distance(at, a.home) <= MONSTER_RULES.leash + MONSTER_RULES.roam);
  if (valid(a)) return;
  const place = [slot.close, slot.far].sort((l, r) => distance(a, l) - distance(a, r)).find(valid) ?? slot.far;
  a.x = place.x;
  a.z = place.z;
}

function showEntry(world: World, blueprint: WorldBlueprint, s: CampaignData, record: BattleRecord, entry: BattleLogEntry,
  byId: ReadonlyMap<string, ActorData>): void {
  const p = s.player, wagon = byId.get('enemy-caravan');
  switch (entry.kind) {
    case 'damage':
      if (entry.target === 'hero') {
        emit(world, s, 'hurt', 'event.hurt', p, entry.amount, 'player');
        effect(s, 'hit', p, 1);
      } else if (entry.target === 'convoy') {
        emit(world, s, 'hurt', 'event.hurt', s.convoy, entry.amount, 'convoy');
        effect(s, 'hit', s.convoy, 1.5);
      } else if (entry.target === 'shipment') {
        if (wagon) {
          emit(world, s, 'hurt', 'event.hurt', wagon, entry.amount, wagon.id);
          effect(s, 'hit', wagon, 1.5);
        }
      } else {
        const a = byId.get(entry.target);
        if (a) effect(s, 'hit', a, a.radius + 0.5);
      }
      break;
    case 'ward-down':
      if (entry.target === 'convoy') {
        s.convoy.hp = 0;
        s.convoy.disabled = true;
        s.convoy.repairProgress = 0;
        emit(world, s, 'convoy', 'event.disabled', s.convoy, 0, 'convoy');
      } else if (wagon && s.military) {
        wagon.hp = 0;
        s.military.shipment.repairProgress = 0;
      }
      break;
    case 'heal': {
      const at = entry.target === 'hero' ? p : entry.target === 'convoy' ? s.convoy : wagon;
      if (at) effect(s, 'heal', at, 1.6);
      break;
    }
    case 'parry':
      emit(world, s, 'parry', 'event.parry', p, 0, entry.target);
      effect(s, 'shield', p, 1.4, p.heading);
      break;
    case 'break': {
      const a = byId.get(entry.target);
      if (a) effect(s, 'explosion', a, a.radius + 1, a.heading);
      break;
    }
    case 'defeated': {
      const a = byId.get(entry.target);
      if (a && a.hp > 0) {
        settle(blueprint, a, record.stage.find(slot => slot.id === a.id));
        defeatActor(world, s, a);
      }
      break;
    }
    case 'rally': {
      const a = byId.get(entry.actor);
      if (a) effect(s, 'heal', a, 3);
      break;
    }
    case 'protect':
      effect(s, 'shield', p, 2.2, p.heading);
      break;
    default:
      break;
  }
}

/** Effects at the moment a hero's or an ally's strike lands, and the hero's swing or skill as an action begins. */
function showAction(world: World, s: CampaignData, action: BattleActionState, began: boolean, now: number,
  byId: ReadonlyMap<string, ActorData>): void {
  const p = s.player, target = action.target === null ? undefined : byId.get(action.target);
  if (action.actor === 'hero') {
    if (began && (action.move === 'attack' || action.move === 'counter')) emit(world, s, 'attack', 'event.attack', p, 0, 'player');
    if (began && SKILLS.has(action.move)) emit(world, s, 'ability', 'event.ability', p, 0, s.faction);
    if (began && action.move === 'bulwark') effect(s, 'shield', p, 4, p.heading);
    if (began && action.move === 'warcry') effect(s, 'shield', p, 6, p.heading);
    if (!action.strikes.some(entry => entry.at === now)) return;
    if (action.move === 'volley' || action.move === 'fall-back') effect(s, 'volley', p, 6, p.heading);
    else if (action.move === 'cleave') effect(s, 'cleave', p, 4, p.heading);
    else if (s.faction !== 'elf') effect(s, 'slash', p, FACTIONS[s.faction].attackRange, p.heading);
  } else if (action.actor === CART_ALLY_ID && target && action.strikes.some(entry => entry.at === now)) {
    if (s.faction === 'villain') effect(s, 'explosion', target, 2.5, target.heading);
    else effect(s, 'volley', s.convoy, Math.min(20, distance(s.convoy, target)), Math.atan2(target.x - s.convoy.x, target.z - s.convoy.z));
  }
}

/** The fortress's single reinforcement wave joins the final battle once the commander is badly hurt. */
function reinforce(world: World, blueprint: WorldBlueprint, s: CampaignData, record: BattleRecord): void {
  const st = record.state;
  if (record.reinforced || st.phase === 'victory' || st.phase === 'defeat') return;
  const boss = st.enemies.find(e => e.id === s.fortress.bossId);
  if (!boss || boss.hp <= 0 || boss.hp >= boss.maxHp * RULES.waveAt) return;
  if (s.fortress.reinforcementWaves !== 0 || s.outposts.filter(post => post.supplied).length >= 3 ||
      st.enemies.length + 3 > RULES.maxEnemies) return;
  record.reinforced = true;
  s.fortress.reinforcementWaves++;
  const faction = s.military && s.faction === 'villain' ? 'guard' : 'villain';
  const ids: string[] = [];
  for (let i = -1; i <= 1; i++) {
    const id = `reinforcement-${++s.spawnSequence}`;
    createActor(world, 'soldier', id, 'fortress', { x: s.fortress.x + i * 3, z: s.fortress.z + 5 }, faction,
      s.military ? 'hostile' : undefined);
    ids.push(id);
  }
  const all = actors(world), joining = ids.map(id => all.find(a => a.id === id)!);
  const living = new Set(st.enemies.filter(e => e.hp > 0).map(e => e.id));
  const bodies = bodiesAround(s, all, record.anchor, new Set([...ids, ...living]));
  for (const slot of record.stage) {
    if (!living.has(slot.id)) continue;
    const radius = all.find(a => a.id === slot.id)?.radius ?? 0.7;
    bodies.push({ at: slot.close, radius }, { at: slot.far, radius });
  }
  record.stage.push(...stageSlots(blueprint, record.anchor, s.player.radius, joining, bodies));
  joinBattle(st, joining.map(a => ({ id: a.id, kind: 'soldier' as const, hp: RULES.waveHp })));
  for (const a of joining) a.target = 'player';
  emit(world, s, 'battle', 'event.reinforcements', s.fortress, joining.length, 'fortress');
}

function finishBattle(world: World, blueprint: WorldBlueprint, s: CampaignData, record: BattleRecord,
  byId: ReadonlyMap<string, ActorData>): void {
  const st = record.state, p = s.player;
  for (const e of st.enemies) {
    const a = byId.get(e.id);
    if (!a || a.hp <= 0) continue;
    settle(blueprint, a, record.stage.find(slot => slot.id === a.id));
    Object.assign(a, { state: 'idle', stateTime: 0 });
  }
  for (const ally of st.allies) {
    const a = byId.get(ally.id);
    if (a && a.hp > 0) Object.assign(a, { state: 'idle', stateTime: 0, target: null });
  }
  p.state = 'idle';
  p.invulnerable = 0;
  delete s.battle;
  countDefenders(s, [...byId.values()]);
  if (st.phase === 'victory') emit(world, s, 'battle', 'event.battleWon', p, st.round, 'player');
  else {
    p.hp = 0;
    resolveOutcome(world, s);
  }
}

/**
 * Runs the active battle, first in every tick: the reactions pressed this tick, the battle's tick, its log shown in the
 * world (wounds, kills and loot, wards, effects and events), the actors' poses and places, and the end of the battle.
 */
export function battleSystem(blueprint: WorldBlueprint): System {
  return {
    name: 'KorovanyBattle', phase: 'preUpdate',
    run(ctx) {
      const s = campaign(ctx.world), record = s.battle;
      if (!record || s.phase !== 'playing') return;
      const input = ctx.world.getResource(Intent) ?? {}, st = record.state, p = s.player, dt = ctx.dt;
      const lockout = st.hero.lockoutUntil;
      tickBattle(st, { ...(input.dodge ? { dodge: true } : {}), ...(input.parry ? { parry: true } : {}) });
      p.invulnerable = dec(p.invulnerable, dt);
      p.dodgeCooldown = dec(p.dodgeCooldown, dt);
      p.attackCooldown = dec(p.attackCooldown, dt);
      p.abilityCooldown = dec(p.abilityCooldown, dt);
      p.abilityDuration = dec(p.abilityDuration, dt);
      s.effects = s.effects.filter(e => { e.remaining = dec(e.remaining, dt); return e.remaining > 0; });
      if (st.hero.lockoutUntil !== lockout) {
        // A reaction press counted: a parry swings, a dodge ducks aside.
        if (input.parry) emit(ctx.world, s, 'attack', 'event.attack', p, 0, 'player');
        else { p.invulnerable = 0.3; p.dodgeCooldown = 0.85; }
      }
      reinforce(ctx.world, blueprint, s, record);
      const all = actors(ctx.world), byId = new Map(all.map(a => [a.id, a]));
      for (const entry of st.log) if (entry.id > record.seen.log) showEntry(ctx.world, blueprint, s, record, entry, byId);
      record.seen.log = st.logSequence;
      // Wounds and heals reach the world.
      p.hp = st.hero.hp;
      for (const e of st.enemies) {
        const a = byId.get(e.id);
        if (a && a.hp > 0 && e.hp > 0) a.hp = Math.max(1, Math.round(a.maxHp * e.hp / e.maxHp));
      }
      for (const ward of st.wards) {
        if (ward.id === 'convoy') s.convoy.hp = ward.hp;
        else {
          const wagon = byId.get('enemy-caravan');
          if (wagon) wagon.hp = ward.hp;
        }
      }
      const action = st.action;
      if (action) {
        const began = action.id !== record.seen.action;
        record.seen.action = action.id;
        showAction(ctx.world, s, action, began, st.now, byId);
      }
      const playing = st.phase === 'action' ? action : null;
      for (const e of st.enemies) {
        const a = byId.get(e.id), slot = record.stage.find(entry => entry.id === e.id);
        if (!a || a.hp <= 0 || !slot) continue;
        const acting = playing?.actor === e.id ? playing : null;
        const goal = acting?.move === 'approach' ? slot.close : acting?.move === 'step-back' ? slot.far
          : e.band === 'close' ? slot.close : slot.far;
        const [pose, time] = acting ? actionPose(acting, st.now) : IDLE;
        const gap = distance(a, goal);
        let moved = false;
        if (gap > 0.05) {
          const step = Math.min(gap, STAGE_SPEED * dt), x = a.x, z = a.z;
          moveWithCollision(blueprint, a, (goal.x - a.x) / gap * step, (goal.z - a.z) / gap * step, a.radius);
          moved = Math.hypot(a.x - x, a.z - z) > 1e-4;
        }
        face(a, p);
        a.state = pose === 'idle' && moved ? 'chase' : pose;
        a.stateTime = Math.min(time, a.kind === 'monster' ? MONSTER_RULES.pause[1] : 1.1);
        a.target = 'player';
      }
      for (const ally of st.allies) {
        const a = byId.get(ally.id);
        if (!a || a.hp <= 0) continue;
        const acting = playing?.actor === ally.id ? playing : null;
        const [pose, time] = acting ? actionPose(acting, st.now) : IDLE;
        const target = acting?.target ? byId.get(acting.target) : undefined;
        if (target) face(a, target);
        a.state = pose;
        a.stateTime = Math.min(time, 1.1);
      }
      const focus = playing?.actor === 'hero' ? playing.target : playing && playing.actor !== CART_ALLY_ID &&
        !st.allies.some(ally => ally.id === playing.actor) ? playing.actor : null;
      const watched = focus ? byId.get(focus) : undefined;
      if (watched) face(p, watched);
      p.state = p.invulnerable > 0 ? 'dodge' : 'idle';
      if (st.phase === 'victory' || st.phase === 'defeat') finishBattle(ctx.world, blueprint, s, record, byId);
    },
  };
}

const NAMES: Readonly<Record<EnemyKind | 'arrow-cart' | 'siege-cart' | WardId, LocalizedText>> = {
  soldier: { en: 'Soldier', ru: 'Солдат' },
  archer: { en: 'Archer', ru: 'Лучник' },
  captain: { en: 'Captain', ru: 'Капитан' },
  warlord: { en: 'Warlord', ru: 'Военачальник' },
  marshal: { en: 'The Palace Marshal', ru: 'Дворцовый маршал' },
  wolf: { en: 'Grave wolf', ru: 'Могильный волк' },
  ghoul: { en: 'Barrow ghoul', ru: 'Курганный упырь' },
  troll: { en: 'Bog troll', ru: 'Болотный тролль' },
  caravan: { en: 'Enemy caravan', ru: 'Вражеский караван' },
  'arrow-cart': { en: 'Arrow cart', ru: 'Стрелковая повозка' },
  'siege-cart': { en: 'Siege cart', ru: 'Осадная повозка' },
  convoy: { en: 'Convoy', ru: 'Обоз' },
  shipment: SHIPMENT_NAME,
};

/** Display names: named actors keep their names; repeated names are numbered in roster order. */
function battleNames(state: BattleState, byId: ReadonlyMap<string, ActorData>): Record<string, LocalizedText> {
  const names: Record<string, LocalizedText> = { hero: { en: 'You', ru: 'Вы' } };
  const number = (entries: { id: string; name: LocalizedText }[]): void => {
    for (const entry of entries) {
      const twins = entries.filter(other => other.name.en === entry.name.en);
      const index = twins.indexOf(entry) + 1;
      names[entry.id] = twins.length > 1 ? { en: `${entry.name.en} ${index}`, ru: `${entry.name.ru} ${index}` } : entry.name;
    }
  };
  number(state.enemies.map(e => ({ id: e.id, name: byId.get(e.id)?.name ?? NAMES[e.kind] })));
  number(state.allies.map(a => ({ id: a.id, name: NAMES[a.kind] })));
  for (const ward of state.wards) names[ward.id] = NAMES[ward.id];
  return names;
}

export function battleView(s: CampaignData, all: readonly ActorData[]): BattleView | undefined {
  if (!s.battle) return undefined;
  return { ...battleSnapshot(s.battle.state), names: battleNames(s.battle.state, new Map(all.map(a => [a.id, a]))) };
}

export function validateBattleOptions(value: unknown): BattleOptions {
  assertRecord(value, 'Battle options');
  if (Object.keys(value).sort().join(',') !== 'difficulty,latencyTicks') throw new Error('Invalid battle options');
  if (value.difficulty !== 'story' && value.difficulty !== 'standard' && value.difficulty !== 'expert') throw new Error('Unknown battle difficulty');
  const latency = value.latencyTicks;
  if (typeof latency !== 'number' || !Number.isInteger(latency) || latency < 0 || latency > 12) throw new Error('Battle latency must be 0-12 ticks');
  return { difficulty: value.difficulty, latencyTicks: latency };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/**
 * A saved battle is always the checkpoint taken as it began: the validator regenerates the record from the saved world
 * (with its saved trigger, opening and seed) and accepts nothing else.
 */
export function validateBattleRecord(value: unknown, blueprint: WorldBlueprint, s: CampaignData,
  all: readonly ActorData[]): BattleRecord {
  assertRecord(value, 'Battle record');
  assertRecord(value.setup, 'Battle setup');
  const { seed, opening } = value.setup;
  if (typeof value.trigger !== 'string' || typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff ||
      (opening !== 'neutral' && opening !== 'first-strike' && opening !== 'ambushed')) throw new Error('Invalid battle record');
  let expected: BattleRecord;
  try {
    expected = planBattle(blueprint, s, all, value.trigger, opening, seed);
  } catch {
    throw new Error('Invalid battle record');
  }
  if (!deepEqual(value, expected)) throw new Error('Battle record does not match the saved campaign');
  return expected;
}
