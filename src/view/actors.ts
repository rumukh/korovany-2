import * as THREE from 'three';
import { factionColors, palette, type ViewFaction } from './palette';
import { beam, joint, part, shapeGeometry } from './primitives';
import { ViewResources } from './resources';

export type ActorLook = 'hero' | 'guard' | 'archer' | 'brute' | 'boss';

export interface ActorPose {
  moving: number;
  time: number;
  attacking: number;
  winding: number;
  dodging: boolean;
  dead: boolean;
  reducedMotion: boolean;
}

export interface ActorModel {
  root: THREE.Group;
  height: number;
  animate(pose: ActorPose): void;
}

export function createActor(resources: ViewResources, look: ActorLook, faction: ViewFaction, friendly = false): ActorModel {
  const root = new THREE.Group();
  const large = look === 'brute' || look === 'boss';
  const hero = look === 'hero';
  const scale = look === 'boss' ? 1.7 : large ? 1.2 : 1;
  const coat = hero || friendly ? factionColors[faction] : look === 'boss' ? palette.villain : palette.hostile;
  const body = joint(root, [0, 0, 0]);
  body.scale.setScalar(scale);
  const hips = joint(body, [0, 0.75, 0]);
  const torso = joint(body, [0, 1.1, 0]);
  const armored = large || look === 'guard' || (hero && faction !== 'elf');
  const chest = part(resources, torso, 'box', armored ? palette.steel : coat, [0, 0.12, 0], [large ? 0.76 : 0.6, 0.65, 0.4]);
  chest.rotation.z = 0.025;
  part(resources, torso, 'box', coat, [0, 0.03, 0.221], [0.28, 0.63, 0.025]);
  part(resources, torso, 'box', palette.iron, [0, -0.19, 0], [0.65, 0.12, 0.44]);
  part(resources, torso, 'box', palette.brass, [0, -0.19, 0.235], [0.13, 0.105, 0.03]);
  const head = joint(torso, [0, 0.65, 0]);
  part(resources, head, 'sphere', palette.skin, [0, 0, 0.025], [0.45, 0.49, 0.43]);
  part(resources, head, 'box', palette.ink, [0, 0.035, 0.21], [0.29, 0.05, 0.025]);
  part(resources, head, 'box', palette.skin, [0, -0.025, 0.24], [0.085, 0.1, 0.065]);

  const cape = joint(torso, [0, 0.33, -0.2]);
  const capeMesh = part(resources, cape, 'cloth', coat, [0, -0.52, -0.12], [0.77, 1.12, 1], [-0.16, 0, 0]);
  if (hero) {
    part(resources, cape, 'cloth', palette.brass, [0, -0.98, -0.2], [0.71, 0.11, 1], [-0.16, 0, 0]);
    const ring = new THREE.Mesh(shapeGeometry(resources, 'ring'), resources.material(palette.parchment, { unlit: true }));
    ring.scale.setScalar(1.65);
    ring.position.y = 0.065;
    root.add(ring);
    const inner = new THREE.Mesh(shapeGeometry(resources, 'ring'), resources.material(palette.brass, { unlit: true }));
    inner.scale.setScalar(1.46);
    inner.position.y = 0.068;
    root.add(inner);
  }

  if ((hero && faction === 'elf') || look === 'archer') {
    part(resources, head, 'cone', coat, [0, 0.29, -0.035], [0.63, 0.48, 0.55], [-0.3, 0, -0.17]);
    part(resources, head, 'box', palette.leafDark, [0, 0.11, 0.08], [0.61, 0.06, 0.53], [0, 0, -0.07]);
    part(resources, head, 'cloth', palette.parchment, [0.21, 0.39, -0.03], [0.11, 0.42, 1], [0.3, 0.4, -0.35]);
    if (hero) {
      part(resources, head, 'cone', palette.skin, [-0.25, 0.01, 0], [0.13, 0.27, 0.12], [0, 0, 1.05]);
      part(resources, head, 'cone', palette.skin, [0.25, 0.01, 0], [0.13, 0.27, 0.12], [0, 0, -1.05]);
    }
    part(resources, torso, 'cylinder', palette.bark, [0.3, 0.23, -0.35], [0.2, 0.78, 0.2], [-0.2, 0, -0.32]);
    part(resources, torso, 'box', palette.parchment, [0.44, 0.69, -0.42], [0.19, 0.17, 0.07], [0, 0, -0.32]);
  } else {
    part(resources, head, 'sphere', palette.steel, [0, 0.15, -0.055], [0.54, 0.45, 0.5]);
    part(resources, head, 'box', palette.iron, [0, 0.025, 0.24], [0.47, 0.08, 0.05]);
    if ((hero && faction === 'villain') || look === 'boss') {
      part(resources, head, 'cone', palette.brass, [-0.23, 0.35, 0], [0.14, 0.43, 0.15], [0.15, 0, 0.32]);
      part(resources, head, 'cone', palette.brass, [0.23, 0.35, 0], [0.14, 0.43, 0.15], [0.15, 0, -0.32]);
      part(resources, head, 'cone', palette.brass, [0, 0.38, 0.07], [0.13, 0.43, 0.15]);
    } else {
      part(resources, head, 'box', coat, [0, 0.38, -0.08], [0.11, 0.25, 0.47], [-0.17, 0, 0]);
    }
  }

  const leftLeg = joint(hips, [-0.19, 0, 0]);
  const rightLeg = joint(hips, [0.19, 0, 0]);
  for (const leg of [leftLeg, rightLeg]) {
    part(resources, leg, 'box', palette.iron, [0, -0.21, 0], [0.23, 0.46, 0.25]);
    part(resources, leg, 'box', palette.bark, [0, -0.51, 0.07], [0.25, 0.2, 0.42]);
    if (armored) part(resources, leg, 'box', palette.steel, [0, -0.24, 0.14], [0.2, 0.28, 0.06]);
  }
  const leftArm = joint(torso, [-0.43, 0.28, 0]);
  const rightArm = joint(torso, [0.43, 0.28, 0]);
  for (const arm of [leftArm, rightArm]) {
    part(resources, arm, armored ? 'sphere' : 'box', armored ? palette.steel : coat, [0, -0.09, 0], [0.35, 0.36, 0.38]);
    part(resources, arm, 'box', coat, [0, -0.3, 0], [0.23, 0.37, 0.24]);
    part(resources, arm, 'sphere', palette.skin, [0, -0.49, 0.06], [0.25, 0.25, 0.25]);
  }
  const weapon = joint(rightArm, [0, -0.46, 0.12]);
  if (look === 'archer' || (hero && faction === 'elf')) {
    beam(resources, weapon, [0, -0.48, 0.08], [0, 0, 0.3], 0.065, palette.timber);
    beam(resources, weapon, [0, 0, 0.3], [0, 0.48, 0.08], 0.065, palette.timber);
    beam(resources, weapon, [0, -0.48, 0.08], [0, 0.48, 0.08], 0.014, palette.parchment);
  } else if (large) {
    part(resources, weapon, 'box', palette.bark, [0, 0, 0.39], [0.1, 0.1, 0.95], [-0.2, 0, 0]);
    part(resources, weapon, 'box', palette.iron, [0, 0.12, 0.89], [0.57, 0.46, 0.32]);
    part(resources, weapon, 'box', palette.brass, [0, 0.12, 0.89], [0.64, 0.15, 0.35]);
  } else {
    part(resources, weapon, 'box', palette.ink, [0, 0, 0.05], [0.1, 0.1, 0.3]);
    part(resources, weapon, 'box', palette.brass, [0, 0, 0.24], [0.32, 0.07, 0.08]);
    part(resources, weapon, 'box', palette.steel, [0, 0, 0.67], [0.095, 0.045, 0.8]);
    part(resources, weapon, 'cone', palette.parchment, [0, 0, 1.12], [0.095, 0.16, 0.05], [Math.PI / 2, 0, 0]);
    if (armored) {
      part(resources, leftArm, 'cylinder', palette.iron, [-0.1, -0.3, 0.2], [0.64, 0.12, 0.72], [Math.PI / 2, 0, 0]);
      part(resources, leftArm, 'cylinder', coat, [-0.1, -0.3, 0.27], [0.52, 0.035, 0.61], [Math.PI / 2, 0, 0]);
      part(resources, leftArm, 'sphere', palette.brass, [-0.1, -0.3, 0.31], [0.2, 0.2, 0.08]);
    }
  }

  return {
    root,
    height: 2.35 * scale,
    animate(pose): void {
      const stride = Math.sin(pose.time * 10.5) * Math.min(1, pose.moving) * (pose.reducedMotion ? 0.25 : 0.65);
      leftLeg.rotation.x = stride;
      rightLeg.rotation.x = -stride;
      leftArm.rotation.x = -stride * 0.6 - pose.winding * 0.5;
      rightArm.rotation.x = stride * 0.6 - pose.winding * 1.8 + Math.sin(pose.attacking * Math.PI) * 1.3;
      rightArm.rotation.z = -pose.winding * 0.45;
      torso.rotation.y = -pose.winding * 0.55 + Math.sin(pose.attacking * Math.PI) * 0.8;
      torso.rotation.x = pose.dodging ? 0.35 : 0;
      body.position.y = pose.reducedMotion ? 0 : Math.abs(stride) * 0.07;
      body.rotation.z = pose.dead ? Math.PI / 2 : 0;
      body.position.y += pose.dead ? -0.1 : 0;
      cape.rotation.x = -0.05 - Math.abs(stride) * 0.22;
      capeMesh.rotation.z = pose.reducedMotion ? 0 : Math.sin(pose.time * 3) * 0.055;
      head.rotation.y = pose.winding * 0.18;
    },
  };
}

export interface WagonModel {
  root: THREE.Group;
  animate(distance: number, time: number, reducedMotion: boolean, movement: number): void;
}

export function createWagon(resources: ViewResources, friendly: boolean): WagonModel {
  const root = new THREE.Group();
  const cart = joint(root, [0, 0, 0]);
  const wheels: THREE.Group[] = [];
  const legs: THREE.Group[] = [];
  const canvas = friendly ? palette.parchment : '#c7b083';
  const flag = friendly ? palette.teal : palette.hostile;

  part(resources, cart, 'box', palette.iron, [0, 0.61, 0], [1.76, 0.14, 2.53]);
  part(resources, cart, 'box', palette.timber, [0, 0.85, 0], [1.61, 0.39, 2.45]);
  for (const side of [-1, 1]) {
    part(resources, cart, 'box', palette.timberLight, [side * 0.81, 1.08, 0], [0.09, 0.5, 2.5]);
    for (const z of [-0.85, 0.83]) {
      part(resources, cart, 'box', palette.iron, [side * 0.84, 1.08, z], [0.04, 0.58, 0.1]);
      const wheel = joint(cart, [side * 0.99, 0.53, z]);
      wheels.push(wheel);
      part(resources, wheel, 'cylinder', palette.iron, [0, 0, 0], [1.05, 0.15, 1.05], [0, 0, Math.PI / 2]);
      part(resources, wheel, 'cylinder', palette.timber, [side * 0.085, 0, 0], [0.87, 0.04, 0.87], [0, 0, Math.PI / 2]);
      part(resources, wheel, 'box', palette.timberLight, [side * 0.115, 0, 0], [0.06, 0.79, 0.09]);
      part(resources, wheel, 'box', palette.timberLight, [side * 0.115, 0, 0], [0.06, 0.09, 0.79]);
      part(resources, wheel, 'cylinder', palette.iron, [side * 0.15, 0, 0], [0.2, 0.14, 0.2], [0, 0, Math.PI / 2]);
    }
  }
  const cover = resources.geometry('wagon-cover', () => {
    const geometry = new THREE.CylinderGeometry(0.91, 0.91, 2.32, 8, 1, true, -Math.PI / 2, Math.PI);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
  });
  const roof = new THREE.Mesh(cover, resources.material(canvas, { side: THREE.DoubleSide }));
  roof.position.y = 1.43;
  roof.castShadow = true;
  roof.customDepthMaterial = resources.depthMaterial();
  roof.receiveShadow = true;
  cart.add(roof);
  for (const z of [-1.14, 0, 1.14]) {
    const hoop = new THREE.Mesh(resources.geometry('wagon-hoop', () => new THREE.TorusGeometry(0.92, 0.035, 4, 12, Math.PI)), resources.material(palette.bark));
    hoop.position.set(0, 1.43, z);
    cart.add(hoop);
  }
  part(resources, cart, 'box', palette.timberLight, [0, 1.1, -0.94], [1.5, 0.5, 0.12]);
  part(resources, cart, 'box', palette.bark, [0.88, 1.7, -0.7], [0.065, 1.5, 0.065]);
  part(resources, cart, 'cloth', flag, [1.16, 2.12, -0.7], [0.52, 0.39, 1]);
  for (const x of [-0.36, 0.35]) {
    part(resources, cart, 'sphere', palette.earth, [x, 1.25, -0.61], [0.61, 0.65, 0.66]);
    part(resources, cart, 'box', palette.timberLight, [x, 1.16, 0.44], [0.57, 0.49, 0.55]);
    beam(resources, root, [x * 1.8, 0.83, 0.9], [x * 1.8, 0.92, 3.24], 0.11, palette.timber);
  }
  const ox = joint(root, [0, 0, 3.04]);
  part(resources, ox, 'rock', '#987e58', [0, 1.05, 0], [1.17, 1.18, 1.87]);
  part(resources, ox, 'rock', '#bfab80', [0, 1.16, 0.93], [0.73, 0.78, 0.9]);
  part(resources, ox, 'box', palette.bark, [0, 0.99, 1.31], [0.55, 0.22, 0.36]);
  part(resources, ox, 'box', palette.iron, [0, 1.13, 1.15], [0.73, 0.07, 0.06]);
  part(resources, ox, 'box', palette.timber, [0, 1.51, 0.53], [1.52, 0.14, 0.2]);
  for (const side of [-1, 1]) {
    part(resources, ox, 'cone', palette.parchment, [side * 0.47, 1.61, 0.91], [0.19, 0.57, 0.2], [0.3, 0, side * -0.7]);
    for (const z of [-0.54, 0.61]) {
      const leg = joint(ox, [side * 0.36, 0.88, z]);
      legs.push(leg);
      part(resources, leg, 'box', '#987e58', [0, -0.32, 0], [0.19, 0.65, 0.22]);
      part(resources, leg, 'box', palette.ink, [0, -0.61, 0.03], [0.23, 0.17, 0.28]);
    }
  }
  let wheelAngle = 0;
  return {
    root,
    animate(distance, time, reducedMotion, movement): void {
      wheelAngle += distance / 0.525;
      for (const wheel of wheels) wheel.rotation.x = wheelAngle;
      const walking = Math.min(1, movement);
      legs.forEach((leg, index) => {
        leg.rotation.x = Math.sin(time * 6 + (index === 0 || index === 3 ? 0 : Math.PI)) * walking * (reducedMotion ? 0.14 : 0.33);
      });
      cart.rotation.z = reducedMotion ? 0 : Math.sin(time * 6) * 0.013 * walking;
    },
  };
}
