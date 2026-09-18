import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ViewResources } from './resources';
import { surfaceNames, surfaceUrl } from './surfaces';

describe('generated frontier materials', () => {
  it('ships every map with matching provenance and a relative deployment URL', () => {
    const root = new URL('../../public/textures/frontier/', import.meta.url);
    const manifests = ['manifest.json', 'manifest-rock.json'].map(name =>
      JSON.parse(readFileSync(new URL(name, root), 'utf8')) as {
        maps: { file: string; width: number; height: number; sha256: string }[];
      });
    const maps = manifests.flatMap(manifest => manifest.maps);
    expect(maps).toHaveLength(surfaceNames.length * 3);
    for (const surface of surfaceNames) {
      for (const kind of ['color', 'normal', 'roughness'] as const) {
        const file = `${surface}-${kind}.webp`;
        const data = readFileSync(new URL(file, root));
        const metadata = maps.find(map => map.file === file);
        expect(metadata).toMatchObject({ width: 512, height: 512 });
        expect(createHash('sha256').update(data).digest('hex')).toBe(metadata?.sha256);
        expect(data.toString('ascii', 8, 12)).toBe('WEBP');
        expect(surfaceUrl(surface, kind)).toBe(`${import.meta.env.BASE_URL}textures/frontier/${file}`);
      }
    }
  });

  it('shares color and linear data maps across regional tints and releases them once', () => {
    const textures: THREE.Texture[] = [];
    const completions: (() => void)[] = [];
    const loader: Pick<THREE.TextureLoader, 'load'> = {
      load(_url, onLoad) {
        const texture = new THREE.Texture();
        textures.push(texture);
        completions.push(() => onLoad?.(texture));
        return texture;
      },
    };
    const resources = new ViewResources(loader, 16);
    const first = resources.material('#ffffff', { surface: 'stone' });
    const second = resources.material('#aaaaaa', { surface: 'stone' });
    expect(first).toBeInstanceOf(THREE.MeshStandardMaterial);
    if (!(first instanceof THREE.MeshStandardMaterial) || !(second instanceof THREE.MeshStandardMaterial)) {
      throw new Error('Expected physically based surface materials');
    }
    expect(textures).toHaveLength(3);
    expect(resources.textureStatus.pending).toBe(3);
    completions.forEach(complete => complete());
    expect(resources.textureStatus.pending).toBe(0);
    expect(first.map).toBe(second.map);
    expect(first.normalMap).toBe(second.normalMap);
    expect(first.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(first.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(first.roughnessMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(textures.every(texture => texture.anisotropy === 8 && texture.wrapS === THREE.RepeatWrapping)).toBe(true);
    const disposed = vi.fn();
    textures.forEach(texture => texture.addEventListener('dispose', disposed));
    resources.dispose();
    resources.dispose();
    expect(disposed).toHaveBeenCalledTimes(3);
  });

  it('surfaces failed loads to the shell instead of silently accepting missing textures', () => {
    const failures: (() => void)[] = [];
    const loader: Pick<THREE.TextureLoader, 'load'> = {
      load(_url, _onLoad, _onProgress, onError) {
        failures.push(() => onError?.(new Error('offline')));
        return new THREE.Texture();
      },
    };
    const resources = new ViewResources(loader);
    resources.material('#ffffff', { surface: 'cloth' });
    failures.forEach(fail => fail());
    expect(resources.textureStatus.pending).toBe(0);
    expect(() => resources.assertTextures()).toThrow('Could not load world texture');
    resources.dispose();
  });
});
