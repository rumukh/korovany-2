/**
 * Turn-based battles with timed defence (design: `README.md` in this folder). Time is counted in 60 Hz ticks. On the
 * hero's turn a battle waits for a command and no time passes; while an action plays it advances one tick per
 * `tickBattle`. A dodge or parry press during an enemy action is bound to the next incoming hit and succeeds only inside
 * that hit's timing window. A battle's whole state is a plain, serializable `BattleState`.
 */
import type { FactionId } from '../types';

export type BattleDifficulty = 'story' | 'standard' | 'expert';
/** First strike: the hero acts first. Ambushed: the enemies act first and their melee fighters start close. */
export type BattleOpening = 'neutral' | 'first-strike' | 'ambushed';
export type BattlePhase = 'command' | 'action' | 'victory' | 'defeat';
/** Abstract distance from the hero: melee needs `close`; ranged attacks reach both bands. */
export type Band = 'close' | 'far';
/** Troops, the two final commanders (Raut and the Palace Marshal), the borderland's beasts and the legacy raid wagon. */
export type EnemyKind = 'soldier' | 'archer' | 'captain' | 'warlord' | 'marshal' | 'wolf' | 'ghoul' | 'troll' | 'caravan';
/** Friendly troops and the convoy's weapon (the elves' arrow cart, the mountain army's siege cart). */
export type AllyKind = 'soldier' | 'archer' | 'captain' | 'arrow-cart' | 'siege-cart';
/** Wagons enemies may strike instead of the hero: the logistics convoy and the escorted shipment. */
export type WardId = 'convoy' | 'shipment';
export type EncounterId = 'post-garrison' | 'shipment-escort' | 'wolf-pack' | 'ghoul-pack' | 'troll' | 'warlord' | 'marshal';
export type Reaction = 'dodge' | 'parry';
export type HitOutcome = 'pending' | 'hit' | 'dodged' | 'parried';
export type SkillId = 'aimed-shot' | 'volley' | 'fall-back' | 'shield-bash' | 'bulwark' | 'cleave' | 'warcry';
/** Why a well-formed command changed nothing: wrong phase, invalid target, too few AP, not this hero's skill, no item. */
export type BattleNotice = 'phase' | 'target' | 'ap' | 'unavailable' | 'item';

export interface BattleEnemySpec {
  id: string;
  kind: EnemyKind;
  /** Current HP; defaults to the kit's maximum. */
  hp?: number;
  /** Starting band; defaults to far, or close for melee fighters when ambushed. */
  band?: Band;
}
export interface BattleAllySpec { id: string; kind: AllyKind }
export interface BattleWardSpec { id: WardId; hp: number; maxHp: number }
/** The hero's campaign stats; defaults to the faction kit (full HP, base damage). */
export interface BattleHeroSpec { hp: number; maxHp: number; damage: number }

export interface BattleSetup {
  seed: string | number;
  faction: FactionId;
  /** A preset roster (sandbox and bots). Exactly one of `encounter` and `enemies`. */
  encounter?: EncounterId;
  enemies?: readonly BattleEnemySpec[];
  allies?: readonly BattleAllySpec[];
  wards?: readonly BattleWardSpec[];
  hero?: BattleHeroSpec;
  difficulty?: BattleDifficulty;
  opening?: BattleOpening;
  /** The player's measured input and display latency in ticks (0-12), subtracted from every reaction press. */
  latencyTicks?: number;
}

export type BattleCommand =
  | { type: 'attack'; target: string }
  | { type: 'skill'; skill: SkillId; target?: string }
  | { type: 'item'; item: 'tonic' }
  /** Cover the wagons until the hero's next turn: blows aimed at them come at the hero instead. */
  | { type: 'protect' };

/** One-shot reaction pulses for the tick being entered. Holding a button does not repeat it. */
export interface BattleInput {
  dodge?: boolean;
  parry?: boolean;
}

export interface BattleHeroSnapshot {
  faction: FactionId;
  hp: number;
  maxHp: number;
  damage: number;
  ap: number;
  maxAp: number;
  tonics: number;
  /** Guard: incoming damage is reduced until the guard's next turn. */
  bulwark: boolean;
  /** Covering the wagons until the hero's next turn. */
  guarding: boolean;
  /** Villain: multiplier for the next damaging action, 1 when none. */
  empowered: number;
  /** Ticks before another dodge or parry press counts. */
  lockout: number;
}

export interface BattleEnemySnapshot {
  id: string;
  kind: EnemyKind;
  hp: number;
  maxHp: number;
  band: Band;
  breakMeter: number;
  breakMax: number;
  /** Broken: loses its next turn and takes extra damage until then. */
  broken: boolean;
  /** Attacks left that carry a rally bonus. */
  rallied: number;
}
export interface BattleAllySnapshot { id: string; kind: AllyKind }
export interface BattleWardSnapshot { id: WardId; hp: number; maxHp: number }

export interface BattleHitSnapshot {
  index: number;
  /** Absolute tick at which the blow lands. */
  impact: number;
  /** Heavy blows cannot be parried, only dodged. */
  heavy: boolean;
  damage: number;
  outcome: HitOutcome;
  reaction: Reaction | null;
  /** Tick of this blow's one bound attempt, after latency compensation; null without one. */
  pressed: number | null;
  /** The hero (who may react) or an uncovered ward (which cannot). */
  target: 'hero' | WardId;
}

export interface BattleActionSnapshot {
  id: number;
  /** `hero`, an enemy ID or an ally ID. */
  actor: string;
  /** `attack`, `counter`, `item`, `protect`, a skill ID, an enemy move ID or an ally's support move. */
  move: string;
  target: string | null;
  start: number;
  end: number;
  /** Enemy blows, the ones a reaction can answer when aimed at the hero. */
  hits: BattleHitSnapshot[];
}

export interface BattleCommandOption {
  command: 'attack' | 'skill' | 'item' | 'protect';
  id: string;
  cost: number;
  /** Valid target IDs for targeted commands; empty for untargeted ones. */
  targets: string[];
  enabled: boolean;
  reason: BattleNotice | null;
}

export type BattleLogKind = 'damage' | 'heal' | 'dodge' | 'parry' | 'counter' | 'break' | 'recover' | 'defeated'
  | 'approach' | 'retreat' | 'rally' | 'skill' | 'item' | 'protect' | 'support' | 'join' | 'ward-down'
  | 'victory' | 'defeat';

export interface BattleLogEntry {
  /** Monotonic; consumers can deduplicate across snapshots. */
  id: number;
  tick: number;
  kind: BattleLogKind;
  actor: string;
  target: string;
  amount: number;
}

export interface BattleSnapshot {
  version: 1;
  difficulty: BattleDifficulty;
  opening: BattleOpening;
  phase: BattlePhase;
  tick: number;
  /** Hero turns taken so far, including the current one. */
  round: number;
  hero: BattleHeroSnapshot;
  enemies: BattleEnemySnapshot[];
  allies: BattleAllySnapshot[];
  wards: BattleWardSnapshot[];
  /** The next actors on the timeline, the current one first. */
  order: string[];
  action: BattleActionSnapshot | null;
  commands: BattleCommandOption[];
  /** The last 32 entries. */
  log: BattleLogEntry[];
  notice: BattleNotice | null;
}

/** A battle's complete, serializable state; change it only through the battle functions. */
export interface BattleState {
  version: 1;
  faction: FactionId;
  difficulty: BattleDifficulty;
  opening: BattleOpening;
  latencyTicks: number;
  /** The battle's own PRNG words (sfc32), so the battle never draws from anything else. */
  rng: number[];
  now: number;
  round: number;
  phase: BattlePhase;
  notice: BattleNotice | null;
  actionSequence: number;
  logSequence: number;
  hero: {
    hp: number; maxHp: number; damage: number; ap: number; tonics: number;
    bulwark: boolean; guarding: boolean; empowered: number; lockoutUntil: number; next: number;
  };
  enemies: {
    id: string; kind: EnemyKind; hp: number; maxHp: number; band: Band;
    breakMeter: number; broken: boolean; rallied: number; next: number;
  }[];
  allies: { id: string; kind: AllyKind; next: number }[];
  wards: { id: WardId; hp: number; maxHp: number }[];
  action: BattleActionState | null;
  log: BattleLogEntry[];
}
export interface BattleActionState {
  id: number;
  actor: string;
  move: string;
  target: string | null;
  start: number;
  end: number;
  hits: (Omit<BattleHitSnapshot, 'pressed'> & { pressed: number | null })[];
  /** Damage landing on enemies at tick `at`: the hero's (`flat` 0, scaled by its damage) or an ally's flat damage. */
  strikes: { at: number; source: string; targets: string[]; multiplier: number; flat: number; breakAdd: number; done: boolean }[];
  /** The villain's rage AP has been granted for this move. */
  raged: boolean;
}

export interface Battle {
  /** Only on the hero's turn. Malformed commands throw; unavailable ones set `notice` and change nothing else. */
  command(command: BattleCommand): void;
  /** Advances one tick while an action plays and returns true; in any other phase it changes nothing and returns false. */
  tick(input?: BattleInput): boolean;
  snapshot(): BattleSnapshot;
  /** The live state (for saving); a deep copy. */
  state(): BattleState;
}
