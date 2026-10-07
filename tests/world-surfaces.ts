import * as THREE from 'three';
import { SURFACE_ALBEDO_PART_LAYERS, SURFACE_LEVELS, SURFACE_SIZE } from '../src/view/world-assets';

/**
 * A stand-in for one part of the albedo surface array as the KTX2 transcoder returns it, for tests that build a
 * WorldAssetLibrary outside a browser: square sRGB layers with a full mip chain, by default a part's size, layer count and
 * levels. Its levels hold `bytesPerLayer` bytes per layer set to `fill` (none by default: nothing is uploaded in these
 * tests).
 */
export function fakeSurfaceAlbedo({ size = SURFACE_SIZE, levels = SURFACE_LEVELS, layers = SURFACE_ALBEDO_PART_LAYERS, fill = 0, bytesPerLayer = 0,
  format = THREE.RGBA_BPTC_Format as THREE.CompressedPixelFormat }: {
  size?: number; levels?: number; layers?: number; fill?: number; bytesPerLayer?: number; format?: THREE.CompressedPixelFormat;
} = {}): THREE.CompressedArrayTexture {
  const mipmaps = Array.from({ length: levels }, (_, level) => {
    const width = Math.max(1, size >> level);
    return { data: new Uint8Array(layers * bytesPerLayer).fill(fill), width, height: width };
  });
  const texture = new THREE.CompressedArrayTexture(mipmaps, size, size, layers, format);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
