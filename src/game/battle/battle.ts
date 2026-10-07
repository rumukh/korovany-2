import { createPrng, prngFromState, type Prng } from '@aegis/core';
import type { FactionId } from '../types';
import {
  ALLY_KITS, DIFFICULTY, ENCOUNTERS, ENEMY_KITS, HERO_KITS, HERO_TIMING, MOVE_TICKS, RULES, TIMING, type HeroKit, type SkillSpec,
} from './content';
import type {
  AllyKind, Band, Battle, BattleActionState, BattleCommand, BattleCommandOption, BattleDifficulty, BattleEnemySpec, BattleInput,
  BattleLogKind, BattleNotice, BattleOpening, BattleSetup, BattleSnapshot, BattleState, EnemyKind, Reaction, SkillId, WardId,
} from './types';

const SKILL_IDS: readonly SkillId[] = ['aimed-shot', 'volley', 'fall-back', 'shield-bash', 'bulwark', 'cleave', 'warcry'];
const OPENINGS: readonly BattleOpening[] = ['neutral', 'first-strike', 'ambushed'];
const DIFFICULTIES: readonly BattleDifficulty[] = ['story', 'standard', 'expert'];
const ENEMY_KINDS = Object.keys(ENEMY_KITS) as EnemyKind[];
const ALLY_KINDS = Object.keys(ALLY_KITS) as AllyKind[];
const WARD_IDS: readonly WardId[] = ['convoy', 'shipment'];
const BANDS: readonly Band[] = ['close', 'far'];
const LOG_LIMIT = 32;
const ORDER_LENGTH = 7;
/** Hits resolve this long after impact, so that late presses inside a window still count. */
const SETTLE = Math.max(TIMING.dodge.late, TIMING.parry.late);

type Hero = BattleState['hero'];
type Enemy = BattleState['enemies'][number];
type Ally = BattleState['allies'][number];
type Hit = BattleActionState['hits'][number];
type Strike = BattleActionState['strikes'][number];

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Unknown ${label} field`);
}
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 80;
function positive(value: unknown, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) throw new Error(`Invalid ${label}`);
  return value;
}
function list(value: unknown, max: number, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label}`);
  return value;
}

interface Normalized {
  rngSeed: string;
  faction: FactionId;
  difficulty: BattleDifficulty;
  opening: BattleOpening;
  latencyTicks: number;
  enemies: { id: string; kind: EnemyKind; hp: number; band: Band | null }[];
  allies: { id: string; kind: AllyKind }[];
  wards: { id: WardId; hp: number; maxHp: number }[];
  hero: { hp: number; maxHp: number; damage: number };
}

function enemySpecs(value: unknown, label: string, max: number): Normalized['enemies'] {
  return list(value, max, label).map(raw => {
    const spec = record(raw, label);
    onlyKeys(spec, ['id', 'kind', 'hp', 'band'], label);
    if (!nonEmpty(spec.id)) throw new Error(`Invalid ${label} ID`);
    if (!ENEMY_KINDS.includes(spec.kind as EnemyKind)) throw new Error(`Unknown ${label} kind`);
    const kind = spec.kind as EnemyKind;
    if (spec.band !== undefined && !BANDS.includes(spec.band as Band)) throw new Error(`Invalid ${label} band`);
    return { id: spec.id, kind, hp: spec.hp === undefined ? ENEMY_KITS[kind].maxHp : positive(spec.hp, ENEMY_KITS[kind].maxHp, `${label} HP`),
      band: (spec.band as Band | undefined) ?? null };
  });
}

function validateSetup(value: unknown): Normalized {
  const setup = record(value, 'Battle setup');
  onlyKeys(setup, ['seed', 'faction', 'encounter', 'enemies', 'allies', 'wards', 'hero', 'difficulty', 'opening', 'latencyTicks'], 'battle setup');
  if (!nonEmpty(setup.seed) && !(typeof setup.seed === 'number' && Number.isSafeInteger(setup.seed))) {
    throw new Error('Battle seed must be a short string or a safe integer');
  }
  if (setup.faction !== 'elf' && setup.faction !== 'guard' && setup.faction !== 'villain') throw new Error('Unknown faction');
  if ((setup.encounter === undefined) === (setup.enemies === undefined)) throw new Error('A battle needs exactly one of an encounter or enemies');
  if (setup.encounter !== undefined && (typeof setup.encounter !== 'string' || !Object.hasOwn(ENCOUNTERS, setup.encounter))) {
    throw new Error('Unknown encounter');
  }
  const encounter = setup.encounter as keyof typeof ENCOUNTERS | undefined;
  const enemies = encounter ? ENCOUNTERS[encounter].map(({ id, kind }) => ({ id, kind, hp: ENEMY_KITS[kind].maxHp, band: null }))
    : enemySpecs(setup.enemies, 'enemy', RULES.maxEnemies);
  if (!enemies.length) throw new Error('A battle needs at least one enemy');
  const allies = list(setup.allies, RULES.maxAllies, 'allies').map(raw => {
    const spec = record(raw, 'ally');
    onlyKeys(spec, ['id', 'kind'], 'ally');
    if (!nonEmpty(spec.id)) throw new Error('Invalid ally ID');
    if (!ALLY_KINDS.includes(spec.kind as AllyKind)) throw new Error('Unknown ally kind');
    return { id: spec.id, kind: spec.kind as AllyKind };
  });
  const wards = list(setup.wards, WARD_IDS.length, 'wards').map(raw => {
    const spec = record(raw, 'ward');
    onlyKeys(spec, ['id', 'hp', 'maxHp'], 'ward');
    if (!WARD_IDS.includes(spec.id as WardId)) throw new Error('Unknown ward');
    const maxHp = positive(spec.maxHp, 5000, 'ward max HP');
    return { id: spec.id as WardId, hp: positive(spec.hp, maxHp, 'ward HP'), maxHp };
  });
  const ids = [...enemies.map(e => e.id), ...allies.map(a => a.id), ...wards.map(w => w.id), 'hero'];
  if (new Set(ids).size !== ids.length) throw new Error('Battle participant IDs must be unique');
  const kit = HERO_KITS[setup.faction];
  let hero = { hp: kit.maxHp, maxHp: kit.maxHp, damage: kit.damage };
  if (setup.hero !== undefined) {
    const spec = record(setup.hero, 'Battle hero');
    onlyKeys(spec, ['hp', 'maxHp', 'damage'], 'battle hero');
    const maxHp = positive(spec.maxHp, 5000, 'hero max HP');
    hero = { hp: positive(spec.hp, maxHp, 'hero HP'), maxHp, damage: positive(spec.damage, 1000, 'hero damage') };
  }
  const difficulty = setup.difficulty ?? 'standard';
  if (!DIFFICULTIES.includes(difficulty as BattleDifficulty)) throw new Error('Unknown difficulty');
  const opening = setup.opening ?? 'neutral';
  if (!OPENINGS.includes(opening as BattleOpening)) throw new Error('Unknown opening');
  const latencyTicks = setup.latencyTicks ?? 0;
  if (typeof latencyTicks !== 'number' || !Number.isInteger(latencyTicks) || latencyTicks < 0 || latencyTicks > 12) {
    throw new Error('Latency must be 0-12 ticks');
  }
  return {
    rngSeed: `korovany2:battle:${encounter ?? 'custom'}:${setup.seed}`, faction: setup.faction,
    difficulty: difficulty as BattleDifficulty, opening: opening as BattleOpening, latencyTicks, enemies, allies, wards, hero,
  };
}

/** Validates a command's structure; throws when malformed. */
export function validateBattleCommand(value: unknown): BattleCommand {
  const command = record(value, 'Battle command');
  if (command.type === 'attack') {
    onlyKeys(command, ['type', 'target'], 'attack');
    if (!nonEmpty(command.target)) throw new Error('Attack needs a target');
    return { type: 'attack', target: command.target };
  }
  if (command.type === 'skill') {
    onlyKeys(command, ['type', 'skill', 'target'], 'skill');
    if (!SKILL_IDS.includes(command.skill as SkillId)) throw new Error('Unknown skill');
    if (command.target !== undefined && !nonEmpty(command.target)) throw new Error('Invalid skill target');
    return { type: 'skill', skill: command.skill as SkillId, ...(command.target !== undefined ? { target: command.target } : {}) };
  }
  if (command.type === 'item') {
    onlyKeys(command, ['type', 'item'], 'item');
    if (command.item !== 'tonic') throw new Error('Unknown item');
    return { type: 'item', item: 'tonic' };
  }
  if (command.type === 'protect') {
    onlyKeys(command, ['type'], 'protect');
    return { type: 'protect' };
  }
  throw new Error('Unknown battle command');
}

function validateInput(value: unknown): BattleInput {
  const input = record(value, 'Battle input');
  onlyKeys(input, ['dodge', 'parry'], 'battle input');
  for (const key of ['dodge', 'parry'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  }
  return input as BattleInput;
}

const interval = (speed: number): number => 100 / speed;

/** A reaction's success window around impact: from `early` ticks before it to `late` ticks after it. */
export function reactionWindow(faction: FactionId, difficulty: BattleDifficulty, reaction: Reaction): { early: number; late: number } {
  const kit = HERO_KITS[faction], timing = TIMING[reaction];
  const scale = DIFFICULTY[difficulty].window * (reaction === 'dodge' ? kit.dodgeWindow : kit.parryWindow);
  return { early: Math.round(timing.early * scale), late: timing.late };
}

/** Runs one battle operation against a state, with the battle's own PRNG loaded from and saved back to the state. */
class Runner {
  readonly rng: Prng;
  readonly kit: HeroKit;
  readonly scale: { window: number; damage: number };
  constructor(readonly s: BattleState) {
    this.rng = prngFromState({ s: s.rng });
    this.kit = HERO_KITS[s.faction];
    this.scale = DIFFICULTY[s.difficulty];
  }
  save(): void {
    this.s.rng = [...this.rng.save().s];
  }
  get hero(): Hero { return this.s.hero; }
  living(): Enemy[] { return this.s.enemies.filter(e => e.hp > 0); }
  enemyById(id: string | undefined | null): Enemy | undefined { return this.s.enemies.find(e => e.id === id && e.hp > 0); }
  standingWards(): BattleState['wards'] { return this.s.wards.filter(w => w.hp > 0); }
  write(kind: BattleLogKind, actor: string, target: string, amount = 0): void {
    this.s.log.push({ id: ++this.s.logSequence, tick: this.s.now, kind, actor, target, amount });
    if (this.s.log.length > LOG_LIMIT) this.s.log.shift();
  }
  finish(result: 'victory' | 'defeat'): void {
    this.s.phase = result;
    this.write(result, 'hero', 'hero');
  }
  heal(amount: number): void {
    const gained = Math.min(this.hero.maxHp - this.hero.hp, amount);
    if (gained <= 0) return;
    this.hero.hp += gained;
    this.write('heal', 'hero', 'hero', gained);
  }
  addBreak(e: Enemy, amount: number): void {
    if (amount <= 0 || e.broken || e.hp <= 0) return;
    e.breakMeter += amount;
    if (e.breakMeter < ENEMY_KITS[e.kind].breakMax) return;
    e.breakMeter = 0;
    e.broken = true;
    this.write('break', 'hero', e.id);
  }
  start(actor: string, move: string, target: string | null, ticks: number, hits: Hit[] = [], strikes: Strike[] = []): void {
    this.s.action = { id: ++this.s.actionSequence, actor, move, target, start: this.s.now, end: this.s.now + ticks, hits, strikes, raged: false };
    this.s.phase = 'action';
  }
  /** The next actor on the timeline: the earliest `next`; on ties the hero, then enemies, then allies, in roster order. */
  nextActor(): { enemy: Enemy } | { ally: Ally } | null {
    let best: { enemy: Enemy } | { ally: Ally } | null = null, time = this.hero.next;
    for (const e of this.living()) if (ENEMY_KITS[e.kind].speed > 0 && e.next < time) { best = { enemy: e }; time = e.next; }
    for (const a of this.s.allies) if (a.next < time) { best = { ally: a }; time = a.next; }
    return best;
  }
  beginTurn(): void {
    this.s.action = null;
    const next = this.nextActor();
    if (!next) {
      this.hero.next += interval(this.kit.speed);
      this.hero.bulwark = false;
      this.hero.guarding = false;
      this.s.round++;
      this.s.phase = 'command';
      return;
    }
    if ('ally' in next) {
      this.allyTurn(next.ally);
      return;
    }
    const actor = next.enemy;
    actor.next += interval(ENEMY_KITS[actor.kind].speed);
    if (actor.broken) {
      actor.broken = false;
      this.write('recover', actor.id, actor.id);
      this.start(actor.id, 'recover', null, MOVE_TICKS.recover);
      return;
    }
    this.enemyTurn(actor);
  }
  allyTurn(a: Ally): void {
    const kit = ALLY_KITS[a.kind];
    a.next += interval(kit.speed);
    const target = [...this.living()].sort((left, right) => left.hp - right.hp)[0]!;
    this.write('support', a.id, target.id);
    this.start(a.id, kit.move, target.id, kit.ticks, [],
      [{ at: this.s.now + kit.impact, source: a.id, targets: [target.id], multiplier: 1, flat: kit.damage, breakAdd: 1, done: false }]);
  }
  enemyTurn(e: Enemy): void {
    const enemyKit = ENEMY_KITS[e.kind], rng = this.rng;
    if (!enemyKit.ranged && e.band === 'far') return this.start(e.id, 'approach', null, MOVE_TICKS.approach);
    if (enemyKit.ranged && e.band === 'close' && rng.bool(RULES.retreatChance)) return this.start(e.id, 'step-back', null, MOVE_TICKS['step-back']);
    if (enemyKit.rally > 0 && this.living().some(other => other !== e) && !this.living().some(other => other.rallied > 0) &&
        rng.bool(enemyKit.rally)) return this.start(e.id, 'rally', null, MOVE_TICKS.rally);
    let roll = rng.range(0, enemyKit.moves.reduce((sum, move) => sum + move.weight, 0));
    const move = enemyKit.moves.find(candidate => (roll -= candidate.weight) < 0) ?? enemyKit.moves[enemyKit.moves.length - 1]!;
    const rally = e.rallied > 0 ? RULES.rallyBonus : 1;
    if (e.rallied > 0) e.rallied--;
    let target: 'hero' | WardId = 'hero';
    const wards = this.standingWards();
    if (enemyKit.raid > 0 && wards.length && rng.bool(enemyKit.raid)) {
      const ward = wards.length > 1 ? wards[rng.int(0, wards.length)]! : wards[0]!;
      if (this.hero.guarding) this.write('protect', 'hero', ward.id);
      else target = ward.id;
    }
    const taken = this.scale.damage * rally * (target === 'hero' ? this.kit.armor * (this.hero.bulwark ? RULES.bulwark : 1) : 1);
    const hits: Hit[] = move.blows.map((blow, index) => ({
      index, impact: this.s.now + blow.at, damage: Math.max(1, Math.round(blow.damage * taken)), heavy: blow.heavy === true,
      outcome: 'pending', reaction: null, pressed: null, target,
    }));
    this.start(e.id, move.id, target, move.ticks, hits);
  }
  resolveHit(current: BattleActionState, hit: Hit, attacker: Enemy | undefined): void {
    const source = attacker?.id ?? current.actor;
    if (hit.target !== 'hero') {
      hit.outcome = 'hit';
      const ward = this.s.wards.find(w => w.id === hit.target);
      if (!ward || ward.hp <= 0) return;
      const dealt = Math.min(ward.hp, hit.damage);
      ward.hp -= dealt;
      this.write('damage', source, ward.id, dealt);
      if (ward.hp <= 0) {
        ward.hp = 0;
        this.write('ward-down', source, ward.id);
        // A weapon mounted on the wrecked wagon is out of the fight.
        this.s.allies = this.s.allies.filter(a => ALLY_KITS[a.kind].ward !== ward.id);
      }
      return;
    }
    let success = false;
    if (hit.reaction && hit.pressed !== null && (hit.reaction === 'dodge' || !hit.heavy)) {
      const window = reactionWindow(this.s.faction, this.s.difficulty, hit.reaction);
      success = hit.pressed >= hit.impact - window.early && hit.pressed <= hit.impact + window.late;
    }
    if (success && hit.reaction === 'dodge') {
      hit.outcome = 'dodged';
      if (this.kit.dodgeAp) this.hero.ap = Math.min(RULES.maxAp, this.hero.ap + 1);
      this.write('dodge', 'hero', source);
      return;
    }
    if (success) {
      hit.outcome = 'parried';
      this.hero.ap = Math.min(RULES.maxAp, this.hero.ap + 1);
      this.write('parry', 'hero', source);
      if (attacker) this.addBreak(attacker, RULES.parryBreak);
      return;
    }
    hit.outcome = 'hit';
    this.hero.hp = Math.max(0, this.hero.hp - hit.damage);
    this.write('damage', source, 'hero', hit.damage);
    if (this.kit.rage && !current.raged) {
      current.raged = true;
      this.hero.ap = Math.min(RULES.maxAp, this.hero.ap + 1);
    }
    if (this.hero.hp === 0) this.finish('defeat');
  }
  applyStrike(strike: Strike): void {
    strike.done = true;
    const fromHero = strike.flat === 0;
    for (const id of strike.targets) {
      const target = this.enemyById(id);
      if (!target) continue;
      const broken = target.broken ? RULES.brokenBonus : 1;
      const amount = fromHero
        ? Math.max(1, Math.round(this.hero.damage * strike.multiplier * (this.kit.ranged && target.band === 'close' ? RULES.elfClose : 1) * broken))
        : Math.max(1, Math.round(strike.flat * broken));
      const dealt = Math.min(target.hp, amount);
      target.hp -= dealt;
      this.write('damage', strike.source, target.id, dealt);
      if (fromHero && this.kit.lifesteal > 0) this.heal(Math.round(dealt * this.kit.lifesteal));
      if (target.hp === 0) {
        target.broken = false;
        target.rallied = 0;
        this.write('defeated', strike.source, target.id);
      } else this.addBreak(target, strike.breakAdd);
    }
    if (this.living().length === 0) this.finish('victory');
  }
  endAction(current: BattleActionState): void {
    const enemy = this.enemyById(current.actor);
    if (enemy) {
      if (current.move === 'approach') {
        enemy.band = 'close';
        this.write('approach', enemy.id, 'hero');
      } else if (current.move === 'step-back') {
        enemy.band = 'far';
        this.write('retreat', enemy.id, 'hero');
      } else if (current.move === 'rally') {
        for (const ally of this.living()) ally.rallied = RULES.rallyAttacks;
        this.write('rally', enemy.id, enemy.id);
      } else if (current.hits.length > 0 && current.hits.every(h => h.target === 'hero' && h.outcome === 'parried') &&
          (this.kit.ranged || enemy.band === 'close')) {
        // Every blow of the move was parried: the hero answers at once. A melee hero cannot reach a far archer.
        this.write('counter', 'hero', enemy.id);
        const timing = HERO_TIMING.counter;
        this.start('hero', 'counter', enemy.id, timing.ticks, [], [{
          at: this.s.now + timing.impact, source: 'hero', targets: [enemy.id], multiplier: this.kit.counter, flat: 0,
          breakAdd: RULES.counterBreak, done: false,
        }]);
        return;
      }
    }
    this.beginTurn();
  }
  skillReason(spec: SkillSpec, target: string | undefined): BattleNotice | null {
    if (spec.targeted ? !this.enemyById(target) : target !== undefined) return 'target';
    if ((spec.id === 'fall-back' || spec.id === 'cleave') && !this.living().some(e => e.band === 'close')) return 'target';
    if (spec.id === 'warcry' && !this.living().some(e => e.band === 'far')) return 'target';
    return this.hero.ap < spec.cost ? 'ap' : null;
  }
  strike(targets: string[], multiplier: number, breakAdd: number, impact: number): Strike[] {
    if (targets.length === 0) return [];
    const empowered = this.hero.empowered;
    this.hero.empowered = 1;
    return [{ at: this.s.now + impact, source: 'hero', targets, multiplier: multiplier * empowered, flat: 0, breakAdd, done: false }];
  }
  attack(targetId: string): void {
    const target = this.enemyById(targetId)!;
    let multiplier = 1;
    if (!this.kit.ranged && target.band === 'far') {
      target.band = 'close';
      multiplier *= RULES.charge;
    }
    this.hero.ap = Math.min(RULES.maxAp, this.hero.ap + 1);
    const timing = HERO_TIMING.attack;
    this.start('hero', 'attack', target.id, timing.ticks, [], this.strike([target.id], multiplier, 1, timing.impact));
  }
  useSkill(spec: SkillSpec, targetId: string | undefined): void {
    this.hero.ap -= spec.cost;
    this.write('skill', 'hero', targetId ?? 'hero', spec.cost);
    let targets: string[] = [], multiplier = spec.damage;
    switch (spec.id) {
      case 'aimed-shot':
        targets = [targetId!];
        break;
      case 'volley':
        targets = this.living().map(e => e.id);
        break;
      case 'fall-back':
        for (const e of this.living()) if (e.band === 'close') e.band = 'far';
        targets = [targetId!];
        break;
      case 'shield-bash': {
        const target = this.enemyById(targetId)!;
        if (target.band === 'far') {
          target.band = 'close';
          multiplier *= RULES.charge;
        }
        targets = [target.id];
        break;
      }
      case 'bulwark':
        this.hero.bulwark = true;
        this.heal(RULES.bulwarkHeal);
        for (const ward of this.standingWards()) {
          const repaired = Math.min(ward.maxHp - ward.hp, RULES.bulwarkWardHeal);
          if (repaired <= 0) continue;
          ward.hp += repaired;
          this.write('heal', 'hero', ward.id, repaired);
        }
        break;
      case 'cleave':
        targets = this.living().filter(e => e.band === 'close').map(e => e.id);
        break;
      case 'warcry':
        for (const e of this.living()) e.band = 'close';
        this.hero.empowered = RULES.warcry;
        break;
    }
    this.start('hero', spec.id, targetId ?? null, spec.ticks, [], this.strike(targets, multiplier, spec.breakAdd, spec.impact));
  }
  command(command: BattleCommand): void {
    const s = this.s;
    s.notice = null;
    if (s.phase !== 'command') { s.notice = 'phase'; return; }
    if (command.type === 'attack') {
      if (!this.enemyById(command.target)) { s.notice = 'target'; return; }
      this.attack(command.target);
      return;
    }
    if (command.type === 'item') {
      if (this.hero.tonics === 0 || this.hero.hp >= this.hero.maxHp) { s.notice = 'item'; return; }
      this.hero.tonics--;
      this.write('item', 'hero', 'hero');
      this.heal(RULES.tonicHeal);
      this.start('hero', 'item', null, MOVE_TICKS.item);
      return;
    }
    if (command.type === 'protect') {
      if (!this.standingWards().length) { s.notice = s.wards.length ? 'target' : 'unavailable'; return; }
      this.hero.guarding = true;
      this.hero.ap = Math.min(RULES.maxAp, this.hero.ap + 1);
      this.write('protect', 'hero', 'hero');
      this.start('hero', 'protect', null, MOVE_TICKS.protect);
      return;
    }
    const spec = this.kit.skills.find(skill => skill.id === command.skill);
    if (!spec) { s.notice = 'unavailable'; return; }
    const reason = this.skillReason(spec, command.target);
    if (reason) { s.notice = reason; return; }
    this.useSkill(spec, command.target);
  }
  tick(input: BattleInput): boolean {
    const s = this.s;
    if (s.phase !== 'action' || !s.action) return false;
    s.now++;
    const current = s.action;
    const press: Reaction | null = input.parry ? 'parry' : input.dodge ? 'dodge' : null;
    if (press && s.now >= this.hero.lockoutUntil) {
      this.hero.lockoutUntil = s.now + TIMING.lockout;
      const at = s.now - s.latencyTicks;
      const hit = current.hits.find(h => h.target === 'hero' && h.outcome === 'pending' && h.pressed === null &&
        at >= h.impact - TIMING.attempt && at <= h.impact + TIMING[press].late);
      if (hit) { hit.pressed = at; hit.reaction = press; }
    }
    const attacker = this.enemyById(current.actor);
    for (const hit of current.hits) {
      if (hit.outcome === 'pending' && s.now >= hit.impact + SETTLE + s.latencyTicks) this.resolveHit(current, hit, attacker);
      if (s.phase !== 'action') return true;
    }
    for (const entry of current.strikes) {
      if (!entry.done && s.now >= entry.at) this.applyStrike(entry);
      if (s.phase !== 'action') return true;
    }
    if (s.now >= current.end && current.hits.every(h => h.outcome !== 'pending') && current.strikes.every(entry => entry.done)) {
      this.endAction(current);
    }
    return true;
  }
  join(specs: Normalized['enemies']): void {
    const s = this.s;
    if (s.phase === 'victory' || s.phase === 'defeat') throw new Error('A finished battle cannot be joined');
    if (s.enemies.length + specs.length > RULES.maxEnemies) throw new Error('Too many enemies in one battle');
    const taken = new Set([...s.enemies.map(e => e.id), ...s.allies.map(a => a.id), ...s.wards.map(w => w.id), 'hero']);
    let base = this.hero.next;
    for (const e of this.living()) if (ENEMY_KITS[e.kind].speed > 0) base = Math.min(base, e.next);
    for (const a of s.allies) base = Math.min(base, a.next);
    for (const spec of specs) {
      if (taken.has(spec.id)) throw new Error('Joining enemy IDs must be new');
      taken.add(spec.id);
      const kit = ENEMY_KITS[spec.kind];
      s.enemies.push({
        id: spec.id, kind: spec.kind, hp: spec.hp, maxHp: kit.maxHp, band: spec.band ?? 'far', breakMeter: 0, broken: false, rallied: 0,
        next: kit.speed > 0 ? base + interval(kit.speed) * this.rng.range(0.2, 0.8) : 0,
      });
      this.write('join', spec.id, 'hero');
    }
  }
  order(): string[] {
    const s = this.s;
    if (s.phase === 'victory' || s.phase === 'defeat') return [];
    const queue = [{ id: 'hero', next: this.hero.next, step: interval(this.kit.speed) },
      ...this.living().filter(e => ENEMY_KITS[e.kind].speed > 0).map(e => ({ id: e.id, next: e.next, step: interval(ENEMY_KITS[e.kind].speed) })),
      ...s.allies.map(a => ({ id: a.id, next: a.next, step: interval(ALLY_KITS[a.kind].speed) }))];
    const result = [s.phase === 'command' || !s.action ? 'hero' : s.action.actor];
    while (result.length < ORDER_LENGTH) {
      let best = queue[0]!;
      for (const entry of queue) if (entry.next < best.next) best = entry;
      result.push(best.id);
      best.next += best.step;
    }
    return result;
  }
  commandOptions(): BattleCommandOption[] {
    if (this.s.phase !== 'command') return [];
    const targets = this.living().map(e => e.id);
    const options: BattleCommandOption[] = [{ command: 'attack', id: 'attack', cost: 0, targets, enabled: true, reason: null }];
    for (const spec of this.kit.skills) {
      const reason = this.skillReason(spec, spec.targeted ? targets[0] : undefined);
      options.push({ command: 'skill', id: spec.id, cost: spec.cost, targets: spec.targeted ? targets : [], enabled: !reason, reason });
    }
    if (this.s.wards.length) {
      const standing = this.standingWards().length > 0;
      options.push({ command: 'protect', id: 'protect', cost: 0, targets: [], enabled: standing, reason: standing ? null : 'target' });
    }
    const usable = this.hero.tonics > 0 && this.hero.hp < this.hero.maxHp;
    options.push({ command: 'item', id: 'tonic', cost: 0, targets: [], enabled: usable, reason: usable ? null : 'item' });
    return options;
  }
  snapshot(): BattleSnapshot {
    const s = this.s, current = s.action;
    return {
      version: 1, difficulty: s.difficulty, opening: s.opening, phase: s.phase, tick: s.now, round: s.round,
      hero: {
        faction: s.faction, hp: this.hero.hp, maxHp: this.hero.maxHp, damage: this.hero.damage, ap: this.hero.ap, maxAp: RULES.maxAp,
        tonics: this.hero.tonics, bulwark: this.hero.bulwark, guarding: this.hero.guarding, empowered: this.hero.empowered,
        lockout: Math.max(0, this.hero.lockoutUntil - s.now),
      },
      enemies: s.enemies.map(e => ({
        id: e.id, kind: e.kind, hp: e.hp, maxHp: e.maxHp, band: e.band, breakMeter: e.breakMeter,
        breakMax: ENEMY_KITS[e.kind].breakMax, broken: e.broken, rallied: e.rallied,
      })),
      allies: s.allies.map(a => ({ id: a.id, kind: a.kind })),
      wards: s.wards.map(w => ({ ...w })),
      order: this.order(),
      action: current ? {
        id: current.id, actor: current.actor, move: current.move, target: current.target, start: current.start, end: current.end,
        hits: current.hits.map(h => ({ ...h })),
      } : null,
      commands: this.commandOptions(),
      log: s.log.map(entry => ({ ...entry })),
      notice: s.notice,
    };
  }
}

function run<T>(state: BattleState, operation: (runner: Runner) => T): T {
  const runner = new Runner(state);
  try {
    return operation(runner);
  } finally {
    runner.save();
  }
}

/** Starts a deterministic battle: the same setup and the same inputs on the same ticks always give the same battle. */
export function startBattle(setup: BattleSetup): BattleState {
  const n = validateSetup(setup);
  const kit = HERO_KITS[n.faction];
  const rng = createPrng(n.rngSeed);
  const state: BattleState = {
    version: 1, faction: n.faction, difficulty: n.difficulty, opening: n.opening, latencyTicks: n.latencyTicks,
    rng: [], now: 0, round: 0, phase: 'command', notice: null, actionSequence: 0, logSequence: 0,
    hero: {
      hp: n.hero.hp, maxHp: n.hero.maxHp, damage: n.hero.damage, ap: RULES.startAp, tonics: RULES.tonics,
      bulwark: false, guarding: false, empowered: 1, lockoutUntil: 0, next: 0,
    },
    enemies: n.enemies.map(e => ({
      id: e.id, kind: e.kind, hp: e.hp, maxHp: ENEMY_KITS[e.kind].maxHp, band: e.band ?? 'far',
      breakMeter: 0, broken: false, rallied: 0, next: 0,
    })),
    allies: n.allies.map(a => ({ id: a.id, kind: a.kind, next: 0 })),
    wards: n.wards.map(w => ({ ...w })),
    action: null, log: [],
  };
  const acting = (e: Enemy): boolean => ENEMY_KITS[e.kind].speed > 0;
  if (n.opening === 'first-strike') {
    for (const e of state.enemies) if (acting(e)) e.next = interval(ENEMY_KITS[e.kind].speed) * rng.range(0.6, 1.1);
  } else if (n.opening === 'ambushed') {
    state.hero.next = interval(kit.speed);
    for (const [index, e] of state.enemies.entries()) {
      if (acting(e)) e.next = interval(ENEMY_KITS[e.kind].speed) * rng.range(0, 0.4);
      if (!ENEMY_KITS[e.kind].ranged && n.enemies[index]!.band === null) e.band = 'close';
    }
  } else {
    state.hero.next = interval(kit.speed) * rng.range(0.3, 1);
    for (const e of state.enemies) if (acting(e)) e.next = interval(ENEMY_KITS[e.kind].speed) * rng.range(0.3, 1);
  }
  for (const a of state.allies) a.next = interval(ALLY_KITS[a.kind].speed) * rng.range(0.4, 1.1);
  state.rng = [...rng.save().s];
  run(state, runner => runner.beginTurn());
  return state;
}

/** The hero's command, on the hero's turn only. Malformed commands throw; unavailable ones set `notice` and change nothing else. */
export function commandBattle(state: BattleState, command: BattleCommand): void {
  const valid = validateBattleCommand(command);
  run(state, runner => runner.command(valid));
}

/** Advances one tick while an action plays and returns true; in any other phase it changes nothing and returns false. */
export function tickBattle(state: BattleState, input: BattleInput = {}): boolean {
  const valid = validateInput(input);
  return run(state, runner => runner.tick(valid));
}

/** Adds enemies to an unfinished battle (reinforcements); they start far unless a band is given, and act after the next turn. */
export function joinBattle(state: BattleState, enemies: readonly BattleEnemySpec[]): void {
  const specs = enemySpecs(enemies, 'joining enemy', RULES.maxEnemies);
  run(state, runner => runner.join(specs));
}

/** A read-only view of a battle; it never changes the state. */
export function battleSnapshot(state: BattleState): BattleSnapshot {
  return new Runner(state).snapshot();
}

/** A self-contained battle object over its own state (sandbox, bots and tests). */
export function createBattle(setup: BattleSetup): Battle {
  const state = startBattle(setup);
  return {
    command: command => commandBattle(state, command),
    tick: input => tickBattle(state, input),
    snapshot: () => battleSnapshot(state),
    state: () => structuredClone(state),
  };
}
