import {
  createCampaign, restoreCampaign, createProfile, restoreProfile, claimRewards,
  purchaseMetaUpgrade, metaUpgradeCost, MAX_UPGRADE_LEVEL,
  type GameSession, type GameSnapshot, type GameInput as CampaignInput, type MetaProfile, type RunRewards, type UpgradeId, type Vec2,
} from "./game";
import { createGameView, type GameView } from "./view";
import { Soundscape } from "./audio/soundscape";
import { GameInput } from "./ui/input";
import { GameShell, type Overlay, type ShellAction, type ShellState } from "./ui/shell";
import { BrowserStorage, DirtySave, defaultSettings, parseSettings, storageKeys } from "./ui/storage";
import { parseChart } from "./ui/atlas";
import { translate } from "./ui/locale";
import "./style.css";

const STEP = 1 / 60;
const MAX_FRAME = 0.1;
const root = document.getElementById("app");
if (!root) throw new Error("Game root is missing.");
const pendingWarnings = new Set<string>();
let shell: GameShell | null = null;
const storage = new BrowserStorage((issue) => {
  const key = `storage.${issue}`;
  if (shell) shell.warn(key);
  else pendingWarnings.add(key);
});
const storedSettings = storage.read(storageKeys.settings, parseSettings);
let settings = storedSettings.status === "ok" ? storedSettings.value : defaultSettings();

function restored<T>(restore: (value: unknown) => T): (value: unknown) => T | null {
  return (value) => {
    try {
      return restore(value);
    } catch (error) {
      console.warn("Korovany II rejected invalid saved data.", error);
      return null;
    }
  };
}

const storedProfile = storage.read(storageKeys.profile, restored(restoreProfile));
let profile: MetaProfile = storedProfile.status === "ok" ? storedProfile.value : createProfile();
const storedCampaign = storage.read(storageKeys.campaign, restored(restoreCampaign));
let campaign: GameSession | null = storedCampaign.status === "ok" ? storedCampaign.value : null;
let snapshot: GameSnapshot | null = campaign?.snapshot() ?? null;
let selectedFaction = snapshot?.faction ?? "elf";
let selectedSeed = snapshot?.seed ?? newSeed();
let preview: GameSnapshot | null = null;
let view: GameView | null = null;
let viewWorldId: string | null = null;
let input: GameInput | null = null;
let queued: CampaignInput = {};
let lastAim: Vec2 = { x: 0, z: -1 };
let lastFrame: number | null = null;
let accumulator = 0;
let hudElapsed = 0;
let lastSaveTick = snapshot?.tick ?? 0;
let lastEvent = snapshot?.events.at(-1)?.id ?? 0;
let rewardSaved = true;
const pendingRewards = new Map<string, RunRewards>();
const campaignSave = new DirtySave(storage, storageKeys.campaign);
const atlasSave = new DirtySave(storage, storageKeys.atlas);
let running = false;
let atTitle = true;
let disposed = false;
let fatal = false;
let raf = 0;
let cameraDrag: { x: number; y: number } | null = null;
const lifecycle = new AbortController();
const sound = new Soundscape(() => shell?.warn("audioFailure"));
sound.configure(settings.muted);

function newSeed(): string {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return `ROAD-${values[0]?.toString(36).toUpperCase() ?? "II"}`;
}

function state(): ShellState {
  return {
    settings, faction: selectedFaction, seed: selectedSeed, hasSave: campaign !== null,
    profile, rewardSaved,
    offers: (["damage", "vitality", "logistics"] as const).map((id) => ({
      id, level: profile.upgrades[id], maxLevel: MAX_UPGRADE_LEVEL,
      cost: metaUpgradeCost(profile.upgrades[id]),
    })),
  };
}

function refresh(rebuild = true): void {
  shell?.setState(state(), rebuild);
}

function reconcileProfile(): boolean {
  const latest = storage.read(storageKeys.profile, restored(restoreProfile));
  if (latest.status === "error" && latest.issue !== "corrupt") return false;
  profile = latest.status === "ok" ? latest.value : createProfile();
  for (const rewards of pendingRewards.values()) profile = claimRewards(profile, rewards);
  return true;
}

function saveRewards(): boolean {
  if (!pendingRewards.size) return true;
  const readable = reconcileProfile();
  if (!readable) {
    for (const rewards of pendingRewards.values()) profile = claimRewards(profile, rewards);
  }
  rewardSaved = readable && storage.writeIfUnchanged(storageKeys.profile, profile) === "saved";
  if (rewardSaved) pendingRewards.clear();
  return rewardSaved;
}

function buyMetaUpgrade(id: UpgradeId): void {
  if (!saveRewards() || !reconcileProfile()) {
    refresh();
    return;
  }
  if (profile.upgrades[id] >= MAX_UPGRADE_LEVEL || profile.renown < metaUpgradeCost(profile.upgrades[id])) {
    shell?.warn("profileChanged");
    refresh();
    return;
  }
  const purchased = purchaseMetaUpgrade(profile, id);
  if (storage.writeIfUnchanged(storageKeys.profile, purchased) === "saved") profile = purchased;
  refresh();
}

function saveCampaign(notify = false): boolean {
  const rewardsSaved = saveRewards();
  if (!campaign || !shell) return rewardsSaved;
  const currentCampaign = campaign;
  const currentShell = shell;
  const result = campaignSave.flush(() => currentCampaign.serialize());
  const saved = result === "saved" || result === "unchanged";
  const chartResult = saved ? atlasSave.flush(() => currentShell.atlas.serialize()) : "error";
  const chartSaved = chartResult === "saved" || chartResult === "unchanged";
  if (result === "conflict") {
    freeze();
    if (!atTitle) shell.show("pause");
  }
  lastSaveTick = snapshot?.tick ?? 0;
  if (notify && saved && chartSaved && rewardsSaved) shell.announce("saved");
  refresh(false);
  return saved && chartSaved && rewardsSaved;
}

function freeze(): void {
  running = false;
  input?.setEnabled(false);
  queued = {};
  cameraDrag = null;
  accumulator = 0;
  lastFrame = null;
  sound.setActive(false);
}

function changeOverlay(overlay: Overlay): void {
  if (fatal) return;
  const wasRunning = running;
  freeze();
  if (wasRunning) saveCampaign();
  if (overlay === "menu") atTitle = true;
  else if (overlay === null) atTitle = false;
  shell?.show(overlay);
  if (overlay === null && campaignSave.conflicted) {
    shell?.warn("storage.conflict");
    shell?.show("pause");
  } else if (overlay === null && campaign && snapshot?.phase === "playing") {
    running = true;
    input?.setEnabled(true);
    sound.setActive(true);
  }
}

function rendererFor(next: GameSnapshot): void {
  if (!shell || viewWorldId === next.world.id) return;
  view?.dispose();
  view = null;
  viewWorldId = null;
  view = createGameView(shell.canvas, next.world, {
    quality: settings.quality,
    reducedMotion: settings.reducedMotion,
  });
  viewWorldId = next.world.id;
  view.resize();
}

function updatePreview(): void {
  preview = createCampaign({
    seed: selectedSeed.trim() || "ROAD-II",
    faction: selectedFaction,
    upgrades: profile.upgrades,
    runId: "title-preview",
  }).snapshot();
  rendererFor(preview);
}

function finish(): void {
  if (!snapshot || snapshot.phase === "playing") return;
  freeze();
  atTitle = false;
  if (snapshot.rewards) {
    pendingRewards.set(snapshot.rewards.runId, snapshot.rewards);
    saveRewards();
  }
  shell?.update(snapshot);
  saveCampaign();
  refresh(false);
  shell?.show("terminal");
}

function begin(sameSeed?: boolean): void {
  if (!shell) return;
  if (sameSeed === false) selectedSeed = newSeed();
  if (sameSeed === true && snapshot) selectedSeed = snapshot.seed;
  if (!selectedSeed.trim()) {
    shell.warn("seedRequired");
    return;
  }
  if (((campaign && snapshot?.phase === "playing") || storage.unchanged(storageKeys.campaign) === false) &&
    !window.confirm(translate(settings.language, "overwrite"))) return;
  freeze();
  // An explicit new campaign may replace the latest record, not a stale tab's baseline.
  storage.read(storageKeys.campaign, restored(restoreCampaign));
  storage.read(storageKeys.atlas, parseChart);
  reconcileProfile();
  campaign = createCampaign({
    seed: selectedSeed.trim(), faction: selectedFaction,
    upgrades: profile.upgrades, runId: crypto.randomUUID(),
  });
  snapshot = campaign.snapshot();
  campaignSave.adopt();
  atlasSave.adopt();
  campaignSave.markDirty();
  atlasSave.markDirty();
  rendererFor(snapshot);
  lastAim = { x: Math.sin(snapshot.player.heading), z: Math.cos(snapshot.player.heading) };
  lastEvent = snapshot.events.at(-1)?.id ?? 0;
  lastSaveTick = 0;
  shell.update(snapshot);
  saveCampaign();
  refresh(false);
  changeOverlay(null);
}

function resume(): void {
  if (!campaign || !snapshot) return;
  rendererFor(snapshot);
  lastAim = { x: Math.sin(snapshot.player.heading), z: Math.cos(snapshot.player.heading) };
  shell?.update(snapshot);
  if (snapshot.phase === "playing") changeOverlay(null);
  else finish();
}

function continueLatest(): void {
  const unchanged = storage.unchanged(storageKeys.campaign);
  if (campaignSave.dirty && unchanged !== false) {
    resume();
    return;
  }
  if (campaignSave.dirty && !window.confirm(translate(settings.language, "loadLatest"))) return;
  const latest = storage.read(storageKeys.campaign, restored(restoreCampaign));
  if (latest.status === "error") return;
  campaign = latest.status === "ok" ? latest.value : null;
  snapshot = campaign?.snapshot() ?? null;
  campaignSave.adopt();
  atlasSave.adopt();
  const chart = storage.read(storageKeys.atlas, parseChart);
  if (chart.status === "ok") shell?.atlas.restore(chart.value);
  reconcileProfile();
  if (snapshot) {
    lastEvent = snapshot.events.at(-1)?.id ?? 0;
    lastSaveTick = snapshot.tick;
    shell?.update(snapshot);
  }
  refresh(false);
  if (campaign) resume();
  else {
    shell?.warn("storage.conflict");
    shell?.show("menu");
  }
}

function dispatch(action: ShellAction): void {
  if (disposed || (fatal && action.type !== "reload")) return;
  try {
    switch (action.type) {
      case "start": begin(action.sameSeed); break;
      case "continue": continueLatest(); break;
      case "resume": resume(); break;
      case "overlay":
        if (action.overlay === "records") {
          reconcileProfile();
          refresh(false);
        }
        changeOverlay(action.overlay);
        break;
      case "save": saveCampaign(true); break;
      case "title":
        if (!saveCampaign() && !window.confirm(translate(settings.language, "leaveUnsaved"))) break;
        changeOverlay("menu");
        updatePreview();
        refresh();
        break;
      case "randomSeed":
        selectedSeed = newSeed();
        updatePreview();
        refresh();
        break;
      case "seed":
        selectedSeed = action.seed;
        refresh(false);
        break;
      case "faction":
        selectedFaction = action.faction;
        updatePreview();
        refresh();
        break;
      case "settings":
        settings = action.settings;
        storage.write(storageKeys.settings, settings);
        sound.configure(settings.muted);
        view?.setQuality(settings.quality);
        view?.setReducedMotion(settings.reducedMotion);
        refresh();
        break;
      case "metaUpgrade":
        buyMetaUpgrade(action.id);
        break;
      case "upgrade":
        if (!snapshot?.shop.some((item) => item.id === action.id && item.available)) {
          const item = snapshot?.shop.find((entry) => entry.id === action.id);
          shell?.warn(item ? `notice.${item.reason}` : "notice.location");
          break;
        }
        resume();
        if (running) queued = { ...queued, upgrade: action.id };
        break;
      case "convoy":
        resume();
        if (running) queued = { ...queued, convoy: action.order };
        break;
      case "reload": window.location.reload(); break;
    }
  } catch (error) {
    stopForError(error, "game");
  }
}

function worldDirection(local: Vec2): Vec2 {
  const basis = view?.getMoveBasis();
  if (!basis) return { x: 0, z: 0 };
  return {
    x: basis.right.x * local.x + basis.forward.x * local.z,
    z: basis.right.z * local.x + basis.forward.z * local.z,
  };
}

function sampleInput(): CampaignInput {
  const sample = input?.consume();
  if (!sample || !snapshot) return {};
  if (sample.keyboardAim) lastAim = worldDirection(sample.keyboardAim);
  else if (sample.pointer) {
    const point = view?.screenToWorld(sample.pointer.x, sample.pointer.y);
    if (point) {
      const x = point.x - snapshot.player.x;
      const z = point.z - snapshot.player.z;
      const length = Math.hypot(x, z);
      if (length > 0.05) lastAim = { x: x / length, z: z / length };
    }
  }
  const value: CampaignInput = {
    move: worldDirection(sample.move), aim: lastAim,
    attack: sample.attack, sprint: sample.sprint, interact: sample.interact,
    dodge: sample.dodge, special: sample.ability,
    ...(sample.convoy ? { convoy: "cycle" as const } : {}),
    ...queued,
  };
  queued = {};
  return value;
}

function events(next: GameSnapshot): void {
  let important = false;
  for (const event of next.events) {
    if (event.id <= lastEvent) continue;
    lastEvent = event.id;
    switch (event.kind) {
      case "attack": sound.cue("attack"); break;
      case "hurt": sound.cue("hit"); break;
      case "ability": sound.cue("ability"); break;
      case "capture": sound.cue("capture"); important = true; break;
      case "delivery": sound.cue("delivery"); important = true; break;
      case "victory": sound.cue("victory"); important = true; break;
      case "defeat": sound.cue("defeat"); important = true; break;
      case "raid":
      case "upgrade":
      case "fortress": important = true; break;
    }
    if (!["attack", "hurt", "pickup"].includes(event.kind)) shell?.announce(event.key);
  }
  const combat = next.actors.some((actor) => actor.hp > 0 &&
    Math.hypot(actor.x - next.player.x, actor.z - next.player.z) < 24 &&
    ["windup", "attack", "chase"].includes(actor.state));
  sound.setCombat(combat);
  if (next.tick - lastSaveTick >= 600 || (important && next.tick - lastSaveTick >= 120)) saveCampaign();
}

function stopForError(error: unknown, kind: "graphics" | "game"): void {
  console.error(`Korovany II ${kind} failure.`, error);
  fatal = true;
  freeze();
  if (raf) cancelAnimationFrame(raf);
  shell?.fail(kind);
}

function frame(time: number): void {
  if (disposed || fatal) return;
  const delta = lastFrame === null ? 0 : Math.min(MAX_FRAME, Math.max(0, (time - lastFrame) / 1000));
  lastFrame = time;
  try {
    if (running && campaign) {
      accumulator += delta;
      while (accumulator >= STEP) {
        campaign.step(sampleInput());
        campaignSave.markDirty();
        atlasSave.markDirty();
        accumulator -= STEP;
        snapshot = campaign.snapshot();
        if (snapshot.phase !== "playing") break;
      }
      if (snapshot) {
        events(snapshot);
        hudElapsed += delta;
        if (hudElapsed >= 0.1) {
          shell?.update(snapshot);
          hudElapsed = 0;
        }
        if (snapshot.phase !== "playing") finish();
      }
    }
    const display = atTitle ? preview : snapshot;
    if (display && !document.hidden) view?.render(display, delta);
  } catch (error) {
    stopForError(error, "game");
    return;
  }
  raf = requestAnimationFrame(frame);
}

shell = new GameShell(root, state(), dispatch);
pendingWarnings.forEach((key) => shell?.warn(key));
input = new GameInput(shell.canvas, (overlay) => changeOverlay(overlay), () => changeOverlay("pause"));
const storedChart = storage.read(storageKeys.atlas, parseChart);
if (storedChart.status === "ok") shell.atlas.restore(storedChart.value);
if (snapshot) shell.update(snapshot);

window.addEventListener("resize", () => view?.resize(), { signal: lifecycle.signal });
window.addEventListener("pointerdown", (event) => {
  if (event.isTrusted) void sound.unlock();
}, { signal: lifecycle.signal, capture: true });
window.addEventListener("keydown", (event) => {
  if (event.isTrusted) void sound.unlock();
}, { signal: lifecycle.signal, capture: true });
shell.canvas.addEventListener("pointerdown", (event) => {
  if (!running || event.button !== 2) return;
  event.preventDefault();
  cameraDrag = { x: event.clientX, y: event.clientY };
  shell?.canvas.setPointerCapture(event.pointerId);
}, { signal: lifecycle.signal });
shell.canvas.addEventListener("pointermove", (event) => {
  if (!running || !cameraDrag) return;
  view?.orbit((event.clientX - cameraDrag.x) * 0.006, (event.clientY - cameraDrag.y) * 0.004);
  cameraDrag = { x: event.clientX, y: event.clientY };
}, { signal: lifecycle.signal });
window.addEventListener("pointerup", (event) => {
  if (event.button === 2) cameraDrag = null;
}, { signal: lifecycle.signal });
shell.canvas.addEventListener("wheel", (event) => {
  if (!running) return;
  event.preventDefault();
  view?.zoom(event.deltaY);
}, { signal: lifecycle.signal, passive: false });
shell.canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  stopForError(new Error("WebGL context lost"), "graphics");
}, { signal: lifecycle.signal });
window.addEventListener("pagehide", () => {
  if (running) changeOverlay("pause");
  else freeze();
  saveCampaign();
}, { signal: lifecycle.signal });
window.addEventListener("storage", (event) => {
  if (event.key === storageKeys.campaign && !atTitle && storage.unchanged(storageKeys.campaign) === false) {
    campaignSave.conflicted = true;
    freeze();
    shell?.warn("storage.conflict");
    shell?.show("pause");
  }
  if (event.key === storageKeys.profile && !pendingRewards.size) {
    reconcileProfile();
    refresh(shell?.overlay === "records");
  }
}, { signal: lifecycle.signal });

Object.defineProperty(window, "korovany", {
  configurable: true,
  value: Object.freeze({
    inspect: () => ({
      snapshot: campaign?.snapshot() ?? null,
      overlay: shell?.overlay ?? null,
      running,
      settings: { ...settings },
      audio: sound.inspect(),
      profile: { ...profile, upgrades: { ...profile.upgrades }, completedRuns: [...profile.completedRuns] },
      viewWorldId,
      moveBasis: view?.getMoveBasis() ?? null,
    }),
  }),
});

function dispose(): void {
  if (disposed) return;
  disposed = true;
  freeze();
  cancelAnimationFrame(raf);
  lifecycle.abort();
  input?.dispose();
  view?.dispose();
  sound.dispose();
  shell?.dispose();
}

if (import.meta.hot) import.meta.hot.dispose(dispose);

try {
  updatePreview();
  raf = requestAnimationFrame(frame);
} catch (error) {
  stopForError(error, "graphics");
}
