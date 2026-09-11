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
}

type Edge = "dodge" | "ability" | "interact" | "convoy" | "attack";
const bindings: Record<string, Edge> = {
  KeyQ: "dodge",
  KeyF: "ability",
  KeyE: "interact",
  KeyC: "convoy",
  Space: "attack",
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
  private readonly edges = new Set<Edge>();
  private readonly controller = new AbortController();
  private enabled = false;
  private pointerDown = false;
  private pointer: InputSample["pointer"] = null;
  private aimSource: "keyboard" | "pointer" = "keyboard";

  constructor(
    private readonly surface: HTMLElement,
    onOverlay: (overlay: "pause" | "map") => void,
    onFocusLost: () => void,
  ) {
    const signal = this.controller.signal;
    window.addEventListener("keydown", (event) => {
      if (!this.enabled || event.defaultPrevented || editable(event.target)) return;
      if (["Escape", "KeyM", "Tab"].includes(event.code)) {
        event.preventDefault();
        if (!event.repeat) onOverlay(event.code === "Escape" ? "pause" : "map");
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

  consume(): InputSample {
    const axis = (positive: string, negative: string): number =>
      Number(this.keys.has(positive)) - Number(this.keys.has(negative));
    const move = vector(axis("KeyD", "KeyA"), axis("KeyW", "KeyS"));
    const aim = vector(axis("ArrowRight", "ArrowLeft"), axis("ArrowUp", "ArrowDown"));
    const sample: InputSample = {
      move,
      keyboardAim: this.aimSource === "keyboard"
        ? (aim.x || aim.z ? aim : move.x || move.z ? move : null)
        : null,
      pointer: this.aimSource === "pointer" ? this.pointer : null,
      attack: this.pointerDown || this.keys.has("Space") || this.edges.has("attack"),
      sprint: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"),
      dodge: this.edges.has("dodge"),
      ability: this.edges.has("ability"),
      interact: this.keys.has("KeyE") || this.edges.has("interact"),
      convoy: this.edges.has("convoy"),
    };
    this.edges.clear();
    return sample;
  }

  release(): void {
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
