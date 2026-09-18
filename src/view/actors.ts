import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { factionColors, palette, type ViewFaction } from './palette';
import { beam, joint, part, shapeGeometry } from './primitives';
import { ViewResources } from './resources';

export type ActorLook = 'hero' | 'guard' | 'archer' | 'brute' | 'boss';
export type ViewAllegiance = 'friendly' | 'hostile' | 'neutral';
const leather = '#594735';

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

export function createActor(resources: ViewResources, look: ActorLook, faction: ViewFaction, affiliation: boolean | ViewAllegiance = false): ActorModel {
  const root = new THREE.Group();
  const allegiance = typeof affiliation === 'boolean' ? affiliation ? 'friendly' : 'hostile' : affiliation;
  root.userData.allegiance = allegiance;
  const large = look === 'brute' || look === 'boss';
  const hero = look === 'hero';
  const scale = look === 'boss' ? 1.7 : large ? 1.2 : 1;
  const coat = hero || allegiance === 'friendly' || affiliation === 'hostile' ? factionColors[faction]
    : allegiance === 'neutral' ? palette.stone : look === 'boss' ? palette.villain : palette.hostile;
  const body = joint(root, [0, 0, 0]);
  body.scale.setScalar(scale);
  const hips = joint(body, [0, 0.75, 0]);
  const torso = joint(body, [0, 1.1, 0]);
  const armored = large || look === 'guard' || (hero && faction !== 'elf');
  const ranger = (hero && faction === 'elf') || look === 'archer';
  const sinister = (hero && faction === 'villain') || look === 'boss';
  body.name = 'actor-body';
  hips.name = 'actor-hips';
  torso.name = 'actor-torso';
  part(resources, hips, 'sphere', palette.iron, [0, 0.02, 0], [0.56, 0.32, 0.36]);
  part(resources, torso, 'sphere', armored ? palette.steel : coat, [0, 0.14, 0], [large ? 0.85 : 0.7, 0.75, 0.49]);
  part(resources, torso, 'sphere', armored ? palette.iron : leather, [0, -0.08, 0], [0.56, 0.35, 0.4]);
  part(resources, torso, 'cloth', coat, [0, -0.07, 0.237], [0.27, 0.75, 0.45]);
  part(resources, torso, 'cylinder', palette.iron, [0, -0.19, 0], [0.65, 0.12, 0.44]);
  part(resources, torso, 'box', palette.brass, [0, -0.19, 0.235], [0.13, 0.105, 0.03]);
  part(resources, torso, 'cylinder', palette.iron, [0, 0.46, 0], [0.31, 0.13, 0.29]);
  for (const side of [-1, 1]) {
    part(resources, torso, armored ? 'sphere' : 'cloth', armored ? palette.steel : coat,
      [side * 0.21, -0.25, 0.13], [0.23, 0.34, armored ? 0.19 : 0.45], [0.12, side * 0.15, side * 0.08]);
    part(resources, torso, 'sphere', palette.brass, [side * 0.23, 0.33, 0.175], [0.08, 0.08, 0.055]);
  }
  beam(resources, torso, [-0.22, 0.36, 0.16], [0.2, -0.16, 0.235], 0.065, leather);
  if (hero || large) {
    part(resources, torso, 'cone', palette.brass, [0, 0.17, 0.28], [0.12, 0.2, 0.035],
      [0, 0, sinister ? Math.PI : 0]);
  }
  const head = joint(torso, [0, 0.65, 0]);
  head.name = 'actor-head';
  part(resources, head, 'sphere', palette.skin, [0, 0, 0.025], [0.43, 0.49, 0.43]);
  part(resources, head, 'sphere', palette.skin, [0, -0.12, 0.12], [0.29, 0.24, 0.26]);
  for (const side of [-1, 1]) {
    part(resources, head, 'sphere', palette.ink, [side * 0.092, 0.035, 0.218], [0.047, 0.033, 0.024]);
  }
  part(resources, head, 'sphere', palette.skin, [0, -0.01, 0.246], [0.075, 0.12, 0.091]);
  part(resources, head, 'box', leather, [0, -0.115, 0.236], [0.12, 0.016, 0.019]);

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
  } else if (allegiance !== 'hostile') {
    const ring = new THREE.Mesh(shapeGeometry(resources, 'ring'),
      resources.material(allegiance === 'friendly' ? palette.teal : palette.stone, { unlit: true }));
    ring.name = 'allegiance-ring';
    ring.scale.setScalar(1.35 * scale);
    ring.position.y = 0.065;
    root.add(ring);
  }

  if (ranger) {
    part(resources, head, 'cone', coat, [0, 0.29, -0.035], [0.63, 0.48, 0.55], [-0.3, 0, -0.17]);
    part(resources, head, 'box', palette.leafDark, [0, 0.11, 0.08], [0.61, 0.06, 0.53], [0, 0, -0.07]);
    part(resources, head, 'cloth', palette.parchment, [0.21, 0.39, -0.03], [0.11, 0.42, 1], [0.3, 0.4, -0.35]);
    if (hero) {
      part(resources, head, 'cone', palette.skin, [-0.25, 0.01, 0], [0.13, 0.27, 0.12], [0, 0, 1.05]);
      part(resources, head, 'cone', palette.skin, [0.25, 0.01, 0], [0.13, 0.27, 0.12], [0, 0, -1.05]);
    }
    part(resources, torso, 'cylinder', leather, [0.3, 0.23, -0.35], [0.2, 0.78, 0.2], [-0.2, 0, -0.32]);
    for (const offset of [-0.06, 0.06]) {
      part(resources, torso, 'cylinder', palette.timberLight, [0.43 + offset, 0.65, -0.42],
        [0.026, 0.42, 0.026], [-0.2, 0, -0.32]);
      part(resources, torso, 'cloth', palette.parchment, [0.46 + offset, 0.79, -0.45], [0.08, 0.13, 0.22], [0, 0, -0.32]);
    }
  } else {
    part(resources, head, 'sphere', palette.steel, [0, 0.15, -0.055], [0.54, 0.45, 0.5]);
    part(resources, head, 'box', palette.iron, [0, 0.095, 0.21], [0.45, 0.055, 0.06]);
    part(resources, head, 'box', palette.steel, [0, 0.008, 0.272], [0.044, 0.18, 0.035], [-0.13, 0, 0]);
    for (const side of [-1, 1]) {
      part(resources, head, 'sphere', palette.steel, [side * 0.18, -0.075, 0.11],
        [0.11, 0.26, 0.2], [0.2, side * -0.2, side * -0.13]);
    }
    if (sinister) {
      part(resources, head, 'cone', palette.brass, [-0.23, 0.35, 0], [0.14, 0.43, 0.15], [0.15, 0, 0.32]);
      part(resources, head, 'cone', palette.brass, [0.23, 0.35, 0], [0.14, 0.43, 0.15], [0.15, 0, -0.32]);
      part(resources, head, 'cone', palette.brass, [0, 0.38, 0.07], [0.13, 0.43, 0.15]);
    } else {
      part(resources, head, 'box', coat, [0, 0.38, -0.08], [0.11, 0.25, 0.47], [-0.17, 0, 0]);
    }
  }

  const leftLeg = joint(hips, [-0.19, 0, 0]);
  const rightLeg = joint(hips, [0.19, 0, 0]);
  leftLeg.name = 'actor-left-leg';
  rightLeg.name = 'actor-right-leg';
  for (const leg of [leftLeg, rightLeg]) {
    part(resources, leg, 'cylinder', palette.iron, [0, -0.17, 0], [0.25, 0.34, 0.28]);
    part(resources, leg, 'sphere', armored ? palette.steel : leather, [0, -0.31, 0.03], [0.26, 0.21, 0.3]);
    part(resources, leg, 'cylinder', armored ? palette.steel : leather, [0, -0.43, 0], [0.21, 0.26, 0.24]);
    part(resources, leg, 'sphere', leather, [0, -0.57, 0.075], [0.28, 0.23, 0.43]);
    part(resources, leg, 'box', palette.iron, [0, -0.66, 0.06], [0.25, 0.055, 0.35]);
  }
  const leftArm = joint(torso, [-0.43, 0.28, 0]);
  const rightArm = joint(torso, [0.43, 0.28, 0]);
  leftArm.name = 'actor-left-arm';
  rightArm.name = 'actor-right-arm';
  for (const arm of [leftArm, rightArm]) {
    part(resources, arm, 'sphere', armored ? palette.steel : coat, [0, -0.07, 0], [0.36, 0.35, 0.4]);
    part(resources, arm, 'cylinder', coat, [0, -0.23, 0], [0.24, 0.27, 0.25]);
    part(resources, arm, 'sphere', palette.iron, [0, -0.32, 0], [0.24, 0.19, 0.25]);
    part(resources, arm, 'cylinder', armored ? palette.steel : leather, [0, -0.39, 0.035], [0.24, 0.22, 0.25], [-0.18, 0, 0]);
    part(resources, arm, 'sphere', palette.skin, [0, -0.51, 0.07], [0.22, 0.22, 0.25]);
    if (sinister) part(resources, arm, 'cone', palette.brass, [0, 0.13, -0.06], [0.12, 0.28, 0.12]);
  }
  const weapon = joint(rightArm, [0, -0.46, 0.12]);
  weapon.name = ranger ? 'actor-bow' : large ? 'actor-hammer' : 'actor-sword';
  if (ranger) {
    const bowPoints = [[0, -0.57, 0.02], [0, -0.39, 0.18], [0, 0, 0.31], [0, 0.39, 0.18], [0, 0.57, 0.02]] as const;
    for (let index = 1; index < bowPoints.length; index++) {
      beam(resources, weapon, bowPoints[index - 1]!, bowPoints[index]!, 0.055, palette.timber);
    }
    beam(resources, weapon, bowPoints[0], bowPoints[4], 0.012, palette.parchment);
    part(resources, weapon, 'cylinder', leather, [0, 0, 0.31], [0.075, 0.17, 0.075]);
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
      const shield = joint(leftArm, [-0.1, -0.3, 0.2]);
      shield.name = 'actor-shield';
      part(resources, shield, 'cylinder', palette.iron, [0, 0, 0], [0.7, 0.12, 0.82], [Math.PI / 2, 0, 0]);
      part(resources, shield, 'cylinder', coat, [0, 0, 0.075], [0.6, 0.035, 0.71], [Math.PI / 2, 0, 0]);
      part(resources, shield, 'torus', palette.brass, [0, 0, 0.09], [0.67, 0.79, 0.3]);
      part(resources, shield, 'sphere', palette.brass, [0, 0, 0.12], [0.2, 0.2, 0.11]);
      part(resources, shield, 'box', palette.brass, [0, 0, 0.104], [0.055, 0.63, 0.025]);
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

export function createWagon(resources: ViewResources, affiliation: boolean | ViewAllegiance): WagonModel {
  const root = new THREE.Group();
  const allegiance = typeof affiliation === 'boolean' ? affiliation ? 'friendly' : 'hostile' : affiliation;
  root.userData.allegiance = allegiance;
  const cart = joint(root, [0, 0, 0]);
  const wheels: THREE.Group[] = [];
  const legs: THREE.Group[] = [];
  const canvas = allegiance === 'friendly' ? palette.parchment : '#c7b083';
  const flag = allegiance === 'friendly' ? palette.teal : allegiance === 'neutral' ? palette.stone : palette.hostile;
  cart.name = 'wagon-cart';
  const spokes = resources.geometry('wagon-spokes', () => {
    const beams = Array.from({ length: 4 }, (_, index) => {
      const geometry = new THREE.BoxGeometry(0.085, 0.87, 0.06);
      geometry.rotateX(index * Math.PI / 4);
      return geometry;
    });
    const geometry = mergeGeometries(beams);
    for (const beamGeometry of beams) beamGeometry.dispose();
    return geometry;
  });

  part(resources, cart, 'box', palette.iron, [0, 0.61, 0], [1.76, 0.14, 2.53]);
  part(resources, cart, 'box', palette.timber, [0, 0.85, 0], [1.61, 0.39, 2.45]);
  for (const z of [-0.85, 0.83]) {
    part(resources, cart, 'cylinder', palette.iron, [0, 0.53, z], [0.14, 2.06, 0.14], [0, 0, Math.PI / 2]);
  }
  for (const side of [-1, 1]) {
    for (let slat = 0; slat < 3; slat++) {
      part(resources, cart, 'box', palette.timberLight, [side * 0.81, 0.92 + slat * 0.17, 0], [0.09, 0.145, 2.5]);
    }
    for (const z of [-0.85, 0.83]) {
      part(resources, cart, 'box', palette.iron, [side * 0.84, 1.08, z], [0.04, 0.58, 0.1]);
      const wheel = joint(cart, [side * 0.99, 0.53, z]);
      wheel.name = 'wagon-wheel';
      wheels.push(wheel);
      part(resources, wheel, 'torus', palette.iron, [0, 0, 0], [1.05, 1.05, 1.05], [0, Math.PI / 2, 0]);
      part(resources, wheel, 'torus', palette.timber, [side * 0.018, 0, 0], [0.94, 0.94, 1.15], [0, Math.PI / 2, 0]);
      const spokeMesh = new THREE.Mesh(spokes, resources.material(palette.timberLight));
      spokeMesh.name = 'wagon-wheel-spokes';
      spokeMesh.castShadow = spokeMesh.receiveShadow = true;
      spokeMesh.customDepthMaterial = resources.depthMaterial();
      wheel.add(spokeMesh);
      part(resources, wheel, 'cylinder', palette.timber, [side * 0.04, 0, 0], [0.24, 0.25, 0.24], [0, 0, Math.PI / 2]);
      part(resources, wheel, 'cylinder', palette.iron, [side * 0.18, 0, 0], [0.16, 0.045, 0.16], [0, 0, Math.PI / 2]);
    }
  }
  const cover = resources.geometry('wagon-cover', () => {
    const geometry = new THREE.CylinderGeometry(0.91, 0.91, 2.32, 24, 12, true, -Math.PI / 2, Math.PI);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index++) {
      const sag = Math.sin(positions.getZ(index) * Math.PI / 1.16) ** 2 * 0.045;
      positions.setY(index, positions.getY(index) - sag);
    }
    geometry.computeVertexNormals();
    return geometry;
  });
  const roof = new THREE.Mesh(cover, resources.material(canvas, { side: THREE.DoubleSide, surface: 'cloth' }));
  roof.name = 'wagon-canopy';
  roof.position.y = 1.43;
  roof.castShadow = true;
  roof.customDepthMaterial = resources.depthMaterial();
  roof.receiveShadow = true;
  cart.add(roof);
  for (const z of [-1.14, 0, 1.14]) {
    const hoop = new THREE.Mesh(resources.geometry('wagon-hoop', () => new THREE.TorusGeometry(0.92, 0.035, 6, 28, Math.PI)), resources.material(palette.bark));
    hoop.position.set(0, 1.43, z);
    hoop.castShadow = hoop.receiveShadow = true;
    hoop.customDepthMaterial = resources.depthMaterial();
    cart.add(hoop);
  }
  for (const side of [-1, 1]) {
    part(resources, cart, 'box', palette.bark, [side * 0.9, 1.43, 0], [0.045, 0.05, 2.36]);
    part(resources, cart, 'cloth', canvas, [side * 0.63, 1.6, -1.17], [0.47, 0.4, 0.25], [0, 0, side * -0.12]);
  }
  for (let slat = 0; slat < 3; slat++) {
    part(resources, cart, 'box', palette.timberLight, [0, 0.96 + slat * 0.17, -1.19], [1.52, 0.145, 0.1]);
  }
  part(resources, cart, 'box', palette.iron, [-0.74, 1.43, -1.22], [0.22, 0.3, 0.21]);
  const lantern = part(resources, cart, 'box', palette.sun, [-0.74, 1.44, -1.335], [0.14, 0.2, 0.025]);
  lantern.material = resources.material(palette.sun, { emissive: palette.sun });
  part(resources, cart, 'box', palette.bark, [0.88, 1.7, -0.7], [0.065, 1.5, 0.065]);
  part(resources, cart, 'cloth', flag, [1.16, 2.12, -0.7], [0.52, 0.39, 1]);
  for (const x of [-0.36, 0.35]) {
    part(resources, cart, 'sphere', palette.earth, [x, 1.25, -0.61], [0.61, 0.65, 0.66]);
    part(resources, cart, 'box', palette.timberLight, [x, 1.16, 0.44], [0.57, 0.49, 0.55]);
    beam(resources, root, [x * 1.8, 0.83, 0.9], [x * 1.8, 0.92, 3.24], 0.11, palette.timber);
  }
  const ox = joint(root, [0, 0, 3.04]);
  ox.name = 'wagon-ox';
  part(resources, ox, 'sphere', '#987e58', [0, 1.06, 0], [1.17, 1.18, 1.87]);
  part(resources, ox, 'sphere', '#987e58', [0, 1.37, 0.48], [0.93, 0.74, 0.91]);
  part(resources, ox, 'sphere', '#bfab80', [0, 0.91, 0.56], [0.54, 0.75, 0.53]);
  const oxHead = joint(ox, [0, 1.23, 0.82]);
  oxHead.name = 'wagon-ox-head';
  part(resources, oxHead, 'sphere', '#bfab80', [0, -0.03, 0.12], [0.73, 0.78, 0.87]);
  part(resources, oxHead, 'sphere', leather, [0, -0.24, 0.52], [0.56, 0.32, 0.4]);
  part(resources, oxHead, 'torus', palette.iron, [0, -0.2, 0.4], [0.61, 0.43, 0.2]);
  part(resources, ox, 'box', palette.timber, [0, 1.51, 0.53], [1.52, 0.14, 0.2]);
  part(resources, ox, 'torus', leather, [0, 1.05, 0.57], [0.89, 1.07, 0.72]);
  for (const side of [-1, 1]) {
    part(resources, oxHead, 'sphere', palette.ink, [side * 0.285, 0.07, 0.3], [0.06, 0.055, 0.07]);
    part(resources, oxHead, 'sphere', palette.ink, [side * 0.155, -0.185, 0.69], [0.07, 0.05, 0.03]);
    part(resources, oxHead, 'sphere', '#987e58', [side * 0.37, 0.07, 0.03], [0.41, 0.14, 0.24], [0, 0, side * 0.22]);
    part(resources, oxHead, 'cylinder', palette.parchment, [side * 0.38, 0.32, 0.02], [0.16, 0.36, 0.16], [0.2, 0, side * -0.9]);
    part(resources, oxHead, 'cone', palette.parchment, [side * 0.51, 0.53, -0.01], [0.13, 0.32, 0.13], [-0.3, 0, side * -0.15]);
    beam(resources, ox, [side * 0.64, 1.5, 0.53], [side * 0.65, 0.94, -0.34], 0.055, leather);
    for (const z of [-0.54, 0.61]) {
      const leg = joint(ox, [side * 0.36, 0.88, z]);
      leg.name = 'wagon-ox-leg';
      legs.push(leg);
      part(resources, leg, 'cylinder', '#987e58', [0, -0.22, 0], [0.23, 0.44, 0.26], [0.08, 0, 0]);
      part(resources, leg, 'sphere', '#bfab80', [0, -0.4, -0.02], [0.2, 0.2, 0.22]);
      part(resources, leg, 'cylinder', '#987e58', [0, -0.5, 0], [0.15, 0.26, 0.18]);
      part(resources, leg, 'box', palette.ink, [0, -0.61, 0.03], [0.23, 0.17, 0.28]);
    }
  }
  const tail = joint(ox, [0, 1.34, -0.84]);
  beam(resources, tail, [0, 0, 0], [0, -0.57, -0.18], 0.075, '#987e58');
  part(resources, tail, 'sphere', leather, [0, -0.61, -0.19], [0.14, 0.25, 0.15]);
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
      oxHead.rotation.x = reducedMotion ? 0 : Math.sin(time * 6) * walking * 0.035;
      tail.rotation.z = reducedMotion ? 0 : Math.sin(time * 2) * 0.1;
      cart.rotation.z = reducedMotion ? 0 : Math.sin(time * 6) * 0.013 * walking;
    },
  };
}
