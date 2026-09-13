# Game-owned Three presentation

Import `createGameView`, `GameView` and `GameViewOptions` from `src/view/index.ts`.
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
| `dispose()` | Idempotently releases shared geometry/materials/textures, the sky reflection environment, shadow and HDR buffers, instance buffers, renderer resources and owned canvas listeners. |

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
the area), with eight bilingual regions and 24 authored locations connected by
road loops and three river crossings. The original six military sites and their
structures remain in place. Every exploration location has a matching road-node
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

Shadow depth materials are game-owned as well as visible materials, so changing
runs releases their shader programs rather than retaining Three's implicit shadow
materials. Outpost ownership and deliveries change their heraldry; fortress
heraldry distinguishes locked, unlocked and defeated states without a false gate.
