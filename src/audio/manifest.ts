export interface VoiceEntry {
  id: string;
  speaker: string;
  language: "ru" | "en";
  text: string;
  clips: { src: string; duration: number }[];
}

export function paragraphs(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
}

export function voiceKey(speaker: string, language: string, text: string): string {
  return JSON.stringify([speaker, language, text.replace(/\r\n?/g, "\n").trim()]);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid voice manifest object.");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Empty voice manifest field.");
  return value;
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
      clips: entry.clips.map(value => {
        const clip = record(value);
        const src = string(clip.src);
        if (!src.startsWith("audio/voices/") || !/^[a-zA-Z0-9_./-]+\.(ogg|mp3|m4a|wav)$/.test(src) ||
          src.split("/").some(part => part === ".." || part === ".")) throw new Error(`Invalid local voice path: ${src}`);
        const duration = clip.duration;
        if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) throw new Error("Invalid voice duration.");
        return { src, duration };
      }),
    });
  }
  return result;
}
