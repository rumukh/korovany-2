import { describe, expect, test } from 'vitest';
import {
  createBattle, ENEMY_KITS, HERO_KITS, reactionWindow, suggestCommand, TIMING, type Battle, type BattleActionSnapshot,
  type BattleInput, type BattleSetup, type BattleSnapshot,
} from '../src/game/battle';
import type { FactionId } from '../src/game';
import { formatMetrics, measure, playBattle, Reactor, type BattleMetrics, type ReactionProfile } from './battle-bots';

const FACTIONS: FactionId[] = ['elf', 'guard', 'villain'];
const SETTLE = Math.max(TIMING.dodge.late, TIMING.parry.late);

/** Plays the policy without reactions until an enemy move with blows starts; null if the battle ends first. */
function toNextBlow(battle: Battle): BattleSnapshot | null {
  for (let i = 0; i < 20_000; i++) {
    const s = battle.snapshot();
    if (s.phase === 'victory' || s.phase === 'defeat') return null;
    if (s.phase === 'command') battle.command(suggestCommand(s));
    else if (s.action!.actor !== 'hero' && s.action!.hits.length > 0 && s.tick === s.action!.start) return s;
    else battle.tick();
  }
  throw new Error('No enemy blow');
}

/** A deterministic setup whose first enemy blow move matches; replaying the setup reaches the same move again. */
function findBlow(faction: FactionId, match: (action: BattleActionSnapshot, s: BattleSnapshot) => boolean,
  extra: Partial<BattleSetup> = {}): BattleSetup {
  for (let seed = 0; seed < 300; seed++) {
    const setup: BattleSetup = { seed: `rule-${seed}`, faction, encounter: 'post-garrison', opening: 'ambushed', ...extra };
    const s = toNextBlow(createBattle(setup));
    if (s && match(s.action!, s)) return setup;
  }
  throw new Error('No matching blow');
}

/** Replays `setup` to its first enemy blow, ticks through that move with the given presses and returns its blows. */
function answer(setup: BattleSetup, presses: (action: BattleActionSnapshot) => Map<number, BattleInput>) {
  const battle = createBattle(setup);
  const before = toNextBlow(battle)!;
  const action = before.action!, schedule = presses(action);
  let last = action;
  for (let tick = before.tick + 1; tick <= action.end + 1; tick++) {
    battle.tick(schedule.get(tick) ?? {});
    const s = battle.snapshot();
    if (s.phase === 'victory' || s.phase === 'defeat') return { before, action: s.action ?? last, after: s, battle };
    if (s.action?.id !== action.id) return { before, action: last, after: s, battle };
    last = s.action;
  }
  throw new Error('The move did not end');
}

const at = (entries: [number, BattleInput][]): Map<number, BattleInput> => new Map(entries);
const single = (a: BattleActionSnapshot): boolean => a.hits.length === 1 && !a.hits[0]!.heavy;

describe('battle prototype rules', () => {
  test('the hero turn waits for a command and no time passes', () => {
    const battle = createBattle({ seed: 'wait', faction: 'elf', encounter: 'post-garrison', opening: 'first-strike' });
    const s = battle.snapshot();
    expect(s.phase).toBe('command');
    expect(s.order[0]).toBe('hero');
    expect(s.order.filter(id => id === 'hero').length).toBeGreaterThanOrEqual(s.order.filter(id => id === 'captain').length);
    expect(s.commands.map(c => c.id)).toEqual(['attack', 'aimed-shot', 'volley', 'fall-back', 'tonic']);
    expect(battle.tick({ parry: true })).toBe(false);
    expect(battle.snapshot()).toEqual(s);
  });

  test('malformed input throws; unavailable commands only set a notice', () => {
    const valid: BattleSetup = { seed: 'checks', faction: 'elf', encounter: 'post-garrison', opening: 'first-strike' };
    for (const bad of [{ ...valid, faction: 'orc' }, { ...valid, encounter: 'dragon' }, { ...valid, latencyTicks: 13 },
      { ...valid, opening: 'flank' }, { ...valid, difficulty: 'easy' }, { ...valid, extra: true }, { ...valid, seed: '' }]) {
      expect(() => createBattle(bad as BattleSetup)).toThrow();
    }
    const battle = createBattle(valid);
    const before = battle.snapshot();
    for (const malformed of [{ type: 'attack' }, { type: 'cast', target: 'soldier' }, { type: 'skill', skill: 'fireball' },
      { type: 'item', item: 'elixir' }, { type: 'attack', target: 'soldier', twice: true }]) {
      expect(() => battle.command(malformed as never)).toThrow();
    }
    expect(() => battle.tick({ dodge: 1 } as never)).toThrow();
    expect(() => battle.tick({ block: true } as never)).toThrow();
    for (const [command, notice] of [
      [{ type: 'skill', skill: 'cleave' }, 'unavailable'], [{ type: 'skill', skill: 'volley' }, 'ap'],
      [{ type: 'attack', target: 'nobody' }, 'target'], [{ type: 'skill', skill: 'aimed-shot' }, 'target'],
      [{ type: 'skill', skill: 'fall-back', target: 'soldier' }, 'target'], [{ type: 'item', item: 'tonic' }, 'item'],
    ] as const) {
      battle.command(command);
      expect(battle.snapshot()).toEqual({ ...before, notice });
    }
  });

  test('a parry inside its window negates a blow and grants AP; parrying a whole move earns a counter', () => {
    const setup = findBlow('guard', (a, s) => a.hits.every(h => !h.heavy) &&
      s.enemies.find(e => e.id === a.actor)!.band === 'close' && s.enemies.find(e => e.id === a.actor)!.kind !== 'archer');
    const { before, action, after, battle } = answer(setup, a => at(a.hits.map(h => [h.impact - 1, { parry: true }])));
    expect(action.hits.every(h => h.outcome === 'parried' && h.reaction === 'parry')).toBe(true);
    expect(after.hero.hp).toBe(before.hero.hp);
    expect(after.hero.ap).toBe(Math.min(6, before.hero.ap + action.hits.length));
    expect(after.action).toMatchObject({ actor: 'hero', move: 'counter', target: action.actor });
    const hp = (s: BattleSnapshot) => s.enemies.find(e => e.id === action.actor)!.hp;
    const counter = after.action!.id;
    for (let i = 0; i < 200 && battle.snapshot().action?.id === counter; i++) battle.tick();
    expect(hp(battle.snapshot())).toBeLessThan(hp(after));
  });

  test('early, late and mashed presses fail; the dodge window is wider than the parry window', () => {
    const setup = findBlow('guard', single);
    const outcome = (presses: (a: BattleActionSnapshot) => Map<number, BattleInput>) => answer(setup, presses).action.hits[0]!;
    const parryEarly = reactionWindow('guard', 'standard', 'parry').early;
    expect(parryEarly).toBe(Math.round(TIMING.parry.early * HERO_KITS.guard.parryWindow));
    expect(reactionWindow('guard', 'standard', 'dodge').early).toBeGreaterThan(parryEarly);
    expect(outcome(() => at([]))).toMatchObject({ outcome: 'hit', reaction: null, pressed: null });
    const parried = outcome(a => at([[a.hits[0]!.impact - parryEarly, { parry: true }]]));
    expect(parried).toMatchObject({ outcome: 'parried', reaction: 'parry', pressed: parried.impact - parryEarly });
    expect(outcome(a => at([[a.hits[0]!.impact - parryEarly - 1, { parry: true }]])).outcome).toBe('hit');
    expect(outcome(a => at([[a.hits[0]!.impact - parryEarly - 1, { dodge: true }]])).outcome).toBe('dodged');
    expect(outcome(a => at([[a.hits[0]!.impact + TIMING.parry.late, { parry: true }]])).outcome).toBe('parried');
    expect(outcome(a => at([[a.hits[0]!.impact + TIMING.parry.late + 1, { parry: true }]])).outcome).toBe('hit');
    const mash = (key: 'dodge' | 'parry') => (a: BattleActionSnapshot) =>
      at(Array.from({ length: a.end - a.start }, (_, i) => [a.start + 1 + i, { [key]: true }]));
    expect(outcome(mash('parry')).outcome).toBe('hit');
    expect(outcome(mash('dodge')).outcome).toBe('hit');
    const hit = answer(setup, () => at([]));
    expect(hit.after.hero.hp).toBe(hit.before.hero.hp - hit.action.hits[0]!.damage);
  });

  test('heavy blows cannot be parried but can be dodged', () => {
    const setup = findBlow('elf', a => a.hits.length === 1 && a.hits[0]!.heavy);
    expect(answer(setup, a => at([[a.hits[0]!.impact - 1, { parry: true }]])).action.hits[0]!.outcome).toBe('hit');
    expect(answer(setup, a => at([[a.hits[0]!.impact - 1, { dodge: true }]])).action.hits[0]!.outcome).toBe('dodged');
  });

  test('latency calibration shifts the windows by the player delay', () => {
    const setup = findBlow('villain', single);
    const late = (latencyTicks: number) => answer({ ...setup, latencyTicks },
      a => at([[a.hits[0]!.impact + 5, { parry: true }]])).action.hits[0]!.outcome;
    expect(late(0)).toBe('hit');
    expect(late(6)).toBe('parried');
  });

  test('fall back pushes close enemies away, so melee troops spend their turn approaching', () => {
    const battle = createBattle({ seed: 'fall-back', faction: 'elf', encounter: 'post-garrison', opening: 'ambushed' });
    let s = battle.snapshot();
    while (s.phase !== 'command') { battle.tick(); s = battle.snapshot(); }
    expect(s.enemies.filter(e => e.kind !== 'archer').every(e => e.band === 'close')).toBe(true);
    battle.command({ type: 'skill', skill: 'fall-back', target: 'soldier' });
    expect(battle.snapshot().enemies.every(e => e.band === 'far')).toBe(true);
    const melee = new Map<string, string>();
    for (let i = 0; i < 5000 && melee.size < 2; i++) {
      s = battle.snapshot();
      if (s.phase === 'command') battle.command({ type: 'attack', target: 'archer' });
      else {
        const actor = s.action!.actor;
        if ((actor === 'soldier' || actor === 'captain') && !melee.has(actor) && s.action!.move !== 'recover') melee.set(actor, s.action!.move);
        battle.tick();
      }
    }
    expect([...melee.values()]).toEqual(['approach', 'approach']);
  });

  test('a broken enemy loses its next turn', () => {
    let breaks = 0;
    for (const faction of FACTIONS) {
      for (let seed = 0; seed < 6; seed++) {
        const result = playBattle({ seed: `break-${seed}`, faction, encounter: 'post-garrison' }, 'expert');
        for (const entry of result.log.filter(e => e.kind === 'break')) {
          const next = result.actions.find(a => a.actor === entry.target && a.tick > entry.tick);
          if (!next) continue;
          breaks++;
          expect(next.move).toBe('recover');
        }
      }
    }
    expect(breaks).toBeGreaterThan(5);
  });

  test('battles are deterministic and finished battles are frozen', () => {
    const setup: BattleSetup = { seed: 'replay', faction: 'villain', encounter: 'post-garrison', difficulty: 'expert' };
    expect(playBattle(setup, 'average')).toEqual(playBattle(setup, 'average'));
    const battle = createBattle(setup), reactor = new Reactor('perfect', 'frozen');
    let s = battle.snapshot();
    for (let i = 0; i < 100_000 && s.phase !== 'victory' && s.phase !== 'defeat'; i++) {
      if (s.phase === 'command') battle.command(suggestCommand(s));
      else { reactor.observe(s); battle.tick(reactor.input(s.tick + 1)); }
      s = battle.snapshot();
    }
    expect(s.phase).toBe('victory');
    expect(s.hero.hp).toBe(s.hero.maxHp);
    expect(battle.tick({ parry: true })).toBe(false);
    battle.command({ type: 'attack', target: 'soldier' });
    expect(battle.snapshot()).toEqual({ ...s, notice: 'phase' });
  });

  test('every enemy move can be answered: blows are spaced beyond the lockout and settle before the move ends', () => {
    for (const kit of Object.values(ENEMY_KITS)) {
      for (const move of kit.moves) {
        expect(move.blows[0]!.at, `${kit.kind} ${move.id}`).toBeGreaterThanOrEqual(TIMING.attempt);
        for (let i = 1; i < move.blows.length; i++) {
          expect(move.blows[i]!.at - move.blows[i - 1]!.at, `${kit.kind} ${move.id}`).toBeGreaterThan(TIMING.lockout);
        }
        expect(move.ticks, `${kit.kind} ${move.id}`).toBeGreaterThan(move.blows.at(-1)!.at + SETTLE + 12);
      }
    }
  });

  test('mashing cannot reach a standard or expert window: a repeated press binds before every window opens', () => {
    const widest = Math.max(...Object.values(HERO_KITS).flatMap(kit => [
      Math.round(TIMING.dodge.early * kit.dodgeWindow), Math.round(TIMING.parry.early * kit.parryWindow)]));
    expect(TIMING.attempt - TIMING.lockout + 1).toBeGreaterThan(widest);
  });
});

describe('battle prototype tuning targets (post garrison, deterministic bots)', () => {
  const seeds = Number(process.env.KOROVANY_BATTLE_SEEDS ?? 60);
  const rows: BattleMetrics[] = [];
  const row = (faction: FactionId, difficulty: BattleMetrics['difficulty'], profile: ReactionProfile, opening?: 'first-strike' | 'ambushed') => {
    const metrics = measure(faction, difficulty, profile, seeds, opening);
    if (!opening) rows.push(metrics);
    return metrics;
  };

  test('standard difficulty rewards reactions without demanding perfection', () => {
    for (const faction of FACTIONS) {
      expect(row(faction, 'standard', 'none').winRate, faction).toBeLessThanOrEqual(0.05);
      const masher = row(faction, 'standard', 'masher');
      expect(masher.winRate, faction).toBeLessThanOrEqual(0.05);
      expect(masher.defended, faction).toBe(0);
      const novice = row(faction, 'standard', 'novice').winRate;
      expect(novice, faction).toBeGreaterThanOrEqual(0.55);
      expect(novice, faction).toBeLessThanOrEqual(0.95);
      const average = row(faction, 'standard', 'average');
      expect(average.winRate, faction).toBeGreaterThanOrEqual(0.9);
      expect(average.hpLeft, faction).toBeLessThanOrEqual(0.75);
      expect(average.minutes, faction).toBeGreaterThanOrEqual(1);
      expect(average.minutes, faction).toBeLessThanOrEqual(3.5);
      expect(row(faction, 'standard', 'expert').winRate, faction).toBeGreaterThanOrEqual(0.97);
      const perfect = row(faction, 'standard', 'perfect');
      expect(perfect.winRate, faction).toBe(1);
      expect(perfect.hpLeft, faction).toBe(1);
    }
    const novices = rows.filter(r => r.difficulty === 'standard' && r.profile === 'novice').map(r => r.winRate);
    expect(Math.max(...novices) - Math.min(...novices)).toBeLessThanOrEqual(0.2);
  });

  test('story difficulty is winnable without reactions; expert difficulty is harder', () => {
    for (const faction of FACTIONS) {
      expect(row(faction, 'story', 'none').winRate, faction).toBeGreaterThanOrEqual(0.85);
      expect(row(faction, 'story', 'novice').winRate, faction).toBeGreaterThanOrEqual(0.97);
      const average = row(faction, 'expert', 'average').winRate;
      expect(average, faction).toBeGreaterThanOrEqual(0.6);
      expect(average, faction).toBeLessThanOrEqual(0.97);
      expect(row(faction, 'expert', 'expert').winRate, faction).toBeGreaterThanOrEqual(0.9);
    }
  });

  test('a first strike helps and an ambush hurts', () => {
    const mean = (opening?: 'first-strike' | 'ambushed') =>
      FACTIONS.reduce((sum, faction) => sum + measure(faction, 'standard', 'novice', seeds, opening).winRate, 0) / FACTIONS.length;
    const neutral = mean(), first = mean('first-strike'), ambushed = mean('ambushed');
    expect(first).toBeGreaterThan(neutral);
    expect(ambushed).toBeLessThan(neutral - 0.05);
    if (process.env.KOROVANY_BATTLE_REPORT === '1') {
      console.log(`${formatMetrics(rows)}\n\nNovice win rate by opening: neutral ${Math.round(neutral * 100)}%, ` +
        `first strike ${Math.round(first * 100)}%, ambushed ${Math.round(ambushed * 100)}% (${seeds} seeds)`);
    }
  });
});
