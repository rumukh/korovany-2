import { expect } from 'vitest';
import { findRoadRoute, isWalkable, type ActorSnapshot, type GameInput, type GameSession, type GameSnapshot, type Vec2 } from '../src/game';

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const hostile = (actor: ActorSnapshot): boolean =>
  actor.hp > 0 && actor.allegiance !== 'friendly' && actor.allegiance !== 'neutral';
const dir = (a: Vec2, b: Vec2): Vec2 => {
  const length = dist(a, b) || 1;
  return { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
};

export function advance(game: GameSession, input: GameInput, ticks = 6): void {
  for (let i = 0; i < ticks; i++) game.step(i === 0 ? input : {
    ...input, dodge: false, special: false, convoy: undefined, upgrade: undefined,
  });
}

/** Public-snapshot bot: no entity, HP, objective, timer or save mutation. */
export class CampaignDriver {
  constructor(readonly game: GameSession) {}
  snap(): GameSnapshot { return this.game.snapshot(); }
  live(): GameSnapshot {
    const snapshot = this.snap();
    if (snapshot.phase === 'defeat') throw new Error(`Driver defeated at tick ${snapshot.tick}, ${JSON.stringify(snapshot.player)}, objective ${snapshot.objective.stage}`);
    return snapshot;
  }
  walk(point: Vec2, tolerance = 0.8, fight = true): void {
    for (let frame = 0; frame < 2000; frame++) {
      const s = this.live();
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
  fight(siteId: string): void {
    for (let i = 0; i < 2000; i++) {
      const s = this.live();
      if (s.phase === 'victory') return;
      const enemies = s.actors.filter(a => hostile(a) && a.siteId === siteId)
        .sort((a, b) => dist(a, s.player) - dist(b, s.player));
      const enemy = enemies[0];
      if (!enemy) return;
      const d = dist(s.player, enemy), aim = dir(s.player, enemy);
      const ideal = s.faction === 'elf' ? 9 : 2.4;
      const nearestThreat = s.actors.find(a => hostile(a) && a.state === 'windup' && a.kind !== 'archer' && dist(a, s.player) < a.attackRange + 1.5);
      let move: Vec2 = d > ideal ? aim : s.faction === 'elf' && d < 6 ? { x: -aim.x, z: -aim.z } : { x: 0, z: 0 };
      const dodge = !!nearestThreat && s.player.dodgeCooldown === 0 && s.player.stamina >= 25;
      if (dodge) move = { x: -aim.z, z: aim.x };
      advance(this.game, { aim, move, attack: true, special: s.player.abilityCooldown === 0, dodge });
    }
    throw new Error(`Fight timed out at ${siteId}: ${JSON.stringify(this.snap().actors.filter(a => a.siteId === siteId))}`);
  }
  capture(id: string): void {
    this.toNode(id);
    this.fight(id);
    this.toNode(id);
    advance(this.game, { interact: true }, 190);
    expect(this.live().outposts.find(p => p.id === id)?.owner).toBe('player');
    advance(this.game, { interact: true }, 480);
  }
  waitConvoy(id: string): void {
    this.game.step({ convoy: { destination: id } });
    for (let i = 0; i < 5000; i++) {
      const s = this.live();
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
      if (frame % 30 === 0) checkpoint?.(this.live());
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
