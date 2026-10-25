// Procedural prop models. Each builder returns an array of { mat, geo } parts in local space
// (origin on the ground at the prop centre, +X = forward/length). environment.js merges them.
import * as THREE from 'three';
import { materials, boxUV, colorize } from '../render/materials.js';
import { RNG } from '../core/rng.js';

const V = THREE.Vector3;
export function box(w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.applyMatrix4(new THREE.Matrix4().compose(new V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new V(1, 1, 1)));
  return g;
}
export function cyl(rt, rb, h, seg, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, open = false) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
  g.applyMatrix4(new THREE.Matrix4().compose(new V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new V(1, 1, 1)));
  return g;
}
export function extrude(pts, depth, bevel = 0.05, curve = 4) {
  // pts: [x, y] points, or { arc: [cx, cy, r] } to cut a wheel arch into the outline
  const s = new THREE.Shape();
  pts.forEach((p, i) => { if (p.arc) { const [cx, cy, r] = p.arc; s.lineTo(cx - r, cy); s.absarc(cx, cy, r, Math.PI, 0, true); } else if (i) s.lineTo(p[0], p[1]); else s.moveTo(p[0], p[1]); });
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: curve });
  g.translate(0, 0, -depth / 2);
  return g;
}
export const xf = (g, x, y, z, rx = 0, ry = 0, rz = 0, s = 1) => { g.applyMatrix4(new THREE.Matrix4().compose(new V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new V(s, s, s))); return g; };

// ---------- Vehicles ----------
// variants: 0 sedan, 1 van, 2 pickup, 3 hatchback, 4 box truck, 5 bus. paint: index into M.carPaint (0..8).
const carCache = new Map();
const PAINTS = 9;
function wheel(parts, M, x, z, r, burnt, side) {
  if (burnt) {
    parts.push({ mat: M.carBurnt, geo: cyl(r * 0.7, r * 0.7, 0.16, 14, x, r * 0.7, z, Math.PI / 2) });
    parts.push({ mat: M.rust, geo: cyl(r * 0.45, r * 0.45, 0.2, 8, x, r * 0.7, z, Math.PI / 2) });
    return;
  }
  parts.push({ mat: M.tire, geo: cyl(r, r, 0.26, 14, x, r, z, Math.PI / 2) });
  parts.push({ mat: M.rim, geo: cyl(r * 0.6, r * 0.62, 0.05, 12, x, r, z + side * 0.12, Math.PI / 2) });
  parts.push({ mat: M.black, geo: cyl(r * 0.18, r * 0.18, 0.07, 6, x, r, z + side * 0.14, Math.PI / 2) });
}
export function carParts(variant, paint, burnt) {
  const key = variant + ':' + paint + ':' + burnt;
  if (carCache.has(key)) return carCache.get(key).map((p) => ({ mat: p.mat, geo: p.geo.clone() }));
  const M = materials();
  const body = burnt ? M.carBurnt : M.carPaint[paint % PAINTS];
  const glass = burnt ? null : M.carGlass;
  const trimM = burnt ? M.carBurnt : M.black;
  const parts = [];
  const add = (mat, geo) => { if (mat) parts.push({ mat, geo }); };
  let W = 1.74, wheelX = [1.38, -1.38], wheelR = 0.36, front = 2.3, back = -2.32, lightY = 0.72, cabin = null;
  if (variant === 0) { // sedan
    add(body, extrude([[-2.25, 0.32], { arc: [-1.38, 0.34, 0.44] }, { arc: [1.38, 0.34, 0.44] }, [2.15, 0.32], [2.3, 0.5], [2.27, 0.82], [1.05, 0.96], [-1.55, 1.0], [-2.28, 0.93], [-2.32, 0.55]], W - 0.12, 0.06));
    cabin = [[1.05, 0.9], [0.25, 1.38], [-0.95, 1.42], [-1.6, 0.98]];
    add(body, box(1.18, 0.06, W - 0.3, -0.35, 1.44, 0));
    for (const sz of [-1, 1]) { add(body, box(0.12, 0.46, 0.06, -0.3, 1.17, sz * (W / 2 - 0.2), sz * 0.12)); add(body, box(0.5, 0.06, 0.06, 0.62, 1.16, sz * (W / 2 - 0.2), sz * 0.12, 0, -0.55)); add(body, box(0.55, 0.06, 0.06, -1.27, 1.2, sz * (W / 2 - 0.2), sz * 0.12, 0, 0.6)); }
  } else if (variant === 3) { // hatchback
    W = 1.66; wheelX = [1.2, -1.2]; wheelR = 0.33; front = 1.95; back = -1.95;
    add(body, extrude([[-1.92, 0.3], { arc: [-1.2, 0.31, 0.41] }, { arc: [1.2, 0.31, 0.41] }, [1.85, 0.3], [1.98, 0.48], [1.95, 0.78], [0.95, 0.95], [-1.9, 1.02], [-1.98, 0.5]], W - 0.12, 0.06));
    cabin = [[0.95, 0.9], [0.15, 1.42], [-1.6, 1.46], [-1.92, 0.98]];
    add(body, box(1.7, 0.06, W - 0.28, -0.75, 1.48, 0));
    for (const sz of [-1, 1]) add(body, box(0.12, 0.5, 0.06, -0.45, 1.2, sz * (W / 2 - 0.2), sz * 0.1));
  } else if (variant === 1) { // van
    W = 1.9; wheelX = [1.5, -1.5]; wheelR = 0.38; front = 2.42; back = -2.5; lightY = 0.85;
    add(body, extrude([[-2.45, 0.35], { arc: [-1.5, 0.38, 0.46] }, { arc: [1.5, 0.38, 0.46] }, [2.3, 0.35], [2.42, 0.6], [2.38, 1.0], [1.7, 1.22], [1.25, 1.95], [-2.45, 2.02]], W - 0.12, 0.06));
    add(glass, extrude([[1.72, 1.18], [1.27, 1.88], [0.95, 1.9], [0.95, 1.2]], W - 0.06, 0.03));
    add(glass, box(0.9, 0.42, W + 0.01, 0.2, 1.55, 0));
    add(trimM, box(0.03, 1.2, 0.02, -0.6, 1.0, W / 2 + 0.005)); add(trimM, box(2.0, 0.03, 0.02, -1.4, 0.36 + 1.5, W / 2 + 0.005));
    for (const sz of [-1, 1]) add(M.black, box(2.2, 0.05, 0.05, -1.0, 2.1, sz * 0.62)); for (const x of [-1.9, -1.0, -0.1]) add(M.black, box(0.05, 0.05, 1.3, x, 2.12, 0)); // roof rack rails
  } else if (variant === 2) { // pickup
    W = 1.85; wheelX = [1.55, -1.55 - 0.6]; wheelR = 0.4; front = 2.47; back = -2.68; lightY = 0.8;
    add(body, extrude([[-0.3, 0.4], { arc: [1.55, 0.4, 0.48] }, [2.3, 0.4], [2.45, 0.65], [2.4, 1.05], [1.3, 1.15], [0.75, 1.75], [-0.35, 1.78]], W - 0.12, 0.06));
    add(glass, extrude([[1.3, 1.1], [0.78, 1.68], [0.2, 1.7], [0.2, 1.12]], W - 0.1, 0.03));
    add(body, box(2.3, 0.12, W, -1.5, 0.55, 0));
    add(body, box(2.3, 0.5, 0.08, -1.5, 0.85, W / 2 - 0.04)); add(body, box(2.3, 0.5, 0.08, -1.5, 0.85, -W / 2 + 0.04));
    add(body, box(0.08, 0.5, W, -2.62, 0.85, 0));
    add(M.black, box(2.3, 0.3, W - 0.2, -1.5, 0.4, 0));
    add(M.rust, box(0.9, 0.3, 0.7, -1.6, 0.76, 0.2, 0, 0.4, 0));
    add(M.tire, cyl(0.36, 0.36, 0.24, 14, -2.0, 0.85, -0.3, 0.3, 0, 0.2));
  } else if (variant === 4) { // box truck
    W = 2.3; wheelX = [2.35, -1.6, -2.6]; wheelR = 0.46; front = 3.45; back = -3.75; lightY = 0.9;
    add(body, extrude([[1.3, 0.55], { arc: [2.35, 0.5, 0.56] }, [3.3, 0.55], [3.45, 0.75], [3.42, 1.4], [3.0, 1.6], [2.65, 2.55], [1.3, 2.6]], W - 0.12, 0.06));
    add(glass, extrude([[3.0, 1.55], [2.67, 2.42], [2.3, 2.45], [2.3, 1.6]], W - 0.06, 0.03));
    add(burnt ? M.carBurnt : M.carPaint[(paint + 2) % PAINTS], box(5.0, 2.9, W + 0.1, -1.25, 2.15, 0));
    add(M.black, box(5.6, 0.35, W - 0.3, -0.85, 0.55, 0));
    add(M.metal, box(0.06, 2.8, W + 0.14, -3.76, 2.15, 0));
    add(M.metal, box(5.0, 0.08, W + 0.16, -1.25, 0.72, 0));
  } else { // 5 bus
    W = 2.5; wheelX = [3.6, -2.9]; wheelR = 0.5; front = 5.6; back = -5.6; lightY = 0.75;
    add(body, extrude([[-5.6, 0.45], { arc: [-2.9, 0.5, 0.6] }, { arc: [3.6, 0.5, 0.6] }, [5.55, 0.45], [5.62, 1.2], [5.5, 2.9], [5.2, 3.05], [-5.5, 3.05], [-5.62, 2.8]], W - 0.12, 0.08, 6));
    add(glass, box(9.4, 0.85, W + 0.01, -0.5, 2.25, 0));
    add(glass, extrude([[5.6, 1.3], [5.52, 2.8], [5.35, 2.9], [5.35, 1.3]], W - 0.2, 0.02));
    for (let x = -4.8; x < 4.4; x += 1.25) add(body, box(0.1, 0.86, W + 0.03, x, 2.25, 0));
    add(burnt ? M.carBurnt : M.metal, box(2.0, 0.3, 1.3, -1.5, 3.2, 0));
    add(M.black, box(9.0, 0.06, W + 0.02, 0, 1.45, 0));
  }
  if (cabin) {
    if (glass) add(glass, extrude(cabin, W - 0.36, 0.04));
    else add(M.interior, extrude(cabin.map(([x, y]) => [x * 0.95, y - 0.05]), W - 0.5, 0.02));
  }
  if (burnt) add(M.interior, box(Math.abs(front - back) * 0.4, 0.4, W - 0.5, (front + back) / 2 - 0.2, 0.8, 0));
  // bumpers, lights, plates, grille
  add(burnt ? M.carBurnt : variant === 5 ? M.black : M.chrome, box(0.14, 0.18, W - 0.06, front + 0.02, 0.45, 0));
  add(M.black, box(0.14, 0.18, W - 0.06, back - 0.02, 0.45, 0));
  add(M.black, box(0.04, 0.16, W * 0.38, front + 0.0, lightY - 0.04, 0));
  add(burnt ? null : M.plate, box(0.02, 0.12, 0.42, front + 0.1, 0.45, 0));
  add(burnt ? null : M.plate, box(0.02, 0.12, 0.42, back - 0.1, 0.6, 0));
  for (const sz of [-1, 1]) {
    add(burnt ? M.black : M.headlight, box(0.06, 0.13, 0.3, front - 0.01, lightY, sz * (W / 2 - 0.28)));
    add(burnt ? M.black : M.taillight, box(0.06, 0.16, 0.24, back + 0.03, lightY + 0.05, sz * (W / 2 - 0.2)));
    // door seams / sill
    if (variant <= 3) {
      add(trimM, box(0.02, 0.55, 0.012, variant === 3 ? 0.4 : 0.85, 0.66, sz * (W / 2 + 0.004)));
      if (variant !== 2) add(trimM, box(0.02, 0.55, 0.012, variant === 3 ? -0.5 : -0.35, 0.66, sz * (W / 2 + 0.004)));
      add(trimM, box(0.12, 0.03, 0.012, variant === 3 ? 0.1 : 0.4, 0.82, sz * (W / 2 + 0.006)));
    }
    add(M.black, box(Math.abs(front - back) - 1.8, 0.06, 0.02, (front + back) / 2, 0.38, sz * (W / 2 - 0.02)));
  }
  for (let i = 0; i < wheelX.length; i++) for (const sz of [-1, 1]) wheel(parts, M, wheelX[i], sz * (W / 2 - 0.13), wheelR, burnt, sz);
  // underside (inset so the wheel arches read) + mirrors
  add(M.black, box(Math.abs(front - back) - 0.5, 0.22, W - 0.5, (front + back) / 2, 0.32, 0));
  if (variant <= 3) {
    const mx = variant === 0 ? 0.95 : variant === 3 ? 0.85 : variant === 1 ? 1.6 : 1.2, my = variant === 1 ? 1.25 : variant === 2 ? 1.15 : 1.0;
    for (const sz of [-1, 1]) add(burnt ? M.black : body, box(0.14, 0.12, 0.16, mx, my, sz * (W / 2 + 0.05)));
  }
  const DET = new Map([[M.headlight, 0x8a8880], [M.taillight, 0x5a0806], [M.plate, 0xb0a888], [M.rim, 0x5a5c60], [M.chrome, 0x7a7a7a], [M.black, 0x0c0c0d], [M.interior, 0x161412]]);
  for (const p of parts) { // metric box-projected UVs so paint/rust/char detail keeps a constant texel scale
    if (p.geo.index) p.geo = p.geo.toNonIndexed();
    if (DET.has(p.mat)) { colorize(p.geo, DET.get(p.mat)); p.mat = M.carDetail; } // one draw call for all small trim
    boxUV(p.geo, 0.55, [variant * 0.31 + paint * 0.17, paint * 0.23]);
  }
  carCache.set(key, parts.map((p) => ({ mat: p.mat, geo: p.geo })));
  return parts.map((p) => ({ mat: p.mat, geo: p.geo.clone() }));
}
// half extents [x, height, z]
export function carSize(variant) { return [[2.35, 0.92, 0.9], [2.5, 1.0, 1.0], [2.7, 0.95, 0.95], [2.0, 0.9, 0.85], [3.8, 1.5, 1.2], [5.7, 1.6, 1.3]][variant] || [2.35, 0.92, 0.9]; }

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
  const proto = new THREE.TorusGeometry(0.31, 0.13, 5, 12); proto.rotateX(Math.PI / 2);
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
  const body = box(6.06, 2.5, 2.44, 0, 1.3, 0).toNonIndexed(); boxUV(body, 0.33, [colorIdx * 0.37, 0]);
  const parts = [{ mat, geo: body }];
  // top/bottom rails + door locking bars + faded stencil block
  for (const y of [0.12, 2.5]) for (const sz of [-1, 1]) parts.push({ mat: M.metal, geo: box(6.1, 0.12, 0.08, 0, y, sz * 1.22) });
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
