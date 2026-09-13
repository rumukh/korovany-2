# Korovany II: The Hollow Road / Глухой тракт

A standalone, single-player 3D action campaign built on
[Aegis Engine](https://github.com/rumukh/aegis-engine), and a sequel to
[Korovany](https://github.com/rumukh/korovany).

You are a captain hired to escort a convoy. Mara's wagons have returned with their
grain but without their people. Hidden beneath the sacks is black ward-glass:
the first evidence connecting the cargo to disappearances along the road.

The Caller mimics the voices of the dead and draws people away from the road.
Maintained bells and unbroken salt keep it out; answering a familiar voice can
lead someone beyond that protection. Yet the fortress convoys still travel
where other crews disappear. Follow the cargo, compare accounts and discover
what makes those wagons different.

An original branching narrative sits alongside the physical convoy campaign:
fight for supply posts, raid a rival caravan, and escort cargo to open the final
stronghold. The supernatural threat is told through authored evidence and
testimony, not a new monster-hunting mode or a dynamic night simulation.
Choosing the finale is a plan, not an instant ending: its consequences appear
only after the commander is defeated.

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
npm test -- tests\ui-browser.test.ts tests\story-browser.test.ts
```

Set `AEGIS_BROWSER` to an executable path if the browser is not installed in a
standard location. `KOROVANY_CAPTURE_DIR` optionally selects a screenshot output
directory.

The production game is written to `dist`. Serve that directory over HTTP; opening
`index.html` directly with `file://` is not supported. Assets use relative paths,
so the same build works at a site root or under `/korovany-2/`. Runtime assets are
local: no account, backend, external font service, or asset CDN is required.

## The campaign

Choose a banner and a world seed. Woodland elves fight at range, palace guards
can hold their ground with a bulwark, and the Iron company excels at close-range
cleaves. These banners select the existing combat and convoy loadouts.

1. Defeat the defenders at two of the three supply posts, then hold **E** inside
   the capture circle to claim them.
2. Destroy the rival caravan and collect its supplies.
3. Bring supplies to your convoy. Deliver 30 cargo to each of two captured posts;
   supplying the third also weakens the final reinforcements.
4. Defeat Commander Raut at the unlocked fortress. Complete the main
   investigation and choose your finale plan to finish the campaign.

The convoy follows actual roads and crosses the river at the bridge. Use its
orders to move it, hold it safely behind the fighting, or send it home. A damaged
or disabled convoy can be repaired by holding **E** nearby; losing its health
does not permanently strand the campaign. Home and captured posts offer
recovery and in-campaign upgrades.

The same seed reproduces the world, not a promise of identical outcomes under
different player inputs. New campaigns can apply purchased permanent upgrades.
Russian is the default language; English is available in the game.

## The borderlands and their stories

The campaign explores a **980 x 980 metre** continuous world, **49 times the area**
of the original military map. Eight named regions contain 24 authored locations:
settlements, inns, ruins, shrines and landmarks. Interconnected roads and three
bridges connect The Heartlands / Срединные земли to Greenmarch / Зелёное
пограничье, The Fens / Топи, The Salt Coast / Соляной берег, The Ash Steppe /
Пепельная степь, Crownlands / Коронные земли, Frostspine / Инейный хребет and
Hollowvale / Глухая долина. The original military sites remain in The Heartlands.

The campaign has **five main chapters**, **eight branching side quests**, **20
named NPCs**, and **three mutually exclusive endings**. Begin with Mara at
Roadward Inn / Трактовый двор, near your home convoy. **T** talks to a nearby resident
or examines a landmark; the on-screen prompt tells you what is available.
Conversations and inspections pause the simulation. Inspected evidence opens
in a scrollable reading overlay, rather than only flashing in a HUD notice.
Choose a dialogue response with the mouse or **1-9**; **Escape** leaves without
selecting a response. In an inspection, **Continue** or **Escape** closes the
reading panel and resumes play. Residents offer local stories,
testimony and decisions with persistent consequences, not repeatable reward
dispensers.

<details>
<summary>Ending requirements (spoilers)</summary>

The three endings are **Three Bells / Три колокола**, **The Cloister's Prisoner /
Узник скита**, and **Broken Glass / Разбитое стекло**. Three Bells requires
the completed `bell-mourn` and `stag-dependents` side outcomes: the allies must
actually be secured, not merely promised. The other two plans can be chosen
without completing side quests. The final epilogue follows military victory.

</details>

Reputation tracks the Border Villages / Приграничные общины, Crown Garrison /
Коронный гарнизон and Candlekeepers / Свечники.

**J** opens the quest journal. It records objectives, testimony, outcomes and
faction reputation. Track a quest to mark its destination on the atlas and show
distance on the HUD. **M** opens the atlas; switch between the whole borderlands
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
simulation state, including the convoy and ongoing encounters. Terminal run
rewards are claimed once per run ID. Clearing browser site data removes these
saves; private browsing or blocked storage can prevent persistence.

Story saves also retain discoveries, testimony, reputation, quest outcomes,
tracked objectives, open conversations and open inspections. Continuing a save
with an open reading panel or conversation returns to that paused scene.

This campaign uses **narrative version 2**. Earlier narrative saves are incompatible
and are rejected, not migrated or automatically deleted. Start a new campaign to
play The Hollow Road. This replaces the campaign record but retains the separate
profile, permanent upgrades and settings. Damaged or unsupported records produce
a visible storage warning rather than silently loading a different campaign.

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