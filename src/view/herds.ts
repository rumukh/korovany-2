import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Vec2, WorldBlueprint } from '../game/types';
import { isWalkable, nearbyObstacles, projectSegment } from '../game/world';
import type { Terrain } from './terrain';
import { FAUNA_CLIPS, type WorldAssetLibrary } from './world-assets';

export type HerdBreed = 'deer' | 'goat';

/**
 * Per breed: the model, the authored ground speeds of its Walk and Run clips (cook_quadruped.py recipes, metres per
 * second), its walking radius, the distance at which the hero alarms the herd and the distance it flees to, how far it
 * strays from home, the herd size range and the spread of the herd round its home.
 */
const BREEDS = {
  deer: { model: 'char-deer', walk: 1.4, run: 7.0, radius: 0.6, alarm: 18, safe: 45, range: 20, size: [3, 6], spread: 12, startle: 0.3, graze: 0.55 },
  goat: { model: 'char-goat', walk: 1.0, run: 4.6, radius: 0.5, alarm: 11, safe: 24, range: 14, size: [4, 7], spread: 10, startle: 0.4, graze: 0.6 },
} as const;

/** Herds per region: red deer in the forests and the woodland round them, feral goats among the crags. */
const RANGES: Readonly<Record<string, readonly (readonly [HerdBreed, number])[]>> = {
  greenmarch: [['deer', 3]], hollowvale: [['deer', 3]], heartlands: [['deer', 1]],
  crownlands: [['deer', 1], ['goat', 1]], frostspine: [['goat', 4]], ashsteppe: [['goat', 1]],
};

/** Herds keep this far beyond every place's and site's radius, and this far from road verges. */
const PEOPLE = 45;
const ROADS = 14;
/** Herds of any breed keep this far apart. */
const APART = 60;
/** Animation runs only within this distance of the camera focus; beyond HIDE a herd is not drawn. */
const ANIMATE = 60;
const HIDE = 120;
const FADE = 0.25;

type Clip = typeof FAUNA_CLIPS[number];

export interface HerdHome { id: string; breed: HerdBreed; x: number; z: number; count: number }

interface Animal {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<Clip, THREE.AnimationAction>;
  clip: Clip;
  herd: Herd;
  x: number;
  z: number;
  heading: number;
  target: Vec2 | null;
  rest: number;
  startle: number;
  random: () => number;
}

interface Herd extends HerdHome { animals: Animal[] }

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

function inField(world: WorldBlueprint, p: Vec2, margin: number): boolean {
  return (world.fields ?? []).some(field => {
    const dx = p.x - field.x, dz = p.z - field.z, c = Math.cos(field.heading), s = Math.sin(field.heading);
    return Math.abs(dx * c - dz * s) < field.halfX + margin && Math.abs(dx * s + dz * c) < field.halfZ + margin;
  });
}

/**
 * Herd homes of a version 3 world, deterministic from its seed: deer in a glade of the forests (open ground with at
 * least six trees within 20 m), goats at the foot of the crags (within 22 m of a crag's talus, in the open); every herd
 * well away from places, sites, roads and fields, and from other herds. A region with no such spot has fewer herds.
 */
export function herdHomes(world: WorldBlueprint): HerdHome[] {
  if (world.version !== 3 || !world.exploration) return [];
  const random = stream(hash(`${world.seed}:herds`));
  const places = [...world.exploration.locations, ...world.sites];
  const nodes = new Map(world.roads.nodes.map(node => [node.id, node]));
  const roads = world.roads.edges.map(edge => ({ a: nodes.get(edge.from)!, b: nodes.get(edge.to)!, half: edge.width / 2 }));
  const homes: HerdHome[] = [];
  const suitable = (p: Vec2, breed: HerdBreed): boolean => {
    // Cheapest first: distances to places, roads, herds and fields, then walkability and the obstacle grid.
    if (places.some(place => Math.hypot(place.x - p.x, place.z - p.z) - place.radius < PEOPLE)) return false;
    if (homes.some(home => Math.hypot(home.x - p.x, home.z - p.z) < APART)) return false;
    if (roads.some(road => { const q = projectSegment(p, road.a, road.b); return Math.hypot(q.x - p.x, q.z - p.z) - road.half < ROADS; })) return false;
    if (inField(world, p, 10)) return false;
    if (!isWalkable(world, p, 3)) return false;
    const near = nearbyObstacles(world, p.x - 24, p.z - 24, p.x + 24, p.z + 24);
    if (breed === 'deer') return near.filter(o => o.kind === 'tree' && Math.hypot(o.x - p.x, o.z - p.z) < 20).length >= 6;
    return near.some(o => o.model?.startsWith('rock-crag-') && Math.hypot(o.x - p.x, o.z - p.z) - o.radius < 22);
  };
  for (const region of world.exploration.regions) {
    const plan = Object.hasOwn(RANGES, region.id) ? RANGES[region.id]! : [];
    const b = region.bounds;
    for (const [breed, herds] of plan) {
      for (let herd = 0; herd < herds; herd++) {
        for (let attempt = 0; attempt < 400; attempt++) {
          const p = { x: b.minX + 24 + random() * (b.maxX - b.minX - 48), z: b.minZ + 24 + random() * (b.maxZ - b.minZ - 48) };
          if (!suitable(p, breed)) continue;
          const [low, high] = BREEDS[breed].size;
          homes.push({ id: `${breed}-${region.id}-${herd}`, breed, x: p.x, z: p.z, count: low + Math.floor(random() * (high - low + 1)) });
          break;
        }
      }
    }
  }
  return homes;
}

/**
 * Presentation-only herds of a version 3 world: red deer hinds in the forests and feral goats on the crags. They graze
 * and wander round their home, and the whole herd startles and bolts when the hero comes near (deer from farther and
 * faster), weaving round trees and rocks, then drifts back. Deterministic placement from the world seed; behaviour runs
 * on cosmetic time. They are never part of snapshots, saves or rules, and move with the world's own walkability.
 */
export class WorldHerds {
  private readonly herds: Herd[] = [];
  readonly group = new THREE.Group();

  constructor(private readonly world: WorldBlueprint, assets: WorldAssetLibrary, private readonly terrain: Terrain) {
    this.group.name = 'world-herds';
    if (world.version !== 3) return;
    for (const home of herdHomes(world)) {
      const breed = BREEDS[home.breed];
      const model = assets.require(breed.model);
      const herd: Herd = { ...home, animals: [] };
      const random = stream(hash(`${world.seed}:${home.id}:animals`));
      for (let index = 0; index < home.count; index++) {
        let x = home.x, z = home.z;
        for (let attempt = 0; attempt < 12; attempt++) {
          const angle = random() * Math.PI * 2, distance = 1.5 + random() * breed.spread;
          const candidate = { x: home.x + Math.sin(angle) * distance, z: home.z + Math.cos(angle) * distance };
          if (isWalkable(world, candidate, breed.radius)) { x = candidate.x; z = candidate.z; break; }
        }
        const root = cloneSkinned(model.scene);
        root.name = `${home.breed}:${home.id}:${index}`;
        root.traverse(object => {
          if ((object as THREE.Mesh).isMesh) {
            object.castShadow = true;
            object.receiveShadow = true;
            object.frustumCulled = false;
          }
        });
        const mixer = new THREE.AnimationMixer(root);
        const actions = Object.fromEntries(FAUNA_CLIPS.map(name => {
          const clip = model.clips.get(name);
          if (!clip) throw new Error(`The ${home.breed} model has no ${name} clip.`);
          const action = mixer.clipAction(clip);
          if (name === 'Startle') {
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true;
          }
          return [name, action];
        })) as Record<Clip, THREE.AnimationAction>;
        const clip: Clip = random() < breed.graze ? 'Graze' : 'Idle';
        actions[clip].play();
        actions[clip].time = random() * actions[clip].getClip().duration;
        // Applies the starting pose, so a reduced-motion view (no mixer updates) still shows the animals posed.
        mixer.update(0);
        const animal: Animal = { root, mixer, actions, clip, herd, x, z, heading: random() * Math.PI * 2, target: null,
          rest: 2 + random() * 8, startle: 0, random };
        this.place(animal);
        this.group.add(root);
        herd.animals.push(animal);
      }
      this.herds.push(herd);
    }
  }

  get count(): number {
    return this.herds.reduce((sum, herd) => sum + herd.animals.length, 0);
  }

  /** Shader warm-up: the first deer and the first goat stand near (x, y, z), visible, until `restore`. */
  warm(x: number, y: number, z: number): { objects: THREE.Object3D[]; restore(): void } | undefined {
    const roots = (['deer', 'goat'] as const).map(breed => this.herds.find(herd => herd.breed === breed)?.animals[0]?.root)
      .filter((root): root is THREE.Object3D => root !== undefined);
    if (!roots.length) return undefined;
    const saved = roots.map(root => ({ root, visible: root.visible, attached: root.parent === this.group, position: root.position.clone() }));
    roots.forEach((root, index) => {
      root.position.set(x + index * 2, y, z);
      root.visible = true;
      if (root.parent !== this.group) this.group.add(root);
    });
    return {
      objects: roots,
      restore: () => {
        for (const { root, visible, attached, position } of saved) {
          root.visible = visible;
          root.position.copy(position);
          if (!attached) root.removeFromParent();
        }
      },
    };
  }

  private place(animal: Animal): void {
    animal.root.position.set(animal.x, this.terrain.height(animal.x, animal.z), animal.z);
    animal.root.rotation.y = animal.heading;
  }

  private play(animal: Animal, clip: Clip): void {
    if (animal.clip === clip) return;
    const next = animal.actions[clip];
    next.reset();
    next.play();
    animal.actions[animal.clip].crossFadeTo(next, FADE, false);
    animal.clip = clip;
  }

  /** Turns toward `goal` and steps; a blocked step tries to weave round the tree or rock first. True when done or stuck. */
  private steer(animal: Animal, goal: Vec2, speed: number, dt: number): boolean {
    const breed = BREEDS[animal.herd.breed];
    const dx = goal.x - animal.x, dz = goal.z - animal.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.5) return true;
    const wanted = Math.atan2(dx, dz);
    const turn = Math.atan2(Math.sin(wanted - animal.heading), Math.cos(wanted - animal.heading));
    animal.heading += Math.sign(turn) * Math.min(Math.abs(turn), dt * (speed > 2 ? 4 : 2));
    const step = Math.min(distance, speed * dt * Math.max(0, Math.cos(turn)));
    for (const swerve of [0, 0.6, -0.6, 1.2, -1.2]) {
      const heading = animal.heading + swerve;
      const next = { x: animal.x + Math.sin(heading) * step, z: animal.z + Math.cos(heading) * step };
      if (isWalkable(this.world, next, breed.radius)) {
        animal.heading = heading;
        animal.x = next.x;
        animal.z = next.z;
        return false;
      }
    }
    return true;
  }

  /** `focus` is the camera's ground focus; `hero` the player's position. */
  update(hero: Vec2, focus: Vec2, dt: number, reducedMotion: boolean, paused: boolean): void {
    for (const herd of this.herds) {
      const breed = BREEDS[herd.breed];
      const visible = Math.hypot(herd.x - focus.x, herd.z - focus.z) < HIDE + breed.safe;
      if (!paused && !reducedMotion && visible) {
        // One alarmed animal startles the whole herd; each bolts after its own short flinch.
        const alarmed = herd.animals.some(animal => animal.clip !== 'Run' && animal.startle <= 0
          && Math.hypot(animal.x - hero.x, animal.z - hero.z) < breed.alarm);
        if (alarmed) {
          for (const animal of herd.animals) {
            if (animal.clip === 'Run' || animal.startle > 0) continue;
            animal.startle = breed.startle + animal.random() * 0.25;
            this.play(animal, 'Startle');
          }
        }
      }
      for (const animal of herd.animals) this.updateAnimal(animal, hero, focus, dt, reducedMotion, paused);
    }
  }

  private updateAnimal(animal: Animal, hero: Vec2, focus: Vec2, dt: number, reducedMotion: boolean, paused: boolean): void {
    const breed = BREEDS[animal.herd.breed];
    const far = Math.hypot(animal.x - focus.x, animal.z - focus.z);
    const visible = far < HIDE;
    animal.root.visible = visible;
    // Hidden animals leave the scene graph: three walks every attached node's matrices each frame.
    if (visible !== (animal.root.parent === this.group)) {
      if (visible) this.group.add(animal.root);
      else animal.root.removeFromParent();
    }
    if (!visible) return;
    if (!paused && !reducedMotion) {
      const threat = Math.hypot(animal.x - hero.x, animal.z - hero.z);
      if (animal.startle > 0) {
        animal.startle -= dt;
        if (animal.startle <= 0) {
          const away = Math.atan2(animal.x - hero.x, animal.z - hero.z) + (animal.random() - 0.5) * 0.7;
          animal.target = { x: animal.x + Math.sin(away) * breed.safe, z: animal.z + Math.cos(away) * breed.safe };
          this.play(animal, 'Run');
        }
      } else if (animal.clip === 'Run') {
        const done = animal.target === null || this.steer(animal, animal.target, breed.run, dt);
        if (done || threat > breed.safe) {
          animal.target = null;
          animal.rest = 2 + animal.random() * 4;
          this.play(animal, 'Idle');
        }
      } else if (animal.clip === 'Walk') {
        if (animal.target === null || this.steer(animal, animal.target, breed.walk, dt)) {
          animal.target = null;
          animal.rest = 4 + animal.random() * 10;
          this.play(animal, animal.random() < breed.graze ? 'Graze' : 'Idle');
        }
      } else {
        animal.rest -= dt;
        if (animal.rest <= 0) {
          // Wander round home; an animal that strayed or fled walks back.
          const homeward = Math.hypot(animal.x - animal.herd.x, animal.z - animal.herd.z) > breed.range;
          const angle = animal.random() * Math.PI * 2, distance = homeward ? 3 : 2 + animal.random() * 6;
          const base = homeward ? animal.herd : { x: animal.x, z: animal.z };
          animal.target = { x: base.x + Math.sin(angle) * distance, z: base.z + Math.cos(angle) * distance };
          this.play(animal, 'Walk');
        }
      }
      this.place(animal);
    }
    if (reducedMotion || far > ANIMATE) return;
    animal.mixer.update(paused ? 0 : dt);
  }

  dispose(): void {
    for (const animal of this.herds.flatMap(herd => herd.animals)) {
      animal.mixer.stopAllAction();
      animal.mixer.uncacheRoot(animal.root);
    }
    this.herds.length = 0;
    this.group.removeFromParent();
  }
}
