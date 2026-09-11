type Cue = "attack" | "hit" | "capture" | "delivery" | "victory" | "defeat" | "ability" | "click";

export class Soundscape {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly voices = new Set<OscillatorNode>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private muted = false;
  private combat = false;
  private beat = 0;
  private disposed = false;

  constructor(private readonly onFailure: () => void) {}

  /** Call only from a trusted click/keypress; autoplay is never requested. */
  async unlock(): Promise<void> {
    if (this.disposed || this.muted) return;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = 0.16;
        this.master.connect(this.context.destination);
      }
      if (this.context.state === "suspended") await this.context.resume();
      if (this.active) this.begin();
    } catch {
      this.onFailure();
    }
  }

  configure(muted: boolean): void {
    this.muted = muted;
    if (muted) this.silence();
    else if (this.active) this.begin();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.begin();
    else this.silence();
  }

  setCombat(combat: boolean): void {
    this.combat = combat;
  }

  inspect(): { state: AudioContextState | "locked"; active: boolean; muted: boolean; voices: number } {
    return { state: this.context?.state ?? "locked", active: this.active, muted: this.muted, voices: this.voices.size };
  }

  cue(cue: Cue): void {
    if (!this.active || this.muted) return;
    const notes: Record<Cue, readonly number[]> = {
      attack: [146.83],
      hit: [73.42, 69.3],
      capture: [293.66, 369.99, 440],
      delivery: [220, 293.66, 440, 587.33],
      victory: [293.66, 369.99, 440, 587.33, 739.99],
      defeat: [220, 196, 146.83],
      ability: [146.83, 293.66, 587.33],
      click: [440],
    };
    notes[cue].forEach((frequency, index) =>
      this.note(frequency, index * 0.085, cue === "hit" || cue === "attack" ? 0.075 : 0.55, 0.3));
  }

  private begin(): void {
    if (this.timer !== null || !this.context || this.context.state !== "running" || this.muted || !this.active) return;
    this.timer = setInterval(() => {
      if (!this.active || this.muted) return;
      const sequence = [146.83, 220, 293.66, 220, 164.81, 246.94, 329.63, 220];
      const frequency = sequence[Math.floor(this.beat / 2) % sequence.length] ?? 146.83;
      if (this.beat % 2 === 0) this.note(frequency, 0, 1.2, 0.09);
      if (this.combat) this.note(this.beat % 2 ? 73.42 : 55, 0, 0.08, 0.22, "triangle");
      if (this.beat % 8 === 5) this.note(frequency * 4, 0, 0.8, 0.045);
      this.beat += 1;
    }, 360);
  }

  private note(
    frequency: number,
    delay: number,
    duration: number,
    volume: number,
    type: OscillatorType = "sine",
  ): void {
    if (!this.context || !this.master || this.voices.size >= 20 || this.context.state !== "running") return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const at = this.context.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.99, at + duration);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.007);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(gain);
    gain.connect(this.master);
    this.voices.add(oscillator);
    oscillator.onended = () => {
      this.voices.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(at);
    oscillator.stop(at + duration + 0.015);
  }

  private silence(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const voice of this.voices) voice.stop();
    this.voices.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.silence();
    if (this.context) void this.context.close().catch(this.onFailure);
    this.context = null;
    this.master = null;
  }
}
