import { describe, expect, test } from 'vitest';
import { getFactionStory } from '../src/game/faction-stories';
import { factionCampaignSnapshot, militaryReady } from '../src/game/faction-campaigns';
import { narrativeSnapshot } from '../src/game/narrative';
import {
  createVoiceCatalogue, factions, journalBefore, languages, militarySpeakers, militaryStates,
  normalizeVoiceText, scene, splitVoiceBlocks, voiceKey, voiceState, voiceWorld,
} from '../scripts/voices/catalogue';
import type { FactionId, NarrativeSnapshot } from '../src/game/types';
import cast from '../scripts/voices/cast.json';
import samples from '../scripts/voices/faction-samples.json';

const entries = createVoiceCatalogue();
const keys = new Set(entries.map(e => voiceKey(e.speaker, e.language, e.text)));
function covered(snapshot: NarrativeSnapshot): void {
  const lines = [
    ...(snapshot.dialogue ? [{ speaker: snapshot.dialogue.npcId, text: snapshot.dialogue.text },
      ...snapshot.dialogue.choices.map(c => ({ speaker: 'player', text: c.text }))] : []),
    ...(snapshot.inspection ? [{ speaker: 'narrator', text: snapshot.inspection.text }] : []),
    ...(snapshot.ending ? [{ speaker: 'narrator', text: snapshot.ending }] : []),
  ];
  for (const line of lines) for (const language of languages) for (const text of splitVoiceBlocks(line.text[language])) {
    expect(keys.has(voiceKey(line.speaker, language, text)), `${language}/${line.speaker}: ${text}`).toBe(true);
  }
}

function inspect(faction: FactionId, journal: string[], locationId: string, actionIds: string[]): void {
  const state = voiceState(faction, journal, true);
  state.narrative!.inspection = { locationId, actionIds };
  covered(narrativeSnapshot(state, voiceWorld(faction), []));
}

describe('complete faction-aware exact-match bilingual voice inventory', () => {
  test('stable content IDs, all cast profiles and reconstructable line segments', () => {
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
    expect(keys.size).toBe(entries.length);
    expect(createVoiceCatalogue()).toEqual(entries);
    for (const faction of factions) {
      const { npcs } = getFactionStory(faction);
      expect(npcs).toHaveLength(20);
      expect(Object.keys(cast.profiles).sort()).toEqual([...npcs.map(n => n.id), 'player', 'narrator'].sort());
      for (const speaker of [...npcs.map(n => n.id), 'player', 'narrator']) for (const language of languages) {
        expect(entries.some(e => e.speaker === speaker && e.language === language &&
          e.sources.some(s => s.startsWith(`faction.${faction}.`)))).toBe(true);
      }
    }
    expect(cast.model).toBe('MAI-Voice-2');
    expect(cast.pronunciation_mode).toBe('natural-reviewed');
    expect(Object.values(cast.engines).sort()).toEqual([
      'en-US-Ethan:MAI-Voice-2', 'en-US-Grant:MAI-Voice-2',
      'en-US-Harper:MAI-Voice-2', 'en-US-Olivia:MAI-Voice-2',
      'ru-RU-Lev:MAI-Voice-2', 'ru-RU-Masha:MAI-Voice-2',
    ]);
    for (const profile of Object.values(cast.profiles)) for (const language of languages) {
      const [engine, rate, pitch] = profile[language];
      expect(Object.hasOwn(cast.engines, engine!)).toBe(true);
      const voice = Object.entries(cast.engines).find(([id]) => id === engine)?.[1];
      expect(voice?.startsWith(language === 'ru' ? 'ru-RU-' : 'en-US-')).toBe(true);
      expect(rate).toBe(0);
      expect(pitch).toBe(0);
    }
    for (const role of [...samples, ...cast.auditions]) for (const language of languages) {
      const selected = entries.filter(e => e.language === language && e.speaker === role.speaker && e.sources.includes(role.source));
      expect(selected).toHaveLength(1);
      if ('segment_indices' in role) for (const index of role.segment_indices ?? []) {
        expect(selected[0]!.segments[index]).toBeDefined();
      }
    }
    for (const entry of entries) {
      expect(entry.segments.map(s => s.text).join(' ').replace(/\s+/g, ' ')).toBe(entry.text.replace(/\s+/g, ' '));
      expect(entry.text).toBe(normalizeVoiceText(entry.text));
      expect(entry.segments.length).toBeGreaterThan(0);
    }
    expect(splitVoiceBlocks(' \r\nTitle\r\nOutcome\r\n\r\nNext ')).toEqual(['Title\nOutcome', 'Next']);
    expect(entries.flatMap(e => e.segments).some(s => /^[IVX]+\.$/.test(s.text))).toBe(false);
  });

  test.each(factions)('%s: every stage, choice, response and conditional prompt in actual snapshots', faction => {
    const { quests } = getFactionStory(faction);
    for (const quest of quests) for (const [index, stage] of quest.stages.entries()) {
      for (const conditions of [[], ...(stage.variants ?? []).map(v => [v.after])]) {
        const journal = journalBefore(faction, quest, index, conditions);
        if (stage.kind === 'talk') {
          covered(scene(voiceState(faction, journal, true), stage.at, `quest-${quest.id}`));
          for (const action of stage.actions) {
            const incompatible = action.requiresActions?.some(required =>
              quests.flatMap(q => q.stages).find(s => s.actions.some(a => a.id === required))!
                .actions.some(a => a.id !== required && conditions.includes(a.id)));
            if (incompatible) continue;
            const chosen = journalBefore(faction, quest, index + 1, [...conditions, action.id]);
            const after = voiceState(faction, chosen, true);
            covered(scene(after, stage.at, action.id));
            covered(scene(after, stage.at));
          }
        } else {
          inspect(faction, [...journal, stage.actions[0]!.id], stage.at, [stage.actions[0]!.id]);
        }
      }
    }
  });

  test.each(factions)('%s: all topics, reactions and inspection fallbacks', faction => {
    const { quests, npcs } = getFactionStory(faction);
    for (const npc of npcs) {
      for (const topic of [null, 'topic-local', 'topic-belief']) covered(scene(voiceState(faction), npc.id, topic));
      for (const reaction of npc.reactions ?? []) {
        const quest = quests.find(q => q.stages.some(s => s.actions.some(a => a.id === reaction.after)))!;
        const index = quest.stages.findIndex(s => s.actions.some(a => a.id === reaction.after));
        covered(scene(voiceState(faction, journalBefore(faction, quest, index + 1, [reaction.after])), npc.id));
      }
    }
    for (const at of voiceWorld(faction).exploration!.locations) {
      if (at.kind !== 'ruin' && at.kind !== 'shrine' &&
        !quests.some(q => q.stages.some(s => s.kind === 'inspect' && s.at === at.id))) continue;
      inspect(faction, [], at.id, []);
    }
  });

  test.each(factions)('%s: all reachable military projections preserve exact single-newline lists', faction => {
    const { quests } = getFactionStory(faction);
    const finalQuest = quests.find(q => q.stages.some(s => s.actions.some(a => a.ending)))!;
    const finalStage = finalQuest.stages.at(-1)!;
    const projectionKeys = new Set<string>();
    for (const state of militaryStates(faction)) {
      const requirements = factionCampaignSnapshot(state).requirements;
      const complete = (id: string) => requirements.find(r => r.id === id)?.complete ?? false;
      expect(state.fortress.bossDefeated && !militaryReady(state)).toBe(false);
      if (!state.military!.directive) expect(requirements.filter(r => r.complete).every(r => r.id === 'defense')).toBe(true);
      if (faction === 'guard') {
        if (!complete('defense')) expect(complete('shipment') || complete('post-palace') || complete('post-quarry')).toBe(false);
        if (complete('post-quarry')) expect(complete('shipment') && complete('post-palace')).toBe(true);
      }
      const projectionKey = JSON.stringify([state.military!.directive, requirements.map(r => r.complete)]);
      expect(projectionKeys.has(projectionKey)).toBe(false);
      projectionKeys.add(projectionKey);
      for (const id of militarySpeakers(faction)) covered(scene(state, id, 'topic-war'));
      if (state.military!.directive) {
        const directiveAction = quests.flatMap(q => q.stages.flatMap(s => s.actions))
          .find(a => a.directive === state.military!.directive)!;
        state.narrative!.journal = journalBefore(faction, finalQuest, finalQuest.stages.length - 1, [directiveAction.id]);
        covered(scene(state, finalStage.at, `quest-${finalQuest.id}`));
      }
    }
  });

  test.each(factions)('%s: every ending, intermediate main branch, side outcome and unresolved recap', faction => {
    const { quests } = getFactionStory(faction);
    const finalQuest = quests.find(q => q.stages.some(s => s.actions.some(a => a.ending)))!;
    const endings = finalQuest.stages.at(-1)!.actions;
    expect(endings).toHaveLength(3);
    for (const ending of endings) {
      const required = new Set(ending.requiresActions ?? []);
      const variants = quests.flatMap(q => q.stages.flatMap(stage =>
        stage.actions.length > 1 && !stage.actions.some(a => a.ending) ?
          stage.actions.filter(a => !stage.actions.some(other => other.id !== a.id && required.has(other.id))).map(a => a.id) : []));
      for (const conditions of [[ending.id], ...variants.map(id => [id, ending.id])]) {
        const journal = journalBefore(faction, finalQuest, finalQuest.stages.length, conditions);
        covered(scene(voiceState(faction, journal, true)));
      }
    }
  });
});
