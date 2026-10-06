/**
 * `window.korovany.inspect()` without the snapshot's world blueprint. A version 3 world is about 1.42 MB of the
 * 1.44 MB snapshot, and returning it by value over CDP cost about 0.7 s per call on a fast desktop (more on CI
 * runners). Read world data with `window.korovany.inspect()` itself, or with a targeted in-page expression.
 */
export const INSPECT_WITHOUT_WORLD = `(() => {
  const inspected = window.korovany.inspect();
  return inspected.snapshot ? { ...inspected, snapshot: { ...inspected.snapshot, world: undefined } } : inspected;
})()`;
