# Korovany II simulation / presentation boundary

`src/game/index.ts` is the public entry point. It exports all public types, faction
configuration and these implemented functions:

```ts
createCampaign(options: CampaignOptions): GameSession
restoreCampaign(save: unknown): GameSession
generateWorld(seed: string | number, version?: 1 | 2): WorldBlueprint
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
Pause means not calling combat `step`. Neither renderer nor shell may mutate live rules.
The exception is `step({ narrative: command })`: it is a paused transaction and
never increments the tick or advances movement, timers, projectiles, RNG, the
convoy or hostile AI. Narrative input is exclusive of combat input. Valid
transactions clear the Aegis intent resource, including refused stale choices.
An open conversation or inspection also blocks ordinary combat ticks until a
`close` command (or the conversation's offered `leave` choice). The shell may therefore submit dialogue and
journal commands while its fixed-step loop is paused.
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

New campaigns default to world version 2. `CampaignOptions.worldVersion: 1`
explicitly creates the original military-only campaign. Saves use the blueprint
version and restore that exact generator, preserving v1 geometry and hashes.
`GameSnapshot.version` remains the presentation protocol version 1, not the
world/save version. `GameSnapshot.narrative` is absent for v1, present for v2.

## The Hollow Road

The expanded campaign keeps the conquest intact and adds five sequential main
chapters, eight local quests with different investigation lengths and witnesses,
and twenty authored NPCs across eight regions. Main chapter completion opens the
next investigation; side quests may be started in any order. Inspecting a relevant
location records the evidence and opens a paused reading scene. Inspection
snapshots expose the location, title and full text; closing the scene does not
remove its evidence from the journal. Revisiting a place cannot grant evidence or
rewards twice.

The story concerns a convoy's missing crew, a voice that imitates the dead, and
Commander Raut's trade in protective black glass. It does not add monster combat,
a day/night system or simulated village populations. Local outcomes are recorded
narrative events; they change testimony, reputation and available final plans,
not unimplemented combat bonuses.

Three mutually exclusive final plans follow the investigation and military
supply prerequisites. Three Bells additionally requires the `bell-mourn` and
`stag-dependents` alliances. Its reply explains the missing decisions; refusing
those alliances leaves the other two plans available. Prerequisites are checked
both when choosing and chronologically when replaying a save. A player may agree
on a plan before the commander dies, or postpone the choice to finish local work.
The selected plan is explicitly a commitment, not a completed ritual. Its actual
epilogue appears only after the commander's defeat.

V2 victory requires **both** a chosen final plan and the defeated fortress
commander. Boss death alone does not freeze an unresolved story. Final choice
after boss death completes the expedition without a combat tick; choosing first
leaves the world playable until the boss dies. Defeat and terminal reward rules
otherwise remain unchanged. V1 boss victory is unchanged.

Public `NarrativeInput` commands are `talk`, `choose`, `close`, `inspect`, `track`
and `travel`, with exact fields in `narrative-types.ts`. Map T/talk to
`narrative.interaction`; held E remains military capture/repair/transfer/rest.
NPCs near Roadward are available immediately. Each has authored questions about
local matters and their own experience; only Mara, Ren and Elin offer the military
status topic. If several quests need the same witness, the player chooses a quest
topic before seeing its prompt and replies. A local topic never offers answers to
an unseen quest prompt. Raw commands cannot bypass that topic selection.

Every action separates the player's first-person journal entry from the NPC's
spoken response. Revisited quest-givers respond to their own latest resolution,
not to unrelated events elsewhere. Conditional stage prompts remember particular
earlier choices. `leave` explicitly defers a decision. Civic reputation is separate
from the military faction selected at creation.

The snapshot is authoritative: render both languages from localized fields,
only offer returned choices, respect their `enabled` and `reason`, and show
`notice` after rejected or stale commands. Unknown well-formed IDs and stale
proximity/choice commands get localized notices without progression. Malformed
command structures throw before any mutation. A quest's `targetId` points to its
speaker when discovered, otherwise that speaker's location, so map tracking
does not depend on guessing an undiscovered NPC's coordinates. The `summary`
explains remaining military/story obligations even after the commander dies.

`npcs` includes residents at discovered locations regardless of talk range or
nearby threats. `NpcSnapshot.available` means conversation is currently allowed:
the campaign is playing, the hero is within 4.25m, and both are safe. It is not a
visibility flag; world and map presenters apply their own draw distances.

Locations are discovered on proximity. Travel requires a discovered eligible
stop at both ends, the hero within 7m of the departure road node, the convoy
within 7m of both hero and node, full convoy health, and no living enemy or
incoming hostile projectile within 26m of either body or the destination.
The destination must have an actual local road node and collision-safe space
for both bodies. Travel relocates both, preserves cargo/health/timers, clears
the convoy route and orders it to hold. It cannot rescue an ambushed cart,
abandon the convoy or travel to undiscovered/non-travel locations.

Narrative state lives inside Aegis's `KorovanyCampaign` resource. A bounded
ordered journal of authored action IDs derives quest stages, exclusive outcomes,
reputation and facts; a checked one-time reward ledger matches completions.
Only IDs, discovery, current dialogue/topic, current inspection/evidence IDs,
tracking and a notice code are saved, not translated prose. Restoration rejects
unknown IDs, duplicate/out-of-order actions, contradictory branches, missing
evidence discoveries, invalid topics, out-of-range scenes, simultaneous dialogue
and inspection, stale intent and bypassed military/alliance gates. Both kinds of
reading scene survive exact save/resume without advancing time.

The Hollow Road uses narrative state version **2**, independently of the world
and snapshot protocol versions. Previous story state is deliberately unsupported;
start a new campaign rather than reinterpret old choices. Profile and settings
storage are unchanged. Explicit military-only v1 worlds remain an independent
simulation mode, not a migration path for the old story.

## Simulation and persistence

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
save/resume on explicit v1 worlds. Narrative acceptance drives public v2 input
through every authored branch, all three endings, both orders of story/military
victory, late side quests, corrupt saves and travel prerequisites.
`npm run lock:canonicalize` normalizes only the root game lockfile
after a proxied dependency update; root `.npmrc` retains the corporate registry.
