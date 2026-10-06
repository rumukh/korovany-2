import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createCampaign, type FactionId } from '../src/game';
import { Presentation } from '../src/view';
import {
  campaignModelIds, CHARACTER_CLIPS, CharacterInstance, FACTION_TROOP_IDS, FACTION_TROOPS, ModelLibrary, TROOPS, troopModelFor,
  type FactionTroopModelId, type ModelId, type TroopModelId,
} from '../src/view/models';
import { ViewResources } from '../src/view/resources';
import { brokenVariants, verifyMotion, type MotionContract } from './character-motion';
import { imageBytes, imageSize, parseGlbWithoutTextures, readGlb } from './glb';
import { yieldRunner } from './faction-driver';

// GLB parsing and per-frame verification settle on microtasks only; yield a macrotask between tests so the worker
// reads vitest's RPC replies.
afterEach(yieldRunner);

const glb = (id: ModelId) => new Uint8Array(readFileSync(new URL(`../public/models/${id}/${id}.glb`, import.meta.url)));
const nodeSource = { load: (id: ModelId) => parseGlbWithoutTextures(glb(id)) };
const KIND = (id: FactionTroopModelId) => id.split('-').at(-1) as 'soldier' | 'archer' | 'captain';

/** Simulation contract of each actor kind (src/game/rules.ts): windup and recovery seconds and world speed. */
const SIMULATION = {
  soldier: { windup: 0.5, recovery: 0.65, speed: 3.5 },
  archer: { windup: 0.65, recovery: 0.65, speed: 3 },
  captain: { windup: 0.5, recovery: 0.65, speed: 3.5 },
} as const;

/** Presentation contract of a faction troop at its cooked (human) size, checked on every 60 Hz frame of the shipped skin. */
export function factionTroopMotion(id: FactionTroopModelId): MotionContract {
  const { windup, recovery } = SIMULATION[KIND(id)];
  // Captains are shown at x1.2, so their Run is cooked at the world speed divided by that scale.
  const cooked = TROOPS[id].runSpeed / TROOPS[id].scale;
  return {
    fps: 60, feet: ['foot_l', 'foot_r'], bodyRadius: 1.05, itemRadius: 3.1, minY: -0.03, maxY: 3.2, contactHeight: 0.025,
    plantedHeight: 0.012, maxSlideSpeed: 0.3, maxMeanSlideSpeed: 0.1, minSwingLift: 0.06, loopTolerance: 0.003, maxEdgeRatio: 8,
    minEdgeRatio: 0.02, strainQuantile: 0.995, maxQuantileStretch: 2.0, minQuantileCompression: 0.5, rigidTolerance: 0.01, maxWeightError: 0.002,
    clips: {
      Idle: { minSeconds: 2, maxSeconds: 3.5, loop: true, minMotion: 0.004, planted: true },
      AtEase: { minSeconds: 2.5, maxSeconds: 4, loop: true, minMotion: 0.004, planted: true },
      Run: { minSeconds: 0.6, maxSeconds: 1.1, loop: true, minMotion: 0.2, velocity: [0, cooked], contact: [0.3, 0.7] },
      Windup: { minSeconds: windup - 0.02, maxSeconds: windup + 0.02, loop: false, minMotion: 0.15, planted: true },
      Strike: { minSeconds: 0.1, maxSeconds: 0.15, loop: false, minMotion: 0.1, planted: true },
      Recovery: { minSeconds: recovery - 0.02, maxSeconds: recovery + 0.02, loop: false, minMotion: 0.15, planted: true },
      Hit: { minSeconds: 0.25, maxSeconds: 0.45, loop: false, minMotion: 0.02, planted: true },
      Death: { minSeconds: 0.8, maxSeconds: 1.4, loop: false, minMotion: 0.6, ground: false, maxQuantileStretch: 2.8,
        minQuantileCompression: 0.4, holdsFinalPose: true },
    },
  };
}

describe('faction troop models', () => {
  test('the elves and the mountain army field their own soldier, archer and captain; bosses keep their faction models', () => {
    expect(FACTION_TROOPS.guard).toEqual({ soldier: 'char-line-soldier', archer: 'char-archer', captain: 'char-captain' });
    expect(FACTION_TROOPS.elf).toEqual({ soldier: 'char-elf-soldier', archer: 'char-elf-archer', captain: 'char-elf-captain' });
    expect(FACTION_TROOPS.villain).toEqual({ soldier: 'char-mountain-soldier', archer: 'char-mountain-archer', captain: 'char-mountain-captain' });
    for (const faction of ['elf', 'guard', 'villain'] as const) {
      for (const kind of ['soldier', 'archer', 'captain'] as const) expect(troopModelFor(kind, faction)).toBe(FACTION_TROOPS[faction][kind]);
    }
    expect(troopModelFor('boss', 'guard')).toBe('char-boss-marshal');
    expect(troopModelFor('boss', 'villain')).toBe('char-boss-raut');
    expect(troopModelFor('soldier', 'unknown')).toBe('char-line-soldier');
    expect(new Set(Object.values(FACTION_TROOPS).flatMap(troops => Object.values(troops))).size).toBe(9);
  });

  test.each(FACTION_TROOP_IDS)('%s: one skinned body within budget, troop joints, WebP maps and the soldier clip contract', async id => {
    const troop = TROOPS[id];
    expect(troop.runSpeed, 'Run is planted at the simulation speed').toBe(SIMULATION[KIND(id)].speed);
    expect(troop.scale).toBe(KIND(id) === 'captain' ? 1.2 : 1);
    const bytes = glb(id);
    expect(bytes.byteLength).toBeLessThanOrEqual(2_000_000);
    const document = readGlb(bytes);
    const { json: gltf } = document;
    expect(gltf.skins).toHaveLength(1);
    expect(gltf.extensionsRequired ?? []).toEqual(['EXT_meshopt_compression', 'EXT_texture_webp', 'KHR_mesh_quantization']);
    const joints = gltf.skins![0]!.joints.map(index => gltf.nodes![index]!.name);
    expect(joints.length).toBeLessThanOrEqual(40);
    for (const name of ['root', 'pelvis', 'spine', 'chest', 'head', 'hand_l', 'hand_r', 'foot_l', 'foot_r']) expect(joints).toContain(name);
    expect(gltf.animations!.map(animation => animation.name).sort()).toEqual([...CHARACTER_CLIPS].sort());
    expect(gltf.nodes!.filter(node => node.mesh !== undefined).map(node => node.name).sort()).toEqual(['body', ...troop.items].sort());
    let body = 0, items = 0, primitives = 0;
    for (const [index, mesh] of gltf.meshes!.entries()) {
      const skinned = gltf.nodes!.some(node => node.mesh === index && node.skin !== undefined);
      for (const primitive of mesh.primitives) {
        expect(primitive.attributes.NORMAL).toBeDefined();
        const count = gltf.accessors![primitive.indices!]!.count / 3;
        if (skinned) body += count;
        else items += count;
        primitives++;
      }
    }
    expect(body).toBeLessThanOrEqual(12_000);
    expect(items).toBeLessThanOrEqual(1_500);
    expect(primitives).toBeLessThanOrEqual(3);
    const images = gltf.images!.map((image, index) => ({ name: image.name, ...imageSize(imageBytes(document, index)) }));
    expect(images.every(image => image.format === 'webp')).toBe(true);
    for (const name of ['body-base', 'body-normal', 'body-orm']) expect(images.find(image => image.name === name)?.width).toBeGreaterThanOrEqual(512);
    // The faction colour field is dye-masked in the base-colour alpha, so legacy runs keep their brick-red coats.
    expect(images.find(image => image.name === 'body-base')?.alpha).toBe(true);
    const { scene, animations } = await parseGlbWithoutTextures(bytes);
    const bounds = new THREE.Box3().setFromObject(scene);
    expect(bounds.min.y).toBeCloseTo(0, 2);
    expect(bounds.max.y).toBeGreaterThan(2.05);
    expect(bounds.max.y).toBeLessThan(2.45);
    for (const clip of animations) {
      const rootTrack = clip.tracks.find(track => track.name === 'root.position');
      if (rootTrack) expect(new Set(rootTrack.values).size).toBeLessThanOrEqual(1);
    }
  });
});

describe('faction troop motion on every frame', () => {
  test.each(FACTION_TROOP_IDS)('%s passes deformation, contact, loop, clearance, strain and root-motion checks', async id => {
    const { scene, animations } = await parseGlbWithoutTextures(glb(id));
    const report = verifyMotion(scene, animations, factionTroopMotion(id));
    expect(report.failures).toEqual([]);
    expect(report.maxInfluences).toBeLessThanOrEqual(4);
    expect(report.soles[0]).toBeGreaterThan(10);
    expect(report.soles[1]).toBeGreaterThan(10);
  }, 60_000);

  const expected: Record<string, [RegExp, string]> = {
    static: [/barely deforms/, 'Idle'], rootMotion: [/moves its root joint/, 'Run'], sliding: [/slides foot/, 'Run'],
    openLoop: [/does not close its loop/, 'Idle'], stretched: [/stretches an edge/, 'Strike'], unnormalizedWeights: [/not normalized/, 'Idle'],
  };
  test.each(FACTION_TROOP_IDS.flatMap(id => Object.keys(expected).map(name => [id, name] as const)))(
    '%s rejects a deliberately broken %s copy', async (id, name) => {
      const { scene, animations } = await parseGlbWithoutTextures(glb(id));
      // Archers draw with the left arm on the bow; everyone else swings with the right.
      const variant = brokenVariants(animations, 'root', KIND(id) === 'archer' ? 'forearm_l' : 'forearm_r', 'Run', 'Strike')[name]!;
      if (variant.mutateWeights) {
        scene.traverse(object => {
          if (!(object instanceof THREE.SkinnedMesh)) return;
          const weights = object.geometry.getAttribute('skinWeight');
          for (let index = 0; index < weights.array.length; index++) (weights.array as Float32Array)[index]! *= 0.7;
        });
      }
      const [pattern, clip] = expected[name]!;
      const contract = factionTroopMotion(id);
      const report = verifyMotion(scene, variant.clips, { ...contract, clips: { [clip]: contract.clips[clip]! } });
      expect(report.failures.some(failure => pattern.test(failure)), report.failures.join('\n')).toBe(true);
    }, 60_000);
});

type ActorVisuals = { actorVisuals: Map<string, { root: THREE.Group; character?: CharacterInstance }> };

describe('faction troop presentation without a DOM', () => {
  test.each<[FactionId, 1 | 2]>([['elf', 2], ['guard', 2], ['villain', 2], ['guard', 1]])(
    '%s run (world v%i): every soldier, archer and captain wears its own faction\'s model on the shared dyed program', async (faction, version) => {
      const snapshot = createCampaign({ seed: 'faction-troops', faction, worldVersion: version }).snapshot();
      // The campaign's own preload set: its troops, hero, boss, wagons, pickups and, in story worlds, residents and landmarks.
      const library = new ModelLibrary(nodeSource, campaignModelIds(snapshot));
      await library.ready;
      const presentation = new Presentation(snapshot.world, new ViewResources(undefined, 1, library));
      try {
        presentation.update(snapshot, 1 / 60, new THREE.PerspectiveCamera(), false);
        const visuals = (presentation as unknown as ActorVisuals).actorVisuals;
        const shown = new Set<TroopModelId>();
        for (const actor of snapshot.actors) {
          if (actor.kind === 'caravan' || actor.kind === 'boss') continue;
          const id = FACTION_TROOPS[actor.faction as FactionId][actor.kind];
          const character = visuals.get(actor.id)!.character!;
          expect(character.root.name, actor.id).toBe(id);
          expect(character.root.scale.x).toBe(actor.kind === 'captain' ? 1.2 : 1);
          const skinned = character.skinned[0]!;
          expect((skinned.material as THREE.MeshStandardMaterial).customProgramCacheKey()).toBe('korovany-dye-v1');
          expect(skinned.customDepthMaterial).toBe(library.depthMaterial());
          for (const item of TROOPS[id].items) expect(character.root.getObjectByName(item), `${actor.id} ${item}`).toBeInstanceOf(THREE.Mesh);
          shown.add(id);
        }
        // Every faction wears its own troops: Crown kettle hats, elven hoods and mountain fur and iron never mix.
        const factions = new Set(snapshot.actors.filter(actor => actor.kind !== 'caravan').map(actor => actor.faction));
        expect([...shown].some(id => id.startsWith('char-elf-')), 'elf models shown').toBe(factions.has('elf'));
        expect([...shown].some(id => id.startsWith('char-mountain-')), 'mountain models shown').toBe(factions.has('villain'));
        for (const actor of snapshot.actors) {
          if (actor.kind === 'caravan' || actor.kind === 'boss') continue;
          const name = visuals.get(actor.id)!.character!.root.name;
          expect(name.startsWith('char-elf-'), actor.id).toBe(actor.faction === 'elf');
          expect(name.startsWith('char-mountain-'), actor.id).toBe(actor.faction === 'villain');
        }
      } finally {
        presentation.dispose();
        library.dispose();
      }
    }, 60_000);

  test('a missing faction troop fails the library instead of falling back to the Crown troop or a procedural figure', async () => {
    const library = new ModelLibrary({
      load: async (id: ModelId) => {
        if (id === 'char-elf-archer') throw new Error('404 Not Found');
        return parseGlbWithoutTextures(glb(id));
      },
    }, ['char-archer', 'char-elf-archer']);
    await expect(library.ready).rejects.toThrow('Could not load 3D model');
    expect(library.status.error).toMatch(/models\/char-elf-archer\/char-elf-archer\.glb/);
    expect(() => library.require('char-elf-archer')).toThrow('Could not load 3D model');
    library.dispose();
  });
});
