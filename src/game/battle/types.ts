/**
 * Headless prototype of turn-based battles with timed defence (design: `README.md` in this folder). It is not wired into
 * `GameSession`, the presenter or saves yet. Time is counted in 60 Hz ticks. On the hero's turn a battle waits for a
 * command and no time passes; while an action plays it advances one tick per `tick()`. A dodge or parry press during an
 * enemy action is bound to the next incoming hit and succeeds only inside that hit's timing window.
 */
import type { FactionId } from '../types';

export type BattleDifficulty = 'story' | 'standard' | 'expert';
/** First strike: the hero acts first. Ambushed: the enemies act first and their melee troops start close. */
export type BattleOpening = 'neutral' | 'first-strike' | 'ambushed';
export type BattlePhase = 'command' | 'action' | 'victory' | 'defeat';
/** Abstract distance from the hero: melee needs `close`; ranged attacks reach both bands. */
export type Band = 'close' | 'far';
export type EnemyKind = 'soldier' | 'archer' | 'captain';
export type EncounterId = 'post-garrison';
export type Reaction = 'dodge' | 'parry';
export type HitOutcome = 'pending' | 'hit' | 'dodged' | 'parried';
export type SkillId = 'aimed-shot' | 'volley' | 'fall-back' | 'shield-bash' | 'bulwark' | 'cleave' | 'warcry';
/** Why a well-formed command changed nothing: wrong phase, invalid target, too few AP, not this hero's skill, no item. */
export type BattleNotice = 'phase' | 'target' | 'ap' | 'unavailable' | 'item';

export interface BattleSetup {
  seed: string | number;
  faction: FactionId;
  encounter: EncounterId;
  difficulty?: BattleDifficulty;
  opening?: BattleOpening;
  /** The player's measured input and display latency in ticks (0-12), subtracted from every reaction press. */
  latencyTicks?: number;
}

export type BattleCommand =
  | { type: 'attack'; target: string }
  | { type: 'skill'; skill: SkillId; target?: string }
  | { type: 'item'; item: 'tonic' };

/** One-shot reaction pulses for the tick being entered. Holding a button does not repeat it. */
export interface BattleInput {
  dodge?: boolean;
  parry?: boolean;
}

export interface BattleHeroSnapshot {
  faction: FactionId;
  hp: number;
  maxHp: number;
  ap: number;
  maxAp: number;
  tonics: number;
  /** Guard: incoming damage is reduced until the guard's next turn. */
  bulwark: boolean;
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
  /** Attacks left that carry the captain's rally bonus. */
  rallied: number;
}

export interface BattleHitSnapshot {
  index: number;
  /** Absolute tick at which the blow lands. */
  impact: number;
  /** Heavy blows cannot be parried, only dodged. */
  heavy: boolean;
  damage: number;
  outcome: HitOutcome;
  reaction: Reaction | null;
}

export interface BattleActionSnapshot {
  id: number;
  /** `hero` or an enemy ID. */
  actor: string;
  /** `attack`, `counter`, `item`, a skill ID, or an enemy move ID. */
  move: string;
  target: string | null;
  start: number;
  end: number;
  /** Enemy blows aimed at the hero, the ones a reaction can answer. */
  hits: BattleHitSnapshot[];
}

export interface BattleCommandOption {
  command: 'attack' | 'skill' | 'item';
  id: string;
  cost: number;
  /** Valid target IDs for targeted commands; empty for untargeted ones. */
  targets: string[];
  enabled: boolean;
  reason: BattleNotice | null;
}

export type BattleLogKind = 'damage' | 'heal' | 'dodge' | 'parry' | 'counter' | 'break' | 'recover' | 'defeated'
  | 'approach' | 'retreat' | 'rally' | 'skill' | 'item' | 'victory' | 'defeat';

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
  encounter: EncounterId;
  difficulty: BattleDifficulty;
  phase: BattlePhase;
  tick: number;
  /** Hero turns taken so far, including the current one. */
  round: number;
  hero: BattleHeroSnapshot;
  enemies: BattleEnemySnapshot[];
  /** The next actors on the timeline, the current one first. */
  order: string[];
  action: BattleActionSnapshot | null;
  commands: BattleCommandOption[];
  /** The last 32 entries. */
  log: BattleLogEntry[];
  notice: BattleNotice | null;
}

export interface Battle {
  /** Only on the hero's turn. Malformed commands throw; unavailable ones set `notice` and change nothing else. */
  command(command: BattleCommand): void;
  /** Advances one tick while an action plays and returns true; in any other phase it changes nothing and returns false. */
  tick(input?: BattleInput): boolean;
  snapshot(): BattleSnapshot;
}
