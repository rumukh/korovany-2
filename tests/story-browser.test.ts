import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createCampaign, type GameSnapshot } from "../src/game";
import { storageKeys, type Settings } from "../src/ui/storage";
import {
  click, evaluate, launchBrowser, openPage, screenshot, until,
  type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { closeOwnedBrowser } from "../vendor/aegis-engine/packages/render-three/src/testing/browser-lifecycle";

interface Inspection { snapshot: GameSnapshot; overlay: string | null; running: boolean }

describe.runIf(process.env.KOROVANY_BROWSER === "1")("narrative browser integration", () => {
  let server: ViteDevServer;
  let browser: LaunchedBrowser;
  let cdp: CdpSession;

  async function inspect(): Promise<Inspection> {
    return evaluate(cdp, "window.korovany.inspect()");
  }
  async function tap(code: string): Promise<void> {
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", { type, code,
        key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code,
        windowsVirtualKeyCode: code.startsWith("Key") ? code.charCodeAt(3) : code === "Escape" ? 27 : 9 });
    }
  }
  async function select(selector: string): Promise<void> {
    const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
      const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(element => element.getClientRects().length > 0);
      if (!button || button.disabled) throw new Error('Unavailable narrative control: ' + ${JSON.stringify(selector)});
      button.scrollIntoView({block:'center'});
      const rect = button.getBoundingClientRect();
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`);
    await click(cdp, point.x, point.y);
  }
  async function capture(name: string): Promise<void> {
    if (process.env.KOROVANY_CAPTURE_DIR) await screenshot(cdp, join(process.env.KOROVANY_CAPTURE_DIR, `${name}.png`));
  }
  async function reload(): Promise<void> {
    const origin = await evaluate<number>(cdp, "performance.timeOrigin");
    await cdp.send("Page.reload");
    await until(cdp, `performance.timeOrigin !== ${origin} && Boolean(window.korovany) && window.korovany.inspect().overlay === 'menu'`, Boolean, 30_000);
  }

  beforeAll(async () => {
    if (process.env.KOROVANY_CAPTURE_DIR) await mkdir(process.env.KOROVANY_CAPTURE_DIR, { recursive: true });
    server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error("Missing narrative preview URL");
    expect((await fetch(origin)).status).toBe(200);
    browser = await launchBrowser({ viewport: { width: 1440, height: 1000 } });
    cdp = await openPage(browser.port, origin, { width: 1440, height: 1000 });
    await until(cdp, "Boolean(window.korovany)", Boolean, 30_000);
    const save = createCampaign({ seed: "story-browser", faction: "guard", runId: "story-browser-run" }).serialize();
    const settings: Settings = { language: "en", quality: "high", reducedMotion: false, muted: false };
    await evaluate(cdp, `(() => {
      localStorage.setItem(${JSON.stringify(storageKeys.campaign)}, ${JSON.stringify(JSON.stringify(save))});
      localStorage.setItem(${JSON.stringify(storageKeys.settings)}, ${JSON.stringify(JSON.stringify(settings))});
    })()`);
    await reload();
  }, 90_000);

  afterAll(async () => {
    cdp?.close();
    if (browser) {
      await closeOwnedBrowser(browser);
      await rm(browser.profile, { recursive: true, force: true });
    }
    await server?.close();
  }, 30_000);

  it("opens a live NPC conversation, preserves it across reload, and closes without leaking movement", async () => {
    await select('[data-action="continue"]');
    await until(cdp, "Boolean(window.korovany.inspect().snapshot.narrative?.interaction?.kind === 'talk')", Boolean, 20_000);
    const before = await inspect();
    expect(before.snapshot.world.exploration?.regions.length).toBeGreaterThanOrEqual(8);
    expect(before.snapshot.narrative?.npcs.some((npc) => npc.id === before.snapshot.narrative?.interaction?.targetId)).toBe(true);
    await capture("residents-at-roadward");
    await tap("KeyT");
    await until(cdp, "window.korovany.inspect().overlay", (value: string) => value === "dialogue", 15_000);
    const talking = await inspect();
    expect(talking.running).toBe(false);
    expect(talking.snapshot.narrative?.dialogue?.choices.length).toBeGreaterThan(0);
    await capture("conversation-en");
    await tap("KeyW");
    await evaluate(cdp, "new Promise(resolve => setTimeout(resolve, 250))");
    expect((await inspect()).snapshot.tick).toBe(talking.snapshot.tick);
    await reload();
    await select('[data-action="continue"]');
    expect((await inspect()).overlay).toBe("dialogue");
    expect((await inspect()).snapshot.narrative?.dialogue).toEqual(talking.snapshot.narrative?.dialogue);
    await select(".dialogue-choice:not(:disabled)");
    const answered = await inspect();
    expect(answered.overlay).not.toBe("fatal");
    expect(answered.snapshot.player.hp).toBe(talking.snapshot.player.hp);
    if (answered.overlay === "dialogue") await tap("Escape");
    expect((await inspect()).running).toBe(true);
    const position = (await inspect()).snapshot.player;
    await until(cdp, "window.korovany.inspect().snapshot.tick", (tick: number) => tick > talking.snapshot.tick + 5, 20_000);
    expect((await inspect()).snapshot.player.x).toBe(position.x);
    expect((await inspect()).snapshot.player.z).toBe(position.z);
  }, 90_000);

  it("tracks authored quests on a paused journal and switches between local and regional navigation", async () => {
    await tap("KeyJ");
    const opened = await inspect();
    expect(opened.overlay).toBe("journal");
    expect(opened.running).toBe(false);
    expect(opened.snapshot.narrative?.quests.length).toBeGreaterThanOrEqual(13);
    expect(await evaluate<number>(cdp, "document.querySelectorAll('.quest-entry').length")).toBeGreaterThan(0);
    await capture("quest-journal-en");
    const target = opened.snapshot.narrative?.trackedQuestId;
    await select('[data-action="track-quest"]');
    expect((await inspect()).overlay).toBe("journal");
    expect((await inspect()).snapshot.tick).toBe(opened.snapshot.tick);
    expect((await inspect()).snapshot.narrative?.trackedQuestId).not.toBe(target);
    await select('[data-action="track-quest"]');
    expect((await inspect()).snapshot.narrative?.trackedQuestId).toBe(target);
    await select('[data-action="open-map"]');
    expect((await inspect()).overlay).toBe("map");
    const regional = await evaluate<string>(cdp, "document.querySelector('.atlas-paper svg').getAttribute('viewBox')");
    expect(await evaluate<number>(cdp, "document.querySelectorAll('.atlas-paper [data-location]').length")).toBeGreaterThanOrEqual(24);
    expect(await evaluate(cdp, "Boolean(document.querySelector('.travel-controls'))")).toBe(true);
    await capture("borderlands-atlas-en");
    await select('[data-action="map-scale"]');
    expect(await evaluate(cdp, "document.querySelector('.atlas-paper svg').getAttribute('viewBox')")).not.toBe(regional);
    await capture("local-atlas-en");
    await tap("Escape");
    expect((await inspect()).running).toBe(true);
    await tap("Escape");
    await select('[data-action="open-settings"]');
    await evaluate(cdp, `(() => {
      const language = document.querySelector('select[aria-label="Language"]');
      language.value = 'ru';
      language.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await select('[data-action="open-pause"]');
    await select('[data-action="open-journal"]');
    expect(await evaluate(cdp, "document.documentElement.lang")).toBe("ru");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 960, deviceScaleFactor: 1, mobile: false });
    await capture("quest-journal-ru-narrow");
    expect(await evaluate(cdp, "document.querySelector('.journal-panel').scrollWidth <= document.querySelector('.journal-panel').clientWidth")).toBe(true);
    await tap("Tab");
    expect(await evaluate(cdp, "document.querySelector('.journal-panel').contains(document.activeElement)")).toBe(true);
  }, 90_000);
});
