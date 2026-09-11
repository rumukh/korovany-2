# Korovany II simulation / presentation boundary

`src/game/index.ts` is the public entry point. It exports all public types, faction
configuration and these implemented functions:

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
three posts prevents the single three-soldier reinforcement wave. Convoy starts
with 30 cargo; the enemy caravan drops 90 supplies, enough for every post.
Near the convoy, interact transfers carried supplies; held interact repairs a
disabled or damaged convoy for free, so a lost cart is recoverable, never a
permanent softlock. A wreck takes five held seconds to restore half its health;
further repair is continuous. Home and captured posts heal the hero while
interacting if there are no nearby enemies. A post takes three held seconds to
capture after its three defenders are dead; partial uncontested progress persists.

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

The registered `KorovanyCombatant` component owns every hostile actor; the
`KorovanyCampaign` resource owns the hero, convoy and campaign counters.
`KorovanyIntent` receives validated per-tick input. The schedule runs timers,
hero action, enemy AI, convoy routing, swept projectiles, conquest and terminal
cleanup in that order. Saves retain the entire engine World including PRNG and
entity allocator. Restoration validates the generated world ID, finite bounded
state, roster identity, collision positions, contiguous events, on-road paths,
supply conservation, captured-post defenders and terminal rewards.

Generator geometry reserves all road corridors before adding scenery; circle
walls at actual sites are also authoritative. Corpses expire after eight seconds,
effects are capped at 48, projectiles at 96, and event history at 32. Supply and
coin pickups do not expire; the finite roster bounds them without deleting cargo.

`npm test` runs the game tests and presenter tests under `src/view`. Campaign
acceptance drives normal public input through all three factions, including
capture, raid, supply, reinforcements, victory, defeat, wreck recovery and exact
save/resume. `npm run lock:canonicalize` normalizes only the root game lockfile
after a proxied dependency update; root `.npmrc` retains the corporate registry.
