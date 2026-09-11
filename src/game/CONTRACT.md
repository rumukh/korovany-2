# Korovany II simulation / presentation boundary

`src/game/index.ts` is the public entry point. Types and faction configuration are
available in this foundation commit. The implementation commit adds these exports:

```ts
createCampaign(options: CampaignOptions): GameSession
restoreCampaign(save: unknown): GameSession
generateWorld(seed: string | number): WorldBlueprint
isWalkable(world: WorldBlueprint, point: Vec2, radius?: number): boolean
findRoadRoute(world: WorldBlueprint, from: Vec2, destination: string): Vec2[]
createProfile(): MetaProfile
restoreProfile(value: unknown): MetaProfile
claimRewards(profile: MetaProfile, rewards: RunRewards): MetaProfile
purchaseMetaUpgrade(profile: MetaProfile, id: UpgradeId): MetaProfile
metaUpgradeCost(level: number): number
```

All coordinates use metres on X/Z; Y is presentation-only. Heading is radians,
`atan2(x, z)`. Ground is level for authoritative collision. Biome elevation may
be decorative, but roads, sites and bridge deck must stay traversable.

The shell owns title/faction/seed selection, settings, RU/EN localization, camera,
keyboard/pointer conversion to world-space directions, pause, fixed 60 Hz
accumulation with a frame cap, save storage and metadata persistence. `step` takes
held attack/sprint/interact; dodge/special/convoy/upgrade are one-shot pulses.
Pause means not calling `step`. Neither renderer nor shell may mutate live rules.
`snapshot` returns an independent plain object. Its world is immutable by contract
for the lifetime of that run; renderer can cache scenery by `world.id`.

Renderer sees player, actors (including the enemy caravan), convoy, collision
obstacles, road graph, water/bridges, pickups, effects, projectiles, faction colors,
AI windup/attack/recovery state, fortress and outpost ownership/progress.
Enemy factions are rival houses: even a post of the player's selected faction
starts hostile. `owner`, not faction color, defines captured status.

Campaign: defeat a post's defenders and hold interact inside its capture radius;
capture two of three posts; destroy the raiding caravan and gather its supplies;
escort the physical road-following convoy with cargo to two captured posts.
Deliveries (30 per post) plus the raid unlock the fortress boss. Supplying all
three posts further reduces reinforcements. Convoy starts with 30 cargo.
Near the convoy, interact transfers carried supplies; held interact repairs a
disabled or damaged convoy for free, so a lost cart is recoverable, never a
permanent softlock. Home rest and captured-post shops aid recovery.

Convoy commands cycle hold/follow/return; explicit `destination` may be any road
node ID (including home and post IDs). It follows the connected road graph,
crossing water only on the physical bridge. Follow chooses a nearby road node,
not a straight line through scenery. Snapshots expose its current route.

`objective`, `interaction`, `shop` and `rewards` are authoritative; do not guess
eligibility from distances in UI. Event IDs increase monotonically; the last 32
are retained so render/audio consumers should deduplicate. Timers are seconds.
Terminal states are frozen. Rewards are returned only for terminal runs.
Reward claiming is a pure idempotent profile operation keyed by run ID; the shell
should create unique run IDs for genuinely new campaigns and persist profile
immediately after claiming. Save keys are `korovany2:campaign` and
`korovany2:profile`; neither uses the original game's storage.

The Aegis ECS World, registered components/resources, ordered Systems and fixed
Simulation own game state and timers. Browser code must not import the engine's
Node-only renderer or CLI. A custom Three presenter is intentional.
