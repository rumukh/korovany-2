import * as THREE from 'three';
import type { GameSnapshot } from '../game/types';
import { palette } from './palette';
import { shapeGeometry } from './primitives';
import { seededRandom, ViewResources } from './resources';

class InstancePool {
  mesh: THREE.InstancedMesh;
  private count = 0;
  private readonly transform = new THREE.Object3D();
  private readonly color = new THREE.Color();

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private capacity: number,
    private readonly shadow = false,
    private readonly depthMaterial?: THREE.Material,
  ) {
    this.mesh = this.createMesh();
  }

  private createMesh(): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, this.capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = this.shadow;
    mesh.customDepthMaterial = this.depthMaterial;
    mesh.count = 0;
    this.parent.add(mesh);
    return mesh;
  }

  begin(required = 0): void {
    if (required > this.capacity) {
      this.mesh.removeFromParent();
      this.mesh.dispose();
      this.capacity = Math.max(required, this.capacity * 2);
      this.mesh = this.createMesh();
    }
    this.count = 0;
  }

  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, rx = 0, ry = 0, rz = 0): void {
    if (this.count >= this.capacity) throw new Error('Presentation instance pool capacity exceeded.');
    this.transform.position.set(x, y, z);
    this.transform.scale.set(sx, sy, sz);
    this.transform.rotation.set(rx, ry, rz);
    this.transform.updateMatrix();
    this.mesh.setMatrixAt(this.count, this.transform.matrix);
    this.mesh.setColorAt(this.count, this.color.set(color));
    this.count += 1;
  }

  finish(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}

interface Burst {
  x: number;
  z: number;
  age: number;
  color: string;
  seed: number;
}

export class WorldEffects {
  private readonly rings: InstancePool;
  private readonly arcs: InstancePool;
  private readonly sparks: InstancePool;
  private readonly arrows: InstancePool;
  private readonly arrowheads: InstancePool;
  private readonly coins: InstancePool;
  private readonly packages: InstancePool;
  private readonly crosses: InstancePool;
  private readonly motes: InstancePool;
  private readonly all: InstancePool[];
  private readonly bursts: Burst[] = [];
  private lastEvent = -1;
  private lastTick = -1;
  private trailClock = 0;
  private low = false;

  constructor(resources: ViewResources, parent: THREE.Object3D) {
    const unlit = resources.material('#ffffff', { unlit: true, opacity: 0.73, depthWrite: false, side: THREE.DoubleSide });
    const solid = resources.material('#ffffff');
    this.rings = new InstancePool(parent, shapeGeometry(resources, 'ring'), unlit, 64);
    this.arcs = new InstancePool(parent,
      resources.geometry('effect-arc', () => new THREE.RingGeometry(0.34, 0.5, 24, 1, -Math.PI / 3, Math.PI * 2 / 3).rotateX(-Math.PI / 2).rotateY(-Math.PI / 2)),
      unlit, 64);
    this.sparks = new InstancePool(parent, shapeGeometry(resources, 'sphere'), unlit, 512);
    this.arrows = new InstancePool(parent, shapeGeometry(resources, 'box'), solid, 64, true, resources.depthMaterial());
    this.arrowheads = new InstancePool(parent, shapeGeometry(resources, 'cone'), solid, 64);
    this.coins = new InstancePool(parent, shapeGeometry(resources, 'cylinder'), solid, 64, true, resources.depthMaterial());
    this.packages = new InstancePool(parent, shapeGeometry(resources, 'box'), solid, 64, true, resources.depthMaterial());
    this.crosses = new InstancePool(parent, shapeGeometry(resources, 'box'), unlit, 64);
    this.motes = new InstancePool(parent, shapeGeometry(resources, 'sphere'), unlit, 44);
    this.all = [this.rings, this.arcs, this.sparks, this.arrows, this.arrowheads, this.coins, this.packages, this.crosses, this.motes];
  }

  setQuality(low: boolean): void {
    this.low = low;
  }

  update(snapshot: Readonly<GameSnapshot>, dt: number, cosmeticTime: number, reducedMotion: boolean): void {
    const effects = snapshot.effects.slice(-64);
    this.rings.begin(effects.length + 2);
    this.arcs.begin(effects.length);
    this.sparks.begin(512);
    this.arrows.begin(snapshot.projectiles.length);
    this.arrowheads.begin(snapshot.projectiles.length);
    this.coins.begin(snapshot.pickups.length);
    this.packages.begin(snapshot.pickups.length * 2);
    this.crosses.begin(snapshot.pickups.length * 2);
    this.motes.begin();

    if (this.lastEvent < 0) {
      this.lastEvent = snapshot.events.reduce((maximum, event) => Math.max(maximum, event.id), 0);
    } else {
      for (const event of snapshot.events) {
        if (event.id <= this.lastEvent) continue;
        this.lastEvent = event.id;
        if (event.kind === 'hurt' || event.kind === 'kill' || event.kind === 'pickup' || event.kind === 'delivery' || event.kind === 'capture') {
          this.bursts.push({
            x: event.x, z: event.z, age: 0, seed: event.id,
            color: event.kind === 'pickup' || event.kind === 'delivery' ? palette.brass
              : event.kind === 'capture' ? palette.teal : palette.parchment,
          });
        }
      }
    }
    this.trailClock += dt;
    if (snapshot.tick !== this.lastTick && snapshot.player.state === 'dodge' && !reducedMotion && this.trailClock > 0.045) {
      this.trailClock = 0;
      this.bursts.push({ x: snapshot.player.x, z: snapshot.player.z, age: 0.12, color: palette.teal, seed: snapshot.tick });
    }
    while (this.bursts.length > (this.low ? 12 : 32)) this.bursts.shift();
    for (let index = this.bursts.length - 1; index >= 0; index -= 1) {
      const burst = this.bursts[index];
      if (!burst) continue;
      burst.age += dt;
      if (burst.age > 0.55) {
        this.bursts.splice(index, 1);
        continue;
      }
      const random = seededRandom(burst.seed);
      const count = reducedMotion ? 3 : this.low ? 4 : 7;
      for (let spark = 0; spark < count; spark += 1) {
        const angle = random() * Math.PI * 2;
        const velocity = 0.8 + random() * 1.7;
        const distance = burst.age * velocity;
        const size = (1 - burst.age / 0.55) * 0.16;
        this.sparks.add(burst.x + Math.sin(angle) * distance, 0.4 + burst.age * 2.2 - burst.age * burst.age * 3.8,
          burst.z + Math.cos(angle) * distance, size, size * 1.8, size, burst.color, 0, angle, angle);
      }
    }
    for (const effect of effects) {
      const progress = THREE.MathUtils.clamp(1 - effect.remaining / Math.max(effect.duration, 0.001), 0, 1);
      const radius = effect.radius * 2 * (effect.kind === 'shield' ? 1 : 0.65 + progress * 0.35);
      const color = effect.kind === 'hit' || effect.kind === 'explosion' ? palette.ember
        : effect.kind === 'heal' || effect.kind === 'shield' ? palette.teal : palette.brass;
      if (effect.kind === 'slash' || effect.kind === 'cleave') {
        this.arcs.add(effect.x, 0.36 + (1 - progress) * 0.35, effect.z, radius, 1, radius, color, 0, effect.heading, 0);
      } else {
        this.rings.add(effect.x, 0.09, effect.z, radius, 1, radius, color);
      }
    }
    if (snapshot.player.abilityDuration > 0) {
      this.rings.add(snapshot.player.x, 0.11, snapshot.player.z, 2.2, 1, 2.2, palette.teal);
    }

    for (const projectile of snapshot.projectiles) {
      const siege = projectile.kind === 'siege';
      const length = siege ? 0.38 : 0.87;
      const color = projectile.owner === 'player' ? palette.parchment : palette.ember;
      this.arrows.add(projectile.x, 1.0, projectile.z, siege ? 0.3 : 0.045, siege ? 0.3 : 0.045, length,
        siege ? palette.iron : palette.timberLight, 0, projectile.heading, 0);
      this.arrowheads.add(projectile.x + Math.sin(projectile.heading) * length * 0.53, 1.0,
        projectile.z + Math.cos(projectile.heading) * length * 0.53, 0.14, 0.23, 0.14, color, Math.PI / 2, 0, -projectile.heading);
    }
    for (const pickup of snapshot.pickups) {
      const bob = reducedMotion ? 0 : Math.sin(cosmeticTime * 2.5 + pickup.x) * 0.08;
      const turn = reducedMotion ? Math.PI / 6 : cosmeticTime * 1.3;
      if (pickup.kind === 'coin') {
        this.coins.add(pickup.x, 0.4 + bob, pickup.z, 0.37, 0.075, 0.37, palette.brass, Math.PI / 2, turn, 0);
      } else if (pickup.kind === 'supply') {
        this.packages.add(pickup.x, 0.23 + bob, pickup.z, 0.48, 0.38, 0.42, palette.timberLight, 0, 0.25, 0);
        this.packages.add(pickup.x, 0.24 + bob, pickup.z, 0.09, 0.4, 0.44, palette.bark, 0, 0.25, 0);
      } else {
        this.packages.add(pickup.x, 0.26 + bob, pickup.z, 0.35, 0.43, 0.3, palette.parchment);
        this.crosses.add(pickup.x, 0.31 + bob, pickup.z + 0.16, 0.07, 0.23, 0.025, palette.ember);
        this.crosses.add(pickup.x, 0.31 + bob, pickup.z + 0.16, 0.22, 0.07, 0.025, palette.ember);
      }
    }

    if (!reducedMotion && !this.low) {
      for (let index = 0; index < 44; index += 1) {
        const x = snapshot.player.x + Math.sin(index * 127.1) * 14 + Math.sin(cosmeticTime * 0.14 + index) * 0.7;
        const z = snapshot.player.z + Math.sin(index * 311.7) * 14 + Math.cos(cosmeticTime * 0.1 + index) * 0.6;
        const y = 0.6 + THREE.MathUtils.euclideanModulo(index * 0.77 + cosmeticTime * 0.09, 3.8);
        this.motes.add(x, y, z, 0.032, 0.032, 0.032, palette.sun);
      }
    }
    for (const pool of this.all) pool.finish();
    this.lastTick = snapshot.tick;
  }

  dispose(): void {
    for (const pool of this.all) pool.dispose();
    this.bursts.length = 0;
  }
}
