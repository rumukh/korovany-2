import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createCampaign, type GameSnapshot } from '../src/game';
import {
  ModelLibrary, RESIDENT_CLIPS, RESIDENTS, residentModelFor, type ModelId, type ModelSource, type ResidentNpc,
} from '../src/view/models';
import { WorldResidents } from '../src/view/residents';
import { ViewResources } from '../src/view/resources';
import { verifyMotion } from './character-motion';
import { imageBytes, imageSize, parseGlbWithoutTextures, readGlb } from './glb';
import { CampaignDriver } from './driver';
import { residentBrokenVariants, residentMotion } from './resident-motion';
import { yieldRunner } from './faction-driver';

// GLB parsing and per-frame verification settle on microtasks only, so without a macrotask between tests the whole
// file is one event-loop turn: the worker cannot read vitest's RPC replies and trips its 60 s onTaskUpdate timeout.
afterEach(yieldRunner);

const NPCS = Object.keys(RESIDENTS) as ResidentNpc[];
const IDS = NPCS.map(npc => RESIDENTS[npc].id);
const glb = (id: ModelId) => new Uint8Array(readFileSync(new URL(`../public/models/${id}/${id}.glb`, import.meta.url)));
const nodeSource: ModelSource = { load: id => parseGlbWithoutTextures(glb(id)) };

function triangles(document: ReturnType<typeof readGlb>): number {
  const { json: gltf } = document;
  return gltf.meshes!.reduce((sum, mesh) => sum + mesh.primitives.reduce((part, primitive) =>
    part + gltf.accessors![primitive.indices!]!.count / 3, 0), 0);
}

async function library(ids: readonly ModelId[] = IDS, source = nodeSource): Promise<ModelLibrary> {
  const models = new ModelLibrary(source, ids);
  await models.ready;
  return models;
}

function snapshotOf(faction: 'elf' | 'guard' | 'villain'): GameSnapshot {
  return structuredClone(createCampaign({ seed: 'resident-models', faction, runId: `resident-models-${faction}` }).snapshot());
}

/** Each faction's home residents, listed by a fresh campaign; Mara and Ren keep the Roadward Inn. */
const HOME: Record<'elf' | 'guard' | 'villain', ResidentNpc[]> = { elf: ['lida', 'toman'], guard: ['vesk'], villain: ['ren'] };

function roadward(): GameSnapshot {
  const game = createCampaign({ seed: 'resident-roadward', faction: 'guard', runId: 'resident-roadward' });
  new CampaignDriver(game).toNode('roadward');
  return structuredClone(game.snapshot());
}

/** Stands the hero a few metres in front of a resident, inside the 8 m facing range. */
function standBefore(snapshot: GameSnapshot, npcId: string, distance = 5): void {
  const npc = snapshot.narrative!.npcs.find(person => person.id === npcId)!;
  snapshot.player.x = npc.x;
  snapshot.player.z = npc.z + distance;
}

function boneState(root: THREE.Object3D): number[] {
  const values: number[] = [];
  root.traverse(object => {
    if (object instanceof THREE.Bone) values.push(...object.quaternion.toArray(), ...object.position.toArray());
  });
  return values;
}

describe('cooked residents', () => {
  test.each(NPCS)('%s: one skinned body within budget, WebP maps, Idle and Talk, standing at its height and facing +Z', async npc => {
    const { id, height } = RESIDENTS[npc];
    const bytes = glb(id);
    expect(bytes.byteLength).toBeLessThanOrEqual(1_500_000);
    const document = readGlb(bytes);
    const { json: gltf } = document;
    expect(gltf.skins).toHaveLength(1);
    const joints = gltf.skins![0]!.joints.map(index => gltf.nodes![index]!.name);
    for (const name of ['root', 'pelvis', 'spine', 'chest', 'neck', 'head', 'hand_l', 'hand_r', 'foot_l', 'foot_r', 'toe_l', 'toe_r']) {
      expect(joints).toContain(name);
    }
    expect(gltf.animations!.map(animation => animation.name).sort()).toEqual([...RESIDENT_CLIPS].sort());
    expect(gltf.nodes!.filter(node => node.mesh !== undefined)).toHaveLength(1);
    expect(triangles(document)).toBeLessThanOrEqual(10_000);
    const images = gltf.images!.map((image, index) => ({ name: image.name, ...imageSize(imageBytes(document, index)) }));
    expect(images.every(image => image.format === 'webp')).toBe(true);
    for (const name of ['body-base', 'body-normal']) expect(images.find(image => image.name === name)?.width).toBeGreaterThanOrEqual(512);
    expect(images.find(image => image.name === 'body-orm')?.width).toBe(512);
    // Vertex data and rotation keys are quantized (KHR_mesh_quantization, read by three.js without a decoder); the
    // positions' dequantization lives in the inverse bind matrices, so the bounds below are measured through the skin.
    expect(gltf.extensionsRequired).toContain('KHR_mesh_quantization');
    const attributes = gltf.meshes![0]!.primitives[0]!.attributes;
    expect(gltf.accessors![attributes['POSITION']!]).toMatchObject({ componentType: 5122, normalized: true });
    expect(gltf.accessors![attributes['WEIGHTS_0']!]).toMatchObject({ componentType: 5121, normalized: true });
    const { scene } = await parseGlbWithoutTextures(bytes);
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(scene);
    expect(bounds.min.y).toBeCloseTo(0, 2);
    expect(bounds.max.y).toBeGreaterThan(height * 0.97);
    expect(bounds.max.y).toBeLessThan(height * 1.03);
    // The game's heading is +Z forward: the balls of the feet are ahead of the ankles.
    for (const side of ['l', 'r']) {
      const ankle = new THREE.Vector3().setFromMatrixPosition(scene.getObjectByName(`foot_${side}`)!.matrixWorld);
      const ball = new THREE.Vector3().setFromMatrixPosition(scene.getObjectByName(`toe_${side}`)!.matrixWorld);
      expect(ball.z - ankle.z, side).toBeGreaterThan(0.05);
    }
  });
});

describe('resident motion on every frame', () => {
  test.each(NPCS)('%s: planted Idle and Talk loops pass deformation, contact, loop, strain and root-motion checks', async npc => {
    const { scene, animations } = await parseGlbWithoutTextures(glb(RESIDENTS[npc].id));
    const report = verifyMotion(scene, animations, residentMotion(RESIDENTS[npc].height));
    expect(report.failures).toEqual([]);
    expect(report.clips.map(clip => clip.name).sort()).toEqual([...RESIDENT_CLIPS].sort());
  });

  const expected: Record<string, RegExp> = {
    static: /barely deforms/, rootMotion: /moves its root joint/, sliding: /slides foot_/, openLoop: /does not close its loop/,
    stretched: /scaling joint forearm_r/, unnormalizedWeights: /not normalized/,
  };
  test.each(Object.keys(expected))('rejects a deliberately broken %s copy', async name => {
    const { id, height } = RESIDENTS.toman;
    const { animations } = await parseGlbWithoutTextures(glb(id));
    const variant = residentBrokenVariants(animations)[name]!;
    const fresh = await parseGlbWithoutTextures(glb(id));
    if (variant.mutateWeights) {
      fresh.scene.traverse(object => {
        if (!(object instanceof THREE.SkinnedMesh)) return;
        const weights = object.geometry.getAttribute('skinWeight');
        for (let index = 0; index < weights.array.length; index++) (weights.array as Float32Array)[index]! *= 0.7;
      });
    }
    const report = verifyMotion(fresh.scene, variant.clips, residentMotion(height));
    expect(report.failures.some(failure => expected[name]!.test(failure)), JSON.stringify(report.failures)).toBe(true);
  });
});

describe('residents without a DOM', () => {
  test.each(['elf', 'guard', 'villain'] as const)('%s run: cooked residents use the shared skinned program; the others stay procedural', async faction => {
    const models = await library();
    const resources = new ViewResources(undefined, 1, models);
    const scene = new THREE.Scene();
    const residents = new WorldResidents(resources, scene);
    const camera = new THREE.PerspectiveCamera();
    try {
      const snapshot = snapshotOf(faction);
      residents.update(snapshot, camera, false, 1 / 60);
      for (const npc of snapshot.narrative!.npcs) {
        const root = scene.getObjectByName(`resident:${npc.id}`)!;
        expect(root, npc.id).toBeDefined();
        const id = residentModelFor(npc.id);
        const skinned: THREE.SkinnedMesh[] = [];
        root.traverse(object => { if (object instanceof THREE.SkinnedMesh) skinned.push(object); });
        expect(skinned.length, npc.id).toBe(id ? 1 : 0);
        expect(Boolean(residents.model(npc.id)), npc.id).toBe(Boolean(id));
        if (!id) continue;
        const body = skinned[0]!;
        // The troops' dyed program with an empty mask: residents add no shader variant.
        expect((body.material as THREE.Material).customProgramCacheKey()).toBe('korovany-dye-v1');
        expect(body.customDepthMaterial).toBe(resources.modelDepthMaterial());
        expect(body.castShadow).toBe(true);
        // The game-owned ring and marker stay.
        expect(root.children.filter(child => child instanceof THREE.Mesh && !(child instanceof THREE.SkinnedMesh))).toHaveLength(2);
      }
      expect([...residents.modelIds].sort()).toEqual(HOME[faction].map(npc => RESIDENTS[npc].id).sort());
    } finally {
      residents.dispose();
      resources.dispose();
      models.dispose();
    }
  });

  test('Roadward shows Mara and Ren cooked', async () => {
    const models = await library();
    const resources = new ViewResources(undefined, 1, models);
    const scene = new THREE.Scene();
    const residents = new WorldResidents(resources, scene);
    try {
      residents.update(roadward(), new THREE.PerspectiveCamera(), false, 1 / 60);
      expect(residents.model('mara')).toBeDefined();
      expect(residents.model('ren')).toBeDefined();
    } finally {
      residents.dispose();
      resources.dispose();
      models.dispose();
    }
  }, 60_000);

  // Batch D2: the Cinderwell pair, the Hollow Village pair and Elin at the Last Archive; batch D3: Lev, Yara, Nika, Radek
  // and Oss at their own locations; batch D4: Ivet, Sella, Orsa, Hana and Dren at theirs. Each is reached by a real walk.
  test.each([
    ['cinderwell', 'elf', ['beran', 'tessa']],
    ['hollow-village', 'guard', ['ada', 'mila']],
    ['last-archive', 'guard', ['elin']],
    ['star-monastery', 'villain', ['lev']],
    ['thornwatch', 'elf', ['yara']],
    ['high-pass', 'villain', ['nika']],
    ['bell-foundry', 'guard', ['radek']],
    ['lantern-ferry', 'guard', ['oss']],
    ['reed-chapel', 'elf', ['ivet']],
    ['mirecross', 'villain', ['sella']],
    ['saltmarket', 'guard', ['orsa']],
    ['tide-observatory', 'guard', ['hana']],
    ['wreckers-rest', 'elf', ['dren']],
  ] as const)('%s shows its residents cooked', async (location, faction, npcs) => {
    const models = await library();
    const resources = new ViewResources(undefined, 1, models);
    const scene = new THREE.Scene();
    const residents = new WorldResidents(resources, scene);
    try {
      const game = createCampaign({ seed: `resident-${location}`, faction, runId: `resident-${location}` });
      new CampaignDriver(game).toNode(location);
      const snapshot = structuredClone(game.snapshot());
      for (const npc of npcs) expect(snapshot.narrative!.npcs.some(person => person.id === npc), npc).toBe(true);
      residents.update(snapshot, new THREE.PerspectiveCamera(), false, 1 / 60);
      for (const npc of npcs) expect(residents.model(npc), npc).toBeDefined();
    } finally {
      residents.dispose();
      resources.dispose();
      models.dispose();
    }
  }, 60_000);

  test('a resident faces the hero within 8 m, keeps its heading beyond, and talks only in its own conversation', async () => {
    const models = await library();
    const resources = new ViewResources(undefined, 1, models);
    const scene = new THREE.Scene();
    const residents = new WorldResidents(resources, scene);
    const camera = new THREE.PerspectiveCamera();
    try {
      const snapshot = snapshotOf('elf');
      const toman = snapshot.narrative!.npcs.find(npc => npc.id === 'toman')!;
      standBefore(snapshot, 'toman', 5);
      residents.update(snapshot, camera, false, 1 / 60);
      const root = scene.getObjectByName('resident:toman')!;
      expect(root.rotation.y).toBeCloseTo(0, 6);
      standBefore(snapshot, 'toman', 9);
      residents.update(snapshot, camera, false, 1 / 60);
      expect(root.rotation.y).toBeCloseTo(toman.heading, 6);
      standBefore(snapshot, 'toman', 4);
      const model = residents.model('toman')!;
      const lida = residents.model('lida')!;
      expect(model.activeClip).toBe('Idle');
      // Conversations pause the simulation; render time alone drives the gestures.
      snapshot.narrative!.dialogue = { npcId: 'toman' } as unknown as NonNullable<GameSnapshot['narrative']>['dialogue'];
      const elapsed = snapshot.elapsed;
      const before = boneState(model.root);
      for (let frame = 0; frame < 30; frame++) residents.update(snapshot, camera, false, 1 / 60);
      expect(snapshot.elapsed).toBe(elapsed);
      expect(model.activeClip).toBe('Talk');
      expect(lida.activeClip).toBe('Idle');
      expect(boneState(model.root)).not.toEqual(before);
      snapshot.narrative!.dialogue = null;
      for (let frame = 0; frame < 30; frame++) residents.update(snapshot, camera, false, 1 / 60);
      expect(model.activeClip).toBe('Idle');
    } finally {
      residents.dispose();
      resources.dispose();
      models.dispose();
    }
  });

  test('reduced motion holds a still standing pose and skips conversation gestures', async () => {
    const models = await library();
    const resources = new ViewResources(undefined, 1, models);
    const scene = new THREE.Scene();
    const residents = new WorldResidents(resources, scene);
    const camera = new THREE.PerspectiveCamera();
    try {
      const snapshot = snapshotOf('elf');
      standBefore(snapshot, 'toman', 4);
      snapshot.narrative!.dialogue = { npcId: 'toman' } as unknown as NonNullable<GameSnapshot['narrative']>['dialogue'];
      residents.update(snapshot, camera, true, 1 / 60);
      const model = residents.model('toman')!;
      const still = boneState(model.root);
      for (let frame = 0; frame < 90; frame++) residents.update(snapshot, camera, true, 1 / 60);
      expect(model.activeClip).toBe('Idle');
      expect(boneState(model.root)).toEqual(still);
      residents.update(snapshot, camera, false, 1 / 60);
      for (let frame = 0; frame < 30; frame++) residents.update(snapshot, camera, false, 1 / 60);
      expect(model.activeClip).toBe('Talk');
    } finally {
      residents.dispose();
      resources.dispose();
      models.dispose();
    }
  });

  test('removing residents and disposing release their clones but keep the library materials', async () => {
    const models = await library();
    const resources = new ViewResources(undefined, 1, models);
    const scene = new THREE.Scene();
    const residents = new WorldResidents(resources, scene);
    const camera = new THREE.PerspectiveCamera();
    const snapshot = snapshotOf('elf');
    residents.update(snapshot, camera, false, 1 / 60);
    const body = residents.model('lida')!.skinned[0]!;
    const material = body.material as THREE.Material;
    const disposed = { material: 0 };
    material.addEventListener('dispose', () => { disposed.material++; });
    const skeleton = body.skeleton;
    let skeletonDisposed = 0;
    const original = skeleton.dispose.bind(skeleton);
    skeleton.dispose = () => { skeletonDisposed++; original(); };
    snapshot.narrative!.npcs = snapshot.narrative!.npcs.filter(npc => npc.id !== 'lida');
    residents.update(snapshot, camera, false, 1 / 60);
    expect(scene.getObjectByName('resident:lida')).toBeUndefined();
    expect(skeletonDisposed).toBe(1);
    residents.dispose();
    expect(scene.children).toHaveLength(0);
    resources.dispose();
    expect(disposed.material).toBe(0);
    models.dispose();
    expect(disposed.material).toBe(1);
  });

  test('a missing resident model fails the library instead of falling back to the procedural figure', async () => {
    const source: ModelSource = { load: id => id === 'char-resident-vesk' ? Promise.reject(new Error('404')) : nodeSource.load(id) };
    const models = new ModelLibrary(source, IDS);
    await expect(models.ready).rejects.toThrow(/char-resident-vesk/);
    const resources = new ViewResources(undefined, 1, models);
    const residents = new WorldResidents(resources, new THREE.Scene());
    expect(() => residents.update(snapshotOf('guard'), new THREE.PerspectiveCamera(), false, 1 / 60)).toThrow(/char-resident-vesk/);
    residents.dispose();
    resources.dispose();
    models.dispose();
  });
});
