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
| `render(snapshot, dt, hold?)` | Detached readonly game state and nonnegative cosmetic frame seconds; no simulation updates. Rebuilds and disposes the previous mirror when world, run ID, faction or rewound tick changes. `hold` says the shell will not advance the scene (paused, at the title or behind a menu) under reduced motion: once the scene has settled, a frame that would repeat the last one drawn is skipped and the canvas keeps it. |
| `getMoveBasis()` | Unit `forward` and `right` vectors in world X/Z for shell-owned movement conversion. |
| `screenToWorld(clientX, clientY)` | Ray-plane intersection in world X/Z using the canvas CSS rectangle; `null` for invalid/unavailable intersection. |
| `orbit(deltaYaw, deltaPitch?)` | Radian deltas. Pitch is constrained for third-person visibility. |
| `zoom(delta)` | Wheel-style delta; positive zooms out. Distance is constrained to 18-40 metres. |
| `resize()` | Matches the drawing buffer to the canvas CSS dimensions, without changing CSS. |
| `setQuality('low' \| 'high')` | Low caps DPR at 1, disables shadows, grasses and ambient motes, simplifies tree crowns and releases HDR postprocessing buffers; high caps DPR at 1.75 and enables subtle bloom with multisampled HDR targets. Generated textures remain in both modes. |
| `setReducedMotion(boolean)` | Removes camera lag, ambient motes, water/cape flourishes and dodge trails; reduces gait animation. |
| `invalidate()` | The next `render` draws even under `hold`; the shell calls it when the page becomes visible again. |
| `dispose()` | Idempotently releases shared geometry/materials/textures, the sky reflection environment, shadow and HDR buffers, instance buffers, renderer resources and owned canvas listeners. A renderer passed in `GameViewOptions.renderer` is borrowed and left for its owner to dispose. |

The shell owns RAF, keyboard/pointer/wheel input, pause, canvas layout and recovery
UI. WebGL 2 creation/context-loss errors are explicit exceptions. There are no
global input handlers or additional animation loops. The initial camera looks
toward positive Z, into the campaign from the southern home. Normal disposal does
not force a context loss, so the shell can reuse its canvas. Keeping one view and
passing a new run's snapshot also safely rebuilds scenery without recreating the
WebGL renderer. A new run on the same world (a campaign begun or continued from
its title preview, or a restored save) keeps the world's presentation, its
terrain, scenery, sites and animals, and `Presentation.resetRun()` releases only
the run's visuals (hero, banner, convoy, troops, monsters, residents, effects),
so starting a run no longer rebuilds the whole world (measured under SwiftShader:
1.8 s to 0.08 s for a version 3 world).

With reduced motion the paused scene is already still, so redrawing it every
frame only costs time: a version 3 frame took 370-470 ms under SwiftShader at
480 x 320 whether the game played or sat behind the pause menu. The shell passes
`hold` while the simulation is not running and the player chose reduced motion.
The view then draws until `Presentation.settled` holds and skips every frame that
would repeat the last one: same snapshot object, same presentation, no resize,
orbit, zoom, quality or motion change since, no model or world asset loading and
no pending warm-up. `settled` needs every texture loaded and every animated
figure at rest: troops, beasts, the ox and residents with their blend weights on
their goals and no death or flinch playing, the hero also turned onto its facing
with no swing, dash or death left, every spark burst burnt out and the fog eased
onto its region's air. The hero's last ten-thousandth of a radian of turn and the
fog's last invisible fraction of its ease snap onto their targets, so a settled
scene is exactly still. Normal motion never holds: flags, water, weather and
breathing keep animating behind menus. Under SwiftShader this cut the controller
"camera inversion" browser test from 49-57 s to 24 s.

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
scenes, not additional interactive meshes or monster actors: the Caller is never
shown. Version 3's grave wolves, barrow ghouls and bog trolls, beasts of the borderland outside the story,
are the only monsters (`MonsterInstance`, see "Version 3 worlds" above).
Grass and pebbles are excluded from roads, locations, water and blockers. Horizon
mountains stay outside the map. All bridges have level traversable decks; rails
are over solid water outside their exact walkable rectangles. Regional foliage
uses a screen-space dither cutaway around the hero's sightline.

Expanded solid scenery is capped at 1,400 authoritative obstacles. Structures
and cosmetic dressing are instanced in 140-metre cells, with local bounding
spheres for frustum culling and a 190-metre hero-centred cell visibility range.
Geometry and materials are shared across cells. Low quality removes the entire
dressing layer, not the authoritative landmarks. Instance buffers are released
when the world mirror is disposed. Each candidate tuft or pebble is checked
against only the obstacles and roads of its 8-metre grid cell (`dressingFilter`),
with the same tests as `isDressingAllowed`, so a version 1 or 2 scenery build
takes about 0.2 s instead of about 2 s, with identical placements.

## Version 3 worlds (new campaigns)

The browser shell starts new campaigns in version 3; saved version 1 and 2 campaigns keep their own worlds.
A version 3 blueprint (`generateWorld(seed, 3)`, `CampaignOptions.worldVersion: 3`) is drawn by
`createWorldSceneryV3` (`scenery-v3.ts`) instead of `createWorldScenery`; versions 1 and 2 are drawn exactly as before.
Every v3 obstacle names a `model` from the world asset registry (`world-assets.ts`: buildings, walls, fences, farm and
village props, trees, boulders, the reeds, and the sheep, crows, deer, goats and grave wolves), which is separate from the cooked characters and story
props in `models.ts`: own files (`public/world/<id>/<id>.glb`, `public/world/surfaces`), provenance (`scripts/world`)
and budgets.
`createGameView` needs a page-lifetime `WorldAssetLibrary` in `GameViewOptions.worldAssets` and presents a v3 world
only once `worldAssetIds(world)` and the surface layers have loaded; a failed load is thrown by `render` (there is no
primitive fallback). Version 1 and 2 worlds request nothing from it. `assetsReady(world, models, worldAssets)` is that
rule, and `main.ts` holds the simulation and shows its loading line on the same rule for the shown world, so a
version 1 or 2 campaign continued from the version 3 title preview starts once its models are in, without waiting for
the preview's world assets.

- **Surfaces.** Thirty-two 512 px tiling layers (`WORLD_SURFACES`: architecture, ground, rock and bark) form two
  `DataArrayTexture`s: the sRGB albedo, carrying in its alpha the roughness that `deriveSurface` derives at load from
  each layer's grayscale height map, and an RG8 array of the tangent normal's X and Y derived the same way. Kit, bark and rock meshes carry the layer index in UV1.x and baked AO in UV1.y and
  share one program (`kitMaterial`); the ground blends eight layers by 1024-texel control maps (`terrainMaterial`,
  `terrainControl`) with height-based transitions and furrows turned along each field: meadow, forest, mud, road and
  field everywhere, a regional base and overlay (`REGION_GROUND`: reed mud in the Fens, cold grass with shingle on the
  Salt Coast, ash on the Ash Steppe, cold grass with snow in the Frostspine, cold grass in Hollowvale), a dark needle
  floor where the Greenmarch and Hollowvale forests stand densest (`REGION_GROUND.deep`, by local tree density), cobbled
  streets in the stone towns (`COBBLED_PLACES`) and fortress courtyards (`COURTYARDS`: cobbles in the Royal Citadel,
  trampled ground in the Old Fort). The layers ship as WebP and upload as RGBA8 and RG8; KTX2/Basis was measured
  at W0 and deferred (ETC1S saved 282 KB and 15 MiB of GPU memory but needs a 585 KB transcoder). The whole v3 world
  needs about 151 MiB of texture memory, within its 160 MiB budget; props use 256 px normal and ORM maps (the W0 farm
  props were recooked so in W4b), the small ones a 256 px albedo, the sheep, deer, goats and grave wolves 512 px maps,
  and the barrow ghoul and bog troll a 512 px base colour with 256 px normal and ORM maps.
- **Settlements.** Each region builds its own vernacular from the scripted kit (`build_kit.py`, `build_kit_w1.py`):
  timber cottages, longhouses and barns in the Heartlands, the Greenmarch and Hollowvale, stone and brick houses,
  jettied townhouses with cobbles in Crownbridge, stilt huts and a reed-roofed chapel in the Fens, salt sheds and
  upturned-hull shelters on the coast, a glass kiln at Cinderwell; inns with stables and walled courtyards, smithies,
  watchtowers, market stalls, and dry-stone or fenced yards. Cooked props dress them (bell posts, stocks, handcarts,
  crates, troughs, anvils, lantern posts, net racks, beehives, graveyards with warded graves) and the roads
  (signposts at junctions, wayside shrines and gibbets at turns).
- **Castles, ruins and landmarks.** `build_kit_w2.py` adds a 6 m curtain module and its ruined variant, round,
  square and ruined towers, a keep, a gatehouse arch, a roofless chapel and house, and a timber camp tower. Curtain
  runs are boxes the presentation fills with repeated modules (`V3_MODULES`; ruined modules turn end for end at
  random); round pieces (`V3_ROUND`) are circles and turn by a hash of their id. Gate arches are presentation-only
  `WorldBlueprint.decor` (drawn like the kit, never colliding; nothing of an arch comes below 6.8 m). The cooked
  landmarks kept from v2 are drawn through `legacyWall` as before but with the sightline cutaway, like the kit.
  Remains (giant skulls and ribcages, troll gibbets, standing stones) are cooked props.
- **Wild lands.** `build_nature_w3.py` (importing build_nature.py's helpers unchanged) adds black pines, twisted oaks
  and dead birches and re-cooks the W0 trees, all with a middle level of detail (`lod1-wood`/`lod1-leaves`, drawn from
  24 m) before the impostors at 58 m; crags (`rock-crag-<style>-<a..d>`, overlapping convex blocks with a rubble talus,
  drawn from their own long-range `ScatterField` to 560 m with shadows within 150 m) standing on the lowest ground under
  their talus; and the forest floor (`rock-mossy`, `wood-log`, `wood-stump`, drawn at the obstacle's scale, logs pitched
  to the ground between their ends). `farMountains(world)` adds the presentation-only ranges behind the ring, crags at
  2.4 to 5.2 times their size wholly outside the bounds; `undergrowth(world)` scatters bracken and bramble clumps
  (`plant-*`, tree layout with 128 px impostors, no shadows, whole within 30 m and gone by 70 m) round a regional share
  of trees on walkable ground off roads, fields and clearings. Where the dark forests' trees stand close (8 m cells,
  box-filtered), the region's overlay slot paints the `darkforest` layer (`REGION_GROUND.deep`).
- **Water.** `makeWaters` (`waters.ts`) draws the river (ending at the coast), every lake and the sea in one mesh on one
  program (`korovany-water-v3`; v3 no longer draws the v1/v2 river plane). Each vertex carries its water's tint (the
  river and the Fen meres peat-dark, forest pools black, tarns slate, steppe pools a bitter grey-green, the sea grey) and
  a shore band: silt in the shallows, ripples from four directions faded with distance (no stripes on far water), faint
  wind slicks, a swell and uneven surf lines on the sea; a small polygon offset keeps the open sea, which runs 400 m
  beyond the bounds into the fog, above the far apron. Beds are carved below the water plane (`LAKE_BEDS`, `waterDepth`);
  the relief lies level within `LAKE_BANK` (6 m) of every shore, banks are muddy (`terrainControl`), and the Salt Coast
  gets a shingle beach, wet for its last two metres. `shoreDressing(world)` (`shores.ts`, presentation only) stands reed
  beds (`plant-reeds`, `build_nature_w3b.py`) along the shores in runs, two deep, mostly in the shallows (densest on the
  Fen meres, sparse rushes on the tarns), drowned dead trees and stumps in the meres and pools, and boulders in the surf
  at rocky points on the coast.
- **Terrain.** `terrainFor(world)` is a presentation-only heightfield (exactly 0 for v1/v2): level on roads, sites,
  clearings, footprints, fields, shores, combat zones and within `LAIR_FLAT` (40 m) of every monster lair and haunt, hills
  elsewhere with slopes of at most about 11 degrees. Terrain
  chunks are 128 m meshes of 2 m quads. Actors, residents, pickups, effects, rings, the sun target and the camera
  focus stand on it; the river channel and the lake and sea beds are carved below the water plane.
- **Instancing.** Static models are pooled per model, variant and distance band in a `ScatterField`: each update
  submits only instances in the camera's horizontal view cone (plus everything within 36 m of the hero), with shadows
  near the hero only and tree impostors beyond 58 m, so a kilometre of forest costs one draw per part. Whole 32 m cells
  that no instance of theirs could pass (beyond reach, or outside the cone widened by the cell's largest instance) are
  skipped before their instances are tested, which never changes what is drawn (`tests/scatter-culling.test.ts`).
  Impostor cards dither away as they turn edge-on (`applyEdgeFade`), so a crossed or top card never shows as a line. The
  shader warm-up draws one instance of every pool of both fields (and one sheep, crow, deer and goat), so no species,
  impostor, crag, reed or prop compiles on first sight.
- **Cutaway.** Architecture dithers within 1.6-3.2 m of the camera-to-hero sightline; canopies and trunks in a cone
  3-6 m wide at the hero and twice that at the camera, and crags (11-30 m tall) in a cone 3.5-7 m wide at the hero
  (`applySightlineDither`'s radius and widening are uniforms on
  the shared program). Kit walls are one-sided, so a building is not drawn while the camera is inside its bounds
  grown by 2 m (`ScatterKind.hollow`); a low camera behind a tall chapel or inn sees through it, never into it.
- **Light.** `lightWorldV3` is an overcast late-autumn grade (cooler sky and fog, a lower sun); character light stays
  within 10 percent of the v1/v2 calibration (measured 0.96 on the line soldier).
- **Air and weather (W5, `weather.ts`).** `WorldWeather` gives each wild region its own air (`REGION_AIR`): a dim
  green-grey fog under the Greenmarch and Hollowvale forests, a pale thick mist on the Fens (near 16 m, far 138 m), a
  brown ash haze on the Ash Steppe, cold haze on the Frostspine and sea haze on the Salt Coast. The fog, the background
  and the sky dome's horizon move together towards the hero's region over about 1.6 s, and a region's air fades out
  over its last 40 m (`regionWeights`); the heartlands and the Crownlands keep the base grade. One point cloud
  (`world-weather`, one shader program, compiled by the load-time warm-up) draws tumbling leaves in the forests,
  charcoal ash with rare embers on the steppe, snow on the Frostspine and will-o'-wisps over the Fens; it hangs still
  in the world and wraps round the hero, so the particles drift with the wind rather than the camera. Particles show at
  high quality without reduced motion; the air always applies. Presentation only; version 1 and 2 scenes are unchanged.
- **Animals.** `WorldFauna` grazes sheep flocks on settlement pastures (deterministic from the seed; each flock's
  home is the first walkable point of its stubble field, since haystacks may stand anywhere in it). They flee the
  hero within 9 m, move with the world's own `isWalkable`, stop animating beyond 60 m, hide beyond 120 m and freeze
  in reduced motion. Crow flocks (`crowHomes`) peck on the other stubble fields, at chapels, gibbets, the giant
  remains and the Echo
  Well; they take off when the hero comes within 10 m, fly off and land again once the hero is 34 m away (the
  perched and flying models swap at take-off and landing). `WorldHerds` (`herds.ts`) keeps herds of red deer hinds in
  forest glades (at least six trees within 20 m) and bands of feral goats at the feet of crags (`herdHomes`, 13-14 herds
  and about 70 animals a world, 45 m from people and 14 m from roads); a herd startles together when the hero comes
  within 18 m (deer) or 11 m (goats), bounds away swerving round solids and water, and settles again once clear.
  Animals are never in snapshots, saves or rules.
- **Monsters.** Grave wolves (`char-wolf`, a fauna model cooked by `cook_monster_quadruped.py`), barrow ghouls and bog
  trolls (`char-ghoul`, `char-troll`, cooked by `cook_monster_biped.py` on the troops' humanoid rig), all with the
  `MONSTER_CLIPS` contract and their own gaits (`MONSTER_GAITS`), come from `GameSnapshot.monsters`, not `actors`, and are drawn by `MonsterInstance` (`monsters.ts`), the
  troops' clip logic for a beast: Idle, then Walk or Run by ground speed (a wolf runs above 2.2 m/s), Windup, Strike and
  Recovery scrubbed by the snapshot's progress through those states, Hit added on a wound and Death held at its last
  frame. Monsters are never dyed and carry no allegiance ring; a hostile health bar shows once wounded or winding up,
  and the windup's red tell ring has the beast's reach (wolf 1.9 m, ghoul 2.1 m, troll 3.2 m). Bodies lie along steep
  ground like the troops' (lairs and haunts are level anyway). `worldAssetIds` adds each lair's and haunt's species
  model, and the warm-up draws one beast per species. The barrow (`kit-barrow`, `build_kit_w4.py`) is a kit piece. The
  audio presentation howls (far and quiet) as a pack appears, howls again as it turns on the hero, snarls at each
  windup, yelps at a wound and cries at a death, from its own manifest (`public/audio/beasts`, synthesised by
  `scripts/audio/synth_beasts_w4b.py`, which imports the wolf's `synth_beasts.py`; the soundtrack's manifest is
  unchanged), each species with its own voice, and hunting beasts start the combat music.

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

Forty-eight cooked glTF models replace procedural presentation: the troops (the line
soldier, the road archer, the infantry captain and two bosses, Commander Raut and
the Palace Marshal, in `public/models/char-line-soldier/`, `char-archer/`,
`char-captain/`, `char-boss-raut/` and `char-boss-marshal/`, the elves' own
forest warden, ranger and warden captain in `char-elf-soldier/`,
`char-elf-archer/` and `char-elf-captain/`, and the mountain army's own axeman,
bowman and hammer captain in `char-mountain-soldier/`, `char-mountain-archer/`
and `char-mountain-captain/`), used by the factions' `soldier`,
`archer`, `captain` and `boss` actors; the Echo Well
(`public/models/prop-echo-well/`), used by the Echo Well and the matching
Cinderwell structure; one hero per faction (`public/models/char-hero-elf/`,
`char-hero-guard/` and `char-hero-villain/`), used for the player; and the wagons:
the logistics convoy (`public/models/prop-wagon-convoy/`) with its cargo load
(`prop-cargo-load/`), the Crown shipment and every other `caravan` actor
(`prop-wagon-shipment/`), and the draft ox that pulls both (`char-draft-ox/`); and
all twenty named residents: the home residents of each campaign and the Roadward pair
(`public/models/char-resident-toman/`, `char-resident-lida/`,
`char-resident-vesk/`, `char-resident-ren/` and `char-resident-mara/`), the
residents of Cinderwell, Hollow Village and the Last Archive (`char-resident-beran/`,
`char-resident-tessa/`, `char-resident-ada/`, `char-resident-mila/` and
`char-resident-elin/`), Lev at the Star Monastery, Yara at Thornwatch, Nika
at the High Pass, Radek at the Bell Foundry and Oss at the Lantern Ferry
(`char-resident-lev/`, `char-resident-yara/`, `char-resident-nika/`,
`char-resident-radek/` and `char-resident-oss/`), and Ivet at the Reed Chapel,
Sella at Mirecross, Orsa at Saltmarket, Hana at the Tide Observatory and Dren at
Wreckers' Rest (`char-resident-ivet/`, `char-resident-sella/`,
`char-resident-orsa/`, `char-resident-hana/` and `char-resident-dren/`); and the
six signature landmarks and three pickups described below.
`residentModelFor()` maps a narrative NPC id to its model; the procedural figure
remains only for DOM-free tests that construct `ViewResources` without models.
`troopModelFor()` picks the troop for an actor kind and faction from
`FACTION_TROOPS`: the Crown wears the line soldier, road archer and infantry
captain, the elves and the mountain army their own troops; the Palace Marshal is
the Crown's (guard) boss, Raut the mountain army's. `ModelLibrary`
(`models.ts`) loads them through `GLTFLoader`, per campaign: `campaignModelIds()`
lists every model a campaign can show from a snapshot on (the player's hero, the
troop of every actor, the boss faction's soldier for its reinforcement wave, both
wagons with the ox and cargo, the pickups and, in a world with a story, all
residents and the Echo Well and landmarks standing in it), and `main.ts`
requests that set whenever it presents a title preview, a new run or a resumed
one. The other factions' heroes and boss are never fetched for a campaign that
cannot show them, and a campaign without elf troops (the mountain sovereign's)
never fetches theirs; a story campaign preloads 28.0 to 29.3 MB of the 33.9 MB
of models and a legacy one about 13.1 to 13.6 MB (`tests/campaign-models.test.ts` checks the
sets, the 30 MB budget and full runs, including the reinforcement wave). Loaded
models stay for the page, so a faction picked again or the run started from the
title's preview never waits twice. Until every requested
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
quantization pushed two of its clips over the 2.0x strain limit. The static props
(the wagons, the cargo and the Echo Well) are quantized too, by
`quantize_static_glb.py`: 16-bit positions with one uniform scale per mesh held
in its node, with no offset, so the wagon wheels still spin about their axles;
8-bit normals and tangents; and 16-bit UVs. The landmarks and pickups use
`quantize_prop_glb.py`, which centres the 16-bit position range on each mesh's
bounding box (the node holds the scale and the centre), so an 18 m tower keeps
its worst position error near 0.14 mm. Weapons and other character items stay
float. Code that needs a skinned model's size must measure it through the skin
(`Box3` does this), not from the raw `position` attribute. Static meshes are
measured through their node transforms.

Before quantization, models from batch D4 on pass through `repair_tangents.py`.
It checks that every vertex normal is unit length and replaces any zero-length
tangent with the mean of its neighbours' tangents, made perpendicular to the
normal. Blender's MikkTSpace returns a zero tangent where every face around a
vertex has a degenerate UV mapping. three.js normalizes tangents in the vertex
shader, so a zero tangent shades its triangles NaN, and at high quality the bloom
spreads that over a black block of the frame. The repair changed one vertex of
Ivet and no others. `tests/models.test.ts` checks that every shipped normal and
tangent is a finite unit vector.

Every model's geometry, skin and animation data are then compressed with
`EXT_meshopt_compression` (`meshopt_glb.mjs`). First each mesh's vertices and
triangles are reordered for locality, which the codecs need. The mesh itself is
unchanged: the same vertices with the same attribute values, and the same
triangles with the same winding. No lossy filter is used, so decoding restores
exactly that reordered data. Files are about a fifth smaller. GitHub Pages
already gzips GLBs, so on its own this step cuts the download by only about 7%.
Quantization is what makes the static props smaller to download.
Textures stay WebP and are not compressed again.
`gltfModelSource()` gives `GLTFLoader` three.js's bundled WebAssembly
`MeshoptDecoder`. The files require the extension and their fallback buffer holds
no data, so a loader without the decoder fails instead of drawing anything.

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
captain's tabard, on the elves the hood, mantle and tunic, the round shield's
face, the ranger's hood, mantle and tunic and the warden captain's tabard, and on
the mountain army the axeman's surcoat and shield face, the bowman's tunic and
the hammer captain's skirt, through
one dyed material program (`korovany-dye-v1`, dye mask in the base-colour alpha),
so an elf or mountain troop wears its faction colour, neutral stone grey or the legacy
run's shared brick-red hostile colour by the same allegiance rules as every
troop; the bosses wear fixed colours and have no dye mask. The elf
warden carries a leaf-bladed sword and a round shield, the ranger a longbow and
quiver, and the warden captain a two-handed leaf glaive swung with the captain's
hammer clips; the mountain axeman carries a bearded axe and an iron-rimmed round
shield, the bowman a shorter bow and quiver, and the captain a great hammer;
these items are Blender meshes (`pipeline/k2items_g.py`, `pipeline/k2rig.py`).
Colour variants therefore add no shader variants. Because that alpha is a mask rather than
coverage, dye-masked base colour is encoded with libwebp's `exact` option
(`pipeline/webp_exact.py`): the default lossy mode discards the colour of every
texel whose alpha is 0, which is every undyed surface. The line soldier's Phase 1
cook predates the in-cook tone calibration the other troops have, so
`pipeline/derive_tone_cook.py` lifts its saved base colour afterwards by the same
luma power (0.6, chroma kept, dye mask unchanged), re-encodes only that image with
the same `exact` settings and verifies that the rest of the file is byte-identical.
The well scales uniformly
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
map is 512 px. Like the other skinned bodies (see "Model encoding" above), its
vertex data and rotation keys are quantized and then meshopt-compressed, which keeps
each resident between 0.45 and 0.65 MB.

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

The six signature landmarks replace the procedural structures of their
locations' buildings, as the Echo Well does (`LANDMARK_PLACES`,
`landmarkModelFor()`, `locationStructure()`). The Ward-Bell Frame stands at the
Bell Foundry and the Reed Chapel, the Stag Shrine Gate at the Stag Shrine, the
Frozen Beacon at the Frozen Beacon, and the Tide Observatory Armillary at the
Tide Observatory and the Star Monastery's first building. The Ward-Glass
Outcrop stands at the Glass Quarry and the Ash Cairn at the Ash Cairn
(`public/models/prop-ward-bell/` and the matching folders). Each copy is scaled
uniformly so every vertex stays inside its building's authoritative circular
blocker, faces the location centre and is drawn through the world's instanced
static batches with the scenery's shadow-depth material. Footprints, collision
and narrative stay the world's. The three pickups (`PICKUPS`:
`prop-pickup-coin`, a coin purse; `prop-pickup-health`, a healer's satchel with
no red cross; `prop-pickup-supply`, a pine crate with a roped sack) replace the
procedural coin, healer's parcel and crate in `WorldEffects`. Each kind is one instanced draw of its
cooked geometry and material, with no per-instance colour and so no extra shader
variant. It is scaled to the procedural pickup's size and height, bobs on the
same cosmetic curve, and only the coin purse spins. Reduced motion holds every
pickup still, as before. Collection radius, amounts and timing stay the
simulation's. Without a model library (DOM-free tests) the procedural
structures and pickups remain; with one, a landmark or pickup that failed to
load stops the game on the asset error. A landmark has at most 15,000 triangles
and 1024 px maps (0.71 to 0.91 MB per file) and a pickup at most 3,000 triangles
and 512 px maps (0.25 to 0.29 MB); together the nine add 5.70 MB. The three elf
troops add 2.67 MB (0.80 to 1.01 MB each) and the three mountain troops 2.62 MB
(0.83 to 0.90 MB each), so the forty-eight models total 33.9 MB, of which one
campaign preloads its own set.

After a world mirror is built and after every quality change, `createGameView`
calls `Presentation.warmModels()` in the same task as the next real frame: a
temporary soldier visual (model, ring, health bar, tell) and, in story worlds, the
well are drawn twice,
alone, together with the current hero, one of each other troop model the
campaign shows, both wagons with their oxen and the convoy's cargo, one of
each cooked resident the world currently lists (sharing the soldier's and the
well's programs, so only their textures upload), and one instanced copy of
every landmark the campaign loaded and every pickup (compiling the instanced static programs and
uploading their textures),
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
drives the residents through `WorldResidents` with real campaign snapshots: home,
Roadward, Cinderwell, Hollow Village and Last Archive residents (each location
reached by a real walk) are cooked on the shared program, the others stay
procedural, Talk follows the open conversation on render time, reduced motion holds
still, removal and disposal release their clones, and a missing model fails instead
of falling back. `tests/residents-browser.test.ts` decodes their textures, renders
Greenhollow's residents talking and still on the warmed programs, and stops with an
asset error when a resident model is missing.
