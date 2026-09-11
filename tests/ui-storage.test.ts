import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserStorage, parseSettings, storageKeys } from "../src/ui/storage";
import { parseChart } from "../src/ui/atlas";
import { translate } from "../src/ui/locale";

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

  it("bounds and validates the independently persisted visited atlas cells", () => {
    expect(parseChart({ runId: "journey", explored: [0, 783] })).not.toBeNull();
    expect(parseChart({ runId: "journey", explored: [784] })).toBeNull();
    expect(parseChart({ runId: "journey", explored: [0.5] })).toBeNull();
    expect(parseChart({ runId: 12, explored: [] })).toBeNull();
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
