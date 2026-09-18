import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createCampaign } from "../src/game";
import { getFactionStory } from "../src/game/faction-stories";
import { paragraphs, parseVoices, voiceKey, type VoiceEntry } from "../src/audio/manifest";
import type { Soundscape } from "../src/audio/soundscape";
import { storageKeys } from "../src/ui/storage";
import { createVoiceCatalogue, factions, hashText, journalBefore, scene, voiceState } from "../scripts/voices/catalogue";
import {
  click, evaluate, launchBrowser, openPage, until, type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { closeOwnedBrowser } from "../vendor/aegis-engine/packages/render-three/src/testing/browser-lifecycle";

type AudioState = ReturnType<Soundscape["inspect"]>;
interface Decoded {
  src: string; channels: number; nativeSampleRate: number; primingSeconds: number;
  duration: number; peak: number; rms: number;
}

describe.runIf(process.env.KOROVANY_BROWSER === "1" && process.env.KOROVANY_VOICE_ASSETS === "1")(
  "complete real faction recordings under a deployment prefix (staged or released)", () => {
    let server: ViteDevServer, browser: LaunchedBrowser, cdp: CdpSession;
    let origin: string, manifest: Map<string, VoiceEntry>;
    const base = "/voice-acceptance/";

    async function select(selector: string): Promise<void> {
      const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element || element.disabled) throw new Error("Unavailable voice asset control");
        element.scrollIntoView({block:"center"}); const r=element.getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2};
      })()`);
      await click(cdp, point.x, point.y);
    }
    async function navigate(url: string, ready: string): Promise<void> {
      const previous = await evaluate<number>(cdp, "performance.timeOrigin");
      await cdp.send("Page.navigate", { url });
      await until(cdp, `performance.timeOrigin !== ${previous} && Boolean(${ready})`, Boolean, 60_000);
    }
    async function playing(expression: string, speaker: string, language: "ru" | "en"): Promise<AudioState["speech"]> {
      return until<AudioState["speech"]>(cdp, expression,
        state => state.playing && state.subtitle?.speaker === speaker && state.subtitle.language === language, 45_000);
    }
    async function decode(src: string): Promise<Decoded> {
      return evaluate<Decoded>(cdp, `(async () => {
        const src=${JSON.stringify(src)}, response=await fetch(${JSON.stringify(base)}+src);
        if(!response.ok)throw new Error(src+": HTTP "+response.status);
        const bytes=await response.arrayBuffer();
        if(String.fromCharCode(...new Uint8Array(bytes,0,4))!=="OggS")throw new Error(src+": not Ogg");
        const header=new Uint8Array(bytes,0,Math.min(bytes.byteLength,512)), magic=[1,118,111,114,98,105,115];
        const start=header.findIndex((_,index)=>magic.every((byte,offset)=>header[index+offset]===byte));
        if(start<0||start+30>header.length)throw new Error(src+": missing Vorbis identification");
        const vorbis=new DataView(bytes,start), nativeSampleRate=vorbis.getUint32(12,true);
        const shortBlock=2**(vorbis.getUint8(28)&15);
        const buffer=await new OfflineAudioContext(1,1,48000).decodeAudioData(bytes);
        let peak=0,squared=0;
        for(let channel=0;channel<buffer.numberOfChannels;channel++)for(const sample of buffer.getChannelData(channel)){
          if(!Number.isFinite(sample))throw new Error(src+": nonfinite PCM");
          peak=Math.max(peak,Math.abs(sample));squared+=sample*sample;
        }
        return {src,channels:buffer.numberOfChannels,nativeSampleRate,primingSeconds:shortBlock/2/nativeSampleRate,
          duration:buffer.duration,peak,rms:Math.sqrt(squared/(buffer.length*buffer.numberOfChannels))};
      })()`);
    }

    beforeAll(async () => {
      const staging = process.env.KOROVANY_VOICE_STAGING;
      const raw = JSON.parse(await readFile(staging ? join(staging, "audio", "voices", "staging-index.json") :
        new URL("../public/audio/voices/manifest.json", import.meta.url), "utf8"));
      if (staging) {
        expect(raw.status).toBe("unreleased-awaiting-final-human-review");
        expect(raw.inventory_source_hash).toBe(hashText(JSON.stringify(createVoiceCatalogue())));
      }
      manifest = parseVoices(raw);
      const clips = new Set([...manifest.values()].flatMap(entry => entry.clips.map(clip => clip.src)));
      server = await createServer({ configFile: false, base, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
        plugins: [{ name: "released-voice-acceptance-page", configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            const path = request.url?.split("?")[0];
            if (staging && path?.startsWith(`${base}audio/voices/`)) {
              const src = path.slice(base.length);
              if (src === "audio/voices/manifest.json") {
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify({ version: 1, entries: [...manifest.values()] }));
              } else if (clips.has(src)) {
                void readFile(join(staging, ...src.split("/"))).then(bytes => {
                  response.setHeader("Content-Type", "audio/ogg");
                  response.setHeader("Content-Length", bytes.length);
                  response.end(bytes);
                }, next);
              } else { response.statusCode = 404; response.end("Unknown staged voice"); }
              return;
            }
            if (request.url?.split("?")[0] !== `${base}media-check.html`) return next();
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end('<!doctype html><html lang="en"><title>Real voice transport verification</title><body><button id="unlock">Play</button></body></html>');
          });
        } }] });
      await server.listen();
      const local = server.resolvedUrls?.local[0];
      if (!local) throw new Error("Missing released-voice URL");
      origin = new URL(base, local).href;
      expect((await fetch(new URL("audio/voices/manifest.json", origin))).status).toBe(200);
      browser = await launchBrowser({ viewport: { width: 1440, height: 1000 } });
      cdp = await openPage(browser.port, new URL("media-check.html", origin).href, { width: 1440, height: 1000 });
      await until(cdp, "Boolean(document.querySelector('#unlock'))", Boolean, 30_000);
    }, 90_000);

    afterAll(async () => {
      cdp?.close();
      try {
        if (browser) { await closeOwnedBrowser(browser); await rm(browser.profile, { recursive: true, force: true }); }
      } finally { await server?.close(); }
    }, 30_000);

    test("fully decodes every unique deployed Ogg and exactly matches the current local faction inventory", async () => {
      const expected = createVoiceCatalogue();
      expect(manifest.size).toBe(expected.length);
      expect(new Set([...manifest.values()].map(e => e.speaker)).size).toBe(22);
      const unique = new Map<string, number>();
      for (const entry of expected) {
        const actual = manifest.get(voiceKey(entry.speaker, entry.language, entry.text));
        expect(actual?.id, entry.id).toBe(entry.id);
        expect(actual!.clips).toHaveLength(entry.segments.length);
        for (const clip of actual!.clips) {
          if (unique.has(clip.src)) expect(unique.get(clip.src)).toBe(clip.duration);
          unique.set(clip.src, clip.duration);
        }
      }
      for (const [src, duration] of unique) {
        const decoded = await decode(src);
        expect(decoded.channels, src).toBe(1);
        expect(decoded.nativeSampleRate, src).toBe(24000);
        expect(Math.abs(decoded.duration - duration), src).toBeLessThanOrEqual(decoded.primingSeconds + 1 / 24000);
        expect(decoded.peak, src).toBeGreaterThan(0.00001);
        expect(decoded.peak, src).toBeLessThan(1);
        expect(decoded.rms, src).toBeGreaterThan(0.000001);
      }
    }, 600_000);

    test("plays all nine actual faction epilogues without looking up obsolete ending-score IDs", async () => {
      await evaluate(cdp, `(async () => {
        const {Soundscape}=await import(${JSON.stringify(`${base}src/audio/soundscape.ts`)});
        const {SpeechPresentation}=await import(${JSON.stringify(`${base}src/audio/presentation.ts`)});
        const failures=[],sound=new Soundscape(()=>failures.push("voice"));
        window.voiceAcceptance={sound,presentation:new SpeechPresentation(sound),failures};
        document.querySelector("#unlock").addEventListener("click",e=>{if(e.isTrusted)void sound.unlock()});
      })()`);
      try {
        for (const faction of factions) {
          const final = getFactionStory(faction).quests.find(q => q.stages.some(s => s.actions.some(a => a.ending)))!;
          for (const ending of final.stages.at(-1)!.actions) {
            const snapshot = createCampaign({ faction, seed: "released-ending", runId: ending.id }).snapshot();
            snapshot.phase = "victory";
            snapshot.narrative = scene(voiceState(faction, journalBefore(faction, final, final.stages.length, [ending.id]), true));
            for (const language of ["ru", "en"] as const) {
              for (const block of paragraphs(snapshot.narrative.ending![language])) {
                expect(manifest.has(voiceKey("narrator", language, block)), `${ending.id}: ${block}`).toBe(true);
              }
              await evaluate(cdp, `window.voiceAcceptance.presentation.sync(${JSON.stringify(snapshot)},"terminal",false,${JSON.stringify(language)})`);
              await select("#unlock");
              const speech = await playing("window.voiceAcceptance.sound.inspect().speech", "narrator", language);
              expect(speech.lastDecoded?.src).toMatch(/\.ogg$/);
              expect(speech.failures).toEqual([]);
              expect(await evaluate(cdp, "window.voiceAcceptance.failures")).toEqual([]);
            }
          }
        }
      } finally { await evaluate(cdp, "window.voiceAcceptance.sound.dispose()"); }
    }, 180_000);

    test.each(factions)("%s: actual RU/EN dialogue, focus, language, reload and cancellation", async faction => {
      const game = createCampaign({ faction, seed: "released-conversation", runId: `released-${faction}` });
      game.step();
      const npcId = game.snapshot().narrative!.interaction!.targetId;
      game.step({ narrative: { type: "talk", npcId } });
      const saved = game.serialize(), before = game.snapshot();
      const choice = before.narrative!.dialogue!.choices.find(c => c.enabled && c.id !== "leave")!;
      for (const language of ["ru", "en"] as const) {
        await evaluate(cdp, `(() => {
          localStorage.setItem(${JSON.stringify(storageKeys.campaign)},${JSON.stringify(JSON.stringify(saved))});
          localStorage.setItem(${JSON.stringify(storageKeys.settings)},${JSON.stringify(JSON.stringify({
            language, quality: "low", reducedMotion: true, muted: false,
          }))});
        })()`);
        await navigate(origin, "window.korovany");
        await select('[data-action="continue"]');
        await playing("window.korovany.inspect().audio.speech", npcId, language);
        await select(`[data-choice="${choice.id}"]`);
        await playing("window.korovany.inspect().audio.speech", "player", language);
        const speech = await playing("window.korovany.inspect().audio.speech", npcId, language);
        expect(speech.lastDecoded?.src).toMatch(/\.ogg$/);
        expect(speech.failures).toEqual([]);
        expect(await evaluate(cdp, "window.korovany.inspect().snapshot.tick")).toBe(before.tick);
        expect(await evaluate(cdp, "window.korovany.inspect().running")).toBe(false);
        await evaluate(cdp, "window.dispatchEvent(new Event('blur'))");
        expect(await evaluate(cdp, "window.korovany.inspect().audio.voices")).toBe(0);
        await evaluate(cdp, "window.dispatchEvent(new Event('focus'))");
        await playing("window.korovany.inspect().audio.speech", npcId, language);
        await select('[data-action="open-settings"]');
        expect(await evaluate(cdp, "window.korovany.inspect().audio.voices")).toBe(0);
        const nextLanguage = language === "ru" ? "en" : "ru";
        await evaluate(cdp, `(() => {
          const language=document.querySelector(".settings-panel select");
          language.value=${JSON.stringify(nextLanguage)};
          language.dispatchEvent(new Event("change",{bubbles:true}));
        })()`);
        await select('[data-action="open-dialogue"]');
        await playing("window.korovany.inspect().audio.speech", npcId, nextLanguage);
        await navigate(origin, "window.korovany");
        expect(await evaluate(cdp, "window.korovany.inspect().audio.state")).toBe("locked");
        await select('[data-action="continue"]');
        const restored = await playing("window.korovany.inspect().audio.speech", npcId, nextLanguage);
        expect(restored.failures).toEqual([]);
        expect(await evaluate(cdp, "window.korovany.inspect().snapshot.tick")).toBe(before.tick);
        await select('[data-action="close-dialogue"]');
        expect(await evaluate(cdp, "window.korovany.inspect().audio.speech.playing")).toBe(false);
        expect(await evaluate(cdp, "window.korovany.inspect().audio.speech.length")).toBe(0);
      }
    }, 180_000);
  },
);
