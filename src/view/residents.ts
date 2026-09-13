import * as THREE from 'three';
import type { GameSnapshot, NpcSnapshot } from '../game/types';
import { palette } from './palette';
import { joint, part, shapeGeometry } from './primitives';
import { ViewResources } from './resources';

interface Resident {
  root: THREE.Group;
  marker: THREE.Mesh;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  head: THREE.Group;
}

function resident(resources: ViewResources, npc: NpcSnapshot): Resident {
  let hash = 0;
  for (const letter of npc.id) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  const variant = hash % 4;
  const coat = ['#697455', '#886c4e', '#476b69', '#756076'][variant]!;
  const root = new THREE.Group();
  root.name = `resident:${npc.id}`;
  root.userData.npcId = npc.id;
  const body = joint(root, [0, 0, 0]);
  body.scale.y = 0.93 + (hash % 5) * 0.035;
  for (const side of [-1, 1]) {
    part(resources, body, 'cylinder', '#594735', [side * 0.17, 0.4, 0], [0.23, 0.7, 0.26]);
    part(resources, body, 'sphere', '#594735', [side * 0.17, 0.12, 0.08], [0.29, 0.24, 0.42]);
  }
  part(resources, body, 'sphere', coat, [0, 1.13, 0], [0.79, 0.92, 0.52], [0, 0, 0], 'cloth');
  part(resources, body, 'cone', coat, [0, 0.72, 0], [0.78, 0.62, 0.57], [0, 0, 0], 'cloth');
  part(resources, body, 'cylinder', '#594735', [0, 0.92, 0], [0.63, 0.08, 0.45]);
  part(resources, body, 'box', palette.brass, [0, 0.92, 0.23], [0.1, 0.09, 0.03]);
  part(resources, body, 'cylinder', palette.skin, [0, 1.64, 0], [0.2, 0.2, 0.2]);
  const head = joint(body, [0, 1.88, 0]);
  part(resources, head, 'sphere', palette.skin, [0, 0, 0.03], [0.43, 0.51, 0.42]);
  for (const side of [-1, 1]) {
    part(resources, head, 'sphere', palette.ink, [side * 0.09, 0.045, 0.225], [0.04, 0.032, 0.024]);
    part(resources, head, 'sphere', palette.skin, [side * 0.21, 0, 0.015], [0.095, 0.14, 0.08]);
  }
  part(resources, head, 'sphere', palette.skin, [0, -0.02, 0.25], [0.08, 0.12, 0.09]);
  part(resources, head, 'box', '#594735', [0, -0.12, 0.23], [0.1, 0.015, 0.02]);
  const hair = hash % 3 === 0 ? palette.parchment : palette.bark;
  part(resources, head, 'sphere', hair, [0, 0.14, -0.05], [0.46, 0.34, 0.42]);
  if (variant === 0) {
    part(resources, head, 'cone', coat, [0, 0.32, -0.05], [0.58, 0.47, 0.58]);
    part(resources, head, 'cylinder', palette.bark, [0, 0.17, 0], [0.79, 0.055, 0.79]);
  } else if (variant === 1) {
    part(resources, body, 'cloth', palette.parchment, [0, 0.9, 0.25], [0.49, 0.8, 1]);
    part(resources, head, 'sphere', hair, [0, -0.17, 0.2], [0.3, 0.26, 0.16]);
  } else if (variant === 2) {
    part(resources, body, 'cloth', palette.teal, [0, 1.1, -0.24], [0.82, 1.15, 1]);
    part(resources, body, 'box', palette.brass, [0.25, 1.42, 0.24], [0.09, 0.09, 0.045]);
  } else {
    part(resources, head, 'cylinder', coat, [0, 0.26, 0], [0.49, 0.26, 0.47]);
    part(resources, body, 'box', palette.bark, [-0.38, 0.79, 0.1], [0.25, 0.35, 0.32]);
  }
  const leftArm = joint(body, [-0.43, 1.43, 0]);
  const rightArm = joint(body, [0.43, 1.43, 0]);
  for (const arm of [leftArm, rightArm]) {
    part(resources, arm, 'sphere', coat, [0, -0.06, 0], [0.32, 0.3, 0.34], [0, 0, 0], 'cloth');
    part(resources, arm, 'cylinder', coat, [0, -0.28, 0], [0.24, 0.42, 0.28], [0, 0, 0], 'cloth');
    part(resources, arm, 'cylinder', palette.parchment, [0, -0.45, 0], [0.25, 0.09, 0.29], [0, 0, 0], 'cloth');
    part(resources, arm, 'sphere', palette.skin, [0, -0.52, 0.025], [0.22, 0.23, 0.24]);
  }
  if (variant === 2) {
    leftArm.rotation.x = -0.45;
    part(resources, leftArm, 'box', palette.bark, [0, -0.45, 0.17], [0.42, 0.12, 0.5]);
    part(resources, leftArm, 'box', palette.parchment, [0, -0.39, 0.17], [0.37, 0.035, 0.45]);
  }
  const ring = new THREE.Mesh(shapeGeometry(resources, 'ring'), resources.material(palette.teal, { unlit: true }));
  ring.scale.setScalar(1.55);
  ring.position.y = 0.06;
  root.add(ring);
  const marker = new THREE.Mesh(shapeGeometry(resources, 'box'), resources.material(palette.brass, { unlit: true }));
  marker.position.y = 2.65;
  marker.scale.set(0.23, 0.23, 0.08);
  root.add(marker);
  return { root, marker, leftArm, rightArm, head };
}

export class WorldResidents {
  private readonly people = new Map<string, Resident>();

  constructor(private readonly resources: ViewResources, private readonly scene: THREE.Scene) {}

  update(snapshot: Readonly<GameSnapshot>, camera: THREE.Camera, reducedMotion: boolean): void {
    const ids = new Set<string>();
    for (const npc of snapshot.narrative?.npcs ?? []) {
      ids.add(npc.id);
      let person = this.people.get(npc.id);
      if (!person) {
        person = resident(this.resources, npc);
        this.people.set(npc.id, person);
        this.scene.add(person.root);
      }
      const distance = Math.hypot(npc.x - snapshot.player.x, npc.z - snapshot.player.z);
      person.root.visible = npc.available && distance < 120;
      if (!person.root.visible) continue;
      person.root.position.set(npc.x, 0.06, npc.z);
      person.root.rotation.y = distance < 8
        ? Math.atan2(snapshot.player.x - npc.x, snapshot.player.z - npc.z) : npc.heading;
      person.marker.visible = distance < 32;
      person.marker.material = this.resources.material(npc.questAvailable ? palette.brass : palette.teal, { unlit: true });
      person.marker.quaternion.copy(person.root.quaternion).invert().multiply(camera.quaternion);
      person.marker.rotateZ(Math.PI / 4);
      person.marker.position.y = 2.65 + (reducedMotion ? 0 : Math.sin(snapshot.elapsed * 2 + npc.x) * 0.08);
      const speaking = snapshot.narrative?.dialogue?.npcId === npc.id;
      person.rightArm.rotation.x = reducedMotion ? 0 : Math.sin(snapshot.elapsed * 1.5 + npc.z) * (speaking ? 0.18 : 0.035);
      person.head.rotation.z = reducedMotion ? 0 : Math.sin(snapshot.elapsed * 0.8 + npc.x) * 0.025;
    }
    for (const [id, person] of this.people) {
      if (ids.has(id)) continue;
      person.root.removeFromParent();
      this.people.delete(id);
    }
  }

  dispose(): void {
    for (const person of this.people.values()) person.root.removeFromParent();
    this.people.clear();
  }
}
