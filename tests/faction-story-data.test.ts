import { describe, expect, test } from 'vitest';
import { DIRECTIVES, FACTION_CAMPAIGNS } from '../src/game/faction-campaigns';
import { getFactionStory, type FactionStory } from '../src/game/faction-stories';
import { NPCS, QUESTS, type StoryAction } from '../src/game/narrative-data';
import type { FactionId, LocalizedText } from '../src/game/types';
import { generateWorld } from '../src/game/world';

const factions: FactionId[] = ['elf', 'guard', 'villain'];
const endings = ['commons', 'compact', 'cinder'] as const;
const world = generateWorld('faction-authored-data');
const locations = new Map(world.exploration!.locations.map(location => [location.id, location]));

function actions(story: FactionStory): StoryAction[] {
  return story.quests.flatMap(quest => quest.stages.flatMap(stage => stage.actions));
}

function localizedLines(story: FactionStory): LocalizedText[] {
  return [
    story.title, ...Object.values(story.endings), ...Object.values(story.epilogues),
    ...story.npcs.flatMap(npc => [
      npc.name, npc.role, npc.activity, npc.greeting, npc.localQuestion, npc.local, npc.beliefQuestion, npc.belief,
      ...(npc.reactions?.map(reaction => reaction.text) ?? []),
    ]),
    ...story.quests.flatMap(quest => [
      quest.title, quest.description, quest.unresolved,
      ...quest.stages.flatMap(stage => [
        stage.objective, stage.prompt, ...(stage.variants?.map(variant => variant.prompt) ?? []),
        ...stage.actions.flatMap(action => [action.text, action.entry, action.response]),
      ]),
    ]),
  ];
}

describe.each(factions)('%s authored campaign', faction => {
  const story = getFactionStory(faction);
  const main = story.quests.filter(quest => quest.kind === 'main');
  const side = story.quests.filter(quest => quest.kind === 'side');
  const allActions = actions(story);
  const actionIds = new Set(allActions.map(action => action.id));
  const npcIds = new Set(story.npcs.map(npc => npc.id));

  test('has five complete sequential chapters, eight local stories and twenty residents', () => {
    expect(main).toHaveLength(5);
    expect(side).toHaveLength(8);
    expect(story.npcs).toHaveLength(20);
    expect(main.flatMap(quest => quest.stages)).toHaveLength(22);
    expect(side.flatMap(quest => quest.stages)).toHaveLength(32);
    expect(allActions).toHaveLength(67);
    expect(new Set(story.quests.map(quest => quest.id)).size).toBe(story.quests.length);
    expect(npcIds.size).toBe(story.npcs.length);
    main.forEach((quest, index) => {
      expect(quest.requires).toBe(index === 0 ? null : main[index - 1]!.id);
      expect(quest.stages.length).toBeGreaterThanOrEqual(3);
      expect(quest.reward).toBeGreaterThan(0);
    });
    expect(side.every(quest => quest.requires === null)).toBe(true);
    expect(side.every(quest => quest.stages.length >= 3 && quest.stages.some(stage => stage.actions.length > 1))).toBe(true);
  });

  test('has complete independently localized prose on every visible surface', () => {
    for (const line of localizedLines(story)) {
      expect(Object.keys(line).sort()).toEqual(['en', 'ru']);
      expect(line.en.trim(), JSON.stringify(line)).not.toBe('');
      expect(line.ru, line.en).toMatch(/[А-Яа-яЁё]/);
      expect(line.en).not.toBe(line.ru);
      expect(`${line.en} ${line.ru}`).not.toMatch(/\bTODO\b|\bTBD\b|lorem ipsum|placeholder|�/i);
    }
    expect(new Set(story.npcs.map(npc => npc.greeting.en)).size).toBe(story.npcs.length);
    expect(new Set(story.npcs.map(npc => npc.greeting.ru)).size).toBe(story.npcs.length);
  });

  test('resolves NPC positions and every target within the shared eight-region world', () => {
    expect(world.exploration!.regions).toHaveLength(8);
    for (const npc of story.npcs) expect(locations.has(npc.locationId), npc.id).toBe(true);
    for (const quest of story.quests) for (const stage of quest.stages) {
      expect(stage.kind === 'talk' ? npcIds.has(stage.at) : locations.has(stage.at), `${quest.id}: ${stage.at}`).toBe(true);
      expect(stage.actions.length).toBeGreaterThan(0);
      if (stage.kind === 'inspect') {
        expect(stage.actions).toHaveLength(1);
        expect(stage.actions[0]!.ending).toBeUndefined();
        expect(stage.actions[0]!.directive).toBeUndefined();
      }
    }
    const starter = story.npcs.find(npc => npc.id === main[0]!.stages[0]!.at)!;
    expect(starter.locationId).toBe(FACTION_CAMPAIGNS[faction].homeLocationId);
    expect(starter.id).toBe(faction === 'elf' ? 'toman' : faction === 'guard' ? 'vesk' : 'ren');
    expect(starter.locationId).toBe(faction === 'elf' ? 'greenhollow' : faction === 'guard' ? 'crownbridge' : 'old-fort');
    if (faction === 'villain') {
      expect(locations.get(starter.locationId)!.regionId).toBe('frostspine');
      expect(starter.role.en).toContain('adviser');
    }
  });

  test('keeps all quest, action, dependency, variant and reaction references faction-scoped', () => {
    expect(actionIds.size).toBe(allActions.length);
    const positions = new Map(story.quests.flatMap(quest => quest.stages.flatMap((stage, stageIndex) =>
      stage.actions.map(action => [action.id, { questId: quest.id, stageIndex }] as const))));
    for (const quest of story.quests) {
      expect(quest.id.startsWith(`${faction}-`)).toBe(true);
      if (quest.requires) expect(story.quests.some(candidate => candidate.id === quest.requires)).toBe(true);
      for (const [stageIndex, stage] of quest.stages.entries()) {
        for (const action of stage.actions) {
          expect(action.id.startsWith(`${faction}-`)).toBe(true);
          for (const required of action.requiresActions ?? []) {
            expect(actionIds.has(required), `${action.id} requires ${required}`).toBe(true);
            const position = positions.get(required)!;
            if (position.questId === quest.id) expect(position.stageIndex).toBeLessThan(stageIndex);
          }
        }
        for (const variant of stage.variants ?? []) {
          expect(actionIds.has(variant.after), `${quest.id} variant ${variant.after}`).toBe(true);
          const position = positions.get(variant.after)!;
          if (position.questId === quest.id) expect(position.stageIndex).toBeLessThan(stageIndex);
        }
      }
    }
    for (const npc of story.npcs) for (const reaction of npc.reactions ?? []) {
      expect(actionIds.has(reaction.after), `${npc.id} reaction ${reaction.after}`).toBe(true);
    }
  });

  test('offers exactly two irreversible faction-exclusive operational choices after the initial inquiry', () => {
    const directives = allActions.filter(action => action.directive !== undefined);
    expect(directives.map(action => action.directive).sort()).toEqual([...DIRECTIVES[faction]].sort());
    expect(main[0]!.stages[3]!.actions).toEqual(directives);
    expect(main[0]!.stages.map(stage => stage.at)).toEqual([
      faction === 'elf' ? 'toman' : faction === 'guard' ? 'vesk' : 'ren',
      'mara', 'old-orchard', faction === 'elf' ? 'toman' : faction === 'guard' ? 'vesk' : 'ren',
    ]);
    for (const action of directives) {
      expect(action.gate).toBeUndefined();
      expect(action.requiresActions).toBeUndefined();
      expect(action.ending).toBeUndefined();
    }
  });

  test('preserves the complete neutral sidequest consequences and reachable local callbacks', () => {
    for (const original of QUESTS.filter(quest => quest.kind === 'side')) {
      const scoped = side.find(quest => quest.id === `${faction}-${original.id}`)!;
      expect(scoped.stages).toHaveLength(original.stages.length);
      for (const [stageIndex, originalStage] of original.stages.entries()) {
        const scopedStage = scoped.stages[stageIndex]!;
        expect(scopedStage.actions).toHaveLength(originalStage.actions.length);
        for (const [actionIndex, originalAction] of originalStage.actions.entries()) {
          const scopedAction = scopedStage.actions[actionIndex]!;
          expect(scopedAction.id).toBe(`${faction}-${originalAction.id}`);
          if (originalAction.id === 'beacon-amnesty') {
            expect(scopedAction.entry.en).toContain('has not erased the charges');
            expect(scopedAction.entry.ru).toContain('не сняло обвинений');
          } else expect(scopedAction.entry).toEqual(originalAction.entry);
          expect(scopedAction.response).toEqual(originalAction.response);
          expect(scopedAction.reputation).toEqual(originalAction.reputation);
        }
        for (const variant of originalStage.variants ?? []) {
          const scopedId = `${faction}-${variant.after}`;
          if (actionIds.has(scopedId)) expect(scopedStage.variants).toContainEqual({ ...variant, after: scopedId });
        }
      }
    }
    const bellChoices = side.find(quest => quest.id === `${faction}-bell-metal`)!.stages.at(-1)!.actions;
    expect(bellChoices.map(action => action.id)).toEqual([`${faction}-bell-mourn`, `${faction}-bell-road`]);
    const watches = side.find(quest => quest.id === `${faction}-stag-oath`)!.stages.at(-1)!.actions;
    expect(watches.map(action => action.id)).toEqual([`${faction}-stag-dependents`, `${faction}-stag-secret`]);
  });

  test('remembers at least three independent side outcomes even before any main campaign progress', () => {
    const seen = new Set<string>();
    let recalled = 0;
    for (const quest of side) for (const stage of quest.stages) {
      if (stage.variants?.some(variant => seen.has(variant.after))) recalled++;
      seen.add(stage.actions[0]!.id);
    }
    expect(recalled).toBeGreaterThanOrEqual(3);
    const orchard = side.find(quest => quest.id === `${faction}-orchard-claim`)!.stages[2]!;
    for (const directive of main[0]!.stages[3]!.actions) {
      expect(orchard.variants?.some(variant => variant.after === directive.id)).toBe(true);
    }
  });

  test('shares physical evidence without inheriting the generic hired-captain plot', () => {
    for (const id of ['names-stones', 'river-plates', 'winter-tides', 'winter-glass', 'weight-order', 'weight-census', 'road-names', 'road-index']) {
      const originalStage = QUESTS.flatMap(quest => quest.stages).find(stage => stage.actions[0]?.id === id)!;
      const currentStage = main.flatMap(quest => quest.stages).find(stage => stage.actions[0]?.id === `${faction}-${id}`)!;
      expect(currentStage.kind).toBe('inspect');
      expect(currentStage.prompt).toEqual(originalStage.prompt);
      expect(currentStage.at).toBe(originalStage.at);
    }
    const oldMain = QUESTS.filter(quest => quest.kind === 'main');
    const oldPrompts = new Set(oldMain.flatMap(quest => quest.stages.filter(stage => stage.kind === 'talk').map(stage => stage.prompt.en)));
    for (const stage of main.flatMap(quest => quest.stages).filter(stage => stage.kind === 'talk')) {
      expect(oldPrompts.has(stage.prompt.en), stage.at).toBe(false);
    }
    expect(story.npcs.find(npc => npc.id === 'mara')!.greeting).not.toEqual(NPCS.find(npc => npc.id === 'mara')!.greeting);
    expect(story.npcs.find(npc => npc.id === 'elin')!.localQuestion.en).not.toContain('convoy captain');
  });

  test('enacts all three resolutions only after conquest and requires both cooperative side outcomes', () => {
    expect(Object.keys(story.endings).sort()).toEqual([...endings].sort());
    expect(Object.keys(story.epilogues).sort()).toEqual([...endings].sort());
    const finale = main.at(-1)!.stages.at(-1)!;
    expect(finale.at).toBe('elin');
    const finalActions = allActions.filter(action => action.ending !== undefined);
    expect(finale.actions).toEqual(finalActions);
    expect(finalActions.map(action => action.ending)).toEqual(endings);
    for (const action of finalActions) {
      expect(action.id).toBe(`${faction}-ending-${action.ending}`);
      expect(action.gate).toBe('conquest');
      if (action.ending === 'commons') {
        expect(action.requiresActions).toEqual([`${faction}-bell-mourn`, `${faction}-stag-dependents`]);
      } else expect(action.requiresActions).toBeUndefined();
    }
    expect(story.epilogues.compact.en).toMatch(/confine|cannot|only as far|no.*replace/i);
    expect(story.epilogues.cinder.en).toMatch(/daylight/);
    expect(story.epilogues.cinder.ru).toMatch(/засветло|дневн/);
  });
});

test('all three perspectives have disjoint campaign/action IDs and nine distinct endings in both languages', () => {
  const stories = factions.map(getFactionStory);
  const questIds = stories.flatMap(story => story.quests.map(quest => quest.id));
  const actionIds = stories.flatMap(story => actions(story).map(action => action.id));
  expect(new Set(questIds).size).toBe(questIds.length);
  expect(new Set(actionIds).size).toBe(actionIds.length);
  for (const language of ['en', 'ru'] as const) {
    expect(new Set(stories.map(story => story.title[language])).size).toBe(3);
    expect(new Set(stories.flatMap(story => Object.values(story.endings).map(line => line[language]))).size).toBe(9);
    expect(new Set(stories.flatMap(story => Object.values(story.epilogues).map(line => line[language]))).size).toBe(9);
    for (let index = 0; index < 5; index++) {
      const chapters = stories.map(story => story.quests.filter(quest => quest.kind === 'main')[index]!);
      expect(new Set(chapters.map(quest => quest.title[language])).size).toBe(3);
      expect(new Set(chapters.map(quest => quest.description[language])).size).toBe(3);
      expect(new Set(chapters.map(quest => quest.stages[0]!.prompt[language])).size).toBe(3);
    }
  }
  for (const epilogue of Object.values(getFactionStory('villain').epilogues)) {
    expect(epilogue.en).not.toMatch(/Raut (?:is dead|is defeated|falls|is killed)/);
    expect(epilogue.ru).not.toMatch(/Раут (?:мёртв|побеждён|пал|убит)/);
  }
});

test('building faction stories leaves shared authoring and independent NPC roles intact', () => {
  expect(QUESTS[0]!.id).toBe('missing-names');
  expect(NPCS.find(npc => npc.id === 'ren')!.locationId).toBe('roadward');
  expect(getFactionStory('guard').npcs.find(npc => npc.id === 'ren')!.locationId).toBe('roadward');
  expect(getFactionStory('elf').npcs.find(npc => npc.id === 'ren')!.locationId).toBe('roadward');
  expect(getFactionStory('villain').npcs.find(npc => npc.id === 'ren')!.locationId).toBe('old-fort');
  for (const faction of factions) {
    expect(getFactionStory(faction).npcs.find(npc => npc.id === 'sella')!.faction).toBe('villain');
    expect(getFactionStory(faction).npcs.find(npc => npc.id === 'ivet')!.faction).toBe('guard');
    expect(getFactionStory(faction).npcs.find(npc => npc.id === 'mara')!.locationId).toBe('roadward');
  }
});
