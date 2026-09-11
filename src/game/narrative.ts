import { CIVIC_FACTIONS, ENDINGS, NPCS, QUESTS, text, type CivicFaction, type EndingId,
  type StoryAction, type StoryNpc, type StoryQuest, type StoryStage } from './narrative-data';
import { assertRecord } from './profile';
import type { ActorData, CampaignData } from './state';
import type { DialogueChoice, LocalizedText, NarrativeInput, NarrativeSnapshot, NpcSnapshot,
  QuestSnapshot, Vec2, WorldBlueprint, WorldLocation } from './types';
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
  conquest: text('First capture and supply two posts, and destroy the raiding caravan. The commander may be defeated before or after this choice.',
    'Сначала захватите и снабдите две заставы и уничтожьте вражеский караван. Командира можно победить до или после этого выбора.'),
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
  paused: text('Conversation paused the expedition. Close the dialogue to resume movement and combat.',
    'Разговор приостановил экспедицию. Закройте диалог, чтобы продолжить движение и бой.'),
} satisfies Record<string, LocalizedText>;
type NoticeId = keyof typeof NOTICES;

/** Only compact, validated IDs are saved; prose and derived quest state come from authored data. */
export interface NarrativeState {
  version: 1;
  journal: string[];
  rewardedQuestIds: string[];
  discovered: string[];
  dialogue: { npcId: string; topicId: string | null } | null;
  trackedQuestId: string | null;
  notice: NoticeId | null;
}
interface QuestProgress {
  quest: StoryQuest;
  count: number;
  entries: StoryAction[];
}
interface StoryProgress {
  quests: Map<string, QuestProgress>;
  reputation: Record<CivicFaction, number>;
  ending: EndingId | null;
}
const QUEST_BY_ID = new Map(QUESTS.map(q => [q.id, q]));
const NPC_BY_ID = new Map(NPCS.map(n => [n.id, n]));
const ACTION_BY_ID = new Map(QUESTS.flatMap(q => q.stages.flatMap((stage, index) =>
  stage.actions.map(action => [action.id, { quest: q, stage, index, action }] as const))));

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
  return s.raidComplete && s.outposts.filter(p => p.owner === 'player' && p.supplied).length >= 2;
}
function gate(action: StoryAction, s: CampaignData): NoticeId | null {
  return action.gate === 'conquest' && !conquestReady(s) ? 'conquest' : null;
}

/** Replay makes branch exclusivity, ordering, reputation and completion rewards one source of truth. */
function progress(state: NarrativeState): StoryProgress {
  const result: StoryProgress = {
    quests: new Map(QUESTS.map(quest => [quest.id, { quest, count: 0, entries: [] }])),
    reputation: { commons: 0, registry: 0, lanterns: 0 }, ending: null,
  };
  for (const id of state.journal) {
    const entry = ACTION_BY_ID.get(id);
    if (!entry) throw new Error('Unknown narrative journal entry');
    const q = result.quests.get(entry.quest.id)!;
    if (q.count !== entry.index || !unlocked(result, entry.quest)) throw new Error('Out-of-order or repeated narrative action');
    q.count++;
    q.entries.push(entry.action);
    for (const faction of CIVIC_FACTIONS) result.reputation[faction.id] += entry.action.reputation?.[faction.id] ?? 0;
    if (entry.action.ending) {
      if (result.ending !== null) throw new Error('Conflicting narrative endings');
      result.ending = entry.action.ending;
    }
  }
  return result;
}

export function createNarrative(world: WorldBlueprint): NarrativeState {
  if (world.version !== 2 || !world.exploration) throw new Error('Narrative requires a version 2 exploration world');
  if (ACTION_BY_ID.size !== QUESTS.reduce((sum, q) => sum + q.stages.reduce((n, st) => n + st.actions.length, 0), 0)) {
    throw new Error('Duplicate authored narrative action');
  }
  for (const npc of NPCS) npcPosition(world, npc);
  for (const quest of QUESTS) for (const stage of quest.stages) {
    if (stage.kind === 'inspect') location(world, stage.at);
    else if (!NPC_BY_ID.has(stage.at)) throw new Error(`Unknown narrative speaker ${stage.at}`);
  }
  return { version: 1, journal: [], rewardedQuestIds: [], discovered: [], dialogue: null, trackedQuestId: 'missing-names', notice: null };
}

function npcPosition(world: WorldBlueprint, npc: StoryNpc): Vec2 {
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
  return enemies.some(a => a.hp > 0 && distance(a, at) < THREAT_RADIUS) ||
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
  return QUESTS.flatMap(quest => {
    const q = p.quests.get(quest.id)!;
    const stage = quest.stages[q.count];
    return unlocked(p, quest) && stage?.kind === 'talk' && stage.at === npcId ? [{ quest, stage }] : [];
  });
}
function finishAction(s: CampaignData, p: StoryProgress, quest: StoryQuest, action: StoryAction): void {
  const state = s.narrative!;
  const q = p.quests.get(quest.id)!;
  if (state.journal.includes(action.id)) throw new Error('Narrative action already applied');
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
  const state = s.narrative;
  if (!state) throw new Error('Narrative commands are not supported by legacy campaigns');
  const fail = (reason: NoticeId): void => { state.notice = reason; };
  state.notice = null;
  if (input.type === 'close') { state.dialogue = null; return; }
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
    fail('traveling');
    discoverNarrative(s, world);
    return;
  }
  if (input.type === 'inspect') {
    const at = world.exploration!.locations.find(l => l.id === input.locationId);
    if (!at || !inspectable(at)) { fail('unknown'); return; }
    const blocked = interactionBlock(s, enemies, at, INSPECT_RADIUS);
    if (blocked) { fail(blocked); return; }
    discoverNarrative(s, world);
    state.dialogue = null;
    for (const quest of QUESTS) {
      const q = p.quests.get(quest.id)!;
      const stage = quest.stages[q.count];
      if (unlocked(p, quest) && stage?.kind === 'inspect' && stage.at === at.id) finishAction(s, p, quest, stage.actions[0]!);
    }
    fail('inspected');
    return;
  }
  const npc = NPC_BY_ID.get(input.npcId);
  if (!npc) { fail('unknown'); return; }
  const blocked = interactionBlock(s, enemies, npcPosition(world, npc), TALK_RADIUS);
  if (blocked) { state.dialogue = null; fail(blocked); return; }
  if (input.type === 'talk') {
    discoverNarrative(s, world);
    state.dialogue = { npcId: npc.id, topicId: null };
    return;
  }
  if (state.dialogue?.npcId !== npc.id) { fail('stale'); return; }
  if (input.choiceId === 'topic-local' || input.choiceId === 'topic-belief' || input.choiceId === 'topic-war') {
    state.dialogue.topicId = input.choiceId;
    return;
  }
  if (input.choiceId === 'leave') { state.dialogue = null; return; }
  const offered = availableStages(p, npc.id).flatMap(({ quest, stage }) =>
    stage.actions.map(action => ({ quest, action }))).find(a => a.action.id === input.choiceId);
  if (!offered) { fail('stale'); return; }
  const locked = gate(offered.action, s);
  if (locked) { fail(locked); return; }
  finishAction(s, p, offered.quest, offered.action);
  state.dialogue.topicId = offered.action.id;
}

function inspectable(at: WorldLocation): boolean {
  return at.kind === 'ruin' || at.kind === 'shrine' ||
    QUESTS.some(q => q.stages.some(st => st.kind === 'inspect' && st.at === at.id));
}
function questSnapshot(p: StoryProgress, q: QuestProgress, discovered: string[]): QuestSnapshot {
  const { quest } = q;
  const done = completed(q);
  const stage = quest.stages[q.count];
  const ready = unlocked(p, quest);
  const previous = quest.requires ? QUEST_BY_ID.get(quest.requires)! : null;
  const target = !ready && previous ? p.quests.get(previous.id)!.quest.stages[p.quests.get(previous.id)!.count] : stage;
  const npc = target?.kind === 'talk' ? NPC_BY_ID.get(target.at)! : null;
  return {
    id: quest.id, title: quest.title, description: quest.description, kind: quest.kind,
    status: done ? 'completed' : q.count > 0 ? 'active' : 'available',
    objective: done ? text('Resolved. Your choice remains part of the road.', 'Завершено. Ваш выбор останется частью дороги.') :
      !ready && previous ? text(`First resolve ${previous.title.en}.`, `Сначала завершите: ${previous.title.ru}.`) : stage!.objective,
    targetId: done ? null : npc && !discovered.includes(npc.locationId) ? npc.locationId : target?.at ?? null,
    entries: q.entries.map(a => a.entry), outcome: done ? q.entries.at(-1)!.entry : null,
  };
}
function militaryText(s: CampaignData): LocalizedText {
  if (!conquestReady(s)) return NOTICES.conquest;
  if (!s.fortress.bossDefeated) return text(
    'Two supplied posts and the broken raiding caravan make a settlement possible. The commander still holds the fortress. Resolve the final page whenever you are ready; both victories are required.',
    'Две снабжённые заставы и разгромленный караван позволяют заключить соглашение. Командир ещё в крепости. Последнюю страницу можно решить, когда будете готовы; нужны обе победы.');
  return text(
    'The commander is defeated. The expedition remains open until you choose the road\'s future at the Last Archive. Finish any side investigations before that final choice.',
    'Командир побеждён. Экспедиция продолжается до выбора будущего дороги в Последнем архиве. Завершите побочные расследования до последнего решения.');
}
function summaryText(s: CampaignData, p: StoryProgress, current: StoryQuest | undefined): LocalizedText {
  if (!current) return s.fortress.bossDefeated ? text(
    'The commander is defeated and the road has a future. Your settlement remembers the decisions that brought it here.',
    'Командир побеждён, у дороги есть будущее. Ваше соглашение сохранит память о решениях, которые к нему привели.') : text(
    'The road\'s future is chosen. Defeat the fortress commander to secure it and complete the expedition. Local investigations remain open until then.',
    'Будущее дороги выбрано. Победите командира крепости, чтобы защитить его и завершить экспедицию. До этого местные расследования остаются открыты.');
  const q = p.quests.get(current.id)!;
  const objective = current.stages[q.count]!.objective;
  const finalChoice = current.id === 'unwritten-road' && q.count === current.stages.length - 1;
  const lines = [current.description, objective];
  if (finalChoice) lines.push(militaryText(s));
  else if (s.fortress.bossDefeated) lines.unshift(text(
    'The commander is defeated, but the investigation is unfinished. Continue the journal before choosing the road\'s future.',
    'Командир побеждён, но расследование не окончено. Продолжите записи в журнале, прежде чем выбирать будущее дороги.'));
  return text(lines.map(line => line.en).join('\n\n'), lines.map(line => line.ru).join('\n\n'));
}
function contextText(p: StoryProgress, npc: StoryNpc): LocalizedText {
  const own = [...p.quests.values()].filter(q => completed(q) && q.quest.stages.at(-1)?.at === npc.id);
  const main = [...p.quests.values()].filter(q => q.quest.kind === 'main' && completed(q)).at(-1);
  const affected = own.at(-1) ?? main;
  if (!affected) return npc.greeting;
  const outcome = affected.entries.at(-1)!.entry;
  const stance = p.reputation.commons > p.reputation.registry ? text(
    'People say you hear households before offices.', 'Люди говорят, что вы слушаете семьи раньше контор.') :
    p.reputation.registry > p.reputation.commons ? text(
      'The clerks say you still believe the books can be repaired.', 'Писцы говорят, что вы ещё верите: книги можно исправить.') :
      text('The borderland is watching what you choose to put in writing.', 'Пограничье смотрит, что вы решите записать.');
  return text(`${npc.greeting.en}\n\n${outcome.en}\n\n${stance.en}`, `${npc.greeting.ru}\n\n${outcome.ru}\n\n${stance.ru}`);
}
function dialogueText(s: CampaignData, p: StoryProgress, npc: StoryNpc): LocalizedText {
  const topic = s.narrative!.dialogue!.topicId;
  if (topic === 'topic-local') return npc.local;
  if (topic === 'topic-belief') {
    const context = contextText(p, npc);
    return text(`${npc.belief.en}\n\n${context.en}`, `${npc.belief.ru}\n\n${context.ru}`);
  }
  if (topic === 'topic-war') return militaryText(s);
  if (topic) {
    const action = ACTION_BY_ID.get(topic)!;
    const next = availableStages(p, npc.id)[0]?.stage.prompt;
    return next ? text(`${action.action.entry.en}\n\n${next.en}`, `${action.action.entry.ru}\n\n${next.ru}`) : action.action.entry;
  }
  const stages = availableStages(p, npc.id);
  const context = contextText(p, npc);
  if (stages.length) return text(`${context.en}\n\n${stages[0]!.stage.prompt.en}`, `${context.ru}\n\n${stages[0]!.stage.prompt.ru}`);
  return context;
}
function endingText(s: CampaignData, p: StoryProgress): LocalizedText | null {
  if (!p.ending) return null;
  const root = p.quests.get('unwritten-road')!.entries.at(-1)!.entry;
  const notes = QUESTS.filter(q => q.kind === 'side').map(quest => {
    const q = p.quests.get(quest.id)!;
    return completed(q) ? q.entries.at(-1)!.entry : text(
      `${quest.title.en}: the dispute still waits for someone to hear it.`,
      `${quest.title.ru}: спор ещё ждёт, когда его выслушают.`);
  });
  const mainChoices = QUESTS.filter(q => q.kind === 'main' && q.id !== 'unwritten-road')
    .map(q => p.quests.get(q.id)!.entries.at(-1)!.entry);
  const coda = s.fortress.bossDefeated ? text(
    'With the commander defeated, your convoy carries the settlement beyond the archive. The road will remember both the people helped and the work left unfinished.',
    'Командир побеждён, и обоз везёт решение за стены архива. Дорога запомнит и тех, кому помогли, и незавершённые дела.') : text(
    'This future is chosen, not yet secured. Defeat the fortress commander to complete the expedition. You can still resolve side quests before that victory.',
    'Это будущее выбрано, но ещё не защищено. Победите командира крепости, чтобы закончить экспедицию. До победы можно завершить побочные задания.');
  const paragraphs = [ENDINGS[p.ending], root, ...mainChoices, ...notes, coda];
  return text(paragraphs.map(t => t.en).join('\n\n'), paragraphs.map(t => t.ru).join('\n\n'));
}

export function narrativeSnapshot(s: CampaignData, world: WorldBlueprint, enemies: readonly ActorData[]): NarrativeSnapshot {
  const state = s.narrative!;
  const p = progress(state);
  const current = QUESTS.find(q => q.kind === 'main' && !completed(p.quests.get(q.id)!));
  const npcs: NpcSnapshot[] = NPCS.filter(n => state.discovered.includes(n.locationId)).map(npc => {
    const at = npcPosition(world, npc);
    const done = [...p.quests.values()].some(q => completed(q) && q.quest.stages.at(-1)?.at === npc.id);
    return {
      ...at, heading: 0, id: npc.id, locationId: npc.locationId, name: npc.name, role: npc.role, faction: npc.faction,
      activity: done ? text('Living with your decision; willing to discuss it', 'Живёт с вашим решением; готов обсудить его') : npc.activity,
      available: s.phase === 'playing' && interactionBlock(s, enemies, at, TALK_RADIUS) === null,
      questAvailable: availableStages(p, npc.id).length > 0,
    };
  });
  let dialogue: NarrativeSnapshot['dialogue'] = null;
  if (state.dialogue) {
    const npc = NPC_BY_ID.get(state.dialogue.npcId)!;
    const blocked = interactionBlock(s, enemies, npcPosition(world, npc), TALK_RADIUS);
    const choices: DialogueChoice[] = availableStages(p, npc.id).flatMap(({ stage }) => stage.actions.map(a => {
      const reason = blocked ?? gate(a, s);
      return { id: a.id, text: a.text, enabled: reason === null, reason: reason ? NOTICES[reason] : null };
    }));
    for (const topic of [
      { id: 'topic-local', text: text('Tell me about this place and its roads.', 'Расскажите об этом месте и его дорогах.') },
      { id: 'topic-belief', text: text('What do you think of the people who govern the road?', 'Что вы думаете о тех, кто правит дорогой?') },
      { id: 'topic-war', text: text('What still stands between this campaign and peace?', 'Что ещё отделяет этот поход от мира?') },
    ]) choices.push({ ...topic, enabled: blocked === null, reason: blocked ? NOTICES[blocked] : null });
    choices.push({
      id: 'leave', text: text('Leave. I have other work before making any further decision.', 'Уйти. До следующего решения у меня есть другие дела.'),
      enabled: true, reason: null,
    });
    dialogue = { npcId: npc.id, name: npc.name, role: npc.role, text: dialogueText(s, p, npc), choices };
  }
  const inspectAt = world.exploration!.locations.filter(at => inspectable(at) && distance(s.player, at) <= INSPECT_RADIUS)
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
    title: text('THE UNWRITTEN ROAD', 'НЕНАПИСАННАЯ ДОРОГА'),
    chapter: current?.title ?? ENDINGS[p.ending!],
    summary: summaryText(s, p, current),
    npcs, quests: QUESTS.map(quest => questSnapshot(p, p.quests.get(quest.id)!, state.discovered)), dialogue,
    trackedQuestId: state.trackedQuestId, discovered: [...state.discovered],
    reputation: CIVIC_FACTIONS.map(f => ({ ...f, value: p.reputation[f.id] })),
    facts: state.journal.map(id => ACTION_BY_ID.get(id)!.action.entry),
    ending: endingText(s, p), notice: state.notice ? NOTICES[state.notice] : null,
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
  assertRecord(value, 'Narrative state');
  const fields = ['version', 'journal', 'rewardedQuestIds', 'discovered', 'dialogue', 'trackedQuestId', 'notice'];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(k => !fields.includes(k)) || value.version !== 1) {
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
    if (!discovered.includes(npc.locationId) || distance(s.player, npcPosition(world, npc)) > TALK_RADIUS) {
      throw new Error('Saved dialogue is outside interaction range');
    }
    if (d.topicId !== null && (typeof d.topicId !== 'string' ||
      (!['topic-local', 'topic-belief', 'topic-war'].includes(d.topicId) &&
       (!journal.includes(d.topicId) || ACTION_BY_ID.get(d.topicId)?.stage.at !== d.npcId)))) {
      throw new Error('Invalid saved dialogue topic');
    }
    dialogue = { npcId: d.npcId, topicId: d.topicId };
  }
  // The guards above establish these finite unions without trusting a deserialized object.
  const validNotice = Object.keys(NOTICES).find((key): key is NoticeId => key === notice) ?? null;
  const state: NarrativeState = { version: 1, journal: [...journal], rewardedQuestIds: [...rewardedQuestIds], discovered: [...discovered],
    dialogue, trackedQuestId: tracked, notice: validNotice };
  const derived = progress(state);
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
    if (gate(entry.action, s)) throw new Error('Narrative decision bypassed military prerequisites');
  }
  return state;
}
