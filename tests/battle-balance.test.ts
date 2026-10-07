import { describe, expect, test } from 'vitest';
import type { FactionId } from '../src/game';
import { measure, measureFinale } from './battle-bots';

// Campaign battle balance with the deterministic bots of `battle-bots.ts` (assumed human timing profiles, not
// measurements of players). The post garrison's own targets live in `battle-prototype.test.ts`.
const FACTIONS: FactionId[] = ['elf', 'guard', 'villain'];
const seeds = Number(process.env.KOROVANY_BATTLE_SEEDS ?? 40);

describe('campaign battle balance (deterministic bots)', () => {
  test('beasts: a wolf pack only wears the hero down, ghouls need reactions, a troll is a long fight', () => {
    for (const faction of FACTIONS) {
      const wolves = measure(faction, 'standard', 'none', seeds, 'neutral', 'wolf-pack');
      expect(wolves.winRate, faction).toBeGreaterThanOrEqual(0.9);
      expect(wolves.hpLeft, faction).toBeLessThanOrEqual(0.75);
      expect(measure(faction, 'standard', 'novice', seeds, 'neutral', 'wolf-pack').winRate, faction).toBeGreaterThanOrEqual(0.97);
      expect(measure(faction, 'standard', 'none', seeds, 'neutral', 'ghoul-pack').winRate, faction).toBeLessThanOrEqual(0.2);
      expect(measure(faction, 'standard', 'novice', seeds, 'neutral', 'ghoul-pack').winRate, faction).toBeGreaterThanOrEqual(0.9);
      expect(measure(faction, 'standard', 'novice', seeds, 'neutral', 'troll').winRate, faction).toBeGreaterThanOrEqual(0.9);
      expect(measure(faction, 'standard', 'average', seeds, 'neutral', 'troll').winRate, faction).toBeGreaterThanOrEqual(0.97);
    }
  });

  test('the final battle is the hardest: upgrades and reactions decide it, and story difficulty carries novices', () => {
    for (const faction of FACTIONS) {
      // A typical hero at the fortress: one damage and one vitality purchase, facing the reinforcement wave.
      const typical = measureFinale(faction, 'standard', 'average', seeds, 1);
      expect(typical.winRate, faction).toBeGreaterThanOrEqual(0.75);
      expect(typical.minutes, faction).toBeLessThanOrEqual(6);
      expect(measureFinale(faction, 'standard', 'expert', seeds, 1).winRate, faction).toBeGreaterThanOrEqual(0.97);
      expect(measureFinale(faction, 'standard', 'novice', seeds, 1).winRate, faction).toBeLessThanOrEqual(0.65);
      expect(measureFinale(faction, 'standard', 'novice', seeds, 2).winRate, faction).toBeGreaterThanOrEqual(0.25);
      // Without upgrades, skipping the optional third post (the wave) makes it a real test.
      expect(measureFinale(faction, 'standard', 'average', seeds, 0).winRate, faction).toBeGreaterThanOrEqual(0.25);
      expect(measureFinale(faction, 'story', 'novice', seeds, 0).winRate, faction).toBeGreaterThanOrEqual(0.95);
    }
  });
});
