import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createCampaign, isWalkable, type GameSnapshot } from "../src/game";
import { NPCS, QUESTS } from "../src/game/narrative-data";
import { CampaignDriver } from "./driver";
import { storageKeys, type Settings } from "../src/ui/storage";
import {
  click, evaluate, launchBrowser, openPage, screenshot, until,
  type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { closeTestBrowser } from "./browser-cleanup";
import { reloadTestPage } from "./browser-navigation";

interface Inspection { snapshot: GameSnapshot; overlay: string | null; running: boolean }

describe.runIf(process.env.KOROVANY_BROWSER === "1")("narrative browser integration", () => {
  let server: ViteDevServer;
  let browser: LaunchedBrowser;
  let cdp: CdpSession;
  // SwiftShader can take seconds per frame while the game caps simulation catch-up.
  const gameplayTimeout = 60_000;

  async function inspect(): Promise<Inspection> {
    return evaluate(cdp, "window.korovany.inspect()");
  }
  async function visibleEvidence(): Promise<string> {
    return evaluate(cdp, "[...document.querySelectorAll('.inspection-text p')].map(p => p.textContent).join('\\n\\n')");
  }
  async function press(code: string, down: boolean): Promise<void> {
    await cdp.send("Input.dispatchKeyEvent", { type: down ? "keyDown" : "keyUp", code,
      key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code.startsWith("Digit") ? code.slice(5) : code,
      windowsVirtualKeyCode: code.startsWith("Key") ? code.charCodeAt(3)
        : code.startsWith("Digit") ? code.charCodeAt(5) : code === "Escape" ? 27 : 9 });
  }
  async function tap(code: string): Promise<void> {
    await press(code, true);
    await press(code, false);
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
    await reloadTestPage(cdp);
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
    const settings: Omit<Settings, "audio"> = { language: "en", quality: "high", reducedMotion: false, muted: false };
    await evaluate(cdp, `(() => {
      localStorage.setItem(${JSON.stringify(storageKeys.campaign)}, ${JSON.stringify(JSON.stringify(save))});
      localStorage.setItem(${JSON.stringify(storageKeys.settings)}, ${JSON.stringify(JSON.stringify(settings))});
    })()`);
    await reload();
  }, 90_000);

  afterAll(async () => {
    cdp?.close();
    try {
      if (browser) await closeTestBrowser(browser);
    } finally {
      await server?.close();
    }
  }, 60_000);

  it("shows discovered NPC map markers beyond talk range, including when conversation is blocked", async () => {
    const snapshot = createCampaign({ seed: "resident-map-range", faction: "guard" }).snapshot();
    const markers = await evaluate<{ distance: number; available: boolean; visible: boolean[] }[]>(cdp, `(async () => {
      const { Atlas } = await import('/src/ui/atlas.ts');
      const atlas = new Atlas();
      const snapshot = ${JSON.stringify(snapshot)};
      const npc = snapshot.narrative.npcs.find(person => person.id === 'mara');
      const results = [];
      for (const available of [false, true]) {
        npc.available = available;
        for (const distance of [0, 4.25, 4.26, 10, 32, 38, 38.01, 120]) {
          snapshot.player.x = npc.x + distance;
          snapshot.player.z = npc.z;
          results.push({ distance, available, visible: [[false, false], [false, true], [true, false]]
            .map(([miniature, local]) => Boolean(atlas.draw(snapshot, 'en', miniature, local).querySelector('[data-npc="mara"]'))) });
        }
      }
      snapshot.narrative.npcs = [];
      results.push({distance: 0, available: false, visible: [Boolean(atlas.draw(snapshot, 'en').querySelector('[data-npc]'))]});
      return results;
    })()`);
    const absent = markers.pop()!;
    expect(absent.visible).toEqual([false]);
    for (const result of markers) {
      expect(result.visible, `${result.distance}m, available: ${result.available}`).toEqual(Array(3).fill(result.distance <= 38));
    }
  });

  it("opens a live NPC conversation, preserves it across reload, and closes without leaking movement", async () => {
    await select('[data-action="continue"]');
    await until(cdp, "Boolean(window.korovany.inspect().snapshot.narrative?.interaction?.kind === 'talk')", Boolean, 20_000);
    const before = await inspect();
    expect(before.snapshot.world.exploration?.regions.length).toBeGreaterThanOrEqual(8);
    expect(before.snapshot.narrative?.npcs.some((npc) => npc.id === before.snapshot.narrative?.interaction?.targetId)).toBe(true);
    await capture("residents-at-roadward");
    const distanceFromMara = `(() => {
      const snapshot = window.korovany.inspect().snapshot;
      const npc = snapshot.narrative.npcs.find(person => person.id === 'mara');
      return Math.hypot(npc.x - snapshot.player.x, npc.z - snapshot.player.z);
    })()`;
    // Bound SwiftShader's pixel cost during sustained movement without disabling high-quality rendering.
    // Dialogue and layout coverage still use the full desktop viewport.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 500, deviceScaleFactor: 1, mobile: false });
    try {
      await until(cdp, "document.querySelector('canvas').width === 720 && document.querySelector('canvas').height === 500", Boolean, gameplayTimeout);
      expect(await evaluate(cdp, "window.korovany.inspect().settings.quality")).toBe("high");
      for (const [code, away] of [["KeyS", true], ["KeyW", false]] as const) {
        const started = Date.now();
        const startTick = (await inspect()).snapshot.tick;
        await press(code, true);
        try {
          await until(cdp, distanceFromMara, (distance: number) => away ? distance >= 10 : distance <= 3.5, gameplayTimeout);
        } finally {
          await press(code, false);
          const ended = await inspect();
          console.info("NPC movement", JSON.stringify({
            code, wallMs: Date.now() - started, ticks: ended.snapshot.tick - startTick,
            distance: await evaluate(cdp, distanceFromMara), overlay: ended.overlay, running: ended.running,
          }));
        }
        if (away) {
          const distant = await inspect();
          expect(distant.snapshot.narrative!.npcs.find(npc => npc.id === "mara")?.available).toBe(false);
          expect(distant.snapshot.narrative!.interaction?.targetId).not.toBe("mara");
          await until(cdp, "window.korovany.inspect().snapshot.tick", (tick: number) => tick >= distant.snapshot.tick + 60, gameplayTimeout);
          expect(await evaluate(cdp, `Boolean(document.querySelector('.minimap [data-npc="mara"]'))`)).toBe(true);
          await capture("residents-beyond-talk-range");
        }
      }
    } finally {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    }
    await until(cdp, "document.querySelector('canvas').width === 1440 && document.querySelector('canvas').height === 1000", Boolean, gameplayTimeout);
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
  }, 210_000);

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

  it("reads discovered evidence, stays paused through menus and reload, then resumes only after closing", async () => {
    const game = createCampaign({ seed: "inspection-browser", faction: "guard", runId: "inspection-browser-run" });
    const driver = new CampaignDriver(game);
    const quest = QUESTS.find((entry) => entry.kind === "main")!;
    const evidenceStage = quest.stages.find((stage) => stage.kind === "inspect")!;
    for (const stage of quest.stages) {
      if (stage === evidenceStage) break;
      const npc = NPCS.find((entry) => entry.id === stage.at)!;
      driver.toNode(npc.locationId);
      game.step({ narrative: { type: "talk", npcId: npc.id } });
      if (!game.snapshot().narrative!.dialogue!.choices.some((choice) => choice.id === stage.actions[0]!.id)) {
        game.step({ narrative: { type: "choose", npcId: npc.id, choiceId: `quest-${quest.id}` } });
      }
      expect(game.snapshot().narrative!.dialogue!.choices.find((choice) => choice.id === stage.actions[0]!.id)?.enabled).toBe(true);
      game.step({ narrative: { type: "choose", npcId: npc.id, choiceId: stage.actions[0]!.id } });
      game.step({ narrative: { type: "close" } });
    }
    driver.toNode(evidenceStage.at);
    const ready = game.snapshot();
    const inspectAt = ready.world.exploration!.locations.find((place) => place.id === evidenceStage.at)!;
    const nearestResident = (point: { x: number; z: number }) => Math.min(...ready.narrative!.npcs.map((npc) =>
      Math.hypot(point.x - npc.x, point.z - npc.z)));
    const readingSpot = Array.from({ length: 16 }, (_, index) => ({
      x: inspectAt.x + Math.sin(index * Math.PI / 8) * 5,
      z: inspectAt.z + Math.cos(index * Math.PI / 8) * 5,
    })).filter(point => isWalkable(ready.world, point, ready.player.radius))
      .sort((a, b) => nearestResident(b) - nearestResident(a))[0];
    expect(readingSpot, "The inspection must have a walkable reading spot").toBeDefined();
    if (!readingSpot) throw new Error("No walkable reading spot near the evidence");
    driver.walk(readingSpot, 0.2);
    expect(game.snapshot().narrative!.inspection).toBeNull();
    expect(game.snapshot().narrative!.interaction).toMatchObject({ kind: "inspect", targetId: evidenceStage.at, enabled: true });
    await evaluate(cdp, `(() => {
      localStorage.setItem(${JSON.stringify(storageKeys.campaign)}, ${JSON.stringify(JSON.stringify(game.serialize()))});
      localStorage.setItem(${JSON.stringify(storageKeys.settings)}, ${JSON.stringify(JSON.stringify({
        language: "en", quality: "high", reducedMotion: false, muted: true,
      }))});
    })()`);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await reload();
    await select('[data-action="continue"]');
    await until(cdp, "window.korovany.inspect().snapshot.narrative.interaction?.kind", (kind: string) => kind === "inspect", 15_000);
    const before = await inspect();
    await tap("KeyT");
    await until(cdp, "window.korovany.inspect().overlay", (overlay: string) => overlay === "inspection", 15_000);
    const reading = await inspect();
    const evidence = reading.snapshot.narrative!.inspection!;
    expect(evidence.locationId).toBe(evidenceStage.at);
    expect(evidence.text.en).toBe(evidenceStage.prompt.en);
    expect(reading.snapshot.narrative!.facts.length).toBeGreaterThan(before.snapshot.narrative!.facts.length);
    expect(reading.running).toBe(false);
    expect(await evaluate(cdp, "document.querySelector('.inspection h2').textContent")).toBe(evidence.title.en);
    expect(await visibleEvidence()).toBe(evidence.text.en);
    expect(await evaluate(cdp, "document.querySelector('.inspection-panel').getAttribute('aria-labelledby')")).toBe("inspection-title");
    await capture("inspection-en");
    await tap("Tab");
    expect(await evaluate(cdp, "document.querySelector('.inspection-panel').contains(document.activeElement)")).toBe(true);
    for (const code of ["KeyW", "KeyT", "Digit1"]) await tap(code);
    await evaluate(cdp, "new Promise(resolve => setTimeout(resolve, 250))");
    expect((await inspect()).snapshot.tick).toBe(reading.snapshot.tick);
    expect((await inspect()).snapshot.narrative!.inspection).toEqual(evidence);

    await select('[data-action="open-pause"]');
    await select('[data-action="open-map"]');
    await select('[data-action="resume"]');
    expect((await inspect()).overlay).toBe("inspection");
    expect((await inspect()).running).toBe(false);
    await select('[data-action="open-pause"]');
    await select('[data-action="save"]');
    await select('[data-action="open-settings"]');
    await evaluate(cdp, `(() => {
      const language = document.querySelector('select[aria-label="Language"]');
      language.value = 'ru';
      language.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await select('[data-action="open-pause"]');
    await select('[data-action="resume"]');
    expect(await visibleEvidence()).toBe(evidence.text.ru);
    await capture("inspection-ru");
    await select('[data-action="open-pause"]');
    await select('[data-action="title"]');
    expect((await inspect()).overlay).toBe("menu");
    expect((await inspect()).running).toBe(false);
    await select('[data-action="continue"]');
    expect((await inspect()).overlay).toBe("inspection");
    await reload();
    await select('[data-action="continue"]');
    expect((await inspect()).overlay).toBe("inspection");
    expect((await inspect()).running).toBe(false);
    expect((await inspect()).snapshot.tick).toBe(reading.snapshot.tick);
    expect((await inspect()).snapshot.narrative!.inspection).toEqual(evidence);
    expect(await visibleEvidence()).toBe(evidence.text.ru);

    await select('[data-action="close-inspection"]');
    expect((await inspect()).snapshot.narrative!.inspection).toBeNull();
    expect((await inspect()).running).toBe(true);
    await until(cdp, "window.korovany.inspect().snapshot.tick", (tick: number) => tick > reading.snapshot.tick + 5, 15_000);
    expect((await inspect()).snapshot.player.x).toBe(reading.snapshot.player.x);
    expect((await inspect()).snapshot.player.z).toBe(reading.snapshot.player.z);
    await tap("KeyT");
    await until(cdp, "window.korovany.inspect().overlay", (overlay: string) => overlay === "inspection", 15_000);
    const revisited = await inspect();
    const place = revisited.snapshot.world.exploration!.locations.find((location) => location.id === evidenceStage.at)!;
    expect(revisited.snapshot.narrative!.inspection!.text).toEqual(place.description);
    expect(await visibleEvidence()).toBe(place.description.ru);
    await tap("Escape");
    expect((await inspect()).snapshot.narrative!.inspection).toBeNull();
    expect((await inspect()).running).toBe(true);
    await tap("Escape");
  }, 120_000);

  it("renders long bilingual inspection paragraphs safely and displays a journal outcome only once", async () => {
    const results = await evaluate<{
      language: string; paragraphs: number; literal: boolean; scrolls: boolean;
      fits: boolean; close: unknown; history: number; outcomes: number; notices: number;
    }[]>(cdp, `(async () => {
      const { inspectionContent, journalContent } = await import('/src/ui/story.ts');
      const results = [];
      for (const language of ['en', 'ru']) {
        const snapshot = window.korovany.inspect().snapshot;
        const line = language === 'en' ? 'Salt lies beneath the bell rope.' : 'Под колокольной верёвкой рассыпана соль.';
        const text = Array.from({length:24}, () => line.repeat(8)).join('\\n\\n') + '\\n\\n<em>Evidence is text</em>';
        snapshot.narrative.inspection = {locationId:'old-orchard', title:{en:'Old Orchard', ru:'Старый сад'}, text:{en:text, ru:text}};
        const commands = [];
        const root = inspectionContent(snapshot, language, command => commands.push(command));
        const host = document.createElement('div');
        host.className = 'overlay-host';
        const panel = document.createElement('section');
        panel.className = 'panel inspection-panel';
        panel.style.width = '340px';
        panel.style.height = '420px';
        panel.append(root);
        host.append(panel);
        document.body.append(host);
        try {
          root.querySelector('[data-action="close-inspection"]').click();
          const quest = snapshot.narrative.quests[0];
          const outcome = {en:'The villagers now keep the bell.', ru:'Теперь жители сами следят за колоколом.'};
          quest.status = 'completed';
          quest.entries = [{en:'The bell was repaired.', ru:'Колокол починили.'}, outcome];
          quest.outcome = outcome;
          snapshot.narrative.ending = outcome;
          snapshot.narrative.notice = outcome;
          const journal = journalContent(snapshot, language, quest.id, 'completed', () => {}, () => {}, () => {});
          results.push({language,
            paragraphs: root.querySelectorAll('.inspection-text p').length,
            literal: root.textContent.includes('<em>Evidence is text</em>') && !root.querySelector('em'),
            scrolls: panel.scrollHeight > panel.clientHeight,
            fits: panel.scrollWidth <= panel.clientWidth,
            close: commands[0],
            history: journal.querySelectorAll('.quest-history li').length,
            outcomes: journal.querySelectorAll('.quest-outcome').length,
            notices: journal.querySelectorAll('.story-notice').length});
        } finally { host.remove(); }
      }
      return results;
    })()`);
    expect(results).toHaveLength(2);
    for (const result of results) expect(result).toMatchObject({
      paragraphs: 25, literal: true, scrolls: true, fits: true,
      close: { type: "close" }, history: 1, outcomes: 1, notices: 0,
    });
  }, 30_000);
});
