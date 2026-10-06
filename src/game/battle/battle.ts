import { createPrng } from '@aegis/core';
import { DIFFICULTY, ENCOUNTERS, ENEMY_KITS, HERO_KITS, HERO_TIMING, MOVE_TICKS, RULES, TIMING, type SkillSpec } from './content';
import type {
  Band, Battle, BattleCommand, BattleCommandOption, BattleDifficulty, BattleInput, BattleLogEntry, BattleLogKind,
  BattleNotice, BattleOpening, BattlePhase, BattleSetup, BattleSnapshot, EncounterId, EnemyKind, HitOutcome, Reaction, SkillId,
} from './types';

const SKILL_IDS: readonly SkillId[] = ['aimed-shot', 'volley', 'fall-back', 'shield-bash', 'bulwark', 'cleave', 'warcry'];
const OPENINGS: readonly BattleOpening[] = ['neutral', 'first-strike', 'ambushed'];
const LOG_LIMIT = 32;
const ORDER_LENGTH = 7;
/** Hits resolve this long after impact, so that late presses inside a window still count. */
const SETTLE = Math.max(TIMING.dodge.late, TIMING.parry.late);

interface Hero { hp: number; ap: number; tonics: number; bulwark: boolean; empowered: number; lockoutUntil: number; next: number }
interface Enemy {
  id: string; kind: EnemyKind; hp: number; maxHp: number; band: Band; breakMeter: number; broken: boolean; rallied: number;
  next: number;
}
interface Hit {
  index: number; impact: number; damage: number; heavy: boolean; outcome: HitOutcome; reaction: Reaction | null;
  /** The tick of this blow's one bound attempt, after latency compensation. */
  pressed: number | null;
}
/** Hero damage landing on enemies at tick `at`. */
interface Strike { at: number; targets: string[]; multiplier: number; breakAdd: number; done: boolean }
interface Action {
  id: number; actor: string; move: string; target: string | null; start: number; end: number; hits: Hit[]; strikes: Strike[];
  /** The villain's rage AP has been granted for this move. */
  raged: boolean;
}
type ValidSetup = Required<BattleSetup>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Unknown ${label} field`);
}
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 80;

function validateSetup(value: unknown): ValidSetup {
  const setup = record(value, 'Battle setup');
  onlyKeys(setup, ['seed', 'faction', 'encounter', 'difficulty', 'opening', 'latencyTicks'], 'battle setup');
  if (!nonEmpty(setup.seed) && !(typeof setup.seed === 'number' && Number.isSafeInteger(setup.seed))) {
    throw new Error('Battle seed must be a short string or a safe integer');
  }
  if (setup.faction !== 'elf' && setup.faction !== 'guard' && setup.faction !== 'villain') throw new Error('Unknown faction');
  if (typeof setup.encounter !== 'string' || !Object.hasOwn(ENCOUNTERS, setup.encounter)) throw new Error('Unknown encounter');
  const difficulty = setup.difficulty ?? 'standard';
  if (typeof difficulty !== 'string' || !Object.hasOwn(DIFFICULTY, difficulty)) throw new Error('Unknown difficulty');
  const opening = setup.opening ?? 'neutral';
  if (!OPENINGS.includes(opening as BattleOpening)) throw new Error('Unknown opening');
  const latencyTicks = setup.latencyTicks ?? 0;
  if (typeof latencyTicks !== 'number' || !Number.isInteger(latencyTicks) || latencyTicks < 0 || latencyTicks > 12) {
    throw new Error('Latency must be 0-12 ticks');
  }
  return {
    seed: setup.seed as string | number, faction: setup.faction, encounter: setup.encounter as EncounterId,
    difficulty: difficulty as BattleDifficulty, opening: opening as BattleOpening, latencyTicks,
  };
}

function validateCommand(value: unknown): BattleCommand {
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

/** Creates a deterministic battle: the same setup and the same inputs on the same ticks always give the same battle. */
export function createBattle(options: BattleSetup): Battle {
  const setup = validateSetup(options);
  const kit = HERO_KITS[setup.faction];
  const scale = DIFFICULTY[setup.difficulty];
  const rng = createPrng(`korovany2:battle:${setup.encounter}:${setup.seed}`);
  const hero: Hero = { hp: kit.maxHp, ap: RULES.startAp, tonics: RULES.tonics, bulwark: false, empowered: 1, lockoutUntil: 0, next: 0 };
  const enemies: Enemy[] = ENCOUNTERS[setup.encounter].map(({ id, kind }) => {
    const enemyKit = ENEMY_KITS[kind];
    return { id, kind, hp: enemyKit.maxHp, maxHp: enemyKit.maxHp, band: 'far', breakMeter: 0, broken: false, rallied: 0, next: 0 };
  });
  if (setup.opening === 'first-strike') {
    for (const e of enemies) e.next = interval(ENEMY_KITS[e.kind].speed) * rng.range(0.6, 1.1);
  } else if (setup.opening === 'ambushed') {
    hero.next = interval(kit.speed);
    for (const e of enemies) {
      e.next = interval(ENEMY_KITS[e.kind].speed) * rng.range(0, 0.4);
      if (!ENEMY_KITS[e.kind].ranged) e.band = 'close';
    }
  } else {
    hero.next = interval(kit.speed) * rng.range(0.3, 1);
    for (const e of enemies) e.next = interval(ENEMY_KITS[e.kind].speed) * rng.range(0.3, 1);
  }

  let now = 0, round = 0, actionSequence = 0, logSequence = 0;
  let phase: BattlePhase = 'command';
  let action: Action | null = null;
  let notice: BattleNotice | null = null;
  const log: BattleLogEntry[] = [];

  const living = (): Enemy[] => enemies.filter(e => e.hp > 0);
  const enemyById = (id: string | undefined): Enemy | undefined => enemies.find(e => e.id === id && e.hp > 0);
  function write(kind: BattleLogKind, actor: string, target: string, amount = 0): void {
    log.push({ id: ++logSequence, tick: now, kind, actor, target, amount });
    if (log.length > LOG_LIMIT) log.shift();
  }
  function finish(result: 'victory' | 'defeat'): void {
    phase = result;
    write(result, 'hero', 'hero');
  }
  function heal(amount: number): void {
    const gained = Math.min(kit.maxHp - hero.hp, amount);
    if (gained <= 0) return;
    hero.hp += gained;
    write('heal', 'hero', 'hero', gained);
  }
  function addBreak(e: Enemy, amount: number): void {
    if (amount <= 0 || e.broken || e.hp <= 0) return;
    e.breakMeter += amount;
    if (e.breakMeter < ENEMY_KITS[e.kind].breakMax) return;
    e.breakMeter = 0;
    e.broken = true;
    write('break', 'hero', e.id);
  }
  function start(actor: string, move: string, target: string | null, ticks: number, hits: Hit[] = [], strikes: Strike[] = []): void {
    action = { id: ++actionSequence, actor, move, target, start: now, end: now + ticks, hits, strikes, raged: false };
    phase = 'action';
  }
  /** The next actor on the timeline: the earliest `next`, the hero first and then roster order on ties. */
  function nextActor(): Enemy | null {
    let best: Enemy | null = null, time = hero.next;
    for (const e of living()) if (e.next < time) { best = e; time = e.next; }
    return best;
  }
  function beginTurn(): void {
    action = null;
    const actor = nextActor();
    if (!actor) {
      hero.next += interval(kit.speed);
      hero.bulwark = false;
      round++;
      phase = 'command';
      return;
    }
    actor.next += interval(ENEMY_KITS[actor.kind].speed);
    if (actor.broken) {
      actor.broken = false;
      write('recover', actor.id, actor.id);
      start(actor.id, 'recover', null, MOVE_TICKS.recover);
      return;
    }
    enemyTurn(actor);
  }
  function enemyTurn(e: Enemy): void {
    const enemyKit = ENEMY_KITS[e.kind];
    if (!enemyKit.ranged && e.band === 'far') return start(e.id, 'approach', null, MOVE_TICKS.approach);
    if (enemyKit.ranged && e.band === 'close' && rng.bool(RULES.retreatChance)) return start(e.id, 'step-back', null, MOVE_TICKS['step-back']);
    if (e.kind === 'captain' && living().some(other => other !== e) && !living().some(other => other.rallied > 0) &&
        rng.bool(RULES.rallyChance)) return start(e.id, 'rally', null, MOVE_TICKS.rally);
    let roll = rng.range(0, enemyKit.moves.reduce((sum, move) => sum + move.weight, 0));
    const move = enemyKit.moves.find(candidate => (roll -= candidate.weight) < 0) ?? enemyKit.moves[enemyKit.moves.length - 1]!;
    const rally = e.rallied > 0 ? RULES.rallyBonus : 1;
    if (e.rallied > 0) e.rallied--;
    const taken = scale.damage * kit.armor * (hero.bulwark ? RULES.bulwark : 1) * rally;
    const hits: Hit[] = move.blows.map((blow, index) => ({
      index, impact: now + blow.at, damage: Math.max(1, Math.round(blow.damage * taken)), heavy: blow.heavy === true,
      outcome: 'pending', reaction: null, pressed: null,
    }));
    start(e.id, move.id, 'hero', move.ticks, hits);
  }
  function resolveHit(current: Action, hit: Hit, attacker: Enemy | undefined): void {
    let success = false;
    if (hit.reaction && hit.pressed !== null && (hit.reaction === 'dodge' || !hit.heavy)) {
      const window = TIMING[hit.reaction];
      const early = Math.round(window.early * scale.window * (hit.reaction === 'dodge' ? kit.dodgeWindow : kit.parryWindow));
      success = hit.pressed >= hit.impact - early && hit.pressed <= hit.impact + window.late;
    }
    const source = attacker?.id ?? '';
    if (success && hit.reaction === 'dodge') {
      hit.outcome = 'dodged';
      write('dodge', 'hero', source);
      return;
    }
    if (success) {
      hit.outcome = 'parried';
      hero.ap = Math.min(RULES.maxAp, hero.ap + 1);
      write('parry', 'hero', source);
      if (attacker) addBreak(attacker, RULES.parryBreak);
      return;
    }
    hit.outcome = 'hit';
    hero.hp = Math.max(0, hero.hp - hit.damage);
    write('damage', source, 'hero', hit.damage);
    if (kit.rage && !current.raged) {
      current.raged = true;
      hero.ap = Math.min(RULES.maxAp, hero.ap + 1);
    }
    if (hero.hp === 0) finish('defeat');
  }
  function applyStrike(strike: Strike): void {
    strike.done = true;
    for (const id of strike.targets) {
      const target = enemyById(id);
      if (!target) continue;
      const band = kit.ranged && target.band === 'close' ? RULES.elfClose : 1;
      const amount = Math.max(1, Math.round(kit.damage * strike.multiplier * band * (target.broken ? RULES.brokenBonus : 1)));
      const dealt = Math.min(target.hp, amount);
      target.hp -= dealt;
      write('damage', 'hero', target.id, dealt);
      if (kit.lifesteal > 0) heal(Math.round(dealt * kit.lifesteal));
      if (target.hp === 0) {
        target.broken = false;
        target.rallied = 0;
        write('defeated', 'hero', target.id);
      } else addBreak(target, strike.breakAdd);
    }
    if (living().length === 0) finish('victory');
  }
  function endAction(current: Action): void {
    const enemy = enemyById(current.actor);
    if (enemy) {
      if (current.move === 'approach') {
        enemy.band = 'close';
        write('approach', enemy.id, 'hero');
      } else if (current.move === 'step-back') {
        enemy.band = 'far';
        write('retreat', enemy.id, 'hero');
      } else if (current.move === 'rally') {
        for (const ally of living()) ally.rallied = RULES.rallyAttacks;
        write('rally', enemy.id, enemy.id);
      } else if (current.hits.length > 0 && current.hits.every(h => h.outcome === 'parried') && (kit.ranged || enemy.band === 'close')) {
        // Every blow of the move was parried: the hero answers at once. A melee hero cannot reach a far archer.
        write('counter', 'hero', enemy.id);
        const timing = HERO_TIMING.counter;
        start('hero', 'counter', enemy.id, timing.ticks, [],
          [{ at: now + timing.impact, targets: [enemy.id], multiplier: kit.counter, breakAdd: RULES.counterBreak, done: false }]);
        return;
      }
    }
    beginTurn();
  }
  function skillReason(spec: SkillSpec, target: string | undefined): BattleNotice | null {
    if (spec.targeted ? !enemyById(target) : target !== undefined) return 'target';
    if ((spec.id === 'fall-back' || spec.id === 'cleave') && !living().some(e => e.band === 'close')) return 'target';
    if (spec.id === 'warcry' && !living().some(e => e.band === 'far')) return 'target';
    return hero.ap < spec.cost ? 'ap' : null;
  }
  function strike(targets: string[], multiplier: number, breakAdd: number, impact: number): Strike[] {
    if (targets.length === 0) return [];
    const empowered = hero.empowered;
    hero.empowered = 1;
    return [{ at: now + impact, targets, multiplier: multiplier * empowered, breakAdd, done: false }];
  }
  function attack(targetId: string): void {
    const target = enemyById(targetId)!;
    let multiplier = 1;
    if (!kit.ranged && target.band === 'far') {
      target.band = 'close';
      multiplier *= RULES.charge;
    }
    hero.ap = Math.min(RULES.maxAp, hero.ap + 1);
    const timing = HERO_TIMING.attack;
    start('hero', 'attack', target.id, timing.ticks, [], strike([target.id], multiplier, 1, timing.impact));
  }
  function useSkill(spec: SkillSpec, targetId: string | undefined): void {
    hero.ap -= spec.cost;
    write('skill', 'hero', targetId ?? 'hero', spec.cost);
    let targets: string[] = [], multiplier = spec.damage;
    switch (spec.id) {
      case 'aimed-shot':
        targets = [targetId!];
        break;
      case 'volley':
        targets = living().map(e => e.id);
        break;
      case 'fall-back':
        for (const e of living()) if (e.band === 'close') e.band = 'far';
        targets = [targetId!];
        break;
      case 'shield-bash': {
        const target = enemyById(targetId)!;
        if (target.band === 'far') {
          target.band = 'close';
          multiplier *= RULES.charge;
        }
        targets = [target.id];
        break;
      }
      case 'bulwark':
        hero.bulwark = true;
        heal(RULES.bulwarkHeal);
        break;
      case 'cleave':
        targets = living().filter(e => e.band === 'close').map(e => e.id);
        break;
      case 'warcry':
        for (const e of living()) e.band = 'close';
        hero.empowered = RULES.warcry;
        break;
    }
    start('hero', spec.id, targetId ?? null, spec.ticks, [], strike(targets, multiplier, spec.breakAdd, spec.impact));
  }
  function order(): string[] {
    if (phase === 'victory' || phase === 'defeat') return [];
    const queue = [{ id: 'hero', next: hero.next, step: interval(kit.speed) },
      ...living().map(e => ({ id: e.id, next: e.next, step: interval(ENEMY_KITS[e.kind].speed) }))];
    const result = [phase === 'command' ? 'hero' : action!.actor];
    while (result.length < ORDER_LENGTH) {
      let best = queue[0]!;
      for (const entry of queue) if (entry.next < best.next) best = entry;
      result.push(best.id);
      best.next += best.step;
    }
    return result;
  }
  function commandOptions(): BattleCommandOption[] {
    if (phase !== 'command') return [];
    const targets = living().map(e => e.id);
    const options: BattleCommandOption[] = [{ command: 'attack', id: 'attack', cost: 0, targets, enabled: true, reason: null }];
    for (const spec of kit.skills) {
      const reason = skillReason(spec, spec.targeted ? targets[0] : undefined);
      options.push({ command: 'skill', id: spec.id, cost: spec.cost, targets: spec.targeted ? targets : [], enabled: !reason, reason });
    }
    const usable = hero.tonics > 0 && hero.hp < kit.maxHp;
    options.push({ command: 'item', id: 'tonic', cost: 0, targets: [], enabled: usable, reason: usable ? null : 'item' });
    return options;
  }

  beginTurn();
  return {
    command(value: BattleCommand): void {
      const command = validateCommand(value);
      notice = null;
      if (phase !== 'command') { notice = 'phase'; return; }
      if (command.type === 'attack') {
        if (!enemyById(command.target)) { notice = 'target'; return; }
        attack(command.target);
        return;
      }
      if (command.type === 'item') {
        if (hero.tonics === 0 || hero.hp >= kit.maxHp) { notice = 'item'; return; }
        hero.tonics--;
        write('item', 'hero', 'hero');
        heal(RULES.tonicHeal);
        start('hero', 'item', null, MOVE_TICKS.item);
        return;
      }
      const spec = kit.skills.find(skill => skill.id === command.skill);
      if (!spec) { notice = 'unavailable'; return; }
      const reason = skillReason(spec, command.target);
      if (reason) { notice = reason; return; }
      useSkill(spec, command.target);
    },
    tick(value: BattleInput = {}): boolean {
      const input = validateInput(value);
      if (phase !== 'action' || !action) return false;
      now++;
      const current: Action = action;
      const press: Reaction | null = input.parry ? 'parry' : input.dodge ? 'dodge' : null;
      if (press && now >= hero.lockoutUntil) {
        hero.lockoutUntil = now + TIMING.lockout;
        const at = now - setup.latencyTicks;
        const hit = current.hits.find(h => h.outcome === 'pending' && h.pressed === null &&
          at >= h.impact - TIMING.attempt && at <= h.impact + TIMING[press].late);
        if (hit) { hit.pressed = at; hit.reaction = press; }
      }
      const attacker = enemyById(current.actor);
      for (const hit of current.hits) {
        if (hit.outcome === 'pending' && now >= hit.impact + SETTLE + setup.latencyTicks) resolveHit(current, hit, attacker);
        if (phase !== 'action') return true;
      }
      for (const entry of current.strikes) {
        if (!entry.done && now >= entry.at) applyStrike(entry);
        if (phase !== 'action') return true;
      }
      if (now >= current.end && current.hits.every(h => h.outcome !== 'pending') && current.strikes.every(s => s.done)) endAction(current);
      return true;
    },
    snapshot(): BattleSnapshot {
      const current: Action | null = action;
      return {
        version: 1, encounter: setup.encounter, difficulty: setup.difficulty, phase, tick: now, round,
        hero: {
          faction: setup.faction, hp: hero.hp, maxHp: kit.maxHp, ap: hero.ap, maxAp: RULES.maxAp, tonics: hero.tonics,
          bulwark: hero.bulwark, empowered: hero.empowered, lockout: Math.max(0, hero.lockoutUntil - now),
        },
        enemies: enemies.map(e => ({
          id: e.id, kind: e.kind, hp: e.hp, maxHp: e.maxHp, band: e.band, breakMeter: e.breakMeter,
          breakMax: ENEMY_KITS[e.kind].breakMax, broken: e.broken, rallied: e.rallied,
        })),
        order: order(),
        action: current ? {
          id: current.id, actor: current.actor, move: current.move, target: current.target, start: current.start, end: current.end,
          hits: current.hits.map(h => ({ index: h.index, impact: h.impact, heavy: h.heavy, damage: h.damage, outcome: h.outcome, reaction: h.reaction })),
        } : null,
        commands: commandOptions(),
        log: log.map(entry => ({ ...entry })),
        notice,
      };
    },
  };
}
