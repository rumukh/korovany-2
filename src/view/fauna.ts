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

/** Crow flight: authored clip speeds are not ground speeds, so these only pace the view's movement. */
const CROW_RADIUS = 0.2;
/** The hero puts a flock up inside this distance of any of its crows; it comes back when the hero is this far. */
const CROW_ALARM = 10;
const CROW_RETURN = 34;
const CROW_SPEED = 7;
const CROW_CRUISE = 22;
/** A crow that has flown this far from home is out of sight and waits there to come back. */
const CROW_AWAY = 70;

type CrowState = 'ground' | 'takeoff' | 'flying' | 'away' | 'landing';

interface Crow {
  perched: THREE.Object3D;
  flight: THREE.Object3D;
  perchedMixer: THREE.AnimationMixer;
  flightMixer: THREE.AnimationMixer;
  perch: { Perch: THREE.AnimationAction; Peck: THREE.AnimationAction };
  wing: { Fly: THREE.AnimationAction; Glide: THREE.AnimationAction; TakeOff: THREE.AnimationAction };
  flock: CrowFlock;
  spot: Vec2;
  x: number;
  y: number;
  z: number;
  heading: number;
  state: CrowState;
  timer: number;
  random: () => number;
}

interface CrowFlock { id: string; x: number; z: number; count: number; crows: Crow[]; alarmed: boolean; quiet: number }

/**
 * Crow flocks: on one more stubble or furrow field per settlement than the sheep use, in each chapel's graveyard and at
 * each roadside gibbet; 3-6 crows each, deterministic from the seed.
 */
export function crowHomes(world: WorldBlueprint): { id: string; x: number; z: number; count: number }[] {
  const homes: { id: string; x: number; z: number; count: number }[] = [];
  const sheep = new Set(flockHomes(world).map(home => home.id));
  const used = new Set<string>();
  const add = (id: string, x: number, z: number) => {
    const random = stream(hash(`${world.seed}:${id}:crows`));
    homes.push({ id, x, z, count: 3 + Math.floor(random() * 4) });
  };
  for (const field of world.fields ?? []) {
    const settlement = field.id.replace(/-field-\d+$/, '');
    if (used.has(settlement) || sheep.has(field.id) || !isWalkable(world, field, CROW_RADIUS)) continue;
    used.add(settlement);
    add(field.id, field.x, field.z);
  }
  for (const o of world.obstacles) {
    if (o.model === 'prop-gibbet') add(o.id, o.x + 2.6, o.z + 1.4);
    else if (o.model === 'prop-troll-gibbet' || o.model === 'prop-giant-skull' || o.model === 'prop-giant-ribs') {
      // Crows pick at the remains of giant beasts, just off their local +X side ((cos h, -sin h)).
      const heading = o.shape?.heading ?? 0, reach = (o.shape?.halfX ?? o.radius) + 1.6;
      add(o.id, o.x + Math.cos(heading) * reach, o.z - Math.sin(heading) * reach);
    } else if ((o.model === 'kit-chapel' || o.model === 'kit-chapel-fen') && o.shape) {
      // Among the graves behind the chapel (its back is local -X: (-cos h, sin h)).
      const back = o.shape.halfX + 5;
      add(o.id, o.x - Math.cos(o.shape.heading) * back, o.z + Math.sin(o.shape.heading) * back);
    } else if (o.id === 'name-well-grave-0') add(o.id, o.x + 2, o.z);
  }
  return homes;
}

/**
 * Presentation-only sheep flocks and crows of a version 3 world. Sheep graze and wander inside their pasture, startle
 * and flee from the hero, and walk back afterwards. Crows peck and look about on fields, in graveyards and under
 * gibbets; when the hero comes close the flock takes off, flies away out of sight and comes back down once the hero has
 * gone. Deterministic placement from the world seed; behaviour runs on cosmetic time. They are never part of snapshots,
 * saves or rules, and walking animals move with the world's own walkability so they never cross buildings.
 */
export class WorldFauna {
  private readonly sheep: Sheep[] = [];
  private readonly flocks: CrowFlock[] = [];
  readonly group = new THREE.Group();

  constructor(private readonly world: WorldBlueprint, assets: WorldAssetLibrary, private readonly terrain: Terrain) {
    this.group.name = 'world-fauna';
    if (world.version !== 3) return;
    this.addCrows(assets);
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

  get crowCount(): number {
    return this.flocks.reduce((sum, flock) => sum + flock.crows.length, 0);
  }

  private addCrows(assets: WorldAssetLibrary): void {
    const homes = crowHomes(this.world);
    if (!homes.length) return;
    const perchedModel = assets.require('char-crow'), flightModel = assets.require('char-crow-flight');
    const clip = (model: typeof perchedModel, name: string): THREE.AnimationClip => {
      const found = model.clips.get(name);
      if (!found) throw new Error(`The crow model has no ${name} clip.`);
      return found;
    };
    for (const home of homes) {
      const flock: CrowFlock = { ...home, crows: [], alarmed: false, quiet: 0 };
      const random = stream(hash(`${this.world.seed}:${home.id}:crow`));
      for (let index = 0; index < home.count; index++) {
        let spot: Vec2 = { x: home.x, z: home.z };
        for (let attempt = 0; attempt < 12; attempt++) {
          const angle = random() * Math.PI * 2, distance = 0.8 + random() * 3.5;
          const candidate = { x: home.x + Math.sin(angle) * distance, z: home.z + Math.cos(angle) * distance };
          if (isWalkable(this.world, candidate, CROW_RADIUS)) { spot = candidate; break; }
        }
        const perched = cloneSkinned(perchedModel.scene), flight = cloneSkinned(flightModel.scene);
        perched.name = `crow:${home.id}:${index}:perched`;
        flight.name = `crow:${home.id}:${index}:flight`;
        for (const root of [perched, flight]) {
          root.traverse(object => {
            if ((object as THREE.Mesh).isMesh) {
              object.castShadow = true;
              object.receiveShadow = true;
              object.frustumCulled = false;
            }
          });
        }
        const perchedMixer = new THREE.AnimationMixer(perched), flightMixer = new THREE.AnimationMixer(flight);
        const perch = { Perch: perchedMixer.clipAction(clip(perchedModel, 'Perch')), Peck: perchedMixer.clipAction(clip(perchedModel, 'Peck')) };
        const wing = { Fly: flightMixer.clipAction(clip(flightModel, 'Fly')), Glide: flightMixer.clipAction(clip(flightModel, 'Glide')),
          TakeOff: flightMixer.clipAction(clip(flightModel, 'TakeOff')) };
        wing.TakeOff.setLoop(THREE.LoopOnce, 1);
        wing.TakeOff.clampWhenFinished = true;
        const first = random() < 0.5 ? perch.Peck : perch.Perch;
        first.play();
        first.time = random() * first.getClip().duration;
        wing.Fly.play();
        // Starting poses, so a reduced-motion view (no mixer updates) still shows posed birds.
        perchedMixer.update(0);
        flightMixer.update(0);
        const crow: Crow = { perched, flight, perchedMixer, flightMixer, perch, wing, flock, spot, x: spot.x, y: 0, z: spot.z,
          heading: random() * Math.PI * 2, state: 'ground', timer: 1 + random() * 4, random };
        this.placeCrow(crow);
        this.group.add(perched);
        flock.crows.push(crow);
      }
      this.flocks.push(flock);
    }
  }

  private placeCrow(crow: Crow, root: THREE.Object3D = crow.perched): void {
    root.position.set(crow.x, this.terrain.height(crow.x, crow.z) + crow.y, crow.z);
    root.rotation.y = crow.heading;
  }

  /** Shows the perched or the flying model (only one is in the scene graph), or neither. */
  private showCrow(crow: Crow, which: 'perched' | 'flight' | null): void {
    for (const [root, name] of [[crow.perched, 'perched'], [crow.flight, 'flight']] as const) {
      const wanted = which === name;
      if (wanted && root.parent !== this.group) this.group.add(root);
      if (!wanted && root.parent) root.removeFromParent();
      root.visible = wanted;
    }
  }

  private perchClip(crow: Crow, name: 'Perch' | 'Peck'): void {
    const next = crow.perch[name], current = name === 'Perch' ? crow.perch.Peck : crow.perch.Perch;
    if (next.isRunning() && next.getEffectiveWeight() > 0.99) return;
    next.reset();
    next.play();
    current.crossFadeTo(next, 0.2, false);
  }

  private wingClip(crow: Crow, name: 'Fly' | 'Glide' | 'TakeOff'): void {
    const next = crow.wing[name];
    if (next.isRunning() && next.getEffectiveWeight() > 0.99) return;
    next.reset();
    next.play();
    for (const other of Object.values(crow.wing)) if (other !== next && other.isRunning()) other.crossFadeTo(next, 0.15, false);
  }

  private updateCrows(hero: Vec2, focus: Vec2, dt: number, reducedMotion: boolean, paused: boolean): void {
    for (const flock of this.flocks) {
      if (!paused && !reducedMotion) {
        const startled = flock.crows.some(crow => crow.state === 'ground' && Math.hypot(crow.x - hero.x, crow.z - hero.z) < CROW_ALARM);
        if (startled && !flock.alarmed) {
          flock.alarmed = true;
          flock.quiet = 0;
          for (const crow of flock.crows) {
            if (crow.state !== 'ground' && crow.state !== 'landing') continue;
            // A ragged lift-off: each bird goes within half a second, away from the hero.
            crow.state = 'takeoff';
            crow.timer = -crow.random() * 0.45;
          }
        }
        if (flock.alarmed && flock.crows.every(crow => crow.state === 'away')) {
          flock.quiet = Math.hypot(flock.x - hero.x, flock.z - hero.z) > CROW_RETURN ? flock.quiet + dt : 0;
          if (flock.quiet > 5) {
            flock.alarmed = false;
            for (const crow of flock.crows) {
              const angle = crow.random() * Math.PI * 2, distance = 38 + crow.random() * 10;
              crow.x = crow.spot.x + Math.sin(angle) * distance;
              crow.z = crow.spot.z + Math.cos(angle) * distance;
              crow.y = CROW_CRUISE - 6 + crow.random() * 4;
              crow.state = 'landing';
              this.wingClip(crow, 'Glide');
            }
          }
        }
      }
      for (const crow of flock.crows) this.updateCrow(crow, hero, focus, dt, reducedMotion, paused);
    }
  }

  private updateCrow(crow: Crow, hero: Vec2, focus: Vec2, dt: number, reducedMotion: boolean, paused: boolean): void {
    if (!paused && !reducedMotion) {
      switch (crow.state) {
        case 'ground':
          crow.timer -= dt;
          if (crow.timer <= 0) {
            this.perchClip(crow, crow.random() < 0.55 ? 'Peck' : 'Perch');
            crow.heading += (crow.random() - 0.5) * 1.2;
            crow.timer = 2 + crow.random() * 4;
          }
          break;
        case 'takeoff':
          crow.timer += dt;
          if (crow.timer < 0) break;
          if (crow.y === 0) {
            crow.heading = Math.atan2(crow.x - hero.x, crow.z - hero.z) + (crow.random() - 0.5) * 1.2;
            this.wingClip(crow, 'TakeOff');
            crow.y = 0.01;
          }
          crow.x += Math.sin(crow.heading) * 2.5 * dt;
          crow.z += Math.cos(crow.heading) * 2.5 * dt;
          crow.y += 3 * dt;
          if (crow.timer > crow.wing.TakeOff.getClip().duration) {
            crow.state = 'flying';
            this.wingClip(crow, 'Fly');
          }
          break;
        case 'flying': {
          crow.heading += (crow.random() - 0.5) * 0.6 * dt;
          crow.x += Math.sin(crow.heading) * CROW_SPEED * dt;
          crow.z += Math.cos(crow.heading) * CROW_SPEED * dt;
          crow.y += Math.max(-1, Math.min(3, (CROW_CRUISE - crow.y) * 0.6)) * dt;
          if (Math.hypot(crow.x - crow.spot.x, crow.z - crow.spot.z) > CROW_AWAY) {
            crow.state = 'away';
            crow.y = 0;
          }
          break;
        }
        case 'landing': {
          const dx = crow.spot.x - crow.x, dz = crow.spot.z - crow.z, distance = Math.hypot(dx, dz);
          const target = Math.min(CROW_CRUISE, distance * 0.4);
          crow.heading = Math.atan2(dx, dz);
          const step = Math.min(distance, Math.min(CROW_SPEED, distance * 0.9 + 1.2) * dt);
          if (distance > 1e-3) {
            crow.x += dx / distance * step;
            crow.z += dz / distance * step;
          }
          crow.y = Math.max(0, crow.y + Math.max(-3, Math.min(1, (target - crow.y) * 1.5)) * dt);
          // A few flaps to brake just before touching down.
          if (distance < 3.5) this.wingClip(crow, 'Fly');
          if (distance < 0.2 && crow.y < 0.15) {
            crow.x = crow.spot.x;
            crow.z = crow.spot.z;
            crow.y = 0;
            crow.state = 'ground';
            crow.timer = 1 + crow.random() * 3;
            this.perchClip(crow, 'Perch');
          }
          break;
        }
        case 'away':
          break;
      }
    }
    const far = Math.hypot(crow.x - focus.x, crow.z - focus.z);
    const visible = crow.state !== 'away' && far < HIDE;
    const airborne = crow.state === 'flying' || crow.state === 'landing' || (crow.state === 'takeoff' && crow.y > 0);
    this.showCrow(crow, visible ? (airborne ? 'flight' : 'perched') : null);
    if (!visible) return;
    this.placeCrow(crow, airborne ? crow.flight : crow.perched);
    if (reducedMotion || far > ANIMATE) return;
    (airborne ? crow.flightMixer : crow.perchedMixer).update(paused ? 0 : dt);
  }

  /** Shader warm-up: the first sheep and the first crow, perched and flying, stand near (x, y, z), visible, until `restore`. */
  warm(x: number, y: number, z: number): { objects: THREE.Object3D[]; restore(): void } | undefined {
    const crow = this.flocks[0]?.crows[0];
    const roots = [this.sheep[0]?.root, crow?.perched, crow?.flight].filter((root): root is THREE.Object3D => root !== undefined);
    if (!roots.length) return undefined;
    const saved = roots.map(root => ({ root, visible: root.visible, attached: root.parent === this.group, position: root.position.clone() }));
    roots.forEach((root, index) => {
      root.position.set(x + index * 1.5, y + (root === crow?.flight ? 1.5 : 0), z);
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
        if (this.sheep[0]) this.place(this.sheep[0]);
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
    this.updateCrows(hero, focus, dt, reducedMotion, paused);
  }

  dispose(): void {
    for (const sheep of this.sheep) {
      sheep.mixer.stopAllAction();
      sheep.mixer.uncacheRoot(sheep.root);
    }
    this.sheep.length = 0;
    for (const crow of this.flocks.flatMap(flock => flock.crows)) {
      for (const [mixer, root] of [[crow.perchedMixer, crow.perched], [crow.flightMixer, crow.flight]] as const) {
        mixer.stopAllAction();
        mixer.uncacheRoot(root);
      }
    }
    this.flocks.length = 0;
    this.group.removeFromParent();
  }
}
