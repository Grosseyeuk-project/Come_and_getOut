// Global atmosphere shader layer, injected into every built-in lit material through ShaderChunk patches:
//  - height fog (analytic exponential-height integral along the view ray) instead of flat distance fog
//  - per-light in-scattering ("airlight": closed-form integral of 1/d^2 along the view ray) so every point
//    light blooms a coloured halo into the haze -> light pooling / volumetric feel at zero extra passes
//  - wet ground: damp darkening + procedural puddles (glossy, flat normals) on low up-facing surfaces
//  - silhouette rim light (cool, complementary to the warm key) for anything at character height
// Parameters are shared plain-object uniforms injected into ShaderLib (cloneUniforms keeps plain objects
// by reference), so one JS write updates every material without touching material code.
import * as THREE from 'three';

export const atmo = {
  // x: height falloff k, y: fog base height, z: height-fog density, w: in-scatter strength
  fog: { x: 0.16, y: 0.0, z: 0.05, w: 0.0025 },
  // x: wetness 0..1, y: puddle threshold (lower = more puddles), z: rim strength, w: time
  wet: { x: 0.6, y: 0.55, z: 0.6, w: 0 },
  rim: { r: 0.35, g: 0.75, b: 1.0 },
  // colour the haze picks up looking "up" (sky-scatter) vs at the ground
  haze: { r: 0.1, g: 0.12, b: 0.14 },
};

const U = { uAtmoFog: { value: atmo.fog }, uAtmoWet: { value: atmo.wet }, uAtmoRim: { value: atmo.rim }, uAtmoHaze: { value: atmo.haze } };

// GLSL puddle mask shared with the reflection-streak shader in lighting.js
export const PUDDLE_GLSL = /* glsl */`
float atmoHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float atmoNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(atmoHash(i), atmoHash(i + vec2(1,0)), f.x), mix(atmoHash(i + vec2(0,1)), atmoHash(i + vec2(1,1)), f.x), f.y); }
float atmoPuddle(vec2 xz){ return atmoNoise(xz * 0.16) * 0.62 + atmoNoise(xz * 0.47 + 7.3) * 0.28 + atmoNoise(xz * 1.9 + 3.1) * 0.10; }
`;

let installed = false;
export function installAtmosphere(quality) {
  if (installed) return; installed = true;
  const C = THREE.ShaderChunk;
  // make the shared uniforms reachable from every built-in material + any ShaderMaterial merging UniformsLib.fog
  Object.assign(THREE.UniformsLib.fog, U);
  for (const k in THREE.ShaderLib) { const u = THREE.ShaderLib[k].uniforms; if (u && u.fogColor) Object.assign(u, U); }

  C.fog_pars_vertex = `#ifdef USE_FOG
  varying float vFogDepth; varying vec3 vFogWorld; varying vec3 vFogView;
#endif`;
  // world position from the view-space position (works for every shader that has mvPosition, incl. sprites/points)
  C.fog_vertex = `#ifdef USE_FOG
  vFogDepth = - mvPosition.z; vFogView = mvPosition.xyz;
  vFogWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;
  C.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor; uniform vec4 uAtmoFog; uniform vec3 uAtmoHaze;
  varying float vFogDepth; varying vec3 vFogWorld; varying vec3 vFogView;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear; uniform float fogFar;
  #endif
#endif`;
  C.fog_fragment = `#ifdef USE_FOG
  {
    vec3 fcam = cameraPosition, fw = vFogWorld;
    float fdist = length(fw - fcam);
    float fk = uAtmoFog.x;
    float y0 = max(fcam.y - uAtmoFog.y, -4.0), y1 = max(fw.y - uAtmoFog.y, -4.0);
    float e0 = exp(-fk * y0), e1 = exp(-fk * y1), dy = y1 - y0;
    float avgD = abs(dy) > 0.05 ? (e0 - e1) / (fk * dy) : e1;
    #ifdef FOG_EXP2
      float distF = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth * 0.35);
    #else
      float distF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    float hF = 1.0 - exp(- uAtmoFog.z * fdist * max(avgD, 0.0));
    float fogFactor = clamp(max(hF, distF), 0.0, 0.92);
    // haze is darker near the ground and catches a little sky colour higher up
    vec3 fcol = mix(fogColor, uAtmoHaze, clamp(fw.y * 0.06, 0.0, 1.0));
    vec3 fogged = mix(gl_FragColor.rgb, fcol, fogFactor);
    gl_FragColor.rgb = fogged;
  }
#endif`;
  C.lights_pars_begin = '#define ATMO_LIGHTS 1\nuniform vec4 uAtmoWet; uniform vec3 uAtmoRim;\n' + PUDDLE_GLSL + C.lights_pars_begin;
  // wetness: before the PBR material is assembled (roughnessFactor / diffuseColor / normal are all in scope)
  C.lights_physical_fragment = `
  {
    float upF = smoothstep(0.72, 0.95, dot(nonPerturbedNormal, viewMatrix[1].xyz)) * uAtmoWet.x;
    if (upF > 0.001) {
      vec3 wpos = cameraPosition + transpose(mat3(viewMatrix)) * (-vViewPosition);
      float lowF = 1.0 - smoothstep(0.2, 0.55, wpos.y);
      float wet = upF * (0.55 + 0.45 * lowF);
      float pv = atmoPuddle(wpos.xz);
      float pd = wet * lowF * smoothstep(uAtmoWet.y, uAtmoWet.y + 0.07, pv);
      float damp = wet * (0.55 + 0.45 * smoothstep(uAtmoWet.y - 0.25, uAtmoWet.y, pv));
      roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.5, damp);
      roughnessFactor = mix(roughnessFactor, 0.03, pd);
      diffuseColor.rgb *= 1.0 - 0.35 * damp - 0.35 * pd;
      normal = normalize(mix(normal, nonPerturbedNormal, pd * 0.92));
    }
  }
` + C.lights_physical_fragment;
  // rim / silhouette light at character height, complementary cool colour
  C.lights_fragment_end = C.lights_fragment_end + `
  {
    vec3 rwp = cameraPosition + transpose(mat3(viewMatrix)) * (-vViewPosition);
    // curvature (normal change per world unit): rounded props / characters yes, flat walls / slabs no
    float curv = length(fwidth(nonPerturbedNormal)) / max(length(fwidth(rwp)), 1e-4);
    float hb = smoothstep(0.15, 0.45, rwp.y) * (1.0 - smoothstep(2.2, 2.8, rwp.y)) * smoothstep(1.2, 3.5, curv) * uAtmoWet.z;
    if (hb > 0.001) {
      float rim = smoothstep(0.6, 0.97, 1.0 - abs(dot(nonPerturbedNormal, normalize(vViewPosition))));
      reflectedLight.directSpecular += uAtmoRim * (rim * rim * hb);
    }
  }`;
}
