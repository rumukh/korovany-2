import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { parseBeasts } from '../src/audio/manifest';
import { createCampaign, generateWorld, restoreCampaign } from '../src/game';
import { MONSTERS, MONSTER_RULES } from '../src/game/monsters';
import type { FactionId, GameInput, GameSession, GameSnapshot, MonsterSnapshot, MonsterSpecies, Vec2, WorldBlueprint, WorldLair } from '../src/game/types';
import { isWalkable, lakeClearance, monsterLairs, obstacleClearance, projectSegment } from '../src/game/world';
import { CHAPEL_SHRINES, HAUNTS, LAIR_RULES, V3_BUILDINGS } from '../src/game/world-v3';

// W4b: barrow ghouls at opened barrows on the Ash Steppe and bog trolls in the Fens and on the Frostspine. Their haunts
// sit beside the W4a wolves' lairs (`WorldBlueprint.haunts`), whose placement W4b leaves exactly as it was.
type Save = ReturnType<GameSession['serialize']> & { engine: { entities: { components: { KorovanyCombatant: Record<string, unknown> } }[];
  resources: { KorovanyCampaign: Record<string, unknown> & { player: Vec2; spawner?: { sequence: number; timer: number;
    lairs: Record<string, { cooldown: number }> }; pickups: unknown[] } } } };

const save = (session: GameSession): Save => structuredClone(session.serialize()) as Save;
const near = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
const seeds = ['wolves-a', 'wolves-b', 0, 42];

function regionAt(world: WorldBlueprint, p: Vec2): string | undefined {
  return world.exploration!.regions.find(r => p.x >= r.bounds.minX && p.x <= r.bounds.maxX && p.z >= r.bounds.minZ && p.z <= r.bounds.maxZ)?.id;
}

/** A walkable hero spot `reach` metres from `centre`, farther than `apart` from every other lair and haunt. */
function spot(world: WorldBlueprint, centre: Vec2, reach: number, apart = 0): Vec2 {
  for (let index = 0; index < 144; index++) {
    const angle = index / 144 * Math.PI * 2;
    const p = { x: centre.x + Math.sin(angle) * reach, z: centre.z + Math.cos(angle) * reach };
    if (isWalkable(world, p, 0.65) && monsterLairs(world).every(lair => lair === centre || near(lair, p) > apart)) return p;
  }
  throw new Error(`no walkable spot ${reach} m from ${JSON.stringify(centre)}`);
}

function placed(session: GameSession, at: Vec2, edit?: (value: Save) => void): GameSession {
  const value = save(session);
  Object.assign(value.engine.resources.KorovanyCampaign.player, { x: at.x, z: at.z });
  edit?.(value);
  return restoreCampaign(value);
}

/** Lets the test runner's worker breathe: long simulations otherwise starve its RPC (as tests/faction-driver.ts does). */
const breathe = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function until(session: GameSession, ticks: number, done: (snapshot: GameSnapshot) => boolean,
  input: (snapshot: GameSnapshot) => GameInput = () => ({})): Promise<number> {
  let tick = 0;
  for (; tick < ticks && !done(session.snapshot()); tick++) {
    session.step(input(session.snapshot()));
    if (tick % 60 === 59) await breathe();
  }
  return tick;
}

const pack = (snapshot: GameSnapshot, lairId: string): MonsterSnapshot[] => (snapshot.monsters ?? []).filter(m => m.lairId === lairId);

/** A campaign whose haunt has its beasts: the hero stood 120 m away (beyond 160 m of every other lair and haunt) for a tick. */
function staged(faction: FactionId, seed: string | number, haunt: (world: WorldBlueprint) => WorldLair) {
  let session = createCampaign({ seed, faction, worldVersion: 3 });
  const world = session.snapshot().world;
  const lair = haunt(world);
  session = placed(session, spot(world, lair, 120, 170));
  session.step({});
  return { session, world, lair };
}
const first = (species: MonsterSpecies) => (world: WorldBlueprint): WorldLair => world.haunts!.find(h => h.species === species)!;

/** Aims and attacks the nearest living beast; stands still. */
const hunter = (snapshot: GameSnapshot): GameInput => {
  const prey = (snapshot.monsters ?? []).filter(m => m.hp > 0).sort((a, b) => near(a, snapshot.player) - near(b, snapshot.player))[0];
  return prey ? { attack: true, aim: { x: prey.x - snapshot.player.x, z: prey.z - snapshot.player.z } } : {};
};

describe('W4b barrow ghouls and bog trolls', () => {
  test('version 3 worlds keep ghoul haunts on the Ash Steppe and troll haunts in the Fens and Frostspine, clear of everything', () => {
    for (const seed of seeds) {
      const world = generateWorld(seed, 3);
      const haunts = world.haunts!;
      const species = (name: MonsterSpecies) => haunts.filter(h => h.species === name);
      expect(species('ghoul').length, `${seed}`).toBeGreaterThanOrEqual(2);
      expect(species('troll').length, `${seed}`).toBeGreaterThanOrEqual(1);
      expect(new Set(monsterLairs(world).map(l => l.id)).size).toBe(monsterLairs(world).length);
      const roads = world.roads.edges.map(e => ({ a: world.roads.nodes.find(n => n.id === e.from)!, b: world.roads.nodes.find(n => n.id === e.to)!, half: e.width / 2 }));
      for (const haunt of haunts) {
        const region = regionAt(world, haunt)!;
        expect(HAUNTS[region]?.map(plan => plan.species), haunt.id).toContain(haunt.species);
        expect(haunt.id.startsWith(`haunt-${region}-`)).toBe(true);
        expect(haunt.radius).toBe(LAIR_RULES.radius);
        for (const location of world.exploration!.locations) {
          const settled = location.kind === 'settlement' || location.kind === 'inn' || CHAPEL_SHRINES.has(location.id);
          expect(near(haunt, location) - location.radius, `${haunt.id} ${location.id}`).toBeGreaterThanOrEqual(settled ? LAIR_RULES.settled : LAIR_RULES.location);
        }
        for (const site of world.sites) expect(near(haunt, site) - site.radius, `${haunt.id} ${site.id}`).toBeGreaterThanOrEqual(LAIR_RULES.site);
        for (const road of roads) expect(near(haunt, projectSegment(haunt, road.a, road.b)) - road.half).toBeGreaterThanOrEqual(LAIR_RULES.road);
        for (const lake of world.lakes ?? []) expect(lakeClearance(lake, haunt)).toBeGreaterThanOrEqual(LAIR_RULES.lake);
        for (const other of monsterLairs(world)) if (other !== haunt) expect(near(haunt, other), `${haunt.id} ${other.id}`).toBeGreaterThanOrEqual(LAIR_RULES.lair);
        // The clearing is open; only the haunt's own pieces stand on its rim, beyond where its beasts appear.
        const inside = world.obstacles.filter(o => obstacleClearance(o, haunt) < haunt.radius);
        expect(inside.every(o => o.id.startsWith(`${haunt.id}-piece-`)), `${haunt.id}: ${inside.map(o => o.id)}`).toBe(true);
        const pieces = world.obstacles.filter(o => o.id.startsWith(`${haunt.id}-piece-`));
        expect(pieces[0]!.model).toBe(haunt.species === 'ghoul' ? 'kit-barrow' : 'prop-giant-skull');
        const radius = MONSTERS[haunt.species].radius;
        for (const piece of pieces) expect(obstacleClearance(piece, haunt)).toBeGreaterThan(MONSTER_RULES.scatter + radius);
        for (let index = 0; index < 24; index++) {
          const angle = index / 24 * Math.PI * 2;
          for (const r of [0, 3, MONSTER_RULES.scatter]) {
            expect(isWalkable(world, { x: haunt.x + Math.sin(angle) * r, z: haunt.z + Math.cos(angle) * r }, radius)).toBe(true);
          }
        }
      }
    }
  });

  test('the wolves keep the lairs W4a gave them: haunts are placed after, from their own random stream', () => {
    // generateWorld('wolves-a', 3)'s lairs as W4a shipped them (main 62c3e6e).
    const lairs = generateWorld('wolves-a', 3).lairs!.map(l => `${l.id}@${l.x},${l.z}`);
    expect(lairs).toEqual(['lair-greenmarch-0@65.24,-365.32', 'lair-greenmarch-1@-72.89,-324.14', 'lair-greenmarch-2@-191,-395.1',
      'lair-hollowvale-0@173.85,407.18', 'lair-hollowvale-1@386.18,192.27', 'lair-hollowvale-2@412.93,413.12']);
  });

  test('the barrow is a low turf mound inside its 14 x 8 m footprint; a troll is twice a soldier and shoulders a corridor', () => {
    expect(V3_BUILDINGS['kit-barrow']).toEqual({ width: 14, length: 8, height: 3.2 });
    expect(MONSTERS.troll.radius).toBeGreaterThan(MONSTERS.ghoul.radius);
    expect(MONSTERS.troll.pack).toEqual([1, 1]);
    // Every haunt's beasts fit the 12-beast cap with the wolves' largest packs.
    expect(MONSTERS.ghoul.pack[1] + MONSTERS.wolf.pack[1] * 2).toBeLessThanOrEqual(MONSTER_RULES.cap);
  });

  for (const species of ['ghoul', 'troll'] as const) {
    test(`a ${species} appears at its haunt only while the hero is 90-160 m away, and is saved and validated`, async () => {
      let session = createCampaign({ seed: 'wolves-a', faction: 'elf', worldVersion: 3 });
      const world = session.snapshot().world;
      const haunt = first(species)(world);
      for (const reach of [60, 200]) {
        const quiet = placed(session, spot(world, haunt, reach, 170));
        await until(quiet, 70, () => false);
        expect(pack(quiet.snapshot(), haunt.id), `${reach} m`).toEqual([]);
      }
      session = placed(session, spot(world, haunt, 120, 170));
      session.step({});
      const beasts = pack(session.snapshot(), haunt.id);
      expect(beasts.length).toBeGreaterThanOrEqual(MONSTERS[species].pack[0]);
      expect(beasts.length).toBeLessThanOrEqual(MONSTERS[species].pack[1]);
      for (const beast of beasts) {
        expect(beast).toMatchObject({ species, hp: MONSTERS[species].hp, maxHp: MONSTERS[species].hp, radius: MONSTERS[species].radius,
          attackRange: MONSTERS[species].attackRange, target: null, home: { x: haunt.x, z: haunt.z } });
        expect(near(beast, haunt)).toBeLessThanOrEqual(MONSTER_RULES.scatter);
      }
      expect(session.snapshot().actors.every(a => !a.id.startsWith('monster-'))).toBe(true);
      expect(() => restoreCampaign(save(session))).not.toThrow();
      // Validation knows each species: a ghoul's stats on a troll (or the reverse) are rejected.
      const other: MonsterSpecies = species === 'ghoul' ? 'troll' : 'ghoul';
      const forged = save(session);
      const entity = forged.engine.entities.find(e => e.components.KorovanyCombatant.siteId === haunt.id)!.components.KorovanyCombatant;
      entity.species = other;
      expect(() => restoreCampaign(forged)).toThrow();
      const stronger = save(session);
      stronger.engine.entities.find(e => e.components.KorovanyCombatant.siteId === haunt.id)!.components.KorovanyCombatant.damage = MONSTERS[species].damage + 1;
      expect(() => restoreCampaign(stronger)).toThrow();
    });
  }

  test('trolls round the giant skull to reach a hero behind it, ghouls fight in the open, and every faction hero wins', async () => {
    const results: string[] = [];
    for (const species of ['ghoul', 'troll'] as const) {
      for (const faction of ['elf', 'guard', 'villain'] as const) {
        for (const seed of ['wolves-a', 'wolves-b', 0]) {
          await breathe();
          const { session: start, world, lair } = staged(faction, seed, first(species));
          // The hero waits just past the far side of the haunt's main piece (the barrow or the skull) when that is still
          // inside the beasts' aggro radius (the skull: about 18 m out), so they must go round it; otherwise 12 m out.
          const main = world.obstacles.find(o => o.id === `${lair.id}-piece-0`)!;
          const out = { x: (main.x - lair.x) / near(main, lair), z: (main.z - lair.z) / near(main, lair) };
          let behind: Vec2 | null = null;
          for (let r = near(main, lair); r < MONSTERS[species].aggro - 1 && !behind; r += 0.25) {
            const p = { x: lair.x + out.x * r, z: lair.z + out.z * r };
            if (obstacleClearance(main, p) >= 2 && isWalkable(world, p, 0.65)) behind = p;
          }
          const at = behind ?? spot(world, lair, 12);
          if (species === 'troll') expect(behind, `${faction}/${seed}: a spot behind the skull`).not.toBeNull();
          const session = placed(start, at);
          const maxHp = session.snapshot().player.maxHp;
          let lowest = maxHp;
          const ticks = await until(session, 60 * 40, s => !pack(s, lair.id).some(m => m.hp > 0), s => {
            lowest = Math.min(lowest, s.player.hp);
            return hunter(s);
          });
          const snapshot = session.snapshot();
          const label = `${species}/${faction}/${seed}`;
          expect(snapshot.phase, label).toBe('playing');
          expect(pack(snapshot, lair.id).every(m => m.hp === 0), `${label} killed in ${ticks / 60} s`).toBe(true);
          // The beasts land blows (the villain's life-steal may heal the hero back to full by the end).
          const dip = (maxHp - lowest) / maxHp;
          results.push(`${label} ${(dip * 100).toFixed(0)}%`);
          expect(dip, label).toBeGreaterThan(0.02);
          expect(dip, label).toBeLessThan(0.8);
        }
      }
    }
    console.info('W4b stand-up fights (lowest health, as health lost)', results.join(', '));
  }, 300_000);

  test('a troll\'s slam is a long telegraph the hero can step out of', async () => {
    const { session: start, world, lair } = staged('guard', 'wolves-a', first('troll'));
    let session = placed(start, spot(world, lair, 12));
    await until(session, 60 * 20, s => pack(s, lair.id).some(m => m.state === 'windup'));
    const troll = pack(session.snapshot(), lair.id).find(m => m.state === 'windup')!;
    expect(troll.stateTime).toBeGreaterThan(0.6);
    const hp = session.snapshot().player.hp;
    // Step straight back out of reach during the windup: the slam misses.
    const away = (s: GameSnapshot): GameInput => {
      const t = pack(s, lair.id)[0]!, d = near(t, s.player) || 1;
      return { move: { x: (s.player.x - t.x) / d, z: (s.player.z - t.z) / d } };
    };
    await until(session, 90, s => pack(s, lair.id)[0]!.state === 'recovery', away);
    expect(pack(session.snapshot(), lair.id)[0]!.state).toBe('recovery');
    expect(session.snapshot().player.hp).toBe(hp);
    session = restoreCampaign(JSON.parse(JSON.stringify(session.serialize())));
    expect(session.snapshot().monsters!.length).toBeGreaterThan(0);
  });

  test('the beasts\' voices ship beside the wolf\'s: each species howls, snarls, yelps and dies, from the committed synthesis', () => {
    const root = new URL('../', import.meta.url);
    const beasts = parseBeasts(JSON.parse(readFileSync(new URL('public/audio/beasts/manifest.json', root), 'utf8')));
    const ids = beasts.map(asset => asset.id);
    for (const species of ['wolf', 'ghoul', 'troll']) {
      for (const voice of ['howl', 'snarl', 'yelp', 'death']) expect(ids, `${species} ${voice}`).toContain(`beast-${species}-${voice}`);
    }
    const provenance = JSON.parse(readFileSync(new URL('scripts/audio/beasts-provenance.json', root), 'utf8')) as {
      script: { path: string; sha256: string }; imports: { path: string; sha256: string }[] };
    expect(provenance.script.path).toBe('scripts/audio/synth_beasts_w4b.py');
    for (const script of [provenance.script, ...provenance.imports]) {
      const text = readFileSync(new URL(script.path, root), 'utf8').replaceAll('\r\n', '\n');
      expect(createHash('sha256').update(text).digest('hex'), script.path).toBe(script.sha256);
    }
  });
});

describe('W4b haunts leave older worlds alone', () => {
  let world1: WorldBlueprint, world2: WorldBlueprint;
  beforeAll(() => {
    world1 = generateWorld('wolves-a', 1);
    world2 = generateWorld('wolves-a', 2);
  });
  test('version 1 and 2 worlds have no haunts', () => {
    expect(world1.haunts).toBeUndefined();
    expect(world2.haunts).toBeUndefined();
    expect(monsterLairs(world2)).toEqual([]);
  });
});
