import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import {
  deriveSurface, SURFACE_ALBEDO_PART_LAYERS, SURFACE_ALBEDO_PARTS, SURFACE_FINISH, SURFACE_LEVELS, SURFACE_SIZE, surfaceAlbedoUrl, surfaceUrl,
  WORLD_SURFACES, WorldAssetLibrary, type WorldAssetSource,
} from '../src/view/world-assets';
import { imageSize, parseGlbWithoutTextures } from './glb';
import { fakeSurfaceAlbedo } from './world-surfaces';

const shipped = new URL('../public/world/surfaces/', import.meta.url);
const record = new URL('../scripts/world/surface-albedo/', import.meta.url);
const transcoder = new URL('../node_modules/three/examples/jsm/libs/basis/', import.meta.url);
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const json = <T>(url: URL): T => JSON.parse(readFileSync(url, 'utf8')) as T;
/** Committed text as git stores it (LF), whatever the checkout's line endings. */
const lf = (url: URL) => readFileSync(url, 'utf8').replaceAll('\r\n', '\n');
/** The world plan's budget for any one deployed world file. */
const FILE_BUDGET = 8 * 1024 * 1024;

interface Finish { relief: number; roughness: number }
interface Recipe {
  size: number;
  layers: ({ name: string } & Finish)[];
  parts: { file: string; layers: number }[];
  maxFileBytes: number;
  basisu: string[];
  fixture: { seed: number; size: number; finishes: Finish[] };
}
interface FileRecord { file: string; sha256: string; bytes: number }
interface Provenance {
  outputs: (FileRecord & { firstLayer: number; layers: number; levels: number; width: number })[];
  inputs: { layer: string; albedo: FileRecord; height: FileRecord }[];
  license: string;
  tools: { name: string; sha256?: string | Record<string, string> }[];
  cook: { scripts: Record<string, string>; recipe: { file: string; sha256: string }; encoder: { arguments: string[] } };
  derivation: { fixture: Recipe['fixture'] & { sha256: string } };
  verification: { targets: string[]; psnr: { colour: Record<string, { min: number; median: number }>; roughness: Record<string, { min: number; median: number }> } };
}
interface Approval { asset: string; decisions: { gate: string; decision: string; files: { file: string; sha256: string }[]; delegation?: string }[] }

const recipe = json<Recipe>(new URL('recipe.json', record));
const provenance = json<Provenance>(new URL('provenance.json', record));
const parts = Array.from({ length: SURFACE_ALBEDO_PARTS }, (_, part) => ({
  part, file: `surfaces-albedo-${part}.ktx2`, bytes: new Uint8Array(readFileSync(new URL(`surfaces-albedo-${part}.ktx2`, shipped))),
}));

describe('the world surface albedo array', () => {
  test('holds every surface layer in the game\'s order with the game\'s finishes, in parts of consecutive layers', () => {
    expect(recipe.size).toBe(SURFACE_SIZE);
    expect(recipe.layers.map(layer => layer.name)).toEqual([...WORLD_SURFACES]);
    for (const { name, relief, roughness } of recipe.layers) expect({ relief, roughness }, name).toEqual(SURFACE_FINISH[name as keyof typeof SURFACE_FINISH]);
    expect(SURFACE_ALBEDO_PART_LAYERS * SURFACE_ALBEDO_PARTS).toBe(WORLD_SURFACES.length);
    expect(recipe.parts).toEqual(parts.map(({ file }) => ({ file, layers: SURFACE_ALBEDO_PART_LAYERS })));
    expect(recipe.maxFileBytes).toBe(FILE_BUDGET);
    for (const { part, file } of parts) expect(surfaceAlbedoUrl(part)).toBe(`${import.meta.env.BASE_URL}world/surfaces/${file}`);
  });

  test('each part ships as an sRGB UASTC KTX2 array of its layers with the full mip chain, Zstandard-compressed, within 8 MiB', () => {
    for (const { file, bytes } of parts) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(bytes.byteLength, file).toBeLessThanOrEqual(FILE_BUDGET);
      expect(imageSize(bytes), file).toEqual({ format: 'ktx2', width: SURFACE_SIZE, height: SURFACE_SIZE, alpha: true });
      expect(view.getUint32(12, true), `${file} vkFormat: Basis Universal`).toBe(0);
      expect(view.getUint32(28, true), `${file} pixelDepth`).toBe(0);
      expect(view.getUint32(32, true), `${file} layers`).toBe(SURFACE_ALBEDO_PART_LAYERS);
      expect(view.getUint32(36, true), `${file} faces`).toBe(1);
      expect(view.getUint32(40, true), `${file} levels`).toBe(SURFACE_LEVELS);
      expect(view.getUint32(44, true), `${file} supercompression: Zstandard`).toBe(2);
      const block = view.getUint32(48, true) + 4;
      expect(bytes[block + 8], `${file} colour model: UASTC`).toBe(166);
      expect(bytes[block + 9], `${file} primaries: BT.709`).toBe(1);
      expect(bytes[block + 10], `${file} transfer: sRGB`).toBe(2);
    }
  });

  test('records its bytes, the layer files it was built from, the scripts, the encoder and the shipped transcoder', () => {
    expect(provenance.outputs).toEqual(parts.map(({ part, file, bytes }) => expect.objectContaining({
      file: `public/world/surfaces/${file}`, sha256: sha256(bytes), bytes: bytes.byteLength,
      firstLayer: part * SURFACE_ALBEDO_PART_LAYERS, layers: SURFACE_ALBEDO_PART_LAYERS, levels: SURFACE_LEVELS, width: SURFACE_SIZE,
    })));
    // Built from the layers' current cooked WebPs: re-cooking a layer without rebuilding the parts fails here.
    expect(provenance.inputs.map(input => input.layer)).toEqual([...WORLD_SURFACES]);
    for (const input of provenance.inputs) {
      for (const map of ['albedo', 'height'] as const) {
        const file = new Uint8Array(readFileSync(new URL(`${input.layer}-${map}.webp`, shipped)));
        expect(input[map], `${input.layer} ${map}`).toEqual({ file: `public/world/surfaces/${input.layer}-${map}.webp`, sha256: sha256(file), bytes: file.byteLength });
      }
    }
    expect(surfaceUrl(WORLD_SURFACES[0])).toBe(`${import.meta.env.BASE_URL}world/surfaces/${WORLD_SURFACES[0]}-height.webp`);
    expect(Object.keys(provenance.cook.scripts).sort()).toEqual(['world/pipeline/surface_albedo_ktx2.py', 'world/pipeline/surface_tool.mjs']);
    for (const [name, digest] of Object.entries(provenance.cook.scripts)) {
      expect(sha256(lf(new URL(`../scripts/${name}`, import.meta.url))), name).toBe(digest);
    }
    expect(provenance.cook.recipe).toEqual({ file: 'recipe.json', sha256: sha256(lf(new URL('recipe.json', record))) });
    expect(provenance.cook.encoder.arguments).toEqual(['-tex_array', '-mipmap', '-mip_filter', 'box', '-no_multithreading', '-ktx2', ...recipe.basisu]);
    const tools = Object.fromEntries(provenance.tools.map(tool => [tool.name, tool]));
    expect(tools['Basis Universal']?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Verified with the transcoder the game ships: every layer of every level to every format three.js may pick.
    expect(tools['three.js Basis Universal transcoder']?.sha256).toEqual({
      'basis_transcoder.js': sha256(readFileSync(new URL('basis_transcoder.js', transcoder))),
      'basis_transcoder.wasm': sha256(readFileSync(new URL('basis_transcoder.wasm', transcoder))),
    });
    expect(provenance.verification.targets).toEqual(['ASTC 4x4', 'BC7', 'ETC1/ETC2', 'BC1/BC3', 'PVRTC1', 'RGBA8']);
    expect(provenance.verification.psnr.colour.level0!.min).toBeGreaterThanOrEqual(35);
    expect(provenance.verification.psnr.roughness.level0!.min).toBeGreaterThanOrEqual(39);
    expect(provenance.license).toMatch(/no photograph, third-party texture or TRELLIS output/);
  });

  test('derives each layer\'s roughness exactly as the game does (deriveSurface on the recorded fixture)', () => {
    const { seed, size, finishes, sha256: recorded } = provenance.derivation.fixture;
    expect({ seed, size, finishes }).toEqual(recipe.fixture);
    let state = seed;
    const heights = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      heights[i] = (state >>> 24) / 255;
    }
    const out = new Uint8Array(size * size * 4 * finishes.length);
    finishes.forEach((finish, index) => deriveSurface(heights, size, finish, out, index * size * size * 4));
    expect(sha256(out)).toBe(recorded);
  });

  test('the library joins the parts in layer order at every level, and a missing or mismatched part fails the load', async () => {
    const shed = new Uint8Array(readFileSync(new URL('../public/world/kit-shed/kit-shed.glb', import.meta.url)));
    const source = (albedo: (part: number) => Promise<THREE.Texture>): WorldAssetSource => ({
      model: () => parseGlbWithoutTextures(shed),
      image: async () => ({ width: SURFACE_SIZE, height: SURFACE_SIZE, data: new Uint8ClampedArray(SURFACE_SIZE * SURFACE_SIZE * 4).fill(128) }),
      surfaceAlbedo: albedo,
    });
    const library = new WorldAssetLibrary(source(async part => fakeSurfaceAlbedo({ fill: part + 1, bytesPerLayer: 4 })));
    await library.request(['kit-shed']);
    const albedo = library.surfaces().albedo;
    expect(albedo.image).toEqual({ width: SURFACE_SIZE, height: SURFACE_SIZE, depth: WORLD_SURFACES.length });
    expect(albedo.format).toBe(THREE.RGBA_BPTC_Format);
    expect(albedo.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(albedo.mipmaps).toHaveLength(SURFACE_LEVELS);
    albedo.mipmaps!.forEach((level, index) => {
      expect(level.width, `level ${index}`).toBe(Math.max(1, SURFACE_SIZE >> index));
      const expected = new Uint8Array(WORLD_SURFACES.length * 4);
      for (let part = 0; part < SURFACE_ALBEDO_PARTS; part++) expected.fill(part + 1, part * SURFACE_ALBEDO_PART_LAYERS * 4, (part + 1) * SURFACE_ALBEDO_PART_LAYERS * 4);
      expect(level.data, `level ${index}`).toEqual(expected);
    });
    library.dispose();

    const failures: [string, (part: number) => Promise<THREE.Texture>, RegExp][] = [
      ['missing', async part => { if (part === 1) throw new Error('HTTP 404'); return fakeSurfaceAlbedo(); }, /Could not load world surface textures: HTTP 404/],
      ['layers', async part => fakeSurfaceAlbedo({ layers: part === 1 ? WORLD_SURFACES.length : SURFACE_ALBEDO_PART_LAYERS }),
        /surfaces-albedo-1\.ktx2 has 32 layers, expected 16/],
      ['levels', async part => fakeSurfaceAlbedo({ levels: part === 0 ? 1 : SURFACE_LEVELS }), /surfaces-albedo-0\.ktx2 has 1 mip levels, expected 10/],
      ['format', async part => fakeSurfaceAlbedo({ format: part === 1 ? THREE.RGBA_ASTC_4x4_Format : THREE.RGBA_BPTC_Format }),
        /surfaces-albedo-1\.ktx2 was transcoded to another format than .*surfaces-albedo-0\.ktx2/],
    ];
    for (const [name, albedoPart, error] of failures) {
      const broken = new WorldAssetLibrary(source(albedoPart));
      await expect(broken.request(['kit-shed']), name).rejects.toThrow(error);
      expect(broken.isReady, name).toBe(false);
      expect(() => broken.surfaces(), name).toThrow(error);
      broken.dispose();
    }
  });

  test('passed its delegated in-game review with these bytes', () => {
    const approval = json<Approval>(new URL('approval.json', record));
    expect(approval.asset).toBe('surface-albedo');
    expect(approval.decisions.every(decision => decision.decision === 'accepted')).toBe(true);
    expect(approval.decisions.map(decision => decision.gate)).toEqual(['in-game']);
    expect(approval.decisions[0]!.files).toEqual(parts.map(({ file, bytes }) => ({ file: `public/world/surfaces/${file}`, sha256: sha256(bytes) })));
    expect(approval.decisions[0]!.delegation).toBe('_reviews/delegation-2026-10-04-world.json');
  });
});
