import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/** Cooked, provenance-tracked GLB assets shipped under `public/models/<id>/<id>.glb`. */
export type HeroFaction = 'elf' | 'guard' | 'villain';
export type HeroModelId = `char-hero-${HeroFaction}`;
export type ModelId = 'char-line-soldier' | 'prop-echo-well' | HeroModelId;
export const MODEL_IDS: readonly ModelId[] = ['char-line-soldier', 'prop-echo-well', 'char-hero-elf', 'char-hero-guard', 'char-hero-villain'];

export type CharacterClip = 'Idle' | 'AtEase' | 'Run' | 'Windup' | 'Strike' | 'Recovery' | 'Hit' | 'Death';
export const CHARACTER_CLIPS: readonly CharacterClip[] = ['Idle', 'AtEase', 'Run', 'Windup', 'Strike', 'Recovery', 'Hit', 'Death'];

/** Presentation contract of the line soldier. Gameplay timing and speed stay authoritative in the simulation. */
export const LINE_SOLDIER = {
  id: 'char-line-soldier',
  /** Planted-foot speed authored into one Run cycle, in metres per second. */
  runSpeed: 3.5,
  loops: ['Idle', 'AtEase', 'Run'] as readonly CharacterClip[],
  items: ['item-sword', 'item-shield'] as const,
} as const;

export type HeroClip = 'Idle' | 'AtEase' | 'Run' | 'RunBack' | 'RunLeft' | 'RunRight' | 'Sprint' | 'Dodge' | 'Attack' | 'AttackB'
  | 'Ability' | 'Interact' | 'Hit' | 'Death';
export const HERO_CLIPS: readonly HeroClip[] = ['Idle', 'AtEase', 'Run', 'RunBack', 'RunLeft', 'RunRight', 'Sprint', 'Dodge', 'Attack',
  'AttackB', 'Ability', 'Interact', 'Hit', 'Death'];

/**
 * Presentation contract of each faction's hero. `runSpeed` is the planted-foot speed authored into the Run clips
 * (the faction's base speed); Sprint is authored at `SPRINT_FACTOR` times it. `height` is the cooked standing height
 * in metres. Gameplay speed, timing and heading stay authoritative in the simulation.
 */
export const HEROES: Record<HeroFaction, { id: HeroModelId; runSpeed: number; height: number; items: readonly string[] }> = {
  elf: { id: 'char-hero-elf', runSpeed: 7.6, height: 2.34, items: ['item-bow', 'item-quiver'] },
  guard: { id: 'char-hero-guard', runSpeed: 6.3, height: 2.23, items: ['item-sword', 'item-shield'] },
  villain: { id: 'char-hero-villain', runSpeed: 6.8, height: 2.28, items: ['item-hammer'] },
};
export const SPRINT_FACTOR = 1.55;

function heroOf(id: ModelId): (typeof HEROES)[HeroFaction] | undefined {
  return Object.values(HEROES).find(hero => hero.id === id);
}

export function modelUrl(id: ModelId): string {
  return `${import.meta.env.BASE_URL}models/${id}/${id}.glb`;
}

/** Browser source: the same three.js GLTFLoader version the game renders with. */
export function gltfModelSource(): ModelSource {
  const loader = new GLTFLoader();
  return { load: id => loader.loadAsync(modelUrl(id)) };
}

export interface LoadedModel {
  readonly id: ModelId;
  readonly scene: THREE.Object3D;
  readonly clips: ReadonlyMap<string, THREE.AnimationClip>;
  /** Axis-aligned bounds of the rest pose in model metres. */
  readonly bounds: THREE.Box3;
  /** Largest horizontal distance of any rest-pose vertex from the model origin. */
  readonly reach: number;
}

export interface ModelSource {
  load(id: ModelId): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>;
}

export interface ModelStatus {
  pending: number;
  loaded: number;
  total: number;
  error: string | null;
}

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  root.traverse(object => {
    if (object instanceof THREE.Mesh) result.push(object);
  });
  return result;
}

function horizontalReach(root: THREE.Object3D): number {
  const point = new THREE.Vector3();
  let reach = 0;
  for (const mesh of meshes(root)) {
    const positions = mesh.geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index++) {
      point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
      reach = Math.max(reach, Math.hypot(point.x, point.z));
    }
  }
  return reach;
}

function validate(id: ModelId, scene: THREE.Object3D, clips: ReadonlyMap<string, THREE.AnimationClip>): void {
  const parts = meshes(scene);
  const hero = heroOf(id);
  if (id === 'char-line-soldier' || hero) {
    const bodies = parts.filter(mesh => mesh instanceof THREE.SkinnedMesh);
    if (bodies.length !== 1) throw new Error(`expected one skinned body, found ${bodies.length}`);
    for (const clip of hero ? HERO_CLIPS : CHARACTER_CLIPS) {
      if (!clips.has(clip)) throw new Error(`missing animation clip ${clip}`);
    }
    for (const item of hero ? hero.items : LINE_SOLDIER.items) {
      if (!parts.some(mesh => mesh.name === item && !(mesh instanceof THREE.SkinnedMesh))) {
        throw new Error(`missing attached item ${item}`);
      }
    }
    if (hero) {
      const names = new Set(bodies[0]!.skeleton.bones.map(bone => bone.name));
      for (const joint of ['pelvis', 'spine', 'chest']) if (!names.has(joint)) throw new Error(`missing ${joint} joint`);
    }
  } else if (parts.length !== 1 || parts[0] instanceof THREE.SkinnedMesh || Array.isArray(parts[0]!.material)) {
    throw new Error('expected one static mesh with one material');
  }
  for (const mesh of parts) {
    if (!mesh.geometry.getAttribute('normal')) throw new Error(`mesh ${mesh.name} has no cooked normals`);
    if (!(mesh.material instanceof THREE.MeshStandardMaterial)) throw new Error(`mesh ${mesh.name} is not physically based`);
  }
}

/**
 * Owns parsed models for the lifetime of the page. Presentations borrow templates, dyed variants and the model
 * shadow-depth material; only this library disposes their geometry, materials and textures, so a page-lifetime
 * renderer keeps the uploads and shader programs across world mirrors. `releaseGpu` frees one renderer's copies
 * so a replacement renderer can upload the same parsed data again.
 */
export class ModelLibrary {
  private readonly models = new Map<ModelId, LoadedModel>();
  private readonly dyes = new Map<string, THREE.MeshStandardMaterial>();
  private shadowDepth: THREE.MeshDepthMaterial | undefined;
  private failure: Error | undefined;
  private pendingCount: number;
  private disposed = false;
  readonly ready: Promise<void>;

  constructor(source: ModelSource, readonly ids: readonly ModelId[] = MODEL_IDS) {
    this.pendingCount = ids.length;
    this.ready = Promise.all(ids.map(async id => {
      try {
        const gltf = await source.load(id);
        const clips = new Map(gltf.animations.map(clip => [clip.name, clip] as const));
        validate(id, gltf.scene, clips);
        gltf.scene.updateMatrixWorld(true);
        const loaded: LoadedModel = {
          id, scene: gltf.scene, clips, bounds: new THREE.Box3().setFromObject(gltf.scene), reach: horizontalReach(gltf.scene),
        };
        if (this.disposed) ModelLibrary.release(loaded, true);
        else this.models.set(id, loaded);
      } catch (cause) {
        const error = new Error(`Could not load 3D model ${modelUrl(id)}: ${cause instanceof Error ? cause.message : String(cause)}. Reload to retry.`, { cause });
        this.failure ??= error;
        throw error;
      } finally {
        this.pendingCount--;
      }
    })).then(() => undefined);
    // Callers observe failures through `ready`, `status` or `assert`; never as an unhandled rejection.
    this.ready.catch(() => undefined);
  }

  get status(): ModelStatus {
    return { pending: this.pendingCount, loaded: this.models.size, total: this.ids.length, error: this.failure?.message ?? null };
  }

  get isReady(): boolean {
    return !this.failure && this.models.size === this.ids.length;
  }

  assert(): void {
    if (this.failure) throw this.failure;
  }

  get(id: ModelId): LoadedModel | undefined {
    return this.models.get(id);
  }

  require(id: ModelId): LoadedModel {
    this.assert();
    const model = this.models.get(id);
    if (!model) throw new Error(`3D model ${id} was used before it finished loading.`);
    return model;
  }

  /** Faction-tinted copy of a model material, shared by every presentation; all tints share one program. */
  dyed(base: THREE.MeshStandardMaterial, color: string): THREE.MeshStandardMaterial {
    const key = `${base.uuid}:${color}`;
    let material = this.dyes.get(key);
    if (!material) {
      material = dyedMaterial(base, color);
      this.dyes.set(key, material);
    }
    return material;
  }

  /** Shadow-depth material for model casters. It matches the world's, so rigid casters share its programs. */
  depthMaterial(): THREE.MeshDepthMaterial {
    this.shadowDepth ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    return this.shadowDepth;
  }

  private releaseShared(): void {
    for (const material of this.dyes.values()) material.dispose();
    this.dyes.clear();
    this.shadowDepth?.dispose();
    this.shadowDepth = undefined;
  }

  private static release(model: LoadedModel, close: boolean): void {
    const textures = new Set<THREE.Texture>();
    model.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
        material.dispose();
      }
      if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
    });
    for (const texture of textures) {
      texture.dispose();
      const image: unknown = texture.image;
      if (close && typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
    }
  }

  /** Frees GPU copies owned by the current renderer while keeping parsed data for the next one. */
  releaseGpu(): void {
    this.releaseShared();
    for (const model of this.models.values()) ModelLibrary.release(model, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseShared();
    for (const model of this.models.values()) ModelLibrary.release(model, true);
    this.models.clear();
  }
}

export interface DyeUniforms {
  dyeColor: { value: THREE.Color };
  dyeGain: { value: number };
}

/**
 * Faction colour comes from a mask stored in the base-colour alpha of an opaque material. Every variant
 * shares one shader program; only the colour uniform differs.
 */
export function dyedMaterial(base: THREE.MeshStandardMaterial, color: string, gain = 1.9): THREE.MeshStandardMaterial {
  const material = base.clone();
  const uniforms: DyeUniforms = { dyeColor: { value: new THREE.Color(color) }, dyeGain: { value: gain } };
  material.name = `${base.name}:dye`;
  material.userData.dye = uniforms;
  material.customProgramCacheKey = () => 'korovany-dye-v1';
  material.onBeforeCompile = shader => {
    shader.uniforms.dyeColor = uniforms.dyeColor;
    shader.uniforms.dyeGain = uniforms.dyeGain;
    shader.fragmentShader = `uniform vec3 dyeColor;\nuniform float dyeGain;\n${shader.fragmentShader}`.replace('#include <map_fragment>', `
      #include <map_fragment>
      #ifdef USE_MAP
        float dyeMask = sampledDiffuseColor.a;
        float dyeLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        diffuseColor.rgb = mix(diffuseColor.rgb, dyeColor * dyeLuma * dyeGain, dyeMask);
        diffuseColor.a = opacity;
      #endif
    `);
  };
  return material;
}

export interface CharacterFrame {
  state: 'idle' | 'move' | 'windup' | 'attack' | 'recovery' | 'dead';
  /** Progress through a telegraphed state from the snapshot, 0-1. */
  progress: number;
  /** Ground speed in metres per second, zero while the simulation is paused. */
  speed: number;
  /** The actor lost health on the latest simulation tick. */
  hit: boolean;
  /** A conversation or inspection is open: stand at ease. */
  relaxed: boolean;
  reducedMotion: boolean;
}

const FADE_SECONDS = 0.16;
const SCRUBBED = new Set<CharacterClip>(['Windup', 'Strike', 'Recovery']);

/** One cloned, skinned soldier with its own mixer. Cosmetic only: it never reads or writes game rules. */
export class CharacterInstance {
  readonly root: THREE.Object3D;
  readonly skinned: THREE.SkinnedMesh[] = [];
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<CharacterClip, THREE.AnimationAction>();
  private readonly weights = new Map<CharacterClip, number>();
  private readonly hit: THREE.AnimationAction;
  private dead = false;

  constructor(model: LoadedModel, materials: { body: THREE.Material; items: THREE.Material; depth: THREE.Material }, startDead = false) {
    this.root = cloneSkinned(model.scene);
    this.root.name = model.id;
    this.root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.material = object instanceof THREE.SkinnedMesh ? materials.body : materials.items;
      object.castShadow = true;
      object.receiveShadow = true;
      object.customDepthMaterial = materials.depth;
      if (object instanceof THREE.SkinnedMesh) this.skinned.push(object);
    });
    this.mixer = new THREE.AnimationMixer(this.root);
    for (const name of CHARACTER_CLIPS) {
      const clip = model.clips.get(name)!;
      if (name === 'Hit') continue;
      const action = this.mixer.clipAction(clip);
      if (!LINE_SOLDIER.loops.includes(name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      action.play();
      action.setEffectiveWeight(name === 'Idle' ? 1 : 0);
      this.actions.set(name, action);
      this.weights.set(name, name === 'Idle' ? 1 : 0);
    }
    const additive = THREE.AnimationUtils.makeClipAdditive(model.clips.get('Hit')!.clone());
    this.hit = this.mixer.clipAction(additive);
    this.hit.blendMode = THREE.AdditiveAnimationBlendMode;
    this.hit.setLoop(THREE.LoopOnce, 1);
    if (startDead) {
      this.dead = true;
      const death = this.actions.get('Death')!;
      death.time = death.getClip().duration;
      this.snap('Death');
    }
    this.mixer.update(0);
  }

  private snap(target: CharacterClip): void {
    for (const [name, action] of this.actions) {
      const weight = name === target ? 1 : 0;
      this.weights.set(name, weight);
      action.setEffectiveWeight(weight);
    }
  }

  get activeClip(): CharacterClip {
    let best: CharacterClip = 'Idle';
    let weight = -1;
    for (const [name, value] of this.weights) {
      if (value > weight) {
        best = name;
        weight = value;
      }
    }
    return best;
  }

  update(frame: CharacterFrame, dt: number): void {
    const target: CharacterClip = frame.state === 'dead' ? 'Death'
      : frame.state === 'windup' ? 'Windup'
        : frame.state === 'attack' ? 'Strike'
          : frame.state === 'recovery' ? 'Recovery'
            : frame.state === 'move' && frame.speed > 0.35 ? 'Run'
              : frame.relaxed ? 'AtEase' : 'Idle';
    if (target === 'Death' && !this.dead) {
      this.dead = true;
      const death = this.actions.get('Death')!;
      death.reset();
      death.play();
      this.hit.stop();
    } else if (target !== 'Death') {
      this.dead = false;
    }
    for (const [name, action] of this.actions) {
      if (SCRUBBED.has(name)) {
        action.paused = true;
        if (name === target) action.time = THREE.MathUtils.clamp(frame.progress, 0, 1) * action.getClip().duration;
      } else if (name === 'Run') {
        action.paused = false;
        action.timeScale = THREE.MathUtils.clamp(frame.speed / LINE_SOLDIER.runSpeed, 0.5, 1.9);
      } else if (name === 'Idle' || name === 'AtEase') {
        // Reduced motion keeps a still stance instead of breathing and weight shifts.
        action.paused = frame.reducedMotion;
        if (frame.reducedMotion) action.time = 0;
      }
    }
    const rate = dt <= 0 ? 1 : dt / (target === 'Death' ? 0.1 : SCRUBBED.has(target) ? 0.06 : FADE_SECONDS);
    for (const [name, action] of this.actions) {
      const current = this.weights.get(name)!;
      const goal = name === target ? 1 : 0;
      const next = goal > current ? Math.min(goal, current + rate) : Math.max(goal, current - rate);
      this.weights.set(name, next);
      action.setEffectiveWeight(next);
    }
    if (frame.hit && !this.dead && !frame.reducedMotion) {
      this.hit.reset();
      this.hit.setEffectiveWeight(1);
      this.hit.play();
    }
    this.mixer.update(Math.max(0, dt));
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    for (const mesh of this.skinned) mesh.skeleton.dispose();
    this.root.removeFromParent();
  }
}

export interface HeroFrame {
  /** Entity-frame ground velocity in m/s: +z forward, +x toward the hero's left. Zero while the simulation is paused. */
  velocity: { x: number; z: number };
  dodging: boolean;
  dead: boolean;
  /** An attack or ability event arrived since the previous frame. */
  attack: boolean;
  ability: boolean;
  /** The hero lost health on the latest simulation tick. */
  hit: boolean;
  /** The hero is holding an interaction whose progress is rising (capture, repair, rest). */
  working: boolean;
  /** A conversation or inspection is open: stand at ease. */
  relaxed: boolean;
  reducedMotion: boolean;
}

type BaseClip = Exclude<HeroClip, 'Attack' | 'AttackB' | 'Ability' | 'Hit'>;
type OverlayClip = Extract<HeroClip, 'Attack' | 'AttackB' | 'Ability'>;
const BASE_CLIPS: readonly BaseClip[] = ['Idle', 'AtEase', 'Interact', 'Run', 'RunBack', 'RunLeft', 'RunRight', 'Sprint', 'Dodge', 'Death'];
const LOCOMOTION: readonly BaseClip[] = ['Run', 'RunBack', 'RunLeft', 'RunRight', 'Sprint'];
/** Directional clips by entity-frame travel angle, atan2(x, z), counter-clockwise from forward (+x is the hero's left). */
const DIRECTIONS: readonly BaseClip[] = ['Run', 'RunLeft', 'RunBack', 'RunRight'];
const STATIONARY: readonly BaseClip[] = ['Idle', 'AtEase', 'Interact'];
/** Below this ground speed the hero stands; the simulation starts and stops instantly. */
const HERO_MOVING = 0.35;
/** Time constant of base-layer crossfades, in seconds. */
const HERO_BLEND = 0.05;
/** A directional clip is kept until travel leaves its 90-degree sector by this much, so diagonals do not flicker. */
const DIRECTION_HYSTERESIS = THREE.MathUtils.degToRad(10);
/** Time constants of the body's turn onto its travel direction, in seconds. */
const TURN = 0.06;
const DASH_TURN = 0.03;
/** Largest upper-body counter-twist toward the heading. */
const MAX_TWIST = THREE.MathUtils.degToRad(60);
const OVERLAY_IN = 0.05;
const OVERLAY_OUT = 0.15;
const OVERLAY_CROSSFADE = 0.08;
const DODGE_OUT = 0.15;
const UP = new THREE.Vector3(0, 1, 0);

interface Channel {
  bone: number;
  quaternion?: THREE.Interpolant;
  position?: THREE.Interpolant;
}

/** Samples one clip onto skeleton bone indices without a mixer, for the overlay and the additive hit. */
class ClipSampler {
  readonly channels: Channel[] = [];
  readonly duration: number;

  constructor(clip: THREE.AnimationClip, bones: readonly THREE.Bone[]) {
    this.duration = clip.duration;
    const index = new Map(bones.map((bone, position) => [bone.name, position] as const));
    const channels = new Map<number, Channel>();
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.');
      const bone = index.get(track.name.slice(0, dot));
      const property = track.name.slice(dot + 1);
      if (bone === undefined || (property !== 'quaternion' && property !== 'position')) continue;
      let channel = channels.get(bone);
      if (!channel) {
        channel = { bone };
        channels.set(bone, channel);
        this.channels.push(channel);
      }
      channel[property] = track.createInterpolant();
    }
  }
}

interface Pose {
  quaternion: THREE.Quaternion[];
  position: THREE.Vector3[];
}

interface OverlayPlay {
  sampler: ClipSampler;
  name: OverlayClip;
  time: number;
}

/**
 * One cloned, skinned hero driven by snapshot state and render time. Cosmetic only: position, heading, collision,
 * timing and every gameplay rule stay authoritative in the simulation.
 *
 * The base layer runs on an `AnimationMixer`: Idle, AtEase and Interact while standing, one pure directional run
 * (forward, back, left or right, blended with Sprint by speed), the dash and the held corpse. Base clip times are set
 * here, never advanced by the mixer: every locomotion clip shares one stride phase advanced by the measured ground
 * speed, so planted feet keep the authored stride at any speed. Diagonal travel uses orientation warping: the body
 * turns by up to 55 degrees onto the exact travel direction of the nearest directional clip, and spine and chest
 * counter-twist so the upper body keeps facing the heading. Attacks and the ability form an overlay. While the hero
 * stands they drive the whole body; while it moves they replace the upper body only, with the spine corrected for the
 * locomotion's pelvis. The hit flinch is additive.
 */
export class HeroInstance {
  readonly root: THREE.Object3D;
  readonly skinned: THREE.SkinnedMesh[] = [];
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<BaseClip, THREE.AnimationAction>();
  private readonly weights = new Map<BaseClip, number>();
  private readonly targets = new Map<BaseClip, number>();
  private readonly strides = new Map<BaseClip, number>();
  private readonly bones: THREE.Bone[];
  private readonly upper: boolean[];
  private readonly pelvis: number;
  private readonly spine: number;
  private readonly chest: number;
  private readonly rest: Pose;
  private readonly base: Pose;
  private readonly overlayPose: Pose;
  private readonly previousPose: Pose;
  private readonly overlays: Record<OverlayClip, ClipSampler>;
  private readonly hitSampler: ClipSampler;
  private current: OverlayPlay | undefined;
  private previous: OverlayPlay | undefined;
  private crossfade = 0;
  private overlayWeight = 0;
  private nextAttack: 'Attack' | 'AttackB' = 'Attack';
  private hitTime = Infinity;
  private dodgeTime = Infinity;
  private deathTime = Infinity;
  private phase = 0;
  private stationaryTime = 0;
  /** Directional clip in use, as an index into DIRECTIONS. */
  private direction = 0;
  /** Body yaw from the heading, in radians: the model turns onto its travel direction or dash. */
  private yaw = 0;
  private dodgeYaw = 0;
  private wasDodging = false;
  private dead = false;
  private readonly corrected = new THREE.Quaternion();
  private readonly delta = new THREE.Quaternion();
  private readonly offset = new THREE.Vector3();
  private readonly parentWorld = new THREE.Quaternion();
  private readonly world = new THREE.Quaternion();
  private readonly turn = new THREE.Quaternion();

  constructor(model: LoadedModel, readonly runSpeed: number,
    materials: { body: THREE.Material; items: THREE.Material; depth: THREE.Material }, startDead = false) {
    this.root = cloneSkinned(model.scene);
    this.root.name = model.id;
    this.root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.material = object instanceof THREE.SkinnedMesh ? materials.body : materials.items;
      object.castShadow = true;
      object.receiveShadow = true;
      object.customDepthMaterial = materials.depth;
      if (object instanceof THREE.SkinnedMesh) this.skinned.push(object);
    });
    this.bones = this.skinned[0]!.skeleton.bones;
    this.pelvis = this.bones.findIndex(bone => bone.name === 'pelvis');
    this.spine = this.bones.findIndex(bone => bone.name === 'spine');
    this.chest = this.bones.findIndex(bone => bone.name === 'chest');
    const above = new Set<THREE.Object3D>();
    this.bones[this.spine]!.traverse(object => above.add(object));
    this.upper = this.bones.map(bone => above.has(bone));
    const pose = (): Pose => ({ quaternion: this.bones.map(bone => bone.quaternion.clone()), position: this.bones.map(bone => bone.position.clone()) });
    this.rest = pose();
    this.base = pose();
    this.overlayPose = pose();
    this.previousPose = pose();
    this.mixer = new THREE.AnimationMixer(this.root);
    for (const name of BASE_CLIPS) {
      const action = this.mixer.clipAction(model.clips.get(name)!);
      action.paused = true;
      action.play();
      action.setEffectiveWeight(name === 'Idle' ? 1 : 0);
      this.actions.set(name, action);
      this.weights.set(name, name === 'Idle' ? 1 : 0);
    }
    for (const name of LOCOMOTION) {
      this.strides.set(name, (name === 'Sprint' ? runSpeed * SPRINT_FACTOR : runSpeed) * model.clips.get(name)!.duration);
    }
    this.overlays = {
      Attack: new ClipSampler(model.clips.get('Attack')!, this.bones),
      AttackB: new ClipSampler(model.clips.get('AttackB')!, this.bones),
      Ability: new ClipSampler(model.clips.get('Ability')!, this.bones),
    };
    this.hitSampler = new ClipSampler(THREE.AnimationUtils.makeClipAdditive(model.clips.get('Hit')!.clone()), this.bones);
    if (startDead) {
      this.dead = true;
      this.deathTime = model.clips.get('Death')!.duration;
      for (const [name, action] of this.actions) {
        this.weights.set(name, name === 'Death' ? 1 : 0);
        action.setEffectiveWeight(name === 'Death' ? 1 : 0);
        if (name === 'Death') action.time = this.deathTime;
      }
    }
    this.pose(0);
  }

  /** The base clip with the largest weight. */
  get activeClip(): BaseClip {
    let best: BaseClip = 'Idle';
    let weight = -1;
    for (const [name, value] of this.weights) {
      if (value > weight) {
        best = name;
        weight = value;
      }
    }
    return best;
  }

  /** The playing attack or ability, its time and weight, if any. */
  get overlay(): { clip: OverlayClip; time: number; weight: number } | undefined {
    return this.current && this.overlayWeight > 0 ? { clip: this.current.name, time: this.current.time, weight: this.overlayWeight } : undefined;
  }

  baseWeight(name: BaseClip): number {
    return this.weights.get(name) ?? 0;
  }

  update(frame: HeroFrame, dt: number): void {
    dt = Math.max(0, dt);
    const speed = Math.hypot(frame.velocity.x, frame.velocity.z);
    if (frame.dead !== this.dead) {
      this.dead = frame.dead;
      this.deathTime = frame.dead ? 0 : Infinity;
      this.hitTime = Infinity;
    }
    if (frame.dodging && !this.wasDodging && !this.dead) this.dodgeTime = 0;
    this.wasDodging = frame.dodging;
    if (!this.dead) {
      const ability = this.current?.name === 'Ability' && this.current.time < this.current.sampler.duration * 0.7;
      if (frame.ability) this.start('Ability');
      else if (frame.attack && !ability) {
        this.start(this.nextAttack);
        this.nextAttack = this.nextAttack === 'Attack' ? 'AttackB' : 'Attack';
      }
      if (frame.hit && !frame.reducedMotion) this.hitTime = 0;
    }
    this.blendBase(frame, speed, dt);
    this.advance(frame, speed, dt);
    this.pose(dt);
  }

  /** Base-layer targets sum to one and every weight eases by the same factor, so a blend never leaks the bind pose. */
  private blendBase(frame: HeroFrame, speed: number, dt: number): void {
    const targets = this.targets;
    for (const name of BASE_CLIPS) targets.set(name, 0);
    if (this.dead) {
      targets.set('Death', 1);
    } else {
      const duration = this.actions.get('Dodge')!.getClip().duration;
      const moving = speed > HERO_MOVING && !frame.relaxed;
      // The dash holds its clip; its landing and gathering keep planted feet, so they give way at once to running.
      const dodge = this.dodgeTime >= duration || (moving && !frame.dodging) ? 0
        : THREE.MathUtils.clamp((duration - this.dodgeTime) / DODGE_OUT, 0, 1);
      const remaining = 1 - dodge;
      targets.set('Dodge', dodge);
      if (moving) {
        // Orientation warping: one pure directional clip, with the body turned onto the exact travel direction (below).
        // Joint-space blends of perpendicular strides were measured to slide planted feet at 2-6 m/s on diagonals.
        const angle = Math.atan2(frame.velocity.x, frame.velocity.z);
        const from = THREE.MathUtils.euclideanModulo(angle - this.direction * (Math.PI / 2) + Math.PI, Math.PI * 2) - Math.PI;
        if (Math.abs(from) > Math.PI / 4 + DIRECTION_HYSTERESIS) {
          this.direction = Math.round(THREE.MathUtils.euclideanModulo(angle, Math.PI * 2) / (Math.PI / 2)) % 4;
        }
        const sprint = THREE.MathUtils.clamp((speed / this.runSpeed - 1.15) / 0.3, 0, 1);
        const clip = DIRECTIONS[this.direction]!;
        if (clip === 'Run') {
          targets.set('Run', remaining * (1 - sprint));
          targets.set('Sprint', remaining * sprint);
        } else {
          targets.set(clip, remaining);
        }
      } else {
        targets.set(frame.working ? 'Interact' : frame.relaxed ? 'AtEase' : 'Idle', remaining);
      }
    }
    const ease = 1 - Math.exp(-dt / HERO_BLEND);
    let total = 0;
    for (const name of BASE_CLIPS) {
      const weight = this.weights.get(name)!;
      const next = weight + (targets.get(name)! - weight) * ease;
      this.weights.set(name, next < 1e-4 ? 0 : next);
      total += this.weights.get(name)!;
    }
    for (const name of BASE_CLIPS) this.weights.set(name, total > 0 ? this.weights.get(name)! / total : name === 'Idle' ? 1 : 0);
  }

  private advance(frame: HeroFrame, speed: number, dt: number): void {
    // One stride phase for every locomotion clip, advanced by the ground speed over the active stride, so planted
    // feet keep pace with the ground at any speed.
    let locomotion = 0;
    let stride = 0;
    for (const name of LOCOMOTION) {
      locomotion += this.weights.get(name)!;
      stride += this.weights.get(name)! * this.strides.get(name)!;
    }
    stride = locomotion > 0 ? stride / locomotion : this.strides.get('Run')!;
    if (speed > HERO_MOVING) this.phase = THREE.MathUtils.euclideanModulo(this.phase + speed * dt / stride, 1);
    // Reduced motion holds a still stance instead of breathing and weight shifts.
    this.stationaryTime = frame.reducedMotion ? 0 : this.stationaryTime + dt;
    if (this.dodgeTime < Infinity) this.dodgeTime += dt;
    const death = this.actions.get('Death')!.getClip().duration;
    if (this.deathTime < Infinity) this.deathTime = Math.min(this.deathTime + dt, death);
    for (const [name, action] of this.actions) {
      const duration = action.getClip().duration;
      action.time = LOCOMOTION.includes(name) ? this.phase * duration
        : STATIONARY.includes(name) ? THREE.MathUtils.euclideanModulo(this.stationaryTime, duration)
          : Math.min(name === 'Dodge' ? this.dodgeTime : this.deathTime, duration);
      action.setEffectiveWeight(this.weights.get(name)!);
    }
    // The body turns onto its travel direction (the dash, or the directional clip's own axis), the corpse holds its
    // last facing, and the upper body counter-twists toward the heading below.
    if (frame.dodging && speed > 2) this.dodgeYaw = Math.atan2(frame.velocity.x, frame.velocity.z);
    const dashing = frame.dodging || this.weights.get('Dodge')! > 0.01;
    if (!this.dead) {
      let facing = 0;
      if (dashing) facing = this.dodgeYaw;
      else if (speed > HERO_MOVING && !frame.relaxed) {
        facing = Math.atan2(frame.velocity.x, frame.velocity.z) - this.direction * (Math.PI / 2);
      }
      const turn = THREE.MathUtils.euclideanModulo(facing - this.yaw + Math.PI, Math.PI * 2) - Math.PI;
      this.yaw = THREE.MathUtils.euclideanModulo(this.yaw + turn * (1 - Math.exp(-dt / (dashing ? DASH_TURN : TURN))) + Math.PI, Math.PI * 2)
        - Math.PI;
    }
    this.root.rotation.y = this.yaw;
    // Overlay envelope: in over 50 ms, held through the clip, out over 150 ms after it ends or a story opens.
    if (this.current) {
      this.current.time = Math.min(this.current.time + dt, this.current.sampler.duration);
      const active = !this.dead && !frame.relaxed && this.current.time < this.current.sampler.duration;
      this.overlayWeight = active ? Math.min(1, this.overlayWeight + dt / OVERLAY_IN) : Math.max(0, this.overlayWeight - dt / OVERLAY_OUT);
      if (this.overlayWeight === 0 && !active) this.current = undefined;
    }
    if (this.previous) this.previous.time = Math.min(this.previous.time + dt, this.previous.sampler.duration);
    this.crossfade = Math.max(0, this.crossfade - dt / OVERLAY_CROSSFADE);
    if (this.crossfade === 0) this.previous = undefined;
    if (this.hitTime < Infinity) this.hitTime += dt;
  }

  private start(name: OverlayClip): void {
    if (this.current && this.overlayWeight > 0 && this.current.time < this.current.sampler.duration) {
      // An interrupted swing fades out from where it stands.
      this.previous = { ...this.current };
      this.crossfade = 1;
    }
    this.current = { sampler: this.overlays[name], name, time: 0 };
  }

  /** Local transforms of one overlay clip at its time; untracked bones keep the bind pose, as in the mixer. */
  private sample(play: OverlayPlay, out: Pose): void {
    for (let index = 0; index < this.bones.length; index++) {
      out.quaternion[index]!.copy(this.rest.quaternion[index]!);
      out.position[index]!.copy(this.rest.position[index]!);
    }
    for (const channel of play.sampler.channels) {
      if (channel.quaternion) out.quaternion[channel.bone]!.fromArray(channel.quaternion.evaluate(play.time) as unknown as number[]);
      if (channel.position) out.position[channel.bone]!.fromArray(channel.position.evaluate(play.time) as unknown as number[]);
    }
  }

  private pose(dt: number): void {
    const bones = this.bones;
    // The mixer writes a bone only when its blended value changes, so restore last frame's base pose first and the
    // overlay below never compounds on itself.
    for (let index = 0; index < bones.length; index++) {
      bones[index]!.quaternion.copy(this.base.quaternion[index]!);
      bones[index]!.position.copy(this.base.position[index]!);
    }
    this.mixer.update(dt);
    for (let index = 0; index < bones.length; index++) {
      this.base.quaternion[index]!.copy(bones[index]!.quaternion);
      this.base.position[index]!.copy(bones[index]!.position);
    }
    const weight = this.current ? this.overlayWeight : 0;
    if (this.current && weight > 0) {
      const target = this.overlayPose;
      this.sample(this.current, target);
      if (this.previous && this.crossfade > 0) {
        this.sample(this.previous, this.previousPose);
        for (let index = 0; index < bones.length; index++) {
          target.quaternion[index]!.slerp(this.previousPose.quaternion[index]!, this.crossfade);
          target.position[index]!.lerp(this.previousPose.position[index]!, this.crossfade);
        }
      }
      let standing = 0;
      for (const name of STATIONARY) standing += this.weights.get(name)!;
      const lower = weight * standing;
      if (lower > 0) {
        for (let index = 0; index < bones.length; index++) {
          if (this.upper[index]) continue;
          bones[index]!.quaternion.slerp(target.quaternion[index]!, lower);
          bones[index]!.position.lerp(target.position[index]!, lower);
        }
      }
      // Mesh-space spine: keep the overlay's chest orientation relative to the root whatever the pelvis now does.
      const pelvis = bones[this.pelvis]!.quaternion;
      this.corrected.copy(pelvis).invert().multiply(target.quaternion[this.pelvis]!).multiply(target.quaternion[this.spine]!);
      bones[this.spine]!.quaternion.slerp(this.corrected, weight);
      for (let index = 0; index < bones.length; index++) {
        if (!this.upper[index] || index === this.spine) continue;
        bones[index]!.quaternion.slerp(target.quaternion[index]!, weight);
      }
    }
    // Counter-twist spine and chest about the vertical so the upper body keeps facing the heading (the aim) while the
    // body runs along its travel direction. The dash and the corpse face their own way.
    const gate = Math.max(0, 1 - this.weights.get('Dodge')! - this.weights.get('Death')!);
    const twist = THREE.MathUtils.clamp(-this.yaw, -MAX_TWIST, MAX_TWIST) * gate;
    if (Math.abs(twist) > 1e-4) {
      for (const index of [this.spine, this.chest]) {
        const bone = bones[index]!;
        bone.parent!.getWorldQuaternion(this.parentWorld);
        bone.getWorldQuaternion(this.world);
        this.world.premultiply(this.turn.setFromAxisAngle(UP, twist / 2));
        bone.quaternion.copy(this.parentWorld.invert().multiply(this.world));
      }
    }
    if (this.hitTime < this.hitSampler.duration && !this.dead) {
      for (const channel of this.hitSampler.channels) {
        const bone = bones[channel.bone]!;
        if (channel.quaternion) bone.quaternion.multiply(this.delta.fromArray(channel.quaternion.evaluate(this.hitTime) as unknown as number[]));
        if (channel.position) bone.position.add(this.offset.fromArray(channel.position.evaluate(this.hitTime) as unknown as number[]));
      }
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    for (const mesh of this.skinned) mesh.skeleton.dispose();
    this.root.removeFromParent();
  }
}
/** Static prop placement that shares the library geometry and material for instancing. */
export function propInstance(model: LoadedModel, depth: THREE.Material, radius: number): THREE.Object3D {
  const source = meshes(model.scene)[0]!;
  const mesh = new THREE.Mesh(source.geometry, source.material);
  mesh.name = model.id;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = depth;
  mesh.matrix.copy(source.matrixWorld);
  mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  const holder = new THREE.Group();
  holder.name = `${model.id}:placement`;
  // Uniform scale keeps every vertex inside the authoritative circular blocker.
  holder.scale.setScalar(radius * 0.98 / Math.max(model.reach, 0.001));
  holder.add(mesh);
  return holder;
}
