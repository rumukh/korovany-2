import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameInput } from "../src/ui/input";

class Surface extends EventTarget {
  focus = vi.fn();
  closest = vi.fn<() => Surface | null>(() => null);
}

function event(type: string, values: Record<string, unknown> = {}): Event {
  const result = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(values)) Object.defineProperty(result, key, { value });
  return result;
}

describe("browser input tick boundary", () => {
  let windowTarget: EventTarget;
  let documentTarget: EventTarget & { hidden: boolean };
  let surface: Surface;
  let input: GameInput;
  const overlay = vi.fn();
  const focusLost = vi.fn();

  beforeEach(() => {
    windowTarget = new EventTarget();
    documentTarget = Object.assign(new EventTarget(), { hidden: false });
    surface = new Surface();
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("Element", Surface);
    vi.stubGlobal("HTMLElement", Surface);
    input = new GameInput(surface as unknown as HTMLElement, overlay, focusLost);
    input.setEnabled(true);
  });
  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("retains quick key and click edges until a tick and consumes pulses only once", () => {
    windowTarget.dispatchEvent(event("keydown", { code: "KeyQ", repeat: false }));
    windowTarget.dispatchEvent(event("keyup", { code: "KeyQ" }));
    surface.dispatchEvent(event("pointerdown", { button: 0, clientX: 100, clientY: 120 }));
    windowTarget.dispatchEvent(event("pointerup", { button: 0 }));
    const first = input.consume();
    expect(first.dodge).toBe(true);
    expect(first.attack).toBe(true);
    expect(first.pointer).toEqual({ x: 100, y: 120 });
    expect(input.consume()).toMatchObject({ dodge: false, attack: false });
  });

  it("holds attack, sprint and interaction over catch-up ticks without repeating ability pulses", () => {
    for (const code of ["Space", "ShiftLeft", "KeyE", "KeyF", "KeyC"]) {
      windowTarget.dispatchEvent(event("keydown", { code, repeat: false }));
    }
    expect(input.consume()).toMatchObject({ attack: true, sprint: true, interact: true, ability: true, convoy: true });
    windowTarget.dispatchEvent(event("keydown", { code: "KeyF", repeat: true }));
    expect(input.consume()).toMatchObject({ attack: true, sprint: true, interact: true, ability: false, convoy: false });
    windowTarget.dispatchEvent(event("keyup", { code: "KeyE" }));
    expect(input.consume().interact).toBe(false);
  });

  it("normalizes diagonal movement and allows keyboard aim independent of movement", () => {
    for (const code of ["KeyW", "KeyD", "ArrowLeft"]) windowTarget.dispatchEvent(event("keydown", { code, repeat: false }));
    const sample = input.consume();
    expect(Math.hypot(sample.move.x, sample.move.z)).toBeCloseTo(1);
    expect(sample.keyboardAim).toEqual({ x: -1, z: 0 });
  });

  it("consumes conversation once and opens the journal without leaking held controls", () => {
    windowTarget.dispatchEvent(event("keydown", { code: "KeyT", repeat: false }));
    expect(input.consume().talk).toBe(true);
    windowTarget.dispatchEvent(event("keydown", { code: "KeyT", repeat: true }));
    expect(input.consume().talk).toBe(false);
    windowTarget.dispatchEvent(event("keyup", { code: "KeyT" }));
    windowTarget.dispatchEvent(event("keydown", { code: "KeyJ", repeat: false }));
    expect(overlay).toHaveBeenCalledWith("journal");
    input.setEnabled(false);
    windowTarget.dispatchEvent(event("keydown", { code: "KeyT", repeat: false }));
    expect(input.consume().talk).toBe(false);
  });

  it("keeps mouse aiming while moving and clears all held controls on blur or overlays", () => {
    surface.dispatchEvent(event("pointermove", { clientX: 80, clientY: 90, movementX: 1, movementY: 1 }));
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: false }));
    expect(input.consume()).toMatchObject({ pointer: { x: 80, y: 90 }, keyboardAim: null });
    windowTarget.dispatchEvent(event("blur"));
    expect(focusLost).toHaveBeenCalledOnce();
    expect(input.consume()).toMatchObject({ move: { x: 0, z: 0 }, pointer: null, attack: false });
    input.setEnabled(false);
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: false }));
    expect(input.consume().move).toEqual({ x: 0, z: 0 });
  });

  it("does not reopen an overlay after another listener consumed its closing key", () => {
    const close = event("keydown", { code: "Tab", repeat: false });
    close.preventDefault();
    windowTarget.dispatchEvent(close);
    expect(overlay).not.toHaveBeenCalled();
    windowTarget.dispatchEvent(event("keydown", { code: "Tab", repeat: false }));
    expect(overlay).toHaveBeenCalledWith("map");
  });

  it("ignores editable controls and releases keys on document hiding", () => {
    const field = new Surface();
    field.closest.mockReturnValue(field);
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: false, target: field }));
    expect(input.consume().move.z).toBe(0);
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: false }));
    documentTarget.hidden = true;
    documentTarget.dispatchEvent(event("visibilitychange"));
    expect(focusLost).toHaveBeenCalledOnce();
    expect(input.consume().move.z).toBe(0);
  });
});
