import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { CAMERA_CLEARANCE, ScatterField } from '../src/view/scatter';

/** A 10 x 12 x 8 m building whose ground floor centre is the origin, as the kit cooks them. */
function field(hollow: boolean) {
  const geometry = new THREE.BoxGeometry(10, 8, 12).translate(0, 4, 0);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const material = new THREE.MeshBasicMaterial();
  const scatter = new ScatterField(new THREE.Group(), [{
    parts: [{ name: 'house', geometry, material, near: 0, far: 200, castShadow: false }],
    radius: geometry.boundingSphere!.radius,
    hollow: hollow ? geometry.boundingBox! : undefined,
  }], 'test');
  // Turned a quarter: the clearance test works in the building's own frame.
  scatter.add(0, new THREE.Matrix4().compose(new THREE.Vector3(40, 0, -20), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), new THREE.Vector3(1, 1, 1)));
  const [pool] = scatter.finish();
  const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.25, 290);
  const hero = new THREE.Vector3(40, 1, -40);
  return {
    drawn(x: number, y: number, z: number): number {
      camera.position.set(x, y, z);
      camera.lookAt(hero);
      camera.updateMatrixWorld();
      scatter.update(hero, camera);
      return pool!.count;
    },
  };
}

describe('scatter field', () => {
  test('a hollow building is not drawn while the camera is inside it or within the clearance', () => {
    const scene = field(true);
    // Rotated a quarter turn, the 12 m side runs along x: the building spans x 34-46, z -25 to -15, y 0-8.
    expect(scene.drawn(40, 9, 20)).toBe(1);
    expect(scene.drawn(40, 6, -20)).toBe(0);
    expect(scene.drawn(40, 7, -15 + CAMERA_CLEARANCE - 0.5)).toBe(0);
    expect(scene.drawn(40, 8 + CAMERA_CLEARANCE - 0.5, -20)).toBe(0);
    expect(scene.drawn(46 + CAMERA_CLEARANCE - 0.5, 6, -20)).toBe(0);
    // Above the roof or beyond the clearance it is drawn again.
    expect(scene.drawn(40, 8 + CAMERA_CLEARANCE + 0.5, -20)).toBe(1);
    expect(scene.drawn(40, 7, -15 + CAMERA_CLEARANCE + 2)).toBe(1);
    expect(scene.drawn(46 + CAMERA_CLEARANCE + 2, 6, -20)).toBe(1);
  });

  test('scenery without hollow bounds is drawn wherever the camera is', () => {
    const scene = field(false);
    expect(scene.drawn(40, 9, 20)).toBe(1);
    expect(scene.drawn(40, 6, -20)).toBe(1);
  });
});
