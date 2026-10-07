import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface GlbDocument {
  json: GltfJson;
  bin: Uint8Array;
}

export interface GltfJson {
  asset: { version: string; generator?: string };
  scenes?: { name?: string; nodes: number[] }[];
  nodes?: { name?: string; mesh?: number; skin?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; material?: number }[] }[];
  skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  materials?: Record<string, unknown>[];
  textures?: { source?: number; extensions?: Record<string, { source: number }> }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string; name?: string }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; min?: number[]; max?: number[]; normalized?: boolean }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: Record<string, unknown> }[];
  buffers?: { byteLength: number; uri?: string; extensions?: Record<string, unknown> }[];
  animations?: { name?: string; channels: { sampler: number; target: { node?: number; path: string } }[]; samplers: { input: number; output: number; interpolation?: string }[] }[];
  cameras?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extensions?: Record<string, unknown>;
}

export function readGlb(bytes: Uint8Array): GlbDocument {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('Not a glTF 2.0 binary');
  if (view.getUint32(8, true) !== bytes.byteLength) throw new Error('GLB length header does not match the file');
  let at = 12;
  let json: GltfJson | undefined;
  let bin: Uint8Array = new Uint8Array();
  while (at < bytes.byteLength) {
    const length = view.getUint32(at, true);
    const kind = view.getUint32(at + 4, true);
    const payload = bytes.subarray(at + 8, at + 8 + length);
    if (kind === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(payload)) as GltfJson;
    else if (kind === 0x004e4942) bin = payload;
    at += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

export function writeGlb(json: GltfJson, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.byteLength / 4) * 4;
  const binLength = Math.ceil(bin.byteLength / 4) * 4;
  const total = 12 + 8 + jsonLength + (bin.byteLength ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(text, 20);
  if (bin.byteLength) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, 0x004e4942, true);
    out.set(bin, at + 8);
  }
  return out;
}

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/** Image header dimensions for the embedded PNG, WebP and KTX2 textures, without decoding pixels. */
export function imageSize(bytes: Uint8Array): { format: 'png' | 'webp' | 'ktx2'; width: number; height: number; alpha: boolean } {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') {
    const colour = bytes[25];
    return { format: 'png', width: view.getUint32(16), height: view.getUint32(20), alpha: colour === 4 || colour === 6 };
  }
  if (KTX2_IDENTIFIER.every((byte, index) => bytes[index] === byte)) {
    // Alpha from the data format descriptor: Basis UASTC with RGBA channels, Basis ETC1S with an alpha slice, else four samples.
    const block = view.getUint32(48, true) + 4;
    const model = bytes[block + 8];
    const samples = ((view.getUint32(block + 4, true) >>> 16) - 24) / 16;
    const alpha = model === 166 ? (bytes[block + 27]! & 0x0f) === 3 : model === 163 ? samples === 2 : samples === 4;
    return { format: 'ktx2', width: view.getUint32(20, true), height: view.getUint32(24, true), alpha };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const chunk = ascii(12, 16);
    if (chunk === 'VP8X') {
      return { format: 'webp', width: 1 + (bytes[24]! | bytes[25]! << 8 | bytes[26]! << 16),
        height: 1 + (bytes[27]! | bytes[28]! << 8 | bytes[29]! << 16), alpha: (bytes[20]! & 0x10) !== 0 };
    }
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, alpha: ((bits >> 28) & 1) === 1 };
    }
    if (chunk === 'VP8 ') return { format: 'webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff, alpha: false };
  }
  throw new Error('Unsupported embedded image format');
}

export function imageBytes(document: GlbDocument, image: number): Uint8Array {
  const entry = document.json.images?.[image];
  if (!entry || entry.bufferView === undefined) throw new Error(`Image ${image} is not embedded`);
  const view = document.json.bufferViews![entry.bufferView]!;
  return document.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}

/** Node cannot decode images; parse geometry, skin and clips with texture references removed. Geometry and animation
 * data go through the same three.js meshopt decoder as the game's loader (`gltfModelSource`). */
export async function parseGlbWithoutTextures(bytes: Uint8Array, decoder: typeof MeshoptDecoder | null = MeshoptDecoder): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  const document = readGlb(bytes);
  const json: GltfJson = structuredClone(document.json);
  for (const material of json.materials ?? []) {
    for (const key of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) delete material[key];
    const pbr = material.pbrMetallicRoughness as Record<string, unknown> | undefined;
    if (pbr) {
      delete pbr.baseColorTexture;
      delete pbr.metallicRoughnessTexture;
    }
  }
  json.extensionsRequired = (json.extensionsRequired ?? []).filter(name => name !== 'EXT_texture_webp');
  const stripped = writeGlb(json, document.bin);
  const buffer = stripped.buffer.slice(stripped.byteOffset, stripped.byteOffset + stripped.byteLength) as ArrayBuffer;
  const loader = new GLTFLoader();
  if (decoder) loader.setMeshoptDecoder(decoder);
  return new Promise((resolve, reject) => loader.parse(buffer, '', gltf => resolve(gltf), reject));
}

export function loadGlbFile(url: URL): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  return parseGlbWithoutTextures(new Uint8Array(readFileSync(url)));
}
