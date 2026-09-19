import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserStorage, DirtySave, defaultSettings, parseSettings, storageKeys } from "../src/ui/storage";
import { parseChart } from "../src/ui/atlas";
import { translate } from "../src/ui/locale";
import { defaultMix, mixChannels } from "../src/audio/mix";

afterEach(() => vi.unstubAllGlobals());

describe("isolated browser persistence", () => {
  it("reports unavailable and corrupt data instead of pretending to load a save", () => {
    const report = vi.fn();
    const localStorage = { getItem: vi.fn(() => "{broken"), setItem: vi.fn() };
    vi.stubGlobal("window", { localStorage });
    const store = new BrowserStorage(report);
    expect(store.read(storageKeys.settings, parseSettings)).toEqual({ status: "error", issue: "corrupt" });
    expect(report).toHaveBeenLastCalledWith("corrupt", storageKeys.settings);
    localStorage.getItem.mockImplementation(() => { throw new Error("denied"); });
    expect(store.read(storageKeys.settings, parseSettings)).toEqual({ status: "error", issue: "unavailable" });
    expect(report).toHaveBeenLastCalledWith("unavailable", storageKeys.settings);
    expect(store.unchanged(storageKeys.campaign)).toBeNull();
  });

  it("validates settings and returns failed quota writes explicitly", () => {
    const report = vi.fn();
    vi.stubGlobal("window", { localStorage: { setItem: () => { throw new Error("quota"); } } });
    expect(new BrowserStorage(report).write(storageKeys.profile, { renown: 42 })).toBe(false);
    expect(report).toHaveBeenCalledWith("write", storageKeys.profile);
    expect(parseSettings({ language: "en", quality: "low", reducedMotion: true, muted: true })).not.toBeNull();
    expect(parseSettings({ language: "en", quality: "ultra", reducedMotion: true, muted: true })).toBeNull();
    for (const key of Object.values(storageKeys)) expect(key.startsWith("korovany2")).toBe(true);
  });

  it("upgrades old mixer-less settings and validates every persisted audio channel", () => {
    const old = { language: "en", quality: "high", reducedMotion: false, muted: true };
    expect(parseSettings(old)?.audio).toEqual(defaultMix());
    const audio = { master: 0, music: 0.2, ambience: 0.4, effects: 0.6, voices: 1 };
    expect(parseSettings({ ...old, audio })?.audio).toEqual(audio);
    for (const channel of mixChannels) {
      for (const invalid of [-0.1, 1.1, NaN, "1", null]) {
        expect(parseSettings({ ...old, audio: { ...audio, [channel]: invalid } })).toBeNull();
      }
      expect(translate("en", `audio.${channel}`)).not.toBe(`audio.${channel}`);
      expect(translate("ru", `audio.${channel}`)).not.toBe(`audio.${channel}`);
    }
  });

  it("defaults older settings to natural camera control and validates the saved inversion preference", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(defaultSettings().invertControllerCameraX).toBe(false);
    const old = { language: "en", quality: "high", reducedMotion: false, muted: true, audio: defaultMix() };
    expect(parseSettings(old)).toEqual({ ...old, invertControllerCameraX: false });
    for (const inverted of [false, true]) {
      const saved = { ...old, invertControllerCameraX: inverted };
      expect(parseSettings(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    }
    for (const invalid of ["false", 0, 1, null, {}]) {
      expect(parseSettings({ ...old, invertControllerCameraX: invalid })).toBeNull();
    }
    for (const language of ["en", "ru"] as const) {
      expect(translate(language, "invertControllerCameraX")).not.toBe("invertControllerCameraX");
    }
  });

  it("bounds and validates the independently persisted visited atlas cells", () => {
    expect(parseChart({ runId: "journey", explored: [0, 783] })).not.toBeNull();
    expect(parseChart({ runId: "journey", explored: [784] })).toBeNull();
    expect(parseChart({ runId: "journey", explored: [0.5] })).toBeNull();
    expect(parseChart({ runId: 12, explored: [] })).toBeNull();
  });

  it("never serializes or writes an untouched loaded campaign on flush", () => {
    const records = new Map<string, string>([[storageKeys.campaign, JSON.stringify({ tick: 0 })]]);
    const setItem = vi.fn((key: string, value: string) => { records.set(key, value); });
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem } });
    const storage = new BrowserStorage(vi.fn());
    storage.read(storageKeys.campaign, (value) => value);
    const save = new DirtySave(storage, storageKeys.campaign);
    records.set(storageKeys.campaign, JSON.stringify({ tick: 659 }));
    const serialize = vi.fn(() => ({ tick: 0 }));
    expect(save.flush(serialize)).toBe("unchanged");
    expect(serialize).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(records.get(storageKeys.campaign)).toBe('{"tick":659}');
  });

  it("rejects stale same-run and different-run writers while retaining their dirty state", () => {
    const records = new Map<string, string>();
    const getItem = (key: string) => records.get(key) ?? null;
    const setItem = vi.fn((key: string, value: string) => { records.set(key, value); });
    vi.stubGlobal("window", { localStorage: { getItem, setItem } });
    const report = vi.fn();
    const first = new BrowserStorage(report);
    const stale = new BrowserStorage(report);
    first.read(storageKeys.campaign, (value) => value);
    stale.read(storageKeys.campaign, (value) => value);
    expect(first.writeIfUnchanged(storageKeys.campaign, { runId: "first", tick: 659 })).toBe("saved");
    const dirty = new DirtySave(stale, storageKeys.campaign);
    dirty.markDirty();
    expect(dirty.flush(() => ({ runId: "first", tick: 10 }))).toBe("conflict");
    expect(dirty.dirty).toBe(true);
    expect(dirty.conflicted).toBe(true);
    expect(report).toHaveBeenCalledWith("conflict", storageKeys.campaign);
    expect(first.writeIfUnchanged(storageKeys.campaign, { runId: "new-run", tick: 0 })).toBe("saved");
    expect(dirty.flush(() => ({ runId: "first", tick: 20 }))).toBe("conflict");
    expect(getItem(storageKeys.campaign)).toBe('{"runId":"new-run","tick":0}');
    expect(setItem).toHaveBeenCalledTimes(2);
    stale.read(storageKeys.campaign, (value) => value);
    dirty.adopt();
    dirty.markDirty();
    expect(dirty.flush(() => ({ runId: "new-run", tick: 1 }))).toBe("saved");
    expect(dirty.dirty).toBe(false);
    expect(dirty.conflicted).toBe(false);
  });

  it("guards shared metadata and refuses writes without an observed baseline", () => {
    const records = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => { records.set(key, value); },
    } });
    const first = new BrowserStorage(vi.fn());
    const stale = new BrowserStorage(vi.fn());
    expect(first.writeIfUnchanged(storageKeys.profile, { renown: 100 })).toBe("conflict");
    first.read(storageKeys.profile, (value) => value);
    stale.read(storageKeys.profile, (value) => value);
    expect(first.writeIfUnchanged(storageKeys.profile, { renown: 70, damage: 1 })).toBe("saved");
    expect(stale.writeIfUnchanged(storageKeys.profile, { renown: 70, vitality: 1 })).toBe("conflict");
    expect(records.get(storageKeys.profile)).toBe('{"renown":70,"damage":1}');
  });
});

describe("complete game contract translation", () => {
  it("provides RU and EN for every authoritative presentation key", () => {
    const groups: Record<string, string[]> = {
      site: ["home", "forest", "palace", "quarry", "raid", "fortress"],
      objective: ["capture", "raid", "supply", "fortress", "complete", "failed"],
      interaction: ["capture", "contested", "repair", "transfer", "rest", "shop", "raid", "locked"],
      event: ["attack", "hurt", "kill", "coin", "health", "supply", "capture", "delivery", "raid", "convoy", "disabled", "repair", "upgrade", "ability", "fortress", "victory", "defeat"],
      notice: ["location", "coins", "max", "destination"],
      upgrade: ["damage", "vitality", "logistics"],
      faction: ["elf", "guard", "villain"],
      ability: ["volley", "bulwark", "cleave"],
      convoy: ["ranger", "repair", "siege"],
      order: ["hold", "follow", "return", "route"],
      storage: ["unavailable", "corrupt", "write", "conflict"],
    };
    for (const [group, values] of Object.entries(groups)) {
      for (const value of values) {
        const key = `${group}.${value}`;
        expect(translate("ru", key), key).not.toBe(key);
        expect(translate("en", key), key).not.toBe(key);
      }
    }
  });
});
