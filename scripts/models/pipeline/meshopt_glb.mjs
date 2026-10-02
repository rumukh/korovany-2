// Compress a finished cook's geometry and animation data with EXT_meshopt_compression (no lossy filters).
//
// node meshopt_glb.mjs <cook dir> <glb name>
//
// Runs last in a cook, after webp_exact.py and (for skinned bodies) quantize_glb.py, with meshoptimizer's encoder
// (npm meshoptimizer, pinned in the pipeline's package.json). First every triangle-list primitive is reordered for
// locality (meshoptimizer reorderMesh: vertex-cache triangle order, then vertex-fetch vertex order), which the codecs need
// to compress well. The reorder is checked to be a permutation: every vertex keeps its exact attribute bytes, and the
// triangles are the same, with the same winding, in another order. Then every bufferView that holds exactly one accessor
// is encoded: index buffers of triangle lists with the triangle codec, everything else (vertex attributes, skin matrices,
// animation keys) with the attribute codec, element by element. Images stay as they are. No filter is applied, so decoding
// returns the reordered bytes exactly; the triangle codec may only rotate each triangle's first vertex (same triangles,
// order and winding). Both checks run on every view before writing, and the result is recorded in cook.json. three.js
// decodes it with its bundled MeshoptDecoder (GLTFLoader.setMeshoptDecoder).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [cookDir, glbName] = process.argv.slice(2);
const receiptPath = join(cookDir, 'cook.json');
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
// The well's Phase 1 prop cook predates the verification status and is recorded as pending review.
if (!['cooked-pending-verification', 'cooked-pending-review'].includes(receipt.status)) throw new Error(`cook status is ${receipt.status}, expected cooked-pending-verification`);
if (receipt.geometryCompression) throw new Error('already compressed');
const glbPath = join(cookDir, glbName);
const data = readFileSync(glbPath);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (data.readUInt32LE(0) !== 0x46546c67 || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) throw new Error('invalid GLB header');
const jsonLength = data.readUInt32LE(12);
const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8'));
const binStart = 20 + jsonLength + 8;
const bin = Buffer.from(data.subarray(binStart, binStart + data.readUInt32LE(20 + jsonLength)));
if ((json.extensionsUsed ?? []).includes('EXT_meshopt_compression')) throw new Error('already compressed');
if (json.buffers.length !== 1) throw new Error('expected one buffer');
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const views = json.bufferViews;
const usage = views.map(() => ({ accessors: [], indexMode: null, image: false }));
json.accessors.forEach((accessor, index) => {
  if (accessor.sparse) throw new Error(`accessor ${index} is sparse`);
  usage[accessor.bufferView].accessors.push(index);
});
for (const mesh of json.meshes) {
  for (const primitive of mesh.primitives) {
    if (primitive.indices !== undefined) usage[json.accessors[primitive.indices].bufferView].indexMode = (primitive.mode ?? 4) === 4 ? 'TRIANGLES' : 'INDICES';
  }
}
for (const image of json.images ?? []) usage[image.bufferView].image = true;
const viewBytes = view => bin.subarray(views[view].byteOffset ?? 0, (views[view].byteOffset ?? 0) + views[view].byteLength);
const elementSize = accessor => views[accessor.bufferView].byteStride ?? SIZE[accessor.componentType] * WIDTH[accessor.type];

// Reorder for locality; a primitive whose vertex data is shared, or that leaves vertices unreferenced, keeps its order.
const attributeUsers = new Map();
for (const mesh of json.meshes) {
  for (const primitive of mesh.primitives) {
    if (primitive.targets) throw new Error('morph targets are not supported');
    for (const accessor of new Set(Object.values(primitive.attributes))) attributeUsers.set(accessor, (attributeUsers.get(accessor) ?? 0) + 1);
  }
}
const reorder = { primitives: 0, kept: 0, vertices: 0, triangles: 0 };
const canonical = (indices, map) => {
  const keys = [];
  for (let t = 0; t < indices.length; t += 3) {
    let tri = [indices[t], indices[t + 1], indices[t + 2]].map(index => map ? map[index] : index);
    const first = tri.indexOf(Math.min(...tri));
    tri = [tri[first], tri[(first + 1) % 3], tri[(first + 2) % 3]];
    keys.push(`${tri[0]},${tri[1]},${tri[2]}`);
  }
  return keys.sort();
};
for (const mesh of json.meshes) {
  for (const primitive of mesh.primitives) {
    const attributes = [...new Set(Object.values(primitive.attributes))].map(index => json.accessors[index]);
    const vertexCount = json.accessors[primitive.attributes.POSITION].count;
    const movable = (primitive.mode ?? 4) === 4 && primitive.indices !== undefined
      && [...new Set(Object.values(primitive.attributes))].every(index => attributeUsers.get(index) === 1)
      && attributes.every(accessor => accessor.count === vertexCount && (accessor.byteOffset ?? 0) === 0 && usage[accessor.bufferView].accessors.length === 1)
      && usage[json.accessors[primitive.indices].bufferView].accessors.length === 1;
    if (!movable) { reorder.kept++; continue; }
    const indexAccessor = json.accessors[primitive.indices];
    const indexBytes = viewBytes(indexAccessor.bufferView);
    const Index = indexAccessor.componentType === 5123 ? Uint16Array : indexAccessor.componentType === 5125 ? Uint32Array : null;
    if (!Index || (indexAccessor.byteOffset ?? 0) !== 0) { reorder.kept++; continue; }
    const before = new Index(indexBytes.buffer.slice(indexBytes.byteOffset, indexBytes.byteOffset + indexAccessor.count * Index.BYTES_PER_ELEMENT));
    const indices = Uint32Array.from(before);
    const [remap, unique] = MeshoptEncoder.reorderMesh(indices, true, false);
    if (unique !== vertexCount) { reorder.kept++; continue; }
    const seen = new Uint8Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
      if (remap[v] >= vertexCount || seen[remap[v]]) throw new Error('reorderMesh did not return a permutation');
      seen[remap[v]] = 1;
    }
    for (const accessor of attributes) {
      const size = elementSize(accessor);
      const target = viewBytes(accessor.bufferView);
      const source = Buffer.from(target);
      for (let v = 0; v < vertexCount; v++) source.copy(target, remap[v] * size, v * size, v * size + size);
      for (let v = 0; v < vertexCount; v++) {
        if (source.compare(target, remap[v] * size, remap[v] * size + size, v * size, v * size + size) !== 0) throw new Error('vertex lost its attribute bytes');
      }
    }
    const after = new Index(indices);
    if (canonical(before, remap).join(';') !== canonical(after).join(';')) throw new Error('reorder changed the triangles or their winding');
    indexBytes.set(new Uint8Array(after.buffer));
    reorder.primitives++; reorder.vertices += vertexCount; reorder.triangles += indexAccessor.count / 3;
  }
}

const pad = length => (4 - (length % 4)) % 4;
const chunks = [];
let offset = 0;
let fallbackOffset = 0;
const place = payload => {
  const at = offset;
  chunks.push(payload);
  offset += payload.length;
  const padding = pad(offset);
  if (padding) { chunks.push(Buffer.alloc(padding)); offset += padding; }
  return at;
};
const facts = { attributes: { views: 0, raw: 0, packed: 0 }, triangles: { views: 0, raw: 0, packed: 0, rotatedTriangles: 0 }, indices: { views: 0, raw: 0, packed: 0 }, stored: 0 };
json.bufferViews = views.map((view, v) => {
  const bytes = viewBytes(v);
  const use = usage[v];
  const store = () => { facts.stored += bytes.length; return { ...view, buffer: 0, byteOffset: place(bytes) }; };
  if (use.image || use.accessors.length !== 1) return store();
  const accessor = json.accessors[use.accessors[0]];
  if ((accessor.byteOffset ?? 0) !== 0) return store();
  const element = view.byteStride ?? SIZE[accessor.componentType] * WIDTH[accessor.type];
  let mode = use.indexMode ?? 'ATTRIBUTES';
  if (mode === 'ATTRIBUTES' && (element % 4 !== 0 || element > 256)) return store();
  if (mode === 'TRIANGLES' && accessor.count % 3 !== 0) mode = 'INDICES';
  if (mode !== 'ATTRIBUTES' && element !== 2 && element !== 4) return store();
  const count = accessor.count;
  const source = new Uint8Array(bytes.buffer, bytes.byteOffset, count * element);
  const encoded = MeshoptEncoder.encodeGltfBuffer(source, count, element, mode);
  const decoded = new Uint8Array(count * element);
  MeshoptDecoder.decodeGltfBuffer(decoded, count, element, encoded, mode, 'NONE');
  if (mode === 'TRIANGLES') {
    const Type = element === 2 ? Uint16Array : Uint32Array;
    const a = new Type(source.slice().buffer), b = new Type(decoded.buffer);
    for (let t = 0; t < a.length; t += 3) {
      const [x, y, z] = [a[t], a[t + 1], a[t + 2]], [p, q, r] = [b[t], b[t + 1], b[t + 2]];
      if (x === p && y === q && z === r) continue;
      if ((x === q && y === r && z === p) || (x === r && y === p && z === q)) { facts.triangles.rotatedTriangles++; continue; }
      throw new Error(`triangle ${t / 3} of view ${v} did not survive the triangle codec`);
    }
  } else if (!Buffer.from(decoded).equals(Buffer.from(source))) {
    throw new Error(`view ${v} did not survive the ${mode} codec exactly`);
  }
  const bucket = facts[mode.toLowerCase()];
  bucket.views++; bucket.raw += source.length; bucket.packed += encoded.length;
  const at = place(Buffer.from(encoded));
  const fallback = fallbackOffset;
  fallbackOffset += source.length + pad(source.length);
  const out = { buffer: 1, byteOffset: fallback, byteLength: source.length,
    extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: at, byteLength: encoded.length, byteStride: element, count, mode } } };
  if (view.byteStride) out.byteStride = view.byteStride;
  if (view.target) out.target = view.target;
  return out;
});
// The fallback buffer has no data: EXT_meshopt_compression is required, so loaders never read it.
json.buffers = [{ byteLength: offset }, { byteLength: fallbackOffset, extensions: { EXT_meshopt_compression: { fallback: true } } }];
for (const key of ['extensionsUsed', 'extensionsRequired']) json[key] = [...new Set([...(json[key] ?? []), 'EXT_meshopt_compression'])].sort();
let text = Buffer.from(JSON.stringify(json));
text = Buffer.concat([text, Buffer.alloc(pad(text.length), 0x20)]);
const body = Buffer.concat(chunks);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + text.length + 8 + body.length, 8);
const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(text.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(body.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, jsonHeader, text, binHeader, body]);
writeFileSync(glbPath, result);

const requireFromHere = createRequire(import.meta.url);
const encoderVersion = JSON.parse(readFileSync(requireFromHere.resolve('meshoptimizer/package.json'), 'utf8')).version;
receipt.geometryCompression = {
  extension: 'EXT_meshopt_compression', encoder: `meshoptimizer ${encoderVersion} (npm)`, script: 'meshopt_glb.mjs',
  scriptSha256: sha(readFileSync(new URL(import.meta.url))), filters: 'none',
  reorder: { method: 'meshoptimizer reorderMesh: vertex-cache triangle order, then vertex-fetch vertex order', ...reorder,
    check: 'a permutation: every vertex keeps its exact attribute bytes, and the triangles are the same, with the same winding, in another order' },
  check: 'every view decoded again: attribute views byte-identical to the reordered data; triangle index views hold the same triangles in the same order and winding (only the first vertex may rotate)',
  views: facts, inputSha256: sha(data), bytesBefore: data.length, bytesAfter: result.length,
};
receipt.output = { file: glbName, bytes: result.length, sha256: sha(result),
  images: (json.images ?? []).map(image => [image.name ?? null, json.bufferViews[image.bufferView].byteLength]) };
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`MESHOPT=${JSON.stringify({ bytes: [data.length, result.length], reorder, views: facts })}`);
