import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { MonsterSpecies } from '../game/types';
import { MONSTER_CLIPS, type WorldModel } from './world-assets';

type MonsterClip = typeof MONSTER_CLIPS[number];

/**
 * Per species, the authored ground speeds of its Walk and Run clips (cook_monster_quadruped.py recipe, metres per
 * second) and the speed above which it runs rather than walks.
 */
export const MONSTER_GAITS: Readonly<Record<MonsterSpecies, { walk: number; run: number; runAbove: number }>> = {
  wolf: { walk: 1.3, run: 6.0, runAbove: 2.2 },
};

export interface MonsterFrame {
  state: 'idle' | 'move' | 'windup' | 'attack' | 'recovery' | 'dead';
  /** Progress through a telegraphed state from the snapshot, 0-1. */
  progress: number;
  /** Ground speed in metres per second, zero while the simulation is paused. */
  speed: number;
  /** The beast lost health on the latest simulation tick. */
  hit: boolean;
  reducedMotion: boolean;
}

const FADE_SECONDS = 0.16;
const LOOPS = new Set<MonsterClip>(['Idle', 'Walk', 'Run']);
const SCRUBBED = new Set<MonsterClip>(['Windup', 'Strike', 'Recovery']);

/**
 * One cloned, skinned version 3 monster with its own mixer, following the troops' clip contract: Idle, Walk and Run by
 * ground speed, Windup, Strike and Recovery scrubbed by the snapshot's progress through those states, Hit added on a
 * wound and Death held at its last frame. Monsters wear their cooked coat (never dyed). Cosmetic only: it never reads
 * or writes game rules.
 */
export class MonsterInstance {
  readonly root: THREE.Object3D;
  /** Standing height in metres (the health bar floats above it). */
  readonly height: number;
  private readonly skinned: THREE.SkinnedMesh[] = [];
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<MonsterClip, THREE.AnimationAction>();
  private readonly weights = new Map<MonsterClip, number>();
  private readonly hit: THREE.AnimationAction;
  private readonly gait: { walk: number; run: number; runAbove: number };
  private dead = false;

  constructor(model: WorldModel, readonly species: MonsterSpecies, startDead = false) {
    this.gait = MONSTER_GAITS[species];
    this.root = cloneSkinned(model.scene);
    this.root.name = model.id;
    this.root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = true;
      object.receiveShadow = true;
      // Skinned bounds stay at the bind pose; the wolf's lunge and fall reach beyond them.
      object.frustumCulled = false;
      if (object instanceof THREE.SkinnedMesh) this.skinned.push(object);
    });
    this.height = model.bounds.max.y;
    this.mixer = new THREE.AnimationMixer(this.root);
    for (const name of MONSTER_CLIPS) {
      if (name === 'Hit') continue;
      const clip = model.clips.get(name);
      if (!clip) throw new Error(`The ${species} model has no ${name} clip.`);
      const action = this.mixer.clipAction(clip);
      if (!LOOPS.has(name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      action.play();
      action.setEffectiveWeight(name === 'Idle' ? 1 : 0);
      this.actions.set(name, action);
      this.weights.set(name, name === 'Idle' ? 1 : 0);
    }
    const hit = model.clips.get('Hit');
    if (!hit) throw new Error(`The ${species} model has no Hit clip.`);
    this.hit = this.mixer.clipAction(THREE.AnimationUtils.makeClipAdditive(hit.clone()));
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

  private snap(target: MonsterClip): void {
    for (const [name, action] of this.actions) {
      const weight = name === target ? 1 : 0;
      this.weights.set(name, weight);
      action.setEffectiveWeight(weight);
    }
  }

  /** The clip with the largest blend weight. */
  get activeClip(): MonsterClip {
    let best: MonsterClip = 'Idle';
    let weight = -1;
    for (const [name, value] of this.weights) {
      if (value > weight) {
        best = name;
        weight = value;
      }
    }
    return best;
  }

  update(frame: MonsterFrame, dt: number): void {
    const target: MonsterClip = frame.state === 'dead' ? 'Death'
      : frame.state === 'windup' ? 'Windup'
        : frame.state === 'attack' ? 'Strike'
          : frame.state === 'recovery' ? 'Recovery'
            : frame.state === 'move' && frame.speed > this.gait.runAbove ? 'Run'
              : frame.state === 'move' && frame.speed > 0.35 ? 'Walk' : 'Idle';
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
      } else if (name === 'Run' || name === 'Walk') {
        action.paused = false;
        action.timeScale = THREE.MathUtils.clamp(frame.speed / (name === 'Run' ? this.gait.run : this.gait.walk), 0.5, 1.9);
      } else if (name === 'Idle') {
        // Reduced motion keeps a still stance instead of breathing and looking round.
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
