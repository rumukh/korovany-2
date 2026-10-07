import { beforeAll, describe, expect, test } from 'vitest';
import { createCampaign, generateWorld, restoreCampaign } from '../src/game';
import { MONSTERS, MONSTER_RULES } from '../src/game/monsters';
import type { FactionId, GameInput, GameSession, GameSnapshot, MonsterSnapshot, Vec2, WorldBlueprint } from '../src/game/types';
import { distance, isWalkable, lakeClearance, obstacleClearance, projectSegment } from '../src/game/world';
import { CHAPEL_SHRINES, LAIR_RULES, LAIRS } from '../src/game/world-v3';
import { battleInput, playBattle } from './driver';

// W4a: grave wolves. Lairs are part of a version 3 world; packs appear, hunt the hero and are saved as combatants.
type Save = ReturnType<GameSession['serialize']> & { engine: { entities: { components: { KorovanyCombatant: Record<string, unknown> } }[];
  resources: { KorovanyCampaign: Record<string, unknown> & { player: Vec2; spawner?: { sequence: number; timer: number;
    lairs: Record<string, { cooldown: number }> }; pickups: unknown[] } } } };

const save = (session: GameSession): Save => structuredClone(session.serialize()) as Save;
const near = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);

function regionAt(world: WorldBlueprint, p: Vec2): string | undefined {
  return world.exploration!.regions.find(r => p.x >= r.bounds.minX && p.x <= r.bounds.maxX && p.z >= r.bounds.minZ && p.z <= r.bounds.maxZ)?.id;
}

/** A walkable hero spot `reach` metres from `centre`, farther than `apart` from every other lair. */
function spot(world: WorldBlueprint, centre: Vec2, reach: number, apart = 0): Vec2 {
  for (let index = 0; index < 144; index++) {
    const angle = index / 144 * Math.PI * 2;
    const p = { x: centre.x + Math.sin(angle) * reach, z: centre.z + Math.cos(angle) * reach };
    if (isWalkable(world, p, 0.65) && world.lairs!.every(lair => lair === centre || near(lair, p) > apart)) return p;
  }
  throw new Error(`no walkable spot ${reach} m from ${JSON.stringify(centre)}`);
}

/** The session restored from its own save with the hero moved to `at` (and the save otherwise edited by `edit`). */
function placed(session: GameSession, at: Vec2, edit?: (value: Save) => void): GameSession {
  const value = save(session);
  Object.assign(value.engine.resources.KorovanyCampaign.player, { x: at.x, z: at.z });
  edit?.(value);
  return restoreCampaign(value);
}

/** Lets the test runner's worker breathe: long simulations otherwise starve its RPC (as tests/faction-driver.ts does). */
const breathe = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function run(session: GameSession, ticks: number, input: (snapshot: GameSnapshot) => GameInput = () => ({})): Promise<void> {
  for (let tick = 0; tick < ticks; tick++) {
    session.step(input(session.snapshot()));
    if (tick % 60 === 59) await breathe();
  }
}

/** Steps with `input` until `done` or `ticks`, breathing every simulated second. */
async function until(session: GameSession, ticks: number, done: (snapshot: GameSnapshot) => boolean,
  input: (snapshot: GameSnapshot) => GameInput = () => ({})): Promise<void> {
  for (let tick = 0; tick < ticks && !done(session.snapshot()); tick++) {
    session.step(input(session.snapshot()));
    if (tick % 60 === 59) await breathe();
  }
}

const pack = (snapshot: GameSnapshot, lairId: string): MonsterSnapshot[] => (snapshot.monsters ?? []).filter(m => m.lairId === lairId);

/** A campaign whose first lair has a pack: the hero stood 120 m away (beyond 160 m of every other lair) for one tick. */
function staged(faction: FactionId, seed: string) {
  let session = createCampaign({ seed, faction, worldVersion: 3 });
  const world = session.snapshot().world;
  const lair = world.lairs![0]!;
  session = placed(session, spot(world, lair, 120, 170));
  session.step({});
  return { session, world, lair };
}

/** Aims and attacks the nearest living beast; stands still. */
const hunter = (snapshot: GameSnapshot): GameInput => {
  const prey = (snapshot.monsters ?? []).filter(m => m.hp > 0)
    .sort((a, b) => near(a, snapshot.player) - near(b, snapshot.player))[0];
  return prey ? { attack: true, aim: { x: prey.x - snapshot.player.x, z: prey.z - snapshot.player.z } } : {};
};

describe('W4a grave wolves', () => {
  const seeds = ['wolves-a', 'wolves-b', 0, 42];

  test('version 3 worlds keep wolf lairs in the dark forests, clear of people, roads, water and each other', () => {
    for (const seed of seeds) {
      const world = generateWorld(seed, 3);
      const lairs = world.lairs!;
      expect(lairs.length, `${seed}`).toBeGreaterThanOrEqual(3);
      expect(new Set(lairs.map(l => l.id)).size).toBe(lairs.length);
      const roads = world.roads.edges.map(e => ({ a: world.roads.nodes.find(n => n.id === e.from)!, b: world.roads.nodes.find(n => n.id === e.to)!, half: e.width / 2 }));
      for (const lair of lairs) {
        const region = regionAt(world, lair)!;
        expect(Object.keys(LAIRS), lair.id).toContain(region);
        expect(lair.id.startsWith(`lair-${region}-`)).toBe(true);
        expect(lair.species).toBe('wolf');
        expect(lair.radius).toBe(LAIR_RULES.radius);
        for (const location of world.exploration!.locations) {
          const settled = location.kind === 'settlement' || location.kind === 'inn' || CHAPEL_SHRINES.has(location.id);
          expect(near(lair, location) - location.radius, `${lair.id} ${location.id}`).toBeGreaterThanOrEqual(settled ? LAIR_RULES.settled : LAIR_RULES.location);
        }
        for (const site of world.sites) expect(near(lair, site) - site.radius, `${lair.id} ${site.id}`).toBeGreaterThanOrEqual(LAIR_RULES.site);
        for (const road of roads) expect(near(lair, projectSegment(lair, road.a, road.b)) - road.half).toBeGreaterThanOrEqual(LAIR_RULES.road);
        for (const lake of world.lakes ?? []) expect(lakeClearance(lake, lair)).toBeGreaterThanOrEqual(LAIR_RULES.lake);
        for (const other of lairs) if (other !== lair) expect(near(lair, other)).toBeGreaterThanOrEqual(LAIR_RULES.lair);
        // The clearing holds only the den: a fallen pine and two mossy boulders beyond where a pack appears.
        const inside = world.obstacles.filter(o => obstacleClearance(o, lair) < lair.radius);
        expect(inside.map(o => o.id).sort(), lair.id).toEqual([0, 1, 2].map(k => `${lair.id}-den-${k}`));
        for (const piece of inside) expect(obstacleClearance(piece, lair)).toBeGreaterThan(MONSTER_RULES.scatter + MONSTERS.wolf.radius);
        for (let index = 0; index < 24; index++) {
          const angle = index / 24 * Math.PI * 2;
          for (const r of [0, 3, MONSTER_RULES.scatter]) {
            expect(isWalkable(world, { x: lair.x + Math.sin(angle) * r, z: lair.z + Math.cos(angle) * r }, MONSTERS.wolf.radius)).toBe(true);
          }
        }
      }
    }
  });

  test('version 1 and 2 campaigns have no lairs, no spawner and no monsters', async () => {
    for (const version of [1, 2] as const) {
      expect(generateWorld('wolves-a', version).lairs).toBeUndefined();
      const session = createCampaign({ seed: 'wolves-a', faction: 'guard', worldVersion: version });
      await run(session, 120);
      const snapshot = session.snapshot();
      expect(Object.hasOwn(snapshot, 'monsters')).toBe(false);
      expect(Object.hasOwn(save(session).engine.resources.KorovanyCampaign, 'spawner')).toBe(false);
      expect(snapshot.actors.every(a => !a.id.startsWith('monster-'))).toBe(true);
    }
  });

  test('a pack appears at its lair only while the hero is 90-160 m away, and snapshots list it apart from the troops', async () => {
    let session = createCampaign({ seed: 'wolves-a', faction: 'elf', worldVersion: 3 });
    const world = session.snapshot().world;
    const lair = world.lairs![0]!;
    for (const reach of [60, 200]) {
      const quiet = placed(session, spot(world, lair, reach, 170));
      await run(quiet, 70);
      expect(pack(quiet.snapshot(), lair.id), `${reach} m`).toEqual([]);
    }
    session = placed(session, spot(world, lair, 120, 170));
    session.step({});
    const snapshot = session.snapshot();
    const wolves = pack(snapshot, lair.id);
    expect(wolves.length).toBeGreaterThanOrEqual(MONSTERS.wolf.pack[0]);
    expect(wolves.length).toBeLessThanOrEqual(MONSTERS.wolf.pack[1]);
    for (const wolf of wolves) {
      expect(wolf.id).toMatch(/^monster-[1-9]\d*$/);
      expect(Object.keys(wolf).sort()).toEqual(['attackRange', 'heading', 'home', 'hp', 'id', 'lairId', 'maxHp', 'radius', 'species', 'state',
        'stateTime', 'target', 'x', 'z']);
      expect(wolf).toMatchObject({ species: 'wolf', hp: MONSTERS.wolf.hp, maxHp: MONSTERS.wolf.hp, target: null, home: { x: lair.x, z: lair.z } });
      expect(near(wolf, lair)).toBeLessThanOrEqual(MONSTER_RULES.scatter);
    }
    expect(snapshot.actors.some(a => a.id.startsWith('monster-'))).toBe(false);
    // Wandering keeps the pack inside its roaming circle.
    await run(session, 60 * 20);
    for (const wolf of pack(session.snapshot(), lair.id)) expect(near(wolf, lair)).toBeLessThanOrEqual(MONSTER_RULES.roam + 0.5);
  });

  test('the pack hunts the hero together, its contact opens a battle against the whole pack, and it gives up beyond its leash', async () => {
    const { session: start, world, lair } = staged('guard', 'wolves-b');
    const hp = start.snapshot().player.hp;
    let session = placed(start, spot(world, lair, 12));
    // Noticed, the whole pack hunts at once (it cannot reach the hero yet).
    await run(session, 15);
    expect(pack(session.snapshot(), lair.id).every(m => m.target === 'player')).toBe(true);
    expect(session.snapshot().battle).toBeUndefined();
    // Beyond its leash the pack gives up and goes home.
    const fled = placed(session, spot(world, lair, MONSTER_RULES.leash + 15));
    await run(fled, 60 * 8);
    for (const wolf of pack(fled.snapshot(), lair.id)) {
      expect(wolf.target).toBeNull();
      expect(near(wolf, lair)).toBeLessThanOrEqual(MONSTER_RULES.roam + 0.5);
    }
    // A hero who stands is reached: nobody bites in the field, and contact opens a battle against the whole pack.
    await until(session, 60 * 10, s => s.battle !== undefined);
    const snapshot = session.snapshot(), battle = snapshot.battle!;
    expect(snapshot.player.hp).toBe(hp);
    expect(battle.opening).not.toBe('first-strike');
    expect(battle.enemies.map(e => e.id).sort()).toEqual(pack(snapshot, lair.id).map(m => m.id).sort());
    expect(battle.enemies.every(e => e.kind === 'wolf' && e.hp === e.maxHp)).toBe(true);
    for (const e of battle.enemies) expect(battle.names[e.id]!.en).toMatch(/^Grave wolf( \d)?$/);
    // While it runs, the battle's save is its start.
    expect(restoreCampaign(save(session)).snapshot().battle!.tick).toBe(0);
  });

  test('killing a pack pays coins, never counts as the hero\'s kills and quiets its lair for 90-180 s', async () => {
    const { session: start, world, lair } = staged('villain', 'wolves-a');
    const session = placed(start, spot(world, lair, 10));
    const wolves = pack(session.snapshot(), lair.id).length;
    await until(session, 60 * 20, s => s.battle !== undefined, hunter);
    playBattle(session);
    const snapshot = session.snapshot();
    expect(snapshot.phase).toBe('playing');
    expect(pack(snapshot, lair.id).every(m => m.hp === 0 && m.state === 'dead')).toBe(true);
    expect(snapshot.player.kills).toBe(0);
    expect(snapshot.player.level).toBe(1);
    expect(snapshot.events.filter(e => e.kind === 'kill' && e.targetId.startsWith('monster-')).length).toBeGreaterThan(0);
    // Every wolf paid its coins: still on the ground, or already picked up (the hero had none before).
    const lying = snapshot.pickups.filter(p => p.kind === 'coin').reduce((sum, p) => sum + p.amount, 0);
    expect(lying + snapshot.player.coins).toBe(wolves * MONSTERS.wolf.coins);
    const quiet = save(session).engine.resources.KorovanyCampaign.spawner!.lairs[lair.id]!.cooldown;
    expect(quiet).toBeGreaterThan(MONSTER_RULES.cooldown[0] - 1);
    expect(quiet).toBeLessThanOrEqual(MONSTER_RULES.cooldown[1]);
    // While the lair is quiet no pack returns, even with the hero back in the spawn band once the bodies are gone.
    const band = spot(world, lair, 120, 170);
    const waiting = placed(session, band);
    await run(waiting, 60 * 10);
    expect(pack(waiting.snapshot(), lair.id)).toEqual([]);
    // Once the quiet ends the lair fills again.
    const later = placed(waiting, band, value => { value.engine.resources.KorovanyCampaign.spawner!.lairs[lair.id]!.cooldown = 0.5; });
    await run(later, 120);
    expect(pack(later.snapshot(), lair.id).length).toBeGreaterThanOrEqual(MONSTERS.wolf.pack[0]);
  });

  test('wandering packs vanish beyond 240 m, and never more than 12 beasts are abroad', async () => {
    const { session: start, world, lair } = staged('elf', 'wolves-a');
    const far = placed(start, spot(world, lair, MONSTER_RULES.despawn + 15));
    await run(far, 70);
    expect(pack(far.snapshot(), lair.id)).toEqual([]);
    // A spot within the spawn band of as many lairs as possible: the cap holds however many packs could appear.
    for (const seed of seeds) {
      await breathe();
      const session = createCampaign({ seed, faction: 'guard', worldVersion: 3 });
      const w = session.snapshot().world;
      let best: Vec2 | null = null, count = 0;
      for (let x = -440; x <= 440; x += 20) for (let z = -440; z <= 440; z += 20) {
        const p = { x, z };
        const inBand = w.lairs!.filter(l => near(l, p) >= MONSTER_RULES.spawn[0] + 1 && near(l, p) <= MONSTER_RULES.spawn[1] - 1).length;
        if (inBand > count && isWalkable(w, p, 0.65)) { best = p; count = inBand; }
      }
      if (!best) continue;
      const crowded = placed(session, best);
      crowded.step({});
      const abroad = crowded.snapshot().monsters!;
      expect(abroad.length, `${seed}: ${count} lairs in band`).toBeLessThanOrEqual(MONSTER_RULES.cap);
      expect(abroad.length).toBeGreaterThanOrEqual(Math.min(count, 3) * MONSTERS.wolf.pack[0]);
      expect(() => restoreCampaign(save(crowded))).not.toThrow();
    }
  });

  test('every state of a wandering, fleeing and fighting hero round a den is a valid save that resumes exactly', async () => {
    for (const [faction, seed] of [['guard', 'wolves-a'], ['elf', 'wolves-b'], ['villain', 0]] as const) {
      const { session: start, world, lair } = staged(faction, String(seed));
      let session = placed(start, spot(world, lair, 20));
      // A seeded random walk: runs at, round and away from the den, sprinting, dodging and attacking at random; battles
      // are fought with perfect reactions.
      let state = 7919;
      const random = (): number => { state = (state * 48271) % 2147483647; return state / 2147483647; };
      let heading = random() * Math.PI * 2, battleStart: string | null = null, battles = 0;
      for (let tick = 0; tick < 60 * 50; tick++) {
        if (tick % 60 === 59) await breathe();
        if (tick % 45 === 0) heading += (random() - 0.5) * 2.4;
        const snapshot = session.snapshot();
        if (snapshot.phase !== 'playing') break;
        // Pulled back towards the den when it strays beyond 70 m.
        if (near(snapshot.player, lair) > 70) heading = Math.atan2(lair.x - snapshot.player.x, lair.z - snapshot.player.z);
        const input: GameInput = snapshot.battle ? battleInput(snapshot.battle) : { move: { x: Math.sin(heading), z: Math.cos(heading) },
          sprint: random() < 0.3, attack: random() < 0.5, dodge: random() < 0.02 };
        const prey = (snapshot.monsters ?? []).find(m => m.hp > 0 && near(m, snapshot.player) < 6);
        if (prey && !snapshot.battle) input.aim = { x: prey.x - snapshot.player.x, z: prey.z - snapshot.player.z };
        session.step(input);
        const after = session.snapshot();
        if (after.battle && !snapshot.battle) { battleStart = JSON.stringify(after); battles++; }
        if (tick % 120 === 119) {
          const resumed = restoreCampaign(JSON.parse(JSON.stringify(session.serialize())));
          // A battle resumes from its start; anything else resumes exactly where it was.
          if (after.battle) expect(JSON.stringify(resumed.snapshot()), `${faction} tick ${tick}`).toBe(battleStart);
          else {
            expect(JSON.stringify(resumed.snapshot()), `${faction} tick ${tick}`).toBe(JSON.stringify(after));
            session = resumed;
          }
        }
      }
      expect(session.snapshot().monsters!.length, faction).toBeGreaterThan(0);
      expect(battles, faction).toBeGreaterThan(0);
    }
  });

  test('saves restore a hunt exactly, a battle restarts from its start, and identical runs stay identical', async () => {
    const { session: start, world, lair } = staged('elf', 'wolves-b');
    const policy = (s: GameSnapshot): GameInput => s.battle ? battleInput(s.battle) : hunter(s);
    const a = placed(start, spot(world, lair, 14));
    const b = placed(start, spot(world, lair, 14));
    await run(a, 90, policy);
    await run(b, 90, policy);
    expect(JSON.stringify(b.snapshot())).toBe(JSON.stringify(a.snapshot()));
    const midway = JSON.parse(JSON.stringify(a.serialize()));
    const one = restoreCampaign(midway), two = restoreCampaign(midway);
    if (a.snapshot().battle) expect(one.snapshot().battle!.tick).toBe(0);
    else expect(JSON.stringify(one.snapshot())).toBe(JSON.stringify(a.snapshot()));
    await run(one, 240, policy);
    await run(two, 240, policy);
    expect(JSON.stringify(two.snapshot())).toBe(JSON.stringify(one.snapshot()));
    await until(a, 60 * 60, s => !s.battle && !pack(s, lair.id).some(m => m.hp > 0), policy);
    expect(pack(a.snapshot(), lair.id).every(m => m.hp === 0)).toBe(true);
    const resumed = restoreCampaign(JSON.parse(JSON.stringify(a.serialize())));
    expect(JSON.stringify(resumed.snapshot())).toBe(JSON.stringify(a.snapshot()));
    await run(a, 240, policy);
    await run(resumed, 240, policy);
    expect(JSON.stringify(resumed.snapshot())).toBe(JSON.stringify(a.snapshot()));
  });

  test('every faction hero beats a pack with perfect reactions; a hero who never reacts is worn down', async () => {
    for (const faction of ['elf', 'guard', 'villain'] as const) {
      for (const seed of ['wolves-a', 'wolves-b']) {
        await breathe();
        const label = `${faction}/${seed}`;
        const { session: start, world, lair } = staged(faction, seed);
        const at = spot(world, lair, 12);
        const maxHp = start.snapshot().player.maxHp;
        for (const style of ['perfect', 'passive'] as const) {
          const session = placed(start, at);
          await until(session, 60 * 30, s => s.battle !== undefined);
          const snapshot = playBattle(session, style);
          expect(snapshot.phase, `${label} ${style}`).toBe('playing');
          expect(pack(snapshot, lair.id).every(m => m.hp === 0), `${label} ${style}`).toBe(true);
          const lost = (maxHp - snapshot.player.hp) / maxHp;
          if (style === 'perfect') expect(lost, label).toBe(0);
          else {
            expect(lost, label).toBeGreaterThan(0.1);
            expect(lost, label).toBeLessThan(0.9);
          }
        }
      }
    }
  });

  describe('save validation', () => {
    let world: WorldBlueprint, lair: NonNullable<WorldBlueprint['lairs']>[number], live: GameSession;
    beforeAll(async () => {
      const staging = staged('guard', 'wolves-a');
      ({ world, lair } = staging);
      live = placed(staging.session, spot(world, lair, 12));
      await run(live, 45);
    });
    const wolf = (value: Save): Record<string, unknown> =>
      value.engine.entities.map(e => e.components.KorovanyCombatant).find(a => String(a.id).startsWith('monster-'))!;

    test('accepts the live hunt', () => {
      expect(() => restoreCampaign(save(live))).not.toThrow();
    });

    test.each([
      ['a wound beyond full health', (v: Save) => { wolf(v).hp = MONSTERS.wolf.hp + 1; }],
      ['a stronger bite', (v: Save) => { wolf(v).damage = 30; }],
      ['an unknown species', (v: Save) => { wolf(v).species = 'troll'; }],
      ['a monster from no lair', (v: Save) => { wolf(v).siteId = 'lair-nowhere-0'; }],
      ['a moved lair', (v: Save) => { (wolf(v).home as Vec2).x += 3; }],
      ['a wandering point beyond the roaming circle', (v: Save) => { wolf(v).roam = { x: lair.x + MONSTER_RULES.roam + 2, z: lair.z }; }],
      ['a monster hunting the convoy', (v: Save) => { wolf(v).target = 'convoy'; }],
      ['a monster serving a faction', (v: Save) => { wolf(v).faction = 'elf'; }],
      ['an ID beyond the spawn sequence', (v: Save) => { wolf(v).id = `monster-${v.engine.resources.KorovanyCampaign.spawner!.sequence + 1}`; }],
      ['a spawn sequence rewound', (v: Save) => { v.engine.resources.KorovanyCampaign.spawner!.sequence = 0; }],
      ['a quiet lair with a living pack', (v: Save) => { v.engine.resources.KorovanyCampaign.spawner!.lairs[lair.id]!.cooldown = 50; }],
      ['a cooldown beyond 180 s', (v: Save) => { v.engine.resources.KorovanyCampaign.spawner!.lairs[world.lairs![1]!.id]!.cooldown = 181; }],
      ['a forgotten lair', (v: Save) => { delete v.engine.resources.KorovanyCampaign.spawner!.lairs[lair.id]; }],
      ['no spawner', (v: Save) => { delete v.engine.resources.KorovanyCampaign.spawner; }],
      ['a monster counted as a hero kill', (v: Save) => { (v.engine.resources.KorovanyCampaign.player as unknown as { kills: number }).kills = 1; }],
      ['a wandering pause beyond 6 s', (v: Save) => { wolf(v).stateTime = 7; }],
      ['a beast far beyond its leash', (v: Save) => { Object.assign(wolf(v), { x: lair.x + 70, z: lair.z }); }],
    ])('rejects %s', (_label, tamper) => {
      const value = save(live);
      tamper(value);
      expect(() => restoreCampaign(value)).toThrow();
    });

    test('rejects a spawner in a version 2 save', () => {
      const v2 = createCampaign({ seed: 'wolves-a', faction: 'guard', worldVersion: 2 });
      const value = save(v2);
      value.engine.resources.KorovanyCampaign.spawner = { sequence: 0, timer: 0, lairs: {} } as never;
      expect(() => restoreCampaign(value)).toThrow();
    });
  });
});
