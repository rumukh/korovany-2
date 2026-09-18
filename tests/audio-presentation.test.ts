import { describe, expect, it, vi } from "vitest";
import { createCampaign } from "../src/game";
import { getFactionStory } from "../src/game/faction-stories";
import { AudioPresentation, audioScreen, endingMusic, regionAudio } from "../src/audio/presentation";
import { Soundscape } from "../src/audio/soundscape";

function fixture() {
  const snapshot = createCampaign({ seed: "audio-presentation", faction: "elf" }).snapshot();
  const sound = new Soundscape(vi.fn());
  const active = vi.spyOn(sound, "setActive").mockImplementation(() => {});
  const scene = vi.spyOn(sound, "setScene").mockImplementation(() => {});
  const speak = vi.spyOn(sound, "speak").mockImplementation(() => {});
  const cue = vi.spyOn(sound, "cue").mockImplementation(() => {});
  const presentation = new AudioPresentation(sound);
  presentation.reset(snapshot);
  return { snapshot, presentation, sound, active, scene, speak, cue };
}

describe("snapshot-only audio direction", () => {
  it("keeps story/title/terminal audible independently of combat, and focus loss stops every screen", () => {
    const { snapshot, presentation, active } = fixture();
    expect(audioScreen("dialogue", false)).toBe("story");
    expect(audioScreen("inspection", false)).toBe("story");
    expect(audioScreen("terminal", false)).toBe("terminal");
    expect(audioScreen("pause", false)).toBe("paused");
    presentation.sync(snapshot, "dialogue", false, "en");
    expect(active).toHaveBeenLastCalledWith(true);
    presentation.setFocused(false);
    expect(active).toHaveBeenLastCalledWith(false);
    presentation.sync(snapshot, "dialogue", false, "en");
    expect(active).toHaveBeenLastCalledWith(false);
    presentation.setFocused(true);
    presentation.sync(snapshot, "pause", false, "en");
    expect(active).toHaveBeenLastCalledWith(false);
  });

  it("selects regional ambience, delays region changes, and holds combat/boss scores through brief lulls", () => {
    const { snapshot, presentation, scene } = fixture();
    const initialRegion = regionAudio(snapshot);
    presentation.sync(snapshot, null, false, "en");
    expect(scene).toHaveBeenLastCalledWith("road", initialRegion);
    const fen = snapshot.world.exploration!.regions.find((region) => region.id === "fenlands")!;
    snapshot.player.x = (fen.bounds.minX + fen.bounds.maxX) / 2;
    snapshot.player.z = (fen.bounds.minZ + fen.bounds.maxZ) / 2;
    expect(regionAudio(snapshot)).toBe("fens");
    presentation.update(snapshot);
    expect(scene.mock.lastCall?.[1]).toBe(initialRegion);
    snapshot.elapsed += 2.1;
    presentation.update(snapshot);
    expect(scene).toHaveBeenLastCalledWith("mystery", "fens");
    const actor = snapshot.actors.find(actor => actor.allegiance === "hostile")!;
    actor.x = snapshot.player.x;
    actor.z = snapshot.player.z;
    actor.state = "chase";
    presentation.update(snapshot);
    expect(scene.mock.lastCall?.[0]).toBe("combat");
    actor.state = "idle";
    snapshot.elapsed += 3;
    presentation.update(snapshot);
    expect(scene.mock.lastCall?.[0]).toBe("combat");
    snapshot.elapsed += 4;
    presentation.update(snapshot);
    expect(scene.mock.lastCall?.[0]).toBe("mystery");
    const boss = snapshot.actors.find((entry) => entry.kind === "boss")!;
    boss.x = snapshot.player.x;
    boss.z = snapshot.player.z;
    snapshot.fortress.unlocked = true;
    presentation.update(snapshot);
    expect(scene.mock.lastCall?.[0]).toBe("fortress");
  });

  it("deduplicates events, maps faction effects and preserves final cues through terminal presentation", () => {
    const { snapshot, presentation, cue, active, scene } = fixture();
    presentation.sync(snapshot, null, false, "en");
    const event = { tick: 1, key: "event.attack", amount: 0, targetId: "player", x: snapshot.player.x, z: snapshot.player.z };
    snapshot.events.push({ ...event, id: 100, kind: "attack" });
    presentation.update(snapshot);
    presentation.update(snapshot);
    expect(cue.mock.calls.filter(([id]) => id === "attack-elf")).toHaveLength(1);
    snapshot.phase = "victory";
    const ending = getFactionStory(snapshot.faction).endings.compact;
    snapshot.narrative!.ending = { en: `${ending.en}\n\nEpilogue`, ru: `${ending.ru}\n\nИтог` };
    snapshot.events.push({ ...event, id: 101, kind: "victory" });
    presentation.update(snapshot);
    presentation.sync(snapshot, "terminal", false, "en");
    expect(cue).toHaveBeenCalledWith("victory");
    expect(active).toHaveBeenLastCalledWith(true);
    expect(scene).toHaveBeenLastCalledWith("ending-compact", null);
    snapshot.phase = "defeat";
    expect(endingMusic(snapshot)).toBeNull();
    snapshot.phase = "playing";
    expect(endingMusic(snapshot)).toBeNull();
  });

  it("plays terminal presentation on Continue without replaying old combat events", () => {
    const { snapshot, presentation, cue } = fixture();
    snapshot.phase = "defeat";
    presentation.reset(snapshot);
    presentation.sync(snapshot, "terminal", false, "en");
    presentation.sync(snapshot, "terminal", false, "en");
    expect(cue).toHaveBeenCalledExactlyOnceWith("defeat");
  });

  it.each(["elf", "guard", "villain"] as const)("%s resolves all three faction titles and ignores friendly/neutral combatants", faction => {
    const snapshot = createCampaign({ faction, seed: "audio-allegiance" }).snapshot();
    const sound = new Soundscape(vi.fn());
    const scene = vi.spyOn(sound, "setScene").mockImplementation(() => {});
    vi.spyOn(sound, "setActive").mockImplementation(() => {});
    vi.spyOn(sound, "speak").mockImplementation(() => {});
    const presentation = new AudioPresentation(sound);
    const actor = snapshot.actors.find(actor => actor.allegiance === "friendly")!;
    actor.x = snapshot.player.x; actor.z = snapshot.player.z;
    const boss = snapshot.actors.find(actor => actor.kind === "boss")!;
    boss.x = snapshot.player.x; boss.z = snapshot.player.z;
    snapshot.fortress.unlocked = true;
    for (const allegiance of ["friendly", "neutral"] as const) {
      actor.allegiance = allegiance; boss.allegiance = allegiance;
      for (const state of ["windup", "attack", "chase"] as const) {
        actor.state = state; boss.state = state;
        presentation.reset(snapshot);
        presentation.sync(snapshot, null, false, "en");
        expect(["combat", "fortress"]).not.toContain(scene.mock.lastCall?.[0]);
      }
    }
    boss.allegiance = "hostile";
    presentation.update(snapshot);
    expect(scene.mock.lastCall?.[0]).toBe("fortress");
    snapshot.phase = "victory";
    for (const [id, title] of Object.entries(getFactionStory(faction).endings)) {
      snapshot.narrative!.ending = title;
      expect(endingMusic(snapshot)).toBe(`ending-${id}`);
    }
    sound.dispose();
  });

  it("restarts explicit conversation, language and choices, not shell refresh; narrates inspections and endings", () => {
    const { snapshot, presentation, speak } = fixture();
    snapshot.narrative!.dialogue = {
      npcId: "mara", text: { en: "Hello", ru: "Привет" }, name: { en: "Mara", ru: "Мара" },
      role: { en: "Captain", ru: "Капитан" }, choices: [],
    };
    presentation.sync(snapshot, "dialogue", false, "en");
    const first = speak.mock.lastCall?.[0];
    presentation.sync(snapshot, "dialogue", false, "en");
    expect(speak.mock.lastCall?.[0]).toBe(first);
    presentation.sync(snapshot, "dialogue", false, "ru");
    expect(speak.mock.lastCall?.[0]).not.toBe(first);
    expect(speak.mock.lastCall?.[1][0]?.language).toBe("ru");
    presentation.sync(snapshot, "dialogue", false, "en", { player: { en: "Yes", ru: "Да" } });
    expect(speak.mock.lastCall?.[1].map((line) => line.speaker)).toEqual(["player", "mara"]);
    presentation.sync(snapshot, "dialogue", false, "en", { restart: true });
    expect(speak.mock.lastCall?.[0]).not.toBe(first);
    snapshot.narrative!.dialogue = null;
    snapshot.narrative!.inspection = { locationId: "ruins", title: { en: "Ruins", ru: "Руины" }, text: { en: "Evidence", ru: "Следы" } };
    presentation.sync(snapshot, "inspection", false, "en");
    expect(speak.mock.lastCall?.[1][0]?.speaker).toBe("narrator");
    snapshot.narrative!.ending = { en: "Epilogue", ru: "Эпилог" };
    snapshot.phase = "victory";
    presentation.sync(snapshot, "terminal", false, "en");
    expect(speak.mock.lastCall?.[1][0]?.text).toBe("Epilogue");
  });
});
