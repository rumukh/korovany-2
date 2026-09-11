# Korovany II: War of the Road

A standalone, single-player 3D action campaign built on
[Aegis Engine](https://github.com/rumukh/aegis-engine), and a sequel to
[Korovany](https://github.com/rumukh/korovany).

Take the road as a forest elf, palace guard, or villain. Fight for supply posts,
raid a rival caravan, and command a physical convoy along the road network.
Deliveries open the final stronghold; returning victorious earns permanent
upgrades for the next expedition.

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

## Controls

| Control | Action |
| --- | --- |
| WASD | Move relative to the camera |
| Mouse | Aim |
| Left mouse / Space | Attack |
| Shift | Sprint |
| Q | Dodge |
| F | Faction ability |
| E (hold) | Contextual capture, transfer, repair, or rest |
| C | Cycle convoy orders |
| M / Tab | Campaign map |
| Escape | Pause / close overlay |

The in-game help describes additional camera and interface controls. Opening
menus pauses the campaign. Browser focus loss releases held controls.

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