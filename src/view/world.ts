import * as THREE from 'three';
import type { Bounds, Obstacle, Vec2, WorldBlueprint, WorldSite } from '../game/types';
import { palette } from './palette';
import { beam, joint, part, shapeGeometry, StaticBatch } from './primitives';
import { seededRandom, ViewResources } from './resources';
import { locationStructure, regionThemes, themeAt, type RegionTheme } from './region-scenery';
import { WorldChunks } from './world-chunks';

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
  if (world.exploration?.locations.some(place => Math.hypot(place.x - point.x, place.z - point.z) < place.radius)) return false;
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
      zenith: { value: new THREE.Color('#61889f') },
      horizon: { value: new THREE.Color(palette.fog) },
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
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
          mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float value = 0.0, amplitude = 0.5;
        for (int i = 0; i < 4; i++) {
          value += noise(p) * amplitude;
          p = p * 2.03 + vec2(13.1, 7.7);
          amplitude *= 0.5;
        }
        return value;
      }
      void main() {
        vec3 direction = normalize(vDirection);
        float elevation = max(0.0, direction.y);
        vec3 color = mix(horizon, zenith, smoothstep(0.0, 0.85, elevation));
        float sunAngle = max(0.0, dot(direction, normalize(vec3(-40.0, 38.0, 32.0))));
        color += vec3(0.45, 0.24, 0.09) * pow(sunAngle, 12.0);
        color += vec3(2.5, 1.9, 1.1) * smoothstep(0.9993, 0.9998, sunAngle);
        vec2 cloudUv = direction.xz / max(0.16, direction.y + 0.16);
        float cloud = smoothstep(0.43, 0.73, fbm(cloudUv * 1.8));
        cloud *= smoothstep(0.035, 0.2, elevation);
        color = mix(color, vec3(0.93, 0.87, 0.73), cloud * 0.8);
        // Distant painted ridgelines are sky, never traversable world geometry.
        float ridge = 0.035 + fbm(direction.xz * 8.0) * 0.15;
        float mountains = 1.0 - smoothstep(ridge - 0.005, ridge + 0.005, direction.y);
        vec3 mountainColor = mix(vec3(0.29, 0.39, 0.44), horizon, 0.56);
        float snow = smoothstep(ridge - 0.025, ridge, direction.y) * step(0.13, ridge);
        mountainColor = mix(mountainColor, vec3(0.72, 0.77, 0.74), snow * 0.5);
        color = mix(color, mountainColor, mountains * smoothstep(-0.08, 0.07, direction.y));
        color = mix(horizon, color, smoothstep(-0.06, 0.035, direction.y));
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  }));
  const sky = new THREE.Mesh(geometry, material);
  sky.name = 'world-sky';
  sky.frustumCulled = false;
  return sky;
}

function makeWater(resources: ViewResources, bounds: Bounds): { mesh: THREE.Mesh; time: { value: number } } {
  const time = { value: 0 };
  const material = resources.ownMaterial('river-water', new THREE.MeshPhysicalMaterial({
    color: '#365f66', roughness: 0.24, metalness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.18,
  }));
  material.customProgramCacheKey = () => 'frontier-water-v2';
  material.onBeforeCompile = shader => {
    shader.uniforms.waterTime = time;
    shader.uniforms.waterBounds = { value: new THREE.Vector4(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ) };
    shader.vertexShader = `varying vec3 vWaterWorld;\n${shader.vertexShader}`.replace('#include <worldpos_vertex>', `
      #include <worldpos_vertex>
      vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
    `);
    shader.fragmentShader = `varying vec3 vWaterWorld;
      uniform float waterTime;
      uniform vec4 waterBounds;\n${shader.fragmentShader}`
      .replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        float wave = sin(vWaterWorld.x * 1.7 + vWaterWorld.z * 0.8 - waterTime * 0.9);
        float ripple = sin(vWaterWorld.z * 3.1 - vWaterWorld.x * 1.3 + waterTime * 1.2);
        normal = normalize(mat3(viewMatrix) * normalize(vec3(wave * 0.075, 1.0, ripple * 0.055)));
      `).replace('#include <clearcoat_normal_fragment_maps>', `
        #include <clearcoat_normal_fragment_maps>
        clearcoatNormal = normal;
      `).replace('#include <color_fragment>', `
        #include <color_fragment>
        float bank = min(min(vWaterWorld.x - waterBounds.x, waterBounds.y - vWaterWorld.x),
                         min(vWaterWorld.z - waterBounds.z, waterBounds.w - vWaterWorld.z));
        float shallows = 1.0 - smoothstep(0.1, 1.5, bank);
        float foam = (1.0 - smoothstep(0.04, 0.32, bank)) *
          smoothstep(0.25, 0.8, sin(vWaterWorld.x * 5.0 + vWaterWorld.z * 3.0 + waterTime));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.34, 0.29), shallows * 0.5);
        diffuseColor.rgb += foam * vec3(0.22, 0.24, 0.19);
      `);
  };
  const mesh = new THREE.Mesh(resources.geometry('water-plane', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), material);
  mesh.receiveShadow = true;
  mesh.position.set((bounds.minX + bounds.maxX) / 2, 0.03, (bounds.minZ + bounds.maxZ) / 2);
  mesh.scale.set(bounds.maxX - bounds.minX, 1, bounds.maxZ - bounds.minZ);
  return { mesh, time };
}

function tree(resources: ViewResources, obstacle: Obstacle, theme?: RegionTheme): THREE.Group {
  const root = new THREE.Group();
  root.position.set(obstacle.x, 0, obstacle.z);
  root.rotation.y = obstacle.variant * 0.7;
  const radius = obstacle.radius;
  const height = obstacle.height;
  const leaves = theme?.foliage ?? [palette.leafDark, palette.leaf, palette.leafLight];
  part(resources, root, 'cone', palette.bark, [0, height * 0.32, 0], [radius * 0.66, height * 0.64, radius * 0.66]);
  part(resources, root, 'rock', palette.moss, [0, 0.09, 0], [radius * 1.98, 0.25, radius * 1.98]);
  for (let branch = 0; branch < 4; branch++) {
    const angle = branch * 2.4;
    beam(resources, root, [Math.sin(angle) * radius * 0.83, 0.04, Math.cos(angle) * radius * 0.83],
      [0, height * 0.13, 0], radius * 0.18, palette.bark);
  }
  if (obstacle.variant % 3 !== 0) {
    for (let tier = 0; tier < 5; tier += 1) {
      const width = radius * (3.1 - tier * 0.46);
      part(resources, root, 'foliage', leaves[Math.min(2, Math.floor(tier / 2))]!,
        [0, height * (0.38 + tier * 0.12), 0], [width * 0.65, height * 0.38, width * 0.65], [0, tier * 0.63, 0.025]);
      for (let spray = 0; spray < 4; spray++) {
        const angle = spray * Math.PI / 2 + tier * 1.7;
        part(resources, root, 'foliage', leaves[tier % 3]!,
          [Math.sin(angle) * width * 0.28, height * (0.3 + tier * 0.12), Math.cos(angle) * width * 0.28],
          [width * 0.61, height * 0.18, width * 0.45], [0, angle, -0.18]);
      }
    }
  } else {
    for (let crown = 0; crown < 8; crown += 1) {
      const angle = crown * 2.4;
      const y = height * (0.58 + (crown % 3) * 0.1);
      const x = Math.sin(angle) * radius * 1.05, z = Math.cos(angle) * radius * 0.9;
      if (crown < 4) beam(resources, root, [0, height * 0.3, 0], [x, y, z], radius * 0.15, palette.bark);
      part(resources, root, 'foliage', leaves[crown % 3]!,
        [x, y, z], [radius * 2, height * 0.38, radius * 1.9], [0.1, angle, 0.12]);
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
  part(resources, root, 'disc', palette.earth, [0, 0.025, 0], [radius * 1.99, 0.05, radius * 1.99]);
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
  if (!masonry && obstacle.variant % 3 === 2) {
    for (let index = 0; index < 7; index += 1) {
      const angle = -Math.PI * 0.72 + index / 6 * Math.PI * 1.44;
      const x = Math.sin(angle) * radius * 0.73;
      const z = Math.cos(angle) * radius * 0.73;
      const stakeHeight = height * (0.52 + (index % 2) * 0.08);
      part(resources, root, 'cylinder', palette.timber, [x, stakeHeight / 2, z], [radius * 0.34, stakeHeight, radius * 0.34]);
      part(resources, root, 'cone', palette.timberLight, [x, stakeHeight + radius * 0.18, z], [radius * 0.34, radius * 0.36, radius * 0.34]);
    }
    part(resources, root, 'box', palette.bark, [0, height * 0.29, radius * 0.67], [radius * 1.32, 0.12, 0.13]);
    part(resources, root, 'box', palette.timberLight, [0, height * 0.13, 0], [radius * 0.7, height * 0.26, radius * 0.8]);
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
    const length = Math.hypot(to.x - from.x, to.z - from.z) + edge.width * 0.5;
    const heading = Math.atan2(to.x - from.x, to.z - from.z);
    const midpoint: [number, number, number] = [(from.x + to.x) / 2, 0.004, (from.z + to.z) / 2];
    batch.add('box', palette.earth, midpoint, [edge.width + 0.32, 0.006, length], [0, heading, 0], false, 'ground');
    batch.add('box', palette.road, [midpoint[0], 0.012, midpoint[2]], [edge.width, 0.006, length], [0, heading, 0], false, 'ground');
    for (const side of [-1, 1]) {
      batch.add('box', '#c6ae81',
        [midpoint[0] + Math.cos(heading) * side * 0.58, 0.017, midpoint[2] - Math.sin(heading) * side * 0.58],
        [0.12, 0.004, length], [0, heading, 0], false, 'ground');
    }
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
  for (const color of new Set([palette.leaf, palette.leafLight, palette.leafDark, ...Object.values(regionThemes).flatMap(theme => theme.foliage)])) {
    const material = resources.material(color, { side: THREE.FrontSide });
    material.customProgramCacheKey = () => 'korovany-foliage-v2';
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
      `).replace('#include <color_fragment>', `
        #include <color_fragment>
        vec3 leafCell = floor(vFoliageWorld * 14.0);
        float leafNoise = fract(sin(dot(leafCell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        diffuseColor.rgb *= 0.8 + leafNoise * 0.35;
      `);
    };
  }
}

function applyGroundGrain(resources: ViewResources): void {
  for (const color of new Set([palette.grass, palette.meadow, palette.road, palette.earth, palette.bank,
    ...Object.values(regionThemes).flatMap(theme => [theme.ground, theme.patches])])) {
    const material = resources.material(color, { side: THREE.FrontSide, surface: 'ground' });
    const groundUv = material.onBeforeCompile;
    material.customProgramCacheKey = () => `korovany-ground-grain-v2:${color === palette.road}`;
    material.onBeforeCompile = (shader, renderer) => {
      groundUv.call(material, shader, renderer);
      shader.vertexShader = `varying vec3 vGrainWorld;\nvarying float vRoadEdge;\n${shader.vertexShader}`.replace('#include <worldpos_vertex>', `
        #include <worldpos_vertex>
        vec4 grainPosition = vec4(transformed, 1.0);
        float roadWidth = 1.0;
        #ifdef USE_INSTANCING
          grainPosition = instanceMatrix * grainPosition;
          roadWidth = length(instanceMatrix[0].xyz);
        #endif
        vGrainWorld = (modelMatrix * grainPosition).xyz;
        vRoadEdge = (0.5 - abs(position.x)) * roadWidth;
      `);
      shader.fragmentShader = `varying vec3 vGrainWorld;\nvarying float vRoadEdge;\n${shader.fragmentShader}`.replace('#include <color_fragment>', `
        #include <color_fragment>
        vec2 grainCell = floor(vGrainWorld.xz * 5.0);
        float grain = fract(sin(dot(grainCell, vec2(12.9898, 78.233))) * 43758.5453);
        float patches = sin(vGrainWorld.x * 0.43 + sin(vGrainWorld.z * 0.23)) * sin(vGrainWorld.z * 0.37);
        diffuseColor.rgb *= 0.94 + grain * 0.06 + patches * 0.09;
        ${color === palette.road ? 'if (vRoadEdge < 0.05 + grain * 0.22) discard;' : ''}
      `);
    };
  }
}

export function createWorldScenery(resources: ViewResources, world: WorldBlueprint): WorldScenery {
  const group = new THREE.Group();
  const structures = new StaticBatch(resources);
  const decoration = new StaticBatch(resources);
  const chunks = world.exploration ? new WorldChunks(resources, 'world-structures') : undefined;
  const detailChunks = world.exploration ? new WorldChunks(resources, 'world-dressing') : undefined;
  const random = seededRandom(worldSeed(world.seed));
  const heroPosition = new THREE.Vector3();
  const flagAnchors = new Map<string, THREE.Vector3>();
  const bounds = world.bounds;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const sky = makeSky(resources);
  const rockGeometry = shapeGeometry(resources, 'rock');
  rockGeometry.computeBoundingBox();
  if (!rockGeometry.boundingBox) throw new Error('Rock geometry has no bounds.');
  const rockGroundOffset = -rockGeometry.boundingBox.min.y;
  group.add(sky);
  structures.add('box', palette.earth, [centerX, -0.84, centerZ], [width, 1.6, depth], [0, 0, 0], false, 'ground');
  structures.add('box', palette.meadow, [centerX, -0.047, centerZ], [width, 0.014, depth], [0, 0, 0], false, 'ground');
  for (const biome of world.exploration?.regions ?? world.biomes) {
    const area = biome.bounds;
    const bx = Math.max(bounds.minX, area.minX);
    const ex = Math.min(bounds.maxX, area.maxX);
    const bz = Math.max(bounds.minZ, area.minZ);
    const ez = Math.min(bounds.maxZ, area.maxZ);
    const color = 'id' in biome ? regionThemes[biome.id]?.ground ?? palette.meadow
      : biome.kind === 'forest' ? palette.grass : biome.kind === 'mountains' ? '#a7aa91' : palette.meadow;
    if (ex > bx && ez > bz) structures.add('box', color, [(bx + ex) / 2, -0.037, (bz + ez) / 2], [ex - bx, 0.006, ez - bz], [0, 0, 0], false, 'ground');
  }
  const river = world.river;
  structures.add('box', palette.bank, [(river.minX + river.maxX) / 2, -0.019, (river.minZ + river.maxZ) / 2],
    [river.maxX - river.minX + 0.55, 0.006, river.maxZ - river.minZ + 0.55], [0, 0, 0], false, 'ground');
  addRoads(world, structures);
  const water = makeWater(resources, river);
  group.add(water.mesh);
  for (const bridge of world.bridges) addBridge(bridge, world, structures);

  for (const obstacle of world.obstacles) {
    const batch = chunks?.at(obstacle) ?? structures;
    const theme = world.exploration ? themeAt(world, obstacle) : undefined;
    if (obstacle.kind === 'tree') {
      batch.append(tree(resources, obstacle, theme));
    } else if (obstacle.kind === 'rock') {
      const scale = obstacle.radius * 1.94;
      batch.add('rock', theme?.stone ?? (obstacle.variant % 2 === 0 ? palette.stone : palette.slateLight),
        [obstacle.x, obstacle.height * rockGroundOffset - 0.035, obstacle.z], [scale, obstacle.height, scale], [0, obstacle.variant * 0.61, 0], true, 'rock');
    } else {
      const place = world.exploration?.locations.find(candidate => obstacle.id.startsWith(`${candidate.id}-building-`));
      if (place && theme) {
        batch.append(locationStructure(resources, obstacle, place, theme));
        continue;
      }
      const site = world.sites.reduce<WorldSite | undefined>((nearest, candidate) => {
        if (!nearest) return candidate;
        return Math.hypot(candidate.x - obstacle.x, candidate.z - obstacle.z) < Math.hypot(nearest.x - obstacle.x, nearest.z - obstacle.z) ? candidate : nearest;
      }, undefined);
      batch.append(structure(resources, obstacle, site));
    }
  }
  for (const site of world.sites) {
    structures.add('zone-ring', site.kind === 'home' ? palette.brass : palette.earth,
      [site.x, 0.022, site.z], [site.radius * 2, 1, site.radius * 2], [0, 0, 0], false);
    const support = world.obstacles.filter((obstacle) => obstacle.kind === 'wall')
      .sort((a, b) => Math.hypot(a.x - site.x, a.z - site.z) - Math.hypot(b.x - site.x, b.z - site.z))[0];
    if (support && Math.hypot(support.x - site.x, support.z - site.z) < site.radius + 12) {
      structures.add('box', palette.bark, [support.x, (support.height + 1.2) / 2, support.z], [0.09, support.height + 1.2, 0.09]);
      flagAnchors.set(site.id, new THREE.Vector3(support.x + 0.46, support.height + 0.8, support.z));
    } else {
      // A floating heraldic marker is presentation, not an invented solid building.
      flagAnchors.set(site.id, new THREE.Vector3(site.x, 3.9, site.z));
    }
  }

  for (let index = 0; index < (world.exploration ? 28000 : 1700); index += 1) {
    const point = { x: bounds.minX + random() * width, z: bounds.minZ + random() * depth };
    if (!isDressingAllowed(world, point)) continue;
    const batch = detailChunks?.at(point) ?? decoration;
    const theme = world.exploration ? themeAt(world, point) : undefined;
    const angle = random() * Math.PI * 2;
    if (index % 6 === 0) {
      const size = 0.12 + random() * 0.18;
      batch.add('rock', theme?.stone ?? palette.stoneLight, [point.x, 0.03, point.z], [size, size * 0.35, size], [0, angle, 0], false);
    } else {
      const height = 0.22 + random() * 0.32;
      const color = theme?.foliage[2] ?? (index % 3 === 0 ? palette.moss : '#969b59');
      batch.add('grass', color, [point.x, 0, point.z], [0.85, height, 0.85], [0, angle, 0], false);
      if (index % 13 === 0) batch.add('sphere', palette.parchment, [point.x, height, point.z], [0.1, 0.075, 0.1], [0, 0, 0], false);
    }
  }
  const narrowRiverX = river.maxX - river.minX < river.maxZ - river.minZ;
  for (let index = 0; index < 150; index += 1) {
    const side = index % 2 === 0 ? -1 : 1;
    const along = random();
    const point = {
      x: narrowRiverX ? (side < 0 ? river.minX - 1.55 : river.maxX + 1.55) : bounds.minX + along * width,
      z: narrowRiverX ? bounds.minZ + along * depth : (side < 0 ? river.minZ - 1.55 : river.maxZ + 1.55),
    };
    if (!isDressingAllowed(world, point)) continue;
    const batch = detailChunks?.at(point) ?? decoration;
    const height = 0.48 + random() * 0.37;
    batch.add('box', palette.moss, [point.x, height / 2, point.z], [0.045, height, 0.045], [0.06, 0, side * 0.1], false);
    batch.add('cylinder', palette.bark, [point.x - side * height * 0.05, height, point.z],
      [0.075, 0.22, 0.075], [0.06, 0, side * 0.1], false);
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
  const staticMeshes = [...structures.finish(group), ...(chunks?.finish(group) ?? [])];
  const foliageGeometry = shapeGeometry(resources, 'foliage');
  const distantFoliage = resources.geometry('distant-foliage', () => new THREE.IcosahedronGeometry(0.5, 0));
  const foliageMeshes = staticMeshes.filter(mesh => mesh.geometry === foliageGeometry);
  let lowQuality = false;
  const updateFoliage = (): void => {
    for (const mesh of foliageMeshes) {
      const center = mesh.boundingSphere?.center;
      const distant = center && Math.hypot(center.x - heroPosition.x, center.z - heroPosition.z) > 95;
      mesh.geometry = lowQuality || distant ? distantFoliage : foliageGeometry;
    }
  };
  const detailGroup = new THREE.Group();
  detailGroup.name = 'world-details';
  group.add(detailGroup);
  const detailMeshes = [...decoration.finish(detailGroup), ...(detailChunks?.finish(detailGroup) ?? [])];
  chunks?.update(heroPosition);
  detailChunks?.update(heroPosition);
  updateFoliage();
  applyFoliageDither(resources, heroPosition);
  applyGroundGrain(resources);

  return {
    group,
    heroPosition,
    flagAnchors,
    update(time, reducedMotion): void {
      water.time.value = reducedMotion ? 0 : time;
      sky.position.set(heroPosition.x, 0, heroPosition.z);
      chunks?.update(heroPosition);
      detailChunks?.update(heroPosition);
    },
    setQuality(low): void {
      detailGroup.visible = !low;
      lowQuality = low;
      updateFoliage();
    },
    dispose(): void {
      for (const mesh of [...staticMeshes, ...detailMeshes]) mesh.dispose();
      group.removeFromParent();
    },
  };
}
