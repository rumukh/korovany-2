import * as THREE from 'three';

export interface GroundPoint {
  x: number;
  z: number;
}

export interface MovementBasis {
  forward: GroundPoint;
  right: GroundPoint;
}

/** Battle framing: over the hero's shoulder towards the foe it faces, a little higher and closer than on the road. */
export const BATTLE_FRAMING = { shoulder: 0.42, pitch: 0.62, distance: 21 } as const;

export class FollowCamera {
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.25, 290);
  private readonly focus = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly intersection = new THREE.Vector3();
  private readonly cursor = new THREE.Vector2();
  private yaw = Math.PI;
  private pitch = 0.48;
  private distance = 26;
  private initialized = false;
  private reducedMotion = false;
  /** A framing the camera eases towards; the player's own orbit or zoom takes over from it. */
  private goal: { yaw: number; pitch: number; distance: number } | null = null;
  /** The pitch and distance the player had before a battle, restored after it. */
  private resume: { pitch: number; distance: number } | null = null;

  constructor(private readonly canvas: Pick<HTMLCanvasElement, 'getBoundingClientRect'>) {}

  resize(width: number, height: number): void {
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  update(point: GroundPoint, dt: number, ground = 0): void {
    this.target.set(point.x, 0.65 + ground, point.z);
    // Pointer aim intersects the hero's own ground height (version 3 relief; 0 on flat worlds).
    this.ground.constant = -ground;
    if (this.goal) this.approach(this.goal, this.reducedMotion || !this.initialized ? 1 : 1 - Math.exp(-Math.max(0, dt) * 4.5));
    if (!this.initialized || this.focus.distanceToSquared(this.target) > 625 || this.reducedMotion) {
      this.focus.copy(this.target);
      this.initialized = true;
    } else {
      this.focus.lerp(this.target, 1 - Math.exp(-Math.max(0, dt) * 8));
    }
    const horizontal = Math.cos(this.pitch) * this.distance;
    this.camera.position.set(
      this.focus.x + Math.sin(this.yaw) * horizontal,
      this.focus.y + Math.sin(this.pitch) * this.distance,
      this.focus.z + Math.cos(this.yaw) * horizontal,
    );
    this.camera.lookAt(this.focus);
    this.camera.updateMatrixWorld();
  }

  orbit(deltaYaw: number, deltaPitch = 0): void {
    if (!Number.isFinite(deltaYaw) || !Number.isFinite(deltaPitch)) throw new Error('Camera orbit requires finite deltas.');
    this.goal = null;
    this.yaw = THREE.MathUtils.euclideanModulo(this.yaw + deltaYaw, Math.PI * 2);
    this.pitch = THREE.MathUtils.clamp(this.pitch + deltaPitch, 0.38, 1.13);
  }

  zoom(delta: number): void {
    if (!Number.isFinite(delta)) throw new Error('Camera zoom requires a finite delta.');
    this.goal = null;
    this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(delta * 0.001), 18, 40);
  }

  /** A battle begins with the hero facing `heading`: the camera eases round behind its shoulder, looking at the foe. */
  frameBattle(heading: number): void {
    if (!Number.isFinite(heading)) throw new Error('Battle framing requires a finite heading.');
    this.resume ??= { pitch: this.pitch, distance: this.distance };
    this.goal = {
      yaw: THREE.MathUtils.euclideanModulo(heading + Math.PI + BATTLE_FRAMING.shoulder, Math.PI * 2),
      pitch: BATTLE_FRAMING.pitch, distance: BATTLE_FRAMING.distance,
    };
  }

  /** The battle is over: the pitch and distance from before it come back; the camera keeps facing the same way. */
  endBattle(): void {
    if (!this.resume) return;
    this.goal = { yaw: this.yaw, pitch: this.resume.pitch, distance: this.resume.distance };
    this.resume = null;
  }

  /** Eases towards a framing by `share` of the way (1 arrives), along the shorter turn. */
  private approach(goal: { yaw: number; pitch: number; distance: number }, share: number): void {
    const turn = THREE.MathUtils.euclideanModulo(goal.yaw - this.yaw + Math.PI, Math.PI * 2) - Math.PI;
    if (share >= 1 || (Math.abs(turn) < 1e-3 && Math.abs(goal.pitch - this.pitch) < 1e-3 && Math.abs(goal.distance - this.distance) < 1e-2)) {
      this.yaw = goal.yaw;
      this.pitch = goal.pitch;
      this.distance = goal.distance;
      this.goal = null;
      return;
    }
    this.yaw = THREE.MathUtils.euclideanModulo(this.yaw + turn * share, Math.PI * 2);
    this.pitch += (goal.pitch - this.pitch) * share;
    this.distance += (goal.distance - this.distance) * share;
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  reset(): void {
    this.initialized = false;
    this.goal = null;
    this.resume = null;
  }

  getMoveBasis(): MovementBasis {
    return {
      forward: { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) },
      right: { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) },
    };
  }

  screenToWorld(clientX: number, clientY: number): GroundPoint | null {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.cursor.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    this.raycaster.setFromCamera(this.cursor, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.ground, this.intersection);
    return hit ? { x: hit.x, z: hit.z } : null;
  }
}
