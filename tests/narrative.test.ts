import { describe, expect, test } from 'vitest';
import { createCampaign, restoreCampaign, type GameSession, type NarrativeInput } from '../src/game';
import { getFactionStory } from '../src/game/faction-stories';
import { FactionStoryDriver, savedResource, yieldRunner } from './faction-driver';
import { advance, dist } from './driver';

function command(game: GameSession, input: NarrativeInput): void { game.step({ narrative: input }); }
const narrative = (game: GameSession) => game.snapshot().narrative!;
const factions = ['elf', 'guard', 'villain'] as const;

describe.each(factions)('%s narrative transactions', faction => {
  const story = getFactionStory(faction);
  const first = story.quests.find(quest => quest.kind === 'main')!;
  const stage = first.stages[0]!;
  const npcId = stage.at;
  const action = stage.actions[0]!;

  test('starts with its own nearby speaker and pauses every overlay transaction exactly', () => {
    const game = createCampaign({ seed: 'dialogue', faction });
    expect(game.serialize().version).toBe(2);
    expect(narrative(game).interaction).toMatchObject({ kind: 'talk', targetId: npcId, enabled: true });
    expect(dist(narrative(game).npcs.find(npc => npc.id === npcId)!, game.snapshot().player)).toBeLessThan(4.25);
    expect(narrative(game).title).toEqual(story.title);
    const finalChapter = narrative(game).quests.find(quest => quest.id === story.quests.filter(q => q.kind === 'main').at(-1)!.id)!;
    expect(finalChapter.targetId).toBe(npcId);
    expect(finalChapter.objective.en).toContain(first.title.en);
    game.step({ attack: true });
    const frozen = game.snapshot();
    command(game, { type: 'talk', npcId });
    command(game, { type: 'choose', npcId, choiceId: 'topic-local' });
    command(game, { type: 'track', questId: first.id });
    expect(game.snapshot().tick).toBe(frozen.tick);
    expect(game.snapshot().actors).toEqual(frozen.actors);
    expect(game.snapshot().player).toEqual(frozen.player);
    expect(game.snapshot().convoy).toEqual(frozen.convoy);
    const resumed = restoreCampaign(JSON.parse(JSON.stringify(game.serialize())));
    expect(resumed.snapshot()).toEqual(game.snapshot());
    for (const session of [game, resumed]) {
      session.step({ attack: true, move: { x: 1, z: 1 }, special: true, convoy: 'follow' });
      expect(session.snapshot().tick).toBe(frozen.tick);
      expect(narrative(session).notice?.en).toContain('paused the game');
      command(session, { type: 'choose', npcId, choiceId: `quest-${first.id}` });
      command(session, { type: 'choose', npcId, choiceId: action.id });
      expect(narrative(session).quests.find(quest => quest.id === first.id)?.status).toBe('active');
      command(session, { type: 'close' });
      expect(narrative(session).dialogue).toBeNull();
      expect(restoreCampaign(session.serialize()).snapshot().narrative!.dialogue).toBeNull();
      session.step();
      expect(session.snapshot().tick).toBe(frozen.tick + 1);
    }
    expect(game.serialize()).toEqual(resumed.serialize());
  });

  test('rejects malformed commands atomically and reports stale, remote and out-of-faction input', () => {
    const game = createCampaign({ seed: 'invalid-narrative', faction });
    for (const input of [
      { narrative: { type: 'choose', npcId, choiceId: '' } },
      { narrative: { type: 'talk', npcId, extra: true } },
      { narrative: { type: 'unknown' } },
      { narrative: { type: 'close' }, move: { x: 1, z: 0 } },
      { narrative: { type: 'track', questId: undefined } },
    ]) {
      const before = game.serialize();
      expect(() => game.step(input as never)).toThrow();
      expect(game.serialize()).toEqual(before);
    }
    command(game, { type: 'choose', npcId, choiceId: action.id });
    expect(narrative(game).notice?.en).toContain('no longer available');
    command(game, { type: 'talk', npcId: 'elin' });
    expect(narrative(game).notice?.en).toContain('closer');
    command(game, { type: 'inspect', locationId: 'last-archive' });
    expect(narrative(game).notice?.ru).toContain('ближе');
    command(game, { type: 'track', questId: 'not-a-quest' });
    expect(narrative(game).notice?.en).toContain('not available');
    expect(narrative(game).quests.every(quest => quest.status === 'available')).toBe(true);
    expect(game.snapshot().tick).toBe(0);
  });

  test('local topics cannot execute hidden answers and distinguish spoken response from journal evidence', () => {
    const game = createCampaign({ seed: 'topic-boundary', faction });
    command(game, { type: 'talk', npcId });
    command(game, { type: 'choose', npcId, choiceId: 'topic-local' });
    const before = narrative(game);
    expect(before.dialogue!.choices.some(choice => choice.id === action.id)).toBe(false);
    expect(before.dialogue!.choices.some(choice => choice.id === `quest-${first.id}`)).toBe(true);
    const foreign = getFactionStory(faction === 'guard' ? 'elf' : 'guard').quests.find(quest => quest.kind === 'main')!.stages[0]!.actions[0]!;
    for (const choiceId of [action.id, foreign.id]) {
      command(game, { type: 'choose', npcId, choiceId });
      expect(narrative(game).notice?.en).toContain('no longer available');
      expect(narrative(game).facts).toEqual(before.facts);
      expect(narrative(game).dialogue?.npcId).toBe(npcId);
    }
    command(game, { type: 'choose', npcId, choiceId: `quest-${first.id}` });
    expect(narrative(game).dialogue!.text.ru).toBe(stage.prompt.ru);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
    command(game, { type: 'choose', npcId, choiceId: action.id });
    expect(narrative(game).dialogue!.text.ru).toBe(action.response.ru);
    expect(narrative(game).facts.at(-1)!.ru).toBe(action.entry.ru);
    expect(action.response.ru).not.toBe(action.entry.ru);
  });

  test('rejects incompatible versions, duplicate rewards, ordering bypasses and inconsistent paused scenes', () => {
    const game = createCampaign({ seed: 'corrupt-story', faction });
    command(game, { type: 'talk', npcId });
    command(game, { type: 'choose', npcId, choiceId: action.id });
    for (const edit of [
      (n: Record<string, unknown>) => { n.version = 2; },
      (n: Record<string, unknown>) => { n.extra = true; },
      (n: Record<string, unknown>) => { n.journal = [action.id, action.id]; },
      (n: Record<string, unknown>) => { n.journal = [first.stages[1]!.actions[0]!.id]; },
      (n: Record<string, unknown>) => { n.journal = [action.id, first.stages[1]!.actions[0]!.id]; },
      (n: Record<string, unknown>) => { n.discovered = ['roadward', 'roadward']; },
      (n: Record<string, unknown>) => { n.discovered = ['made-up-place']; },
      (n: Record<string, unknown>) => { n.trackedQuestId = 'made-up-quest'; },
      (n: Record<string, unknown>) => { n.notice = 'invented'; },
      (n: Record<string, unknown>) => { n.rewardedQuestIds = [first.id]; },
      (n: Record<string, unknown>) => { n.dialogue = { npcId: 'elin', topicId: null }; },
      (n: Record<string, unknown>) => { n.dialogue = { npcId, topicId: `quest-${story.quests[1]!.id}` }; },
      (n: Record<string, unknown>) => { n.inspection = { locationId: 'old-orchard', actionIds: [] }; },
    ]) {
      const save = game.serialize();
      edit(savedResource(save).narrative as Record<string, unknown>);
      const original = structuredClone(save);
      expect(() => restoreCampaign(save)).toThrow();
      expect(save).toEqual(original);
    }
    const missing = game.serialize();
    delete savedResource(missing).narrative;
    expect(() => restoreCampaign(missing)).toThrow();
    const intent = game.serialize();
    (intent.engine as { resources: Record<string, unknown> }).resources.KorovanyIntent = { attack: true };
    expect(() => restoreCampaign(intent)).toThrow(/intent/);
    expect(() => restoreCampaign({ ...game.serialize(), version: 1 })).toThrow();
    expect(restoreCampaign(game.serialize()).serialize()).toEqual(game.serialize());
  });
});

describe('readable evidence and persistent local choices', () => {
  test('inspection is paused and saved; repeated or out-of-order examination grants nothing', () => {
    const game = createCampaign({ seed: 'reading-evidence', faction: 'guard' });
    const bot = new FactionStoryDriver(game);
    const quest = bot.story.quests.find(q => q.kind === 'main')!;
    const evidence = quest.stages.find(stage => stage.kind === 'inspect')!;
    for (const stage of quest.stages) {
      if (stage === evidence) break;
      bot.stage(stage);
    }
    bot.visit(evidence.at);
    const before = game.snapshot();
    command(game, { type: 'inspect', locationId: evidence.at });
    const examined = game.snapshot();
    expect(examined.narrative!.inspection!.text).toEqual(evidence.prompt);
    expect(examined.tick).toBe(before.tick);
    expect(examined.actors).toEqual(before.actors);
    expect(examined.player).toEqual(before.player);
    expect(examined.convoy).toEqual(before.convoy);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(examined);
    game.step({ attack: true, move: { x: 1, z: 0 }, convoy: 'follow' });
    expect(game.snapshot().tick).toBe(examined.tick);
    expect(narrative(game).inspection).toEqual(examined.narrative!.inspection);
    for (const inspection of [
      { locationId: 'name-well', actionIds: [evidence.actions[0]!.id] },
      { locationId: evidence.at, actionIds: [quest.stages[0]!.actions[0]!.id] },
      { locationId: evidence.at, actionIds: [evidence.actions[0]!.id, evidence.actions[0]!.id] },
      { locationId: evidence.at, actionIds: ['elf-names-stones'] },
    ]) {
      const save = game.serialize();
      (savedResource(save).narrative as Record<string, unknown>).inspection = inspection;
      expect(() => restoreCampaign(save)).toThrow();
    }
    const facts = narrative(game).facts;
    bot.close();
    command(game, { type: 'inspect', locationId: evidence.at });
    expect(narrative(game).facts).toEqual(facts);
    expect(narrative(game).inspection!.text).toEqual(examined.world.exploration!.locations.find(location => location.id === evidence.at)!.description);
    bot.inspect('last-archive');
    expect(narrative(game).facts).toEqual(facts);
  }, 120_000);

  test('all shared side branches remain playable, reward once and remember earlier decisions', async () => {
    const game = createCampaign({ seed: 'local-story-acceptance', faction: 'guard' });
    const bot = new FactionStoryDriver(game);
    let remembered = 0;
    for (const quest of bot.story.quests.filter(q => q.kind === 'side')) {
      for (const stage of quest.stages) {
        if (stage.kind === 'inspect') bot.inspect(stage.at);
        else {
          bot.talk(stage.at); bot.topic(quest.id);
          const journal = (savedResource(game.serialize()).narrative as { journal: string[] }).journal;
          const variant = [...journal].reverse().flatMap(id => stage.variants?.filter(v => v.after === id) ?? [])[0];
          if (variant) {
            expect(narrative(game).dialogue!.text.ru).toContain(variant.prompt.ru);
            remembered++;
          }
          if (stage === quest.stages.at(-1)) {
            const fork = game.serialize(), baseline = game.snapshot().player.coins;
            const outcomes = new Set<string>(), reputations = new Set<string>();
            for (const action of stage.actions) {
              const branch = restoreCampaign(fork);
              command(branch, { type: 'choose', npcId: stage.at, choiceId: action.id });
              const completed = narrative(branch).quests.find(q => q.id === quest.id)!;
              expect(completed.status).toBe('completed');
              expect(branch.snapshot().player.coins).toBe(baseline + quest.reward);
              outcomes.add(completed.outcome!.en);
              reputations.add(JSON.stringify(narrative(branch).reputation));
              for (const repeat of stage.actions) command(branch, { type: 'choose', npcId: stage.at, choiceId: repeat.id });
              expect(branch.snapshot().player.coins).toBe(baseline + quest.reward);
              expect(narrative(branch).notice?.en).toContain('no longer available');
              expect(restoreCampaign(branch.serialize()).snapshot()).toEqual(branch.snapshot());
              const corrupt = branch.serialize();
              (savedResource(corrupt).narrative as { rewardedQuestIds: string[] }).rewardedQuestIds.pop();
              expect(() => restoreCampaign(corrupt)).toThrow(/reward/);
            }
            expect(outcomes.size).toBe(stage.actions.length);
            expect(reputations.size).toBe(stage.actions.length);
          }
          bot.choose(stage.actions[0]!.id);
        }
        expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
        await yieldRunner();
      }
      expect(narrative(game).quests.find(q => q.id === quest.id)?.status).toBe('completed');
      bot.close();
    }
    expect(remembered).toBeGreaterThanOrEqual(3);
  }, 240_000);
});

describe('version and travel boundaries', () => {
  test('legacy runs retain their original world and no story', () => {
    const game = createCampaign({ seed: 'legacy-story', faction: 'guard', worldVersion: 1 });
    expect(game.snapshot().narrative).toBeUndefined();
    expect(game.serialize().version).toBe(1);
    expect(game.snapshot().world.id).toMatch(/^k2-v1-/);
    const saved = game.serialize();
    expect(() => command(game, { type: 'talk', npcId: 'mara' })).toThrow(/legacy/);
    expect(game.serialize()).toEqual(saved);
    expect(restoreCampaign(saved).snapshot()).toEqual(game.snapshot());
  });

  test('fast travel requires discovered stops and an intact accompanying convoy without moving other actors', () => {
    const game = createCampaign({ seed: 'travel-story', faction: 'guard' });
    const bot = new FactionStoryDriver(game);
    const start = game.snapshot();
    command(game, { type: 'travel', locationId: 'greenhollow' });
    expect(narrative(game).notice?.en).toContain('Discover');
    expect(game.snapshot().player).toEqual(start.player);
    command(game, { type: 'travel', locationId: 'crownbridge' });
    expect(narrative(game).notice?.en).toContain('arrived');
    expect(game.snapshot().tick).toBe(start.tick);
    bot.visit('high-pass');
    const away = game.snapshot();
    expect(narrative(game).travel.available).toBe(false);
    command(game, { type: 'travel', locationId: 'crownbridge' });
    expect(narrative(game).notice?.en).toContain('Bring the convoy');
    expect(game.snapshot().convoy).toEqual(away.convoy);
    bot.waitConvoy('high-pass');
    advance(game, { interact: true }, 480);
    expect(narrative(game).travel.available).toBe(true);
    const before = game.snapshot();
    command(game, { type: 'travel', locationId: 'crownbridge' });
    const after = game.snapshot();
    expect(after.tick).toBe(before.tick);
    expect(after.actors).toEqual(before.actors);
    expect(after.convoy.mode).toBe('hold');
    expect(after.convoy.route).toEqual([]);
    expect(after.convoy.cargo).toBe(before.convoy.cargo);
    expect(dist(after.player, after.convoy)).toBe(3);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(after);
    bot.visit('tax-vault');
    command(game, { type: 'travel', locationId: 'tax-vault' });
    expect(narrative(game).notice?.en).toContain('Discover');
    command(game, { type: 'travel', locationId: 'high-pass' });
    expect(narrative(game).notice?.en).toContain('road stop');
  }, 120_000);
});
