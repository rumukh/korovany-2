import type { GameSnapshot } from "../game";
import { translate } from "./locale";
import type { Language } from "./storage";

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
    for (let iz = Math.max(0, Math.floor(z - 3)); iz <= Math.min(GRID - 1, Math.ceil(z + 3)); iz += 1) {
      for (let ix = Math.max(0, Math.floor(x - 3)); ix <= Math.min(GRID - 1, Math.ceil(x + 3)); ix += 1) {
        if (Math.hypot(ix + 0.5 - x, iz + 0.5 - z) <= 3) this.explored.add(iz * GRID + ix);
      }
    }
  }

  serialize(): ChartSave {
    return { runId: this.runId, explored: [...this.explored] };
  }

  draw(snapshot: GameSnapshot, language: Language, miniature = false): SVGSVGElement {
    const t = (key: string) => translate(language, key);
    const world = snapshot.world;
    const width = world.bounds.maxX - world.bounds.minX;
    const height = world.bounds.maxZ - world.bounds.minZ;
    const x = (value: number) => value - world.bounds.minX;
    const z = (value: number) => value - world.bounds.minZ;
    const root = svg("svg", {
      viewBox: `-7 -7 ${width + 14} ${height + 14}`,
      class: miniature ? "atlas-svg miniature" : "atlas-svg",
      role: "img",
      "aria-label": t("mapLabel"),
    });
    root.append(svg("rect", { x: 0, y: 0, width, height, fill: "#d9d0b5" }));
    for (const biome of world.biomes) {
      root.append(svg("rect", {
        x: x(biome.bounds.minX), y: z(biome.bounds.minZ),
        width: biome.bounds.maxX - biome.bounds.minX,
        height: biome.bounds.maxZ - biome.bounds.minZ,
        fill: biome.kind === "forest" ? "#8c9c7b" : biome.kind === "mountains" ? "#a8a091" : "#c6b98a",
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
        stroke: "#796e52", "stroke-width": miniature ? 1.6 : 1.1,
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
        fill: "none", stroke: "#427b74", "stroke-width": 1.6, "stroke-dasharray": "3 2",
      }));
    }
    for (const site of world.sites) {
      const post = snapshot.outposts.find((item) => item.id === site.id);
      const color = post ? post.supplied ? "#427b74" : post.owner === "player" ? "#9c762f" : "#a14e3d" : "#4d5144";
      const marker = svg(site.kind === "fortress" ? "rect" : "circle", site.kind === "fortress"
        ? { x: x(site.x) - 2.2, y: z(site.z) - 2.2, width: 4.4, height: 4.4, fill: color }
        : { cx: x(site.x), cy: z(site.z), r: 2.2, fill: color });
      const title = svg("title", {});
      title.textContent = t(site.nameKey);
      marker.append(title);
      root.append(marker);
      if (!miniature) {
        const label = svg("text", {
          x: x(site.x), y: z(site.z) - 4, "text-anchor": "middle",
          fill: "#323c31", "font-size": "3.2", "font-family": "Georgia, serif", "font-weight": "bold",
        });
        label.textContent = t(site.nameKey);
        root.append(label);
      }
    }
    root.append(svg("rect", {
      x: x(snapshot.convoy.x) - 1.8, y: z(snapshot.convoy.z) - 1.8,
      width: 3.6, height: 3.6, fill: "#427b74", stroke: "#efe6d2", "stroke-width": 0.8,
    }));
    const player = snapshot.player;
    root.append(svg("path", {
      d: "M0 -3.3 L2.3 2.3 L0 1.1 L-2.3 2.3 Z",
      transform: `translate(${x(player.x)} ${z(player.z)}) rotate(${180 - player.heading * 180 / Math.PI})`,
      fill: "#151e1b", stroke: "#efe6d2", "stroke-width": 0.8,
    }));
    return root;
  }
}
