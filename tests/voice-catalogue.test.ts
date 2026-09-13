import { describe, expect, test } from 'vitest';
import { NPCS, QUESTS } from '../src/game/narrative-data';
import { narrativeSnapshot } from '../src/game/narrative';
import {
  createVoiceCatalogue, journalBefore, languages, normalizeVoiceText, scene, splitVoiceBlocks,
  voiceKey, voiceState, voiceWorld,
} from '../scripts/voices/catalogue';
import type { NarrativeSnapshot } from '../src/game/types';
import cast from '../scripts/voices/cast.json';

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

describe('complete exact-match bilingual voice inventory', () => {
  test('stable IDs, all 20 NPCs, both languages and segment reconstruction', () => {
    expect(NPCS).toHaveLength(20);
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
    expect(keys.size).toBe(entries.length);
    expect(createVoiceCatalogue()).toEqual(entries);
    for (const speaker of [...NPCS.map(n => n.id), 'player', 'narrator']) for (const language of languages) {
      expect(entries.some(e => e.speaker === speaker && e.language === language)).toBe(true);
    }
    for (const entry of entries) {
      expect(entry.segments.map(s => s.text).join(' ').replace(/\s+/g, ' ')).toBe(entry.text.replace(/\s+/g, ' '));
      expect(entry.text).toBe(normalizeVoiceText(entry.text));
      expect(entry.segments.length).toBeGreaterThan(0);
    }
    expect(splitVoiceBlocks(' \r\nTitle\r\nOutcome\r\n\r\nNext ')).toEqual(['Title\nOutcome', 'Next']);
    expect(entries.flatMap(e => e.segments).some(s => /^[IVX]+\.$/.test(s.text))).toBe(false);
  });

  test('cast profiles cover exactly the authored roles with controlled available engines', () => {
    expect(Object.keys(cast.profiles).sort()).toEqual([...NPCS.map(n => n.id), 'player', 'narrator'].sort());
    expect(Object.values(cast.engines).filter(v => v.startsWith('ru-RU-'))).toHaveLength(3);
    expect(Object.values(cast.engines).filter(v => v.startsWith('en-GB-'))).toHaveLength(4);
    for (const profile of Object.values(cast.profiles)) for (const language of languages) {
      const [engine, rate, pitch] = profile[language];
      expect(Object.hasOwn(cast.engines, engine!)).toBe(true);
      expect(typeof rate).toBe('number');
      expect(typeof pitch).toBe('number');
      expect(rate).toBeGreaterThanOrEqual(-15);
      expect(rate).toBeLessThanOrEqual(5);
      expect(pitch).toBeGreaterThanOrEqual(-10);
      expect(pitch).toBeLessThanOrEqual(5);
    }
    for (const role of cast.auditions) for (const language of languages) {
      expect(entries.filter(e => e.language === language && e.speaker === role.speaker && e.sources.includes(role.source))).toHaveLength(1);
    }
  });

  test('every authored stage, choice, response and conditional prompt in real snapshots', () => {
    for (const quest of QUESTS) for (const [index, stage] of quest.stages.entries()) {
      for (const conditions of [[], ...(stage.variants ?? []).map(v => [v.after])]) {
        const journal = journalBefore(quest, index, conditions);
        const state = voiceState(journal, 2);
        if (stage.kind === 'talk') {
          covered(scene(state, stage.at, `quest-${quest.id}`));
          for (const action of stage.actions) {
            const incompatible = action.requiresActions?.some(required =>
              QUESTS.flatMap(q => q.stages).find(s => s.actions.some(a => a.id === required))!
                .actions.some(a => a.id !== required && conditions.includes(a.id)));
            if (incompatible) continue;
            const chosen = journalBefore(quest, index + 1, [...conditions, action.id]);
            const after = voiceState(chosen, 2);
            covered(scene(after, stage.at, action.id));
            covered(scene(after, stage.at));
          }
        } else {
          state.narrative!.journal.push(stage.actions[0]!.id);
          state.narrative!.inspection = { locationId: stage.at, actionIds: [stage.actions[0]!.id] };
          covered(narrativeSnapshot(state, voiceWorld, []));
        }
      }
    }
  });

  test('all speakers and topic choices, all three military conditions, reactions and fallbacks', () => {
    for (const npc of NPCS) {
      for (const topic of [null, 'topic-local', 'topic-belief']) covered(scene(voiceState(), npc.id, topic));
      for (const reaction of npc.reactions ?? []) {
        const quest = QUESTS.find(q => q.stages.some(s => s.actions.some(a => a.id === reaction.after)))!;
        const index = quest.stages.findIndex(s => s.actions.some(a => a.id === reaction.after));
        covered(scene(voiceState(journalBefore(quest, index + 1, [reaction.after])), npc.id));
      }
    }
    for (const id of ['mara', 'ren', 'elin']) for (const military of [0, 1, 2]) {
      covered(scene(voiceState([], military), id, 'topic-war'));
    }
    for (const at of voiceWorld.exploration!.locations) {
      if (at.kind !== 'ruin' && at.kind !== 'shrine' &&
        !QUESTS.some(q => q.stages.some(s => s.kind === 'inspect' && s.at === at.id))) continue;
      const state = voiceState();
      state.narrative!.inspection = { locationId: at.id, actionIds: [] };
      covered(narrativeSnapshot(state, voiceWorld, []));
    }
  });

  test('pending and terminal endings, every side outcome and unresolved title block', () => {
    const finalQuest = QUESTS.find(q => q.id === 'unwritten-road')!;
    for (const ending of finalQuest.stages.at(-1)!.actions) {
      const base = [ending.id];
      const variations = [base, ...QUESTS.filter(q => q.kind === 'side').flatMap(q =>
        q.stages.at(-1)!.actions.filter(a => ending.ending !== 'commons' ||
          !['bell-road', 'stag-secret'].includes(a.id)).map(a => [...base, a.id]))];
      for (const conditions of variations) for (const military of [1, 2]) {
        const journal = journalBefore(finalQuest, finalQuest.stages.length, conditions);
        covered(scene(voiceState(journal, military)));
      }
    }
  });
});
