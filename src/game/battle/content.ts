/**
 * Data for the battle prototype: timing windows, difficulty presets, hero kits, enemy movesets and encounters. Every
 * duration is in 60 Hz ticks. The numbers are tuned by `tests/battle-prototype.test.ts` against the design targets in
 * `README.md`; change them together with that test.
 */
import type { FactionId } from '../types';
import type { BattleDifficulty, EncounterId, EnemyKind, SkillId } from './types';

/** Reaction timing, relative to a blow's impact tick. */
export const TIMING = {
  /** The first press from this many ticks before impact is that blow's one attempt; earlier presses bind to nothing. */
  attempt: 24,
  /** Success windows: `early` ticks before impact (scaled by difficulty and kit) to `late` ticks after it. */
  dodge: { early: 10, late: 3 },
  parry: { early: 5, late: 2 },
  /**
   * Ticks after any press before another press counts. With `attempt`, it also defeats mashing: a repeated press binds
   * within `lockout` ticks of a blow's attempt window opening, before every standard and expert success window.
   */
  lockout: 8,
} as const;

export const DIFFICULTY: Readonly<Record<BattleDifficulty, { window: number; damage: number }>> = {
  story: { window: 1.8, damage: 0.5 },
  standard: { window: 1, damage: 1 },
  expert: { window: 0.7, damage: 1.25 },
};

export const RULES = {
  maxAp: 6,
  startAp: 2,
  tonics: 2,
  /** HP a tonic restores: flat, so the sturdier heroes gain less from it. */
  tonicHeal: 50,
  /** Damage taken by a broken enemy, and dealt by a rallied one. */
  brokenBonus: 1.25,
  rallyBonus: 1.25,
  rallyAttacks: 2,
  rallyChance: 0.3,
  /** A melee strike on a far target closes in and deals this share. */
  charge: 0.7,
  /** The elf's shots at a close target deal this share. */
  elfClose: 0.75,
  /** Share of damage the guard takes under Bulwark, and what it heals. */
  bulwark: 0.35,
  bulwarkHeal: 25,
  /** The villain's next damaging action after a war cry. */
  warcry: 1.25,
  counterBreak: 2,
  parryBreak: 1,
  /** A ranged enemy caught close steps back with this chance instead of shooting. */
  retreatChance: 0.6,
} as const;

/** Durations of actions without blows. */
export const MOVE_TICKS = { approach: 36, 'step-back': 30, rally: 50, recover: 24, item: 40 } as const;

/** Assumed seconds a player spends choosing each command; used only to estimate battle length. */
export const DECISION_SECONDS = 5;

export interface StrikeTiming {
  ticks: number;
  impact: number;
}
export const HERO_TIMING: Readonly<Record<'attack' | 'counter', StrikeTiming>> = {
  attack: { ticks: 42, impact: 22 },
  counter: { ticks: 32, impact: 14 },
};

export interface SkillSpec extends StrikeTiming {
  id: SkillId;
  cost: number;
  /** Targeted skills need one living enemy; the others take none. */
  targeted: boolean;
  /** Multiplier of the hero's damage per target, 0 for none. */
  damage: number;
  breakAdd: number;
}

export interface HeroKit {
  faction: FactionId;
  maxHp: number;
  speed: number;
  damage: number;
  ranged: boolean;
  /** Share of incoming damage taken. */
  armor: number;
  /** Multipliers of the dodge and parry windows. */
  dodgeWindow: number;
  parryWindow: number;
  /** Counter-attack damage multiplier. */
  counter: number;
  /** Share of damage dealt that heals the hero. */
  lifesteal: number;
  /** The first blow taken from each enemy move grants 1 AP. */
  rage: boolean;
  skills: readonly SkillSpec[];
}

/** HP, damage and speed follow the factions' real-time identities (see `FACTIONS`), rescaled for turns. */
export const HERO_KITS: Readonly<Record<FactionId, HeroKit>> = {
  elf: {
    faction: 'elf', maxHp: 120, speed: 115, damage: 24, ranged: true, armor: 1,
    dodgeWindow: 1.5, parryWindow: 1, counter: 1, lifesteal: 0, rage: false,
    skills: [
      { id: 'aimed-shot', cost: 2, targeted: true, ticks: 56, impact: 34, damage: 2.2, breakAdd: 2 },
      { id: 'volley', cost: 3, targeted: false, ticks: 62, impact: 38, damage: 0.9, breakAdd: 1 },
      { id: 'fall-back', cost: 2, targeted: true, ticks: 58, impact: 40, damage: 1, breakAdd: 1 },
    ],
  },
  guard: {
    faction: 'guard', maxHp: 180, speed: 90, damage: 32, ranged: false, armor: 0.9,
    dodgeWindow: 1, parryWindow: 1.4, counter: 1.5, lifesteal: 0, rage: false,
    skills: [
      { id: 'shield-bash', cost: 2, targeted: true, ticks: 50, impact: 26, damage: 1, breakAdd: 3 },
      { id: 'bulwark', cost: 3, targeted: false, ticks: 48, impact: 24, damage: 0, breakAdd: 0 },
    ],
  },
  villain: {
    faction: 'villain', maxHp: 150, speed: 100, damage: 34, ranged: false, armor: 1,
    dodgeWindow: 1, parryWindow: 1, counter: 1, lifesteal: 0.1, rage: true,
    skills: [
      { id: 'cleave', cost: 3, targeted: false, ticks: 60, impact: 34, damage: 1.1, breakAdd: 1 },
      { id: 'warcry', cost: 1, targeted: false, ticks: 46, impact: 22, damage: 0, breakAdd: 0 },
    ],
  },
};

export interface EnemyBlow {
  /** Ticks from the start of the move to impact. */
  at: number;
  damage: number;
  heavy?: boolean;
}
export interface EnemyMove {
  id: string;
  weight: number;
  ticks: number;
  blows: readonly EnemyBlow[];
}
export interface EnemyKit {
  kind: EnemyKind;
  maxHp: number;
  speed: number;
  ranged: boolean;
  breakMax: number;
  /** Attacks, chosen by weight once the enemy is in range. */
  moves: readonly EnemyMove[];
}

export const ENEMY_KITS: Readonly<Record<EnemyKind, EnemyKit>> = {
  soldier: {
    kind: 'soldier', maxHp: 130, speed: 95, ranged: false, breakMax: 4,
    moves: [
      { id: 'cut', weight: 6, ticks: 70, blows: [{ at: 38, damage: 14 }] },
      { id: 'double-cut', weight: 4, ticks: 84, blows: [{ at: 34, damage: 10 }, { at: 58, damage: 10 }] },
    ],
  },
  archer: {
    kind: 'archer', maxHp: 90, speed: 100, ranged: true, breakMax: 3,
    moves: [
      { id: 'loose', weight: 6, ticks: 72, blows: [{ at: 46, damage: 12 }] },
      { id: 'pinning-shot', weight: 3, ticks: 90, blows: [{ at: 64, damage: 18, heavy: true }] },
    ],
  },
  captain: {
    kind: 'captain', maxHp: 200, speed: 85, ranged: false, breakMax: 6,
    moves: [
      { id: 'hammer-combo', weight: 5, ticks: 110, blows: [{ at: 32, damage: 9 }, { at: 52, damage: 9 }, { at: 86, damage: 14 }] },
      { id: 'overhead', weight: 3, ticks: 92, blows: [{ at: 56, damage: 22, heavy: true }] },
    ],
  },
};

/** A post's three defenders: the forest depot, the palace supply gate and the quarry road post all hold this garrison. */
export const ENCOUNTERS: Readonly<Record<EncounterId, readonly { id: string; kind: EnemyKind }[]>> = {
  'post-garrison': [{ id: 'soldier', kind: 'soldier' }, { id: 'archer', kind: 'archer' }, { id: 'captain', kind: 'captain' }],
};
