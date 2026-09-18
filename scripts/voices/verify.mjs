import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative, isAbsolute } from 'node:path';

const [inventoryPath, publicPath] = process.argv.slice(2);
if (!inventoryPath || !publicPath) throw new Error('Usage: node scripts\\voices\\verify.mjs <inventory.json> <public-directory>');
const publicRoot = resolve(publicPath);
const inventory = JSON.parse(await readFile(resolve(inventoryPath), 'utf8'));
const manifest = JSON.parse(await readFile(join(publicRoot, 'audio', 'voices', 'manifest.json'), 'utf8'));
const provenance = JSON.parse(await readFile(join(publicRoot, 'audio', 'voices', 'provenance.json'), 'utf8'));
if (manifest.version !== 1 || provenance.inventory_source_hash !== inventory.sourceHash) throw new Error('Stale or invalid voice manifest');
const keys = new Set();
const byId = new Map(manifest.entries.map(entry => [entry.id, entry]));
if (byId.size !== inventory.entries.length || byId.size !== manifest.entries.length) throw new Error('Incomplete or duplicate voice entries');
let clipCount = 0;
const verified = new Set();
for (const expected of inventory.entries) {
  const entry = byId.get(expected.id);
  if (!entry || ['speaker', 'language', 'text'].some(key => entry[key] !== expected[key])) throw new Error(`Source mismatch ${expected.id}`);
  const key = JSON.stringify([entry.speaker, entry.language, entry.text]);
  if (keys.has(key)) throw new Error(`Ambiguous exact voice lookup ${entry.id}`);
  keys.add(key);
  if (entry.clips.length !== expected.segments.length) throw new Error(`Missing voice segments ${entry.id}`);
  for (const [index, clip] of entry.clips.entries()) {
    if (!clip.src.startsWith('audio/voices/') || !clip.src.endsWith('.ogg') ||
      (provenance.segment_clips ? provenance.segment_clips[expected.segments[index].id] !== clip.src :
        !clip.src.includes(`/${expected.segments[index].id}-`)) ||
      !Number.isFinite(clip.duration) || clip.duration <= 0) throw new Error(`Invalid voice clip ${entry.id}`);
    const path = resolve(publicRoot, ...clip.src.split('/'));
    const rel = relative(publicRoot, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`External voice path ${clip.src}`);
    clipCount++;
    if (verified.has(clip.src)) continue;
    if (!(await stat(path)).isFile()) throw new Error(`Missing voice file ${clip.src}`);
    const bytes = await readFile(path);
    if (bytes.subarray(0, 4).toString() !== 'OggS') throw new Error(`Not an Ogg file ${clip.src}`);
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (provenance.clip_sha256[clip.src] !== sha) throw new Error(`Modified voice file ${clip.src}`);
    verified.add(clip.src);
  }
}
console.log(JSON.stringify({ entries: keys.size, clips: clipCount, uniqueClips: verified.size, languages: ['ru', 'en'], complete: true }));
