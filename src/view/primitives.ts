import * as THREE from 'three';
import { ViewResources } from './resources';
import type { Surface } from './surfaces';

export type Shape = 'box' | 'sphere' | 'rock' | 'cone' | 'cylinder' | 'disc' | 'ring' | 'zone-ring' | 'cloth'
  | 'roof' | 'torus' | 'foliage' | 'grass';
export type Triplet = readonly [number, number, number];

export function shapeGeometry(resources: ViewResources, shape: Shape): THREE.BufferGeometry {
  return resources.geometry(shape, () => {
    switch (shape) {
      case 'box': return new THREE.BoxGeometry(1, 1, 1);
      case 'sphere': return new THREE.IcosahedronGeometry(0.5, 1);
      case 'rock':
      case 'foliage': {
        const geometry = new THREE.IcosahedronGeometry(0.5, 1);
        const positions = geometry.getAttribute('position');
        for (let index = 0; index < positions.count; index++) {
          const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
          const ripple = 0.86 + 0.14 * Math.sin(x * 31 + y * 17) * Math.cos(z * 29 - y * 11);
          positions.setXYZ(index, x * ripple, y * ripple, z * ripple);
        }
        if (shape === 'rock') geometry.computeVertexNormals();
        return geometry;
      }
      case 'cone': return new THREE.ConeGeometry(0.5, 1, 12);
      case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
      case 'torus': return new THREE.TorusGeometry(0.43, 0.07, 6, 24);
      case 'roof': {
        const profile = new THREE.Shape();
        profile.moveTo(-0.5, -0.5);
        profile.lineTo(0.5, -0.5);
        profile.lineTo(0, 0.5);
        profile.closePath();
        return new THREE.ExtrudeGeometry(profile, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
      }
      case 'grass': {
        const vertices: number[] = [];
        for (let blade = 0; blade < 5; blade++) {
          const angle = blade * 2.4;
          const x = Math.sin(angle) * 0.28, z = Math.cos(angle) * 0.28;
          const height = 0.6 + (blade % 3) * 0.2;
          vertices.push(x - 0.065, 0, z, x + 0.065, 0, z,
            x + Math.sin(angle) * 0.3, height, z + Math.cos(angle) * 0.3);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.computeVertexNormals();
        return geometry;
      }
      case 'disc': return new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
      case 'ring': return new THREE.RingGeometry(0.42, 0.5, 40).rotateX(-Math.PI / 2);
      case 'zone-ring': return new THREE.RingGeometry(0.494, 0.5, 80).rotateX(-Math.PI / 2);
      case 'cloth': {
        const geometry = new THREE.PlaneGeometry(1, 1, 12, 8);
        const positions = geometry.getAttribute('position');
        for (let index = 0; index < positions.count; index += 1) {
          const x = positions.getX(index);
          const y = positions.getY(index);
          positions.setZ(index, Math.sin(x * 8 + y * 3) * 0.07);
        }
        geometry.computeVertexNormals();
        return geometry;
      }
    }
  });
}

export function part(
  resources: ViewResources,
  parent: THREE.Object3D,
  shape: Shape,
  color: string,
  position: Triplet,
  scale: Triplet,
  rotation: Triplet = [0, 0, 0],
  surface?: Surface,
): THREE.Mesh {
  const mesh = new THREE.Mesh(shapeGeometry(resources, shape), resources.material(color, {
    side: shape === 'cloth' || shape === 'grass' ? THREE.DoubleSide : THREE.FrontSide,
    surface: surface ?? (shape === 'cloth' ? 'cloth' : undefined),
  }));
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.rotation.set(...rotation);
  mesh.castShadow = shape !== 'ring' && shape !== 'zone-ring';
  mesh.customDepthMaterial = resources.depthMaterial();
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function joint(parent: THREE.Object3D, position: Triplet): THREE.Group {
  const group = new THREE.Group();
  group.position.set(...position);
  parent.add(group);
  return group;
}

export function beam(
  resources: ViewResources,
  parent: THREE.Object3D,
  from: Triplet,
  to: Triplet,
  width: number,
  color: string,
): THREE.Mesh {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const direction = end.clone().sub(start);
  const mesh = part(resources, parent, 'box', color, [0, 0, 0], [width, direction.length(), width]);
  mesh.position.copy(start.add(end).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

type Batch = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  transforms: THREE.Matrix4[];
  shadow: boolean;
};

/** Merge repeated authored parts into one instanced draw per geometry/material pair. */
export class StaticBatch {
  private readonly batches = new Map<string, Batch>();
  private readonly transform = new THREE.Object3D();

  constructor(private readonly resources: ViewResources) {}

  add(shape: Shape, color: string, position: Triplet, scale: Triplet, rotation: Triplet = [0, 0, 0], shadow = true, surface?: Surface): void {
    const key = `${shape}:${color}:${shadow}:${surface ?? ''}`;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = {
        geometry: shapeGeometry(this.resources, shape),
        material: this.resources.material(color, {
          side: shape === 'cloth' || shape === 'grass' ? THREE.DoubleSide : THREE.FrontSide,
          surface: surface ?? (shape === 'cloth' ? 'cloth' : undefined),
        }),
        transforms: [],
        shadow,
      };
      this.batches.set(key, batch);
    }
    this.transform.position.set(...position);
    this.transform.scale.set(...scale);
    this.transform.rotation.set(...rotation);
    this.transform.updateMatrix();
    batch.transforms.push(this.transform.matrix.clone());
  }

  append(group: THREE.Object3D): void {
    group.updateMatrixWorld(true);
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
      const key = `${object.geometry.uuid}:${object.material.uuid}:${object.castShadow}`;
      let batch = this.batches.get(key);
      if (!batch) {
        batch = {
          geometry: object.geometry,
          material: object.material,
          transforms: [],
          shadow: object.castShadow,
        };
        this.batches.set(key, batch);
      }
      batch.transforms.push(object.matrixWorld.clone());
    });
  }

  finish(parent: THREE.Object3D): THREE.InstancedMesh[] {
    const meshes: THREE.InstancedMesh[] = [];
    for (const batch of this.batches.values()) {
      const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.transforms.length);
      batch.transforms.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.castShadow = batch.shadow;
      mesh.customDepthMaterial = this.resources.depthMaterial();
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.batches.clear();
    return meshes;
  }
}
