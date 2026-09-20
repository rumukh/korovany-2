import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import {
  evaluate, launchBrowser, openPage, screenshot, until,
  type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { createCampaign, type GameSnapshot } from "../src/game";
import { CampaignDriver } from "./driver";
import { closeTestBrowser } from "./browser-cleanup";
import { navigateTestPage, reloadTestPage } from "./browser-navigation";
import { storageKeys } from "../src/ui/storage";

interface Inspection {
  snapshot: GameSnapshot | null;
  overlay: string | null;
  running: boolean;
  settings: { invertControllerCameraX: boolean };
  moveBasis: { forward: { x: number; z: number }; right: { x: number; z: number } };
  controller: { active: boolean; armed: boolean; status: string };
}

describe.runIf(process.env.KOROVANY_BROWSER === "1")("controller through the real game", () => {
  let server: ViteDevServer | undefined;
  let browser: LaunchedBrowser | undefined;
  let cdp: CdpSession;
  const captures = process.env.KOROVANY_CAPTURE_DIR;

  async function inspect(): Promise<Inspection> { return evaluate(cdp, "window.korovany.inspect()"); }
  async function frames(count = 2): Promise<void> {
    await evaluate(cdp, `new Promise((resolve,reject) => {
      let remaining=${count};
      const timeout=setTimeout(()=>reject(new Error('Game controller RAF stalled')),15000);
      const next=()=>{if(--remaining===0){clearTimeout(timeout);resolve(null)}else requestAnimationFrame(next)};
      requestAnimationFrame(next);
    })`);
  }
  async function pad(axes = [0, 0, 0, 0], down: number[] = [], connected = true): Promise<void> {
    await evaluate(cdp, `window.testPad = {
      index:0,id:'Korovany virtual Xbox',mapping:'standard',connected:${connected},
      axes:${JSON.stringify(axes)},
      buttons:Array.from({length:17},(_,i)=>({value:${JSON.stringify(down)}.includes(i)?1:0,pressed:${JSON.stringify(down)}.includes(i)}))
    }`);
    await frames();
  }
  async function tap(button: number): Promise<void> { await pad([0, 0, 0, 0], [button]); await pad(); }
  async function focus(selector: string): Promise<void> {
    for (let step = 0; step < 80; step++) {
      if (await evaluate(cdp, `Boolean(document.activeElement?.matches(${JSON.stringify(selector)}))`)) return;
      await tap(13);
    }
    throw new Error(`Controller could not focus ${selector}; active=${await evaluate(cdp, "document.activeElement?.outerHTML")}`);
  }
  async function activate(selector: string): Promise<void> { await focus(selector); await tap(0); }
  async function capture(name: string): Promise<void> {
    if (captures) await screenshot(cdp, join(captures, `${name}.png`));
  }
  async function ticks(count: number): Promise<void> {
    const before = (await inspect()).snapshot!.tick;
    await until(cdp, "window.korovany.inspect().snapshot.tick", (tick: number) => tick >= before + count, 30_000);
  }
  async function horizontalTurn(direction: number): Promise<number> {
    const before = (await inspect()).moveBasis;
    await pad([0, 0, direction, 0]);
    await ticks(8);
    await pad();
    const after = (await inspect()).moveBasis.forward;
    return (after.x * before.right.x + after.z * before.right.z) * direction;
  }
  const attacks = (snapshot: GameSnapshot) => snapshot.events.filter(event => event.kind === "attack" && event.targetId === "player").at(-1)?.id ?? 0;

  beforeAll(async () => {
    if (captures) await mkdir(captures, { recursive: true });
    server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error("Missing controller game URL.");
    expect((await fetch(origin)).status).toBe(200);
    browser = await launchBrowser({ viewport: { width: 960, height: 640 } });
    cdp = await openPage(browser.port, "about:blank", { width: 960, height: 640 });
    // Bound SwiftShader pixel cost for input timing while preserving the full CSS layout.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 960, height: 640, deviceScaleFactor: 0.5, mobile: false,
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.testPad={index:0,id:'Korovany virtual Xbox',mapping:'standard',connected:true,
        axes:[0,0,0,0],buttons:Array.from({length:17},()=>({value:0,pressed:false}))};
      Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>window.testPad.connected?[window.testPad]:[]});
      if(location.protocol==='http:' && !localStorage.getItem(${JSON.stringify(storageKeys.settings)})) {
        localStorage.setItem(${JSON.stringify(storageKeys.settings)},JSON.stringify({
          language:'en',quality:'low',reducedMotion:true,muted:true
        }));
      }
    ` });
    await navigateTestPage(cdp, origin, "window.korovany && window.korovany.inspect().controller.armed", 45_000);
    expect(await evaluate(cdp, `({
      width:innerWidth,height:innerHeight,pixelRatio:devicePixelRatio,
      renderWidth:document.querySelector('canvas').width,renderHeight:document.querySelector('canvas').height
    })`)).toEqual({ width: 960, height: 640, pixelRatio: 0.5, renderWidth: 480, renderHeight: 320 });
  }, 60_000);

  afterAll(async () => {
    cdp?.close();
    try { if (browser) await closeTestBrowser(browser); }
    finally { await server?.close(); }
  }, 60_000);

  it("starts without a mouse, moves, orbits, aims, attacks and navigates map/journal/pause", async () => {
    await activate('[data-action="start"]');
    await until(cdp, "window.korovany.inspect().running", Boolean, 20_000);
    expect((await inspect()).controller.active).toBe(true);
    expect(await evaluate(cdp, "document.pointerLockElement")).toBeNull();
    const start = (await inspect()).snapshot!.player;
    await pad([0, -1, 0, 0]);
    await ticks(12);
    await pad();
    const moved = (await inspect()).snapshot!.player;
    expect(Math.hypot(moved.x - start.x, moved.z - start.z)).toBeGreaterThan(0.3);
    expect((await inspect()).settings.invertControllerCameraX).toBe(false);
    for (const direction of [1, -1]) {
      expect(await horizontalTurn(direction)).toBeGreaterThan(0);
    }

    const aimingBasis = (await inspect()).moveBasis;
    await pad([0, 0, 1, 0], [6, 7]);
    await ticks(8);
    const aimed = await inspect();
    expect(aimed.moveBasis).toEqual(aimingBasis);
    expect(Math.sin(aimed.snapshot!.player.heading)).toBeCloseTo(aimingBasis.right.x);
    expect(Math.cos(aimed.snapshot!.player.heading)).toBeCloseTo(aimingBasis.right.z);
    expect(attacks(aimed.snapshot!)).toBeGreaterThan(0);
    await pad();
    await tap(8);
    expect((await inspect()).overlay).toBe("map");
    const mapTick = (await inspect()).snapshot!.tick;
    await frames(4);
    expect((await inspect()).snapshot!.tick).toBe(mapTick);
    await capture("controller-atlas");
    await tap(1);
    expect((await inspect()).running).toBe(true);
    await tap(12);
    expect((await inspect()).overlay).toBe("journal");
    await tap(1);
    await tap(9);
    expect((await inspect()).overlay).toBe("pause");
    await capture("controller-pause");
    await tap(9);
    expect((await inspect()).running).toBe(true);
  }, 120_000);

  it("applies optional horizontal camera inversion from Settings and keeps it after reloading", async () => {
    const runId = (await inspect()).snapshot!.runId;
    await tap(9);
    await activate('[data-action="open-settings"]');
    await activate('[data-controller-key="setting:invertControllerCameraX"]');
    expect((await inspect()).settings.invertControllerCameraX).toBe(true);
    expect(await evaluate(cdp, "document.querySelector('[data-controller-key=\"setting:invertControllerCameraX\"]').checked")).toBe(true);
    expect(await evaluate(cdp, `JSON.parse(localStorage.getItem(${JSON.stringify(storageKeys.settings)})).invertControllerCameraX`)).toBe(true);
    await tap(1);
    await tap(9);
    expect((await inspect()).running).toBe(true);
    for (const direction of [1, -1]) {
      expect(await horizontalTurn(direction)).toBeLessThan(0);
    }
    const aimingBasis = (await inspect()).moveBasis;
    await pad([0, 0, 1, 0], [6]);
    await ticks(8);
    const aimed = await inspect();
    expect(aimed.moveBasis).toEqual(aimingBasis);
    expect(Math.sin(aimed.snapshot!.player.heading)).toBeCloseTo(aimingBasis.right.x);
    expect(Math.cos(aimed.snapshot!.player.heading)).toBeCloseTo(aimingBasis.right.z);
    await pad();
    await tap(9);
    await reloadTestPage(cdp);
    await frames();
    expect((await inspect()).settings.invertControllerCameraX).toBe(true);
    await activate('[data-action="continue"]');
    expect((await inspect()).snapshot!.runId).toBe(runId);
    expect((await inspect()).running).toBe(true);
  }, 120_000);

  it("pauses on disconnect, rearms on neutral and cannot leak UI confirmation or held attack", async () => {
    await pad([0, 0, 0, 0], [7]);
    await ticks(2);
    await pad([0, 0, 0, 0], [7], false);
    expect((await inspect()).overlay).toBe("pause");
    expect((await inspect()).running).toBe(false);
    await pad([0, 0, 0, 0], [7], true);
    expect((await inspect()).controller.armed).toBe(false);
    await pad();
    expect((await inspect()).controller.armed).toBe(true);
    await focus('[data-action="resume"]');
    const before = attacks((await inspect()).snapshot!);
    await pad([0, 0, 0, 0], [0, 7]);
    await ticks(12);
    expect((await inspect()).controller.armed).toBe(false);
    expect(attacks((await inspect()).snapshot!)).toBe(before);
    await pad();
    await pad([0, 0, 0, 0], [7]);
    await until(cdp, "window.korovany.inspect().snapshot", (snapshot: GameSnapshot) => attacks(snapshot) > before, 20_000);
    await pad();
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyW", key: "w" });
    expect((await inspect()).controller.active).toBe(false);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyW", key: "w" });
    await tap(9);
    expect((await inspect()).controller.active).toBe(true);
    expect((await inspect()).overlay).toBe("pause");
    await tap(9);
    await pad([0, -1, 0, 0], [7]);
    await evaluate(cdp, "window.dispatchEvent(new Event('blur'))");
    expect((await inspect()).overlay).toBe("pause");
    const paused = (await inspect()).snapshot!;
    await evaluate(cdp, "window.dispatchEvent(new Event('focus'))");
    await frames(3);
    expect((await inspect()).controller.armed).toBe(false);
    expect((await inspect()).snapshot!.tick).toBe(paused.tick);
    await pad();
    await tap(9);
    await ticks(4);
    const resumed = (await inspect()).snapshot!;
    expect(resumed.player.x).toBeCloseTo(paused.player.x, 4);
    expect(resumed.player.z).toBeCloseTo(paused.player.z, 4);
    expect(attacks(resumed)).toBe(attacks(paused));
    await tap(9);
  }, 90_000);

  it("opens dialogue with X and selects/backtracks responses without unpausing combat", async () => {
    const game = createCampaign({ seed: "controller-dialogue", faction: "elf", runId: "controller-dialogue" });
    const npc = game.snapshot().narrative!.npcs.find(person => person.id === "toman")!;
    expect(npc).toBeDefined();
    new CampaignDriver(game).walk(npc, 0.2);
    await evaluate(cdp, `localStorage.setItem(${JSON.stringify(storageKeys.campaign)},${JSON.stringify(JSON.stringify(game.serialize()))})`);
    await reloadTestPage(cdp);
    await frames();
    await activate('[data-action="continue"]');
    await until(cdp, "window.korovany.inspect().snapshot.narrative.interaction?.kind === 'talk'", Boolean, 20_000);
    await tap(2);
    expect((await inspect()).overlay).toBe("dialogue");
    const before = (await inspect()).snapshot!;
    await frames(4);
    expect((await inspect()).snapshot!.tick).toBe(before.tick);
    await focus(".dialogue-choice:not(:disabled)");
    await capture("controller-dialogue");
    await tap(0);
    const after = await inspect();
    expect(after.snapshot!.player.hp).toBe(before.player.hp);
    expect(after.running).toBe(false);
    await tap(1);
    expect((await inspect()).running).toBe(true);
  }, 90_000);

  it("cancels campaign replacement in an in-game confirmation without a native dialog", async () => {
    await tap(9);
    await activate('[data-action="title"]');
    expect((await inspect()).overlay).toBe("menu");
    const run = (await inspect()).snapshot!.runId;
    await activate('[data-action="start"]');
    expect(await evaluate(cdp, "Boolean(document.querySelector('[role=alertdialog]'))")).toBe(true);
    await capture("controller-confirmation");
    await tap(1);
    expect((await inspect()).snapshot!.runId).toBe(run);
    expect((await inspect()).overlay).toBe("menu");
    expect(await evaluate(cdp, "Boolean(document.querySelector('[role=alertdialog]'))")).toBe(false);
  }, 90_000);

  it("keeps controller recovery navigation available without restarting failed rendering", async () => {
    await evaluate(cdp, `(() => {
      const extension=document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context');
      if(!extension) throw new Error('Context-loss testing unavailable');
      extension.loseContext();
    })()`);
    await until(cdp, "window.korovany.inspect().overlay", (overlay: string) => overlay === "fatal", 15_000);
    const before = (await inspect()).snapshot!.tick;
    await pad();
    await focus('.fatal-panel [data-action="reload"]');
    await frames(4);
    expect((await inspect()).running).toBe(false);
    expect((await inspect()).snapshot!.tick).toBe(before);
    expect(await evaluate(cdp, "document.activeElement.matches('[data-action=reload]')")).toBe(true);
    await capture("controller-recovery");
  }, 45_000);
});
