import type { ControllerUiFrame } from "./controller-types";

const controlSelector = "button, input:not([type='hidden']), select, textarea, summary, [tabindex='0']";

export function controllerControls(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(controlSelector)].filter((node) => {
    if (node.matches(":disabled") || node.closest("[hidden], [inert], [aria-hidden='true'], [aria-disabled='true']")) return false;
    if (!node.getClientRects().length || getComputedStyle(node).visibility === "hidden") return false;
    for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement && !parent.open && parent.querySelector("summary") !== node) return false;
    }
    return true;
  });
}

function controlKey(node: HTMLElement): string {
  if (node.dataset.controllerKey) return node.dataset.controllerKey;
  if (node.id) return `id:${node.id}`;
  for (const key of ["faction", "quest", "choice", "travel", "audioChannel", "action"]) {
    if (node.dataset[key]) return `${key}:${node.dataset[key]}`;
  }
  return `${node.tagName}:${node.className}`;
}

export interface ControllerContext {
  key: string | null;
  occurrence: number;
  index: number;
  details: boolean[];
  scroll: { key: string; top: number; left: number }[];
}

export function captureControllerContext(root: HTMLElement): ControllerContext {
  const controls = controllerControls(root);
  const focused = document.activeElement as HTMLElement;
  const index = controls.indexOf(focused);
  const key = index < 0 ? null : controlKey(focused);
  return {
    key, index, occurrence: controls.slice(0, index).filter((node) => controlKey(node) === key).length,
    details: [...root.querySelectorAll("details")].map((node) => node.open),
    scroll: [root, ...root.querySelectorAll<HTMLElement>("*")]
      .filter((node) => node.scrollTop !== 0 || node.scrollLeft !== 0)
      .map((node) => ({ key: controlKey(node), top: node.scrollTop, left: node.scrollLeft })),
  };
}

export function restoreControllerContext(root: HTMLElement, context: ControllerContext): boolean {
  root.querySelectorAll("details").forEach((node, index) => { node.open = context.details[index] ?? false; });
  const controls = controllerControls(root);
  const focused = controls.filter((node) => controlKey(node) === context.key)[context.occurrence]
    ?? (context.index >= 0 ? controls[Math.min(context.index, controls.length - 1)] : undefined);
  focused?.focus({ preventScroll: true });
  for (const saved of context.scroll) {
    const node = [root, ...root.querySelectorAll<HTMLElement>("*")].find((item) => controlKey(item) === saved.key);
    if (node) { node.scrollTop = saved.top; node.scrollLeft = saved.left; }
  }
  return Boolean(focused);
}

export function controllerNeutral(frame: ControllerUiFrame): boolean {
  return !frame.confirm && !frame.cancel && !frame.pause && !frame.map && !frame.journal &&
    [frame.moveX, frame.moveY, frame.scrollX, frame.scrollY].every((axis) => Math.abs(axis) < 0.25);
}

export function trapControllerTab(root: HTMLElement, event: KeyboardEvent): void {
  const controls = controllerControls(root);
  const index = controls.indexOf(document.activeElement as HTMLElement);
  if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
    event.preventDefault();
    (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
  }
}

function revealControllerFocus(control: HTMLElement, root: HTMLElement): void {
  control.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  for (let parent = control.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(parent).overflowY)) continue;
    const bounds = parent.getBoundingClientRect();
    const hint = parent.querySelector<HTMLElement>(":scope > .controller-hints:not([hidden])")?.getBoundingClientRect();
    const top = Math.max(bounds.top + parent.clientTop + 5, hint ? hint.bottom + 8 : -Infinity);
    const bottom = bounds.top + parent.clientTop + parent.clientHeight - 5;
    const rect = control.getBoundingClientRect();
    // Long reading regions may fill the viewport; compact controls must clear sticky hints.
    if (rect.height > bottom - top) continue;
    if (rect.top < top) parent.scrollTop -= top - rect.top;
    else if (rect.bottom > bottom) parent.scrollTop += rect.bottom - bottom;
  }
}

/** DOM navigation only: all game changes still go through the controls' existing handlers. */
export class ControllerNavigation {
  private direction = "";
  private elapsed = 0;
  private repeating = false;

  reset(): void {
    this.direction = "";
    this.elapsed = 0;
    this.repeating = false;
  }

  focus(root: HTMLElement, reveal = false): HTMLElement | undefined {
    const controls = controllerControls(root);
    const current = controls.find((node) => node === document.activeElement) ?? controls[0];
    if (current && current !== document.activeElement) {
      current.focus({ preventScroll: true });
      reveal = true;
    }
    if (reveal && current) revealControllerFocus(current, root);
    return current;
  }

  handle(root: HTMLElement, frame: ControllerUiFrame, dt: number): boolean {
    const focused = this.focus(root);
    this.scroll(root, focused, frame.scrollX, frame.scrollY, dt);
    if (frame.confirm) {
      this.reset();
      return focused ? this.activate(focused) : false;
    }
    const horizontal = Math.abs(frame.moveX) > Math.abs(frame.moveY);
    const value = horizontal ? frame.moveX : frame.moveY;
    const direction = Math.abs(value) >= 0.5 ? `${horizontal ? "x" : "y"}${Math.sign(value)}` : "";
    if (!direction) { this.reset(); return false; }
    if (direction === this.direction) {
      this.elapsed += Math.max(0, Math.min(dt, 0.1));
      const interval = this.repeating ? 0.14 : 0.38;
      if (this.elapsed < interval) return false;
      this.elapsed -= interval;
      this.repeating = true;
    } else {
      this.direction = direction;
      this.elapsed = 0;
      this.repeating = false;
    }
    const step = Math.sign(value);
    if (horizontal && focused && this.adjustable(focused)) return this.adjust(focused, step);
    const controls = controllerControls(root);
    const index = controls.indexOf(focused!);
    const next = controls[(index + step + controls.length) % controls.length];
    next?.focus({ preventScroll: true });
    if (next) revealControllerFocus(next, root);
    return false;
  }

  private adjustable(node: HTMLElement): boolean {
    return node instanceof HTMLSelectElement || node instanceof HTMLInputElement && node.type === "range";
  }

  private adjust(node: HTMLElement, direction: number): boolean {
    if (node instanceof HTMLSelectElement) {
      const options = [...node.options].filter((option) => !option.disabled && !option.hidden &&
        !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled));
      const index = options.findIndex((option) => option.value === node.value);
      const option = options[Math.max(0, Math.min(options.length - 1, index + direction))];
      if (!option || option.value === node.value) return false;
      node.value = option.value;
    } else if (node instanceof HTMLInputElement && node.type === "range") {
      const before = node.value;
      if (direction > 0) node.stepUp(); else node.stepDown();
      if (node.value === before) return false;
    } else return false;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  private activate(node: HTMLElement): boolean {
    if (node instanceof HTMLSelectElement) {
      const options = [...node.options].filter((option) => !option.disabled && !option.hidden &&
        !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled));
      const next = options[(options.findIndex((option) => option.value === node.value) + 1) % options.length];
      if (!next || next.value === node.value) return false;
      node.value = next.value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (node instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(node.type) ||
      node instanceof HTMLTextAreaElement || node.isContentEditable) return false;
    if (node.tagName === "SUMMARY" && node.parentElement instanceof HTMLDetailsElement) {
      node.parentElement.open = !node.parentElement.open;
    } else if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement) node.click();
    else return false;
    return true;
  }

  private scroll(root: HTMLElement, focused: HTMLElement | undefined, x: number, y: number, dt: number): void {
    const amount = 640 * Math.max(0, Math.min(dt, 0.1));
    for (const [axis, value] of [["y", y], ["x", x]] as const) {
      if (Math.abs(value) < 0.15) continue;
      let node: HTMLElement | null = focused?.parentElement ?? root;
      while (node && root.contains(node)) {
        const style = getComputedStyle(node);
        const overflow = axis === "y" ? style.overflowY : style.overflowX;
        const position = axis === "y" ? node.scrollTop : node.scrollLeft;
        const maximum = axis === "y" ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth;
        if (/auto|scroll/.test(overflow) && maximum > 1 && (value > 0 ? position < maximum - 1 : position > 0)) {
          if (axis === "y") node.scrollTop += value * amount; else node.scrollLeft += value * amount;
          break;
        }
        node = node.parentElement;
      }
    }
  }
}
