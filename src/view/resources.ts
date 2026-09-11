import * as THREE from 'three';

/** One owner for shared GPU assets, including assets held by invisible pools. */
export class ViewResources {
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();

  geometry<T extends THREE.BufferGeometry>(key: string, create: () => T): THREE.BufferGeometry {
    const existing = this.geometries.get(key);
    if (existing) return existing;
    const geometry = create();
    this.geometries.set(key, geometry);
    return geometry;
  }

  material(color: string, options: {
    emissive?: string;
    opacity?: number;
    metalness?: number;
    side?: THREE.Side;
    unlit?: boolean;
    depthWrite?: boolean;
  } = {}): THREE.Material {
    const key = `${color}:${JSON.stringify(options)}`;
    const existing = this.materials.get(key);
    if (existing) return existing;
    const common = {
      color,
      transparent: options.opacity !== undefined && options.opacity < 1,
      opacity: options.opacity ?? 1,
      side: options.side ?? THREE.FrontSide,
      depthWrite: options.depthWrite ?? true,
    };
    const material = options.unlit
      ? new THREE.MeshBasicMaterial(common)
      : new THREE.MeshStandardMaterial({
        ...common,
        roughness: 0.93,
        metalness: options.metalness ?? 0,
        flatShading: true,
        emissive: options.emissive ?? '#000000',
      });
    this.materials.set(key, material);
    return material;
  }

  ownMaterial<T extends THREE.Material>(key: string, material: T): T {
    if (this.materials.has(key)) throw new Error(`Duplicate view material: ${key}`);
    this.materials.set(key, material);
    return material;
  }

  ownTexture<T extends THREE.Texture>(texture: T): T {
    this.textures.add(texture);
    return texture;
  }

  dispose(): void {
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
  }
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
