/**
 * Battle data: timing windows, difficulty presets, hero kits, enemy movesets (troops, the two final commanders, the
 * borderland's beasts and the legacy raid wagon), allies, wards and encounter presets. Every duration is in 60 Hz ticks.
 * The numbers are tuned by `tests/battle-prototype.test.ts` and `tests/battle-balance.test.ts` against the design targets
 * in `README.md`; change them together with those tests.
 */
import type { FactionId } from '../types';
import type { AllyKind, BattleDifficulty, EncounterId, EnemyKind, SkillId, WardId } from './types';

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
  story: { window: 1.8, damage: 0.3 },
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
  /** A melee strike on a far target closes in and deals this share. */
  charge: 0.7,
  /** The elf's shots at a close target deal this share. */
  elfClose: 0.75,
  /** Share of damage the guard takes under Bulwark, what it heals, and what it repairs on each ward. */
  bulwark: 0.35,
  bulwarkHeal: 25,
  bulwarkWardHeal: 30,
  /** The villain's next damaging action after a war cry. */
  warcry: 1.25,
  counterBreak: 2,
  parryBreak: 1,
  /** A ranged enemy caught close steps back with this chance instead of shooting. */
  retreatChance: 0.6,
  /** Most enemies in one battle, reinforcements included. */
  maxEnemies: 8,
  maxAllies: 4,
  /** The fortress's reinforcement wave joins the final battle once the commander is below this share of HP, each
   * soldier with `waveHp`: levies rushed from the walls. */
  waveAt: 0.6,
  waveHp: 40,
} as const;

/** Durations of actions without blows. */
export const MOVE_TICKS = {
  approach: 36, 'step-back': 30, rally: 50, recover: 24, item: 40, protect: 30,
} as const;

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
  /** Battle damage at the faction's base strength; upgrades scale it (see `BattleHeroSpec.damage`). */
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
  /** A successful dodge grants 1 AP. */
  dodgeAp: boolean;
  skills: readonly SkillSpec[];
}

/** HP, damage and speed follow the factions' identities (see `FACTIONS`), rescaled for turns. */
export const HERO_KITS: Readonly<Record<FactionId, HeroKit>> = {
  elf: {
    faction: 'elf', maxHp: 120, speed: 115, damage: 24, ranged: true, armor: 1,
    dodgeWindow: 1.35, parryWindow: 1, counter: 1, lifesteal: 0, rage: false, dodgeAp: true,
    skills: [
      { id: 'aimed-shot', cost: 2, targeted: true, ticks: 56, impact: 34, damage: 2.2, breakAdd: 2 },
      { id: 'volley', cost: 3, targeted: false, ticks: 62, impact: 38, damage: 0.9, breakAdd: 1 },
      { id: 'fall-back', cost: 2, targeted: true, ticks: 58, impact: 40, damage: 1, breakAdd: 1 },
    ],
  },
  guard: {
    faction: 'guard', maxHp: 180, speed: 90, damage: 32, ranged: false, armor: 0.9,
    dodgeWindow: 1, parryWindow: 1.4, counter: 1.5, lifesteal: 0, rage: false, dodgeAp: false,
    skills: [
      { id: 'shield-bash', cost: 2, targeted: true, ticks: 50, impact: 26, damage: 1, breakAdd: 3 },
      { id: 'bulwark', cost: 3, targeted: false, ticks: 48, impact: 24, damage: 0, breakAdd: 0 },
    ],
  },
  villain: {
    faction: 'villain', maxHp: 150, speed: 100, damage: 34, ranged: false, armor: 1,
    dodgeWindow: 1, parryWindow: 1, counter: 1, lifesteal: 0.1, rage: true, dodgeAp: false,
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
  /** Timeline speed; 0 never acts (the legacy raid wagon). */
  speed: number;
  ranged: boolean;
  breakMax: number;
  /** Chance per turn to rally every other living enemy instead of attacking, while none is rallied. */
  rally: number;
  /** Chance per attack to strike a ward (the convoy or the shipment) instead of the hero, while one stands. */
  raid: number;
  /** Attacks, chosen by weight once the enemy is in range. */
  moves: readonly EnemyMove[];
}

export const ENEMY_KITS: Readonly<Record<EnemyKind, EnemyKit>> = {
  soldier: {
    kind: 'soldier', maxHp: 130, speed: 95, ranged: false, breakMax: 4, rally: 0, raid: 0.3,
    moves: [
      { id: 'cut', weight: 6, ticks: 70, blows: [{ at: 38, damage: 14 }] },
      { id: 'double-cut', weight: 4, ticks: 84, blows: [{ at: 34, damage: 10 }, { at: 58, damage: 10 }] },
    ],
  },
  archer: {
    kind: 'archer', maxHp: 90, speed: 100, ranged: true, breakMax: 3, rally: 0, raid: 0.35,
    moves: [
      { id: 'loose', weight: 6, ticks: 72, blows: [{ at: 46, damage: 12 }] },
      { id: 'pinning-shot', weight: 3, ticks: 90, blows: [{ at: 64, damage: 18, heavy: true }] },
    ],
  },
  captain: {
    kind: 'captain', maxHp: 185, speed: 85, ranged: false, breakMax: 6, rally: 0.3, raid: 0.25,
    moves: [
      { id: 'hammer-combo', weight: 5, ticks: 110, blows: [{ at: 32, damage: 9 }, { at: 52, damage: 9 }, { at: 86, damage: 14 }] },
      { id: 'overhead', weight: 3, ticks: 92, blows: [{ at: 56, damage: 22, heavy: true }] },
    ],
  },
  /** Raut: a great axe swung in long arcs, and a skull-splitter held back to break a nervous parry. */
  warlord: {
    kind: 'warlord', maxHp: 380, speed: 90, ranged: false, breakMax: 8, rally: 0.2, raid: 0.15,
    moves: [
      { id: 'reaping-arc', weight: 5, ticks: 116, blows: [{ at: 30, damage: 9 }, { at: 50, damage: 9 }, { at: 86, damage: 14 }] },
      { id: 'skull-splitter', weight: 3, ticks: 108, blows: [{ at: 76, damage: 24, heavy: true }] },
      { id: 'earthshaker', weight: 2, ticks: 124, blows: [{ at: 40, damage: 11 }, { at: 88, damage: 20, heavy: true }] },
    ],
  },
  /** The Palace Marshal: quick halberd thrusts, a shield charge and a feinted thrust that lands late. */
  marshal: {
    kind: 'marshal', maxHp: 360, speed: 100, ranged: false, breakMax: 8, rally: 0.2, raid: 0.15,
    moves: [
      { id: 'halberd-flurry', weight: 5, ticks: 120, blows: [{ at: 28, damage: 7 }, { at: 44, damage: 7 }, { at: 60, damage: 7 }, { at: 92, damage: 11 }] },
      { id: 'shield-charge', weight: 3, ticks: 92, blows: [{ at: 54, damage: 20, heavy: true }] },
      { id: 'feinted-thrust', weight: 2, ticks: 106, blows: [{ at: 72, damage: 17 }] },
    ],
  },
  /** Grave wolves: quick, fragile, in packs. */
  wolf: {
    kind: 'wolf', maxHp: 56, speed: 120, ranged: false, breakMax: 2, rally: 0, raid: 0,
    moves: [
      { id: 'bite', weight: 6, ticks: 56, blows: [{ at: 26, damage: 7 }] },
      { id: 'snapping-lunge', weight: 4, ticks: 72, blows: [{ at: 24, damage: 5 }, { at: 42, damage: 5 }] },
    ],
  },
  /** Barrow ghouls: raking claw strings with a delayed last swipe. */
  ghoul: {
    kind: 'ghoul', maxHp: 96, speed: 100, ranged: false, breakMax: 3, rally: 0, raid: 0,
    moves: [
      { id: 'raking-claws', weight: 5, ticks: 100, blows: [{ at: 30, damage: 7 }, { at: 48, damage: 7 }, { at: 80, damage: 11 }] },
      { id: 'grave-rend', weight: 3, ticks: 84, blows: [{ at: 52, damage: 15 }] },
    ],
  },
  /** Bog trolls: alone, slow and heavy; their slams cannot be parried, only dodged. */
  troll: {
    kind: 'troll', maxHp: 420, speed: 70, ranged: false, breakMax: 8, rally: 0, raid: 0,
    moves: [
      { id: 'slam', weight: 5, ticks: 100, blows: [{ at: 68, damage: 26, heavy: true }] },
      { id: 'fist-and-slam', weight: 3, ticks: 126, blows: [{ at: 40, damage: 14 }, { at: 92, damage: 22, heavy: true }] },
      { id: 'backhand', weight: 2, ticks: 76, blows: [{ at: 44, damage: 16 }] },
    ],
  },
  /** The legacy campaign's raid wagon: it never acts, but must be destroyed. */
  caravan: {
    kind: 'caravan', maxHp: 200, speed: 0, ranged: false, breakMax: 99, rally: 0, raid: 0,
    moves: [],
  },
};

export interface AllyKit {
  kind: AllyKind;
  speed: number;
  damage: number;
  /** The support move's ID, duration and impact tick. */
  move: string;
  ticks: number;
  impact: number;
  /** The wagon this weapon fights from: it leaves the battle when that ward is wrecked. */
  ward?: WardId;
}
/** Friendly soldiers and convoy weapons near a battle: they strike the weakest enemy on their turns and are never targeted. */
export const ALLY_KITS: Readonly<Record<AllyKind, AllyKit>> = {
  soldier: { kind: 'soldier', speed: 80, damage: 12, move: 'strike', ticks: 40, impact: 22 },
  archer: { kind: 'archer', speed: 85, damage: 10, move: 'shoot', ticks: 40, impact: 24 },
  captain: { kind: 'captain', speed: 75, damage: 16, move: 'strike', ticks: 44, impact: 24 },
  'arrow-cart': { kind: 'arrow-cart', speed: 70, damage: 10, move: 'cart-volley', ticks: 40, impact: 26, ward: 'convoy' },
  'siege-cart': { kind: 'siege-cart', speed: 45, damage: 26, move: 'siege-shot', ticks: 52, impact: 34, ward: 'convoy' },
};

/** Preset rosters for the sandbox and the balance bots; campaign battles list their own participants. */
export const ENCOUNTERS: Readonly<Record<EncounterId, readonly { id: string; kind: EnemyKind }[]>> = {
  'post-garrison': [{ id: 'soldier', kind: 'soldier' }, { id: 'archer', kind: 'archer' }, { id: 'captain', kind: 'captain' }],
  'shipment-escort': [{ id: 'soldier', kind: 'soldier' }, { id: 'archer', kind: 'archer' }],
  'wolf-pack': [{ id: 'wolf-1', kind: 'wolf' }, { id: 'wolf-2', kind: 'wolf' }, { id: 'wolf-3', kind: 'wolf' }, { id: 'wolf-4', kind: 'wolf' }],
  'ghoul-pack': [{ id: 'ghoul-1', kind: 'ghoul' }, { id: 'ghoul-2', kind: 'ghoul' }, { id: 'ghoul-3', kind: 'ghoul' }],
  troll: [{ id: 'troll', kind: 'troll' }],
  warlord: [{ id: 'warlord', kind: 'warlord' }, { id: 'guard-1', kind: 'captain' }, { id: 'guard-2', kind: 'captain' }],
  marshal: [{ id: 'marshal', kind: 'marshal' }, { id: 'guard-1', kind: 'captain' }, { id: 'guard-2', kind: 'captain' }],
};
