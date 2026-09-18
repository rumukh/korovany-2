import type { Soundscape } from "../src/audio/soundscape";
import { until, type CdpSession } from "../vendor/aegis-engine/packages/render-three/src/browser";

type AudioState = ReturnType<Soundscape["inspect"]>;

export function isSpeechPlaying(audio: AudioState, speaker: string, language: "ru" | "en"): boolean {
  // Speaking/subtitles begin before download and decode; effects also contribute to voices.
  return audio.speaking && audio.voices > audio.effects &&
    audio.subtitle?.speaker === speaker && audio.subtitle.language === language;
}

export function waitForSpeech(cdp: CdpSession, speaker: string, language: "ru" | "en", timeoutMs: number): Promise<AudioState> {
  return until<AudioState>(cdp, "window.korovany.inspect().audio",
    (audio) => isSpeechPlaying(audio, speaker, language), timeoutMs);
}
