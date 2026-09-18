import type { GameSnapshot, LocalizedText, NarrativeInput, QuestSnapshot, Vec2 } from "../game";
import { translate } from "./locale";
import { npcPortraitId, PLAYER_PORTRAITS, portraitContent } from "./portraits";
import type { Language } from "./storage";

export function localText(text: LocalizedText, language: Language): string {
  return text[language];
}

export function worldTarget(snapshot: GameSnapshot, id: string | null | undefined, language: Language): (Vec2 & { name: string }) | null {
  if (!id) return null;
  const npc = snapshot.narrative?.npcs.find((entry) => entry.id === id);
  if (npc) return { x: npc.x, z: npc.z, name: localText(npc.name, language) };
  const location = snapshot.world.exploration?.locations.find((entry) => entry.id === id);
  if (location) return { x: location.x, z: location.z, name: localText(location.name, language) };
  const actor = snapshot.actors.find((entry) => entry.id === id);
  if (actor) return { x: actor.x, z: actor.z, name: actor.name ? localText(actor.name, language) : id };
  if (id === snapshot.convoy.id) return { x: snapshot.convoy.x, z: snapshot.convoy.z, name: translate(language, "convoy") };
  const site = snapshot.world.sites.find((entry) => entry.id === id);
  return site ? { x: site.x, z: site.z, name: site.name ? localText(site.name, language) : translate(language, site.nameKey) } : null;
}

export function questTarget(snapshot: GameSnapshot, quest?: QuestSnapshot, language: Language = "en"): (Vec2 & { name: string }) | null {
  return worldTarget(snapshot, quest?.targetId, language);
}

export function militaryObjective(snapshot: GameSnapshot, language: Language): string {
  return snapshot.campaign ? localText(snapshot.campaign.objectiveLabel, language) : translate(language, snapshot.objective.key);
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function button(text: string, action: () => void, className = "button"): HTMLButtonElement {
  const result = node("button", className, text);
  result.type = "button";
  result.addEventListener("click", action);
  return result;
}

export function campaignContent(snapshot: GameSnapshot, language: Language): HTMLElement {
  const root = node("section", "campaign-briefing");
  const campaign = snapshot.campaign;
  if (!campaign) return root;
  const text = (value: LocalizedText) => localText(value, language);
  const t = (key: string) => translate(language, `campaign.${key}`);
  root.dataset.campaign = campaign.identity.id;
  root.setAttribute("aria-label", t("orders"));
  const identity = node("div", "campaign-identity");
  identity.append(node("p", "eyebrow", text(campaign.identity.name)),
    node("h3", "", text(campaign.identity.role)));
  const home = worldTarget(snapshot, campaign.identity.homeLocationId, language);
  if (home) identity.append(node("p", "small campaign-home", `${t("home")}: ${home.name}`));
  if (campaign.directive) identity.append(node("p", "small campaign-directive", `${t("directive")}: ${t(`directive.${campaign.directive}`)}`));
  identity.append(node("p", "guide-copy campaign-allegiance", text(campaign.identity.allegiance)),
    node("h3", "", t("orders")), node("p", "guide-copy campaign-orders", text(campaign.orders)));
  const military = node("div", "campaign-military");
  military.append(node("p", "eyebrow", t("military")), node("p", "campaign-objective", militaryObjective(snapshot, language)));
  const requirements = node("ul", "campaign-requirements");
  for (const requirement of campaign.requirements) {
    const row = node("li", "", `${translate(language, requirement.complete ? "story.completed" : "story.active")}: ${text(requirement.label)}`);
    row.dataset.requirement = requirement.id;
    row.dataset.complete = String(requirement.complete);
    const target = worldTarget(snapshot, requirement.targetId, language);
    if (!requirement.complete && target) row.append(node("span", "small requirement-target", target.name));
    requirements.append(row);
  }
  military.append(requirements, node("p", "small campaign-shipment", `${text(campaign.shipment.role)}: ${text(campaign.shipment.status)}`));
  const relationships = node("div", "campaign-relationships");
  relationships.append(node("h3", "", t("relationships")));
  const standings = node("ul", "campaign-standings");
  for (const standing of campaign.standing) {
    const row = node("li", `campaign-standing ${standing.relation}`);
    row.dataset.politicalFaction = standing.id;
    row.append(node("span", "", text(standing.name)), node("strong", "", t(`relation.${standing.relation}`)));
    standings.append(row);
  }
  relationships.append(standings);
  root.append(identity, military, relationships);
  return root;
}

export function dialogueContent(snapshot: GameSnapshot, language: Language, command: (input: NarrativeInput) => void): HTMLElement {
  const root = node("div", "conversation");
  const dialogue = snapshot.narrative?.dialogue;
  if (!dialogue) return root;
  const text = (value: LocalizedText) => localText(value, language);
  const header = node("header", "conversation-header");
  const portrait = portraitContent(npcPortraitId(dialogue.npcId), text(dialogue.name), language);
  const identity = node("div");
  identity.append(node("p", "eyebrow", text(dialogue.role)), node("h2", "", text(dialogue.name)));
  header.append(portrait, identity);
  const speech = node("p", "dialogue-speech", text(dialogue.text));
  speech.id = "dialogue-speech";
  speech.setAttribute("aria-live", "polite");
  root.append(header, speech);
  if (dialogue.choices.length) {
    const player = node("div", "dialogue-player");
    const role = snapshot.campaign ? text(snapshot.campaign.identity.role) : translate(language, `faction.${snapshot.faction}`);
    const identity = node("div");
    identity.append(node("p", "eyebrow", translate(language, "story.answers")), node("p", "player-identity", role));
    player.append(portraitContent(PLAYER_PORTRAITS[snapshot.faction], `${translate(language, "hero")}: ${role}`, language), identity);
    root.append(player);
  }
  const choices = node("div", "dialogue-choices");
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", translate(language, "story.answers"));
  dialogue.choices.forEach((choice, index) => {
    const option = button("", () => command({ type: "choose", npcId: dialogue.npcId, choiceId: choice.id }), "dialogue-choice");
    option.dataset.choice = choice.id;
    option.dataset.npc = dialogue.npcId;
    option.disabled = !choice.enabled;
    option.append(node("span", "choice-number", String(index + 1)), node("span", "", text(choice.text)));
    if (choice.reason) option.append(node("small", "choice-reason", text(choice.reason)));
    choices.append(option);
  });
  root.append(choices, node("p", "small muted", translate(language, "story.dialogueHint")));
  if (snapshot.narrative?.notice) root.append(node("p", "story-notice", text(snapshot.narrative.notice)));
  const close = button(translate(language, "story.leave"), () => command({ type: "close" }), "button quiet");
  close.dataset.action = "close-dialogue";
  root.append(close);
  return root;
}

export function inspectionContent(snapshot: GameSnapshot, language: Language, command: (input: NarrativeInput) => void): HTMLElement {
  const root = node("article", "inspection");
  const inspection = snapshot.narrative?.inspection;
  if (!inspection) return root;
  const title = node("h2", "", localText(inspection.title, language));
  title.id = "inspection-title";
  root.setAttribute("aria-labelledby", title.id);
  root.dataset.location = inspection.locationId;
  const evidence = node("div", "inspection-text");
  for (const paragraph of localText(inspection.text, language).split(/\n\s*\n/).filter((part) => part.trim())) {
    evidence.append(node("p", "", paragraph));
  }
  const hint = node("p", "small muted", translate(language, "story.inspectionHint"));
  const close = button(translate(language, "story.continue"), () => command({ type: "close" }), "button primary");
  close.dataset.action = "close-inspection";
  root.append(node("p", "eyebrow", translate(language, "story.inspection")), title, evidence, hint, close);
  return root;
}

export type QuestFilter = "active" | "completed" | "all";

export function journalContent(
  snapshot: GameSnapshot,
  language: Language,
  selectedId: string | null,
  filter: QuestFilter,
  select: (id: string) => void,
  setFilter: (filter: QuestFilter) => void,
  command: (input: NarrativeInput) => void,
): HTMLElement {
  const root = node("div", "story-journal");
  const story = snapshot.narrative;
  const t = (key: string) => translate(language, `story.${key}`);
  const text = (value: LocalizedText) => localText(value, language);
  if (!story) {
    root.append(node("p", "guide-copy", t("unavailable")));
    return root;
  }
  root.append(node("p", "eyebrow", text(story.chapter)), node("h2", "", text(story.title)),
    node("p", "prologue", text(story.summary)));
  if (snapshot.campaign) root.append(campaignContent(snapshot, language));
  const tabs = node("div", "quest-filters");
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", t("filter"));
  for (const value of ["active", "completed", "all"] as const) {
    const tab = button(t(value), () => setFilter(value), "button small");
    tab.setAttribute("aria-pressed", String(filter === value));
    tabs.append(tab);
  }
  root.append(tabs);
  const visible = story.quests.filter((quest) => filter === "all" ||
    (filter === "completed" ? ["completed", "failed"].includes(quest.status) : ["active", "available"].includes(quest.status)));
  const selected = visible.find((quest) => quest.id === selectedId) ??
    visible.find((quest) => quest.id === story.trackedQuestId) ?? visible[0];
  const layout = node("div", "quest-layout");
  const list = node("nav", "quest-list");
  list.setAttribute("aria-label", t("quests"));
  for (const quest of visible) {
    const entry = button("", () => select(quest.id), "quest-entry");
    entry.dataset.quest = quest.id;
    entry.setAttribute("aria-current", String(selected?.id === quest.id));
    entry.append(node("span", "eyebrow", `${t(quest.kind)} / ${t(quest.status)}`),
      node("strong", "", text(quest.title)));
    if (story.trackedQuestId === quest.id) entry.append(node("small", "quest-tracked", t("tracked")));
    list.append(entry);
  }
  if (!visible.length) list.append(node("p", "small muted", t("empty")));
  const detail = node("article", "quest-detail");
  if (selected) {
    detail.append(node("p", "eyebrow", `${t(selected.kind)} / ${t(selected.status)}`),
      node("h3", "", text(selected.title)), node("p", "guide-copy", text(selected.description)));
    const objective = node("section", "quest-objective");
    objective.append(node("p", "eyebrow", t("next")), node("p", "", text(selected.objective)));
    const target = questTarget(snapshot, selected, language);
    if (target) objective.append(node("p", "small muted",
      `${Math.round(Math.hypot(target.x - snapshot.player.x, target.z - snapshot.player.z))} ${t("metres")} / ${t("mapTarget")}`));
    detail.append(objective);
    if (selected.status === "active" || selected.status === "available") {
      const tracked = story.trackedQuestId === selected.id;
      const track = button(t(tracked ? "untrack" : "track"), () => command({ type: "track", questId: tracked ? null : selected.id }));
      track.dataset.action = "track-quest";
      detail.append(track);
    }
    const outcome = selected.outcome ? text(selected.outcome) : null;
    const history = selected.entries.filter((entry) => text(entry) !== outcome);
    if (history.length) {
      detail.append(node("h3", "", t("entries")));
      const entries = node("ol", "quest-history");
      for (const entry of history) entries.append(node("li", "", text(entry)));
      detail.append(entries);
    }
    if (outcome) detail.append(node("p", "quest-outcome", outcome));
  }
  layout.append(list, detail);
  root.append(layout);
  const reputation = node("section", "story-reputation");
  reputation.append(node("h3", "", t("reputation")));
  const standings = node("div", "reputation-grid");
  for (const faction of story.reputation) {
    const standing = node("div", "reputation-standing");
    standing.append(node("span", "", text(faction.name)),
      node("strong", faction.value < 0 ? "danger-text" : "", `${faction.value > 0 ? "+" : ""}${faction.value}`));
    standings.append(standing);
  }
  reputation.append(standings);
  root.append(reputation);
  if (story.facts.length) {
    const facts = node("details", "story-facts");
    facts.append(node("summary", "", `${t("facts")} (${story.facts.length})`));
    for (const fact of story.facts) facts.append(node("p", "guide-copy", text(fact)));
    root.append(facts);
  }
  if (story.ending && (!selected?.outcome || text(story.ending) !== text(selected.outcome))) {
    root.append(node("p", "quest-outcome", text(story.ending)));
  }
  if (story.notice && (!selected?.outcome || text(story.notice) !== text(selected.outcome)) &&
    (!story.ending || text(story.notice) !== text(story.ending))) {
    root.append(node("p", "story-notice", text(story.notice)));
  }
  return root;
}
