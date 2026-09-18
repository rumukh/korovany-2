import * as THREE from 'three';
import { palette } from './palette';

export function skyEnvironment(renderer: THREE.WebGLRenderer, scenery: THREE.Object3D): THREE.WebGLRenderTarget {
  const sky = scenery.getObjectByName('world-sky');
  if (!sky) throw new Error('The world is missing its environment sky.');
  const scene = new THREE.Scene();
  const dome = sky.clone();
  dome.position.set(0, 0, 0);
  scene.add(dome);
  const generator = new THREE.PMREMGenerator(renderer);
  try {
    return generator.fromScene(scene, 0.04, 0.1, 300);
  } finally {
    generator.dispose();
    scene.clear();
  }
}

export function lightWorld(scene: THREE.Scene): THREE.DirectionalLight {
  scene.background = new THREE.Color(palette.fog);
  scene.fog = new THREE.Fog(palette.fog, 64, 205);
  scene.add(new THREE.HemisphereLight('#bbd4e0', '#86735a', 1.85));
  const sun = new THREE.DirectionalLight('#ffe1ad', 2.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 125 });
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.055;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  return sun;
}

export function positionSun(sun: THREE.DirectionalLight, x: number, z: number): void {
  const snappedX = Math.round(x * 8) / 8, snappedZ = Math.round(z * 8) / 8;
  sun.position.set(snappedX - 40, 38, snappedZ + 32);
  sun.target.position.set(snappedX, 0, snappedZ);
  sun.target.updateMatrixWorld();
}
