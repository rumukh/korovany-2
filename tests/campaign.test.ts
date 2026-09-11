import { describe, expect, test } from 'vitest';
import {
  claimRewards, createCampaign, createProfile, findRoadRoute, generateWorld, isWalkable,
  purchaseMetaUpgrade, restoreCampaign, restoreProfile, type FactionId,
} from '../src/game';
import { advance, CampaignDriver, dist } from './driver';

describe('seeded connected campaign world', () => {
  test('deterministic, diverse, and every graph route crosses only walkable bridge geometry', () => {
    for (let seed = 0; seed < 24; seed++) {
      const world = generateWorld(seed);
      expect(generateWorld(seed)).toEqual(world);
      expect(generateWorld(seed + 1).id).not.toBe(world.id);
      expect(world.obstacles.filter(o => o.kind === 'wall')).toHaveLength(20);
      for (const from of world.roads.nodes) for (const to of world.roads.nodes) {
        const route = [from, ...findRoadRoute(world, from, to.id)];
        for (let i = 1; i < route.length; i++) {
          const a = route[i - 1]!, b = route[i]!, steps = Math.max(1, Math.ceil(dist(a, b) * 2));
          for (let j = 0; j <= steps; j++) {
            expect(isWalkable(world, { x: a.x + (b.x - a.x) * j / steps, z: a.z + (b.z - a.z) * j / steps }, 1.5)).toBe(true);
          }
        }
      }
      expect(isWalkable(world, { x: 20, z: 0 })).toBe(false);
      expect(isWalkable(world, { x: 0, z: 0 })).toBe(true);
    }
  });
});

describe('real-input campaign acceptance', () => {
  for (const faction of ['elf', 'guard', 'villain'] as FactionId[]) {
    test(`${faction}: capture, raid, physical supply delivery and fortress victory`, () => {
      const game = createCampaign({ seed: `acceptance-${faction}`, faction, runId: `run-${faction}` });
      const bot = new CampaignDriver(game);
      bot.capture('forest');
      bot.waitConvoy('forest');
      expect(bot.snap().outposts.find(p => p.id === 'forest')?.supplied).toBe(true);
      game.step({ upgrade: 'damage' });
      expect(bot.snap().player.upgrades.damage).toBe(1);
      bot.raid();
      bot.capture('palace');
      expect(bot.snap().fortress.unlocked).toBe(false);
      bot.waitConvoy('palace');
      expect(bot.snap().fortress.unlocked).toBe(true);
      const resumed = restoreCampaign(JSON.parse(JSON.stringify(game.serialize())));
      expect(resumed.snapshot()).toEqual(game.snapshot());
      bot.toNode('fortress');
      bot.fight('fortress');
      const resumedBot = new CampaignDriver(resumed);
      resumedBot.toNode('fortress');
      resumedBot.fight('fortress');
      expect(resumed.serialize()).toEqual(game.serialize());
      const final = bot.snap();
      expect(final.phase).toBe('victory');
      expect(final.convoy.delivered).toBe(60);
      expect(final.rewards?.renown).toBeGreaterThanOrEqual(80);
      expect(final.fortress.bossDefeated).toBe(true);
      expect(final.fortress.reinforcementWaves).toBe(1);
      const frozen = game.serialize();
      advance(game, { attack: true, special: true, move: { x: 1, z: 1 }, convoy: 'follow' }, 240);
      expect(game.serialize()).toEqual(frozen);
      expect(restoreCampaign(frozen).snapshot()).toEqual(final);
      const profile = claimRewards(createProfile(), final.rewards!);
      expect(claimRewards(profile, final.rewards!)).toEqual(profile);
    });
  }
  test('unguarded hero dies, terminal defeat stays frozen', () => {
    const game = createCampaign({ seed: 'defeat', faction: 'elf' });
    const bot = new CampaignDriver(game);
    bot.toNode('forest', false);
    advance(game, {}, 9000);
    expect(game.snapshot().phase).toBe('defeat');
    const save = game.serialize();
    advance(game, { interact: true, special: true }, 300);
    expect(game.serialize()).toEqual(save);
    expect(restoreCampaign(save).snapshot()).toEqual(game.snapshot());
  });
  test('an abandoned convoy can be recovered without supplies or coins', () => {
    const game = createCampaign({ seed: 'repair', faction: 'guard' });
    game.step({ convoy: { destination: 'forest' } });
    advance(game, {}, 9000);
    expect(game.snapshot().convoy.disabled).toBe(true);
    const bot = new CampaignDriver(game);
    bot.capture('forest');
    bot.walk(bot.snap().convoy);
    advance(game, { interact: true }, 120);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(bot.snap());
    advance(game, { interact: true }, 660);
    expect(bot.snap().convoy.hp).toBeGreaterThan(0);
    expect(bot.snap().convoy.disabled).toBe(false);
    bot.waitConvoy('home');
    expect(bot.snap().convoy.destination).toBe('home');
  });
  test('supplying the optional third post prevents all boss reinforcement waves', () => {
    const game = createCampaign({ seed: 'all-posts', faction: 'guard' });
    const bot = new CampaignDriver(game);
    bot.capture('forest'); bot.waitConvoy('forest');
    bot.raid();
    bot.capture('palace'); bot.waitConvoy('palace');
    bot.capture('quarry'); bot.waitConvoy('quarry');
    expect(bot.snap().convoy.delivered).toBe(90);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(bot.snap());
    bot.toNode('fortress'); bot.fight('fortress');
    expect(bot.snap().phase).toBe('victory');
    expect(bot.snap().fortress.reinforcementWaves).toBe(0);
  });
});

describe('persistence and input boundaries', () => {
  for (const id of ['damage', 'vitality', 'logistics'] as const) {
    test(`${id} purchase changes authoritative stats and survives serialization`, () => {
      const game = createCampaign({ seed: `upgrade-${id}`, faction: 'guard' });
      const bot = new CampaignDriver(game);
      bot.capture('forest');
      const before = bot.snap();
      expect(before.shop.find(item => item.id === id)?.available).toBe(true);
      game.step({ upgrade: id });
      const after = bot.snap();
      expect(after.player.coins).toBe(before.player.coins - 35);
      expect(after.player.upgrades[id]).toBe(1);
      if (id === 'damage') expect(after.player.damage).toBe(before.player.damage + 8);
      if (id === 'vitality') expect(after.player.maxHp).toBe(before.player.maxHp + 30);
      if (id === 'logistics') {
        expect(after.convoy.maxHp).toBe(before.convoy.maxHp + 50);
        expect(after.convoy.capacity).toBe(before.convoy.capacity + 30);
      }
      expect(restoreCampaign(game.serialize()).snapshot()).toEqual(after);
    });
  }
  test('capture and fortress gates cannot be bypassed by interaction or invalid route commands', () => {
    const game = createCampaign({ seed: 'gates', faction: 'guard' });
    const bot = new CampaignDriver(game);
    bot.toNode('forest', false);
    advance(game, { interact: true }, 60);
    expect(bot.snap().outposts.find(p => p.id === 'forest')?.captureProgress).toBe(0);
    expect(bot.snap().interaction?.kind).toBe('contested');
    game.step({ convoy: { destination: 'not-a-road-node' }, upgrade: 'damage' });
    expect(bot.snap().convoy.mode).toBe('hold');
    expect(bot.snap().player.upgrades.damage).toBe(0);
    expect(bot.snap().events.some(event => event.key === 'notice.destination')).toBe(true);
    const other = createCampaign({ seed: 'gates', faction: 'elf' });
    const scout = new CampaignDriver(other);
    scout.toNode('fortress');
    advance(other, { attack: true, special: true, aim: { x: 0, z: 1 }, interact: true }, 180);
    expect(scout.snap().actors.find(a => a.id === 'boss')?.hp).toBe(480);
    expect(scout.snap().fortress.unlocked).toBe(false);
    expect(scout.snap().interaction?.kind).toBe('locked');
  });
  test('metadata upgrades initialize all factions and remain capped in the campaign', () => {
    for (const faction of ['elf', 'guard', 'villain'] as FactionId[]) for (let level = 0; level <= 3; level++) {
      const game = createCampaign({ seed: 'meta', faction, upgrades: { damage: level, vitality: level, logistics: level } });
      expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
      if (level === 3) {
        game.step({ upgrade: 'logistics' });
        expect(game.snapshot().player.upgrades.logistics).toBe(3);
        expect(game.snapshot().events.at(-1)?.key).toBe('notice.max');
      }
    }
  });
  test('save/restore retains exact RNG, pending projectiles, AI tells and subsequent inputs', () => {
    const game = createCampaign({ seed: 42, faction: 'elf', upgrades: { damage: 1 } });
    const bot = new CampaignDriver(game);
    bot.toNode('south');
    for (let i = 0; i < 80; i++) game.step({ move: { x: -1, z: 0 }, aim: { x: -1, z: 0 }, attack: true });
    const restored = restoreCampaign(JSON.parse(JSON.stringify(game.serialize())));
    for (let i = 0; i < 180; i++) {
      const input = { attack: i % 2 === 0, aim: { x: -1, z: 0 }, special: i === 12, dodge: i === 60 };
      game.step(input); restored.step(input);
    }
    expect(restored.serialize()).toEqual(game.serialize());
    expect(restored.snapshot()).toEqual(game.snapshot());
  });
  test('snapshots cannot mutate campaign; invalid input is atomic; normalization removes speed cheats', () => {
    const a = createCampaign({ seed: 'input', faction: 'guard' }), b = createCampaign({ seed: 'input', faction: 'guard' });
    const copy = a.snapshot();
    copy.player.hp = 0; copy.world.obstacles.length = 0;
    expect(a.snapshot()).toEqual(b.snapshot());
    const before = a.serialize();
    expect(() => a.step({ move: { x: NaN, z: 1 } })).toThrow();
    expect(a.serialize()).toEqual(before);
    a.step({ move: { x: 10, z: 10 } }); b.step({ move: { x: 1, z: 1 } });
    expect(a.snapshot()).toEqual(b.snapshot());
  });
  test('rejects malformed, oversized, nonfinite, inconsistent and unsupported saves', () => {
    const game = createCampaign({ seed: 12, faction: 'guard' });
    const save = game.serialize();
    expect(restoreCampaign(save).snapshot()).toEqual(game.snapshot());
    expect(() => restoreCampaign({ ...save, version: 99 })).toThrow();
    expect(() => restoreCampaign({ ...save, seed: 'different' })).toThrow();
    const corrupt = (path: string[], value: unknown): void => {
      const broken = JSON.parse(JSON.stringify(save));
      let target = broken;
      for (const key of path.slice(0, -1)) target = target[key];
      target[path[path.length - 1]!] = value;
      expect(() => restoreCampaign(broken), path.join('.')).toThrow();
    };
    corrupt(['engine', 'resources', 'KorovanyCampaign', 'player', 'hp'], Infinity);
    corrupt(['engine', 'resources', 'KorovanyCampaign', 'player', 'maxHp'], 9999);
    corrupt(['engine', 'resources', 'KorovanyCampaign', 'convoy', 'route'], [{ x: 42, z: 26 }]);
    corrupt(['engine', 'resources', 'KorovanyCampaign', 'convoy', 'cargo'], 0);
    corrupt(['engine', 'prng', 's'], [0, 0, -1, 1]);
    corrupt(['engine', 'resources', 'KorovanyCampaign', 'followTimer'], -1);
    corrupt(['engine', 'entities', '0', 'components', 'KorovanyCombatant', 'state'], 'unrecognized');
    corrupt(['engine', 'entities', '0', 'components', 'KorovanyCombatant', 'id'], 'alien');
    corrupt(['engine', 'entities', '0', 'components', 'KorovanyCombatant', 'siteId'], 'fortress');
    corrupt(['engine', 'allocator', 'slots'], Array(10_000).fill(1));
    corrupt(['engine', 'resources', 'KorovanyCampaign', 'outposts', '0', 'supplied'], true);
  });
  test('profile upgrade spending is pure, capped and validated', () => {
    const profile = claimRewards(createProfile(), { runId: 'one', claimed: false, renown: 300, victory: true });
    let next = profile;
    for (let i = 0; i < 3; i++) next = purchaseMetaUpgrade(next, 'damage');
    expect(next.upgrades.damage).toBe(3);
    expect(profile.upgrades.damage).toBe(0);
    expect(next.renown).toBe(120);
    expect(() => purchaseMetaUpgrade(next, 'damage')).toThrow();
    expect(() => purchaseMetaUpgrade(createProfile(), 'vitality')).toThrow();
    expect(restoreProfile(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(() => restoreProfile({ ...next, renown: -1 })).toThrow();
    expect(() => restoreProfile({ ...next, completedRuns: ['same', 'same'] })).toThrow();
  });
});
