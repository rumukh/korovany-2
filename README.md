# Korovany II: The Unwritten Road

A standalone, single-player 3D action campaign built on
[Aegis Engine](https://github.com/rumukh/aegis-engine), and a sequel to
[Korovany](https://github.com/rumukh/korovany).

Take the road as a forest elf, palace guard, or villain. Villages are vanishing
from the toll ledgers, and the supply wagons no longer stop for people who
officially do not exist. Investigate the missing names, listen to conflicting
witnesses, and decide who should control the borderlands' roads.

An original branching narrative sits alongside the physical convoy campaign:
fight for supply posts, raid a rival caravan, and escort cargo to open the final
stronghold. Your conversations and investigations determine the road's future;
military victory alone does not finish a new story campaign.

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
npm test -- tests\ui-browser.test.ts
```

Set `AEGIS_BROWSER` to an executable path if the browser is not installed in a
standard location. `KOROVANY_CAPTURE_DIR` optionally selects a screenshot output
directory.

The production game is written to `dist`. Serve that directory over HTTP; opening
`index.html` directly with `file://` is not supported. Assets use relative paths,
so the same build works at a site root or under `/korovany-2/`. Runtime assets are
local: no account, backend, external font service, or asset CDN is required.

## The campaign

Choose a faction and a world seed. Elves fight at range, guards can hold their
ground with a bulwark, and villains excel at close-range cleaves.

1. Defeat the defenders at two of the three supply posts, then hold **E** inside
   the capture circle to claim them.
2. Destroy the rival caravan and collect its supplies.
3. Bring supplies to your convoy. Deliver 30 cargo to each of two captured posts;
   supplying the third also weakens the final reinforcements.
4. Defeat the commander at the unlocked fortress.

The convoy follows actual roads and crosses the river at the bridge. Use its
orders to move it, hold it safely behind the fighting, or send it home. A damaged
or disabled convoy can be repaired by holding **E** nearby; losing its health
does not permanently strand the campaign. Home and captured posts offer
recovery and in-campaign upgrades.

The same seed reproduces the world, not a promise of identical outcomes under
different player inputs. New campaigns can apply purchased permanent upgrades.
Russian is the default language; English is available in the game.

## The borderlands and their stories

New campaigns explore a **980 x 980 metre** continuous world, **49 times the area**
of the original military map. Eight named regions contain 24 authored locations:
settlements, inns, ruins, shrines and landmarks. Interconnected roads and three
bridges connect the heartlands to Greenmarch, Fenlands, Saltcoast, Ashsteppe,
Crownlands, Frostspine and Hollowvale. The original military sites remain in the
heartlands.

Start with the road keeper near your home convoy. **T** talks to a nearby resident
or examines a landmark; the on-screen prompt tells you what is available.
Conversations pause the simulation. Choose a response with the mouse or **1-9**;
**Escape** leaves without selecting a response. Residents offer local stories,
testimony and decisions with persistent consequences, not repeatable reward
dispensers.

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
| T | Talk to a nearby resident / examine a landmark |
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