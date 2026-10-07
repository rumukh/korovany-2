import {
  reactionWindow, type BattleCommand, type BattleCommandOption, type BattleLogEntry, type BattleView,
} from "../game";
import { translate } from "./locale";
import type { Language } from "./storage";
import "./battle.css";

const SVG = "http://www.w3.org/2000/svg";
/** Approach ring radii: it starts wide and meets the target circle at the moment of impact. */
const CUE = { target: 20, spread: 46 } as const;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function circle(className: string, r: number): SVGCircleElement {
  const node = document.createElementNS(SVG, "circle");
  for (const [name, value] of Object.entries({ cx: "60", cy: "60", r: String(r), class: className })) node.setAttribute(name, value);
  return node;
}

/** The command a chosen option sends, with its target when it needs one. */
export function battleCommand(option: BattleCommandOption, target?: string): BattleCommand {
  if (option.command === "attack") return { type: "attack", target: target ?? option.targets[0]! };
  if (option.command === "item") return { type: "item", item: "tonic" };
  if (option.command === "protect") return { type: "protect" };
  return { type: "skill", skill: option.id as Extract<BattleCommand, { type: "skill" }>["skill"], ...(target ? { target } : {}) };
}

/**
 * The battle panel of the HUD: the turn order, the enemies, the hero's resources, the commands on the hero's turn
 * (1-9, a click, or the controller) and, on enemy turns, the incoming move with its approach ring. The panel is rebuilt
 * only when what it shows changes; the ring moves every frame.
 */
export class BattleHud {
  readonly root = element("section", "battle-hud");
  /** The command (or target) buttons the controller navigates. */
  readonly controls = element("div", "battle-controls");
  readonly cue = document.createElementNS(SVG, "svg");
  private readonly cueTarget = circle("cue-target", CUE.target);
  private readonly cueApproach = circle("cue-approach", CUE.target + CUE.spread);
  private battle: BattleView | null = null;
  private language: Language = "ru";
  private controller = false;
  private renderKey = "";
  /** A targeted command waiting for its target. */
  private targeting: BattleCommandOption | null = null;

  constructor(private readonly dispatch: (command: BattleCommand) => void) {
    this.root.hidden = true;
    this.root.setAttribute("role", "region");
    this.cue.setAttribute("viewBox", "0 0 120 120");
    this.cue.setAttribute("class", "battle-cue");
    this.cue.setAttribute("aria-hidden", "true");
    this.cue.append(this.cueTarget, this.cueApproach);
  }

  get active(): boolean { return this.battle !== null; }
  /** The hero's turn: commands are offered. */
  get commanding(): boolean { return this.battle?.phase === "command"; }

  private t(key: string): string { return translate(this.language, key); }
  private name(id: string): string { return this.battle?.names[id]?.[this.language] ?? id; }

  update(battle: BattleView | undefined, language: Language, controller: boolean): void {
    if (!battle) {
      this.battle = null;
      this.targeting = null;
      this.renderKey = "";
      this.root.hidden = true;
      this.cue.classList.remove("visible");
      return;
    }
    if (battle.phase !== "command" || (this.targeting && !battle.commands.some((option) => option.id === this.targeting!.id && option.enabled))) {
      this.targeting = null;
    }
    this.battle = battle;
    this.language = language;
    this.controller = controller;
    const { hero } = battle;
    const key = JSON.stringify([language, controller, battle.phase, battle.round, battle.notice, hero.hp, hero.ap, hero.tonics,
      hero.guarding, hero.bulwark, hero.empowered, battle.enemies, battle.wards, battle.order, battle.action?.id ?? 0,
      battle.action?.hits.map((hit) => hit.outcome) ?? [], battle.log.at(-1)?.id ?? 0, this.targeting?.id ?? null]);
    if (key === this.renderKey) return;
    this.renderKey = key;
    this.render();
  }

  /** Moves the approach ring for the next blow aimed at the hero; called every frame. */
  frame(battle: BattleView | undefined): void {
    const action = battle?.phase === "action" ? battle.action : null;
    const hit = action?.hits.find((entry) => entry.target === "hero" && entry.outcome === "pending");
    if (!battle || !action || !hit) {
      this.cue.classList.remove("visible");
      return;
    }
    const span = Math.max(1, hit.impact - action.start);
    const remaining = Math.max(0, hit.impact - battle.tick);
    this.cueApproach.setAttribute("r", String(CUE.target + CUE.spread * Math.min(1, remaining / span)));
    const window = reactionWindow(battle.hero.faction, battle.difficulty, hit.heavy ? "dodge" : "parry");
    const open = battle.tick >= hit.impact - window.early && battle.tick <= hit.impact + window.late;
    this.cue.classList.add("visible");
    this.cue.classList.toggle("heavy", hit.heavy);
    this.cue.classList.toggle("open", open);
    this.cue.classList.toggle("pressed", hit.pressed !== null);
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
    this.renderKey = "";
    if (this.battle) this.update(this.battle, this.language, this.controller);
    return true;
  }

  private choose(option: BattleCommandOption): void {
    if (!option.enabled) return;
    if (option.targets.length > 1) {
      this.targeting = option;
      this.renderKey = "";
      if (this.battle) this.update(this.battle, this.language, this.controller);
      return;
    }
    this.send(option, option.targets[0]);
  }

  private send(option: BattleCommandOption, target?: string): void {
    this.targeting = null;
    this.renderKey = "";
    this.dispatch(battleCommand(option, target));
  }

  private label(option: BattleCommandOption): string {
    return this.t(`battle.command.${option.id}`);
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
    row.append(bar, element("span", "meter-value", `${Math.ceil(value)}/${Math.ceil(max)}`));
    return row;
  }

  private logText(entry: BattleLogEntry): string | null {
    if (entry.kind === "skill") return null;
    const template = this.t(`battle.log.${entry.kind}`);
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
    const head = element("header", "battle-head");
    const title = element("h2", "", `${this.t("battle.title")} · ${this.t("battle.round")} ${Math.max(1, battle.round)}`);
    head.append(title);
    if (battle.round <= 1 && battle.opening !== "neutral") head.append(element("p", `battle-opening ${battle.opening}`, this.t(`battle.opening.${battle.opening}`)));
    const order = element("ol", "battle-order");
    order.setAttribute("aria-label", this.t("battle.order"));
    battle.order.forEach((id, index) => {
      const chip = element("li", `${id === "hero" ? "hero" : battle.enemies.some((e) => e.id === id) ? "enemy" : "ally"}${index === 0 ? " current" : ""}`, this.name(id));
      order.append(chip);
    });
    head.append(order);

    const enemies = element("ul", "battle-enemies");
    enemies.setAttribute("aria-label", this.t("battle.enemies"));
    const acting = battle.phase === "action" ? battle.action?.actor : undefined;
    for (const enemy of battle.enemies) {
      const item = element("li", `battle-enemy${enemy.hp <= 0 ? " fallen" : ""}${acting === enemy.id ? " acting" : ""}${enemy.broken ? " broken" : ""}`);
      const tags = [this.t(`battle.${enemy.band}`), ...(enemy.broken ? [this.t("battle.broken")] : []),
        ...(enemy.rallied > 0 ? [`${this.t("battle.rallied")} ×${enemy.rallied}`] : [])];
      item.append(element("strong", "", this.name(enemy.id)), element("span", "battle-tags", tags.join(" · ")),
        this.meter(enemy.hp, enemy.maxHp, "enemy-health", this.name(enemy.id)),
        this.meter(enemy.breakMeter, enemy.breakMax, "break", this.t("battle.break")));
      enemies.append(item);
    }

    const side = element("div", "battle-side");
    const hero = battle.hero;
    const heroBox = element("div", "battle-hero");
    heroBox.append(element("strong", "", this.name("hero")),
      this.meter(hero.hp, hero.maxHp, "hero-health", this.t("health")));
    const pips = element("div", "battle-ap");
    pips.setAttribute("role", "meter");
    pips.setAttribute("aria-label", this.t("battle.apLong"));
    pips.setAttribute("aria-valuemin", "0");
    pips.setAttribute("aria-valuemax", String(hero.maxAp));
    pips.setAttribute("aria-valuenow", String(hero.ap));
    pips.append(element("span", "battle-ap-label", this.t("battle.ap")));
    for (let i = 0; i < hero.maxAp; i++) pips.append(element("span", `pip${i < hero.ap ? " full" : ""}`));
    heroBox.append(pips, element("p", "battle-status", [`${this.t("battle.tonics")} ${hero.tonics}`,
      ...(hero.guarding ? [this.t("battle.guarding")] : []), ...(hero.bulwark ? [this.t("battle.bulwark")] : []),
      ...(hero.empowered > 1 ? [this.t("battle.empowered")] : [])].join(" · ")));
    side.append(heroBox);
    if (battle.allies.length) {
      side.append(element("p", "battle-allies", `${this.t("battle.allies")}: ${battle.allies.map((ally) => this.name(ally.id)).join(", ")}`));
    }
    for (const ward of battle.wards) {
      const wardBox = element("div", `battle-ward${ward.hp <= 0 ? " fallen" : ""}`);
      wardBox.append(element("span", "", `${this.t("battle.wards")}: ${this.name(ward.id)}${ward.hp <= 0 ? ` · ${this.t("battle.wrecked")}` : ""}`),
        this.meter(ward.hp, ward.maxHp, "ward-health", this.name(ward.id)));
      side.append(wardBox);
    }

    const body = element("div", "battle-body");
    body.append(enemies, side);

    this.controls.replaceChildren();
    const footer = element("div", "battle-footer");
    if (battle.phase === "command") {
      if (this.targeting) {
        const option = this.targeting;
        footer.append(element("p", "battle-prompt", `${this.t("battle.chooseTarget")} · ${this.label(option)}`));
        option.targets.forEach((id, index) => {
          const enemy = battle.enemies.find((entry) => entry.id === id);
          const button = element("button", "battle-command target");
          button.type = "button";
          button.dataset.controllerKey = `battle-target:${id}`;
          button.append(element("kbd", "", String(index + 1)), element("span", "", this.name(id)),
            element("small", "", enemy ? `${Math.ceil(enemy.hp)}/${enemy.maxHp} · ${this.t(`battle.${enemy.band}`)}` : ""));
          button.addEventListener("click", () => this.send(option, id));
          this.controls.append(button);
        });
        const back = element("button", "battle-command back");
        back.type = "button";
        back.dataset.controllerKey = "battle-back";
        back.append(element("kbd", "", this.controller ? "B" : "Esc"), element("span", "", this.t("battle.back")));
        back.addEventListener("click", () => this.cancel());
        this.controls.append(back);
      } else {
        footer.append(element("p", "battle-prompt", this.t("battle.yourTurn")));
        battle.commands.forEach((option, index) => {
          const button = element("button", `battle-command ${option.command}`);
          button.type = "button";
          button.disabled = !option.enabled;
          button.dataset.controllerKey = `battle-command:${option.id}`;
          const cost = option.cost > 0 ? ` · ${option.cost} ${this.t("battle.ap")}` : option.id === "tonic" ? ` · ${hero.tonics}` : "";
          button.append(element("kbd", "", String(index + 1)), element("span", "", `${this.label(option)}${cost}`),
            element("small", "", option.enabled || !option.reason ? this.t(`battle.about.${option.id}`) : this.t(`battle.notice.${option.reason}`)));
          button.title = this.t(`battle.about.${option.id}`);
          button.addEventListener("click", () => this.choose(option));
          this.controls.append(button);
        });
      }
      footer.append(this.controls, element("p", "battle-hint", this.t(this.controller ? "battle.commands.controller" : "battle.commands.keyboard")));
      if (battle.notice) footer.append(element("p", "battle-notice danger-text", this.t(`battle.notice.${battle.notice}`)));
    } else if (battle.action) {
      const action = battle.action;
      const move = this.t(`battle.move.${action.move}`);
      footer.append(element("p", "battle-prompt", `${this.name(action.actor)} — ${move.startsWith("battle.") ? this.t(`battle.command.${action.move}`) : move}`));
      if (action.hits.length) {
        const blows = element("ol", "battle-blows");
        for (const hit of action.hits) {
          const mark = hit.outcome === "parried" || hit.outcome === "dodged" ? "✓" : hit.outcome === "hit" ? "✕" : hit.heavy ? "!" : "•";
          const blow = element("li", `${hit.outcome}${hit.heavy ? " heavy" : ""}${hit.target !== "hero" ? " ward" : ""}`, mark);
          blow.title = hit.target === "hero" ? this.t(`battle.${hit.heavy ? "heavy" : "reactions"}`) : this.name(hit.target);
          blows.append(blow);
        }
        footer.append(blows);
        if (action.hits.some((hit) => hit.target === "hero" && hit.heavy && hit.outcome === "pending")) {
          footer.append(element("p", "battle-heavy", this.t("battle.heavy")));
        }
        footer.append(element("p", "battle-hint", this.t(this.controller ? "battle.react.controller" : "battle.react.keyboard")));
      }
    }
    const log = element("ol", "battle-log");
    for (const entry of battle.log.slice(-6)) {
      const text = this.logText(entry);
      if (text) log.append(element("li", `log-${entry.kind}`, text));
    }
    while (log.children.length > 4) log.firstElementChild!.remove();
    this.root.replaceChildren(head, body, footer, log);
    if (focused) this.controls.querySelector<HTMLElement>(`[data-controller-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
}
