import { afterEach, describe, expect, it, vi } from "vitest";
import { Soundscape } from "../src/audio/soundscape";

class Gain {
  gain = {
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
}

class Oscillator {
  type = "sine";
  frequency = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  onended: (() => void) | null = null;
}

class Context {
  static instances: Context[] = [];
  state = "suspended";
  currentTime = 0;
  destination = {};
  oscillators: Oscillator[] = [];
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  createGain = () => new Gain();
  createOscillator = () => {
    const oscillator = new Oscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  };
  constructor() { Context.instances.push(this); }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Context.instances = [];
});

describe("gesture-unlocked bounded soundscape", () => {
  it("never creates audio before an unlock gesture and stops every voice on pause", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", Context);
    const audio = new Soundscape(vi.fn());
    audio.setActive(true);
    vi.advanceTimersByTime(5_000);
    expect(Context.instances).toHaveLength(0);
    await audio.unlock();
    const context = Context.instances[0];
    expect(context?.resume).toHaveBeenCalledOnce();
    audio.cue("delivery");
    vi.advanceTimersByTime(60_000);
    expect(context?.oscillators.length).toBeLessThanOrEqual(20);
    const count = context?.oscillators.length;
    audio.setActive(false);
    for (const oscillator of context?.oscillators ?? []) expect(oscillator.stop).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(context?.oscillators).toHaveLength(count ?? 0);
    audio.dispose();
    expect(context?.close).toHaveBeenCalledOnce();
  });

  it("respects mute before unlock and reports an unavailable AudioContext", async () => {
    vi.stubGlobal("AudioContext", Context);
    const failure = vi.fn();
    const audio = new Soundscape(failure);
    audio.configure(true);
    await audio.unlock();
    expect(Context.instances).toHaveLength(0);
    audio.configure(false);
    vi.stubGlobal("AudioContext", class { constructor() { throw new Error("audio unavailable"); } });
    await audio.unlock();
    expect(failure).toHaveBeenCalledOnce();
    audio.dispose();
  });
});
