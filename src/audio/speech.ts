import { paragraphs, parseVoices, voiceKey, type VoiceEntry } from "./manifest";

export interface SpeechLine {
  speaker: string;
  language: "ru" | "en";
  text: string;
  label: string;
}

const CACHE_BYTES = 24 * 1024 * 1024;

/** Recorded voice transport; the existing soundscape owns the gesture-unlocked context. */
export class VoicePlayback {
  private active = false;
  private muted = false;
  private disposed = false;
  private generation = 0;
  private readonly lifetime = new AbortController();
  private downloads = new AbortController();
  private catalogue: Promise<Map<string, VoiceEntry>> | null = null;
  private readonly cache = new Map<string, AudioBuffer>();
  private cacheBytes = 0;
  private decoding = 0;
  private readonly decodeWaiters = new Set<() => void>();
  private readonly failures = new Set<string>();
  private speechKey = "";
  private lines: SpeechLine[] = [];
  private lineIndex = 0;
  private clipIndex = 0;
  private speaking = false;
  private subtitle: SpeechLine | null = null;
  private finishClip: (() => void) | null = null;
  private lastDecoded: { src: string; duration: number; sampleRate: number } | null = null;

  constructor(
    private readonly context: () => AudioContext | null,
    private readonly onFailure: () => void,
    private readonly onSubtitle: (line: SpeechLine | null) => void = () => {},
  ) {}

  private get ready(): boolean {
    return !this.disposed && this.active && !this.muted && this.context()?.state === "running";
  }

  configure(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop();
    else this.start();
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) this.start();
    else this.stop();
  }

  speak(key: string, lines: readonly SpeechLine[]): void {
    if (key === this.speechKey) return;
    this.stop();
    this.speechKey = key;
    this.lines = lines.flatMap(line => paragraphs(line.text).map(text => ({ ...line, text })));
    this.lineIndex = 0;
    this.clipIndex = 0;
    this.start();
  }

  cancel(): void { this.speak("", []); }

  start(): void {
    if (this.ready && !this.speaking && this.lineIndex < this.lines.length) void this.playSpeech();
  }

  private fail(where: string, error: unknown): void {
    if (this.disposed || this.failures.has(where)) return;
    if (this.failures.size >= 64) this.failures.delete(this.failures.values().next().value!);
    this.failures.add(where);
    console.warn(`Korovany II voice: ${where}`, error);
    this.onFailure();
  }

  private url(src: string): string {
    return new URL(`${import.meta.env.BASE_URL}${src}`, document.baseURI).href;
  }

  private voices(): Promise<Map<string, VoiceEntry>> {
    this.catalogue ??= (async () => {
      const response = await fetch(this.url("audio/voices/manifest.json"), { signal: this.lifetime.signal });
      if (!response.ok) throw new Error(`Voice manifest: HTTP ${response.status}`);
      return parseVoices(await response.json());
    })();
    return this.catalogue;
  }

  private async buffer(src: string, signal: AbortSignal): Promise<AudioBuffer> {
    const cached = this.cache.get(src);
    if (cached) {
      this.cache.delete(src);
      this.cache.set(src, cached);
      return cached;
    }
    const context = this.context();
    if (!context) throw new Error("Audio context is locked.");
    const response = await fetch(this.url(src), { signal });
    if (!response.ok) throw new Error(`${src}: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    signal.throwIfAborted();
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
    if (this.disposed || context !== this.context()) throw new DOMException("Disposed", "AbortError");
    if (decoded.numberOfChannels !== 1 || decoded.duration <= 0) throw new Error(`Invalid mono voice: ${src}`);
    this.lastDecoded = { src, duration: decoded.duration, sampleRate: decoded.sampleRate };
    const size = decoded.length * decoded.numberOfChannels * 4;
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

  private caption(line: SpeechLine | null): void {
    this.subtitle = line;
    this.onSubtitle(line);
  }

  private async playSpeech(): Promise<void> {
    const token = ++this.generation;
    const signal = this.downloads.signal;
    const valid = () => this.ready && token === this.generation && !signal.aborted;
    this.speaking = true;
    try {
      const catalogue = await this.voices();
      while (valid() && this.lineIndex < this.lines.length) {
        const line = this.lines[this.lineIndex]!;
        const entry = catalogue.get(voiceKey(line.speaker, line.language, line.text));
        if (!entry) throw new Error(`Missing voice ${voiceKey(line.speaker, line.language, line.text)}`);
        this.caption(line);
        while (valid() && this.clipIndex < entry.clips.length) {
          const clip = entry.clips[this.clipIndex]!;
          const buffer = await this.buffer(clip.src, signal);
          if (!valid()) return;
          await new Promise<void>(resolve => {
            const context = this.context()!;
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(context.destination);
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              source.onended = null;
              source.stop();
              source.disconnect();
              resolve();
            };
            this.finishClip = finish;
            source.onended = finish;
            source.start();
          });
          if (!valid()) return;
          this.finishClip = null;
          this.clipIndex++;
        }
        if (!valid()) return;
        this.clipIndex = 0;
        this.lineIndex++;
      }
    } catch (error) {
      if (valid()) {
        this.fail(`speech:${this.speechKey}:${this.lineIndex}`, error);
        this.lineIndex = this.lines.length;
      }
    } finally {
      if (token === this.generation) {
        this.speaking = false;
        this.caption(null);
      }
    }
  }

  private stop(): void {
    this.generation++;
    this.downloads.abort();
    this.downloads = new AbortController();
    this.finishClip?.();
    this.finishClip = null;
    this.speaking = false;
    this.caption(null);
  }

  inspect() {
    return {
      active: this.active, speaking: this.speaking, playing: this.finishClip !== null,
      subtitle: this.subtitle ? { ...this.subtitle } : null,
      lineIndex: this.lineIndex, clipIndex: this.clipIndex, length: this.lines.length,
      cacheBytes: this.cacheBytes, cacheEntries: this.cache.size, failures: [...this.failures],
      decoding: this.decoding, waitingDecodes: this.decodeWaiters.size, lastDecoded: this.lastDecoded,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.stop();
    this.lifetime.abort();
    this.cache.clear();
    this.cacheBytes = 0;
    this.lines = [];
    this.catalogue = null;
  }
}
