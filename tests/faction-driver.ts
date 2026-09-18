import { expect } from 'vitest';
import { type CampaignSave, type FactionDirective, type GameSession } from '../src/game';
import { getFactionStory } from '../src/game/faction-stories';
import type { StoryAction, StoryQuest, StoryStage } from '../src/game/narrative-data';
import { CampaignDriver } from './driver';

export function savedResource(save: CampaignSave): Record<string, unknown> {
  return (save.engine as { resources: { KorovanyCampaign: Record<string, unknown> } }).resources.KorovanyCampaign;
}

export const yieldRunner = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Story setup uses the same public movement and narrative inputs as the military driver. */
export class FactionStoryDriver extends CampaignDriver {
  constructor(game: GameSession) { super(game); }
  get story() { return getFactionStory(this.snap().faction); }
  close(): void { this.game.step({ narrative: { type: 'close' } }); }
  visit(id: string): void {
    this.close();
    this.toNode(id);
    expect(this.snap().narrative!.discovered).toContain(id);
  }
  talk(id: string): void {
    const npc = this.story.npcs.find(person => person.id === id)!;
    this.visit(npc.locationId);
    this.game.step({ narrative: { type: 'talk', npcId: id } });
    expect(this.snap().narrative!.dialogue?.npcId, `Talk to ${id}`).toBe(id);
  }
  topic(id: string): void {
    const dialogue = this.snap().narrative!.dialogue!;
    if (dialogue.choices.some(choice => choice.id === `quest-${id}`)) {
      this.game.step({ narrative: { type: 'choose', npcId: dialogue.npcId, choiceId: `quest-${id}` } });
    }
  }
  choose(id: string): void {
    const quest = this.story.quests.find(q => q.stages.some(stage => stage.actions.some(action => action.id === id)));
    if (quest && !this.snap().narrative!.dialogue!.choices.some(choice => choice.id === id)) this.topic(quest.id);
    const dialogue = this.snap().narrative!.dialogue!;
    const choice = dialogue.choices.find(entry => entry.id === id);
    expect(choice?.enabled, `${dialogue.npcId}: ${id}; ${choice?.reason?.en}`).toBe(true);
    this.game.step({ narrative: { type: 'choose', npcId: dialogue.npcId, choiceId: id } });
    expect(this.snap().narrative!.notice).toBeNull();
  }
  inspect(id: string): void {
    this.visit(id);
    this.game.step({ narrative: { type: 'inspect', locationId: id } });
    expect(this.snap().narrative!.inspection?.locationId).toBe(id);
    expect(this.snap().narrative!.notice?.en).toContain('Place examined');
  }
  stage(stage: StoryStage, action: StoryAction = stage.actions[0]!): void {
    if (stage.kind === 'inspect') this.inspect(stage.at);
    else { this.talk(stage.at); this.choose(action.id); }
  }
  async quest(quest: StoryQuest, desiredAction?: string): Promise<void> {
    const completed = this.snap().narrative!.quests.find(q => q.id === quest.id)!.entries.length;
    for (const stage of quest.stages.slice(completed)) {
      this.stage(stage, stage.actions.find(action => action.id === desiredAction) ?? stage.actions[0]!);
      await yieldRunner();
    }
    expect(this.snap().narrative!.quests.find(q => q.id === quest.id)?.status).toBe('completed');
    this.close();
  }
  async directive(directive: FactionDirective): Promise<void> {
    const quest = this.story.quests.find(q => q.stages.some(stage => stage.actions.some(action => action.directive === directive)))!;
    for (const stage of quest.stages) {
      const chosen = stage.actions.find(action => action.directive === directive);
      this.stage(stage, chosen ?? stage.actions[0]!);
      await yieldRunner();
      if (chosen) break;
    }
    expect(this.snap().campaign!.directive).toBe(directive);
    this.close();
  }
  async finale(): Promise<StoryStage> {
    for (const quest of this.story.quests.filter(q => q.kind === 'main')) {
      const completed = this.snap().narrative!.quests.find(q => q.id === quest.id)!.entries.length;
      for (const stage of quest.stages.slice(completed)) {
        if (stage.actions.some(action => action.ending)) {
          this.talk(stage.at);
          this.topic(quest.id);
          return stage;
        }
        this.stage(stage);
        await yieldRunner();
      }
      this.close();
    }
    throw new Error('No unfinished faction finale');
  }
}
