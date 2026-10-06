# Korovany II: The Hollow Road / Глухой тракт

A standalone, single-player 3D action campaign built on
[Aegis Engine](https://github.com/rumukh/aegis-engine), and a sequel to
[Korovany](https://github.com/rumukh/korovany).

Three factions enter the same mystery from different homes and with different
authority: an elven partisan defending Greenhollow, a palace officer reporting
to Commander Vesk at Crownbridge, or an independent mountain ruler commanding
from the Old Fort. Mara is an independent carrier, not everyone's employer.
Her wagons have returned with their grain but without their people. Black
ward-glass hidden beneath the sacks connects the cargo to the disappearances.

The Caller mimics the voices of the dead and draws people away from the road.
Maintained bells and unbroken salt keep it out; answering a familiar voice can
lead someone beyond that protection. Yet the fortress convoys still travel
where other crews disappear. Follow the cargo, compare accounts and discover
what makes those wagons different.

The faction determines your opening, relationships, military obligations,
investigation and final settlement, not just your weapon or colours. The Caller,
Hollow Road and ward-glass remain shared. The supernatural threat is told through
authored evidence and testimony, not a monster-hunting mode or dynamic night
simulation: the Caller is never seen, and the missing crews never return as
monsters. The only beasts are the borderland's own (grave wolves, barrow ghouls
and bog trolls in the version 3 wilds). Final choices enact resolutions **after** the military objectives
and final enemy are defeated; they are not pre-battle plans.

## Run locally

Requires **Node.js 24 or newer**, npm, Git, and a desktop browser with WebGL2.

```powershell
git clone --recurse-submodules https://github.com/rumukh/korovany-2.git
Set-Location korovany-2
npm ci
npm run dev
```

Open the local URL printed by Vite. If the repository was cloned without its
submodule, run `git submodule update --init --recursive` before `npm ci`.
Installation builds the pinned engine packages; do not install a similarly named
SDK from the npm registry or install a second dependency tree inside the engine.

```powershell
npm test
npm run build
npm run preview
```

Real-browser coverage uses an installed Chrome or Edge and Aegis's existing CDP
driver, with isolated browser profiles and no additional test dependencies:

```powershell
$env:KOROVANY_BROWSER = '1'
$env:KOROVANY_WORLD_BROWSER = '1'
$env:KOROVANY_VOICE_ASSETS = '1'
$env:KOROVANY_TEST_SUITE = 'browser'
npm test
```

Set `AEGIS_BROWSER` to an executable path if the browser is not installed in a
standard location. `KOROVANY_CAPTURE_DIR` optionally selects a screenshot output
directory.

Browser-enabled runs execute test files sequentially: the engine's CDP launcher
uses software WebGL, so concurrent renderers and simulation suites otherwise
compete for CPU time. Ordinary headless unit-test runs remain parallel.
CI builds the site, runs unit tests and runs four balanced browser-file groups on
separate runners concurrently. Deployment requires every job to succeed; no
browser assertions, audio clips or narrative branches are omitted. Each browser
runner still runs only one test file at a time. The workflow lists its groups
explicitly, and a coverage test requires every browser suite to appear exactly
once. `KOROVANY_TEST_SUITE=unit` or `browser` selects those categories locally.
Without the selector, `npm test` retains its full-suite behavior.
CI enables both the world-visual benchmark (`KOROVANY_WORLD_BROWSER=1`) and the
complete shipped-voice checks (`KOROVANY_VOICE_ASSETS=1`). These remain opt-in for
ordinary local runs; the example above enables the complete release coverage.

Browser reloads wait for a new document loader and application readiness.
Only execution-context replacement during the requested navigation is retried
within the original deadline; renderer crashes and application errors still fail.
Long gameplay waits keep their tick-count assertions but allow up to 60 seconds
for software rendering. These functional scenarios are not GPU benchmarks.

The production game is written to `dist`. Serve that directory over HTTP; opening
`index.html` directly with `file://` is not supported. Assets use relative paths,
so the same build works at a site root or under `/korovany-2/`. Runtime assets are
local: no account, backend, external font service, or asset CDN is required.

## Frontier graphics

Seven original generated materials cover soil, masonry, oak boards, slate,
bark, linen and natural rock. Their 21 local 512 x 512 lossless WebP maps provide
color, tangent-space normals and roughness. Ground detail is mapped in world
metres, so it does not stretch across the kilometre-wide landscape.

The presentation combines detailed architecture and equipment, clustered tree
crowns, denser meadow grass, a layered mountain sky, reflective river ripples,
warm directional light and cool atmospheric haze. High quality adds HDR bloom
and antialiased postprocessing; low quality releases those render targets,
disables shadows and ground dressing, and uses simpler tree crowns. Both retain
the generated textures. Camera orbit now supports a lower landscape view.

Material provenance and hashes live in `public/textures/frontier/manifest*.json`.
`scripts/prepare-frontier-textures.py` is the offline atlas-processing utility
(Pillow and NumPy); running or building the game does not require Python or an
image-generation service. Normal/roughness maps are artistically derived from
the generated images, not measured scans.

### Cooked 3D models

The line soldier, road archer and infantry captain worn by the Crown's troops,
the elves' own forest warden, ranger and warden captain, the mountain army's own
axeman, fur-capped bowman and hammer captain,
the two bosses (Commander Raut and the Palace Marshal), the Echo Well,
the three faction heroes (the elf ranger, the palace officer and the
mountain sovereign), both wagons (the logistics convoy and the Crown ward-glass
shipment), the draft ox that pulls them, the convoy's cargo load and all
twenty named residents (Toman, Lida, Vesk, Ren and Mara at home and on the road;
Beran and Tessa at Cinderwell; Ada and Mila at Hollow Village; Elin at the Last
Archive; Lev at the Star Monastery, Yara at Thornwatch, Nika at the High Pass,
Radek at the Bell Foundry and Oss at the Lantern Ferry; Ivet at the Reed Chapel,
Sella at Mirecross, Orsa at Saltmarket, Hana at the Tide Observatory and Dren at
Wreckers' Rest), six signature landmarks (the Ward-Bell Frame at the Bell Foundry
and the Reed Chapel, the Stag Shrine Gate, the Frozen Beacon, the Tide Observatory
Armillary at the Tide Observatory and the Star Monastery, the Ward-Glass Outcrop
at the Glass Quarry and the Ash Cairn) and the three pickups (a coin purse, a
healer's satchel and a supply crate) are cooked glTF models (`public/models`) instead of procedural meshes. Their concepts were generated
locally with Qwen Image Edit Plus 2511, from original Blender reference renders
(for the archer, captain, bosses and the elf and mountain troops, the approved soldier concept
with a blank mannequin head; for the residents, plain civilian body templates derived from it;
for the wagons, ox, cargo, landmarks and pickups, grey blockouts) and, for the heroes and residents,
the game's own portraits as identity references. They were reconstructed with
TRELLIS-image-large and cooked, rigged and animated in Blender 5.2.2 LTS. Every
human character's back comes from an approved rear-view concept projected onto
the mesh, except the elf warden captain's: TRELLIS reconstructed him facing
away, so his mesh is turned 180 degrees and keeps the back it invented; the ox,
wagons, cargo, landmarks and pickups keep the far sides TRELLIS invented. Residents
stand and talk: they have Idle and Talk loops only. Landmarks keep their
buildings' authoritative footprints; pickups keep the procedural pickups' size,
height, bob and spin. TRELLIS cannot resolve
spokes, so the wagons' wheels, axles and
harness (shafts, duga arch, bell and pennant) are built in Blender and the
reconstructed wheels are cut away. Dark TRELLIS textures of the heroes, line soldier,
archer, captain, bosses, elf and mountain troops and residents are lifted by a tone curve calibrated
in the game against each approved concept from the default camera (the line
soldier's after its cook, by `derive_tone_cook.py`). The heroes,
bosses and most residents match their concepts' brightness; the line soldier, the archer, the
captain, the six elf and mountain troops and Tessa stop at the strongest lift measured and
stay visibly darker than their concepts, and Toman and Mara slightly darker; the
ox and wagons are lifted by eye, not calibrated. Faction and
allegiance colour the soldier's tabard and shield, the archer's hood, cape and
tabard, the captain's tabard, the elves' hoods, mantles, tunics and tabards and
the warden's round shield, the mountain axeman's surcoat and round shield, the
bowman's tunic and the hammer captain's skirt, the palace officer's shield and the wagons'
pennants (the convoy flies its faction's colour, the shipment its current
allegiance) without extra shader variants. Each campaign loads only the models it
can show (its own hero, the boss it fights, the troops of its factions, the
wagons and pickups, and in story worlds the residents and landmarks): about
28.0 to 29.3 MB of the 33.9 MB of models for a story campaign and about 13.1 to
13.6 MB for a legacy one. The game waits for those models before presenting a run and stops
with an explicit asset error if any fails to load.

**Licensing limitation:** TRELLIS code and weights are MIT-licensed, but its
textured export depends on components restricted to research and evaluation.
No commercial clearance exists for these forty-eight models; the project owner
acknowledged publishing them here. Concepts, recipes, provenance, approvals and
the cooking scripts are in `scripts/models`. In version 1 and 2 worlds the rest of
the world (houses, walls, trees, rocks, roads and the remaining props) is still procedural, so the models
read as more realistic than their surroundings there. They are not AAA
assets: see each `provenance.json` for measured limitations.

### World version 3

New campaigns start in a rebuilt, darker world: **world version 3**. Saved
campaigns from earlier releases keep loading in their own version 1 or 2 world,
exactly as before. Version 3 keeps the version 2 geography, regions, roads,
river, places and story, and changes:

- **Scale.** Buildings follow a heroic scale standard for the 2.25 m soldiers:
  1.3 x 2.8 m doors, 3.8-4.6 m eaves (3.2 m on sheds), 8-10 m ridges, 6.5 x 10 m cottages, an
  8 x 18 m longhouse and a 9 x 15 m barn; two-storey townhouses and inns rise to about 15 m, watchtowers to
  14.6 m and the Star Monastery's chapel spire to 22.4 m. They collide as exact oriented rectangles
  (versions 1 and 2 keep their circles).
- **Settlements.** Every settlement and inn is laid out along its roads in its
  region's own building style: half-timbered cottages, longhouses and barns in the
  Heartlands, Greenmarch and Hollowvale; rubble and sooty brick houses, a glass kiln
  and cobbled streets at Cinderwell; jettied townhouses on cobbles at Crownbridge;
  stilt huts and the reed-roofed Reed Chapel in the Fens; salt sheds and
  upturned-hull shelters on the Salt Coast; a stone chapel at the Star Monastery.
  Inns have stables and walled courtyards; settlements have smithies, watchtowers,
  market stalls, bell posts, stocks, handcarts and crates, fenced or dry-stone
  yards with woodpiles, barrels and beehives, graveyards with warded graves, and
  strip fields with haystacks and scarecrows. Signposts stand at road junctions,
  wayside shrines and gibbets at turns, and three warded graves beside the Echo
  Well.
- **Castles and ruins.** The Royal Citadel is a curtain of seven 31 m round
  towers with a 35 m keep, a gatehouse arch over the Crownbridge road and an open
  courtyard for the villain's final battle (nothing solid within 23.5 m of its
  centre). The Old Fort is a ring fort with a gate over each road, a square keep
  and a fallen stretch round a broken tower. Thornwatch keeps its ruined
  watchtower; the Old Cloister and the Drowned Archive have roofless chapels and
  houses; the Sealed Vault a strongroom tower; the Glass Quarry and the Bell
  Foundry furnaces; the Tide Observatory a tower; the Old Orchard rows of dead
  oaks behind a broken fence. Cooked landmarks (bell frames, stag gate, beacon,
  armillary, ward-glass, cairn, Echo Well) grow up to 3.8 m in radius where the
  road allows, and the military posts' four footings carry timber watch towers.
- **Remains.** Skulls and ribcages of beasts far larger than any soldier lie in
  the Ash Steppe and Hollowvale, trolls hang from gibbets on the Frostspine roads,
  and standing stones mark the Stag Shrine, the Ash Cairn and the Thornwatch road.
  Crows pick at the remains.
- **Wild land.** Greenmarch and Hollowvale are dark forests: tall black pines
  over old twisted oaks, spruce and dead birches, three times denser than any
  other woodland, with fallen trunks, broken stumps, mossy boulders and rust
  bracken and bramble underfoot. Every gap between trees and the forest floor is
  at least 1.6 m, so the hero always gets through. The open lands have copses
  and lone gnarled trees. Canopies dither away around the hero instead of
  hiding them.
- **Mountains.** A ring of crags closes the world on every side but the Salt
  Coast, which the sea closes, with far mountains rising behind it in the fog;
  snow-capped massifs stand in the Frostspine, mossy outcrops in the forests and
  bare crags on the Ash Steppe. Crags are solid; they keep clear of every road
  and place.
- **Water.** A great mere and lesser meres lie among reed beds and drowned trees
  in the Fens, black pools in the dark forests' glades, tarns among the
  Frostspine crags, bitter pools on the Ash Steppe, a pool in the Crownlands and
  a pond in the Heartlands. Water is solid, like the river: no one wades or
  swims. The sea breaks on a shingle beach along the Salt Coast, where the river
  runs out into it.
- **Ground.** Gentle hills (presentation only: roads, sites, clearings,
  buildings, fields and every fight stay level, slopes at most about 11 degrees)
  painted with meadow, forest floor, mud, road and field layers, and regional
  ground: a dark needle floor where the dark forests stand close, reed mud in
  the Fens, cold grass and shingle on the Salt Coast, ash on the Ash Steppe,
  cold grass and snow in the Frostspine.
- **Light.** An overcast late-autumn grade with denser fog; characters stay
  within 5 percent of their calibrated brightness.
- **Air and weather.** Each wild region has its own air, eased in as the hero
  travels: dim green-grey under the dark forests, a pale thick mist on the Fens,
  a brown ash haze on the Ash Steppe, cold haze on the Frostspine and sea haze on
  the Salt Coast. Leaves fall in the forests, ash and embers drift over the
  steppe, snow falls on the Frostspine and will-o'-wisps wander over the Fens
  (at high quality, without reduced motion). Scenery only.
- **Animals.** Sheep flocks graze on settlement pastures and scatter from the
  hero; crows peck on stubble fields, in graveyards and under gibbets and take
  off when the hero comes near; herds of red deer hinds browse in forest glades
  and feral goats at the feet of crags, and bolt together when the hero comes
  close. They are scenery only: never saved and never part of the rules.
- **Grave wolves.** Beasts of the borderland, grown bold on empty roads and
  opened graves, den in clearings of the Greenmarch and Hollowvale forests (five
  or six dens per world, at least 100 m from any settlement, inn, chapel, home or
  military site and 22 m from the roads). A pack of three or four appears at its
  den while you are 90-160 m away and wanders round it. Come within 18 m and the
  pack hunts you, and only you, not the convoy or a shipment: each wolf crouches
  before it bites (its red ring shows its reach), and the pack gives up once you
  are 35 m from its den. Wolves drop a few coins but never count as kills,
  levels or renown. A den whose pack was killed stays empty for 90-180 seconds,
  and packs far behind you vanish. Wolves near you block talking, inspecting and
  travel, like any enemy.
- **Barrow ghouls and bog trolls.** Gaunt carrion beasts drawn to the burials
  Raut's men dug up for bone ash haunt opened barrows on the Ash Steppe (three
  per world): an old long barrow, dug open on one flank, with a warded
  grave and headstones on the clearing's rim. They come three or four at a time,
  each a head taller than a soldier, and rake with long claws after a short
  windup. Bog trolls, huge wild beasts twice a soldier's height, keep alone to a
  larder by a giant beast's skull in the Fens and on the Frostspine (usually
  three per world). A troll's two-fisted slam comes after a long windup with a
  wide red ring: step out of it. Both follow the wolves' rules (the same spawn
  distances, leash, quiet time; they drop more coins and never count as kills or
  renown), and both walk round the barrow, the skull and other big solids to
  reach you. These three are the only monsters: the Caller stays unseen and the
  missing crews never become beasts.

Buildings, castles, ruins, walls, fences, trees, crags, the forest floor, the
undergrowth and the reed beds are generated by committed Blender scripts
(`scripts/world/pipeline/build_kit.py`, `build_kit_w1.py`, `build_kit_w2.py`,
`build_kit_w4.py` for the barrow, `build_nature.py`, `build_nature_w3.py`, `build_nature_w3b.py`). The farm and village
props, the remains, the sheep, the crows, the deer, the goats, the grave wolf, the barrow ghoul and the bog troll are
TRELLIS reconstructions of concept images generated with the owner's Azure
OpenAI image deployment (approved for concept art), with the same
research-and-evaluation licensing limitation as the models above. The beasts'
voices are synthesised by committed scripts (`scripts/audio/synth_beasts.py` and `synth_beasts_w4b.py`):
no recordings, samples or generative models. Surface
textures are generated locally with Qwen Image Edit Plus 2511 from scripted
layout swatches drawn at true physical scale. Everything is in `public/world`
with recipes, provenance and approvals in `scripts/world`; the pipeline scripts
read the authoring folder from `K2_AUTHORING` and Blender from `K2_BLENDER`. A
version 3 world loads about 15.7 MiB of world assets before it is shown and
stops with an explicit asset error if any fails. Measured limitations and the
remaining gap to AAA are listed in each `provenance.json`.

## The campaign

Choose a faction and a world seed. Elves fight at range and answer to forest
households. Palace guards use a bulwark, defend their existing post and obey
Vesk's orders. The mountain ruler uses close-range cleaves and chooses
conquest without an employer. Independent human settlements form a fourth,
neutral political group: residents' clothing does not make them combat enemies.

Your opening chapter commits to **one irreversible directive**:

| Faction / directive | Physical obligations before the final battle |
| --- | --- |
| Elf / Shelter | Liberate and supply the forest depot; intercept the intact shipment and escort it to that depot. |
| Elf / Interdict | The same forest recovery, plus capture and supply the palace supply gate. |
| Guard / Relief | Repel the attack on your already-owned palace supply gate, supply it, and protect the Crown shipment's delivery there. |
| Guard / Pursuit | Complete the relief and delivery first; only then may you capture and supply the quarry road post. |
| Mountain ruler / Dominion | Take and supply the palace gate and quarry road post; appropriate the intact shipment and escort it to the palace gate. |
| Mountain ruler / Plunder | Take and supply the palace gate, but physically escort the appropriated shipment back to the Old Fort. |

Clear hostile defenders before holding **E** inside an authorized capture circle.
Each required post consumes **30 cargo** from your nearby supply convoy.
The mission shipment is a **separate wagon**, not a target to destroy for loot.
Clear its hostile escort or attackers, then hold **E** beside it to take charge.
Guards must first repel the palace attack. Stay within **22 metres** while the
shipment follows its road route; opening a conversation does not claim it,
deliver it or move it. A completed delivery provides supplies that can be
collected and transferred to your own convoy with **E**.

Your own convoy accepts hold, follow, return-home and road-destination orders.
The mountain ruler's soldiers follow those logistics orders along the roads
and engage hostile forces; they are not merely decorative starting guards.
Both carts use real roads and bridges. Hold **E** nearby to repair a damaged or
disabled cart for free; a wreck does not permanently strand the campaign.
Home and secured posts provide recovery and in-campaign upgrades.

Once your directive's shipment and supplied holdings are complete, the final
battle unlocks. Elves and guards fight Raut's invasion redoubt; the mountain
ruler assaults the **Royal Citadel** and its Palace Marshal. The citadel is the
royal residence, distinct from the central palace supply gate. Military victory
alone leaves the investigation playable: complete your faction's main chapters
and select a resolution to finish the run.

The same seed reproduces the world, not a promise of identical outcomes under
different player inputs. New campaigns can apply purchased permanent upgrades.
Russian is the default language; English is available in the game.

## The borderlands and their stories

The campaign explores a **980 x 980 metre** continuous world, **49 times the area**
of the original military map. Eight named regions contain 26 authored locations:
settlements, inns, ruins, shrines and landmarks. Interconnected roads and three
bridges connect The Heartlands / Срединные земли to Greenmarch / Зелёное
пограничье, The Fens / Топи, The Salt Coast / Соляной берег, The Ash Steppe /
Пепельная степь, Crownlands / Коронные земли, Frostspine / Инейный хребет and
Hollowvale / Глухая долина. The forest depot, palace supply gate, quarry road
post and shipment encounter remain in the central military area; faction homes
and the mountain ruler's final palace assault extend beyond it.

Each faction has **five main chapters**, **eight branching local side quests**,
**20 named NPCs**, and **three mutually exclusive resolutions**: nine
faction-specific endings across the game. Begin with Toman in Greenhollow,
Vesk at Crownbridge, or Ren at the Old Fort. Shared local stories do not turn
their residents into soldiers of your faction. **T** talks to a nearby resident
or examines a landmark; the on-screen prompt tells you what is available.
Conversations and inspections pause the simulation. Inspected evidence opens
in a scrollable reading overlay, rather than only flashing in a HUD notice.
Choose a dialogue response with the mouse or **1-9**; **Escape** leaves without
selecting a response. In an inspection, **Continue** or **Escape** closes the
reading panel and resumes play. Residents offer local stories,
testimony and decisions with persistent consequences, not repeatable reward
dispensers.

Conversations show **20 canonical NPC portraits** and a distinct player portrait
for each faction. These original illustrations are shared across languages and
use stable character identities across campaigns. The 23 local, 320 x 320 WebP
images total about 313 KiB; production prompts, attribution and hashes are in
`public/portraits/manifest.json`. See `scripts/portraits/README.md` for reproduction.
Portrait loading failures never hide a speaker's name or dialogue choices.

Dialogue, player replies, inspections, military status and all nine epilogues
have local Russian and English recordings. See **Audio** below for coverage,
playback controls and the documented human release acceptance.

<details>
<summary>Ending requirements (spoilers)</summary>

Every final response requires the chosen directive, its physically delivered
shipment, its secured and supplied posts, the defeated final enemy, and the
preceding investigation. Responses that need local allies require their
completed side-quest outcomes, not promises to help. Declining an optional
alliance blocks the resolutions that depend on it, not the entire campaign;
other resolutions remain available. The dialogue shows the missing requirements.

| Faction | Resolutions |
| --- | --- |
| Elven resistance | The Uncrowned Watches / Дозоры без короны; One Door Left Shut / Одна запертая дверь; The Forest Takes the Night / Лес принимает ночь |
| Palace guard | The Charter of Three Watches / Грамота трёх дозоров; The Watch Without Relief / Караул без смены; An Oath in Daylight / Присяга при дневном свете |
| Mountain ruler | A Throne with Three Limits / Трон с тремя пределами; The Keeper and the Conqueror / Смотритель и завоеватель; No Rival's Glass / Стекло не достанется сопернику |

The first resolution in each row needs both the completed bell alliance and
stag-shrine dependents' outcome (`<faction>-bell-mourn` and
`<faction>-stag-dependents`). The remaining two do not require those alliances.

</details>

Reputation tracks the Border Villages / Приграничные общины, Crown Garrison /
Коронный гарнизон and Candlekeepers / Свечники.

**J** opens the quest journal. It records objectives, testimony, outcomes and
faction reputation, military orders and their completion state. Track a quest
to mark its destination on the atlas and show distance on the HUD. **M** opens
the atlas; switch between the whole borderlands
and local surroundings. The minimap stays local so nearby roads and people remain
readable. Locations become discovered through exploration.

The atlas also offers convoy travel to eligible discovered stops. Travel is
authoritative: the game checks the starting location, nearby danger, destination
and convoy conditions, and shows why a journey is unavailable. It is not an
unrestricted teleport out of combat.

## Controls

| Control | Action |
| --- | --- |
| WASD | Move relative to the camera |
| Mouse (captured) / Arrow keys (uncaptured) | Look and aim together / Aim |
| Left mouse / Space | Attack |
| Mouse movement / Mouse wheel | Turn camera and character together / Zoom |
| Shift | Sprint |
| Q | Dodge |
| F | Faction ability |
| E (hold) | Contextual capture, transfer, repair, or rest |
| T | Talk to a nearby resident / open an inspection reading panel |
| J | Quest journal and tracking |
| 1-9 | Select a dialogue response |
| C | Cycle convoy orders |
| M / Tab | Campaign map |
| Escape | Pause / close overlay |

Starting or resuming with a mouse click captures and hides the cursor. Mouse
movement then turns the camera and character together without holding any button;
WASD movement does not turn your aim away from the camera. Clicking the game world
also captures the mouse, without attacking on that first click. Escape pauses and
releases the cursor. Opening menus or losing browser focus also releases capture
and held controls. After a keyboard-only resume, click the world to recapture.
If the browser denies capture, the game reports it; keyboard-only aiming and
controller input remain available. A controller takeover releases the cursor
without pausing. Once the atlas is open, Tab navigates its controls; use M or
Escape to return to the road.

### Xbox-style controllers

Standard-mapped controllers use the shared Aegis browser input adapter. Connect
over USB or Bluetooth, press a button if the browser has not exposed the device,
then release the sticks and buttons to arm it. Serve over localhost or HTTPS.
Non-standard layouts and blocked browser permissions are reported, not guessed.

| Controller | Action |
| --- | --- |
| Left stick | Camera-relative analog movement |
| Right stick | Orbit camera; left looks left, right looks right |
| LT + right stick | Aim independently; camera stays still |
| RT | Attack |
| A (hold) / X | Contextual interaction / Talk or inspect |
| B / Y | Dodge / Faction ability |
| LB (hold) / RB | Sprint / Cycle convoy orders |
| Menu / View | Pause / Atlas |
| D-pad up / Left or right | Journal / Camera zoom |

Horizontal camera control follows the stick by default. Enable **Invert
horizontal camera (controller)** in Settings to restore the opposite direction.
The preference is saved in this browser and applies immediately; it does not
change vertical camera control, LT aiming, menu scrolling, or mouse controls.

In overlays, use the D-pad or left stick to navigate, A to confirm and B to
return. Right stick scrolls long text; left/right adjusts focused selectors
and sliders. Confirmations are game-owned, so replacing a campaign does not
require a browser dialog. Seed text entry still needs a keyboard; the random
seed button is controller-accessible. Prompts follow the last-used device.
Disconnecting an active controller pauses play. Focus changes and leaving a
menu require neutral controls before gameplay resumes; held confirmation or
attack cannot leak across that boundary.

Gamepad input alone does not unlock browser audio. A real click or key press
may still be needed once; the controller hint explains this. Camera angle
limits and combat rules are unchanged; manual aiming does not add lock-on.
Automated coverage uses virtual standard controllers in a real browser, not
physical Xbox hardware or driver certification.

## Audio

The browser plays local compressed media from
`public/audio/soundtrack/manifest.json` and `public/audio/voices/manifest.json`.
There is no oscillator soundtrack or browser text-to-speech substitute. The first
trusted click or key press unlocks audio; the title screen then plays its score.
If a manifest, clip, decoder or autoplay permission is unavailable, a localized
warning appears and the console identifies the failure. Dialogue remains readable
and choices remain immediate. Reload after restoring missing files.

Music crossfades between the road, mystery sites, combat and the fortress, with
hysteresis to avoid switching at every border or combat lull. Eight regional
ambience beds follow the player. Final scores start only after victory, never after a nonterminal conversation;
defeat plays its cue and then falls silent. Presentation
effects use snapshot events and movement, with distance attenuation, stereo
placement, rate limits and bounded polyphony. They do not change game rules.
Footsteps are timber on the bridge decks and soft earth everywhere else,
including the home camp and other site rings. Each surface has four quiet takes,
shuffled without an immediate repeat and varied slightly in pitch and level.

The score contains eight original instrumental compositions totaling 15 minutes,
eight 32-second regional loops and 24 distinct effects in 30 files, counting
each footstep take. Production captions,
source hashes, mastering details and reproduction instructions are retained in
[`scripts/audio`](scripts/audio/README.md). Voice casting, pronunciation and
exact narrative coverage are documented in [`scripts/voices`](scripts/voices/README.md).
The shipped files play offline from the game's HTTP server; synthesis services
are production tools, not runtime dependencies.

NPC dialogue, selected player responses, inspection narration and terminal
epilogues look up exact RU/EN paragraph blocks in the voice manifest. Multiple
clips for a paragraph play in order. Choosing again immediately cancels stale
downloads and playback; reopening a conversation replays it. Voices duck the
music, not the simulation: conversation and inspection overlays pause gameplay
while audio continues. Their **Settings** control can change language or volume
without closing the scene. Closing a reading scene cancels its narration.

The full voice bank contains **1,332 localized blocks** (666 per language),
with 3,772 segment references sharing **3,115 unique clips**: approximately
184 minutes across all three campaigns, not one playthrough. All 20 NPCs,
the player and the narrator have recorded parts. Azure **MAI-Voice-2** supplies
two native Russian voices (Lev/Masha) and four US English voices
(Ethan/Grant/Harper/Olivia), not 22 separate actors. Delivery is local 24 kHz mono
Ogg Vorbis, about 73.8 MiB, with uniform 3 dB headroom to prevent lossy-codec
overshoot. Lossless masters and exact production receipts are retained separately;
there is no pitch shifting or time compression.

The complete recording was accepted with documented metric limitations on
2026-09-20. MAI's tested voices ignore forced IPA, so this recording uses the
explicitly approved natural-delivery workflow: names and ambiguous stress are
listening targets, not claimed to be enforced. All 944 accepted-but-retained
review flags (557 listening-only and 387 other metric flags) remain in
`public/audio/voices/provenance.json`, distinctly from automatic passes.
Acceptance covers the reviewed recording and does not claim that every flagged
clip was individually heard or that every pronunciation is correct. Six low
acoustic-score representatives and short-word/chapter-number recognition caveats
remain disclosed. Production, exact coverage and hash-bound human release
records are documented in `scripts/voices/README.md`.

Settings provide independent **Master**, **Music**, **Ambience**, **Sound effects**
and **Voices** sliders, as well as the existing mute switch. Old settings without
mix levels load compatible defaults. Pause, mute, a hidden tab and window blur
stop all playback; returning to a voiced scene resumes its current clip, or
restarts the scene in the newly selected language. Text stays visible throughout.

Long music and ambience beds are streamed (at most two streams per lane during
crossfades). Short effects and speech are decoded lazily into a 24 MiB LRU cache;
at most twelve effects, four ordinary effect downloads and two native decodes
run concurrently. Speech is sequential; the full voice corpus is never prefetched.
`window.korovany.inspect().audio` exposes transport, stream times, current subtitle,
recent effect IDs, decoded duration, cache usage and failures for browser acceptance.
It is read-only and provides no simulation controls.
The `speaking` flag includes speech loading; browser checks wait for a live voice
source as well as the expected speaker and language, not just a subtitle or effect.

`tests/audio-browser.test.ts` serves test-only PCM fixtures over HTTP to exercise
real browser media and Web Audio lifecycles; these fixtures are not shipped assets.
`tests/audio-assets-browser.test.ts` instead fully decodes every shipped Ogg file
in Chromium, checks channel count, duration, audibility and headroom, then exercises
real terminal cues, all three ending scores, and RU/EN conversations with their
selected player responses. It serves assets beneath a URL prefix to cover
subdirectory deployment. Run it only with both complete audio banks present:

```powershell
$env:KOROVANY_BROWSER = '1'
npm test -- tests\audio-assets-browser.test.ts --maxWorkers=1 --no-file-parallelism
```

The separate `tests/voice-catalogue.test.ts` checks exact narrative coverage across
authored branches and outcomes. Browser decoding and speech metrics complement
human listening; they do not establish acting quality or correct lexical stress.

## Saves

Campaign, profile, and settings are stored locally in the browser under the
`korovany2:` namespace, separately from the original game. Saved campaigns retain
simulation state, including faction, irreversible directive, both carts' routes
and condition, deliveries, supplied posts and ongoing encounters. Terminal run
rewards are claimed once per run ID. Clearing browser site data removes these
saves; private browsing or blocked storage can prevent persistence.

Story saves also retain discoveries, testimony, reputation, quest outcomes,
tracked objectives, open conversations and open inspections. Continuing a save
with an open reading panel or conversation returns to that paused scene.

This campaign uses **narrative version 3**. Earlier narrative saves are incompatible
and are rejected, not migrated or automatically deleted. Start a new campaign to
play The Hollow Road. This replaces the campaign record but retains the separate
profile, permanent upgrades and settings. Damaged or unsupported records produce
a visible storage warning rather than silently loading a different campaign.
Explicit `worldVersion: 1` simulation runs retain the original military-only
rules and saves; they do not acquire a faction story on restoration. New
campaigns save as world version 3. The version 3 world is still being built:
when a later release changes its layout, a version 3 save from an earlier release
no longer matches its world. The title then says, in Russian and English, that
the campaign belongs to an earlier version of the world; the save is neither
loaded into a different world nor deleted.

## Architecture

| Location | Responsibility |
| --- | --- |
| `src/game` | Aegis ECS components, ordered systems, deterministic world, campaign rules, saves, and profile progression |
| `src/view` | Game-owned Three.js presentation: procedural scenery and characters, cooked glTF models, camera, and effects |
| `src/ui`, `src/audio`, `src/main.ts` | Interface, localization, controls, browser lifecycle, and local-media audio |
| `tests` | Headless game and integration coverage |
| `vendor/aegis-engine` | Unmodified engine submodule |

The engine is pinned to
[`06c616dab5b8b2507a65d4d974131db4fce99f43`](https://github.com/rumukh/aegis-engine/tree/06c616dab5b8b2507a65d4d974131db4fce99f43).
Its private workspace packages are built from source. Aegis owns the
authoritative fixed-step simulation; the game-owned third-person renderer
consumes detached snapshots and never supplies authoritative state. The browser
shell accumulates 60 Hz simulation steps separately from rendering.

See [`src/game/CONTRACT.md`](src/game/CONTRACT.md) for the simulation/presentation
boundary. A new presentation is intentional: the engine's stock FPS and
isometric hosts do not provide this action camera and interface.

## Deployment and attribution

The GitHub Actions workflow builds and runs the game tests on pushes and pull
requests. On `main`, it can publish the build through GitHub Pages. Set the
repository's **Settings > Pages > Source** to **GitHub Actions** before enabling
deployment. Local builds do not require GitHub.

Aegis packages declare MIT; Three.js is MIT. Runtime notices are included in
[`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt) and copied into
the production build. The engine remains pinned with its upstream provenance.
The sequel uses newly authored procedural visuals, forty-two locally generated and
cooked 3D models (research/evaluation-only TRELLIS export, see "Cooked 3D
models" above), the version 3 world's assets (script-generated buildings,
castles, trees and rocks, locally generated surfaces, and TRELLIS-derived props,
remains, sheep, crows, deer, goats, grave wolves, barrow ghouls and bog trolls under the same restriction, see "World version 3" above) and original audio
(including procedurally synthesised beast voices)
rather than copying the original game's implementation or asset library. No
project-wide redistribution license is assigned here.