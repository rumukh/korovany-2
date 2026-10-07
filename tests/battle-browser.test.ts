import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import {
  click, evaluate, openPage, screenshot, until,
  type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { createCampaign, isWalkable, restoreCampaign, type BattleView, type CampaignSave, type GameSnapshot } from "../src/game";
import { closeTestBrowser, launchTestBrowser } from "./browser-cleanup";
import { navigateTestPage, reloadTestPage } from "./browser-navigation";
import { INSPECT_WITHOUT_WORLD } from "./game-inspect";
import { storageKeys } from "../src/ui/storage";

interface Inspection {
  snapshot: GameSnapshot | null;
  overlay: string | null;
  running: boolean;
  mouseLook: boolean;
  settings: { battleDifficulty: string; battleLatency: number };
  controller: { active: boolean; armed: boolean };
}

type Engine = { entities: { components: { KorovanyCombatant: { id: string; x: number; z: number } } }[];
  resources: { KorovanyCampaign: { battleOptions?: { difficulty: string; latencyTicks: number } } } };

/** A guard campaign saved as its first battle begins: a woodland soldier strayed beside the home camp, struck first. */
function loneSoldier(): CampaignSave {
  const game = createCampaign({ seed: "battle-browser", faction: "guard", runId: "battle-browser" });
  const s = game.snapshot();
  const forward = { x: Math.sin(s.player.heading), z: Math.cos(s.player.heading) };
  const spot = [1.6, 1.9, 2.2, 2.5].map(r => ({ x: s.player.x + forward.x * r, z: s.player.z + forward.z * r }))
    .find(p => isWalkable(s.world, p, 0.7));
  if (!spot) throw new Error("No room beside the camp");
  const save = JSON.parse(JSON.stringify(game.serialize())) as CampaignSave;
  Object.assign((save.engine as Engine).entities.find(e => e.components.KorovanyCombatant.id === "forest-soldier")!.components.KorovanyCombatant, spot);
  const session = restoreCampaign(save);
  session.step({ attack: true, aim: forward });
  if (!session.snapshot().battle) throw new Error("The first strike opened no battle");
  return session.serialize();
}

/** A guard campaign saved as the woodland garrison engages the hero: three enemies to choose from. */
function garrison(): CampaignSave {
  const game = createCampaign({ seed: "battle-browser-garrison", faction: "guard", runId: "battle-browser-garrison" });
  const s = game.snapshot();
  const captain = s.actors.find(a => a.id === "forest-captain")!;
  let spot = null as { x: number; z: number } | null;
  for (let i = 0; i < 72 && !spot; i++) {
    const angle = i / 72 * Math.PI * 2, p = { x: captain.x + Math.sin(angle) * 10, z: captain.z + Math.cos(angle) * 10 };
    if (isWalkable(s.world, p, 0.65)) spot = p;
  }
  const save = JSON.parse(JSON.stringify(game.serialize())) as CampaignSave & { engine: { resources: { KorovanyCampaign: { player: object } } } };
  Object.assign(save.engine.resources.KorovanyCampaign.player, spot);
  const session = restoreCampaign(save);
  for (let i = 0; i < 900 && !session.snapshot().battle; i++) session.step({});
  if ((session.snapshot().battle?.enemies.length ?? 0) < 3) throw new Error("The garrison did not engage together");
  return session.serialize();
}

describe.runIf(process.env.KOROVANY_BROWSER === "1")("turn-based battles in the real game", () => {
  let server: ViteDevServer | undefined;
  let browser: LaunchedBrowser | undefined;
  let cdp: CdpSession;
  let origin: string;
  const captures = process.env.KOROVANY_CAPTURE_DIR;

  const inspect = (): Promise<Inspection> => evaluate(cdp, INSPECT_WITHOUT_WORLD);
  const battle = async (): Promise<BattleView | undefined> => (await inspect()).snapshot?.battle;
  async function capture(name: string): Promise<void> {
    if (captures) await screenshot(cdp, join(captures, `${name}.png`));
  }
  async function press(code: string, down: boolean): Promise<void> {
    const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : code.startsWith("Digit") ? code.slice(5) : code;
    const vk = code.startsWith("Key") ? code.charCodeAt(3) : code.startsWith("Digit") ? 48 + Number(code.slice(5))
      : ({ Escape: 27, Space: 32 }[code] ?? 0);
    await cdp.send("Input.dispatchKeyEvent", { type: down ? "keyDown" : "keyUp", code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
  async function tap(code: string): Promise<void> { await press(code, true); await press(code, false); }
  async function centre(selector: string): Promise<{ x: number; y: number }> {
    return evaluate(cdp, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
  }
  async function clickSelector(selector: string): Promise<void> {
    const point = await centre(selector);
    await click(cdp, point.x, point.y);
  }
  async function frames(count = 2): Promise<void> {
    await evaluate(cdp, `new Promise((resolve, reject) => {
      let remaining = ${count};
      const timeout = setTimeout(() => reject(new Error('Game RAF stalled')), 15000);
      const next = () => { if (--remaining === 0) { clearTimeout(timeout); resolve(null); } else requestAnimationFrame(next); };
      requestAnimationFrame(next);
    })`);
  }
  async function pad(down: number[] = []): Promise<void> {
    await evaluate(cdp, `window.testPad = { index: 0, id: 'Korovany virtual Xbox', mapping: 'standard', connected: true,
      axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ value: ${JSON.stringify(down)}.includes(i) ? 1 : 0,
        pressed: ${JSON.stringify(down)}.includes(i) })) }`);
    await frames();
  }
  async function padTap(button: number): Promise<void> { await pad([button]); await pad(); }
  /** Loads a saved campaign that is in a battle and continues it from the title. */
  async function continueBattle(save: CampaignSave): Promise<void> {
    await evaluate(cdp, `localStorage.setItem(${JSON.stringify(storageKeys.campaign)}, ${JSON.stringify(JSON.stringify(save))})`);
    await reloadTestPage(cdp);
    await until(cdp, "Boolean(window.korovany) && window.korovany.inspect().overlay === 'menu' && window.korovany.inspect().controller.armed", Boolean, 45_000);
    await clickSelector('[data-action="continue"]');
    await until(cdp, "window.korovany.inspect().running && Boolean(window.korovany.inspect().snapshot?.battle)", Boolean, 60_000);
  }
  const toCommand = (): Promise<unknown> =>
    until(cdp, "window.korovany.inspect().snapshot.battle?.phase", (phase: string | undefined) => phase === "command", 120_000);
  /** Waits for a blow aimed at the hero that lands in 14-24 ticks: a press then binds to it however slowly frames arrive.
   * Meanwhile the hero covers the convoy on its turns, so the battle lasts. */
  async function incoming(): Promise<{ action: number; index: number }> {
    return until<{ action: number; index: number }>(cdp, `(() => {
      const battle = window.korovany.inspect().snapshot.battle;
      if (!battle) throw new Error('The battle ended first');
      if (battle.phase === 'command') { document.querySelector('[data-controller-key="battle-command:protect"]')?.click(); return null; }
      const hit = battle.action?.hits.find(h => h.target === 'hero' && h.outcome === 'pending' && h.pressed === null &&
        h.impact - battle.tick <= 24 && h.impact - battle.tick >= 14);
      return hit ? { action: battle.action.id, index: hit.index } : null;
    })()`, Boolean, 120_000);
  }
  async function reaction(blow: { action: number; index: number }): Promise<string | null> {
    return until<string | null>(cdp, `(() => {
      const action = window.korovany.inspect().snapshot.battle?.action;
      const hit = action?.id === ${blow.action} ? action.hits.find(h => h.index === ${blow.index}) : undefined;
      return hit?.pressed !== null && hit?.pressed !== undefined ? hit.reaction : action?.id === ${blow.action} ? null : 'gone';
    })()`, Boolean, 30_000);
  }

  beforeAll(async () => {
    if (captures) await mkdir(captures, { recursive: true });
    server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error("Vite did not expose a local URL.");
    origin = url;
    browser = await launchTestBrowser({ viewport: { width: 960, height: 640 } });
    cdp = await openPage(browser.port, "about:blank", { width: 960, height: 640 });
    // Bound SwiftShader pixel cost for input timing while preserving the full CSS layout.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 640, deviceScaleFactor: 0.5, mobile: false });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.testPad = { index: 0, id: 'Korovany virtual Xbox', mapping: 'standard', connected: true,
        axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })) };
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => window.testPad.connected ? [window.testPad] : [] });
      if (location.protocol === 'http:' && !localStorage.getItem(${JSON.stringify(storageKeys.settings)})) {
        localStorage.setItem(${JSON.stringify(storageKeys.settings)}, JSON.stringify({ language: 'en', quality: 'low', reducedMotion: true, muted: true }));
      }
    ` });
    await navigateTestPage(cdp, origin, "window.korovany && window.korovany.inspect().controller.armed", 45_000);
  }, 90_000);

  afterAll(async () => {
    cdp?.close();
    try { if (browser) await closeTestBrowser(browser); }
    finally { await server?.close(); }
  }, 60_000);

  it("plays a battle by keyboard and mouse: commands, parries, dodges, victory and back to the road", async () => {
    await continueBattle(loneSoldier());
    await until(cdp, "!document.querySelector('.battle-hud').hidden && document.querySelector('.hud-bottom').hidden", Boolean, 10_000);
    let state = await inspect();
    expect(state.mouseLook).toBe(false);
    expect(await evaluate(cdp, "document.pointerLockElement")).toBeNull();
    await toCommand();
    state = await inspect();
    expect(state.snapshot!.battle!.opening).toBe("first-strike");
    const commands = await evaluate<string[]>(cdp,
      "[...document.querySelectorAll('.battle-controls button')].map(button => button.dataset.controllerKey)");
    expect(commands).toEqual(["battle-command:attack", "battle-command:shield-bash", "battle-command:bulwark", "battle-command:protect",
      "battle-command:tonic"]);
    expect(await evaluate(cdp, "document.querySelector('.battle-hud').innerText")).toContain("Your turn");
    await capture("battle-command-en");
    // 1 picks Attack; with one enemy no target is asked for.
    await tap("Digit1");
    await until(cdp, "window.korovany.inspect().snapshot.battle?.action?.move", (move: string) => move === "attack", 30_000);
    // E answers an incoming blow with a parry; a right click on the world, with a dodge.
    const parried = await incoming();
    await tap("KeyE");
    expect(await reaction(parried)).toBe("parry");
    const blow = await incoming();
    const point = await evaluate<{ x: number; y: number }>(cdp, "({ x: innerWidth / 2, y: innerHeight / 3 })");
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "right", buttons: 2, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "right", buttons: 0, clickCount: 1 });
    expect(await reaction(blow)).toBe("dodge");
    await capture("battle-reaction-en");
    // The rest by mouse: Attack on every turn until the soldier falls.
    const kills = (await inspect()).snapshot!.player.kills;
    for (let turn = 0; turn < 40 && await battle(); turn++) {
      const phase = await until(cdp, "window.korovany.inspect().snapshot.battle?.phase ?? 'over'", (value: string) => value !== "action", 120_000);
      if (phase === "command") await clickSelector('[data-controller-key="battle-command:attack"]');
      await frames(3);
    }
    state = await inspect();
    expect(state.snapshot!.battle).toBeUndefined();
    expect(state.snapshot!.player.kills).toBe(kills + 1);
    expect(state.snapshot!.events.some(event => event.key === "event.battleWon")).toBe(true);
    await until(cdp, "document.querySelector('.battle-hud').hidden && !document.querySelector('.hud-bottom').hidden", Boolean, 10_000);
    // The road again: a click on the world captures the mouse.
    await click(cdp, point.x, point.y);
    await until(cdp, "document.pointerLockElement === document.querySelector('canvas.world')", Boolean, 10_000);
    // Battle settings reach the campaign (for the next battle) and its save.
    await tap("Escape");
    await until(cdp, "window.korovany.inspect().overlay", (overlay: string) => overlay === "pause", 10_000);
    await clickSelector('[data-action="open-settings"]');
    await evaluate(cdp, `(() => {
      const select = document.querySelector('[data-controller-key="setting:battleDifficulty"]');
      select.value = 'story';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const latency = document.querySelector('[data-controller-key="setting:battleLatency"]');
      latency.value = '3';
      latency.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    expect((await inspect()).settings).toMatchObject({ battleDifficulty: "story", battleLatency: 3 });
    await tap("Escape");
    await clickSelector('[data-action="resume"]');
    await until(cdp, "window.korovany.inspect().running", Boolean, 10_000);
    await tap("Escape");
    await until(cdp, "window.korovany.inspect().overlay", (overlay: string) => overlay === "pause", 10_000);
    const saved = await evaluate<{ engine: Engine }>(cdp, `JSON.parse(localStorage.getItem(${JSON.stringify(storageKeys.campaign)}))`);
    expect(saved.engine.resources.KorovanyCampaign.battleOptions).toEqual({ difficulty: "story", latencyTicks: 3 });
    // The game page declares no icon, so the browser's own /favicon.ico request is a 404; nothing may throw.
    expect(cdp.diagnostics.filter(entry => !/status of 404/.test(entry)), JSON.stringify(cdp.diagnostics)).toEqual([]);
  }, 600_000);

  it("chooses targets with number keys, backs out with Escape without pausing, and fights with a controller", async () => {
    await continueBattle(garrison());
    await toCommand();
    await tap("Digit1");
    await until(cdp, "document.querySelector('.battle-prompt')?.textContent ?? ''", (text: string) => text.startsWith("Choose a target"), 10_000);
    const targets = await evaluate<string[]>(cdp, "[...document.querySelectorAll('.battle-controls button')].map(button => button.dataset.controllerKey)");
    expect(targets.filter(key => key.startsWith("battle-target:")).length).toBeGreaterThanOrEqual(3);
    expect(targets.at(-1)).toBe("battle-back");
    await capture("battle-targets-en");
    await tap("Escape");
    await frames(3);
    let state = await inspect();
    expect(state.overlay).toBeNull();
    expect(state.running).toBe(true);
    expect(await evaluate(cdp, "document.querySelector('.battle-prompt').textContent")).toBe("Your turn");
    // A controller: A on the focused Attack asks for a target, B backs out, A and A strike the first target.
    await padTap(0);
    await until(cdp, "window.korovany.inspect().controller.active", Boolean, 10_000);
    await until(cdp, "document.querySelector('.battle-prompt')?.textContent ?? ''", (text: string) => text.startsWith("Choose a target"), 10_000);
    expect(await evaluate(cdp, "document.querySelector('.battle-hint').textContent")).toContain("D-pad");
    await padTap(1);
    await until(cdp, "document.querySelector('.battle-prompt')?.textContent ?? ''", (text: string) => text === "Your turn", 10_000);
    state = await inspect();
    expect(state.overlay).toBeNull();
    await padTap(0);
    await until(cdp, "document.querySelector('.battle-prompt')?.textContent ?? ''", (text: string) => text.startsWith("Choose a target"), 10_000);
    const first = targets[0]!.slice("battle-target:".length);
    await padTap(0);
    await until(cdp, "window.korovany.inspect().snapshot.battle?.action", (action: { actor: string; target: string } | null) =>
      action?.actor === "hero" && action.target === first, 30_000);
    // RT answers a blow with a parry.
    const blow = await until<{ action: number; index: number }>(cdp, `(() => {
      const battle = window.korovany.inspect().snapshot.battle;
      if (!battle) throw new Error('The battle ended first');
      const hit = battle.phase === 'action' ? battle.action?.hits.find(h => h.target === 'hero' && h.outcome === 'pending' &&
        h.pressed === null && h.impact - battle.tick <= 24 && h.impact - battle.tick >= 14) : undefined;
      return hit ? { action: battle.action.id, index: hit.index } : null;
    })()`, Boolean, 120_000);
    await padTap(7);
    expect(await reaction(blow)).toBe("parry");
    // The game page declares no icon, so the browser's own /favicon.ico request is a 404; nothing may throw.
    expect(cdp.diagnostics.filter(entry => !/status of 404/.test(entry)), JSON.stringify(cdp.diagnostics)).toEqual([]);
  }, 600_000);
});
