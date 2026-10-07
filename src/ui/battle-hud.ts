import {
  BATTLE_TIMING, HERO_KITS, reactionWindow,
  type BattleCommand, type BattleCommandOption, type BattleEnemySnapshot, type BattleHitSnapshot, type BattleLogEntry,
  type BattleView, type Reaction,
} from "../game";
import { translate } from "./locale";
import type { Language } from "./storage";
import "./battle.css";

const SVG = "http://www.w3.org/2000/svg";
const TICK_MS = 1000 / 60;
/** Approach rings appear this many ticks before their blow lands and close on the target circle at impact. */
export const APPROACH_TICKS = 42;
/** The defence cue's geometry in its SVG units (the view box spans -100 to 100): the target circle round the hero and
 * the radius an approach ring starts from. */
export const CUE_RING = { target: 30, start: 92 } as const;
const SPREAD = CUE_RING.start - CUE_RING.target;
const FEEDBACK_MS = 1800;
const PRESS_MS = 200;
const MAX_RINGS = 4;
/** Ticks after a blow's window closes in which a press that answered nothing is reported as too late for it. */
const LATE_GRACE = 20;

type Role = "hero" | "enemy" | "ally";
type FeedbackKind = "parried" | "dodged" | "hit" | "ward" | "counter" | "break" | "wrecked" | "join";

/** An enemy move's blows at the hero as last seen, matched in order to the log entries that resolve them. */
interface SeenMove { id: number; actor: string; hits: BattleHitSnapshot[]; resolved: number }
/** A parry or dodge press: the tick it entered the simulation, whether the engine bound it to a blow, and whether a
 * report has explained a blow with it. */
interface Press { kind: Reaction; tick: number; bound: boolean; used: boolean }
/** The report of a landed blow nobody answered, which a press arriving shortly after can still explain as too late. */
interface Unanswered { item: HTMLElement; detail: HTMLElement; impact: number; until: number }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/** The command a chosen option sends, with its target when it needs one. */
export function battleCommand(option: BattleCommandOption, target?: string): BattleCommand {
  if (option.command === "attack") return { type: "attack", target: target ?? option.targets[0]! };
  if (option.command === "item") return { type: "item", item: "tonic" };
  if (option.command === "protect") return { type: "protect" };
  return { type: "skill", skill: option.id as Extract<BattleCommand, { type: "skill" }>["skill"], ...(target ? { target } : {}) };
}

/** Radius of a blow's approach ring `remaining` ticks before it lands (negative after), in the cue's SVG units. */
export function ringRadius(remaining: number): number {
  return CUE_RING.target + SPREAD * Math.max(-0.12, Math.min(1, remaining / APPROACH_TICKS));
}

/** The band an approach ring crosses while a reaction succeeds: from `late` ticks after impact to `early` before. */
export function reactionBand(window: { early: number; late: number }): { inner: number; outer: number } {
  return { inner: ringRadius(-window.late), outer: ringRadius(window.early) };
}

/**
 * The battle HUD. Panels at the screen's edges keep the battlefield clear: the turn order (top), the enemies (left), the
 * hero (bottom left), and the commands on the hero's turn or the defence guide on enemy turns (bottom right). Centred on
 * the hero, the defence cue shows each incoming blow: an approach ring that meets the target circle as the blow lands,
 * the bands in which a parry (gold) and a dodge (blue) succeed, the keys that light up while each would succeed, and
 * what each blow came to. The panels are rebuilt when what they show changes; the cue moves every frame.
 */
export class BattleHud {
  readonly root = element("section", "battle-hud");
  /** The command (or target) buttons the controller navigates. */
  readonly controls = element("div", "battle-controls");
  private readonly top = element("div", "battle-top");
  private readonly banner = element("p", "battle-banner");
  private readonly enemyPanel = element("section", "battle-panel battle-enemies-panel");
  private readonly heroPanel = element("section", "battle-panel battle-hero-panel");
  private readonly actionPanel = element("section", "battle-panel battle-actions-panel");
  private readonly log = element("ol", "battle-log");
  private readonly cue = element("div", "battle-cue");
  private readonly zoneDodge = svg("circle", { class: "zone dodge", r: "0" });
  private readonly zoneParry = svg("circle", { class: "zone parry", r: "0" });
  private readonly targetCircle = svg("circle", { class: "target", r: String(CUE_RING.target) });
  private readonly ringGroup = svg("g", { class: "rings" });
  private readonly rings: SVGCircleElement[] = [];
  private readonly mark = svg("text", { class: "mark", x: "0", y: String(-CUE_RING.target - 9) });
  private readonly blows = element("ol", "cue-blows");
  private readonly parryKey = element("div", "cue-key parry");
  private readonly dodgeKey = element("div", "cue-key dodge");
  private readonly feedback = element("ol", "cue-feedback");
  private readonly expiry = new Map<Element, number>();
  private battle: BattleView | null = null;
  /** The latest battle a frame showed; shell refreshes may pass an older snapshot. */
  private live: BattleView | null = null;
  private language: Language = "ru";
  private controller = false;
  private hints = true;
  /** The battle's latency compensation in ticks: learnt from the first press the engine binds, else the setting's. */
  private latency = 0;
  private latencySetting = 0;
  private latencyKnown = false;
  private renderKey = "";
  private keysKey = "";
  private blowKey = "";
  /** A targeted command waiting for its target. */
  private targeting: BattleCommandOption | null = null;
  /** The battle being followed: a lower tick than the last frame showed means a new one (or a restarted one). */
  private following: { tick: number; log: number } | null = null;
  private moves: SeenMove[] = [];
  private presses: Press[] = [];
  private unanswered: Unanswered[] = [];
  private pressedUntil: Record<Reaction, number> = { parry: 0, dodge: 0 };

  constructor(private readonly dispatch: (command: BattleCommand) => void) {
    this.root.hidden = true;
    this.root.setAttribute("role", "region");
    this.cue.hidden = true;
    this.cue.setAttribute("aria-hidden", "true");
    const drawing = svg("svg", { viewBox: "-100 -100 200 200", class: "cue-drawing" });
    drawing.append(this.zoneDodge, this.zoneParry, this.targetCircle, this.ringGroup, this.mark);
    const keys = element("div", "cue-keys");
    keys.append(this.parryKey, this.dodgeKey);
    const bottom = element("div", "cue-bottom");
    bottom.append(this.blows, keys);
    this.cue.append(this.feedback, drawing, bottom);
    this.banner.hidden = true;
    this.root.append(this.top, this.banner, this.enemyPanel, this.heroPanel, this.actionPanel, this.log, this.cue);
  }

  get active(): boolean { return this.battle !== null; }
  /** The hero's turn: commands are offered. */
  get commanding(): boolean { return this.battle?.phase === "command"; }

  private t(key: string): string { return translate(this.language, key); }
  private name(id: string): string { return this.battle?.names[id]?.[this.language] ?? id; }
  private role(battle: BattleView, id: string): Role {
    return id === "hero" ? "hero" : battle.enemies.some((enemy) => enemy.id === id) ? "enemy" : "ally";
  }

  /** Rebuilds the panels when what they show changed. `latency` is the reaction latency setting in ticks, used until a
   * bound press shows the battle's own. */
  update(battle: BattleView | undefined, language: Language, controller: boolean, hints = true, latency = 0): void {
    if (!battle) {
      this.battle = null;
      this.live = null;
      this.targeting = null;
      this.following = null;
      this.latencyKnown = false;
      this.renderKey = "";
      this.root.hidden = true;
      this.cue.hidden = true;
      this.clearFeedback();
      return;
    }
    // The shell may refresh with an older snapshot of the same battle than the last frame showed: show the newer one.
    // Only `frame`, which always gets the live snapshot, decides that a new battle began.
    const live = this.live;
    if (live && battle.tick < live.tick && battle.opening === live.opening && battle.enemies[0]?.id === live.enemies[0]?.id) battle = live;
    if (battle.phase !== "command" || (this.targeting && !battle.commands.some((option) => option.id === this.targeting!.id && option.enabled))) {
      this.targeting = null;
    }
    this.battle = battle;
    this.language = language;
    this.controller = controller;
    this.hints = hints;
    this.latencySetting = latency;
    if (!this.latencyKnown) this.latency = latency;
    const keys = `${language}|${controller}`;
    if (keys !== this.keysKey) {
      this.keysKey = keys;
      this.renderKeys();
    }
    const { hero } = battle;
    const key = JSON.stringify([language, controller, hints, battle.phase, battle.round, battle.notice, hero.hp, hero.ap, hero.tonics,
      hero.guarding, hero.bulwark, hero.empowered, battle.enemies, battle.allies, battle.wards, battle.order, battle.action?.id ?? 0,
      battle.action?.hits.map((hit) => hit.outcome) ?? [], battle.log.at(-1)?.id ?? 0, this.targeting?.id ?? null]);
    if (key === this.renderKey) return;
    this.renderKey = key;
    this.render();
  }

  /** A parry or dodge the player pressed during an enemy move, as it is sent with the next simulation tick: its key
   * flashes, and the report of the blow it answered (or failed to) explains its timing. */
  press(kind: Reaction): void {
    const shown = this.live ?? this.battle;
    if (!shown) return;
    this.presses.push({ kind, tick: shown.tick + 1, bound: false, used: false });
    if (this.presses.length > 12) this.presses.shift();
    this.pressedUntil[kind] = performance.now() + PRESS_MS;
  }

  /** Moves the defence cue and reports resolved blows; called every frame. `alpha` is the fraction of a tick elapsed
   * since the shown one, for smooth rings. Without a battle (or behind a menu) the cue hides. */
  frame(battle: BattleView | undefined, alpha = 0): void {
    const now = performance.now();
    if (!battle || !this.battle) {
      this.cue.hidden = true;
      return;
    }
    this.follow(battle);
    this.live = battle;
    this.see(battle);
    this.consume(battle);
    this.lateReports(battle, now);
    for (const [node, until] of this.expiry) {
      if (now < until) continue;
      node.remove();
      this.expiry.delete(node);
    }
    const action = battle.phase === "action" ? battle.action : null;
    const enemyMove = action !== null && this.role(battle, action.actor) === "enemy";
    const heroHits = enemyMove ? action.hits.filter((hit) => hit.target === "hero") : [];
    const pending = heroHits.filter((hit) => hit.outcome === "pending");
    const live = pending.length > 0;
    const time = battle.tick + Math.max(0, Math.min(0.999, alpha));
    const dodge = reactionWindow(battle.hero.faction, battle.difficulty, "dodge");
    const parry = reactionWindow(battle.hero.faction, battle.difficulty, "parry");
    // The blow a press would answer, as the engine binds it: the first one unanswered whose window has not closed.
    const next = pending.find((hit) => hit.pressed === null && time <= hit.impact + dodge.late);
    this.cue.hidden = !live && this.feedback.childElementCount === 0;
    this.cue.classList.toggle("live", live);
    this.renderBlows(action?.id ?? 0, heroHits, next);
    let used = 0;
    for (const hit of pending) {
      const remaining = hit.impact - time;
      if (remaining > APPROACH_TICKS || used >= MAX_RINGS) continue;
      const ring = this.ring(used++);
      ring.setAttribute("r", ringRadius(remaining).toFixed(2));
      ring.setAttribute("class", `ring${hit.heavy ? " heavy" : ""}${hit === next ? " next" : " later"}${hit.pressed !== null ? " answered" : ""}`);
    }
    for (let index = used; index < this.rings.length; index++) this.rings[index]!.setAttribute("class", "ring off");
    const remaining = next ? next.impact - time : Infinity;
    const shown = this.hints && remaining <= APPROACH_TICKS;
    this.band(this.zoneDodge, shown ? dodge : null);
    this.band(this.zoneParry, shown && !next!.heavy ? parry : null);
    const dodgeOpen = remaining <= dodge.early && remaining >= -dodge.late;
    const parryOpen = next !== undefined && !next.heavy && remaining <= parry.early && remaining >= -parry.late;
    this.cue.classList.toggle("heavy", next?.heavy === true);
    this.cue.classList.toggle("dodge-open", this.hints && dodgeOpen);
    this.cue.classList.toggle("parry-open", this.hints && parryOpen);
    const prompt = this.hints && (next?.heavy ? dodgeOpen : parryOpen);
    this.mark.textContent = prompt ? this.t("battle.cue.now") : next?.heavy ? "!" : "";
    this.mark.setAttribute("class", `mark${prompt ? " now" : next?.heavy ? " heavy" : ""}`);
    const locked = battle.hero.lockout > 0;
    for (const [node, kind] of [[this.parryKey, "parry"], [this.dodgeKey, "dodge"]] as const) {
      node.classList.toggle("open", this.hints && (kind === "parry" ? parryOpen : dodgeOpen));
      node.classList.toggle("pressed", now < this.pressedUntil[kind]);
      node.classList.toggle("locked", locked && now >= this.pressedUntil[kind]);
    }
  }

  /** Keyboard commands on the hero's turn: 1-9 choose, Escape or Backspace leave target selection. */
  key(event: KeyboardEvent): boolean {
    if (!this.battle || this.battle.phase !== "command" || event.repeat) return false;
    const editable = event.target instanceof HTMLElement && event.target.matches("input, textarea, select");
    if (editable) return false;
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
    if (digit) {
      const index = Number(digit[1]) - 1;
      if (this.targeting) {
        const target = this.targeting.targets[index];
        if (target) this.send(this.targeting, target);
      } else {
        const option = this.battle.commands[index];
        if (option) this.choose(option);
      }
      return true;
    }
    if ((event.code === "Escape" || event.code === "Backspace") && this.targeting) {
      this.cancel();
      return true;
    }
    return false;
  }

  /** Leaves target selection; false when there was none. */
  cancel(): boolean {
    if (!this.targeting) return false;
    this.targeting = null;
    this.rerender();
    return true;
  }

  private rerender(): void {
    this.renderKey = "";
    if (this.battle) this.update(this.battle, this.language, this.controller, this.hints, this.latencySetting);
  }

  private choose(option: BattleCommandOption): void {
    if (!option.enabled) return;
    if (option.targets.length > 1) {
      this.targeting = option;
      this.rerender();
      return;
    }
    this.send(option, option.targets[0]);
  }

  private send(option: BattleCommandOption, target?: string): void {
    this.targeting = null;
    this.renderKey = "";
    this.dispatch(battleCommand(option, target));
  }

  /** Starts following a battle that is new (or restarted): nothing logged before it is news. */
  private follow(battle: BattleView): void {
    if (this.following && battle.tick >= this.following.tick) {
      this.following.tick = battle.tick;
      return;
    }
    this.following = { tick: battle.tick, log: battle.log.at(-1)?.id ?? 0 };
    this.moves = [];
    this.presses = [];
    this.latencyKnown = false;
    this.blowKey = "";
    this.clearFeedback();
  }

  private clearFeedback(): void {
    this.feedback.replaceChildren();
    this.expiry.clear();
    this.unanswered = [];
  }

  /**
   * Keeps the latest copy of the current enemy move's blows at the hero, and notes which press the engine bound to a
   * blow since the last frame: the latest one sent. A bound attempt is the press's tick less the latency compensation,
   * so it also shows the battle's latency.
   */
  private see(battle: BattleView): void {
    const action = battle.action;
    if (!action || this.role(battle, action.actor) !== "enemy") return;
    const hits = action.hits.filter((hit) => hit.target === "hero").map((hit) => ({ ...hit }));
    if (!hits.length) return;
    const seen = this.moves.find((move) => move.id === action.id);
    for (const hit of hits) {
      const before = seen?.hits.find((entry) => entry.index === hit.index);
      // Bound since the last frame: pressed now, but not in the copy last seen (or there was no copy yet).
      if (hit.pressed === null || (before !== undefined && before.pressed !== null)) continue;
      const press = this.presses.filter((entry) => !entry.bound && entry.tick <= battle.tick).at(-1);
      if (!press) continue;
      press.bound = true;
      const latency = press.tick - hit.pressed;
      if (latency >= 0 && latency <= 12) {
        this.latency = latency;
        this.latencyKnown = true;
      }
    }
    if (seen) seen.hits = hits;
    else {
      this.moves.push({ id: action.id, actor: action.actor, hits, resolved: 0 });
      if (this.moves.length > 4) this.moves.shift();
    }
  }

  /** The next unresolved blow of `attacker`'s latest move: log entries resolve a move's blows in order. */
  private claim(attacker: string): BattleHitSnapshot | undefined {
    for (let index = this.moves.length - 1; index >= 0; index--) {
      const move = this.moves[index]!;
      if (move.actor === attacker && move.resolved < move.hits.length) return move.hits[move.resolved++];
    }
    return undefined;
  }

  private consume(battle: BattleView): void {
    const following = this.following!;
    for (const entry of battle.log) {
      if (entry.id <= following.log) continue;
      following.log = entry.id;
      this.report(battle, entry);
    }
    this.presses = this.presses.filter((press) => press.tick >= battle.tick - 180);
  }

  private report(battle: BattleView, entry: BattleLogEntry): void {
    switch (entry.kind) {
      case "parry":
      case "dodge": {
        const hit = this.claim(entry.target);
        if (hit) this.retire(hit.impact);
        const ap = entry.kind === "parry" || HERO_KITS[battle.hero.faction].dodgeAp;
        this.popup(entry.kind === "parry" ? "parried" : "dodged", this.t(`battle.fb.${entry.kind === "parry" ? "parried" : "dodged"}`),
          ap ? this.t("battle.fb.ap") : "");
        break;
      }
      case "damage":
        if (entry.target === "hero") {
          const hit = this.claim(entry.actor);
          const reason = hit ? this.miss(battle, hit) : "";
          if (hit) this.retire(hit.impact);
          const popup = this.popup("hit", this.t("battle.fb.hit").replace("{n}", String(entry.amount)),
            reason ?? this.t(this.controller ? "battle.fb.none.controller" : "battle.fb.none.keyboard"));
          // Nothing answered it yet: a press arriving shortly is reported as too late.
          if (hit && reason === null && popup.detail) {
            this.unanswered.push({ item: popup.item, detail: popup.detail, impact: hit.impact,
              until: hit.impact + this.latency + BATTLE_TIMING.dodge.late + LATE_GRACE });
          }
        } else if (entry.target === "convoy" || entry.target === "shipment") {
          this.popup("ward", `${this.name(entry.target)} −${entry.amount}`, this.t("battle.fb.wardHelp"));
        }
        break;
      case "counter":
        this.popup("counter", this.t("battle.fb.counter"), this.name(entry.target));
        break;
      case "break":
        this.popup("break", this.t("battle.fb.break"), `${this.name(entry.target)} · ${this.t("battle.broken.help")}`);
        break;
      case "ward-down":
        this.popup("wrecked", this.t("battle.fb.wrecked").replace("{t}", this.name(entry.target)), "");
        break;
      case "join":
        if (![...this.feedback.children].some((node) => node.classList.contains("fb-join"))) this.popup("join", this.t("battle.fb.join"), "");
        break;
      default:
        break;
    }
  }

  /**
   * Why a blow at the hero landed: its bound attempt against the window, or a press sent near it that bound to nothing
   * (too early, too late, or again within the lockout of an earlier press). Null when nothing was pressed near it yet.
   */
  private miss(battle: BattleView, hit: BattleHitSnapshot): string | null {
    const ms = (ticks: number): string => String(Math.max(1, Math.round(ticks * TICK_MS)));
    if (hit.pressed !== null && hit.reaction) {
      if (hit.reaction === "parry" && hit.heavy) return this.t("battle.fb.heavy");
      const window = reactionWindow(battle.hero.faction, battle.difficulty, hit.reaction);
      const offset = hit.pressed - hit.impact;
      if (offset < -window.early) return this.t("battle.fb.early").replace("{n}", ms(-window.early - offset));
      if (offset > window.late) return this.t("battle.fb.late").replace("{n}", ms(offset - window.late));
      return "";
    }
    const press = this.presses.filter((entry) => !entry.bound && !entry.used && entry.tick <= battle.tick &&
      entry.tick - this.latency >= hit.impact - 60).at(-1);
    if (!press) return null;
    press.used = true;
    const at = press.tick - this.latency;
    const window = reactionWindow(battle.hero.faction, battle.difficulty, press.kind);
    if (at > hit.impact + window.late) return this.t("battle.fb.late").replace("{n}", ms(at - hit.impact - window.late));
    if (at < hit.impact - BATTLE_TIMING.attempt) return this.t("battle.fb.early").replace("{n}", ms(hit.impact - window.early - at));
    return this.t("battle.fb.lockout");
  }

  /** A blow has resolved: presses sent up to its window's end belong to it and explain no later blow. */
  private retire(impact: number): void {
    for (const press of this.presses) if (!press.used && press.tick - this.latency <= impact + BATTLE_TIMING.dodge.late) press.used = true;
  }

  /** A press that arrives just after a blow nobody answered landed was too late for it, unless it answered the next. */
  private lateReports(battle: BattleView, now: number): void {
    if (!this.unanswered.length) return;
    this.unanswered = this.unanswered.filter((report) => {
      const press = this.presses.filter((entry) => !entry.bound && !entry.used && entry.tick <= battle.tick &&
        entry.tick - this.latency > report.impact).at(-1);
      if (press) {
        press.used = true;
        const window = reactionWindow(battle.hero.faction, battle.difficulty, press.kind);
        const late = Math.max(1, Math.round((press.tick - this.latency - report.impact - window.late) * TICK_MS));
        report.detail.textContent = this.t("battle.fb.late").replace("{n}", String(late));
        if (report.item.isConnected) this.expiry.set(report.item, now + FEEDBACK_MS);
        return false;
      }
      return battle.tick <= report.until;
    });
  }

  private popup(kind: FeedbackKind, title: string, detail: string): { item: HTMLElement; detail: HTMLElement | null } {
    const item = element("li", `fb-${kind}`);
    item.append(element("strong", "", title));
    const line = detail ? element("small", "", detail) : null;
    if (line) item.append(line);
    this.feedback.append(item);
    this.expiry.set(item, performance.now() + FEEDBACK_MS);
    while (this.feedback.childElementCount > 3) {
      const oldest = this.feedback.firstElementChild!;
      this.expiry.delete(oldest);
      oldest.remove();
    }
    this.cue.hidden = false;
    return { item, detail: line };
  }

  private ring(index: number): SVGCircleElement {
    while (this.rings.length <= index) {
      const ring = svg("circle", { class: "ring off", r: String(CUE_RING.start) });
      this.rings.push(ring);
      this.ringGroup.append(ring);
    }
    return this.rings[index]!;
  }

  /** Draws a success band as a thick circle between its inner and outer radii; null hides it. */
  private band(node: SVGCircleElement, window: { early: number; late: number } | null): void {
    if (!window) {
      node.setAttribute("stroke-width", "0");
      return;
    }
    const { inner, outer } = reactionBand(window);
    node.setAttribute("r", ((inner + outer) / 2).toFixed(2));
    node.setAttribute("stroke-width", (outer - inner).toFixed(2));
  }

  private renderKeys(): void {
    const pad = this.controller;
    const cap = (kind: Reaction): HTMLElement[] => {
      const text = element("span", "cue-key-text");
      text.append(element("b", "", this.t(`battle.cue.${kind}`)));
      const alternatives = this.t(`battle.cue.${kind}.${pad ? "controller" : "keyboard"}`);
      if (alternatives) text.append(element("small", "", alternatives));
      if (kind === "dodge") text.append(element("em", "only", this.t("battle.cue.dodgeOnly")));
      return [element("kbd", "", pad ? (kind === "parry" ? "A" : "B") : (kind === "parry" ? "E" : "Q")), text];
    };
    this.parryKey.replaceChildren(...cap("parry"));
    this.dodgeKey.replaceChildren(...cap("dodge"));
    this.renderKey = "";
  }

  /** The blows of the enemy move under way: answered, landed, heavy, and the one a press would answer now. */
  private renderBlows(action: number, hits: readonly BattleHitSnapshot[], next: BattleHitSnapshot | undefined): void {
    const key = `${action}|${hits.map((hit) => `${hit.outcome}${hit.heavy ? "!" : ""}${hit.pressed !== null ? "p" : ""}`).join(",")}|${next?.index ?? -1}`;
    if (key === this.blowKey) return;
    this.blowKey = key;
    this.blows.replaceChildren(...hits.map((hit) => element("li", `${hit.outcome}${hit.heavy ? " heavy" : ""}${hit.index === next?.index ? " current" : ""}`,
      hit.outcome === "parried" || hit.outcome === "dodged" ? "✓" : hit.outcome === "hit" ? "✕" : hit.heavy ? "!" : "")));
    this.blows.hidden = hits.length < 2 && !hits.some((hit) => hit.heavy);
  }

  private label(option: BattleCommandOption): string {
    return this.t(`battle.command.${option.id}`);
  }

  private moveName(move: string): string {
    const name = this.t(`battle.move.${move}`);
    return name.startsWith("battle.") ? this.t(`battle.command.${move}`) : name;
  }

  private meter(value: number, max: number, className: string, label: string): HTMLElement {
    const row = element("div", `battle-meter ${className}`);
    const bar = element("div", "meter");
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", label);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(Math.max(1, max)));
    bar.setAttribute("aria-valuenow", String(Math.max(0, Math.min(value, max))));
    const fill = element("span", "meter-fill");
    fill.style.width = `${Math.max(0, Math.min(100, value / Math.max(1, max) * 100))}%`;
    bar.append(fill);
    row.append(bar, element("span", "meter-value", `${Math.ceil(value)} / ${Math.ceil(max)}`));
    return row;
  }

  private logText(entry: BattleLogEntry): string | null {
    if (entry.kind === "skill") return null;
    const key = entry.kind === "damage" && entry.actor === "hero" ? "battle.log.damage.hero"
      : entry.kind === "damage" && entry.target === "hero" ? "battle.log.damage.taken"
        : entry.kind === "heal" && entry.target === "hero" ? "battle.log.heal.hero" : `battle.log.${entry.kind}`;
    const template = this.t(key);
    const protecting = entry.kind === "protect" && entry.target !== "hero";
    return (protecting ? `${template} · ${this.name(entry.target)}` : template)
      .replace("{a}", this.name(entry.actor)).replace("{t}", this.name(entry.target)).replace("{n}", String(entry.amount));
  }

  private render(): void {
    const battle = this.battle!;
    const focused = document.activeElement instanceof HTMLElement && this.controls.contains(document.activeElement)
      ? document.activeElement.dataset.controllerKey : undefined;
    this.root.hidden = false;
    this.root.setAttribute("aria-label", this.t("battle.title"));
    this.renderTop(battle);
    this.renderEnemies(battle);
    this.renderHero(battle);
    this.renderActions(battle);
    const lines = battle.log.map((entry) => [entry, this.logText(entry)] as const).filter(([, text]) => text !== null).slice(-3);
    this.log.replaceChildren(...lines.map(([entry, text]) => element("li", `log-${entry.kind}`, text!)));
    if (focused) this.controls.querySelector<HTMLElement>(`[data-controller-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  private renderTop(battle: BattleView): void {
    const round = element("p", "battle-round");
    round.append(element("small", "", this.t("battle.roundLabel")), element("strong", "", String(Math.max(1, battle.round))));
    const order = element("ol", "battle-order");
    order.setAttribute("aria-label", this.t("battle.order"));
    battle.order.forEach((id, index) => {
      const chip = element("li", `${this.role(battle, id)}${index === 0 ? " current" : ""}`);
      if (index === 0) chip.append(element("small", "", this.t("battle.now")));
      chip.append(element("span", "", this.name(id)));
      order.append(chip);
    });
    this.top.replaceChildren(round, order);
    // The opening is news until the hero's first command has been given.
    const opening = battle.round === 0 || (battle.round === 1 && battle.phase === "command");
    this.banner.hidden = !opening;
    this.banner.className = `battle-banner ${battle.opening}`;
    this.banner.textContent = opening ? this.t(`battle.opening.${battle.opening}`) : "";
  }

  private renderEnemies(battle: BattleView): void {
    const targeting = this.targeting;
    const acting = battle.phase === "action" ? battle.action?.actor : undefined;
    const list = element("ul", "battle-enemies");
    list.setAttribute("aria-label", this.t("battle.enemies"));
    for (const enemy of battle.enemies.filter((entry) => entry.hp > 0)) {
      const index = targeting ? targeting.targets.indexOf(enemy.id) : -1;
      const item = element("li", `battle-enemy${acting === enemy.id ? " acting" : ""}${enemy.broken ? " broken" : ""}${index >= 0 ? " targetable" : ""}`);
      const line = element("div", "enemy-line");
      if (index >= 0) line.append(element("kbd", "target-key", String(index + 1)));
      line.append(element("strong", "", this.name(enemy.id)), element("span", `badge band ${enemy.band}`, this.t(`battle.${enemy.band}`)));
      item.append(line, this.meter(enemy.hp, enemy.maxHp, "enemy-health", this.name(enemy.id)));
      if (enemy.breakMax <= 12) item.append(this.guard(enemy));
      const badges = element("div", "badges");
      if (acting === enemy.id) badges.append(element("span", "badge attacking", this.t("battle.attacking")));
      if (enemy.broken) badges.append(element("span", "badge broken", `${this.t("battle.broken")} · ${this.t("battle.broken.help")}`));
      if (enemy.rallied > 0) badges.append(element("span", "badge rallied", `${this.t("battle.rallied")} ×${enemy.rallied}`));
      if (badges.childElementCount) item.append(badges);
      if (index >= 0 && targeting) {
        item.title = `${index + 1} · ${this.label(targeting)}`;
        item.addEventListener("click", () => this.send(targeting, enemy.id));
      }
      list.append(item);
    }
    const fallen = battle.enemies.filter((entry) => entry.hp <= 0);
    if (fallen.length) list.append(element("li", "battle-fallen", `${this.t("battle.defeated")}: ${fallen.map((entry) => this.name(entry.id)).join(", ")}`));
    this.enemyPanel.classList.toggle("targeting", targeting !== null);
    this.enemyPanel.replaceChildren(element("h3", "battle-heading", this.t("battle.enemies")), list);
  }

  private guard(enemy: BattleEnemySnapshot): HTMLElement {
    const row = element("div", "guard-row");
    row.title = this.t("battle.guard.help");
    const pips = element("span", "guard-pips");
    pips.setAttribute("role", "meter");
    pips.setAttribute("aria-label", this.t("battle.break"));
    pips.setAttribute("aria-valuemin", "0");
    pips.setAttribute("aria-valuemax", String(enemy.breakMax));
    pips.setAttribute("aria-valuenow", String(enemy.breakMeter));
    for (let index = 0; index < enemy.breakMax; index++) pips.append(element("i", index < enemy.breakMeter || enemy.broken ? "on" : ""));
    row.append(element("span", "guard-label", this.t("battle.guard")), pips);
    return row;
  }

  private renderHero(battle: BattleView): void {
    const hero = battle.hero;
    const head = element("div", "hero-line");
    head.append(element("strong", "", this.name("hero")), element("span", "hero-role", this.t(`faction.${hero.faction}`)));
    const badges = element("div", "badges");
    if (hero.guarding) badges.append(element("span", "badge guarding", this.t("battle.guarding")));
    if (hero.bulwark) badges.append(element("span", "badge bulwark", this.t("battle.bulwark")));
    if (hero.empowered > 1) badges.append(element("span", "badge empowered", this.t("battle.empowered")));
    const ap = element("div", "ap-row");
    const pips = element("span", "ap-pips");
    pips.setAttribute("role", "meter");
    pips.setAttribute("aria-label", this.t("battle.apLong"));
    pips.setAttribute("aria-valuemin", "0");
    pips.setAttribute("aria-valuemax", String(hero.maxAp));
    pips.setAttribute("aria-valuenow", String(hero.ap));
    for (let index = 0; index < hero.maxAp; index++) pips.append(element("i", index < hero.ap ? "on" : ""));
    ap.append(element("span", "ap-label", this.t("battle.ap")), pips, element("span", "ap-value", `${hero.ap} / ${hero.maxAp}`),
      element("span", "tonics", `${this.t("battle.tonics")}: ${hero.tonics}`));
    const parts: HTMLElement[] = [head];
    if (badges.childElementCount) parts.push(badges);
    parts.push(this.meter(hero.hp, hero.maxHp, "hero-health", this.t("health")), ap);
    if (battle.allies.length) {
      const allies = element("p", "battle-allies");
      allies.append(element("span", "battle-subheading", this.t("battle.allies")),
        ...battle.allies.map((ally) => element("span", "ally-chip", this.name(ally.id))));
      parts.push(allies);
    }
    for (const ward of battle.wards) {
      const box = element("div", `battle-ward${ward.hp <= 0 ? " fallen" : ""}`);
      box.append(element("span", "battle-subheading", `${this.t("battle.wards")}: ${this.name(ward.id)}${ward.hp <= 0 ? ` · ${this.t("battle.wrecked")}` : ""}`),
        this.meter(ward.hp, ward.maxHp, "ward-health", this.name(ward.id)));
      parts.push(box);
    }
    this.heroPanel.setAttribute("aria-label", this.name("hero"));
    this.heroPanel.replaceChildren(...parts);
  }

  private renderActions(battle: BattleView): void {
    const panel = this.actionPanel;
    const parts: HTMLElement[] = [];
    this.controls.replaceChildren();
    let mode = "waiting";
    if (battle.phase === "command") {
      mode = "commanding";
      const option = this.targeting;
      if (option) {
        parts.push(element("h3", "battle-prompt", `${this.t("battle.chooseTarget")} · ${this.label(option)}`));
        option.targets.forEach((id, index) => {
          const enemy = battle.enemies.find((entry) => entry.id === id);
          const button = element("button", "battle-command target");
          button.type = "button";
          button.dataset.controllerKey = `battle-target:${id}`;
          button.append(element("kbd", "", String(index + 1)), element("span", "name", this.name(id)),
            element("span", "cost", enemy ? this.t(`battle.${enemy.band}`) : ""),
            element("small", "", enemy ? `${Math.ceil(enemy.hp)} / ${enemy.maxHp}${enemy.broken ? ` · ${this.t("battle.broken")}` : ""}` : ""));
          button.addEventListener("click", () => this.send(option, id));
          this.controls.append(button);
        });
        const back = element("button", "battle-command back");
        back.type = "button";
        back.dataset.controllerKey = "battle-back";
        back.append(element("kbd", "", this.controller ? "B" : "Esc"), element("span", "name", this.t("battle.back")));
        back.addEventListener("click", () => this.cancel());
        this.controls.append(back);
        parts.push(this.controls, element("p", "battle-hint", this.t(this.controller ? "battle.commands.controller" : "battle.targets.keyboard")));
      } else {
        parts.push(element("h3", "battle-prompt", this.t("battle.yourTurn")));
        battle.commands.forEach((command, index) => {
          const button = element("button", `battle-command ${command.command}`);
          button.type = "button";
          button.disabled = !command.enabled;
          button.dataset.controllerKey = `battle-command:${command.id}`;
          const cost = command.id === "tonic" ? `×${battle.hero.tonics}`
            : command.cost > 0 ? this.t("battle.cost").replace("{n}", String(command.cost))
              : command.id === "attack" || command.id === "protect" ? this.t("battle.fb.ap") : "";
          button.append(element("kbd", "", String(index + 1)), element("span", "name", this.label(command)), element("span", "cost", cost),
            element("small", command.enabled || !command.reason ? "" : "reason",
              command.enabled || !command.reason ? this.t(`battle.about.${command.id}`) : this.t(`battle.notice.${command.reason}`)));
          button.title = this.t(`battle.about.${command.id}`);
          button.addEventListener("click", () => this.choose(command));
          this.controls.append(button);
        });
        parts.push(this.controls, element("p", "battle-hint", this.t(this.controller ? "battle.commands.controller" : "battle.commands.keyboard")));
      }
      if (battle.notice) parts.push(element("p", "battle-notice", this.t(`battle.notice.${battle.notice}`)));
    } else if (battle.action) {
      const action = battle.action;
      const role = this.role(battle, action.actor);
      mode = role === "enemy" ? "enemy" : "acting";
      const target = action.target && action.target !== "hero" && role !== "enemy" ? ` → ${this.name(action.target)}` : "";
      parts.push(element("h3", "battle-prompt", this.t(role === "enemy" ? "battle.enemyTurn" : role === "ally" ? "battle.allyTurn" : "battle.heroAction")),
        element("p", "battle-move", `${this.name(action.actor)} — ${this.moveName(action.move)}${target}`));
      if (role === "enemy") {
        const atHero = action.hits.filter((hit) => hit.target === "hero");
        const atWard = action.hits.find((hit) => hit.target !== "hero");
        if (atHero.length) parts.push(...this.defenceGuide(atHero));
        else if (atWard) {
          parts.push(element("p", "battle-warning", this.t("battle.defend.ward").replace("{a}", this.name(action.actor))
            .replace("{t}", this.name(atWard.target))));
        } else parts.push(element("p", "battle-hint", this.t("battle.noBlow")));
      }
    }
    panel.className = `battle-panel battle-actions-panel ${mode}`;
    panel.replaceChildren(...parts);
  }

  /** How to answer the blows of the enemy move under way. */
  private defenceGuide(hits: readonly BattleHitSnapshot[]): HTMLElement[] {
    const pad = this.controller;
    const parts: HTMLElement[] = [];
    const heavy = hits.some((hit) => hit.heavy);
    parts.push(element("p", "battle-blowcount", `${this.t("battle.blows")}: ${hits.length}${heavy ? ` · ${this.t("battle.heavyShort")}` : ""}`));
    if (this.hints) parts.push(element("p", "defend-how", this.t("battle.defend.how")));
    const keys = element("ul", "defend-keys");
    for (const kind of ["parry", "dodge"] as const) {
      const row = element("li", kind);
      const caps = element("span", "defend-caps");
      const primary = pad ? (kind === "parry" ? "A" : "B") : (kind === "parry" ? "E" : "Q");
      caps.append(element("kbd", "", primary));
      const alternative = this.t(`battle.cue.${kind}.${pad ? "controller" : "keyboard"}`);
      if (alternative) caps.append(element("small", "", alternative));
      row.append(caps, element("b", "", this.t(`battle.cue.${kind}`)));
      if (this.hints) row.append(element("span", "", this.t(`battle.defend.${kind}`)));
      keys.append(row);
    }
    parts.push(keys);
    if (heavy || this.hints) parts.push(element("p", `defend-heavy${heavy ? " now" : ""}`, this.t("battle.defend.heavy")));
    return parts;
  }
}
