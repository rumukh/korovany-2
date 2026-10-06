import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createCampaign, restoreCampaign } from "../src/game";
import type { GameSession, GameSnapshot, Vec2 } from "../src/game/types";
import { isWalkable } from "../src/game/world";
import { parseBeasts, parseSoundtrack } from "../src/audio/manifest";
import { AudioPresentation } from "../src/audio/presentation";
import { Soundscape } from "../src/audio/soundscape";

// W4a: the grave wolves' voices are synthesised by scripts/audio/synth_beasts.py into their own manifest; the soundtrack
// keeps its own unchanged.
const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const beasts = parseBeasts(JSON.parse(read("public/audio/beasts/manifest.json").toString("utf8")));
const provenance = JSON.parse(read("scripts/audio/beasts-provenance.json").toString("utf8")) as {
  license: string; script: { path: string; sha256: string }; limitations: string[];
  assets: { id: string; sha256: string; bytes: number; duration: number; codec: string; channels: number; sampleRate: number }[];
};

describe("grave wolf voices", () => {
  it("ship every voice the presentation cues, from a committed synthesis script, apart from the soundtrack", () => {
    const ids = beasts.map((asset) => asset.id);
    for (const voice of ["howl", "snarl", "yelp", "death"]) expect(ids).toContain(`beast-wolf-${voice}`);
    const soundtrack = parseSoundtrack(JSON.parse(read("public/audio/soundtrack/manifest.json").toString("utf8")));
    expect(soundtrack.sfx.some((asset) => asset.id.startsWith("beast-"))).toBe(false);
    expect(provenance.license).toMatch(/no recordings, samples, sound libraries or generative models/i);
    expect(provenance.limitations.length).toBeGreaterThan(0);
    const script = read(provenance.script.path).toString("utf8").replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(script).digest("hex")).toBe(provenance.script.sha256);
    expect(provenance.assets.map((asset) => asset.id).sort()).toEqual([...ids].sort());
    for (const asset of beasts) {
      const bytes = read(`public/${asset.src}`);
      const record = provenance.assets.find((entry) => entry.id === asset.id)!;
      expect(bytes.subarray(0, 4).toString("latin1"), asset.id).toBe("OggS");
      expect(createHash("sha256").update(bytes).digest("hex"), asset.id).toBe(record.sha256);
      expect(bytes.byteLength).toBe(record.bytes);
      expect(record).toMatchObject({ codec: "vorbis", channels: 1, sampleRate: 48000, duration: asset.duration });
      expect(asset.loop).toBe(false);
      expect(asset.duration).toBeGreaterThan(0.3);
      expect(asset.duration).toBeLessThan(4);
    }
  });

  it("rejects beast manifests outside their folder, looping or misnamed", () => {
    const valid = { id: "beast-wolf-howl", src: "audio/beasts/beast-wolf-howl.ogg", duration: 2, loop: false };
    expect(() => parseBeasts({ version: 1, sfx: [valid] })).not.toThrow();
    for (const bad of [{ ...valid, src: "audio/soundtrack/sfx/kill.ogg" }, { ...valid, loop: true }, { ...valid, id: "wolf-howl" },
      { ...valid, src: "audio/beasts/../x.ogg" }]) expect(() => parseBeasts({ version: 1, sfx: [bad] })).toThrow();
    expect(() => parseBeasts({ version: 1, sfx: [valid, valid] })).toThrow();
    expect(() => parseBeasts({ version: 2, sfx: [valid] })).toThrow();
  });

  it("howls as a pack appears and turns, snarls at each windup, yelps at wounds and cries at deaths, and plays combat music", () => {
    let session: GameSession = createCampaign({ seed: "wolves-a", faction: "guard", worldVersion: 3 });
    const world = session.snapshot().world;
    const lair = world.lairs![0]!;
    const spot = (reach: number, apart = 0): Vec2 => {
      for (let index = 0; index < 144; index++) {
        const angle = index / 144 * Math.PI * 2, p = { x: lair.x + Math.sin(angle) * reach, z: lair.z + Math.cos(angle) * reach };
        if (isWalkable(world, p, 0.65) && world.lairs!.every((other) => other === lair || Math.hypot(other.x - p.x, other.z - p.z) > apart)) return p;
      }
      throw new Error("no spot");
    };
    const move = (at: Vec2) => {
      const value = structuredClone(session.serialize()) as unknown as { engine: { resources: { KorovanyCampaign: { player: Vec2 } } } };
      Object.assign(value.engine.resources.KorovanyCampaign.player, at);
      session = restoreCampaign(value);
    };
    move(spot(120, 170));
    const sound = new Soundscape(vi.fn());
    vi.spyOn(sound, "setActive").mockImplementation(() => {});
    const scene = vi.spyOn(sound, "setScene").mockImplementation(() => {});
    vi.spyOn(sound, "speak").mockImplementation(() => {});
    const cue = vi.spyOn(sound, "cue").mockImplementation(() => {});
    const presentation = new AudioPresentation(sound);
    const show = (snapshot: GameSnapshot) => { presentation.sync(snapshot, null, false, "en"); presentation.update(snapshot); };
    presentation.reset(session.snapshot());
    session.step({});
    show(session.snapshot());
    const ids = () => cue.mock.calls.map((call) => call[0]);
    expect(ids()).toContain("beast-wolf-howl");
    // A pack appearing far off howls quietly: as if from 45 m.
    expect(cue.mock.calls.find((call) => call[0] === "beast-wolf-howl")![1]).toBe(45);
    move(spot(12));
    presentation.reset(session.snapshot());
    cue.mockClear();
    const hunter = (snapshot: GameSnapshot) => {
      const prey = (snapshot.monsters ?? []).filter((m) => m.hp > 0)
        .sort((a, b) => Math.hypot(a.x - snapshot.player.x, a.z - snapshot.player.z) - Math.hypot(b.x - snapshot.player.x, b.z - snapshot.player.z))[0];
      return prey ? { attack: true, aim: { x: prey.x - snapshot.player.x, z: prey.z - snapshot.player.z } } : {};
    };
    let hunting = false;
    for (let tick = 0; tick < 60 * 20; tick++) {
      const snapshot = session.snapshot();
      if ((snapshot.monsters ?? []).some((m) => m.lairId === lair.id) && (snapshot.monsters ?? []).filter((m) => m.lairId === lair.id).every((m) => m.hp <= 0)) break;
      // Stand still until the pack has turned on the hero, then fight.
      if (!hunting) hunting = (snapshot.monsters ?? []).some((m) => m.target === "player" && m.state === "windup");
      session.step(hunting ? hunter(snapshot) : {});
      show(session.snapshot());
    }
    for (const voice of ["howl", "snarl", "yelp", "death"]) expect(ids(), voice).toContain(`beast-wolf-${voice}`);
    // Monster deaths have their own cry, not the troops' kill sting.
    expect(ids()).not.toContain("kill");
    expect(scene.mock.calls.some((call) => call[0] === "combat")).toBe(true);
  });
});
