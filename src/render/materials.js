// Shared PBR materials + geometry helpers (world-space box UVs, see-through cutout for walls).
import * as THREE from 'three';
import * as T from './textures.js';

// shared animated uniforms (environment.js re-exports uTime as worldUniforms.uTime; game.js ticks it)
export const matUniforms = { uTime: { value: 0 } };

export const cutUniforms = {
  uCutPos: { value: new THREE.Vector3(0, 1, 0) },
  uCutR: { value: 3.4 },
};

// Injects a dithered "see-through" hole around the player for occluding geometry.
export function applyCutout(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCutPos = cutUniforms.uCutPos; sh.uniforms.uCutR = cutUniforms.uCutR;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutW;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 cutw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cutw = instanceMatrix * cutw;
        #endif
        vCutW = (modelMatrix * cutw).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutW;\nuniform vec3 uCutPos;\nuniform float uCutR;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        {
          vec3 toP = uCutPos - cameraPosition; float lenP = length(toP); vec3 dP = toP / lenP;
          vec3 toF = vCutW - cameraPosition; float along = dot(toF, dP);
          // camera-side occluders (foreground buildings / roofs that fill the frame without covering the
          // player): tall geometry well in front of the player's focal plane is stippled ~70% see-through
          {
            float front = lenP - along;
            float kf = smoothstep(5.0, 11.0, front) * smoothstep(2.2, 4.5, vCutW.y) * 0.72;
            ivec2 fp = ivec2(mod(floor(gl_FragCoord.xy), 4.0));
            const float FM[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
            if (kf > (FM[fp.x + fp.y * 4] + 0.5) / 16.0) discard;
          }
          if (along < lenP - 0.8 && vCutW.y > 0.25) {
            float d = length(toF - dP * along);
            float fade = smoothstep(0.0, 2.5, lenP - along);
            float r = uCutR * fade * clamp(along / lenP, 0.0, 1.0); // constant screen-space radius
            ivec2 bp = ivec2(mod(floor(gl_FragCoord.xy), 4.0));
            const float BM[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
            float bayer = (BM[bp.x + bp.y * 4] + 0.5) / 16.0;
            float k = 1.0 - smoothstep(r * 0.55, r, d);
            if (k > bayer * 0.9 + 0.05) discard;
          }
        }`);
  };
  mat.customProgramCacheKey = () => 'cutout';
  return mat;
}

// Foliage cards are double sided but should not flip their (up-facing) normals on back faces.
export function foliage(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
  };
  const key = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.customProgramCacheKey = () => key + '|foliage';
  return mat;
}

// Emissive flicker for signage: vertex colour R carries a per-sign seed (>=0.75 steady, below = faulty tube).
function emissiveVC(mat) { // emissive tinted by vertex colour (one material, many window colours)
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => { if (prev) prev.call(mat, sh, r); sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance *= vColor.rgb;'); };
  const key = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.customProgramCacheKey = () => key + '|evc';
  return mat;
}
function neonFlicker(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    sh.uniforms.uTime = matUniforms.uTime;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float s = vColor.r;
          if (s < 0.75) {
            float t = uTime * 0.6 + s * 37.0;
            float burst = step(0.62, fract(sin(floor(t) * 12.9898 + s * 78.2) * 43758.5453));
            float st = step(0.45, fract(sin(floor(uTime * 17.0) * (s * 91.7 + 1.3)) * 43758.5453));
            totalEmissiveRadiance *= mix(1.0, 0.04 + 0.96 * st, burst);
          }
        }`);
  };
  const key = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.customProgramCacheKey = () => key + '|neon';
  return mat;
}

// World-space wet patches for ground materials: large non-repeating puddle zones with low roughness,
// darker albedo and a slight normal flattening (reads as standing water / damp asphalt).
export const wetUniforms = { uWet: { value: 0.55 } };
function wet(mat, scale = 0.055, amount = 1) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    sh.uniforms.uWet = wetUniforms.uWet;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWetW;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 wetw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wetw = instanceMatrix * wetw;
        #endif
        vWetW = (modelMatrix * wetw).xyz;`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vWetW; uniform float uWet;
      float wh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float wn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(wh(i), wh(i + vec2(1, 0)), f.x), mix(wh(i + vec2(0, 1)), wh(i + vec2(1, 1)), f.x), f.y); }
      float wetMask() { vec2 p = vWetW.xz * ${scale.toFixed(4)};
        float n = wn(p) * 0.55 + wn(p * 2.3 + 7.1) * 0.3 + wn(p * 6.1 + 3.3) * 0.15;
        return smoothstep(1.0 - uWet * 0.75, 1.0 - uWet * 0.75 + 0.08, n) * ${amount.toFixed(2)}; }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float wetK = wetMask();
        roughnessFactor = mix(roughnessFactor, 0.06, wetK);
        diffuseColor.rgb *= mix(1.0, 0.72, wetK);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize(mix(normal, normalize(vNormal), wetMask() * 0.85));`);
  };
  const key = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.customProgramCacheKey = () => key + '|wet' + scale + amount;
  return mat;
}

function std(tex, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.roughnessMap,
    metalnessMap: opts.metal ? tex.roughnessMap : null,
    roughness: 1, metalness: opts.metal ? 1 : 0, ...opts.extra,
  });
  if (opts.normalScale) m.normalScale.set(opts.normalScale, opts.normalScale);
  return m;
}

let M = null;
export function materials() {
  if (M) return M;
  M = {};
  M.asphalt = wet(std(T.asphalt(), { normalScale: 1.0, extra: { envMapIntensity: 1.5 } }), 0.055, 1);
  M.ground = wet(std(T.dirt(), { normalScale: 1.0 }), 0.04, 0.6);
  M.pavers = wet(std(T.pavers(), { normalScale: 0.8, extra: { envMapIntensity: 1.4 } }), 0.07, 0.8);
  M.concrete = std(T.concrete(), { normalScale: 0.6 });
  M.concreteWall = applyCutout(std(T.concrete(), { normalScale: 0.7, extra: { vertexColors: true } }));
  M.brickWall = applyCutout(std(T.brick(), { normalScale: 1.0, extra: { vertexColors: true } }));
  M.plasterWall = applyCutout(std(T.plaster(), { normalScale: 0.6, extra: { vertexColors: true } }));
  M.slab = applyCutout(std(T.concrete(), { normalScale: 0.6, extra: { vertexColors: true } }));
  M.rubble = std(T.concrete(), { normalScale: 1.2, extra: { color: 0x9a948a } });
  M.brickRubble = std(T.brick(), { normalScale: 1.2 });
  M.corrugated = std(T.corrugated(), { metal: true, normalScale: 1 });
  M.container = [
    std(T.paintedSheet('c1', [0.36, 0.08, 0.05]), { metal: true }),
    std(T.paintedSheet('c2', [0.06, 0.15, 0.22]), { metal: true }),
    std(T.paintedSheet('c3', [0.1, 0.18, 0.08]), { metal: true }),
    std(T.paintedSheet('c4', [0.42, 0.3, 0.06]), { metal: true }),
  ];
  M.containerCorr = M.container;
  // vehicle paints: dielectric paint with scratches/rust (metalness only in scratches); last = burnt
  M.carPaint = [
    ['red', [0.32, 0.05, 0.04]], ['navy', [0.07, 0.11, 0.18]], ['white', [0.4, 0.4, 0.38]], ['olive', [0.16, 0.18, 0.11]],
    ['beige', [0.42, 0.35, 0.22]], ['silver', [0.33, 0.34, 0.35]], ['taxi', [0.5, 0.34, 0.04]], ['black', [0.03, 0.03, 0.035]], ['teal', [0.06, 0.2, 0.2]],
  ].map(([k, c]) => std(T.carPaint(k, c), { metal: true, normalScale: 0.7, extra: { envMapIntensity: 1.6, vertexColors: true } }));
  M.carBurnt = std(T.burntMetal(), { metal: true, normalScale: 1.2, extra: { vertexColors: true } });
  M.carPaint.push(M.carBurnt); // legacy index 'burnt'
  M.carGlass = new THREE.MeshStandardMaterial({ color: 0x0c1014, roughness: 0.06, metalness: 0.2, envMapIntensity: 2.5 });
  M.headlight = new THREE.MeshStandardMaterial({ color: 0x9a9890, roughness: 0.15, metalness: 0.5, emissive: 0x302a20, emissiveIntensity: 0.6 });
  M.taillight = new THREE.MeshStandardMaterial({ color: 0x3a0604, roughness: 0.2, emissive: 0x400404, emissiveIntensity: 0.8 });
  M.plate = new THREE.MeshStandardMaterial({ color: 0xb8b090, roughness: 0.6 });
  M.rim = new THREE.MeshStandardMaterial({ color: 0x55575a, roughness: 0.4, metalness: 1 });
  M.interior = new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 0.95 });
  M.carDetail = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.55, vertexColors: true, envMapIntensity: 1.5 });
  M.metal = std(T.rustMetal('dark', [0.18, 0.18, 0.19]), { metal: true });
  M.rust = std(T.rustMetal('rusty', [0.3, 0.14, 0.07]), { metal: true });
  M.wood = std(T.wood(), {});
  M.sandbag = std(T.fabric(), { extra: { color: 0x8a7a58 } });
  M.tire = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  M.glass = new THREE.MeshStandardMaterial({ color: 0x1a2026, roughness: 0.12, metalness: 0.4, envMapIntensity: 3 });
  M.chrome = new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.35, metalness: 1 });
  M.black = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.8 });
  M.rebar = new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.7, metalness: 0.6 });
  M.lampOn = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffb060, emissiveIntensity: 6 });
  M.redLight = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff2010, emissiveIntensity: 5 });
  M.grass = foliage(new THREE.MeshStandardMaterial({ map: T.grassCard(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.95, color: 0xffffff }));
  M.leaves = foliage(new THREE.MeshStandardMaterial({ map: T.leafCard(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9, color: 0xffffff }));
  M.vines = foliage(applyCutout(new THREE.MeshStandardMaterial({ map: T.vineCard(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9, color: 0xffffff })));
  M.graffiti = applyCutout(new THREE.MeshStandardMaterial({ map: T.graffitiAtlas(), transparent: true, depthWrite: false, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  M.trim = applyCutout(std(T.concrete(), { normalScale: 0.5, extra: { vertexColors: true, color: 0xb0aca4 } }));
  M.bark = new THREE.MeshStandardMaterial({ color: 0x2a2219, roughness: 1 });
  // --- building kit ---
  for (const st of ['concrete', 'brick', 'plaster']) {
    const f = T.facade(st);
    M['facade_' + st] = applyCutout(std(f, { normalScale: 0.8, extra: { vertexColors: true, emissiveMap: f.emissiveMap, emissive: 0xffffff, emissiveIntensity: 3.2 } }));
  }
  M.deckTop = wet(applyCutout(std(T.asphalt(), { normalScale: 1.0, extra: { vertexColors: true, envMapIntensity: 1.5 } })), 0.06, 0.9);
  M.roof = applyCutout(std(T.roofing(), { normalScale: 0.8, extra: { vertexColors: true } }));
  M.shutter = applyCutout(std(T.shutter(), { metal: true, extra: { vertexColors: true } }));
  M.frame = applyCutout(new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.55, metalness: 0.6, vertexColors: true }));
  M.pane = applyCutout(new THREE.MeshStandardMaterial({ color: 0x141a20, roughness: 0.05, metalness: 0.3, envMapIntensity: 2.5, vertexColors: true }));
  M.interiorDark = applyCutout(new THREE.MeshStandardMaterial({ color: 0x0b0a09, roughness: 1, vertexColors: true }));
  M.kitMetal = applyCutout(std(T.rustMetal('kit', [0.42, 0.42, 0.4]), { metal: true, extra: { vertexColors: true } }));
  M.kitRust = applyCutout(std(T.rustMetal('kitr', [0.26, 0.13, 0.07]), { metal: true, extra: { vertexColors: true } }));
  M.awning = applyCutout(std(T.fabric(), { extra: { vertexColors: true, side: THREE.DoubleSide } }));
  M.poster = applyCutout(new THREE.MeshStandardMaterial({ map: T.posterAtlas(), alphaTest: 0.5, roughness: 0.85, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  const sa = T.signAtlas();
  M.neon = neonFlicker(applyCutout(new THREE.MeshStandardMaterial({ map: sa.map, emissiveMap: sa.emissiveMap, emissive: 0xffffff, emissiveIntensity: 2.4, roughness: 0.5, vertexColors: true })));
  M.signDead = applyCutout(new THREE.MeshStandardMaterial({ map: sa.map, roughness: 0.6, vertexColors: true, emissiveMap: sa.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.05 }));
  M.windowLit = emissiveVC(applyCutout(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 1.6, vertexColors: true, roughness: 0.4 })));
  M.bulb = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc070, emissiveIntensity: 5 });
  M.bulbCold = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x80d8ff, emissiveIntensity: 4 });
  M.cable = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.6 });
  // --- street clutter ---
  M.plastic = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, vertexColors: true, envMapIntensity: 1.4 });
  M.paint = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.3, vertexColors: true });
  M.cardboard = std(T.cardboard(), { normalScale: 0.8 });
  M.crate = std(T.crateWood(), { normalScale: 1.0 });
  M.foliage = foliage(new THREE.MeshStandardMaterial({ map: T.leafBright(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.75, vertexColors: true }));
  M.paper = new THREE.MeshStandardMaterial({ color: 0xc8c0aa, roughness: 0.9, side: THREE.DoubleSide });
  return M;
}

// Assign UVs by projecting each vertex along its dominant normal axis (world units * scale).
export function boxUV(geo, scale = 0.33, offset = [0, 0]) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = p.getX(i); v = p.getZ(i); }
    else if (nx >= nz) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u * scale + offset[0]; uv[i * 2 + 1] = v * scale + offset[1];
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

export function colorize(geo, color) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}

// Accumulates transformed geometries per material and merges into few meshes.
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
export class GeoBatch {
  constructor() { this.groups = new Map(); }
  add(mat, geo) {
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox, CH = 44;
    const key = mat.uuid + ':' + Math.floor((bb.min.x + bb.max.x) / 2 / CH) + ',' + Math.floor((bb.min.z + bb.max.z) / 2 / CH);
    if (!this.groups.has(key)) this.groups.set(key, { mat, list: [] });
    const g = geo.index ? geo.toNonIndexed() : geo;
    // normalize attributes so merges succeed
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.color) colorize(g, 0xffffff);
    if (!g.attributes.uv) boxUV(g);
    this.groups.get(key).list.push(g);
  }
  build(parent, { cast = true, receive = true } = {}) {
    const meshes = [];
    // grouped by material + spatial chunk so frustum culling stays effective
    for (const { mat, list } of this.groups.values()) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const m = new THREE.Mesh(merged, mat); m.castShadow = cast; m.receiveShadow = receive;
      parent.add(m); meshes.push(m);
    }
    return meshes;
  }
}
