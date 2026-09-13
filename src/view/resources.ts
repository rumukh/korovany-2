import * as THREE from 'three';
import { palette } from './palette';
import { surfaceForColor, surfaceUrl, type Surface } from './surfaces';

/** One owner for shared GPU assets, including assets held by invisible pools. */
export class ViewResources {
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private shadowDepth: THREE.MeshDepthMaterial | undefined;
  private readonly surfaceMaps = new Map<Surface, {
    map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture;
  }>();
  private pendingTextures = 0;
  private textureError: Error | undefined;
  private disposed = false;

  constructor(
    private readonly loader?: Pick<THREE.TextureLoader, 'load'>,
    private readonly anisotropy = 1,
  ) {}

  get textureStatus(): { pending: number; error: string | null; surfaces: number } {
    return { pending: this.pendingTextures, error: this.textureError?.message ?? null, surfaces: this.surfaceMaps.size };
  }

  assertTextures(): void {
    if (this.textureError) throw this.textureError;
  }

  private maps(surface: Surface): { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture } | undefined {
    if (!this.loader) return undefined;
    const existing = this.surfaceMaps.get(surface);
    if (existing) return existing;
    const load = (kind: 'color' | 'normal' | 'roughness'): THREE.Texture => {
      const url = surfaceUrl(surface, kind);
      this.pendingTextures++;
      const texture = this.loader!.load(url, () => {
        this.pendingTextures--;
      }, undefined, () => {
        this.pendingTextures--;
        if (!this.disposed) this.textureError = new Error(`Could not load world texture: ${url}. Reload to retry.`);
      });
      texture.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(8, this.anisotropy);
      return this.ownTexture(texture);
    };
    const maps = { map: load('color'), normalMap: load('normal'), roughnessMap: load('roughness') };
    this.surfaceMaps.set(surface, maps);
    return maps;
  }

  depthMaterial(): THREE.MeshDepthMaterial {
    if (!this.shadowDepth) {
      this.shadowDepth = this.ownMaterial('shared-shadow-depth',
        new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
    }
    return this.shadowDepth;
  }

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
    surface?: Surface;
    roughness?: number;
    smooth?: boolean;
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
    const surface = options.surface ?? surfaceForColor(color);
    const metal = color === palette.steel || color === palette.iron || color === palette.brass;
    const material = options.unlit
      ? new THREE.MeshBasicMaterial(common)
      : new THREE.MeshStandardMaterial({
        ...common,
        roughness: options.roughness ?? (metal ? 0.38 : 0.92),
        metalness: options.metalness ?? (metal ? 0.68 : 0),
        flatShading: !(options.smooth ?? true),
        emissive: options.emissive ?? '#000000',
        ...(surface ? this.maps(surface) : undefined),
        normalScale: new THREE.Vector2(surface === 'stone' ? 0.65 : 0.32, surface === 'stone' ? 0.65 : 0.32),
      });
    if (surface === 'ground' && !options.unlit) {
      material.customProgramCacheKey = () => 'frontier-ground-uv-v1';
      material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `
          #include <worldpos_vertex>
          vec4 surfacePosition = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            surfacePosition = instanceMatrix * surfacePosition;
          #endif
          vec2 groundUv = (modelMatrix * surfacePosition).xz * 0.32;
          #ifdef USE_MAP
            vMapUv = groundUv;
          #endif
          #ifdef USE_NORMALMAP
            vNormalMapUv = groundUv;
          #endif
          #ifdef USE_ROUGHNESSMAP
            vRoughnessMapUv = groundUv;
          #endif
        `);
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
          #include <normal_fragment_maps>
          #ifdef USE_NORMALMAP
            vec3 groundNormal = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
            normal = normalize(mat3(viewMatrix) * vec3(
              groundNormal.x * normalScale.x, groundNormal.z, groundNormal.y * normalScale.y));
          #endif
        `);
      };
    }
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
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
    this.surfaceMaps.clear();
    this.shadowDepth = undefined;
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
