import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getFactionStory } from "../src/game/faction-stories";
import type { FactionId } from "../src/game";
import { NPC_PORTRAIT_IDS, npcPortraitId, PLAYER_PORTRAITS, portraitUrl } from "../src/ui/portraits";
import catalog from "../scripts/portraits/catalog.json";

interface PortraitRecord {
  id: string;
  kind: string;
  file: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  generatedAt: string;
  prompt: string;
  master: { file: string; width: number; height: number; sha256: string };
}
const directory = join(process.cwd(), "public", "portraits");
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as {
  model: string;
  settings: typeof catalog.settings;
  attribution: string;
  delivery: { totalBytes: number };
  portraits: PortraitRecord[];
};
const factions: FactionId[] = ["elf", "guard", "villain"];

describe("canonical generated dialogue portraits", () => {
  it("keeps portraits local under relative and hosted application bases", () => {
    try {
      for (const base of ["./", "/korovany-2/"]) {
        vi.stubEnv("BASE_URL", base);
        expect(portraitUrl("mara")).toBe(`${base}portraits/mara.webp`);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(factions)("covers every current %s resident and speaking quest stage without prose matching", (faction) => {
    const story = getFactionStory(faction);
    expect([...NPC_PORTRAIT_IDS].sort()).toEqual(story.npcs.map((npc) => npc.id).sort());
    for (const npc of story.npcs) expect(npcPortraitId(npc.id)).toBe(npc.id);
    for (const stage of story.quests.flatMap((quest) => quest.stages).filter((stage) => stage.kind === "talk")) {
      expect(npcPortraitId(stage.at), stage.at).not.toBeNull();
    }
    expect(PLAYER_PORTRAITS[faction]).toBe(`player-${faction}`);
    expect(portraitUrl(PLAYER_PORTRAITS[faction])).toBe(`/portraits/player-${faction}.webp`);
    expect(npcPortraitId(story.npcs[0]!.name.en)).toBeNull();
    expect(npcPortraitId(story.npcs[0]!.name.ru)).toBeNull();
    expect(npcPortraitId("narrator")).toBeNull();
    expect(npcPortraitId("not-authored")).toBeNull();
  });

  it("ships exactly 23 unique local images with hashes, original prompts and generation provenance", () => {
    const ids = [...NPC_PORTRAIT_IDS, ...Object.values(PLAYER_PORTRAITS)];
    expect(manifest.portraits.map((entry) => entry.id).sort()).toEqual(ids.sort());
    expect(catalog.characters.map((entry) => entry.id).sort()).toEqual(ids);
    expect(readdirSync(directory).filter((file) => file.endsWith(".webp")).sort())
      .toEqual(manifest.portraits.map((entry) => entry.file).sort());
    expect(manifest.model).toBe("gpt-image-2");
    expect(manifest.settings).toEqual(catalog.settings);
    expect(manifest.attribution).toContain("Original AI-generated");
    expect(new Set(manifest.portraits.map((entry) => entry.sha256)).size).toBe(23);
    for (const entry of manifest.portraits) {
      const image = readFileSync(join(directory, entry.file));
      expect(entry.file).toBe(`${entry.id}.webp`);
      expect(image.subarray(0, 4).toString()).toBe("RIFF");
      expect(image.subarray(8, 12).toString()).toBe("WEBP");
      expect(createHash("sha256").update(image).digest("hex")).toBe(entry.sha256);
      expect(image.length).toBe(entry.bytes);
      expect(entry.bytes).toBeLessThanOrEqual(40_000);
      expect([entry.width, entry.height]).toEqual([320, 320]);
      expect([entry.master.width, entry.master.height]).toEqual([1024, 1024]);
      expect(entry.master.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Number.isFinite(Date.parse(entry.generatedAt))).toBe(true);
      const character = catalog.characters.find((person) => person.id === entry.id)!;
      expect(entry.prompt).toBe(`${character.subject}\n\n${catalog.style}`);
      expect(entry.kind).toBe(character.kind);
    }
    expect(manifest.delivery.totalBytes).toBe(manifest.portraits.reduce((sum, entry) => sum + entry.bytes, 0));
    expect(manifest.delivery.totalBytes).toBeLessThanOrEqual(700_000);
  });
});
