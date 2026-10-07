import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { LANDMARK_IDS, type ModelId } from '../src/view/models';
import { disposeTextureTranscoder, textureTranscoder, transcodeTargets, type TextureSupport } from '../src/view/textures';
import { imageBytes, imageSize, readGlb } from './glb';

/** Models whose maps ship GPU-compressed (Basis Universal UASTC in KTX2); every other model ships WebP. */
const KTX2_MODELS: ModelId[] = [...LANDMARK_IDS, 'prop-echo-well'];
const sources = new URL('../scripts/models/', import.meta.url);
const transcoder = new URL('../node_modules/three/examples/jsm/libs/basis/', import.meta.url);
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

interface TextureCompression {
  extension: string;
  encoder: { sha256: string; license: string };
  transcoder: { sha256: Record<string, string> };
  images: { image: string; role: 'colour' | 'data' | 'normal'; sha256: string; levels: number; transcodedTo: string[];
    mip0: { psnr: number }; mip2: { psnr: number } }[];
}

/** The KTX2 fields the loader relies on, from the file header and its data format descriptor. */
function ktx2(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dfd = view.getUint32(48, true) + 4;
  return {
    vkFormat: view.getUint32(12, true), layers: view.getUint32(32, true), faces: view.getUint32(36, true),
    levels: view.getUint32(40, true), supercompression: view.getUint32(44, true),
    colorModel: bytes[dfd + 8], transfer: bytes[dfd + 10],
  };
}

describe('GPU-compressed model textures', () => {
  test('the transcoder prefers BC7 to ASTC where both exist and otherwise keeps three.js\'s choice', () => {
    const support = (names: string[]): TextureSupport => ({ has: name => names.includes(name) });
    const both = transcodeTargets(support(['WEBGL_compressed_texture_astc', 'EXT_texture_compression_bptc', 'WEBGL_compressed_texture_etc']));
    expect(both.has('WEBGL_compressed_texture_astc')).toBe(false);
    expect(both.has('EXT_texture_compression_bptc')).toBe(true);
    expect(both.has('WEBGL_compressed_texture_etc')).toBe(true);
    const mobile = transcodeTargets(support(['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc']));
    expect(mobile.has('WEBGL_compressed_texture_astc')).toBe(true);
    expect(mobile.has('EXT_texture_compression_bptc')).toBe(false);
    expect(transcodeTargets(support([])).has('WEBGL_compressed_texture_s3tc')).toBe(false);
  });

  test('one transcoder serves the page until it is disposed', () => {
    const first = textureTranscoder(() => ({ has: () => false }));
    expect(textureTranscoder()).toBe(first);
    disposeTextureTranscoder();
    const second = textureTranscoder(() => ({ has: () => false }));
    expect(second).not.toBe(first);
    disposeTextureTranscoder();
  });

  test.each(KTX2_MODELS)('%s: UASTC KTX2 maps with full mip chains, recorded against the shipped bytes and transcoder', id => {
    const document = readGlb(new Uint8Array(readFileSync(new URL(`../public/models/${id}/${id}.glb`, import.meta.url))));
    const { json: gltf } = document;
    expect(gltf.extensionsRequired).toContain('KHR_texture_basisu');
    expect(gltf.extensionsUsed).not.toContain('EXT_texture_webp');
    const material = gltf.materials![0]! as { pbrMetallicRoughness: { baseColorTexture: { index: number } } };
    const colour = gltf.textures![material.pbrMetallicRoughness.baseColorTexture.index]!.extensions!['KHR_texture_basisu']!.source;
    for (const texture of gltf.textures!) {
      // No fallback image: without the transcoder the model fails to load instead of drawing something else.
      expect(texture.source).toBeUndefined();
      expect(texture.extensions!['KHR_texture_basisu']!.source).toBeTypeOf('number');
    }
    const provenance = JSON.parse(readFileSync(new URL(`${id}/provenance.json`, sources), 'utf8')) as {
      cook: { scripts: Record<string, string>; textureCompression: TextureCompression };
    };
    const record = provenance.cook.textureCompression;
    expect(record.extension).toBe('KHR_texture_basisu');
    expect(record.encoder).toMatchObject({ sha256: 'b42d951b1bf146133578e8c7927ad4a4a857552846a46a3ee33b541b2a06bc7d', license: 'Apache-2.0' });
    expect(Object.keys(provenance.cook.scripts)).toEqual(expect.arrayContaining(['ktx2_glb.py', 'ktx2_tool.mjs', 'meshopt_glb.mjs']));
    // The files were verified with the transcoder the game ships.
    for (const [file, digest] of Object.entries(record.transcoder.sha256)) expect(sha256(readFileSync(new URL(file, transcoder))), file).toBe(digest);
    expect(gltf.images).toHaveLength(record.images.length);
    for (const [index, image] of gltf.images!.entries()) {
      const bytes = imageBytes(document, index);
      expect(image.mimeType).toBe('image/ktx2');
      expect(imageSize(bytes)).toEqual({ format: 'ktx2', width: 1024, height: 1024, alpha: false });
      const entry = record.images.find(candidate => candidate.image === image.name)!;
      expect(entry.sha256, image.name).toBe(sha256(bytes));
      expect(entry.transcodedTo, image.name).toEqual(['ASTC 4x4', 'BC7', 'BC1/BC3', 'ETC1/ETC2', 'PVRTC1', 'RGBA8']);
      // The cook measured each level against a box-filtered reference: mip 0 for close-ups, mip 2 for gameplay distance.
      expect(entry.mip0.psnr, image.name).toBeGreaterThan(38);
      expect(entry.mip2.psnr, image.name).toBeGreaterThan(33);
      // Basis UASTC, Zstandard, one 2D image with every level down to 1x1; base colour sRGB, data and normals linear.
      expect(ktx2(bytes), image.name).toEqual({ vkFormat: 0, layers: 0, faces: 1, levels: 11, supercompression: 2, colorModel: 166,
        transfer: index === colour ? 2 : 1 });
      expect(entry.role === 'colour', image.name).toBe(index === colour);
    }
  });
});
