import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Vec2, WorldBlueprint } from '../game/types';
import { isWalkable } from '../game/world';
import type { Terrain } from './terrain';
import type { WorldAssetLibrary } from './world-assets';

/** Authored ground speeds of the sheep's locomotion clips (cook_sheep.py recipe), metres per second. */
const WALK_SPEED = 1.0;
const RUN_SPEED = 4.2;
const SHEEP_RADIUS = 0.45;
/** The hero alarms a sheep inside this distance; it flees until it is this far away. */
const FLEE_START = 9;
const FLEE_STOP = 15;
/** Animation runs only within this distance of the camera focus; beyond HIDE the flock is not drawn. */
const ANIMATE = 60;
const HIDE = 120;
const FADE = 0.25;

type Clip = 'Idle' | 'Graze' | 'Walk' | 'Run' | 'Startle';

interface Sheep {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<Clip, THREE.AnimationAction>;
  clip: Clip;
  home: Vec2;
  x: number;
  z: number;
  heading: number;
  target: Vec2 | null;
  rest: number;
  startle: number;
  random: () => number;
}

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}

function stream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Field-local offsets (across, along) tried in order for a flock's home: the centre, then two rings inside the field. */
const HOME_OFFSETS: readonly (readonly [number, number])[] = [[0, 0],
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => [Math.sin(i * Math.PI / 4) * 0.35, Math.cos(i * Math.PI / 4) * 0.35] as const),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => [Math.sin((i + 0.5) * Math.PI / 4) * 0.7, Math.cos((i + 0.5) * Math.PI / 4) * 0.7] as const)];

/**
 * Home pastures: one per settlement, on its first stubble field with walkable ground (haystacks may stand anywhere in a
 * field, so the home is the first walkable point of the centre and two inner rings), deterministic from the seed.
 */
export function flockHomes(world: WorldBlueprint): { id: string; x: number; z: number; count: number }[] {
  const homes: { id: string; x: number; z: number; count: number }[] = [];
  const used = new Set<string>();
  for (const field of world.fields ?? []) {
    const settlement = field.id.replace(/-field-\d+$/, '');
    if (used.has(settlement) || field.crop !== 'stubble') continue;
    const c = Math.cos(field.heading), s = Math.sin(field.heading);
    const home = HOME_OFFSETS.map(([across, along]) => {
      const u = across * field.halfX, t = along * field.halfZ;
      return { x: field.x + u * c + t * s, z: field.z - u * s + t * c };
    }).find(point => isWalkable(world, point, SHEEP_RADIUS));
    if (!home) continue;
    used.add(settlement);
    const random = stream(hash(`${world.seed}:${field.id}:flock`));
    homes.push({ id: field.id, ...home, count: 5 + Math.floor(random() * 5) });
  }
  return homes;
}

/**
 * Presentation-only sheep flocks of a version 3 world: they graze and wander inside their pasture, startle and flee from
 * the hero, and walk back afterwards. Deterministic placement from the world seed; behaviour runs on cosmetic time. They
 * are never part of snapshots, saves or rules, and move with the world's own walkability so they never cross buildings.
 */
export class WorldFauna {
  private readonly sheep: Sheep[] = [];
  readonly group = new THREE.Group();

  constructor(private readonly world: WorldBlueprint, assets: WorldAssetLibrary, private readonly terrain: Terrain) {
    this.group.name = 'world-fauna';
    if (world.version !== 3) return;
    const model = assets.require('char-sheep');
    for (const home of flockHomes(world)) {
      const random = stream(hash(`${world.seed}:${home.id}:sheep`));
      for (let index = 0; index < home.count; index++) {
        let x = home.x, z = home.z;
        for (let attempt = 0; attempt < 12; attempt++) {
          const angle = random() * Math.PI * 2, distance = 1.5 + random() * 8;
          x = home.x + Math.sin(angle) * distance;
          z = home.z + Math.cos(angle) * distance;
          if (isWalkable(world, { x, z }, SHEEP_RADIUS)) break;
        }
        const root = cloneSkinned(model.scene);
        root.name = `sheep:${home.id}:${index}`;
        root.traverse(object => {
          if ((object as THREE.Mesh).isMesh) {
            object.castShadow = true;
            object.receiveShadow = true;
            object.frustumCulled = false;
          }
        });
        const mixer = new THREE.AnimationMixer(root);
        const actions = Object.fromEntries((['Idle', 'Graze', 'Walk', 'Run', 'Startle'] as const).map(name => {
          const clip = model.clips.get(name);
          if (!clip) throw new Error(`The sheep model has no ${name} clip.`);
          const action = mixer.clipAction(clip);
          if (name === 'Startle') {
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true;
          }
          return [name, action];
        })) as Record<Clip, THREE.AnimationAction>;
        const clip: Clip = random() < 0.65 ? 'Graze' : 'Idle';
        actions[clip].play();
        actions[clip].time = random() * actions[clip].getClip().duration;
        // Applies the starting pose, so a reduced-motion view (no mixer updates) still shows the sheep posed.
        mixer.update(0);
        const sheep: Sheep = { root, mixer, actions, clip, home, x, z, heading: random() * Math.PI * 2, target: null,
          rest: 2 + random() * 8, startle: 0, random };
        this.place(sheep);
        this.group.add(root);
        this.sheep.push(sheep);
      }
    }
  }

  get count(): number {
    return this.sheep.length;
  }

  /** Shader warm-up: the first sheep stands at (x, y, z), visible, until `restore`. */
  warm(x: number, y: number, z: number): { objects: THREE.Object3D[]; restore(): void } | undefined {
    const sheep = this.sheep[0];
    if (!sheep) return undefined;
    const visible = sheep.root.visible;
    const attached = sheep.root.parent === this.group;
    sheep.root.position.set(x, y, z);
    sheep.root.visible = true;
    if (!attached) this.group.add(sheep.root);
    return {
      objects: [sheep.root],
      restore: () => {
        sheep.root.visible = visible;
        if (!attached) sheep.root.removeFromParent();
        this.place(sheep);
      },
    };
  }

  private place(sheep: Sheep): void {
    sheep.root.position.set(sheep.x, this.terrain.height(sheep.x, sheep.z), sheep.z);
    sheep.root.rotation.y = sheep.heading;
  }

  private play(sheep: Sheep, clip: Clip): void {
    if (sheep.clip === clip) return;
    const next = sheep.actions[clip];
    next.reset();
    next.play();
    sheep.actions[sheep.clip].crossFadeTo(next, FADE, false);
    sheep.clip = clip;
  }

  private steer(sheep: Sheep, goal: Vec2, speed: number, dt: number): boolean {
    const dx = goal.x - sheep.x, dz = goal.z - sheep.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.4) return true;
    const wanted = Math.atan2(dx, dz);
    const turn = Math.atan2(Math.sin(wanted - sheep.heading), Math.cos(wanted - sheep.heading));
    sheep.heading += Math.sign(turn) * Math.min(Math.abs(turn), dt * (speed > 2 ? 4 : 2));
    const step = Math.min(distance, speed * dt * Math.max(0, Math.cos(turn)));
    const next = { x: sheep.x + Math.sin(sheep.heading) * step, z: sheep.z + Math.cos(sheep.heading) * step };
    if (isWalkable(this.world, next, SHEEP_RADIUS)) {
      sheep.x = next.x;
      sheep.z = next.z;
      return false;
    }
    // Blocked by a building, fence or water: give up on this goal.
    return true;
  }

  /** `focus` is the camera's ground focus; `hero` the player's position. */
  update(hero: Vec2, focus: Vec2, dt: number, reducedMotion: boolean, paused: boolean): void {
    for (const sheep of this.sheep) {
      const far = Math.hypot(sheep.x - focus.x, sheep.z - focus.z);
      const visible = far < HIDE;
      sheep.root.visible = visible;
      // A hidden sheep keeps its pose and place but leaves the scene graph: three walks every attached node's matrices
      // each frame, and a flock is about 35 nodes a sheep.
      if (visible !== (sheep.root.parent === this.group)) {
        if (visible) this.group.add(sheep.root);
        else sheep.root.removeFromParent();
      }
      if (!visible) continue;
      if (!paused && !reducedMotion) {
        const threat = Math.hypot(sheep.x - hero.x, sheep.z - hero.z);
        if (sheep.clip !== 'Run' && sheep.startle <= 0 && threat < FLEE_START) {
          sheep.startle = 0.45;
          this.play(sheep, 'Startle');
        }
        if (sheep.startle > 0) {
          sheep.startle -= dt;
          if (sheep.startle <= 0) {
            const away = Math.atan2(sheep.x - hero.x, sheep.z - hero.z) + (sheep.random() - 0.5) * 0.8;
            sheep.target = { x: sheep.x + Math.sin(away) * FLEE_STOP, z: sheep.z + Math.cos(away) * FLEE_STOP };
            this.play(sheep, 'Run');
          }
        } else if (sheep.clip === 'Run') {
          const done = sheep.target === null || this.steer(sheep, sheep.target, RUN_SPEED, dt);
          if (done || threat > FLEE_STOP) {
            sheep.target = null;
            sheep.rest = 2 + sheep.random() * 4;
            this.play(sheep, 'Idle');
          }
        } else if (sheep.clip === 'Walk') {
          if (sheep.target === null || this.steer(sheep, sheep.target, WALK_SPEED, dt)) {
            sheep.target = null;
            sheep.rest = 4 + sheep.random() * 10;
            this.play(sheep, sheep.random() < 0.7 ? 'Graze' : 'Idle');
          }
        } else {
          sheep.rest -= dt;
          if (sheep.rest <= 0) {
            // Wander within the pasture; a sheep far from home walks back.
            const homeward = Math.hypot(sheep.x - sheep.home.x, sheep.z - sheep.home.z) > 12;
            const angle = sheep.random() * Math.PI * 2, distance = homeward ? 3 : 2 + sheep.random() * 6;
            const base = homeward ? sheep.home : { x: sheep.x, z: sheep.z };
            sheep.target = { x: base.x + Math.sin(angle) * distance, z: base.z + Math.cos(angle) * distance };
            this.play(sheep, 'Walk');
          }
        }
        this.place(sheep);
      }
      if (reducedMotion || far > ANIMATE) continue;
      sheep.mixer.update(paused ? 0 : dt);
    }
  }

  dispose(): void {
    for (const sheep of this.sheep) {
      sheep.mixer.stopAllAction();
      sheep.mixer.uncacheRoot(sheep.root);
    }
    this.sheep.length = 0;
    this.group.removeFromParent();
  }
}
