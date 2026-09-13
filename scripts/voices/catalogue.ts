import { createHash } from 'node:crypto';
import { NPCS, QUESTS, ENDINGS, ENDING_EPILOGUES, type StoryQuest } from '../../src/game/narrative-data';
import { createNarrative, narrativeSnapshot } from '../../src/game/narrative';
import { createCampaign } from '../../src/game/simulation';
import type { CampaignData } from '../../src/game/state';
import type { LocalizedText, NarrativeSnapshot } from '../../src/game/types';

export type VoiceLanguage = 'ru' | 'en';
export interface VoiceEntry {
  id: string;
  speaker: string;
  language: VoiceLanguage;
  text: string;
  sourceSha256: string;
  sources: string[];
  segments: { id: string; text: string; sourceSha256: string }[];
}
export const languages: VoiceLanguage[] = ['ru', 'en'];
export const normalizeVoiceText = (value: string): string => value.replace(/\r\n/g, '\n').trim();
export const splitVoiceBlocks = (value: string): string[] =>
  normalizeVoiceText(value).split(/\n\s*\n/).map(normalizeVoiceText).filter(Boolean);
export const voiceKey = (speaker: string, language: VoiceLanguage, value: string): string =>
  JSON.stringify([speaker, language, normalizeVoiceText(value)]);
export const hashText = (value: string): string => createHash('sha256').update(value).digest('hex');

function segments(text: string, language: VoiceLanguage): string[] {
  const result: string[] = [];
  const sentences = [...new Intl.Segmenter(language, { granularity: 'sentence' }).segment(text)].map(s => s.segment.trim());
  for (let index = 0; index < sentences.length; index++) {
    let sentence = sentences[index]!;
    if (/^[IVX]+\.$/.test(sentence) && sentences[index + 1]) sentence += ` ${sentences[++index]}`;
    const words = sentence.split(/\s+/);
    // Keep recognition requests short; sentence fragments retain their exact words.
    while (words.length) result.push(words.splice(0, 38).join(' '));
  }
  return result;
}

const template = createCampaign({ seed: 'voice-catalogue-v1', faction: 'guard' }).snapshot();
export const voiceWorld = template.world;

export function voiceState(journal: string[] = [], military = 0): CampaignData {
  const state: CampaignData = {
    ...structuredClone(template),
    worldId: voiceWorld.id, phase: 'playing', projectiles: [],
    raidComplete: military > 0, eventSequence: 0, transientSequence: 0, spawnSequence: 0,
    followTimer: 0, convoyWeaponTimer: 0, reinforcementTimer: 0, dodgeDirection: { x: 0, z: 1 },
    narrative: createNarrative(voiceWorld),
  };
  state.narrative!.journal = [...journal];
  state.narrative!.discovered = voiceWorld.exploration!.locations.map(at => at.id);
  state.narrative!.rewardedQuestIds = QUESTS.filter(q =>
    q.stages.at(-1)!.actions.some(action => journal.includes(action.id))).map(q => q.id);
  state.fortress.bossDefeated = military === 2;
  for (const post of state.outposts) { post.owner = 'player'; post.supplied = military > 0; }
  return state;
}

export function scene(state: CampaignData, npcId?: string, topicId: string | null = null): NarrativeSnapshot {
  state.narrative!.inspection = null;
  state.narrative!.dialogue = npcId ? { npcId, topicId } : null;
  if (npcId) {
    const npc = NPCS.find(n => n.id === npcId)!;
    const at = voiceWorld.exploration!.locations.find(at => at.id === npc.locationId)!;
    state.player.x = at.x;
    state.player.z = at.z;
  }
  return narrativeSnapshot(state, voiceWorld, []);
}

/** Build ordered, branch-exclusive histories without enumerating irrelevant cross-products. */
export function journalBefore(quest: StoryQuest, count: number, conditions: string[] = []): string[] {
  const journal: string[] = [];
  const counts = new Map<string, number>();
  const choices = new Map<string, string>();
  for (const id of conditions) {
    const q = QUESTS.find(q => q.stages.some(s => s.actions.some(a => a.id === id)));
    if (!q) throw new Error(`Unknown voice fixture condition ${id}`);
    const index = q.stages.findIndex(s => s.actions.some(a => a.id === id));
    const key = `${q.id}:${index}`;
    if (choices.has(key) && choices.get(key) !== id) throw new Error(`Conflicting voice fixture ${key}`);
    choices.set(key, id);
  }
  const complete = (q: StoryQuest, target: number): void => {
    if (q.requires) complete(QUESTS.find(other => other.id === q.requires)!, Number.MAX_SAFE_INTEGER);
    while ((counts.get(q.id) ?? 0) < Math.min(target, q.stages.length)) {
      const index = counts.get(q.id) ?? 0;
      const stage = q.stages[index]!;
      const action = stage.actions.find(a => a.id === choices.get(`${q.id}:${index}`)) ?? stage.actions[0]!;
      for (const required of action.requiresActions ?? []) {
        const other = QUESTS.find(q => q.stages.some(s => s.actions.some(a => a.id === required)))!;
        const step = other.stages.findIndex(s => s.actions.some(a => a.id === required));
        if (choices.has(`${other.id}:${step}`) && choices.get(`${other.id}:${step}`) !== required) {
          throw new Error(`Unsatisfied voice fixture ally ${required}`);
        }
        choices.set(`${other.id}:${step}`, required);
        complete(other, step + 1);
      }
      journal.push(action.id);
      counts.set(q.id, index + 1);
    }
  };
  for (const id of conditions) {
    const other = QUESTS.find(q => q.stages.some(s => s.actions.some(a => a.id === id)))!;
    const step = other.stages.findIndex(s => s.actions.some(a => a.id === id));
    if (other.id !== quest.id || step < count) complete(other, step + 1);
  }
  complete(quest, count);
  return journal;
}

export function createVoiceCatalogue(): VoiceEntry[] {
  const entries = new Map<string, VoiceEntry>();
  const add = (speaker: string, line: LocalizedText, source: string): void => {
    for (const language of languages) for (const text of splitVoiceBlocks(line[language])) {
      const key = voiceKey(speaker, language, text);
      const prior = entries.get(key);
      if (prior) {
        if (!prior.sources.includes(source)) prior.sources.push(source);
        continue;
      }
      const sourceSha256 = hashText(text);
      const id = `${language}-${speaker}-${sourceSha256.slice(0, 16)}`;
      entries.set(key, { id, speaker, language, text, sourceSha256, sources: [source],
        segments: segments(text, language).map((text, index) => ({
          id: `${id}.${String(index + 1).padStart(3, '0')}`, text, sourceSha256: hashText(text),
        })) });
    }
  };
  for (const npc of NPCS) {
    for (const kind of ['greeting', 'local', 'belief'] as const) add(npc.id, npc[kind], `npc.${npc.id}.${kind}`);
    for (const kind of ['localQuestion', 'beliefQuestion'] as const) add('player', npc[kind], `npc.${npc.id}.${kind}`);
    for (const reaction of npc.reactions ?? []) add(npc.id, reaction.text, `npc.${npc.id}.after.${reaction.after}`);
  }
  for (const quest of QUESTS) {
    add('player', quest.title, `quest.${quest.id}.topic`);
    for (const [index, stage] of quest.stages.entries()) {
      const source = `quest.${quest.id}.stage.${index}`;
      const speaker = stage.kind === 'talk' ? stage.at : 'narrator';
      add(speaker, stage.prompt, `${source}.prompt`);
      for (const variant of stage.variants ?? []) add(speaker, variant.prompt, `${source}.after.${variant.after}`);
      for (const action of stage.actions) {
        if (stage.kind === 'talk') {
          add('player', action.text, `action.${action.id}.choice`);
          add(speaker, action.response, `action.${action.id}.response`);
        }
      }
    }
  }
  for (const at of voiceWorld.exploration!.locations) {
    if (at.kind === 'ruin' || at.kind === 'shrine' ||
      QUESTS.some(q => q.stages.some(s => s.kind === 'inspect' && s.at === at.id))) {
      add('narrator', at.description, `inspection.${at.id}.fallback`);
    }
  }
  // These strings are assembled by narrative.ts, never copied into the voice source.
  for (const npcId of ['mara', 'ren', 'elin']) for (const military of [0, 1, 2]) {
    const snapshot = scene(voiceState([], military), npcId, 'topic-war');
    add(npcId, snapshot.dialogue!.text, `military.${npcId}.${military}`);
    for (const choice of snapshot.dialogue!.choices) {
      if (choice.id === 'leave' || choice.id === 'topic-war') add('player', choice.text, `choice.${choice.id}`);
    }
  }
  const finalQuest = QUESTS.find(q => q.id === 'unwritten-road')!;
  for (const ending of finalQuest.stages.at(-1)!.actions) {
    const journal = journalBefore(finalQuest, finalQuest.stages.length, [ending.id]);
    for (const military of [1, 2]) {
      const snapshot = scene(voiceState(journal, military));
      add('narrator', snapshot.ending!, `epilogue.${ending.id}.${military}`);
    }
  }
  // Side outcomes are title + single newline + paragraph, not independently keyed sentences.
  for (const quest of QUESTS.filter(q => q.kind === 'side')) {
    for (const [index, outcome] of [quest.unresolved, ...quest.stages.at(-1)!.actions.map(a => a.entry)].entries()) {
      add('narrator', { en: `${quest.title.en}\n${outcome.en}`, ru: `${quest.title.ru}\n${outcome.ru}` },
        `epilogue.side.${quest.id}.${index}`);
    }
  }
  for (const quest of QUESTS.filter(q => q.kind === 'main' && q.id !== finalQuest.id)) {
    for (const action of quest.stages.at(-1)!.actions) add('narrator', action.entry, `epilogue.main.${action.id}`);
  }
  for (const ending of Object.keys(ENDINGS) as (keyof typeof ENDINGS)[]) {
    add('narrator', ENDINGS[ending], `epilogue.title.${ending}`);
    add('narrator', ENDING_EPILOGUES[ending], `epilogue.root.${ending}`);
  }
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function inventorySummary(entries: VoiceEntry[]) {
  const summarize = (items: VoiceEntry[]) => {
    const characters = items.reduce((sum, entry) => sum + entry.text.length, 0);
    const words = items.reduce((sum, entry) => sum + entry.text.split(/\s+/).length, 0);
    return { entries: items.length, segments: items.reduce((sum, entry) => sum + entry.segments.length, 0),
      characters, words, minutesAt130Wpm: Math.round(words / 130 * 10) / 10,
      minutesAt155Wpm: Math.round(words / 155 * 10) / 10,
      illustrativeUsdAt15PerMillionCharacters: Math.round(characters * 15 / 1_000_000 * 100) / 100 };
  };
  return {
    npcCount: NPCS.length, speakerCount: new Set(entries.map(entry => entry.speaker)).size,
    total: summarize(entries),
    languages: Object.fromEntries(languages.map(language => [language, summarize(entries.filter(e => e.language === language))])),
    speakers: Object.fromEntries([...new Set(entries.map(e => e.speaker))].map(speaker =>
      [speaker, Object.fromEntries(languages.map(language =>
        [language, summarize(entries.filter(e => e.speaker === speaker && e.language === language))]))])),
    scope: 'All authored dialogue/choice branches, inspectable fallbacks, pending and terminal epilogues. Includes conservative default prompts even when a prior branch necessarily selects a variant.',
    estimateNote: 'Unique corpus, not one playthrough. USD is an illustrative standard-neural rate, not an Azure quote; excludes SSML billing overhead, probes and assessment.',
  };
}
