import type { ControllerGameplay } from "./gamepad";

export interface InputVector {
  x: number;
  z: number;
}

export interface InputSample {
  move: InputVector;
  keyboardAim: InputVector | null;
  pointer: { x: number; y: number } | null;
  attack: boolean;
  sprint: boolean;
  dodge: boolean;
  ability: boolean;
  interact: boolean;
  convoy: boolean;
  talk: boolean;
}

type Edge = "dodge" | "ability" | "interact" | "convoy" | "attack" | "talk";
const bindings: Record<string, Edge> = {
  KeyQ: "dodge",
  KeyF: "ability",
  KeyE: "interact",
  KeyC: "convoy",
  Space: "attack",
  KeyT: "talk",
};
const gameKeys = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft",
  "ArrowRight", "ShiftLeft", "ShiftRight", ...Object.keys(bindings),
]);

function vector(x: number, z: number): InputVector {
  const length = Math.hypot(x, z);
  return length > 1 ? { x: x / length, z: z / length } : { x, z };
}

function editable(target: EventTarget | null): boolean {
  return target instanceof Element &&
    Boolean(target.closest("input, textarea, select, button, a, [contenteditable=true]"));
}

/** Edges are consumed by simulation ticks, never by render-only frames. */
export class GameInput {
  private readonly keys = new Set<string>();
  private readonly blockedKeys = new Set<string>();
  private readonly edges = new Set<Edge>();
  private readonly controller = new AbortController();
  private enabled = false;
  private pointerDown = false;
  private pointer: InputSample["pointer"] = null;
  private aimSource: "keyboard" | "pointer" = "keyboard";

  constructor(
    private readonly surface: HTMLElement,
    onOverlay: (overlay: "pause" | "map" | "journal") => void,
    onFocusLost: () => void,
  ) {
    const signal = this.controller.signal;
    window.addEventListener("keydown", (event) => {
      if (this.blockedKeys.has(event.code)) return;
      if (!this.enabled || event.defaultPrevented || editable(event.target)) {
        if (gameKeys.has(event.code)) this.blockedKeys.add(event.code);
        return;
      }
      if (["Escape", "KeyM", "Tab", "KeyJ"].includes(event.code)) {
        event.preventDefault();
        if (!event.repeat) onOverlay(event.code === "Escape" ? "pause" : event.code === "KeyJ" ? "journal" : "map");
        return;
      }
      if (!gameKeys.has(event.code)) return;
      event.preventDefault();
      if (!event.repeat && !this.keys.has(event.code)) {
        const edge = bindings[event.code];
        if (edge) this.edges.add(edge);
      }
      this.keys.add(event.code);
      if (event.code.startsWith("Arrow")) {
        this.aimSource = "keyboard";
      }
    }, { signal });
    window.addEventListener("keyup", (event) => {
      this.blockedKeys.delete(event.code);
      this.keys.delete(event.code);
      if (this.enabled && gameKeys.has(event.code)) event.preventDefault();
    }, { signal });
    surface.addEventListener("pointerdown", (event) => {
      if (!this.enabled || event.button !== 0 || editable(event.target)) return;
      event.preventDefault();
      surface.focus({ preventScroll: true });
      this.pointerDown = true;
      this.edges.add("attack");
      this.pointer = { x: event.clientX, y: event.clientY };
      this.aimSource = "pointer";
    }, { signal });
    surface.addEventListener("pointermove", (event) => {
      if (!this.enabled || (event.movementX === 0 && event.movementY === 0)) return;
      this.pointer = { x: event.clientX, y: event.clientY };
      this.aimSource = "pointer";
    }, { signal });
    window.addEventListener("pointerup", (event) => {
      if (event.button === 0) this.pointerDown = false;
    }, { signal });
    window.addEventListener("pointercancel", () => this.release(), { signal });
    surface.addEventListener("contextmenu", (event) => {
      if (this.enabled) event.preventDefault();
    }, { signal });
    window.addEventListener("blur", () => {
      this.release();
      if (this.enabled) onFocusLost();
    }, { signal });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.release();
        if (this.enabled) onFocusLost();
      }
    }, { signal });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.release();
    if (enabled) this.surface.focus({ preventScroll: true });
  }

  useGamepad(): void {
    this.pointer = null;
    this.aimSource = "keyboard";
  }

  consume(controller?: ControllerGameplay): InputSample {
    if (!this.enabled) controller = undefined;
    const axis = (positive: string, negative: string): number =>
      Number(this.keys.has(positive)) - Number(this.keys.has(negative));
    const keyboardMove = vector(axis("KeyD", "KeyA"), axis("KeyW", "KeyS"));
    const move = vector(keyboardMove.x + (controller?.move.x ?? 0), keyboardMove.z + (controller?.move.z ?? 0));
    const aim = vector(axis("ArrowRight", "ArrowLeft"), axis("ArrowUp", "ArrowDown"));
    const sample: InputSample = {
      move,
      keyboardAim: controller?.active ? controller.aim : this.aimSource === "keyboard"
        ? (aim.x || aim.z ? aim : keyboardMove.x || keyboardMove.z ? keyboardMove : null)
        : null,
      pointer: !controller?.active && this.aimSource === "pointer" ? this.pointer : null,
      attack: this.pointerDown || this.keys.has("Space") || this.edges.has("attack") || controller?.attack === true,
      sprint: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || controller?.sprint === true,
      dodge: this.edges.has("dodge") || controller?.dodge === true,
      ability: this.edges.has("ability") || controller?.ability === true,
      interact: this.keys.has("KeyE") || this.edges.has("interact") || controller?.interact === true,
      convoy: this.edges.has("convoy") || controller?.convoy === true,
      talk: this.edges.has("talk") || controller?.talk === true,
    };
    this.edges.clear();
    return sample;
  }

  release(): void {
    for (const key of this.keys) this.blockedKeys.add(key);
    this.keys.clear();
    this.edges.clear();
    this.pointerDown = false;
    this.pointer = null;
    this.aimSource = "keyboard";
  }

  dispose(): void {
    this.release();
    this.controller.abort();
  }
}
