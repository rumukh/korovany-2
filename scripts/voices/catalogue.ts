import { createHash } from 'node:crypto';
import type { StoryQuest } from '../../src/game/narrative-data';
import { getFactionStory } from '../../src/game/faction-stories';
import { createMilitary, DIRECTIVES, FACTION_CAMPAIGNS, requiredPosts } from '../../src/game/faction-campaigns';
import { createNarrative, narrativeSnapshot } from '../../src/game/narrative';
import { createCampaign } from '../../src/game/simulation';
import type { CampaignData } from '../../src/game/state';
import type { FactionId, LocalizedText, NarrativeSnapshot } from '../../src/game/types';

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
export const factions: FactionId[] = ['elf', 'guard', 'villain'];
export const normalizeVoiceText = (value: string): string => value.replace(/\r\n?/g, '\n').trim();
export const splitVoiceBlocks = (value: string): string[] =>
  normalizeVoiceText(value).split(/\n\s*\n/).map(normalizeVoiceText).filter(Boolean);
export const voiceKey = (speaker: string, language: VoiceLanguage, value: string): string =>
  JSON.stringify([speaker, language, normalizeVoiceText(value)]);
export const hashText = (value: string): string => createHash('sha256').update(value).digest('hex');

function segments(text: string, language: VoiceLanguage, splitLines: boolean): string[] {
  const result: string[] = [];
  const sentences = (splitLines ? text.split('\n') : [text]).flatMap(line =>
    [...new Intl.Segmenter(language, { granularity: 'sentence' }).segment(line)].map(s => s.segment.trim()));
  for (let index = 0; index < sentences.length; index++) {
    let sentence = sentences[index]!;
    if (/^[IVX]+\.$/.test(sentence) && sentences[index + 1]) sentence += ` ${sentences[++index]}`;
    const words = sentence.split(/\s+/);
    // Keep recognition requests short; sentence fragments retain their exact words.
    while (words.length) result.push(words.splice(0, 38).join(' '));
  }
  return result;
}

const templates = new Map(factions.map(faction =>
  [faction, createCampaign({ seed: 'voice-catalogue-v1', faction }).snapshot()]));
export const voiceWorld = (faction: FactionId) => templates.get(faction)!.world;

export function voiceState(faction: FactionId, journal: string[] = [], militaryComplete = false): CampaignData {
  const template = templates.get(faction)!;
  const world = voiceWorld(faction);
  const { quests } = getFactionStory(faction);
  const state: CampaignData = {
    ...structuredClone(template),
    worldId: world.id, phase: 'playing', projectiles: [],
    raidComplete: militaryComplete, eventSequence: 0, transientSequence: 0, spawnSequence: 0,
    followTimer: 0, convoyWeaponTimer: 0, reinforcementTimer: 0, dodgeDirection: { x: 0, z: 1 },
    narrative: createNarrative(world, faction), military: createMilitary(),
  };
  state.narrative!.journal = [...journal];
  state.narrative!.discovered = world.exploration!.locations.map(at => at.id);
  state.narrative!.rewardedQuestIds = quests.filter(q =>
    q.stages.at(-1)!.actions.some(action => journal.includes(action.id))).map(q => q.id);
  state.military!.directive = quests.flatMap(q => q.stages.flatMap(s => s.actions))
    .find(action => action.directive && journal.includes(action.id))?.directive ?? null;
  if (militaryComplete) {
    state.military!.directive ??= DIRECTIVES[faction][0]!;
    state.military!.shipment.claimed = true;
    state.military!.shipment.delivered = true;
    state.fortress.unlocked = true;
    state.fortress.bossDefeated = true;
    for (const post of state.outposts) { post.owner = 'player'; post.supplied = true; post.defendersRemaining = 0; }
  }
  return state;
}

export function scene(state: CampaignData, npcId?: string, topicId: string | null = null): NarrativeSnapshot {
  const world = voiceWorld(state.faction);
  state.narrative!.inspection = null;
  state.narrative!.dialogue = npcId ? { npcId, topicId } : null;
  if (npcId) {
    const npc = getFactionStory(state.faction).npcs.find(n => n.id === npcId)!;
    const at = world.exploration!.locations.find(at => at.id === npc.locationId)!;
    state.player.x = at.x;
    state.player.z = at.z;
  }
  return narrativeSnapshot(state, world, []);
}

/** Build ordered, branch-exclusive histories without enumerating irrelevant cross-products. */
export function journalBefore(faction: FactionId, quest: StoryQuest, count: number, conditions: string[] = []): string[] {
  const QUESTS = getFactionStory(faction).quests;
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

/** Reachable requirement projections, not arbitrary subsets of the displayed checklist. */
export function militaryStates(faction: FactionId): CampaignData[] {
  const result: CampaignData[] = [];
  for (const directive of [null, ...DIRECTIVES[faction]]) {
    const seed = voiceState(faction);
    seed.military!.directive = directive;
    const posts = requiredPosts(seed);
    for (const defended of faction === 'guard' ? [false, true] : [true]) {
      for (const delivered of [false, true]) for (let mask = 0; mask < 2 ** posts.length; mask++) {
        if (directive === null && (delivered || mask !== 0)) continue;
        if (faction === 'guard' && (!defended && (delivered || mask !== 0) ||
          posts.includes('quarry') && (mask & 2) !== 0 && (!delivered || (mask & 1) === 0))) continue;
        const ready = directive !== null && delivered && mask === 2 ** posts.length - 1;
        for (const defeated of ready ? [false, true] : [false]) {
          const state = structuredClone(seed);
          if (faction === 'guard') state.outposts.find(p => p.id === 'palace')!.defendersRemaining = defended ? 0 : 1;
          state.military!.shipment.claimed = delivered;
          state.military!.shipment.delivered = delivered;
          state.raidComplete = delivered;
          state.fortress.unlocked = ready;
          state.fortress.bossDefeated = defeated;
          for (const [index, id] of posts.entries()) if ((mask & 2 ** index) !== 0) {
            const post = state.outposts.find(p => p.id === id)!;
            post.owner = 'player'; post.supplied = true; post.defendersRemaining = 0;
          }
          result.push(state);
        }
      }
    }
  }
  return result;
}

export function militarySpeakers(faction: FactionId): string[] {
  const story = getFactionStory(faction);
  return [...new Set([
    ...story.npcs.filter(npc => scene(voiceState(faction), npc.id).dialogue!.choices.some(c => c.id === 'topic-war')).map(npc => npc.id),
    ...story.quests.flatMap(q => q.stages.filter(s => s.kind === 'talk' && s.actions.some(a => a.ending)).map(s => s.at)),
  ])];
}

export function createVoiceCatalogue(): VoiceEntry[] {
  const entries = new Map<string, VoiceEntry>();
  const add = (speaker: string, line: LocalizedText, source: string, splitLines = false): void => {
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
        segments: segments(text, language, splitLines).map((text, index) => ({
          id: `${id}.${String(index + 1).padStart(3, '0')}`, text, sourceSha256: hashText(text),
        })) });
    }
  };
  for (const faction of factions) {
  const story = getFactionStory(faction), QUESTS = story.quests, NPCS = story.npcs;
  const prefix = `faction.${faction}.`;
  for (const npc of NPCS) {
    for (const kind of ['greeting', 'local', 'belief'] as const) add(npc.id, npc[kind], `${prefix}npc.${npc.id}.${kind}`);
    for (const kind of ['localQuestion', 'beliefQuestion'] as const) add('player', npc[kind], `${prefix}npc.${npc.id}.${kind}`);
    for (const reaction of npc.reactions ?? []) add(npc.id, reaction.text, `${prefix}npc.${npc.id}.after.${reaction.after}`);
  }
  for (const quest of QUESTS) {
    add('player', quest.title, `${prefix}quest.${quest.id}.topic`);
    for (const [index, stage] of quest.stages.entries()) {
      const source = `${prefix}quest.${quest.id}.stage.${index}`;
      const speaker = stage.kind === 'talk' ? stage.at : 'narrator';
      add(speaker, stage.prompt, `${source}.prompt`);
      for (const variant of stage.variants ?? []) add(speaker, variant.prompt, `${source}.after.${variant.after}`);
      for (const action of stage.actions) {
        if (stage.kind === 'talk') {
          add('player', action.text, `${prefix}action.${action.id}.choice`);
          add(speaker, action.response, `${prefix}action.${action.id}.response`);
        }
      }
    }
  }
  for (const at of voiceWorld(faction).exploration!.locations) {
    if (at.kind === 'ruin' || at.kind === 'shrine' ||
      QUESTS.some(q => q.stages.some(s => s.kind === 'inspect' && s.at === at.id))) {
      add('narrator', at.description, `${prefix}inspection.${at.id}.fallback`);
    }
  }
  // These strings are assembled by narrative.ts, never copied into the voice source.
  for (const npcId of militarySpeakers(faction)) for (const [index, state] of militaryStates(faction).entries()) {
    const snapshot = scene(state, npcId, 'topic-war');
    add(npcId, snapshot.dialogue!.text, `${prefix}military.${npcId}.${index}`, true);
    for (const choice of snapshot.dialogue!.choices) {
      if (choice.id === 'leave' || choice.id === 'topic-war') add('player', choice.text, `${prefix}choice.${choice.id}`);
    }
  }
  const finalQuest = QUESTS.find(q => q.stages.some(s => s.actions.some(a => a.ending)))!;
  for (const ending of finalQuest.stages.at(-1)!.actions) {
    const journal = journalBefore(faction, finalQuest, finalQuest.stages.length, [ending.id]);
    const snapshot = scene(voiceState(faction, journal, true));
    add('narrator', snapshot.ending!, `${prefix}epilogue.${ending.id}`);
  }
  // Side outcomes are title + single newline + paragraph, not independently keyed sentences.
  for (const quest of QUESTS.filter(q => q.kind === 'side')) {
    for (const [index, outcome] of [quest.unresolved, ...quest.stages.at(-1)!.actions.map(a => a.entry)].entries()) {
      add('narrator', { en: `${quest.title.en}\n${outcome.en}`, ru: `${quest.title.ru}\n${outcome.ru}` },
        `${prefix}epilogue.side.${quest.id}.${index}`);
    }
  }
  for (const quest of QUESTS.filter(q => q.kind === 'main')) {
    for (const stage of quest.stages.filter(s => s.actions.length > 1)) {
      for (const action of stage.actions.filter(a => !a.ending)) add('narrator', action.entry, `${prefix}epilogue.main.${action.id}`);
    }
  }
  for (const ending of Object.keys(story.endings) as (keyof typeof story.endings)[]) {
    add('narrator', story.endings[ending], `${prefix}epilogue.title.${ending}`);
    add('narrator', story.epilogues[ending], `${prefix}epilogue.root.${ending}`);
  }
  add('narrator', FACTION_CAMPAIGNS[faction].victorySummary, `${prefix}epilogue.victory`);
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
    npcCount: new Set(factions.flatMap(f => getFactionStory(f).npcs.map(n => n.id))).size,
    factionCount: factions.length, endingCount: factions.reduce((sum, f) => sum + Object.keys(getFactionStory(f).endings).length, 0),
    militaryStates: Object.fromEntries(factions.map(f => [f, militaryStates(f).length])),
    speakerCount: new Set(entries.map(entry => entry.speaker)).size,
    total: summarize(entries),
    languages: Object.fromEntries(languages.map(language => [language, summarize(entries.filter(e => e.language === language))])),
    speakers: Object.fromEntries([...new Set(entries.map(e => e.speaker))].map(speaker =>
      [speaker, Object.fromEntries(languages.map(language =>
        [language, summarize(entries.filter(e => e.speaker === speaker && e.language === language))]))])),
    scope: 'Three local faction graphs; all dialogue/choices, reactions/variants, inspection fallbacks, reachable military requirement lists and nine epilogues with every intermediate main choice and side outcome. Conservative default prompts retained.',
    estimateNote: 'Unique corpus, not one playthrough. USD is an illustrative standard-neural rate, not an Azure quote; excludes SSML billing overhead, probes and assessment.',
  };
}
