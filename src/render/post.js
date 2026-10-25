// Post-processing shaders: HDR sanitizer (kills NaN/Inf + clamps runaway additive stacks before bloom,
// which otherwise smears a single bad pixel over the whole screen through its mip chain), and the final
// grade: exposure, log-space contrast, split toning, hue-preserving filmic tonemap, sRGB, lift, vignette,
// grain, chroma, damage + fade.
import * as THREE from 'three';

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

export const MAX_SCATTER = 16;
// HDR sanitizer + per-light in-scattering (airlight). Runs right after the scene render, reads its depth:
//  - kills NaN/Inf and clamps runaway additive stacks before bloom (a single bad pixel otherwise poisons the
//    bloom mip chain and blacks out the whole frame - the muzzle-flash / impact black-frame bug)
//  - for each pooled point light, adds the closed-form integral of 1/d^2 along the view ray up to the visible
//    surface -> coloured halos / light pooling in the haze, correctly occluded by geometry in front.
export const ScatterShader = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, uMax: { value: 48 }, uN: { value: 0 }, uK: { value: 0.003 },
    uProjInv: { value: new THREE.Matrix4() }, uL: { value: Array.from({ length: MAX_SCATTER }, () => new THREE.Vector4()) },
    uLC: { value: Array.from({ length: MAX_SCATTER }, () => new THREE.Vector3()) }, uMaxDist: { value: 70 },
  },
  vertexShader: VS,
  fragmentShader: `
    #define MAXL ${16}
    uniform sampler2D tDiffuse, tDepth; uniform float uMax, uK, uMaxDist; uniform int uN; uniform mat4 uProjInv;
    uniform vec4 uL[MAXL]; uniform vec3 uLC[MAXL]; varying vec2 vUv;
    bool bad(float v){ return !(v >= 0.0 && v <= 65000.0) || isnan(v) || isinf(v); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      if (bad(c.r) || bad(c.g) || bad(c.b)) c.rgb = vec3(0.0);
      float m = max(c.r, max(c.g, c.b));
      if (m > uMax) c.rgb *= uMax / m;
      if (uN > 0) {
        float d = texture2D(tDepth, vUv).x;
        vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); vec3 V = vp.xyz / vp.w;
        float tl = min(length(V), uMaxDist); vec3 rd = normalize(V);
        vec3 sc = vec3(0.0);
        for (int i = 0; i < MAXL; i++) {
          if (i >= uN) break;
          vec3 L = uL[i].xyz; float b = dot(rd, L);
          float h = sqrt(max(dot(L, L) - b * b, 0.0) + 0.3);
          float I = (atan((tl - b) / h) - atan(-b / h)) / h;
          float fr = clamp(1.0 - h / uL[i].w, 0.0, 1.0);
          sc += uLC[i] * (I * fr * fr);
        }
        sc *= uK; c.rgb += sc / (1.0 + max(sc.r, max(sc.g, sc.b)) * 0.6);
      }
      gl_FragColor = vec4(c.rgb, 1.0);
    }`,
};

export const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
    uExposure: { value: 1 }, uContrast: { value: 1.15 }, uSat: { value: 0.9 }, uLift: { value: new THREE.Color(0.006, 0.009, 0.012) },
    uTint: { value: new THREE.Color(1.04, 0.98, 0.9) }, uShadowTint: { value: new THREE.Color(0.85, 0.98, 1.1) },
    uVignette: { value: 0.85 }, uGrain: { value: 0.035 }, uChroma: { value: 0.0012 }, uDamage: { value: 0 }, uFade: { value: 0 },
    uWarmSat: { value: 0.25 },
  },
  vertexShader: VS,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uExposure, uContrast, uSat, uVignette, uGrain, uChroma, uDamage, uFade, uWarmSat;
    uniform vec3 uLift, uTint, uShadowTint; uniform vec2 uRes; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
    float acesL(float x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
    vec3 toSRGB(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main(){
      vec2 c = vUv - 0.5; float r2 = dot(c, c);
      vec2 off = c * (uChroma + uDamage * 0.004) * (1.0 + r2 * 4.0);
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col = max(col, 0.0) * uExposure + uLift;
      // log-space contrast around mid grey: deepens shadows without clipping them to zero
      float L = max(luma(col), 1e-5);
      float Lc = 0.18 * pow(L / 0.18, uContrast);
      col *= Lc / L; L = Lc;
      // split toning (cool shadows / warm highlights) - complementary colour design
      col *= mix(uShadowTint, uTint, smoothstep(0.02, 0.5, L));
      // saturation, with extra push for warm hues (fire, sodium) so they read against the cool base
      float warm = clamp((col.r - col.b) / max(col.r + 1e-4, 1e-4), 0.0, 1.0);
      col = mix(vec3(L), col, uSat + warm * uWarmSat);
      col = max(col, 0.0);
      // hue-preserving filmic: tonemap luminance, keep chroma, roll highlights toward per-channel ACES
      float Lt = acesL(L);
      vec3 hp = col * (Lt / max(L, 1e-5));
      float mx = max(hp.r, max(hp.g, hp.b));
      col = mix(hp / max(1.0, mx), aces(col), smoothstep(0.75, 1.6, mx));
      col = toSRGB(col);
      float vig = 1.0 - smoothstep(0.25, 0.9, length(c * vec2(1.0, 0.85)) * uVignette * 1.25);
      col *= mix(0.55, 1.0, vig);
      float edge = smoothstep(0.25, 0.75, length(c) * 1.4);
      col = mix(col, vec3(0.45, 0.02, 0.02), edge * uDamage * 0.8);
      col += (h(vUv * uRes + fract(uTime) * 100.0) - 0.5) * uGrain * (1.0 - col * 0.5);
      col = mix(col, vec3(0.0), uFade);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};
