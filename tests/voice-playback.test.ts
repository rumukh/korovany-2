import { describe, expect, test, vi } from "vitest";
import { createCampaign } from "../src/game";
import { getFactionStory } from "../src/game/faction-stories";
import { paragraphs, parseVoices, voiceKey } from "../src/audio/manifest";
import { AudioPresentation, type AudioOutput } from "../src/audio/presentation";
import { factions, journalBefore, scene, voiceState } from "../scripts/voices/catalogue";

function output(): AudioOutput {
  return { speak: vi.fn(), cancelSpeech: vi.fn(), setActive: vi.fn(), setScene: vi.fn(), cue: vi.fn() };
}

describe("recorded faction voice presentation", () => {
  test("normalization preserves military lists and side-epilogue single newlines", () => {
    expect(paragraphs(" A\r\nB\r\n\r\nC ")).toEqual(["A\nB", "C"]);
    expect(voiceKey("toman", "ru", " A\rB ")).toBe(voiceKey("toman", "ru", "A\nB"));
    expect(voiceKey("toman", "en", "A B")).not.toBe(voiceKey("toman", "en", "A\nB"));
    const manifest = { version: 1, entries: [{ id: "exact", speaker: "narrator", language: "en", text: "Title\nOutcome",
      clips: [{ src: "audio/voices/en/narrator/exact.ogg", duration: 2 }] }] };
    expect(parseVoices(manifest).get(voiceKey("narrator", "en", "Title\nOutcome"))?.id).toBe("exact");
    expect(() => parseVoices({ ...manifest, entries: [...manifest.entries, ...manifest.entries] })).toThrow(/Duplicate/);
    expect(() => parseVoices({ ...manifest, entries: [{ ...manifest.entries[0], text: "Title\n\nOutcome" }] })).toThrow(/paragraph/);
    expect(() => parseVoices({ ...manifest, entries: [{ ...manifest.entries[0],
      clips: [{ src: "audio/voices/../secret.ogg", duration: 2 }] }] })).toThrow(/path/);
  });

  test.each(factions)("%s: queues the selected player line before exact NPC text in both languages", faction => {
    const snapshot = createCampaign({ faction, seed: "voice-presentation" }).snapshot();
    const npc = getFactionStory(faction).npcs.find(n => n.locationId === snapshot.campaign!.identity.homeLocationId)!;
    snapshot.narrative = scene(voiceState(faction), npc.id);
    const sound = output(), presentation = new AudioPresentation(sound);
    const dialogue = snapshot.narrative.dialogue!;
    for (const language of ["ru", "en"] as const) {
      presentation.sync(snapshot, "dialogue", false, language, { player: dialogue.choices[0]!.text });
      expect(sound.speak).toHaveBeenLastCalledWith(expect.stringContaining(`:${language}`), [
        expect.objectContaining({ speaker: "player", text: dialogue.choices[0]!.text[language], language }),
        expect.objectContaining({ speaker: npc.id, text: dialogue.text[language], language }),
      ]);
      expect(sound.setActive).toHaveBeenLastCalledWith(true);
    }
  });

  test("pause/focus/title cancel audibility without changing game state or losing scene identity", () => {
    const snapshot = createCampaign({ faction: "elf", seed: "voice-focus" }).snapshot();
    snapshot.narrative = scene(voiceState("elf"), "toman");
    const before = structuredClone(snapshot);
    const sound = output(), presentation = new AudioPresentation(sound);
    presentation.sync(snapshot, "dialogue", false, "ru");
    const key = vi.mocked(sound.speak).mock.calls.at(-1)![0];
    presentation.setFocused(false);
    expect(sound.setActive).toHaveBeenLastCalledWith(false);
    presentation.sync(snapshot, "pause", false, "ru");
    presentation.setFocused(true);
    expect(sound.setActive).toHaveBeenLastCalledWith(false);
    presentation.sync(snapshot, "dialogue", false, "ru");
    expect(vi.mocked(sound.speak).mock.calls.at(-1)![0]).toBe(key);
    presentation.sync(snapshot, "dialogue", false, "en");
    expect(vi.mocked(sound.speak).mock.calls.at(-1)![0]).not.toBe(key);
    presentation.sync(snapshot, "menu", true, "en");
    expect(sound.setActive).toHaveBeenLastCalledWith(true);
    expect(sound.setScene).toHaveBeenLastCalledWith("title", null);
    expect(sound.speak).toHaveBeenLastCalledWith(expect.any(String), []);
    presentation.reset(snapshot);
    expect(sound.cancelSpeech).toHaveBeenCalledOnce();
    expect(snapshot).toEqual(before);
  });

  test("speaks the selected leave choice once, without retaining an NPC response", () => {
    const snapshot = createCampaign({ faction: "elf", seed: "voice-leave" }).snapshot();
    snapshot.narrative = scene(voiceState("elf"), "toman");
    const leave = snapshot.narrative.dialogue!.choices.find(c => c.id === "leave")!.text;
    snapshot.narrative.dialogue = null;
    const sound = output(), presentation = new AudioPresentation(sound);
    presentation.sync(snapshot, null, false, "en", { player: leave });
    expect(sound.speak).toHaveBeenLastCalledWith(expect.any(String), [
      expect.objectContaining({ speaker: "player", text: leave.en }),
    ]);
    expect(sound.setActive).toHaveBeenLastCalledWith(true);
    presentation.sync(snapshot, null, false, "ru");
    expect(sound.speak).toHaveBeenLastCalledWith(expect.any(String), []);
    expect(sound.setActive).toHaveBeenLastCalledWith(true);
  });

  test.each(factions)("%s: all three actual terminal epilogues use narrator, not old global ending labels", faction => {
    const story = getFactionStory(faction);
    const final = story.quests.find(q => q.stages.some(s => s.actions.some(a => a.ending)))!;
    const sound = output(), presentation = new AudioPresentation(sound);
    for (const ending of final.stages.at(-1)!.actions) {
      const journal = journalBefore(faction, final, final.stages.length, [ending.id]);
      const snapshot = createCampaign({ faction, seed: "voice-ending" }).snapshot();
      snapshot.phase = "victory";
      snapshot.narrative = scene(voiceState(faction, journal, true));
      for (const language of ["ru", "en"] as const) {
        presentation.sync(snapshot, "terminal", false, language);
        expect(sound.speak).toHaveBeenLastCalledWith(expect.any(String), [
          expect.objectContaining({ speaker: "narrator", text: snapshot.narrative.ending![language] }),
        ]);
      }
    }
  });
});
