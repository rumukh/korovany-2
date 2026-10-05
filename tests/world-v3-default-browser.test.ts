import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import {
  click, evaluate, launchBrowser, openPage, until,
  type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { closeTestBrowser } from "./browser-cleanup";
import { reloadTestPage } from "./browser-navigation";
import { createCampaign } from "../src/game";

// W2b: the shell starts new campaigns in world version 3. Saved version 2 campaigns keep their world, and a version 3
// save from an earlier release is refused with its own explanation and kept, never loaded into a rebuilt world.
describe.runIf(process.env.KOROVANY_BROWSER === "1")("new campaigns in world version 3", () => {
  let server: ViteDevServer | undefined;
  let browser: LaunchedBrowser | undefined;
  let cdp: CdpSession;
  // SwiftShader may spend seconds per frame, and a v3 run first loads its world assets.
  const gameplayTimeout = 120_000;

  const settings = (language: "ru" | "en") =>
    JSON.stringify({ language, quality: "low", reducedMotion: true, muted: true });

  async function clickSelector(selector: string): Promise<void> {
    const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)} +
        ' overlay=' + window.korovany.inspect().overlay + ' warnings=' + (document.querySelector('.warnings')?.textContent ?? ''));
      element.scrollIntoView({block: 'center'});
      const rect = element.getBoundingClientRect();
      return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    })()`);
    await click(cdp, point.x, point.y);
  }

  /** Reloads the title with these storage records written before the game reads them. */
  async function reloadWith(records: Record<string, string>): Promise<void> {
    const writes = Object.entries(records).map(([key, value]) => `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
    const script = await cdp.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: writes.join("\n") });
    try {
      await reloadTestPage(cdp, "window.korovany && window.korovany.inspect().overlay === 'menu'", 60_000);
    } finally {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", script);
    }
  }

  interface Run { version: number; id: string; modelled: boolean; tick: number }
  const run = (): Promise<Run | null> => evaluate(cdp, `(() => {
    const snapshot = window.korovany.inspect().snapshot;
    return snapshot && { version: snapshot.world.version, id: snapshot.world.id,
      modelled: snapshot.world.obstacles.some(o => typeof o.model === 'string'), tick: snapshot.tick };
  })()`);
  const stored = (): Promise<string | null> => evaluate(cdp, "localStorage.getItem('korovany2:campaign')");
  const notice = (): Promise<string> => evaluate(cdp, "document.querySelector('.warnings')?.textContent ?? ''");
  const canContinue = (): Promise<boolean> => evaluate(cdp, "Boolean(document.querySelector('[data-action=continue]'))");

  beforeAll(async () => {
    server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error("Vite did not expose a local URL.");
    browser = await launchBrowser({ viewport: { width: 1280, height: 720 } });
    cdp = await openPage(browser.port, origin, { width: 1280, height: 720 });
    await until(cdp, "Boolean(window.korovany)", Boolean, 30_000);
    await reloadWith({ "korovany2.settings.v1": settings("ru") });
  }, 120_000);

  afterAll(async () => {
    cdp?.close();
    try {
      if (browser) await closeTestBrowser(browser);
    } finally {
      await server?.close();
    }
  }, 60_000);

  it("starts a new campaign from the title in world version 3, saves it and continues it", async () => {
    expect(await run()).toBeNull();
    await clickSelector('[data-action="start"]');
    await until(cdp, "window.korovany.inspect().snapshot?.tick ?? 0", (tick: number) => tick > 2, gameplayTimeout);
    const started = await run();
    expect(started?.version).toBe(3);
    expect(started?.id.startsWith("k2-v3-")).toBe(true);
    expect(started?.modelled).toBe(true);
    const save = JSON.parse(await stored() ?? "null") as { version: number; worldId: string } | null;
    expect(save?.version).toBe(3);
    expect(save?.worldId).toBe(started?.id);

    await reloadTestPage(cdp, "window.korovany && window.korovany.inspect().overlay === 'menu'", 60_000);
    expect(await canContinue()).toBe(true);
    await clickSelector('[data-action="continue"]');
    const resumed = await run();
    expect(resumed?.version).toBe(3);
    expect(resumed?.id).toBe(started?.id);
    await until(cdp, "window.korovany.inspect().snapshot.tick", (tick: number) => tick > (resumed?.tick ?? 0) + 2, gameplayTimeout);
  }, 360_000);

  it("continues a saved version 2 campaign in its own world", async () => {
    const legacy = createCampaign({ seed: "w2b-legacy", faction: "elf", runId: "w2b-legacy" });
    const raw = JSON.stringify(legacy.serialize());
    await reloadWith({ "korovany2:campaign": raw });
    expect((await run())?.version).toBe(2);
    await clickSelector('[data-action="continue"]');
    const resumed = await run();
    expect(resumed?.version).toBe(2);
    expect(resumed?.id).toBe(legacy.snapshot().world.id);
    expect(resumed?.modelled).toBe(false);
    await until(cdp, "window.korovany.inspect().snapshot.tick", (tick: number) => tick > (resumed?.tick ?? 0) + 2, gameplayTimeout);
  }, 240_000);

  it("refuses a version 3 save from an earlier release with its own message, keeps it, and starts anew", async () => {
    const save = createCampaign({ seed: "w2b-outdated", faction: "guard", runId: "w2b-outdated", worldVersion: 3 }).serialize();
    const outdated = JSON.stringify({ ...save, worldId: save.worldId.replace(/^k2-v3-[0-9a-f]+/, "k2-v3-0badc0de") });
    await reloadWith({ "korovany2:campaign": outdated, "korovany2.settings.v1": settings("ru") });
    expect(await run()).toBeNull();
    expect(await canContinue()).toBe(false);
    expect(await notice()).toContain("прежней версии мира");
    expect(await notice()).not.toContain("повреждены");
    expect(await stored()).toBe(outdated);

    await reloadWith({ "korovany2.settings.v1": settings("en") });
    expect(await notice()).toContain("earlier version of the world");
    expect(await stored()).toBe(outdated);

    await clickSelector('[data-action="start"]');
    await until(cdp, "window.korovany.inspect().snapshot?.tick ?? 0", (tick: number) => tick > 2, gameplayTimeout);
    const fresh = await run();
    expect(fresh?.version).toBe(3);
    const replaced = JSON.parse(await stored() ?? "null") as { version: number; worldId: string; runId: string } | null;
    expect(replaced?.worldId).toBe(fresh?.id);
    expect(replaced?.runId).not.toBe("w2b-outdated");
  }, 360_000);
});
