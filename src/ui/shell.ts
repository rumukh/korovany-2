import { FACTIONS, type FactionId, type GameEvent, type GameInput, type GameSnapshot, type MetaProfile, type UpgradeId } from "../game";
import { Atlas } from "./atlas";
import { formatTime, translate } from "./locale";
import type { Settings } from "./storage";

export type Overlay = "menu" | "pause" | "map" | "settings" | "help" | "records" | "terminal" | "fatal" | null;
export interface MetaOffer {
  id: UpgradeId;
  level: number;
  maxLevel: number;
  cost: number;
}
export type ShellAction =
  | { type: "start"; sameSeed?: boolean }
  | { type: "continue" | "resume" | "save" | "title" | "randomSeed" | "reload" }
  | { type: "overlay"; overlay: Overlay }
  | { type: "faction"; faction: FactionId }
  | { type: "seed"; seed: string }
  | { type: "settings"; settings: Settings }
  | { type: "metaUpgrade" | "upgrade"; id: UpgradeId }
  | { type: "convoy"; order: NonNullable<GameInput["convoy"]> };

export interface ShellState {
  settings: Settings;
  faction: FactionId;
  seed: string;
  hasSave: boolean;
  profile: MetaProfile;
  offers: MetaOffer[];
  rewardSaved: boolean;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emblem(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 80 80");
  svg.setAttribute("class", "emblem");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(ns, "circle");
  for (const [name, value] of Object.entries({ cx: "40", cy: "40", r: "34", fill: "none", stroke: "currentColor", "stroke-width": "1" })) circle.setAttribute(name, value);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M40 3v12M40 65v12M3 40h12M65 40h12M18 29h7l6 22h25l7-18H27M36 21l-8 8h27l-8-8M34 59a3 3 0 1 0 0-6 3 3 0 0 0 0 6M54 59a3 3 0 1 0 0-6 3 3 0 0 0 0 6");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  svg.append(circle, path);
  return svg;
}

export class GameShell {
  readonly canvas = element("canvas", "world");
  readonly atlas = new Atlas();
  private readonly hud = element("div", "hud");
  private readonly hudTop = element("div", "hud-top");
  private readonly hudBottom = element("div", "hud-bottom");
  private readonly minimap = element("button", "minimap");
  private readonly controls = element("div", "hud-controls");
  private readonly overlayHost = element("div", "overlay-host");
  private readonly warnings = element("div", "warnings");
  private readonly live = element("div", "sr-only");
  private readonly controller = new AbortController();
  private warningKeys: string[] = [];
  private snapshot: GameSnapshot | null = null;
  private currentOverlay: Overlay = "menu";
  private returnOverlay: Overlay = "menu";
  private state: ShellState;
  private lastMapTick = -Infinity;
  private fatalKind: "graphics" | "game" = "graphics";

  constructor(root: HTMLElement, state: ShellState, private readonly dispatch: (action: ShellAction) => void) {
    this.state = state;
    this.canvas.tabIndex = 0;
    this.live.setAttribute("aria-live", "polite");
    this.live.setAttribute("aria-atomic", "true");
    this.warnings.setAttribute("aria-live", "polite");
    this.minimap.type = "button";
    this.minimap.addEventListener("click", () => dispatch({ type: "overlay", overlay: "map" }));
    this.hud.append(this.hudTop, this.minimap, this.hudBottom, this.controls);
    root.replaceChildren(this.canvas, this.hud, this.overlayHost, this.warnings, this.live);
    window.addEventListener("keydown", (event) => this.overlayKey(event), { signal: this.controller.signal });
    this.applyLanguage();
    this.buildControls();
    this.renderOverlay();
  }

  get overlay(): Overlay {
    return this.currentOverlay;
  }

  private t(key: string): string {
    return translate(this.state.settings.language, key);
  }

  private button(key: string, action: ShellAction, className = "button"): HTMLButtonElement {
    const button = element("button", className, this.t(key));
    button.type = "button";
    button.dataset.action = action.type === "overlay" ? `open-${action.overlay}` : action.type;
    button.addEventListener("click", () => this.dispatch(action));
    return button;
  }

  private heading(key: string, level: "h1" | "h2" | "h3" = "h2"): HTMLHeadingElement {
    return element(level, "", this.t(key));
  }

  private label(key: string): HTMLElement {
    return element("p", "eyebrow", this.t(key));
  }

  setState(state: ShellState, rebuild = true): void {
    const languageChanged = state.settings.language !== this.state.settings.language;
    this.state = state;
    this.applyLanguage();
    if (languageChanged) {
      this.buildControls();
      this.renderWarnings();
      this.lastMapTick = -Infinity;
    }
    if (rebuild) this.renderOverlay();
    if (this.snapshot) this.update(this.snapshot);
  }

  private applyLanguage(): void {
    document.documentElement.lang = this.state.settings.language;
    document.documentElement.dataset.motion = this.state.settings.reducedMotion ? "reduced" : "full";
    document.title = `${this.t("title")} II — ${this.t("subtitle")}`;
    this.canvas.setAttribute("aria-label", this.t("worldLabel"));
    this.minimap.setAttribute("aria-label", this.t("map"));
  }

  show(overlay: Overlay): void {
    if (overlay === "settings" || overlay === "help" || overlay === "records") {
      this.returnOverlay = this.currentOverlay;
    }
    this.currentOverlay = overlay;
    this.renderOverlay();
  }

  fail(kind: "graphics" | "game"): void {
    this.fatalKind = kind;
    this.show("fatal");
  }

  warn(key: string): void {
    if (!this.warningKeys.includes(key)) this.warningKeys.push(key);
    this.renderWarnings();
  }

  announce(key: string): void {
    this.live.textContent = this.t(key);
    if (key === "saved") {
      const feedback = this.overlayHost.querySelector(".save-feedback");
      if (feedback) feedback.textContent = this.t(key);
    }
  }

  private renderWarnings(): void {
    this.warnings.replaceChildren();
    for (const key of this.warningKeys) {
      const notice = element("div", "notice");
      notice.append(element("strong", "", this.t("warning")), element("p", "", this.t(key)));
      const close = element("button", "notice-close", "×");
      close.type = "button";
      close.setAttribute("aria-label", this.t("dismiss"));
      close.addEventListener("click", () => {
        this.warningKeys = this.warningKeys.filter((item) => item !== key);
        this.renderWarnings();
      });
      notice.append(close);
      this.warnings.append(notice);
    }
  }

  private buildControls(): void {
    this.controls.replaceChildren(
      this.button("map", { type: "overlay", overlay: "map" }, "hud-button"),
      this.button("pause", { type: "overlay", overlay: "pause" }, "hud-button"),
    );
  }

  update(snapshot: GameSnapshot): void {
    this.snapshot = snapshot;
    this.atlas.observe(snapshot);
    if (this.currentOverlay !== null) return;
    const crest = element("section", "hero-panel");
    crest.append(element("div", `faction-crest ${snapshot.faction}`, snapshot.faction === "elf" ? "↟" : snapshot.faction === "guard" ? "♜" : "◆"));
    const vitals = element("div", "hero-vitals");
    vitals.append(this.label(FACTIONS[snapshot.faction].nameKey));
    vitals.append(this.meter("health", snapshot.player.hp, snapshot.player.maxHp, "health"));
    vitals.append(this.meter("stamina", snapshot.player.stamina, snapshot.player.maxStamina, "stamina"));
    crest.append(vitals);
    const objective = element("section", "objective");
    objective.setAttribute("aria-label", this.t("progressLabel"));
    objective.append(this.label("chapter"), element("h2", "", this.t(snapshot.objective.key)));
    objective.append(element("p", "objective-counts",
      `${this.t("capturedCount")} ${snapshot.objective.captured}/${snapshot.objective.captureRequired} · ` +
      `${this.t("suppliedCount")} ${snapshot.objective.supplied}/${snapshot.objective.supplyRequired}`));
    const boss = snapshot.actors.find((actor) => actor.kind === "boss" && actor.hp > 0);
    if (boss && snapshot.fortress.unlocked && Math.hypot(boss.x - snapshot.player.x, boss.z - snapshot.player.z) < 32) {
      objective.append(this.meter("boss", boss.hp, boss.maxHp, "boss"));
    }
    this.hudTop.replaceChildren(crest, objective);
    const convoy = element("section", "convoy-panel");
    convoy.append(this.label(FACTIONS[snapshot.faction].convoyKey));
    convoy.append(this.meter("convoy", snapshot.convoy.hp, snapshot.convoy.maxHp, "convoy-health"));
    convoy.append(element("p", "cargo", `${this.t("cargo")} ${snapshot.convoy.cargo}/${snapshot.convoy.capacity} · ${this.t("order." + snapshot.convoy.mode)}`));
    if (snapshot.convoy.disabled) convoy.append(element("p", "danger-text", this.t("disabledConvoy")));
    convoy.append(element("p", "key-prompt", `C · ${this.t("orders")}`));
    const actions = element("section", "action-panel");
    if (snapshot.interaction) {
      const interaction = element("div", `interaction ${snapshot.interaction.enabled ? "" : "unavailable"}`);
      interaction.append(element("kbd", "", "E"), element("span", "", `${this.t("hold")} · ${this.t(snapshot.interaction.key)}`));
      if (snapshot.interaction.progress > 0) interaction.append(this.meter("interact", snapshot.interaction.progress, 1, "capture"));
      actions.append(interaction);
    }
    const slots = element("div", "action-slots");
    for (const [key, label, cooldown] of [
      ["Space", "attack", snapshot.player.attackCooldown],
      ["Q", "dodge", snapshot.player.dodgeCooldown],
      ["F", FACTIONS[snapshot.faction].abilityKey, snapshot.player.abilityCooldown],
    ] as const) {
      const slot = element("div", "action-slot");
      slot.append(element("kbd", "", key === "Space" ? this.t("spaceKey") : key), element("span", "", this.t(label)),
        element("small", cooldown > 0 ? "cooldown" : "", cooldown > 0 ? `${cooldown.toFixed(1)}${this.t("seconds")}` : this.t("ready")));
      slots.append(slot);
    }
    actions.append(slots, element("p", "movement-prompt", `WASD · ${this.t("move")} / Shift · ${this.t("sprint")}`));
    const journal = element("section", "journal");
    journal.setAttribute("aria-label", this.t("events"));
    journal.append(element("div", "purse", `${this.t("coins")} ${snapshot.player.coins} · ${this.t("supplies")} ${snapshot.player.supplies}`));
    const relevant = snapshot.events.filter((event) => !["attack", "hurt"].includes(event.kind)).slice(-3);
    for (const event of relevant) journal.append(element("p", "", this.eventText(event, snapshot)));
    this.hudBottom.replaceChildren(convoy, actions, journal);
    if (snapshot.tick < this.lastMapTick || snapshot.tick - this.lastMapTick >= 60) {
      this.minimap.replaceChildren(this.atlas.draw(snapshot, this.state.settings.language, true), element("span", "", `M · ${this.t("map")}`));
      this.lastMapTick = snapshot.tick;
    }
  }

  private meter(key: string, value: number, max: number, className: string): HTMLElement {
    const row = element("div", `meter-row ${className}`);
    const bar = element("div", "meter");
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", this.t(key));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(Math.max(1, max)));
    bar.setAttribute("aria-valuenow", String(Math.max(0, Math.min(value, max))));
    const fill = element("span", "meter-fill");
    fill.style.width = `${Math.max(0, Math.min(100, value / Math.max(1, max) * 100))}%`;
    bar.append(fill);
    row.append(bar, element("span", "meter-value", `${Math.ceil(value)}/${Math.ceil(max)}`));
    return row;
  }

  private eventText(event: GameEvent, snapshot: GameSnapshot): string {
    let detail = "";
    if (event.kind === "convoy") {
      const site = snapshot.world.sites.find((item) => item.id === event.targetId);
      detail = site ? this.t(site.nameKey) : ["hold", "follow", "return", "route"].includes(event.targetId) ? this.t(`order.${event.targetId}`) : "";
    } else if (["pickup", "delivery", "hurt"].includes(event.kind) && event.amount > 0) detail = String(event.amount);
    else if (event.kind === "capture") {
      const site = snapshot.world.sites.find((item) => item.id === event.targetId);
      if (site) detail = this.t(site.nameKey);
    }
    return `${this.t(event.key)}${detail ? ` · ${detail}` : ""}`;
  }

  private renderOverlay(): void {
    this.hud.hidden = this.currentOverlay !== null;
    this.overlayHost.replaceChildren();
    this.overlayHost.hidden = this.currentOverlay === null;
    this.overlayHost.className = `overlay-host ${this.currentOverlay === "menu" ? "title-overlay" : ""}`;
    this.canvas.setAttribute("aria-hidden", String(this.currentOverlay !== null));
    if (this.currentOverlay === null) {
      this.lastMapTick = -Infinity;
      if (this.snapshot) this.update(this.snapshot);
      return;
    }
    const panel = element("section", `panel ${this.currentOverlay}-panel`);
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.tabIndex = -1;
    const headingKey = this.currentOverlay === "menu" ? "menuLabel"
      : this.currentOverlay === "pause" ? "paused"
        : this.currentOverlay === "terminal" ? (this.snapshot?.phase === "victory" ? "victory" : "defeat")
          : this.currentOverlay === "fatal" ? (this.fatalKind === "graphics" ? "graphicsFailure" : "gameFailure")
            : this.currentOverlay;
    panel.setAttribute("aria-label", this.t(headingKey));
    if (this.currentOverlay === "menu") this.menu(panel);
    else if (this.currentOverlay === "pause") this.pause(panel);
    else if (this.currentOverlay === "map") this.map(panel);
    else if (this.currentOverlay === "settings") this.settings(panel);
    else if (this.currentOverlay === "help") this.help(panel);
    else if (this.currentOverlay === "records") this.records(panel);
    else if (this.currentOverlay === "terminal") this.terminal(panel);
    else this.fatal(panel);
    this.overlayHost.append(panel);
    panel.focus({ preventScroll: true });
  }

  private menu(panel: HTMLElement): void {
    const masthead = element("div", "masthead");
    masthead.append(emblem(), this.label("edition"));
    const title = element("h1", "game-title");
    title.append(element("span", "", this.t("title")), element("span", "roman", "II"));
    masthead.append(title, element("p", "subtitle", this.t("subtitle")), element("p", "prologue", this.t("prologue")));
    panel.append(masthead, element("p", "introduction", this.t("introduction")), this.label("chooseFaction"));
    const factions = element("div", "factions");
    factions.setAttribute("role", "group");
    factions.setAttribute("aria-label", this.t("chooseFaction"));
    for (const id of ["elf", "guard", "villain"] as const) {
      const button = this.button(`faction.${id}`, { type: "faction", faction: id }, `faction-card ${id}`);
      button.textContent = "";
      button.setAttribute("aria-pressed", String(this.state.faction === id));
      button.dataset.faction = id;
      button.append(element("span", "faction-mark", id === "elf" ? "↟" : id === "guard" ? "♜" : "◆"));
      const text = element("span", "faction-copy");
      text.append(element("strong", "", this.t(`faction.${id}`)), element("span", "", this.t(`description.${id}`)));
      button.append(text);
      factions.append(button);
    }
    panel.append(factions);
    const seedRow = element("div", "seed-row");
    const label = element("label", "seed-label", this.t("seed"));
    const seed = element("input", "seed-input");
    seed.id = "atlas-seed";
    seed.value = this.state.seed;
    seed.maxLength = 80;
    seed.required = true;
    seed.autocomplete = "off";
    seed.spellcheck = false;
    seed.setAttribute("aria-describedby", "seed-hint");
    label.htmlFor = seed.id;
    seed.addEventListener("input", () => this.dispatch({ type: "seed", seed: seed.value }));
    seedRow.append(label, seed, this.button("newSeed", { type: "randomSeed" }, "button quiet"));
    const hint = element("p", "small muted", this.t("seedHint"));
    hint.id = "seed-hint";
    panel.append(seedRow, hint);
    const launch = element("div", "launch-actions");
    if (this.state.hasSave) launch.append(this.button("continue", { type: "continue" }, "button primary"));
    launch.append(this.button("start", { type: "start" }, `button ${this.state.hasSave ? "" : "primary"}`));
    panel.append(launch);
    const footer = element("nav", "title-footer");
    footer.append(
      this.button("records", { type: "overlay", overlay: "records" }, "text-button"),
      this.button("help", { type: "overlay", overlay: "help" }, "text-button"),
      this.button("settings", { type: "overlay", overlay: "settings" }, "text-button"),
    );
    const language = element("button", "language-button", this.state.settings.language === "ru" ? "EN" : "RU");
    language.type = "button";
    language.setAttribute("aria-label", this.state.settings.language === "ru" ? "Switch to English" : "Переключить на русский");
    language.addEventListener("click", () => this.dispatch({ type: "settings", settings: { ...this.state.settings, language: this.state.settings.language === "ru" ? "en" : "ru" } }));
    footer.append(language);
    panel.append(footer, element("p", "desktop-note", this.t("desktop")), element("p", "touch-note", this.t("touchNotice")),
      element("p", "attribution", this.t("powered")));
  }

  private back(panel: HTMLElement, overlay: Overlay = this.returnOverlay): void {
    panel.append(this.button("back", { type: "overlay", overlay }, "button quiet back-button"));
  }

  private pause(panel: HTMLElement): void {
    panel.append(this.label("edition"), this.heading("paused"), element("p", "prologue", this.t("pausedNote")));
    const buttons = element("div", "pause-actions");
    buttons.append(this.button("resume", { type: "resume" }, "button primary"), this.button("save", { type: "save" }),
      this.button("map", { type: "overlay", overlay: "map" }), this.button("help", { type: "overlay", overlay: "help" }),
      this.button("settings", { type: "overlay", overlay: "settings" }), this.button("titleReturn", { type: "title" }));
    panel.append(buttons);
    panel.append(element("p", "save-feedback small"));
    if (this.snapshot) {
      panel.append(this.heading("upgrades", "h3"), element("p", "small muted", this.t("upgradeNote")));
      const shop = element("div", "upgrade-list");
      for (const item of this.snapshot.shop) {
        const row = element("div", "upgrade-row");
        const copy = element("div");
        copy.append(element("strong", "", this.t(item.key)), element("p", "small", `${this.t("level")} ${item.level}/${item.maxLevel}`));
        const buy = this.button("buy", { type: "upgrade", id: item.id }, "button");
        buy.textContent = `${this.t("buy")} · ${item.cost} ${this.t("coins")}`;
        buy.disabled = !item.available;
        buy.title = this.t(`reason.${item.reason}`);
        row.append(copy, buy, element("small", "upgrade-reason", this.t(`reason.${item.reason}`)));
        shop.append(row);
      }
      panel.append(shop);
    }
  }

  private map(panel: HTMLElement): void {
    const snapshot = this.snapshot;
    panel.append(this.heading("map"), element("p", "small muted", this.t("mapNote")));
    if (!snapshot) return;
    const layout = element("div", "atlas-layout");
    const map = element("div", "atlas-paper");
    map.append(this.atlas.draw(snapshot, this.state.settings.language));
    const sidebar = element("div", "atlas-sidebar");
    sidebar.append(this.label("chapter"), element("h3", "", this.t(snapshot.objective.key)));
    for (const post of snapshot.outposts) {
      const row = element("div", `post-record ${post.owner}`);
      row.append(element("strong", "", this.t(post.nameKey)),
        element("p", "small", this.t(post.supplied ? "supplied" : post.owner === "player" ? "captured" : "hostile")));
      if (post.captureProgress > 0 && post.owner !== "player") row.append(this.meter("captured", post.captureProgress, 1, "capture"));
      sidebar.append(row);
    }
    sidebar.append(this.heading("orders", "h3"));
    const orderButtons = element("div", "order-buttons");
    for (const order of ["hold", "follow", "return"] as const) {
      const button = this.button(`order.${order}`, { type: "convoy", order }, "button small");
      button.setAttribute("aria-pressed", String(snapshot.convoy.mode === order));
      orderButtons.append(button);
    }
    sidebar.append(orderButtons);
    const label = element("label", "eyebrow", this.t("roadDestination"));
    const destinations = element("select", "destination-select");
    destinations.id = "convoy-destination";
    label.htmlFor = destinations.id;
    const sites = snapshot.world.sites.filter((site) => snapshot.world.roads.nodes.some((node) => node.id === site.id));
    for (const site of sites) {
      const option = element("option", "", this.t(site.nameKey));
      option.value = site.id;
      option.selected = snapshot.convoy.destination === site.id;
      destinations.append(option);
    }
    const send = element("button", "button primary", this.t("sendConvoy"));
    send.type = "button";
    send.disabled = sites.length === 0;
    send.addEventListener("click", () => this.dispatch({ type: "convoy", order: { destination: destinations.value } }));
    sidebar.append(label, destinations, send, element("p", "small", `${this.t("cargo")} ${snapshot.convoy.cargo}/${snapshot.convoy.capacity}`));
    sidebar.append(this.label("legend"));
    const legend = element("div", "map-legend");
    for (const key of ["hero", "convoy", "hostile", "captured", "supplied", "route", "unexplored"]) {
      legend.append(element("span", `legend-item legend-${key}`, this.t(key)));
    }
    sidebar.append(legend);
    layout.append(map, sidebar);
    panel.append(layout, this.button("resume", { type: "resume" }, "button primary"));
  }

  private settings(panel: HTMLElement): void {
    panel.append(this.heading("settings"));
    const choices = (key: "language" | "quality", values: readonly string[], labels: readonly string[]) => {
      const row = element("label", "setting-row", this.t(key));
      const select = element("select");
      select.setAttribute("aria-label", this.t(key));
      values.forEach((value, index) => {
        const option = element("option", "", labels[index]);
        option.value = value;
        option.selected = this.state.settings[key] === value;
        select.append(option);
      });
      select.addEventListener("change", () => {
        const value = select.value;
        if (key === "language" && (value === "ru" || value === "en")) this.dispatch({ type: "settings", settings: { ...this.state.settings, language: value } });
        if (key === "quality" && (value === "low" || value === "high")) this.dispatch({ type: "settings", settings: { ...this.state.settings, quality: value } });
      });
      row.append(select);
      panel.append(row);
    };
    choices("language", ["ru", "en"], ["Русский", "English"]);
    choices("quality", ["high", "low"], [this.t("high"), this.t("low")]);
    for (const [key, label] of [["muted", "muted"], ["reducedMotion", "reducedMotion"]] as const) {
      const row = element("label", "setting-row", this.t(label));
      const input = element("input");
      input.type = "checkbox";
      input.checked = this.state.settings[key];
      input.addEventListener("change", () => this.dispatch({ type: "settings", settings: { ...this.state.settings, [key]: input.checked } }));
      row.append(input);
      panel.append(row);
    }
    this.back(panel);
  }

  private help(panel: HTMLElement): void {
    panel.append(this.heading("help"), element("p", "prologue", this.t("guideIntro")));
    for (const [heading, paragraph] of [
      ["chapter", "guideCampaign"], ["orders", "guideConvoy"], ["attack", "guideCombat"],
      ["upgrades", "guideRecovery"], ["map", "guideCamera"], ["save", "guideSave"],
    ]) {
      if (heading && paragraph) panel.append(this.heading(heading, "h3"), element("p", "guide-copy", this.t(paragraph)));
    }
    this.back(panel);
  }

  private records(panel: HTMLElement): void {
    panel.append(this.heading("records"), element("p", "prologue", this.t("metaNote")));
    const stats = element("div", "record-stats");
    stats.append(this.stat("renown", this.state.profile.renown), this.stat("completedRuns", this.state.profile.completedRuns.length));
    panel.append(stats);
    const list = element("div", "upgrade-list");
    for (const offer of this.state.offers) {
      const row = element("div", "upgrade-row");
      const copy = element("div");
      copy.append(element("strong", "", this.t(`upgrade.${offer.id}`)),
        element("p", "small", this.t(`upgradeDescription.${offer.id}`)),
        element("p", "small", `${this.t("level")} ${offer.level}/${offer.maxLevel}`));
      const button = this.button("buy", { type: "metaUpgrade", id: offer.id });
      const maximum = offer.level >= offer.maxLevel;
      button.disabled = maximum || this.state.profile.renown < offer.cost;
      button.textContent = maximum ? this.t("maximum") : `${this.t("buy")} · ${offer.cost} ${this.t("renown")}`;
      row.append(copy, button);
      if (!maximum && button.disabled) row.append(element("small", "upgrade-reason", this.t("insufficientRenown")));
      list.append(row);
    }
    panel.append(list);
    this.back(panel);
  }

  private stat(key: string, value: number | string): HTMLElement {
    const stat = element("div", "stat");
    stat.append(element("strong", "", String(value)), element("span", "", this.t(key)));
    return stat;
  }

  private terminal(panel: HTMLElement): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const victory = snapshot.phase === "victory";
    panel.append(emblem(), this.label("edition"), this.heading(victory ? "victory" : "defeat"),
      element("p", "prologue", this.t(victory ? "victoryStory" : "defeatStory")));
    const stats = element("div", "record-stats");
    stats.append(this.stat("campaignTime", formatTime(snapshot.elapsed)),
      this.stat("capturedCount", snapshot.objective.captured), this.stat("suppliedCount", snapshot.objective.supplied),
      this.stat("delivered", snapshot.convoy.delivered), this.stat("kills", snapshot.player.kills),
      this.stat("reward", snapshot.rewards?.renown ?? 0));
    panel.append(stats, element("p", "small", `${this.t("runSeed")}: ${snapshot.seed}`),
      element("p", this.state.rewardSaved ? "small" : "danger-text", this.t(this.state.rewardSaved ? "rewardClaimed" : "rewardUnsaved")));
    const actions = element("div", "launch-actions");
    actions.append(this.button("replay", { type: "start", sameSeed: true }, "button primary"),
      this.button("playAgain", { type: "start", sameSeed: false }),
      this.button("records", { type: "overlay", overlay: "records" }), this.button("titleReturn", { type: "title" }));
    panel.append(actions);
  }

  private fatal(panel: HTMLElement): void {
    panel.append(emblem(), this.heading(this.fatalKind === "graphics" ? "graphicsFailure" : "gameFailure"),
      element("p", "guide-copy", this.t(this.fatalKind === "graphics" ? "graphicsDetail" : "gameFailureDetail")),
      this.button("reload", { type: "reload" }, "button primary"));
  }

  private overlayKey(event: KeyboardEvent): void {
    if (this.currentOverlay === null || this.currentOverlay === "fatal") return;
    const editable = event.target instanceof HTMLElement && event.target.matches("input, textarea, select");
    if (event.code === "Escape" || (this.currentOverlay === "map" && !editable && event.code === "KeyM")) {
      event.preventDefault();
      if (event.repeat) return;
      if (["settings", "help", "records"].includes(this.currentOverlay)) this.dispatch({ type: "overlay", overlay: this.returnOverlay });
      else if (this.currentOverlay === "pause" || this.currentOverlay === "map") this.dispatch({ type: "resume" });
      return;
    }
    if (event.code === "Tab") {
      const focusable = [...this.overlayHost.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, [tabindex='0']")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement as HTMLElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement as HTMLElement))) {
        event.preventDefault();
        first?.focus();
      }
    }
  }

  dispose(): void {
    this.controller.abort();
    this.overlayHost.replaceChildren();
  }
}
