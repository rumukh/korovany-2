import { beforeAll, describe, expect, test } from 'vitest';
import { createCampaign, restoreCampaign, type CampaignSave, type GameSession, type NarrativeInput } from '../src/game';
import { ENDINGS, ENDING_EPILOGUES, NPCS, QUESTS } from '../src/game/narrative-data';
import { advance, CampaignDriver, dist } from './driver';

function command(game: GameSession, input: NarrativeInput): void { game.step({ narrative: input }); }
function narrative(game: GameSession) { return game.snapshot().narrative!; }
const yieldRunner = () => new Promise<void>(resolve => setImmediate(resolve));
function resource(save: CampaignSave): Record<string, unknown> {
  // Corruption tests intentionally manipulate untrusted wire values, never active sessions.
  const engine = save.engine as { resources: { KorovanyCampaign: Record<string, unknown> } };
  return engine.resources.KorovanyCampaign;
}
class StoryDriver extends CampaignDriver {
  close(): void { command(this.game, { type: 'close' }); }
  visit(id: string): void {
    this.close();
    this.toNode(id);
    expect(narrative(this.game).discovered).toContain(id);
  }
  talk(id: string): void {
    const npc = NPCS.find(n => n.id === id)!;
    this.visit(npc.locationId);
    command(this.game, { type: 'talk', npcId: id });
    expect(narrative(this.game).dialogue?.npcId).toBe(id);
  }
  choose(id: string): void {
    const quest = QUESTS.find(q => q.stages.some(stage => stage.actions.some(action => action.id === id)));
    if (quest && !narrative(this.game).dialogue!.choices.some(c => c.id === id)) this.topic(quest.id);
    const dialogue = narrative(this.game).dialogue!;
    expect(dialogue.choices.find(c => c.id === id)?.enabled, `${dialogue.npcId}: ${id}`).toBe(true);
    command(this.game, { type: 'choose', npcId: dialogue.npcId, choiceId: id });
    expect(narrative(this.game).notice).toBeNull();
  }
  topic(id: string): void {
    const dialogue = narrative(this.game).dialogue!;
    const topic = `quest-${id}`;
    if (dialogue.choices.some(choice => choice.id === topic)) {
      command(this.game, { type: 'choose', npcId: dialogue.npcId, choiceId: topic });
    }
  }
  inspect(id: string): void {
    this.visit(id);
    command(this.game, { type: 'inspect', locationId: id });
    expect(narrative(this.game).notice?.en).toContain('Place examined');
    expect(narrative(this.game).inspection?.locationId).toBe(id);
  }
  quest(id: string, branch = 0): void {
    const quest = QUESTS.find(q => q.id === id)!;
    for (const stage of quest.stages) {
      if (stage.kind === 'inspect') this.inspect(stage.at);
      else {
        this.talk(stage.at);
        this.choose(stage.actions[Math.min(branch, stage.actions.length - 1)]!.id);
      }
    }
    expect(narrative(this.game).quests.find(q => q.id === id)?.status).toBe('completed');
    this.close();
  }
  conquest(boss: boolean): void {
    this.close();
    this.capture('forest'); this.waitConvoy('forest');
    this.raid();
    this.capture('palace'); this.waitConvoy('palace');
    if (boss) { this.toNode('fortress'); this.fight('fortress'); }
    this.toNode('home'); this.waitConvoy('home');
    advance(this.game, { interact: true }, 660);
  }
}

describe('narrative input and starter contract', () => {
  test('authored bilingual chapters, branching local stories and distinct speakers', () => {
    expect(QUESTS.filter(q => q.kind === 'main')).toHaveLength(5);
    const side = QUESTS.filter(q => q.kind === 'side');
    expect(side.length).toBeGreaterThanOrEqual(8);
    expect(side.every(q => q.stages.length >= 3 && q.stages.some(s => s.actions.length >= 2))).toBe(true);
    expect(new Set(side.map(q => q.stages.length)).size).toBeGreaterThanOrEqual(3);
    expect(side.filter(q => new Set(q.stages.filter(s => s.kind === 'talk').map(s => s.at)).size > 1).length).toBeGreaterThanOrEqual(3);
    expect(new Set(NPCS.map(n => n.id)).size).toBeGreaterThanOrEqual(16);
    expect(new Set(NPCS.map(n => n.greeting.ru)).size).toBe(NPCS.length);
    for (const npc of NPCS) for (const line of [
      npc.greeting, npc.localQuestion, npc.local, npc.beliefQuestion, npc.belief, ...(npc.reactions?.map(r => r.text) ?? []),
    ]) {
      expect(line.en.trim()).not.toBe('');
      expect(line.ru).toMatch(/[А-Яа-яЁё]/);
    }
    for (const quest of QUESTS) {
      for (const line of [quest.title, quest.description, quest.unresolved, ...quest.stages.flatMap(s => [
        s.objective, s.prompt, ...(s.variants?.map(v => v.prompt) ?? []), ...s.actions.flatMap(a => [a.text, a.entry, a.response]),
      ])]) {
        expect(line.en.trim()).not.toBe('');
        expect(line.ru).toMatch(/[А-Яа-яЁё]/);
      }
    }
  });
  test('starter dialogue and all overlay commands are paused transactions with exact resume', () => {
    const game = createCampaign({ seed: 'dialogue', faction: 'guard' });
    expect(game.serialize().version).toBe(2);
    expect(narrative(game).interaction).toMatchObject({ kind: 'talk', targetId: 'mara', enabled: true });
    const mara = narrative(game).npcs.find(n => n.id === 'mara')!;
    expect(dist(mara, game.snapshot().convoy)).toBeGreaterThan(game.snapshot().convoy.radius + 0.95);
    expect(dist(mara, game.snapshot().player)).toBeLessThan(4.25);
    expect(narrative(game).summary.en).toMatch(/convoy|wagon|cart/i);
    expect(narrative(game).summary.en).toContain('Mara');
    expect(narrative(game).summary.en).not.toContain('First capture');
    const finalChapter = narrative(game).quests.find(q => q.id === 'unwritten-road')!;
    expect(finalChapter.targetId).toBe('mara');
    expect(finalChapter.objective.en).toContain(QUESTS[0]!.title.en);
    expect(finalChapter.description.en).not.toBe(QUESTS.find(q => q.id === 'unwritten-road')!.description.en);
    const before = game.snapshot();
    game.step({ attack: true, move: { x: 0, z: 0 } });
    const tick = game.snapshot().tick;
    const frozen = game.snapshot();
    command(game, { type: 'talk', npcId: 'mara' });
    command(game, { type: 'choose', npcId: 'mara', choiceId: 'topic-local' });
    command(game, { type: 'track', questId: 'missing-names' });
    const after = game.snapshot();
    expect(after.tick).toBe(tick);
    expect(after.actors).toEqual(frozen.actors);
    expect(after.player).toEqual(frozen.player);
    expect(after.convoy).toEqual(frozen.convoy);
    const saved = JSON.parse(JSON.stringify(game.serialize()));
    const resumed = restoreCampaign(saved);
    expect(resumed.snapshot()).toEqual(after);
    for (const session of [game, resumed]) {
      session.step({ attack: true, move: { x: 1, z: 1 }, special: true, convoy: 'follow' });
      expect(session.snapshot().tick).toBe(tick);
      expect(narrative(session).notice?.en).toContain('paused the game');
      command(session, { type: 'choose', npcId: 'mara', choiceId: 'quest-missing-names' });
      command(session, { type: 'choose', npcId: 'mara', choiceId: 'names-start' });
      expect(narrative(session).quests.find(q => q.id === 'missing-names')?.status).toBe('active');
      command(session, { type: 'close' });
      expect(narrative(session).dialogue).toBeNull();
      expect(restoreCampaign(session.serialize()).snapshot().narrative!.dialogue).toBeNull();
      session.step();
      expect(session.snapshot().tick).toBe(tick + 1);
    }
    expect(game.serialize()).toEqual(resumed.serialize());
    expect(before.narrative!.quests[0]!.status).toBe('available');
  });
  test('invalid command structure is atomic; stale and remote choices have explicit notices', () => {
    const game = createCampaign({ seed: 'invalid-narrative', faction: 'guard' });
    for (const input of [
      { narrative: { type: 'choose', npcId: 'mara', choiceId: '' } },
      { narrative: { type: 'talk', npcId: 'mara', extra: true } },
      { narrative: { type: 'unknown' } },
      { narrative: { type: 'close' }, move: { x: 1, z: 0 } },
      { narrative: { type: 'track', questId: undefined } },
    ]) {
      const saved = game.serialize();
      expect(() => game.step(input as never)).toThrow();
      expect(game.serialize()).toEqual(saved);
    }
    command(game, { type: 'choose', npcId: 'mara', choiceId: 'names-start' });
    expect(narrative(game).notice?.en).toContain('no longer available');
    command(game, { type: 'talk', npcId: 'elin' });
    expect(narrative(game).notice?.en).toContain('closer');
    command(game, { type: 'inspect', locationId: 'last-archive' });
    expect(narrative(game).notice?.ru).toContain('ближе');
    command(game, { type: 'track', questId: 'not-a-quest' });
    expect(narrative(game).notice?.en).toContain('not available');
    expect(narrative(game).quests.every(q => q.status === 'available')).toBe(true);
    expect(game.snapshot().tick).toBe(0);
  });
  test('choosing a local topic does not offer unseen quest answers or accept them by ID', () => {
    const game = createCampaign({ seed: 'topic-boundary', faction: 'guard' });
    command(game, { type: 'talk', npcId: 'mara' });
    command(game, { type: 'choose', npcId: 'mara', choiceId: 'topic-local' });
    const before = narrative(game);
    expect(before.dialogue!.choices.some(c => c.id === 'names-start')).toBe(false);
    expect(before.dialogue!.choices.some(c => c.id === 'quest-missing-names')).toBe(true);
    command(game, { type: 'choose', npcId: 'mara', choiceId: 'names-start' });
    expect(narrative(game).notice?.en).toContain('no longer available');
    expect(narrative(game).facts).toEqual(before.facts);
    command(game, { type: 'choose', npcId: 'mara', choiceId: 'quest-missing-names' });
    expect(narrative(game).dialogue!.text.ru).toBe(QUESTS[0]!.stages[0]!.prompt.ru);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
    command(game, { type: 'choose', npcId: 'mara', choiceId: 'names-start' });
    const action = QUESTS[0]!.stages[0]!.actions[0]!;
    expect(narrative(game).dialogue!.text.ru).toBe(action.response.ru);
    expect(narrative(game).facts.at(-1)!.ru).toBe(action.entry.ru);
    expect(action.response.ru).not.toBe(action.entry.ru);
  });
  test('legacy runs have no narrative, keep their original world hash and reject narrative without mutation', () => {
    const legacy = createCampaign({ seed: 'legacy-story', faction: 'guard', worldVersion: 1 });
    expect(legacy.snapshot().narrative).toBeUndefined();
    expect(legacy.serialize().version).toBe(1);
    expect(legacy.snapshot().world.id).toMatch(/^k2-v1-/);
    const saved = legacy.serialize();
    expect(() => command(legacy, { type: 'talk', npcId: 'mara' })).toThrow(/legacy/);
    expect(legacy.serialize()).toEqual(saved);
    expect(restoreCampaign(saved).snapshot()).toEqual(legacy.snapshot());
  });
});

describe('narrative persistence and travel boundaries', () => {
  test('an examination is a readable, paused, saved scene; repeated inspections grant nothing', () => {
    const game = createCampaign({ seed: 'reading-evidence', faction: 'guard' });
    const bot = new StoryDriver(game);
    bot.talk('mara'); bot.choose('names-start');
    bot.talk('toman'); bot.choose('names-witness');
    bot.visit('old-orchard');
    const before = game.snapshot();
    command(game, { type: 'inspect', locationId: 'old-orchard' });
    const examined = game.snapshot();
    const scene = examined.narrative!.inspection!;
    expect(scene.text.ru).toBe(QUESTS[0]!.stages.find(stage => stage.kind === 'inspect')!.prompt.ru);
    expect(scene.title.ru).toBe(examined.world.exploration!.locations.find(l => l.id === 'old-orchard')!.name.ru);
    expect(examined.tick).toBe(before.tick);
    expect(examined.actors).toEqual(before.actors);
    expect(examined.player).toEqual(before.player);
    expect(examined.convoy).toEqual(before.convoy);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(examined);
    game.step({ attack: true, move: { x: 1, z: 0 }, convoy: 'follow' });
    expect(game.snapshot().tick).toBe(examined.tick);
    expect(narrative(game).inspection).toEqual(scene);
    for (const inspection of [
      { locationId: 'name-well', actionIds: ['names-stones'] },
      { locationId: 'old-orchard', actionIds: ['names-start'] },
      { locationId: 'old-orchard', actionIds: ['names-stones', 'names-stones'] },
      { locationId: 'old-orchard', actionIds: ['road-index'] },
    ]) {
      const save = game.serialize();
      (resource(save).narrative as Record<string, unknown>).inspection = inspection;
      expect(() => restoreCampaign(save)).toThrow();
    }
    const staleIntent = game.serialize();
    (staleIntent.engine as { resources: Record<string, unknown> }).resources.KorovanyIntent = { attack: true };
    expect(() => restoreCampaign(staleIntent)).toThrow(/stale intent/);
    const facts = narrative(game).facts;
    bot.close();
    expect(narrative(game).inspection).toBeNull();
    command(game, { type: 'inspect', locationId: 'old-orchard' });
    expect(narrative(game).facts).toEqual(facts);
    expect(narrative(game).inspection!.text).toEqual(examined.world.exploration!.locations.find(l => l.id === 'old-orchard')!.description);
    bot.close();
    game.step();
    expect(game.snapshot().tick).toBe(examined.tick + 1);
  });
  test('previous story saves are rejected explicitly without modifying them', () => {
    const game = createCampaign({ seed: 'old-story', faction: 'guard' });
    const save = game.serialize();
    const n = resource(save).narrative as Record<string, unknown>;
    n.version = 1;
    delete n.inspection;
    const original = structuredClone(save);
    expect(() => restoreCampaign(save)).toThrow(/Unsupported story version/);
    expect(save).toEqual(original);
  });
  test('tampered state rejects duplicate actions, out-of-order chapters, invented evidence and inconsistent dialogues', () => {
    const game = createCampaign({ seed: 'corrupt-story', faction: 'guard' });
    command(game, { type: 'talk', npcId: 'mara' });
    command(game, { type: 'choose', npcId: 'mara', choiceId: 'names-start' });
    for (const edit of [
      (n: Record<string, unknown>) => { n.version = 1; },
      (n: Record<string, unknown>) => { n.extra = true; },
      (n: Record<string, unknown>) => { n.journal = ['names-start', 'names-start']; },
      (n: Record<string, unknown>) => { n.journal = ['river-start']; },
      (n: Record<string, unknown>) => { n.journal = ['names-start', 'names-witness']; },
      (n: Record<string, unknown>) => { n.journal = ['ending-cinder']; },
      (n: Record<string, unknown>) => { n.discovered = ['roadward', 'roadward']; },
      (n: Record<string, unknown>) => { n.discovered = ['made-up-place']; },
      (n: Record<string, unknown>) => { n.trackedQuestId = 'made-up-quest'; },
      (n: Record<string, unknown>) => { n.notice = 'invented'; },
      (n: Record<string, unknown>) => { n.rewardedQuestIds = ['missing-names']; },
      (n: Record<string, unknown>) => { n.dialogue = { npcId: 'elin', topicId: null }; },
      (n: Record<string, unknown>) => { n.dialogue = { npcId: 'mara', topicId: 'river-open' }; },
      (n: Record<string, unknown>) => { n.dialogue = { npcId: 'mara', topicId: 'quest-river-record' }; },
      (n: Record<string, unknown>) => { n.inspection = { locationId: 'old-orchard', actionIds: [] }; },
    ]) {
      const saved = structuredClone(game.serialize());
      edit(resource(saved).narrative as Record<string, unknown>);
      expect(() => restoreCampaign(saved)).toThrow();
    }
    const missing = structuredClone(game.serialize());
    delete resource(missing).narrative;
    expect(() => restoreCampaign(missing)).toThrow();
    const intent = structuredClone(game.serialize());
    (intent.engine as { resources: Record<string, unknown> }).resources.KorovanyIntent = { attack: true };
    expect(() => restoreCampaign(intent)).toThrow(/intent/);
    const downgrade = { ...game.serialize(), version: 1 as const };
    expect(() => restoreCampaign(downgrade)).toThrow();
    expect(restoreCampaign(game.serialize()).serialize()).toEqual(game.serialize());
  });

  describe('the full Hollow Road through public input', () => {
    let ready: CampaignSave;
    let withoutBells: CampaignSave;
    let rememberedChoices = 0;
    beforeAll(async () => {
      const game = createCampaign({ seed: 'authored-borderland', faction: 'guard', runId: 'story-acceptance' });
      const bot = new StoryDriver(game);
      for (const quest of QUESTS.filter(q => q.id !== 'unwritten-road' && q.id !== 'borrowed-name')) {
        for (const stage of quest.stages) {
          if (stage.kind === 'inspect') bot.inspect(stage.at);
          else {
            bot.talk(stage.at);
            bot.topic(quest.id);
            const journal = (resource(game.serialize()).narrative as { journal: string[] }).journal;
            const remembered = [...journal].reverse().flatMap(id => stage.variants?.filter(v => v.after === id) ?? [])[0];
            if (remembered) {
              expect(narrative(game).dialogue!.text.ru).toContain(remembered.prompt.ru);
              rememberedChoices++;
            }
            if (stage.actions.length > 1) {
              const fork = game.serialize(), baseline = game.snapshot().player.coins;
              const outcomes = new Set<string>(), reputations = new Set<string>();
              for (const action of stage.actions) {
                const branch = restoreCampaign(fork);
                command(branch, { type: 'choose', npcId: stage.at, choiceId: action.id });
                const end = narrative(branch).quests.find(q => q.id === quest.id)!;
                expect(end.status).toBe('completed');
                expect(branch.snapshot().player.coins).toBe(baseline + quest.reward);
                outcomes.add(end.outcome!.en);
                reputations.add(JSON.stringify(narrative(branch).reputation));
                const paid = branch.snapshot().player.coins;
                for (const reply of stage.actions) command(branch, { type: 'choose', npcId: stage.at, choiceId: reply.id });
                expect(branch.snapshot().player.coins).toBe(paid);
                expect(narrative(branch).notice?.en).toContain('no longer available');
                expect(restoreCampaign(branch.serialize()).snapshot()).toEqual(branch.snapshot());
                if (action.id === 'bell-road') withoutBells = branch.serialize();
                const corrupt = structuredClone(branch.serialize());
                const n = resource(corrupt).narrative as { rewardedQuestIds: string[] };
                n.rewardedQuestIds.pop();
                expect(() => restoreCampaign(corrupt)).toThrow(/reward/);
              }
              expect(outcomes.size).toBe(stage.actions.length);
              expect(reputations.size).toBe(stage.actions.length);
            }
            bot.choose(stage.actions[0]!.id);
          }
          expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
          // Long public-input journeys must yield so Vitest can acknowledge worker RPC messages.
          await yieldRunner();
        }
        expect(narrative(game).quests.find(q => q.id === quest.id)?.status).toBe('completed');
        bot.close();
      }
      // Inspecting a future stage early never grants an out-of-order story entry.
      bot.inspect('last-archive');
      expect(narrative(game).quests.find(q => q.id === 'unwritten-road')?.entries).toHaveLength(0);
      bot.talk('ada'); bot.choose('road-start');
      bot.inspect('name-well'); bot.inspect('last-archive');
      bot.talk('elin');
      const locked = narrative(game).dialogue!.choices.filter(c => c.id.startsWith('ending-'));
      expect(locked).toHaveLength(3);
      for (const choice of locked) {
        expect(choice.enabled).toBe(false);
        expect(choice.reason?.en).toContain('supply two posts');
        command(game, { type: 'choose', npcId: 'elin', choiceId: choice.id });
        expect(narrative(game).notice?.en).toContain('supply two posts');
        expect(narrative(game).ending).toBeNull();
      }
      bot.choose('leave');
      expect(narrative(game).quests.find(q => q.id === 'unwritten-road')?.status).toBe('active');
      await yieldRunner();
      bot.conquest(false);
      expect(game.snapshot().fortress.bossDefeated).toBe(false);
      command(game, { type: 'travel', locationId: 'hollow-village' });
      expect(narrative(game).notice?.en).toContain('arrived');
      bot.talk('elin');
      expect(narrative(game).dialogue!.choices.filter(c => c.id.startsWith('ending-')).every(c => c.enabled)).toBe(true);
      ready = game.serialize();
    }, 240_000);
    test('later witnesses respond specifically to earlier decisions', () => {
      expect(rememberedChoices).toBeGreaterThanOrEqual(3);
    });
    test('Mara learns what happened to the drivers instead of repeating the opening request', () => {
      const game = restoreCampaign(ready), bot = new StoryDriver(game);
      bot.talk('mara');
      const mara = NPCS.find(npc => npc.id === 'mara')!;
      expect(narrative(game).dialogue!.text).toEqual(mara.reactions!.find(r => r.after === 'road-names')!.text);
      expect(narrative(game).dialogue!.text).not.toEqual(mara.greeting);
      expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
    });

    for (const ending of ['commons', 'compact', 'cinder'] as const) {
      test(`${ending}: explicit, mutually exclusive finale, unique rewards and exact paused resume`, () => {
        const game = restoreCampaign(ready);
        const before = game.snapshot();
        command(game, { type: 'choose', npcId: 'elin', choiceId: `ending-${ending}` });
        const after = game.snapshot(), story = after.narrative!;
        expect(after.phase).toBe('playing');
        expect(after.tick).toBe(before.tick);
        expect(after.player.coins).toBe(before.player.coins + 50);
        expect(story.ending?.en).toContain(ENDINGS[ending].en);
        expect(story.ending?.en).not.toContain(ENDING_EPILOGUES[ending].en);
        expect(story.ending?.en).toContain(QUESTS.find(q => q.id === 'borrowed-name')!.unresolved.en);
        expect(story.dialogue!.choices.some(c => c.id.startsWith('ending-'))).toBe(false);
        for (const id of ['commons', 'compact', 'cinder']) command(game, { type: 'choose', npcId: 'elin', choiceId: `ending-${id}` });
        expect(game.snapshot().player.coins).toBe(after.player.coins);
        expect(narrative(game).ending).toEqual(story.ending);
        const restored = restoreCampaign(JSON.parse(JSON.stringify(game.serialize())));
        expect(restored.snapshot()).toEqual(game.snapshot());
        expect(restored.serialize()).toEqual(game.serialize());
      });
    }
    test('a refused bell alliance closes only its finale, and cannot be bypassed by a command', async () => {
      const game = restoreCampaign(withoutBells), bot = new StoryDriver(game);
      bot.talk('ada'); bot.choose('road-start');
      await yieldRunner();
      bot.inspect('name-well');
      await yieldRunner();
      bot.inspect('last-archive');
      await yieldRunner();
      bot.conquest(false);
      await yieldRunner();
      bot.talk('elin');
      const choices = narrative(game).dialogue!.choices;
      const bells = choices.find(choice => choice.id === 'ending-commons')!;
      expect(bells.enabled).toBe(false);
      expect(bells.reason!.en).toContain(QUESTS.find(q => q.id === 'bell-metal')!.title.en);
      expect(bells.reason!.en).toContain('no longer available');
      expect(choices.find(choice => choice.id === 'ending-compact')!.enabled).toBe(true);
      expect(choices.find(choice => choice.id === 'ending-cinder')!.enabled).toBe(true);
      const before = game.snapshot();
      command(game, { type: 'choose', npcId: 'elin', choiceId: 'ending-commons' });
      expect(narrative(game).notice?.en).toContain('allies');
      expect(narrative(game).ending).toBeNull();
      expect(game.snapshot().player).toEqual(before.player);
      expect(game.snapshot().tick).toBe(before.tick);
      expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
      bot.choose('ending-compact');
      expect(narrative(game).ending!.en).toContain(ENDINGS.compact.en);
    }, 120_000);
    test('saved finale cannot acquire its required allies retroactively', () => {
      const game = restoreCampaign(ready);
      command(game, { type: 'choose', npcId: 'elin', choiceId: 'ending-commons' });
      const save = game.serialize();
      const n = resource(save).narrative as { journal: string[] };
      n.journal.splice(n.journal.indexOf('bell-mourn'), 1);
      n.journal.push('bell-mourn');
      expect(() => restoreCampaign(save)).toThrow(/required allies/);
    });
    test('boss death first leaves investigation playable; side quests can precede the final decision', async () => {
      const game = restoreCampaign(ready), bot = new StoryDriver(game);
      bot.close(); bot.toNode('fortress'); bot.fight('fortress');
      await yieldRunner();
      expect(game.snapshot().fortress.bossDefeated).toBe(true);
      expect(game.snapshot().phase).toBe('playing');
      expect(game.snapshot().rewards).toBeNull();
      expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
      bot.quest('borrowed-name', 1);
      await yieldRunner();
      bot.talk('mila');
      const borrowed = QUESTS.find(q => q.id === 'borrowed-name')!.stages.at(-1)!.actions[1]!;
      expect(narrative(game).dialogue!.text.en).toBe(borrowed.response.en);
      command(game, { type: 'choose', npcId: 'mila', choiceId: 'topic-belief' });
      expect(narrative(game).dialogue!.text.en).toBe(NPCS.find(n => n.id === 'mila')!.belief.en);
      bot.talk('elin');
      expect(narrative(game).dialogue!.text.ru).toContain('Раут побеждён');
      expect(narrative(game).dialogue!.text.ru).not.toContain('Сначала нужно');
      expect(narrative(game).dialogue!.choices.filter(c => c.id.startsWith('ending-'))
        .every(c => !c.text.ru.includes('Когда Раут'))).toBe(true);
      const before = game.snapshot();
      command(game, { type: 'choose', npcId: 'elin', choiceId: 'ending-commons' });
      const final = game.snapshot();
      expect(final.tick).toBe(before.tick);
      expect(final.phase).toBe('victory');
      expect(final.rewards?.victory).toBe(true);
      expect(final.narrative!.ending!.en).not.toContain(QUESTS.find(q => q.id === 'borrowed-name')!.unresolved.en);
      expect(final.narrative!.ending!.en).toContain(borrowed.entry.en);
      expect(final.narrative!.ending!.en).toContain(ENDING_EPILOGUES.commons.en);
      expect(final.narrative!.dialogue).toBeNull();
      const save = game.serialize();
      game.step({ narrative: { type: 'travel', locationId: 'roadward' } });
      game.step({ attack: true });
      expect(game.serialize()).toEqual(save);
      expect(restoreCampaign(save).snapshot()).toEqual(final);
    });
    test('finale first permits local work, then military victory completes the campaign', async () => {
      const game = restoreCampaign(ready), bot = new StoryDriver(game);
      bot.choose('ending-cinder');
      const before = narrative(game).ending!.en;
      bot.quest('borrowed-name', 0);
      await yieldRunner();
      expect(narrative(game).ending!.en).not.toBe(before);
      expect(narrative(game).ending!.en).toContain(QUESTS.find(q => q.id === 'borrowed-name')!.stages.at(-1)!.actions[0]!.entry.en);
      bot.toNode('fortress'); bot.fight('fortress');
      expect(game.snapshot().phase).toBe('victory');
      expect(narrative(game).ending!.en).toContain(ENDING_EPILOGUES.cinder.en);
      expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
    });
  });
  test('fast travel requires discovered stops, safe source and a fully repaired accompanying convoy', () => {
    const game = createCampaign({ seed: 'travel-story', faction: 'guard' });
    const bot = new StoryDriver(game);
    const start = game.snapshot();
    command(game, { type: 'travel', locationId: 'greenhollow' });
    expect(narrative(game).notice?.en).toContain('Discover');
    expect(game.snapshot().player).toEqual(start.player);
    command(game, { type: 'travel', locationId: 'roadward' });
    expect(narrative(game).notice?.en).toContain('arrived');
    expect(game.snapshot().tick).toBe(start.tick);
    bot.visit('greenhollow');
    const away = game.snapshot();
    expect(narrative(game).travel.available).toBe(false);
    command(game, { type: 'travel', locationId: 'roadward' });
    expect(narrative(game).notice?.en).toContain('Bring the convoy');
    expect(game.snapshot().convoy).toEqual(away.convoy);
    bot.waitConvoy('greenhollow');
    expect(narrative(game).travel.available).toBe(true);
    const before = game.snapshot();
    command(game, { type: 'travel', locationId: 'roadward' });
    const after = game.snapshot();
    expect(after.tick).toBe(before.tick);
    expect(after.actors).toEqual(before.actors);
    expect(after.convoy.mode).toBe('hold');
    expect(after.convoy.route).toEqual([]);
    expect(after.convoy.cargo).toBe(before.convoy.cargo);
    expect(dist(after.player, after.convoy)).toBe(3);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(after);
    bot.visit('old-orchard');
    command(game, { type: 'travel', locationId: 'old-orchard' });
    expect(narrative(game).notice?.en).toContain('Discover');
    command(game, { type: 'travel', locationId: 'greenhollow' });
    expect(narrative(game).notice?.en).toContain('road stop');
    // A damaged cart is a real gameplay state. Walk back to safe home and let its unattended route face the forest post.
    bot.visit('roadward');
    game.step({ convoy: { destination: 'forest' } });
    advance(game, {}, 9000);
    expect(game.snapshot().convoy.disabled).toBe(true);
    command(game, { type: 'travel', locationId: 'greenhollow' });
    expect(narrative(game).notice?.en).toMatch(/enemies|Repair/);
    bot.toNode('forest'); bot.fight('forest');
    bot.walk(bot.snap().convoy);
    advance(game, { interact: true }, 306);
    bot.waitConvoy('roadward');
    bot.visit('roadward');
    // Repairs only run while interacting: the recovering cart must not be made whole by a travel command.
    const saved = game.serialize();
    expect(game.snapshot().convoy.hp).toBeGreaterThan(0);
    expect(game.snapshot().convoy.hp).toBeLessThan(game.snapshot().convoy.maxHp);
    command(game, { type: 'travel', locationId: 'greenhollow' });
    expect(narrative(game).notice?.en).toContain('Repair');
    expect(game.snapshot().convoy.hp).toBe((resource(saved).convoy as { hp: number }).hp);
  });
});
