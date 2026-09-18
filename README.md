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
simulation. Final choices enact resolutions **after** the military objectives
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
npm test -- tests\ui-browser.test.ts tests\story-browser.test.ts tests\faction-presentation.test.ts
```

Set `AEGIS_BROWSER` to an executable path if the browser is not installed in a
standard location. `KOROVANY_CAPTURE_DIR` optionally selects a screenshot output
directory.

The production game is written to `dist`. Serve that directory over HTTP; opening
`index.html` directly with `file://` is not supported. Assets use relative paths,
so the same build works at a site root or under `/korovany-2/`. Runtime assets are
local: no account, backend, external font service, or asset CDN is required.

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

Dialogue, player replies, inspections, military status and all nine epilogues
have local Russian and English recordings: **1,332 bilingual blocks / 3,115
unique Ogg clips**, about **158 minutes** of unique speech. The established
20 NPC profiles plus player/narrator are preserved, using three Russian and four
British English engine voices rather than claiming 22 different actors.
Selected player replies play before NPC responses without advancing the paused
simulation. Settings remain accessible during dialogue, inspection and endings;
language changes replace the speech queue, and the existing sound toggle mutes
speech, music and effects. There is no browser text-to-speech fallback.

The complete recording was accepted with documented metric limitations on
2026-09-18. Those flags remain in `public\audio\voices\provenance.json`, not
relabeled automatic PASS. See `scripts\voices\README.md` for production,
pronunciation, exact coverage and the separate human release records.

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
| Mouse / Arrow keys | Aim |
| Left mouse / Space | Attack |
| Right mouse drag / Mouse wheel | Orbit camera / Zoom |
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

Opening menus pauses the campaign. Browser focus loss pauses play and releases
held controls. Once the atlas is open, Tab navigates its controls; use M or
Escape to return to the road.

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
rules and saves; they do not acquire a faction story on restoration.

## Architecture

| Location | Responsibility |
| --- | --- |
| `src/game` | Aegis ECS components, ordered systems, deterministic world, campaign rules, saves, and profile progression |
| `src/view` | Procedural Three.js scenery, character animation, camera, and effects |
| `src/ui`, `src/audio`, `src/main.ts` | Interface, localization, controls, browser lifecycle, and synthesized audio |
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
The sequel uses newly authored procedural visuals and synthesized audio rather
than copying the original game's implementation or asset library. No
project-wide redistribution license is assigned here.