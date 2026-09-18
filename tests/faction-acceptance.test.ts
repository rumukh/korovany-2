import { describe, expect, test } from 'vitest';
import {
  createCampaign, restoreCampaign, type CampaignSave, type FactionDirective, type FactionId, type GameSnapshot,
} from '../src/game';
import { getFactionStory } from '../src/game/faction-stories';
import { FactionStoryDriver, savedResource, yieldRunner } from './faction-driver';
import { advance, dist } from './driver';

const cases: { faction: FactionId; directive: FactionDirective; seed: string | number; posts: string[] }[] = [
  { faction: 'elf', directive: 'shelter', seed: 0, posts: ['forest'] },
  { faction: 'elf', directive: 'interdict', seed: 42, posts: ['forest', 'palace'] },
  { faction: 'guard', directive: 'relief', seed: 1, posts: ['palace'] },
  { faction: 'guard', directive: 'pursuit', seed: 'bridge-corners', posts: ['palace', 'quarry'] },
  { faction: 'villain', directive: 'dominion', seed: 'northern-roads', posts: ['palace', 'quarry'] },
  { faction: 'villain', directive: 'plunder', seed: 'wet-season', posts: ['palace'] },
];

function shipmentState(save: CampaignSave) {
  return (savedResource(save).military as {
    directive: FactionDirective | null;
    shipment: { claimed: boolean; delivered: boolean; destination: string | null; route: { x: number; z: number }[] };
  });
}

function assertTerminal(save: CampaignSave, endingId: string): void {
  const game = restoreCampaign(save);
  const story = getFactionStory(game.snapshot().faction);
  const stage = story.quests.flatMap(quest => quest.stages).find(entry => entry.actions.some(action => action.ending))!;
  const action = stage.actions.find(entry => entry.id === endingId)!;
  const before = game.snapshot();
  game.step({ narrative: { type: 'choose', npcId: stage.at, choiceId: endingId } });
  const after = game.snapshot();
  expect(after.phase).toBe('victory');
  expect(after.tick).toBe(before.tick);
  expect(after.rewards?.victory).toBe(true);
  expect(after.narrative!.dialogue).toBeNull();
  expect(after.narrative!.ending!.en).toContain(story.endings[action.ending!].en);
  expect(after.narrative!.ending!.en).toContain(story.epilogues[action.ending!].en);
  const finaleQuest = story.quests.find(quest => quest.stages.includes(stage))!;
  expect(after.player.coins).toBe(before.player.coins + finaleQuest.reward);
  const journal = new Set((savedResource(save).narrative as { journal: string[] }).journal);
  for (const quest of story.quests.filter(quest => quest.kind === 'main')) {
    for (const branch of quest.stages.filter(entry => entry.actions.length > 1)) {
      for (const decision of branch.actions.filter(entry => !entry.ending)) {
        for (const language of ['en', 'ru'] as const) {
          const occurrences = after.narrative!.ending![language].split(decision.entry[language]).length - 1;
          expect(occurrences, `${decision.id}/${language}: chosen decisions appear once, rejected alternatives never appear`)
            .toBe(journal.has(decision.id) ? 1 : 0);
        }
      }
    }
  }
  if (after.faction === 'villain') expect(after.narrative!.ending!.en).not.toMatch(/Raut (?:is |was )?defeated|defeated Raut/i);
  const frozen = game.serialize();
  for (const choice of stage.actions) game.step({ narrative: { type: 'choose', npcId: stage.at, choiceId: choice.id } });
  game.step({ narrative: { type: 'travel', locationId: 'roadward' } });
  game.step({ move: { x: 1, z: 0 }, attack: true, special: true, convoy: 'follow' });
  expect(game.serialize()).toEqual(frozen);
  expect(restoreCampaign(JSON.parse(JSON.stringify(frozen))).snapshot()).toEqual(after);
}

describe('substantive faction campaign acceptance through public inputs', () => {
  test('three roles occupy distinct real homes with independent humans and authoritative reachable military targets', () => {
    const homes = new Set<string>(), positions = new Set<string>(), roles = new Set<string>(), starts = new Set<string>();
    for (const faction of ['elf', 'guard', 'villain'] as const) {
      const snapshot = createCampaign({ faction, seed: 'distinct-campaigns' }).snapshot();
      const campaign = snapshot.campaign!;
      const home = snapshot.world.sites.find(site => site.id === 'home')!;
      const location = snapshot.world.exploration!.locations.find(place => place.id === campaign.identity.homeLocationId)!;
      expect(home).toMatchObject({ x: location.x, z: location.z, faction, allegiance: 'friendly' });
      expect(dist(snapshot.player, home)).toBeLessThan(4);
      expect(dist(snapshot.convoy, home)).toBe(0);
      expect(snapshot.narrative!.discovered).toContain(location.id);
      expect(campaign.standing.find(standing => standing.id === 'neutral')?.relation).toBe('neutral');
      expect(campaign.standing.find(standing => standing.id === faction)?.relation).toBe('friendly');
      const target = campaign.requirements.find(requirement => !requirement.complete)!.targetId;
      expect(snapshot.narrative!.npcs.some(npc => npc.id === target)).toBe(true);
      homes.add(location.id);
      positions.add(`${home.x},${home.z}`);
      roles.add(campaign.identity.role.en);
      starts.add(snapshot.narrative!.quests[0]!.id);
    }
    expect(homes).toEqual(new Set(['greenhollow', 'crownbridge', 'old-fort']));
    expect(positions.size).toBe(3);
    expect(roles.size).toBe(3);
    expect(starts.size).toBe(3);
  });

  test.each(cases)('$faction/$directive seed=$seed: real defense, capture, road escort, supplies, boss and authored resolution', async ({ faction, directive, seed, posts }) => {
    const game = createCampaign({ seed, faction, runId: `faction-acceptance-${faction}-${directive}` });
    const bot = new FactionStoryDriver(game);
    const initial = game.snapshot();
    await bot.directive(directive);
    expect(game.snapshot().campaign!.requirements.filter(requirement => requirement.id.startsWith('post-')).map(requirement => requirement.targetId)).toEqual(posts);
    expect(shipmentState(game.serialize()).shipment).toMatchObject({ claimed: false, delivered: false, destination: null, route: [] });
    expect(game.snapshot().objective.raidComplete).toBe(false);
    expect(game.snapshot().outposts.map(post => [post.id, post.owner, post.supplied]))
      .toEqual(initial.outposts.map(post => [post.id, post.owner, post.supplied]));
    const committed = game.serialize();
    const originalJournal = (savedResource(committed).narrative as { journal: string[] }).journal;
    const chosenAction = bot.story.quests.flatMap(quest => quest.stages).flatMap(stage => stage.actions).find(action => action.directive === directive)!;
    const alternative = bot.story.quests.flatMap(quest => quest.stages).flatMap(stage => stage.actions).find(action => action.directive && action.directive !== directive)!;
    const foreign = getFactionStory(faction === 'guard' ? 'elf' : 'guard').quests.flatMap(quest => quest.stages)
      .flatMap(stage => stage.actions).find(action => action.directive)!;
    for (const action of [alternative, foreign]) {
      const before = game.snapshot();
      game.step({ narrative: { type: 'choose', npcId: 'toman', choiceId: action.id } });
      expect(game.snapshot().campaign!.directive).toBe(directive);
      expect(game.snapshot().player).toEqual(before.player);
      expect(game.snapshot().narrative!.notice).not.toBeNull();
      const corrupt = structuredClone(committed);
      (savedResource(corrupt).narrative as { journal: string[] }).journal = originalJournal.map(id => id === chosenAction.id ? action.id : id);
      expect(() => restoreCampaign(corrupt)).toThrow();
    }
    let initialDisabledShipment: CampaignSave | undefined;
    if (directive === 'pursuit') {
      bot.close();
      bot.toNode('raid'); bot.fight('raid');
      if (game.snapshot().actors.find(actor => actor.id === 'enemy-caravan')!.hp === 0) initialDisabledShipment = game.serialize();
      expect(game.snapshot().outposts.find(post => post.id === 'palace')!.defendersRemaining).toBeGreaterThan(0);
      bot.walk(game.snapshot().actors.find(actor => actor.id === 'enemy-caravan')!, 2);
      advance(game, { interact: true }, 660);
      const repaired = game.snapshot().actors.find(actor => actor.id === 'enemy-caravan')!;
      expect(repaired.hp).toBe(repaired.maxHp);
      expect(shipmentState(game.serialize()).shipment.claimed).toBe(false);
      advance(game, { interact: true }, 180);
      expect(game.snapshot().actors.find(actor => actor.id === 'enemy-caravan')).toMatchObject({ x: repaired.x, z: repaired.z });
      expect(shipmentState(game.serialize()).shipment).toMatchObject({ claimed: false, delivered: false, route: [] });
      bot.toNode('quarry'); bot.fight('quarry'); bot.toNode('quarry');
      advance(game, { interact: true }, 190);
      expect(game.snapshot().outposts.find(post => post.id === 'quarry')).toMatchObject({
        owner: 'enemy', captureProgress: 0, defendersRemaining: 0,
      });
      expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
      bot.toNode('home');
      advance(game, { interact: true }, 480);
    }
    const finale = await bot.finale();
    const beforeWar = game.snapshot();
    for (const action of finale.actions) {
      expect(beforeWar.narrative!.dialogue!.choices.find(choice => choice.id === action.id)?.enabled).toBe(false);
      game.step({ narrative: { type: 'choose', npcId: finale.at, choiceId: action.id } });
      expect(game.snapshot().narrative!.ending).toBeNull();
      expect(game.snapshot().player.coins).toBe(beforeWar.player.coins);
      expect(game.snapshot().narrative!.notice).not.toBeNull();
    }
    bot.close();
    bot.toNode('home');
    advance(game, { interact: true }, 480);
    let midShipment: CampaignSave | undefined;
    let disabledShipment: CampaignSave | undefined = initialDisabledShipment;
    const observed = new Set<string>();
    const checkpoint = (snapshot: GameSnapshot): void => {
      const save = game.serialize(), military = shipmentState(save);
      expect(restoreCampaign(save).snapshot()).toEqual(snapshot);
      if (snapshot.actors.find(actor => actor.id === 'enemy-caravan')?.hp === 0) disabledShipment ??= save;
      const target = snapshot.campaign!.requirements.find(requirement => !requirement.complete)?.targetId;
      if (target) {
        expect(snapshot.actors.some(actor => actor.id === target) || snapshot.world.sites.some(site => site.id === target) ||
          snapshot.world.exploration!.locations.some(location => location.id === target) ||
          snapshot.narrative!.npcs.some(npc => npc.id === target), `Missing military marker ${target}`).toBe(true);
      }
      if (military.shipment.claimed && !military.shipment.delivered && military.shipment.route.length) {
        midShipment ??= save;
        observed.add(JSON.stringify(snapshot.actors.find(actor => actor.id === 'enemy-caravan') && {
          x: snapshot.actors.find(actor => actor.id === 'enemy-caravan')!.x,
          z: snapshot.actors.find(actor => actor.id === 'enemy-caravan')!.z,
        }));
      }
    };
    bot.military(checkpoint);
    expect(midShipment, `No physical shipment checkpoint for ${faction}/${directive}/${seed}`).toBeDefined();
    if (faction === 'guard') {
      expect(disabledShipment, 'Unattended Crown shipment should require real recovery after the investigation').toBeDefined();
      const disabled = restoreCampaign(disabledShipment!);
      advance(disabled, {}, 601);
      expect(disabled.snapshot().actors.find(actor => actor.id === 'enemy-caravan')).toMatchObject({ hp: 0 });
      expect(restoreCampaign(disabled.serialize()).snapshot()).toEqual(disabled.snapshot());
    }
    expect(observed.size).toBeGreaterThan(2);
    const restored = restoreCampaign(midShipment!);
    const replay = restoreCampaign(JSON.parse(JSON.stringify(midShipment)));
    for (let tick = 0; tick < 180; tick++) for (const session of [restored, replay]) session.step({ interact: true });
    expect(restored.serialize()).toEqual(replay.serialize());
    expect(game.snapshot().phase).toBe('playing');
    expect(game.snapshot().rewards).toBeNull();
    expect(game.snapshot().actors.find(actor => actor.id === 'enemy-caravan')!.hp).toBeGreaterThan(0);
    expect(shipmentState(game.serialize()).shipment.delivered).toBe(true);
    expect(game.snapshot().fortress.bossDefeated).toBe(true);
    expect(game.snapshot().campaign!.requirements.every(requirement => requirement.complete)).toBe(true);
    await yieldRunner();
    await bot.finale();
    const noAllies = game.serialize();
    const enabled = game.snapshot().narrative!.dialogue!.choices.filter(choice => finale.actions.some(action => action.id === choice.id) && choice.enabled);
    expect(enabled.length, 'Optional local allies must not deadlock the campaign').toBeGreaterThan(0);
    assertTerminal(noAllies, enabled[0]!.id);

    // Every faction's first directive proves all three resolutions, including actual declined ally outcomes.
    if (['shelter', 'relief', 'dominion'].includes(directive)) {
      const requiredAllies = [...new Set(finale.actions.flatMap(action => action.requiresActions ?? []))];
      expect(requiredAllies.length).toBeGreaterThan(0);
      const refused = restoreCampaign(noAllies), refusalBot = new FactionStoryDriver(refused);
      const allyQuest = bot.story.quests.find(quest => quest.stages.some(stage => stage.actions.some(action => action.id === requiredAllies[0])))!;
      const refusal = allyQuest.stages.flatMap(stage => stage.actions).find(action =>
        !requiredAllies.includes(action.id) && allyQuest.stages.at(-1)!.actions.includes(action))!;
      await refusalBot.quest(allyQuest, refusal.id);
      await refusalBot.finale();
      const refusalChoices = refused.snapshot().narrative!.dialogue!.choices.filter(choice => finale.actions.some(action => action.id === choice.id));
      expect(refusalChoices.some(choice => !choice.enabled && choice.reason)).toBe(true);
      const escape = refusalChoices.find(choice => choice.enabled)!;
      expect(escape).toBeDefined();
      assertTerminal(refused.serialize(), escape.id);
      for (const actionId of requiredAllies) {
        const quest = bot.story.quests.find(entry => entry.stages.some(stage => stage.actions.some(action => action.id === actionId)))!;
        await bot.quest(quest, actionId);
      }
      await bot.finale();
      const allReady = game.serialize();
      for (const action of finale.actions) {
        expect(game.snapshot().narrative!.dialogue!.choices.find(choice => choice.id === action.id)?.enabled).toBe(true);
        assertTerminal(allReady, action.id);
      }
    }
  }, 300_000);
});
