import { CIVIC_FACTIONS, text, type CivicFaction, type EndingId,
  type StoryAction, type StoryNpc, type StoryQuest, type StoryStage } from './narrative-data';
import { getFactionStory } from './faction-stories';
import { DIRECTIVES, FACTION_CAMPAIGNS, factionCampaignSnapshot, militaryReady } from './faction-campaigns';
import { assertRecord } from './profile';
import type { ActorData, CampaignData } from './state';
import type { DialogueChoice, LocalizedText, NarrativeInput, NarrativeSnapshot, NpcSnapshot,
  QuestSnapshot, Vec2, WorldBlueprint, WorldLocation, FactionId } from './types';
import { distance, isWalkable } from './world';

const TALK_RADIUS = 4.25;
const INSPECT_RADIUS = 6;
const TRAVEL_RADIUS = 7;
const THREAT_RADIUS = 26;
const NOTICES = {
  distance: text('Move closer to speak or examine this place.', 'Подойдите ближе, чтобы поговорить или осмотреть это место.'),
  danger: text('Not safe: nearby enemies or incoming missiles. Leave danger before speaking, inspecting or traveling.',
    'Небезопасно: рядом враги или летящие снаряды. Покиньте опасную зону до разговора, осмотра или переезда.'),
  unknown: text('That person, place or quest is not available.', 'Этот человек, место или задание недоступны.'),
  stale: text('That reply is no longer available. Open the current conversation and choose an offered reply.',
    'Этот ответ больше недоступен. Откройте текущий разговор и выберите предложенный ответ.'),
  conquest: text('Complete your faction’s military requirements and defeat its final commander before this decision.',
    'До этого решения выполните военные задачи своей стороны и победите последнего командира.'),
  allies: text('This plan needs allies you have not secured. The reply lists the required decisions and their quests.',
    'Для этого плана не хватает союзников. Под ответом указаны задания и решения, которые обеспечат их помощь.'),
  source: text('Travel starts at a discovered road stop marked for fast travel. Stand within 7m of its road node.',
    'Переезд начинается у открытой дорожной стоянки с быстрым переездом. Встаньте не дальше 7 м от её дорожного узла.'),
  convoy: text('Bring the convoy within 7m of you and this road stop. The whole expedition travels together.',
    'Подведите обоз не дальше 7 м от вас и этой стоянки. Вся экспедиция переезжает вместе.'),
  repair: text('Repair the convoy to full health before traveling; a disabled or damaged cart cannot travel.',
    'Полностью отремонтируйте обоз до переезда: повреждённая или разбитая телега не переедет.'),
  destination: text('Discover an eligible fast-travel destination on foot before traveling there.',
    'Прежде переезда откройте подходящую стоянку пешком.'),
  blocked: text('The destination has no safe, clear arrival space for both hero and convoy.',
    'В точке назначения нет безопасного свободного места для героя и обоза.'),
  traveling: text('You and your convoy arrived together. Convoy orders are now hold.',
    'Вы с обозом прибыли вместе. Обоз получил приказ стоять.'),
  inspected: text('Place examined. New evidence, if relevant to an active investigation, is recorded in the journal.',
    'Место осмотрено. Новые улики для активных расследований записаны в журнал.'),
  paused: text('Conversation or inspection paused the game. Close the scene to resume movement and combat.',
    'Разговор или осмотр приостановил игру. Закройте сцену, чтобы продолжить движение и бой.'),
} satisfies Record<string, LocalizedText>;
type NoticeId = keyof typeof NOTICES;

/** Only compact, validated IDs are saved; prose and derived quest state come from authored data. */
export interface NarrativeState {
  version: 3;
  faction: FactionId;
  journal: string[];
  rewardedQuestIds: string[];
  discovered: string[];
  dialogue: { npcId: string; topicId: string | null } | null;
  inspection: { locationId: string; actionIds: string[] } | null;
  trackedQuestId: string | null;
  notice: NoticeId | null;
}
interface QuestProgress {
  quest: StoryQuest;
  count: number;
  entries: StoryAction[];
}
interface StoryProgress {
  catalog: ReturnType<typeof catalog>;
  quests: Map<string, QuestProgress>;
  reputation: Record<CivicFaction, number>;
  ending: EndingId | null;
  actions: Set<string>;
}
function buildCatalog(faction: FactionId) {
  const story = getFactionStory(faction), QUESTS = story.quests, NPCS = story.npcs;
  return {
    story, QUESTS, NPCS,
    QUEST_BY_ID: new Map(QUESTS.map(q => [q.id, q])),
    QUEST_TOPICS: new Map(QUESTS.map(q => [`quest-${q.id}`, q.id])),
    NPC_BY_ID: new Map(NPCS.map(n => [n.id, n])),
    ACTION_BY_ID: new Map(QUESTS.flatMap(q => q.stages.flatMap((stage, index) =>
      stage.actions.map(action => [action.id, { quest: q, stage, index, action }] as const)))),
  };
}
const catalogs = new Map<FactionId, ReturnType<typeof buildCatalog>>();
function catalog(faction: FactionId): ReturnType<typeof buildCatalog> {
  let result = catalogs.get(faction);
  if (!result) { result = buildCatalog(faction); catalogs.set(faction, result); }
  return result;
}

function location(world: WorldBlueprint, id: string): WorldLocation {
  const result = world.exploration?.locations.find(l => l.id === id);
  if (!result) throw new Error(`Narrative world is missing location ${id}`);
  return result;
}
function completed(progress: QuestProgress): boolean { return progress.count === progress.quest.stages.length; }
function unlocked(progress: StoryProgress, quest: StoryQuest): boolean {
  return quest.requires === null || completed(progress.quests.get(quest.requires)!);
}
function conquestReady(s: CampaignData): boolean {
  return militaryReady(s) && s.fortress.bossDefeated;
}
function gate(action: StoryAction, s: CampaignData, journal = s.narrative?.journal ?? []): NoticeId | null {
  if ((action.gate === 'conquest' || action.ending) && !conquestReady(s)) return 'conquest';
  if (action.directive && (!DIRECTIVES[s.faction].includes(action.directive) ||
      s.military?.directive !== null && (s.military?.directive !== action.directive || !journal.includes(action.id)))) return 'stale';
  return action.requiresActions?.some(id => !journal.includes(id)) ? 'allies' : null;
}
function gateText(action: StoryAction, s: CampaignData, reason: NoticeId): LocalizedText {
  const { ACTION_BY_ID } = catalog(s.faction);
  if (reason === 'conquest') return militaryText(s);
  if (reason !== 'allies') return NOTICES[reason];
  const journal = s.narrative!.journal;
  const missing = action.requiresActions!.filter(id => !journal.includes(id)).map(id => {
    const { quest, action: required } = ACTION_BY_ID.get(id)!;
    const resolved = quest.stages.at(-1)!.actions.some(action => journal.includes(action.id));
    return resolved ? text(
      `${quest.title.en}: your decision ruled out this help. This plan is no longer available in this campaign.`,
      `${quest.title.ru}: принятое решение исключило эту помощь. В этой кампании данный план уже недоступен.`) : text(
      `${quest.title.en}: secure this agreement — ${required.text.en}`,
      `${quest.title.ru}: договоритесь о помощи — ${required.text.ru}`);
  });
  return text(missing.map(line => line.en).join('\n'), missing.map(line => line.ru).join('\n'));
}

/** Replay makes branch exclusivity, ordering, reputation and completion rewards one source of truth. */
function progress(state: NarrativeState): StoryProgress {
  const authored = catalog(state.faction), { QUESTS, ACTION_BY_ID } = authored;
  const result: StoryProgress = {
    catalog: authored,
    quests: new Map(QUESTS.map(quest => [quest.id, { quest, count: 0, entries: [] }])),
    reputation: { commons: 0, registry: 0, lanterns: 0 }, ending: null, actions: new Set(),
  };
  for (const id of state.journal) {
    if (result.ending !== null) throw new Error('Narrative action follows a terminal ending');
    const entry = ACTION_BY_ID.get(id);
    if (!entry) throw new Error('Unknown narrative journal entry');
    const q = result.quests.get(entry.quest.id)!;
    if (q.count !== entry.index || !unlocked(result, entry.quest)) throw new Error('Out-of-order or repeated narrative action');
    if (entry.action.requiresActions?.some(id => !result.actions.has(id))) {
      throw new Error('Narrative decision precedes its required allies');
    }
    q.count++;
    result.actions.add(id);
    q.entries.push(entry.action);
    for (const faction of CIVIC_FACTIONS) result.reputation[faction.id] += entry.action.reputation?.[faction.id] ?? 0;
    if (entry.action.ending) {
      if (result.ending !== null) throw new Error('Conflicting narrative endings');
      result.ending = entry.action.ending;
    }
  }
  return result;
}

export function createNarrative(world: WorldBlueprint, faction: FactionId): NarrativeState {
  const { QUESTS, NPCS, NPC_BY_ID, ACTION_BY_ID } = catalog(faction);
  if (world.version !== 2 || !world.exploration) throw new Error('Narrative requires a version 2 exploration world');
  if (ACTION_BY_ID.size !== QUESTS.reduce((sum, q) => sum + q.stages.reduce((n, st) => n + st.actions.length, 0), 0)) {
    throw new Error('Duplicate authored narrative action');
  }
  for (const npc of NPCS) {
    npcPosition(world, npc, faction);
    for (const reaction of npc.reactions ?? []) {
      if (!ACTION_BY_ID.has(reaction.after)) throw new Error(`Unknown narrative reaction ${reaction.after}`);
    }
  }
  for (const quest of QUESTS) for (const stage of quest.stages) {
    if (stage.kind === 'inspect') location(world, stage.at);
    else if (!NPC_BY_ID.has(stage.at)) throw new Error(`Unknown narrative speaker ${stage.at}`);
    for (const action of stage.actions) {
      for (const required of action.requiresActions ?? []) {
        if (!ACTION_BY_ID.has(required) || required === action.id) throw new Error(`Invalid narrative prerequisite ${required}`);
      }
    }
    for (const variant of stage.variants ?? []) {
      if (!ACTION_BY_ID.has(variant.after)) throw new Error(`Unknown narrative prompt condition ${variant.after}`);
    }
  }
  return { version: 3, faction, journal: [], rewardedQuestIds: [], discovered: [], dialogue: null, inspection: null,
    trackedQuestId: QUESTS.find(q => q.kind === 'main' && q.requires === null)?.id ?? null, notice: null };
}

function npcPosition(world: WorldBlueprint, npc: StoryNpc, faction: FactionId): Vec2 {
  const { NPCS } = catalog(faction);
  const at = location(world, npc.locationId);
  const index = NPCS.filter(n => n.locationId === npc.locationId).findIndex(n => n.id === npc.id);
  // Locations reserve a 3m approach area; try alternate local offsets explicitly if scenery changes.
  const first = npc.id === 'mara' ? { x: 2.5, z: 1.5 } : { x: 0, z: 2 };
  const offsets = [first, { x: -2, z: 0 }, { x: 2, z: 0 }, { x: 0, z: -2 }];
  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[(index + i) % offsets.length]!;
    const position = { x: at.x + offset.x, z: at.z + offset.z };
    if (isWalkable(world, position, 0.65)) return position;
  }
  throw new Error(`No walkable narrative position for ${npc.id}`);
}
function dangerous(s: CampaignData, enemies: readonly ActorData[], at: Vec2): boolean {
  return enemies.some(a => a.hp > 0 && a.allegiance !== 'friendly' && a.allegiance !== 'neutral' && distance(a, at) < THREAT_RADIUS) ||
    s.projectiles.some(p => p.owner === 'enemy' && distance(p, at) < THREAT_RADIUS);
}
function interactionBlock(s: CampaignData, enemies: readonly ActorData[], at: Vec2, radius: number): NoticeId | null {
  if (distance(s.player, at) > radius) return 'distance';
  return dangerous(s, enemies, s.player) || dangerous(s, enemies, at) ? 'danger' : null;
}

export function discoverNarrative(s: CampaignData, world: WorldBlueprint): void {
  if (!s.narrative) return;
  for (const at of world.exploration!.locations) {
    if (distance(s.player, at) <= at.radius + 10 && !s.narrative.discovered.includes(at.id)) {
      s.narrative.discovered.push(at.id);
    }
  }
}

function availableStages(p: StoryProgress, npcId: string): { quest: StoryQuest; stage: StoryStage }[] {
  const { QUESTS } = p.catalog;
  return QUESTS.flatMap(quest => {
    const q = p.quests.get(quest.id)!;
    const stage = quest.stages[q.count];
    return unlocked(p, quest) && stage?.kind === 'talk' && stage.at === npcId ? [{ quest, stage }] : [];
  });
}
function selectedStage(s: CampaignData, p: StoryProgress, npcId: string): { quest: StoryQuest; stage: StoryStage } | null {
  const { QUEST_TOPICS, ACTION_BY_ID } = p.catalog;
  const stages = availableStages(p, npcId);
  const topic = s.narrative!.dialogue!.topicId;
  if (topic === null) return stages.length === 1 ? stages[0]! : null;
  const questId = QUEST_TOPICS.get(topic) ?? ACTION_BY_ID.get(topic)?.quest.id;
  return stages.find(({ quest }) => quest.id === questId) ?? null;
}
function latestReaction<T extends { after: string }>(options: T[] | undefined, p: StoryProgress): T | undefined {
  for (const id of [...p.actions].reverse()) {
    const reaction = options?.find(reaction => reaction.after === id);
    if (reaction) return reaction;
  }
  return undefined;
}
function stagePrompt(stage: StoryStage, p: StoryProgress): LocalizedText {
  return latestReaction(stage.variants, p)?.prompt ?? stage.prompt;
}
function spokenPrompt(s: CampaignData, p: StoryProgress, stage: StoryStage): LocalizedText {
  const prompt = stagePrompt(stage, p);
  if (!stage.actions.some(action => action.ending)) return prompt;
  const military = militaryText(s);
  return text(`${prompt.en}\n\n${military.en}`, `${prompt.ru}\n\n${military.ru}`);
}
function hasWarTopic(npc: StoryNpc): boolean {
  return ['toman', 'vesk', 'ren', 'elin'].includes(npc.id);
}
function finishAction(s: CampaignData, p: StoryProgress, quest: StoryQuest, action: StoryAction): void {
  const { QUESTS } = p.catalog;
  const state = s.narrative!;
  const q = p.quests.get(quest.id)!;
  if (state.journal.includes(action.id)) throw new Error('Narrative action already applied');
  if (action.directive) {
    if (!s.military || s.military.directive !== null) throw new Error('Military directive already committed');
    s.military.directive = action.directive;
  }
  state.journal.push(action.id);
  if (q.count + 1 === quest.stages.length) {
    if (state.rewardedQuestIds.includes(quest.id)) throw new Error('Narrative reward already claimed');
    state.rewardedQuestIds.push(quest.id);
    s.player.coins += quest.reward;
    if (state.trackedQuestId === quest.id) {
      state.trackedQuestId = QUESTS.find(candidate => candidate.requires === quest.id)?.id ?? null;
    }
  } else if (q.count === 0 || state.trackedQuestId === null) state.trackedQuestId = quest.id;
}

interface TravelPlan {
  reason: NoticeId | null;
  destinations: string[];
}
function roadStop(world: WorldBlueprint, at: WorldLocation): Vec2 | null {
  // No arbitrary nearest-node jump: an eligible location must have a road node inside its clearing.
  return [...world.roads.nodes].filter(n => distance(n, at) <= at.radius)
    .sort((a, b) => distance(a, at) - distance(b, at) || a.id.localeCompare(b.id))[0] ?? null;
}
function arrival(world: WorldBlueprint, at: WorldLocation, s: CampaignData): { player: Vec2; convoy: Vec2 } | null {
  const node = roadStop(world, at);
  if (!node || !isWalkable(world, node, s.convoy.radius)) return null;
  const offsets = [{ x: 0, z: 3 }, { x: 3, z: 0 }, { x: 0, z: -3 }, { x: -3, z: 0 }];
  for (const offset of offsets) {
    const p = { x: node.x + offset.x, z: node.z + offset.z };
    if (isWalkable(world, p, s.player.radius) &&
        distance(p, node) > s.player.radius + s.convoy.radius) {
      return { player: p, convoy: { x: node.x, z: node.z } };
    }
  }
  return null;
}
function travelPlan(s: CampaignData, world: WorldBlueprint, enemies: readonly ActorData[]): TravelPlan {
  const state = s.narrative!;
  const eligible = world.exploration!.locations.filter(l => l.fastTravel && state.discovered.includes(l.id));
  const destinations = eligible.filter(at => {
    const positions = arrival(world, at, s);
    return positions !== null && !dangerous(s, enemies, positions.player) && !dangerous(s, enemies, positions.convoy);
  }).map(at => at.id);
  const source = eligible.find(at => {
    const node = roadStop(world, at);
    return node && distance(s.player, node) <= TRAVEL_RADIUS;
  });
  let reason: NoticeId | null = null;
  if (dangerous(s, enemies, s.player) || dangerous(s, enemies, s.convoy)) reason = 'danger';
  else if (!source) reason = 'source';
  else if (s.convoy.disabled || s.convoy.hp < s.convoy.maxHp) reason = 'repair';
  else if (distance(s.player, s.convoy) > TRAVEL_RADIUS ||
      distance(s.convoy, roadStop(world, source)!) > TRAVEL_RADIUS) reason = 'convoy';
  return { reason, destinations };
}

export function narrativeResolved(s: CampaignData): boolean {
  return s.narrative === undefined || progress(s.narrative).ending !== null;
}
export function pauseNarrative(s: CampaignData): void {
  if (s.narrative) s.narrative.notice = 'paused';
}

/** Called only after structural input validation. No timers, movement, RNG or hostile systems run here. */
export function applyNarrative(s: CampaignData, world: WorldBlueprint, enemies: readonly ActorData[], input: NarrativeInput): void {
  const { QUESTS, QUEST_BY_ID, QUEST_TOPICS, NPC_BY_ID } = catalog(s.faction);
  const state = s.narrative;
  if (!state) throw new Error('Narrative commands are not supported by legacy campaigns');
  const fail = (reason: NoticeId): void => { state.notice = reason; };
  state.notice = null;
  if (input.type === 'close') { state.dialogue = null; state.inspection = null; return; }
  if (input.type === 'track') {
    if (input.questId !== null && !QUEST_BY_ID.has(input.questId)) { fail('unknown'); return; }
    state.trackedQuestId = input.questId;
    return;
  }
  const p = progress(state);
  if (input.type === 'travel') {
    const at = world.exploration!.locations.find(l => l.id === input.locationId && l.fastTravel);
    if (!at || !state.discovered.includes(at.id)) { fail('destination'); return; }
    const plan = travelPlan(s, world, enemies);
    if (plan.reason) { fail(plan.reason); return; }
    const points = arrival(world, at, s);
    if (!points) { fail('blocked'); return; }
    if (!plan.destinations.includes(at.id)) { fail('danger'); return; }
    Object.assign(s.player, points.player, { state: 'idle' });
    Object.assign(s.convoy, points.convoy, { mode: 'hold', destination: null, route: [] });
    s.followTimer = 0;
    state.dialogue = null;
    state.inspection = null;
    fail('traveling');
    discoverNarrative(s, world);
    return;
  }
  if (input.type === 'inspect') {
    const at = world.exploration!.locations.find(l => l.id === input.locationId);
    if (!at || !inspectable(at, s.faction)) { fail('unknown'); return; }
    const blocked = interactionBlock(s, enemies, at, INSPECT_RADIUS);
    if (blocked) { fail(blocked); return; }
    discoverNarrative(s, world);
    state.dialogue = null;
    const evidence = QUESTS.flatMap(quest => {
      const q = p.quests.get(quest.id)!;
      const stage = quest.stages[q.count];
      return unlocked(p, quest) && stage?.kind === 'inspect' && stage.at === at.id ?
        [{ quest, action: stage.actions[0]! }] : [];
    });
    const blockedEvidence = evidence.map(({ action }) => gate(action, s)).find(reason => reason !== null);
    if (blockedEvidence) { fail(blockedEvidence); return; }
    for (const { quest, action } of evidence) finishAction(s, p, quest, action);
    state.inspection = { locationId: at.id, actionIds: evidence.map(({ action }) => action.id) };
    fail('inspected');
    return;
  }
  const npc = NPC_BY_ID.get(input.npcId);
  if (!npc) { fail('unknown'); return; }
  const blocked = interactionBlock(s, enemies, npcPosition(world, npc, s.faction), TALK_RADIUS);
  if (blocked) { state.dialogue = null; fail(blocked); return; }
  if (input.type === 'talk') {
    discoverNarrative(s, world);
    state.dialogue = { npcId: npc.id, topicId: null };
    state.inspection = null;
    return;
  }
  if (state.dialogue?.npcId !== npc.id) { fail('stale'); return; }
  const questTopic = QUEST_TOPICS.get(input.choiceId);
  if (questTopic) {
    if (!availableStages(p, npc.id).some(({ quest }) => quest.id === questTopic)) { fail('stale'); return; }
    state.dialogue.topicId = input.choiceId;
    return;
  }
  if (input.choiceId === 'topic-local' || input.choiceId === 'topic-belief' || input.choiceId === 'topic-war') {
    if (input.choiceId === 'topic-war' && !hasWarTopic(npc)) { fail('stale'); return; }
    state.dialogue.topicId = input.choiceId;
    return;
  }
  if (input.choiceId === 'leave') { state.dialogue = null; return; }
  const selected = selectedStage(s, p, npc.id);
  const action = selected?.stage.actions.find(action => action.id === input.choiceId);
  if (!selected || !action) { fail('stale'); return; }
  const locked = gate(action, s);
  if (locked) { fail(locked); return; }
  finishAction(s, p, selected.quest, action);
  state.dialogue.topicId = action.id;
}

function inspectable(at: WorldLocation, faction: FactionId): boolean {
  const { QUESTS } = catalog(faction);
  return at.kind === 'ruin' || at.kind === 'shrine' ||
    QUESTS.some(q => q.stages.some(st => st.kind === 'inspect' && st.at === at.id));
}
function questSnapshot(p: StoryProgress, q: QuestProgress, discovered: string[]): QuestSnapshot {
  const { QUEST_BY_ID, NPC_BY_ID } = p.catalog;
  const { quest } = q;
  const done = completed(q);
  const stage = quest.stages[q.count];
  const ready = unlocked(p, quest);
  let prerequisite = quest;
  while (!unlocked(p, prerequisite)) prerequisite = QUEST_BY_ID.get(prerequisite.requires!)!;
  const target = ready ? stage : prerequisite.stages[p.quests.get(prerequisite.id)!.count];
  const npc = target?.kind === 'talk' ? NPC_BY_ID.get(target.at)! : null;
  return {
    id: quest.id, title: quest.title,
    description: ready ? quest.description : text(
      'This part of the investigation has not begun. Follow the current lead before looking ahead.',
      'Эта часть расследования ещё не началась. Сначала разберитесь с текущей зацепкой.'),
    kind: quest.kind,
    status: done ? 'completed' : q.count > 0 ? 'active' : 'available',
    objective: done ? text('Completed. The outcome is recorded below.', 'Задание завершено. Результат записан ниже.') :
      !ready ? text(`First complete ${prerequisite.title.en}.`, `Сначала завершите: ${prerequisite.title.ru}.`) : stage!.objective,
    targetId: done ? null : npc && !discovered.includes(npc.locationId) ? npc.locationId : target?.at ?? null,
    entries: q.entries.map(a => a.entry), outcome: done ? q.entries.at(-1)!.entry : null,
  };
}
function militaryText(s: CampaignData): LocalizedText {
  const snapshot = factionCampaignSnapshot(s);
  const lines = snapshot.requirements.filter(r => !r.complete).map(r => r.label);
  return lines.length ? text(lines.map(l => l.en).join('\n'), lines.map(l => l.ru).join('\n')) :
    text('Military obligations are fulfilled. The final story decision will end the campaign; finish local business first.',
      'Военные обязательства выполнены. Итоговое сюжетное решение завершит кампанию; сначала закончите местные дела.');
}
function summaryText(s: CampaignData, p: StoryProgress, current: StoryQuest | undefined): LocalizedText {
  if (!current) return FACTION_CAMPAIGNS[s.faction].victorySummary;
  const q = p.quests.get(current.id)!;
  const objective = current.stages[q.count]!.objective;
  const finalChoice = current.stages[q.count]!.actions.some(a => a.ending);
  const lines = [current.description, objective];
  if (finalChoice) lines.push(militaryText(s));
  else if (s.fortress.bossDefeated) lines.unshift(text(
    'The military campaign is won, but the ward-glass mystery remains. Follow your faction’s journal.',
    'Военная кампания выиграна, но тайна обережного стекла не раскрыта. Следуйте журналу своей стороны.'));
  return text(lines.map(line => line.en).join('\n\n'), lines.map(line => line.ru).join('\n\n'));
}
function contextText(p: StoryProgress, npc: StoryNpc): LocalizedText {
  const { ACTION_BY_ID } = p.catalog;
  const reaction = latestReaction(npc.reactions, p);
  if (reaction) return reaction.text;
  for (const id of [...p.actions].reverse()) {
    const entry = ACTION_BY_ID.get(id)!;
    if (entry.stage.at === npc.id && entry.index === entry.quest.stages.length - 1) return entry.action.response;
  }
  return npc.greeting;
}
function dialogueText(s: CampaignData, p: StoryProgress, npc: StoryNpc): LocalizedText {
  const { QUEST_TOPICS, ACTION_BY_ID } = p.catalog;
  const topic = s.narrative!.dialogue!.topicId;
  if (topic === 'topic-local') return npc.local;
  if (topic === 'topic-belief') {
    return npc.belief;
  }
  if (topic === 'topic-war') return militaryText(s);
  const selected = selectedStage(s, p, npc.id);
  if (topic && QUEST_TOPICS.has(topic)) return spokenPrompt(s, p, selected!.stage);
  if (topic) {
    const action = ACTION_BY_ID.get(topic)!;
    const next = selected ? spokenPrompt(s, p, selected.stage) : null;
    return next ? text(`${action.action.response.en}\n\n${next.en}`, `${action.action.response.ru}\n\n${next.ru}`) : action.action.response;
  }
  const context = contextText(p, npc);
  if (selected) {
    const prompt = spokenPrompt(s, p, selected.stage);
    return text(`${context.en}\n\n${prompt.en}`, `${context.ru}\n\n${prompt.ru}`);
  }
  return context;
}
function endingText(s: CampaignData, p: StoryProgress): LocalizedText | null {
  if (!p.ending) return null;
  const { QUESTS, story } = p.catalog;
  const root = story.epilogues[p.ending];
  const notes = QUESTS.filter(q => q.kind === 'side').map(quest => {
    const q = p.quests.get(quest.id)!;
    const outcome = completed(q) ? q.entries.at(-1)!.entry : quest.unresolved;
    return text(`${quest.title.en}\n${outcome.en}`, `${quest.title.ru}\n${outcome.ru}`);
  });
  const mainChoices = QUESTS.filter(q => q.kind === 'main').flatMap(quest =>
    p.quests.get(quest.id)!.entries.filter((action, index) => !action.ending && quest.stages[index]!.actions.length > 1)
      .map(action => action.entry));
  const paragraphs = [story.endings[p.ending], root, ...mainChoices, ...notes, FACTION_CAMPAIGNS[s.faction].victorySummary];
  return text(paragraphs.map(t => t.en).join('\n\n'), paragraphs.map(t => t.ru).join('\n\n'));
}

export function narrativeSnapshot(s: CampaignData, world: WorldBlueprint, enemies: readonly ActorData[]): NarrativeSnapshot {
  const { QUESTS, NPCS, NPC_BY_ID, ACTION_BY_ID, story } = catalog(s.faction);
  const state = s.narrative!;
  const p = progress(state);
  const current = QUESTS.find(q => q.kind === 'main' && !completed(p.quests.get(q.id)!));
  const npcs: NpcSnapshot[] = NPCS.filter(n => state.discovered.includes(n.locationId)).map(npc => {
    const at = npcPosition(world, npc, s.faction);
    return {
      ...at, heading: 0, id: npc.id, locationId: npc.locationId, name: npc.name, role: npc.role, faction: npc.faction,
      activity: npc.activity,
      available: s.phase === 'playing' && interactionBlock(s, enemies, at, TALK_RADIUS) === null,
      questAvailable: availableStages(p, npc.id).length > 0,
    };
  });
  let dialogue: NarrativeSnapshot['dialogue'] = null;
  if (state.dialogue) {
    const npc = NPC_BY_ID.get(state.dialogue.npcId)!;
    const blocked = interactionBlock(s, enemies, npcPosition(world, npc, s.faction), TALK_RADIUS);
    const selected = selectedStage(s, p, npc.id);
    const choices: DialogueChoice[] = (selected?.stage.actions ?? []).map(a => {
      const reason = blocked ?? gate(a, s);
      return { id: a.id, text: a.text, enabled: reason === null, reason: reason ? gateText(a, s, reason) : null };
    });
    for (const { quest } of availableStages(p, npc.id)) {
      if (quest.id === selected?.quest.id) continue;
      choices.push({ id: `quest-${quest.id}`, text: quest.title, enabled: blocked === null, reason: blocked ? NOTICES[blocked] : null });
    }
    for (const topic of [
      { id: 'topic-local', text: npc.localQuestion },
      { id: 'topic-belief', text: npc.beliefQuestion },
      ...(hasWarTopic(npc) ? [{ id: 'topic-war', text: text('What military obligations remain?', 'Какие военные задачи остались?') }] : []),
    ]) choices.push({ ...topic, enabled: blocked === null, reason: blocked ? NOTICES[blocked] : null });
    choices.push({
      id: 'leave', text: text('I need to go.', 'Мне пора.'),
      enabled: true, reason: null,
    });
    dialogue = { npcId: npc.id, name: npc.name, role: npc.role, text: dialogueText(s, p, npc), choices };
  }
  const inspectAt = world.exploration!.locations.filter(at => inspectable(at, s.faction) && distance(s.player, at) <= INSPECT_RADIUS)
    .sort((a, b) => distance(s.player, a) - distance(s.player, b))[0];
  const neededInspect = inspectAt && [...p.quests.values()].some(q => unlocked(p, q.quest) &&
    q.quest.stages[q.count]?.kind === 'inspect' && q.quest.stages[q.count]?.at === inspectAt.id);
  const nearest = npcs.filter(n => distance(s.player, n) <= TALK_RADIUS)
    .sort((a, b) => distance(s.player, a) - distance(s.player, b))[0];
  const interaction: NarrativeSnapshot['interaction'] = s.phase !== 'playing' ? null :
    inspectAt && (neededInspect || !nearest) ? {
      kind: 'inspect', targetId: inspectAt.id, label: text(`Inspect: ${inspectAt.name.en}`, `Осмотреть: ${inspectAt.name.ru}`),
      enabled: interactionBlock(s, enemies, inspectAt, INSPECT_RADIUS) === null,
    } : nearest ? {
      kind: 'talk', targetId: nearest.id, label: text(`Talk: ${nearest.name.en}`, `Говорить: ${nearest.name.ru}`), enabled: nearest.available,
    } : null;
  const travel = travelPlan(s, world, enemies);
  return {
    title: story.title,
    chapter: current?.title ?? story.endings[p.ending!],
    summary: summaryText(s, p, current),
    npcs, quests: QUESTS.map(quest => questSnapshot(p, p.quests.get(quest.id)!, state.discovered)), dialogue,
    inspection: state.inspection ? {
      locationId: state.inspection.locationId,
      title: location(world, state.inspection.locationId).name,
      text: state.inspection.actionIds.length ? text(
        state.inspection.actionIds.map(id => stagePrompt(ACTION_BY_ID.get(id)!.stage, p).en).join('\n\n'),
        state.inspection.actionIds.map(id => stagePrompt(ACTION_BY_ID.get(id)!.stage, p).ru).join('\n\n'),
      ) : location(world, state.inspection.locationId).description,
    } : null,
    trackedQuestId: state.trackedQuestId, discovered: [...state.discovered],
    reputation: CIVIC_FACTIONS.map(f => ({ ...f, value: p.reputation[f.id] })),
    facts: state.journal.map(id => ACTION_BY_ID.get(id)!.action.entry),
    ending: endingText(s, p), notice: state.notice === 'conquest' ? militaryText(s) : state.notice ? NOTICES[state.notice] : null,
    interaction, travel: { available: s.phase === 'playing' && travel.reason === null,
      reason: travel.reason ? NOTICES[travel.reason] : null, destinations: travel.destinations },
  };
}

export function validateNarrativeInput(value: unknown): NarrativeInput {
  assertRecord(value, 'Narrative input');
  const keys = (expected: string[]): void => {
    if (Object.keys(value).length !== expected.length || Object.keys(value).some(k => !expected.includes(k))) {
      throw new Error('Unexpected narrative command fields');
    }
  };
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(value)) throw new Error('Invalid narrative identifier');
    return value;
  };
  switch (value.type) {
    case 'close': keys(['type']); return { type: 'close' };
    case 'talk': keys(['type', 'npcId']); return { type: 'talk', npcId: id(value.npcId) };
    case 'choose': keys(['type', 'npcId', 'choiceId']); return { type: 'choose', npcId: id(value.npcId), choiceId: id(value.choiceId) };
    case 'track': keys(['type', 'questId']); return { type: 'track', questId: value.questId === null ? null : id(value.questId) };
    case 'inspect': keys(['type', 'locationId']); return { type: 'inspect', locationId: id(value.locationId) };
    case 'travel': keys(['type', 'locationId']); return { type: 'travel', locationId: id(value.locationId) };
    default: throw new Error('Unknown narrative command');
  }
}

export function validateNarrativeState(value: unknown, world: WorldBlueprint, s: CampaignData): NarrativeState {
  const { QUEST_BY_ID, QUEST_TOPICS, NPC_BY_ID, ACTION_BY_ID } = catalog(s.faction);
  assertRecord(value, 'Narrative state');
  if (value.version !== 3) throw new Error('Unsupported story version. Start a new faction campaign; older narrative journals cannot be migrated.');
  if (value.faction !== s.faction) throw new Error('Narrative faction does not match campaign');
  const fields = ['version', 'faction', 'journal', 'rewardedQuestIds', 'discovered', 'dialogue', 'inspection', 'trackedQuestId', 'notice'];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(k => !fields.includes(k))) {
    throw new Error('Invalid narrative state fields/version');
  }
  const ids = (value: unknown, allowed: ReadonlySet<string>, label: string): string[] => {
    if (!Array.isArray(value) || value.length > allowed.size ||
        value.some(id => typeof id !== 'string' || !allowed.has(id)) || new Set(value).size !== value.length) {
      throw new Error(`Invalid narrative ${label}`);
    }
    return value;
  };
  const journal = ids(value.journal, new Set(ACTION_BY_ID.keys()), 'journal');
  const rewardedQuestIds = ids(value.rewardedQuestIds, new Set(QUEST_BY_ID.keys()), 'rewards');
  const discovered = ids(value.discovered, new Set(world.exploration!.locations.map(l => l.id)), 'discovery');
  const tracked = value.trackedQuestId;
  if (tracked !== null && (typeof tracked !== 'string' || !QUEST_BY_ID.has(tracked))) throw new Error('Unknown tracked quest');
  const notice = value.notice;
  if (notice !== null && (typeof notice !== 'string' || !Object.hasOwn(NOTICES, notice))) throw new Error('Unknown narrative notice');
  let dialogue: NarrativeState['dialogue'] = null;
  if (value.dialogue !== null) {
    assertRecord(value.dialogue, 'Dialogue state');
    const d = value.dialogue;
    if (Object.keys(d).sort().join(',') !== 'npcId,topicId' || typeof d.npcId !== 'string' || !NPC_BY_ID.has(d.npcId)) {
      throw new Error('Invalid dialogue speaker');
    }
    const npc = NPC_BY_ID.get(d.npcId)!;
    if (!discovered.includes(npc.locationId) || distance(s.player, npcPosition(world, npc, s.faction)) > TALK_RADIUS) {
      throw new Error('Saved dialogue is outside interaction range');
    }
    if (d.topicId !== null && (typeof d.topicId !== 'string' ||
      (!['topic-local', 'topic-belief', 'topic-war'].includes(d.topicId) && !QUEST_TOPICS.has(d.topicId) &&
       (!journal.includes(d.topicId) || ACTION_BY_ID.get(d.topicId)?.stage.at !== d.npcId)))) {
      throw new Error('Invalid saved dialogue topic');
    }
    if (d.topicId === 'topic-war' && !hasWarTopic(npc)) throw new Error('This speaker has no military topic');
    dialogue = { npcId: d.npcId, topicId: d.topicId };
  }
  let inspection: NarrativeState['inspection'] = null;
  if (value.inspection !== null) {
    assertRecord(value.inspection, 'Inspection state');
    const i = value.inspection;
    if (Object.keys(i).sort().join(',') !== 'actionIds,locationId' || typeof i.locationId !== 'string') {
      throw new Error('Invalid inspection fields');
    }
    const at = world.exploration!.locations.find(at => at.id === i.locationId);
    if (dialogue || !at || !inspectable(at, s.faction) || !discovered.includes(at.id) || distance(s.player, at) > INSPECT_RADIUS) {
      throw new Error('Saved inspection is outside interaction range or overlaps dialogue');
    }
    const actionIds = ids(i.actionIds, new Set(journal), 'inspection evidence');
    if (actionIds.some(id => {
      const entry = ACTION_BY_ID.get(id)!;
      return entry.stage.kind !== 'inspect' || entry.stage.at !== at.id;
    }) || (actionIds.length && journal.slice(-actionIds.length).join(',') !== actionIds.join(','))) {
      throw new Error('Saved inspection does not match the latest evidence');
    }
    inspection = { locationId: at.id, actionIds: [...actionIds] };
  }
  // The guards above establish these finite unions without trusting a deserialized object.
  const validNotice = Object.keys(NOTICES).find((key): key is NoticeId => key === notice) ?? null;
  const state: NarrativeState = { version: 3, faction: s.faction, journal: [...journal], rewardedQuestIds: [...rewardedQuestIds], discovered: [...discovered],
    dialogue, inspection, trackedQuestId: tracked, notice: validNotice };
  const derived = progress(state);
  const directives = journal.flatMap(id => ACTION_BY_ID.get(id)!.action.directive ?? []);
  if (directives.length > 1 || (directives[0] ?? null) !== s.military?.directive ||
      directives.some(d => !DIRECTIVES[s.faction].includes(d))) throw new Error('Inconsistent faction military directive');
  if (dialogue?.topicId && QUEST_TOPICS.has(dialogue.topicId) &&
      !availableStages(derived, dialogue.npcId).some(({ quest }) => quest.id === QUEST_TOPICS.get(dialogue.topicId!))) {
    throw new Error('Saved quest topic is no longer available');
  }
  const rewards = state.journal.flatMap(id => {
    const entry = ACTION_BY_ID.get(id)!;
    return entry.index === entry.quest.stages.length - 1 ? [entry.quest.id] : [];
  });
  if (rewards.join(',') !== state.rewardedQuestIds.join(',') ||
      state.rewardedQuestIds.some(id => !completed(derived.quests.get(id)!))) throw new Error('Inconsistent narrative reward ledger');
  for (const id of state.journal) {
    const entry = ACTION_BY_ID.get(id)!;
    const at = entry.stage.kind === 'inspect' ? entry.stage.at : NPC_BY_ID.get(entry.stage.at)!.locationId;
    if (!discovered.includes(at)) throw new Error('Narrative evidence precedes location discovery');
    if (gate(entry.action, s, state.journal)) throw new Error('Narrative decision bypassed prerequisites');
  }
  return state;
}
