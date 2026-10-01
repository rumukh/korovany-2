# Game-owned Three presentation

Import `createGameView`, `createRenderer`, `GameView` and `GameViewOptions` from `src/view/index.ts`.
The browser presenter imports Three directly, never the Node-only engine renderer.

```ts
const view = createGameView(canvas, campaign.snapshot().world, {
  quality: 'high',
  reducedMotion: false,
});

// The shell owns this loop and all authoritative fixed steps.
view.render(campaign.snapshot(), frameSeconds);
```

| Method | Contract |
| --- | --- |
| `render(snapshot, dt)` | Detached readonly game state and nonnegative cosmetic frame seconds; no simulation updates. Rebuilds and disposes the previous mirror when world, run ID, faction or rewound tick changes. |
| `getMoveBasis()` | Unit `forward` and `right` vectors in world X/Z for shell-owned movement conversion. |
| `screenToWorld(clientX, clientY)` | Ray-plane intersection in world X/Z using the canvas CSS rectangle; `null` for invalid/unavailable intersection. |
| `orbit(deltaYaw, deltaPitch?)` | Radian deltas. Pitch is constrained for third-person visibility. |
| `zoom(delta)` | Wheel-style delta; positive zooms out. Distance is constrained to 18-40 metres. |
| `resize()` | Matches the drawing buffer to the canvas CSS dimensions, without changing CSS. |
| `setQuality('low' \| 'high')` | Low caps DPR at 1, disables shadows, grasses and ambient motes, simplifies tree crowns and releases HDR postprocessing buffers; high caps DPR at 1.75 and enables subtle bloom with multisampled HDR targets. Generated textures remain in both modes. |
| `setReducedMotion(boolean)` | Removes camera lag, ambient motes, water/cape flourishes and dodge trails; reduces gait animation. |
| `dispose()` | Idempotently releases shared geometry/materials/textures, the sky reflection environment, shadow and HDR buffers, instance buffers, renderer resources and owned canvas listeners. A renderer passed in `GameViewOptions.renderer` is borrowed and left for its owner to dispose. |

The shell owns RAF, keyboard/pointer/wheel input, pause, canvas layout and recovery
UI. WebGL 2 creation/context-loss errors are explicit exceptions. There are no
global input handlers or additional animation loops. The initial camera looks
toward positive Z, into the campaign from the southern home. Normal disposal does
not force a context loss, so the shell can reuse its canvas. Keeping one view and
passing a new run's snapshot also safely rebuilds scenery without recreating the
WebGL renderer.

Road widths, water and bridge rectangles, site positions and solid scenery come
from `WorldBlueprint`. `generateWorld(seed, 1)` preserves the original 140-metre
world and its save hashes. The default version 2 is 980 metres square (49 times
the area), with eight bilingual regions and 26 authored locations connected by
road loops and three river crossings. Campaign homes and the military citadel
use their faction-specific authoritative sites. Every exploration location has a matching road-node
ID; NPCs can stand within three metres of its centre without hitting scenery.

Buildings are constrained to real circular wall obstacles, including the new
inns, archives, wells, bell frames, antler shrines, glass ribs and star instruments.
Regional ground, masonry, roofs and foliage distinguish the eight landscapes.
The Hollow Road reuses these authored locations. Books and shelves remain
scenery; evidence and supernatural encounters are presented as paused story
scenes, not additional interactive meshes or monster actors.
Grass and pebbles are excluded from roads, locations, water and blockers. Horizon
mountains stay outside the map. All bridges have level traversable decks; rails
are over solid water outside their exact walkable rectangles. Regional foliage
uses a screen-space dither cutaway around the hero's sightline.

Expanded solid scenery is capped at 1,400 authoritative obstacles. Structures
and cosmetic dressing are instanced in 140-metre cells, with local bounding
spheres for frustum culling and a 190-metre hero-centred cell visibility range.
Geometry and materials are shared across cells. Low quality removes the entire
dressing layer, not the authoritative landmarks. Instance buffers are released
when the world mirror is disposed.

Seven generated surface families use shared color, normal and roughness maps
from `public/textures/frontier`. Albedo is sRGB; normal/roughness data is linear.
Maps repeat with bounded anisotropic filtering and ground UVs are world-scaled.
`ViewResources` accepts a texture loader for the browser; omitting it supports
DOM-free geometry tests. Loading failures are retained and raised to the shell
on the next frame, rather than silently dropping the texture. Resource disposal
also covers images that finish loading after a world mirror is replaced.

The sky dome follows `scenery.heroPosition` in `scenery.update()`, including
teleports to the map corners. The existing 290-metre camera far plane encloses
the 240-metre dome at the maximum 40-metre follow distance. Fog remains local
(64-205 metres), and the player-centred shadow frustum follows the hero
instead of stretching one shadow texture over the full map.
The sky also supplies a prefiltered reflection environment for metal, stone and
wood. Water has view-dependent reflection, sun glints and shallow-bank foam.
The camera keeps its 18-40 metre distance range and allows a 0.38-radian minimum
pitch for landscape views. Tree crowns switch to shared lower-detail geometry
beyond 95 metres and in low quality; this does not change their solid footprint.

Actors and projectiles are keyed by authoritative IDs, with faction silhouettes,
snapshot-driven windups, health and capture/supply states. Combat cosmetics use
the bounded snapshot effect list and deduplicated event IDs; spark bursts and
visible corpses have fixed caps. No presentation entity participates in rules,
and no fake quest, target, actor or pickup is created.

Residents at discovered locations remain visible within the 120-metre world
draw range, with overhead markers within 32 metres and atlas/minimap markers
within 38 metres. These ranges are independent of `NpcSnapshot.available`,
which only permits conversation within 4.25 metres when it is safe. Walking
away or entering danger does not remove residents or their nearby map markers.

Actor appearance and hostility are separate: explicit `allegiance` controls
friendly/neutral ground rings, health bars and hostile attack tells, while faction
controls the detailed uniform. Changing allegiance rebuilds the keyed visual using
shared geometry and textured materials. A mission shipment with zero health and
an idle state is disabled but repairable, not a corpse. The citadel flag follows
its actual faction and changes to the player's banner after defeat; its ground
ring communicates the military state independently.

Old Fort towers and broken curtain sections use the authored circular blockers,
with shared stone and cloth surfaces. A narrow camera-to-hero dither cutaway keeps
the character visible behind foreground masonry; only fort material copies use it,
with unchanged opaque shadow depth. It follows orbit/zoom without changing collision
or the landscape camera, and leaves unobstructing fort surfaces opaque.
Cutaway strength is a per-material uniform (zero on ordinary surfaces), so isolated
fort material copies share compiled programs with matching ordinary materials
instead of creating extra texture/sidedness shader variants.
The structures do not add noncolliding walls across the open road gates.
DOM-free scene assertions construct `Presentation` without
a texture loader; `createGameView` always supplies browser texture resources and
the shared reflection environment.

Shadow depth materials are game-owned as well as visible materials, so changing
runs releases their shader programs rather than retaining Three's implicit shadow
materials. Outpost ownership and deliveries change their heraldry; fortress
heraldry distinguishes locked, unlocked and defeated states without a false gate.

## Cooked 3D models

Eighteen cooked glTF models replace procedural presentation: the troops (the line
soldier, the road archer, the infantry captain and two bosses, Commander Raut and
the Palace Marshal, in `public/models/char-line-soldier/`, `char-archer/`,
`char-captain/`, `char-boss-raut/` and `char-boss-marshal/`), used by every
faction's `soldier`, `archer`, `captain` and `boss` actors; the Echo Well
(`public/models/prop-echo-well/`), used by the Echo Well and the matching
Cinderwell structure; one hero per faction (`public/models/char-hero-elf/`,
`char-hero-guard/` and `char-hero-villain/`), used for the player; and the wagons:
the logistics convoy (`public/models/prop-wagon-convoy/`) with its cargo load
(`prop-cargo-load/`), the Crown shipment and every other `caravan` actor
(`prop-wagon-shipment/`), and the draft ox that pulls both (`char-draft-ox/`); and
the first five named residents, the home residents of each campaign
(`public/models/char-resident-toman/`, `char-resident-lida/`,
`char-resident-vesk/`, `char-resident-ren/` and `char-resident-mara/`).
`residentModelFor()` maps a narrative NPC id to its model; the other fifteen
residents keep their procedural figures until their batch ships.
`troopModelFor()` picks the troop for an actor kind and faction: the Palace
Marshal is the Crown's (guard) boss, Raut the mountain army's. `ModelLibrary`
(`models.ts`) starts loading them through `GLTFLoader` as the page opens, behind
the title menu. Until every
model is ready the world is not drawn and the simulation does not step; a small
status line says so, and a run started early still captures the mouse from its
own click and begins on the first frame the player can see. A load failure stops
on the fatal "assets" panel with the failing URL. There is no primitive fallback;
only DOM-free geometry tests construct `ViewResources` without models.

**Model encoding.** Every skinned body except the mountain sovereign stores its
vertex data and rotation keys quantized (`KHR_mesh_quantization`, which
`GLTFLoader` reads without a decoder). Positions are 16-bit, with their scale and
offset folded into the inverse bind matrices. Normals, tangents and skin weights
are 8-bit, and UVs and rotations 16-bit. The cook decodes every value again and
records the worst errors in each `provenance.json`. Quantized files are about a
third smaller and look the same in the game. The mountain sovereign stays float:
quantization pushed two of its clips over the 2.0x strain limit. Weapons and other
items, the wagons, the cargo and the Echo Well are static meshes and stay float.
Code that needs a skinned model's size must measure it through the skin (`Box3`
does this), not from the raw `position` attribute.

Troop instances (`CharacterInstance`) are `SkeletonUtils` clones driven by an
`AnimationMixer` from snapshot state and render time: `Idle`, `AtEase` (while a
story scene is open), `Run` (moving faster than 0.35 m/s, played at the ratio of
the measured ground speed to the troop's `runSpeed`), `Windup`, `Strike` and
`Recovery` (scrubbed by snapshot progress, each lasting exactly as long as the
actor kind's state), an additive `Hit` on health loss, and `Death`, which is held
as the corpse. All troops are cooked at human size; `TROOPS` scales the captain
by 1.2 and the bosses by 1.7 at runtime, the sizes of the procedural figures they
replace, and their Run clips are authored at the world speed divided by that
scale so planted feet stay planted. Reduced motion freezes the idle breathing and
suppresses hit reactions. Clips carry no root motion; position, heading,
collision and timing stay authoritative. Faction and allegiance colour the
soldier's tabard and shield, the archer's hood, shoulder cape and tabard and the
captain's tabard through one dyed material program (`korovany-dye-v1`, dye mask
in the base-colour alpha); the bosses wear fixed colours and have no dye mask.
Colour variants therefore add no shader variants. Because that alpha is a mask rather than
coverage, dye-masked base colour is encoded with libwebp's `exact` option
(`pipeline/webp_exact.py`): the default lossy mode discards the colour of every
texel whose alpha is 0, which is every undyed surface. The well scales uniformly
into its circular blocker and shares one geometry and material across instances.

The hero (`HeroInstance`) is a `SkeletonUtils` clone with 14 clips: `Idle`,
`AtEase` (while a story scene is open), `Interact` (while interaction progress
rises), the directional runs `Run`, `RunBack`, `RunLeft` and `RunRight`, `Sprint`
(blended in by ground speed), `Dodge` (while the player dodges), the `Attack`
and `AttackB` swings (alternating, on the player's own attack events), `Ability`,
an additive `Hit` on health loss, and the held `Death`. Movement comes from the
snapshot's velocity in the hero's frame. Every locomotion clip shares one stride
phase advanced by that ground speed, so planted feet keep the authored stride.
Diagonal travel uses orientation warping rather than a stride blend: the body
turns by up to 55 degrees onto the nearest directional clip's travel axis, and
spine and chest counter-twist (at most 60 degrees) back towards the heading.
Attacks and the ability drive the whole body while the hero stands and only the
upper body while it moves. Reduced motion holds a still stance and suppresses the
flinch. The heroes share the soldier's dyed program; only the palace officer's
shield face is dyed, so a hero adds no shader program.

A cooked resident (`ResidentInstance`, built by `WorldResidents` in `residents.ts`) is a
`SkeletonUtils` clone with two planted loops: `Idle` (two breaths, a slow weight
shift and a glance) and `Talk`, which plays while `narrative.dialogue.npcId` names
that resident. The mixer runs on render time, so the speaker keeps gesturing while
the conversation pauses the simulation; the clips cross-fade over 0.4 s, and
neighbouring residents start Idle at their own phase. Reduced motion holds Idle's
first frame still and shows no conversation gestures. Placement, the 8 m facing
rule, the 120 m draw range, the teal ring and the quest marker stay the
presenter's, exactly as for the procedural figures. A resident takes the troops'
skinned dyed program with an empty mask and the model shadow-depth material, so
residents add no shader variants. The clips are keyed at 30 Hz (the slow standing
motion interpolates within the per-frame limits) and the occlusion/roughness/metal
map is 512 px. Like the other skinned bodies (see "Model encoding" below), its
vertex data and rotation keys are quantized, which keeps each resident near 0.8 MB.

A wagon (`createModelWagon` in `actors.ts`) is a clone of its cooked scene: a
static TRELLIS body, one Blender-authored node per axle (both wheels and the axle
tree) and the harness (shafts, the duga arch with a small bell, and a rippled
pennant whose colour shows from any side).
The wheels spin about their axle by the distance travelled on each simulation
tick over their own radius, so they roll without slipping; a jump by fast travel
does not spin them. The body and wheels lean 0.085 rad while the wagon is disabled
(0.27 for a destroyed legacy caravan) and sway slightly while moving, except under
reduced motion. The convoy's cargo load sits on its `socket-cargo` and is hidden
while the convoy carries no cargo. The draft ox (`OxInstance`) stands at
`socket-ox`: a `SkeletonUtils` clone whose mixer blends `Idle`, `Walk`, `Trot` and
`Canter` by the wagon's measured ground speed (with hysteresis) and plays each gait
at that speed over its authored one (1.15, 4 and 5.8 m/s), so its hooves stay
planted at the simulation's wagon speeds (1.15 for legacy caravans, 4 for the
shipment, 4.7-6.95 for the convoy); a speed-matched canter is not how a real ox
moves, but the wagons' road speeds are fixed by the simulation. An additive `Hit`
plays when the wagon loses health. Reduced motion stills the idle and skips the
flinch. Each frame the harness pitches about its hinge to follow the midpoint of
the ox's hame-hook joints, so the shafts ride with the ox's gait. Collision,
speed, heading and health stay the simulation's; the models never change them.
The body keeps the Echo Well's plain prop program; the wheels and harness share
one dyed material whose only masked region is the pennant (the convoy flies its
faction's colour, the shipment its allegiance); the ox takes the troops' skinned
dyed program with an empty mask. The wagons therefore add no shader variants.

After a world mirror is built and after every quality change, `createGameView`
calls `Presentation.warmModels()` in the same task as the next real frame: a
temporary soldier visual (model, ring, health bar, tell) and well are drawn twice,
alone, together with the current hero, one of each other troop model the
campaign shows, both wagons with their oxen and the convoy's cargo, and one of
each cooked resident the world currently lists (sharing the soldier's and the
well's programs, so only their textures upload),
with the scene's real lights, fog, shadow
maps and output path, then removed, so no model shader compiles when a soldier
first appears (aegis-engine
#6). Every other renderable is hidden for those two draws, and they shade a single
scissored pixel (`compileFrame`), or a 4×4 target when frames go through
post-processing, so warming pays for compiling the model programs rather than for
extra full-scene shadow and vertex passes on software GL. Without
warming, the first soldier creates seven programs (two dyed lit programs, four
shadow-depth variants and the shared unlit health-bar program); `GameView.warmup`
reports the latest warm-up. Instances and skeletons are released with the world
mirror. The page-lifetime library owns the shared geometry, textures, dyed
variants and the model shadow-depth material, and `main.ts` passes one renderer
from `createRenderer()` to every view it creates, so model uploads and model
programs are paid once per page rather than on every title, faction or run
change. A view that creates its own renderer releases the library's GPU copies
(`releaseGpu`) before disposing it.

Each model's concept, recipe, provenance and three approval decisions are in
`scripts/models/<id>/`, with the Blender cooking scripts in `scripts/models/pipeline/`.
The models were reconstructed with TRELLIS-image-large, whose textured export
depends on components licensed for research and evaluation only; no commercial
clearance exists for this output, and the project owner acknowledged publishing
it on the public site. `tests/models.test.ts` checks every shipped byte against
its provenance and verifies every 60 Hz frame of every soldier clip (weights,
foot contact and sliding, loop closure, clearance, joint scale, rigid parts and
crease strain), including deliberately broken copies that must fail.
`tests/hero-models.test.ts` does the same for every hero clip, drives each hero
through the presenter with real campaign inputs, and checks foot planting in
eight directions. `tests/troop-models.test.ts` does it for the archer, captain
and bosses, whose telegraphed clips must last exactly as long as the simulation's
windup and recovery. `tests/wagon-models.test.ts` checks the wagons' structure
(a static body, one wheel node per axle touching the ground, a harness whose
shafts meet the ox's hame hooks, budgets and WebP maps) and the cargo's fit in the
convoy's bed, verifies every frame of every ox gait at its authored speed with
broken copies that must fail, and drives both wagons through the presenter:
wheels roll by distance over radius, the gait follows speed, lean and cargo follow
the convoy, and a takeover rebuilds the shipment with a friendly pennant.
`tests/wagons-browser.test.ts` decodes their textures, renders both wagons on the
warmed programs and stops with an asset error when a wagon model is missing.
`tests/resident-models.test.ts` checks each resident's structure (one skinned body
within 10,000 triangles, WebP maps, its height and +Z facing), verifies every 60 Hz
frame of Idle and Talk as planted loops with six broken copies that must fail, and
drives the residents through `WorldResidents` with real campaign snapshots: home
and Roadward residents are cooked on the shared program, the others stay
procedural, Talk follows the open conversation on render time, reduced motion holds
still, removal and disposal release their clones, and a missing model fails instead
of falling back. `tests/residents-browser.test.ts` decodes their textures, renders
Greenhollow's residents talking and still on the warmed programs, and stops with an
asset error when a resident model is missing.
