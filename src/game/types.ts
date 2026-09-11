/**
 * Public presentation contract. Distances are metres, time is seconds except tick counters.
 * Ground plane is world X/Z, Y is up; heading is atan2(x, z) radians (0 faces +Z).
 * Snapshots are independent plain JSON values; changing them never changes the session.
 * Rules advance only through step(), exactly 1/60 second per call. No wall-clock is read.
 */
import type { ExplorationWorld, NarrativeInput, NarrativeSnapshot } from './narrative-types';
export type * from './narrative-types';

export type FactionId = 'elf' | 'guard' | 'villain';
export type Phase = 'playing' | 'victory' | 'defeat';
export type ActorKind = 'soldier' | 'archer' | 'captain' | 'boss' | 'caravan';
export type ActorState = 'idle' | 'chase' | 'windup' | 'attack' | 'recovery' | 'dead';
export type ConvoyMode = 'hold' | 'follow' | 'return' | 'route';
export type UpgradeId = 'damage' | 'vitality' | 'logistics';
export interface Vec2 { x: number; z: number }
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface Position extends Vec2 { heading: number }
export interface Upgrades { damage: number; vitality: number; logistics: number }

export interface CampaignOptions {
  /** String or safe integer, canonicalized to a nonempty string of at most 80 characters. */
  seed: string | number;
  faction: FactionId;
  upgrades?: Partial<Upgrades>;
  /** Shell should persist a unique run ID, e.g. crypto.randomUUID(); default is seed/faction. */
  runId?: string;
}

export interface GameInput {
  /** Held camera-relative input already converted to WORLD X/Z by the shell; clamped to unit. */
  move?: Vec2;
  /** WORLD direction; zero/omitted retains heading. */
  aim?: Vec2;
  /** Held: attacks repeat at the weapon's cooldown; sprint consumes stamina. */
  attack?: boolean;
  sprint?: boolean;
  /** Held: captures, repairs and transfers while in range. */
  interact?: boolean;
  /** One-shot pulses: shell consumes once, never repeats across catch-up steps. */
  dodge?: boolean;
  special?: boolean;
  /** One-shot cycle hold -> follow -> return -> hold, or explicit mode/road destination. */
  convoy?: 'cycle' | 'hold' | 'follow' | 'return' | { destination: string };
  /** One-shot in-run purchase; requires proximity to home or a captured post. */
  upgrade?: UpgradeId;
  narrative?: NarrativeInput;
}

export interface PlayerSnapshot extends Position {
  id: 'player';
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  coins: number;
  supplies: number;
  level: number;
  kills: number;
  damage: number;
  speed: number;
  radius: number;
  attackCooldown: number;
  abilityCooldown: number;
  abilityDuration: number;
  dodgeCooldown: number;
  invulnerable: number;
  state: 'idle' | 'moving' | 'attack' | 'dodge' | 'dead';
  upgrades: Upgrades;
}

export interface ActorSnapshot extends Position {
  id: string;
  kind: ActorKind;
  faction: FactionId;
  hp: number;
  maxHp: number;
  radius: number;
  state: ActorState;
  /** Seconds remaining in the currently telegraphed state. */
  stateTime: number;
  attackRange: number;
  target: 'player' | 'convoy' | null;
  home: Vec2;
  siteId: string;
}

export interface ConvoySnapshot extends Position {
  id: 'convoy';
  faction: FactionId;
  hp: number;
  maxHp: number;
  cargo: number;
  capacity: number;
  mode: ConvoyMode;
  destination: string | null;
  /** Road waypoints still to traverse; no teleportation or off-road water crossing. */
  route: Vec2[];
  speed: number;
  radius: number;
  disabled: boolean;
  repairProgress: number;
  delivered: number;
}

export interface OutpostSnapshot extends Vec2 {
  id: string;
  nameKey: string;
  faction: FactionId;
  owner: 'enemy' | 'player';
  captureProgress: number;
  captureRadius: number;
  defendersRemaining: number;
  supplied: boolean;
  supplyRequired: number;
}
export interface PickupSnapshot extends Vec2 {
  id: string;
  kind: 'coin' | 'health' | 'supply';
  amount: number;
}
export interface ProjectileSnapshot extends Position {
  id: string;
  owner: 'player' | 'enemy';
  faction: FactionId;
  kind: 'arrow' | 'bolt' | 'siege';
  radius: number;
  remaining: number;
}
export interface EffectSnapshot extends Vec2 {
  id: string;
  kind: 'slash' | 'volley' | 'cleave' | 'shield' | 'hit' | 'heal' | 'capture' | 'delivery' | 'explosion';
  faction: FactionId;
  heading: number;
  radius: number;
  remaining: number;
  duration: number;
}
export type EventKind = 'attack' | 'hurt' | 'kill' | 'pickup' | 'capture' | 'delivery'
  | 'raid' | 'convoy' | 'repair' | 'upgrade' | 'ability' | 'fortress' | 'victory' | 'defeat' | 'notice';
export interface GameEvent extends Vec2 {
  /** Monotonic sequence; presentation can consume events once even with multiple snapshots. */
  id: number;
  tick: number;
  kind: EventKind;
  key: string;
  amount: number;
  targetId: string;
}
export interface RoadNode extends Vec2 { id: string }
export interface RoadEdge { from: string; to: string; width: number }
export interface Obstacle extends Vec2 {
  id: string;
  kind: 'tree' | 'rock' | 'wall';
  radius: number;
  height: number;
  variant: number;
}
export interface WorldSite extends Vec2 {
  id: string;
  kind: 'home' | 'outpost' | 'fortress' | 'raid';
  faction: FactionId;
  nameKey: string;
  radius: number;
}
export interface WorldBlueprint {
  version: 1 | 2;
  seed: string;
  id: string;
  bounds: Bounds;
  roads: { nodes: RoadNode[]; edges: RoadEdge[] };
  /** Water is solid except within the walkable bridge rectangles. */
  river: Bounds;
  bridges: Bounds[];
  obstacles: Obstacle[];
  sites: WorldSite[];
  /** Visual biome regions; not additional collision. */
  biomes: { kind: 'forest' | 'countryside' | 'mountains'; bounds: Bounds }[];
  exploration?: ExplorationWorld;
}

export interface ObjectiveSnapshot {
  stage: 'capture' | 'raid' | 'supply' | 'fortress' | 'complete' | 'failed';
  key: string;
  captured: number;
  captureRequired: number;
  supplied: number;
  supplyRequired: number;
  raidComplete: boolean;
  targetId: string | null;
}
export interface FortressSnapshot extends Vec2 {
  id: 'fortress';
  unlocked: boolean;
  bossId: string;
  bossDefeated: boolean;
  reinforcementWaves: number;
}
export interface InteractionSnapshot {
  kind: 'capture' | 'contested' | 'repair' | 'transfer' | 'rest' | 'shop' | 'raid' | 'locked';
  key: string;
  targetId: string;
  progress: number;
  enabled: boolean;
}
export interface ShopItem {
  id: UpgradeId;
  key: string;
  level: number;
  maxLevel: number;
  cost: number;
  available: boolean;
  reason: 'ready' | 'location' | 'coins' | 'max';
}
export interface RunRewards {
  runId: string;
  claimed: false;
  renown: number;
  victory: boolean;
}
export interface GameSnapshot {
  version: 1;
  phase: Phase;
  tick: number;
  elapsed: number;
  seed: string;
  runId: string;
  faction: FactionId;
  world: WorldBlueprint;
  player: PlayerSnapshot;
  actors: ActorSnapshot[];
  convoy: ConvoySnapshot;
  outposts: OutpostSnapshot[];
  pickups: PickupSnapshot[];
  projectiles: ProjectileSnapshot[];
  effects: EffectSnapshot[];
  /** Last 32 events, not only the last tick. Deduplicate by event ID. */
  events: GameEvent[];
  objective: ObjectiveSnapshot;
  fortress: FortressSnapshot;
  interaction: InteractionSnapshot | null;
  shop: ShopItem[];
  rewards: RunRewards | null;
  narrative?: NarrativeSnapshot;
}

/** Opaque JSON save; restoreCampaign accepts unknown and rejects invalid/corrupt saves. */
export interface CampaignSave {
  namespace: 'korovany2:campaign';
  version: 1 | 2;
  seed: string;
  faction: FactionId;
  runId: string;
  worldId: string;
  engine: unknown;
}
export interface GameSession {
  /** Advances one fixed tick; terminal sessions are frozen. Input is validated before mutation. */
  step(input?: GameInput): void;
  snapshot(): GameSnapshot;
  serialize(): CampaignSave;
}
export interface MetaProfile {
  namespace: 'korovany2:profile';
  version: 1;
  renown: number;
  upgrades: Upgrades;
  completedRuns: string[];
}
export interface FactionDefinition {
  id: FactionId;
  nameKey: string;
  abilityKey: string;
  convoyKey: string;
  maxHp: number;
  speed: number;
  damage: number;
  attackRange: number;
  attackCooldown: number;
  abilityCooldown: number;
  color: number;
}
