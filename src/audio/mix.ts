export const mixChannels = ["master", "music", "ambience", "effects", "voices"] as const;
export type MixChannel = typeof mixChannels[number];
export type AudioMix = Record<MixChannel, number>;

export function defaultMix(): AudioMix {
  return { master: 0.8, music: 0.55, ambience: 0.5, effects: 0.8, voices: 1 };
}

export function parseMix(value: unknown): AudioMix | null {
  if (!value || typeof value !== "object") return null;
  const fields = value as Record<string, unknown>;
  const mix = defaultMix();
  for (const channel of mixChannels) {
    const level = fields[channel];
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) return null;
    mix[channel] = level;
  }
  return mix;
}
