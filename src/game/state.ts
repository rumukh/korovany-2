import { defineComponent, defineResource, type World } from '@aegis/core';
import type { BattleOptions, BattleRecord } from './battles';
import type { NarrativeState } from './narrative';
import type { MilitaryState } from './faction-campaigns';
import type {
  ActorKind, ActorSnapshot, ConvoySnapshot, EffectSnapshot, FactionId, FortressSnapshot, GameEvent,
  GameInput, MonsterSpecies, OutpostSnapshot, Phase, PickupSnapshot, PlayerSnapshot, ProjectileSnapshot, RunRewards, Vec2,
} from './types';

/**
 * One combatant entity. Version 3 monsters are combatants of kind `monster` with a `species`, `allegiance: 'hostile'`,
 * their lair as `siteId` and its centre as `home`; snapshots list them apart from the troops (`GameSnapshot.monsters`).
 */
export interface ActorData extends Omit<ActorSnapshot, 'kind'> {
  kind: ActorKind | 'monster';
  /** Version 3 monsters only. */
  species?: MonsterSpecies;
  cooldown: number;
  damage: number;
  speed: number;
  deadTime: number;
  attackPoint: Vec2;
  patrolDirection: number;
  marchRoute?: Vec2[];
  marchDestination?: string | null;
  /** Version 3 monsters only: the point it wanders to while it is not hunting, within its roam circle round `home`. */
  roam?: Vec2;
}
/** Version 3 only: the monster spawner. `sequence` numbers `monster-<n>` IDs; a lair's `cooldown` runs after its pack
 * was killed out and blocks a new pack until it reaches 0. */
export interface MonsterState {
  version: 1;
  sequence: number;
  timer: number;
  lairs: Record<string, { cooldown: number }>;
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
  /** Absent on legacy v1 worlds, retained in the Aegis campaign resource on v2. */
  narrative?: NarrativeState;
  military?: MilitaryState;
  /** Version 3 only: the monster spawner's state. */
  spawner?: MonsterState;
  /** The battle in progress, if any (see `battles.ts`); every field system rests while it runs. */
  battle?: BattleRecord;
  /** The shell's battle settings; absent means standard difficulty without latency compensation. */
  battleOptions?: BattleOptions;
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
