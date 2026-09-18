import { afterEach, describe, expect, it } from "vitest";
import { createGamepadInput } from "@aegis/render-three/input";
import { ControllerInput, controllerBindings } from "../src/ui/gamepad";

function device() {
  return {
    id: "Virtual Xbox", index: 0, mapping: "standard", connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
}

const owned: ControllerInput[] = [];
function setup() {
  const pad = device();
  let connected = true;
  const input = new ControllerInput(createGamepadInput({
    bindings: controllerBindings, manageFocus: false,
    getGamepads: () => connected ? [pad] : [],
  }));
  owned.push(input);
  input.poll(false, 0);
  const button = (index: number, value: number) => { pad.buttons[index] = { pressed: value >= 0.5, value }; };
  return { pad, input, button, connect: (value: boolean) => { connected = value; } };
}

afterEach(() => { for (const input of owned.splice(0)) input.dispose(); });

describe("Korovany shared-engine controller input", () => {
  it("preserves analog speed and camera-relative forward with radial dead zones", () => {
    const { pad, input } = setup();
    pad.axes = [0.1, -0.1, 0, 0];
    input.poll(true, 1 / 60);
    expect(input.consume(1).move).toEqual({ x: 0, z: -0 });
    pad.axes = [0, -0.6, 0, 0];
    input.poll(true, 1 / 60);
    const frame = input.consume(2);
    expect(frame.move.x).toBe(0);
    expect(frame.move.z).toBeCloseTo(0.5);
    expect(frame.aim).toEqual({ x: 0, z: 1 });
    pad.axes = [1, -1, 0, 0];
    input.poll(true, 1 / 60);
    const diagonal = input.consume(3).move;
    expect(Math.hypot(diagonal.x, diagonal.z)).toBeCloseTo(1);
  });

  it("integrates camera once per display time, not per simulation tick", () => {
    for (const hz of [30, 60, 120]) {
      const { pad, input } = setup();
      pad.axes = [0, 0, 1, 0];
      let yaw = 0;
      for (let frame = 0; frame < hz; frame++) {
        yaw += input.poll(true, 1 / hz).camera.yaw;
        for (let tick = 0; tick < 6; tick++) input.consume(frame * 6 + tick);
      }
      expect(yaw).toBeCloseTo(2.1);
      expect(input.poll(false, 1 / 30).camera.yaw).toBe(0);
      expect(input.poll(true, 10).camera.yaw).toBeCloseTo(0.21);
      expect(() => input.poll(true, NaN)).toThrow("finite");
    }
  });

  it("LT switches right stick from orbit to explicit manual aiming, retaining aim at stick rest", () => {
    const { input, pad, button } = setup();
    pad.axes = [0, -1, 1, 0];
    button(6, 0.4);
    const frame = input.poll(true, 0.05);
    expect(frame.camera).toEqual({ yaw: 0, pitch: 0, zoom: 0 });
    expect(input.consume(1)).toMatchObject({ move: { x: 0, z: 1 }, aim: { x: 1, z: -0 } });
    pad.axes[2] = 0;
    input.poll(true, 0.05);
    expect(input.consume(2).aim).toBeNull();
    button(6, 0);
    input.poll(true, 0.05);
    expect(input.consume(3).aim).toEqual({ x: 0, z: 1 });
  });

  it("buffers render-frame taps and consumes pulses only once across catch-up ticks", () => {
    const { input, button } = setup();
    for (const index of [1, 2, 3, 5]) button(index, 1);
    button(7, 0.5);
    input.poll(true, 1 / 120);
    for (const index of [1, 2, 3, 5]) button(index, 0);
    input.poll(true, 1 / 120);
    expect(input.consume(1)).toMatchObject({ dodge: true, talk: true, ability: true, convoy: true, attack: true });
    expect(input.consume(2)).toMatchObject({ dodge: false, talk: false, ability: false, convoy: false, attack: true });
    button(7, 0);
    input.poll(true, 1 / 60);
    expect(input.consume(3).attack).toBe(false);
  });

  it("routes UI while paused and discards confirmation/attack across context transitions", () => {
    const { input, button } = setup();
    button(0, 1);
    button(7, 1);
    expect(input.poll(false, 1 / 60).ui.confirm).toBe(true);
    expect(input.consume(1)).toMatchObject({ interact: false, attack: false });
    input.clear();
    expect(input.poll(true, 1 / 60).sample.armed).toBe(false);
    expect(input.consume(2)).toMatchObject({ interact: false, attack: false });
    button(0, 0); button(7, 0);
    expect(input.poll(true, 1 / 60).sample.armed).toBe(true);
    button(7, 0.5);
    input.poll(true, 1 / 60);
    expect(input.consume(3).attack).toBe(true);
    input.clear();
    expect(input.consume(4).attack).toBe(false);
  });

  it("reports disconnection once and stops all gamepad movement/held controls", () => {
    const { input, pad, button, connect } = setup();
    pad.axes[0] = 1;
    button(7, 1);
    input.poll(true, 1 / 60);
    expect(input.consume(1).attack).toBe(true);
    connect(false);
    expect(input.poll(true, 1 / 60).disconnected).toBe(true);
    expect(input.consume(2)).toMatchObject({ move: { x: 0, z: -0 }, attack: false });
    expect(input.poll(true, 1 / 60).disconnected).toBe(false);
    connect(true);
    expect(input.poll(true, 1 / 60).sample.armed).toBe(false);
    expect(input.consume(3).attack).toBe(false);
    pad.axes[0] = 0; button(7, 0);
    expect(input.poll(true, 1 / 60).sample.armed).toBe(true);
  });

  it("allows keyboard/mouse takeover without idle pads reclaiming prompts or pausing on removal", () => {
    const { input, pad, connect } = setup();
    pad.axes[0] = 1;
    expect(input.poll(true, 1 / 60).becameActive).toBe(true);
    input.useKeyboardOrMouse();
    expect(input.active).toBe(false);
    expect(input.poll(true, 1 / 60).becameActive).toBe(false);
    expect(input.consume(1).active).toBe(false);
    connect(false);
    expect(input.poll(true, 1 / 60).disconnected).toBe(false);
  });

  it("discards unconsumed controller impulses on removal even after keyboard takeover", () => {
    const { input, button, connect } = setup();
    button(7, 1); button(3, 1);
    input.poll(true, 1 / 120);
    input.useKeyboardOrMouse();
    connect(false);
    input.poll(true, 1 / 120);
    expect(input.consume(1)).toMatchObject({ attack: false, ability: false });
  });

  it("provides menu, atlas, journal, zoom and held interaction without confusing UI navigation", () => {
    const { input, button } = setup();
    button(12, 1);
    const journal = input.poll(true, 0.05);
    expect(journal.overlay).toBe("journal");
    expect(journal.ui.moveY).toBe(-1);
    expect(journal.ui.journal).toBe(false);
    expect(input.poll(true, 0.05).overlay).toBeNull();
    button(12, 0); button(14, 1); button(0, 1); button(4, 1);
    expect(input.poll(true, 0.05).camera.zoom).toBe(-35);
    expect(input.consume(1)).toMatchObject({ interact: true, sprint: true });
    expect(input.consume(2)).toMatchObject({ interact: true, sprint: true });
    button(9, 1);
    expect(input.poll(true, 0.05).overlay).toBe("pause");
    button(9, 0); button(8, 1);
    expect(input.poll(true, 0.05).overlay).toBe("map");
  });
});
