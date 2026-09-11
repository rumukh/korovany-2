import * as THREE from 'three';
import type { Vec2 } from '../game/types';
import { StaticBatch } from './primitives';
import type { ViewResources } from './resources';

const CELL_SIZE = 140;
const VISIBLE_DISTANCE = 190;

/** Keep instance bounds local instead of submitting an entire kilometre of trees. */
export class WorldChunks {
  private readonly cells = new Map<string, { batch: StaticBatch; group: THREE.Group; x: number; z: number }>();

  constructor(private readonly resources: ViewResources, private readonly label: string) {}

  at(point: Vec2): StaticBatch {
    const x = Math.floor(point.x / CELL_SIZE), z = Math.floor(point.z / CELL_SIZE);
    const key = `${x}:${z}`;
    let cell = this.cells.get(key);
    if (!cell) {
      const group = new THREE.Group();
      group.name = `${this.label}:${key}`;
      cell = { group, batch: new StaticBatch(this.resources), x: (x + 0.5) * CELL_SIZE, z: (z + 0.5) * CELL_SIZE };
      this.cells.set(key, cell);
    }
    return cell.batch;
  }

  finish(parent: THREE.Object3D): THREE.InstancedMesh[] {
    const meshes: THREE.InstancedMesh[] = [];
    for (const cell of this.cells.values()) {
      parent.add(cell.group);
      meshes.push(...cell.batch.finish(cell.group));
    }
    return meshes;
  }

  update(hero: Vec2): void {
    for (const cell of this.cells.values()) {
      const dx = Math.max(0, Math.abs(hero.x - cell.x) - CELL_SIZE / 2);
      const dz = Math.max(0, Math.abs(hero.z - cell.z) - CELL_SIZE / 2);
      cell.group.visible = dx * dx + dz * dz < VISIBLE_DISTANCE * VISIBLE_DISTANCE;
    }
  }
}
