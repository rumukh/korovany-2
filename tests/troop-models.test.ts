import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { createCampaign, type FactionId, type GameSnapshot } from '../src/game';
import { Presentation } from '../src/view';
import {
  CHARACTER_CLIPS, CharacterInstance, ModelLibrary, TROOPS, troopModelFor, type CharacterFrame, type ModelId, type TroopModelId,
} from '../src/view/models';
import { ViewResources } from '../src/view/resources';
import { brokenVariants, verifyMotion, type MotionContract } from './character-motion';
import { imageBytes, imageSize, parseGlbWithoutTextures, readGlb } from './glb';
import { yieldRunner } from './faction-driver';

// GLB parsing and per-frame verification settle on microtasks only; yield a macrotask between tests so the worker
// reads vitest's RPC replies (a file that never yields trips the 60 s onTaskUpdate timeout).
afterEach(yieldRunner);

const glb = (id: ModelId) => new Uint8Array(readFileSync(new URL(`../public/models/${id}/${id}.glb`, import.meta.url)));
const nodeSource = { load: (id: ModelId) => parseGlbWithoutTextures(glb(id)) };
const NEW_TROOPS = ['char-archer', 'char-captain', 'char-boss-raut', 'char-boss-marshal'] as const satisfies readonly TroopModelId[];

/**
 * Simulation contract of each actor kind (src/game/rules.ts and validation.ts): windup and recovery seconds, world speed.
 * The telegraphed clips last exactly as long as the states the game scrubs them by.
 */
const SIMULATION: Record<(typeof NEW_TROOPS)[number], { windup: number; recovery: number; speed: number; body: number }> = {
  'char-archer': { windup: 0.65, recovery: 0.65, speed: 3, body: 12_000 },
  'char-captain': { windup: 0.5, recovery: 0.65, speed: 3.5, body: 12_000 },
  'char-boss-raut': { windup: 0.85, recovery: 1.1, speed: 3.6, body: 20_000 },
  'char-boss-marshal': { windup: 0.85, recovery: 1.1, speed: 3.6, body: 20_000 },
};

/** Presentation contract of a cooked troop at its cooked (human) size, checked on every 60 Hz frame of the shipped skin. */
export function troopMotion(id: (typeof NEW_TROOPS)[number]): MotionContract {
  const { windup, recovery } = SIMULATION[id];
  // The game scales captains (x1.2) and bosses (x1.7), so their Run is cooked at the world speed divided by that scale.
  const cooked = TROOPS[id].runSpeed / TROOPS[id].scale;
  return {
    fps: 60, feet: ['foot_l', 'foot_r'], bodyRadius: 1.05, itemRadius: 3.1, minY: -0.03, maxY: 3.2, contactHeight: 0.025,
    plantedHeight: 0.012, maxSlideSpeed: 0.3, maxMeanSlideSpeed: 0.1, minSwingLift: 0.06, loopTolerance: 0.003, maxEdgeRatio: 8,
    minEdgeRatio: 0.02, strainQuantile: 0.995, maxQuantileStretch: 2.0, minQuantileCompression: 0.5, rigidTolerance: 0.01, maxWeightError: 0.002,
    clips: {
      Idle: { minSeconds: 2, maxSeconds: 3.5, loop: true, minMotion: 0.004, planted: true },
      AtEase: { minSeconds: 2.5, maxSeconds: 4, loop: true, minMotion: 0.004, planted: true },
      // Slow troops walk: each foot is planted for 30-70% of a stride.
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

describe('cooked troop models', () => {
  test.each(NEW_TROOPS)('%s: one skinned body within budget, troop joints, WebP maps and the soldier clip contract', async id => {
    const troop = TROOPS[id];
    expect(troop.runSpeed, 'Run is planted at the simulation speed').toBe(SIMULATION[id].speed);
    const bytes = glb(id);
    expect(bytes.byteLength).toBeLessThanOrEqual(id.startsWith('char-boss') ? 3_500_000 : 2_000_000);
    const document = readGlb(bytes);
    const { json: gltf } = document;
    expect(gltf.skins).toHaveLength(1);
    expect(gltf.cameras ?? []).toHaveLength(0);
    // Vertex data and rotation keys are quantized (KHR_mesh_quantization; three.js needs no decoder), then
    // meshopt-compressed without lossy filters (see models.test.ts).
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
    expect(body).toBeLessThanOrEqual(SIMULATION[id].body);
    expect(items).toBeLessThanOrEqual(1_500);
    expect(primitives).toBeLessThanOrEqual(3);
    const images = gltf.images!.map((image, index) => ({ name: image.name, ...imageSize(imageBytes(document, index)) }));
    expect(images.every(image => image.format === 'webp')).toBe(true);
    for (const name of ['body-base', 'body-normal', 'body-orm']) expect(images.find(image => image.name === name)?.width).toBeGreaterThanOrEqual(1024);
    // The base-colour alpha is the dye mask read by the shared dyed program.
    expect(images.find(image => image.name === 'body-base')?.alpha).toBe(true);
    const { scene, animations } = await parseGlbWithoutTextures(bytes);
    const bounds = new THREE.Box3().setFromObject(scene);
    expect(bounds.min.y).toBeCloseTo(0, 2);
    // Cooked at human size; the procedural figures' sizes come from the runtime scale.
    expect(bounds.max.y).toBeGreaterThan(2.1);
    expect(bounds.max.y).toBeLessThan(2.45);
    for (const clip of animations) {
      const rootTrack = clip.tracks.find(track => track.name === 'root.position');
      if (rootTrack) expect(new Set(rootTrack.values).size).toBeLessThanOrEqual(1);
    }
  });
});

describe('troop motion on every frame', () => {
  test.each(NEW_TROOPS)('%s passes deformation, contact, loop, clearance, strain and root-motion checks', async id => {
    const { scene, animations } = await parseGlbWithoutTextures(glb(id));
    const report = verifyMotion(scene, animations, troopMotion(id));
    expect(report.failures).toEqual([]);
    expect(report.maxInfluences).toBeLessThanOrEqual(4);
    expect(report.soles[0]).toBeGreaterThan(10);
    expect(report.soles[1]).toBeGreaterThan(10);
  }, 60_000);

  const expected: Record<string, [RegExp, string]> = {
    static: [/barely deforms/, 'Idle'], rootMotion: [/moves its root joint/, 'Run'], sliding: [/slides foot/, 'Run'],
    openLoop: [/does not close its loop/, 'Idle'], stretched: [/stretches an edge/, 'Strike'], unnormalizedWeights: [/not normalized/, 'Idle'],
  };
  test.each(NEW_TROOPS.flatMap(id => Object.keys(expected).map(name => [id, name] as const)))(
    '%s rejects a deliberately broken %s copy', async (id, name) => {
      const { scene, animations } = await parseGlbWithoutTextures(glb(id));
      // The archer draws with the left arm on the bow; everyone else swings with the right.
      const variant = brokenVariants(animations, 'root', id === 'char-archer' ? 'forearm_l' : 'forearm_r', 'Run', 'Strike')[name]!;
      if (variant.mutateWeights) {
        scene.traverse(object => {
          if (!(object instanceof THREE.SkinnedMesh)) return;
          const weights = object.geometry.getAttribute('skinWeight');
          for (let index = 0; index < weights.array.length; index++) (weights.array as Float32Array)[index]! *= 0.7;
        });
      }
      const [pattern, clip] = expected[name]!;
      const contract = troopMotion(id);
      const report = verifyMotion(scene, variant.clips, { ...contract, clips: { [clip]: contract.clips[clip]! } });
      expect(report.failures.some(failure => pattern.test(failure)), report.failures.join('\n')).toBe(true);
    }, 60_000);
});

type ActorVisuals = { actorVisuals: Map<string, { root: THREE.Group; character?: CharacterInstance }> };

describe('troop presentation without a DOM', () => {
  test.each<[FactionId, TroopModelId]>([['elf', 'char-boss-raut'], ['guard', 'char-boss-raut'], ['villain', 'char-boss-marshal']])(
    '%s run: archers, captains and the boss are cooked models on the shared dyed program at the procedural sizes', async (faction, boss) => {
      const library = new ModelLibrary(nodeSource);
      await library.ready;
      const snapshot = createCampaign({ seed: 'troop-presentation', faction }).snapshot();
      const presentation = new Presentation(snapshot.world, new ViewResources(undefined, 1, library));
      const disposed = vi.fn();
      try {
        presentation.update(snapshot, 1 / 60, new THREE.PerspectiveCamera(), false);
        const visuals = (presentation as unknown as ActorVisuals).actorVisuals;
        const kinds = new Set<string>();
        for (const actor of snapshot.actors) {
          if (actor.kind === 'caravan') continue;
          const visual = visuals.get(actor.id)!;
          const id = troopModelFor(actor.kind, actor.faction);
          if (actor.kind === 'boss') expect(id).toBe(boss);
          kinds.add(actor.kind);
          expect(visual.root.getObjectByName('actor-body'), actor.id).toBeUndefined();
          const character = visual.character!;
          expect(character.root.name).toBe(id);
          expect(character.root.scale.x).toBe(TROOPS[id].scale);
          const skinned = character.skinned[0]!;
          expect((skinned.material as THREE.MeshStandardMaterial).customProgramCacheKey()).toBe('korovany-dye-v1');
          expect(skinned.customDepthMaterial).toBe(library.depthMaterial());
          for (const item of TROOPS[id].items) expect(character.root.getObjectByName(item), `${actor.id} ${item}`).toBeInstanceOf(THREE.Mesh);
          if (actor.kind === 'boss') {
            const release = skinned.skeleton.dispose.bind(skinned.skeleton);
            skinned.skeleton.dispose = () => { disposed(); release(); };
          }
        }
        expect([...kinds].sort()).toEqual(['archer', 'boss', 'captain', 'soldier']);
      } finally {
        presentation.dispose();
      }
      expect(disposed).toHaveBeenCalledTimes(1);
      library.dispose();
    }, 60_000);

  test('telegraphed states scrub their clips by snapshot progress; the corpse holds; reduced motion is still', async () => {
    const library = new ModelLibrary(nodeSource, ['char-boss-raut']);
    await library.ready;
    const model = library.require('char-boss-raut');
    const material = new THREE.MeshStandardMaterial();
    const materials = { body: material, items: material, depth: material };
    const frame = (state: CharacterFrame['state'], progress = 0, extra: Partial<CharacterFrame> = {}): CharacterFrame =>
      ({ state, progress, speed: state === 'move' ? 3.6 : 0, hit: false, relaxed: false, reducedMotion: false, ...extra });
    const pose = (character: CharacterInstance) => character.skinned[0]!.skeleton.bones.flatMap(bone => bone.quaternion.toArray());
    const change = (a: number[], b: number[]) => Math.max(...a.map((value, index) => Math.abs(value - b[index]!)));
    const boss = new CharacterInstance(model, materials);
    const still = new CharacterInstance(model, materials);
    try {
      for (let tick = 0; tick < 20; tick++) boss.update(frame('move'), 1 / 60);
      expect(boss.activeClip).toBe('Run');
      for (let tick = 0; tick < 20; tick++) boss.update(frame('windup', tick / 40), 1 / 60);
      expect(boss.activeClip).toBe('Windup');
      const early = pose(boss);
      for (let tick = 0; tick < 10; tick++) boss.update(frame('windup', 0.95), 1 / 60);
      expect(change(pose(boss), early)).toBeGreaterThan(1e-3);
      for (let tick = 0; tick < 10; tick++) boss.update(frame('attack', 0.5), 1 / 60);
      expect(boss.activeClip).toBe('Strike');
      for (let tick = 0; tick < 20; tick++) boss.update(frame('recovery', tick / 20), 1 / 60);
      expect(boss.activeClip).toBe('Recovery');
      for (let tick = 0; tick < 90; tick++) boss.update(frame('dead'), 1 / 60);
      expect(boss.activeClip).toBe('Death');
      const corpse = pose(boss);
      for (let tick = 0; tick < 30; tick++) boss.update(frame('dead'), 1 / 60);
      expect(pose(boss)).toEqual(corpse);
      still.update(frame('idle', 0, { reducedMotion: true }), 1 / 60);
      const start = pose(still);
      for (let tick = 0; tick < 45; tick++) still.update(frame('idle', 0, { reducedMotion: true, hit: tick === 10 }), 1 / 60);
      expect(pose(still)).toEqual(start);
    } finally {
      boss.dispose();
      still.dispose();
      library.dispose();
    }
  });

  test('a mirror rebuilt after a boss falls shows the corpse, not a standing boss', async () => {
    const library = new ModelLibrary(nodeSource);
    await library.ready;
    const snapshot: GameSnapshot = createCampaign({ seed: 'troop-presentation', faction: 'villain' }).snapshot();
    const boss = snapshot.actors.find(actor => actor.kind === 'boss')!;
    boss.state = 'dead';
    boss.hp = 0;
    const presentation = new Presentation(snapshot.world, new ViewResources(undefined, 1, library));
    try {
      presentation.update(snapshot, 1 / 60, new THREE.PerspectiveCamera(), false);
      expect((presentation as unknown as ActorVisuals).actorVisuals.get(boss.id)!.character!.activeClip).toBe('Death');
    } finally {
      presentation.dispose();
      library.dispose();
    }
  });

  test('a missing troop model fails the library instead of falling back to a procedural figure', async () => {
    const library = new ModelLibrary({
      load: async (id: ModelId) => {
        if (id === 'char-boss-marshal') throw new Error('404 Not Found');
        return parseGlbWithoutTextures(glb(id));
      },
    });
    await expect(library.ready).rejects.toThrow('Could not load 3D model');
    expect(library.status.error).toMatch(/models\/char-boss-marshal\/char-boss-marshal\.glb/);
    library.dispose();
  });
});
