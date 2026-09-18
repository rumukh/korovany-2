import {
  createGamepadInput, createInputBuffer, createLiveInput,
  type GamepadBindings, type GamepadInput, type GamepadSample,
} from "@aegis/render-three/input";
import type { ControllerUiFrame } from "./controller-types";
import type { InputVector } from "./input";

export const controllerBindings: GamepadBindings = {
  sticks: [
    { axes: [0, 1], x: "MoveX", y: "MoveY", deadZone: 0.2, label: "LS" },
    { axes: [2, 3], x: "LookX", y: "LookY", deadZone: 0.2, label: "RS" },
  ],
  buttons: [
    { button: 0, action: "Interact", label: "A" },
    { button: 1, action: "Dodge", label: "B" },
    { button: 2, action: "Talk", label: "X" },
    { button: 3, action: "Ability", label: "Y" },
    { button: 4, action: "Sprint", label: "LB" },
    { button: 5, action: "Convoy", label: "RB" },
    { button: 6, action: "Aim", threshold: 0.3, label: "LT" },
    { button: 7, action: "Attack", threshold: 0.3, label: "RT" },
    { button: 8, action: "Map", label: "View" },
    { button: 9, action: "Pause", label: "Menu" },
    { button: 12, action: "Up", label: "D-pad up" },
    { button: 13, action: "Down", label: "D-pad down" },
    { button: 14, action: "Left", label: "D-pad left" },
    { button: 15, action: "Right", label: "D-pad right" },
  ],
};

export interface ControllerGameplay {
  active: boolean;
  move: InputVector;
  aim: InputVector | null;
  attack: boolean;
  sprint: boolean;
  interact: boolean;
  dodge: boolean;
  ability: boolean;
  convoy: boolean;
  talk: boolean;
}

export interface ControllerFrame {
  sample: GamepadSample;
  becameActive: boolean;
  disconnected: boolean;
  overlay: "pause" | "map" | "journal" | null;
  camera: { yaw: number; pitch: number; zoom: number };
  ui: ControllerUiFrame;
}

const gameplayActions = new Set(["Interact", "Dodge", "Talk", "Ability", "Sprint", "Convoy", "Aim", "Attack"]);

export class ControllerInput {
  private readonly packets = createInputBuffer();
  private readonly ticks = createLiveInput();
  private lastActivity = 0;
  private device: GamepadSample["device"] = null;
  private current: GamepadSample | null = null;
  private usingController = false;

  constructor(private readonly pad: GamepadInput = createGamepadInput({ bindings: controllerBindings })) {}

  get active(): boolean { return this.usingController; }
  get sample(): GamepadSample | null { return this.current; }

  useKeyboardOrMouse(): void {
    this.usingController = false;
  }

  poll(gameplay: boolean, dt: number): ControllerFrame {
    if (!Number.isFinite(dt) || dt < 0) throw new Error("Controller frame time must be finite and nonnegative.");
    const sample = this.pad.sample();
    const becameActive = sample.activity !== this.lastActivity;
    if (becameActive) this.usingController = true;
    this.lastActivity = sample.activity;
    const deviceLost = this.device !== null &&
      (sample.status !== "ready" || sample.device?.index !== this.device.index || sample.device?.id !== this.device.id);
    if (deviceLost) {
      this.packets.clear();
      this.ticks.clear();
    }
    this.device = sample.status === "ready" ? sample.device : null;
    this.current = sample;
    const held = (action: string) => sample.held.includes(action);
    const pressed = (action: string) => sample.pressed.includes(action);
    const x = sample.axes.MoveX ?? 0, y = sample.axes.MoveY ?? 0;
    const lookX = sample.axes.LookX ?? 0, lookY = sample.axes.LookY ?? 0;
    const horizontal = Number(held("Right")) - Number(held("Left"));
    const vertical = Number(held("Down")) - Number(held("Up"));
    const seconds = Math.min(0.1, Math.max(0, dt));
    const looking = gameplay && !held("Aim");
    this.packets.setSource("controller", gameplay
      ? { held: sample.held.filter(action => gameplayActions.has(action)), axes: sample.axes }
      : { held: [], axes: {} });
    this.ticks.submit(this.packets.take());
    return {
      sample, becameActive, disconnected: this.usingController && deviceLost,
      overlay: gameplay ? pressed("Pause") ? "pause" : pressed("Map") ? "map" : pressed("Up") ? "journal" : null : null,
      camera: {
        yaw: looking ? lookX * seconds * 2.1 : 0,
        pitch: looking ? lookY * seconds * 1.3 : 0,
        zoom: gameplay ? horizontal * seconds * 700 : 0,
      },
      ui: {
        moveX: Math.max(-1, Math.min(1, x + horizontal)),
        moveY: Math.max(-1, Math.min(1, y + vertical)),
        scrollX: lookX, scrollY: lookY,
        confirm: pressed("Interact"), cancel: pressed("Dodge"),
        pause: pressed("Pause"), map: pressed("Map"), journal: false,
      },
    };
  }

  consume(tick: number): ControllerGameplay {
    const frame = this.ticks.frameFor(tick);
    const move = { x: frame.axes.MoveX ?? 0, z: -(frame.axes.MoveY ?? 0) };
    const direction = frame.actions.Aim
      ? { x: frame.axes.LookX ?? 0, z: -(frame.axes.LookY ?? 0) } : move;
    const length = Math.hypot(direction.x, direction.z);
    return {
      active: this.usingController, move,
      aim: length > 0 ? { x: direction.x / length, z: direction.z / length } : null,
      attack: frame.actions.Attack === true, sprint: frame.actions.Sprint === true,
      interact: frame.actions.Interact === true,
      dodge: frame.pressed.includes("Dodge"), ability: frame.pressed.includes("Ability"),
      convoy: frame.pressed.includes("Convoy"), talk: frame.pressed.includes("Talk"),
    };
  }

  clear(): void {
    this.pad.clear();
    this.packets.clear();
    this.ticks.clear();
  }

  dispose(): void {
    this.clear();
    this.pad.dispose();
  }
}
