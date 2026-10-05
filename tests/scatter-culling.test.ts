import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { ScatterField, type ScatterKind } from '../src/view/scatter';

// W3a: dense forests put several thousand instances inside the scatter field's reach, so it rejects whole cells that no
// instance in them could pass before testing instances. That must never change what is drawn.
function kinds(): ScatterKind[] {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.computeBoundingSphere();
  const material = new THREE.MeshBasicMaterial();
  const kind = (radius: number, bands: [number, number][]): ScatterKind => ({
    radius, parts: bands.map(([near, far], index) => ({ name: `r${radius}:${index}`, geometry, material, near, far, castShadow: false })),
  });
  // A tree with a middle band, a building, a crag and undergrowth.
  return [kind(0.8, [[0, 24], [24, 58], [58, 235]]), kind(3, [[0, 95], [95, 235]]), kind(16, [[0, 150], [150, 560]]),
    kind(1.5, [[0, 12], [12, 28], [28, 55]])];
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe('scatter field whole-cell culling', () => {
  test('submits exactly the instances, parts and order the per-instance tests submit', () => {
    const next = random(20261005);
    const culled = new ScatterField(new THREE.Group(), kinds(), 'culled');
    const reference = new ScatterField(new THREE.Group(), kinds(), 'reference', { cellCulling: false });
    for (let index = 0; index < 6000; index++) {
      const kind = Math.floor(next() * 4), scale = 0.5 + next();
      const matrix = new THREE.Matrix4().compose(new THREE.Vector3(next() * 1000 - 500, 0, next() * 1000 - 500),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), next() * Math.PI * 2), new THREE.Vector3(scale, scale, scale));
      culled.add(kind, matrix);
      reference.add(kind, matrix);
    }
    const culledPools = culled.finish(), referencePools = reference.finish();
    const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.1, 2000);
    let drawn = 0;
    for (let trial = 0; trial < 300; trial++) {
      const hero = new THREE.Vector3(next() * 1000 - 500, 0, next() * 1000 - 500);
      const distance = 18 + next() * 22, pitch = 0.38 + next() * 0.75, yaw = next() * Math.PI * 2;
      camera.position.set(hero.x - Math.sin(yaw) * Math.cos(pitch) * distance, Math.sin(pitch) * distance,
        hero.z - Math.cos(yaw) * Math.cos(pitch) * distance);
      camera.lookAt(hero);
      camera.updateMatrixWorld();
      const scale = trial % 2 ? 0.72 : 1;
      culled.setDistanceScale(scale);
      reference.setDistanceScale(scale);
      culled.update(hero, camera);
      reference.update(hero, camera);
      culledPools.forEach((pool, index) => {
        const other = referencePools[index]!;
        expect(pool.count, `${pool.name} trial ${trial}`).toBe(other.count);
        expect(Array.from(pool.instanceMatrix.array.slice(0, pool.count * 16)), `${pool.name} trial ${trial}`)
          .toEqual(Array.from(other.instanceMatrix.array.slice(0, other.count * 16)));
        drawn += pool.count;
      });
    }
    expect(drawn).toBeGreaterThan(1000);
  });
});
