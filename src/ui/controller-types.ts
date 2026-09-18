import type { GamepadSample } from "@aegis/render-three/input";

export interface ControllerUiFrame {
  moveX: number;
  moveY: number;
  scrollX: number;
  scrollY: number;
  confirm: boolean;
  cancel: boolean;
  pause: boolean;
  map: boolean;
  journal: boolean;
}

export interface ControllerFeedback {
  active: boolean;
  connected: boolean;
  status: GamepadSample["status"];
  armed: boolean;
  audioLocked: boolean;
}
