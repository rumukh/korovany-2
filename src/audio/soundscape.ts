import { defaultMix, type AudioMix } from "./mix";
import { paragraphs, parseSoundtrack, parseVoices, voiceKey, type AudioAsset, type SoundtrackManifest, type VoiceEntry } from "./manifest";

export interface SpeechLine {
  speaker: string;
  language: "ru" | "en";
  text: string;
  label: string;
}

type Lane = "music" | "ambience";
interface Stream {
  id: string;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  started: boolean;
  cleanup?: ReturnType<typeof setTimeout>;
}
interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  finish: () => void;
}

const CACHE_BYTES = 24 * 1024 * 1024;
const MAX_EFFECTS = 12;
const MAX_DOWNLOADS = 4;

/** Presentation-only transport. No audio is constructed before a trusted gesture. */
export class Soundscape {
  private context: AudioContext | null = null;
  private buses: Record<"master" | "music" | "ambience" | "effects" | "voices", GainNode> | null = null;
  private active = false;
  private muted = false;
  private mix = defaultMix();
  private disposed = false;
  private generation = 0;
  private speechGeneration = 0;
  private readonly lifetime = new AbortController();
  private downloads = new AbortController();
  private voiceDownload = new AbortController();
  private soundtrack: Promise<SoundtrackManifest> | null = null;
  private catalogue: Promise<Map<string, VoiceEntry>> | null = null;
  private readonly cache = new Map<string, AudioBuffer>();
  private cacheBytes = 0;
  private decoding = 0;
  private readonly decodeWaiters = new Set<() => void>();
  private pendingEffects = 0;
  private pendingTerminal: string | null = null;
  private readonly effects = new Set<Playing>();
  private speech: Playing | null = null;
  private readonly lastCue = new Map<string, number>();
  private readonly variations = new Map<string, number>();
  private readonly recentEffects: { id: string; src: string; distance: number }[] = [];
  private lastDecoded: { src: string; duration: number; bytes: number } | null = null;
  private readonly failures = new Set<string>();
  private readonly streams: Record<Lane, Stream[]> = { music: [], ambience: [] };
  private readonly desired: Record<Lane, string | null> = { music: "title", ambience: null };
  private readonly laneGeneration: Record<Lane, number> = { music: 0, ambience: 0 };
  private readonly requested: Record<Lane, string | null | undefined> = { music: undefined, ambience: undefined };
  private speechKey = "";
  private lines: SpeechLine[] = [];
  private speechIndex = 0;
  private clipIndex = 0;
  private speaking = false;
  private subtitle: SpeechLine | null = null;

  constructor(
    private readonly onFailure: () => void,
    private readonly onSubtitle: (line: SpeechLine | null) => void = () => {},
  ) {}

  private fail(where: string, error: unknown): void {
    if (this.disposed || this.failures.has(where)) return;
    if (this.failures.size >= 64) this.failures.delete(this.failures.values().next().value!);
    this.failures.add(where);
    console.warn(`Korovany II audio: ${where}`, error);
    this.onFailure();
  }

  private get ready(): boolean {
    return !this.disposed && this.active && !this.muted && this.mix.master > 0 && this.context?.state === "running";
  }

  /** The caller must gate this on Event.isTrusted. Other methods never resume a context. */
  async unlock(): Promise<void> {
    if (this.disposed || this.muted || this.mix.master === 0) return;
    try {
      if (!this.context) {
        const context = new AudioContext();
        this.context = context;
        context.onstatechange = () => {
          if (!this.disposed && this.active && !this.muted && context.state !== "running") {
            this.fail("audio-device", new Error(`Audio context became ${context.state}. A new gesture may be required.`));
          }
        };
        this.buses = {
          master: context.createGain(), music: context.createGain(), ambience: context.createGain(),
          effects: context.createGain(), voices: context.createGain(),
        };
        this.buses.master.connect(context.destination);
        for (const channel of ["music", "ambience", "effects", "voices"] as const) this.buses[channel].connect(this.buses.master);
        this.applyMix();
      }
      const context = this.context;
      if (context.state === "suspended") await context.resume();
      if (this.disposed || this.context !== context) return;
      if (context.state !== "running") throw new Error(`Audio context did not start: ${context.state}`);
      this.start();
    } catch (error) {
      this.fail("unlock", error);
    }
  }

  configure(muted: boolean, mix: AudioMix = this.mix): void {
    this.muted = muted;
    this.mix = { ...mix };
    this.applyMix();
    if (muted || mix.master === 0) this.stop();
    else {
      if (mix.voices === 0) this.stopSpeech();
      if (mix.effects === 0) {
        for (const effect of [...this.effects]) effect.finish();
      }
      this.start();
    }
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) this.start();
    else this.stop();
  }

  setScene(music: string | null, ambience: string | null): void {
    for (const lane of ["music", "ambience"] as const) {
      const id = lane === "music" ? music : ambience;
      if (id !== this.desired[lane]) {
        this.desired[lane] = id;
        this.requested[lane] = undefined;
        this.laneGeneration[lane]++;
      }
    }
    this.start();
  }

  speak(key: string, lines: readonly SpeechLine[]): void {
    if (key === this.speechKey) return;
    this.stopSpeech();
    this.speechKey = key;
    this.lines = lines.flatMap((line) => paragraphs(line.text).map((text) => ({ ...line, text })));
    this.speechIndex = 0;
    this.clipIndex = 0;
    this.start();
  }

  cancelSpeech(): void {
    this.speak("", []);
  }

  private applyMix(): void {
    if (!this.buses || !this.context) return;
    for (const channel of ["master", "music", "ambience", "effects", "voices"] as const) {
      const gain = this.buses[channel].gain;
      const level = this.muted ? 0 : this.mix[channel] * (channel === "music" && this.speaking ? 0.3 : 1);
      gain.setTargetAtTime(level, this.context.currentTime, 0.08);
    }
  }

  private start(): void {
    if (!this.ready) return;
    if (this.pendingTerminal) {
      const cue = this.pendingTerminal;
      this.pendingTerminal = null;
      this.cue(cue);
    }
    for (const lane of ["music", "ambience"] as const) {
      if (this.mix[lane] === 0) {
        this.clearLane(lane);
        this.requested[lane] = undefined;
        this.laneGeneration[lane]++;
      } else if (this.requested[lane] !== this.desired[lane]) {
        this.requested[lane] = this.desired[lane];
        void this.changeLane(lane, this.desired[lane]);
      }
    }
    if (!this.speaking && this.speechIndex < this.lines.length && this.mix.voices > 0) void this.playSpeech();
  }

  private url(src: string): string {
    return new URL(`${import.meta.env.BASE_URL}${src}`, document.baseURI).href;
  }

  private async json(src: string): Promise<unknown> {
    const response = await fetch(this.url(src), { signal: this.lifetime.signal });
    if (!response.ok) throw new Error(`${src}: HTTP ${response.status}`);
    return response.json();
  }

  private score(): Promise<SoundtrackManifest> {
    this.soundtrack ??= this.json("audio/soundtrack/manifest.json").then(parseSoundtrack);
    return this.soundtrack;
  }

  private voices(): Promise<Map<string, VoiceEntry>> {
    this.catalogue ??= this.json("audio/voices/manifest.json").then(parseVoices);
    return this.catalogue;
  }

  private releaseStream(stream: Stream): void {
    clearTimeout(stream.cleanup);
    stream.element.onerror = null;
    stream.element.pause();
    stream.element.removeAttribute("src");
    stream.element.load();
    stream.source.disconnect();
    stream.gain.disconnect();
  }

  private clearLane(lane: Lane): void {
    for (const stream of this.streams[lane]) this.releaseStream(stream);
    this.streams[lane] = [];
  }

  private removeStream(lane: Lane, stream: Stream): void {
    if (!this.streams[lane].includes(stream)) return;
    this.releaseStream(stream);
    this.streams[lane] = this.streams[lane].filter((entry) => entry !== stream);
  }

  private fadeOut(lane: Lane, stream: Stream): void {
    if (!this.context) return;
    clearTimeout(stream.cleanup);
    stream.gain.gain.cancelScheduledValues(this.context.currentTime);
    stream.gain.gain.setValueAtTime(stream.gain.gain.value, this.context.currentTime);
    stream.gain.gain.linearRampToValueAtTime(0, this.context.currentTime + 1.5);
    stream.cleanup = setTimeout(() => {
      this.removeStream(lane, stream);
    }, 1600);
  }

  private async changeLane(lane: Lane, id: string | null): Promise<void> {
    const token = ++this.laneGeneration[lane];
    const current = () => this.ready && this.laneGeneration[lane] === token;
    for (const stream of [...this.streams[lane]]) if (!stream.started) this.removeStream(lane, stream);
    if (!id) {
      for (const stream of this.streams[lane]) this.fadeOut(lane, stream);
      return;
    }
    let stream: Stream | undefined;
    try {
      const manifest = await this.score();
      if (!current() || !this.context || !this.buses) return;
      const asset = manifest[lane].find((entry) => entry.id === id);
      if (!asset) throw new Error(`Missing ${lane} asset ${id}`);
      // Preserve the audible bed, not a superseded download or a nearly silent crossfade tail.
      const keep = [...this.streams[lane]].reverse().sort((a, b) => b.gain.gain.value - a.gain.gain.value)[0];
      for (const old of [...this.streams[lane]]) if (old !== keep) this.removeStream(lane, old);
      if (keep) {
        clearTimeout(keep.cleanup);
        keep.cleanup = undefined;
        const at = this.context.currentTime;
        const volume = keep.gain.gain.value;
        keep.gain.gain.cancelScheduledValues(at);
        keep.gain.gain.setValueAtTime(volume, at);
        keep.gain.gain.setTargetAtTime(1, at, 0.08);
      }
      const element = new Audio(this.url(asset.src));
      element.preload = "auto";
      element.loop = asset.loop;
      const source = this.context.createMediaElementSource(element);
      const gain = this.context.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(this.buses[lane]);
      stream = { id, element, source, gain, started: false };
      this.streams[lane].push(stream);
      element.onerror = () => {
        if (!current()) return;
        this.fail(asset.src, new Error(`Media error ${element.error?.code ?? "unknown"}`));
        if (stream) this.removeStream(lane, stream);
      };
      await element.play();
      if (!current()) {
        this.removeStream(lane, stream);
        return;
      }
      stream.started = true;
      gain.gain.linearRampToValueAtTime(1, this.context.currentTime + 1.5);
      for (const old of this.streams[lane]) if (old !== stream) this.fadeOut(lane, old);
    } catch (error) {
      if (stream) this.removeStream(lane, stream);
      if (current()) this.fail(`${lane}:${id}`, error);
    }
  }

  private async buffer(src: string, signal: AbortSignal): Promise<AudioBuffer> {
    const cached = this.cache.get(src);
    if (cached) {
      this.cache.delete(src);
      this.cache.set(src, cached);
      return cached;
    }
    const context = this.context;
    if (!context) throw new Error("Audio context is locked.");
    const response = await fetch(this.url(src), { signal });
    if (!response.ok) throw new Error(`${src}: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    signal.throwIfAborted();
    // Native decode cannot be aborted. Bound concurrent decodes even across rapid scene changes.
    while (this.decoding >= 2) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          this.decodeWaiters.delete(ready);
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.decodeWaiters.delete(ready);
          reject(signal.reason);
        };
        this.decodeWaiters.add(ready);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
    }
    this.decoding++;
    let decoded: AudioBuffer;
    try {
      decoded = await context.decodeAudioData(bytes);
    } finally {
      this.decoding--;
      for (const ready of [...this.decodeWaiters]) ready();
    }
    signal.throwIfAborted();
    if (this.disposed || context !== this.context) throw new DOMException("Disposed", "AbortError");
    const size = decoded.length * decoded.numberOfChannels * 4;
    this.lastDecoded = { src, duration: decoded.duration, bytes: size };
    if (size <= CACHE_BYTES && !this.cache.has(src)) {
      while (this.cacheBytes + size > CACHE_BYTES && this.cache.size) {
        const oldest = this.cache.entries().next().value!;
        this.cache.delete(oldest[0]);
        this.cacheBytes -= oldest[1].length * oldest[1].numberOfChannels * 4;
      }
      this.cache.set(src, decoded);
      this.cacheBytes += size;
    }
    return decoded;
  }

  private play(buffer: AudioBuffer, channel: "effects" | "voices", volume: number, pan: number, ended: () => void): Playing {
    const context = this.context!;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = volume;
    const panner = context.createStereoPanner();
    panner.pan.value = pan;
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.buses![channel]);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      source.onended = null;
      source.stop();
      source.disconnect();
      gain.disconnect();
      panner.disconnect();
      ended();
    };
    source.onended = finish;
    source.start();
    return { source, gain, pan: panner, finish };
  }

  cue(id: string, distance = 0, pan = 0): void {
    const terminal = id === "victory" || id === "defeat";
    if (!this.ready) {
      if (terminal && !this.disposed && this.active && !this.muted && this.mix.master > 0 && this.mix.effects > 0) this.pendingTerminal = id;
      return;
    }
    if (this.mix.effects === 0 || distance >= 55) return;
    const now = this.context!.currentTime;
    const interval = id.startsWith("step-") ? 0.28 : id === "convoy" ? 1.2 : id === "click" ? 0.1 : 0.12;
    if (now - (this.lastCue.get(id) ?? -Infinity) < interval) return;
    if (terminal) this.stopEffects();
    else if (this.effects.size + this.pendingEffects >= MAX_EFFECTS || this.pendingEffects >= MAX_DOWNLOADS) return;
    this.lastCue.set(id, now);
    const token = this.generation;
    const signal = this.downloads.signal;
    const valid = () => this.ready && token === this.generation && !signal.aborted && this.mix.effects > 0;
    this.pendingEffects++;
    void (async () => {
      try {
        const manifest = await this.score();
        if (!valid()) return;
        const base = manifest.sfx.find((entry) => entry.id === id);
        if (!base) throw new Error(`Missing effect ${id}`);
        const variants = manifest.sfx.filter((entry) => entry.id === id ||
          (entry.id.startsWith(`${id}-`) && /^\d+$/.test(entry.id.slice(id.length + 1))));
        const index = this.variations.get(id) ?? 0;
        const asset: AudioAsset = variants[index % variants.length] ?? base;
        this.variations.set(id, index + 1);
        const buffer = await this.buffer(asset.src, signal);
        if (!valid()) return;
        const playing = this.play(buffer, "effects", Math.max(0, 1 - distance / 55) ** 2,
          Math.max(-1, Math.min(1, pan)), () => this.effects.delete(playing));
        this.effects.add(playing);
        this.recentEffects.push({ id: asset.id, src: asset.src, distance });
        if (this.recentEffects.length > 16) this.recentEffects.shift();
      } catch (error) {
        if (valid()) this.fail(`effect:${id}`, error);
      } finally {
        this.pendingEffects--;
      }
    })();
  }

  private caption(line: SpeechLine | null): void {
    this.subtitle = line;
    this.onSubtitle(line);
  }

  private async playSpeech(): Promise<void> {
    const token = ++this.speechGeneration;
    const signal = this.voiceDownload.signal;
    const valid = () => this.ready && token === this.speechGeneration && !signal.aborted && this.mix.voices > 0;
    this.speaking = true;
    this.applyMix();
    try {
      const catalogue = await this.voices();
      while (valid() && this.speechIndex < this.lines.length) {
        const line = this.lines[this.speechIndex]!;
        const entry = catalogue.get(voiceKey(line.speaker, line.language, line.text));
        try {
          if (!entry) throw new Error(`Missing voice ${voiceKey(line.speaker, line.language, line.text)}`);
          this.caption(line);
          while (valid() && this.clipIndex < entry.clips.length) {
            const clip = entry.clips[this.clipIndex]!;
            const buffer = await this.buffer(clip.src, signal);
            if (!valid()) return;
            await new Promise<void>((resolve) => {
              this.speech = this.play(buffer, "voices", 1, 0, resolve);
            });
            if (!valid()) return;
            this.speech = null;
            this.clipIndex++;
          }
        } catch (error) {
          if (valid()) this.fail(`speech:${this.speechKey}:${this.speechIndex}`, error);
        }
        if (!valid()) return;
        this.clipIndex = 0;
        this.speechIndex++;
      }
    } catch (error) {
      if (valid()) {
        this.fail(`speech:${this.speechKey}:${this.speechIndex}`, error);
        this.speechIndex = this.lines.length;
      }
    } finally {
      if (token === this.speechGeneration) {
        this.speaking = false;
        this.caption(null);
        this.applyMix();
      }
    }
  }

  private stopSpeech(): void {
    this.speechGeneration++;
    this.voiceDownload.abort();
    this.voiceDownload = new AbortController();
    this.speech?.finish();
    this.speech = null;
    this.speaking = false;
    this.caption(null);
    this.applyMix();
  }

  private stop(): void {
    this.pendingTerminal = null;
    this.stopEffects();
    this.stopSpeech();
    for (const lane of ["music", "ambience"] as const) {
      this.laneGeneration[lane]++;
      this.clearLane(lane);
      this.requested[lane] = undefined;
    }
  }

  private stopEffects(): void {
    this.generation++;
    this.downloads.abort();
    this.downloads = new AbortController();
    for (const effect of [...this.effects]) effect.finish();
  }

  inspect() {
    return {
      state: this.context?.state ?? "locked", active: this.active, muted: this.muted,
      voices: this.effects.size + Number(this.speech !== null),
      effects: this.effects.size, pendingEffects: this.pendingEffects,
      music: this.desired.music, ambience: this.desired.ambience,
      streams: [...this.streams.music, ...this.streams.ambience].map(({ id, element }) =>
        ({ id, paused: element.paused, time: element.currentTime, readyState: element.readyState })),
      speaking: this.speaking, subtitle: this.subtitle ? { ...this.subtitle } : null,
      speechIndex: this.speechIndex, clipIndex: this.clipIndex, speechLength: this.lines.length,
      cacheBytes: this.cacheBytes, cacheEntries: this.cache.size, failures: [...this.failures],
      decoding: this.decoding, waitingDecodes: this.decodeWaiters.size,
      lastDecoded: this.lastDecoded ? { ...this.lastDecoded } : null,
      recentEffects: this.recentEffects.map((entry) => ({ ...entry })),
      mix: { ...this.mix },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.stop();
    this.lifetime.abort();
    this.cache.clear();
    this.cacheBytes = 0;
    this.lines = [];
    this.catalogue = null;
    this.soundtrack = null;
    if (this.buses) for (const gain of Object.values(this.buses)) gain.disconnect();
    const context = this.context;
    if (context) context.onstatechange = null;
    this.context = null;
    this.buses = null;
    if (context) void context.close().catch((error: unknown) => console.warn("Korovany II audio close failed.", error));
  }
}
