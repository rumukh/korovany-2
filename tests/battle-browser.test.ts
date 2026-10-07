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
  settings: { battleDifficulty: string; battleLatency: number; battleHints: boolean };
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
   * Meanwhile the hero covers the convoy on its turns, so the battle lasts. `ready` is a further page condition. */
  async function incoming(ready = "true"): Promise<{ action: number; index: number }> {
    return until<{ action: number; index: number }>(cdp, `(() => {
      const battle = window.korovany.inspect().snapshot.battle;
      if (!battle) throw new Error('The battle ended first');
      if (battle.phase === 'command') { document.querySelector('[data-controller-key="battle-command:protect"]')?.click(); return null; }
      const hit = battle.action?.hits.find(h => h.target === 'hero' && h.outcome === 'pending' && h.pressed === null &&
        h.impact - battle.tick <= 24 && h.impact - battle.tick >= 14);
      return hit && (${ready}) ? { action: battle.action.id, index: hit.index } : null;
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
    // The battle HUD replaces the road panels and the minimap; the battlefield's centre stays clear for clicks.
    expect(await evaluate(cdp, "[document.querySelector('.hud-top').hidden, document.querySelector('.minimap').hidden]")).toEqual([true, true]);
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
    expect(await evaluate(cdp, "document.querySelector('.battle-banner').textContent")).toBe("First strike! You act first.");
    expect(await evaluate(cdp, "document.elementFromPoint(innerWidth / 2, innerHeight / 2) === document.querySelector('canvas.world')")).toBe(true);
    await capture("battle-command-en");
    // 1 picks Attack; with one enemy no target is asked for.
    await tap("Digit1");
    await until(cdp, "window.korovany.inspect().snapshot.battle?.action?.move", (move: string) => move === "attack", 30_000);
    // E answers an incoming blow with a parry; a right click on the world, with a dodge. The defence guide explains them.
    const parried = await incoming("document.querySelector('.defend-how') !== null");
    await tap("KeyE");
    // The defence cue shows the blow coming, the keys that answer it and (hints are on by default) the success bands.
    const cue = await evaluate<{ hidden: boolean; live: boolean; keys: string; band: number; panel: string }>(cdp, `(() => {
      const cue = document.querySelector('.battle-cue');
      return { hidden: cue.hidden, live: cue.classList.contains('live'), keys: cue.querySelector('.cue-keys').textContent,
        band: Number(cue.querySelector('.zone.parry').getAttribute('stroke-width')),
        panel: document.querySelector('.battle-actions-panel .battle-prompt').textContent };
    })()`);
    expect(cue).toMatchObject({ hidden: false, live: true, panel: "Enemy turn" });
    expect(cue.keys).toMatch(/E.*Parry.*Q.*Dodge/s);
    expect(cue.band).toBeGreaterThan(0);
    expect(await reaction(parried)).toBe("parry");
    // Every blow reports what it came to.
    expect(await until(cdp, "[...document.querySelectorAll('.cue-feedback li strong')].map(node => node.textContent).find(text => /^(PARRIED|HIT −\\d+)$/.test(text)) ?? null",
      (text: string | null) => text !== null, 30_000)).toMatch(/^(PARRIED|HIT −\d+)$/);
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
    expect(await evaluate(cdp, "[document.querySelector('.hud-top').hidden, document.querySelector('.minimap').hidden]")).toEqual([false, false]);
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
      document.querySelector('[data-controller-key="setting:battleHints"]').click();
    })()`);
    expect((await inspect()).settings).toMatchObject({ battleDifficulty: "story", battleLatency: 3, battleHints: false });
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

  it("reports every blow and cues the blow a press would answer, from real engine battles driven tick by tick", async () => {
    type Outcome = { popups: string[][]; cues: { tick: number; mark: string; parry: boolean; dodge: boolean; next: number }[]; impacts: number[] };
    const run = (move: string, presses: Record<number, string>, options: { stale?: number; latency?: number } = {}): Promise<Outcome> =>
      evaluate<Outcome>(cdp, `(async () => {
        const { BattleHud } = await import('/src/ui/battle-hud.ts');
        const { startBattle, battleSnapshot, tickBattle, commandBattle } = await import('/src/game/battle/index.ts');
        const names = { hero: { en: 'You', ru: 'Вы' }, soldier: { en: 'Soldier', ru: 'Солдат' } };
        const view = state => ({ ...battleSnapshot(state), names });
        // Plays to the soldier's first ${JSON.stringify(move)} (seeds tried in turn); the hero attacks on its turns.
        const toMove = state => {
          for (let i = 0; i < 2000; i++) {
            if (state.phase === 'command') commandBattle(state, { type: 'attack', target: 'soldier' });
            else if (state.action?.actor === 'soldier' && state.action.hits.length) return state.action.move === ${JSON.stringify(move)};
            else tickBattle(state, {});
            if (state.phase === 'victory' || state.phase === 'defeat') return false;
          }
          return false;
        };
        let state = null;
        for (let seed = 0; seed < 300 && !state; seed++) {
          const candidate = startBattle({ seed, faction: 'guard', enemies: [{ id: 'soldier', kind: 'soldier' }], opening: 'ambushed',
            latencyTicks: ${options.latency ?? 0} });
          if (toMove(candidate)) state = candidate;
        }
        if (!state) throw new Error('No battle opens with ${move}');
        const impacts = state.action.hits.map(hit => hit.impact);
        const hud = new BattleHud(() => {});
        const views = [view(state)];
        hud.update(views[0], 'en', false, true, 0);
        hud.frame(views[0], 0);
        const cues = [];
        const presses = ${JSON.stringify(presses)};
        const action = state.action.id;
        for (let i = 0; i < 400 && state.action?.id === action; i++) {
          const kind = presses[state.now + 1 - impacts[0]];
          if (kind) hud.press(kind);
          tickBattle(state, kind ? { [kind]: true } : {});
          const current = view(state);
          views.push(current);
          hud.frame(current, 0);
          // The shell refreshes the panels about every sixth frame, and on a save or a pause with the snapshot it last
          // refreshed with, which may be some ticks old.
          if (state.now - impacts[0] === ${options.stale ?? -999}) hud.update(views[views.length - 5], 'en', false, true, 0);
          else if (state.now % 6 === 0) hud.update(current, 'en', false, true, 0);
          const next = hud.root.querySelector('.ring.next');
          cues.push({ tick: state.now - impacts[0], mark: hud.root.querySelector('.mark').textContent,
            parry: hud.root.querySelector('.cue-key.parry').classList.contains('open'),
            dodge: hud.root.querySelector('.cue-key.dodge').classList.contains('open'),
            next: next ? Number(next.getAttribute('r')) : -1 });
        }
        // Late presses may still arrive after the move: the grace period runs out.
        for (let i = 0; i < 30; i++) {
          tickBattle(state, {});
          hud.frame(view(state), 0);
        }
        const popups = [...hud.root.querySelectorAll('.cue-feedback li')].map(item => [...item.children].map(node => node.textContent));
        return { popups, cues, impacts: impacts.map(impact => impact - impacts[0]) };
      })()`);
    // A blow nobody answers says so; a press after it landed corrects that to how late it was.
    expect((await run("cut", {})).popups).toEqual([[expect.stringMatching(/^HIT −\d+$/), "No reaction: E parries, Q dodges"]]);
    expect((await run("cut", { 6: "parry" })).popups).toEqual([[expect.stringMatching(/^HIT −\d+$/), "Too late by 67 ms"]]);
    expect((await run("cut", { [-30]: "dodge" })).popups).toEqual([[expect.stringMatching(/^HIT −\d+$/), "Too early by 333 ms"]]);
    // A dodged first blow is answered: NOW! and the lit keys move on to the second blow instead of lingering.
    const combo = await run("double-cut", { [-1]: "dodge", 23: "parry" }, { stale: 6 });
    expect(combo.impacts).toEqual([0, 24]);
    expect(combo.popups).toEqual([["DODGED"], ["PARRIED", "+1 AP"]]);
    for (const cue of combo.cues.filter(entry => entry.tick >= 0 && entry.tick <= 13)) {
      expect(cue, `tick ${cue.tick}`).toMatchObject({ mark: "", parry: false, dodge: false });
    }
    expect(combo.cues.find(entry => entry.tick === 22)).toMatchObject({ mark: "NOW!", parry: true, dodge: true });
    // With latency compensation a landed blow stays unresolved a while; the cue moves on as soon as its window closes.
    const delayed = await run("double-cut", {}, { latency: 6 });
    const nextRadius = (tick: number): number => delayed.cues.find(entry => entry.tick === tick)!.next;
    expect(nextRadius(2)).toBeLessThan(nextRadius(5));
    expect(delayed.cues.find(entry => entry.tick === 22)).toMatchObject({ parry: true, dodge: true });
    expect(delayed.popups).toEqual([[expect.stringMatching(/^HIT −\d+$/), "No reaction: E parries, Q dodges"],
      [expect.stringMatching(/^HIT −\d+$/), "No reaction: E parries, Q dodges"]]);
  }, 120_000);

  it("chooses targets with number keys, backs out with Escape without pausing, and fights with a controller", async () => {
    await continueBattle(garrison());
    await toCommand();
    await tap("Digit1");
    await until(cdp, "document.querySelector('.battle-prompt')?.textContent ?? ''", (text: string) => text.startsWith("Choose a target"), 10_000);
    const targets = await evaluate<string[]>(cdp, "[...document.querySelectorAll('.battle-controls button')].map(button => button.dataset.controllerKey)");
    expect(targets.filter(key => key.startsWith("battle-target:")).length).toBeGreaterThanOrEqual(3);
    expect(targets.at(-1)).toBe("battle-back");
    // The enemy cards carry the same numbers as the target buttons.
    const numbers = await evaluate<string[]>(cdp, "[...document.querySelectorAll('.battle-enemy.targetable .target-key')].map(key => key.textContent)");
    expect(numbers).toEqual(targets.slice(0, -1).map((_, index) => String(index + 1)));
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
    // RT answers a blow with a parry. The cue shows the controller's buttons; with defence hints turned off in the first
    // test's settings, it shows no bands and the defence guide no explanations.
    const blow = await until<{ action: number; index: number }>(cdp, `(() => {
      const battle = window.korovany.inspect().snapshot.battle;
      if (!battle) throw new Error('The battle ended first');
      const hit = battle.phase === 'action' ? battle.action?.hits.find(h => h.target === 'hero' && h.outcome === 'pending' &&
        h.pressed === null && h.impact - battle.tick <= 24 && h.impact - battle.tick >= 14) : undefined;
      return hit ? { action: battle.action.id, index: hit.index } : null;
    })()`, Boolean, 120_000);
    const cue = await evaluate<{ keys: string[]; how: boolean; band: number }>(cdp, `({
      keys: [...document.querySelectorAll('.cue-key kbd')].map(key => key.textContent),
      how: Boolean(document.querySelector('.defend-how')),
      band: Number(document.querySelector('.zone.parry').getAttribute('stroke-width')),
    })`);
    expect(cue).toEqual({ keys: ["A", "B"], how: false, band: 0 });
    await padTap(7);
    expect(await reaction(blow)).toBe("parry");
    // The game page declares no icon, so the browser's own /favicon.ico request is a 404; nothing may throw.
    expect(cdp.diagnostics.filter(entry => !/status of 404/.test(entry)), JSON.stringify(cdp.diagnostics)).toEqual([]);
  }, 600_000);
});
