export type Language = "ru" | "en";
export interface Settings {
  language: Language;
  quality: "low" | "high";
  reducedMotion: boolean;
  muted: boolean;
}

export type StorageIssue = "unavailable" | "corrupt" | "write";
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
    muted: false,
  };
}

export function parseSettings(value: unknown): Settings | null {
  if (!value || typeof value !== "object") return null;
  const fields = value as Record<string, unknown>;
  if ((fields.language !== "ru" && fields.language !== "en") ||
    (fields.quality !== "low" && fields.quality !== "high") ||
    typeof fields.reducedMotion !== "boolean" || typeof fields.muted !== "boolean") return null;
  return {
    language: fields.language,
    quality: fields.quality,
    reducedMotion: fields.reducedMotion,
    muted: fields.muted,
  };
}

export class BrowserStorage {
  constructor(private readonly report: (issue: StorageIssue, key: string) => void) {}

  read<T>(key: string, validate: (value: unknown) => T | null): ReadResult<T> {
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      this.report("unavailable", key);
      return { status: "error", issue: "unavailable" };
    }
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
