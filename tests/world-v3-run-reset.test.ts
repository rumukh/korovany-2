import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createCampaign } from '../src/game';
import type { GameSnapshot } from '../src/game/types';
import { Presentation } from '../src/view';
import { ViewResources } from '../src/view/resources';
import { SURFACE_SIZE, WorldAssetLibrary, worldAssetIds, type WorldAssetSource, type WorldModelId } from '../src/view/world-assets';
import { parseGlbWithoutTextures } from './glb';

// A campaign begun or continued from its title preview keeps the world's presentation (terrain, scenery, animals) and
// releases only the run's visuals, so starting a run no longer rebuilds the whole world.
const shipped = new URL('../public/world/', import.meta.url);
const nodeSource: WorldAssetSource = {
  model: (id: WorldModelId) => parseGlbWithoutTextures(new Uint8Array(readFileSync(new URL(`${id}/${id}.glb`, shipped)))),
  image: async () => ({ width: SURFACE_SIZE, height: SURFACE_SIZE, data: new Uint8ClampedArray(SURFACE_SIZE * SURFACE_SIZE * 4).fill(128) }),
};

/** Names of everything a run puts in the scene beside the world's own groups (which a new run keeps). */
function runSignature(view: Presentation): string[] {
  const kept = new Set<THREE.Object3D>([view.scenery.group]);
  if (view.fauna) kept.add(view.fauna.group);
  if (view.herds) kept.add(view.herds.group);
  const names: string[] = [];
  for (const child of view.scene.children) {
    if (kept.has(child)) continue;
    names.push(`${child.type}:${child.name}:${child.visible}:${child.position.toArray().map(v => v.toFixed(3)).join(',')}`);
  }
  return names.sort();
}

const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.25, 290);
function show(view: Presentation, snapshot: GameSnapshot, frames = 3): void {
  for (let i = 0; i < frames; i++) {
    const frame = structuredClone(snapshot);
    frame.tick += i;
    view.update(frame, 1 / 60, camera, true);
  }
}

describe('a new run on the same world keeps its presentation', () => {
  test('after resetRun the scene holds exactly what a new presentation would draw for the run', async () => {
    // The title preview and the run share the world (same seed and faction); the run has moved on and lost its hero.
    const preview = createCampaign({ seed: 'reset-run', faction: 'villain', runId: 'title-preview', worldVersion: 3 }).snapshot();
    const session = createCampaign({ seed: 'reset-run', faction: 'villain', runId: 'the-run', worldVersion: 3 });
    for (let i = 0; i < 240; i++) session.step({ move: { x: 0.6, z: -0.8 } });
    const run = structuredClone(session.snapshot());
    expect(run.world.id).toBe(preview.world.id);
    run.player.state = 'dead';
    run.player.hp = 0;
    const library = new WorldAssetLibrary(nodeSource);
    await library.request(worldAssetIds(run.world));
    const reused = new Presentation(preview.world, new ViewResources(undefined, 1, undefined, library));
    const fresh = new Presentation(run.world, new ViewResources(undefined, 1, undefined, library));
    try {
      show(reused, preview);
      const scenery = reused.scenery.group, terrain = reused.terrain, herds = reused.herds;
      const before = reused.scene.children.length;
      const heroOf = (view: Presentation) => (view as unknown as { hero?: { root: THREE.Object3D } }).hero;
      const previewHero = heroOf(reused)!.root;
      expect(previewHero.parent).toBe(reused.scene);
      reused.resetRun();
      // The preview's hero, banner, convoy, troops and residents are gone until the run's first frame.
      expect(reused.scene.children.length).toBeLessThan(before);
      expect(heroOf(reused)).toBeUndefined();
      expect(previewHero.parent).toBeNull();
      show(reused, run);
      show(fresh, run);
      expect(heroOf(reused)!.root.parent).toBe(reused.scene);
      // Exactly what a new presentation draws for the run: one banner, the dead hero where the run left it, its troops.
      expect(runSignature(reused)).toEqual(runSignature(fresh));
      // The world was kept, not rebuilt.
      expect(reused.scenery.group).toBe(scenery);
      expect(reused.terrain).toBe(terrain);
      expect(reused.herds).toBe(herds);
    } finally {
      reused.dispose();
      fresh.dispose();
      library.dispose();
    }
  }, 120_000);
});
