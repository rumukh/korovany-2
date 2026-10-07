import { describe, expect, test } from 'vitest';
import { reactionWindow, type BattleSetup } from '../src/game/battle';
import {
  describeBlow, describeLog, SandboxSession, summarize, TICK_MS, TICK_SECONDS, type BlowFeedback,
} from '../src/battle-sandbox/session';

const setup = (extra: Partial<BattleSetup> = {}): BattleSetup =>
  ({ seed: 'sandbox-unit', faction: 'guard', encounter: 'post-garrison', opening: 'first-strike', ...extra });

/** Advances one tick at a time, pressing `parry` (or `dodge` for heavy blows) `lead` ticks before each impact. */
function playWithLead(session: SandboxSession, lead: number, limit = 20_000): BlowFeedback[] {
  const resolved: BlowFeedback[] = [];
  const pressed = new Set<string>();
  for (let i = 0; i < limit && !session.over; i++) {
    const s = session.snapshot;
    if (s.phase === 'command') { resolved.push(...session.advance(TICK_SECONDS)); continue; }
    const action = s.action!;
    for (const hit of action.actor === 'hero' ? [] : action.hits) {
      const key = `${action.id}:${hit.index}`;
      if (hit.outcome === 'pending' && !pressed.has(key) && hit.impact - (s.tick + 1) <= lead) {
        pressed.add(key);
        expect(session.react(hit.heavy ? 'dodge' : 'parry')).toBe(true);
        break;
      }
    }
    resolved.push(...session.advance(TICK_SECONDS));
  }
  return resolved;
}

describe('battle sandbox session', () => {
  test('time runs only while an action plays, at a fixed 60 Hz, with long frames clamped', () => {
    const session = new SandboxSession(setup());
    expect(session.snapshot.phase).toBe('command');
    session.advance(1);
    expect(session.snapshot.tick).toBe(0);
    expect(session.react('parry')).toBe(false);
    expect(session.command({ type: 'attack', target: 'soldier' })).toBeNull();
    session.advance(0.1);
    expect(session.snapshot.tick).toBe(6);
    session.advance(0.05);
    expect(session.snapshot.tick).toBe(9);
    session.advance(5);
    expect(session.snapshot.tick).toBe(15);
    session.paused = true;
    session.advance(0.1);
    expect(session.snapshot.tick).toBe(15);
    expect(session.react('dodge')).toBe(false);
    expect(session.command({ type: 'attack', target: 'nobody' })).toBe('phase');
  });

  test('presses on time defend every blow, and feedback reports the offset against the window', () => {
    const session = new SandboxSession(setup({ opening: 'ambushed' }), true);
    const blows = playWithLead(session, 1);
    expect(session.snapshot.phase).toBe('victory');
    expect(blows.length).toBeGreaterThan(5);
    expect(blows.every(b => b.outcome !== 'hit')).toBe(true);
    const parry = reactionWindow('guard', 'standard', 'parry');
    const parried = blows.find(b => b.outcome === 'parried')!;
    expect(parried.offsetMs).toBeCloseTo(-TICK_MS, 6);
    expect(parried.window).toEqual({ from: -parry.early * TICK_MS, to: parry.late * TICK_MS });
    expect(describeBlow(session.snapshot, parried)).toMatch(/^Parried: .+\. Parry at -17 ms \(window -117 ms to \+33 ms\)\.$/);
    expect(session.feedback).toEqual(blows);
  });

  test('early presses fail with their offset; blows without a press say so', () => {
    const early = new SandboxSession(setup({ opening: 'ambushed' }), true);
    const missed = playWithLead(early, 18, 400).find(b => b.outcome === 'hit')!;
    expect(missed.offsetMs).toBeCloseTo(-18 * TICK_MS, 6);
    expect(describeBlow(early.snapshot, missed)).toMatch(/^Hit for \d+: .+\. (Parry|Dodge) at -300 ms/);
    const idle = new SandboxSession(setup({ opening: 'ambushed' }), true);
    for (let i = 0; i < 400 && idle.feedback.length === 0; i++) idle.advance(TICK_SECONDS);
    expect(idle.feedback[0]).toMatchObject({ outcome: 'hit', reaction: null, offsetMs: null, window: null });
    expect(describeBlow(idle.snapshot, idle.feedback[0]!)).toMatch(/No press in time\.$/);
  });

  test('automatic commands play a whole battle without input', () => {
    const session = new SandboxSession(setup({ faction: 'villain', difficulty: 'story' }), true);
    for (let i = 0; i < 100_000 && !session.over; i++) session.advance(TICK_SECONDS);
    expect(session.over).toBe(true);
    expect(session.snapshot.log.some(entry => describeLog(session.snapshot, entry) !== null)).toBe(true);
  });

  test('the latency suggestion follows the mean distance from window centres', () => {
    const blow = (offsetMs: number): BlowFeedback => ({
      key: String(offsetMs), attacker: 'soldier', move: 'cut', outcome: 'hit', reaction: 'parry', heavy: false, damage: 14,
      offsetMs, window: { from: -100, to: 33 },
    });
    const centre = (-100 + 33) / 2;
    expect(summarize([blow(centre + 50)])).toMatchObject({ blows: 1, hit: 1, latencyChange: null });
    expect(summarize(Array.from({ length: 6 }, () => blow(centre + 50))).latencyChange).toBe(3);
    expect(summarize(Array.from({ length: 6 }, () => blow(centre - 34))).latencyChange).toBe(-2);
    expect(summarize(Array.from({ length: 6 }, () => blow(centre + 5))).latencyChange).toBeNull();
    expect(summarize([]).bias).toBeNull();
  });
});
