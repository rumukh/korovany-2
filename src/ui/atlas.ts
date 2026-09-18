import type { GameSnapshot } from "../game";
import { translate } from "./locale";
import type { Language } from "./storage";
import { localText, militaryObjective, questTarget, worldTarget } from "./story";

const NS = "http://www.w3.org/2000/svg";
const GRID = 28;
export interface ChartSave {
  runId: string;
  explored: number[];
}

export function parseChart(value: unknown): ChartSave | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data.runId !== "string" || !Array.isArray(data.explored) ||
    data.explored.length > GRID * GRID ||
    !data.explored.every((cell) => Number.isInteger(cell) && cell >= 0 && cell < GRID * GRID)) return null;
  return { runId: data.runId, explored: data.explored };
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

export class Atlas {
  private runId = "";
  private readonly explored = new Set<number>();

  restore(chart: ChartSave): void {
    this.runId = chart.runId;
    this.explored.clear();
    chart.explored.forEach((cell) => this.explored.add(cell));
  }

  observe(snapshot: GameSnapshot): void {
    if (snapshot.runId !== this.runId) {
      this.runId = snapshot.runId;
      this.explored.clear();
    }
    const { bounds } = snapshot.world;
    const x = (snapshot.player.x - bounds.minX) / (bounds.maxX - bounds.minX) * GRID;
    const z = (snapshot.player.z - bounds.minZ) / (bounds.maxZ - bounds.minZ) * GRID;
    const radius = Math.max(1, 22 / (bounds.maxX - bounds.minX) * GRID);
    for (let iz = Math.max(0, Math.floor(z - radius)); iz <= Math.min(GRID - 1, Math.ceil(z + radius)); iz += 1) {
      for (let ix = Math.max(0, Math.floor(x - radius)); ix <= Math.min(GRID - 1, Math.ceil(x + radius)); ix += 1) {
        if (Math.hypot(ix + 0.5 - x, iz + 0.5 - z) <= radius) this.explored.add(iz * GRID + ix);
      }
    }
  }

  serialize(): ChartSave {
    return { runId: this.runId, explored: [...this.explored] };
  }

  draw(snapshot: GameSnapshot, language: Language, miniature = false, local = false): SVGSVGElement {
    const t = (key: string) => translate(language, key);
    const world = snapshot.world;
    const width = world.bounds.maxX - world.bounds.minX;
    const height = world.bounds.maxZ - world.bounds.minZ;
    const x = (value: number) => value - world.bounds.minX;
    const z = (value: number) => value - world.bounds.minZ;
    const span = Math.min(width, miniature ? 140 : local ? 220 : width);
    const scale = span / 140;
    const left = Math.max(0, Math.min(width - span, x(snapshot.player.x) - span / 2));
    const top = Math.max(0, Math.min(height - span, z(snapshot.player.z) - span / 2));
    const root = svg("svg", {
      viewBox: `${left - 7 * scale} ${top - 7 * scale} ${span + 14 * scale} ${span + 14 * scale}`,
      class: miniature ? "atlas-svg miniature" : "atlas-svg",
      role: "img",
      "aria-label": t("mapLabel"),
    });
    const label = (name: string, px: number, pz: number, color = "#323c31", size = 3.2): SVGTextElement => {
      const text = svg("text", { x: px, y: pz, "text-anchor": "middle", fill: color,
        "font-size": size * scale, "font-family": "Georgia, serif", "font-weight": "bold",
        "paint-order": "stroke", stroke: "#e6dcc6", "stroke-width": 0.6 * scale });
      text.textContent = name;
      root.append(text);
      return text;
    };
    root.append(svg("rect", { x: 0, y: 0, width, height, fill: "#d9d0b5" }));
    const regions = world.exploration?.regions.map((region) => ({ bounds: region.bounds, kind: region.biome })) ?? world.biomes;
    const colors = { forest: "#8c9c7b", countryside: "#c6b98a", mountains: "#a8a091",
      marsh: "#8caaa0", waste: "#b49c85", coast: "#acc0bb" };
    for (const biome of regions) {
      root.append(svg("rect", {
        x: x(biome.bounds.minX), y: z(biome.bounds.minZ),
        width: biome.bounds.maxX - biome.bounds.minX,
        height: biome.bounds.maxZ - biome.bounds.minZ,
        fill: colors[biome.kind],
        opacity: 0.45,
      }));
    }
    const river = world.river;
    root.append(svg("rect", {
      x: x(river.minX), y: z(river.minZ), width: river.maxX - river.minX,
      height: river.maxZ - river.minZ, fill: "#658f88",
    }));
    for (const edge of world.roads.edges) {
      const from = world.roads.nodes.find((node) => node.id === edge.from);
      const to = world.roads.nodes.find((node) => node.id === edge.to);
      if (from && to) root.append(svg("line", {
        x1: x(from.x), y1: z(from.z), x2: x(to.x), y2: z(to.z),
        stroke: "#796e52", "stroke-width": (miniature ? 1.6 : 0.8) * scale,
        "stroke-linecap": "round",
      }));
    }
    for (const bridge of world.bridges) root.append(svg("rect", {
      x: x(bridge.minX), y: z(bridge.minZ), width: bridge.maxX - bridge.minX,
      height: bridge.maxZ - bridge.minZ, fill: "#b59a67", stroke: "#756447", "stroke-width": 0.6,
    }));
    const fog = svg("g", { fill: "#efe6d2", opacity: 0.51 });
    for (let cell = 0; cell < GRID * GRID; cell += 1) {
      if (!this.explored.has(cell)) fog.append(svg("rect", {
        x: (cell % GRID) * width / GRID, y: Math.floor(cell / GRID) * height / GRID,
        width: width / GRID + 0.05, height: height / GRID + 0.05,
      }));
    }
    root.append(fog);
    if (snapshot.convoy.route.length) {
      root.append(svg("polyline", {
        points: [snapshot.convoy, ...snapshot.convoy.route].map((point) => `${x(point.x)},${z(point.z)}`).join(" "),
        fill: "none", stroke: "#427b74", "stroke-width": 1.6 * scale, "stroke-dasharray": `${3 * scale} ${2 * scale}`,
      }));
    }
    if (!miniature && !local) {
      for (const region of world.exploration?.regions ?? []) {
        label(localText(region.name, language).toLocaleUpperCase(language),
          x((region.bounds.minX + region.bounds.maxX) / 2), z(region.bounds.minZ + 20), "#685f4c", 2.2);
        const political = snapshot.campaign?.standing.find((standing) => standing.id === region.politicalFaction);
        if (political) {
          const affiliation = label(localText(political.name, language),
            x((region.bounds.minX + region.bounds.maxX) / 2), z(region.bounds.minZ + 20) + 3.5 * scale, "#685f4c", 1.6);
          affiliation.setAttribute("data-region-faction", political.id);
          affiliation.setAttribute("data-region", region.id);
        }
      }
    }
    const tracked = snapshot.narrative?.quests.find((quest) => quest.id === snapshot.narrative?.trackedQuestId);
    const target = questTarget(snapshot, tracked, language);
    const military = snapshot.campaign ? worldTarget(snapshot, snapshot.objective.targetId, language) : null;
    for (const place of world.exploration?.locations ?? []) {
      const discovered = snapshot.narrative?.discovered.includes(place.id);
      const targeted = target && Math.hypot(target.x - place.x, target.z - place.z) < place.radius;
      const marker = svg("circle", { cx: x(place.x), cy: z(place.z), r: (discovered ? 1.5 : 1.1) * scale,
        fill: discovered ? "#426c64" : "#cabea0", stroke: "#71654d", "stroke-width": 0.5 * scale,
        "data-location": place.id, "data-discovered": String(Boolean(discovered)) });
      const title = svg("title", {});
      title.textContent = discovered ? `${localText(place.name, language)}: ${localText(place.description, language)}`
        : targeted ? localText(place.name, language) : t("unexplored");
      marker.append(title);
      root.append(marker);
      if (!miniature && (discovered || targeted)) label(localText(place.name, language), x(place.x), z(place.z) - 3 * scale);
    }
    for (const site of world.sites) {
      const post = snapshot.outposts.find((item) => item.id === site.id);
      const color = post ? post.supplied ? "#427b74" : post.owner === "player" ? "#9c762f" : "#a14e3d" : "#4d5144";
      const marker = svg(site.kind === "fortress" ? "rect" : "circle", site.kind === "fortress"
        ? { x: x(site.x) - 1.5 * scale, y: z(site.z) - 1.5 * scale, width: 3 * scale, height: 3 * scale, fill: color }
        : { cx: x(site.x), cy: z(site.z), r: 1.5 * scale, fill: color });
      const title = svg("title", {});
      const name = site.name ? localText(site.name, language) : t(site.nameKey);
      title.textContent = name;
      marker.append(title);
      root.append(marker);
      const namedSettlement = world.exploration?.locations.some((place) =>
        snapshot.narrative?.discovered.includes(place.id) && Math.hypot(place.x - site.x, place.z - site.z) < 8);
      if (!miniature && !namedSettlement && (local || width <= 200)) label(name, x(site.x), z(site.z) - 4 * scale);
    }
    for (const npc of snapshot.narrative?.npcs ?? []) {
      if (Math.hypot(npc.x - snapshot.player.x, npc.z - snapshot.player.z) > 38) continue;
      const marker = svg("circle", { cx: x(npc.x), cy: z(npc.z), r: 0.85 * scale,
        fill: npc.questAvailable ? "#dba935" : "#398080", stroke: "#efe6d2", "stroke-width": 0.3 * scale, "data-npc": npc.id });
      const title = svg("title", {});
      title.textContent = localText(npc.name, language);
      marker.append(title);
      root.append(marker);
    }
    const mission = snapshot.campaign?.shipment;
    const shipment = mission && snapshot.actors.find((actor) => actor.id === mission.targetId);
    if (shipment && mission) {
      const marker = svg("rect", {
        x: x(shipment.x) - 2 * scale, y: z(shipment.z) - 1.4 * scale, width: 4 * scale, height: 2.8 * scale,
        fill: shipment.allegiance === "hostile" ? "#a14e3d" : shipment.allegiance === "friendly" ? "#427b74" : "#80785f",
        stroke: "#efe6d2", "stroke-width": 0.7 * scale, "data-shipment": shipment.id,
      });
      const title = svg("title", {});
      title.textContent = `${localText(mission.role, language)}: ${localText(mission.status, language)}`;
      marker.append(title);
      root.append(marker);
      if (!miniature && local && shipment.name) label(localText(shipment.name, language), x(shipment.x), z(shipment.z) - 4 * scale);
    }
    if (target) {
      const px = Math.max(left + 4 * scale, Math.min(left + span - 4 * scale, x(target.x)));
      const pz = Math.max(top + 4 * scale, Math.min(top + span - 4 * scale, z(target.z)));
      const marker = svg("g", { "data-quest-target": tracked?.id ?? "", transform: `translate(${px} ${pz}) scale(${scale})` });
      marker.append(svg("circle", { r: 3.4, fill: "none", stroke: "#a36a17", "stroke-width": 0.9 }),
        svg("path", { d: "M0 -2 L1.5 0 L0 2 L-1.5 0 Z", fill: "#b87c22" }));
      const title = svg("title", {});
      title.textContent = tracked ? localText(tracked.objective, language) : "";
      marker.append(title);
      root.append(marker);
    }
    if (military) {
      const px = Math.max(left + 4 * scale, Math.min(left + span - 4 * scale, x(military.x)));
      const pz = Math.max(top + 4 * scale, Math.min(top + span - 4 * scale, z(military.z)));
      const marker = svg("g", { "data-military-target": snapshot.objective.targetId ?? "",
        transform: `translate(${px} ${pz}) scale(${scale})` });
      marker.append(svg("rect", { x: -3.8, y: -3.8, width: 7.6, height: 7.6,
        fill: "none", stroke: "#874b37", "stroke-width": 0.9 }));
      const title = svg("title", {});
      title.textContent = `${militaryObjective(snapshot, language)}: ${military.name}`;
      marker.append(title);
      root.append(marker);
    }
    root.append(svg("rect", {
      x: x(snapshot.convoy.x) - 1.8 * scale, y: z(snapshot.convoy.z) - 1.8 * scale,
      width: 3.6 * scale, height: 3.6 * scale, fill: "#427b74", stroke: "#efe6d2", "stroke-width": 0.8 * scale,
    }));
    const player = snapshot.player;
    root.append(svg("path", {
      d: "M0 -3.3 L2.3 2.3 L0 1.1 L-2.3 2.3 Z",
      transform: `translate(${x(player.x)} ${z(player.z)}) rotate(${180 - player.heading * 180 / Math.PI}) scale(${scale})`,
      fill: "#151e1b", stroke: "#efe6d2", "stroke-width": 0.8,
    }));
    if (!miniature) label(`${Math.round(span)} ${t("story.metres")}`, left + span / 2, top + span + 5 * scale, "#685f4c", 2.3);
    return root;
  }
}
