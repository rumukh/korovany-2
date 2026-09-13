export interface AudioAsset {
  id: string;
  src: string;
  duration: number;
  loop: boolean;
}

export interface SoundtrackManifest {
  version: 1;
  music: AudioAsset[];
  ambience: AudioAsset[];
  sfx: AudioAsset[];
}

export interface VoiceEntry {
  id: string;
  speaker: string;
  language: "ru" | "en";
  text: string;
  clips: { src: string; duration: number }[];
}

export function paragraphs(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
}

export function voiceKey(speaker: string, language: string, text: string): string {
  return JSON.stringify([speaker, language, text.replace(/\r\n?/g, "\n").trim()]);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid audio manifest object.");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Empty audio manifest field.");
  return value;
}

function duration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("Invalid audio duration.");
  return value;
}

function source(value: unknown, directory: string): string {
  const src = string(value);
  if (!src.startsWith(`audio/${directory}/`) || !/^[a-zA-Z0-9_./-]+\.(ogg|mp3|m4a|wav)$/.test(src) ||
    src.split("/").some((part) => part === ".." || part === ".")) throw new Error(`Invalid local audio path: ${src}`);
  return src;
}

export function parseSoundtrack(value: unknown): SoundtrackManifest {
  const root = record(value);
  if (root.version !== 1) throw new Error("Unsupported soundtrack manifest version.");
  const category = (name: string): AudioAsset[] => {
    const entries = root[name];
    if (!Array.isArray(entries) || !entries.length) throw new Error(`Empty soundtrack category: ${name}`);
    const ids = new Set<string>();
    return entries.map((item) => {
      const asset = record(item);
      const id = string(asset.id);
      if (ids.has(id) || typeof asset.loop !== "boolean") throw new Error(`Invalid or duplicate asset: ${id}`);
      ids.add(id);
      return { id, src: source(asset.src, "soundtrack"), duration: duration(asset.duration), loop: asset.loop };
    });
  };
  return { version: 1, music: category("music"), ambience: category("ambience"), sfx: category("sfx") };
}

export function parseVoices(value: unknown): Map<string, VoiceEntry> {
  const root = record(value);
  if (root.version !== 1 || !Array.isArray(root.entries) || !root.entries.length) throw new Error("Empty or unsupported voice manifest.");
  const result = new Map<string, VoiceEntry>();
  for (const item of root.entries) {
    const entry = record(item);
    const speaker = string(entry.speaker);
    const language = entry.language;
    const text = string(entry.text).replace(/\r\n?/g, "\n").trim();
    if ((language !== "ru" && language !== "en") || !Array.isArray(entry.clips) || !entry.clips.length ||
      paragraphs(text).length !== 1) throw new Error("Invalid voice paragraph.");
    const key = voiceKey(speaker, language, text);
    if (result.has(key)) throw new Error(`Duplicate voice paragraph: ${key}`);
    result.set(key, {
      id: string(entry.id), speaker, language, text,
      clips: entry.clips.map((value) => {
        const clip = record(value);
        return { src: source(clip.src, "voices"), duration: duration(clip.duration) };
      }),
    });
  }
  return result;
}
