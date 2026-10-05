import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { createCampaign, type FactionId } from '../src/game';
import type { Obstacle, Vec2, WorldBlueprint, WorldLocation } from '../src/game/types';
import { distance, generateWorld, isWalkable, obstacleClearance, segmentClearance } from '../src/game/world';
import { V3_BUILDINGS, V3_DECOR, V3_MODULES, V3_PROPS, V3_ROUND } from '../src/game/world-v3';
import { Presentation } from '../src/view';
import { crowHomes } from '../src/view/fauna';
import { LANDMARK_PLACES } from '../src/view/models';
import { ViewResources } from '../src/view/resources';
import { SURFACE_SIZE, WorldAssetLibrary, worldAssetIds, type WorldAssetSource, type WorldModelId } from '../src/view/world-assets';
import { parseGlbWithoutTextures } from './glb';

const SEEDS = ['castles', 'assets-a', 42] as const;
const worlds = SEEDS.map(seed => generateWorld(seed, 3));
const RUINS = ['thornwatch', 'last-archive', 'drowned-archive', 'tax-vault', 'old-orchard', 'glass-quarry'];

function place(world: WorldBlueprint, id: string): WorldLocation {
  return world.exploration!.locations.find(l => l.id === id)!;
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

/** Points every half metre from a to b that a body of `radius` cannot stand on. */
function blocked(world: WorldBlueprint, a: Vec2, b: Vec2, radius: number): Vec2[] {
  const steps = Math.ceil(distance(a, b) * 2);
  const out: Vec2[] = [];
  for (let step = 0; step <= steps; step++) {
    const p = { x: a.x + (b.x - a.x) * step / steps, z: a.z + (b.z - a.z) * step / steps };
    if (!isWalkable(world, p, radius)) out.push(p);
  }
  return out;
}

/** The two end centres of a box run along its local Z. */
function runEnds(o: Obstacle): [Vec2, Vec2] {
  const { halfZ, heading } = o.shape!;
  const along = { x: Math.sin(heading) * halfZ, z: Math.cos(heading) * halfZ };
  return [{ x: o.x - along.x, z: o.z - along.z }, { x: o.x + along.x, z: o.z + along.z }];
}

describe('version 3 castles, ruins and landmarks', () => {
  test('the Royal Citadel keeps its courtyard open for the final battle and gates the Crownbridge road', () => {
    for (const world of worlds) {
      const citadel = place(world, 'palace-citadel'), crownbridge = place(world, 'crownbridge');
      const pieces = world.obstacles.filter(o => o.id.startsWith('palace-citadel-'));
      expect(pieces.filter(o => o.model === 'kit-keep')).toHaveLength(1);
      expect(pieces.filter(o => o.model === 'kit-tower-round').length).toBeGreaterThanOrEqual(6);
      expect(pieces.filter(o => o.model === 'kit-curtain').length).toBeGreaterThanOrEqual(5);
      // The villain's Palace Marshal is leashed 22 m to the centre: nothing solid stands within 23.5 m of it.
      for (const o of world.obstacles) {
        if (distance(o, citadel) < 120) expect(obstacleClearance(o, citadel), o.id).toBeGreaterThanOrEqual(23.5);
      }
      // One gate arch, centred over the Crownbridge road, and the road walkable at convoy width through it.
      const gates = (world.decor ?? []).filter(d => d.id.startsWith('palace-citadel-'));
      expect(gates).toHaveLength(1);
      expect(segmentDistance(gates[0]!, crownbridge, citadel)).toBeLessThan(1e-6);
      expect(blocked(world, crownbridge, citadel, 1.5)).toEqual([]);
    }
  });

  test('the Old Fort becomes a ring fort with a gate over each road and an open mustering yard', () => {
    for (const world of worlds) {
      const fort = place(world, 'old-fort');
      expect(world.obstacles.some(o => o.id.startsWith('old-fort-wall-') || o.id.startsWith('old-fort-building-'))).toBe(false);
      const pieces = world.obstacles.filter(o => o.id.startsWith('old-fort-'));
      expect(pieces.filter(o => o.model === 'kit-tower-round' || o.model === 'kit-tower-ruin').length).toBeGreaterThanOrEqual(6);
      expect(pieces.filter(o => o.model === 'kit-tower-ruin')).toHaveLength(1);
      expect(pieces.filter(o => o.model === 'kit-tower-square')).toHaveLength(1);
      expect(pieces.filter(o => o.model === 'kit-curtain-ruin').length).toBeGreaterThanOrEqual(1);
      for (const o of world.obstacles) {
        if (distance(o, fort) < 80) expect(obstacleClearance(o, fort), o.id).toBeGreaterThanOrEqual(16.5);
      }
      const roads = world.roads.edges.filter(edge => edge.from === fort.id || edge.to === fort.id);
      const gates = (world.decor ?? []).filter(d => d.id.startsWith('old-fort-'));
      expect(gates).toHaveLength(roads.length);
      for (const edge of roads) {
        const other = world.roads.nodes.find(n => n.id === (edge.from === fort.id ? edge.to : edge.from))!;
        expect(gates.some(gate => segmentDistance(gate, fort, other) < 1e-6), other.id).toBe(true);
        expect(blocked(world, fort, other, 1.5), other.id).toEqual([]);
      }
    }
  });

  test.each(['elf', 'guard', 'villain'] as FactionId[])('every %s actor starts on open ground; the villain storms the citadel courtyard', faction => {
    const snapshot = createCampaign({ seed: 'castles', faction, runId: 'castles', worldVersion: 3 }).snapshot();
    const world = snapshot.world;
    for (const actor of snapshot.actors) expect(isWalkable(world, actor, actor.radius), actor.id).toBe(true);
    const fortress = world.sites.find(site => site.id === 'fortress')!;
    if (faction === 'villain') {
      expect(distance(fortress, place(world, 'palace-citadel'))).toBe(0);
      const home = world.sites.find(site => site.kind === 'home')!;
      expect(distance(home, place(world, 'old-fort'))).toBe(0);
      // The route the convoy and the army take from the Old Fort to the citadel follows open road.
      const byId = new Map(world.roads.nodes.map(n => [n.id, n]));
      for (const edge of world.roads.edges.filter(e => e.from === 'fortress' || e.to === 'fortress' || e.from === 'home' || e.to === 'home')) {
        expect(blocked(world, byId.get(edge.from)!, byId.get(edge.to)!, 1.5), `${edge.from} -> ${edge.to}`).toEqual([]);
      }
    }
  });

  test('round pieces collide as circles of their width and curtain runs end inside a tower at both ends', () => {
    for (const world of worlds) {
      const towers = world.obstacles.filter(o => o.model === 'kit-tower-round' || o.model === 'kit-tower-ruin' || o.model === 'kit-tower-square'
        || o.model === 'kit-keep');
      for (const o of world.obstacles.filter(o => o.model && V3_ROUND.has(o.model))) {
        expect(o.shape, o.id).toBeUndefined();
        expect(o.radius, o.id).toBeCloseTo(V3_BUILDINGS[o.model as keyof typeof V3_BUILDINGS].width / 2, 9);
      }
      const runs = world.obstacles.filter(o => o.model === 'kit-curtain' || o.model === 'kit-curtain-ruin');
      expect(runs.length).toBeGreaterThan(10);
      for (const run of runs) {
        expect(run.shape!.halfX * 2, run.id).toBeCloseTo(V3_BUILDINGS['kit-curtain'].width, 9);
        // Free-standing ruined stretches are whole modules; fortress runs bury both ends in towers.
        if (!run.id.includes('-curtain-')) continue;
        expect(run.shape!.halfZ * 2, run.id).toBeGreaterThanOrEqual(V3_MODULES['kit-curtain']! * 0.75);
        for (const end of runEnds(run)) {
          expect(towers.some(tower => obstacleClearance(tower, end) <= -0.99), `${run.id} end ${end.x.toFixed(1)},${end.z.toFixed(1)}`).toBe(true);
        }
      }
    }
  });

  test('ruins, shrines and landmarks are rebuilt round their kept cooked landmarks', () => {
    const v2 = generateWorld('castles', 2);
    for (const world of worlds) {
      for (const id of RUINS) {
        const ruin = place(world, id);
        const pieces = world.obstacles.filter(o => o.id.startsWith(`${id}-piece-`) && o.model && o.model in V3_BUILDINGS);
        expect(pieces.length, id).toBeGreaterThanOrEqual(1);
        for (const piece of pieces) expect(distance(piece, ruin), piece.id).toBeLessThan(40);
      }
      expect(world.obstacles.filter(o => o.id.startsWith('old-orchard-tree-')).length).toBeGreaterThan(40);
      // Every location keeps exactly the v2 buildings that carry its cooked landmark or well; they only grow.
      for (const location of world.exploration!.locations) {
        const kept = world.obstacles.filter(o => o.id.startsWith(`${location.id}-building-`));
        const landmark = Object.hasOwn(LANDMARK_PLACES, location.id) || location.id === 'name-well';
        if (!landmark) {
          expect(kept, location.id).toEqual([]);
          continue;
        }
        expect(kept.length, location.id).toBeGreaterThanOrEqual(1);
        for (const o of kept) {
          const original = v2.obstacles.find(candidate => candidate.id === o.id)!;
          expect(o.model, o.id).toBeUndefined();
          expect({ x: o.x, z: o.z }).toEqual({ x: original.x, z: original.z });
          expect(o.radius, o.id).toBeGreaterThanOrEqual(original.radius);
          for (const edge of world.roads.edges) {
            const a = world.roads.nodes.find(n => n.id === edge.from)!, b = world.roads.nodes.find(n => n.id === edge.to)!;
            expect(segmentClearance(o, a, b) - edge.width / 2, `${o.id} by ${edge.from}-${edge.to}`).toBeGreaterThanOrEqual(
              Math.min(1, segmentClearance(original, a, b) - edge.width / 2) - 1e-9);
          }
        }
      }
    }
  });

  test('military posts keep their four circular footings, now timber watch towers', () => {
    for (const world of worlds) {
      for (const site of world.sites.filter(s => s.kind !== 'home' && s.kind !== 'raid')) {
        const towers = world.obstacles.filter(o => o.id.startsWith(`${site.id}-wall-`));
        expect(towers, site.id).toHaveLength(4);
        for (const tower of towers) {
          expect(tower.model).toBe('kit-camp-tower');
          expect(tower.radius).toBe(1.8);
          expect(tower.shape).toBeUndefined();
        }
      }
    }
  });

  test('remains of huge creatures lie in the wilds, well off the roads and away from every place', () => {
    for (const world of worlds) {
      const remains = world.obstacles.filter(o => o.id.startsWith('remains-'));
      expect(new Set(remains.map(o => o.model))).toEqual(new Set(['prop-giant-skull', 'prop-giant-ribs', 'prop-troll-gibbet', 'prop-standing-stones']));
      for (const o of remains) {
        expect(o.model! in V3_PROPS, o.id).toBe(true);
        for (const location of world.exploration!.locations) expect(obstacleClearance(o, location), o.id).toBeGreaterThanOrEqual(40);
        for (const edge of world.roads.edges) {
          const a = world.roads.nodes.find(n => n.id === edge.from)!, b = world.roads.nodes.find(n => n.id === edge.to)!;
          expect(segmentClearance(o, a, b) - edge.width / 2, o.id).toBeGreaterThanOrEqual(5);
        }
      }
    }
  });

  test('crows gather at the skulls, ribcages and troll gibbets, on open ground beside them', () => {
    for (const world of worlds) {
      const remains = world.obstacles.filter(o => o.id.startsWith('remains-') && o.model !== 'prop-standing-stones');
      const homes = crowHomes(world);
      for (const o of remains) {
        const home = homes.find(candidate => candidate.id === o.id);
        expect(home, o.id).toBeDefined();
        expect(isWalkable(world, home!, 0.5), o.id).toBe(true);
        expect(obstacleClearance(o, home!), o.id).toBeLessThan(2);
      }
    }
  });

  test('decor is presentation only and exists only in version 3 worlds', () => {
    for (const world of worlds) {
      expect(world.decor!.length).toBeGreaterThanOrEqual(3);
      for (const decor of world.decor!) {
        expect(decor.model in V3_DECOR, decor.id).toBe(true);
        expect(world.obstacles.some(o => o.id === decor.id || (o.model === decor.model))).toBe(false);
      }
    }
    for (const version of [1, 2] as const) expect(generateWorld('castles', version).decor).toBeUndefined();
  });
});

describe('version 3 castle presentation (DOM-free)', () => {
  const shipped = new URL('../public/world/', import.meta.url);
  const nodeSource: WorldAssetSource = {
    model: (id: WorldModelId) => parseGlbWithoutTextures(new Uint8Array(readFileSync(new URL(`${id}/${id}.glb`, shipped)))),
    image: async () => ({ width: SURFACE_SIZE, height: SURFACE_SIZE, data: new Uint8ClampedArray(SURFACE_SIZE * SURFACE_SIZE * 4).fill(128) }),
  };

  test('draws curtains as repeated modules and the gate arches as decor, and gives kept landmarks the sightline cutaway', async () => {
    const snapshot = createCampaign({ seed: 'castle-view', faction: 'villain', runId: 'castle-view', worldVersion: 3 }).snapshot();
    const world = snapshot.world;
    const library = new WorldAssetLibrary(nodeSource);
    await library.request(worldAssetIds(world));
    expect(worldAssetIds(world)).toContain('kit-gate-arch');
    const resources = new ViewResources(undefined, 1, undefined, library);
    const view = new Presentation(world, resources);
    try {
      const pools = new Map<string, THREE.InstancedMesh>();
      view.scene.traverse(object => { if (object instanceof THREE.InstancedMesh) pools.set(object.name, object); });
      const capacity = (name: string) => pools.get(name)?.instanceMatrix.count ?? 0;
      // One instance per decor piece, per round tower and per curtain module (6 m, rounded along each run).
      expect(capacity('kit-gate-arch:0:near')).toBe(world.decor!.length);
      expect(capacity('kit-camp-tower:0:near')).toBe(world.obstacles.filter(o => o.model === 'kit-camp-tower').length);
      for (const model of ['kit-curtain', 'kit-curtain-ruin']) {
        const modules = world.obstacles.filter(o => o.model === model)
          .reduce((sum, o) => sum + Math.max(1, Math.round(2 * Math.max(o.shape!.halfX, o.shape!.halfZ) / V3_MODULES[model]!)), 0);
        expect(capacity(`${model}:0:near`), model).toBe(modules);
      }
      // Near the citadel gate, an arch is submitted exactly over its decor position.
      const gate = world.decor!.find(d => d.id.startsWith('palace-citadel-'))!;
      const frame = structuredClone(snapshot);
      frame.player.x = gate.x;
      frame.player.z = gate.z - 20;
      frame.tick += 1;
      const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.25, 290);
      camera.position.set(gate.x, 14, gate.z - 42);
      camera.lookAt(gate.x, 0, gate.z);
      camera.updateMatrixWorld();
      view.update(frame, 1 / 60, camera, true);
      const arches = pools.get('kit-gate-arch:0:near')!;
      expect(arches.count).toBeGreaterThan(0);
      const placed = new THREE.Matrix4(), position = new THREE.Vector3();
      const positions = Array.from({ length: arches.count }, (_, index) => {
        arches.getMatrixAt(index, placed);
        return position.setFromMatrixPosition(placed).clone();
      });
      expect(positions.some(p => Math.hypot(p.x - gate.x, p.z - gate.z) < 1e-3)).toBe(true);
      // Every kept v2 structure (the cooked landmarks' footprints) is drawn with the camera-to-hero cutaway.
      const structures: THREE.Mesh[] = [];
      view.scene.traverse(object => {
        if (object instanceof THREE.Mesh && object.parent?.name.startsWith('world-structures')) structures.push(object);
      });
      expect(structures.length).toBeGreaterThan(0);
      for (const mesh of structures) {
        const material = mesh.material as THREE.Material;
        expect(material.customProgramCacheKey(), mesh.name).toBe('korovany-sightline-v1');
      }
    } finally {
      view.dispose();
      library.dispose();
    }
  }, 120_000);
});

describe('version 3 castle kit models', () => {
  const shipped = new URL('../public/world/', import.meta.url);
  async function points(id: string): Promise<THREE.Vector3[]> {
    const { scene } = await parseGlbWithoutTextures(new Uint8Array(readFileSync(new URL(`${id}/${id}.glb`, shipped))));
    scene.updateMatrixWorld(true);
    const out: THREE.Vector3[] = [];
    scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const position = object.geometry.getAttribute('position');
      for (let index = 0; index < position.count; index++) out.push(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld));
    });
    return out;
  }

  test.each([...V3_ROUND])('%s stays inside its circle below 3 m and within 0.8 m of it above', async id => {
    const radius = V3_BUILDINGS[id as keyof typeof V3_BUILDINGS].width / 2;
    for (const p of await points(id)) {
      const reach = Math.hypot(p.x, p.z);
      expect(reach, `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`).toBeLessThanOrEqual(radius + (p.y < 3 ? 0.002 : 0.8));
    }
  });

  test.each(['kit-curtain', 'kit-curtain-ruin'])('%s is one module long along local Z', async id => {
    const all = await points(id);
    expect(Math.max(...all.map(p => Math.abs(p.z)))).toBeCloseTo(V3_MODULES[id]! / 2, 3);
    expect(Math.max(...all.map(p => Math.abs(p.x)))).toBeLessThanOrEqual(V3_BUILDINGS['kit-curtain'].width / 2 + 0.002);
  });

  test('the gate arch leaves the passage clear below its springing and buries its ends in the gate towers', async () => {
    const arch = V3_DECOR['kit-gate-arch'];
    const all = await points('kit-gate-arch');
    expect(Math.min(...all.map(p => p.y))).toBeGreaterThanOrEqual(arch.spring - 0.002);
    expect(Math.max(...all.map(p => p.y))).toBeLessThanOrEqual(arch.height + 0.002);
    expect(Math.max(...all.map(p => Math.abs(p.z)))).toBeCloseTo(arch.span / 2 + arch.embed, 3);
    // Both end faces lie inside the round gate towers (20-sided bodies with an inscribed radius of at least 3.95 m from
    // the plinth to the parapet), so the façades run into the towers' curved faces without a gap.
    const tower = arch.span / 2 + V3_BUILDINGS['kit-tower-round'].width / 2;
    const ends = all.filter(p => Math.abs(p.z) > arch.span / 2 + arch.embed - 0.01);
    expect(ends.length).toBeGreaterThan(8);
    for (const p of ends) {
      expect(Math.hypot(p.x, Math.abs(p.z) - tower), `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`).toBeLessThanOrEqual(3.95);
    }
  });
});
