import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createCampaign, type GameSnapshot, type LocalizedText } from "../src/game";
import { paragraphs, voiceKey, type VoiceEntry } from "../src/audio/manifest";
import type { Soundscape } from "../src/audio/soundscape";
import { defaultMix, mixChannels } from "../src/audio/mix";
import { storageKeys, type Settings } from "../src/ui/storage";
import {
  click, evaluate, launchBrowser, openPage, until, type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { closeOwnedBrowser } from "../vendor/aegis-engine/packages/render-three/src/testing/browser-lifecycle";

interface Inspection {
  snapshot: GameSnapshot;
  overlay: string | null;
  running: boolean;
  settings: Settings;
  audio: ReturnType<Soundscape["inspect"]>;
}

// Test-only PCM media served over HTTP. No fixture or generated substitute enters public/audio.
function fixtureWave(): Buffer {
  const rate = 8000;
  const samples = rate * 12;
  const result = Buffer.alloc(44 + samples * 2);
  result.write("RIFF", 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(rate, 24);
  result.writeUInt32LE(rate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) result.writeInt16LE(((i * 7919) % 257) - 128, 44 + i * 2);
  return result;
}

describe.runIf(process.env.KOROVANY_BROWSER === "1")("actual browser audio transport with HTTP fixtures", () => {
  let server: ViteDevServer;
  let browser: LaunchedBrowser;
  let cdp: CdpSession;
  let failAssets = false;
  let manifestRequests = 0;
  const game = createCampaign({ seed: "audio-browser", faction: "guard", runId: "audio-browser" });
  game.step();
  const npcId = game.snapshot().narrative!.interaction!.targetId;
  game.step({ narrative: { type: "talk", npcId } });
  const initial = game.snapshot().narrative!.dialogue!;
  const saved = game.serialize();
  const choice = initial.choices.find((entry) => entry.enabled && entry.id !== "leave")!;
  game.step({ narrative: { type: "choose", npcId, choiceId: choice.id } });
  const response = game.snapshot().narrative!.dialogue!;
  const entries = new Map<string, VoiceEntry>();
  const add = (speaker: string, text: LocalizedText) => {
    for (const language of ["en", "ru"] as const) for (const block of paragraphs(text[language])) {
      const key = voiceKey(speaker, language, block);
      entries.set(key, { id: `fixture-${entries.size}`, speaker, language, text: block,
        clips: [{ src: "audio/voices/fixture.wav", duration: 12 }] });
    }
  };
  add(npcId, initial.text);
  add("player", choice.text);
  add(npcId, response.text);
  const music = ["title", "road", "mystery", "combat", "fortress", "ending-commons", "ending-compact", "ending-cinder"];
  const ambience = ["heartlands", "greenmarch", "fens", "salt-coast", "ash-steppe", "crownlands", "frostspine", "hollowvale"];
  const sfx = ["attack-elf", "attack-guard", "attack-villain", "hit", "kill", "pickup", "capture", "delivery", "raid", "convoy",
    "repair", "upgrade", "ability-elf", "ability-guard", "ability-villain", "fortress", "victory", "defeat", "click",
    "step-dirt", "step-stone", "dodge", "discover", "inspect"];
  const assets = (ids: string[], loop: boolean) => ids.map((id) => ({ id, src: "audio/soundtrack/fixture.wav", duration: 12, loop }));
  const score = { version: 1, music: assets(music, true), ambience: assets(ambience, true), sfx: assets(sfx, false) };
  const wave = fixtureWave();
  const inspect = () => evaluate<Inspection>(cdp, "window.korovany.inspect()");

  async function select(selector: string) {
    const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) throw new Error("Missing audio control");
      element.scrollIntoView({block:"center"});
      const r = element.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    await click(cdp, point.x, point.y);
  }
  async function reload() {
    const origin = await evaluate<number>(cdp, "performance.timeOrigin");
    await cdp.send("Page.reload");
    await until(cdp, `performance.timeOrigin !== ${origin} && Boolean(window.korovany)`, Boolean, 30_000);
  }
  async function language(value: "ru" | "en") {
    await evaluate(cdp, `(() => {
      const select = document.querySelector(".settings-panel select");
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event("change", {bubbles:true}));
    })()`);
  }

  beforeAll(async () => {
    server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0 }, plugins: [{
      name: "test-only-audio-fixtures",
      configureServer(server) { server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/audio/")) return next();
      if (failAssets) { res.statusCode = 404; res.end("Fixture unavailable"); return; }
      if (req.url.endsWith("manifest.json")) {
        manifestRequests++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.url.includes("/voices/") ? { version: 1, entries: [...entries.values()] } : score));
      } else {
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Content-Length", wave.length);
        res.end(wave);
      }
      }); },
    }] });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error("No audio test server URL.");
    expect((await fetch(origin)).status).toBe(200);
    expect(await (await fetch(new URL("audio/soundtrack/manifest.json", origin))).json()).toEqual(score);
    manifestRequests = 0;
    browser = await launchBrowser({ viewport: { width: 1280, height: 900 } });
    cdp = await openPage(browser.port, "about:blank", { width: 1280, height: 900 });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      if (!localStorage.getItem(${JSON.stringify(storageKeys.settings)})) localStorage.setItem(
        ${JSON.stringify(storageKeys.settings)}, ${JSON.stringify(JSON.stringify({
          language: "en", quality: "low", reducedMotion: true, muted: false, audio: defaultMix(),
        }))});` });
    await cdp.send("Page.navigate", { url: origin });
    await until(cdp, "Boolean(window.korovany)", Boolean, 60_000);
  }, 120_000);

  afterAll(async () => {
    cdp?.close();
    if (browser) {
      await closeOwnedBrowser(browser);
      await rm(browser.profile, { recursive: true, force: true });
    }
    await server?.close();
  }, 30_000);

  it("unlocks actual streamed media via a trusted click and exposes five persistent accessible mixer controls", async () => {
    expect((await inspect()).audio.state).toBe("locked");
    expect(manifestRequests).toBe(0);
    await select('[data-action="open-settings"]');
    await until(cdp, "window.korovany.inspect().audio.streams.some(s => s.id === 'title' && !s.paused && s.time > 0.1)", Boolean, 20_000);
    await language("en");
    expect(await evaluate(cdp, "document.querySelectorAll('input[type=range]').length")).toBe(5);
    await evaluate(cdp, `(() => {
      for (const input of document.querySelectorAll("input[type=range]")) {
        input.value = "0.65";
        input.dispatchEvent(new Event("input", {bubbles:true}));
      }
    })()`);
    for (const channel of mixChannels) {
      expect((await inspect()).settings.audio[channel]).toBe(0.65);
      expect(await evaluate(cdp, `document.querySelector('[data-audio-channel="${channel}"]').getAttribute("aria-valuetext")`)).toBe("65%");
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 430, height: 900, deviceScaleFactor: 1, mobile: false });
    expect(await evaluate(cdp, "document.querySelector('.settings-panel').scrollWidth <= document.querySelector('.settings-panel').clientWidth")).toBe(true);
    await select('.settings-panel input[type="checkbox"]');
    expect((await inspect()).audio.streams).toHaveLength(0);
    await select('.settings-panel input[type="checkbox"]');
    await until(cdp, "window.korovany.inspect().audio.streams.length > 0", Boolean, 20_000);
    await reload();
    expect((await inspect()).settings.audio).toEqual({ master: .65, music: .65, ambience: .65, effects: .65, voices: .65 });
  }, 120_000);

  it("speaks player then NPC while simulation stays paused, cancels on blur, and resumes in the selected language", async () => {
    await evaluate(cdp, `localStorage.setItem(${JSON.stringify(storageKeys.campaign)}, ${JSON.stringify(JSON.stringify(saved))})`);
    await reload();
    await select('[data-action="continue"]');
    await until(cdp, "window.korovany.inspect().audio.voices > 0 && window.korovany.inspect().audio.subtitle?.speaker !== 'player'", Boolean, 20_000);
    const talking = await inspect();
    expect(talking.overlay).toBe("dialogue");
    expect(talking.running).toBe(false);
    expect(talking.audio.active).toBe(true);
    await select(`[data-choice="${choice.id}"]`);
    await until(cdp, "window.korovany.inspect().audio.subtitle?.speaker === 'player' && window.korovany.inspect().audio.speaking", Boolean, 20_000);
    expect((await inspect()).snapshot.narrative?.dialogue?.text).toEqual(response.text);
    expect((await inspect()).snapshot.tick).toBe(talking.snapshot.tick);
    expect(await evaluate(cdp, "!document.querySelector('.voice-caption').hidden")).toBe(true);
    await evaluate(cdp, "window.dispatchEvent(new Event('blur'))");
    expect((await inspect()).audio.voices).toBe(0);
    expect((await inspect()).audio.streams).toHaveLength(0);
    await select('[data-action="open-settings"]');
    expect((await inspect()).audio.active).toBe(false);
    await language("ru");
    await select('[data-action="open-dialogue"]');
    const resumed = await inspect();
    expect(resumed.overlay, JSON.stringify(resumed.audio)).toBe("dialogue");
    expect(resumed.audio.active, JSON.stringify(resumed.audio)).toBe(true);
    expect(resumed.audio.failures).toEqual([]);
    expect(resumed.settings.language).toBe("ru");
    await until(cdp, "window.korovany.inspect().audio.subtitle?.language === 'ru' && window.korovany.inspect().audio.voices > 0", Boolean, 20_000);
    expect((await inspect()).snapshot.tick).toBe(talking.snapshot.tick);
    expect((await inspect()).audio.failures).toEqual([]);
    expect((await inspect()).audio.cacheBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
  }, 120_000);

  it("shows a localized warning rather than oscillator/TTS replacement when local manifests are absent", async () => {
    failAssets = true;
    await evaluate(cdp, `localStorage.setItem(${JSON.stringify(storageKeys.settings)}, ${JSON.stringify(JSON.stringify({
      language: "en", quality: "low", reducedMotion: true, muted: false, audio: defaultMix(),
    }))})`);
    await reload();
    await select('[data-action="continue"]');
    await until(cdp, "window.korovany.inspect().audio.failures.length > 0", Boolean, 20_000);
    expect(await evaluate(cdp, "document.querySelector('.warnings').textContent.includes('audio')")).toBe(true);
    expect(await evaluate(cdp, "document.querySelector('.dialogue-speech').textContent.length > 0")).toBe(true);
    expect((await inspect()).audio.voices).toBe(0);
    expect((await inspect()).audio.streams).toHaveLength(0);
  }, 90_000);

  it("unlocks an initially muted session on the actual unmute change, without a second gesture", async () => {
    failAssets = false;
    await evaluate(cdp, `localStorage.setItem(${JSON.stringify(storageKeys.settings)}, ${JSON.stringify(JSON.stringify({
      language: "en", quality: "low", reducedMotion: true, muted: true, audio: defaultMix(),
    }))})`);
    await reload();
    await select('[data-action="open-settings"]');
    expect((await inspect()).audio.state).toBe("locked");
    await select('.settings-panel input[type="checkbox"]');
    await until(cdp, "window.korovany.inspect().audio.streams.some(s => s.id === 'title' && !s.paused && s.time > 0.1)", Boolean, 20_000);
    expect((await inspect()).audio.muted).toBe(false);
  }, 90_000);
});
