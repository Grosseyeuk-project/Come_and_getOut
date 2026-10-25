// Shared PBR materials + geometry helpers (world-space box UVs, see-through cutout for walls).
import * as THREE from 'three';
import * as T from './textures.js';

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
          if (along < lenP - 0.8 && vCutW.y > 0.25) {
            float d = length(toF - dP * along);
            float fade = smoothstep(0.0, 2.5, lenP - along);
            float r = uCutR * fade;
            float bayer = fract(dot(floor(gl_FragCoord.xy), vec2(0.5, 0.25)) + fract(floor(gl_FragCoord.y) * 0.5) * 0.5);
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
  M.asphalt = std(T.asphalt(), { normalScale: 0.8 });
  M.ground = std(T.dirt(), { normalScale: 1.0 });
  M.pavers = std(T.pavers(), { normalScale: 0.7 });
  M.concrete = std(T.concrete(), { normalScale: 0.6 });
  M.concreteWall = applyCutout(std(T.concrete(), { normalScale: 0.7, extra: { vertexColors: true } }));
  M.brickWall = applyCutout(std(T.brick(), { normalScale: 1.0, extra: { vertexColors: true } }));
  M.plasterWall = applyCutout(std(T.plaster(), { normalScale: 0.6, extra: { vertexColors: true } }));
  M.slab = applyCutout(std(T.concrete(), { normalScale: 0.6, extra: { vertexColors: true } }));
  M.rubble = std(T.concrete(), { normalScale: 1.2, extra: { color: 0x9a948a } });
  M.brickRubble = std(T.brick(), { normalScale: 1.2 });
  M.corrugated = std(T.corrugated(), { metal: true, normalScale: 1 });
  M.container = [
    std(T.rustMetal('c1', [0.45, 0.12, 0.08]), { metal: true }),
    std(T.rustMetal('c2', [0.1, 0.22, 0.3]), { metal: true }),
    std(T.rustMetal('c3', [0.15, 0.25, 0.12]), { metal: true }),
    std(T.rustMetal('c4', [0.45, 0.35, 0.1]), { metal: true }),
  ];
  M.carPaint = [
    std(T.rustMetal('p1', [0.36, 0.06, 0.05]), { metal: true }),
    std(T.rustMetal('p2', [0.1, 0.16, 0.24]), { metal: true }),
    std(T.rustMetal('p3', [0.5, 0.5, 0.48]), { metal: true }),
    std(T.rustMetal('p4', [0.2, 0.22, 0.14]), { metal: true }),
    std(T.rustMetal('p5', [0.45, 0.38, 0.22]), { metal: true }),
    std(T.rustMetal('burnt', [0.05, 0.045, 0.04]), { metal: true }),
  ];
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
    const bb = geo.boundingBox, CH = 28;
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
