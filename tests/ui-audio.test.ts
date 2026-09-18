import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Soundscape, type SpeechLine } from "../src/audio/soundscape";
import { defaultMix } from "../src/audio/mix";
import { paragraphs, parseSoundtrack, parseVoices, voiceKey } from "../src/audio/manifest";
import { isSpeechPlaying } from "./browser-audio";

class Param {
  value = 0;
  setValueAtTime = vi.fn((value: number) => { this.value = value; });
  linearRampToValueAtTime = vi.fn((value: number) => { this.value = value; });
  setTargetAtTime = vi.fn((value: number) => { this.value = value; });
  cancelScheduledValues = vi.fn();
}
class Gain {
  gain = new Param();
  connect = vi.fn();
  disconnect = vi.fn();
}
class Source {
  buffer: unknown;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  onended: (() => void) | null = null;
  end() { this.onended?.(); }
}
class Media {
  static instances: Media[] = [];
  static start: (() => Promise<void>) | null = null;
  paused = true;
  loop = false;
  preload = "";
  currentTime = 0;
  readyState = 4;
  error = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => { this.paused = false; await Media.start?.(); });
  pause = vi.fn(() => { this.paused = true; });
  removeAttribute = vi.fn(() => { this.src = ""; });
  load = vi.fn();
  constructor(public src: string) { Media.instances.push(this); }
}
class Context {
  static instances: Context[] = [];
  state = "suspended";
  currentTime = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  sources: Source[] = [];
  gains: Gain[] = [];
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => ({ length: 48_000, numberOfChannels: 1, duration: 1 }));
  createGain = () => {
    const gain = new Gain();
    this.gains.push(gain);
    return gain;
  };
  createStereoPanner = () => ({ pan: new Param(), connect: vi.fn(), disconnect: vi.fn() });
  createMediaElementSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  createBufferSource = () => {
    const source = new Source();
    this.sources.push(source);
    return source;
  };
  constructor() { Context.instances.push(this); }
}

const asset = (id: string) => ({ id, src: `audio/soundtrack/${id}.ogg`, duration: 2, loop: true });
const score = {
  version: 1,
  music: ["title", "road", "combat", "fortress", "ending-commons", "ending-compact", "ending-cinder"].map(asset),
  ambience: ["heartlands", "fens", "hollowvale"].map(asset),
  sfx: ["click", "hit", "delivery", "victory", "defeat", "attack-elf", ...Array.from({ length: 24 }, (_, i) => `effect${i}`)].map(asset),
};
const entry = (speaker: string, language: "en" | "ru", text: string, count = 1) => ({
  id: `${speaker}-${language}-${text}`, speaker, language, text,
  clips: Array.from({ length: count }, (_, i) => ({ src: `audio/voices/${speaker}-${language}-${text}-${i}.ogg`, duration: 1 })),
});
const catalogue = { version: 1, entries: [
  entry("mara", "en", "Hello"), entry("mara", "en", "Response", 2), entry("player", "en", "Yes"),
  entry("mara", "ru", "Privet"), entry("narrator", "en", "Ending"),
] };
const line = (text = "Hello", speaker = "mara", language: "en" | "ru" = "en"): SpeechLine =>
  ({ speaker, language, text, label: speaker });
const instances: Soundscape[] = [];
let request: ReturnType<typeof vi.fn>;
const make = (failure = vi.fn(), caption = vi.fn()) => {
  const sound = new Soundscape(failure, caption);
  instances.push(sound);
  return sound;
};
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("Audio", Media);
  vi.stubGlobal("document", { baseURI: "https://local.test/korovany-2/" });
  request = vi.fn(async (url: string) => new Response(url.endsWith("soundtrack/manifest.json") ? JSON.stringify(score)
    : url.endsWith("voices/manifest.json") ? JSON.stringify(catalogue) : new Uint8Array([1, 2, 3])));
  vi.stubGlobal("fetch", request);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  instances.splice(0).forEach((sound) => sound.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Context.instances = [];
  Media.instances = [];
  Media.start = null;
});

describe("local asset contract", () => {
  it("retains single newlines, normalizes CRLF, rejects malformed and empty catalogues", () => {
    expect(paragraphs("  A\r\n\r\n B\r\nC  ")).toEqual(["A", "B\nC"]);
    expect(voiceKey("mara", "en", " A\r\nB ")).toBe(voiceKey("mara", "en", "A\nB"));
    expect(parseSoundtrack(score).music[0]?.id).toBe("title");
    expect(parseVoices(catalogue).size).toBe(5);
    for (const invalid of [null, {}, { version: 1, entries: [] }, { version: 1, entries: [entry("mara", "en", "A\n\nB")] }]) {
      expect(() => parseVoices(invalid)).toThrow();
    }
    expect(() => parseSoundtrack({ ...score, music: [] })).toThrow();
    expect(() => parseSoundtrack({ ...score, music: [{ ...asset("title"), src: "https://remote.test/song.ogg" }] })).toThrow();
    expect(() => parseVoices({ version: 1, entries: [catalogue.entries[0], catalogue.entries[0]] })).toThrow();
  });
});

describe("gesture-unlocked media transport", () => {
  it("does not construct or fetch before a gesture, starts title, and stops all media on pause/dispose", async () => {
    const sound = make();
    sound.setActive(true);
    sound.cue("click");
    expect(Context.instances).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
    await sound.unlock();
    await flush();
    const context = Context.instances[0]!;
    expect(context.resume).toHaveBeenCalledOnce();
    expect(Media.instances[0]?.src).toContain("audio/soundtrack/title.ogg");
    expect(context.decodeAudioData).not.toHaveBeenCalled();
    sound.cue("delivery");
    await flush();
    expect(sound.inspect().effects).toBe(1);
    sound.setActive(false);
    expect(sound.inspect().voices).toBe(0);
    expect(sound.inspect().streams).toHaveLength(0);
    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(Media.instances[0]?.pause).toHaveBeenCalledOnce();
    sound.dispose();
    sound.dispose();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("never resumes outside unlock and respects mute before the first gesture", async () => {
    const sound = make();
    sound.configure(true);
    await sound.unlock();
    expect(Context.instances).toHaveLength(0);
    sound.configure(false);
    sound.setActive(true);
    expect(Context.instances).toHaveLength(0);
    await sound.unlock();
    await flush();
    const context = Context.instances[0]!;
    context.state = "suspended";
    sound.configure(false);
    sound.setActive(false);
    sound.setActive(true);
    expect(context.resume).toHaveBeenCalledOnce();
    await sound.unlock();
    expect(context.resume).toHaveBeenCalledTimes(2);
  });

  it("crossfades only two streams per lane and fades to silence when a bed becomes null", async () => {
    const sound = make();
    sound.setActive(true);
    await sound.unlock();
    await flush();
    sound.setScene("road", "heartlands");
    await flush();
    expect(sound.inspect().streams).toHaveLength(3);
    sound.setScene("combat", "fens");
    await flush();
    expect(sound.inspect().streams).toHaveLength(4);
    vi.advanceTimersByTime(1700);
    expect(sound.inspect().streams.map((stream) => stream.id)).toEqual(["combat", "fens"]);
    sound.setScene(null, null);
    await flush();
    vi.advanceTimersByTime(1700);
    expect(sound.inspect().streams).toHaveLength(0);
  });

  it("keeps the audible bed when successive replacement streams are still downloading", async () => {
    const sound = make();
    sound.setActive(true);
    await sound.unlock();
    await flush();
    const title = Media.instances[0]!;
    const road = deferred<void>();
    const combat = deferred<void>();
    Media.start = () => road.promise;
    sound.setScene("road", null);
    await flush();
    const superseded = Media.instances.at(-1)!;
    Media.start = () => combat.promise;
    sound.setScene("combat", null);
    await flush();
    expect(title.paused).toBe(false);
    expect(superseded.paused).toBe(true);
    expect(sound.inspect().streams.map((stream) => stream.id)).toEqual(["title", "combat"]);
    road.resolve();
    await flush();
    expect(title.paused).toBe(false);
    combat.resolve();
    await flush();
    vi.advanceTimersByTime(1700);
    expect(title.paused).toBe(true);
    expect(sound.inspect().streams.map((stream) => stream.id)).toEqual(["combat"]);
  });

  it("ignores stale manifest and play resolutions after pause, replacement, and disposal", async () => {
    const pending = deferred<Response>();
    request.mockReturnValueOnce(pending.promise);
    const sound = make();
    sound.setActive(true);
    await sound.unlock();
    sound.setActive(false);
    pending.resolve(new Response(JSON.stringify(score)));
    await flush();
    expect(Media.instances).toHaveLength(0);
    const play = deferred<void>();
    Media.start = () => play.promise;
    sound.setActive(true);
    await flush();
    sound.dispose();
    play.resolve();
    await flush();
    expect(sound.inspect().streams).toHaveLength(0);
    expect(Media.instances.every((media) => media.paused)).toBe(true);
  });

  it("surfaces unavailable manifests and autoplay/decode failures without a synthesized fallback", async () => {
    const failure = vi.fn();
    request.mockResolvedValue(new Response("Not found", { status: 404 }));
    const sound = make(failure);
    sound.setActive(true);
    await sound.unlock();
    await flush();
    expect(failure).toHaveBeenCalledOnce();
    expect(sound.inspect().streams).toHaveLength(0);
    expect(Context.instances[0]?.sources).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });

  it("reports playback rejection, decoder errors, and audio-device interruptions", async () => {
    const failure = vi.fn();
    Media.start = () => Promise.reject(new DOMException("Blocked", "NotAllowedError"));
    const sound = make(failure);
    sound.setActive(true);
    await sound.unlock();
    await flush();
    expect(failure).toHaveBeenCalledOnce();
    expect(sound.inspect().streams).toHaveLength(0);
    const context = Context.instances[0]!;
    context.decodeAudioData.mockRejectedValueOnce(new Error("Unsupported codec"));
    sound.cue("click");
    await flush();
    expect(failure).toHaveBeenCalledTimes(2);
    expect(sound.inspect().effects).toBe(0);
    context.state = "suspended";
    context.onstatechange?.();
    expect(failure).toHaveBeenCalledTimes(3);
    expect(sound.inspect().failures).toContain("audio-device");
  });
});

describe("cancellable bilingual speech", () => {
  it.each([{ channels: 2, duration: 1 }, { channels: 1, duration: 0 }])("rejects invalid voice media %j without a replacement transport", async ({ channels, duration }) => {
    const failure = vi.fn(), sound = make(failure);
    sound.setActive(true);
    await sound.unlock();
    await flush();
    Context.instances[0]!.decodeAudioData.mockResolvedValueOnce({ length: 48_000, numberOfChannels: channels, duration });
    sound.speak("invalid", [line()]);
    await flush();
    expect(failure).toHaveBeenCalledOnce();
    expect(sound.inspect().voices).toBe(0);
    expect(sound.inspect().speaking).toBe(false);
    expect(Context.instances).toHaveLength(1);
  });

  it("applies independent voice/music gains through the same context and shared cache", async () => {
    const sound = make();
    sound.setScene("road", "heartlands");
    sound.setActive(true);
    sound.speak("voice", [line()]);
    await sound.unlock();
    await flush();
    const cached = sound.inspect().cacheEntries;
    expect(isSpeechPlaying(sound.inspect(), "mara", "en")).toBe(true);
    sound.configure(false, { ...defaultMix(), voices: 0 });
    expect(sound.inspect().speaking).toBe(false);
    expect(sound.inspect().streams.map(stream => stream.id)).toEqual(["road", "heartlands"]);
    expect(Context.instances[0]!.gains[4]!.gain.value).toBe(0);
    sound.configure(false, { ...defaultMix(), music: 0 });
    await flush();
    expect(isSpeechPlaying(sound.inspect(), "mara", "en")).toBe(true);
    expect(sound.inspect().streams.map(stream => stream.id)).toEqual(["heartlands"]);
    expect(sound.inspect().cacheEntries).toBe(cached);
    expect(Context.instances).toHaveLength(1);
  });

  it.each([false, true])("waits for decoded voice playback, not speech loading or subtitles (effect=%s)", async (effect) => {
    const sound = make();
    sound.setActive(true);
    await sound.unlock();
    if (effect) sound.cue("click");
    await flush();
    const context = Context.instances[0]!;
    const pending = deferred<{ length: number; numberOfChannels: number; duration: number }>();
    context.decodeAudioData.mockReturnValueOnce(pending.promise);
    sound.speak("en", [line()]);
    await flush();
    const loading = sound.inspect();
    expect(loading.speaking).toBe(true);
    expect(loading.subtitle?.text).toBe("Hello");
    expect(loading.lastDecoded?.src).toBe(effect ? "audio/soundtrack/click.ogg" : undefined);
    expect(loading.voices).toBe(Number(effect));
    expect(loading.effects).toBe(Number(effect));
    expect(isSpeechPlaying(loading, "mara", "en")).toBe(false);

    pending.resolve({ length: 48_000, numberOfChannels: 1, duration: 1 });
    await flush();
    const playing = sound.inspect();
    expect(playing.voices).toBe(Number(effect) + 1);
    expect(playing.effects).toBe(Number(effect));
    expect(playing.lastDecoded?.src).toBe("audio/voices/mara-en-Hello-0.ogg");
    expect(isSpeechPlaying(playing, "mara", "en")).toBe(true);
    expect(isSpeechPlaying(playing, "player", "en")).toBe(false);
    expect(isSpeechPlaying(playing, "mara", "ru")).toBe(false);
    context.sources.at(-1)?.end();
    await flush();
    expect(isSpeechPlaying(sound.inspect(), "mara", "en")).toBe(false);
  });

  it("queues selected player and all response clips, ducks music, and does not repeat refreshed text", async () => {
    const caption = vi.fn();
    const sound = make(vi.fn(), caption);
    sound.setActive(true);
    sound.speak("initial", [line()]);
    await sound.unlock();
    await flush();
    const context = Context.instances[0]!;
    expect(sound.inspect().speaking).toBe(true);
    expect(context.gains[1]?.gain.value).toBeCloseTo(defaultMix().music * 0.3);
    sound.speak("choice", [line("Yes", "player"), line("Response")]);
    await flush();
    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(sound.inspect().subtitle?.speaker).toBe("player");
    context.sources.at(-1)?.end();
    await flush();
    expect(sound.inspect().subtitle?.text).toBe("Response");
    context.sources.at(-1)?.end();
    await flush();
    expect(sound.inspect().speechIndex).toBe(1);
    context.sources.at(-1)?.end();
    await flush();
    expect(sound.inspect().speaking).toBe(false);
    expect(context.gains[1]?.gain.value).toBe(defaultMix().music);
    const count = context.sources.length;
    sound.speak("choice", [line("Yes", "player"), line("Response")]);
    await flush();
    expect(context.sources).toHaveLength(count);
    expect(request.mock.calls.filter(([url]) => String(url).includes("/voices/")).length).toBe(5);
  });

  it("does not replay a completed player/response queue when focus activation returns", async () => {
    const sound = make();
    sound.setActive(true);
    sound.speak("completed", [line("Yes", "player"), line("Response")]);
    await sound.unlock();
    await flush();
    const context = Context.instances[0]!;
    for (let clip = 0; clip < 3; clip++) {
      context.sources.at(-1)!.end();
      await flush();
    }
    const completed = sound.inspect();
    expect(completed.speechIndex).toBe(completed.speechLength);
    expect(completed.speaking).toBe(false);
    const played = context.sources.length;
    sound.setActive(false);
    sound.setActive(true);
    await flush();
    expect(context.sources).toHaveLength(played);
    expect(sound.inspect().voices).toBe(0);
    expect(sound.inspect().speechIndex).toBe(completed.speechLength);
  });

  it("discards a stale native decode and restarts the right language after pause/mute", async () => {
    const sound = make();
    sound.setActive(true);
    await sound.unlock();
    await flush();
    const pending = deferred<{ length: number; numberOfChannels: number; duration: number }>();
    const context = Context.instances[0]!;
    context.decodeAudioData.mockReturnValueOnce(pending.promise);
    sound.speak("en", [line()]);
    await flush();
    sound.speak("ru", [line("Privet", "mara", "ru")]);
    await flush();
    expect(sound.inspect().subtitle?.language).toBe("ru");
    pending.resolve({ length: 48_000, numberOfChannels: 1, duration: 1 });
    await flush();
    expect(context.sources).toHaveLength(1);
    expect(sound.inspect().cacheEntries).toBe(1);
    sound.setActive(false);
    expect(sound.inspect().voices).toBe(0);
    sound.setActive(true);
    await flush();
    expect(sound.inspect().subtitle?.language).toBe("ru");
    sound.configure(true);
    expect(sound.inspect().voices).toBe(0);
    expect(sound.inspect().streams).toHaveLength(0);
    sound.configure(false);
    await flush();
    expect(sound.inspect().subtitle?.language).toBe("ru");
  });

  it("reports missing paragraphs explicitly, cancels hidden queues, and never caches after disposal", async () => {
    const failure = vi.fn();
    const sound = make(failure);
    sound.setActive(true);
    await sound.unlock();
    sound.speak("missing", [line("Unavailable")]);
    await flush();
    expect(failure).toHaveBeenCalledOnce();
    expect(sound.inspect().voices).toBe(0);
    const context = Context.instances[0]!;
    const pending = deferred<{ length: number; numberOfChannels: number; duration: number }>();
    context.decodeAudioData.mockReturnValueOnce(pending.promise);
    sound.speak("late", [line()]);
    await flush();
    sound.dispose();
    pending.resolve({ length: 48_000, numberOfChannels: 1, duration: 1 });
    await flush();
    expect(sound.inspect().cacheBytes).toBe(0);
    expect(context.sources).toHaveLength(0);
  });

  it("continues available paragraphs after a visible missing-line warning", async () => {
    const failure = vi.fn();
    const sound = make(failure);
    sound.setActive(true);
    await sound.unlock();
    sound.speak("partial", [line("Unavailable"), line("Response")]);
    await flush();
    expect(failure).toHaveBeenCalledOnce();
    expect(sound.inspect().subtitle?.text).toBe("Response");
    expect(sound.inspect().voices).toBe(1);
  });

  it("bounds unabortable native decodes when rapid speech selections replace each other", async () => {
    const sound = make();
    sound.setActive(true);
    await sound.unlock();
    await flush();
    const first = deferred<{ length: number; numberOfChannels: number; duration: number }>();
    const second = deferred<{ length: number; numberOfChannels: number; duration: number }>();
    const context = Context.instances[0]!;
    context.decodeAudioData.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    sound.speak("1", [line()]);
    await flush();
    sound.speak("2", [line("Privet", "mara", "ru")]);
    await flush();
    sound.speak("3", [line("Yes", "player")]);
    await flush();
    expect(sound.inspect().decoding).toBe(2);
    expect(sound.inspect().waitingDecodes).toBe(1);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(2);
    first.resolve({ length: 48_000, numberOfChannels: 1, duration: 1 });
    second.resolve({ length: 48_000, numberOfChannels: 1, duration: 1 });
    await flush();
    expect(sound.inspect().subtitle?.speaker).toBe("player");
    expect(context.sources).toHaveLength(1);
    expect(sound.inspect().cacheEntries).toBe(1);
  });
});

describe("bounded spatial effects and memory", () => {
  it("rate limits, drops distant cues, caps pending/playing polyphony, and applies spatial gain", async () => {
    const sound = make();
    sound.setActive(true);
    await sound.unlock();
    await flush();
    sound.cue("hit", 60);
    sound.cue("hit", 27.5, -0.7);
    sound.cue("hit");
    await flush();
    expect(sound.inspect().effects).toBe(1);
    const context = Context.instances[0]!;
    expect(context.gains.at(-1)?.gain.value).toBeCloseTo(0.25);
    for (let round = 0; round < 4; round++) {
      context.currentTime += 1;
      for (let i = 0; i < 24; i++) sound.cue(`effect${i}`);
      expect(sound.inspect().pendingEffects).toBeLessThanOrEqual(4);
      await flush();
    }
    expect(sound.inspect().effects).toBe(12);
    sound.configure(false, { ...defaultMix(), effects: 0 });
    expect(sound.inspect().effects).toBe(0);
  });

  it("evicts least-recently-used decoded audio without decoding streamed beds", async () => {
    const sound = make();
    sound.setActive(true);
    await sound.unlock();
    await flush();
    const context = Context.instances[0]!;
    context.decodeAudioData.mockResolvedValue({ length: 1_000_000, numberOfChannels: 1, duration: 20 });
    for (let i = 0; i < 16; i++) {
      sound.cue(`effect${i}`);
      await flush();
      context.sources.at(-1)?.end();
    }
    expect(sound.inspect().cacheBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(sound.inspect().cacheEntries).toBe(6);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(16);
    sound.dispose();
    expect(sound.inspect().cacheBytes).toBe(0);
  });

  it("gives terminal cues priority over saturated combat audio without stopping the ending score", async () => {
    const sound = make();
    sound.setActive(true);
    await sound.unlock();
    await flush();
    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < 4; i++) sound.cue(`effect${batch * 4 + i}`);
      await flush();
    }
    expect(sound.inspect().effects).toBe(12);
    sound.setScene("ending-commons", null);
    sound.cue("victory");
    sound.setActive(true);
    await flush();
    expect(sound.inspect().effects).toBe(1);
    expect(sound.inspect().recentEffects.at(-1)?.id).toBe("victory");
    expect(sound.inspect().streams.some((stream) => stream.id === "ending-commons")).toBe(true);
    expect(Context.instances[0]?.sources.slice(0, 12).every((source) => source.stop.mock.calls.length === 1)).toBe(true);
  });

  it("retains a terminal cue through gesture unlock but never replays it after mute or pause", async () => {
    const sound = make();
    sound.setScene("ending-commons", null);
    sound.setActive(true);
    sound.cue("victory");
    expect(request).not.toHaveBeenCalled();
    await sound.unlock();
    await flush();
    expect(sound.inspect().recentEffects.at(-1)?.id).toBe("victory");
    sound.setActive(false);
    sound.setActive(true);
    await flush();
    expect(sound.inspect().effects).toBe(0);
    expect(sound.inspect().recentEffects).toHaveLength(1);
  });
});
