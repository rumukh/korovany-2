import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import {
  click, evaluate, launchBrowser, openPage, screenshot, until,
  type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { closeOwnedBrowser } from "../vendor/aegis-engine/packages/render-three/src/testing/browser-lifecycle";
import type { GameSnapshot } from "../src/game";

interface Inspection {
  snapshot: GameSnapshot | null;
  overlay: string | null;
  running: boolean;
  settings: { language: string; quality: string; reducedMotion: boolean; muted: boolean };
  audio: { state: string; active: boolean; muted: boolean; voices: number };
  moveBasis: { forward: { x: number; z: number }; right: { x: number; z: number } };
}

describe.runIf(process.env.KOROVANY_BROWSER === "1")("real browser shell controls", () => {
  let server: ViteDevServer | undefined;
  let browser: LaunchedBrowser | undefined;
  let cdp: CdpSession;
  let origin: string;
  const captures = process.env.KOROVANY_CAPTURE_DIR;

  async function inspect(): Promise<Inspection> {
    return evaluate(cdp, "window.korovany.inspect()");
  }

  async function press(code: string, down: boolean): Promise<void> {
    const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : code === "Space" ? " " : code;
    const vk = code.startsWith("Key") ? code.charCodeAt(3)
      : ({ Escape: 27, Tab: 9, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ShiftLeft: 16 }[code] ?? 0);
    await cdp.send("Input.dispatchKeyEvent", {
      type: down ? "keyDown" : "keyUp", code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
  }

  async function tap(code: string): Promise<void> {
    await press(code, true);
    await press(code, false);
  }

  async function clickSelector(selector: string): Promise<void> {
    const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({block: 'center'});
      const rect = element.getBoundingClientRect();
      return {x:rect.x + rect.width / 2, y:rect.y + rect.height / 2};
    })()`);
    await click(cdp, point.x, point.y);
  }

  async function capture(name: string): Promise<void> {
    if (!captures) return;
    await screenshot(cdp, join(captures, `${name}.png`));
  }

  async function reload(): Promise<void> {
    const timeOrigin = await evaluate<number>(cdp, "performance.timeOrigin");
    await cdp.send("Page.reload");
    await until(cdp, `performance.timeOrigin !== ${timeOrigin} && Boolean(window.korovany) && window.korovany.inspect().overlay === 'menu'`, Boolean, 30_000);
  }

  beforeAll(async () => {
    if (captures) await mkdir(captures, { recursive: true });
    server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error("Vite did not expose a local URL.");
    origin = url;
    expect((await fetch(origin)).status).toBe(200);
    browser = await launchBrowser({ viewport: { width: 1440, height: 900 } });
    cdp = await openPage(browser.port, origin, { width: 1440, height: 900 });
    await until(cdp, "Boolean(window.korovany)", Boolean, 30_000);
  }, 60_000);

  afterAll(async () => {
    cdp?.close();
    if (browser) {
      await closeOwnedBrowser(browser);
      await rm(browser.profile, { recursive: true, force: true });
    }
    await server?.close();
  }, 30_000);

  it("plays through actual inputs, pauses without leaking keys, saves, reloads, and localizes the atlas", async () => {
    expect((await inspect()).overlay).toBe("menu");
    expect(await evaluate(cdp, "document.documentElement.lang")).toBe("ru");
    expect(await evaluate<number>(cdp, "document.querySelector('.menu-panel').getBoundingClientRect().left")).toBeLessThan(5);
    await capture("title-ru-desktop");
    await clickSelector(".language-button");
    expect(await evaluate(cdp, "document.documentElement.lang")).toBe("en");
    await capture("title-en-desktop");
    await clickSelector('[data-faction="guard"]');
    await clickSelector('[data-action="start"]');
    await until(cdp, "window.korovany.inspect().snapshot?.tick ?? 0", (tick: number) => tick >= 5, 30_000);
    let start = await inspect();
    expect(start.snapshot?.faction).toBe("guard");
    expect(start.running).toBe(true);
    expect(start.audio.state).toBe("running");
    expect(start.audio.active).toBe(true);
    await capture("gameplay-en-desktop");

    const initialBasis = (await inspect()).moveBasis.forward;
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 800, y: 430, button: "right", buttons: 2, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 850, y: 440, button: "right", buttons: 2 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 850, y: 440, button: "right", buttons: 0, clickCount: 1 });
    expect((await inspect()).moveBasis.forward).not.toEqual(initialBasis);
    start = await inspect();
    await press("KeyW", true);
    const beforeMove = start.snapshot?.player;
    await until(cdp, `window.korovany.inspect().snapshot.tick`, (tick: number) => tick >= (start.snapshot?.tick ?? 0) + 30, 20_000);
    await press("KeyW", false);
    const moved = await inspect();
    expect(Math.hypot((moved.snapshot?.player.x ?? 0) - (beforeMove?.x ?? 0), (moved.snapshot?.player.z ?? 0) - (beforeMove?.z ?? 0))).toBeGreaterThan(0.5);
    expect(((moved.snapshot?.player.x ?? 0) - (beforeMove?.x ?? 0)) * start.moveBasis.forward.x +
      ((moved.snapshot?.player.z ?? 0) - (beforeMove?.z ?? 0)) * start.moveBasis.forward.z).toBeGreaterThan(0.5);

    await press("ArrowLeft", true);
    await press("Space", true);
    const firstAttackEvent = moved.snapshot?.events.at(-1)?.id ?? 0;
    await until(cdp, `window.korovany.inspect().snapshot.events.some(e => e.id > ${firstAttackEvent} && e.kind === 'attack')`, Boolean, 15_000);
    await press("Space", false);
    await press("ArrowLeft", false);
    await tap("KeyF");
    await until(cdp, "window.korovany.inspect().snapshot.player.abilityCooldown", (cooldown: number) => cooldown > 0, 15_000);
    await tap("KeyC");
    await until(cdp, "window.korovany.inspect().snapshot.convoy.mode", (mode: string) => mode !== moved.snapshot?.convoy.mode, 15_000);

    await press("KeyW", true);
    await tap("Escape");
    const paused = await inspect();
    expect(paused.overlay).toBe("pause");
    expect(paused.running).toBe(false);
    expect(paused.audio.active).toBe(false);
    expect(paused.audio.voices).toBe(0);
    await evaluate(cdp, "new Promise(resolve => setTimeout(resolve, 250))");
    expect((await inspect()).snapshot?.tick).toBe(paused.snapshot?.tick);
    await tap("Escape");
    await press("KeyW", false);
    start = await inspect();
    await until(cdp, "window.korovany.inspect().snapshot.tick", (tick: number) => tick >= (start.snapshot?.tick ?? 0) + 8, 15_000);
    expect((await inspect()).snapshot?.player.x).toBeCloseTo(start.snapshot?.player.x ?? 0, 4);
    expect((await inspect()).snapshot?.player.z).toBeCloseTo(start.snapshot?.player.z ?? 0, 4);

    await tap("Tab");
    expect((await inspect()).overlay).toBe("map");
    await capture("atlas-en-desktop");
    await clickSelector('.order-buttons button:nth-child(1)');
    await until(cdp, "window.korovany.inspect().snapshot.convoy.mode", (mode: string) => mode === "hold", 15_000);
    expect((await inspect()).running).toBe(true);
    await tap("KeyM");
    await tap("Tab");
    expect((await inspect()).overlay).toBe("map");
    expect(await evaluate(cdp, "document.activeElement.tagName")).toBe("BUTTON");
    await tap("KeyM");
    expect((await inspect()).overlay).toBe(null);

    await evaluate(cdp, "window.dispatchEvent(new Event('blur'))");
    expect((await inspect()).overlay).toBe("pause");
    await clickSelector('[data-action="save"]');
    const saved = await inspect();
    await reload();
    await clickSelector('[data-action="continue"]');
    const restored = await inspect();
    expect(restored.snapshot?.runId).toBe(saved.snapshot?.runId);
    expect(restored.snapshot?.tick).toBeGreaterThanOrEqual(saved.snapshot?.tick ?? 0);
    expect(restored.snapshot?.player.coins).toBe(saved.snapshot?.player.coins);
    expect(await evaluate(cdp, `(() => {
      const copy = window.korovany.inspect();
      const hp = copy.snapshot.player.hp;
      copy.snapshot.player.hp = -100;
      return window.korovany.inspect().snapshot.player.hp === hp;
    })()`)).toBe(true);

    await tap("Escape");
    await clickSelector('[data-action="open-settings"]');
    await clickSelector('input[type="checkbox"]:last-child');
    expect((await inspect()).settings.muted).toBe(true);
    await clickSelector('.settings-panel [data-action="open-pause"]');
    await clickSelector('[data-action="title"]');
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 430, height: 900, deviceScaleFactor: 1, mobile: false });
    await capture("title-en-narrow");
    await clickSelector(".language-button");
    expect(await evaluate(cdp, "document.documentElement.lang")).toBe("ru");
    await capture("title-ru-narrow");
    expect(await evaluate(cdp, "document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    await clickSelector('[data-action="continue"]');
    await tap("KeyM");
    await capture("atlas-ru-narrow");
    expect(await evaluate(cdp, "document.querySelector('.map-panel').scrollWidth <= document.querySelector('.map-panel').clientWidth")).toBe(true);
    expect(await evaluate(cdp, "Object.keys(window.korovany).join(',')")).toBe("inspect");
  }, 120_000);

  it("surfaces corrupt and blocked storage without crashing or claiming a save exists", async () => {
    const corruption = await cdp.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem('korovany2:campaign', '{broken');
        localStorage.setItem('korovany2:profile', '{broken');
        localStorage.setItem('korovany2.settings.v1', '{broken');`,
    });
    await reload();
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", corruption);
    expect((await inspect()).snapshot).toBeNull();
    expect(await evaluate(cdp, "Boolean(document.querySelector('.notice'))")).toBe(true);
    expect(await evaluate(cdp, "Boolean(document.querySelector('[data-action=continue]'))")).toBe(false);
    const injection = await cdp.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
      source: `Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });`,
    });
    await reload();
    expect((await inspect()).snapshot).toBeNull();
    expect(await evaluate(cdp, "document.querySelector('.notice')?.textContent.includes('недоступно')")).toBe(true);
    await clickSelector('[data-action="start"]');
    await until(cdp, "window.korovany.inspect().snapshot?.tick ?? 0", (tick: number) => tick > 2, 30_000);
    expect((await inspect()).running).toBe(true);
    expect(await evaluate(cdp, "document.querySelector('.warnings').textContent.includes('сохранить')")).toBe(true);
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", injection);
  }, 90_000);

  it("stops cleanly and shows a recovery screen when its own WebGL context is lost", async () => {
    await reload();
    await clickSelector('[data-action="start"]');
    await until(cdp, "window.korovany.inspect().snapshot?.tick ?? 0", (tick: number) => tick >= 5, 30_000);
    await tap("Escape");
    const saved = await evaluate<string | null>(cdp, "localStorage.getItem('korovany2:campaign')");
    expect(saved).not.toBeNull();
    await evaluate(cdp, `(() => {
      const extension = document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Browser did not expose WebGL context-loss testing.');
      extension.loseContext();
    })()`);
    await until(cdp, "window.korovany.inspect().overlay", (overlay: string) => overlay === "fatal", 15_000);
    const failed = await inspect();
    expect(failed.running).toBe(false);
    expect(failed.audio.voices).toBe(0);
    expect(await evaluate(cdp, "Boolean(document.querySelector('.fatal-panel [data-action=reload]'))")).toBe(true);
    expect(await evaluate(cdp, "localStorage.getItem('korovany2:campaign')")).toBe(saved);
    await capture("webgl-recovery");
  }, 60_000);
});
