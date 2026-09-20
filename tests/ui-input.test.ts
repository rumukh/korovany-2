import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameInput } from "../src/ui/input";
import type { ControllerGameplay } from "../src/ui/gamepad";

class Surface extends EventTarget {
  focus = vi.fn();
  closest = vi.fn<() => Surface | null>(() => null);
  requestPointerLock = vi.fn<() => Promise<void> | void>();
}

function event(type: string, values: Record<string, unknown> = {}): Event {
  const result = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(values)) Object.defineProperty(result, key, { value });
  return result;
}

describe("browser input tick boundary", () => {
  let windowTarget: EventTarget;
  let documentTarget: EventTarget & { hidden: boolean; pointerLockElement: Surface | null; exitPointerLock: () => void };
  let surface: Surface;
  let input: GameInput;
  const overlay = vi.fn();
  const focusLost = vi.fn();
  const look = vi.fn();
  const lookError = vi.fn();

  function grantLock(): void {
    documentTarget.pointerLockElement = surface;
    documentTarget.dispatchEvent(event("pointerlockchange"));
  }

  function captureMouse(): void {
    surface.dispatchEvent(event("pointerdown", { button: 0 }));
    windowTarget.dispatchEvent(event("pointerup", { button: 0 }));
  }

  beforeEach(() => {
    windowTarget = new EventTarget();
    documentTarget = Object.assign(new EventTarget(), {
      hidden: false,
      pointerLockElement: null as Surface | null,
      exitPointerLock: vi.fn(() => {
        documentTarget.pointerLockElement = null;
        documentTarget.dispatchEvent(event("pointerlockchange"));
      }),
    });
    surface = new Surface();
    surface.requestPointerLock.mockImplementation(grantLock);
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("Element", Surface);
    vi.stubGlobal("HTMLElement", Surface);
    input = new GameInput(surface as unknown as HTMLElement, overlay, focusLost, look, lookError);
    input.setEnabled(true);
  });
  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("retains quick key and click edges until a tick and consumes pulses only once", () => {
    captureMouse();
    windowTarget.dispatchEvent(event("keydown", { code: "KeyQ", repeat: false }));
    windowTarget.dispatchEvent(event("keyup", { code: "KeyQ" }));
    surface.dispatchEvent(event("pointerdown", { button: 0, clientX: 100, clientY: 120 }));
    windowTarget.dispatchEvent(event("pointerup", { button: 0 }));
    const first = input.consume();
    expect(first.dodge).toBe(true);
    expect(first.attack).toBe(true);
    expect(first.mouseLook).toBe(true);
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

  it("keeps mouse look while strafing and clears all held controls and capture on blur or overlays", () => {
    captureMouse();
    documentTarget.dispatchEvent(event("mousemove", { movementX: 10, movementY: -5 }));
    expect(look).toHaveBeenCalledExactlyOnceWith(10, -5);
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: false }));
    windowTarget.dispatchEvent(event("keydown", { code: "KeyD", repeat: false }));
    expect(input.consume()).toMatchObject({ mouseLook: true, keyboardAim: null });
    windowTarget.dispatchEvent(event("blur"));
    expect(focusLost).toHaveBeenCalledOnce();
    expect(documentTarget.pointerLockElement).toBeNull();
    expect(input.consume()).toMatchObject({ move: { x: 0, z: 0 }, mouseLook: false, attack: false });
    input.setEnabled(false);
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: false }));
    expect(input.consume().move).toEqual({ x: 0, z: 0 });
  });

  it("uses the first click only to capture and requires another press to attack", () => {
    captureMouse();
    expect(input.consume()).toMatchObject({ mouseLook: true, attack: false });
    documentTarget.dispatchEvent(event("mousemove", { movementX: 0, movementY: 0 }));
    expect(look).not.toHaveBeenCalled();
    surface.dispatchEvent(event("pointerdown", { button: 0 }));
    expect(input.consume().attack).toBe(true);
    input.setEnabled(false);
    expect(input.mouseLocked).toBe(false);
    expect(input.consume()).toMatchObject({ mouseLook: false, attack: false });
    expect(focusLost).not.toHaveBeenCalled();
    input.setEnabled(true);
    documentTarget.dispatchEvent(event("mousemove", { movementX: 10, movementY: 5 }));
    expect(look).not.toHaveBeenCalled();
    expect(surface.requestPointerLock).toHaveBeenCalledOnce();
  });

  it("pauses on an unexpected browser unlock and does not recapture automatically", () => {
    captureMouse();
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: false }));
    surface.dispatchEvent(event("pointerdown", { button: 0 }));
    documentTarget.exitPointerLock();
    expect(focusLost).toHaveBeenCalledOnce();
    expect(input.consume()).toMatchObject({ move: { x: 0, z: 0 }, mouseLook: false, attack: false });
    expect(surface.requestPointerLock).toHaveBeenCalledOnce();
  });

  it("handles a browser-consumed Escape key-down during capture without undoing a keyboard resume", () => {
    surface.requestPointerLock.mockImplementation(() => {});
    captureMouse();
    documentTarget.pointerLockElement = surface;
    windowTarget.dispatchEvent(event("keyup", { code: "Escape" }));
    expect(overlay).toHaveBeenCalledExactlyOnceWith("pause");
    expect(input.mouseLocked).toBe(false);
    grantLock();
    expect(input.mouseLocked).toBe(false);

    input.setEnabled(false);
    const resume = event("keydown", { code: "Escape", repeat: false });
    resume.preventDefault();
    windowTarget.dispatchEvent(resume);
    input.setEnabled(true);
    windowTarget.dispatchEvent(event("keyup", { code: "Escape" }));
    expect(overlay).toHaveBeenCalledOnce();
  });

  it("hands control to a gamepad without pausing or retaining mouse attack", () => {
    captureMouse();
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: false }));
    surface.dispatchEvent(event("pointerdown", { button: 0 }));
    input.useGamepad();
    expect(input.consume()).toMatchObject({ move: { x: 0, z: 1 }, mouseLook: false, attack: false });
    expect(focusLost).not.toHaveBeenCalled();
    documentTarget.dispatchEvent(event("mousemove", { movementX: 40, movementY: 20 }));
    expect(look).not.toHaveBeenCalled();
  });

  it.each(["menu", "controller", "dispose"])("releases a late pointer-lock grant after %s without pausing or attacking", (context) => {
    surface.requestPointerLock.mockImplementation(() => {});
    captureMouse();
    if (context === "menu") { input.setEnabled(false); input.setEnabled(true); }
    else if (context === "controller") input.useGamepad();
    else input.dispose();
    grantLock();
    expect(documentTarget.pointerLockElement).toBeNull();
    expect(input.consume()).toMatchObject({ mouseLook: false, attack: false });
    expect(focusLost).not.toHaveBeenCalled();
    expect(lookError).not.toHaveBeenCalled();
  });

  it("reports rejected capture once and allows a later retry", async () => {
    let reject!: (error: Error) => void;
    surface.requestPointerLock.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    captureMouse();
    captureMouse();
    expect(surface.requestPointerLock).toHaveBeenCalledOnce();
    documentTarget.dispatchEvent(event("pointerlockerror"));
    reject(new Error("denied"));
    await Promise.resolve();
    expect(lookError).toHaveBeenCalledOnce();
    expect(input.consume()).toMatchObject({ mouseLook: false, attack: false });
    captureMouse();
    expect(input.mouseLocked).toBe(true);
  });

  it("reports unavailable capture explicitly and leaves keyboard controls available", () => {
    Object.defineProperty(surface, "requestPointerLock", { value: undefined });
    captureMouse();
    expect(lookError).toHaveBeenCalledOnce();
    windowTarget.dispatchEvent(event("keydown", { code: "ArrowRight", repeat: false }));
    windowTarget.dispatchEvent(event("keydown", { code: "Space", repeat: false }));
    expect(input.consume()).toMatchObject({ keyboardAim: { x: 1, z: 0 }, attack: true, mouseLook: false });
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

  it("merges controller and keyboard levels without losing another source's held attack", () => {
    const controller: ControllerGameplay = {
      active: true, move: { x: 0.5, z: 0 }, aim: { x: 1, z: 0 },
      attack: true, interact: false, sprint: false, dodge: false, ability: false, convoy: false, talk: false,
    };
    windowTarget.dispatchEvent(event("keydown", { code: "Space", repeat: false }));
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: false }));
    expect(input.consume(controller).attack).toBe(true);
    windowTarget.dispatchEvent(event("keyup", { code: "Space" }));
    const moving = input.consume(controller);
    expect(moving.attack).toBe(true);
    expect(Math.hypot(moving.move.x, moving.move.z)).toBeCloseTo(1);
    expect(moving.keyboardAim).toEqual({ x: 1, z: 0 });
    controller.attack = false;
    expect(input.consume(controller).attack).toBe(false);
    input.setEnabled(false);
    expect(input.consume(controller)).toMatchObject({ move: { x: 0, z: 0 }, keyboardAim: null });
  });

  it("requires held keys to release across overlay transitions rather than accepting repeats", () => {
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: false }));
    input.setEnabled(false);
    input.setEnabled(true);
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: true }));
    expect(input.consume().move.z).toBe(0);
    windowTarget.dispatchEvent(event("keyup", { code: "KeyW" }));
    windowTarget.dispatchEvent(event("keydown", { code: "KeyW", repeat: false }));
    expect(input.consume().move.z).toBe(1);
  });

  it("does not accept a gameplay key first held in a menu until it is released", () => {
    input.setEnabled(false);
    windowTarget.dispatchEvent(event("keydown", { code: "Space", repeat: false }));
    input.setEnabled(true);
    windowTarget.dispatchEvent(event("keydown", { code: "Space", repeat: true }));
    expect(input.consume().attack).toBe(false);
    windowTarget.dispatchEvent(event("keyup", { code: "Space" }));
    windowTarget.dispatchEvent(event("keydown", { code: "Space", repeat: false }));
    expect(input.consume().attack).toBe(true);
  });
});
