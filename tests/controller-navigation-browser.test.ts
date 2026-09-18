import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createCampaign, type GameSnapshot } from "../src/game";
import { FactionStoryDriver } from "./faction-driver";
import { closeTestBrowser } from "./browser-cleanup";
import {
  click, evaluate, launchBrowser, openPage, type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";

describe.runIf(process.env.KOROVANY_BROWSER === "1")("controller-owned DOM navigation in Chromium", () => {
  let server: ViteDevServer | undefined;
  let browser: LaunchedBrowser | undefined;
  let cdp: CdpSession;
  const snapshot = createCampaign({ faction: "guard", seed: "controller-ui" }).snapshot();
  const run = <T = unknown>(body: string) => evaluate<T>(cdp, `(() => { ${body} })()`);
  const active = () => run<string>("return document.activeElement?.dataset.controllerKey || document.activeElement?.dataset.action || document.activeElement?.className;");
  const focus = (selector: string) => run(`document.querySelector(${JSON.stringify(selector)}).focus();`);
  const frame = (value: object = {}, dt = 1 / 60) => run<boolean>(`return window.ui.frame(${JSON.stringify(value)}, ${dt});`);
  const tap = async (value: object) => { await frame(); return frame(value); };

  async function key(code: string, shift = false): Promise<void> {
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", { type, code, key: code,
        windowsVirtualKeyCode: ({ Tab: 9, Escape: 27, Enter: 13, Space: 32 } as Record<string, number>)[code],
        modifiers: shift ? 8 : 0 });
    }
  }

  async function clickControl(selector: string): Promise<void> {
    const point = await run<{ x: number; y: number }>(`
      const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({block: 'center'});
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    `);
    await click(cdp, point.x, point.y);
  }

  async function install(next: GameSnapshot | null = snapshot, controller = true): Promise<void> {
    await evaluate(cdp, `(async () => {
      window.ui?.shell.dispose();
      const [{ GameShell }, { defaultSettings }, { createProfile }] = await Promise.all([
        import('/src/ui/shell.ts'), import('/src/ui/storage.ts'), import('/src/game/index.ts'),
      ]);
      const state = { settings: { ...defaultSettings(), language: 'en' }, faction: 'guard', seed: 'ready-seed',
        hasSave: true, profile: createProfile(), offers: [], rewardSaved: true };
      const actions = [];
      const feedback = { active: ${controller}, connected: ${controller}, armed: ${controller}, audioLocked: false, status: ${JSON.stringify(controller ? "ready" : "no-device")} };
      let shell;
      shell = new GameShell(document.querySelector('#app'), state, action => {
        actions.push(action);
        if (action.type === 'settings') {
          const languageChanged = state.settings.language !== action.settings.language;
          const next = { ...state, settings: action.settings };
          shell.setState(next, languageChanged);
          Object.assign(state, next);
        }
        if (action.type === 'faction') {
          const next = { ...state, faction: action.faction };
          shell.setState(next); Object.assign(state, next);
        }
        if (action.type === 'randomSeed') {
          const next = { ...state, seed: 'fresh-seed' };
          shell.setState(next); Object.assign(state, next);
        }
        if (action.type === 'overlay') shell.show(action.overlay);
        if (action.type === 'resume') shell.show(null);
        if (action.type === 'start') shell.confirm('overwrite', () => { window.ui.confirmed++; });
      });
      const neutral = { moveX: 0, moveY: 0, scrollX: 0, scrollY: 0, confirm: false, cancel: false, pause: false, map: false, journal: false };
      window.ui = { shell, state, actions, feedback, confirmed: 0,
        frame: (frame = {}, dt = 1/60) => shell.handleController({ ...neutral, ...frame }, dt),
        show: overlay => { shell.show(overlay); shell.handleController(neutral, 1/60); },
        feedback: value => { Object.assign(feedback, value); shell.updateController(feedback); },
      };
      ${next ? `shell.update(${JSON.stringify(next)});` : ""}
      shell.updateController(feedback);
      shell.handleController(neutral, 1/60);
    })()`);
  }

  beforeAll(async () => {
    server = await createServer({
      configFile: false, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
      plugins: [{
        name: "controller-shell-fixture",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== "/__controller-shell") return next();
            response.setHeader("Content-Type", "text/html");
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error("Controller test server unavailable");
    expect((await fetch(`${origin}__controller-shell`)).ok).toBe(true);
    // Keep the launcher's system-temp profile: deep TMPDIR paths break Chromium's Unix sockets.
    browser = await launchBrowser({ viewport: { width: 1280, height: 800 } });
    cdp = await openPage(browser.port, `${origin}__controller-shell`, { width: 1280, height: 800 });
  }, 60_000);

  beforeEach(async () => { await install(); });

  afterAll(async () => {
    cdp?.close();
    try { if (browser) await closeTestBrowser(browser); }
    finally { await server?.close(); }
  }, 60_000);

  it("repeats deliberately, skips disabled/hidden controls and reveals focused items", async () => {
    const result = await evaluate<{
      controls: string[]; first: string; delayed: string; repeated: string; next: string; scrolled: number; disabled: number;
    }>(cdp, `(async () => {
      const { ControllerNavigation, controllerControls } = await import('/src/ui/controller-navigation.ts');
      const root = document.createElement('section');
      root.style.cssText = 'position:fixed;inset:0 auto auto 0;width:300px;height:120px;overflow:auto;z-index:100;background:black';
      root.innerHTML = '<button id="a">a</button><button disabled>disabled</button><button hidden>hidden</button>' +
        '<fieldset disabled><button>fieldset disabled</button></fieldset><details><summary id="summary">details</summary><button>closed detail</button></details>' +
        '<button style="visibility:hidden">invisible</button><div style="height:500px"></div><button id="b">b</button>';
      document.body.append(root);
      let disabled = 0;
      root.querySelectorAll('button:not([id])').forEach(button => button.onclick = () => disabled++);
      const nav = new ControllerNavigation();
      const neutral = {moveX:0,moveY:0,scrollX:0,scrollY:0,confirm:false,cancel:false,pause:false,map:false,journal:false};
      const down = {...neutral,moveY:1};
      root.querySelector('#a').focus();
      const controls = controllerControls(root).map(node => node.id);
      nav.handle(root, down, .016);
      const first = document.activeElement.id;
      for (let i=0;i<3;i++) nav.handle(root, down, .1);
      const delayed = document.activeElement.id;
      nav.handle(root, down, .1);
      const repeated = document.activeElement.id, scrolled = root.scrollTop;
      nav.handle(root, neutral, .016);
      nav.handle(root, down, .016);
      const next = document.activeElement.id;
      root.remove();
      return {controls,first,delayed,repeated,next,scrolled,disabled};
    })()`);
    expect(result).toMatchObject({ controls: ["a", "summary", "b"], first: "summary", delayed: "summary", repeated: "b", next: "a", disabled: 0 });
    expect(result.scrolled).toBeGreaterThan(300);
  });

  it("keeps title faction/language/summary focus and leaves seed editing to a keyboard", async () => {
    await focus('[data-faction="villain"]');
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return document.activeElement.dataset.faction;")).toBe("villain");
    expect(await run("return window.ui.state.faction;")).toBe("villain");
    await focus(".campaign-equipment summary");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return document.querySelector('.campaign-equipment').open;")).toBe(true);
    await focus(".language-button");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await active()).toBe("language-button");
    expect(await run("return document.documentElement.lang;")).toBe("ru");
    expect(await run("return document.querySelector('.campaign-equipment').open;")).toBe(true);
    await focus("#atlas-seed");
    expect(await tap({ confirm: true })).toBe(false);
    expect(await run("return window.ui.state.seed;")).toBe("ready-seed");
    await focus('[data-action="randomSeed"]');
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return window.ui.state.seed;")).toBe("fresh-seed");
    expect(await run("return document.activeElement.dataset.action;")).toBe("randomSeed");
  });

  it("changes settings through real handlers, preserving mix values, focus and keyboard input", async () => {
    await run("window.ui.show('settings'); window.ui.keyboardEvents = 0; window.addEventListener('keydown', () => window.ui.keyboardEvents++);");
    await focus('[data-controller-key="setting:language"]');
    expect(await tap({ moveX: -1 })).toBe(true);
    expect(await active()).toBe("setting:language");
    expect(await run("return window.ui.state.settings.language;")).toBe("ru");
    await focus('[data-controller-key="setting:quality"]');
    expect(await tap({ moveX: 1 })).toBe(true);
    expect(await run("return window.ui.state.settings.quality;")).toBe("low");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return window.ui.state.settings.quality;")).toBe("high");
    await focus('[data-controller-key="setting:muted"]');
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return window.ui.state.settings.muted;")).toBe(true);
    await focus('[data-controller-key="setting:reducedMotion"]');
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return window.ui.state.settings.reducedMotion;")).toBe(true);
    await focus('[data-audio-channel="music"]');
    const before = await run<Record<string, number>>("window.ui.slider = document.activeElement; return {...window.ui.state.settings.audio};");
    expect(await tap({ moveX: -1 })).toBe(true);
    const after = await run<Record<string, number>>("return {...window.ui.state.settings.audio};");
    expect(after.music).toBeCloseTo(before.music! - 0.05);
    expect({ ...after, music: before.music }).toEqual(before);
    expect(await run("return document.activeElement === window.ui.slider;")).toBe(true);
    expect(await run("return document.activeElement.getAttribute('aria-valuetext');")).toBe(`${Math.round(after.music! * 100)}%`);
    expect(await run("return window.ui.keyboardEvents;")).toBe(0);
    await key("Tab");
    expect(await run("return document.activeElement.dataset.audioChannel;")).toBe("ambience");
    expect(await tap({ cancel: true })).toBe(true);
    expect(await run("return window.ui.shell.overlay;")).toBe("menu");
  });

  it("owns safe confirmation focus, neutral arming, cancellation and callback boundaries", async () => {
    await focus('[data-action="start"]');
    expect(await tap({ confirm: true })).toBe(true);
    expect(await active()).toBe("cancel-confirmation");
    expect(await run("return document.querySelector('[role=alertdialog]').getAttribute('aria-describedby');")).toBe("confirmation-message");
    expect(await frame({ confirm: true })).toBe(false);
    expect(await run("return window.ui.confirmed;")).toBe(0);
    await frame();
    expect(await frame({ confirm: true })).toBe(true);
    expect(await run("return document.querySelector('.confirmation-host').hidden;")).toBe(true);
    expect(await run("return document.activeElement.dataset.action;")).toBe("start");
    expect(await run("return window.ui.confirmed;")).toBe(0);
    await tap({ confirm: true });
    await tap({ moveX: 1 });
    expect(await active()).toBe("accept-confirmation");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return window.ui.confirmed;")).toBe(1);
    expect(await frame({ confirm: true })).toBe(false);
    for (const button of ["cancel", "pause"]) {
      await tap({ confirm: true });
      expect(await tap({ [button]: true })).toBe(true);
      expect(await run("return window.ui.confirmed;")).toBe(1);
    }
    await run("window.ui.shell.confirm('leaveUnsaved', () => window.ui.confirmed++);");
    await key("Tab", true);
    expect(await active()).toBe("accept-confirmation");
    await key("Tab");
    expect(await active()).toBe("cancel-confirmation");
    await focus('[data-action="start"]');
    expect(await active()).toBe("cancel-confirmation");
    await key("Escape");
    expect(await run("return document.querySelector('.confirmation-host').hidden;")).toBe(true);
    expect(await run("return window.ui.confirmed;")).toBe(1);
    await run("window.ui.shell.confirm('loadLatest', () => window.ui.confirmed++);");
    await key("Enter");
    expect(await run("return document.querySelector('.confirmation-host').hidden;")).toBe(true);
    expect(await run("return window.ui.confirmed;")).toBe(1);
    await run("window.ui.shell.confirm('loadLatest', () => { window.ui.confirmed++; window.ui.shell.confirm('overwrite', () => window.ui.confirmed++); });");
    await clickControl('[data-action="accept-confirmation"]');
    expect(await run("return window.ui.confirmed;")).toBe(2);
    expect(await active()).toBe("cancel-confirmation");
    expect(await frame({ confirm: true })).toBe(false);
    await clickControl('[data-action="cancel-confirmation"]');
    expect(await run("return window.ui.confirmed;")).toBe(2);
    await run(`
      document.querySelector('[data-action="start"]').focus();
      window.ui.shell.confirm('overwrite', () => window.ui.confirmed++);
      const state = {...window.ui.state, settings:{...window.ui.state.settings, language:'ru'}};
      window.ui.shell.setState(state); Object.assign(window.ui.state, state);
    `);
    expect(await active()).toBe("cancel-confirmation");
    expect(await run("return document.querySelector('.confirmation-message').textContent;")).toContain("Начать новый поход");
    await key("Escape");
    expect(await run("return document.activeElement.dataset.action;")).toBe("start");
    expect(await run("return window.ui.confirmed;")).toBe(2);
  });

  it("navigates journal filters/details, atlas destinations/orders and upgrades without hardware sampling", async () => {
    const availableSnapshot = structuredClone(snapshot);
    availableSnapshot.shop[0]!.available = true;
    availableSnapshot.shop[0]!.reason = "ready";
    const place = availableSnapshot.world.exploration!.locations[1]!;
    availableSnapshot.narrative!.discovered.push(place.id);
    availableSnapshot.narrative!.travel = { ...availableSnapshot.narrative!.travel, available: true, reason: null, destinations: [place.id] };
    await install(availableSnapshot);
    await run("window.ui.show('journal');");
    await focus(".quest-filters button:last-child");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return document.activeElement === document.querySelector('.quest-filters button:last-child');")).toBe(true);
    await focus(".quest-entry:last-child");
    const quest = await run("return document.activeElement.dataset.quest;");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return document.activeElement.dataset.quest;")).toBe(quest);
    await frame();
    for (let i = 0; i < 12; i++) expect(await frame({ scrollY: 1 }, 0.1)).toBe(false);
    expect(await run("return document.querySelector('.journal-panel').scrollTop;")).toBeGreaterThan(0);
    expect(await tap({ map: true })).toBe(true);
    expect(await run("return window.ui.shell.overlay;")).toBe("map");
    await focus("#convoy-destination");
    const destination = await run("return document.activeElement.value;");
    expect(await tap({ moveX: 1 })).toBe(true);
    const next = await run("return document.activeElement.value;");
    expect(next).not.toBe(destination);
    await focus(".map-scale");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return document.activeElement.dataset.action;")).toBe("map-scale");
    expect(await run("return document.querySelector('#convoy-destination').value;")).toBe(next);
    await focus(".atlas-sidebar > .primary");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return window.ui.actions.at(-1);")).toEqual({ type: "convoy", order: { destination: next } });
    await focus(".order-buttons button:nth-child(2)");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return window.ui.actions.at(-1);")).toEqual({ type: "convoy", order: "follow" });
    await focus(".travel-controls button:not(:disabled)");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return window.ui.actions.at(-1);")).toEqual({ type: "narrative", command: { type: "travel", locationId: place.id } });
    await run("window.ui.show('pause');");
    const available = await run<number>("return document.querySelectorAll('[data-action=upgrade]:not(:disabled)').length;");
    expect(available).toBeGreaterThan(0);
    await focus("[data-action=upgrade]:not(:disabled)");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return window.ui.actions.at(-1).type;")).toBe("upgrade");
    await run("window.ui.show('help');");
    expect(await tap({ pause: true })).toBe(true);
    expect(await run("return window.ui.shell.overlay;")).toBe("pause");
    expect(await tap({ pause: true })).toBe(true);
    expect(await run("return window.ui.shell.overlay;")).toBe(null);
  });

  it("handles dialogue, long evidence, terminal and fatal actions with localized prompts", async () => {
    const game = createCampaign({ faction: "guard", seed: "controller-story" });
    const driver = new FactionStoryDriver(game);
    driver.talk("vesk");
    await install(game.snapshot());
    await run("window.ui.show('dialogue');");
    await focus(".dialogue-choice:not(:disabled)");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return window.ui.actions.at(-1).command.type;")).toBe("choose");
    expect(await run("return document.querySelector('.conversation > p.small.muted').textContent;")).toContain("D-pad");
    expect(await tap({ cancel: true })).toBe(true);
    expect(await run("return window.ui.actions.at(-1).command;")).toEqual({ type: "close" });
    const evidence = game.snapshot();
    evidence.narrative!.dialogue = null;
    evidence.narrative!.inspection = {
      locationId: "evidence-test", title: { en: "Evidence", ru: "Улика" },
      text: { en: "An evidence paragraph.\n\n".repeat(60), ru: "Абзац улики.\n\n".repeat(60) },
    };
    await install(evidence);
    await run("window.ui.show('inspection');");
    expect(await active()).toBe("inspection-text");
    expect(await tap({ confirm: true })).toBe(false);
    const initial = await run<number>("return document.querySelector('.inspection-panel').scrollTop;");
    for (let i = 0; i < 12; i++) expect(await frame({ scrollY: 1 }, 0.1)).toBe(false);
    expect(await run<number>("return document.querySelector('.inspection-panel').scrollTop;")).toBeGreaterThan(initial + 300);
    expect(await tap({ cancel: true })).toBe(true);
    expect(await run("return window.ui.actions.at(-1).command;")).toEqual({ type: "close" });
    await run("window.ui.show('terminal');");
    await focus('[data-action="start"]');
    expect(await tap({ confirm: true })).toBe(true);
    expect(await active()).toBe("cancel-confirmation");
    await tap({ cancel: true });
    await run("window.ui.shell.fail('game');");
    expect(await tap({ confirm: true })).toBe(true);
    expect(await run("return window.ui.actions.at(-1);")).toEqual({ type: "reload" });
    await run("window.ui.shell.confirm('overwrite', () => window.ui.confirmed++); window.ui.shell.fail('graphics');");
    expect(await run("return document.querySelector('.confirmation-host').hidden;")).toBe(true);
    expect(await run("return window.ui.confirmed;")).toBe(0);
  });

  it("keeps initial, D-pad and rebuilt dialogue focus inside the visible 960×640 panel", async () => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
    try {
      const game = createCampaign({ faction: "elf", seed: "controller-dialogue-visibility" });
      new FactionStoryDriver(game).talk("toman");
      await install(game.snapshot());
      await run(`
        const state = {...window.ui.state, settings:{...window.ui.state.settings, reducedMotion:true}};
        window.ui.shell.setState(state); Object.assign(window.ui.state, state);
        window.ui.show('dialogue');
      `);
      const visibleFocus = () => run<{ visible: boolean; focused: string; top: number; bottom: number; panelTop: number; panelBottom: number }>(`
        const focused = document.activeElement;
        const panel = document.querySelector('.dialogue-panel');
        const rect = focused.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
        const hint = panel.querySelector('.controller-hints').getBoundingClientRect();
        const top = Math.max(0, bounds.top + panel.clientTop, hint.bottom + 4);
        const bottom = Math.min(innerHeight, bounds.bottom - panel.clientTop);
        return { visible: panel.contains(focused) && rect.top >= top - 1 && rect.bottom <= bottom + 1 &&
          rect.left >= Math.max(0,bounds.left) && rect.right <= Math.min(innerWidth,bounds.right),
          focused: focused.outerHTML.slice(0,180), top:rect.top, bottom:rect.bottom, panelTop:top, panelBottom:bottom };
      `);
      expect(await run("return document.activeElement.matches('.dialogue-choice:not(:disabled)');")).toBe(true);
      let visible = await visibleFocus();
      expect(visible.visible, JSON.stringify(visible)).toBe(true);
      const controls = await run<number>("return document.querySelectorAll('.dialogue-panel button:not(:disabled)').length;");
      for (let index = 0; index < controls; index++) {
        expect(await tap({ moveY: 1 })).toBe(false);
        visible = await visibleFocus();
        expect(visible.visible, JSON.stringify({ index, ...visible })).toBe(true);
      }
      expect(await run("return document.activeElement.matches('.dialogue-choice:not(:disabled)');")).toBe(true);
      const choice = await run("return document.activeElement.dataset.choice;");
      await run(`
        const state = {...window.ui.state, settings:{...window.ui.state.settings, language:'ru'}};
        window.ui.shell.setState(state); Object.assign(window.ui.state, state);
      `);
      expect(await run("return document.activeElement.dataset.choice;")).toBe(choice);
      visible = await visibleFocus();
      expect(visible.visible, JSON.stringify(visible)).toBe(true);
      await frame({ scrollY: -1 }, .1);
      const scroll = await run<number>("return document.querySelector('.dialogue-panel').scrollTop;");
      for (let i = 0; i < 5; i++) await frame();
      expect(await run("return document.querySelector('.dialogue-panel').scrollTop;")).toBe(scroll);
    } finally {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    }
  });

  it("switches hints without rebuilding settings and explains unavailable pads/audio honestly", async () => {
    await install(snapshot, false);
    expect(await run("return document.querySelector('.controller-status').hidden;")).toBe(true);
    await run("window.ui.feedback({status:'blocked'});");
    expect(await run("return document.querySelector('.controller-status').hidden;")).toBe(true);
    await run("window.ui.show('help'); window.ui.feedback({active:false,connected:false,armed:false,status:'blocked'});");
    expect(await run("return document.querySelector('.controller-status').textContent;")).toContain("blocked");
    await run("window.ui.feedback({status:'unsupported'});");
    expect(await run("return document.querySelector('.controller-status').textContent;")).toContain("does not support");
    await run("window.ui.feedback({status:'unsupported-mapping',connected:true});");
    expect(await run("return document.querySelector('.controller-status').textContent;")).toContain("mapping is unsupported");
    await run("window.ui.show('settings'); window.ui.languageSelect = document.querySelector('select'); window.ui.feedback({status:'ready',active:true,connected:true,armed:false,audioLocked:true});");
    expect(await run("return document.querySelector('.controller-status').textContent;")).toContain("Release all");
    expect(await run("return document.querySelector('.controller-status').textContent;")).toContain("real mouse click");
    expect(await tap({ confirm: true })).toBe(false);
    await run("window.ui.feedback({armed:true}); window.ui.feedback({active:false,audioLocked:false});");
    expect(await run("return document.querySelector('select') === window.ui.languageSelect;")).toBe(true);
    expect(await run("return document.querySelector('.controller-hints').hidden;")).toBe(true);
    await run("window.ui.feedback({active:true});");
    expect(await run("return document.querySelector('select') === window.ui.languageSelect;")).toBe(true);
    expect(await run("return document.querySelector('.controller-hints').hidden;")).toBe(false);
    expect(await evaluate(cdp, `(async () => {
      let changes = 0;
      const observer = new MutationObserver(records => changes += records.length);
      observer.observe(document.querySelector('.settings-panel'), {childList:true, attributes:true, subtree:true});
      for (let i=0;i<60;i++) { window.ui.feedback({}); window.ui.frame(); }
      await Promise.resolve(); observer.disconnect(); return changes;
    })()`)).toBe(0);
    await focus('[data-controller-key="setting:language"]');
    await tap({ moveX: -1 });
    await run("window.ui.feedback({audioLocked:true});");
    expect(await run("return document.querySelector('.controller-status').textContent;")).toContain("настоящий щелчок");
    await run("window.ui.show(null);");
    expect(await run("return [...document.querySelectorAll('.action-slot kbd')].map(node => node.textContent);")).toEqual(["RT", "B", "Y"]);
    await run("window.ui.feedback({active:false});");
    expect(await run("return [...document.querySelectorAll('.action-slot kbd')].map(node => node.textContent);")).toEqual(["Пробел", "Q", "F"]);
  });
});
