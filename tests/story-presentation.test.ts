import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createCampaign, type GameSnapshot, type NarrativeSnapshot } from "../src/game";
import { localText, questTarget } from "../src/ui/story";
import { translate } from "../src/ui/locale";
import { WorldResidents } from "../src/view/residents";
import { ViewResources } from "../src/view/resources";

function fixture(): GameSnapshot {
  const snapshot = createCampaign({ seed: "residents", faction: "guard" }).snapshot();
  const copy = { en: "Road keeper", ru: "Road keeper RU" };
  const story: NarrativeSnapshot = {
    title: copy, chapter: copy, summary: copy, dialogue: null, inspection: null, trackedQuestId: "witness",
    discovered: [], reputation: [], facts: [], ending: null, notice: null, interaction: null,
    travel: { available: false, reason: copy, destinations: [] },
    npcs: [{ id: "keeper", name: copy, role: copy, faction: "elf", locationId: "home", x: 1, z: -54,
      heading: 0, activity: copy, available: true, questAvailable: true }],
    quests: [{ id: "witness", title: copy, description: copy, kind: "main", status: "active",
      objective: copy, targetId: "keeper", entries: [], outcome: null }],
  };
  snapshot.narrative = story;
  return snapshot;
}

describe("narrative presentation contract", () => {
  it("resolves NPC and site objectives without guessing a progression state", () => {
    const snapshot = fixture();
    const quest = snapshot.narrative!.quests[0]!;
    expect(questTarget(snapshot, quest)).toMatchObject({ x: 1, z: -54 });
    expect(questTarget(snapshot, { ...quest, targetId: "home" })).toMatchObject({ x: 0, z: -54 });
    expect(questTarget(snapshot, { ...quest, targetId: "missing" })).toBeNull();
    expect(questTarget(snapshot)).toBeNull();
  });

  it("localizes narrative and interface text in both languages", () => {
    expect(localText({ en: "Witness", ru: "Testimony RU" }, "ru")).toBe("Testimony RU");
    expect(translate("en", "subtitle")).toBe("The Hollow Road");
    expect(translate("ru", "subtitle")).toBe("Глухой тракт");
    for (const key of ["journal", "dialogue", "inspection", "inspectionHint", "continue", "guide", "travel", "active", "failed", "main", "side", "mapTarget", "unavailable"]) {
      expect(translate("en", `story.${key}`)).not.toBe(`story.${key}`);
      expect(translate("ru", `story.${key}`)).not.toBe(translate("en", `story.${key}`));
    }
  });

  it("uses the same canonical bilingual geography as the campaign", () => {
    const world = createCampaign({ seed: "canonical-geography", faction: "guard" }).snapshot().world.exploration!;
    expect(world.regions.map(({ id, name }) => [id, name.en, name.ru])).toEqual([
      ["heartlands", "The Heartlands", "Срединные земли"],
      ["greenmarch", "Greenmarch", "Зелёное пограничье"],
      ["fenlands", "The Fens", "Топи"],
      ["saltcoast", "The Salt Coast", "Соляной берег"],
      ["ashsteppe", "The Ash Steppe", "Пепельная степь"],
      ["crownlands", "Crownlands", "Коронные земли"],
      ["frostspine", "Frostspine", "Инейный хребет"],
      ["hollowvale", "Hollowvale", "Глухая долина"],
    ]);
    expect(world.locations.map(({ id, name }) => [id, name.en, name.ru])).toEqual([
      ["roadward", "Roadward Inn", "Трактовый двор"],
      ["greenhollow", "Greenhollow", "Зелёная лощина"],
      ["old-orchard", "Old Orchard", "Старый сад"],
      ["stag-shrine", "Stag Shrine", "Оленье святилище"],
      ["thornwatch", "Thornwatch", "Терновый дозор"],
      ["mirecross", "Mirecross", "Болотный брод"],
      ["drowned-archive", "Drowned Archive", "Затопленный архив"],
      ["reed-chapel", "Reed Chapel", "Камышовая часовня"],
      ["lantern-ferry", "Lantern Ferry", "Фонарная переправа"],
      ["saltmarket", "Saltmarket", "Соляной торг"],
      ["tide-observatory", "Tide Observatory", "Приливная башня"],
      ["wreckers-rest", "Wreckers' Rest", "Приют корабельщиков"],
      ["cinderwell", "Cinderwell", "Углеземье"],
      ["glass-quarry", "Glass Quarry", "Стеклянный карьер"],
      ["ash-cairn", "Ash Cairn", "Пепельный курган"],
      ["crownbridge", "Crownbridge", "Коронный мост"],
      ["tax-vault", "Sealed Vault", "Опечатанный подвал"],
      ["bell-foundry", "Bell Foundry", "Колокольный двор"],
      ["high-pass", "High Pass", "Высокий перевал"],
      ["star-monastery", "Star Monastery", "Звёздный монастырь"],
      ["frozen-beacon", "Frozen Beacon", "Замёрзший маяк"],
      ["hollow-village", "Hollow Village", "Глухая деревня"],
      ["name-well", "Echo Well", "Колодец эха"],
      ["last-archive", "Old Cloister", "Старый скит"],
    ]);
  });

  it("mirrors noncombatants without changing simulation state and reuses their resources", () => {
    const snapshot = fixture();
    const original = structuredClone(snapshot);
    const scene = new THREE.Scene();
    const resources = new ViewResources();
    const residents = new WorldResidents(resources, scene);
    const camera = new THREE.PerspectiveCamera();
    residents.update(snapshot, camera, true);
    const person = scene.getObjectByName("resident:keeper");
    expect(person?.visible).toBe(true);
    expect(person?.userData.npcId).toBe("keeper");
    const disposals: ReturnType<typeof vi.fn>[] = [];
    const materials = new Set<THREE.Material>();
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
    });
    for (const material of materials) {
      const dispose = vi.fn();
      material.addEventListener("dispose", dispose);
      disposals.push(dispose);
    }
    for (let i = 0; i < 100; i++) residents.update(snapshot, camera, true);
    expect(scene.children).toHaveLength(1);
    expect(snapshot).toEqual(original);
    snapshot.player.x = 450;
    residents.update(snapshot, camera, false);
    expect(person?.visible).toBe(false);
    snapshot.narrative!.npcs = [];
    residents.update(snapshot, camera, false);
    expect(scene.children).toHaveLength(0);
    residents.dispose();
    resources.dispose();
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
