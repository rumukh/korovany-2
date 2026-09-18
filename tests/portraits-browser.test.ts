import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createCampaign, type FactionId, type GameSnapshot } from "../src/game";
import { getFactionStory } from "../src/game/faction-stories";
import { NPC_PORTRAIT_IDS, PLAYER_PORTRAITS } from "../src/ui/portraits";
import { storageKeys, type Language } from "../src/ui/storage";
import { FactionStoryDriver } from "./faction-driver";
import {
  click, evaluate, launchBrowser, openPage, screenshot, until,
  type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { closeTestBrowser } from "./browser-cleanup";
import { reloadTestPage } from "./browser-navigation";

interface Inspection { snapshot: GameSnapshot; overlay: string | null; running: boolean }
const cases = (["elf", "guard", "villain"] as const).flatMap((faction) =>
  (["en", "ru"] as const).map((language) => ({ faction, language })));
const firstSpeaker: Record<FactionId, string> = { elf: "toman", guard: "vesk", villain: "ren" };

describe.runIf(process.env.KOROVANY_BROWSER === "1")("generated dialogue portraits in Chromium", () => {
  let server: ViteDevServer;
  let browser: LaunchedBrowser;
  let cdp: CdpSession;
  const inspect = () => evaluate<Inspection>(cdp, "window.korovany.inspect()");

  async function tap(code: string, shift = false): Promise<void> {
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type, code, key: code.startsWith("Digit") ? code.slice(5) : code,
        windowsVirtualKeyCode: code.startsWith("Digit") ? code.charCodeAt(5) : code === "Escape" ? 27 : 9,
        modifiers: shift ? 8 : 0,
      });
    }
  }
  async function capture(name: string): Promise<void> {
    if (process.env.KOROVANY_CAPTURE_DIR) await screenshot(cdp, join(process.env.KOROVANY_CAPTURE_DIR, `${name}.png`));
  }
  async function setViewport(width: number, height: number): Promise<void> {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }
  async function start(faction: FactionId, language: Language) {
    const game = createCampaign({ faction, seed: "portrait-dialogues", runId: `portraits-${faction}-${language}` });
    new FactionStoryDriver(game).talk(firstSpeaker[faction]);
    await evaluate(cdp, `(() => {
      localStorage.setItem(${JSON.stringify(storageKeys.campaign)}, ${JSON.stringify(JSON.stringify(game.serialize()))});
      localStorage.setItem(${JSON.stringify(storageKeys.settings)}, ${JSON.stringify(JSON.stringify({
        language, quality: "low", reducedMotion: true, muted: true,
      }))});
    })()`);
    await reloadTestPage(cdp);
    const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
      const button = document.querySelector('[data-action="continue"]');
      if (!button) throw new Error('Missing saved portrait conversation');
      button.scrollIntoView({block:'center'});
      const rect = button.getBoundingClientRect();
      return { x:rect.x + rect.width/2, y:rect.y + rect.height/2 };
    })()`);
    await click(cdp, point.x, point.y);
    await until(cdp, "window.korovany.inspect().overlay", (overlay: string) => overlay === "dialogue", 20_000);
    await until(cdp, `document.querySelectorAll('.conversation .character-portrait[data-state="ready"]').length`, (count: number) => count === 2, 15_000);
    return game;
  }

  beforeAll(async () => {
    if (process.env.KOROVANY_CAPTURE_DIR) await mkdir(process.env.KOROVANY_CAPTURE_DIR, { recursive: true });
    server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error("Missing portrait preview URL");
    expect((await fetch(origin)).status).toBe(200);
    browser = await launchBrowser({ viewport: { width: 1280, height: 900 } });
    cdp = await openPage(browser.port, origin, { width: 1280, height: 900 });
    await until(cdp, "Boolean(window.korovany)", Boolean, 30_000);
  }, 90_000);

  afterAll(async () => {
    cdp?.close();
    try {
      if (browser) await closeTestBrowser(browser);
    } finally {
      await server?.close();
    }
  }, 60_000);

  it("fully decodes every unique web portrait at its real delivery dimensions", async () => {
    const ids = [...NPC_PORTRAIT_IDS, ...Object.values(PLAYER_PORTRAITS)];
    const images = await evaluate<{ id: string; width: number; height: number; complete: boolean }[]>(cdp, `(async () => {
      const { portraitUrl } = await import('/src/ui/portraits.ts');
      return Promise.all(${JSON.stringify(ids)}.map(async id => {
        const image = new Image();
        image.src = portraitUrl(id);
        await image.decode();
        return { id, width:image.naturalWidth, height:image.naturalHeight, complete:image.complete };
      }));
    })()`);
    expect(images.map((image) => image.id)).toEqual(ids);
    for (const image of images) expect(image).toMatchObject({ width: 320, height: 320, complete: true });
  });

  it.each(cases)("shows actual $faction/$language dialogue, small-screen choices and unchanged keyboard flow", async ({ faction, language }) => {
    await setViewport(1280, 900);
    const game = await start(faction, language);
    const before = await inspect();
    const dialogue = before.snapshot.narrative!.dialogue!;
    expect(dialogue.npcId).toBe(firstSpeaker[faction]);
    expect(before.running).toBe(false);
    const display = await evaluate<{ name: string; player: string; portraits: { id: string; alt: string; fit: string; width: number; height: number }[] }>(cdp, `(() => ({
      name:document.querySelector('.conversation-header h2').textContent,
      player:document.querySelector('.player-identity').textContent,
      portraits:[...document.querySelectorAll('.conversation .character-portrait')].map(root => {
        const image = root.querySelector('img'), rect = root.getBoundingClientRect();
        return { id:root.dataset.portrait, alt:image.alt, fit:getComputedStyle(image).objectFit, width:rect.width, height:rect.height };
      })
    }))()`);
    expect(display.name).toBe(dialogue.name[language]);
    expect(display.player).toBe(before.snapshot.campaign!.identity.role[language]);
    expect(display.portraits.map((image) => image.id)).toEqual([dialogue.npcId, PLAYER_PORTRAITS[faction]]);
    expect(display.portraits.map((image) => image.width)).toEqual([120, 56]);
    for (const image of display.portraits) {
      expect(image.alt).toBe("");
      expect(image.fit).toBe("cover");
      expect(image.width).toBe(image.height);
    }
    await capture(`portraits-${faction}-${language}-desktop`);
    await setViewport(360, 780);
    const narrow = await evaluate<{ overflow: boolean; portraits: number[]; names: boolean }>(cdp, `(() => {
      const panel = document.querySelector('.dialogue-panel');
      panel.scrollTop = 0;
      return {
        overflow:panel.scrollWidth > panel.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth,
        portraits:[...panel.querySelectorAll('.character-portrait')].map(root => root.getBoundingClientRect().width),
        names:[...panel.querySelectorAll('.conversation-header h2, .player-identity')].every(root => root.scrollWidth <= root.clientWidth + 1)
      };
    })()`);
    expect(narrow).toEqual({ overflow: false, portraits: [84, 52], names: true });
    await capture(`portraits-${faction}-${language}-narrow`);
    const lastChoiceVisible = await evaluate<boolean>(cdp, `(() => {
      const choices = document.querySelectorAll('.dialogue-choice');
      const last = choices[choices.length - 1];
      last.scrollIntoView({block:'center'});
      const rect = last.getBoundingClientRect(), panel = document.querySelector('.dialogue-panel').getBoundingClientRect();
      return rect.top >= panel.top && rect.bottom <= panel.bottom && rect.left >= panel.left && rect.right <= panel.right;
    })()`);
    expect(lastChoiceVisible).toBe(true);
    await capture(`portraits-${faction}-${language}-choices`);
    await evaluate(cdp, "document.querySelector('.dialogue-panel').focus()");
    await tap("Tab");
    expect(await evaluate(cdp, "document.activeElement === document.querySelector('.dialogue-panel button:not(:disabled)')")).toBe(true);
    await tap("Tab", true);
    expect(await evaluate(cdp, "document.activeElement.dataset.action")).toBe("open-settings");
    await tap("Tab", true);
    expect(await evaluate(cdp, "document.activeElement.dataset.action")).toBe("close-dialogue");
    await tap("Tab");
    expect(await evaluate(cdp, "document.activeElement.dataset.action")).toBe("open-settings");
    await tap("Tab");
    expect(await evaluate(cdp, "document.activeElement === document.querySelector('.dialogue-panel button:not(:disabled)')")).toBe(true);
    expect((await inspect()).snapshot.tick).toBe(before.snapshot.tick);
    const index = dialogue.choices.findIndex((choice) => choice.enabled);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(9);
    const choice = dialogue.choices[index]!;
    game.step({ narrative: { type: "choose", npcId: dialogue.npcId, choiceId: choice.id } });
    await tap(`Digit${index + 1}`);
    const answered = await inspect();
    expect(answered.overlay).toBe("dialogue");
    expect(answered.running).toBe(false);
    expect(answered.snapshot.narrative!.dialogue).toEqual(game.snapshot().narrative!.dialogue);
    expect(answered.snapshot.player.hp).toBe(before.snapshot.player.hp);
    await tap("Escape");
    expect((await inspect()).running).toBe(true);
    const position = (await inspect()).snapshot.player;
    await until(cdp, "window.korovany.inspect().snapshot.tick", (tick: number) => tick > answered.snapshot.tick + 5, 15_000);
    expect((await inspect()).snapshot.player.x).toBe(position.x);
    expect((await inspect()).snapshot.player.z).toBe(position.z);
    await tap("Escape");
    expect((await inspect()).running).toBe(false);
  }, 90_000);

  it("selects every NPC by ID despite arbitrary localized names and does not add a narrator to evidence", async () => {
    const snapshot = createCampaign({ faction: "guard", seed: "portrait-mapping" }).snapshot();
    const speakers = getFactionStory("guard").npcs;
    const result = await evaluate<{ portraits: string[]; inspectionPortraits: number }>(cdp, `(async () => {
      const { dialogueContent, inspectionContent } = await import('/src/ui/story.ts');
      const snapshot = ${JSON.stringify(snapshot)};
      const portraits = [];
      for (const speaker of ${JSON.stringify(speakers)}) {
        snapshot.narrative.dialogue = { npcId:speaker.id, name:{en:'Same name',ru:'Одинаковое имя'},
          role:speaker.role, text:speaker.greeting, choices:[] };
        const root = dialogueContent(snapshot, 'ru', () => {});
        portraits.push(root.querySelector('.character-portrait').dataset.portrait);
        await root.querySelector('img').decode();
      }
      snapshot.narrative.inspection = { locationId:'evidence', title:{en:'Evidence',ru:'Улика'}, text:{en:'Read the evidence.',ru:'Прочтите улику.'} };
      return { portraits, inspectionPortraits:inspectionContent(snapshot, 'ru', () => {}).querySelectorAll('.character-portrait').length };
    })()`);
    expect(result.portraits).toEqual(speakers.map((speaker) => speaker.id));
    expect(result.inspectionPortraits).toBe(0);
  });

  it.each(["en", "ru"] as const)("exposes loading and real asset failures without losing speaker text or choices (%s)", async (language) => {
    const snapshot = createCampaign({ faction: "guard", seed: "portrait-errors" }).snapshot();
    const result = await evaluate<{
      loading: string; failed: string; failureLabel: string; state: string; imageHidden: boolean;
      missing: string; name: string; buttons: number;
    }>(cdp, `(async () => {
      const { portraitContent } = await import('/src/ui/portraits.ts');
      const { dialogueContent } = await import('/src/ui/story.ts');
      const root = portraitContent('mara', 'Mara', ${JSON.stringify(language)});
      document.body.append(root);
      const loading = root.querySelector('[role="status"]').textContent;
      const image = root.querySelector('img');
      const failed = new Promise(resolve => image.addEventListener('error', resolve, {once:true}));
      image.src = '/portraits/intentional-missing-asset.webp';
      await failed;
      const snapshot = ${JSON.stringify(snapshot)};
      snapshot.narrative.dialogue = { npcId:'unmapped-npc', name:{en:'Visible name',ru:'Видимое имя'},
        role:{en:'Witness',ru:'Свидетель'}, text:{en:'Readable speech',ru:'Читаемая речь'},
        choices:[{id:'local',text:{en:'Ask',ru:'Спросить'},enabled:true,reason:null}] };
      const dialogue = dialogueContent(snapshot, ${JSON.stringify(language)}, () => {});
      const result = { loading, failed:root.querySelector('[role="status"]').textContent,
        failureLabel:root.querySelector('[role="status"]').getAttribute('aria-label'),
        state:root.dataset.state, imageHidden:image.hidden,
        missing:dialogue.querySelector('.character-portrait').dataset.state,
        name:dialogue.querySelector('h2').textContent,
        buttons:dialogue.querySelectorAll('.dialogue-choice:not(:disabled)').length };
      root.remove();
      return result;
    })()`);
    expect(result.loading).toBe(language === "en" ? "Loading portrait" : "Загрузка портрета");
    expect(result.failed).toBe(language === "en" ? "Portrait unavailable" : "Портрет недоступен");
    expect(result.failureLabel).toBe(`${result.failed}: Mara`);
    expect(result.state).toBe("error");
    expect(result.imageHidden).toBe(true);
    expect(result.missing).toBe("error");
    expect(result.name).toBe(language === "en" ? "Visible name" : "Видимое имя");
    expect(result.buttons).toBe(1);
  });
});
