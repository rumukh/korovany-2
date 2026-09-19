import { defaultMix, parseMix, type AudioMix } from "../audio/mix";

export type Language = "ru" | "en";
export interface Settings {
  language: Language;
  quality: "low" | "high";
  reducedMotion: boolean;
  invertControllerCameraX: boolean;
  muted: boolean;
  audio: AudioMix;
}

export type StorageIssue = "unavailable" | "corrupt" | "write" | "conflict";
export type WriteResult = "saved" | "conflict" | "error";
export type ReadResult<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "error"; issue: StorageIssue };

export const storageKeys = {
  settings: "korovany2.settings.v1",
  campaign: "korovany2:campaign",
  profile: "korovany2:profile",
  atlas: "korovany2:atlas",
} as const;

export function defaultSettings(): Settings {
  return {
    language: "ru",
    quality: "high",
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    invertControllerCameraX: false,
    muted: false,
    audio: defaultMix(),
  };
}

export function parseSettings(value: unknown): Settings | null {
  if (!value || typeof value !== "object") return null;
  const fields = value as Record<string, unknown>;
  if ((fields.language !== "ru" && fields.language !== "en") ||
    (fields.quality !== "low" && fields.quality !== "high") ||
    typeof fields.reducedMotion !== "boolean" || typeof fields.muted !== "boolean" ||
    (fields.invertControllerCameraX !== undefined && typeof fields.invertControllerCameraX !== "boolean")) return null;
  const audio = fields.audio === undefined ? defaultMix() : parseMix(fields.audio);
  if (!audio) return null;
  return {
    language: fields.language,
    quality: fields.quality,
    reducedMotion: fields.reducedMotion,
    invertControllerCameraX: fields.invertControllerCameraX ?? false,
    muted: fields.muted,
    audio,
  };
}

export class BrowserStorage {
  private readonly baselines = new Map<string, string | null>();

  constructor(private readonly report: (issue: StorageIssue, key: string) => void) {}

  read<T>(key: string, validate: (value: unknown) => T | null): ReadResult<T> {
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      this.report("unavailable", key);
      return { status: "error", issue: "unavailable" };
    }
    this.baselines.set(key, raw);
    if (raw === null) return { status: "missing" };
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.report("corrupt", key);
      return { status: "error", issue: "corrupt" };
    }
    const parsed = validate(value);
    if (parsed === null) {
      this.report("corrupt", key);
      return { status: "error", issue: "corrupt" };
    }
    return { status: "ok", value: parsed };
  }

  write(key: string, value: unknown): boolean {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      this.report("write", key);
      return false;
    }
  }

  unchanged(key: string): boolean | null {
    try {
      const current = window.localStorage.getItem(key);
      return this.baselines.has(key) && current === this.baselines.get(key);
    } catch {
      this.report("unavailable", key);
      return null;
    }
  }

  writeIfUnchanged(key: string, value: unknown): WriteResult {
    try {
      const next = JSON.stringify(value);
      const current = window.localStorage.getItem(key);
      if (!this.baselines.has(key) || current !== this.baselines.get(key)) {
        this.report("conflict", key);
        return "conflict";
      }
      if (next !== current) window.localStorage.setItem(key, next);
      this.baselines.set(key, next);
      return "saved";
    } catch {
      this.report("write", key);
      return "error";
    }
  }

  remove(key: string): boolean {
    try {
      window.localStorage.removeItem(key);
      return true;
    } catch {
      this.report("write", key);
      return false;
    }
  }

}

/** Loading or previewing a record never makes this tab a writer. */
export class DirtySave {
  dirty = false;
  conflicted = false;

  constructor(private readonly storage: BrowserStorage, private readonly key: string) {}

  markDirty(): void {
    this.dirty = true;
  }

  adopt(): void {
    this.dirty = false;
    this.conflicted = false;
  }

  flush(value: () => unknown): WriteResult | "unchanged" {
    if (!this.dirty) return "unchanged";
    const result = this.storage.writeIfUnchanged(this.key, value());
    if (result === "saved") this.dirty = false;
    if (result === "conflict") this.conflicted = true;
    return result;
  }
}
