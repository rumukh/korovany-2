import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { createServer, type ViteDevServer } from "vite";
import { createCampaign, FACTION_CAMPAIGNS, type FactionId, type GameSnapshot } from "../src/game";
import { translate } from "../src/ui/locale";
import { militaryObjective, questTarget, worldTarget } from "../src/ui/story";
import { storageKeys, type Language } from "../src/ui/storage";
import { Presentation } from "../src/view";
import { factionColors, palette } from "../src/view/palette";
import { ViewResources } from "../src/view/resources";
import { distanceToSegment, oldFortStructure } from "../src/view/world";
import {
  click, evaluate, launchBrowser, openPage, screenshot, until,
  type CdpSession, type LaunchedBrowser,
} from "../vendor/aegis-engine/packages/render-three/src/browser";
import { closeOwnedBrowser } from "../vendor/aegis-engine/packages/render-three/src/testing/browser-lifecycle";

const factions: FactionId[] = ["elf", "guard", "villain"];
const languages: Language[] = ["en", "ru"];

describe("faction presentation source of truth", () => {
  it.each(factions)("uses canonical %s identity and military instructions in both languages", (faction) => {
    const snapshot = createCampaign({ seed: "faction-presentation", faction }).snapshot();
    for (const language of languages) {
      expect(translate(language, `faction.${faction}`)).toBe(FACTION_CAMPAIGNS[faction].name[language]);
      expect(militaryObjective(snapshot, language)).toBe(snapshot.campaign!.objectiveLabel[language]);
      snapshot.objective.key = "legacy-objective-must-not-leak";
      expect(militaryObjective(snapshot, language)).not.toContain("legacy-objective");
    }
    expect(FACTION_CAMPAIGNS.elf.introduction.en).toContain("your home");
    expect(FACTION_CAMPAIGNS.guard.allegiance.en).toContain("garrison");
    expect(FACTION_CAMPAIGNS.villain.role.en).toContain("ruler");
    expect(FACTION_CAMPAIGNS.guard.militaryObjective.en).toMatch(/protect/i);
    expect(FACTION_CAMPAIGNS.guard.militaryObjective.en).not.toMatch(/destroy.+(?:wagon|shipment|caravan)/i);
  });

  it("resolves moving shipments, faction homes and localized sites from current snapshot coordinates", () => {
    const snapshot = createCampaign({ seed: "moving-target-label", faction: "guard" }).snapshot();
    const shipment = snapshot.actors.find((actor) => actor.id === snapshot.campaign!.shipment.targetId)!;
    shipment.x += 23;
    shipment.z -= 17;
    const original = structuredClone(snapshot);
    for (const language of languages) {
      expect(worldTarget(snapshot, shipment.id, language)).toEqual({
        x: shipment.x, z: shipment.z, name: shipment.name![language],
      });
      const home = snapshot.world.exploration!.locations.find((place) => place.id === snapshot.campaign!.identity.homeLocationId)!;
      expect(worldTarget(snapshot, home.id, language)).toEqual({ x: home.x, z: home.z, name: home.name[language] });
      const palace = snapshot.world.sites.find((site) => site.id === "palace")!;
      expect(worldTarget(snapshot, palace.id, language)?.name).toBe(palace.name![language]);
      expect(worldTarget(snapshot, "no-such-target", language)).toBeNull();
      expect(questTarget(snapshot, undefined, language)).toBeNull();
    }
    expect(snapshot).toEqual(original);
  });

  it.each(factions)("retains explicit legacy military instructions for %s", (faction) => {
    const snapshot = createCampaign({ seed: "legacy-presentation", faction, worldVersion: 1 }).snapshot();
    expect(snapshot.campaign).toBeUndefined();
    for (const language of languages) {
      expect(militaryObjective(snapshot, language)).toBe(translate(language, snapshot.objective.key));
      const home = snapshot.world.sites.find((site) => site.id === "home")!;
      expect(worldTarget(snapshot, "home", language)?.name).toBe(translate(language, home.nameKey));
    }
  });

  it("mirrors affiliation changes, suppresses allied threats and preserves a disabled shipment as repairable", () => {
    const snapshot = createCampaign({ seed: "faction-scene", faction: "villain" }).snapshot();
    snapshot.narrative = undefined;
    const presentation = new Presentation(snapshot.world);
    const camera = new THREE.PerspectiveCamera();
    const color = (object: THREE.Object3D | undefined): string => {
      if (!(object instanceof THREE.Mesh)) throw new Error("Expected a painted scene mesh");
      const material = object.material;
      if (!(material instanceof THREE.MeshBasicMaterial || material instanceof THREE.MeshStandardMaterial)) {
        throw new Error("Expected one colored presentation material");
      }
      return `#${material.color.getHexString()}`;
    };
    try {
      const friend = snapshot.actors.find((actor) => actor.allegiance === "friendly" && actor.kind !== "caravan")!;
      const enemy = snapshot.actors.find((actor) => actor.allegiance === "hostile" && actor.kind !== "caravan")!;
      friend.state = "windup";
      enemy.state = "windup";
      friend.faction = "guard";
      enemy.faction = "villain";
      const wagon = snapshot.actors.find((actor) => actor.id === snapshot.campaign!.shipment.targetId)!;
      presentation.update(snapshot, 0, camera, true);
      expect(presentation.scene.getObjectByName(`tell:${friend.id}`)?.visible).toBe(false);
      expect(presentation.scene.getObjectByName(`tell:${enemy.id}`)?.visible).toBe(true);
      expect(color(presentation.scene.getObjectByName(`actor:${friend.id}`)?.getObjectByName("health-fill"))).toBe(palette.teal);
      expect(color(presentation.scene.getObjectByName(`actor:${enemy.id}`)?.getObjectByName("health-fill"))).toBe(palette.ember);
      expect(color(presentation.scene.getObjectByName("fortress-flag"))).toBe(factionColors.guard);
      const neutralWagon = presentation.scene.getObjectByName(`actor:${wagon.id}`)!;
      expect(neutralWagon.userData.allegiance).toBe("neutral");
      expect(color(neutralWagon.getObjectByName("health-fill"))).toBe(palette.stone);
      wagon.allegiance = "friendly";
      presentation.update(snapshot, 0, camera, true);
      const friendlyWagon = presentation.scene.getObjectByName(`actor:${wagon.id}`)!;
      expect(friendlyWagon).not.toBe(neutralWagon);
      expect(neutralWagon.parent).toBeNull();
      expect(friendlyWagon.userData.allegiance).toBe("friendly");
      expect(color(friendlyWagon.getObjectByName("health-fill"))).toBe(palette.teal);
      wagon.hp = 0;
      wagon.state = "idle";
      for (const actor of snapshot.actors.filter((actor) => actor.id !== wagon.id)) {
        actor.hp = 0;
        actor.state = "dead";
      }
      snapshot.actors = [...snapshot.actors.filter((actor) => actor.id !== wagon.id), wagon];
      presentation.update(snapshot, 0, camera, true);
      expect(friendlyWagon.visible).toBe(true);
      expect(friendlyWagon.rotation.z).toBe(0.085);
      expect(friendlyWagon.getObjectByName("health-bar")?.visible).toBe(true);
      wagon.hp = wagon.maxHp;
      presentation.update(snapshot, 0, camera, true);
      expect(friendlyWagon.rotation.z).toBe(0);
      snapshot.fortress.bossDefeated = true;
      presentation.update(snapshot, 0, camera, true);
      expect(color(presentation.scene.getObjectByName("fortress-flag"))).toBe(factionColors.villain);
      expect(color(presentation.scene.getObjectByName("fortress-ring"))).toBe(palette.teal);
      const expected = structuredClone(snapshot);
      presentation.update(snapshot, 0, camera, true);
      expect(snapshot).toEqual(expected);
    } finally {
      presentation.dispose();
    }
  });

  it("fits Old Fort walls and towers to authoritative blockers without closing either road gate", () => {
    const snapshot = createCampaign({ seed: "old-fort-identity", faction: "villain" }).snapshot();
    const home = snapshot.world.exploration!.locations.find((place) => place.id === "old-fort")!;
    const blockers = snapshot.world.obstacles.filter((obstacle) =>
      obstacle.id.startsWith("old-fort-building-") || obstacle.id.startsWith("old-fort-wall-"));
    expect(blockers.filter((obstacle) => obstacle.id.startsWith("old-fort-building-"))).toHaveLength(6);
    const towers = blockers.filter((obstacle) => obstacle.id.startsWith("old-fort-wall-tower-"));
    expect(towers).toHaveLength(2);
    expect(towers.every((tower) => tower.z > home.z && tower.height >= 14)).toBe(true);
    expect(blockers.filter((obstacle) => obstacle.id.startsWith("old-fort-wall-")).length).toBeGreaterThanOrEqual(14);
    const original = JSON.stringify(snapshot.world);
    const resources = new ViewResources();
    const point = new THREE.Vector3();
    try {
      for (const obstacle of blockers) {
        const model = oldFortStructure(resources, obstacle, home);
        model.updateMatrixWorld(true);
        model.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          const positions = object.geometry.getAttribute("position");
          for (let index = 0; index < positions.count; index++) {
            point.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld);
            expect(Math.hypot(point.x - obstacle.x, point.z - obstacle.z), obstacle.id).toBeLessThanOrEqual(obstacle.radius + 0.05);
            expect(point.y, obstacle.id).toBeLessThanOrEqual(obstacle.height + 0.05);
          }
        });
        for (const edge of snapshot.world.roads.edges) {
          const from = snapshot.world.roads.nodes.find((node) => node.id === edge.from)!;
          const to = snapshot.world.roads.nodes.find((node) => node.id === edge.to)!;
          expect(distanceToSegment(obstacle, from, to) - obstacle.radius, `${obstacle.id}: ${edge.from} -> ${edge.to}`)
            .toBeGreaterThanOrEqual(edge.width / 2 + 1.49);
        }
      }
      expect(JSON.stringify(snapshot.world)).toBe(original);
    } finally {
      resources.dispose();
    }
  });
});

describe.runIf(process.env.KOROVANY_BROWSER === "1")("faction presentation in the browser", () => {
  let server: ViteDevServer | undefined;
  let browser: LaunchedBrowser | undefined;
  let cdp: CdpSession;

  async function select(selector: string): Promise<void> {
    const point = await evaluate<{ x: number; y: number }>(cdp, `(() => {
      const control = document.querySelector(${JSON.stringify(selector)});
      if (!control || control.disabled) throw new Error('Unavailable faction control: ' + ${JSON.stringify(selector)});
      control.scrollIntoView({block: 'center'});
      const rect = control.getBoundingClientRect();
      return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    })()`);
    await click(cdp, point.x, point.y);
  }

  async function tap(code: string): Promise<void> {
    const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : code;
    const windowsVirtualKeyCode = code.startsWith("Key") ? code.charCodeAt(3) : code === "Escape" ? 27 : 9;
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, code, key, windowsVirtualKeyCode });
  }

  async function reload(): Promise<void> {
    const origin = await evaluate<number>(cdp, "performance.timeOrigin");
    await cdp.send("Page.reload");
    await until(cdp, `performance.timeOrigin !== ${origin} && Boolean(window.korovany) && window.korovany.inspect().overlay === 'menu'`, Boolean, 30_000);
  }

  async function capture(name: string): Promise<void> {
    if (process.env.KOROVANY_CAPTURE_DIR) await screenshot(cdp, join(process.env.KOROVANY_CAPTURE_DIR, `${name}.png`));
  }

  beforeAll(async () => {
    if (process.env.KOROVANY_CAPTURE_DIR) await mkdir(process.env.KOROVANY_CAPTURE_DIR, { recursive: true });
    server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error("Missing faction presentation preview URL");
    expect((await fetch(origin)).status).toBe(200);
    browser = await launchBrowser({ viewport: { width: 1440, height: 1000 } });
    cdp = await openPage(browser.port, origin, { width: 1440, height: 1000 });
    await until(cdp, "Boolean(window.korovany)", Boolean, 30_000);
  }, 90_000);

  afterAll(async () => {
    cdp?.close();
    if (browser) {
      await closeOwnedBrowser(browser);
      await rm(browser.profile, { recursive: true, force: true });
    }
    await server?.close();
  }, 30_000);

  it("presents three roles, changes the selected briefing without losing focus and retains selection through language/settings", async () => {
    for (const language of ["ru", "en"] as const) {
      if (await evaluate(cdp, "document.documentElement.lang") !== language) await select(".language-button");
      for (const faction of factions) {
        await select(`[data-faction="${faction}"]`);
        const state = await evaluate<{
          cards: string[]; selected: string[]; intro: string; focus: string; summary: boolean;
        }>(cdp, `(() => ({
          cards: [...document.querySelectorAll('.faction-card')].map(card => card.textContent),
          selected: [...document.querySelectorAll('.faction-card[aria-pressed="true"]')].map(card => card.dataset.faction),
          intro: document.querySelector('.campaign-introduction').textContent,
          focus: document.activeElement.dataset.faction,
          summary: Boolean(document.querySelector('.campaign-equipment summary')),
        }))()`);
        expect(state.selected).toEqual([faction]);
        expect(state.focus).toBe(faction);
        for (const [index, id] of factions.entries()) expect(state.cards[index]).toContain(FACTION_CAMPAIGNS[id].role[language]);
        expect(state.intro).toContain(FACTION_CAMPAIGNS[faction].introduction[language]);
        expect(state.intro).toContain(FACTION_CAMPAIGNS[faction].allegiance[language]);
        expect(state.intro).toContain(FACTION_CAMPAIGNS[faction].militaryObjective[language]);
        expect(state.intro).not.toMatch(/Iron company|Железная дружина|Hired to escort|Вас наняли/);
        expect(state.summary).toBe(true);
      }
    }
    await select('[data-action="open-settings"]');
    await select('[data-action="open-menu"]');
    expect(await evaluate(cdp, "document.querySelector('.campaign-introduction').dataset.campaign")).toBe("villain");
    await capture("faction-title-en");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 430, height: 900, deviceScaleFactor: 1, mobile: false });
    await select(".language-button");
    await select('[data-faction="guard"]');
    expect(await evaluate(cdp, "document.querySelector('.menu-panel').scrollWidth <= document.querySelector('.menu-panel').clientWidth")).toBe(true);
    await capture("faction-title-ru-narrow");
    await tap("Tab");
    expect(await evaluate(cdp, "document.querySelector('.menu-panel').contains(document.activeElement)")).toBe(true);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  }, 120_000);

  it("starts the chosen home campaign, restores its identity and does not turn a continued guard run into the menu's new selection", async () => {
    await select('[data-action="start"]');
    await until(cdp, "window.korovany.inspect().running", Boolean, 30_000);
    await tap("Escape");
    const started = await evaluate<GameSnapshot>(cdp, "window.korovany.inspect().snapshot");
    expect(started.faction).toBe("guard");
    expect(started.campaign!.identity.homeLocationId).toBe("crownbridge");
    await select('[data-action="save"]');
    await reload();
    expect(await evaluate(cdp, "document.querySelector('.campaign-introduction').dataset.campaign")).toBe("guard");
    await select('[data-faction="villain"]');
    expect(await evaluate(cdp, "document.querySelector('.saved-campaign').textContent")).toContain(FACTION_CAMPAIGNS.guard.name.ru);
    await select('[data-action="continue"]');
    await until(cdp, "window.korovany.inspect().running", Boolean, 30_000);
    await tap("KeyJ");
    const paused = await evaluate<{ snapshot: GameSnapshot; running: boolean }>(cdp, "window.korovany.inspect()");
    expect(paused.running).toBe(false);
    expect(paused.snapshot.runId).toBe(started.runId);
    expect(paused.snapshot.faction).toBe("guard");
    expect(await evaluate(cdp, "document.querySelector('.campaign-briefing').dataset.campaign")).toBe("guard");
    await evaluate(cdp, "new Promise(resolve => setTimeout(resolve, 150))");
    expect(await evaluate(cdp, "window.korovany.inspect().snapshot.tick")).toBe(paused.snapshot.tick);
    await capture("faction-journal-ru");
    await tap("Escape");
    await tap("Escape");
    await select('[data-action="title"]');
    expect(await evaluate(cdp, "document.querySelector('.campaign-introduction').dataset.campaign")).toBe("guard");
  }, 90_000);

  it("presents the actual villain campaign at its Old Fort home", async () => {
    await evaluate(cdp, `localStorage.removeItem(${JSON.stringify(storageKeys.campaign)})`);
    await reload();
    await select('[data-faction="villain"]');
    await evaluate(cdp, `(() => {
      const seed = document.querySelector('.seed-input');
      seed.value = 'old-fort-identity';
      seed.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await select('[data-action="start"]');
    await until(cdp, "window.korovany.inspect().snapshot?.tick ?? 0", (tick: number) => tick >= 2, 30_000);
    const snapshot = await evaluate<GameSnapshot>(cdp, "window.korovany.inspect().snapshot");
    expect(snapshot.faction).toBe("villain");
    expect(snapshot.campaign!.identity.homeLocationId).toBe("old-fort");
    const home = snapshot.world.sites.find((site) => site.id === "home")!;
    expect(Math.hypot(home.x - snapshot.player.x, home.z - snapshot.player.z)).toBeLessThan(10);
    expect(snapshot.narrative!.npcs.some((npc) => npc.id === "ren")).toBe(true);
    await capture("villain-home-gameplay");
    await evaluate(cdp, "document.querySelector('.hud').style.visibility = 'hidden'");
    await capture("villain-home-world");
    await evaluate(cdp, "document.querySelector('.hud').style.visibility = ''");
    await tap("Escape");
  }, 60_000);

  it("renders current orders, relationships, moving targets and terminal meanings from authoritative snapshots, including legacy", async () => {
    const fixtures = [
      ...factions.map((faction) => createCampaign({ seed: "presentation-surfaces", faction }).snapshot()),
      createCampaign({ seed: "presentation-legacy", faction: "guard", worldVersion: 1 }).snapshot(),
    ];
    for (const language of languages) {
      for (const fixture of fixtures) {
        const result = await evaluate<{
          journal: string; orders: string | null; standings: number; mapTitle: string; target: string | null;
          siteNames: string[]; hud: string; ownConvoyTitle: string; help: string; terminal: string; terminalLabel: string | null; legacyMarker: boolean;
          bossLabel: string | null; neutralBoss: boolean; movingTarget: string | null; movingPosition: string | null;
          shipmentTitle: string | null; shipmentPosition: { x: number; y: number } | null;
        }>(cdp, `(async () => {
          const { GameShell } = await import('/src/ui/shell.ts');
          const { createProfile } = await import('/src/game/index.ts');
          const root = document.createElement('div');
          document.body.append(root);
          const snapshot = ${JSON.stringify(fixture)};
          const language = ${JSON.stringify(language)};
          const shell = new GameShell(root, {
            settings: {language, quality:'low', muted:true, reducedMotion:true},
            faction:snapshot.faction, seed:snapshot.seed, hasSave:true, profile:createProfile(), offers:[], rewardSaved:true,
          }, () => {});
          try {
            shell.update(snapshot);
            shell.show('journal');
            const journal = root.querySelector('.journal-panel').textContent;
            const orders = root.querySelector('.campaign-orders')?.textContent ?? null;
            const standings = root.querySelectorAll('.campaign-standing').length;
            shell.show('map');
            const siteNames = [...root.querySelectorAll('.destination-select option')].map(option => option.textContent);
            const mapTitle = root.querySelector('.atlas-sidebar h3').textContent;
            const marker = root.querySelector('.atlas-paper [data-military-target]');
            const target = marker?.querySelector('title')?.textContent ?? null;
            const legacyMarker = Boolean(marker);
            const shipmentTitle = root.querySelector('.atlas-paper [data-shipment] title')?.textContent ?? null;
            shell.show(null);
            const hud = root.querySelector('.hud-top').textContent;
            const ownConvoyTitle = root.querySelector('.convoy-panel > .eyebrow').textContent;
            shell.show('pause');
            shell.show('help');
            const help = root.querySelector('.help-panel').textContent;
            const boss = snapshot.actors.find(actor => actor.id === snapshot.fortress.bossId);
            snapshot.fortress.unlocked = true;
            snapshot.player.x = boss.x;
            snapshot.player.z = boss.z;
            shell.show(null);
            const bossLabel = root.querySelector('.boss [role="meter"]')?.getAttribute('aria-label') ?? null;
            boss.allegiance = 'neutral';
            shell.update(snapshot);
            const neutralBoss = Boolean(root.querySelector('.boss [role="meter"]'));
            let movingTarget = null, movingPosition = null, shipmentPosition = null;
            if (snapshot.campaign) {
              const shipment = snapshot.actors.find(actor => actor.id === snapshot.campaign.shipment.targetId);
              shipment.x += 23;
              shipment.z -= 17;
              snapshot.objective.targetId = shipment.id;
              snapshot.campaign.objectiveLabel = snapshot.campaign.requirements.find(item => item.id === 'shipment').label;
              shell.update(snapshot);
              shell.show('map');
              const marker = root.querySelector('.atlas-paper [data-military-target]');
              movingTarget = marker.querySelector('title').textContent;
              movingPosition = marker.getAttribute('transform');
              const moving = root.querySelector('.atlas-paper [data-shipment]');
              shipmentPosition = {x:Number(moving.getAttribute('x')),y:Number(moving.getAttribute('y'))};
            }
            snapshot.phase = 'victory';
            shell.update(snapshot);
            shell.show('terminal');
            return {journal, orders, standings, mapTitle, target, siteNames, hud, ownConvoyTitle, help,
              terminal:root.querySelector('.terminal-panel').textContent,
              terminalLabel:root.querySelector('.terminal-panel').getAttribute('aria-label'), legacyMarker,
              bossLabel, neutralBoss, movingTarget, movingPosition, shipmentTitle, shipmentPosition};
          } finally {
            shell.dispose();
            root.remove();
          }
        })()`);
        if (fixture.campaign) {
          const { identity, objectiveLabel, orders, standing, shipment, requirements } = fixture.campaign;
          expect(result.journal).toContain(identity.role[language]);
          expect(result.orders).toBe(orders[language]);
          expect(result.standings).toBe(4);
          for (const relation of standing) expect(result.journal).toContain(relation.name[language]);
          expect(result.journal).toContain(shipment.status[language]);
          for (const requirement of requirements) expect(result.journal).toContain(requirement.label[language]);
          expect(result.mapTitle).toBe(objectiveLabel[language]);
          const target = worldTarget(fixture, fixture.objective.targetId, language);
          if (target) expect(result.target).toBe(`${objectiveLabel[language]}: ${target.name}`);
          expect(result.hud).toContain(objectiveLabel[language]);
          expect(result.ownConvoyTitle).toBe(translate(language, "convoy"));
          expect(result.help).toContain(identity.militaryObjective[language]);
          expect(result.help).not.toContain(translate(language, "guideCampaign"));
          expect(result.terminal).toContain(identity.victoryTitle[language]);
          expect(result.terminal).toContain(identity.victorySummary[language]);
          expect(result.terminalLabel).toBe(identity.victoryTitle[language]);
          expect(result.bossLabel).toBe(identity.boss.name[language]);
          expect(result.neutralBoss).toBe(false);
          const wagon = fixture.actors.find((actor) => actor.id === shipment.targetId)!;
          expect(result.movingTarget).toBe(`${requirements.find((item) => item.id === "shipment")!.label[language]}: ${wagon.name![language]}`);
          const scale = (fixture.world.bounds.maxX - fixture.world.bounds.minX) / 140;
          const left = wagon.x + 23 - fixture.world.bounds.minX;
          const top = wagon.z - 17 - fixture.world.bounds.minZ;
          expect(result.movingPosition).toBe(`translate(${left} ${top}) scale(${scale})`);
          expect(result.shipmentTitle).toBe(`${shipment.role[language]}: ${shipment.status[language]}`);
          expect(result.shipmentPosition).toEqual({ x: left - 2 * scale, y: top - 1.4 * scale });
          for (const site of fixture.world.sites) if (site.name) expect(result.siteNames).toContain(site.name[language]);
        } else {
          expect(result.orders).toBeNull();
          expect(result.standings).toBe(0);
          expect(result.legacyMarker).toBe(false);
          expect(result.mapTitle).toBe(translate(language, fixture.objective.key));
          expect(result.help).toContain(translate(language, "guideCampaign"));
          expect(result.terminal).toContain(translate(language, "victoryStory"));
          expect(result.bossLabel).toBe(translate(language, "boss"));
          expect(result.ownConvoyTitle).toBe(translate(language, "convoy.repair"));
        }
      }
    }
    await evaluate(cdp, `localStorage.removeItem(${JSON.stringify(storageKeys.campaign)})`);
    await reload();
  }, 120_000);
});
