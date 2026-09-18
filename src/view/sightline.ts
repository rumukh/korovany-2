import * as THREE from 'three';

export function applySightlineDither(material: THREE.Material, hero = new THREE.Vector3(), strength = 0): void {
  material.customProgramCacheKey = () => 'korovany-sightline-v1';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.heroPosition = { value: hero };
    shader.uniforms.cutawayStrength = { value: strength };
    shader.vertexShader = `varying vec3 vCutawayWorld;\n${shader.vertexShader}`.replace('#include <worldpos_vertex>', `
        #include <worldpos_vertex>
        vec4 cutawayPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cutawayPosition = instanceMatrix * cutawayPosition;
        #endif
        vCutawayWorld = (modelMatrix * cutawayPosition).xyz;
      `);
    shader.fragmentShader = `uniform vec3 heroPosition;\nuniform float cutawayStrength;\nvarying vec3 vCutawayWorld;\n${shader.fragmentShader}`.replace('#include <alphatest_fragment>', `
        #include <alphatest_fragment>
        if (cutawayStrength > 0.0) {
          vec3 sightline = heroPosition - cameraPosition;
          float alongSight = dot(vCutawayWorld - cameraPosition, sightline) / max(0.001, dot(sightline, sightline));
          float distanceToSight = length(vCutawayWorld - (cameraPosition + sightline * alongSight));
          float cutaway = (1.0 - smoothstep(1.2, 2.5, distanceToSight)) * step(0.0, alongSight) * (1.0 - step(1.03, alongSight));
          float pattern = fract(dot(floor(gl_FragCoord.xy), vec2(0.75487766, 0.56984029)));
          if (pattern < cutaway * cutawayStrength) discard;
        }
      `);
  };
}
