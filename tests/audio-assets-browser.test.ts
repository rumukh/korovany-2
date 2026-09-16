import { readFile, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createCampaign, type GameSnapshot } from "../src/game";
import { ENDINGS } from "../src/game/narrative-data";
import { parseSoundtrack, parseVoices, type SoundtrackManifest } from "../src/audio/manifest";
import { defaultMix } from "../src/audio/mix";
import type { Soundscape } from "../src/audio/soundscape";
import { storageKeys } from "../src/ui/storage";
import {
  click, evaluate, launchBrowser, openPage, until, type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { closeOwnedBrowser } from "../vendor/aegis-engine/packages/render-three/src/testing/browser-lifecycle";

interface Decoded {
  src: string;
  channels: number;
  duration: number;
  peak: number;
  rms: number;
}

describe.runIf(process.env.KOROVANY_BROWSER === "1")("shipped Ogg audio under a deployment prefix", () => {
  let server: ViteDevServer;
  let browser: LaunchedBrowser;
  let cdp: CdpSession;
  let origin: string;
  let soundtrack: SoundtrackManifest;
  const base = "/audio-acceptance/";
  const inspect = () => evaluate<ReturnType<Soundscape["inspect"]>>(cdp, "window.korovany.inspect().audio");

  async function select(selector: string): Promise<void> {
    const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) throw new Error("Missing enabled audio control");
      element.scrollIntoView({block:"center"});
      const rect = element.getBoundingClientRect();
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`);
    await click(cdp, point.x, point.y);
  }

  async function decode(src: string): Promise<Decoded> {
    return evaluate<Decoded>(cdp, `(async () => {
      const src = ${JSON.stringify(src)};
      const response = await fetch(${JSON.stringify(base)} + src);
      if (!response.ok) throw new Error(src + ": HTTP " + response.status);
      const bytes = await response.arrayBuffer();
      if (String.fromCharCode(...new Uint8Array(bytes, 0, 4)) !== "OggS") throw new Error(src + ": not shipped Ogg");
      const decoder = new OfflineAudioContext(2, 1, 48000);
      const buffer = await decoder.decodeAudioData(bytes);
      let peak = 0, squared = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        for (const sample of buffer.getChannelData(channel)) {
          if (!Number.isFinite(sample)) throw new Error(src + ": nonfinite PCM");
          peak = Math.max(peak, Math.abs(sample));
          squared += sample * sample;
        }
      }
      return {src,channels:buffer.numberOfChannels,duration:buffer.duration,peak,
        rms:Math.sqrt(squared/(buffer.length*buffer.numberOfChannels))};
    })()`);
  }

  function audible(decoded: Decoded, duration: number, channels: number): void {
    expect(decoded.channels, decoded.src).toBe(channels);
    expect(Math.abs(decoded.duration - duration), decoded.src).toBeLessThanOrEqual(256 / 48000);
    expect(decoded.peak, decoded.src).toBeGreaterThan(0.00001);
    expect(decoded.peak, decoded.src).toBeLessThan(1);
    expect(decoded.rms, decoded.src).toBeGreaterThan(0.000001);
  }

  beforeAll(async () => {
    soundtrack = parseSoundtrack(JSON.parse(await readFile(new URL("../public/audio/soundtrack/manifest.json", import.meta.url), "utf8")));
    server = await createServer({
      configFile: false, base, server: { host: "127.0.0.1", port: 0 },
      plugins: [{
        name: "audio-acceptance-page",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url?.split("?")[0] !== `${base}media-check.html`) return next();
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end('<!doctype html><html lang="en"><title>Shipped audio acceptance</title><body><button id="unlock">Play</button></body></html>');
          });
        },
      }],
    });
    await server.listen();
    const local = server.resolvedUrls?.local[0];
    if (!local) throw new Error("No actual-asset test URL.");
    origin = new URL(base, local).href;
    expect((await fetch(new URL("audio/soundtrack/manifest.json", origin))).status).toBe(200);
    browser = await launchBrowser({ viewport: { width: 1280, height: 900 } });
    cdp = await openPage(browser.port, new URL("media-check.html", origin).href, { width: 1280, height: 900 });
    await until(cdp, "Boolean(document.querySelector('#unlock'))", Boolean, 30_000);
  }, 120_000);

  afterAll(async () => {
    cdp?.close();
    if (browser) {
      await closeOwnedBrowser(browser);
      await rm(browser.profile, { recursive: true, force: true });
    }
    await server?.close();
  }, 30_000);

  it("fully decodes every shipped score, regional loop and effect in Chromium", async () => {
    expect(soundtrack.music).toHaveLength(8);
    expect(soundtrack.ambience).toHaveLength(8);
    expect(soundtrack.sfx).toHaveLength(24);
    for (const [group, channels] of [[soundtrack.music, 2], [soundtrack.ambience, 2], [soundtrack.sfx, 1]] as const) {
      for (const asset of group) audible(await decode(asset.src), asset.duration, channels);
    }
  }, 180_000);

  it("fully decodes the complete bilingual dialogue corpus, not audition substitutes", async () => {
    const manifest = parseVoices(await (await fetch(new URL("audio/voices/manifest.json", origin))).json());
    expect(manifest.size).toBe(698);
    expect(new Set([...manifest.values()].map((entry) => entry.speaker)).size).toBe(22);
    const clips = [...manifest.values()].flatMap((entry) => entry.clips);
    expect(clips).toHaveLength(2265);
    for (const language of ["ru", "en"]) {
      expect([...manifest.values()].filter((entry) => entry.language === language)).toHaveLength(349);
    }
    for (const clip of clips) audible(await decode(clip.src), clip.duration, 1);
  }, 600_000);

  it("plays real ending music and terminal cues through the production transport", async () => {
    await cdp.send("Page.navigate", { url: new URL("media-check.html", origin).href });
    await until(cdp, "Boolean(document.querySelector('#unlock'))", Boolean, 30_000);
    const snapshot = createCampaign({ seed: "audio-terminal", faction: "guard", runId: "audio-terminal" }).snapshot();
    await evaluate(cdp, `(async () => {
      const {Soundscape} = await import(${JSON.stringify(`${base}src/audio/soundscape.ts`)});
      const {AudioPresentation} = await import(${JSON.stringify(`${base}src/audio/presentation.ts`)});
      const sound = new Soundscape(() => {});
      const presentation = new AudioPresentation(sound);
      sound.configure(false, {...${JSON.stringify(defaultMix())},voices:0});
      window.audioAcceptance = {sound,presentation};
      document.querySelector("#unlock").addEventListener("click", event => {
        if (event.isTrusted) void sound.unlock();
      });
    })()`);
    try {
      for (const [id, title] of Object.entries(ENDINGS)) {
        const terminal: GameSnapshot = structuredClone(snapshot);
        terminal.runId = `audio-${id}`;
        terminal.phase = "victory";
        terminal.narrative!.ending = title;
        await evaluate(cdp, `(() => {
          const {sound,presentation} = window.audioAcceptance;
          presentation.reset(${JSON.stringify(terminal)});
          presentation.sync(${JSON.stringify(terminal)}, "terminal", false, "en");
        })()`);
        await select("#unlock");
        await until(cdp, `window.audioAcceptance.sound.inspect().streams.some(s => s.id === "ending-${id}" && !s.paused && s.time > 0.15)`,
          Boolean, 30_000);
        const audio = await evaluate<ReturnType<Soundscape["inspect"]>>(cdp, "window.audioAcceptance.sound.inspect()");
        expect(audio.failures).toEqual([]);
        expect(audio.recentEffects.some((effect) => effect.id === "victory")).toBe(true);
      }
      snapshot.phase = "defeat";
      await evaluate(cdp, `(() => {
        const {presentation} = window.audioAcceptance;
        presentation.reset(${JSON.stringify(snapshot)});
        presentation.sync(${JSON.stringify(snapshot)}, "terminal", false, "en");
      })()`);
      await until(cdp, "window.audioAcceptance.sound.inspect().recentEffects.some(e => e.id === 'defeat')", Boolean, 20_000);
      await until(cdp, "window.audioAcceptance.sound.inspect().streams.length === 0", Boolean, 10_000);
      expect(await evaluate(cdp, "window.audioAcceptance.sound.inspect().failures")).toEqual([]);
    } finally {
      await evaluate(cdp, "window.audioAcceptance.sound.dispose()");
    }
  }, 120_000);

  it("plays the actual Russian and English conversation in game without advancing its paused simulation", async () => {
    const game = createCampaign({ seed: "audio-conversation", faction: "guard", runId: "audio-conversation" });
    game.step();
    const interaction = game.snapshot().narrative!.interaction!;
    expect(interaction.kind).toBe("talk");
    game.step({ narrative: { type: "talk", npcId: interaction.targetId } });
    const saved = game.serialize();
    const initial = game.snapshot();
    const choice = initial.narrative!.dialogue!.choices.find((entry) => entry.enabled && entry.id !== "leave")!;
    for (const language of ["ru", "en"] as const) {
      await evaluate(cdp, `(() => {
        localStorage.clear();
        localStorage.setItem(${JSON.stringify(storageKeys.campaign)},${JSON.stringify(JSON.stringify(saved))});
        localStorage.setItem(${JSON.stringify(storageKeys.settings)},${JSON.stringify(JSON.stringify({
          language, quality: "low", reducedMotion: true, muted: false, audio: defaultMix(),
        }))});
      })()`);
      await cdp.send("Page.navigate", { url: origin });
      await until(cdp, "Boolean(window.korovany)", Boolean, 60_000);
      expect((await inspect()).state).toBe("locked");
      await select('[data-action="continue"]');
      await until(cdp, `window.korovany.inspect().audio.speaking && window.korovany.inspect().audio.subtitle?.language === "${language}"`,
        Boolean, 30_000);
      let audio = await inspect();
      expect(audio.subtitle?.speaker).toBe(interaction.targetId);
      expect(audio.lastDecoded?.src).toMatch(/\.ogg$/);
      expect(audio.failures).toEqual([]);
      await select(`[data-choice="${choice.id}"]`);
      await until(cdp, "window.korovany.inspect().audio.subtitle?.speaker === 'player' && window.korovany.inspect().audio.speaking",
        Boolean, 30_000);
      await until(cdp, `window.korovany.inspect().audio.subtitle?.speaker === "${interaction.targetId}" && window.korovany.inspect().audio.speaking`,
        Boolean, 60_000);
      expect(await evaluate(cdp, "window.korovany.inspect().snapshot.tick")).toBe(initial.tick);
      expect(await evaluate(cdp, "window.korovany.inspect().running")).toBe(false);
      audio = await inspect();
      expect(audio.failures).toEqual([]);
      expect(audio.cacheBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
      await select('[data-action="open-settings"]');
      expect((await inspect()).active).toBe(false);
      expect((await inspect()).streams).toHaveLength(0);
    }
  }, 240_000);
});
