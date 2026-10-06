import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createCampaign, generateWorld, type GameSnapshot, type Vec2 } from "../src/game";
import { parseSoundtrack } from "../src/audio/manifest";
import { AudioPresentation, footstep } from "../src/audio/presentation";
import { Soundscape } from "../src/audio/soundscape";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const soundtrack = parseSoundtrack(JSON.parse(read("public/audio/soundtrack/manifest.json").toString("utf8")));
const provenance = JSON.parse(read("scripts/audio/soundtrack-provenance.json").toString("utf8")) as {
  assets: {
    asset: { id: string; src: string };
    category: string;
    delivery: { codec: string; channels: number; sample_rate: number; rms_dbfs: number; sha256: string };
    mastering: { target_transient_lufs?: number; delivery_transient_lufs?: number; delivery_ring_ms?: number };
  }[];
};

describe("footsteps", () => {
  it("ship four quiet takes of each footfall, none with a ringing partial, and no stone footfall", () => {
    const effects = provenance.assets.filter((record) => record.category === "sfx");
    const steps = effects.filter((record) => record.asset.id.startsWith("step-"));
    const others = effects.filter((record) => !record.asset.id.startsWith("step-"));
    const takes = ["dirt", "wood"].flatMap((surface) => [`step-${surface}`, ...[2, 3, 4].map((take) => `step-${surface}-${take}`)]);
    expect(steps.map((record) => record.asset.id).sort()).toEqual([...takes].sort());
    expect(soundtrack.sfx.filter((asset) => asset.id.startsWith("step-")).map((asset) => asset.id).sort()).toEqual([...takes].sort());
    expect(existsSync(new URL("public/audio/soundtrack/sfx/step-stone.ogg", root))).toBe(false);
    const quietestOther = Math.min(...others.map((record) => record.delivery.rms_dbfs));
    for (const record of steps) {
      const id = record.asset.id;
      expect(createHash("sha256").update(read(`public/${record.asset.src}`)).digest("hex"), id).toBe(record.delivery.sha256);
      expect(record.delivery, id).toMatchObject({ codec: "vorbis", channels: 1, sample_rate: 48000 });
      // The strongest partial falls 20 dB within tens of milliseconds; the old stone footfall's rang for 175 ms.
      expect(record.mastering.delivery_ring_ms!, id).toBeLessThanOrEqual(60);
      expect(record.mastering.target_transient_lufs!, id).toBeLessThanOrEqual(-32);
      expect(record.mastering.delivery_transient_lufs!, id).toBeLessThanOrEqual(record.mastering.target_transient_lufs! + 0.5);
      // Footfalls repeat several times a second, so they sit at least 10 dB under every other effect.
      expect(record.delivery.rms_dbfs, id).toBeLessThanOrEqual(quietestOther - 10);
    }
  });

  it("are timber on every bridge deck and earth at every site, the home camp included", () => {
    // Version 3 worlds keep version 2's bridges and sites.
    for (const version of [1, 2] as const) {
      const world = generateWorld("footsteps", version);
      expect(world.bridges.length).toBeGreaterThan(0);
      for (const bridge of world.bridges) {
        expect(footstep(world, { x: (bridge.minX + bridge.maxX) / 2, z: (bridge.minZ + bridge.maxZ) / 2 })).toBe("step-wood");
        expect(footstep(world, { x: bridge.minX, z: bridge.maxZ })).toBe("step-wood");
      }
      for (const site of world.sites) expect(footstep(world, site), `${version}:${site.id}`).toBe("step-dirt");
    }
  });

  it("cue timber footfalls across a bridge and earth footfalls through the camp and fortress rings", () => {
    const start = createCampaign({ seed: "footsteps", faction: "elf" }).snapshot();
    const sound = new Soundscape(vi.fn());
    for (const method of ["setActive", "setScene", "speak"] as const) vi.spyOn(sound, method).mockImplementation(() => {});
    const cue = vi.spyOn(sound, "cue").mockImplementation(() => {});
    const presentation = new AudioPresentation(sound);
    presentation.reset(start);
    presentation.sync(start, null, false, "en");
    let tick = start.tick;
    const walk = (from: Vec2, to: Vec2): string[] => {
      cue.mockClear();
      for (let index = 0; index <= 40; index++) {
        const player = { ...start.player, state: "moving" as const,
          x: from.x + (to.x - from.x) * index / 40, z: from.z + (to.z - from.z) * index / 40 };
        presentation.update({ ...start, tick: ++tick, player } satisfies GameSnapshot);
      }
      return cue.mock.calls.map(([id]) => id).filter((id) => id.startsWith("step-"));
    };
    for (const bridge of start.world.bridges) {
      const middle = { x: (bridge.minX + bridge.maxX) / 2, z: (bridge.minZ + bridge.maxZ) / 2 };
      const lengthwise = bridge.maxZ - bridge.minZ >= bridge.maxX - bridge.minX;
      const deck = walk(lengthwise ? { x: middle.x, z: bridge.minZ + 0.3 } : { x: bridge.minX + 0.3, z: middle.z },
        lengthwise ? { x: middle.x, z: bridge.maxZ - 0.3 } : { x: bridge.maxX - 0.3, z: middle.z });
      expect(deck.length).toBeGreaterThanOrEqual(5);
      expect(new Set(deck)).toEqual(new Set(["step-wood"]));
    }
    for (const kind of ["home", "fortress"] as const) {
      const site = start.world.sites.find((candidate) => candidate.kind === kind)!;
      const ring = walk({ x: site.x - site.radius * 0.8, z: site.z }, { x: site.x + site.radius * 0.8, z: site.z });
      expect(ring.length, kind).toBeGreaterThanOrEqual(4);
      expect(new Set(ring), kind).toEqual(new Set(["step-dirt"]));
    }
  });
});
