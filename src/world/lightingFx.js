// GPU-side lighting dressing, all instanced (one draw call each):
//  - LightPools: ground light pools under every lamp / sign / fire, multiplicative ("lights" the albedo that is
//    already on screen) so far lamps that are not in the real point-light pool still light the street; faded out
//    while a real light is assigned to the source, so there is no double lighting and no popping.
//  - PuddleReflections: elongated, rippling reflection streaks of each light on the wet ground, placed where the
//    camera ray to the light's mirror image hits the ground (computed in the vertex shader from cameraPosition),
//    masked by the same procedural puddle field the material wetness uses.
//  - Rain: wrapped streak field + ground splashes, fully animated in the vertex shader.
import * as THREE from 'three';
import { atmo, PUDDLE_GLSL } from '../render/atmosphere.js';

const MAXI = 160;

function instGeo(n) {
  const g = new THREE.InstancedBufferGeometry();
  const q = new THREE.PlaneGeometry(2, 2); q.rotateX(-Math.PI / 2);
  g.index = q.index; g.setAttribute('position', q.attributes.position); g.setAttribute('uv', q.attributes.uv);
  const mk = (k, s) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(n * s), s); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, a); return a; };
  return { g, pos: mk('iPos', 4), col: mk('iCol', 3) };
}

const POOL_VS = `
  attribute vec4 iPos; attribute vec3 iCol; varying vec3 vCol; varying vec2 vQ;
  #include <fog_pars_vertex>
  void main(){
    vCol = iCol; vQ = position.xz;
    float r = iPos.w;
    vec4 mvPosition = viewMatrix * vec4(iPos.x + position.x * r, 0.16, iPos.z + position.z * r, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }`;
const POOL_FS = `
  varying vec3 vCol; varying vec2 vQ;
  void main(){
    float d = length(vQ); if (d > 1.0) discard;
    float f = 1.0 - d; f = f * f * (0.4 + 0.6 * f);
    gl_FragColor = vec4(vCol * f, 1.0);
  }`;

const REFL_VS = `
  attribute vec4 iPos; attribute vec3 iCol; uniform float uTime;
  varying vec3 vCol; varying vec2 vQ; varying vec3 vW;
  #include <fog_pars_vertex>
  void main(){
    vCol = iCol; vQ = position.xz;
    vec3 L = iPos.xyz; float h = max(L.y, 0.3);
    vec3 C = cameraPosition;
    vec3 M = vec3(L.x, -h, L.z);
    vec3 P = C + (M - C) * (C.y / (C.y + h));
    vec2 fwd = normalize(P.xz - C.xz + 1e-4); vec2 side = vec2(-fwd.y, fwd.x);
    float len = 0.5 + h * 0.55, wid = 0.22 + h * 0.07;
    vec2 xz = P.xz + fwd * position.z * len + side * position.x * wid;
    vW = vec3(xz.x, 0.165, xz.y);
    vec4 mvPosition = viewMatrix * vec4(vW, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const REFL_FS = `
  uniform float uTime; uniform vec4 uWet;
  varying vec3 vCol; varying vec2 vQ; varying vec3 vW;
  #include <fog_pars_fragment>
  ${PUDDLE_GLSL}
  void main(){
    float pv = atmoPuddle(vW.xz);
    float pd = smoothstep(uWet.y - 0.02, uWet.y + 0.06, pv);
    float m = uWet.x * (0.18 + 0.82 * pd);
    // ripples break the streak into horizontal bands (rain) and wobble it sideways
    float rip = 0.65 + 0.35 * sin(vQ.y * 22.0 + uTime * 6.0 + sin(vW.x * 3.0) * 2.0);
    float x = vQ.x + sin(vQ.y * 9.0 + uTime * 3.0) * 0.12;
    float s = exp(-x * x * 7.0) * smoothstep(1.0, 0.25, abs(vQ.y));
    float core = exp(-x * x * 40.0) * exp(-vQ.y * vQ.y * 6.0);
    gl_FragColor = vec4(vCol * m * (s * rip + core * 1.5), 1.0);
    #ifdef USE_FOG
      float fogFactor = clamp(1.0 - exp(-uAtmoFog.z * 0.5 * vFogDepth), 0.0, 0.8);
      gl_FragColor.rgb *= 1.0 - fogFactor;
    #endif
  }`;

export class LightFx {
  constructor(scene, quality) {
    this.scene = scene; this.n = quality === 'low' ? 64 : MAXI;
    const P = this.pool = instGeo(this.n);
    this.poolMat = new THREE.ShaderMaterial({
      vertexShader: POOL_VS, fragmentShader: POOL_FS, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.poolMesh = new THREE.Mesh(P.g, this.poolMat); this.poolMesh.frustumCulled = false; this.poolMesh.renderOrder = 1;
    scene.add(this.poolMesh);
    const R = this.refl = instGeo(this.n);
    this.reflMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uWet: { value: atmo.wet } }]),
      vertexShader: REFL_VS, fragmentShader: REFL_FS, transparent: true, depthWrite: false, fog: true,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    this.reflMat.uniforms.uWet.value = atmo.wet;
    this.reflMesh = new THREE.Mesh(R.g, this.reflMat); this.reflMesh.frustumCulled = false; this.reflMesh.renderOrder = 2;
    scene.add(this.reflMesh);
    this._tmp = [];
  }

  update(dt, sources, focus, poolK, reflK) {
    this.reflMat.uniforms.uTime.value += dt;
    const cand = this._tmp; cand.length = 0;
    for (const s of sources) {
      if (!s.on || s.kind === 'pulse' || s.transient) continue;
      const dx = s.pos.x - focus.x, dz = s.pos.z - focus.z, d2 = dx * dx + dz * dz;
      if (d2 > 75 * 75) continue;
      s._d2 = d2; cand.push(s);
    }
    cand.sort((a, b) => a._d2 - b._d2);
    const n = Math.min(cand.length, this.n);
    const pp = this.pool.pos.array, pc = this.pool.col.array, rp = this.refl.pos.array, rc = this.refl.col.array;
    let np = 0, nr = 0;
    for (let i = 0; i < n; i++) {
      const s = cand[i], h = Math.max(0.4, s.pos.y), lv = (s.level ?? 1) * Math.min(1, (75 - Math.sqrt(s._d2)) / 15);
      const I = s.intensity * lv;
      // ground pool: only where no real light is currently doing the job
      const free = 1 - (s._lit || 0);
      if (free > 0.02) {
        const irr = Math.min(3.5, I / (h * h + 2)) * poolK * free;
        const r = Math.min(s.range * 0.55, 1.2 + h * 0.9);
        pp[np * 4] = s.pos.x; pp[np * 4 + 1] = h; pp[np * 4 + 2] = s.pos.z; pp[np * 4 + 3] = r;
        pc[np * 3] = s.color.r * irr; pc[np * 3 + 1] = s.color.g * irr; pc[np * 3 + 2] = s.color.b * irr; np++;
      }
      if (h > 0.8 && s.kind !== 'fire') {
        const k = Math.min(6, I * 0.05) * reflK;
        rp[nr * 4] = s.pos.x; rp[nr * 4 + 1] = h; rp[nr * 4 + 2] = s.pos.z; rp[nr * 4 + 3] = 1;
        rc[nr * 3] = s.color.r * k; rc[nr * 3 + 1] = s.color.g * k; rc[nr * 3 + 2] = s.color.b * k; nr++;
      }
    }
    this.pool.g.instanceCount = np; this.refl.g.instanceCount = nr;
    for (const a of [this.pool.pos, this.pool.col, this.refl.pos, this.refl.col]) a.needsUpdate = true;
    this.poolMesh.visible = np > 0; this.reflMesh.visible = nr > 0 && atmo.wet.x > 0.05;
  }
}

const RAIN_VS = `
  attribute vec4 aSeed; uniform float uTime; uniform vec3 uFocus; uniform vec3 uBox; uniform vec2 uWind;
  varying float vA;
  #include <fog_pars_vertex>
  void main(){
    float speed = 22.0 + aSeed.w * 8.0;
    vec3 p = aSeed.xyz * uBox;
    p.y = mod(p.y - uTime * speed, uBox.y);
    p.xz += uWind * (uBox.y - p.y) * 0.04;
    vec3 base = uFocus - vec3(uBox.x, 0.0, uBox.z) * 0.5;
    vec3 w = vec3(base.x + mod(p.x - base.x, uBox.x), p.y, base.z + mod(p.z - base.z, uBox.z));
    float tail = position.y; // 0 head, 1 tail
    w -= vec3(uWind.x * 0.04, -1.0, uWind.y * 0.04) * tail * (0.35 + aSeed.w * 0.3);
    vA = (1.0 - tail * 0.9) * smoothstep(0.0, 1.5, w.y) * (0.35 + 0.65 * aSeed.w);
    vec4 mvPosition = viewMatrix * vec4(w, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const RAIN_FS = `
  uniform vec3 uColor; varying float vA;
  #include <fog_pars_fragment>
  void main(){
    gl_FragColor = vec4(uColor * vA, 1.0);
    #ifdef USE_FOG
      gl_FragColor.rgb *= 1.0 - clamp(vFogDepth / 90.0, 0.0, 1.0);
    #endif
  }`;
const SPLASH_VS = `
  attribute vec4 aSeed; uniform float uTime; uniform vec3 uFocus; uniform vec3 uBox; uniform float uScale;
  varying float vA;
  float hh(float n){ return fract(sin(n) * 43758.5453); }
  void main(){
    float ph = uTime * (2.2 + aSeed.w) + aSeed.y * 10.0; float cyc = floor(ph), f = fract(ph);
    vec3 base = uFocus - vec3(uBox.x, 0.0, uBox.z) * 0.5;
    vec3 w = vec3(base.x + hh(cyc * 1.3 + aSeed.x * 91.0) * uBox.x, 0.2, base.z + hh(cyc * 2.7 + aSeed.z * 57.0) * uBox.z);
    vA = (1.0 - f) * (1.0 - f) * step(f, 0.5);
    vec4 mvPosition = viewMatrix * vec4(w, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = (0.04 + f * 0.16) * uScale / max(1.0, -mvPosition.z);
  }`;
const SPLASH_FS = `
  uniform vec3 uColor; varying float vA;
  void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c); float ring = smoothstep(0.5, 0.35, d) * smoothstep(0.15, 0.35, d);
    if (ring * vA < 0.01) discard; gl_FragColor = vec4(uColor * ring * vA * 0.8, 1.0); }`;

export class Rain {
  constructor(scene, quality, amount = 1) {
    const N = Math.round((quality === 'low' ? 1400 : quality === 'high' ? 5200 : 3200) * amount);
    const seed = new Float32Array(N * 2 * 4), pos = new Float32Array(N * 2 * 3);
    for (let i = 0; i < N; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      for (let k = 0; k < 2; k++) { seed.set(s, (i * 2 + k) * 4); pos[(i * 2 + k) * 3 + 1] = k; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    this.u = { uTime: { value: 0 }, uFocus: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(56, 26, 56) }, uWind: { value: new THREE.Vector2(3, 1.5) }, uColor: { value: new THREE.Color(0.1, 0.13, 0.16).multiplyScalar(amount > 0.6 ? 1 : 0.7) }, uScale: { value: 400 } };
    const mat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]), vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
    Object.assign(mat.uniforms, this.u);
    this.lines = new THREE.LineSegments(g, mat); this.lines.frustumCulled = false; this.lines.renderOrder = 6;
    scene.add(this.lines);
    const NS = Math.round(N * 0.18), ss = new Float32Array(NS * 4);
    for (let i = 0; i < NS * 4; i++) ss[i] = Math.random();
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NS * 3), 3)); sg.setAttribute('aSeed', new THREE.BufferAttribute(ss, 4));
    const smat = new THREE.ShaderMaterial({ uniforms: {}, vertexShader: SPLASH_VS, fragmentShader: SPLASH_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    smat.uniforms = { ...this.u, uBox: { value: new THREE.Vector3(40, 0, 40) } };
    this.splash = new THREE.Points(sg, smat); this.splash.frustumCulled = false; this.splash.renderOrder = 6;
    scene.add(this.splash);
  }
  update(dt, focus) { this.u.uTime.value += dt; this.u.uFocus.value.set(focus.x, 0, focus.z); this.u.uScale.value = innerHeight / (2 * Math.tan(18 * Math.PI / 180)); }
}
