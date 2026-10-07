/**
 * The battle sandbox's DOM-free core: it runs a prototype battle in real time and explains each blow. A fixed 60 Hz step
 * runs only while an action plays. Nothing advances on the hero's turn or while paused, as in the planned game
 * integration. Reaction presses are one-shot pulses for the next tick.
 */
import {
  createBattle, reactionWindow, suggestCommand, type Battle, type BattleCommand, type BattleInput, type BattleLogEntry,
  type BattleNotice, type BattleSetup, type BattleSnapshot, type HitOutcome, type Reaction,
} from '../game/battle';
import type { FactionId } from '../game/types';

export const TICK_SECONDS = 1 / 60;
export const TICK_MS = 1000 / 60;
/** Longer frames (a background tab, a debugger pause) are clamped rather than replayed as a burst of ticks. */
const MAX_FRAME_SECONDS = 0.1;

export interface BlowFeedback {
  key: string;
  attacker: string;
  move: string;
  outcome: Exclude<HitOutcome, 'pending'>;
  reaction: Reaction | null;
  heavy: boolean;
  /** Damage of the blow when it lands. */
  damage: number;
  /** The bound press relative to impact in milliseconds, negative when early; null without one. */
  offsetMs: number | null;
  /** The success window of that reaction relative to impact, in milliseconds. */
  window: { from: number; to: number } | null;
}

export class SandboxSession {
  readonly battle: Battle;
  snapshot: BattleSnapshot;
  paused = false;
  readonly feedback: BlowFeedback[] = [];
  private accumulator = 0;
  private pending: BattleInput = {};
  private readonly reported = new Set<string>();

  constructor(readonly setup: BattleSetup, public autoCommands = false) {
    this.battle = createBattle(setup);
    this.snapshot = this.battle.snapshot();
  }

  get over(): boolean {
    return this.snapshot.phase === 'victory' || this.snapshot.phase === 'defeat';
  }

  /** How far the clock is into the next tick while an action plays, for drawing between ticks. */
  get alpha(): number {
    return this.snapshot.phase === 'action' && !this.paused ? this.accumulator / TICK_SECONDS : 0;
  }

  /** Queues a reaction for the next tick; false when no action is playing. */
  react(reaction: Reaction): boolean {
    if (this.paused || this.snapshot.phase !== 'action') return false;
    this.pending = { ...this.pending, [reaction]: true };
    return true;
  }

  command(command: BattleCommand): BattleNotice | null {
    this.battle.command(command);
    this.snapshot = this.battle.snapshot();
    return this.snapshot.notice;
  }

  /** Advances by real elapsed time and returns the blows resolved meanwhile. */
  advance(seconds: number): BlowFeedback[] {
    const resolved: BlowFeedback[] = [];
    if (this.paused || this.over) {
      this.accumulator = 0;
      return resolved;
    }
    if (this.snapshot.phase === 'command') {
      this.accumulator = 0;
      if (!this.autoCommands) return resolved;
      this.command(suggestCommand(this.snapshot));
    }
    this.accumulator += Math.min(Math.max(seconds, 0), MAX_FRAME_SECONDS);
    // The epsilon keeps floating-point residue from dropping a tick when whole ticks of time have passed.
    while (this.accumulator + 1e-9 >= TICK_SECONDS && this.snapshot.phase === 'action') {
      this.accumulator = Math.max(0, this.accumulator - TICK_SECONDS);
      this.battle.tick(this.pending);
      this.pending = {};
      this.snapshot = this.battle.snapshot();
      resolved.push(...this.collect());
    }
    if (this.snapshot.phase !== 'action') this.accumulator = 0;
    return resolved;
  }

  private collect(): BlowFeedback[] {
    const action = this.snapshot.action, found: BlowFeedback[] = [];
    if (!action || action.actor === 'hero') return found;
    for (const hit of action.hits) {
      const key = `${action.id}:${hit.index}`;
      if (hit.outcome === 'pending' || this.reported.has(key)) continue;
      this.reported.add(key);
      const window = hit.reaction ? reactionWindow(this.setup.faction, this.setup.difficulty ?? 'standard', hit.reaction) : null;
      const blow: BlowFeedback = {
        key, attacker: action.actor, move: action.move, outcome: hit.outcome, reaction: hit.reaction, heavy: hit.heavy,
        damage: hit.damage, offsetMs: hit.pressed === null ? null : (hit.pressed - hit.impact) * TICK_MS,
        window: window ? { from: -window.early * TICK_MS, to: window.late * TICK_MS } : null,
      };
      found.push(blow);
      this.feedback.push(blow);
    }
    return found;
  }
}

export interface ReactionSummary {
  blows: number;
  parried: number;
  dodged: number;
  hit: number;
  /** Mean bound press relative to the centre of its window, in ms (positive: late); null without presses. */
  bias: number | null;
  /** Suggested change of the latency setting in ticks once there are enough presses, else null. */
  latencyChange: number | null;
}

export function summarize(feedback: readonly BlowFeedback[]): ReactionSummary {
  const timed = feedback.filter(f => f.offsetMs !== null && f.window !== null);
  const bias = timed.length
    ? timed.reduce((sum, f) => sum + f.offsetMs! - (f.window!.from + f.window!.to) / 2, 0) / timed.length : null;
  const change = bias !== null && timed.length >= 6 ? Math.round(bias / TICK_MS) : 0;
  return {
    blows: feedback.length, parried: feedback.filter(f => f.outcome === 'parried').length,
    dodged: feedback.filter(f => f.outcome === 'dodged').length, hit: feedback.filter(f => f.outcome === 'hit').length,
    bias, latencyChange: change === 0 ? null : change,
  };
}

export const HERO_NAMES: Readonly<Record<FactionId, string>> = { elf: 'Elven ranger', guard: 'Palace guard', villain: 'Mountain ruler' };
const MOVE_NAMES: Readonly<Record<string, string>> = {
  attack: 'Attack', counter: 'Counter', item: 'Tonic', recover: 'Recovers', approach: 'Closes in', 'step-back': 'Steps back',
  rally: 'Rally', 'aimed-shot': 'Aimed shot', volley: 'Volley', 'fall-back': 'Fall back', 'shield-bash': 'Shield bash',
  bulwark: 'Bulwark', cleave: 'Cleave', warcry: 'War cry', cut: 'Cut', 'double-cut': 'Double cut', loose: 'Loose',
  'pinning-shot': 'Pinning shot', 'hammer-combo': 'Hammer combo', overhead: 'Overhead',
};
const NOTICES: Readonly<Record<BattleNotice, string>> = {
  phase: 'Wait for your turn.', target: 'That needs a valid target.', ap: 'Not enough AP.',
  unavailable: 'Not your skill.', item: 'No tonic to use, or HP is already full.',
};

export const moveName = (id: string): string => MOVE_NAMES[id] ?? id.replace(/-/g, ' ');
export const noticeText = (notice: BattleNotice): string => NOTICES[notice];

export function actorName(s: BattleSnapshot, id: string): string {
  if (id === 'hero') return HERO_NAMES[s.hero.faction];
  const enemy = s.enemies.find(e => e.id === id);
  return enemy ? enemy.kind[0]!.toUpperCase() + enemy.kind.slice(1) : id;
}

const ms = (value: number): string => `${value > 0 ? '+' : ''}${Math.round(value)} ms`;

/** One line explaining a resolved blow, including how early or late the press was against its window. */
export function describeBlow(s: BattleSnapshot, f: BlowFeedback): string {
  const source = `${actorName(s, f.attacker)}, ${moveName(f.move)}`;
  const timing = f.offsetMs === null ? 'No press in time' :
    `${f.reaction === 'parry' ? 'Parry' : 'Dodge'} at ${ms(f.offsetMs)} (window ${ms(f.window!.from)} to ${ms(f.window!.to)})`;
  if (f.outcome === 'parried') return `Parried: ${source}. ${timing}.`;
  if (f.outcome === 'dodged') return `Dodged: ${source}. ${timing}.`;
  const why = f.heavy && f.reaction === 'parry' ? 'Heavy blows cannot be parried' : timing;
  return `Hit for ${f.damage}: ${source}${f.heavy ? ' (heavy)' : ''}. ${why}.`;
}

/** Readable text for a log entry, or null for entries the sandbox shows another way. */
export function describeLog(s: BattleSnapshot, entry: BattleLogEntry): string | null {
  const actor = actorName(s, entry.actor), target = actorName(s, entry.target);
  switch (entry.kind) {
    case 'damage': return `${actor} hits ${target} for ${entry.amount}.`;
    case 'heal': return `${actor} recovers ${entry.amount} HP.`;
    case 'dodge': return `${actor} dodges ${target}.`;
    case 'parry': return `${actor} parries ${target}.`;
    case 'counter': return `${actor} counters ${target}!`;
    case 'break': return `${target} is broken and loses its next turn.`;
    case 'recover': return `${actor} recovers from the break.`;
    case 'defeated': return `${target} falls.`;
    case 'approach': return `${actor} closes in.`;
    case 'retreat': return `${actor} steps back.`;
    case 'rally': return `${actor} rallies the garrison: their next two attacks hit harder.`;
    case 'victory': return 'Victory.';
    case 'defeat': return 'Defeat.';
    case 'skill':
    case 'item':
      return null;
  }
}
