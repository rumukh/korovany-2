import { describe, expect, it } from 'vitest';
import { createCampaign, OutdatedWorldError, restoreCampaign } from '../src/game';
import { translate } from '../src/ui/locale';

// W2b: the browser shell starts new campaigns in world version 3, whose layout still grows between releases. A v3
// save from an earlier release must be refused with its own explanation, never loaded into a rebuilt world.
function played(worldVersion: 2 | 3) {
  const game = createCampaign({ seed: `w2b-${worldVersion}`, faction: 'guard', runId: `w2b-${worldVersion}`, worldVersion });
  for (let tick = 0; tick < 120; tick++) game.step({ move: { x: 0.3, z: 1 }, sprint: tick % 2 === 0 });
  return game;
}

describe('version 3 saves across releases', () => {
  it('restores a version 3 save made by the current generator', () => {
    const game = played(3);
    const save = game.serialize();
    expect(save.version).toBe(3);
    expect(save.worldId.startsWith('k2-v3-')).toBe(true);
    const restored = restoreCampaign(JSON.parse(JSON.stringify(save)));
    expect(restored.snapshot().world.id).toBe(game.snapshot().world.id);
    expect(restored.snapshot().tick).toBe(game.snapshot().tick);
    expect(restored.serialize()).toEqual(save);
  });

  it('refuses a version 3 save whose world an earlier release generated with OutdatedWorldError', () => {
    const save = JSON.parse(JSON.stringify(played(3).serialize()));
    save.worldId = save.worldId.replace(/^k2-v3-[0-9a-f]+/, 'k2-v3-0badc0de');
    expect(() => restoreCampaign(save)).toThrow(OutdatedWorldError);
    expect(() => restoreCampaign(save)).toThrow('earlier version of the world');
  });

  it('keeps the ordinary mismatch error for version 1 and 2 saves and foreign world ids', () => {
    const v2 = JSON.parse(JSON.stringify(played(2).serialize()));
    v2.worldId = v2.worldId.replace(/^k2-v2-[0-9a-f]+/, 'k2-v2-0badc0de');
    expect(() => restoreCampaign(v2)).toThrow('Saved world does not match the seed/version');
    expect(() => restoreCampaign(v2)).not.toThrow(OutdatedWorldError);
    const v1 = JSON.parse(JSON.stringify(createCampaign({ seed: 'w2b-1', faction: 'guard', runId: 'w2b-1', worldVersion: 1 }).serialize()));
    v1.worldId = 'k2-v1-0badc0de';
    expect(() => restoreCampaign(v1)).toThrow('Saved world does not match the seed/version');
    const foreign = JSON.parse(JSON.stringify(played(3).serialize()));
    foreign.worldId = 'k2-v2-0badc0de-guard-campaign3';
    expect(() => restoreCampaign(foreign)).toThrow('Saved world does not match the seed/version');
    expect(() => restoreCampaign(foreign)).not.toThrow(OutdatedWorldError);
  });

  it('explains an outdated world in Russian and English', () => {
    const ru = translate('ru', 'storage.outdatedWorld');
    const en = translate('en', 'storage.outdatedWorld');
    expect(ru).toContain('прежней версии мира');
    expect(en).toContain('earlier version of the world');
    for (const text of [ru, en]) expect(text).not.toBe(translate(text === ru ? 'ru' : 'en', 'storage.corrupt'));
  });
});
