import type { Bounds, FactionId, Position, Vec2 } from './types';

export interface LocalizedText { en: string; ru: string }
export interface WorldRegion {
  id: string;
  name: LocalizedText;
  description: LocalizedText;
  bounds: Bounds;
  biome: 'forest' | 'countryside' | 'mountains' | 'marsh' | 'waste' | 'coast';
}
export interface WorldLocation extends Vec2 {
  id: string;
  regionId: string;
  name: LocalizedText;
  description: LocalizedText;
  kind: 'settlement' | 'ruin' | 'shrine' | 'inn' | 'landmark';
  radius: number;
  fastTravel: boolean;
}
export interface ExplorationWorld {
  regions: WorldRegion[];
  locations: WorldLocation[];
}
export type NarrativeInput =
  | { type: 'talk'; npcId: string }
  | { type: 'choose'; npcId: string; choiceId: string }
  | { type: 'close' }
  | { type: 'track'; questId: string | null }
  | { type: 'travel'; locationId: string }
  | { type: 'inspect'; locationId: string };
export interface NpcSnapshot extends Position {
  id: string;
  name: LocalizedText;
  role: LocalizedText;
  faction: FactionId;
  locationId: string;
  activity: LocalizedText;
  available: boolean;
  questAvailable: boolean;
}
export interface DialogueChoice {
  id: string;
  text: LocalizedText;
  enabled: boolean;
  reason: LocalizedText | null;
}
export interface DialogueSnapshot {
  npcId: string;
  name: LocalizedText;
  role: LocalizedText;
  text: LocalizedText;
  choices: DialogueChoice[];
}
export interface QuestSnapshot {
  id: string;
  title: LocalizedText;
  description: LocalizedText;
  kind: 'main' | 'side';
  status: 'available' | 'active' | 'completed' | 'failed';
  objective: LocalizedText;
  targetId: string | null;
  entries: LocalizedText[];
  outcome: LocalizedText | null;
}
export interface NarrativeSnapshot {
  title: LocalizedText;
  chapter: LocalizedText;
  summary: LocalizedText;
  npcs: NpcSnapshot[];
  quests: QuestSnapshot[];
  dialogue: DialogueSnapshot | null;
  trackedQuestId: string | null;
  discovered: string[];
  reputation: { id: string; name: LocalizedText; value: number }[];
  facts: LocalizedText[];
  ending: LocalizedText | null;
  notice: LocalizedText | null;
  interaction: {
    kind: 'talk' | 'inspect';
    targetId: string;
    label: LocalizedText;
    enabled: boolean;
  } | null;
  travel: { available: boolean; reason: LocalizedText | null; destinations: string[] };
}
