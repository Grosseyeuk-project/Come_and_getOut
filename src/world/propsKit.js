// Modular kit pieces: street furniture, clutter and building attachments (AC units, water tanks,
// balconies, fire escapes, awnings, signs). Same convention as props.js: arrays of { mat, geo } in
// local space, origin on the ground (or on the wall surface for attachments, +Z = out of the wall).
import * as THREE from 'three';
import { materials, colorize } from '../render/materials.js';
import { RNG } from '../core/rng.js';
import { box, cyl, xf, leafClump } from './props.js';

const tint = (g, c) => colorize(g.index ? g.toNonIndexed() : g, c);

// ---------- street furniture ----------
export function hydrantParts() {
  const M = materials(), c = 0xb02a18;
  return [
    { mat: M.paint, geo: tint(cyl(0.13, 0.15, 0.55, 10, 0, 0.3, 0), c) },
    { mat: M.paint, geo: tint(cyl(0.15, 0.15, 0.06, 10, 0, 0.6, 0), c) },
    { mat: M.paint, geo: tint(new THREE.SphereGeometry(0.12, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.62, 0), c) },
    { mat: M.paint, geo: tint(cyl(0.05, 0.05, 0.42, 8, 0, 0.42, 0, Math.PI / 2), c) },
    { mat: M.metal, geo: cyl(0.2, 0.2, 0.05, 10, 0, 0.025, 0) },
  ];
}
export function newsboxParts(rng) {
  const M = materials(), c = rng.pick([0x2a4a8a, 0x8a2a20, 0x3a6a3a, 0xb09020]);
  return [
    { mat: M.paint, geo: tint(box(0.5, 0.75, 0.45, 0, 0.62, 0), c) },
    { mat: M.carGlass, geo: box(0.36, 0.25, 0.02, 0, 0.75, 0.23) },
    { mat: M.metal, geo: box(0.05, 0.25, 0.05, -0.18, 0.12, 0) }, { mat: M.metal, geo: box(0.05, 0.25, 0.05, 0.18, 0.12, 0) },
  ];
}
export function trashCanParts(rng) {
  const M = materials(), c = rng.pick([0x2a3a2a, 0x2a2e36, 0x3a3a3a]);
  const p = [{ mat: M.paint, geo: tint(cyl(0.3, 0.26, 0.9, 12, 0, 0.45, 0, 0, 0, 0, true), c) }, { mat: M.black, geo: cyl(0.27, 0.27, 0.02, 12, 0, 0.8, 0) }];
  if (rng.chance(0.6)) p.push({ mat: M.paint, geo: tint(cyl(0.33, 0.33, 0.06, 12, 0.15, 0.06, 0.35, 1.4, 0, 0.3), c) });
  return p;
}
export function bagPileParts(rng, n = 6) {
  const M = materials(), parts = [];
  for (let i = 0; i < n; i++) {
    const g = new THREE.SphereGeometry(1, 7, 5); const s = rng.range(0.22, 0.36);
    const pa = g.attributes.position; for (let k = 0; k < pa.count; k++) { const y = pa.getY(k); pa.setY(k, y < -0.3 ? -0.3 - (y + 0.3) * 0.2 : y); if (y > 0.85) { pa.setX(k, pa.getX(k) * 0.4); pa.setZ(k, pa.getZ(k) * 0.4); } }
    g.computeVertexNormals(); g.scale(s, s * 0.85, s * rng.range(0.8, 1.2));
    xf(g, rng.range(-0.6, 0.6), s * 0.3 + (i > n * 0.6 ? s * 0.8 : 0), rng.range(-0.45, 0.45), rng.range(-0.3, 0.3), rng.range(0, 6), rng.range(-0.3, 0.3));
    parts.push({ mat: M.plastic, geo: tint(g, rng.pick([0x0e0e10, 0x101410, 0x1a1c22, 0x2a3a2a, 0x3a3028])) });
  }
  return parts;
}
export function cardboardParts(rng, n = 3) {
  const M = materials(), parts = [];
  for (let i = 0; i < n; i++) { const w = rng.range(0.35, 0.7), h = rng.range(0.25, 0.5), d = rng.range(0.3, 0.6); const st = i > 0 && rng.chance(0.4); parts.push({ mat: M.cardboard, geo: box(w, h, d, rng.range(-0.4, 0.4), h / 2 + (st ? 0.4 : 0), rng.range(-0.4, 0.4), 0, rng.range(0, 3), st ? rng.range(-0.2, 0.2) : 0) }); }
  return parts;
}
export function palletParts(rng) {
  const M = materials(), parts = [];
  const n = rng.int(1, 4);
  for (let k = 0; k < n; k++) {
    const y = k * 0.15, ry = rng.range(-0.15, 0.15);
    for (let i = 0; i < 5; i++) parts.push({ mat: M.wood, geo: box(1.2, 0.025, 0.14, 0, y + 0.135, -0.4 + i * 0.2, 0, ry) });
    for (const z of [-0.45, 0, 0.45]) parts.push({ mat: M.wood, geo: box(1.2, 0.1, 0.1, 0, y + 0.06, z, 0, ry) });
  }
  return parts;
}
export function coneParts() {
  const M = materials();
  return [{ mat: M.plastic, geo: tint(cyl(0.03, 0.17, 0.62, 10, 0, 0.33, 0), 0xd05010) }, { mat: M.plastic, geo: tint(cyl(0.105, 0.125, 0.1, 10, 0, 0.3, 0), 0xdcdcd0) }, { mat: M.plastic, geo: tint(box(0.42, 0.04, 0.42, 0, 0.02, 0), 0xb04010) }];
}
export function bollardParts() { const M = materials(); return [{ mat: M.paint, geo: tint(cyl(0.11, 0.11, 0.9, 10, 0, 0.45, 0), 0x2a2a2a) }, { mat: M.paint, geo: tint(cyl(0.115, 0.115, 0.08, 10, 0, 0.78, 0), 0xb0a040) }]; }
export function planterParts(rng) {
  const M = materials();
  return [{ mat: M.rubble, geo: box(1.6, 0.6, 1.6, 0, 0.3, 0) }, { mat: M.black, geo: box(1.4, 0.04, 1.4, 0, 0.58, 0) }];
}
export function busStopParts(rng) {
  const M = materials(), parts = [];
  for (const x of [-1.6, 1.6]) parts.push({ mat: M.metal, geo: box(0.08, 2.4, 0.08, x, 1.2, -0.6) }, { mat: M.metal, geo: box(0.08, 2.4, 0.08, x, 1.2, 0.6) });
  parts.push({ mat: M.metal, geo: box(3.4, 0.08, 1.5, 0, 2.42, 0, 0.06) });
  const broken = rng.chance(0.5);
  parts.push({ mat: M.carGlass, geo: box(3.2, broken ? 0.9 : 1.8, 0.03, 0, broken ? 0.65 : 1.2, -0.6) });
  parts.push({ mat: M.signDead, geo: uvCell(box(0.04, 1.6, 1.0, 1.6, 1.3, 0), 0, 2) });
  parts.push({ mat: M.wood, geo: box(2.6, 0.05, 0.38, 0, 0.48, -0.35) });
  return parts;
}
export function phoneBoothParts() {
  const M = materials(), c = 0x3a4a5a;
  return [
    { mat: M.paint, geo: tint(box(0.9, 0.1, 0.9, 0, 2.25, 0), c) }, { mat: M.paint, geo: tint(box(0.9, 0.1, 0.9, 0, 0.05, 0), c) },
    ...[[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]].map(([x, z]) => ({ mat: M.paint, geo: tint(box(0.07, 2.2, 0.07, x, 1.1, z), c) })),
    { mat: M.carGlass, geo: box(0.8, 1.4, 0.02, 0, 1.2, -0.41) }, { mat: M.carGlass, geo: box(0.02, 1.4, 0.8, 0.41, 1.2, 0) },
    { mat: M.black, geo: box(0.25, 0.4, 0.12, 0, 1.4, -0.33) },
  ];
}
export function streetSignParts(rng) {
  const M = materials();
  const c = rng.pick([0x1a5a2a, 0x1a3a7a, 0xa02018, 0xc8b040]);
  const lean = rng.range(-0.15, 0.15);
  return [
    { mat: M.metal, geo: cyl(0.035, 0.035, 2.8, 6, 0, 1.4, 0, lean) },
    { mat: M.paint, geo: tint(rng.chance(0.5) ? box(0.8, 0.2, 0.02, 0.3, 2.6, 0, lean) : cyl(0.3, 0.3, 0.02, rng.pick([8, 3, 16]), 0, 2.55, 0.03, Math.PI / 2 + lean), c) },
  ];
}
export function cartParts() {
  const M = materials(), p = [];
  p.push({ mat: M.chrome, geo: box(0.9, 0.02, 0.55, 0, 0.45, 0) });
  for (const z of [-0.28, 0.28]) p.push({ mat: M.chrome, geo: box(0.9, 0.45, 0.02, 0, 0.68, z) });
  p.push({ mat: M.chrome, geo: box(0.02, 0.45, 0.56, 0.45, 0.68, 0) }, { mat: M.chrome, geo: box(0.02, 0.45, 0.56, -0.45, 0.68, 0) });
  for (const x of [-0.4, 0.4]) for (const z of [-0.25, 0.25]) p.push({ mat: M.black, geo: cyl(0.06, 0.06, 0.04, 8, x, 0.06, z, Math.PI / 2) });
  p.push({ mat: M.chrome, geo: cyl(0.015, 0.015, 0.6, 5, -0.55, 0.95, 0, Math.PI / 2) });
  return p;
}
export function mattressParts(rng) { const M = materials(); return [{ mat: M.sandbag, geo: tint(box(1.9, 0.18, 1.3, 0, 0.09, 0, 0, 0, rng.range(-0.05, 0.05)), rng.pick([0xc8b898, 0x9a8a7a, 0xa8a090])) }]; }
export function crateParts(rng) {
  const M = materials(), p = [];
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i++) { const s = rng.range(0.55, 0.85); p.push({ mat: M.crate, geo: box(s, s, s, (i % 2) * 0.9 - 0.45, s / 2 + (i === 2 ? 0.75 : 0), rng.range(-0.1, 0.1), 0, rng.range(-0.3, 0.3)) }); }
  return p;
}
export function tarpParts(rng) {
  const M = materials();
  const g = new THREE.PlaneGeometry(2.4, 1.8, 8, 6); g.rotateX(-Math.PI / 2);
  const pa = g.attributes.position; for (let i = 0; i < pa.count; i++) pa.setY(i, 0.05 + Math.max(0, Math.sin(pa.getX(i) * 2.1 + rng.range(0, 0.3)) * 0.25 + Math.cos(pa.getZ(i) * 2.5) * 0.12));
  g.computeVertexNormals();
  return [{ mat: M.awning, geo: tint(g, rng.pick([0x2a4a6a, 0x4a5a3a, 0x6a5a40, 0x7a3020])) }];
}

// ---------- building attachments (local: x along wall, y up, z out of wall; origin on wall face) ----------
export function acUnitParts() {
  const M = materials();
  return [
    { mat: M.kitMetal, geo: tint(box(0.8, 0.55, 0.5, 0, 0, 0.27), 0xb8b8b0) },
    { mat: M.black, geo: cyl(0.2, 0.2, 0.02, 12, 0.12, 0, 0.53, Math.PI / 2) },
    { mat: M.kitRust, geo: tint(box(0.04, 0.04, 0.5, -0.38, -0.3, 0.27), 0xffffff) }, { mat: M.kitRust, geo: tint(box(0.04, 0.04, 0.5, 0.38, -0.3, 0.27), 0xffffff) },
  ];
}
export function balconyParts(w, rng) {
  const M = materials(), p = [], d = 1.1;
  p.push({ mat: M.slab, geo: tint(box(w, 0.16, d, 0, -0.08, d / 2), 0xa09a90) });
  const broken = rng.chance(0.35);
  for (let x = -w / 2 + 0.05; x <= w / 2; x += 0.14) { if (broken && x > 0 && x < w / 3) continue; p.push({ mat: M.kitRust, geo: tint(box(0.025, 0.95, 0.025, x, 0.48, d - 0.03), 0xffffff) }); }
  p.push({ mat: M.kitRust, geo: tint(box(w, 0.05, 0.05, 0, 0.97, d - 0.03, 0, 0, broken ? 0.08 : 0), 0xffffff) });
  for (const sx of [-1, 1]) p.push({ mat: M.kitRust, geo: tint(box(0.05, 0.05, d, sx * (w / 2 - 0.03), 0.97, d / 2), 0xffffff) });
  if (rng.chance(0.35)) p.push({ mat: M.awning, geo: tint(box(w * 0.6, 0.6, 0.02, rng.range(-0.3, 0.3), 0.5, d + 0.02, 0, 0, rng.range(-0.1, 0.1)), rng.pick([0x8a3a2a, 0x3a5a7a, 0xb0a890])) });
  return p;
}
export function awningParts(w, rng, color) {
  const M = materials(), p = [], d = rng.range(1.0, 1.5), torn = rng.chance(0.4);
  const g = new THREE.PlaneGeometry(w, d, Math.max(2, Math.round(w * 2)), 3); g.rotateX(-Math.PI / 2 + 0.38);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) { const x = pa.getX(i); pa.setY(i, pa.getY(i) - Math.abs(Math.sin(x * 1.7)) * 0.06 - (torn && x > 0 ? (pa.getZ(i) + d / 2) * 0.35 : 0)); }
  g.computeVertexNormals(); g.translate(0, -Math.sin(0.38) * d / 2, Math.cos(0.38) * d / 2);
  p.push({ mat: M.awning, geo: tint(g, color) });
  p.push({ mat: M.kitRust, geo: tint(box(w, 0.04, 0.04, 0, -Math.sin(0.38) * d, Math.cos(0.38) * d), 0xffffff) });
  return p;
}
export function fireEscapeParts(floors, w, rng) { // platforms + zig-zag stairs, from floor 1 up
  const M = materials(), p = [], FH = 3.3, d = 1.2;
  for (let f = 1; f < floors; f++) {
    const y = f * FH;
    p.push({ mat: M.kitRust, geo: tint(box(w, 0.05, d, 0, y, d / 2), 0xffffff) });
    p.push({ mat: M.kitRust, geo: tint(box(w, 0.04, 0.04, 0, y + 0.95, d), 0xffffff) });
    for (let x = -w / 2; x <= w / 2 + 0.01; x += w / 6) p.push({ mat: M.kitRust, geo: tint(box(0.03, 0.95, 0.03, x, y + 0.47, d), 0xffffff) });
    if (f < floors - 1 || f === 1) { // stair to the next level (or a hanging ladder from the first)
      const len = Math.hypot(w * 0.7, FH), ang = Math.atan2(FH, w * 0.7), dir = f % 2 ? 1 : -1;
      if (f < floors - 1) p.push({ mat: M.kitRust, geo: tint(box(len, 0.06, 0.6, dir * w * 0.0, y + FH / 2, d * 0.5, 0, 0, dir * ang), 0xffffff) });
      if (f === 1) p.push({ mat: M.kitRust, geo: tint(box(0.4, FH * 0.55, 0.03, w / 2 - 0.3, y - FH * 0.3, d - 0.1), 0xffffff) });
    }
  }
  return p;
}
export function drainpipeParts(h) {
  const M = materials();
  return [{ mat: M.kitMetal, geo: tint(cyl(0.06, 0.06, h, 6, 0, h / 2, 0.1), 0x8a8a80) }, { mat: M.kitMetal, geo: tint(cyl(0.06, 0.06, 0.3, 6, 0, 0.1, 0.22, Math.PI / 2 - 0.5), 0x8a8a80) }];
}
// sign: cell index into the 4x4 atlas; flat board on the wall (blade = perpendicular to wall)
export function uvCell(g, cell, rot = 0) {
  const ng = g.index ? g.toNonIndexed() : g, uv = ng.attributes.uv, n = ng.attributes.normal;
  const u0 = (cell % 4) / 4, v0 = 1 - (Math.floor(cell / 4) + 1) / 4;
  // box faces: map every face to the cell (side faces too, thin so barely visible)
  for (let i = 0; i < uv.count; i++) { let u = uv.getX(i), v = uv.getY(i); if (rot === 1) [u, v] = [v, 1 - u]; if (rot === 2) [u, v] = [u, v]; uv.setXY(i, u0 + (0.02 + u * 0.96) / 4, v0 + (0.02 + v * 0.96) / 4); }
  void n;
  return ng;
}
export function signParts(cell, w, h, blade, seed, dead) {
  const M = materials(), mat = dead ? M.signDead : M.neon, p = [];
  const g = blade ? box(0.12, h, w, 0, 0, w / 2 + 0.25) : box(w, h, 0.1, 0, 0, 0.1);
  // blade: board faces +-X, its long axis along z; rotate UV so text runs along the board
  const ng = uvCell(g, cell, 0);
  if (blade) { // remap: side faces (normal +-x) use z,y
    const pos = ng.attributes.position, nn = ng.attributes.normal, uv = ng.attributes.uv;
    const u0 = (cell % 4) / 4, v0 = 1 - (Math.floor(cell / 4) + 1) / 4;
    for (let i = 0; i < uv.count; i++) { if (Math.abs(nn.getX(i)) < 0.5) continue; const zz = (pos.getZ(i) - 0.25) / w, yy = pos.getY(i) / h + 0.5; const u = nn.getX(i) > 0 ? 1 - zz : zz; uv.setXY(i, u0 + (0.02 + u * 0.96) / 4, v0 + (0.02 + yy * 0.96) / 4); }
    // rotate the board so text is vertical? keep horizontal blade boards (common for bars/hotels)
  }
  colorize(ng, new THREE.Color(seed, seed, seed));
  p.push({ mat, geo: ng });
  if (blade) { p.push({ mat: M.kitRust, geo: tint(box(0.05, 0.05, w + 0.3, 0, h / 2 + 0.05, w / 2 + 0.15), 0xffffff) }); p.push({ mat: M.kitRust, geo: tint(box(0.05, 0.05, w + 0.3, 0, -h / 2 - 0.05, w / 2 + 0.15), 0xffffff) }); }
  return p;
}
export function waterTankParts(rng) {
  const M = materials(), p = [], r = rng.range(0.9, 1.3), h = rng.range(1.6, 2.4);
  for (const [x, z] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) p.push({ mat: M.kitRust, geo: tint(box(0.1, 1.4, 0.1, x * r, 0.7, z * r), 0xffffff) });
  p.push({ mat: M.wood, geo: cyl(r, r, h, 14, 0, 1.4 + h / 2, 0) });
  p.push({ mat: M.kitMetal, geo: tint(new THREE.ConeGeometry(r * 1.05, 0.6, 14).translate(0, 1.4 + h + 0.3, 0), 0x6a6a64) });
  for (const y of [0.3, 0.7]) p.push({ mat: M.kitRust, geo: tint(xf(new THREE.TorusGeometry(r + 0.01, 0.025, 4, 18), 0, 1.4 + h * y, 0, Math.PI / 2), 0xffffff) });
  return p;
}
export function roofVentParts(rng) {
  const M = materials(), p = [];
  const k = rng.int(0, 3);
  if (k === 0) { p.push({ mat: M.kitMetal, geo: tint(box(1.2, 0.8, 1.0, 0, 0.4, 0), 0xa0a098) }); p.push({ mat: M.black, geo: cyl(0.35, 0.35, 0.05, 12, 0, 0.82, 0) }); }
  else if (k === 1) { p.push({ mat: M.kitMetal, geo: tint(cyl(0.25, 0.25, 0.9, 10, 0, 0.45, 0), 0x909088) }); p.push({ mat: M.kitMetal, geo: tint(new THREE.ConeGeometry(0.4, 0.3, 10).translate(0, 1.05, 0), 0x707068) }); }
  else if (k === 2) { p.push({ mat: M.kitMetal, geo: tint(cyl(0.02, 0.03, 3.5, 5, 0, 1.75, 0), 0x606060) }); for (let i = 0; i < 4; i++) p.push({ mat: M.kitMetal, geo: tint(box(1.2 - i * 0.2, 0.03, 0.03, 0, 2.2 + i * 0.35, 0), 0x606060) }); }
  else { p.push({ mat: M.kitMetal, geo: tint(new THREE.SphereGeometry(0.6, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.6).rotateX(-1.0).translate(0, 0.9, 0), 0xb0b0a8) }); p.push({ mat: M.kitMetal, geo: tint(cyl(0.04, 0.04, 0.9, 5, 0, 0.45, 0), 0x707070) }); }
  return p;
}
export { RNG };
export { box, cyl };

// Raised concrete planter bed packed with a dense, saturated foliage mass (mutated growth),
// leaves spilling over the rim. len along x.
export function planterBedParts(rng, len, colors) {
  const M = materials(), p = [], w = 1.3, h = rng.range(0.55, 0.85);
  p.push({ mat: M.trim, geo: tint(box(len, h, w, 0, h / 2, 0), 0x8a8680) });
  p.push({ mat: M.black, geo: box(len - 0.2, 0.04, w - 0.2, 0, h - 0.02, 0) });
  for (const sz of [-1, 1]) p.push({ mat: M.trim, geo: tint(box(len + 0.06, 0.08, 0.16, 0, h + 0.02, sz * (w / 2 - 0.05)), 0x9a968e) });
  const n = Math.ceil(len * 3.2);
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.5, 0.95), g = leafClump(rng, s);
    g.translate(rng.range(-len / 2 + 0.2, len / 2 - 0.2), h + 0.1 + rng.range(0, 0.45), rng.range(-w / 2, w / 2) * 1.1);
    p.push({ mat: M.foliage, geo: tint(g, new THREE.Color(rng.pick(colors)).multiplyScalar(rng.range(0.6, 1.2))) });
  }
  return p;
}
