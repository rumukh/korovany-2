import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { createCampaign, type FactionId, type GameSnapshot } from '../src/game';
import { Presentation } from '../src/view';
import { coatColor } from '../src/view/actors';
import { CHARACTER_CLIPS, CharacterInstance, LINE_SOLDIER, MODEL_IDS, ModelLibrary, TROOPS, troopModelFor, type CharacterFrame, type ModelId } from '../src/view/models';
import { palette } from '../src/view/palette';
import { locationStructure, regionThemes } from '../src/view/region-scenery';
import { ViewResources } from '../src/view/resources';
import { brokenVariants, verifyMotion, type MotionContract } from './character-motion';
import { imageBytes, imageSize, parseGlbWithoutTextures, readGlb } from './glb';

const shipped = new URL('../public/models/', import.meta.url);
const sources = new URL('../scripts/models/', import.meta.url);
const glb = (id: ModelId) => new Uint8Array(readFileSync(new URL(`${id}/${id}.glb`, shipped)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = <T>(url: URL): T => JSON.parse(readFileSync(url, 'utf8')) as T;
const nodeSource = { load: (id: ModelId) => parseGlbWithoutTextures(glb(id)) };

/** Presentation contract of the line soldier, checked on every 60 Hz frame of the shipped skin. */
export const SOLDIER_MOTION: MotionContract = {
  fps: 60,
  feet: ['foot_l', 'foot_r'],
  bodyRadius: 1.0,
  itemRadius: 3.1,
  minY: -0.03,
  maxY: 2.75,
  contactHeight: 0.025,
  plantedHeight: 0.012,
  maxSlideSpeed: 0.3,
  maxMeanSlideSpeed: 0.1,
  minSwingLift: 0.08,
  loopTolerance: 0.003,
  // Absolute per-edge caps catch torn or collapsed triangles; the 99.5th-percentile band bounds crease strain
  // from linear blend skinning (armpit, knee, tabard hem), measured on every frame of the shipped skin.
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
    Run: { minSeconds: 0.6, maxSeconds: 1.1, loop: true, minMotion: 0.25, speed: LINE_SOLDIER.runSpeed },
    Windup: { minSeconds: 0.45, maxSeconds: 0.55, loop: false, minMotion: 0.2, planted: true },
    Strike: { minSeconds: 0.1, maxSeconds: 0.15, loop: false, minMotion: 0.2, planted: true },
    Recovery: { minSeconds: 0.6, maxSeconds: 0.7, loop: false, minMotion: 0.2, planted: true },
    Hit: { minSeconds: 0.25, maxSeconds: 0.45, loop: false, minMotion: 0.02, planted: true },
    // The fall folds hips and knees for a few frames; the corpse it holds for up to 8 s meets the global band.
    Death: { minSeconds: 0.8, maxSeconds: 1.4, loop: false, minMotion: 0.6, ground: false, maxQuantileStretch: 2.8,
      minQuantileCompression: 0.4, holdsFinalPose: true },
  },
};

interface Provenance {
  id: string;
  output: { file: string; sha256: string; bytes: number };
  license: string;
  tools: { name: string }[];
  source: { concept: { sha256: string } };
  cook: {
    scripts: Record<string, string>;
    geometryCompression?: { extension: string; bytesAfter: number };
    baseEncoding?: {
      settings: { exact: boolean };
      images: { image: string; sha256: string; meanAbsRgbError: { dyed: number; undyed: number } }[];
    };
  };
}

interface Approval {
  asset: string;
  decisions: { gate: string; decision: string; sha256: string }[];
}

describe('cooked 3D models', () => {
  test.each(MODEL_IDS)('%s ships its exact recorded bytes, provenance, approvals and research-only terms', id => {
    const bytes = glb(id);
    const provenance = json<Provenance>(new URL(`${id}/provenance.json`, sources));
    expect(provenance.id).toBe(id);
    expect(provenance.output).toEqual({ file: `public/models/${id}/${id}.glb`, sha256: sha256(bytes), bytes: bytes.byteLength });
    expect(provenance.license).toMatch(/research and evaluation/i);
    expect(provenance.license).toMatch(/no commercial/i);
    expect(provenance.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['Qwen Image Edit Plus 2511', 'TRELLIS-image-large', 'Blender 5.2.2 LTS']));
    const approval = json<Approval>(new URL(`${id}/approval.json`, sources));
    expect(approval.asset).toBe(id);
    expect(approval.decisions.map(decision => decision.gate)).toEqual(['concept', 'unrigged-mesh', 'in-game']);
    expect(approval.decisions[0]!.sha256).toBe(provenance.source.concept.sha256);
    expect(approval.decisions.at(-1)!.sha256).toBe(sha256(bytes));
    const concept = readFileSync(new URL(`${id}/concept.png`, sources));
    expect(sha256(concept)).toBe(provenance.source.concept.sha256);
    const text = readFileSync(new URL(`${id}/provenance.json`, sources), 'utf8');
    expect(text).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|\/home\//);
    // The committed cooking scripts are the ones that produced these bytes (LF-normalized, as git stores them).
    for (const [name, digest] of Object.entries(provenance.cook.scripts)) {
      const script = readFileSync(new URL(`pipeline/${name}`, sources), 'utf8').replaceAll('\r\n', '\n');
      expect(createHash('sha256').update(script).digest('hex'), name).toBe(digest);
    }
  });

  test.each(MODEL_IDS)('%s: geometry, skin and animation data are losslessly meshopt-compressed and need the decoder', async id => {
    const bytes = glb(id);
    const { json: gltf } = readGlb(bytes);
    expect(gltf.extensionsRequired).toContain('EXT_meshopt_compression');
    // The GLB's binary chunk, and a fallback buffer with no data that only sizes the decoded views.
    expect(gltf.buffers).toEqual([{ byteLength: expect.any(Number) }, { byteLength: expect.any(Number), extensions: { EXT_meshopt_compression: { fallback: true } } }]);
    const images = new Set(gltf.images!.map(image => image.bufferView));
    for (const [index, view] of gltf.bufferViews!.entries()) {
      const meshopt = view.extensions?.['EXT_meshopt_compression'] as { buffer: number; mode: string; filter?: string } | undefined;
      if (images.has(index)) {
        expect(view.buffer, `image view ${index}`).toBe(0);
        expect(meshopt, `image view ${index}`).toBeUndefined();
        continue;
      }
      // No lossy filter (octahedral, quaternion, exponential): decoding returns the cooked vertices and triangles exactly,
      // in the order meshopt_glb.mjs gave them for locality.
      expect(view.buffer, `view ${index}`).toBe(1);
      expect(meshopt, `view ${index}`).toMatchObject({ buffer: 0, mode: expect.stringMatching(/^(ATTRIBUTES|TRIANGLES|INDICES)$/) });
      expect(meshopt!.filter ?? 'NONE', `view ${index}`).toBe('NONE');
    }
    const { cook } = json<Provenance>(new URL(`${id}/provenance.json`, sources));
    expect(cook.geometryCompression).toMatchObject({ extension: 'EXT_meshopt_compression', bytesAfter: bytes.byteLength });
    expect(Object.keys(cook.scripts)).toContain('meshopt_glb.mjs');
    // Without the decoder the loader refuses the file rather than reading the empty fallback buffer.
    await expect(parseGlbWithoutTextures(bytes, null)).rejects.toThrow(/setMeshoptDecoder/);
  });

  test.each(MODEL_IDS)('%s: every vertex normal and tangent is a finite unit vector', async id => {
    // three.js normalizes tangents in the vertex shader: a zero-length one (MikkTSpace on a degenerate UV fan) shades its
    // triangles NaN, and the high-quality bloom spreads that over a black block of the frame.
    const { scene } = await parseGlbWithoutTextures(glb(id));
    const vector = new THREE.Vector3();
    let checked = 0;
    scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const name of ['normal', 'tangent']) {
        const attribute = (object.geometry as THREE.BufferGeometry).getAttribute(name) as THREE.BufferAttribute | undefined;
        if (!attribute) continue;
        for (let index = 0; index < attribute.count; index++) {
          const length = vector.fromBufferAttribute(attribute, index).length();
          // 8-bit quantized directions decode within about 0.6% of unit length.
          if (!(Math.abs(length - 1) < 0.02)) expect.fail(`${object.name} ${name} ${index} has length ${length}`);
          if (name === 'tangent' && Math.abs(attribute.getW(index)) !== 1) expect.fail(`${object.name} tangent ${index} handedness`);
        }
        checked += attribute.count;
      }
    });
    expect(checked).toBeGreaterThan(0);
  });

  test('dye-masked base colour keeps its hidden colour: libwebp exact encoding, pinned to the shipped bytes', () => {
    // The base-colour alpha is the faction-dye mask, not coverage. libwebp's default lossy mode discards RGB under
    // alpha 0, which once flattened every undyed surface of the soldier; the cook records the round-trip error.
    const document = readGlb(glb('char-line-soldier'));
    const { baseEncoding } = json<Provenance>(new URL('char-line-soldier/provenance.json', sources)).cook;
    expect(baseEncoding?.settings.exact).toBe(true);
    const masked = document.json.images!.map((image, index) => ({ image, index })).filter(({ index }) => imageSize(imageBytes(document, index)).alpha);
    expect(masked.map(({ image }) => image.name).sort()).toEqual(['body-base', 'items-base']);
    for (const { image, index } of masked) {
      const record = baseEncoding!.images.find(entry => entry.image === image.name);
      expect(record, image.name).toBeDefined();
      expect(record!.sha256).toBe(sha256(imageBytes(document, index)));
      expect(record!.meanAbsRgbError.undyed).toBeLessThan(3);
      expect(record!.meanAbsRgbError.dyed).toBeLessThan(3);
    }
  });

  test('line soldier: one skinned body, bounded joints, real normals, WebP maps and the clip contract', async () => {
    const document = readGlb(glb('char-line-soldier'));
    const { json: gltf } = document;
    expect(gltf.skins).toHaveLength(1);
    expect(gltf.cameras ?? []).toHaveLength(0);
    // Vertex data and rotation keys are quantized (KHR_mesh_quantization; three.js needs no decoder), then
    // meshopt-compressed without lossy filters (EXT_meshopt_compression, decoded by three.js's bundled decoder).
    expect(gltf.extensionsRequired ?? []).toEqual(['EXT_meshopt_compression', 'EXT_texture_webp', 'KHR_mesh_quantization']);
    const joints = gltf.skins![0]!.joints.map(index => gltf.nodes![index]!.name);
    expect(joints.length).toBeLessThanOrEqual(40);
    for (const name of ['root', 'pelvis', 'head', 'hand_r', 'foot_l', 'foot_r', 'socket_hand_r', 'socket_forearm_l']) expect(joints).toContain(name);
    expect(gltf.animations!.map(animation => animation.name).sort()).toEqual([...CHARACTER_CLIPS].sort());
    let triangles = 0;
    for (const mesh of gltf.meshes!) {
      for (const primitive of mesh.primitives) {
        expect(primitive.attributes.NORMAL).toBeDefined();
        triangles += gltf.accessors![primitive.indices!]!.count / 3;
      }
    }
    expect(triangles).toBeLessThanOrEqual(14_000);
    const images = gltf.images!.map((image, index) => ({ name: image.name, ...imageSize(imageBytes(document, index)) }));
    expect(images.every(image => image.format === 'webp')).toBe(true);
    expect(images.find(image => image.name === 'body-base')).toMatchObject({ width: 512, height: 512, alpha: true });
    expect(images.find(image => image.name === 'items-base')).toMatchObject({ alpha: true });
    const { scene, animations } = await parseGlbWithoutTextures(glb('char-line-soldier'));
    const bounds = new THREE.Box3().setFromObject(scene);
    expect(bounds.min.y).toBeCloseTo(0, 2);
    expect(bounds.max.y).toBeGreaterThan(2.1);
    expect(bounds.max.y).toBeLessThan(2.45);
    for (const clip of animations) {
      const rootTrack = clip.tracks.find(track => track.name === 'root.position');
      if (rootTrack) expect(new Set(rootTrack.values).size).toBeLessThanOrEqual(1);
    }
  });

  test('Echo Well: one static mesh and material inside both authoritative well footprints', async () => {
    const document = readGlb(glb('prop-echo-well'));
    expect(document.json.skins ?? []).toHaveLength(0);
    expect(document.json.animations ?? []).toHaveLength(0);
    expect(document.json.meshes).toHaveLength(1);
    expect(document.json.meshes![0]!.primitives).toHaveLength(1);
    const primitive = document.json.meshes![0]!.primitives[0]!;
    expect(primitive.attributes.NORMAL).toBeDefined();
    expect(document.json.accessors![primitive.indices!]!.count / 3).toBeLessThanOrEqual(15_000);
    const library = new ModelLibrary(nodeSource, ['prop-echo-well']);
    await library.ready;
    const resources = new ViewResources(undefined, 1, library);
    const point = new THREE.Vector3();
    for (const [radius, id] of [[2.8, 'name-well'], [3.4, 'cinderwell']] as const) {
      const place = { id, kind: 'shrine' as const, regionId: 'hollowvale', x: 20, z: 35, radius: 22, fastTravel: false,
        name: { en: '', ru: '' }, description: { en: '', ru: '' } };
      const model = locationStructure(resources, { id: `${id}-building-0`, kind: 'wall', x: 27, z: 11, radius, height: 8, variant: 0 },
        place, regionThemes.hollowvale!);
      model.updateMatrixWorld(true);
      let meshes = 0;
      model.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        meshes++;
        expect(object.geometry).toBe(library.get('prop-echo-well')!.scene.children[0] instanceof THREE.Mesh
          ? (library.get('prop-echo-well')!.scene.children[0] as THREE.Mesh).geometry : object.geometry);
        const positions = object.geometry.getAttribute('position');
        for (let index = 0; index < positions.count; index++) {
          point.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld);
          expect(Math.hypot(point.x - 27, point.z - 11)).toBeLessThanOrEqual(radius + 0.05);
          expect(point.y).toBeGreaterThan(-0.05);
        }
      });
      expect(meshes).toBe(1);
    }
    resources.dispose();
    library.dispose();
  });
});

describe('line soldier motion on every frame', () => {
  test('passes deformation, contact, loop, clearance, strain and root-motion checks', async () => {
    const { scene, animations } = await parseGlbWithoutTextures(glb('char-line-soldier'));
    const report = verifyMotion(scene, animations, SOLDIER_MOTION);
    expect(report.failures).toEqual([]);
    expect(report.maxInfluences).toBeLessThanOrEqual(4);
    expect(report.soles[0]).toBeGreaterThan(10);
    expect(report.soles[1]).toBeGreaterThan(10);
    const run = report.clips.find(clip => clip.name === 'Run')!;
    for (const foot of run.contact) expect(foot.fraction).toBeGreaterThan(0.25);
  }, 60_000);

  const expected: Record<string, RegExp> = {
    static: /barely deforms/, rootMotion: /moves its root joint/, sliding: /slides foot/, openLoop: /does not close its loop/,
    stretched: /stretches an edge/, unnormalizedWeights: /not normalized/,
  };
  test.each(Object.keys(expected))('rejects a deliberately broken %s copy', async name => {
    const { scene, animations } = await parseGlbWithoutTextures(glb('char-line-soldier'));
    const variant = brokenVariants(animations, 'root', 'forearm_r')[name]!;
    if (variant.mutateWeights) {
      scene.traverse(object => {
        if (!(object instanceof THREE.SkinnedMesh)) return;
        const weights = object.geometry.getAttribute('skinWeight');
        for (let index = 0; index < weights.array.length; index++) (weights.array as Float32Array)[index]! *= 0.7;
      });
    }
    const report = verifyMotion(scene, variant.clips, SOLDIER_MOTION);
    expect(report.failures.some(failure => expected[name]!.test(failure)), report.failures.join('\n')).toBe(true);
  }, 60_000);
});

function soldierFrame(snapshot: GameSnapshot, faction: FactionId, allegiance: 'friendly' | 'hostile' | 'neutral') {
  const soldier = snapshot.actors.find(actor => actor.kind === 'soldier')!;
  return { ...structuredClone(soldier), faction, allegiance };
}

describe('model presentation without a DOM', () => {
  test('dyes every faction and allegiance through one program, drives clips from snapshots and releases instances', async () => {
    const library = new ModelLibrary(nodeSource);
    await library.ready;
    const campaign = createCampaign({ seed: 'model-presentation', faction: 'guard' });
    const snapshot = campaign.snapshot();
    snapshot.narrative = undefined;
    const variants: [FactionId, 'friendly' | 'hostile' | 'neutral'][] = [
      ['elf', 'hostile'], ['guard', 'friendly'], ['villain', 'hostile'], ['villain', 'friendly'], ['guard', 'neutral'],
    ];
    const soldiers = variants.map(([faction, allegiance], index) => ({
      ...soldierFrame(snapshot, faction, allegiance), id: `test-soldier-${index}`, x: snapshot.player.x + index * 3, z: snapshot.player.z + 4,
    }));
    snapshot.actors = [...snapshot.actors.filter(actor => actor.kind !== 'soldier'), ...soldiers];
    const resources = new ViewResources(undefined, 1, library);
    const presentation = new Presentation(snapshot.world, resources);
    const camera = new THREE.PerspectiveCamera();
    const disposed = vi.fn();
    try {
      presentation.update(snapshot, 1 / 60, camera, false);
      const keys = new Set<string>();
      const colours = new Map<string, string>();
      for (const [index, soldier] of soldiers.entries()) {
        const root = presentation.scene.getObjectByName(`actor:${soldier.id}`)!;
        const skinned: THREE.SkinnedMesh[] = [];
        root.traverse(object => { if (object instanceof THREE.SkinnedMesh) skinned.push(object); });
        expect(skinned).toHaveLength(1);
        const material = skinned[0]!.material as THREE.MeshStandardMaterial;
        keys.add(material.customProgramCacheKey());
        colours.set(`${soldier.faction}:${soldier.allegiance}`, `#${(material.userData.dye.dyeColor.value as THREE.Color).getHexString()}`);
        expect(skinned[0]!.customDepthMaterial).toBe(library.depthMaterial());
        expect(resources.modelDepthMaterial()).toBe(library.depthMaterial());
        expect(Boolean(root.getObjectByName('allegiance-ring'))).toBe(soldier.allegiance !== 'hostile');
        // Each faction's soldier carries its own weapon (the mountain infantry an axe) and shield.
        for (const item of TROOPS[troopModelFor('soldier', soldier.faction)].items) expect(root.getObjectByName(item), item).toBeDefined();
        expect(root.getObjectByName('item-shield')).toBeDefined();
        expect(root.getObjectByName('actor-body')).toBeUndefined();
        const skeleton = skinned[0]!.skeleton;
        const release = skeleton.dispose.bind(skeleton);
        skeleton.dispose = () => { disposed(); release(); };
        void index;
      }
      expect(keys).toEqual(new Set(['korovany-dye-v1']));
      for (const [faction, allegiance] of variants) {
        expect(colours.get(`${faction}:${allegiance}`)).toBe(new THREE.Color(coatColor('soldier', faction, allegiance)).getHexString().replace(/^/, '#'));
      }
      expect(colours.get('guard:neutral')).toBe(`#${new THREE.Color(palette.stone).getHexString()}`);
      const visual = (id: string) => (presentation as unknown as { actorVisuals: Map<string, { character?: CharacterInstance }> })
        .actorVisuals.get(id)!.character!;
      const step = (mutate: (actor: typeof soldiers[number]) => void, ticks = 1) => {
        for (let tick = 0; tick < ticks; tick++) {
          snapshot.tick += 1;
          snapshot.elapsed = snapshot.tick / 60;
          for (const soldier of soldiers) mutate(soldier);
          snapshot.actors = [...snapshot.actors.filter(actor => !actor.id.startsWith('test-soldier')), ...soldiers];
          presentation.update(snapshot, 1 / 60, camera, false);
        }
      };
      step(actor => { actor.state = 'chase'; actor.z += 3.5 / 60; }, 20);
      expect(visual('test-soldier-0').activeClip).toBe('Run');
      step(actor => { actor.state = 'windup'; actor.stateTime = 0.5; }, 1);
      step(actor => { actor.stateTime = Math.max(0, actor.stateTime - 1 / 60); }, 12);
      expect(visual('test-soldier-0').activeClip).toBe('Windup');
      step(actor => { actor.state = 'dead'; actor.hp = 0; }, 30);
      expect(visual('test-soldier-0').activeClip).toBe('Death');
      presentation.update({ ...snapshot, actors: snapshot.actors.filter(actor => actor.id !== 'test-soldier-0') }, 1 / 60, camera, false);
      expect(disposed).toHaveBeenCalledTimes(1);
    } finally {
      presentation.dispose();
    }
    expect(disposed).toHaveBeenCalledTimes(soldiers.length);
    const template = library.get('char-line-soldier')!;
    const geometryDispose = vi.fn();
    template.scene.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.addEventListener('dispose', geometryDispose); });
    library.dispose();
    expect(geometryDispose).toHaveBeenCalled();
  }, 60_000);

  test('keeps dyed variants and the model shadow-depth material for the page, across presentations', async () => {
    const library = new ModelLibrary(nodeSource, ['char-line-soldier']);
    await library.ready;
    let body: THREE.Material | undefined;
    library.require('char-line-soldier').scene.traverse(object => {
      if (object instanceof THREE.SkinnedMesh) body = object.material as THREE.Material;
    });
    const first = new ViewResources(undefined, 1, library);
    const second = new ViewResources(undefined, 1, library);
    const coat = coatColor('soldier', 'villain', 'hostile');
    const tinted = first.dyed(body!, coat);
    // A later world mirror reuses the same objects, so the renderer keeps their programs instead of recompiling.
    expect(second.dyed(body!, coat)).toBe(tinted);
    expect(second.modelDepthMaterial()).toBe(first.modelDepthMaterial());
    expect(first.modelDepthMaterial()).not.toBe(first.depthMaterial());
    const released = vi.fn();
    tinted.addEventListener('dispose', released);
    first.modelDepthMaterial().addEventListener('dispose', released);
    first.dispose();
    second.dispose();
    expect(released).not.toHaveBeenCalled();
    library.dispose();
    expect(released).toHaveBeenCalledTimes(2);
  });

  test('reduced motion holds a still stance and skips hit reactions; normal motion breathes and flinches', async () => {
    const library = new ModelLibrary(nodeSource, ['char-line-soldier']);
    await library.ready;
    const model = library.require('char-line-soldier');
    const material = new THREE.MeshStandardMaterial();
    const materials = { body: material, items: material, depth: material };
    const pose = (character: CharacterInstance) => character.skinned[0]!.skeleton.bones.flatMap(bone => bone.quaternion.toArray());
    const change = (a: number[], b: number[]) => Math.max(...a.map((value, index) => Math.abs(value - b[index]!)));
    const frame = (reducedMotion: boolean, hit = false): CharacterFrame => ({ state: 'idle', progress: 0, speed: 0, hit, relaxed: false, reducedMotion });
    const still = new CharacterInstance(model, materials);
    const calm = new CharacterInstance(model, materials);
    const struck = new CharacterInstance(model, materials);
    try {
      const all = (update: (character: CharacterInstance, index: number) => void) => [still, calm, struck].forEach(update);
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

  test('surfaces a failed model instead of presenting a procedural substitute', async () => {
    const library = new ModelLibrary({ load: async () => { throw new Error('404 Not Found'); } }, ['char-line-soldier']);
    await expect(library.ready).rejects.toThrow('Could not load 3D model');
    expect(library.isReady).toBe(false);
    expect(library.status.error).toMatch(/models\/char-line-soldier\/char-line-soldier\.glb/);
    expect(() => library.assert()).toThrow('Reload to retry');
    expect(() => library.require('char-line-soldier')).toThrow('Could not load 3D model');
  });
});
