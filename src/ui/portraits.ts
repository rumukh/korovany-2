import type { FactionId, LocalizedText } from "../game";
import type { Language } from "./storage";

export const NPC_PORTRAIT_IDS = [
  "mara", "toman", "lida", "yara", "sella", "ivet", "oss", "orsa", "dren", "hana",
  "beran", "tessa", "vesk", "radek", "nika", "lev", "ada", "mila", "elin", "ren",
] as const;

export const PLAYER_PORTRAITS = {
  elf: "player-elf",
  guard: "player-guard",
  villain: "player-villain",
} as const satisfies Record<FactionId, string>;

export type PortraitId = typeof NPC_PORTRAIT_IDS[number] | typeof PLAYER_PORTRAITS[FactionId];

const loading: LocalizedText = { en: "Loading portrait", ru: "Загрузка портрета" };
const unavailable: LocalizedText = { en: "Portrait unavailable", ru: "Портрет недоступен" };

export function npcPortraitId(npcId: string): PortraitId | null {
  return NPC_PORTRAIT_IDS.find((id) => id === npcId) ?? null;
}

export function portraitUrl(id: PortraitId): string {
  return `${import.meta.env.BASE_URL}portraits/${id}.webp`;
}

export function portraitContent(id: PortraitId | null, name: string, language: Language): HTMLElement {
  const root = document.createElement("div");
  root.className = "character-portrait";
  root.dataset.portrait = id ?? "missing";
  root.dataset.state = "loading";
  const status = document.createElement("span");
  status.className = "portrait-status";
  status.setAttribute("role", "status");
  status.textContent = loading[language];
  status.setAttribute("aria-label", `${loading[language]}: ${name}`);
  root.append(status);
  const fail = () => {
    root.dataset.state = "error";
    status.hidden = false;
    status.textContent = unavailable[language];
    status.setAttribute("aria-label", `${unavailable[language]}: ${name}`);
    console.error("Korovany II portrait failure.", { id, name, url: id ? portraitUrl(id) : null });
  };
  if (!id) {
    fail();
    return root;
  }
  const image = document.createElement("img");
  image.alt = "";
  image.width = 320;
  image.height = 320;
  image.decoding = "async";
  image.draggable = false;
  image.addEventListener("load", () => {
    root.dataset.state = "ready";
    status.hidden = true;
  }, { once: true });
  image.addEventListener("error", () => {
    image.hidden = true;
    fail();
  }, { once: true });
  image.src = portraitUrl(id);
  root.prepend(image);
  return root;
}
