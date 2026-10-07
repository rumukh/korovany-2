import { createPrng, type Prng } from '@aegis/core';
import {
  createBattle, DECISION_SECONDS, suggestCommand, type BattleDifficulty, type BattleHitSnapshot,
  type BattleInput, type BattleLogEntry, type BattleOpening, type BattleSetup, type BattleSnapshot,
} from '../src/game/battle';
import type { FactionId } from '../src/game';

export type ReactionProfile = 'none' | 'masher' | 'novice' | 'average' | 'expert' | 'perfect';

/**
 * Assumed human timing, for comparing tunings only, not measurements of players: a press lands `bias` ticks from impact
 * with Gaussian error `sigma`, `lapse` is the chance of not reacting to a blow at all, and `parry` the chance of trying
 * the riskier parry on a parryable blow. Heavy blows are always recognized and dodged.
 */
export const HUMAN: Readonly<Record<'novice' | 'average' | 'expert', { bias: number; sigma: number; lapse: number; parry: number }>> = {
  novice: { bias: -1, sigma: 9, lapse: 0.15, parry: 0.35 },
  average: { bias: -1, sigma: 6, lapse: 0.07, parry: 0.6 },
  expert: { bias: -1, sigma: 3.5, lapse: 0.02, parry: 0.85 },
};

function gaussian(rng: Prng): number {
  const u = Math.max(rng.nextFloat(), 1e-12), v = rng.nextFloat();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Plans one press per incoming blow when its action first appears, like a player reading the windup. */
export class Reactor {
  private readonly planned = new Map<number, BattleInput>();
  private readonly seen = new Set<string>();
  private readonly rng: Prng;
  constructor(readonly profile: ReactionProfile, seed: string | number) {
    this.rng = createPrng(`korovany2:battle-bot:${seed}`);
  }
  observe(s: BattleSnapshot): void {
    const action = s.action;
    if (!action || action.actor === 'hero') return;
    for (const hit of action.hits) {
      const key = `${action.id}:${hit.index}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const plan = this.plan(hit);
      if (plan && !this.planned.has(plan.tick)) this.planned.set(plan.tick, plan.input);
    }
  }
  /** The pulses for entering tick `next`. */
  input(next: number): BattleInput {
    if (this.profile === 'masher') return { dodge: true };
    const input = this.planned.get(next);
    this.planned.delete(next);
    return input ?? {};
  }
  private plan(hit: BattleHitSnapshot): { tick: number; input: BattleInput } | null {
    if (this.profile === 'none' || this.profile === 'masher') return null;
    if (this.profile === 'perfect') return { tick: hit.impact - 1, input: hit.heavy ? { dodge: true } : { parry: true } };
    const human = HUMAN[this.profile];
    if (this.rng.bool(human.lapse)) return null;
    const parry = !hit.heavy && this.rng.bool(human.parry);
    return { tick: hit.impact + Math.round(human.bias + human.sigma * gaussian(this.rng)), input: parry ? { parry: true } : { dodge: true } };
  }
}

export interface BattleResult {
  victory: boolean;
  /** Hero turns. */
  rounds: number;
  /** Ticks of action, excluding the paused command phases. */
  ticks: number;
  /** Action time plus `DECISION_SECONDS` per command. */
  minutes: number;
  /** Share of maximum HP left at the end. */
  hpLeft: number;
  /** Blows aimed at the hero, and how they ended. */
  blows: number;
  parried: number;
  dodged: number;
  /** Every log entry and every action start, in order. */
  log: BattleLogEntry[];
  actions: { tick: number; actor: string; move: string }[];
  final: BattleSnapshot;
}

/** Plays a whole battle through the public API, taking one snapshot per action. */
export function playBattle(setup: BattleSetup, profile: ReactionProfile, botSeed: string | number = setup.seed): BattleResult {
  const battle = createBattle(setup), reactor = new Reactor(profile, botSeed);
  const log: BattleLogEntry[] = [], actions: BattleResult['actions'] = [];
  let lastLog = 0, lastAction = 0;
  for (let step = 0; step < 20_000; step++) {
    const s = battle.snapshot();
    for (const entry of s.log) if (entry.id > lastLog) { log.push(entry); lastLog = entry.id; }
    if (s.action && s.action.id > lastAction) {
      lastAction = s.action.id;
      actions.push({ tick: s.action.start, actor: s.action.actor, move: s.action.move });
    }
    if (s.phase === 'victory' || s.phase === 'defeat') {
      const blows = log.filter(e => (e.kind === 'damage' && e.target === 'hero') || e.kind === 'parry' || e.kind === 'dodge').length;
      return {
        victory: s.phase === 'victory', rounds: s.round, ticks: s.tick, minutes: (s.tick / 60 + s.round * DECISION_SECONDS) / 60,
        hpLeft: s.hero.hp / s.hero.maxHp, blows, parried: log.filter(e => e.kind === 'parry').length,
        dodged: log.filter(e => e.kind === 'dodge').length, log, actions, final: s,
      };
    }
    if (s.phase === 'command') {
      battle.command(suggestCommand(s));
      const notice = battle.snapshot().notice;
      if (notice) throw new Error(`Bot command refused (${notice}) in round ${s.round}`);
      continue;
    }
    reactor.observe(s);
    const until = Math.max(s.action!.end, s.tick + 1);
    for (let tick = s.tick + 1; tick <= until; tick++) if (!battle.tick(reactor.input(tick))) break;
  }
  throw new Error(`Battle did not finish: ${JSON.stringify(setup)} ${profile}`);
}

export interface BattleMetrics {
  faction: FactionId;
  difficulty: BattleDifficulty;
  profile: ReactionProfile;
  battles: number;
  winRate: number;
  minutes: number;
  rounds: number;
  /** Mean share of HP left after victories. */
  hpLeft: number;
  /** Share of blows answered by a successful parry or dodge. */
  defended: number;
}

export function measure(faction: FactionId, difficulty: BattleDifficulty, profile: ReactionProfile, seeds: number,
  opening: BattleOpening = 'neutral'): BattleMetrics {
  const results = Array.from({ length: seeds }, (_, i) =>
    playBattle({ seed: `tuning-${i}`, faction, encounter: 'post-garrison', difficulty, opening }, profile, `reactor-${i}`));
  const mean = (values: number[]): number => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const wins = results.filter(r => r.victory);
  const blows = results.reduce((sum, r) => sum + r.blows, 0);
  return {
    faction, difficulty, profile, battles: seeds, winRate: wins.length / seeds, minutes: mean(results.map(r => r.minutes)),
    rounds: mean(results.map(r => r.rounds)), hpLeft: mean(wins.map(r => r.hpLeft)),
    defended: blows ? results.reduce((sum, r) => sum + r.parried + r.dodged, 0) / blows : 0,
  };
}

export function formatMetrics(rows: readonly BattleMetrics[]): string {
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  return ['| Faction | Difficulty | Reactions | Wins | Est. minutes | Hero turns | HP left (wins) | Blows defended |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.faction} | ${r.difficulty} | ${r.profile} | ${pct(r.winRate)} | ${r.minutes.toFixed(1)} | ` +
      `${r.rounds.toFixed(1)} | ${r.winRate ? pct(r.hpLeft) : '-'} | ${pct(r.defended)} |`)].join('\n');
}
