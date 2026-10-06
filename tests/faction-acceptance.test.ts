import { describe, expect, test } from 'vitest';
import { createCampaign } from '../src/game';
import { dist } from './driver';

// The six campaign cases live in faction-acceptance-<faction>-<directive>.test.ts (shared code: faction-acceptance.ts).
describe('substantive faction campaign acceptance through public inputs', () => {
  test('three roles occupy distinct real homes with independent humans and authoritative reachable military targets', () => {
    const homes = new Set<string>(), positions = new Set<string>(), roles = new Set<string>(), starts = new Set<string>();
    for (const faction of ['elf', 'guard', 'villain'] as const) {
      const snapshot = createCampaign({ faction, seed: 'distinct-campaigns' }).snapshot();
      const campaign = snapshot.campaign!;
      const home = snapshot.world.sites.find(site => site.id === 'home')!;
      const location = snapshot.world.exploration!.locations.find(place => place.id === campaign.identity.homeLocationId)!;
      expect(home).toMatchObject({ x: location.x, z: location.z, faction, allegiance: 'friendly' });
      expect(dist(snapshot.player, home)).toBeLessThan(4);
      expect(dist(snapshot.convoy, home)).toBe(0);
      expect(snapshot.narrative!.discovered).toContain(location.id);
      expect(campaign.standing.find(standing => standing.id === 'neutral')?.relation).toBe('neutral');
      expect(campaign.standing.find(standing => standing.id === faction)?.relation).toBe('friendly');
      const target = campaign.requirements.find(requirement => !requirement.complete)!.targetId;
      expect(snapshot.narrative!.npcs.some(npc => npc.id === target)).toBe(true);
      homes.add(location.id);
      positions.add(`${home.x},${home.z}`);
      roles.add(campaign.identity.role.en);
      starts.add(snapshot.narrative!.quests[0]!.id);
    }
    expect(homes).toEqual(new Set(['greenhollow', 'crownbridge', 'old-fort']));
    expect(positions.size).toBe(3);
    expect(roles.size).toBe(3);
    expect(starts.size).toBe(3);
  });
});
