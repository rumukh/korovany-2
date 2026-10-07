import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createCampaign } from '../src/game';
import { campaignModelIds, MODEL_IDS, TRANSCODED_MODEL_IDS, type ModelId } from '../src/view/models';
import { contextTextureSupport, disposeTextureTranscoder, textureTranscoder, transcodeTargets, type TextureSupport } from '../src/view/textures';
import { imageBytes, imageSize, readGlb } from './glb';

const sources = new URL('../scripts/models/', import.meta.url);
const transcoder = new URL('../node_modules/three/examples/jsm/libs/basis/', import.meta.url);
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const glb = (id: ModelId) => readGlb(new Uint8Array(readFileSync(new URL(`../public/models/${id}/${id}.glb`, import.meta.url))));

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
  test('the transcoder prefers BC7 to ASTC where both exist, keeps three.js\'s choice otherwise and gives software rasterizers RGBA8', () => {
    const support = (names: string[], software = false): TextureSupport => ({ has: name => names.includes(name), software });
    const both = transcodeTargets(support(['WEBGL_compressed_texture_astc', 'EXT_texture_compression_bptc', 'WEBGL_compressed_texture_etc']));
    expect(both.has('WEBGL_compressed_texture_astc')).toBe(false);
    expect(both.has('EXT_texture_compression_bptc')).toBe(true);
    expect(both.has('WEBGL_compressed_texture_etc')).toBe(true);
    const mobile = transcodeTargets(support(['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc']));
    expect(mobile.has('WEBGL_compressed_texture_astc')).toBe(true);
    expect(mobile.has('EXT_texture_compression_bptc')).toBe(false);
    expect(transcodeTargets(support([])).has('WEBGL_compressed_texture_s3tc')).toBe(false);
    // SwiftShader advertises every format but decodes compressed textures on first use; with none, KTX2Loader picks RGBA8.
    const swiftShader = transcodeTargets(support(['WEBGL_compressed_texture_astc', 'EXT_texture_compression_bptc',
      'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_s3tc'], true));
    for (const name of ['WEBGL_compressed_texture_astc', 'EXT_texture_compression_bptc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_s3tc']) {
      expect(swiftShader.has(name), name).toBe(false);
    }
  });

  test('reads compressed formats and software rasterizers from a WebGL context', () => {
    const UNMASKED_RENDERER = 0x9246;
    const context = (renderer: string, extensions: string[]) => ({
      RENDERER: 0x1f01,
      getExtension: (name: string) => name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER }
        : extensions.includes(name) ? {} : null,
      getParameter: (parameter: number) => parameter === UNMASKED_RENDERER ? renderer : 'WebKit WebGL',
    }) as unknown as WebGL2RenderingContext;
    const swiftShader = contextTextureSupport(context(
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', ['EXT_texture_compression_bptc']));
    expect(swiftShader.software).toBe(true);
    expect(swiftShader.has('EXT_texture_compression_bptc')).toBe(true);
    expect(transcodeTargets(swiftShader).has('EXT_texture_compression_bptc')).toBe(false);
    const gpu = contextTextureSupport(context(
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti SUPER (0x00002689) Direct3D11 vs_5_0 ps_5_0, D3D11)', ['EXT_texture_compression_bptc', 'WEBGL_compressed_texture_s3tc']));
    expect(gpu.software).toBe(false);
    expect(transcodeTargets(gpu).has('EXT_texture_compression_bptc')).toBe(true);
    expect(gpu.has('WEBGL_compressed_texture_astc')).toBe(false);
  });

  test('one transcoder serves the page until it is disposed', () => {
    const first = textureTranscoder(() => ({ has: () => false }));
    expect(textureTranscoder()).toBe(first);
    disposeTextureTranscoder();
    const second = textureTranscoder(() => ({ has: () => false }));
    expect(second).not.toBe(first);
    disposeTextureTranscoder();
  });

  test('exactly the listed models ship GPU-compressed maps; every other model ships WebP', () => {
    for (const id of MODEL_IDS) {
      const { json: gltf } = glb(id);
      const transcoded = TRANSCODED_MODEL_IDS.includes(id);
      expect(gltf.extensionsRequired?.includes('KHR_texture_basisu') ?? false, id).toBe(transcoded);
      expect(gltf.extensionsRequired?.includes('EXT_texture_webp') ?? false, id).toBe(!transcoded);
    }
  });

  test('a story campaign requests its GPU-compressed models first, so their maps transcode while the rest download', () => {
    for (const faction of ['elf', 'guard', 'villain'] as const) {
      const ids = campaignModelIds(createCampaign({ seed: 'transcode-order', faction, worldVersion: 3 }).snapshot());
      const transcoded = ids.filter(id => TRANSCODED_MODEL_IDS.includes(id));
      expect(transcoded, faction).toEqual([...TRANSCODED_MODEL_IDS]);
      expect(ids.slice(0, transcoded.length), faction).toEqual(transcoded);
    }
  });

  test.each(TRANSCODED_MODEL_IDS)('%s: UASTC KTX2 maps with full mip chains, recorded against the shipped bytes and transcoder', id => {
    const document = glb(id);
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
