import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createCampaign, type FactionId, type GameSession, type GameSnapshot } from '../src/game';
import {
  campaignModelIds, HEROES, LANDMARK_IDS, MODEL_IDS, ModelLibrary, RESIDENTS, SHARED_MODEL_IDS, troopModelFor,
  type ModelId, type ModelSource,
} from '../src/view/models';
import { CampaignDriver } from './driver';
import { FactionStoryDriver } from './faction-driver';

const shipped = new URL('../public/models/', import.meta.url);
const bytes = (id: ModelId) => readFileSync(new URL(`${id}/${id}.glb`, shipped)).byteLength;
const FACTIONS: FactionId[] = ['elf', 'guard', 'villain'];
const RESIDENT_IDS: ModelId[] = Object.values(RESIDENTS).map(resident => resident.id);
const BOSSES: ModelId[] = ['char-boss-raut', 'char-boss-marshal'];
const STORY_WORLD: ModelId[] = [...RESIDENT_IDS, ...LANDMARK_IDS, 'prop-echo-well'];
/** The per-campaign preload budget for cooked models: 30 MiB in the approved plan, raised to 35 MiB by the owner on
 * 2026-10-06 for GPU-compressed (KTX2) landmarks and Echo Well. */
const PRELOAD_BUDGET = 35 * 1024 * 1024;

/** A source that hands out empty static meshes and counts how often each model is fetched. */
function countingSource(fail?: ModelId): ModelSource & { calls: Map<ModelId, number> } {
  const calls = new Map<ModelId, number>();
  return {
    calls,
    async load(id) {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      await Promise.resolve();
      if (id === fail) throw new Error('404 Not Found');
      const geometry = new THREE.BoxGeometry();
      const scene = new THREE.Group();
      scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
      return { scene, animations: [] };
    },
  };
}

describe('per-campaign model preloading', () => {
  test('requests load each model once, add to what is loaded and report readiness for everything requested', async () => {
    const source = countingSource();
    const library = new ModelLibrary(source, []);
    expect(library.isReady).toBe(true);
    expect(library.status).toEqual({ pending: 0, loaded: 0, total: 0, error: null });
    const first = library.request(['prop-cargo-load', 'prop-pickup-coin']);
    expect(library.isReady).toBe(false);
    expect(library.status).toMatchObject({ pending: 2, total: 2 });
    await first;
    expect(library.isReady).toBe(true);
    const second = library.request(['prop-pickup-coin', 'prop-pickup-health']);
    expect(library.isReady).toBe(false);
    expect(library.ids).toEqual(['prop-cargo-load', 'prop-pickup-coin', 'prop-pickup-health']);
    await second;
    await library.request(['prop-cargo-load']);
    expect(library.isReady).toBe(true);
    expect(library.status).toEqual({ pending: 0, loaded: 3, total: 3, error: null });
    expect([...source.calls.values()]).toEqual([1, 1, 1]);
    expect(library.get('prop-pickup-health')).toBeDefined();
    library.dispose();
  });

  test('a failed model in a later request surfaces through the request, status, readiness and assert', async () => {
    const library = new ModelLibrary(countingSource('prop-pickup-supply'), ['prop-pickup-coin']);
    await library.ready;
    await expect(library.request(['prop-pickup-coin', 'prop-pickup-supply'])).rejects.toThrow(
      /Could not load 3D model .*models\/prop-pickup-supply\/prop-pickup-supply\.glb: 404 Not Found/);
    expect(library.isReady).toBe(false);
    expect(library.status.error).toMatch(/prop-pickup-supply/);
    expect(() => library.assert()).toThrow('Reload to retry');
    await expect(library.request(['prop-pickup-supply'])).rejects.toThrow('Could not load 3D model');
    library.dispose();
  });

  test.each([1, 2] as const)('world v%i: a campaign loads its own hero, boss, troops and world models, and nothing else', version => {
    for (const faction of FACTIONS) {
      const snapshot = createCampaign({ seed: `models-${version}-${faction}`, faction, worldVersion: version }).snapshot();
      const ids = campaignModelIds(snapshot);
      const label = `v${version}/${faction}`;
      expect(new Set(ids).size, label).toBe(ids.length);
      expect(ids.every(id => MODEL_IDS.includes(id)), label).toBe(true);
      for (const id of SHARED_MODEL_IDS) expect(ids, label).toContain(id);
      // Only the player's hero, and only the boss this campaign fights.
      expect(ids.filter(id => id.startsWith('char-hero-')), label).toEqual([HEROES[faction].id]);
      const boss = snapshot.actors.find(actor => actor.kind === 'boss')!;
      expect(ids.filter(id => BOSSES.includes(id)), label).toEqual([troopModelFor('boss', boss.faction)]);
      for (const actor of snapshot.actors) {
        if (actor.kind !== 'caravan') expect(ids, `${label} ${actor.id}`).toContain(troopModelFor(actor.kind, actor.faction));
      }
      // The boss's reinforcement waves are its own faction's soldiers.
      expect(ids, label).toContain(troopModelFor('soldier', boss.faction));
      // The load-time warm-up's carrier troop stands in every campaign.
      expect(ids, label).toContain('char-line-soldier');
      if (version === 1) {
        expect(snapshot.narrative, label).toBeUndefined();
        expect(ids.filter(id => STORY_WORLD.includes(id)), label).toEqual([]);
      } else {
        for (const id of STORY_WORLD) expect(ids, label).toContain(id);
      }
    }
  });

  test('each campaign preloads less than every model and stays inside the 35 MB preload budget', () => {
    const all = MODEL_IDS.reduce((sum, id) => sum + bytes(id), 0);
    const sizes: Record<string, number> = {};
    for (const version of [1, 2] as const) {
      for (const faction of FACTIONS) {
        for (const seed of ['budget-a', 'budget-b']) {
          const ids = campaignModelIds(createCampaign({ seed, faction, worldVersion: version }).snapshot());
          const total = ids.reduce((sum, id) => sum + bytes(id), 0);
          sizes[`v${version}/${faction}`] = Math.max(sizes[`v${version}/${faction}`] ?? 0, total);
          expect(total).toBeLessThan(all);
          expect(total).toBeLessThanOrEqual(PRELOAD_BUDGET);
        }
      }
    }
    console.info('Per-campaign model preload (bytes)', JSON.stringify({ all, ...sizes }));
  });

  /**
   * Plays a campaign through public inputs and checks every model an actor needs against the set preloaded at the start
   * and at checkpoints along the way (a resumed save preloads from its own snapshot): every actor shown afterwards,
   * including the boss's reinforcement wave, must already be covered.
   */
  async function coverage(game: GameSession, play: (session: GameSession) => Promise<void>): Promise<{ final: GameSnapshot; reinforcements: Set<string> }> {
    const checkpoints: Set<ModelId>[] = [];
    const reinforcements = new Set<string>();
    const lastSeen = new Map<ModelId, number>();
    let calls = 0;
    const watched: GameSession = {
      ...game,
      snapshot: () => {
        const snapshot = game.snapshot();
        if (calls % 150 === 0) checkpoints.push(new Set(campaignModelIds(snapshot)));
        for (const actor of snapshot.actors) {
          if (actor.kind !== 'caravan') lastSeen.set(troopModelFor(actor.kind, actor.faction), checkpoints.length - 1);
          if (actor.id.startsWith('reinforcement-')) reinforcements.add(`${actor.kind}:${actor.faction}`);
        }
        calls++;
        return snapshot;
      },
    };
    await play(watched);
    expect(checkpoints.length).toBeGreaterThan(3);
    for (const [model, last] of lastSeen) {
      for (let index = 0; index <= last; index++) expect(checkpoints[index], `${model} at checkpoint ${index}`).toContain(model);
    }
    return { final: game.snapshot(), reinforcements };
  }

  test.each(FACTIONS)('legacy %s run: every troop shown, through the boss reinforcement wave, was preloaded', async faction => {
    const game = createCampaign({ seed: `acceptance-${faction}`, faction, runId: `models-${faction}`, worldVersion: 1 });
    const { final, reinforcements } = await coverage(game, async session => {
      const bot = new CampaignDriver(session);
      bot.capture('forest');
      bot.waitConvoy('forest');
      bot.raid();
      bot.capture('palace');
      bot.waitConvoy('palace');
      bot.toNode('fortress');
      bot.fight('fortress');
    });
    expect(final.phase).toBe('victory');
    expect(final.fortress.reinforcementWaves).toBe(1);
    expect([...reinforcements]).toEqual(['soldier:villain']);
  }, 60_000);

  test('mountain-sovereign campaign: the Crown reinforcement wave was preloaded with the Palace Marshal', async () => {
    const game = createCampaign({ seed: 'northern-roads', faction: 'villain', runId: 'models-villain' });
    const { final, reinforcements } = await coverage(game, async session => {
      const bot = new FactionStoryDriver(session);
      await bot.directive('dominion');
      bot.close();
      bot.military();
    });
    expect(final.fortress.reinforcementWaves).toBe(1);
    expect(final.fortress.bossDefeated).toBe(true);
    expect([...reinforcements]).toEqual(['soldier:guard']);
  }, 120_000);
});
