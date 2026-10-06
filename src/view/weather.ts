import * as THREE from 'three';
import type { Vec2, WorldBlueprint } from '../game/types';
import { V3_GRADE } from './atmosphere';

/**
 * Version 3 weather (presentation only): each wild region's air and what drifts in it, eased in as the hero travels.
 *
 * - The fog thickens and takes the region's colour (the sky's horizon follows): dim green-grey under the dark forests,
 *   a pale thick mist on the Fens, a brown ash haze on the steppe, cold haze on the Frostspine, sea haze on the coast.
 *   Homes and the heartlands keep the base grade, and a region's air fades out over its last 40 m.
 * - One point cloud draws falling leaves (the dark forests), ash flakes with rare embers (the Ash Steppe), snow (the
 *   Frostspine) and will-o'-wisps over the Fens. The particles hang still in the world and wrap round the hero, so they
 *   move with the wind, not with the camera. (Large soft mist sprites were tried and dropped: GPUs clamp big points,
 *   which cut them into hard-edged squares.)
 *
 * Particles show at high quality without reduced motion; the fog grades always apply. One extra shader program,
 * compiled by the load-time warm-up.
 */

/** Air of a region: fog colour and range (the base grade is V3_GRADE). */
interface Air { fog: string; near: number; far: number }
export const REGION_AIR: Readonly<Record<string, Air>> = {
  greenmarch: { fog: '#5d6862', near: 30, far: 170 },
  hollowvale: { fog: '#5b6460', near: 30, far: 168 },
  fenlands: { fog: '#7a857c', near: 16, far: 138 },
  ashsteppe: { fog: '#857b6f', near: 32, far: 178 },
  frostspine: { fog: '#8b96a0', near: 28, far: 172 },
  saltcoast: { fog: '#7c898f', near: 38, far: 192 },
};
/** A region's air fades in over this many metres inside its border. */
export const AIR_EDGE = 40;
/** Seconds for the air to settle after a change of region. */
const AIR_EASE = 1.6;

/** Particle kinds, in their order in the cloud. */
const KINDS = ['leaves', 'ash', 'snow', 'wisps'] as const;
type Kind = typeof KINDS[number];
/** Particles of each kind at full density (high quality). */
export const WEATHER_COUNTS: Readonly<Record<Kind, number>> = { leaves: 700, ash: 1400, snow: 1600, wisps: 110 };

/** How strongly the hero's spot lies inside each region: 1 deep inside, easing to 0 over the last AIR_EDGE metres. */
export function regionWeights(world: WorldBlueprint, p: Vec2): Map<string, number> {
  const weights = new Map<string, number>();
  for (const region of world.exploration?.regions ?? []) {
    const b = region.bounds;
    const inside = Math.min(p.x - b.minX, b.maxX - p.x, p.z - b.minZ, b.maxZ - p.z);
    if (inside <= 0) continue;
    const t = Math.min(1, inside / AIR_EDGE);
    weights.set(region.id, t * t * (3 - 2 * t));
  }
  return weights;
}

/** Density of each particle kind at the hero's spot, 0-1. */
export function weatherDensity(weights: ReadonlyMap<string, number>): Record<Kind, number> {
  const w = (id: string) => weights.get(id) ?? 0;
  return {
    leaves: Math.max(w('greenmarch'), w('hollowvale')),
    ash: w('ashsteppe'),
    snow: w('frostspine'),
    wisps: w('fenlands'),
  };
}

/** The fog the hero's spot should have: the base grade moved towards each region's air by its weight. */
export function targetAir(weights: ReadonlyMap<string, number>, color: THREE.Color): { near: number; far: number } {
  color.set(V3_GRADE.fog);
  const base = color.clone(), air = new THREE.Color();
  let { r, g, b } = base, near = V3_GRADE.fogNear, far = V3_GRADE.fogFar;
  for (const [id, weight] of weights) {
    const grade = REGION_AIR[id];
    if (!grade || weight <= 0) continue;
    // Plain arithmetic: Color.sub clamps at zero, which would drop every darker grade.
    air.set(grade.fog);
    r += (air.r - base.r) * weight;
    g += (air.g - base.g) * weight;
    b += (air.b - base.b) * weight;
    near += (grade.near - V3_GRADE.fogNear) * weight;
    far += (grade.far - V3_GRADE.fogFar) * weight;
  }
  color.setRGB(r, g, b);
  return { near, far };
}

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCentre;
  uniform float uHalfHeight;
  uniform float uDensity[4];
  attribute float aKind;
  attribute float aPick;
  varying vec4 vColor;
  varying float vKind;
  varying float vSpin;
  #include <fog_pars_vertex>

  float wrapped(float value, float size) { return value - size * floor(value / size); }

  void main() {
    int kind = int(aKind + 0.5);
    float density = uDensity[kind];
    vKind = aKind;
    vSpin = 0.0;
    if (aPick >= density) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vColor = vec4(0.0);
      return;
    }
    float t = uTime, phase = aPick * 37.0 + position.x * 11.0;
    // Each faller's pace is its own draw: a pace tied to its starting height would gather every flake at one height.
    float pace = fract(position.z * 7.13 + aPick * 3.71 + position.x * 1.37);
    // Falling kinds fill a 64 m box round the hero up to 22 m high; wisps keep near the ground in a wider one.
    float span = kind == 3 ? 84.0 : 64.0;
    vec3 world = vec3(0.0);
    vec3 color = vec3(1.0);
    float size = 0.1, alpha = 1.0, top = 22.0, lift = 0.0;
    if (kind == 0) {
      // Leaves: a slow tumbling fall that sways across the wind.
      float fall = 0.55 + 0.5 * pace;
      lift = wrapped(position.y * top - t * fall, top);
      world.xz = position.xz * span + vec2(0.9, 0.35) * t + vec2(sin(t * 1.3 + phase), cos(t * 1.1 + phase)) * 0.8;
      vSpin = t * (1.5 + position.z * 2.5) + phase;
      size = 0.15 + 0.08 * position.z;
      color = mix(vec3(0.16, 0.07, 0.02), vec3(0.32, 0.16, 0.03), position.x);
      color = mix(color, vec3(0.08, 0.09, 0.03), step(0.82, position.z));
    } else if (kind == 1) {
      // Ash: charcoal flakes drifting down the steppe wind; one in eleven a glowing ember.
      float fall = 0.22 + 0.2 * pace;
      lift = wrapped(position.y * top - t * fall, top);
      world.xz = position.xz * span + vec2(0.7, -0.25) * t + vec2(sin(t * 0.7 + phase), cos(t * 0.6 + phase)) * 0.5;
      float ember = step(0.91, fract(phase * 0.618));
      size = mix(0.13 + 0.1 * position.z, 0.09, ember);
      color = mix(mix(vec3(0.035, 0.032, 0.03), vec3(0.2, 0.19, 0.17), position.x), vec3(2.4, 0.62, 0.1), ember);
      alpha = mix(0.9, 0.65 + 0.35 * sin(t * 6.0 + phase), ember);
    } else if (kind == 2) {
      // Snow: a steady fall with a little drift.
      float fall = 1.0 + 0.6 * pace;
      lift = wrapped(position.y * top - t * fall, top);
      world.xz = position.xz * span + vec2(0.35, 0.12) * t + vec2(sin(t * 0.9 + phase), cos(t * 0.8 + phase)) * 0.35;
      size = 0.11 + 0.09 * position.z;
      color = vec3(0.86, 0.9, 0.96);
    } else {
      // Will-o'-wisps: pale lights wandering a metre or two over the fen, breathing in and out.
      lift = 0.6 + 1.6 * position.y + 0.35 * sin(t * 0.8 + phase);
      world.xz = position.xz * span + vec2(sin(t * 0.21 + phase), cos(t * 0.17 + phase * 1.3)) * 4.0;
      size = 0.5;
      color = vec3(0.55, 0.95, 0.62) * 2.2;
      alpha = 0.55 + 0.45 * sin(t * 1.7 + phase * 3.0);
    }
    // The cloud hangs still in the world and wraps round the hero, fading out at the edges of its box.
    vec2 local = vec2(wrapped(world.x - uCentre.x + span * 0.5, span), wrapped(world.z - uCentre.z + span * 0.5, span));
    vec2 edge = min(local, vec2(span) - local);
    alpha *= smoothstep(0.0, 6.0, min(edge.x, edge.y));
    if (kind <= 2) alpha *= 1.0 - smoothstep(top - 4.0, top, lift);
    float base = kind <= 2 ? uCentre.y - 1.5 : uCentre.y;
    vec3 at = vec3(uCentre.x - span * 0.5 + local.x, base + lift, uCentre.z - span * 0.5 + local.y);
    vec4 mvPosition = modelViewMatrix * vec4(at, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float depth = max(0.1, -mvPosition.z);
    // Points stay small (every GPU draws 64 px points whole).
    gl_PointSize = min(64.0, size * projectionMatrix[1][1] * uHalfHeight / depth);
    // Nothing large right in front of the lens.
    alpha *= smoothstep(1.5, 4.0, depth);
    vColor = vec4(color, alpha);
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  varying vec4 vColor;
  varying float vKind;
  varying float vSpin;
  #include <fog_pars_fragment>

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float shape;
    if (vKind < 0.5) {
      float c = cos(vSpin), s = sin(vSpin);
      vec2 turned = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
      shape = 1.0 - smoothstep(0.7, 1.0, length(turned * vec2(1.0, 2.3)));
    } else if (vKind > 2.5) {
      float r = length(uv);
      shape = exp(-r * r * 9.0) + 0.35 * (1.0 - smoothstep(0.2, 1.0, r));
    } else {
      shape = 1.0 - smoothstep(0.45, 1.0, length(uv));
    }
    float alpha = shape * vColor.a;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vColor.rgb, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** A small deterministic generator for the particles' seeds (the same cloud for every load of a world). */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WorldWeather {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly densities = new Float32Array(KINDS.length);
  private readonly targetColor = new THREE.Color();
  private readonly near: { value: number };
  private readonly far: { value: number };
  private time = 0;
  private low = false;
  /** The air has been placed once; later changes of region ease in. */
  private placed = false;
  private targetNear = 0;
  private targetFar = 0;

  constructor(private readonly world: WorldBlueprint, private readonly fog: THREE.Fog, private readonly background: THREE.Color,
    private readonly horizon: THREE.Color | undefined) {
    const total = KINDS.reduce((sum, kind) => sum + WEATHER_COUNTS[kind], 0);
    const positions = new Float32Array(total * 3), kinds = new Float32Array(total), picks = new Float32Array(total);
    const random = seeded(world.seed.split('').reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261));
    let index = 0;
    KINDS.forEach((kind, kindIndex) => {
      for (let i = 0; i < WEATHER_COUNTS[kind]; i++, index++) {
        positions[index * 3] = random();
        positions[index * 3 + 1] = random();
        positions[index * 3 + 2] = random();
        kinds[index] = kindIndex;
        // Evenly spread thresholds, so a density of d shows the first d of each kind's particles.
        picks[index] = (i + random()) / WEATHER_COUNTS[kind];
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aKind', new THREE.BufferAttribute(kinds, 1));
    geometry.setAttribute('aPick', new THREE.BufferAttribute(picks, 1));
    this.material = new THREE.ShaderMaterial({
      name: 'world-weather',
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 }, uCentre: { value: new THREE.Vector3() }, uHalfHeight: { value: 540 }, uDensity: { value: KINDS.map(() => 0) },
      }]),
      vertexShader, fragmentShader, transparent: true, depthWrite: false, fog: true,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.name = 'world-weather';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
    this.near = { value: fog.near };
    this.far = { value: fog.far };
  }

  setQuality(low: boolean): void {
    this.low = low;
  }

  /**
   * Another update at the same spot would draw the same air: no particle is shown (they show only at high quality
   * without reduced motion) and the fog has come to rest on the region's colour and range.
   */
  get settled(): boolean {
    return this.placed && !this.points.visible && this.fog.color.equals(this.targetColor)
      && this.near.value === this.targetNear && this.far.value === this.targetFar;
  }

  /** What is left of the fog's ease is below a hundredth of a metre and well under one 8-bit step of colour. */
  private airArrived(): boolean {
    const fog = this.fog.color, target = this.targetColor;
    return Math.max(Math.abs(fog.r - target.r), Math.abs(fog.g - target.g), Math.abs(fog.b - target.b)) < 5e-4
      && Math.abs(this.near.value - this.targetNear) < 0.01 && Math.abs(this.far.value - this.targetFar) < 0.01;
  }

  /**
   * Eases the fog towards the hero's region and moves the particles. `halfHeight` is half the drawing buffer's height in
   * pixels (the point sizes follow the resolution).
   */
  update(hero: Vec2, ground: number, dt: number, reducedMotion: boolean, halfHeight: number): void {
    const weights = regionWeights(this.world, hero);
    const { near, far } = targetAir(weights, this.targetColor);
    this.targetNear = near;
    this.targetFar = far;
    const ease = this.placed ? 1 - Math.exp(-Math.max(0, dt) / AIR_EASE) : 1;
    this.placed = true;
    this.fog.color.lerp(this.targetColor, ease);
    this.near.value += (near - this.near.value) * ease;
    this.far.value += (far - this.far.value) * ease;
    // The air comes to rest exactly on its region's grade once what is left of the ease is too small to see.
    if (this.airArrived()) {
      this.fog.color.copy(this.targetColor);
      this.near.value = near;
      this.far.value = far;
    }
    this.fog.near = this.near.value;
    this.fog.far = this.far.value;
    this.background.copy(this.fog.color);
    this.horizon?.copy(this.fog.color);

    const show = !reducedMotion && !this.low;
    const density = weatherDensity(weights);
    KINDS.forEach((kind, index) => { this.densities[index] = show ? density[kind] : 0; });
    this.points.visible = show && this.densities.some(value => value > 0);
    if (!this.points.visible) return;
    this.time += Math.min(dt, 0.1);
    const uniforms = this.material.uniforms;
    uniforms.uTime!.value = this.time % 3600;
    (uniforms.uCentre!.value as THREE.Vector3).set(hero.x, ground, hero.z);
    uniforms.uHalfHeight!.value = halfHeight;
    uniforms.uDensity!.value = Array.from(this.densities);
  }

  /** Shader warm-up: the cloud drawn once (every kind present), until `restore`. */
  warm(x: number, y: number, z: number): { objects: THREE.Object3D[]; restore(): void } {
    const visible = this.points.visible, density = this.material.uniforms.uDensity!.value as number[];
    const centre = (this.material.uniforms.uCentre!.value as THREE.Vector3).clone();
    this.points.visible = true;
    this.material.uniforms.uDensity!.value = KINDS.map(() => 1);
    (this.material.uniforms.uCentre!.value as THREE.Vector3).set(x, y, z);
    return {
      objects: [this.points],
      restore: () => {
        this.points.visible = visible;
        this.material.uniforms.uDensity!.value = density;
        (this.material.uniforms.uCentre!.value as THREE.Vector3).copy(centre);
      },
    };
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
