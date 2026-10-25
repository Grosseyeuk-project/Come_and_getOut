// Procedural prop models. Each builder returns an array of { mat, geo } parts in local space
// (origin on the ground at the prop centre, +X = forward/length). environment.js merges them.
import * as THREE from 'three';
import { materials } from '../render/materials.js';
import { RNG } from '../core/rng.js';

const V = THREE.Vector3;
function box(w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.applyMatrix4(new THREE.Matrix4().compose(new V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new V(1, 1, 1)));
  return g;
}
function cyl(rt, rb, h, seg, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, open = false) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
  g.applyMatrix4(new THREE.Matrix4().compose(new V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new V(1, 1, 1)));
  return g;
}
function extrude(pts, depth, bevel = 0.05, curve = 4) {
  const s = new THREE.Shape(); pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y))); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: curve });
  g.translate(0, 0, -depth / 2);
  return g;
}
const xf = (g, x, y, z, rx = 0, ry = 0, rz = 0, s = 1) => { g.applyMatrix4(new THREE.Matrix4().compose(new V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new V(s, s, s))); return g; };

// ---------- Vehicles ----------
const carCache = new Map();
export function carParts(variant, paint, burnt) {
  const key = variant + ':' + paint + ':' + burnt;
  if (carCache.has(key)) return carCache.get(key).map((p) => ({ mat: p.mat, geo: p.geo.clone() }));
  const M = materials();
  const body = burnt ? M.carPaint[5] : M.carPaint[paint % 5];
  const glass = burnt ? M.black : M.glass;
  const parts = [];
  const W = variant === 1 ? 1.9 : 1.72;
  let wheelX = 1.38, wheelR = 0.36;
  if (variant === 0) { // sedan
    parts.push({ mat: body, geo: extrude([[-2.25, 0.32], [2.15, 0.32], [2.3, 0.5], [2.27, 0.82], [1.05, 0.96], [-1.55, 1.0], [-2.28, 0.93], [-2.32, 0.55]], W - 0.12, 0.06) });
    parts.push({ mat: glass, geo: extrude([[1.05, 0.9], [0.25, 1.38], [-0.95, 1.42], [-1.6, 0.98]], W - 0.36, 0.04) });
    parts.push({ mat: body, geo: box(1.18, 0.06, W - 0.3, -0.35, 1.44, 0) });
  } else if (variant === 1) { // van
    wheelX = 1.5; wheelR = 0.38;
    parts.push({ mat: body, geo: extrude([[-2.45, 0.35], [2.3, 0.35], [2.42, 0.6], [2.38, 1.0], [1.7, 1.22], [1.25, 1.95], [-2.45, 2.02]], W - 0.12, 0.06) });
    parts.push({ mat: glass, geo: extrude([[1.72, 1.18], [1.27, 1.88], [0.95, 1.9], [0.95, 1.2]], W - 0.06, 0.03) });
    parts.push({ mat: glass, geo: box(0.9, 0.42, W + 0.01, 0.2, 1.55, 0) });
  } else { // pickup
    wheelX = 1.55; wheelR = 0.4;
    parts.push({ mat: body, geo: extrude([[-0.3, 0.4], [2.3, 0.4], [2.45, 0.65], [2.4, 1.05], [1.3, 1.15], [0.75, 1.75], [-0.35, 1.78]], W - 0.12, 0.06) });
    parts.push({ mat: glass, geo: extrude([[1.3, 1.1], [0.78, 1.68], [0.2, 1.7], [0.2, 1.12]], W - 0.1, 0.03) });
    parts.push({ mat: body, geo: box(2.3, 0.12, W, -1.5, 0.55, 0) });
    parts.push({ mat: body, geo: box(2.3, 0.5, 0.08, -1.5, 0.85, W / 2 - 0.04) });
    parts.push({ mat: body, geo: box(2.3, 0.5, 0.08, -1.5, 0.85, -W / 2 + 0.04) });
    parts.push({ mat: body, geo: box(0.08, 0.5, W, -2.62, 0.85, 0) });
    parts.push({ mat: M.rust, geo: box(0.9, 0.3, 0.7, -1.6, 0.76, 0.2, 0, 0.4, 0) });
  }
  // bumpers, lights
  parts.push({ mat: burnt ? M.black : M.chrome, geo: box(0.12, 0.16, W - 0.1, variant === 2 ? 2.47 : 2.33, 0.45, 0) });
  parts.push({ mat: M.black, geo: box(0.12, 0.16, W - 0.1, variant === 1 ? -2.5 : variant === 2 ? -2.68 : -2.36, 0.45, 0) });
  if (!burnt) {
    parts.push({ mat: M.lampOn === null ? M.chrome : M.chrome, geo: box(0.05, 0.12, 0.32, variant === 2 ? 2.46 : 2.3, 0.72, W / 2 - 0.3) });
    parts.push({ mat: M.chrome, geo: box(0.05, 0.12, 0.32, variant === 2 ? 2.46 : 2.3, 0.72, -W / 2 + 0.3) });
  }
  // wheels
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * wheelX - (variant === 2 && sx < 0 ? 0.6 : 0), z = sz * (W / 2 - 0.12);
    if (burnt) parts.push({ mat: M.rust, geo: cyl(wheelR * 0.62, wheelR * 0.62, 0.18, 10, x, wheelR * 0.62, z, Math.PI / 2) });
    else {
      parts.push({ mat: M.tire, geo: cyl(wheelR, wheelR, 0.26, 14, x, wheelR, z, Math.PI / 2) });
      parts.push({ mat: M.metal, geo: cyl(wheelR * 0.55, wheelR * 0.55, 0.28, 8, x, wheelR, z, Math.PI / 2) });
    }
  }
  // underside shadow block
  parts.push({ mat: M.black, geo: box(variant === 1 ? 4.6 : 4.2, 0.25, W - 0.3, 0, 0.3, 0) });
  carCache.set(key, parts.map((p) => ({ mat: p.mat, geo: p.geo })));
  return parts.map((p) => ({ mat: p.mat, geo: p.geo.clone() }));
}
export function carSize(variant) { return variant === 1 ? [2.5, 1.0, 2.05] : variant === 2 ? [2.7, 0.95, 1.85] : [2.35, 0.92, 1.45]; }

// ---------- Barricades ----------
export function jerseyParts(len = 2.6) {
  const M = materials();
  const g = extrude([[-0.32, 0], [0.32, 0], [0.25, 0.12], [0.09, 0.32], [0.08, 0.82], [-0.08, 0.82], [-0.09, 0.32], [-0.25, 0.12]], len - 0.06, 0.03, 1);
  g.rotateY(Math.PI / 2);
  return [{ mat: M.rubble, geo: g }];
}
export function sandbagParts(len = 3, rng = new RNG(1)) {
  const M = materials();
  const parts = [];
  const proto = new THREE.SphereGeometry(1, 9, 6);
  const rows = 3;
  for (let r = 0; r < rows; r++) {
    const n = Math.floor(len / 0.62) - (r % 2);
    for (let i = 0; i < n; i++) {
      const x = -len / 2 + 0.31 + i * 0.62 + (r % 2) * 0.31;
      const g = proto.clone(); g.scale(0.33, 0.14, 0.24);
      xf(g, x + rng.range(-0.03, 0.03), 0.13 + r * 0.25, rng.range(-0.04, 0.04), 0, rng.range(-0.15, 0.15), rng.range(-0.08, 0.08));
      parts.push({ mat: M.sandbag, geo: g });
    }
  }
  return parts;
}
export function plankParts(len = 2.6, rng = new RNG(2)) {
  const M = materials(); const parts = [];
  parts.push({ mat: M.wood, geo: box(0.14, 1.5, 0.14, -len / 2 + 0.15, 0.75, 0) });
  parts.push({ mat: M.wood, geo: box(0.14, 1.4, 0.14, len / 2 - 0.15, 0.7, 0, 0, 0, 0.05) });
  for (let i = 0; i < 4; i++) parts.push({ mat: M.wood, geo: box(len, 0.22, 0.05, 0, 0.3 + i * 0.32 + rng.range(-0.05, 0.05), 0.09, 0, 0, rng.range(-0.12, 0.12)) });
  parts.push({ mat: M.rust, geo: box(len * 1.05, 0.08, 0.06, 0, 0.8, 0.14, 0, 0, 0.45) });
  return parts;
}
export function tireParts(rng = new RNG(3)) {
  const M = materials(); const parts = [];
  const proto = new THREE.TorusGeometry(0.31, 0.13, 8, 16); proto.rotateX(Math.PI / 2);
  const stacks = rng.int(1, 3);
  for (let s = 0; s < stacks; s++) {
    const ox = (s - (stacks - 1) / 2) * 0.75, h = rng.int(2, 4);
    for (let i = 0; i < h; i++) { const g = proto.clone(); xf(g, ox + rng.range(-0.05, 0.05), 0.13 + i * 0.24, rng.range(-0.05, 0.05), rng.range(-0.05, 0.05), 0, rng.range(-0.05, 0.05)); parts.push({ mat: M.tire, geo: g }); }
  }
  return parts;
}
export function barrelParts(rng = new RNG(4)) {
  const M = materials();
  const mat = rng.pick([M.rust, M.container[0], M.container[1], M.metal]);
  const parts = [{ mat, geo: cyl(0.3, 0.3, 0.9, 14, 0, 0.45, 0) }];
  for (const y of [0.3, 0.6]) parts.push({ mat: M.rust, geo: xf(new THREE.TorusGeometry(0.3, 0.018, 4, 16), 0, y, 0, Math.PI / 2) });
  parts.push({ mat: M.black, geo: cyl(0.27, 0.27, 0.02, 14, 0, 0.9, 0) });
  return parts;
}
export function containerParts(colorIdx = 0) {
  const M = materials();
  const mat = M.containerCorr ? M.containerCorr[colorIdx] : (M.containerCorr = M.container.map((m) => { const c = m.clone(); c.normalMap = materials().corrugated.normalMap; c.normalScale.set(1.2, 1.2); return c; }))[colorIdx];
  const parts = [{ mat, geo: box(6.06, 2.5, 2.44, 0, 1.3, 0) }];
  // corner castings + frame
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push({ mat: M.metal, geo: box(0.18, 2.6, 0.18, sx * 2.95, 1.3, sz * 1.13) });
  parts.push({ mat: M.metal, geo: box(6.1, 0.12, 2.5, 0, 0.06, 0) });
  // door bars
  for (const z of [-0.8, -0.3, 0.3, 0.8]) parts.push({ mat: M.chrome, geo: cyl(0.025, 0.025, 2.3, 5, 3.05, 1.3, z) });
  return parts;
}
export function dumpsterParts() {
  const M = materials();
  return [
    { mat: M.container[2], geo: box(1.9, 1.15, 1.1, 0, 0.67, 0) },
    { mat: M.metal, geo: box(1.95, 0.06, 1.15, 0, 1.3, -0.2, -0.5, 0, 0) },
    { mat: M.black, geo: box(1.7, 0.02, 0.9, 0, 1.24, 0) },
    ...[-0.8, 0.8].map((x) => ({ mat: M.tire, geo: cyl(0.08, 0.08, 0.1, 8, x, 0.08, 0.45, Math.PI / 2) })),
  ];
}
export function lampParts(bent = false, working = true) {
  const M = materials();
  const parts = [
    { mat: M.metal, geo: cyl(0.07, 0.11, 6.2, 8, 0, 3.1, 0) },
    { mat: M.metal, geo: cyl(0.16, 0.2, 0.5, 8, 0, 0.25, 0) },
    { mat: M.metal, geo: cyl(0.045, 0.045, 1.6, 6, 0.75, 6.05, 0, 0, 0, Math.PI / 2 - 0.15) },
    { mat: M.metal, geo: box(0.6, 0.14, 0.28, 1.55, 6.1, 0) },
    { mat: working ? M.lampOn : M.glass, geo: box(0.48, 0.04, 0.2, 1.55, 6.02, 0) },
  ];
  if (bent) for (const p of parts) if (p.geo) { p.geo.translate(0, 0, 0); p.geo.applyMatrix4(new THREE.Matrix4().makeRotationZ(-0.35)); }
  return parts;
}
export function trafficLightParts(working) {
  const M = materials();
  return [
    { mat: M.metal, geo: cyl(0.08, 0.1, 4.2, 8, 0, 2.1, 0) },
    { mat: M.metal, geo: cyl(0.05, 0.05, 3.2, 6, 1.6, 4.1, 0, 0, 0, Math.PI / 2) },
    { mat: M.black, geo: box(0.32, 0.95, 0.3, 3.1, 3.7, 0) },
    { mat: working ? M.redLight : M.glass, geo: cyl(0.09, 0.09, 0.04, 10, 3.1, 4.0, 0.16, Math.PI / 2) },
    { mat: M.glass, geo: cyl(0.09, 0.09, 0.04, 10, 3.1, 3.7, 0.16, Math.PI / 2) },
    { mat: M.glass, geo: cyl(0.09, 0.09, 0.04, 10, 3.1, 3.4, 0.16, Math.PI / 2) },
  ];
}
export function tentParts(rng = new RNG(5)) {
  const M = materials();
  if (!M.tentCloth) M.tentCloth = [0x5a5040, 0x3e4a3a, 0x6a4a34, 0x4a4a4c].map((c) => { const m = M.sandbag.clone(); m.color.set(c); m.side = THREE.DoubleSide; return m; });
  const mat = rng.pick(M.tentCloth);
  const g = new THREE.ConeGeometry(1.9, 1.9, 4, 1, true); g.rotateY(Math.PI / 4); g.scale(1.4, 1, 1); g.translate(0, 0.95, 0);
  const pa = g.attributes.position; // sag the cloth
  for (let i = 0; i < pa.count; i++) { const y = pa.getY(i); if (y < 1.8 && y > 0.1) pa.setY(i, y - 0.08); }
  g.computeVertexNormals();
  return [{ mat, geo: g }, { mat: M.wood, geo: cyl(0.03, 0.03, 2.0, 5, 0, 1.0, 0) }, { mat: M.fabric || M.sandbag, geo: box(1.2, 0.15, 0.8, 0.3, 0.08, 0.2) }];
}
export function benchParts() {
  const M = materials();
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push({ mat: M.wood, geo: box(1.8, 0.04, 0.12, 0, 0.45, -0.18 + i * 0.15) });
  for (let i = 0; i < 2; i++) parts.push({ mat: M.wood, geo: box(1.8, 0.12, 0.04, 0, 0.65 + i * 0.16, -0.3, -0.2, 0, 0) });
  for (const x of [-0.75, 0.75]) parts.push({ mat: M.metal, geo: box(0.06, 0.45, 0.5, x, 0.22, -0.05) });
  return parts;
}
export function fenceParts(len, rng = new RNG(6)) {
  const M = materials();
  if (!M.chainlink) {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    g.strokeStyle = 'rgba(150,150,150,1)'; g.lineWidth = 2.2;
    for (let i = -128; i < 256; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 128, 128); g.stroke(); g.beginPath(); g.moveTo(i + 128, 0); g.lineTo(i, 128); g.stroke(); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    M.chainlink = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide, metalness: 0.8, roughness: 0.5, color: 0x8a8a86 });
  }
  const parts = [];
  const n = Math.ceil(len / 2.5);
  for (let i = 0; i <= n; i++) parts.push({ mat: M.metal, geo: cyl(0.04, 0.04, 2.1, 6, -len / 2 + (i * len) / n, 1.05, 0, rng.range(-0.05, 0.05), 0, rng.range(-0.05, 0.05)) });
  const pg = new THREE.PlaneGeometry(len, 2.0, 8, 2);
  const pa = pg.attributes.position; for (let i = 0; i < pa.count; i++) pa.setZ(i, Math.sin(pa.getX(i) * 1.3) * 0.06 + rng.range(-0.03, 0.03));
  pg.computeVertexNormals(); pg.translate(0, 1.0, 0);
  const uv = pg.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len / 0.8, uv.getY(i) * 2 / 0.8);
  parts.push({ mat: M.chainlink, geo: pg });
  return parts;
}
export function lightRigParts() {
  const M = materials();
  const parts = [];
  for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; parts.push({ mat: M.metal, geo: cyl(0.03, 0.03, 2.9, 5, Math.cos(a) * 0.45, 1.4, Math.sin(a) * 0.45, Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3) }); }
  parts.push({ mat: M.metal, geo: box(0.5, 0.35, 0.3, 0, 2.85, 0, 0, 0, -0.4) });
  parts.push({ mat: M.lampOn, geo: box(0.04, 0.28, 0.24, 0.26, 2.75, 0, 0, 0, -0.4) });
  return parts;
}

// ---------- Foliage ----------
export function deadTreeParts(rng, s = 1, leaves = false) {
  const M = materials();
  const parts = [];
  const branch = (p, dir, len, r, depth) => {
    const end = p.clone().addScaledVector(dir, len);
    const g = new THREE.CylinderGeometry(r * 0.65, r, len, 6, 1, true);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V(0, 1, 0), dir));
    g.translate(p.x, p.y, p.z);
    parts.push({ mat: M.bark, geo: g });
    if (depth <= 0 || r < 0.025) {
      if (leaves) { const lg = leafClump(rng, 0.9 + rng.next() * 0.8); lg.translate(end.x, end.y, end.z); parts.push({ mat: M.leaves, geo: lg }); }
      return;
    }
    const n = rng.int(2, 3);
    for (let i = 0; i < n; i++) {
      const nd = dir.clone().add(new V(rng.range(-0.9, 0.9), rng.range(-0.1, 0.5), rng.range(-0.9, 0.9))).normalize();
      branch(end, nd, len * rng.range(0.55, 0.8), r * 0.62, depth - 1);
    }
  };
  branch(new V(0, 0, 0), new V(rng.range(-0.1, 0.1), 1, rng.range(-0.1, 0.1)).normalize(), 2.2 * s, 0.16 * s, 3);
  return parts;
}
function leafClump(rng, s) {
  const gs = [];
  for (let i = 0; i < 3; i++) { const g = new THREE.PlaneGeometry(1.6 * s, 1.6 * s); g.rotateY((i / 3) * Math.PI + rng.range(0, 0.4)); g.rotateX(rng.range(-0.4, 0.4)); gs.push(g); }
  const pg = new THREE.PlaneGeometry(1.6 * s, 1.6 * s); pg.rotateX(-Math.PI / 2); gs.push(pg);
  const merged = mergeSimple(gs);
  const n = merged.attributes.normal, p = merged.attributes.position; // spherical-ish normals: soft canopy shading
  for (let i = 0; i < n.count; i++) { const x = p.getX(i), y = p.getY(i) + 0.6 * s, z = p.getZ(i), l = Math.hypot(x, y, z) || 1; n.setXYZ(i, x / l, y / l, z / l); }
  return merged;
}
export function bushParts(rng, s = 1) {
  const M = materials(); const parts = [];
  for (let i = 0; i < rng.int(2, 4); i++) { const g = leafClump(rng, s * rng.range(0.6, 1)); g.translate(rng.range(-0.5, 0.5) * s, 0.45 * s + rng.range(0, 0.3), rng.range(-0.5, 0.5) * s); parts.push({ mat: M.leaves, geo: g }); }
  return parts;
}
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
function mergeSimple(gs) { return mergeGeometries(gs.map((g) => (g.index ? g.toNonIndexed() : g)), false); }
