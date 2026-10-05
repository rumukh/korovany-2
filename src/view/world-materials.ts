import * as THREE from 'three';
import { applySightlineDither } from './sightline';
import { SURFACE_METRES, WORLD_SURFACES, type WorldSurfaces } from './world-assets';

/** Three's screen-space cotangent frame (normal mapping without tangent attributes), under a private name. */
const TANGENT_FRAME = `
  mat3 worldTangentFrame(vec3 eyePosition, vec3 surfaceNormal, vec2 uv) {
    vec3 q0 = dFdx(eyePosition); vec3 q1 = dFdy(eyePosition);
    vec2 st0 = dFdx(uv); vec2 st1 = dFdy(uv);
    vec3 q1perp = cross(q1, surfaceNormal); vec3 q0perp = cross(surfaceNormal, q0);
    vec3 T = q1perp * st0.x + q0perp * st1.x;
    vec3 B = q1perp * st0.y + q0perp * st1.y;
    float det = max(dot(T, T), dot(B, B));
    float scale = det == 0.0 ? 0.0 : inversesqrt(det);
    return mat3(T * scale, B * scale, surfaceNormal);
  }
  vec3 worldSurfaceNormal(vec4 data, vec3 normal, vec3 eyePosition, vec2 uv, float strength) {
    vec3 tangentNormal = vec3((data.rg * 2.0 - 1.0) * strength, 0.0);
    tangentNormal.z = sqrt(max(0.05, 1.0 - dot(tangentNormal.xy, tangentNormal.xy)));
    return normalize(worldTangentFrame(eyePosition, normal, uv) * tangentNormal);
  }
`;

export function surfaceLayer(name: (typeof WORLD_SURFACES)[number]): number {
  return WORLD_SURFACES.indexOf(name);
}

/**
 * Crossed-card tree impostors: each card dithers away as it turns edge-on to the view, from gone at `facing[0]` to solid
 * at `facing[1]` (|cos| between the card's face normal, taken from screen-space derivatives, and the view ray), so the
 * horizontal top card never shows as a line from the side. Composes with the material's sightline cutaway; every
 * impostor shares one program.
 */
export function applyEdgeFade(material: THREE.Material, facing: readonly [number, number] = [0.15, 0.35]): void {
  const key = material.customProgramCacheKey();
  if (key.endsWith(':edge-fade')) return;
  const base = material.onBeforeCompile;
  material.customProgramCacheKey = () => `${key}:edge-fade`;
  material.onBeforeCompile = (shader, renderer) => {
    base.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `
        #include <alphatest_fragment>
        {
          vec3 edgeNormal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
          float edgeFacing = abs(dot(edgeNormal, normalize(vViewPosition)));
          float edgePattern = fract(dot(floor(gl_FragCoord.xy), vec2(0.56984029, 0.75487766)) + 0.5);
          if (edgePattern > smoothstep(${facing[0].toFixed(3)}, ${facing[1].toFixed(3)}, edgeFacing)) discard;
        }
      `);
  };
}

/**
 * The material of every scripted kit mesh (buildings, fences, tree bark, rocks): UV0 is a world-scale tiling UV, UV1.x
 * the surface layer (+0.5) and UV1.y a baked ambient-occlusion factor. One program for all of them; the camera-to-hero
 * sightline cutaway dithers them like the rest of the world's architecture.
 */
export function kitMaterial(surfaces: WorldSurfaces, hero: THREE.Vector3,
  sightline: { radius: readonly [number, number]; widen: number } = { radius: [1.6, 3.2], widen: 0 }): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  material.name = 'world-kit';
  applySightlineDither(material, hero, 1, sightline.radius, sightline.widen);
  const cutaway = material.onBeforeCompile;
  material.customProgramCacheKey = () => 'korovany-world-kit-v1';
  material.onBeforeCompile = (shader, renderer) => {
    cutaway.call(material, shader, renderer);
    shader.uniforms.surfaceAlbedo = { value: surfaces.albedo };
    shader.uniforms.surfaceData = { value: surfaces.surface };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        #ifndef USE_UV1
          attribute vec2 uv1;
        #endif
        varying vec2 vKitUv;
        varying vec2 vKitLayer;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vKitUv = uv;
        vKitLayer = uv1;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform highp sampler2DArray surfaceAlbedo;
        uniform highp sampler2DArray surfaceData;
        varying vec2 vKitUv;
        varying vec2 vKitLayer;
        ${TANGENT_FRAME}`)
      .replace('#include <map_fragment>', `
        float kitLayer = floor(vKitLayer.x);
        vec4 kitData = texture(surfaceData, vec3(vKitUv, kitLayer));
        diffuseColor.rgb *= texture(surfaceAlbedo, vec3(vKitUv, kitLayer)).rgb;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * kitData.b;')
      .replace('#include <normal_fragment_maps>', 'normal = worldSurfaceNormal(kitData, normal, -vViewPosition, vKitUv, 1.0);')
      .replace('#include <aomap_fragment>', `
        reflectedLight.indirectDiffuse *= vKitLayer.y;
        reflectedLight.indirectSpecular *= vKitLayer.y;
        reflectedLight.directDiffuse *= mix(0.6, 1.0, vKitLayer.y);`);
  };
  return material;
}

/** Control map channels: forest floor, mud, road and field weight (meadow is what remains). */
export interface TerrainControl {
  /** RGBA8 weights over the world bounds, one texel per `cell` metres, row 0 at minZ. */
  weights: THREE.DataTexture;
  /** R: field furrow heading / PI, G: 1 for stubble fields; sampled at the nearest texel. */
  fields: THREE.DataTexture;
  minX: number;
  minZ: number;
  size: number;
}

/**
 * Ground: five tiling layers blended per pixel by the control map, with luminance as pseudo-height so transitions
 * follow stones and tufts instead of soft gradients, a field layer turned along each strip, and broad tonal variation
 * that breaks up tiling at a distance.
 */
export function terrainMaterial(surfaces: WorldSurfaces, control: TerrainControl): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  material.name = 'world-terrain';
  material.customProgramCacheKey = () => 'korovany-world-terrain-v1';
  const layers = (['meadow', 'forest', 'mud', 'road', 'field'] as const).map(name => `${surfaceLayer(name)}.0`);
  const scales = (['meadow', 'forest', 'mud', 'road', 'field'] as const).map(name => (1 / SURFACE_METRES[name]).toFixed(5));
  material.onBeforeCompile = shader => {
    shader.uniforms.surfaceAlbedo = { value: surfaces.albedo };
    shader.uniforms.surfaceData = { value: surfaces.surface };
    shader.uniforms.terrainWeights = { value: control.weights };
    shader.uniforms.terrainFields = { value: control.fields };
    shader.uniforms.terrainArea = { value: new THREE.Vector3(control.minX, control.minZ, 1 / control.size) };
    shader.vertexShader = `varying vec3 vTerrainWorld;\n${shader.vertexShader}`.replace('#include <worldpos_vertex>', `
      #include <worldpos_vertex>
      vTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform highp sampler2DArray surfaceAlbedo;
        uniform highp sampler2DArray surfaceData;
        uniform sampler2D terrainWeights;
        uniform sampler2D terrainFields;
        uniform vec3 terrainArea;
        varying vec3 vTerrainWorld;
        ${TANGENT_FRAME}
        float terrainHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float terrainNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(terrainHash(i), terrainHash(i + vec2(1, 0)), f.x), mix(terrainHash(i + vec2(0, 1)), terrainHash(i + vec2(1, 1)), f.x), f.y);
        }`)
      .replace('#include <map_fragment>', `
        vec2 areaUv = (vTerrainWorld.xz - terrainArea.xy) * terrainArea.z;
        vec4 control = texture2D(terrainWeights, areaUv);
        vec4 field = texelFetch(terrainFields, clamp(ivec2(areaUv * vec2(textureSize(terrainFields, 0))), ivec2(0),
          textureSize(terrainFields, 0) - 1), 0);
        // Wobble the control lookups' edges at sub-texel scale so borders read as natural, not as bilinear blur.
        float wobble = terrainNoise(vTerrainWorld.xz * 1.7) - 0.5;
        control = clamp(control + wobble * 0.22 * (1.0 - abs(control * 2.0 - 1.0)), 0.0, 1.0);
        float heading = field.r * 3.14159265;
        vec2 fieldUv = mat2(cos(heading), -sin(heading), sin(heading), cos(heading)) * vTerrainWorld.xz * ${scales[4]};
        vec2 groundUv = vTerrainWorld.xz;
        float weights[5];
        weights[1] = control.r; weights[2] = control.g; weights[3] = control.b; weights[4] = control.a;
        weights[0] = clamp(1.0 - control.r - control.g - control.b - control.a, 0.0, 1.0);
        vec4 colours[5];
        vec4 datas[5];
        float best = 0.0;
        float heights[5];
        ${[0, 1, 2, 3, 4].map(i => `
        heights[${i}] = -1.0;
        if (weights[${i}] > 0.003) {
          vec3 uvw = vec3(${i === 4 ? 'fieldUv' : `groundUv * ${scales[i]}`}, ${layers[i]});
          colours[${i}] = texture(surfaceAlbedo, uvw);
          datas[${i}] = texture(surfaceData, uvw);
          heights[${i}] = weights[${i}] + dot(colours[${i}].rgb, vec3(0.9, 1.4, 0.6)) * 0.45;
          best = max(best, heights[${i}]);
        }`).join('')}
        vec3 groundColour = vec3(0.0);
        vec4 groundData = vec4(0.0);
        float total = 0.0;
        ${[0, 1, 2, 3, 4].map(i => `
        if (heights[${i}] > best - 0.28) {
          float blend = heights[${i}] - (best - 0.28);
          groundColour += colours[${i}].rgb * blend;
          groundData += datas[${i}] * blend;
          total += blend;
        }`).join('')}
        groundColour /= total;
        groundData /= total;
        groundColour = mix(groundColour, groundColour * vec3(1.05, 1.0, 0.82), field.g * control.a);
        float broad = terrainNoise(vTerrainWorld.xz * 0.021) * 0.6 + terrainNoise(vTerrainWorld.xz * 0.083) * 0.4;
        groundColour *= 0.82 + broad * 0.32;
        diffuseColor.rgb *= groundColour;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * groundData.b;')
      .replace('#include <normal_fragment_maps>', `normal = worldSurfaceNormal(groundData, normal, -vViewPosition,
        control.a > 0.5 ? fieldUv : vTerrainWorld.xz * 0.25, 0.85);`);
  };
  return material;
}
