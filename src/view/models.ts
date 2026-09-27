import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/** Cooked, provenance-tracked GLB assets shipped under `public/models/<id>/<id>.glb`. */
export type ModelId = 'char-line-soldier' | 'prop-echo-well';
export const MODEL_IDS: readonly ModelId[] = ['char-line-soldier', 'prop-echo-well'];

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
  if (id === 'char-line-soldier') {
    const bodies = parts.filter(mesh => mesh instanceof THREE.SkinnedMesh);
    if (bodies.length !== 1) throw new Error(`expected one skinned body, found ${bodies.length}`);
    for (const clip of CHARACTER_CLIPS) {
      if (!clips.has(clip)) throw new Error(`missing animation clip ${clip}`);
    }
    for (const item of LINE_SOLDIER.items) {
      if (!parts.some(mesh => mesh.name === item && !(mesh instanceof THREE.SkinnedMesh))) {
        throw new Error(`missing attached item ${item}`);
      }
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
 * Owns parsed models for the lifetime of the page. Presentations borrow templates; only this library
 * disposes their geometry, materials and textures. `releaseGpu` frees one renderer's copies so a
 * replacement renderer can upload the same parsed data again.
 */
export class ModelLibrary {
  private readonly models = new Map<ModelId, LoadedModel>();
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
    for (const model of this.models.values()) ModelLibrary.release(model, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
