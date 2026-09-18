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
For v2, `ActorSnapshot.allegiance` explicitly identifies friendly, hostile and
neutral actors. Appearance and political identity never imply hostility. Friendly
soldiers fight hostile forces; the player and friendly projectiles cannot damage
friendly/neutral soldiers or the shipment. `WorldRegion.politicalFaction` exposes
four political territories: elves, Crown, mountain ruler, and independent humans.
`owner`, not faction color, defines controlled holdings. V1 retains its original
rival-house rules, where all combat actors start hostile regardless of color.

Legacy v1 campaign: defeat a post's defenders and hold interact inside its capture radius;
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
world/save version. `GameSnapshot.narrative` and `.campaign` are absent for v1,
present for v2. New v2 worlds have faction-specific world IDs, home sites and
home road aliases; restore reconstructs the same faction world.

## Faction military campaigns

`FACTION_CAMPAIGNS` is the localized public identity/guide configuration.
`snapshot.campaign` supplies identity, current orders, requirement labels and
completion, political standing, shipment status and objective label. Presenters
must use these instead of interpreting generic legacy capture/raid counters.
Sites and named actors have localized `name`; interactions and events can have
localized `label`. The legacy keys remain available for v1.

Each faction has a complete authored journal selected by `getFactionStory`.
An early `StoryAction.directive` is an irreversible military decision, not prose
parsing. It is saved separately and checked against replay of the faction journal.
No new holdings can be claimed or supplied before this decision.

| Faction | Home / authority | Directive and actual prerequisites |
| --- | --- | --- |
| Elf | Greenhollow; Toman and the forest households | `shelter`: liberate/supply forest depot; `interdict`: also take/supply palace supply gate. Both intercept the shipment and escort it to the forest depot, then defeat Raut. |
| Guard | Crownbridge; authorized service under Vesk | Repel the attackers at the already-owned palace supply gate, protect the living shipment to the gate, and supply it. `relief` permits the sortie against Raut; `pursuit` additionally requires quarry capture/supply. Quarry cannot be claimed before the relief shipment and supplied gate; no unauthorized forest conquest. |
| Villain | Old Fort in Frostspine; the player's own army | `dominion`: claim/supply palace gate and quarry, appropriating the shipment for the palace foothold. `plunder`: claim/supply palace gate, but physically return the shipment to Old Fort. Conquer the royal citadel against the Palace Marshal, not Raut. |

`palace` is the supply gate, not the throne. `palace-citadel` is a distinct
Crownlands location and the villain's `fortress` encounter. Elf/guard final combat
is Raut's invasion redoubt. The villain's home soldiers accompany commanded
logistics movements and engage hostile forces; the armed logistics convoy remains
independently commandable.

Old Fort has authoritative `old-fort-wall-*` perimeter blockers: twelve curtain
sections and two tall northern gate towers. The original six building radii are
unchanged; their heights describe stone keeps/towers rather than cottages.
Placement preserves the 9m home clearing and both road approaches. Presentation
must keep the road gaps open rather than adding an invisible gate collision.

The same `enemy-caravan` actor is a Crown ward-glass shipment in all campaigns,
not an enemy simply because of its legacy ID. It begins friendly for guard and
neutral for the other factions. Clear its hostile escort/attackers and hold E
within 4m to assume control after the directive (guard also needs the gate
defense). It follows its actual road route at 4m/s only while the hero is within
22m. Attacks can disable it without deleting it; held E repairs a wreck in five
seconds for free, then continuously repairs damage. Delivery requires a living
wagon physically at its destination and no nearby hostile forces. It grants
90 supplies once. The separate logistics convoy still begins with 30 cargo,
physically supplies holdings, and remains freely repairable.

Required supplied holdings plus shipment delivery unlock the final battle.
All story endings require both that military outcome and the final commander's
death. Dialogue cannot manufacture a military victory. Optional holdings and
local quests remain available before the final story choice.

## The Hollow Road

The expanded campaign contains three different sets of five sequential main
chapters, eight local quests with different investigation lengths and witnesses,
and authored NPCs across the same eight regions. Main chapter completion opens the
next investigation; side quests may be started in any order. Inspecting a relevant
location records the evidence and opens a paused reading scene. Inspection
snapshots expose the location, title and full text; closing the scene does not
remove its evidence from the journal. Revisiting a place cannot grant evidence or
rewards twice.

The shared mystery concerns a shipment's missing crew, a voice that imitates the
dead, and the ward-glass trade, but the witnesses, obligations, decisions and
endings are faction-scoped. It does not add monster combat,
a day/night system or simulated village populations. Local outcomes are recorded
narrative events; they change testimony, reputation and available final plans,
not unimplemented combat bonuses.

Each faction has three mutually exclusive authored final plans. Some additionally
require specific local alliances. Disabled replies explain missing decisions;
refusing an alliance leaves other plans available. Prerequisites are checked
both when choosing and chronologically when replaying a save. A final plan cannot
be selected before the military outcome and commander's defeat.

V2 victory requires **both** a chosen final plan and the defeated fortress
commander. Boss death alone does not freeze an unresolved story. Final choice
after boss death completes the campaign without a combat tick. Defeat and terminal reward rules
otherwise remain unchanged. V1 boss victory is unchanged.

Public `NarrativeInput` commands are `talk`, `choose`, `close`, `inspect`, `track`
and `travel`, with exact fields in `narrative-types.ts`. Map T/talk to
`narrative.interaction`; held E remains military capture/repair/transfer/rest.
Home residents are available immediately. Each has authored questions about
local matters and their own experience; Toman, Vesk, Ren and Elin offer the military
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

Faction campaigns use narrative state version **3**, including an explicit faction,
and military state version **1**, independently of the world
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

The registered `KorovanyCombatant` component owns hostile/friendly forces and the shipment; the
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
