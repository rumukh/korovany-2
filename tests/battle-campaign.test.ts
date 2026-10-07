import { describe, expect, test } from 'vitest';
import {
  createCampaign, findRoadRoute, isWalkable, restoreCampaign, type CampaignSave, type GameSession, type GameSnapshot, type Vec2,
} from '../src/game';
import { getFactionStory } from '../src/game/faction-stories';
import { advance, CampaignDriver, dist, hostile, playBattle } from './driver';

type Engine = { resources: { KorovanyCampaign: Record<string, unknown> & { battle?: Record<string, any> }; KorovanyIntent: Record<string, unknown> };
  entities: { components: { KorovanyCombatant: Record<string, any> } }[] };
const engine = (save: CampaignSave): Engine => save.engine as Engine;
const corrupt = (save: CampaignSave, mutate: (value: Engine) => void): CampaignSave => {
  const copy = structuredClone(save);
  mutate(engine(copy));
  return copy;
};
const garrison = ['forest-soldier', 'forest-archer', 'forest-captain'];

/** Walks the road towards `node` (winning any battle on the way) until `stop` holds, checked every tick. */
function approach(game: GameSession, node: string, stop: (s: GameSnapshot) => boolean): GameSnapshot {
  const route = findRoadRoute(game.snapshot().world, game.snapshot().player, node);
  for (const point of route) {
    for (let tick = 0; tick < 3000; tick++) {
      const s = game.snapshot();
      if (s.battle) { playBattle(game); continue; }
      if (stop(s)) return s;
      if (dist(s.player, point) < 0.7) break;
      const d = dist(s.player, point);
      game.step({ move: { x: (point.x - s.player.x) / d, z: (point.z - s.player.z) / d } });
    }
  }
  throw new Error(`Never stopped on the way to ${node}`);
}
const nearest = (s: GameSnapshot, site: string) => s.actors.filter(a => hostile(a) && a.siteId === site)
  .sort((a, b) => dist(a, s.player) - dist(b, s.player))[0]!;

/** Steps without reacting until the hero's turn. */
function toCommand(game: GameSession): GameSnapshot {
  for (let i = 0; i < 5000; i++) {
    const s = game.snapshot();
    if (!s.battle || s.battle.phase === 'command') return s;
    game.step({});
  }
  throw new Error('No command phase');
}

describe('campaign battles', () => {
  test('a hostile that reaches the hero opens a battle; the field waits while it runs; victory settles the world', () => {
    const game = createCampaign({ seed: 'battle-contact', faction: 'guard' });
    const hp = game.snapshot().player.hp;
    new CampaignDriver(game, 'halt').toNode('forest', false);
    const s = game.snapshot(), battle = s.battle!;
    expect(battle).toBeDefined();
    expect(s.player.hp).toBe(hp);
    expect(battle.opening).not.toBe('first-strike');
    expect(battle.enemies.map(e => e.id)).toEqual(expect.arrayContaining(garrison));
    expect(battle.enemies.find(e => e.id === 'forest-captain')!.kind).toBe('captain');
    for (const e of battle.enemies) expect(battle.names[e.id]!.ru.length).toBeGreaterThan(0);
    expect(battle.names.hero).toEqual({ en: 'You', ru: 'Вы' });
    expect(s.events.some(e => e.kind === 'battle' && e.key === 'event.battle')).toBe(true);
    expect(s.interaction).toBeNull();
    for (const id of garrison) expect(s.actors.find(a => a.id === id)!.target).toBe('player');
    // On the hero's turn the battle waits; the world ticks on (for animation) but nothing in the field moves.
    const turn = toCommand(game);
    advance(game, { move: { x: 1, z: 0 }, attack: true, interact: true, sprint: true, convoy: 'follow', upgrade: 'damage' }, 90);
    const waited = game.snapshot();
    expect(waited.tick).toBe(turn.tick + 90);
    expect(waited.battle!).toMatchObject({ tick: turn.battle!.tick, phase: 'command', round: turn.battle!.round });
    expect({ x: waited.player.x, z: waited.player.z }).toEqual({ x: turn.player.x, z: turn.player.z });
    expect(waited.convoy.mode).toBe(turn.convoy.mode);
    expect(waited.player.upgrades).toEqual(turn.player.upgrades);
    // Commands are paused transactions: the battle acts, the world does not tick.
    game.step({ battle: { type: 'attack', target: 'forest-soldier' } });
    expect(game.snapshot().tick).toBe(waited.tick);
    expect(game.snapshot().battle!.action).toMatchObject({ actor: 'hero', move: 'attack', target: 'forest-soldier' });
    const kills = waited.player.kills;
    const after = playBattle(game);
    expect(after.battle).toBeUndefined();
    expect(after.phase).toBe('playing');
    for (const id of garrison) expect(after.actors.find(a => a.id === id)).toMatchObject({ hp: 0, state: 'dead' });
    expect(after.player.kills).toBe(kills + battle.enemies.length);
    expect(after.outposts.find(p => p.id === 'forest')!.defendersRemaining).toBe(0);
    expect(after.events.some(e => e.kind === 'battle' && e.key === 'event.battleWon')).toBe(true);
    expect(after.events.filter(e => e.kind === 'kill').length).toBeGreaterThanOrEqual(3);
    expect(after.pickups.filter(p => p.kind === 'coin').length).toBeGreaterThanOrEqual(3);
    expect(after.player.state).toBe('idle');
    expect(after.player.hp).toBe(hp);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(after);
    // The field resumes: the hero walks again.
    advance(game, { move: { x: 1, z: 0 } }, 30);
    expect(dist(game.snapshot().player, after.player)).toBeGreaterThan(1);
  });

  test('a battle saves as it began: restoring restarts it, and tampered records are rejected', () => {
    const game = createCampaign({ seed: 'battle-checkpoint', faction: 'villain' });
    new CampaignDriver(game, 'halt').toNode('palace', false);
    expect(game.snapshot().battle).toBeDefined();
    const start = JSON.parse(JSON.stringify(game.serialize())) as CampaignSave;
    const record = engine(start).resources.KorovanyCampaign.battle!;
    expect(record).toMatchObject({ version: 1, reinforced: false, seen: { log: 0, action: 0 } });
    expect(engine(start).resources.KorovanyIntent).toEqual({});
    toCommand(game);
    game.step({ battle: { type: 'skill', skill: 'warcry' } });
    advance(game, {}, 120);
    expect(game.serialize()).toEqual(start);
    const restarted = restoreCampaign(start);
    expect(restarted.snapshot().battle!).toMatchObject({ tick: 0, log: expect.any(Array) });
    expect(restarted.snapshot().battle!.enemies.every(e => e.hp === e.maxHp)).toBe(true);
    // Two restarts of the same battle play out identically.
    const twin = restoreCampaign(start);
    expect(playBattle(twin)).toEqual(playBattle(restarted));
    expect(twin.serialize()).toEqual(restarted.serialize());
    // Once the battle is over the save is the live world again.
    playBattle(game);
    expect(game.serialize()).not.toEqual(start);
    expect(restoreCampaign(game.serialize()).snapshot()).toEqual(game.snapshot());
    for (const [label, tamper] of [
      ['an enemy at full health', (v: Engine) => { v.resources.KorovanyCampaign.battle!.setup.enemies[0].hp += 1; }],
      ['another trigger', (v: Engine) => { v.resources.KorovanyCampaign.battle!.trigger = 'home-watch-1'; }],
      ['a seed out of range', (v: Engine) => { v.resources.KorovanyCampaign.battle!.setup.seed = -1; }],
      ['an unknown opening', (v: Engine) => { v.resources.KorovanyCampaign.battle!.setup.opening = 'flank'; }],
      ['a different opening state', (v: Engine) => { v.resources.KorovanyCampaign.battle!.state.hero.ap = 6; }],
      ['a battle in progress', (v: Engine) => { v.resources.KorovanyCampaign.battle!.state.now = 30; }],
      ['a reinforced battle', (v: Engine) => { v.resources.KorovanyCampaign.battle!.reinforced = true; }],
      ['a battle already shown', (v: Engine) => { v.resources.KorovanyCampaign.battle!.seen.log = 2; }],
      ['an extra field', (v: Engine) => { v.resources.KorovanyCampaign.battle!.extra = 1; }],
      ['a moved stage', (v: Engine) => { v.resources.KorovanyCampaign.battle!.stage[0].close.x += 1; }],
      ['a moved hero', (v: Engine) => { (v.resources.KorovanyCampaign.player as Vec2).x += 0.5; }],
      ['pending input', (v: Engine) => { v.resources.KorovanyIntent.attack = true; }],
      ['a missile in flight', (v: Engine) => { v.resources.KorovanyCampaign.projectiles = [{ id: 'projectile-999999', x: 0, z: 0,
        heading: 0, owner: 'player', faction: 'villain', kind: 'arrow', radius: 0.16, remaining: 0.5, vx: 0, vz: 28, damage: 10 }]; }],
      ['a dead participant', (v: Engine) => { Object.assign(v.entities.find(e => e.components.KorovanyCombatant.id ===
        record.trigger)!.components.KorovanyCombatant, { hp: 0, state: 'dead' }); }],
      ['unknown battle options', (v: Engine) => { v.resources.KorovanyCampaign.battleOptions = { difficulty: 'nightmare', latencyTicks: 0 }; }],
      ['latency beyond 12 ticks', (v: Engine) => { v.resources.KorovanyCampaign.battleOptions = { difficulty: 'story', latencyTicks: 13 }; }],
    ] as const) expect(() => restoreCampaign(corrupt(start, tamper)), label).toThrow();
  });

  test('a first strike gives the hero the first turn; an attack from behind is an ambush', () => {
    // The elf looses an arrow from beyond the garrison's notice.
    const first = createCampaign({ seed: 'battle-first', faction: 'elf' });
    new CampaignDriver(first).toNode('home');
    const near = approach(first, 'forest', s => dist(nearest(s, 'forest'), s.player) < 21);
    expect(near.battle).toBeUndefined();
    for (let i = 0; i < 300 && !first.snapshot().battle; i++) {
      const s = first.snapshot(), target = nearest(s, 'forest');
      first.step({ aim: { x: target.x - s.player.x, z: target.z - s.player.z }, attack: true });
    }
    const opened = first.snapshot().battle!;
    expect(opened.opening).toBe('first-strike');
    expect(opened).toMatchObject({ phase: 'command', round: 1 });
    expect(opened.order[0]).toBe('hero');
    // The guard backs into the garrison, facing away from it, until it closes in.
    const second = createCampaign({ seed: 'battle-ambush', faction: 'guard' });
    new CampaignDriver(second).toNode('home');
    approach(second, 'forest', s => dist(nearest(s, 'forest'), s.player) < 19);
    for (let i = 0; i < 1200 && !second.snapshot().battle; i++) {
      const s = second.snapshot(), threat = nearest(s, 'forest');
      const toward = { x: threat.x - s.player.x, z: threat.z - s.player.z };
      second.step({ move: toward, aim: { x: -toward.x, z: -toward.z } });
    }
    const ambushed = second.snapshot().battle!;
    expect(ambushed.opening).toBe('ambushed');
    // Ambushed melee fighters start close.
    expect(ambushed.enemies.filter(e => e.kind !== 'archer').every(e => e.band === 'close')).toBe(true);
  });

  test('friendly troops and the convoy weapon fight beside the hero, and the hero can cover the convoy', () => {
    const game = createCampaign({ seed: 'battle-allies', faction: 'villain' });
    const s = game.snapshot();
    // A palace soldier strays next to the villain's home, among the home watch and the convoy.
    const forward = { x: Math.sin(s.player.heading), z: Math.cos(s.player.heading) };
    const spot = [1.6, 1.9, 2.2].map(r => ({ x: s.player.x + forward.x * r, z: s.player.z + forward.z * r }))
      .find(p => isWalkable(s.world, p, 0.7))!;
    const save = corrupt(game.serialize(), v => {
      Object.assign(v.entities.find(e => e.components.KorovanyCombatant.id === 'palace-soldier')!.components.KorovanyCombatant, spot);
    });
    const session = restoreCampaign(save);
    session.step({ attack: true, aim: forward });
    const battle = session.snapshot().battle!;
    expect(battle.opening).toBe('first-strike');
    expect(battle.enemies.map(e => e.id)).toEqual(['palace-soldier']);
    expect(battle.allies.map(a => a.id).sort()).toEqual(['convoy-cart', 'home-watch-1', 'home-watch-2']);
    expect(battle.allies.find(a => a.id === 'convoy-cart')!.kind).toBe('siege-cart');
    expect(battle.names['convoy-cart']).toEqual({ en: 'Siege cart', ru: 'Осадная повозка' });
    expect(battle.wards).toEqual([{ id: 'convoy', hp: s.convoy.hp, maxHp: s.convoy.maxHp }]);
    expect(battle.names.convoy).toEqual({ en: 'Convoy', ru: 'Обоз' });
    expect(battle.commands.find(c => c.id === 'protect')).toMatchObject({ enabled: true });
    session.step({ battle: { type: 'protect' } });
    expect(session.snapshot().battle!.hero.guarding).toBe(true);
    let supported = false, shown = false;
    for (let i = 0; i < 20_000 && session.snapshot().battle; i++) {
      const now = session.snapshot(), current = now.battle!;
      if (current.action && ['home-watch-1', 'home-watch-2', 'convoy-cart'].includes(current.action.actor)) {
        supported = true;
        const ally = now.actors.find(a => a.id === current.action!.actor);
        if (ally && (ally.state === 'windup' || ally.state === 'attack')) shown = true;
      }
      if (current.phase === 'command') session.step({ battle: { type: 'attack', target: 'palace-soldier' } });
      else {
        const hit = current.action?.hits.find(h => h.target === 'hero' && h.outcome === 'pending' && h.pressed === null && h.impact === current.tick + 1);
        session.step(hit ? hit.heavy ? { dodge: true } : { parry: true } : {});
      }
    }
    expect(supported).toBe(true);
    expect(shown).toBe(true);
    const after = session.snapshot();
    expect(after.battle).toBeUndefined();
    expect(after.actors.filter(a => a.siteId === 'home').every(a => a.state === 'idle' && a.target === null && a.hp === a.maxHp)).toBe(true);
    expect(after.convoy.hp).toBeLessThanOrEqual(s.convoy.hp);
    expect(restoreCampaign(session.serialize()).snapshot()).toEqual(after);
  });

  test('a battle that begins in the tick another is won becomes the save point', () => {
    // The quarry garrison corners the guard beside the forest post. The battle takes the quarry troops and the two nearest
    // forest troops (five at most); the forest archer, left out, opens the next battle in the tick the first is won.
    const game = createCampaign({ seed: 'battle-again', faction: 'guard' });
    const s = game.snapshot();
    const taken: Vec2[] = [];
    const around = (centre: Vec2, radius: number, start: number): Vec2 => {
      for (let i = 0; i < 72; i++) {
        const angle = start + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI / 36;
        const at = { x: centre.x + Math.sin(angle) * radius, z: centre.z + Math.cos(angle) * radius };
        if (isWalkable(s.world, at, 0.8) && taken.every(t => dist(t, at) > 2)) { taken.push(at); return at; }
      }
      throw new Error('No room');
    };
    const hero = around(s.actors.find(a => a.id === 'forest-archer')!.home, 7, 0);
    // Troops keep 2 m apart; the nearest stands 1.8 m from the hero, clear of its body.
    taken.length = 0;
    const front = around(hero, 1.8, 0);
    const heading = Math.atan2(front.x - hero.x, front.z - hero.z);
    const places: Record<string, Vec2> = {
      'quarry-soldier': front,
      'quarry-archer': around(hero, 3.5, heading + Math.PI * 0.75),
      'quarry-captain': around(hero, 3.5, heading - Math.PI * 0.75),
      'forest-soldier': around(hero, 5, heading + Math.PI / 2),
      'forest-captain': around(hero, 5, heading - Math.PI / 2),
      'forest-archer': around(hero, 10, heading + Math.PI),
    };
    const session = restoreCampaign(corrupt(game.serialize(), v => {
      Object.assign(v.resources.KorovanyCampaign.player as Vec2, { ...hero, heading });
      for (const [id, at] of Object.entries(places)) {
        Object.assign(v.entities.find(e => e.components.KorovanyCombatant.id === id)!.components.KorovanyCombatant, at);
      }
    }));
    for (let i = 0; i < 60 && !session.snapshot().battle; i++) {
      session.step({ attack: true, aim: { x: front.x - hero.x, z: front.z - hero.z } });
    }
    const first = session.snapshot().battle!;
    expect(first.opening).toBe('first-strike');
    const fought = first.enemies.map(e => e.id);
    expect([...fought].sort()).toEqual(['forest-captain', 'forest-soldier', 'quarry-archer', 'quarry-captain', 'quarry-soldier']);
    const next = playBattle(session, 'perfect', now => now.battle?.enemies.some(e => e.id === 'forest-archer') === true);
    expect(next.battle!.enemies.map(e => e.id)).toEqual(['forest-archer']);
    // The save is the new battle as it began, with the first one won: not the first battle again.
    const restored = restoreCampaign(session.serialize()).snapshot();
    expect(restored.battle!).toMatchObject({ tick: 0, enemies: [expect.objectContaining({ id: 'forest-archer' })] });
    for (const id of fought) expect(restored.actors.find(a => a.id === id)!.hp, id).toBe(0);
    expect(playBattle(restoreCampaign(session.serialize())).battle).toBeUndefined();
  });

  test('battle options are paused, exclusive, saved and used by the next battle; story choices wait for its end', () => {
    const game = createCampaign({ seed: 'battle-options', faction: 'guard' });
    const tick = game.snapshot().tick;
    game.step({ battleOptions: { difficulty: 'story', latencyTicks: 4 } });
    game.step({ battle: { type: 'protect' } });
    expect(game.snapshot().tick).toBe(tick);
    expect(engine(game.serialize()).resources.KorovanyCampaign.battleOptions).toEqual({ difficulty: 'story', latencyTicks: 4 });
    for (const bad of [{ battleOptions: { difficulty: 'easy', latencyTicks: 0 } }, { battleOptions: { difficulty: 'story', latencyTicks: 13 } },
      { battleOptions: { difficulty: 'story', latencyTicks: 1.5 } }, { battleOptions: { difficulty: 'story' } },
      { battleOptions: { difficulty: 'story', latencyTicks: 2 }, move: { x: 1, z: 0 } }, { battle: { type: 'protect' }, attack: true },
      { battle: { type: 'charge' } }, { parry: 1 }]) {
      expect(() => game.step(bad as never), JSON.stringify(bad)).toThrow();
    }
    const resumed = restoreCampaign(game.serialize());
    expect(resumed.snapshot()).toEqual(game.snapshot());
    new CampaignDriver(resumed, 'halt').toNode('forest', false);
    const s = resumed.snapshot();
    expect(s.battle!.difficulty).toBe('story');
    // Only tracking and closing stay open in a battle; anything else is refused as dangerous.
    const quest = getFactionStory('guard').quests[0]!.id;
    resumed.step({ narrative: { type: 'talk', npcId: 'toman' } });
    expect(resumed.snapshot().narrative!.dialogue).toBeNull();
    expect(resumed.snapshot().narrative!.notice).not.toBeNull();
    resumed.step({ narrative: { type: 'track', questId: quest } });
    expect(resumed.snapshot().narrative!.trackedQuestId).toBe(quest);
    expect(resumed.snapshot().tick).toBe(s.tick);
    expect(resumed.snapshot().battle!.tick).toBe(s.battle!.tick);
  });
});
