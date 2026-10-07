import { expect } from 'vitest';
import {
  BATTLE_TIMING, findRoadRoute, isWalkable, suggestCommand, type ActorSnapshot, type BattleView, type GameInput, type GameSession,
  type GameSnapshot, type Vec2,
} from '../src/game';

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const hostile = (actor: ActorSnapshot): boolean =>
  actor.hp > 0 && actor.allegiance !== 'friendly' && actor.allegiance !== 'neutral';
const dir = (a: Vec2, b: Vec2): Vec2 => {
  const length = dist(a, b) || 1;
  return { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
};

export function advance(game: GameSession, input: GameInput, ticks = 6): void {
  for (let i = 0; i < ticks; i++) game.step(i === 0 ? input : {
    ...input, dodge: false, parry: false, special: false, convoy: undefined, upgrade: undefined,
  });
}

/**
 * How the driver fights a battle: `perfect` plays the suggested command and a perfectly timed reaction to every blow aimed
 * at the hero (a parry, or a dodge for heavy blows); `passive` plays the suggested commands but never reacts; `reckless`
 * attacks every turn and never reacts; `halt` leaves the battle to the caller (walking and fighting stop as it begins).
 */
export type BattleStyle = 'perfect' | 'passive' | 'reckless' | 'halt';

/** One perfect step of a battle: the suggested command on the hero's turn, otherwise the reaction a blow landing on the
 * tick being entered needs (a parry, or a dodge for heavy blows). */
export function battleInput(battle: BattleView): GameInput {
  if (battle.phase === 'command') return { battle: suggestCommand(battle) };
  const hit = battle.action?.hits.find(h => h.target === 'hero' && h.outcome === 'pending' && h.pressed === null &&
    h.impact === battle.tick + 1);
  return hit ? hit.heavy ? { dodge: true } : { parry: true } : {};
}

/** Plays the battle in progress to its end (or until `stop` holds) and returns the snapshot after it. */
export function playBattle(game: GameSession, style: Exclude<BattleStyle, 'halt'> = 'perfect',
  stop: (s: GameSnapshot) => boolean = () => false): GameSnapshot {
  for (let i = 0; i < 20_000; i++) {
    const s = game.snapshot(), battle = s.battle;
    if (!battle || s.phase !== 'playing' || stop(s)) return s;
    if (battle.phase === 'command') {
      game.step({ battle: style === 'reckless' ? { type: 'attack', target: battle.enemies.find(e => e.hp > 0)!.id }
        : suggestCommand(battle) });
      continue;
    }
    // A press counts for the tick being entered, so it goes on the step that enters the blow's impact tick. A new move's
    // first blow lands at least `BATTLE_TIMING.attempt` ticks after it begins: quiet stretches are stepped blind.
    const hits = style === 'perfect' ? battle.action?.hits.filter(h => h.target === 'hero' && h.outcome === 'pending' &&
      h.pressed === null && h.impact > battle.tick) ?? [] : [];
    const hit = hits.sort((a, b) => a.impact - b.impact)[0];
    const quiet = Math.min(hit ? hit.impact - battle.tick - 1 : Infinity, BATTLE_TIMING.attempt - 4);
    for (let tick = 0; tick < quiet; tick++) game.step({});
    if (hit && quiet === hit.impact - battle.tick - 1) game.step(hit.heavy ? { dodge: true } : { parry: true });
  }
  throw new Error(`Battle timed out: ${JSON.stringify(game.snapshot().battle)}`);
}

/** Public-snapshot bot: no entity, HP, objective, timer or save mutation. */
export class CampaignDriver {
  constructor(readonly game: GameSession, readonly style: BattleStyle = 'perfect') {}
  snap(): GameSnapshot { return this.game.snapshot(); }
  live(): GameSnapshot {
    const snapshot = this.snap();
    if (snapshot.phase === 'defeat') throw new Error(`Driver defeated at tick ${snapshot.tick}, ${JSON.stringify(snapshot.player)}, objective ${snapshot.objective.stage}`);
    return snapshot;
  }
  /** Handles a battle the snapshot shows: plays it to its end, or in the `halt` style leaves it to the caller. */
  private settle(s: GameSnapshot): 'none' | 'played' | 'halt' {
    if (!s.battle) return 'none';
    if (this.style === 'halt') return 'halt';
    playBattle(this.game, this.style);
    this.live();
    return 'played';
  }
  /** Plays a battle in progress; true when there was one to play. */
  battle(): boolean { return this.settle(this.snap()) === 'played'; }
  walk(point: Vec2, tolerance = 0.8, fight = true): void {
    for (let frame = 0; frame < 2000; frame++) {
      const s = this.live(), battle = this.settle(s);
      if (battle === 'halt') return;
      if (battle === 'played') continue;
      if (s.phase === 'victory') return;
      if (dist(s.player, point) < tolerance) return;
      const enemy = fight ? s.actors.find(a => hostile(a) && a.kind !== 'caravan' &&
        (a.siteId !== 'fortress' || s.fortress.unlocked) && dist(a, s.player) < 13) : undefined;
      if (enemy) { this.fight(enemy.siteId); continue; }
      const move = dir(s.player, point);
      const projected = { x: s.player.x + move.x, z: s.player.z + move.z };
      if (!isWalkable(s.world, projected, s.player.radius)) {
        const options = [-0.7, 0.7, -1.3, 1.3, Math.PI].map(angle => ({
          x: move.x * Math.cos(angle) - move.z * Math.sin(angle),
          z: move.x * Math.sin(angle) + move.z * Math.cos(angle),
        }));
        const detour = options.find(d => isWalkable(s.world, { x: s.player.x + d.x, z: s.player.z + d.z }, s.player.radius));
        if (detour) { advance(this.game, { move: detour, sprint: true }); continue; }
      }
      const approaching = dist(s.player, point) < 2;
      advance(this.game, { move, sprint: !approaching }, approaching ? 1 : 6);
    }
    throw new Error(`Could not reach ${JSON.stringify(point)} from ${JSON.stringify(this.snap().player)}`);
  }
  toNode(id: string, fight = true): void {
    let s = this.live();
    const closest = s.world.roads.edges.map(edge => {
      const a = s.world.roads.nodes.find(n => n.id === edge.from)!;
      const b = s.world.roads.nodes.find(n => n.id === edge.to)!;
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((s.player.x - a.x) * dx + (s.player.z - a.z) * dz) / (dx * dx + dz * dz)));
      return { x: a.x + t * dx, z: a.z + t * dz };
    }).sort((a, b) => dist(s.player, a) - dist(s.player, b))[0]!;
    this.walk(closest, 0.4, fight);
    s = this.live();
    for (const point of findRoadRoute(s.world, s.player, id)) this.walk(point, 0.7, fight);
  }
  /** Engages the site's hostiles (a first strike when the hero lands the first blow) and wins every battle there. */
  fight(siteId: string): void {
    for (let i = 0; i < 4000; i++) {
      const s = this.live(), battle = this.settle(s);
      if (battle === 'halt') return;
      if (battle === 'played') continue;
      if (s.phase === 'victory') return;
      const enemy = s.actors.filter(a => hostile(a) && a.siteId === siteId)
        .sort((a, b) => dist(a, s.player) - dist(b, s.player))[0];
      if (!enemy) return;
      const d = dist(s.player, enemy), aim = dir(s.player, enemy);
      const reach = s.faction === 'elf' ? 14 : 1.2 + enemy.radius;
      advance(this.game, { aim, move: d > reach ? aim : { x: 0, z: 0 }, attack: d <= reach + 2, sprint: d > 8 }, 2);
    }
    throw new Error(`Fight timed out at ${siteId}: ${JSON.stringify(this.snap().actors.filter(a => a.siteId === siteId))}`);
  }
  capture(id: string): void {
    this.toNode(id);
    this.fight(id);
    this.toNode(id);
    // A battle (a wandering pack, a patrol) may interrupt the capture; win it and resume.
    for (let i = 0; i < 40; i++) {
      const s = this.live();
      if (s.outposts.find(p => p.id === id)?.owner === 'player') break;
      if (this.settle(s) !== 'none') { this.toNode(id); continue; }
      advance(this.game, { interact: true }, 10);
    }
    expect(this.live().outposts.find(p => p.id === id)?.owner).toBe('player');
    advance(this.game, { interact: true }, 480);
  }
  waitConvoy(id: string): void {
    this.game.step({ convoy: { destination: id } });
    for (let i = 0; i < 5000; i++) {
      const s = this.live();
      if (this.settle(s) !== 'none') continue;
      if (s.convoy.disabled) throw new Error(`Unexpected wreck en route to ${id}`);
      const node = s.world.roads.nodes.find(n => n.id === id)!;
      if (dist(s.convoy, node) < 0.5) return;
      advance(this.game, { interact: true });
    }
    throw new Error('Convoy route timed out');
  }
  raid(): void {
    this.toNode('raid');
    this.fight('raid');
    const supply = this.live().pickups.find(p => p.kind === 'supply');
    if (supply) this.walk(supply);
    expect(this.live().objective.raidComplete).toBe(true);
    this.toNode('raid');
    this.waitConvoy('raid');
    advance(this.game, { interact: true }, 12);
    expect(this.live().convoy.cargo).toBeGreaterThanOrEqual(60);
  }
  escortShipment(destination: string, checkpoint?: (snapshot: GameSnapshot) => void): void {
    this.toNode('raid');
    this.fight('raid');
    checkpoint?.(this.live());
    const wagon = this.live().actors.find(a => a.id === 'enemy-caravan')!;
    this.walk(wagon, 2);
    advance(this.game, { interact: true }, 360);
    const route = findRoadRoute(this.live().world, this.live().player, destination);
    let waypoint = 0;
    for (let frame = 0; frame < 12000; frame++) {
      const s = this.live();
      if (this.settle(s) !== 'none') continue;
      const shipment = s.actors.find(a => a.id === 'enemy-caravan')!;
      if (s.campaign?.requirements.find(r => r.id === 'shipment')?.complete) {
        expect(dist(shipment, s.world.roads.nodes.find(n => n.id === destination)!)).toBeLessThan(4);
        checkpoint?.(s);
        return;
      }
      const enemy = s.actors.find(a => hostile(a) && a.kind !== 'caravan' &&
        (a.siteId !== 'fortress' || s.fortress.unlocked) && dist(a, s.player) < 13);
      if (enemy) { this.fight(enemy.siteId); continue; }
      if (shipment.hp <= 0) {
        this.walk(shipment, 2, false);
        advance(this.game, { interact: true }, 360);
        continue;
      }
      while (waypoint < route.length - 1 && dist(s.player, route[waypoint]!) < 0.8) waypoint++;
      const next = route[waypoint];
      const move = next && dist(s.player, next) > 0.5 &&
        (dist(s.player, shipment) < 8 || dist(s.player, next) > dist(shipment, next))
        ? dir(s.player, next) : { x: 0, z: 0 };
      advance(this.game, { move, interact: true });
      if (frame % 30 === 0) {
        const after = this.live();
        if (!after.battle) checkpoint?.(after);
      }
    }
    throw new Error(`Shipment escort timed out: ${JSON.stringify(this.live().campaign)}, ${JSON.stringify(this.live().player)}`);
  }
  military(checkpoint?: (snapshot: GameSnapshot) => void): void {
    const start = this.live();
    if (!start.campaign?.directive) throw new Error('Choose the authored faction directive before military acceptance');
    const primary = start.faction === 'elf' ? 'forest' : 'palace';
    this.capture(primary);
    this.waitConvoy(primary);
    expect(this.live().outposts.find(p => p.id === primary)?.supplied).toBe(true);
    const destination = start.faction === 'elf' ? 'forest' : start.campaign.directive === 'plunder' ? 'old-fort' : 'palace';
    this.escortShipment(destination, checkpoint);
    for (const pickup of this.live().pickups.filter(p => p.kind === 'supply')) this.walk(pickup);
    this.toNode(destination);
    this.waitConvoy(destination);
    advance(this.game, { interact: true }, 480);
    for (const required of this.live().campaign!.requirements.filter(r => r.id.startsWith('post-') && !r.complete)) {
      const id = required.targetId!;
      this.capture(id);
      this.waitConvoy(id);
      expect(this.live().outposts.find(p => p.id === id)?.supplied).toBe(true);
    }
    expect(this.live().fortress.unlocked).toBe(true);
    this.toNode('fortress');
    this.fight('fortress');
    expect(this.live().fortress.bossDefeated).toBe(true);
    expect(this.live().campaign!.requirements.every(r => r.complete)).toBe(true);
    checkpoint?.(this.live());
  }
}
