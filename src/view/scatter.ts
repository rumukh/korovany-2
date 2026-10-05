import * as THREE from 'three';

/** One drawn part of a scattered kind, shown while the camera is `near` to `far` metres away. */
export interface ScatterPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  near: number;
  far: number;
  castShadow: boolean;
  depthMaterial?: THREE.Material;
  name: string;
}

export interface ScatterKind {
  parts: ScatterPart[];
  /** Bounding radius of one instance at scale 1, for the view-cone test. */
  radius: number;
}

interface Item {
  kind: number;
  x: number;
  z: number;
  radius: number;
  matrix: Float32Array;
}

const CELL = 32;
/** Instances this close to the hero are always submitted (they may shade the hero's ground). */
const ALWAYS = 36;
/** Horizontal half-angle of the submitted view cone: the 48 degree camera at up to 21:9, plus a margin. */
const HALF_ANGLE = THREE.MathUtils.degToRad(62);

/**
 * Many static instances drawn as one instanced pool per kind and part. Each update submits only the instances inside
 * the camera's horizontal view cone (plus everything near the hero) and gives each the part for its distance band
 * (levels of detail, impostors, shadow casting near the hero only), so a kilometre of forest costs one draw per part.
 */
export class ScatterField {
  private readonly items: Item[] = [];
  private readonly grid = new Map<number, number[]>();
  private pools: THREE.InstancedMesh[][] = [];
  private readonly group = new THREE.Group();
  private readonly lastCamera = new THREE.Vector3(Infinity, 0, 0);
  private lastYaw = Infinity;
  private reach = 0;
  private scale = 1;
  private lastHero: THREE.Vector3 | undefined;
  private lastView: THREE.Camera | undefined;

  constructor(parent: THREE.Object3D, private readonly kinds: readonly ScatterKind[], name: string) {
    this.group.name = name;
    parent.add(this.group);
  }

  add(kind: number, matrix: THREE.Matrix4): void {
    if (!this.kinds[kind]) throw new Error(`Unknown scatter kind ${kind}`);
    const e = matrix.elements;
    const scale = Math.max(Math.hypot(e[0]!, e[1]!, e[2]!), Math.hypot(e[8]!, e[9]!, e[10]!), Math.hypot(e[4]!, e[5]!, e[6]!));
    const item: Item = { kind, x: e[12]!, z: e[14]!, radius: this.kinds[kind]!.radius * scale, matrix: new Float32Array(e) };
    const key = this.key(Math.floor(item.x / CELL), Math.floor(item.z / CELL));
    let cell = this.grid.get(key);
    if (!cell) this.grid.set(key, cell = []);
    cell.push(this.items.length);
    this.items.push(item);
  }

  private key(cx: number, cz: number): number {
    return (cx + 1024) * 2048 + (cz + 1024);
  }

  /** Allocates the pools once every instance is added. */
  finish(): THREE.InstancedMesh[] {
    const counts = this.kinds.map(() => 0);
    for (const item of this.items) counts[item.kind]!++;
    this.pools = this.kinds.map((kind, index) => kind.parts.map(part => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, Math.max(1, counts[index]!));
      mesh.name = part.name;
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = part.castShadow;
      mesh.receiveShadow = true;
      if (part.depthMaterial) mesh.customDepthMaterial = part.depthMaterial;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      return mesh;
    }));
    this.reach = Math.max(0, ...this.kinds.flatMap(kind => kind.parts.map(part => part.far)));
    return this.pools.flat();
  }

  /** Shortens every distance band (low quality). */
  setDistanceScale(scale: number): void {
    this.scale = scale;
    this.lastYaw = Infinity;
  }

  /**
   * Shader warm-up: every pool draws one instance at (x, y, z) until `restore`, so programs and textures of parts not yet
   * in view (other species, impostors) compile before gameplay. Returns the pools for the warm-up's visible set.
   */
  warm(x: number, y: number, z: number): { objects: THREE.Object3D[]; restore(): void } {
    const matrix = new THREE.Matrix4().makeTranslation(x, y, z);
    const pools = this.pools.flat();
    for (const pool of pools) {
      pool.instanceMatrix.array.set(matrix.elements, 0);
      pool.count = 1;
      pool.visible = true;
      pool.instanceMatrix.clearUpdateRanges();
      pool.instanceMatrix.needsUpdate = true;
    }
    return {
      objects: pools,
      restore: () => {
        // Resubmit the real view at once: the frame drawn right after the warm-up must not show the warm instances.
        this.lastCamera.set(Infinity, 0, 0);
        this.lastYaw = Infinity;
        if (this.lastHero) this.update(this.lastHero, this.lastView);
        else for (const pool of pools) { pool.count = 0; pool.visible = false; }
      },
    };
  }

  get instanceCount(): number {
    return this.items.length;
  }

  update(hero: THREE.Vector3, camera: THREE.Camera | undefined): void {
    this.lastHero = hero;
    this.lastView = camera;
    const eye = camera ? camera.position : hero;
    const forward = new THREE.Vector3(0, 0, -1);
    if (camera) camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const yaw = Math.atan2(forward.x, forward.z);
    if (this.lastCamera.distanceToSquared(eye) < 1.5 * 1.5 && Math.abs(yaw - this.lastYaw) < 0.03) return;
    this.lastCamera.copy(eye);
    this.lastYaw = yaw;
    const cosHalf = Math.cos(HALF_ANGLE);
    const reach = this.reach * this.scale;
    const counts = this.pools.map(parts => parts.map(() => 0));
    const c0 = Math.floor((eye.x - reach) / CELL), c1 = Math.floor((eye.x + reach) / CELL);
    const r0 = Math.floor((eye.z - reach) / CELL), r1 = Math.floor((eye.z + reach) / CELL);
    for (let cz = r0; cz <= r1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const cell = this.grid.get(this.key(cx, cz));
        if (!cell) continue;
        for (const index of cell) {
          const item = this.items[index]!;
          const dx = item.x - eye.x, dz = item.z - eye.z;
          const distance = Math.hypot(dx, dz);
          if (distance - item.radius > reach) continue;
          const near = Math.hypot(item.x - hero.x, item.z - hero.z) < ALWAYS + item.radius;
          if (!near && distance > item.radius) {
            const along = (dx * forward.x + dz * forward.z) / distance;
            // The cone widens by the instance's own angular radius.
            if (along < cosHalf - item.radius / distance) continue;
          }
          const parts = this.kinds[item.kind]!.parts;
          for (let p = 0; p < parts.length; p++) {
            const part = parts[p]!;
            if (distance < part.near * this.scale || distance >= part.far * this.scale) continue;
            const pool = this.pools[item.kind]![p]!;
            pool.instanceMatrix.array.set(item.matrix, counts[item.kind]![p]! * 16);
            counts[item.kind]![p]!++;
          }
        }
      }
    }
    this.pools.forEach((parts, kind) => parts.forEach((pool, part) => {
      pool.count = counts[kind]![part]!;
      pool.visible = pool.count > 0;
      if (pool.count > 0) {
        pool.instanceMatrix.clearUpdateRanges();
        pool.instanceMatrix.addUpdateRange(0, pool.count * 16);
        pool.instanceMatrix.needsUpdate = true;
      }
    }));
  }

  dispose(): void {
    for (const pool of this.pools.flat()) pool.dispose();
    this.pools = [];
    this.group.removeFromParent();
  }
}
