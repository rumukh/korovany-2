import type { EndingId, StoryNpc, StoryQuest } from './narrative-data';
import type { FactionId, LocalizedText } from './types';
import { ELF_ENDINGS, ELF_EPILOGUES, ELF_NPCS, ELF_QUESTS } from './faction-story-elf';
import { GUARD_ENDINGS, GUARD_EPILOGUES, GUARD_NPCS, GUARD_QUESTS } from './faction-story-guard';
import { VILLAIN_ENDINGS, VILLAIN_EPILOGUES, VILLAIN_NPCS, VILLAIN_QUESTS } from './faction-story-villain';
import { localStories, t } from './faction-story-shared';

export interface FactionStory {
  title: LocalizedText;
  quests: StoryQuest[];
  npcs: StoryNpc[];
  endings: Record<EndingId, LocalizedText>;
  epilogues: Record<EndingId, LocalizedText>;
}

const STORIES: Record<FactionId, FactionStory> = {
  elf: {
    title: t('The Hollow Road: Wooden Walls', 'Глухой тракт: деревянные стены'),
    quests: [...ELF_QUESTS, ...localStories('elf')], npcs: ELF_NPCS,
    endings: ELF_ENDINGS, epilogues: ELF_EPILOGUES,
  },
  guard: {
    title: t('The Hollow Road: The Unrelieved Watch', 'Глухой тракт: бессменный караул'),
    quests: [...GUARD_QUESTS, ...localStories('guard')], npcs: GUARD_NPCS,
    endings: GUARD_ENDINGS, epilogues: GUARD_EPILOGUES,
  },
  villain: {
    title: t('The Hollow Road: My Own Standard', 'Глухой тракт: собственное знамя'),
    quests: [...VILLAIN_QUESTS, ...localStories('villain')], npcs: VILLAIN_NPCS,
    endings: VILLAIN_ENDINGS, epilogues: VILLAIN_EPILOGUES,
  },
};

export function getFactionStory(faction: FactionId): FactionStory {
  return STORIES[faction];
}
