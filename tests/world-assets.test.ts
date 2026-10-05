import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createCampaign } from '../src/game';
import { generateWorld, isWalkable } from '../src/game/world';
import { V3_BUILDINGS, V3_FENCE, V3_PROPS } from '../src/game/world-v3';
import { flockHomes } from '../src/view/fauna';
import {
  deriveSurface, FAUNA_CLIPS, ROCK_VARIANTS, SURFACE_FINISH, SURFACE_METRES, SURFACE_SIZE, TREE_PARTS, TREE_VARIANTS,
  WORLD_MODEL_IDS, WORLD_MODELS, WORLD_SURFACES, WorldAssetLibrary, worldAssetIds, type WorldAssetSource, type WorldModelId,
} from '../src/view/world-assets';
import { imageSize, parseGlbWithoutTextures, readGlb } from './glb';

const shipped = new URL('../public/world/', import.meta.url);
const sources = new URL('../scripts/world/', import.meta.url);
const glb = (id: WorldModelId) => new Uint8Array(readFileSync(new URL(`${id}/${id}.glb`, shipped)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = <T>(url: URL): T => JSON.parse(readFileSync(url, 'utf8')) as T;
const MiB = 1024 * 1024;
/** The approved plan's budgets for world assets: the preload of a version 3 world and any single file. */
const WORLD_PRELOAD_BUDGET = 20 * MiB;
const FILE_BUDGET = 8 * MiB;
const TRIANGLES: Readonly<Record<string, number>> = { kit: 2500, prop: 6000, rock: 400, fauna: 6000 };

interface Provenance {
  id: string;
  kind: string;
  output: { file: string; sha256: string; bytes: number };
  license: string;
  tools: { name: string }[];
  source: { concept?: { sha256: string } };
  cook: { scripts: Record<string, string> };
  limitations: string[];
}

interface Approval {
  asset: string;
  decisions: { gate: string; decision: string; sha256: string }[];
}

function scene(id: WorldModelId) {
  return parseGlbWithoutTextures(glb(id));
}

function triangles(root: THREE.Object3D, filter: (mesh: THREE.Mesh) => boolean = () => true): number {
  let count = 0;
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !filter(object)) return;
    count += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
  });
  return count;
}

/** Every vertex in world space (glTF +Y up), through the nodes' transforms. */
function vertices(root: THREE.Object3D): THREE.Vector3[] {
  root.updateMatrixWorld(true);
  const points: THREE.Vector3[] = [];
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position');
    for (let index = 0; index < position.count; index++) points.push(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld));
  });
  return points;
}

describe('version 3 world assets', () => {
  test('the registry is separate from the cooked characters and matches every v3 obstacle model', () => {
    for (const id of WORLD_MODEL_IDS) expect(statSync(new URL(`${id}/${id}.glb`, shipped)).isFile(), id).toBe(true);
    const models = new Set<string>();
    for (const seed of ['assets-a', 'assets-b']) for (const o of generateWorld(seed, 3).obstacles) if (o.model) models.add(o.model);
    for (const model of models) expect(WORLD_MODEL_IDS, model).toContain(model);
    expect(models).toContain(V3_FENCE.model);
    for (const id of [...Object.keys(V3_BUILDINGS), ...Object.keys(V3_PROPS)]) expect(models, id).toContain(id);
  });

  test.each(WORLD_MODEL_IDS)('%s ships its exact recorded bytes, provenance, approvals and terms', id => {
    const bytes = glb(id);
    const provenance = json<Provenance>(new URL(`assets/${id}/provenance.json`, sources));
    expect(provenance.id).toBe(id);
    expect(provenance.kind).toBe(WORLD_MODELS[id].kind);
    expect(provenance.output).toEqual({ file: `public/world/${id}/${id}.glb`, sha256: sha256(bytes), bytes: bytes.byteLength });
    expect(bytes.byteLength).toBeLessThanOrEqual(FILE_BUDGET);
    const text = readFileSync(new URL(`assets/${id}/provenance.json`, sources), 'utf8');
    expect(text).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|\/home\//);
    expect(provenance.limitations.length).toBeGreaterThan(0);
    const tools = provenance.tools.map(tool => tool.name);
    expect(tools).toContain('Blender 5.2.2 LTS');
    const approval = json<Approval>(new URL(`assets/${id}/approval.json`, sources));
    expect(approval.asset).toBe(id);
    expect(approval.decisions.every(decision => decision.decision === 'accepted')).toBe(true);
    expect(approval.decisions.at(-1)!.sha256).toBe(sha256(bytes));
    if (WORLD_MODELS[id].kind === 'prop' || WORLD_MODELS[id].kind === 'fauna') {
      // TRELLIS-derived: the research-only restriction, the cloud concept tool and the exact concept pixels.
      expect(provenance.license).toMatch(/research and evaluation/i);
      expect(provenance.license).toMatch(/no commercial/i);
      expect(tools).toEqual(expect.arrayContaining(['Azure OpenAI gpt-image-2.5-sunburst', 'TRELLIS-image-large']));
      expect(tools).not.toContain('Qwen Image Edit Plus 2511');
      expect(approval.decisions.map(decision => decision.gate)).toEqual(['concept', 'model', 'in-game']);
      const concept = readFileSync(new URL(`assets/${id}/concept.png`, sources));
      expect(sha256(concept)).toBe(provenance.source.concept!.sha256);
      expect(approval.decisions[0]!.sha256).toBe(provenance.source.concept!.sha256);
    } else {
      expect(provenance.license).toMatch(/no third-party model/i);
      expect(approval.decisions.map(decision => decision.gate)).toEqual(['model', 'in-game']);
    }
    // The committed scripts are the ones that produced these bytes (LF-normalised, as git stores them).
    for (const [name, digest] of Object.entries(provenance.cook.scripts)) {
      const script = readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
      expect(createHash('sha256').update(script).digest('hex'), name).toBe(digest);
    }
  });

  test.each(WORLD_MODEL_IDS)('%s: meshopt-compressed geometry with the parts, surfaces and clips the game draws', async id => {
    const { json: gltf } = readGlb(glb(id));
    expect(gltf.extensionsRequired).toContain('EXT_meshopt_compression');
    const kind = WORLD_MODELS[id].kind;
    // Kit and rock meshes draw from the surface arrays; props, sheep and foliage carry their own WebP maps.
    if (kind === 'kit' || kind === 'rock') expect(gltf.images ?? []).toEqual([]);
    else {
      expect(gltf.images!.length).toBeGreaterThan(0);
      for (const image of gltf.images!) expect(image.mimeType).toBe('image/webp');
    }
    const { scene: root, animations } = await scene(id);
    const meshes: THREE.Mesh[] = [];
    root.traverse(object => { if (object instanceof THREE.Mesh) meshes.push(object); });
    for (const mesh of meshes) expect(mesh.geometry.getAttribute('normal'), mesh.name).toBeDefined();
    if (kind === 'tree') {
      for (let variant = 0; variant < TREE_VARIANTS[id as keyof typeof TREE_VARIANTS]; variant++) {
        for (const part of TREE_PARTS) expect(meshes.some(mesh => mesh.name === `${part}-${variant}`), `${part}-${variant}`).toBe(true);
        const wood = meshes.find(mesh => mesh.name === `lod0-wood-${variant}`)!;
        expect(wood.geometry.getAttribute('uv1')).toBeDefined();
        expect(triangles(root, mesh => mesh.name.endsWith(`-${variant}`)), `variant ${variant}`).toBeLessThanOrEqual(5000);
        expect(triangles(root, mesh => mesh.name === `impostor-${variant}`)).toBe(6);
      }
      return;
    }
    if (kind === 'rock') {
      for (let variant = 0; variant < ROCK_VARIANTS; variant++) {
        const mesh = meshes.find(candidate => candidate.name === `variant-${variant}`);
        expect(mesh?.geometry.getAttribute('uv1'), `variant-${variant}`).toBeDefined();
        expect(triangles(mesh!)).toBeLessThanOrEqual(TRIANGLES.rock!);
      }
      return;
    }
    expect(meshes).toHaveLength(1);
    expect(triangles(root)).toBeLessThanOrEqual(TRIANGLES[kind]!);
    if (kind === 'kit') {
      const layer = meshes[0]!.geometry.getAttribute('uv1');
      expect(layer).toBeDefined();
      // UV1.x is a surface layer index (+0.5) and UV1.y an ambient-occlusion factor.
      for (let index = 0; index < layer.count; index++) {
        const x = layer.getX(index), y = layer.getY(index);
        expect(x - Math.floor(x)).toBeCloseTo(0.5, 2);
        expect(Math.floor(x)).toBeLessThan(WORLD_SURFACES.length);
        expect(y).toBeGreaterThanOrEqual(0.2);
        expect(y).toBeLessThanOrEqual(1.0001);
      }
    }
    if (kind === 'fauna') {
      expect(meshes[0]).toBeInstanceOf(THREE.SkinnedMesh);
      expect(animations.map(clip => clip.name).sort()).toEqual([...FAUNA_CLIPS].sort());
    }
  });

  test.each(Object.keys(V3_BUILDINGS))('%s keeps its walls inside the collider and its eaves within 0.8 m', async id => {
    const { scene: root } = await scene(id as WorldModelId);
    const size = V3_BUILDINGS[id as keyof typeof V3_BUILDINGS];
    const points = vertices(root);
    const tolerance = 0.002;
    let top = 0;
    for (const p of points) {
      top = Math.max(top, p.y);
      expect(p.y).toBeGreaterThanOrEqual(-tolerance);
      const outX = Math.abs(p.x) - size.width / 2, outZ = Math.abs(p.z) - size.length / 2;
      if (p.y < 3) {
        expect(outX, `${id} below 3 m at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`).toBeLessThanOrEqual(tolerance);
        expect(outZ, `${id} below 3 m at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`).toBeLessThanOrEqual(tolerance);
      } else {
        expect(Math.max(outX, outZ)).toBeLessThanOrEqual(0.8 + tolerance);
      }
    }
    // The collider height covers the ridge (chimneys may rise above it).
    expect(top).toBeGreaterThan(size.height - 2.5);
  });

  test('the fence module is 2 m long, inside its 0.24 m collider thickness, and as tall as the generator says', async () => {
    const { scene: root } = await scene('kit-fence');
    const points = vertices(root);
    expect(Math.max(...points.map(p => Math.abs(p.x)))).toBeLessThanOrEqual(V3_FENCE.thickness / 2 + 0.002);
    expect(Math.max(...points.map(p => Math.abs(p.z)))).toBeCloseTo(1, 2);
    expect(Math.max(...points.map(p => p.y))).toBeCloseTo(V3_FENCE.height + 0.15, 1);
  });

  test.each(Object.keys(V3_PROPS))('%s fits the collider the generator gives it', async id => {
    const { scene: root } = await scene(id as WorldModelId);
    const spec = V3_PROPS[id as keyof typeof V3_PROPS];
    const points = vertices(root);
    const height = Math.max(...points.map(p => p.y));
    expect(height).toBeLessThanOrEqual(spec.height + 0.1);
    const low = points.filter(p => p.y < 1.2);
    if ('radius' in spec) {
      for (const p of low) expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(spec.radius + 0.05);
    } else {
      // Box props stand along local Z (their length) as cooked.
      for (const p of low) {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(spec.width / 2 + 0.25);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(spec.length / 2 + 0.25);
      }
    }
  });

  test('every surface layer ships an albedo and a height map at the layer size, with provenance', () => {
    const folders = readdirSync(new URL('textures/', sources));
    const layers = new Map<string, { outputs: Record<string, { file: string; sha256: string; bytes: number }>; tools: { name: string }[] }>();
    for (const folder of folders) {
      const recipe = json<{ layer: string }>(new URL(`textures/${folder}/recipe.json`, sources));
      layers.set(recipe.layer, json(new URL(`textures/${folder}/provenance.json`, sources)));
    }
    expect([...layers.keys()].sort()).toEqual([...WORLD_SURFACES].sort());
    for (const name of WORLD_SURFACES) {
      expect(SURFACE_METRES[name]).toBeGreaterThan(0);
      expect(SURFACE_FINISH[name].roughness).toBeGreaterThan(0);
      const provenance = layers.get(name)!;
      expect(provenance.tools.map(tool => tool.name)).toEqual(['Qwen Image Edit Plus 2511']);
      for (const map of ['albedo', 'height'] as const) {
        const bytes = new Uint8Array(readFileSync(new URL(`surfaces/${name}-${map}.webp`, shipped)));
        expect(provenance.outputs[map]).toEqual({ file: `public/world/surfaces/${name}-${map}.webp`, sha256: sha256(bytes), bytes: bytes.byteLength });
        expect(imageSize(bytes)).toMatchObject({ format: 'webp', width: SURFACE_SIZE, height: SURFACE_SIZE });
      }
    }
  });

  test('a version 3 world preloads at most 20 MiB of world assets; version 1 and 2 worlds load none', () => {
    expect(worldAssetIds(generateWorld('budget', 1))).toEqual([]);
    expect(worldAssetIds(generateWorld('budget', 2))).toEqual([]);
    for (const faction of ['elf', 'guard', 'villain'] as const) {
      const world = createCampaign({ seed: 'budget', faction, runId: 'budget', worldVersion: 3 }).snapshot().world;
      const ids = worldAssetIds(world);
      expect(ids).toContain('char-sheep');
      let bytes = 0;
      for (const id of ids) bytes += statSync(new URL(`${id}/${id}.glb`, shipped)).size;
      for (const name of WORLD_SURFACES) for (const map of ['albedo', 'height']) bytes += statSync(new URL(`surfaces/${name}-${map}.webp`, shipped)).size;
      expect(bytes, faction).toBeLessThanOrEqual(WORLD_PRELOAD_BUDGET);
    }
  });

  test('an obstacle model outside the registry is an error, not a silent primitive', () => {
    const world = generateWorld('unknown-model', 3);
    world.obstacles[0] = { ...world.obstacles[0]!, model: 'kit-castle' };
    expect(() => worldAssetIds(world)).toThrow(/kit-castle is not a registered world asset/);
  });

  test('the library loads each model and the surfaces once, reports readiness, and keeps a failure', async () => {
    const calls = new Map<string, number>();
    const pixels = (size: number) => ({ width: size, height: size, data: new Uint8ClampedArray(size * size * 4).fill(128) });
    const source = (fail?: string): WorldAssetSource => ({
      async model(id) {
        calls.set(id, (calls.get(id) ?? 0) + 1);
        await Promise.resolve();
        if (id === fail) throw new Error('404 Not Found');
        return parseGlbWithoutTextures(glb(id));
      },
      async image(url) {
        calls.set(url, (calls.get(url) ?? 0) + 1);
        return pixels(SURFACE_SIZE);
      },
    });
    const library = new WorldAssetLibrary(source());
    expect(library.isReady).toBe(true);
    const first = library.request(['kit-barn', 'kit-fence']);
    expect(library.isReady).toBe(false);
    await first;
    await library.request(['kit-barn']);
    expect(library.isReady).toBe(true);
    expect(library.status).toEqual({ pending: 0, loaded: 3, total: 3, error: null });
    expect(calls.get('kit-barn')).toBe(1);
    const surfaces = library.surfaces();
    expect(surfaces.albedo.image.depth).toBe(WORLD_SURFACES.length);
    expect(surfaces.albedo.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(surfaces.surface.colorSpace).toBe(THREE.NoColorSpace);
    expect(library.require('kit-barn').bounds.max.y).toBeGreaterThan(8);
    library.dispose();

    const broken = new WorldAssetLibrary(source('kit-shed'));
    await expect(broken.request(['kit-shed'])).rejects.toThrow(/Could not load world model .*kit-shed\.glb: 404 Not Found/);
    expect(broken.isReady).toBe(false);
    expect(broken.status.error).toMatch(/kit-shed/);
    expect(() => broken.assert()).toThrow(/kit-shed/);
    expect(() => broken.require('kit-shed')).toThrow(/kit-shed/);
    broken.dispose();

    const wrongSize: WorldAssetSource = { ...source(), image: async () => pixels(256) };
    const small = new WorldAssetLibrary(wrongSize);
    await expect(small.request(['kit-shed'])).rejects.toThrow(/is 256x256, expected 512x512/);
    small.dispose();
  });

  test('surface data: a flat height map is a flat normal at its finish roughness, and gradients wrap', () => {
    const size = 8;
    const flat = new Float32Array(size * size).fill(0.5);
    const out = new Uint8Array(size * size * 4);
    deriveSurface(flat, size, { relief: 3, roughness: 0.9 }, out, 0);
    for (let index = 0; index < size * size; index++) {
      expect(out[index * 4]).toBe(128);
      expect(out[index * 4 + 1]).toBe(128);
      expect(out[index * 4 + 2]).toBe(Math.round(0.9 * 255));
      expect(out[index * 4 + 3]).toBe(255);
    }
    // A ramp along x that wraps: the first and last columns see their wrapped neighbours.
    const ramp = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) ramp[y * size + x] = x / size;
    deriveSurface(ramp, size, { relief: 3, roughness: 0.9 }, out, 0);
    expect(out[4 * 1]).toBeLessThan(128);
    expect(out[0]).toBeGreaterThan(128);
  });

  test('sheep flocks are deterministic, one per settlement pasture, and start on walkable ground', () => {
    const world = generateWorld('flocks', 3);
    const homes = flockHomes(world);
    expect(homes).toEqual(flockHomes(generateWorld('flocks', 3)));
    expect(homes.length).toBeGreaterThan(3);
    const settlements = homes.map(home => home.id.replace(/-field-\d+$/, ''));
    expect(new Set(settlements).size).toBe(settlements.length);
    for (const home of homes) {
      expect(home.count).toBeGreaterThanOrEqual(5);
      expect(home.count).toBeLessThanOrEqual(9);
      expect(isWalkable(world, home, 0.45), home.id).toBe(true);
    }
    expect(flockHomes(generateWorld('flocks', 2))).toEqual([]);
  });
});
