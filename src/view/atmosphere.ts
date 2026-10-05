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

/**
 * Version 3 grade: a cold, overcast late-autumn borderland. The mood comes from the darker ground and buildings, fog and
 * an overcast sky; the light on characters stays within 10% of v1/v2's (troop tone calibrated under that light).
 */
export const V3_GRADE = {
  fog: '#7d878a',
  fogNear: 42,
  fogFar: 196,
  zenith: '#4c5a62',
  sky: '#b6c6cf',
  ground: '#6e6450',
  hemisphere: 2.1,
  sun: '#f4e0c6',
  sunIntensity: 3.05,
  environment: 0.9,
  /** Sun offset from the hero: lower than v1/v2's for longer shadows (about 32 degrees up). */
  sunOffset: [-44, 34, 33] as const,
} as const;

export function lightWorldV3(scene: THREE.Scene): THREE.DirectionalLight {
  scene.background = new THREE.Color(V3_GRADE.fog);
  scene.fog = new THREE.Fog(V3_GRADE.fog, V3_GRADE.fogNear, V3_GRADE.fogFar);
  scene.add(new THREE.HemisphereLight(V3_GRADE.sky, V3_GRADE.ground, V3_GRADE.hemisphere));
  const sun = new THREE.DirectionalLight(V3_GRADE.sun, V3_GRADE.sunIntensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 140 });
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.055;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  return sun;
}

/** Positions a version 3 sun above the presentation ground at the hero. */
export function positionSunV3(sun: THREE.DirectionalLight, x: number, z: number, ground: number): void {
  const snappedX = Math.round(x * 8) / 8, snappedZ = Math.round(z * 8) / 8;
  const [ox, oy, oz] = V3_GRADE.sunOffset;
  sun.position.set(snappedX + ox, ground + oy, snappedZ + oz);
  sun.target.position.set(snappedX, ground, snappedZ);
  sun.target.updateMatrixWorld();
}
