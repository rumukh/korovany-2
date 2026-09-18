import type { GameSnapshot, LocalizedText, Vec2 } from "../game";
import type { EndingId } from "../game/narrative-data";
import { getFactionStory } from "../game/faction-stories";
import type { Language } from "../ui/storage";
import type { Overlay } from "../ui/shell";
import { translate } from "../ui/locale";
import { paragraphs } from "./manifest";
import type { Soundscape } from "./soundscape";

export type AudioOutput = Pick<Soundscape, "setActive" | "setScene" | "speak" | "cancelSpeech" | "cue">;

interface DialogueLine {
  speaker: string;
  text: LocalizedText;
  name?: LocalizedText;
}

export interface SpeechSelection {
  player?: LocalizedText;
  restart?: boolean;
}

export function audioScreen(overlay: Overlay, atTitle: boolean): "title" | "game" | "story" | "terminal" | "paused" {
  if (overlay === "fatal") return "paused";
  if (atTitle) return "title";
  if (overlay === "dialogue" || overlay === "inspection") return "story";
  if (overlay === "terminal") return "terminal";
  return overlay === null ? "game" : "paused";
}

export function regionAudio(snapshot: GameSnapshot): string {
  const point = snapshot.player;
  const region = snapshot.world.exploration?.regions.find(({ bounds }) =>
    point.x >= bounds.minX && point.x <= bounds.maxX && point.z >= bounds.minZ && point.z <= bounds.maxZ);
  const aliases: Record<string, string> = { fenlands: "fens", saltcoast: "salt-coast", ashsteppe: "ash-steppe" };
  return region ? aliases[region.id] ?? region.id : "heartlands";
}

export function endingMusic(snapshot: GameSnapshot): string | null {
  if (snapshot.phase !== "victory") return null;
  const title = paragraphs(snapshot.narrative?.ending?.en ?? "")[0];
  const endings = getFactionStory(snapshot.faction).endings;
  const ending = (Object.keys(endings) as EndingId[]).find((id) => endings[id].en === title);
  return ending ? `ending-${ending}` : snapshot.narrative ? null : "ending-commons";
}

/** Detached snapshots drive cosmetic audio only; no intent or simulation state is written. */
export class AudioPresentation {
  private previous: GameSnapshot | null = null;
  private lastEvent = 0;
  private dangerUntil = 0;
  private bossUntil = 0;
  private region = "heartlands";
  private candidateRegion = "";
  private regionSince = 0;
  private footDistance = 0;
  private convoyDistance = 0;
  private screen: ReturnType<typeof audioScreen> = "title";
  private sceneKey = "";
  private revision = 0;
  private lines: DialogueLine[] = [];
  private focused = true;
  private terminalCue = "";

  constructor(private readonly sound: AudioOutput) {}

  reset(snapshot: GameSnapshot): void {
    this.previous = snapshot;
    this.lastEvent = snapshot.events.at(-1)?.id ?? 0;
    this.dangerUntil = 0;
    this.bossUntil = 0;
    this.region = regionAudio(snapshot);
    this.candidateRegion = this.region;
    this.footDistance = 0;
    this.convoyDistance = 0;
    this.sceneKey = "";
    this.lines = [];
    this.terminalCue = "";
    this.sound.cancelSpeech();
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    this.sound.setActive(focused && this.screen !== "paused");
  }

  sync(snapshot: GameSnapshot | null, overlay: Overlay, atTitle: boolean, language: Language, selection?: SpeechSelection): void {
    this.screen = audioScreen(overlay, atTitle);
    this.sound.setActive(this.focused && this.screen !== "paused");
    this.beds(snapshot);
    if (this.screen === "terminal" && snapshot && this.terminalCue !== `${snapshot.runId}:${snapshot.phase}`) {
      this.sound.cue(snapshot.phase === "victory" ? "victory" : "defeat");
      this.terminalCue = `${snapshot.runId}:${snapshot.phase}`;
    }
    if (this.screen === "paused") return;
    const dialogue = this.screen === "story" ? snapshot?.narrative?.dialogue : null;
    const inspection = this.screen === "story" ? snapshot?.narrative?.inspection : null;
    const ending = this.screen === "terminal" ? snapshot?.narrative?.ending : null;
    const key = JSON.stringify([snapshot?.runId, snapshot?.faction,
      dialogue ? ["dialogue", dialogue.npcId, dialogue.text] :
        inspection ? ["inspection", inspection.locationId, inspection.text] :
          ending ? ["ending", ending] : this.screen === "game" && selection?.player ? ["choice", selection.player] : this.screen]);
    if (selection?.restart || selection?.player || this.sceneKey !== key) {
      this.sceneKey = key;
      this.revision++;
      this.lines = [];
      if (selection?.player) this.lines.push({ speaker: "player", text: selection.player });
      if (this.screen === "story" && dialogue) this.lines.push({ speaker: dialogue.npcId, text: dialogue.text, name: dialogue.name });
      else if (this.screen === "story" && inspection) this.lines.push({ speaker: "narrator", text: inspection.text });
      else if (this.screen === "terminal" && ending) this.lines.push({ speaker: "narrator", text: ending });
    }
    this.sound.speak(`${snapshot?.runId ?? "title"}:${this.revision}:${language}`, this.lines.map((line) => ({
      speaker: line.speaker, language, text: line.text[language],
      label: line.name?.[language] ?? translate(language, `audio.${line.speaker}`),
    })));
  }

  private beds(snapshot: GameSnapshot | null): void {
    if (this.screen === "title") {
      this.sound.setScene("title", null);
      return;
    }
    if (!snapshot || this.screen === "paused") return;
    if (this.screen === "terminal" || snapshot.phase !== "playing") {
      this.sound.setScene(endingMusic(snapshot), null);
      return;
    }
    const near = (point: Vec2, radius: number) => Math.hypot(point.x - snapshot.player.x, point.z - snapshot.player.z) < radius;
    const enemies = snapshot.actors.filter((actor) => actor.hp > 0 && near(actor, 28) &&
      actor.allegiance !== "friendly" && actor.allegiance !== "neutral" &&
      ["windup", "attack", "chase"].includes(actor.state));
    if (enemies.length) this.dangerUntil = snapshot.elapsed + 6;
    if (snapshot.fortress.unlocked && !snapshot.fortress.bossDefeated &&
      snapshot.actors.some((actor) => actor.kind === "boss" && actor.hp > 0 && near(actor, 36) &&
        actor.allegiance !== "friendly" && actor.allegiance !== "neutral")) this.bossUntil = snapshot.elapsed + 8;
    const candidate = regionAudio(snapshot);
    if (candidate !== this.candidateRegion) {
      this.candidateRegion = candidate;
      this.regionSince = snapshot.elapsed;
    }
    if (snapshot.elapsed - this.regionSince >= 2) this.region = candidate;
    const mystery = ["fens", "hollowvale"].includes(this.region) ||
      snapshot.world.exploration?.locations.some((location) => ["ruin", "shrine"].includes(location.kind) && near(location, location.radius + 10));
    const music = snapshot.elapsed < this.bossUntil ? "fortress"
      : snapshot.elapsed < this.dangerUntil ? "combat" : mystery ? "mystery" : "road";
    this.sound.setScene(music, this.region);
  }

  update(snapshot: GameSnapshot): void {
    if (!this.previous || this.previous.runId !== snapshot.runId) this.reset(snapshot);
    const previous = this.previous!;
    this.beds(snapshot);
    const distance = (point: Vec2) => Math.hypot(point.x - snapshot.player.x, point.z - snapshot.player.z);
    const cueAt = (id: string, point: Vec2) => this.sound.cue(id, distance(point),
      ((point.x - snapshot.player.x) * Math.cos(snapshot.player.heading) -
        (point.z - snapshot.player.z) * Math.sin(snapshot.player.heading)) / 30);
    for (const event of snapshot.events) {
      if (event.id <= this.lastEvent) continue;
      this.lastEvent = event.id;
      if (event.kind === "notice") continue;
      const id = event.kind === "attack" ? `attack-${snapshot.faction}`
        : event.kind === "ability" ? `ability-${snapshot.faction}` : event.kind === "hurt" ? "hit" : event.kind;
      if (event.kind === "victory" || event.kind === "defeat") {
        this.sound.cue(id);
        this.terminalCue = `${snapshot.runId}:${snapshot.phase}`;
      }
      else cueAt(id, event);
    }
    if (this.screen === "game" && snapshot.tick > previous.tick) {
      const moved = distance(previous.player);
      if (moved < 5 && snapshot.player.state === "moving") this.footDistance += moved;
      if (this.footDistance > 2.3) {
        const onStone = snapshot.world.bridges.some((bounds) => snapshot.player.x >= bounds.minX && snapshot.player.x <= bounds.maxX &&
          snapshot.player.z >= bounds.minZ && snapshot.player.z <= bounds.maxZ) ||
          snapshot.world.sites.some((site) => ["fortress", "home"].includes(site.kind) && distance(site) < site.radius);
        this.sound.cue(onStone ? "step-stone" : "step-dirt");
        this.footDistance %= 2.3;
      }
      const cartMoved = Math.hypot(snapshot.convoy.x - previous.convoy.x, snapshot.convoy.z - previous.convoy.z);
      if (cartMoved < 5) this.convoyDistance += cartMoved;
      if (this.convoyDistance > 4) {
        cueAt("convoy", snapshot.convoy);
        this.convoyDistance %= 4;
      }
      if (snapshot.player.dodgeCooldown > previous.player.dodgeCooldown) this.sound.cue("dodge");
      if ((snapshot.narrative?.discovered.length ?? 0) > (previous.narrative?.discovered.length ?? 0)) this.sound.cue("discover");
    }
    if (snapshot.narrative?.inspection && snapshot.narrative.inspection.locationId !== previous.narrative?.inspection?.locationId) this.sound.cue("inspect");
    this.previous = snapshot;
  }
}
