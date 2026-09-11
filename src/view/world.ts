import * as THREE from 'three';
import type { Bounds, Obstacle, Vec2, WorldBlueprint, WorldSite } from '../game/types';
import { palette } from './palette';
import { beam, joint, part, StaticBatch } from './primitives';
import { seededRandom, ViewResources } from './resources';

export interface WorldScenery {
  group: THREE.Group;
  heroPosition: THREE.Vector3;
  flagAnchors: Map<string, THREE.Vector3>;
  update(time: number, reducedMotion: boolean): void;
  setQuality(low: boolean): void;
  dispose(): void;
}

export function distanceToSegment(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : THREE.MathUtils.clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared, 0, 1);
  return Math.hypot(point.x - start.x - dx * t, point.z - start.z - dz * t);
}

export function insideBounds(point: Vec2, bounds: Bounds, margin = 0): boolean {
  return point.x >= bounds.minX - margin && point.x <= bounds.maxX + margin
    && point.z >= bounds.minZ - margin && point.z <= bounds.maxZ + margin;
}

/** Decorative tufts and pebbles never obscure a road, approach, water or blocker. */
export function isDressingAllowed(world: WorldBlueprint, point: Vec2): boolean {
  if (!insideBounds(point, world.bounds, -1) || insideBounds(point, world.river, 1.4)) return false;
  if (world.sites.some((site) => Math.hypot(site.x - point.x, site.z - point.z) < site.radius + 1)) return false;
  if (world.obstacles.some((obstacle) => Math.hypot(obstacle.x - point.x, obstacle.z - point.z) < obstacle.radius + 0.5)) return false;
  for (const edge of world.roads.edges) {
    const start = world.roads.nodes.find((node) => node.id === edge.from);
    const end = world.roads.nodes.find((node) => node.id === edge.to);
    if (!start || !end) throw new Error(`Road edge references an unknown node: ${edge.from} -> ${edge.to}`);
    if (distanceToSegment(point, start, end) < edge.width * 0.5 + 1.1) return false;
  }
  return true;
}

function worldSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function makeSky(resources: ViewResources): THREE.Mesh {
  const geometry = resources.geometry('sky', () => new THREE.SphereGeometry(240, 24, 12));
  const material = resources.ownMaterial('sky', new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: { value: new THREE.Color('#6eabb5') },
      horizon: { value: new THREE.Color('#e7d9ac') },
    },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 zenith;
      uniform vec3 horizon;
      varying vec3 vDirection;
      void main() {
        vec3 direction = normalize(vDirection);
        float elevation = max(0.0, direction.y);
        vec3 color = mix(horizon, zenith, smoothstep(0.0, 0.85, elevation));
        float sun = pow(max(0.0, dot(direction, normalize(vec3(-0.6, 0.7, 0.35)))), 34.0);
        color += vec3(0.12, 0.09, 0.035) * sun;
        float cloud = sin(direction.x * 33.0 + direction.z * 17.0 + direction.y * 63.0);
        cloud = smoothstep(0.93, 1.0, cloud) * smoothstep(0.14, 0.23, elevation) * (1.0 - smoothstep(0.45, 0.65, elevation));
        color = mix(color, horizon, cloud * 0.28);
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  }));
  return new THREE.Mesh(geometry, material);
}

function makeWater(resources: ViewResources, bounds: Bounds): { mesh: THREE.Mesh; time: { value: number } } {
  const time = { value: 0 };
  const material = resources.ownMaterial('river-water', new THREE.ShaderMaterial({
    uniforms: {
      time,
      deep: { value: new THREE.Color(palette.water) },
      light: { value: new THREE.Color(palette.waterLight) },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      varying vec3 vWorld;
      uniform float time;
      uniform vec3 deep;
      uniform vec3 light;
      void main() {
        float wave = sin(vWorld.x * 2.8 + sin(vWorld.z * 0.52) * 1.6 - time * 1.1);
        float streak = smoothstep(0.93, 1.0, wave) * (0.3 + 0.7 * sin(vWorld.z * 0.48 + vWorld.x * 0.08) * sin(vWorld.z * 0.48 + vWorld.x * 0.08));
        vec3 color = mix(deep, light, streak * 0.52 + 0.12 * sin(vWorld.z * 0.15));
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  }));
  const mesh = new THREE.Mesh(resources.geometry('water-plane', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), material);
  mesh.position.set((bounds.minX + bounds.maxX) / 2, 0.03, (bounds.minZ + bounds.maxZ) / 2);
  mesh.scale.set(bounds.maxX - bounds.minX, 1, bounds.maxZ - bounds.minZ);
  return { mesh, time };
}

function tree(resources: ViewResources, obstacle: Obstacle): THREE.Group {
  const root = new THREE.Group();
  root.position.set(obstacle.x, 0, obstacle.z);
  root.rotation.y = obstacle.variant * 0.7;
  const radius = obstacle.radius;
  const height = obstacle.height;
  part(resources, root, 'cone', palette.bark, [0, height * 0.27, 0], [radius * 1.45, height * 0.55, radius * 1.45]);
  part(resources, root, 'rock', palette.moss, [0, 0.09, 0], [radius * 1.98, 0.25, radius * 1.98]);
  if (obstacle.variant % 3 !== 0) {
    for (let tier = 0; tier < 3; tier += 1) {
      const width = radius * (3.05 - tier * 0.69);
      part(resources, root, 'cone', tier === 0 ? palette.leafDark : tier === 1 ? palette.leaf : palette.leafLight,
        [0, height * (0.43 + tier * 0.19), 0], [width, height * 0.48, width], [0, tier * 0.35, 0]);
    }
  } else {
    beam(resources, root, [0, height * 0.33, 0], [radius * 0.7, height * 0.64, 0], radius * 0.25, palette.bark);
    for (let crown = 0; crown < 3; crown += 1) {
      const angle = crown * Math.PI * 2 / 3;
      part(resources, root, 'rock', crown === 0 ? palette.leafLight : palette.leaf,
        [Math.sin(angle) * radius * 0.75, height * (0.64 + crown * 0.04), Math.cos(angle) * radius * 0.6],
        [radius * 2.6, height * 0.6, radius * 2.4], [0.1, angle, 0.12]);
    }
  }
  return root;
}

function structure(resources: ViewResources, obstacle: Obstacle, site: WorldSite | undefined): THREE.Group {
  const root = new THREE.Group();
  root.position.set(obstacle.x, 0, obstacle.z);
  const radius = obstacle.radius;
  const height = obstacle.height;
  const fortress = site?.kind === 'fortress';
  const palace = site?.faction === 'guard';
  const masonry = fortress || palace;
  const base = masonry ? palette.stone : palette.timber;
  const roof = fortress ? palette.slate : palace ? palette.slateLight : palette.moss;
  root.rotation.y = obstacle.variant % 4 * Math.PI / 2;
  if (!fortress && !palace && obstacle.variant % 3 === 1) {
    part(resources, root, 'box', palette.timber, [0, 0.2, 0], [radius * 1.3, 0.4, radius * 1.3]);
    const geometry = resources.geometry('tent', () => {
      const shape = new THREE.ConeGeometry(1, 1, 4);
      shape.rotateY(Math.PI / 4);
      return shape;
    });
    const tent = new THREE.Mesh(geometry, resources.material(palette.parchment));
    tent.position.y = height * 0.43;
    tent.scale.set(radius * 0.95, height * 0.85, radius * 0.95);
    tent.castShadow = true;
    tent.receiveShadow = true;
    root.add(tent);
    part(resources, root, 'box', palette.bark, [0, height * 0.23, radius * 0.62], [radius * 0.34, height * 0.45, 0.035]);
    part(resources, root, 'box', palette.brass, [0, height * 0.45, 0], [0.08, height * 0.95, 0.08]);
    return root;
  }

  if (masonry) {
    part(resources, root, 'cylinder', base, [0, height * 0.33, 0], [radius * 1.92, height * 0.66, radius * 1.92]);
    part(resources, root, 'cylinder', palette.stoneLight, [0, 0.15, 0], [radius * 1.98, 0.3, radius * 1.98]);
    part(resources, root, 'cylinder', palette.stoneLight, [0, height * 0.65, 0], [radius * 1.97, height * 0.07, radius * 1.97]);
    if (obstacle.variant % 3 === 2) {
      for (let index = 0; index < 8; index += 1) {
        const angle = index * Math.PI / 4;
        part(resources, root, 'box', palette.stoneLight,
          [Math.sin(angle) * radius * 0.79, height * 0.77, Math.cos(angle) * radius * 0.79],
          [radius * 0.31, height * 0.2, radius * 0.31], [0, angle, 0]);
      }
    } else {
      part(resources, root, 'cone', roof, [0, height * 0.83, 0], [radius * 1.98, height * 0.36, radius * 1.98]);
      part(resources, root, 'cone', palette.brass, [0, height * 1.025, 0], [0.17, height * 0.1, 0.17]);
    }
    for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      const wall = joint(root, [Math.sin(angle) * radius * 0.9, height * 0.44, Math.cos(angle) * radius * 0.9]);
      wall.rotation.y = angle;
      part(resources, wall, 'box', palette.iron, [0, 0, 0], [radius * 0.18, height * 0.21, 0.03]);
      part(resources, wall, 'box', palette.stoneLight, [0, -height * 0.11, 0.025], [radius * 0.3, 0.08, 0.1]);
    }
  } else {
    const half = radius * 0.53;
    for (const x of [-half, half]) {
      for (const z of [-half, half]) {
        part(resources, root, 'box', palette.bark, [x, height * 0.31, z], [radius * 0.2, height * 0.63, radius * 0.2]);
      }
      beam(resources, root, [x, 0.15, -half], [x, height * 0.57, half], radius * 0.13, palette.timberLight);
      beam(resources, root, [x, 0.15, half], [x, height * 0.57, -half], radius * 0.13, palette.timberLight);
    }
    part(resources, root, 'box', palette.timber, [0, height * 0.55, 0], [radius * 1.4, 0.15, radius * 1.4]);
    part(resources, root, 'box', palette.timberLight, [0, height * 0.66, 0], [radius * 1.35, height * 0.18, radius * 1.35]);
    part(resources, root, 'cone', roof, [0, height * 0.86, 0], [radius * 1.98, height * 0.32, radius * 1.98]);
    part(resources, root, 'box', palette.iron, [0, height * 0.72, radius * 0.68], [radius * 0.77, height * 0.08, 0.025]);
  }
  return root;
}

function addRoads(world: WorldBlueprint, batch: StaticBatch): void {
  for (const edge of world.roads.edges) {
    const from = world.roads.nodes.find((node) => node.id === edge.from);
    const to = world.roads.nodes.find((node) => node.id === edge.to);
    if (!from || !to) throw new Error(`Road edge references an unknown node: ${edge.from} -> ${edge.to}`);
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const heading = Math.atan2(to.x - from.x, to.z - from.z);
    const midpoint: [number, number, number] = [(from.x + to.x) / 2, 0.004, (from.z + to.z) / 2];
    batch.add('box', palette.earth, midpoint, [edge.width + 0.32, 0.006, length], [0, heading, 0], false);
    batch.add('box', palette.road, [midpoint[0], 0.012, midpoint[2]], [edge.width, 0.006, length], [0, heading, 0], false);
    for (const side of [-1, 1]) {
      batch.add('box', '#c6ae81',
        [midpoint[0] + Math.cos(heading) * side * 0.58, 0.017, midpoint[2] - Math.sin(heading) * side * 0.58],
        [0.055, 0.004, length], [0, heading, 0], false);
    }
  }
  for (const node of world.roads.nodes) {
    const edges = world.roads.edges.filter((edge) => edge.from === node.id || edge.to === node.id);
    const width = Math.max(0, ...edges.map((edge) => edge.width));
    if (width > 0) batch.add('disc', palette.road, [node.x, 0.015, node.z], [width, 0.006, width], [0, 0, 0], false);
  }
}

function addBridge(bridge: Bounds, world: WorldBlueprint, batch: StaticBatch): void {
  const width = bridge.maxX - bridge.minX;
  const depth = bridge.maxZ - bridge.minZ;
  const centerX = (bridge.minX + bridge.maxX) / 2;
  const centerZ = (bridge.minZ + bridge.maxZ) / 2;
  const crossX = world.river.maxX - world.river.minX < world.river.maxZ - world.river.minZ;
  batch.add('box', palette.bark, [centerX, 0.046, centerZ], [width, 0.045, depth]);
  const length = crossX ? width : depth;
  const planks = Math.ceil(length / 0.46);
  for (let index = 0; index < planks; index += 1) {
    const along = -length / 2 + (index + 0.5) * length / planks;
    batch.add('box', index % 3 === 0 ? palette.timberLight : palette.timber,
      [centerX + (crossX ? along : 0), 0.076, centerZ + (crossX ? 0 : along)],
      [crossX ? length / planks - 0.022 : width, 0.025, crossX ? depth : length / planks - 0.022]);
  }
  // Rails stand over solid water just outside the exact walkable rectangle.
  const railStart = crossX ? Math.max(bridge.minX, world.river.minX) : Math.max(bridge.minZ, world.river.minZ);
  const railEnd = crossX ? Math.min(bridge.maxX, world.river.maxX) : Math.min(bridge.maxZ, world.river.maxZ);
  const railLength = railEnd - railStart;
  const railCenter = (railStart + railEnd) / 2;
  for (const side of [-1, 1]) {
    const across = side * ((crossX ? depth : width) / 2 + 0.08);
    batch.add('box', palette.bark,
      [crossX ? railCenter : centerX + across, 0.68, crossX ? centerZ + across : railCenter],
      [crossX ? railLength : 0.1, 0.1, crossX ? 0.1 : railLength]);
    const posts = Math.max(1, Math.ceil(railLength / 2.5));
    for (let index = 0; index <= posts; index += 1) {
      const along = railStart + 0.08 + index * Math.max(0, railLength - 0.16) / posts;
      batch.add('box', palette.timberLight,
        [crossX ? along : centerX + across, 0.44, crossX ? centerZ + across : along],
        [0.14, 0.88, 0.14]);
    }
  }
}

function applyFoliageDither(resources: ViewResources, hero: THREE.Vector3): void {
  for (const color of [palette.leaf, palette.leafLight, palette.leafDark]) {
    const material = resources.material(color, { side: THREE.FrontSide });
    material.customProgramCacheKey = () => 'korovany-foliage-v1';
    material.onBeforeCompile = (shader) => {
      shader.uniforms.heroPosition = { value: hero };
      shader.vertexShader = `varying vec3 vFoliageWorld;\n${shader.vertexShader}`.replace('#include <worldpos_vertex>', `
        #include <worldpos_vertex>
        vec4 foliagePosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          foliagePosition = instanceMatrix * foliagePosition;
        #endif
        vFoliageWorld = (modelMatrix * foliagePosition).xyz;
      `);
      shader.fragmentShader = `uniform vec3 heroPosition;\nvarying vec3 vFoliageWorld;\n${shader.fragmentShader}`.replace('#include <alphatest_fragment>', `
        #include <alphatest_fragment>
        vec3 sightline = heroPosition - cameraPosition;
        float alongSight = dot(vFoliageWorld - cameraPosition, sightline) / max(0.001, dot(sightline, sightline));
        float distanceToSight = length(vFoliageWorld - (cameraPosition + sightline * alongSight));
        float cutaway = (1.0 - smoothstep(1.2, 2.5, distanceToSight)) * step(0.0, alongSight) * (1.0 - step(1.03, alongSight));
        float pattern = fract(dot(floor(gl_FragCoord.xy), vec2(0.75487766, 0.56984029)));
        if (pattern < cutaway * 0.92) discard;
      `);
    };
  }
}

export function createWorldScenery(resources: ViewResources, world: WorldBlueprint): WorldScenery {
  const group = new THREE.Group();
  const structures = new StaticBatch(resources);
  const decoration = new StaticBatch(resources);
  const random = seededRandom(worldSeed(world.seed));
  const heroPosition = new THREE.Vector3();
  const flagAnchors = new Map<string, THREE.Vector3>();
  const bounds = world.bounds;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  group.add(makeSky(resources));
  structures.add('box', palette.earth, [centerX, -0.84, centerZ], [width, 1.6, depth]);
  structures.add('box', palette.meadow, [centerX, -0.047, centerZ], [width, 0.014, depth], [0, 0, 0], false);
  for (const biome of world.biomes) {
    const area = biome.bounds;
    const bx = Math.max(bounds.minX, area.minX);
    const ex = Math.min(bounds.maxX, area.maxX);
    const bz = Math.max(bounds.minZ, area.minZ);
    const ez = Math.min(bounds.maxZ, area.maxZ);
    const color = biome.kind === 'forest' ? palette.grass : biome.kind === 'mountains' ? '#a7aa91' : palette.meadow;
    if (ex > bx && ez > bz) structures.add('box', color, [(bx + ex) / 2, -0.037, (bz + ez) / 2], [ex - bx, 0.006, ez - bz], [0, 0, 0], false);
  }
  const river = world.river;
  structures.add('box', palette.bank, [(river.minX + river.maxX) / 2, -0.019, (river.minZ + river.maxZ) / 2],
    [river.maxX - river.minX + 0.55, 0.006, river.maxZ - river.minZ + 0.55], [0, 0, 0], false);
  addRoads(world, structures);
  const water = makeWater(resources, river);
  group.add(water.mesh);
  for (const bridge of world.bridges) addBridge(bridge, world, structures);

  for (const obstacle of world.obstacles) {
    if (obstacle.kind === 'tree') {
      structures.append(tree(resources, obstacle));
    } else if (obstacle.kind === 'rock') {
      const scale = obstacle.radius * 1.94;
      structures.add('rock', obstacle.variant % 2 === 0 ? palette.stone : palette.slateLight,
        [obstacle.x, obstacle.height * 0.42, obstacle.z], [scale, obstacle.height, scale], [0, obstacle.variant * 0.61, 0]);
      structures.add('rock', palette.moss, [obstacle.x, 0.04, obstacle.z], [obstacle.radius * 1.99, 0.12, obstacle.radius * 1.99], [0, obstacle.variant * 0.61, 0]);
    } else {
      const site = world.sites.reduce<WorldSite | undefined>((nearest, candidate) => {
        if (!nearest) return candidate;
        return Math.hypot(candidate.x - obstacle.x, candidate.z - obstacle.z) < Math.hypot(nearest.x - obstacle.x, nearest.z - obstacle.z) ? candidate : nearest;
      }, undefined);
      structures.append(structure(resources, obstacle, site));
    }
  }
  for (const site of world.sites) {
    structures.add('ring', site.kind === 'home' ? palette.brass : palette.earth,
      [site.x, 0.022, site.z], [site.radius * 2, 1, site.radius * 2], [0, 0, 0], false);
    const support = world.obstacles.filter((obstacle) => obstacle.kind === 'wall')
      .sort((a, b) => Math.hypot(a.x - site.x, a.z - site.z) - Math.hypot(b.x - site.x, b.z - site.z))[0];
    if (support && Math.hypot(support.x - site.x, support.z - site.z) < site.radius + 12) {
      structures.add('box', palette.bark, [support.x, support.height + 0.45, support.z], [0.09, 1.5, 0.09]);
      flagAnchors.set(site.id, new THREE.Vector3(support.x + 0.46, support.height + 0.8, support.z));
    } else {
      // A floating heraldic marker is presentation, not an invented solid building.
      flagAnchors.set(site.id, new THREE.Vector3(site.x, 3.9, site.z));
    }
  }

  for (let index = 0; index < 1300; index += 1) {
    const point = { x: bounds.minX + random() * width, z: bounds.minZ + random() * depth };
    if (!isDressingAllowed(world, point)) continue;
    const angle = random() * Math.PI * 2;
    if (index % 6 === 0) {
      const size = 0.12 + random() * 0.18;
      decoration.add('rock', palette.stoneLight, [point.x, 0.03, point.z], [size, size * 0.35, size], [0, angle, 0], false);
    } else {
      const height = 0.15 + random() * 0.28;
      const color = index % 3 === 0 ? palette.moss : '#969b59';
      decoration.add('cone', color, [point.x, height / 2, point.z], [0.095, height, 0.095], [0.14, angle, 0.2], false);
      decoration.add('cone', color, [point.x + 0.12, height * 0.43, point.z], [0.07, height * 0.85, 0.07], [-0.25, angle, -0.24], false);
      if (index % 13 === 0) decoration.add('sphere', palette.parchment, [point.x, height, point.z], [0.1, 0.075, 0.1], [0, 0, 0], false);
    }
  }
  // The horizon is outside authoritative world bounds, never a false obstacle in a lane.
  for (let index = 0; index < 34; index += 1) {
    const angle = index / 34 * Math.PI * 2;
    const distance = (Math.max(width, depth) / 2 + 24 + random() * 15) / Math.max(Math.abs(Math.sin(angle)), Math.abs(Math.cos(angle)));
    const height = 13 + random() * 19;
    const x = centerX + Math.sin(angle) * distance;
    const z = centerZ + Math.cos(angle) * distance;
    structures.add('cone', index % 2 === 0 ? '#7f9d9b' : '#91aaa2',
      [x, height * 0.3 - 3, z], [21 + random() * 12, height, 20 + random() * 10], [0, angle, 0], false);
    if (index % 3 === 0) structures.add('cone', '#cad2bb', [x, height * 0.61 - 3, z], [7.5, height * 0.37, 7], [0, angle, 0], false);
  }
  const staticMeshes = structures.finish(group);
  const detailGroup = new THREE.Group();
  group.add(detailGroup);
  const detailMeshes = decoration.finish(detailGroup);
  applyFoliageDither(resources, heroPosition);

  return {
    group,
    heroPosition,
    flagAnchors,
    update(time, reducedMotion): void {
      water.time.value = reducedMotion ? 0 : time;
    },
    setQuality(low): void {
      detailGroup.visible = !low;
    },
    dispose(): void {
      for (const mesh of [...staticMeshes, ...detailMeshes]) mesh.dispose();
      group.removeFromParent();
    },
  };
}
