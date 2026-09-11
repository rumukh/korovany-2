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
| `setQuality('low' \| 'high')` | Low caps DPR at 1, disables shadows, grasses and ambient motes; high caps DPR at 1.75. |
| `setReducedMotion(boolean)` | Removes camera lag, ambient motes, water/cape flourishes and dodge trails; reduces gait animation. |
| `dispose()` | Idempotently releases shared geometry/materials/textures, shadow buffers, instance buffers, renderer resources and owned canvas listeners. |

The shell owns RAF, keyboard/pointer/wheel input, pause, canvas layout and recovery
UI. WebGL 2 creation/context-loss errors are explicit exceptions. There are no
global input handlers or additional animation loops.

Road widths, water and bridge rectangles, site positions and solid scenery come
from `WorldBlueprint`. Buildings are constrained to real circular wall obstacles.
Grass and pebbles are excluded from roads, sites, water and blockers. Horizon
mountains are outside the map. The bridge has a level traversable deck; rails are
over solid water outside its exact walkable rectangle. Foliage uses a
screen-space dither cutaway around the hero's sightline.

Actors and projectiles are keyed by authoritative IDs, with faction silhouettes,
snapshot-driven windups, health and capture/supply states. Combat cosmetics use
the bounded snapshot effect list and deduplicated event IDs; spark bursts and
visible corpses have fixed caps. No presentation entity participates in rules,
and no fake quest, target, actor or pickup is created.
