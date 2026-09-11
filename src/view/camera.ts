import * as THREE from 'three';

export interface GroundPoint {
  x: number;
  z: number;
}

export interface MovementBasis {
  forward: GroundPoint;
  right: GroundPoint;
}

export class FollowCamera {
  readonly camera = new THREE.PerspectiveCamera(43, 1, 0.25, 290);
  private readonly focus = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly intersection = new THREE.Vector3();
  private readonly cursor = new THREE.Vector2();
  private yaw = 0;
  private pitch = 0.77;
  private distance = 26;
  private initialized = false;
  private reducedMotion = false;

  constructor(private readonly canvas: Pick<HTMLCanvasElement, 'getBoundingClientRect'>) {}

  resize(width: number, height: number): void {
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  update(point: GroundPoint, dt: number): void {
    this.target.set(point.x, 0.65, point.z);
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
    this.yaw = THREE.MathUtils.euclideanModulo(this.yaw + deltaYaw, Math.PI * 2);
    this.pitch = THREE.MathUtils.clamp(this.pitch + deltaPitch, 0.53, 1.13);
  }

  zoom(delta: number): void {
    if (!Number.isFinite(delta)) throw new Error('Camera zoom requires a finite delta.');
    this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(delta * 0.001), 18, 40);
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  reset(): void {
    this.initialized = false;
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
