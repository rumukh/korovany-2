import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { createCampaign, FACTIONS, type FactionId, type GameInput, type GameSnapshot } from '../src/game';
import { Presentation } from '../src/view';
import { HERO_CLIPS, HEROES, HeroInstance, ModelLibrary, SPRINT_FACTOR, type HeroFrame, type ModelId } from '../src/view/models';
import { ViewResources } from '../src/view/resources';
import { brokenVariants, verifyMotion, type MotionContract } from './character-motion';
import { imageBytes, imageSize, parseGlbWithoutTextures, readGlb } from './glb';
import { yieldRunner } from './faction-driver';

// GLB parsing and per-frame verification settle on microtasks only; yield a macrotask between tests so the worker
// reads vitest's RPC replies (a file that never yields trips the 60 s onTaskUpdate timeout).
afterEach(yieldRunner);

const FACTION_IDS: readonly FactionId[] = ['elf', 'guard', 'villain'];
const glb = (id: ModelId) => new Uint8Array(readFileSync(new URL(`../public/models/${id}/${id}.glb`, import.meta.url)));
const nodeSource = { load: (id: ModelId) => parseGlbWithoutTextures(glb(id)) };

/** Presentation contract of a faction's hero, checked on every 60 Hz frame of the shipped skin. */
export function heroMotion(faction: FactionId): MotionContract {
  const { speed, attackCooldown } = FACTIONS[faction];
  const run = (velocity: readonly [number, number]) =>
    ({ minSeconds: 0.5, maxSeconds: 0.8, loop: true, minMotion: 0.25, velocity, contact: [0.14, 0.5] as const });
  // Each swing ends before the weapon's cooldown can start the next one.
  const swing = { minSeconds: 0.3, maxSeconds: attackCooldown + 1e-3, loop: false, minMotion: 0.15, planted: true };
  return {
    fps: 60,
    feet: ['foot_l', 'foot_r'],
    bodyRadius: 1.05,
    itemRadius: 3.1,
    minY: -0.03,
    maxY: HEROES[faction].height + 0.9,
    contactHeight: 0.025,
    plantedHeight: 0.012,
    maxSlideSpeed: 0.3,
    maxMeanSlideSpeed: 0.1,
    minSwingLift: 0.08,
    loopTolerance: 0.003,
    maxEdgeRatio: 8,
    minEdgeRatio: 0.02,
    strainQuantile: 0.995,
    maxQuantileStretch: 2.0,
    minQuantileCompression: 0.5,
    rigidTolerance: 0.01,
    maxWeightError: 0.002,
    clips: {
      Idle: { minSeconds: 2, maxSeconds: 3.5, loop: true, minMotion: 0.004, planted: true },
      AtEase: { minSeconds: 2.5, maxSeconds: 4, loop: true, minMotion: 0.004, planted: true },
      // Fast runs have long flight phases, so each foot is planted for 14-50% of a stride.
      Run: run([0, speed]),
      RunBack: run([0, -speed]),
      RunLeft: run([speed, 0]),
      RunRight: run([-speed, 0]),
      Sprint: { minSeconds: 0.45, maxSeconds: 0.7, loop: true, minMotion: 0.3, velocity: [0, speed * SPRINT_FACTOR], contact: [0.1, 0.45] },
      // The 0.3 s, 18 m/s dash is a tuck and landing, not a planted gait.
      Dodge: { minSeconds: 0.4, maxSeconds: 0.6, loop: false, minMotion: 0.2 },
      Attack: swing,
      AttackB: swing,
      Ability: { minSeconds: 0.5, maxSeconds: 1.0, loop: false, minMotion: 0.2, planted: true },
      Interact: { minSeconds: 1.5, maxSeconds: 2.5, loop: true, minMotion: 0.004, planted: true },
      Hit: { minSeconds: 0.25, maxSeconds: 0.45, loop: false, minMotion: 0.02, planted: true },
      Death: { minSeconds: 0.8, maxSeconds: 1.4, loop: false, minMotion: 0.6, ground: false, maxQuantileStretch: 2.8,
        minQuantileCompression: 0.4, holdsFinalPose: true },
    },
  };
}

describe('cooked hero models', () => {
  test.each(FACTION_IDS)('%s hero: one skinned body within budget, hero joints, WebP maps and the hero clip contract', async faction => {
    const hero = HEROES[faction];
    expect(hero.runSpeed, 'Run clips are authored at the faction speed').toBe(FACTIONS[faction].speed);
    const bytes = glb(hero.id);
    expect(bytes.byteLength).toBeLessThanOrEqual(3_000_000);
    const document = readGlb(bytes);
    const { json: gltf } = document;
    expect(gltf.skins).toHaveLength(1);
    expect(gltf.cameras ?? []).toHaveLength(0);
    // Vertex data and rotation keys are quantized (KHR_mesh_quantization; three.js needs no decoder), except the mountain
    // sovereign's: its float skin already sits at the 2.0x strain limit, and rounded weights pushed two clips over it.
    // Geometry and animation data are then meshopt-compressed without lossy filters (see models.test.ts).
    expect(gltf.extensionsRequired ?? []).toEqual(faction === 'villain' ? ['EXT_meshopt_compression', 'EXT_texture_webp']
      : ['EXT_meshopt_compression', 'EXT_texture_webp', 'KHR_mesh_quantization']);
    const joints = gltf.skins![0]!.joints.map(index => gltf.nodes![index]!.name);
    expect(joints.length).toBeLessThanOrEqual(40);
    for (const name of ['root', 'pelvis', 'spine', 'chest', 'head', 'hand_l', 'hand_r', 'foot_l', 'foot_r']) expect(joints).toContain(name);
    expect(gltf.animations!.map(animation => animation.name).sort()).toEqual([...HERO_CLIPS].sort());
    expect(gltf.nodes!.filter(node => node.mesh !== undefined).map(node => node.name).sort()).toEqual(['body', ...hero.items].sort());
    // Hero budget: at most 16k triangles and three draws, items included.
    let triangles = 0, primitives = 0;
    for (const mesh of gltf.meshes!) {
      for (const primitive of mesh.primitives) {
        expect(primitive.attributes.NORMAL).toBeDefined();
        triangles += gltf.accessors![primitive.indices!]!.count / 3;
        primitives++;
      }
    }
    expect(triangles).toBeLessThanOrEqual(16_000);
    expect(primitives).toBeLessThanOrEqual(3);
    const images = gltf.images!.map((image, index) => ({ name: image.name, ...imageSize(imageBytes(document, index)) }));
    expect(images.every(image => image.format === 'webp')).toBe(true);
    for (const name of ['body-base', 'body-normal', 'body-orm']) expect(images.find(image => image.name === name)).toMatchObject({ width: 1024, height: 1024 });
    // The base-colour alpha is the dye mask read by the shared dyed program.
    expect(images.find(image => image.name === 'body-base')?.alpha).toBe(true);
    const { scene, animations } = await parseGlbWithoutTextures(bytes);
    const bounds = new THREE.Box3().setFromObject(scene);
    expect(bounds.min.y).toBeCloseTo(0, 2);
    expect(Math.abs(bounds.max.y - hero.height)).toBeLessThan(0.03);
    for (const clip of animations) {
      const rootTrack = clip.tracks.find(track => track.name === 'root.position');
      if (rootTrack) expect(new Set(rootTrack.values).size).toBeLessThanOrEqual(1);
    }
  });
});

describe('hero motion on every frame', () => {
  test.each(FACTION_IDS)('%s hero passes deformation, contact, loop, clearance, strain and root-motion checks', async faction => {
    const { scene, animations } = await parseGlbWithoutTextures(glb(HEROES[faction].id));
    const report = verifyMotion(scene, animations, heroMotion(faction));
    expect(report.failures).toEqual([]);
    expect(report.maxInfluences).toBeLessThanOrEqual(4);
    expect(report.soles[0]).toBeGreaterThan(10);
    expect(report.soles[1]).toBeGreaterThan(10);
  }, 60_000);

  const expected: Record<string, [RegExp, string]> = {
    static: [/barely deforms/, 'Idle'], rootMotion: [/moves its root joint/, 'Run'], sliding: [/slides foot/, 'Run'],
    openLoop: [/does not close its loop/, 'Idle'], stretched: [/stretches an edge/, 'Attack'], unnormalizedWeights: [/not normalized/, 'Idle'],
  };
  test.each(FACTION_IDS.flatMap(faction => Object.keys(expected).map(name => [faction, name] as const)))(
    '%s hero rejects a deliberately broken %s copy', async (faction, name) => {
      const { scene, animations } = await parseGlbWithoutTextures(glb(HEROES[faction].id));
      const variant = brokenVariants(animations, 'root', 'forearm_r', 'Run', 'Attack')[name]!;
      if (variant.mutateWeights) {
        scene.traverse(object => {
          if (!(object instanceof THREE.SkinnedMesh)) return;
          const weights = object.geometry.getAttribute('skinWeight');
          for (let index = 0; index < weights.array.length; index++) (weights.array as Float32Array)[index]! *= 0.7;
        });
      }
      // Only the damaged clip is measured; every other clip is the verified original.
      const [pattern, clip] = expected[name]!;
      const contract = heroMotion(faction);
      const report = verifyMotion(scene, variant.clips, { ...contract, clips: { [clip]: contract.clips[clip]! } });
      expect(report.failures.some(failure => pattern.test(failure)), report.failures.join('\n')).toBe(true);
    }, 60_000);
});

type HeroView = { hero: { root: THREE.Group; character?: HeroInstance } };

describe('hero presentation without a DOM', () => {
  test.each(FACTION_IDS)('%s: the faction hero is the cooked model, dyed through the shared program and driven by real inputs', async faction => {
    const library = new ModelLibrary(nodeSource);
    await library.ready;
    const campaign = createCampaign({ seed: 'hero-presentation', faction });
    let snapshot = campaign.snapshot();
    const presentation = new Presentation(snapshot.world, new ViewResources(undefined, 1, library));
    const camera = new THREE.PerspectiveCamera();
    const disposed = vi.fn();
    try {
      presentation.update(snapshot, 1 / 60, camera, false);
      const root = presentation.scene.getObjectByName('hero')!;
      expect(root.getObjectByName(HEROES[faction].id)).toBeDefined();
      expect(root.getObjectByName('actor-body')).toBeUndefined();
      expect(root.getObjectByName('hero-ring')).toBeDefined();
      const skinned: THREE.SkinnedMesh[] = [];
      root.traverse(object => { if (object instanceof THREE.SkinnedMesh) skinned.push(object); });
      expect(skinned).toHaveLength(1);
      // The soldier's dyed program: a hero adds no shader variant.
      expect((skinned[0]!.material as THREE.MeshStandardMaterial).customProgramCacheKey()).toBe('korovany-dye-v1');
      expect(skinned[0]!.customDepthMaterial).toBe(library.depthMaterial());
      for (const item of HEROES[faction].items) {
        const mesh = root.getObjectByName(item);
        expect(mesh, item).toBeInstanceOf(THREE.Mesh);
        expect((mesh as THREE.Mesh).customDepthMaterial).toBe(library.depthMaterial());
      }
      const skeleton = skinned[0]!.skeleton;
      const release = skeleton.dispose.bind(skeleton);
      skeleton.dispose = () => { disposed(); release(); };

      const character = () => (presentation as unknown as HeroView).hero.character!;
      const tick = (input: GameInput, mutate?: (next: GameSnapshot) => void) => {
        campaign.step(input);
        snapshot = campaign.snapshot();
        mutate?.(snapshot);
        presentation.update(snapshot, 1 / 60, camera, false);
      };
      const repeat = (ticks: number, input: GameInput, mutate?: (next: GameSnapshot) => void) => {
        for (let index = 0; index < ticks; index++) tick(input, mutate);
      };
      const heading = snapshot.player.heading;
      const forward = { x: Math.sin(heading), z: Math.cos(heading) };
      // The hero's left (+x in its own frame) in world coordinates.
      const left = { x: Math.cos(heading), z: -Math.sin(heading) };
      const scale = (v: { x: number; z: number }, s: number) => ({ x: v.x * s, z: v.z * s });

      repeat(20, { move: forward });
      expect(character().activeClip).toBe('Run');
      expect(root.position.x).toBeCloseTo(snapshot.player.x, 5);
      expect(root.rotation.y).toBeCloseTo(snapshot.player.heading, 5);
      // Aiming ahead while moving sideways or backwards plays the directional runs.
      repeat(20, { move: left, aim: forward });
      expect(character().activeClip).toBe('RunLeft');
      repeat(20, { move: scale(left, -1), aim: forward });
      expect(character().activeClip).toBe('RunRight');
      repeat(20, { move: scale(forward, -1), aim: forward });
      expect(character().activeClip).toBe('RunBack');
      // A diagonal turns the body onto the travel direction of the nearest directional run.
      const diagonal = { x: (forward.x + left.x) / Math.SQRT2, z: (forward.z + left.z) / Math.SQRT2 };
      repeat(30, { move: diagonal, aim: forward });
      expect(['Run', 'RunLeft']).toContain(character().activeClip);
      expect(Math.abs(character().root.rotation.y)).toBeCloseTo(Math.PI / 4, 1);
      repeat(30, { move: forward, sprint: true });
      expect(character().activeClip).toBe('Sprint');
      expect(Math.abs(character().root.rotation.y)).toBeLessThan(0.01);
      repeat(20, {});
      expect(character().activeClip).toBe('Idle');

      // Attacks alternate two swings; the ability plays its own clip.
      tick({ attack: true });
      expect(character().overlay?.clip).toBe('Attack');
      repeat(Math.ceil(FACTIONS[faction].attackCooldown * 60) + 1, {});
      tick({ attack: true });
      expect(character().overlay?.clip).toBe('AttackB');
      repeat(Math.ceil(FACTIONS[faction].attackCooldown * 60) + 1, {});
      tick({ special: true });
      expect(character().overlay?.clip).toBe('Ability');
      // The longest ability (the villain's 0.9 s cleave) and its 0.15 s fade.
      repeat(75, {});
      expect(character().overlay).toBeUndefined();

      tick({ dodge: true, move: left });
      repeat(5, { move: left });
      expect(character().activeClip).toBe('Dodge');
      repeat(40, {});
      expect(character().activeClip).toBe('Idle');

      // A held interaction (rising capture, repair or rest progress) works; a story scene stands at ease.
      let progress = 0.1;
      repeat(20, {}, next => {
        progress += 1 / 300;
        next.interaction = { kind: 'repair', key: 'interaction.repair', targetId: 'convoy', progress, enabled: true };
      });
      expect(character().activeClip).toBe('Interact');
      repeat(20, {}, next => { next.narrative = { ...next.narrative!, dialogue: {} as never }; });
      expect(character().activeClip).toBe('AtEase');
      repeat(40, {}, next => { next.player.state = 'dead'; next.player.hp = 0; });
      expect(character().activeClip).toBe('Death');
    } finally {
      presentation.dispose();
    }
    expect(disposed).toHaveBeenCalledTimes(1);
    library.dispose();
  }, 60_000);

  test('a mirror rebuilt after defeat shows the corpse, not a standing hero', async () => {
    const library = new ModelLibrary(nodeSource);
    await library.ready;
    const snapshot = createCampaign({ seed: 'hero-presentation', faction: 'villain' }).snapshot();
    snapshot.player.state = 'dead';
    snapshot.player.hp = 0;
    const presentation = new Presentation(snapshot.world, new ViewResources(undefined, 1, library));
    try {
      presentation.update(snapshot, 1 / 60, new THREE.PerspectiveCamera(), false);
      expect((presentation as unknown as HeroView).hero.character!.activeClip).toBe('Death');
      expect((presentation as unknown as HeroView).hero.character!.baseWeight('Death')).toBe(1);
    } finally {
      presentation.dispose();
      library.dispose();
    }
  });

  test('reduced motion holds a still stance and skips hit reactions; normal motion breathes and flinches', async () => {
    const library = new ModelLibrary(nodeSource, ['char-hero-guard']);
    await library.ready;
    const model = library.require('char-hero-guard');
    const material = new THREE.MeshStandardMaterial();
    const materials = { body: material, items: material, depth: material };
    const pose = (character: HeroInstance) => character.skinned[0]!.skeleton.bones.flatMap(bone => bone.quaternion.toArray());
    const change = (a: number[], b: number[]) => Math.max(...a.map((value, index) => Math.abs(value - b[index]!)));
    const frame = (reducedMotion: boolean, hit = false): HeroFrame => ({
      velocity: { x: 0, z: 0 }, dodging: false, dead: false, attack: false, ability: false, hit, working: false, relaxed: false, reducedMotion,
    });
    const runSpeed = HEROES.guard.runSpeed;
    const still = new HeroInstance(model, runSpeed, materials);
    const calm = new HeroInstance(model, runSpeed, materials);
    const struck = new HeroInstance(model, runSpeed, materials);
    try {
      const all = (update: (character: HeroInstance, index: number) => void) => [still, calm, struck].forEach(update);
      all((character, index) => character.update(frame(index === 0), 1 / 60));
      const [stillStart, calmStart] = [pose(still), pose(calm)];
      for (let tick = 0; tick < 45; tick++) all((character, index) => character.update(frame(index === 0), 1 / 60));
      expect(pose(still)).toEqual(stillStart);
      expect(change(pose(calm), calmStart)).toBeGreaterThan(1e-4);
      const stillBefore = pose(still);
      still.update(frame(true, true), 1 / 60);
      calm.update(frame(false), 1 / 60);
      struck.update(frame(false, true), 1 / 60);
      for (let tick = 0; tick < 6; tick++) all((character, index) => character.update(frame(index === 0), 1 / 60));
      expect(pose(still)).toEqual(stillBefore);
      expect(change(pose(struck), pose(calm))).toBeGreaterThan(1e-3);
    } finally {
      for (const character of [still, calm, struck]) character.dispose();
      library.dispose();
    }
  });

  test('keeps planted feet fixed in the world at game speeds in every direction, including diagonals', async () => {
    const library = new ModelLibrary(nodeSource, ['char-hero-elf']);
    await library.ready;
    const model = library.require('char-hero-elf');
    const material = new THREE.MeshStandardMaterial();
    const speed = HEROES.elf.runSpeed;
    for (const degrees of [0, 30, 45, 90, 135, 180, 225, 300]) {
      const character = new HeroInstance(model, speed, { body: material, items: material, depth: material });
      const entity = new THREE.Group();
      entity.add(character.root);
      const body = character.skinned[0]!;
      body.skeleton.update();
      const position = body.geometry.getAttribute('position');
      const weights = body.geometry.getAttribute('skinWeight');
      const joints = body.geometry.getAttribute('skinIndex');
      const foot = body.skeleton.bones.findIndex(bone => bone.name === 'foot_l');
      const vertex = new THREE.Vector3();
      let floor = Infinity;
      for (let index = 0; index < position.count; index++) floor = Math.min(floor, vertex.fromBufferAttribute(position, index).y);
      const sole: number[] = [];
      for (let index = 0; index < position.count; index++) {
        if (vertex.fromBufferAttribute(position, index).y > floor + 0.025) continue;
        let weight = 0;
        for (let k = 0; k < 4; k++) if (joints.getComponent(index, k) === foot) weight += weights.getComponent(index, k);
        if (weight > 0.98) sole.push(index);
      }
      const angle = THREE.MathUtils.degToRad(degrees);
      const local = { x: Math.sin(angle) * speed, z: Math.cos(angle) * speed };
      const track: THREE.Vector3[] = [];
      for (let frame = 0; frame < 150; frame++) {
        entity.position.x += local.x / 60;
        entity.position.z += local.z / 60;
        character.update({ velocity: local, dodging: false, dead: false, attack: false, ability: false, hit: false, working: false,
          relaxed: false, reducedMotion: false }, 1 / 60);
        entity.updateMatrixWorld(true);
        body.skeleton.update();
        if (frame < 40) continue;
        const centre = new THREE.Vector3();
        let low = Infinity;
        for (const index of sole) {
          vertex.fromBufferAttribute(position, index);
          body.applyBoneTransform(index, vertex);
          vertex.applyMatrix4(body.matrixWorld);
          centre.add(vertex);
          low = Math.min(low, vertex.y);
        }
        track.push(centre.divideScalar(sole.length).setY(low));
      }
      const ground = Math.min(...track.map(point => point.y));
      let planted = 0, slide = 0;
      for (let index = 1; index < track.length; index++) {
        if (track[index - 1]!.y - ground > 0.012 || track[index]!.y - ground > 0.012) continue;
        planted++;
        slide = Math.max(slide, Math.hypot(track[index]!.x - track[index - 1]!.x, track[index]!.z - track[index - 1]!.z) * 60);
      }
      expect(planted, `${degrees} degrees`).toBeGreaterThan(5);
      expect(slide, `${degrees} degrees`).toBeLessThan(0.3);
      character.dispose();
    }
    library.dispose();
  }, 60_000);

  test('a missing hero model fails the library instead of falling back to the procedural hero', async () => {
    const library = new ModelLibrary({
      load: async (id: ModelId) => {
        if (id === 'char-hero-villain') throw new Error('404 Not Found');
        return parseGlbWithoutTextures(glb(id));
      },
    });
    await expect(library.ready).rejects.toThrow('Could not load 3D model');
    expect(library.status.error).toMatch(/models\/char-hero-villain\/char-hero-villain\.glb/);
    library.dispose();
  });
});
