import { defineComponent, defineResource, type World } from '@aegis/core';
import type {
  ActorSnapshot, ConvoySnapshot, EffectSnapshot, FactionId, FortressSnapshot, GameEvent,
  GameInput, OutpostSnapshot, Phase, PickupSnapshot, PlayerSnapshot, ProjectileSnapshot, RunRewards, Vec2,
} from './types';

export interface ActorData extends ActorSnapshot {
  cooldown: number;
  damage: number;
  speed: number;
  deadTime: number;
  attackPoint: Vec2;
  patrolDirection: number;
}
export interface ProjectileData extends ProjectileSnapshot {
  vx: number;
  vz: number;
  damage: number;
}
export interface CampaignData {
  seed: string;
  faction: FactionId;
  runId: string;
  worldId: string;
  phase: Phase;
  player: PlayerSnapshot;
  convoy: ConvoySnapshot;
  outposts: OutpostSnapshot[];
  pickups: PickupSnapshot[];
  projectiles: ProjectileData[];
  effects: EffectSnapshot[];
  events: GameEvent[];
  fortress: FortressSnapshot;
  rewards: RunRewards | null;
  raidComplete: boolean;
  eventSequence: number;
  transientSequence: number;
  spawnSequence: number;
  followTimer: number;
  convoyWeaponTimer: number;
  reinforcementTimer: number;
  dodgeDirection: Vec2;
}
export const Combatant = defineComponent<ActorData>({
  id: 'KorovanyCombatant',
  defaults: () => ({
    id: '', kind: 'soldier', faction: 'guard', x: 0, z: 0, heading: 0,
    hp: 60, maxHp: 60, radius: 0.7, state: 'idle', stateTime: 0, attackRange: 2.3,
    target: null, home: { x: 0, z: 0 }, siteId: '', cooldown: 0,
    damage: 12, speed: 3.5, deadTime: 0, attackPoint: { x: 0, z: 0 }, patrolDirection: -1,
  }),
});
// No default campaign exists: creation/restoration must install a validated run.
export const Campaign = defineResource<CampaignData>('KorovanyCampaign', () => {
  throw new Error('Campaign resource must be explicitly initialized');
});
export const Intent = defineResource<GameInput>('KorovanyIntent', () => ({}));

export function campaign(world: World): CampaignData {
  const state = world.getResource(Campaign);
  if (!state) throw new Error('Campaign resource missing');
  return state;
}
export function actors(world: World): ActorData[] {
  return world.query({ has: [Combatant] }).views().map(v => v.get(Combatant));
}
