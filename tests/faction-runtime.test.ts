import { describe, expect, test } from 'vitest';
import {
  claimRewards, createCampaign, createProfile, FACTION_CAMPAIGNS, isWalkable, restoreCampaign,
  type CampaignSave, type FactionId,
} from '../src/game';
import { advance, CampaignDriver, dist } from './driver';
import type { ActorData, CampaignData } from '../src/game/state';
import { FactionStoryDriver } from './faction-driver';
import { getFactionStory } from '../src/game/faction-stories';
import { narrativeSnapshot } from '../src/game/narrative';

const factions: FactionId[] = ['elf', 'guard', 'villain'];
function corrupt(save: CampaignSave, mutate: (state: CampaignData) => void): CampaignSave {
  const copy = structuredClone(save);
  mutate((copy.engine as { resources: { KorovanyCampaign: CampaignData } }).resources.KorovanyCampaign);
  return copy;
}

describe('authoritative faction runtime boundaries', () => {
  for (const faction of factions) {
    test(`${faction} starts safely in its own political home with scoped story and forces`, () => {
      const game = createCampaign({ faction, seed: 'faction-homes' }), snapshot = game.snapshot();
      const definition = FACTION_CAMPAIGNS[faction];
      const home = snapshot.world.sites.find(s => s.id === 'home')!;
      const location = snapshot.world.exploration!.locations.find(l => l.id === definition.homeLocationId)!;
      expect(dist(home, location)).toBe(0);
      expect(dist(snapshot.player, home)).toBeLessThan(4);
      expect(isWalkable(snapshot.world, snapshot.player, snapshot.player.radius)).toBe(true);
      expect(isWalkable(snapshot.world, snapshot.convoy, snapshot.convoy.radius)).toBe(true);
      expect(snapshot.campaign!.identity.id).toBe(faction);
      expect(snapshot.campaign!.standing.find(s => s.id === 'neutral')!.relation).toBe('neutral');
      expect(new Set(snapshot.world.exploration!.regions.map(r => r.politicalFaction))).toEqual(new Set(['elf', 'guard', 'villain', 'neutral']));
      expect(snapshot.narrative!.quests.every(q => q.id.startsWith(`${faction}-`))).toBe(true);
      expect(snapshot.narrative!.npcs.some(n => n.available && n.locationId === definition.homeLocationId)).toBe(true);
      expect(snapshot.actors.filter(a => a.siteId === 'home').every(a => a.allegiance === 'friendly')).toBe(true);
      expect(snapshot.fortress.unlocked).toBe(false);
      expect(restoreCampaign(game.serialize()).snapshot()).toEqual(snapshot);
      const ally = snapshot.actors.find(a => a.siteId === 'home')!;
      advance(game, { aim: { x: ally.x - snapshot.player.x, z: ally.z - snapshot.player.z }, attack: true, special: true }, 180);
      expect(game.snapshot().actors.find(a => a.id === ally.id)!.hp).toBe(ally.hp);
      expect(game.snapshot().player.kills).toBe(0);
      expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
    });
  }

  test('homes and road routes are deterministic, including mountain fort and royal citadel', () => {
    for (const faction of factions) for (const seed of ['route-a', 'route-b', 'route-c']) {
      const a = createCampaign({ faction, seed }), world = a.snapshot().world;
      expect(createCampaign({ faction, seed }).snapshot()).toEqual(a.snapshot());
      for (const edge of world.roads.edges) {
        const start = world.roads.nodes.find(n => n.id === edge.from)!;
        const end = world.roads.nodes.find(n => n.id === edge.to)!;
        const steps = Math.ceil(dist(start, end) / 3);
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          expect(isWalkable(world, { x: start.x + (end.x - start.x) * t, z: start.z + (end.z - start.z) * t }, 1.5),
            `${faction} ${seed} ${edge.from}-${edge.to} ${t}`).toBe(true);
        }
      }
    }
  });

  test('Old Fort has a solid northern gate silhouette without obstructing its home or roads', () => {
    const game = createCampaign({ faction: 'villain', seed: 'old-fort-perimeter' });
    const snapshot = game.snapshot(), world = snapshot.world;
    const home = world.sites.find(s => s.id === 'home')!;
    const perimeter = world.obstacles.filter(o => o.id.startsWith('old-fort-wall-'));
    const towers = perimeter.filter(o => o.id.startsWith('old-fort-wall-tower-'));
    expect(perimeter).toHaveLength(14);
    expect(towers).toHaveLength(2);
    expect(towers.every(o => o.z > home.z && o.height >= 14)).toBe(true);
    expect(world.obstacles.filter(o => o.id.startsWith('old-fort-building-')).every(o => o.radius === 3.4 && o.height >= 10)).toBe(true);
    for (const obstacle of perimeter) {
      expect(isWalkable(world, obstacle)).toBe(false);
      expect(dist(home, obstacle) - obstacle.radius).toBeGreaterThanOrEqual(9);
    }
    expect(snapshot.narrative!.npcs.find(n => n.id === 'ren')!.available).toBe(true);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(snapshot);
  });

  test('schema, faction journals, military ledgers and shipment teleports reject corruption', () => {
    const game = createCampaign({ faction: 'guard', seed: 'guard-validation' }), save = game.serialize();
    expect(() => restoreCampaign(corrupt(save, s => { Object.assign(s.narrative!, { version: 2 }); }))).toThrow(/story version/);
    expect(() => restoreCampaign(corrupt(save, s => { s.narrative!.faction = 'elf'; }))).toThrow(/faction/);
    expect(() => restoreCampaign(corrupt(save, s => { s.narrative!.journal.push('elf-supply-villages'); }))).toThrow();
    expect(() => restoreCampaign(corrupt(save, s => { s.military!.directive = 'shelter'; }))).toThrow();
    expect(() => restoreCampaign(corrupt(save, s => { s.military!.directive = 'relief'; }))).toThrow(/directive/);
    expect(() => restoreCampaign(corrupt(save, s => { s.military!.shipment.delivered = true; s.raidComplete = true; }))).toThrow();
    expect(() => restoreCampaign(corrupt(save, s => { s.outposts[0]!.owner = 'player'; s.outposts[0]!.captureProgress = 1; }))).toThrow();
    expect(() => restoreCampaign(corrupt(save, s => { delete s.military; }))).toThrow();
    const broken = structuredClone(save);
    const engine = broken.engine as { entities: { components: { KorovanyCombatant: { id: string; x: number; allegiance?: string } } }[] };
    const wagon = engine.entities.find(e => e.components.KorovanyCombatant.id === 'enemy-caravan')!.components.KorovanyCombatant;
    wagon.x = 10;
    expect(() => restoreCampaign(broken)).toThrow(/shipment/);
    const before = game.snapshot();
    game.step({ narrative: { type: 'track', questId: 'elf-homeland' } });
    expect(game.snapshot().narrative!.notice).not.toBeNull();
    expect(game.snapshot().narrative!.trackedQuestId).toBe(before.narrative!.trackedQuestId);
  });

  test('guard shipment can be disabled, remains present, and is freely recovered without a directive', () => {
    const game = createCampaign({ faction: 'guard', seed: 'recover-shipment', upgrades: { damage: 3, vitality: 3, logistics: 3 } });
    advance(game, {}, 7200);
    const wreck = game.snapshot().actors.find(a => a.id === 'enemy-caravan')!;
    expect(wreck.hp).toBe(0);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
    const bot = new CampaignDriver(game);
    bot.toNode('raid');
    bot.fight('raid');
    bot.walk(game.snapshot().actors.find(a => a.id === 'enemy-caravan')!);
    advance(game, { interact: true }, 301);
    expect(game.snapshot().actors.find(a => a.id === 'enemy-caravan')!.hp).toBeGreaterThan(0);
    expect(game.snapshot().campaign!.directive).toBeNull();
    expect(game.snapshot().objective.raidComplete).toBe(false);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
  });

  test('legacy world and narrative version are separate; faction military state is absent on v1', () => {
    const game = createCampaign({ faction: 'guard', seed: 'legacy-isolation', worldVersion: 1 });
    expect(game.snapshot().narrative).toBeUndefined();
    expect(game.snapshot().campaign).toBeUndefined();
    expect(game.snapshot().actors.every(a => a.allegiance === undefined)).toBe(true);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
    expect(() => restoreCampaign(corrupt(game.serialize(), s => { Object.assign(s, { military: { version: 1 } }); }))).toThrow(/Legacy/);
  });

  test('faction defeat is terminal and rewards cannot be claimed twice', () => {
    const game = createCampaign({ faction: 'elf', seed: 'faction-terminal', runId: 'faction-terminal-once' });
    const bot = new CampaignDriver(game);
    bot.toNode('forest', false);
    advance(game, {}, 9000);
    const snapshot = game.snapshot();
    expect(snapshot.phase).toBe('defeat');
    expect(snapshot.narrative!.dialogue).toBeNull();
    const frozen = game.serialize();
    game.step({ narrative: { type: 'talk', npcId: 'toman' } });
    advance(game, { attack: true, special: true, interact: true }, 300);
    expect(game.serialize()).toEqual(frozen);
    expect(restoreCampaign(frozen).snapshot()).toEqual(snapshot);
    const profile = claimRewards(createProfile(), snapshot.rewards!);
    expect(claimRewards(profile, snapshot.rewards!)).toEqual(profile);
  });

  test('villain troops obey convoy movements, engage enemies and resume deterministically', async () => {
    const game = createCampaign({ faction: 'villain', seed: 'sovereign-squad', upgrades: { logistics: 3 } });
    const story = new FactionStoryDriver(game);
    await story.directive('dominion');
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
    const home = game.snapshot().world.sites.find(s => s.id === 'home')!;
    game.step({ convoy: { destination: 'quarry' } });
    advance(game, {}, 1200);
    const corruptMarch = structuredClone(game.serialize());
    const marchingActors = (corruptMarch.engine as { entities: { components: { KorovanyCombatant: ActorData } }[] }).entities;
    const marcher = marchingActors.find(e => e.components.KorovanyCombatant.id === 'home-watch-1')!.components.KorovanyCombatant;
    marcher.marchRoute = ['old-fort', 'quarry'].map(id => {
      const at = game.snapshot().world.roads.nodes.find(n => n.id === id)!;
      return { x: at.x, z: at.z };
    });
    expect(() => restoreCampaign(corruptMarch)).toThrow(/Army route/);
    const resumed = restoreCampaign(game.serialize());
    let fired = false;
    for (let i = 0; i < 2600; i++) {
      advance(game, {});
      advance(resumed, {});
      fired ||= game.snapshot().projectiles.some(p => p.owner === 'player' && p.kind === 'bolt');
      if (i % 30 === 0) {
        expect(resumed.serialize()).toEqual(game.serialize());
      }
    }
    const snapshot = game.snapshot();
    expect(snapshot.actors.filter(a => a.siteId === 'home').every(a => dist(a, home) > 100)).toBe(true);
    expect(fired, JSON.stringify({ convoy: snapshot.convoy, actors: snapshot.actors.filter(a => a.siteId === 'home' || a.siteId === 'quarry') })).toBe(true);
    expect(snapshot.player.kills).toBeGreaterThan(0);
    expect(snapshot.actors.filter(a => a.siteId === 'home').every(a => a.allegiance === 'friendly' && a.target === null)).toBe(true);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(snapshot);
  });

  test('ending projection preserves intermediate decisions once and excludes rejected alternatives', () => {
    for (const faction of factions) {
      const game = createCampaign({ faction, seed: 'ending-projection' });
      const story = getFactionStory(faction);
      const state = (game.serialize().engine as { resources: { KorovanyCampaign: CampaignData } }).resources.KorovanyCampaign;
      const main = story.quests.filter(q => q.kind === 'main');
      // This fixture isolates the journal projection; public-input military completion is tested separately.
      state.narrative!.journal = main.flatMap(q => q.stages.map(stage =>
        (stage.actions.find(a => a.ending === 'cinder') ?? stage.actions[0]!).id));
      const ending = narrativeSnapshot(state, game.snapshot().world, []).ending!;
      for (const quest of main) for (const stage of quest.stages.filter(st => st.actions.length > 1 && !st.actions.some(a => a.ending))) {
        const chosen = stage.actions[0]!;
        for (const language of ['en', 'ru'] as const) {
          expect(ending[language].split(chosen.entry[language])).toHaveLength(2);
          for (const rejected of stage.actions.slice(1)) expect(ending[language]).not.toContain(rejected.entry[language]);
        }
      }
    }
  });
});
