import { beforeAll, describe, expect, test } from 'vitest';
import { createCampaign, restoreCampaign, type CampaignSave, type GameSession, type NarrativeInput } from '../src/game';
import { NPCS, QUESTS } from '../src/game/narrative-data';
import { advance, CampaignDriver, dist } from './driver';

function command(game: GameSession, input: NarrativeInput): void { game.step({ narrative: input }); }
function narrative(game: GameSession) { return game.snapshot().narrative!; }
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
    const dialogue = narrative(this.game).dialogue!;
    expect(dialogue.choices.find(c => c.id === id)?.enabled, `${dialogue.npcId}: ${id}`).toBe(true);
    command(this.game, { type: 'choose', npcId: dialogue.npcId, choiceId: id });
    expect(narrative(this.game).notice).toBeNull();
  }
  inspect(id: string): void {
    this.visit(id);
    command(this.game, { type: 'inspect', locationId: id });
    expect(narrative(this.game).notice?.en).toContain('Place examined');
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
    expect(new Set(NPCS.map(n => n.id)).size).toBeGreaterThanOrEqual(16);
    for (const quest of QUESTS) {
      for (const line of [quest.title, quest.description, ...quest.stages.flatMap(s => [
        s.objective, s.prompt, ...s.actions.flatMap(a => [a.text, a.entry]),
      ])]) {
        expect(line.en.length).toBeGreaterThan(10);
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
    expect(narrative(game).summary.en).toContain('cart addressed');
    expect(narrative(game).summary.en).toContain('Mara');
    expect(narrative(game).summary.en).not.toContain('First capture');
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
      expect(narrative(session).notice?.en).toContain('Conversation paused');
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
  test('tampered state rejects duplicate actions, out-of-order chapters, invented evidence and inconsistent dialogues', () => {
    const game = createCampaign({ seed: 'corrupt-story', faction: 'guard' });
    command(game, { type: 'talk', npcId: 'mara' });
    command(game, { type: 'choose', npcId: 'mara', choiceId: 'names-start' });
    for (const edit of [
      (n: Record<string, unknown>) => { n.version = 2; },
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

  describe('the full Unwritten Road through public input', () => {
    let ready: CampaignSave;
    beforeAll(async () => {
      const game = createCampaign({ seed: 'authored-borderland', faction: 'guard', runId: 'story-acceptance' });
      const bot = new StoryDriver(game);
      for (const quest of QUESTS.filter(q => q.id !== 'unwritten-road' && q.id !== 'borrowed-name')) {
        for (const stage of quest.stages) {
          if (stage.kind === 'inspect') bot.inspect(stage.at);
          else {
            bot.talk(stage.at);
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
          await new Promise<void>(resolve => setImmediate(resolve));
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
      await new Promise<void>(resolve => setImmediate(resolve));
      bot.conquest(false);
      expect(game.snapshot().fortress.bossDefeated).toBe(false);
      command(game, { type: 'travel', locationId: 'hollow-village' });
      expect(narrative(game).notice?.en).toContain('arrived');
      bot.talk('elin');
      expect(narrative(game).dialogue!.choices.filter(c => c.id.startsWith('ending-')).every(c => c.enabled)).toBe(true);
      ready = game.serialize();
    }, 240_000);

    for (const ending of ['commons', 'compact', 'cinder']) {
      test(`${ending}: explicit, mutually exclusive finale, unique rewards and exact paused resume`, () => {
        const game = restoreCampaign(ready);
        const before = game.snapshot();
        command(game, { type: 'choose', npcId: 'elin', choiceId: `ending-${ending}` });
        const after = game.snapshot(), story = after.narrative!;
        expect(after.phase).toBe('playing');
        expect(after.tick).toBe(before.tick);
        expect(after.player.coins).toBe(before.player.coins + 50);
        expect(story.ending?.en).toContain(ending === 'commons' ? 'Road of Witnesses' : ending === 'compact' ? 'Winter Compact' : 'Road Without Ink');
        expect(story.ending?.en).toContain('dispute still waits');
        expect(story.dialogue!.choices.some(c => c.id.startsWith('ending-'))).toBe(false);
        for (const id of ['commons', 'compact', 'cinder']) command(game, { type: 'choose', npcId: 'elin', choiceId: `ending-${id}` });
        expect(game.snapshot().player.coins).toBe(after.player.coins);
        expect(narrative(game).ending).toEqual(story.ending);
        const restored = restoreCampaign(JSON.parse(JSON.stringify(game.serialize())));
        expect(restored.snapshot()).toEqual(game.snapshot());
        expect(restored.serialize()).toEqual(game.serialize());
      });
    }
    test('boss death first leaves investigation playable; side quests can precede the final decision', () => {
      const game = restoreCampaign(ready), bot = new StoryDriver(game);
      bot.close(); bot.toNode('fortress'); bot.fight('fortress');
      expect(game.snapshot().fortress.bossDefeated).toBe(true);
      expect(game.snapshot().phase).toBe('playing');
      expect(game.snapshot().rewards).toBeNull();
      expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
      bot.quest('borrowed-name', 1);
      bot.talk('mila');
      command(game, { type: 'choose', npcId: 'mila', choiceId: 'topic-belief' });
      expect(narrative(game).dialogue!.text.en).toContain('public disguise');
      bot.talk('elin');
      const before = game.snapshot();
      command(game, { type: 'choose', npcId: 'elin', choiceId: 'ending-commons' });
      const final = game.snapshot();
      expect(final.tick).toBe(before.tick);
      expect(final.phase).toBe('victory');
      expect(final.rewards?.victory).toBe(true);
      expect(final.narrative!.ending!.en).not.toContain('dispute still waits');
      expect(final.narrative!.ending!.en).toContain('public disguise');
      expect(final.narrative!.dialogue).toBeNull();
      const save = game.serialize();
      game.step({ narrative: { type: 'travel', locationId: 'roadward' } });
      game.step({ attack: true });
      expect(game.serialize()).toEqual(save);
      expect(restoreCampaign(save).snapshot()).toEqual(final);
    });
    test('finale first permits local work, then military victory completes the campaign', () => {
      const game = restoreCampaign(ready), bot = new StoryDriver(game);
      bot.choose('ending-cinder');
      const before = narrative(game).ending!.en;
      bot.quest('borrowed-name', 0);
      expect(narrative(game).ending!.en).not.toBe(before);
      expect(narrative(game).ending!.en).toContain('chosen kin');
      bot.toNode('fortress'); bot.fight('fortress');
      expect(game.snapshot().phase).toBe('victory');
      expect(narrative(game).ending!.en).toContain('Road Without Ink');
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
