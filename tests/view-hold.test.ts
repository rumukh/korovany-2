import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createCampaign, type GameSnapshot } from '../src/game';
import { Presentation } from '../src/view';
import {
  CharacterInstance, DRAFT_OX, HEROES, HeroInstance, ModelLibrary, OxInstance, RESIDENTS, ResidentInstance,
  type CharacterFrame, type HeroFrame, type ModelId, type OxFrame,
} from '../src/view/models';
import { MonsterInstance, type MonsterFrame } from '../src/view/monsters';
import { ViewResources } from '../src/view/resources';
import { MONSTER_MODELS, SURFACE_SIZE, WorldAssetLibrary, worldAssetIds, type WorldAssetSource, type WorldModelId } from '../src/view/world-assets';
import { yieldRunner } from './faction-driver';
import { parseGlbWithoutTextures } from './glb';
import { fakeSurfaceAlbedo } from './world-surfaces';

afterEach(yieldRunner);

const models = { load: (id: ModelId) => parseGlbWithoutTextures(new Uint8Array(readFileSync(new URL(`../public/models/${id}/${id}.glb`, import.meta.url)))) };
const world: WorldAssetSource = {
  model: (id: WorldModelId) => parseGlbWithoutTextures(new Uint8Array(readFileSync(new URL(`../public/world/${id}/${id}.glb`, import.meta.url)))),
  image: async () => ({ width: SURFACE_SIZE, height: SURFACE_SIZE, data: new Uint8ClampedArray(SURFACE_SIZE * SURFACE_SIZE * 4).fill(128) }),
  surfaceAlbedo: async () => fakeSurfaceAlbedo(),
};
const material = new THREE.MeshStandardMaterial();
const pose = (skinned: THREE.SkinnedMesh[], root?: THREE.Object3D): number[] => [
  ...skinned[0]!.skeleton.bones.flatMap(bone => [...bone.quaternion.toArray(), ...bone.position.toArray()]),
  ...(root ? root.quaternion.toArray() : []),
];

/**
 * Updates until `settled()` holds, and then proves what the view relies on when it holds a frame: more updates with the
 * same frame leave the exact pose (and the settled state) unchanged. Returns the number of updates it took.
 */
function settle(name: string, settled: () => boolean, update: () => void, current: () => number[], limit = 400): number {
  for (let frame = 0; frame < limit; frame++) {
    if (settled()) {
      const held = current();
      for (let again = 0; again < 10; again++) update();
      expect(current(), `${name} keeps its pose once settled`).toEqual(held);
      expect(settled(), `${name} stays settled`).toBe(true);
      return frame;
    }
    update();
  }
  throw new Error(`${name} never settled within ${limit} updates`);
}

describe('the view holds a frame only once nothing in it can move', () => {
  test('a troop settles after its fade, death or flinch has played out, and only under reduced motion', async () => {
    const library = new ModelLibrary(models, ['char-line-soldier']);
    await library.ready;
    const troop = new CharacterInstance(library.require('char-line-soldier'), { body: material, items: material, depth: material });
    const frame = (state: CharacterFrame['state'], extra: Partial<CharacterFrame> = {}): CharacterFrame =>
      ({ state, progress: 0, speed: state === 'move' ? 3.6 : 0, hit: false, relaxed: false, reducedMotion: true, ...extra });
    try {
      expect(troop.settled).toBe(false);
      for (let tick = 0; tick < 20; tick++) troop.update(frame('move'), 1 / 60);
      expect(troop.settled).toBe(false);
      const update = (next: CharacterFrame) => () => troop.update(next, 1 / 60);
      troop.update(frame('idle'), 1 / 60);
      expect(troop.settled, 'the run is still fading out').toBe(false);
      expect(settle('a stopped troop', () => troop.settled, update(frame('idle')), () => pose(troop.skinned))).toBeGreaterThan(3);
      troop.update(frame('idle', { hit: true }), 1 / 60);
      expect(troop.settled, 'reduced motion skips the flinch').toBe(true);
      troop.update(frame('idle', { reducedMotion: false, hit: true }), 1 / 60);
      expect(troop.settled).toBe(false);
      troop.update(frame('dead'), 1 / 60);
      expect(troop.settled, 'the death is playing').toBe(false);
      expect(settle('a corpse', () => troop.settled, update(frame('dead')), () => pose(troop.skinned))).toBeGreaterThan(10);
    } finally {
      troop.dispose();
      library.dispose();
    }
  });

  test('the hero settles after its blend, turn, swing and death, and never while breathing at normal motion', async () => {
    const library = new ModelLibrary(models, ['char-hero-guard']);
    await library.ready;
    const hero = new HeroInstance(library.require('char-hero-guard'), HEROES.guard.runSpeed, { body: material, items: material, depth: material });
    const frame = (extra: Partial<HeroFrame> = {}): HeroFrame => ({
      velocity: { x: 0, z: 0 }, dodging: false, dead: false, attack: false, ability: false, hit: false, working: false, relaxed: false,
      reducedMotion: true, ...extra,
    });
    const current = () => pose(hero.skinned, hero.root);
    try {
      expect(hero.settled).toBe(false);
      for (let tick = 0; tick < 30; tick++) hero.update(frame({ velocity: { x: 3, z: 2 } }), 1 / 60);
      expect(hero.settled, 'running').toBe(false);
      hero.update(frame(), 1 / 60);
      expect(hero.settled, 'still blending and turning').toBe(false);
      expect(settle('a stopped hero', () => hero.settled, () => hero.update(frame(), 1 / 60), current)).toBeGreaterThan(3);
      hero.update(frame({ attack: true }), 1 / 60);
      expect(hero.settled, 'swinging').toBe(false);
      expect(settle('a hero after a swing', () => hero.settled, () => hero.update(frame(), 1 / 60), current)).toBeGreaterThan(10);
      hero.update(frame({ reducedMotion: false }), 1 / 60);
      expect(hero.settled, 'normal motion breathes').toBe(false);
      hero.update(frame(), 1 / 60);
      hero.update(frame({ dead: true }), 1 / 60);
      expect(hero.settled, 'dying').toBe(false);
      expect(settle('a dead hero', () => hero.settled, () => hero.update(frame({ dead: true }), 1 / 60), current)).toBeGreaterThan(10);
    } finally {
      hero.dispose();
      library.dispose();
    }
  });

  test('an ox and a resident settle under reduced motion only', async () => {
    const library = new ModelLibrary(models, [DRAFT_OX.id, RESIDENTS.toman.id]);
    await library.ready;
    const ox = new OxInstance(library.require(DRAFT_OX.id), { body: material, depth: material });
    const resident = new ResidentInstance(library.require(RESIDENTS.toman.id), { body: material, depth: material });
    const oxFrame = (extra: Partial<OxFrame> = {}): OxFrame => ({ speed: 0, hit: false, reducedMotion: true, ...extra });
    try {
      for (let tick = 0; tick < 30; tick++) ox.update(oxFrame({ speed: DRAFT_OX.gaits.Trot }), 1 / 60);
      expect(ox.settled, 'trotting').toBe(false);
      ox.update(oxFrame(), 1 / 60);
      expect(ox.settled, 'the trot is still fading out').toBe(false);
      expect(settle('a halted ox', () => ox.settled, () => ox.update(oxFrame(), 1 / 60), () => pose(ox.skinned))).toBeGreaterThan(3);
      ox.update(oxFrame({ reducedMotion: false }), 1 / 60);
      expect(ox.settled, 'normal motion breathes').toBe(false);

      resident.update({ talking: true, reducedMotion: true }, 1 / 60);
      expect(resident.settled, 'reduced motion skips the gestures').toBe(true);
      settle('a resident', () => resident.settled, () => resident.update({ talking: true, reducedMotion: true }, 1 / 60), () => pose(resident.skinned));
      resident.update({ talking: false, reducedMotion: false }, 1 / 60);
      expect(resident.settled).toBe(false);
    } finally {
      ox.dispose();
      resident.dispose();
      library.dispose();
    }
  });

  test('a beast settles after its walk, death or flinch has played out', async () => {
    const library = new WorldAssetLibrary(world);
    await library.request([MONSTER_MODELS.wolf]);
    const wolf = new MonsterInstance(library.require(MONSTER_MODELS.wolf), 'wolf');
    const frame = (state: MonsterFrame['state'], extra: Partial<MonsterFrame> = {}): MonsterFrame =>
      ({ state, progress: 0, speed: state === 'move' ? 1.2 : 0, hit: false, reducedMotion: true, ...extra });
    try {
      for (let tick = 0; tick < 20; tick++) wolf.update(frame('move'), 1 / 60);
      expect(wolf.settled, 'walking').toBe(false);
      wolf.update(frame('idle'), 1 / 60);
      expect(wolf.settled, 'the walk is still fading out').toBe(false);
      settle('a stopped wolf', () => wolf.settled, () => wolf.update(frame('idle'), 1 / 60), () => pose(wolf.root.getObjectsByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh[]));
      wolf.update(frame('idle', { hit: true, reducedMotion: false }), 1 / 60);
      expect(wolf.settled, 'flinching at normal motion').toBe(false);
      wolf.update(frame('dead'), 1 / 60);
      expect(wolf.settled, 'dying').toBe(false);
      settle('a dead wolf', () => wolf.settled, () => wolf.update(frame('dead'), 1 / 60), () => pose(wolf.root.getObjectsByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh[]));
    } finally {
      wolf.dispose();
    }
  });

  test('a version 3 presentation settles once its sparks burn out and its air has eased, under reduced motion only', async () => {
    const snapshot = createCampaign({ seed: 'view-hold', faction: 'guard', runId: 'view-hold', worldVersion: 3 }).snapshot();
    const library = new WorldAssetLibrary(world);
    await library.request(worldAssetIds(snapshot.world));
    const presentation = new Presentation(snapshot.world, new ViewResources(undefined, 1, undefined, library));
    const camera = new THREE.PerspectiveCamera();
    const update = (next: Readonly<GameSnapshot>, reducedMotion = true) => () => presentation.update(next, 0.1, camera, reducedMotion);
    const fog = () => [...(presentation.scene.fog as THREE.Fog).color.toArray(), (presentation.scene.fog as THREE.Fog).near];
    try {
      expect(presentation.settled).toBe(false);
      settle('a paused presentation', () => presentation.settled, update(snapshot), fog);
      presentation.update(snapshot, 0.1, camera, false);
      expect(presentation.settled, 'normal motion animates flags, water and weather').toBe(false);
      settle('a paused presentation again', () => presentation.settled, update(snapshot), fog);

      const latest = snapshot.events.reduce((id, event) => Math.max(id, event.id), 0);
      const hurt: GameSnapshot = { ...snapshot, events: [...snapshot.events,
        { id: latest + 1, kind: 'hurt', x: snapshot.player.x, z: snapshot.player.z } as GameSnapshot['events'][number]] };
      presentation.update(hurt, 0.1, camera, true);
      expect(presentation.settled, 'a spark burst is burning').toBe(false);
      expect(settle('burnt-out sparks', () => presentation.settled, update(hurt), fog)).toBeGreaterThanOrEqual(5);

      const region = snapshot.world.exploration!.regions.find(entry => entry.id === 'fenlands')!;
      const fens: GameSnapshot = { ...hurt, player: { ...snapshot.player,
        x: (region.bounds.minX + region.bounds.maxX) / 2, z: (region.bounds.minZ + region.bounds.maxZ) / 2 } };
      presentation.update(fens, 0.1, camera, true);
      expect(presentation.settled, 'the fog is easing into the Fens').toBe(false);
      expect(settle('the Fens air', () => presentation.settled, update(fens), fog)).toBeGreaterThan(20);
    } finally {
      presentation.dispose();
    }
  });
});
