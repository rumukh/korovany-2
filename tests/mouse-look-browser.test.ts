import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import {
  click, evaluate, launchBrowser, mouseMove, openPage, until,
  type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import type { GameSnapshot } from "../src/game";
import { closeTestBrowser } from "./browser-cleanup";
import { navigateTestPage } from "./browser-navigation";
import { storageKeys } from "../src/ui/storage";

interface Inspection {
  snapshot: GameSnapshot;
  running: boolean;
  overlay: string | null;
  mouseLook: boolean;
  controller: { active: boolean };
  moveBasis: { forward: { x: number; z: number }; right: { x: number; z: number } };
}

describe.runIf(process.env.KOROVANY_BROWSER === "1")("captured mouse look in the real game", () => {
  let server: ViteDevServer | undefined;
  let browser: LaunchedBrowser | undefined;
  let cdp: CdpSession;
  const inspect = () => evaluate<Inspection>(cdp, "window.korovany.inspect()");
  const attacks = (state: Inspection) => state.snapshot.events
    .filter(event => event.kind === "attack" && event.targetId === "player").at(-1)?.id ?? 0;

  async function frames(): Promise<void> {
    await evaluate(cdp, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  }
  async function ticks(count = 3): Promise<void> {
    const before = (await inspect()).snapshot.tick;
    await until(cdp, "window.korovany.inspect().snapshot.tick", (tick: number) => tick >= before + count, 20_000);
  }
  async function key(code: string, down: boolean): Promise<void> {
    const virtualKey = code.startsWith("Key") ? code.charCodeAt(3)
      : ({ Escape: 27, Space: 32, ArrowLeft: 37 }[code] ?? 0);
    await cdp.send("Input.dispatchKeyEvent", {
      type: down ? "keyDown" : "keyUp", code,
      key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code === "Space" ? " " : code,
      windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey,
    });
  }
  async function tap(code: string): Promise<void> { await key(code, true); await key(code, false); }
  async function clickControl(selector: string): Promise<void> {
    const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
      const node=document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({block:'center'});
      const rect=node.getBoundingClientRect();
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`);
    await click(cdp, point.x, point.y);
  }
  async function locked(value: boolean): Promise<void> {
    try {
      await until(cdp, "document.pointerLockElement === document.querySelector('canvas.world')",
        (actual: boolean) => actual === value, 10_000);
    } catch (error) {
      const diagnostic = await evaluate(cdp, `({
        events:window.lockEvents,overlay:window.korovany.inspect().overlay,
        warnings:document.querySelector('.warnings').textContent
      })`);
      throw new Error(`Expected pointer lock ${value}: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    expect((await inspect()).mouseLook).toBe(value);
  }
  function facingCamera(state: Inspection): void {
    expect(Math.sin(state.snapshot.player.heading)).toBeCloseTo(state.moveBasis.forward.x, 4);
    expect(Math.cos(state.snapshot.player.heading)).toBeCloseTo(state.moveBasis.forward.z, 4);
  }

  beforeAll(async () => {
    server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error("Missing mouse-look test server.");
    expect((await fetch(origin)).status).toBe(200);
    browser = await launchBrowser({ viewport: { width: 960, height: 640 } });
    cdp = await openPage(browser.port, "about:blank", { width: 960, height: 640 });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 640, deviceScaleFactor: 0.5, mobile: false });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.lockEvents=[];
      const request=HTMLElement.prototype.requestPointerLock;
      HTMLElement.prototype.requestPointerLock=function(...args) {
        window.lockEvents.push({type:'request',at:performance.now()});
        return request.apply(this,args)?.catch(error=>{
          window.lockEvents.push({type:'error',at:performance.now(),message:error.message});
          throw error;
        });
      };
      document.addEventListener('pointerlockchange',()=>{
        window.lockEvents.push({type:'change',at:performance.now(),locked:!!document.pointerLockElement});
        window.lockEvents=window.lockEvents.slice(-20);
      });
      window.testPad={index:0,id:'Mouse handoff virtual Xbox',mapping:'standard',connected:true,
        axes:[0,0,0,0],buttons:Array.from({length:17},()=>({value:0,pressed:false}))};
      Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.testPad]});
      if(location.protocol==='http:') localStorage.setItem(${JSON.stringify(storageKeys.settings)},
        JSON.stringify({language:'en',quality:'low',reducedMotion:true,muted:true}));
    ` });
    await navigateTestPage(cdp, origin, "window.korovany && window.korovany.inspect().controller.armed", 45_000);
  }, 60_000);

  afterAll(async () => {
    cdp?.close();
    try { if (browser) await closeTestBrowser(browser); }
    finally { await server?.close(); }
  }, 60_000);

  it("captures from a real Start click and turns camera and character together without a held button", async () => {
    await clickControl('[data-action="start"]');
    await locked(true);
    await ticks();
    expect(attacks(await inspect())).toBe(0);
    await mouseMove(cdp, 450, 320);
    for (const [x, direction] of [[490, 1], [450, -1]] as const) {
      const before = (await inspect()).moveBasis;
      await mouseMove(cdp, x, 320);
      await ticks();
      const after = await inspect();
      expect((after.moveBasis.forward.x * before.right.x + after.moveBasis.forward.z * before.right.z) * direction).toBeGreaterThan(0);
      facingCamera(after);
    }
    const before = await inspect();
    await key("KeyD", true);
    await ticks(12);
    await key("KeyD", false);
    const strafe = await inspect();
    expect(Math.hypot(strafe.snapshot.player.x - before.snapshot.player.x, strafe.snapshot.player.z - before.snapshot.player.z)).toBeGreaterThan(0.3);
    expect(strafe.moveBasis).toEqual(before.moveBasis);
    facingCamera(strafe);
    await key("KeyS", true);
    await ticks(8);
    await key("KeyS", false);
    facingCamera(await inspect());
  });

  it("releases capture for menus and Escape, recaptures without an attack, and pauses safely on focus loss", async () => {
    await tap("KeyM");
    await locked(false);
    expect((await inspect()).overlay).toBe("map");
    const paused = await inspect();
    await mouseMove(cdp, 510, 300);
    expect((await inspect()).moveBasis).toEqual(paused.moveBasis);
    await tap("KeyM");
    expect((await inspect()).running).toBe(true);
    await locked(false);
    await click(cdp, 480, 320);
    await locked(true);
    await ticks();
    expect(attacks(await inspect())).toBe(attacks(paused));
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 480, y: 320, button: "left", buttons: 1, clickCount: 1 });
    await until(cdp, "window.korovany.inspect()", (state: Inspection) => attacks(state) > attacks(paused), 15_000);
    await tap("Escape");
    await locked(false);
    expect((await inspect()).overlay).toBe("pause");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 480, y: 320, button: "left", buttons: 0, clickCount: 1 });
    await tap("Escape");
    await locked(false);
    const resumed = await inspect();
    await ticks(8);
    expect(attacks(await inspect())).toBe(attacks(resumed));
    // Chromium rejects capture for a short interval after a browser Escape unlock.
    await until(cdp, "performance.now() - window.lockEvents.filter(event => event.type === 'change' && !event.locked).at(-1).at",
      (elapsed: number) => elapsed >= 1500, 5_000);
    await click(cdp, 480, 320);
    await locked(true);
    await key("KeyW", true);
    await evaluate(cdp, "window.dispatchEvent(new Event('blur'))");
    await locked(false);
    expect((await inspect()).overlay).toBe("pause");
    await key("KeyW", false);
    await evaluate(cdp, "window.dispatchEvent(new Event('focus'))");
    await clickControl('[data-action="resume"]');
    await locked(true);
    const stopped = await inspect();
    await ticks(8);
    expect((await inspect()).snapshot.player.x).toBeCloseTo(stopped.snapshot.player.x, 4);
    expect((await inspect()).snapshot.player.z).toBeCloseTo(stopped.snapshot.player.z, 4);
    await evaluate(cdp, "document.exitPointerLock()");
    await until(cdp, "window.korovany.inspect().overlay", (overlay: string) => overlay === "pause", 10_000);
    expect((await inspect()).running).toBe(false);
  });

  it("reports capture denial instead of silently disabling controls and supports retry", async () => {
    await evaluate(cdp, `document.querySelector('[data-action="resume"]').click()`);
    await locked(false);
    await evaluate(cdp, `Object.defineProperty(document.querySelector('canvas.world'),'requestPointerLock',{
      configurable:true,value:()=>Promise.reject(new DOMException('Test permission denial','NotAllowedError'))
    })`);
    await click(cdp, 480, 320);
    await until(cdp, "document.querySelector('.warnings').textContent.includes('could not capture the mouse')", Boolean, 10_000);
    expect((await inspect()).running).toBe(true);
    expect((await inspect()).mouseLook).toBe(false);
    const before = await inspect();
    await key("ArrowLeft", true);
    await key("Space", true);
    await until(cdp, "window.korovany.inspect()", (state: Inspection) => attacks(state) > attacks(before), 15_000);
    await key("ArrowLeft", false);
    await key("Space", false);
    const aimed = await inspect();
    expect(Math.sin(aimed.snapshot.player.heading)).toBeCloseTo(-aimed.moveBasis.right.x, 4);
    await clickControl(".notice-close");
    await evaluate(cdp, "delete document.querySelector('canvas.world').requestPointerLock");
    await click(cdp, 480, 320);
    await locked(true);
  });

  it("hands over to a controller without pausing, and restores mouse-look only after a click", async () => {
    await evaluate(cdp, "window.testPad.axes=[0,0,1,0]");
    await until(cdp, "window.korovany.inspect().controller.active", Boolean, 10_000);
    await locked(false);
    expect((await inspect()).running).toBe(true);
    await evaluate(cdp, "window.testPad.axes=[0,0,0,0]");
    await frames();
    const before = (await inspect()).moveBasis;
    await mouseMove(cdp, 520, 320);
    await frames();
    expect((await inspect()).moveBasis).toEqual(before);
    expect((await inspect()).controller.active).toBe(true);
    await click(cdp, 480, 320);
    await locked(true);
    await mouseMove(cdp, 500, 320);
    await ticks();
    const restored = await inspect();
    expect(restored.controller.active).toBe(false);
    facingCamera(restored);
    await tap("Escape");
    await locked(false);
  });
});
