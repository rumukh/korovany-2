import * as THREE from 'three';
import type { Bounds, Vec2, WorldBlueprint, WorldLake } from '../game/types';
import { lakeClearance } from '../game/world';
import type { ViewResources } from './resources';
import { SEA_REACH } from './terrain-mesh';

/**
 * Water for version 3 worlds: the river, every lake and the sea in one mesh and one material (one draw, one program).
 * Each vertex carries its water's tint and `water` = (shore band 0..1, wave strength): the river runs peat-dark between
 * its banks, meres are peat-brown, forest pools black, tarns cold slate, steppe pools a bitter grey-green and the sea a
 * grey swell breaking on its shingle. `band` is the width in metres of each water's shallow band.
 */
export const WATER_TINTS = {
  river: { colour: '#2f3d37', band: 2.5, wave: 0.45 },
  mere: { colour: '#2c3326', band: 3, wave: 0.25 },
  pool: { colour: '#1c2725', band: 3, wave: 0.2 },
  steppe: { colour: '#4a5446', band: 3, wave: 0.25 },
  tarn: { colour: '#25333a', band: 4, wave: 0.35 },
  sea: { colour: '#34484a', band: 14, wave: 1 },
} as const;
export type WaterTint = keyof typeof WATER_TINTS;
/** Silt and peat stirred up in the shallows of every water. */
export const SHALLOW_TINT = '#4a4432';
/** The water plane's height, as the river's in versions 1 and 2. */
export const WATER_LEVEL = 0.03;

export function waterTint(world: WorldBlueprint, lake: WorldLake): WaterTint {
  if (lake.kind !== 'pool') return lake.kind;
  const region = world.exploration?.regions.find(r => lake.x >= r.bounds.minX && lake.x <= r.bounds.maxX && lake.z >= r.bounds.minZ && lake.z <= r.bounds.maxZ);
  return region?.id === 'ashsteppe' ? 'steppe' : 'pool';
}

interface Builder { positions: number[]; colours: number[]; water: number[]; indices: number[] }

function vertex(out: Builder, p: Vec2, colour: THREE.Color, band: number, wave: number): number {
  out.positions.push(p.x, WATER_LEVEL, p.z);
  out.colours.push(colour.r, colour.g, colour.b);
  out.water.push(band, wave);
  return out.positions.length / 3 - 1;
}

/** A triangle facing up (+Y), whatever the order of its corners. */
function triangle(out: Builder, a: number, b: number, c: number): void {
  const p = out.positions;
  const ax = p[a * 3]!, az = p[a * 3 + 2]!, bx = p[b * 3]!, bz = p[b * 3 + 2]!, cx = p[c * 3]!, cz = p[c * 3 + 2]!;
  // ((b - a) x (c - a)).y: positive when the corners run counter-clockwise seen from above, the face then looking up.
  if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) >= 0) out.indices.push(a, b, c);
  else out.indices.push(a, c, b);
}

/** An inland lake: a shore band ring (band 0 at the shore, 1 at `width` metres in) round a fan to its centre. */
function inland(out: Builder, lake: WorldLake, colour: THREE.Color, width: number, wave: number): void {
  const n = lake.shore.length;
  const shore = lake.shore.map(p => vertex(out, p, colour, 0, wave));
  const ring = lake.shore.map(p => {
    const d = Math.hypot(p.x - lake.x, p.z - lake.z);
    const t = Math.min(width, d * 0.6) / d;
    return vertex(out, { x: p.x + (lake.x - p.x) * t, z: p.z + (lake.z - p.z) * t }, colour, 1, wave);
  });
  const centre = vertex(out, lake, colour, 1, wave);
  for (let k = 0; k < n; k++) {
    const next = (k + 1) % n;
    triangle(out, shore[k]!, shore[next]!, ring[next]!);
    triangle(out, shore[k]!, ring[next]!, ring[k]!);
    triangle(out, ring[k]!, ring[next]!, centre);
  }
}

/** The sea: its coast (band 0), a surf band `width` metres seaward and open water out to SEA_REACH beyond the bounds. */
function sea(out: Builder, lake: WorldLake, colour: THREE.Color, width: number, wave: number, bounds: Bounds): void {
  const coast = lake.shore;
  const far = bounds.maxX + SEA_REACH;
  const shore = coast.map(p => vertex(out, p, colour, 0, wave));
  const band = coast.map((p, k) => {
    const a = coast[Math.max(0, k - 1)]!, b = coast[Math.min(coast.length - 1, k + 1)]!;
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz) || 1;
    // Seaward is to the right of a shore that runs south to north.
    return vertex(out, { x: Math.min(far, p.x + dz / length * width), z: p.z - dx / length * width }, colour, 1, wave);
  });
  const open = coast.map(p => vertex(out, { x: far, z: p.z }, colour, 1, wave));
  for (let k = 0; k + 1 < coast.length; k++) {
    triangle(out, shore[k]!, shore[k + 1]!, band[k + 1]!);
    triangle(out, shore[k]!, band[k + 1]!, band[k]!);
    triangle(out, band[k]!, band[k + 1]!, open[k + 1]!);
    triangle(out, band[k]!, open[k + 1]!, open[k]!);
  }
}

/** The river between its banks (band 0 at each bank, 1 `width` metres in), in 8 m sections along its length. */
function river(out: Builder, bounds: Bounds, colour: THREE.Color, width: number, wave: number): void {
  const alongX = bounds.maxX - bounds.minX >= bounds.maxZ - bounds.minZ;
  const length = alongX ? bounds.maxX - bounds.minX : bounds.maxZ - bounds.minZ;
  const [lo, hi] = alongX ? [bounds.minZ, bounds.maxZ] : [bounds.minX, bounds.maxX];
  const inset = Math.min(width, (hi - lo) / 2 - 0.01);
  const across = [[lo, 0], [lo + inset, 1], [hi - inset, 1], [hi, 0]] as const;
  const sections = Math.max(1, Math.ceil(length / 8));
  const rows = Array.from({ length: sections + 1 }, (_, k) => {
    const t = (alongX ? bounds.minX : bounds.minZ) + length * k / sections;
    return across.map(([c, band]) => vertex(out, alongX ? { x: t, z: c } : { x: c, z: t }, colour, band, wave));
  });
  for (let k = 0; k < sections; k++) {
    for (let j = 0; j < 3; j++) {
      triangle(out, rows[k]![j]!, rows[k + 1]![j]!, rows[k + 1]![j + 1]!);
      triangle(out, rows[k]![j]!, rows[k + 1]![j + 1]!, rows[k]![j + 1]!);
    }
  }
}

/** The merged water geometry of a version 3 world: the river (ending at the coast), its lakes and the sea. */
export function waterGeometry(world: WorldBlueprint): THREE.BufferGeometry {
  const out: Builder = { positions: [], colours: [], water: [], indices: [] };
  const riverTint = WATER_TINTS.river;
  river(out, riverToCoast(world), new THREE.Color(riverTint.colour), riverTint.band, riverTint.wave);
  for (const lake of world.lakes ?? []) {
    const tint = WATER_TINTS[waterTint(world, lake)];
    const colour = new THREE.Color(tint.colour);
    if (lake.kind === 'sea') sea(out, lake, colour, tint.band, tint.wave, world.bounds);
    else inland(out, lake, colour, tint.band, tint.wave);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(out.positions.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(out.colours, 3));
  geometry.setAttribute('water', new THREE.Float32BufferAttribute(out.water, 2));
  geometry.setIndex(out.indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Version 3 water: the river's physical look (clearcoat glints, view-dependent reflection) with each water's tint, silt in
 * a shallow band at the shore, ripples from four directions at unrelated frequencies (faded with distance, so far water
 * never shimmers into stripes), faint wind slicks, a long swell on the sea and surf breaking in uneven lines on its
 * shingle. A small polygon offset keeps the open sea over the far apron.
 */
export function makeWaters(resources: ViewResources, world: WorldBlueprint): { mesh: THREE.Mesh; time: { value: number } } {
  const time = { value: 0 };
  const material = resources.ownMaterial('world-water', new THREE.MeshPhysicalMaterial({
    color: '#ffffff', vertexColors: true, roughness: 0.3, metalness: 0.25, clearcoat: 0.75, clearcoatRoughness: 0.2,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  }));
  const shallow = { value: new THREE.Color(SHALLOW_TINT) };
  material.customProgramCacheKey = () => 'korovany-water-v3';
  material.onBeforeCompile = shader => {
    shader.uniforms.waterTime = time;
    shader.uniforms.shallowTint = shallow;
    shader.vertexShader = `attribute vec2 water;\nvarying vec2 vWater;\nvarying vec3 vWaterWorld;\n${shader.vertexShader}`
      .replace('#include <worldpos_vertex>', `
        #include <worldpos_vertex>
        vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWater = water;
      `);
    shader.fragmentShader = `varying vec2 vWater;
      varying vec3 vWaterWorld;
      uniform float waterTime;
      uniform vec3 shallowTint;
      vec2 ripple(vec2 p, vec2 direction, float frequency, float speed, float amplitude) {
        return amplitude * cos(dot(p, direction) * frequency - waterTime * speed) * direction;
      }\n${shader.fragmentShader}`
      .replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        vec2 wP = vWaterWorld.xz;
        float wStrength = vWater.y;
        float wNear = 1.0 - smoothstep(22.0, 85.0, length(vWaterWorld - cameraPosition));
        vec2 wSlope = ripple(wP, vec2(0.83, 0.56), 1.9, 1.1, 0.040) + ripple(wP, vec2(-0.47, 0.88), 2.7, -1.3, 0.032)
          + ripple(wP, vec2(0.21, -0.98), 4.3, 1.7, 0.024) + ripple(wP, vec2(-0.93, -0.36), 6.1, -2.1, 0.018);
        wSlope *= (0.35 + wStrength) * wNear;
        wSlope += wStrength * (ripple(wP, vec2(0.96, 0.28), 0.19, 0.6, 0.05) + ripple(wP, vec2(0.6, -0.8), 0.31, 0.75, 0.03));
        normal = normalize(mat3(viewMatrix) * normalize(vec3(wSlope.x, 1.0, wSlope.y)));
      `).replace('#include <clearcoat_normal_fragment_maps>', `
        #include <clearcoat_normal_fragment_maps>
        clearcoatNormal = normal;
      `).replace('#include <color_fragment>', `
        #include <color_fragment>
        vec2 wQ = vWaterWorld.xz;
        float wSlick = sin(wQ.x * 0.045 + sin(wQ.y * 0.061) * 1.7) * sin(wQ.y * 0.038 + sin(wQ.x * 0.052) * 1.3);
        diffuseColor.rgb *= 0.93 + 0.07 * wSlick;
        float wBand = vWater.x;
        float wShallows = 1.0 - smoothstep(0.0, 0.7, wBand);
        diffuseColor.rgb = mix(diffuseColor.rgb, shallowTint * 0.55 + diffuseColor.rgb * 0.45, wShallows * 0.6);
        // Surf on the sea: uneven lines running in to the shingle and broken froth at the waterline; inland water keeps a
        // faint scum line.
        float wAlong = wQ.y * 0.11 + sin(wQ.y * 0.031) * 3.0;
        float wBroken = smoothstep(0.15, 0.85, 0.5 + 0.5 * sin(wAlong) * sin(wAlong * 0.37 + 1.7));
        float wLines = smoothstep(0.88, 0.99, sin(wBand * 30.0 + waterTime * 1.2 + sin(wQ.y * 0.07) * 2.0));
        float wSurf = (1.0 - smoothstep(0.02, 0.5, wBand)) * wLines * (0.3 + 0.7 * wBroken);
        float wFroth = (1.0 - smoothstep(0.0, 0.05, wBand)) * (0.35 + 0.65 * wBroken);
        float wSea = step(0.6, vWater.y);
        diffuseColor.rgb += wSea * (wSurf * 0.2 + wFroth * 0.16) * vec3(0.88, 0.91, 0.88) + (1.0 - wSea) * wFroth * 0.035;
      `);
  };
  const mesh = new THREE.Mesh(resources.geometry(`waters:${world.id}`, () => waterGeometry(world)), material);
  mesh.name = 'world-water';
  mesh.receiveShadow = true;
  // Opaque water after the ground, so the terrain's depth rejects the hidden water early.
  mesh.renderOrder = 1;
  return { mesh, time };
}

/** The river's water in a world with a sea: it ends at the coast, where the sea's water takes over. */
export function riverToCoast(world: WorldBlueprint): Bounds {
  const river = world.river;
  const sea = world.lakes?.find(lake => lake.kind === 'sea');
  if (!sea) return river;
  const z = (river.minZ + river.maxZ) / 2;
  let x = river.maxX;
  while (x > river.minX && lakeClearance(sea, { x: x - 0.25, z }) < 0) x -= 0.25;
  return { ...river, maxX: x };
}
