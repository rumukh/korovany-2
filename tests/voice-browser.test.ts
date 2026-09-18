import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createCampaign, type GameSnapshot, type LocalizedText } from "../src/game";
import { paragraphs, voiceKey, type VoiceEntry } from "../src/audio/manifest";
import type { Soundscape } from "../src/audio/soundscape";
import { storageKeys, type Settings } from "../src/ui/storage";
import {
  click, evaluate, launchBrowser, openPage, until, type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { closeTestBrowser } from "./browser-cleanup";
import { navigateTestPage, reloadTestPage } from "./browser-navigation";
import { isSpeechPlaying } from "./browser-audio";

interface Inspection {
  snapshot: GameSnapshot;
  overlay: string | null;
  running: boolean;
  settings: Settings;
  audio: ReturnType<Soundscape["inspect"]>;
}
interface SpeechObservation {
  audio: Inspection["audio"];
  captionVisible: boolean;
  paused: Inspection["audio"] | null;
}

// Transport-only media. This never enters public/audio and is not speech acceptance evidence.
function fixtureWave(): Buffer {
  const rate = 8000, samples = rate * 2;
  const result = Buffer.alloc(44 + samples * 2);
  result.write("RIFF", 0); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(rate, 24); result.writeUInt32LE(rate * 2, 28); result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34); result.write("data", 36); result.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) result.writeInt16LE(((i * 7919) % 257) - 128, 44 + i * 2);
  return result;
}

describe.runIf(process.env.KOROVANY_BROWSER === "1")("faction voice browser transport (HTTP fixtures, not recording approval)", () => {
  let server: ViteDevServer, browser: LaunchedBrowser, cdp: CdpSession;
  let failAssets = false, requests = 0;
  const httpFailures: { path: string; status: number }[] = [];
  const traceAudio = (phase: string, audio: Inspection["audio"]) => {
    if (process.env.KOROVANY_VOICE_TRACE !== "1") return;
    console.info(JSON.stringify({ phase, at: Date.now(), active: audio.active, speaking: audio.speaking,
      voices: audio.voices, effects: audio.effects, speaker: audio.subtitle?.speaker,
      language: audio.subtitle?.language, speechIndex: audio.speechIndex, clipIndex: audio.clipIndex,
      speechLength: audio.speechLength, failures: audio.failures }));
  };
  const entries = new Map<string, VoiceEntry>();
  const add = (speaker: string, text: LocalizedText) => {
    for (const language of ["ru", "en"] as const) for (const block of paragraphs(text[language])) {
      const key = voiceKey(speaker, language, block);
      entries.set(key, { id: `fixture-${entries.size}`, speaker, language, text: block,
        clips: [{ src: `audio/voices/${language}-${speaker}-fixture.wav`, duration: 2 }] });
    }
  };
  const cases = (["elf", "guard", "villain"] as const).map(faction => {
    const game = createCampaign({ seed: "faction-voice-browser", faction, runId: `voice-browser-${faction}` });
    game.step();
    const npcId = game.snapshot().narrative!.interaction!.targetId;
    game.step({ narrative: { type: "talk", npcId } });
    const initial = game.snapshot().narrative!.dialogue!, saved = game.serialize();
    const choice = initial.choices.find(c => c.enabled && c.id !== "leave")!;
    game.step({ narrative: { type: "choose", npcId, choiceId: choice.id } });
    const response = game.snapshot().narrative!.dialogue!;
    add(npcId, initial.text); add("player", choice.text); add(npcId, response.text);
    return { faction, npcId, saved, choice, response };
  });
  const wave = fixtureWave();
  const inspect = async () => {
    const inspected = await evaluate<Inspection>(cdp, "window.korovany.inspect()");
    traceAudio("inspect", inspected.audio);
    return inspected;
  };
  const speech = (speaker: string, language: "ru" | "en", action: "observe" | "blur" = "observe") => {
    let prior = "";
    // A two-second source may end between CDP roundtrips; observe playback and blur in one browser task.
    const expression = `(() => {
      const audio = window.korovany.inspect().audio;
      const playing = audio.speaking && audio.voices > audio.effects &&
        audio.subtitle?.speaker === ${JSON.stringify(speaker)} && audio.subtitle.language === ${JSON.stringify(language)};
      const caption = document.querySelector(".voice-caption");
      const captionVisible = caption !== null && !caption.hidden;
      const pause = playing && ${action === "blur"};
      if (pause) window.dispatchEvent(new Event("blur"));
      return {audio, captionVisible, paused: pause ? window.korovany.inspect().audio : null};
    })()`;
    return until<SpeechObservation>(cdp, expression, observation => {
      const audio = observation.audio;
      const state = JSON.stringify([audio.active, audio.speaking, audio.voices, audio.effects, audio.subtitle?.speaker,
        audio.subtitle?.language, audio.speechIndex, audio.clipIndex, audio.speechLength]);
      if (state !== prior) traceAudio(`${action}-${language}-${speaker}`, audio);
      if (observation.paused) traceAudio(`paused-${language}-${speaker}`, observation.paused);
      prior = state;
      return isSpeechPlaying(audio, speaker, language);
    }, 20_000);
  };

  async function select(selector: string): Promise<void> {
    const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length);
      if (!element || element.disabled) throw new Error("Unavailable voice test control");
      element.scrollIntoView({block:"center"});
      const r = element.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    await click(cdp, point.x, point.y);
  }
  async function load(item: typeof cases[number], language: "ru" | "en", muted = false): Promise<void> {
    await evaluate(cdp, `(() => {
      localStorage.setItem(${JSON.stringify(storageKeys.campaign)}, ${JSON.stringify(JSON.stringify(item.saved))});
      localStorage.setItem(${JSON.stringify(storageKeys.settings)}, ${JSON.stringify(JSON.stringify({
        language, muted, quality: "low", reducedMotion: true,
      }))});
    })()`);
    await reloadTestPage(cdp, "window.korovany");
  }

  beforeAll(async () => {
    server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
      plugins: [{ name: "voice-transport-fixtures", configureServer(server) {
        server.middlewares.use((req, res, next) => {
          res.once("finish", () => {
            if (res.statusCode >= 400) {
              const failure = { status: res.statusCode, path: req.url ?? "" };
              httpFailures.push(failure);
              if (process.env.KOROVANY_VOICE_TRACE === "1") console.info(JSON.stringify(failure));
            }
          });
          if (!req.url?.startsWith("/audio/voices/")) return next();
          requests++;
          if (failAssets) { res.statusCode = 404; res.end("Missing test fixture"); return; }
          if (req.url.endsWith("manifest.json")) {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ version: 1, entries: [...entries.values()] }));
          } else {
            res.setHeader("Content-Type", "audio/wav"); res.setHeader("Content-Length", wave.length); res.end(wave);
          }
        });
      } }] });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error("Missing voice test URL");
    expect((await fetch(origin)).status).toBe(200);
    browser = await launchBrowser({ viewport: { width: 1440, height: 1000 } });
    cdp = await openPage(browser.port, "about:blank", { width: 1440, height: 1000 });
    await navigateTestPage(cdp, origin, "window.korovany");
  }, 90_000);

  afterAll(async () => {
    cdp?.close();
    try {
      if (browser) await closeTestBrowser(browser);
    } finally { await server?.close(); }
  }, 30_000);

  test.each(cases)("$faction: real RU/EN player-to-NPC sequence, paused ticks, focus and reload", async item => {
    const firstHttpFailure = httpFailures.length;
    for (const language of ["ru", "en"] as const) {
      const beforeRequests = requests;
      await load(item, language);
      expect((await inspect()).audio.state).toBe("locked");
      expect(requests).toBe(beforeRequests);
      await select('[data-action="continue"]');
      await speech(item.npcId, language);
      const before = await inspect();
      expect(before.overlay).toBe("dialogue");
      expect(before.running).toBe(false);
      await select(`[data-choice="${item.choice.id}"]`);
      const player = await speech("player", language);
      expect(player.captionVisible).toBe(true);
      const paused = await speech(item.npcId, language, "blur");
      expect(isSpeechPlaying(paused.audio, item.npcId, language)).toBe(true);
      expect(paused.paused).toMatchObject({ active: false, speaking: false, voices: 0 });
      const response = await inspect();
      expect(response.snapshot.narrative!.dialogue!.text).toEqual(item.response.text);
      expect(response.snapshot.tick).toBe(before.snapshot.tick);
      await evaluate(cdp, "window.dispatchEvent(new Event('focus'))");
      await speech(item.npcId, language);
      await select('[data-action="close-dialogue"]');
      expect((await inspect()).audio.speaking).toBe(false);
      expect((await inspect()).audio.speechLength).toBe(0);
      expect((await inspect()).audio.failures).toEqual([]);
      expect((await inspect()).audio.cacheBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
    }
    expect(httpFailures.slice(firstHttpFailure).filter(failure => failure.path.startsWith("/audio/"))).toEqual([]);
  }, 90_000);

  test("settings pause and language replacement never resume a stale-language response", async () => {
    await load(cases[0]!, "en");
    await select('[data-action="continue"]');
    await speech(cases[0]!.npcId, "en");
    await select('[data-action="open-settings"]');
    expect((await inspect()).audio.voices).toBe(0);
    await evaluate(cdp, `(() => { const s=document.querySelector(".settings-panel select");
      s.value="ru"; s.dispatchEvent(new Event("change",{bubbles:true})); })()`);
    await select('[data-action="open-dialogue"]');
    await speech(cases[0]!.npcId, "ru");
    expect((await inspect()).audio.failures).toEqual([]);
  });

  test("missing assets are explicit, and muted startup creates no context until trusted unmute", async () => {
    failAssets = true;
    await load(cases[0]!, "en");
    await select('[data-action="continue"]');
    await until(cdp, "window.korovany.inspect().audio.failures.length > 0", Boolean, 20_000);
    expect(await evaluate(cdp, "document.querySelector('.warnings').textContent.includes('audio')")).toBe(true);
    expect((await inspect()).audio.speaking).toBe(false);
    failAssets = false;
    await load(cases[0]!, "en", true);
    await select('[data-action="continue"]');
    expect((await inspect()).audio.state).toBe("locked");
    await select('[data-action="open-settings"]');
    await select('.settings-panel input[type="checkbox"]');
    await until(cdp, "window.korovany.inspect().audio.state === 'running'", Boolean, 20_000);
    await select('[data-action="open-dialogue"]');
    await speech(cases[0]!.npcId, "en");
  });
});
