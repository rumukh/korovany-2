import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { createCampaign, type FactionId, type GameSnapshot } from '../src/game';
import { Presentation } from '../src/view';
import type { WagonVisual } from '../src/view/actors';
import {
  DRAFT_OX, ModelLibrary, OX_CLIPS, OxInstance, WAGON_NODES, WAGONS, type DyeUniforms, type ModelId, type OxFrame, type WagonModelId,
} from '../src/view/models';
import { factionColors, palette } from '../src/view/palette';
import { ViewResources } from '../src/view/resources';
import { brokenVariants, verifyMotion, type MotionContract } from './character-motion';
import { imageBytes, imageSize, parseGlbWithoutTextures, readGlb } from './glb';

const glb = (id: ModelId) => new Uint8Array(readFileSync(new URL(`../public/models/${id}/${id}.glb`, import.meta.url)));
const nodeSource = { load: (id: ModelId) => parseGlbWithoutTextures(glb(id)) };
const WAGON_IDS = ['prop-wagon-convoy', 'prop-wagon-shipment'] as const satisfies readonly WagonModelId[];

/** The draft ox's presentation contract, checked on every 60 Hz frame of the shipped skin: each gait plants its hooves
 * at its authored ground speed, and its duty factor bounds each hoof's share of the cycle on the ground. */
export const OX_MOTION: MotionContract = {
  fps: 60, feet: ['hoof_f_l', 'hoof_f_r', 'hoof_h_l', 'hoof_h_r'], bodyRadius: 1.8, itemRadius: 0.01, minY: -0.03, maxY: 2.1,
  contactHeight: 0.025, plantedHeight: 0.012, maxSlideSpeed: 0.3, maxMeanSlideSpeed: 0.1, minSwingLift: 0.05, loopTolerance: 0.003,
  maxEdgeRatio: 8, minEdgeRatio: 0.02, strainQuantile: 0.995, maxQuantileStretch: 2.0, minQuantileCompression: 0.5, rigidTolerance: 0.01,
  maxWeightError: 0.002,
  clips: {
    Idle: { minSeconds: 4, maxSeconds: 6, loop: true, minMotion: 0.004, planted: true },
    Walk: { minSeconds: 0.7, maxSeconds: 1.6, loop: true, minMotion: 0.1, velocity: [0, DRAFT_OX.gaits.Walk], contact: [0.55, 0.8] },
    Trot: { minSeconds: 0.4, maxSeconds: 0.9, loop: true, minMotion: 0.1, velocity: [0, DRAFT_OX.gaits.Trot], contact: [0.3, 0.55] },
    Canter: { minSeconds: 0.35, maxSeconds: 0.8, loop: true, minMotion: 0.1, velocity: [0, DRAFT_OX.gaits.Canter], contact: [0.2, 0.45] },
    Hit: { minSeconds: 0.3, maxSeconds: 0.5, loop: false, minMotion: 0.01, planted: true },
  },
};

function triangles(document: ReturnType<typeof readGlb>, name: string): number {
  const { json: gltf } = document;
  const node = gltf.nodes!.find(candidate => candidate.name === name && candidate.mesh !== undefined);
  if (!node) throw new Error(`no mesh node ${name}`);
  return gltf.meshes![node.mesh!]!.primitives.reduce((sum, primitive) => sum + gltf.accessors![primitive.indices!]!.count / 3, 0);
}

function worldVertices(root: THREE.Object3D, name: string): THREE.Vector3[] {
  const mesh = root.getObjectByName(name) as THREE.Mesh;
  root.updateMatrixWorld(true);
  const position = mesh.geometry.getAttribute('position');
  return Array.from({ length: position.count }, (_, index) => new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld));
}

describe('cooked wagons, draft ox and cargo', () => {
  test.each(WAGON_IDS)('%s: a static body, one spun node per axle and a harness that meets the ox, within budget', async id => {
    const bytes = glb(id);
    expect(bytes.byteLength).toBeLessThanOrEqual(3_000_000);
    const document = readGlb(bytes);
    const { json: gltf } = document;
    expect(gltf.skins ?? []).toHaveLength(0);
    expect(gltf.animations ?? []).toHaveLength(0);
    // Static vertex data is quantized with one uniform scale per mesh held in its node (quantize_static_glb.py), then
    // meshopt-compressed without lossy filters; three.js needs only the meshopt decoder.
    expect(gltf.extensionsRequired ?? []).toEqual(['EXT_meshopt_compression', 'EXT_texture_webp', 'KHR_mesh_quantization']);
    const meshNodes = gltf.nodes!.filter(node => node.mesh !== undefined).map(node => node.name).sort();
    expect(meshNodes).toEqual([WAGON_NODES.body, WAGON_NODES.harness, ...WAGON_NODES.wheels].sort());
    expect(triangles(document, WAGON_NODES.body)).toBeLessThanOrEqual(15_000);
    // Two Blender-authored wheels (at most 1,000 triangles each) and the axle tree per node.
    for (const wheels of WAGON_NODES.wheels) expect(triangles(document, wheels)).toBeLessThanOrEqual(2_200);
    expect(triangles(document, WAGON_NODES.harness)).toBeLessThanOrEqual(3_000);
    const images = gltf.images!.map((image, index) => ({ name: image.name, ...imageSize(imageBytes(document, index)) }));
    expect(images.every(image => image.format === 'webp')).toBe(true);
    for (const name of ['body-base', 'body-normal', 'body-orm']) expect(images.find(image => image.name === name)?.width).toBeGreaterThanOrEqual(512);
    // Only the pennant is dye-masked: the parts' base alpha is the mask.
    expect(images.find(image => image.name === 'parts-base')?.alpha).toBe(true);
    const { scene } = await parseGlbWithoutTextures(bytes);
    scene.updateMatrixWorld(true);
    for (const name of [WAGON_NODES.body, ...WAGON_NODES.wheels, WAGON_NODES.harness]) {
      const mesh = scene.getObjectByName(name) as THREE.Mesh;
      expect(mesh.geometry.getAttribute('normal'), name).toBeDefined();
      expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    }
    const wheels = WAGON_NODES.wheels.map(name => scene.getObjectByName(name) as THREE.Mesh);
    expect(wheels[0]!.material).toBe(wheels[1]!.material);
    expect((scene.getObjectByName(WAGON_NODES.harness) as THREE.Mesh).material).toBe(wheels[0]!.material);
    for (const wheel of wheels) {
      // A wheel node sits on its axle, its height is the rolling radius, and its rim touches the ground.
      expect(wheel.position.x).toBeCloseTo(0, 5);
      expect(wheel.position.y).toBeGreaterThan(0.35);
      expect(wheel.position.y).toBeLessThan(0.7);
      const lowest = Math.min(...worldVertices(scene, wheel.name).map(vertex => vertex.y));
      expect(lowest, wheel.name).toBeGreaterThan(-0.01);
      expect(lowest, wheel.name).toBeLessThan(0.01);
    }
    const body = new THREE.Box3().setFromObject(scene.getObjectByName(WAGON_NODES.body)!);
    expect(body.min.y).toBeGreaterThan(-0.02);
    expect(body.max.y).toBeLessThan(2.8);
    expect(body.max.x - body.min.x).toBeLessThan(2.2);
    // The wagon keeps the procedural wagon's place around the 1.5 m collider; the ox walks ahead of it.
    expect(Math.max(-body.min.z, body.max.z)).toBeLessThan(1.8);
    const ox = scene.getObjectByName(WAGON_NODES.ox)!;
    expect(ox.position.z).toBeGreaterThan(2.4);
    expect(ox.position.z).toBeLessThan(3.6);
    expect(Boolean(scene.getObjectByName(WAGON_NODES.cargo))).toBe(WAGONS[id].cargo);
    // The shaft tips reach the ox's hame hooks at rest.
    const animal = await parseGlbWithoutTextures(glb(DRAFT_OX.id));
    animal.scene.position.copy(ox.position);
    animal.scene.updateMatrixWorld(true);
    const harness = worldVertices(scene, WAGON_NODES.harness);
    for (const hook of DRAFT_OX.hooks) {
      const at = new THREE.Vector3().setFromMatrixPosition(animal.scene.getObjectByName(hook)!.matrixWorld);
      const nearest = Math.min(...harness.map(vertex => vertex.distanceTo(at)));
      expect(nearest, hook).toBeLessThan(0.06);
    }
  });

  test('char-draft-ox: one skinned body within budget, hame hooks, WebP maps and the gait clips', async () => {
    const bytes = glb(DRAFT_OX.id);
    expect(bytes.byteLength).toBeLessThanOrEqual(2_500_000);
    const document = readGlb(bytes);
    const { json: gltf } = document;
    expect(gltf.skins).toHaveLength(1);
    const joints = gltf.skins![0]!.joints.map(index => gltf.nodes![index]!.name);
    expect(joints.length).toBeLessThanOrEqual(40);
    for (const name of ['root', 'pelvis', 'chest', 'head', 'hoof_f_l', 'hoof_f_r', 'hoof_h_l', 'hoof_h_r', ...DRAFT_OX.hooks]) expect(joints).toContain(name);
    expect(gltf.animations!.map(animation => animation.name).sort()).toEqual([...OX_CLIPS].sort());
    expect(gltf.nodes!.filter(node => node.mesh !== undefined)).toHaveLength(1);
    expect(triangles(document, 'body')).toBeLessThanOrEqual(10_000);
    const images = gltf.images!.map((image, index) => ({ name: image.name, ...imageSize(imageBytes(document, index)) }));
    expect(images.every(image => image.format === 'webp')).toBe(true);
    for (const name of ['body-base', 'body-normal', 'body-orm']) expect(images.find(image => image.name === name)?.width).toBeGreaterThanOrEqual(512);
    const { scene } = await parseGlbWithoutTextures(bytes);
    const bounds = new THREE.Box3().setFromObject(scene);
    expect(bounds.min.y).toBeCloseTo(0, 2);
    expect(bounds.max.y).toBeGreaterThan(1.4);
    expect(bounds.max.y).toBeLessThan(2.0);
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(2.2);
    expect(bounds.max.z - bounds.min.z).toBeLessThan(3.2);
  });

  test('prop-cargo-load: one static mesh within budget that fits the convoy\'s open bed', async () => {
    const bytes = glb('prop-cargo-load');
    expect(bytes.byteLength).toBeLessThanOrEqual(1_500_000);
    const document = readGlb(bytes);
    const nodes = document.json.nodes!.filter(node => node.mesh !== undefined);
    expect(nodes).toHaveLength(1);
    expect(triangles(document, nodes[0]!.name!)).toBeLessThanOrEqual(4_000);
    const { scene } = await parseGlbWithoutTextures(bytes);
    const bounds = new THREE.Box3().setFromObject(scene);
    expect(bounds.min.y).toBeCloseTo(0, 2);
    expect(bounds.max.x - bounds.min.x).toBeLessThan(1.4);
    expect(bounds.max.z - bounds.min.z).toBeLessThan(1.3);
    expect(bounds.max.y).toBeLessThan(0.9);
  });
});

describe('draft ox motion on every frame', () => {
  test('passes deformation, hoof contact, loop, clearance, strain and root-motion checks at every authored speed', async () => {
    const { scene, animations } = await parseGlbWithoutTextures(glb(DRAFT_OX.id));
    const report = verifyMotion(scene, animations, OX_MOTION);
    expect(report.failures).toEqual([]);
    expect(report.maxInfluences).toBeLessThanOrEqual(4);
    for (const sole of report.soles) expect(sole).toBeGreaterThan(6);
  }, 120_000);

  const expected: Record<string, [RegExp, string]> = {
    static: [/barely deforms/, 'Idle'], rootMotion: [/moves its root joint/, 'Trot'], sliding: [/slides hoof/, 'Trot'],
    openLoop: [/does not close its loop/, 'Idle'], stretched: [/stretches an edge/, 'Hit'], unnormalizedWeights: [/not normalized/, 'Idle'],
  };
  test.each(Object.keys(expected))('rejects a deliberately broken %s copy', async name => {
    const { scene, animations } = await parseGlbWithoutTextures(glb(DRAFT_OX.id));
    const variant = brokenVariants(animations, 'root', 'cannon_f_l', 'Trot', 'Hit')[name]!;
    if (variant.mutateWeights) {
      scene.traverse(object => {
        if (!(object instanceof THREE.SkinnedMesh)) return;
        const weights = object.geometry.getAttribute('skinWeight');
        for (let index = 0; index < weights.array.length; index++) (weights.array as Float32Array)[index]! *= 0.7;
      });
    }
    const [pattern, clip] = expected[name]!;
    const report = verifyMotion(scene, variant.clips, { ...OX_MOTION, clips: { [clip]: OX_MOTION.clips[clip]! } });
    expect(report.failures.some(failure => pattern.test(failure)), report.failures.join('\n')).toBe(true);
  }, 60_000);
});

type Visuals = { convoy: WagonVisual; actorVisuals: Map<string, { root: THREE.Group; wagon?: WagonVisual }> };

function dyeOf(object: THREE.Object3D | undefined): string {
  if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) throw new Error('Expected a cooked part');
  expect(object.material.customProgramCacheKey()).toBe('korovany-dye-v1');
  return `#${(object.material.userData.dye as DyeUniforms).dyeColor.value.getHexString()}`;
}

/** Advances the snapshot by whole ticks, moving the convoy at `speed` along its heading. */
function drive(presentation: Presentation, snapshot: GameSnapshot, speed: number, ticks: number, camera: THREE.Camera, reducedMotion = false): number {
  let travelled = 0;
  for (let tick = 0; tick < ticks; tick++) {
    snapshot.tick += 1;
    snapshot.elapsed = snapshot.tick / 60;
    snapshot.convoy.x += Math.sin(snapshot.convoy.heading) * speed / 60;
    snapshot.convoy.z += Math.cos(snapshot.convoy.heading) * speed / 60;
    travelled += speed / 60;
    presentation.update(snapshot, 1 / 60, camera, reducedMotion);
  }
  return travelled;
}

describe('wagon presentation without a DOM', () => {
  test.each<FactionId>(['elf', 'guard', 'villain'])(
    '%s run: the convoy and the Crown shipment are cooked wagons with the draft ox on existing programs', async faction => {
      const library = new ModelLibrary(nodeSource);
      await library.ready;
      const snapshot = createCampaign({ seed: 'wagon-presentation', faction }).snapshot();
      snapshot.narrative = undefined;
      const presentation = new Presentation(snapshot.world, new ViewResources(undefined, 1, library));
      const disposed = vi.fn();
      try {
        presentation.update(snapshot, 1 / 60, new THREE.PerspectiveCamera(), false);
        const visuals = presentation as unknown as Visuals;
        const convoy = visuals.convoy;
        expect(convoy.root.getObjectByName('wagon-cart')).toBeUndefined();
        expect(convoy.root.getObjectByName(WAGON_NODES.body)).toBeInstanceOf(THREE.Mesh);
        expect(convoy.root.getObjectByName('prop-cargo-load')).toBeDefined();
        // The convoy flies its faction's colour; the shipment's pennant shows its allegiance, as the procedural flag did.
        expect(dyeOf(convoy.root.getObjectByName(WAGON_NODES.harness))).toBe(factionColors[faction]);
        const shipment = visuals.actorVisuals.get('enemy-caravan')!;
        expect(dyeOf(shipment.root.getObjectByName(WAGON_NODES.harness))).toBe(faction === 'guard' ? palette.teal : palette.stone);
        // Both wagons use the library's materials: the plain prop body, the dyed parts and the ox on the troops' skinned program.
        const body = convoy.root.getObjectByName(WAGON_NODES.body) as THREE.Mesh;
        expect(body.material).toBe((library.require('prop-wagon-convoy').scene.getObjectByName(WAGON_NODES.body) as THREE.Mesh).material);
        const ox = convoy.animal!;
        expect(ox.skinned[0]!.customDepthMaterial).toBe(library.depthMaterial());
        expect((ox.skinned[0]!.material as THREE.MeshStandardMaterial).customProgramCacheKey()).toBe('korovany-dye-v1');
        expect(ox.skinned[0]!.material).toBe(shipment.wagon!.animal!.skinned[0]!.material);
        for (const visual of [convoy, shipment.wagon!]) {
          const release = visual.animal!.skinned[0]!.skeleton.dispose.bind(visual.animal!.skinned[0]!.skeleton);
          visual.animal!.skinned[0]!.skeleton.dispose = () => { disposed(); release(); };
        }
      } finally {
        presentation.dispose();
      }
      expect(disposed).toHaveBeenCalledTimes(2);
      library.dispose();
    }, 60_000);

  test('wheels roll by distance over their radius, the ox gait follows speed, and lean and cargo follow the convoy', async () => {
    const library = new ModelLibrary(nodeSource);
    await library.ready;
    const snapshot = createCampaign({ seed: 'wagon-presentation', faction: 'guard' }).snapshot();
    snapshot.narrative = undefined;
    const presentation = new Presentation(snapshot.world, new ViewResources(undefined, 1, library));
    const camera = new THREE.PerspectiveCamera();
    try {
      presentation.update(snapshot, 1 / 60, camera, false);
      const convoy = (presentation as unknown as Visuals).convoy;
      const front = convoy.root.getObjectByName(WAGON_NODES.wheels[0])!;
      const rear = convoy.root.getObjectByName(WAGON_NODES.wheels[1])!;
      expect(convoy.animal!.activeClip).toBe('Idle');
      const travelled = drive(presentation, snapshot, snapshot.convoy.speed, 40, camera);
      expect(convoy.animal!.activeClip).toBe('Canter');
      expect(front.rotation.x).toBeCloseTo(travelled / front.position.y, 3);
      expect(rear.rotation.x).toBeCloseTo(travelled / rear.position.y, 3);
      expect(Math.abs(front.rotation.x - rear.rotation.x)).toBeGreaterThan(0.1);
      const harness = convoy.root.getObjectByName(WAGON_NODES.harness)!;
      const pitches = new Set<number>();
      for (let tick = 0; tick < 30; tick++) {
        drive(presentation, snapshot, snapshot.convoy.speed, 1, camera);
        pitches.add(Math.round(harness.rotation.x * 1e4));
      }
      // The harness follows the cantering ox's hame hooks.
      expect(pitches.size).toBeGreaterThan(3);
      drive(presentation, snapshot, 4, 40, camera);
      expect(convoy.animal!.activeClip).toBe('Trot');
      drive(presentation, snapshot, 1.15, 40, camera);
      expect(convoy.animal!.activeClip).toBe('Walk');
      drive(presentation, snapshot, 0, 40, camera);
      expect(convoy.animal!.activeClip).toBe('Idle');
      // Disabled: the body and wheels lean while the ox stays upright; no cargo, no crates.
      snapshot.convoy.disabled = true;
      snapshot.convoy.hp = 0;
      snapshot.convoy.cargo = 0;
      drive(presentation, snapshot, 0, 2, camera, true);
      expect(convoy.root.getObjectByName('wagon-lean')!.rotation.z).toBeCloseTo(0.085, 5);
      expect(convoy.animal!.root.getWorldDirection(new THREE.Vector3()).y).toBeCloseTo(0, 5);
      expect(convoy.root.getObjectByName('prop-cargo-load')!.visible).toBe(false);
      expect(convoy.root.getObjectByName('health-bar')!.visible).toBe(true);
      // A teleport (fast travel) is not driving: no wheel spin, no gait.
      const spun = front.rotation.x;
      snapshot.convoy.disabled = false;
      snapshot.convoy.hp = snapshot.convoy.maxHp;
      snapshot.tick += 1;
      snapshot.convoy.x += 80;
      presentation.update(snapshot, 1 / 60, camera, false);
      expect(front.rotation.x).toBe(spun);
      expect(convoy.animal!.activeClip).toBe('Idle');
    } finally {
      presentation.dispose();
      library.dispose();
    }
  }, 60_000);

  test('the shipment trots at its road speed, leans when disabled, and a takeover rebuilds it with a friendly pennant', async () => {
    const library = new ModelLibrary(nodeSource);
    await library.ready;
    const snapshot = createCampaign({ seed: 'wagon-presentation', faction: 'villain' }).snapshot();
    snapshot.narrative = undefined;
    const presentation = new Presentation(snapshot.world, new ViewResources(undefined, 1, library));
    const camera = new THREE.PerspectiveCamera();
    try {
      presentation.update(snapshot, 1 / 60, camera, false);
      const visuals = (presentation as unknown as Visuals).actorVisuals;
      const wagon = snapshot.actors.find(actor => actor.id === 'enemy-caravan')!;
      const neutral = visuals.get(wagon.id)!;
      expect(dyeOf(neutral.root.getObjectByName(WAGON_NODES.harness))).toBe(palette.stone);
      wagon.allegiance = 'friendly';
      presentation.update(snapshot, 1 / 60, camera, false);
      const friendly = visuals.get(wagon.id)!;
      expect(friendly).not.toBe(neutral);
      expect(neutral.root.parent).toBeNull();
      expect(dyeOf(friendly.root.getObjectByName(WAGON_NODES.harness))).toBe(palette.teal);
      for (let tick = 0; tick < 40; tick++) {
        snapshot.tick += 1;
        wagon.z += 4 / 60;
        presentation.update(snapshot, 1 / 60, camera, false);
      }
      expect(friendly.wagon!.animal!.activeClip).toBe('Trot');
      wagon.hp = 0;
      for (let tick = 0; tick < 20; tick++) {
        snapshot.tick += 1;
        presentation.update(snapshot, 1 / 60, camera, false);
      }
      expect(friendly.root.visible).toBe(true);
      expect(friendly.root.getObjectByName('wagon-lean')!.rotation.z).toBeCloseTo(0.085, 1);
      expect(friendly.wagon!.animal!.activeClip).toBe('Idle');
    } finally {
      presentation.dispose();
      library.dispose();
    }
  }, 60_000);

  test('reduced motion holds a still ox at rest and skips its flinch, yet keeps planted gaits', async () => {
    const library = new ModelLibrary(nodeSource, [DRAFT_OX.id]);
    await library.ready;
    const material = new THREE.MeshStandardMaterial();
    const pose = (ox: OxInstance) => ox.skinned[0]!.skeleton.bones.flatMap(bone => [...bone.quaternion.toArray(), ...bone.position.toArray()]);
    const frame = (extra: Partial<OxFrame> = {}): OxFrame => ({ speed: 0, hit: false, reducedMotion: true, ...extra });
    const still = new OxInstance(library.require(DRAFT_OX.id), { body: material, depth: material });
    const lively = new OxInstance(library.require(DRAFT_OX.id), { body: material, depth: material });
    try {
      still.update(frame(), 1 / 60);
      const start = pose(still);
      for (let tick = 0; tick < 60; tick++) still.update(frame({ hit: tick === 10 }), 1 / 60);
      expect(pose(still)).toEqual(start);
      for (let tick = 0; tick < 30; tick++) still.update(frame({ speed: DRAFT_OX.gaits.Trot }), 1 / 60);
      expect(still.activeClip).toBe('Trot');
      expect(pose(still)).not.toEqual(start);
      lively.update(frame({ reducedMotion: false }), 1 / 60);
      const breathing = pose(lively);
      for (let tick = 0; tick < 60; tick++) lively.update(frame({ reducedMotion: false }), 1 / 60);
      expect(pose(lively)).not.toEqual(breathing);
    } finally {
      still.dispose();
      lively.dispose();
      library.dispose();
    }
  });

  test.each<ModelId>(['prop-wagon-convoy', 'char-draft-ox', 'prop-cargo-load'])(
    'a missing %s fails the library instead of falling back to the procedural wagon', async missing => {
      const library = new ModelLibrary({
        load: async (id: ModelId) => {
          if (id === missing) throw new Error('404 Not Found');
          return parseGlbWithoutTextures(glb(id));
        },
      });
      await expect(library.ready).rejects.toThrow('Could not load 3D model');
      expect(library.status.error).toContain(`models/${missing}/${missing}.glb`);
      const snapshot = createCampaign({ seed: 'wagon-presentation', faction: 'elf' }).snapshot();
      let presentation: Presentation | undefined;
      try {
        expect(() => {
          presentation = new Presentation(snapshot.world, new ViewResources(undefined, 1, library));
          presentation.update(snapshot, 1 / 60, new THREE.PerspectiveCamera(), false);
        }).toThrow('Could not load 3D model');
        expect(presentation?.scene.getObjectByName('wagon-cart')).toBeUndefined();
      } finally {
        presentation?.dispose();
        library.dispose();
      }
    });
});
