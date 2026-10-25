// Turns a layout (mapgen.js) into meshes + colliders: ground, roads, sidewalks, ruined buildings,
// props, rubble, decals, foliage. Also registers light sources and fire emitters.
import * as THREE from 'three';
import { RNG, fbm, clamp } from '../core/rng.js';
import { materials, boxUV, colorize, GeoBatch, matUniforms } from '../render/materials.js';
import * as K from './propsKit.js';
import { SIGN_WORDS } from '../render/textures.js';
import * as T from '../render/textures.js';
import * as P from './props.js';
import { HALF, OUTER } from './mapgen.js';
import { Volumetrics } from '../fx/volumetrics.js';

const FH = 3.3, WT = 0.38, PW = 0.45;
export const worldUniforms = { uTime: matUniforms.uTime };

class Scatter { // instanced static clutter: several geometry variants, one material
  constructor(mat, variants, cast = true) { this.mat = mat; this.variants = variants; this.items = variants.map(() => []); this.cast = cast; this.n = 0; }
  add(x, y, z, s, rx, ry, rz, color) { const v = (this.n++ * 7919) % this.variants.length; this.items[v].push({ x, y, z, s, rx, ry, rz, color }); }
  addV(v, x, y, z, s, rx, ry, rz, color) { this.items[v % this.variants.length].push({ x, y, z, s, rx, ry, rz, color }); }
  build(parent) {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), c = new THREE.Color();
    this.variants.forEach((geo, i) => {
      const list = this.items[i]; if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, this.mat, list.length);
      list.forEach((it, k) => {
        e.set(it.rx, it.ry, it.rz); q.setFromEuler(e);
        const s = it.s; sv.set(typeof s === 'number' ? s : s[0], typeof s === 'number' ? s : s[1], typeof s === 'number' ? s : s[2]);
        m4.compose(pv.set(it.x, it.y, it.z), q, sv); im.setMatrixAt(k, m4);
        if (it.color !== undefined) im.setColorAt(k, c.set(it.color));
      });
      im.castShadow = this.cast; im.receiveShadow = true;
      im.computeBoundingSphere();
      parent.add(im);
    });
  }
}

function rockGeo(seed, detail = 0) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const r = new RNG(seed), p = g.attributes.position;
  const sx = r.range(0.6, 1.3), sy = r.range(0.4, 0.9), sz = r.range(0.6, 1.3);
  for (let i = 0; i < p.count; i++) { const k = 0.75 + fbm(p.getX(i) * 2 + seed, p.getZ(i) * 2 + p.getY(i), 2, seed) * 0.5; p.setXYZ(i, p.getX(i) * sx * k, p.getY(i) * sy * k, p.getZ(i) * sz * k); }
  const ng = g.index ? g.toNonIndexed() : g; ng.computeVertexNormals(); boxUV(ng, 0.5);
  return ng;
}

export class Environment {
  constructor(scene, layout, col, lighting) {
    this.scene = scene; this.L = layout; this.col = col; this.lighting = lighting;
    this.root = new THREE.Group(); this.root.name = 'environment'; scene.add(this.root);
    this.M = materials();
    this.batch = new GeoBatch();
    this.fires = [];
    this.smokes = [];
    this.vol = new Volumetrics(scene);
    this.flares = [];
    this.decals = layout.decals;
    this.rng = new RNG(layout.seed ^ 0xabc);
    const M = this.M;
    // height field (for sidewalks / floors)
    this.hRes = 0.5; this.hMin = -HALF - 8; this.hN = Math.ceil(((HALF + 8) * 2) / this.hRes);
    this.hf = new Float32Array(this.hN * this.hN);
    this.rubble = new Scatter(M.rubble, [0, 1, 2, 3, 4].map((i) => rockGeo(100 + i)));
    this.bricks = new Scatter(M.brickRubble, [box1(0.22, 0.07, 0.11), box1(0.3, 0.12, 0.2), box1(0.12, 0.07, 0.11)]);
    this.debris = new Scatter(M.wood, [box1(1.2, 0.04, 0.15), box1(0.8, 0.03, 0.2), box1(1.6, 0.05, 0.1)]);
    this.rebar = new Scatter(M.rebar, [cyl1(0.012, 1)], false);
    this.litter = new Scatter(M.paper, [paperGeo(0), paperGeo(1), paperGeo(2)], false);
    this.pebbles = new Scatter(M.rubble, [0, 1, 2].map((i) => pebbleGeo(300 + i)), false); // tiny chunks: low poly, no shadow
    this.shards = new Scatter(M.carGlass, [shardGeo()], false);
    this.cans = new Scatter(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.6 }), [canGeo(), bottleGeo()], false);
    this.signs = []; // emissive signage {pos, color, flicker, seed, dead}: lighting can pair lights with these
    this.anchors = []; // facade cable anchors
    this.winLights = 0;
    this.beacons = []; // red rooftop aviation lights (positions) for blinking fx
    this.neon = (layout.themeDef && layout.themeDef.neon) || 1;
    this.emissiveMeshes = []; // filled after batching: meshes whose material is emissive (neon, bulbs, windows)

    this.buildGround();
    for (const b of layout.buildings) this.buildBuilding(b);
    for (const p of layout.props) this.buildProp(p);
    for (const line of layout.poles) this.buildPoles(line);
    this.buildCables();
    for (const rb of layout.roadblocks || []) this.buildRoadblock(rb);
    const main = this.batch; this.batch = new GeoBatch();
    this.scatterGround();
    this.buildOuter(); // outer city ring: receives shadows near the border, never casts (would darken the map edge)
    this.buildSkyline();
    const far = this.batch.build(this.root, { cast: false, receive: true });
    this.batch = main;
    this.buildDecals();
    const near = this.batch.build(this.root);
    const emiss = new Set([M.neon, M.bulb, M.bulbCold, M.lampOn, M.redLight, M.facade_concrete, M.facade_brick, M.facade_plaster]);
    for (const m of [...far, ...near]) if (emiss.has(m.material)) this.emissiveMeshes.push(m);
    this.rubble.build(this.root); this.bricks.build(this.root); this.debris.build(this.root); this.rebar.build(this.root);
    this.litter.build(this.root); this.cans.build(this.root); this.shards.build(this.root); this.pebbles.build(this.root);
    this.buildGrass();
  }

  setH(x0, z0, x1, z1, h) {
    const r = this.hRes, m = this.hMin, n = this.hN;
    const i0 = Math.max(0, Math.floor((x0 - m) / r)), i1 = Math.min(n - 1, Math.floor((x1 - m) / r));
    const j0 = Math.max(0, Math.floor((z0 - m) / r)), j1 = Math.min(n - 1, Math.floor((z1 - m) / r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.hf[j * n + i] = Math.max(this.hf[j * n + i], h);
  }
  heightAt(x, z) {
    const i = Math.floor((x - this.hMin) / this.hRes), j = Math.floor((z - this.hMin) / this.hRes);
    if (i < 0 || j < 0 || i >= this.hN || j >= this.hN) return 0;
    return this.hf[j * this.hN + i];
  }

  addBox(mat, cx, cy, cz, sx, sy, sz, ry = 0, color = 0xffffff, uvScale = 0.33, rx = 0, rz = 0, jag = 0, grime = false) {
    const hs = grime ? (sy > 4 ? 3 : sy > 1.4 ? 2 : 1) : 1;
    const g = new THREE.BoxGeometry(sx, sy, sz, jag ? Math.max(1, Math.round(sx / 0.8)) : 1, hs, jag ? Math.max(1, Math.round(sz / 0.8)) : 1);
    if (jag) { // broken top edge: displace top vertices (shared positions moved identically)
      const p = g.attributes.position, off = new Map(), r = this.rng;
      for (let i = 0; i < p.count; i++) {
        if (p.getY(i) < sy / 2 - 1e-4) continue;
        const k = Math.round((p.getX(i) + cx) * 50) + ',' + Math.round((p.getZ(i) + cz) * 50);
        if (!off.has(k)) off.set(k, -r.range(0, jag));
        p.setY(i, p.getY(i) + off.get(k));
      }
    }
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(cx, cy, cz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
    const ng = g.toNonIndexed(); if (jag) ng.computeVertexNormals(); boxUV(ng, uvScale); colorize(ng, color);
    if (grime) applyGrime(ng);
    this.batch.add(mat, ng);
    return ng;
  }
  place(parts, x, y, z, ry = 0, s = 1, rx = 0, rz = 0) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(s, s, s));
    for (const p of parts) { const g = p.geo.index ? p.geo.toNonIndexed() : p.geo; g.applyMatrix4(m); this.batch.add(p.mat, g); }
  }

  buildGround() {
    const M = this.M, L = this.L;
    const S = 300;
    const gg = new THREE.PlaneGeometry(S, S, 1, 1); gg.rotateX(-Math.PI / 2);
    boxUV(gg, 1 / 7);
    const ground = new THREE.Mesh(gg, M.ground); ground.receiveShadow = true; this.root.add(ground);
    // roads
    const RL = (HALF + OUTER) * 2;
    for (const r of [...L.roads, ...(L.outerRoads || [])]) {
      const g = r.axis === 'z' ? new THREE.PlaneGeometry(r.w, RL, 1, 8) : new THREE.PlaneGeometry(RL, r.w, 8, 1);
      g.rotateX(-Math.PI / 2); g.translate(r.axis === 'z' ? r.x : 0, 0.02 + (r.axis === 'z' ? 0 : 0.002), r.axis === 'z' ? 0 : r.z);
      boxUV(g, 1 / 6); this.batch.add(M.asphalt, g);
    }
    for (const r of L.outerRoads || []) for (const sd of [-1, 1]) { // outer sidewalks (visual only)
      const c = (r.axis === 'z' ? r.x : r.z) + sd * (r.w / 2 + 1.2);
      if (r.axis === 'z') this.addBox(M.pavers, c, 0.075, 0, 2.4, 0.15, RL, 0, 0xffffff, 1 / 3.2); else this.addBox(M.pavers, 0, 0.075, c, RL, 0.15, 2.4, 0, 0xffffff, 1 / 3.2);
    }
    // parking lots get asphalt + line decals
    for (const d of L.decals) if (d.kind === 'parkinglot') {
      const g = new THREE.PlaneGeometry(d.x1 - d.x0, d.z1 - d.z0); g.rotateX(-Math.PI / 2); g.translate((d.x0 + d.x1) / 2, 0.025, (d.z0 + d.z1) / 2);
      boxUV(g, 1 / 6); this.batch.add(M.asphalt, g);
    }
    // sidewalks, cut at crossing roads, with curbs
    for (const s of L.sidewalks) {
      const alongZ = s.z1 - s.z0 > s.x1 - s.x0;
      const cross = alongZ ? L.roadsZ : L.roadsX;
      let segs = [[alongZ ? s.z0 : s.x0, alongZ ? s.z1 : s.x1]];
      for (const r of cross) {
        const a = r.p - r.w / 2, b = r.p + r.w / 2; const ns = [];
        for (const [u, v] of segs) { if (b <= u || a >= v) ns.push([u, v]); else { if (a > u) ns.push([u, a]); if (b < v) ns.push([b, v]); } }
        segs = ns;
      }
      for (const [u, v] of segs) {
        if (v - u < 0.2) continue;
        const [x0, x1, z0, z1] = alongZ ? [s.x0, s.x1, u, v] : [u, v, s.z0, s.z1];
        this.addBox(M.pavers, (x0 + x1) / 2, 0.075, (z0 + z1) / 2, x1 - x0, 0.15, z1 - z0, 0, 0xffffff, 1 / 3.2);
        this.setH(x0, z0, x1, z1, 0.15);
      }
    }
  }

  buildBuilding(b) {
    const M = this.M, rng = new RNG(b.seed), col = this.col;
    const mat = b.style === 'brick' ? M.brickWall : b.style === 'plaster' ? M.plasterWall : M.concreteWall;
    const tint = b.tint;
    const H = b.floors * FH;
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    const corners = [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]];
    const winP = b.style === 'concrete' ? 0.78 : 0.62;
    const TH = this.L.themeDef || { neon: 1, shop: 0.5 };
    const shop = rng.chance(TH.shop);
    const shopColor = rng.pick([0x7a2a20, 0x2a4a6a, 0x3a5a3a, 0x8a6a2a, 0x5a3a5a, 0x2a5a5a]);
    const seedOff = (b.seed % 997) * 1.37;
    const prof = (s) => {
      if (b.collapsed) return rng.chance(0.08) ? rng.range(FH, FH * 2) : rng.range(0.2, 2.4);
      const n = fbm(s * 0.07 + seedOff, seedOff, 3, 7);
      const k = clamp((n - 0.3) * 2.0 * b.damage + b.damage * 0.2, 0, 0.95);
      return H * (1 - k);
    };
    // floor slab
    this.addBox(M.slab, (b.x0 + b.x1) / 2, 0.06, (b.z0 + b.z1) / 2, w, 0.12, d, 0, b.collapsed ? 0x6e6a64 : 0x8e8a84, 0.25);
    for (let i = 0; i < Math.ceil(w * d / 40); i++) this.decals.push({ kind: rng.pick(['dirt', 'stain', 'crack', 'paper']), x: rng.range(b.x0 + 1, b.x1 - 1), z: rng.range(b.z0 + 1, b.z1 - 1), s: rng.range(2, 4.5), rot: rng.range(0, 6) });
    this.setH(b.x0, b.z0, b.x1, b.z1, 0.12);
    // openings: breaches + doors
    const per = 2 * (w + d);
    const breaches = []; const nb = b.collapsed ? 2 : b.damage > 0.5 ? rng.int(1, 2) : rng.int(0, 1);
    for (let i = 0; i < nb; i++) breaches.push([rng.range(0, per), rng.range(1.5, 3.5)]);
    let sOff = 0, anyOpening = breaches.length > 0;
    const sideInfo = [];
    for (let si = 0; si < 4; si++) {
      const [ax, az] = corners[si], [bx, bz] = corners[(si + 1) % 4];
      const len = Math.hypot(bx - ax, bz - az);
      const nBays = Math.max(1, Math.round(len / 3.1));
      sideInfo.push({ ax, az, bx, bz, len, nBays, door: nBays > 2 && rng.chance(0.65) ? rng.int(1, nBays - 2) : -1, bays: [] });
      if (sideInfo[si].door >= 0) anyOpening = true;
    }
    if (!anyOpening) { const s = sideInfo.reduce((a, c) => (c.len > a.len ? c : a)); s.door = Math.floor(s.nBays / 2); }
    let minTop = H;

    for (let si = 0; si < 4; si++) {
      const S = sideInfo[si];
      const ux = (S.bx - S.ax) / S.len, uz = (S.bz - S.az) / S.len, nx = uz, nz = -ux;
      Object.assign(S, { ux, uz, nx, nz });
      const alongX = Math.abs(ux) > 0.5;
      const bw = S.len / S.nBays;
      let curTop = H, damaged = false;
      const piece = (t0, t1, y0, y1, collide = true, color = tint) => {
        if (!alongX) { t0 = Math.max(t0, WT); t1 = Math.min(t1, S.len - WT); }
        if (t1 - t0 < 0.05 || y1 - y0 < 0.05) return;
        const tc = (t0 + t1) / 2, cx = S.ax + ux * tc - nx * WT / 2, cz = S.az + uz * tc - nz * WT / 2;
        const sx = alongX ? t1 - t0 : WT, sz = alongX ? WT : t1 - t0;
        const jag = damaged && y1 >= curTop - 0.01 && y1 - y0 > 0.5 ? Math.min(y1 - y0 - 0.2, rng.range(0.3, 1.2)) : 0;
        this.addBox(mat, cx, (y0 + y1) / 2, cz, sx, y1 - y0, sz, 0, color, 0.33, 0, 0, jag, true);
        if (collide && y0 < 1.0) col.add(cx, cz, sx / 2, sz / 2, 0, y1, { kind: 'wall' });
      };
      for (let k = 0; k < S.nBays; k++) {
        const t0 = k * bw, t1 = (k + 1) * bw, sg = sOff + (t0 + t1) / 2;
        let top = prof(sg);
        for (const [bs, br] of breaches) { const dd = Math.abs(((sg - bs + per * 1.5) % per) - per / 2); if (dd < br) top = Math.min(top, rng.range(0, 0.5)); }
        const isDoor = k === S.door;
        curTop = top; damaged = top < H - 0.2 || b.collapsed;
        minTop = Math.min(minTop, top);
        const bay = { t0, t1, top, isDoor, wins: [] }; S.bays.push(bay);
        if (top < 0.45) {
          for (let i = 0; i < 6; i++) { const t = rng.range(t0, t1), o = rng.range(-1.2, 1.4); this.rubble.add(S.ax + ux * t + nx * o, 0.05, S.az + uz * t + nz * o, rng.range(0.12, 0.4), rng.range(0, 3), rng.range(0, 3), 0); }
          for (let i = 0; i < 8; i++) { const t = rng.range(t0, t1), o = rng.range(-1.5, 1.5); this.bricks.add(S.ax + ux * t + nx * o, 0.05, S.az + uz * t + nz * o, 1, rng.range(-0.3, 0.3), rng.range(0, 6), rng.range(-0.3, 0.3)); }
          if (top > 0.1) piece(t0, t1, 0, top, false);
          continue;
        }
        // pier
        piece(t0, t0 + PW, 0, top);
        if (k === S.nBays - 1) piece(t1 - PW, t1, 0, top);
        const a = t0 + PW, c = k === S.nBays - 1 ? t1 - PW : t1;
        for (let f = 0; f * FH < top; f++) {
          const yb = f * FH, yc = Math.min(top, yb + FH);
          if (f === 0 && isDoor) {
            if (yc > 2.6) piece(a, c, 2.6, yc);
            this.doorway(S, a, c, Math.min(2.6, yc), rng, shop);
            continue;
          }
          if (rng.next() < winP) {
            const sf = f === 0 && shop;
            const sill = yb + (sf ? 0.5 : 0.95), lintel = yb + (sf ? 2.8 : 2.35);
            const inset = (c - a) > 2 ? 0.25 : 0.1;
            piece(a, c, yb, Math.min(sill, yc));
            if (inset > 0.1 && yc > sill) { piece(a, a + inset, sill, Math.min(lintel, yc)); piece(c - inset, c, sill, Math.min(lintel, yc)); }
            if (yc > lintel) piece(a, c, lintel, yc);
            if (yc > sill + 0.3) this.trim(S, ux, uz, nx, nz, a - 0.05, c + 0.05, sill - 0.07, sill + 0.02, 0.1);
            if (yc > lintel + 0.05) { bay.wins.push({ f, a: a + inset, c: c - inset, sill, lintel, shop: sf }); this.windowFill(S, a + inset, c - inset, sill, lintel, rng, sf, b); }
          } else piece(a, c, yb, yc);
        }
        // broken jagged top + rebar
        if (top < H - 0.2) {
          if (rng.chance(0.3)) { const ja = rng.range(t0, t1 - 0.4), jb = Math.min(t1, ja + rng.range(0.3, 0.8)); curTop = top + 0.6; piece(ja, jb, top, top + rng.range(0.3, 0.6), false); curTop = top; }
          for (let j = 0; j < rng.int(1, 4); j++) { const t = rng.range(t0, t1); this.rebar.add(S.ax + ux * t - nx * WT / 2, top + 0.3, S.az + uz * t - nz * WT / 2, [1, rng.range(0.5, 1.2), 1], rng.range(-0.5, 0.5), 0, rng.range(-0.5, 0.5)); }
          // fallen chunks at base outside
          if (rng.chance(0.6)) for (let i = 0; i < 4; i++) { const t = rng.range(t0, t1), o = rng.range(0.4, 1.8); this.rubble.add(S.ax + ux * t + nx * o, 0.05, S.az + uz * t + nz * o, rng.range(0.15, 0.45), rng.range(0, 3), rng.range(0, 3), 0); }
        }
        // floor cornice bands on intact spans
        for (let f = 1; f * FH < top - 0.3; f++) this.trim(S, ux, uz, nx, nz, t0, t1, f * FH - 0.12, f * FH + 0.06, 0.12);
        // graffiti on street level
        if (rng.chance(0.16) && top > 2.6 && !isDoor) this.graffiti(S, ux, uz, nx, nz, (t0 + t1) / 2, rng.range(0.9, 1.6), rng.range(1.8, 2.6), rng.int(0, 7));
        // vines
        if (rng.chance(0.24)) {
          const vh = Math.min(top, rng.range(2, 6)), vg = new THREE.PlaneGeometry(bw * 0.95, vh);
          const vm = new THREE.Matrix4().makeRotationY(Math.atan2(nx, nz));
          vg.applyMatrix4(vm); vg.translate(S.ax + ux * (t0 + t1) / 2 + nx * 0.04, top - vh / 2, S.az + uz * (t0 + t1) / 2 + nz * 0.04);
          this.batch.add(M.vines, vg);
        }
      }
      sOff += S.len;
    }
    // corner columns
    for (const [cx, cz] of corners) {
      const ix = cx === b.x0 ? 1 : -1, iz = cz === b.z0 ? 1 : -1;
      const top = b.collapsed ? rng.range(0.5, 2.5) : prof(rng.range(0, per)) + 0.3;
      this.addBox(mat, cx + ix * WT / 2, top / 2, cz + iz * WT / 2, WT + 0.06, top, WT + 0.06, 0, tint, 0.33, 0, 0, 0, true);
      col.add(cx + ix * WT / 2, cz + iz * WT / 2, WT / 2 + 0.03, WT / 2 + 0.03, 0, top);
    }
    const intact = !b.collapsed && minTop >= H - 0.25;
    // upper slabs (partial) + roof on fully intact buildings
    const cell = 3;
    for (let f = 1; f <= b.floors && !b.collapsed; f++) {
      const y = f * FH, roof = f === b.floors;
      if (roof && !intact) break;
      for (let x = b.x0 + WT; x < b.x1 - WT - 0.5; x += cell) for (let z = b.z0 + WT; z < b.z1 - WT - 0.5; z += cell) {
        const edgeCell = x < b.x0 + cell || z < b.z0 + cell || x > b.x1 - cell * 1.5 || z > b.z1 - cell * 1.5;
        if (!roof && rng.next() > (1 - b.damage) * (edgeCell ? 0.75 : 0.35)) continue;
        if (roof && rng.next() < b.damage * 0.25) continue; // roof holes
        const sx = Math.min(cell, b.x1 - WT - x), sz = Math.min(cell, b.z1 - WT - z);
        this.addBox(roof ? M.roof : M.slab, x + sx / 2, y - 0.12, z + sz / 2, sx + 0.02, 0.24, sz + 0.02, 0, roof ? 0xffffff : 0xa8a49c, 0.33);
      }
    }
    if (intact) this.roofKit(b, H, rng);
    // collapsed slab ramp
    if (b.floors >= 2 && !b.collapsed && rng.chance(b.damage * 0.8) && w > 7 && d > 7) {
      const along = rng.chance(0.5), len = 5.5, ang = Math.asin(Math.min(0.95, FH / len));
      const cx = rng.range(b.x0 + 3.5, b.x1 - 3.5), cz = rng.range(b.z0 + 3.5, b.z1 - 3.5);
      const ry = along ? 0 : Math.PI / 2;
      this.addBox(M.slab, cx, FH / 2, cz, len, 0.25, 3.2, ry, 0x9c988f, 0.33, 0, along ? ang * rng.sign() : 0);
      col.add(cx, cz, 1.6, 1.4, ry, 1.6, { kind: 'cover' });
      for (let i = 0; i < 8; i++) this.rubble.add(cx + rng.range(-2.5, 2.5), 0.05, cz + rng.range(-2.5, 2.5), rng.range(0.15, 0.5), rng.range(0, 3), rng.range(0, 3), 0);
    }
    // occasional fire burning inside the ruin (light pool + smoke through the roof)
    if (!b.edge && rng.chance(b.collapsed ? 0.15 : 0.22)) {
      const fx = rng.range(b.x0 + 1.5, b.x1 - 1.5), fz = rng.range(b.z0 + 1.5, b.z1 - 1.5);
      for (let i = 0; i < 5; i++) this.debris.add(fx + rng.range(-0.5, 0.5), 0.15, fz + rng.range(-0.5, 0.5), 1, rng.range(-0.4, 0.4), rng.range(0, 6), rng.range(-0.3, 0.3), 0x1a1410);
      this.decals.push({ kind: 'scorch', x: fx, z: fz, s: 3, rot: rng.range(0, 6) });
      this.addFire(fx, 0.15, fz, rng.range(0.7, 1.0));
      this.col.add(fx, fz, 0.4, 0.4, 0, 0.5, { kind: 'fire', blocksShots: false });
    }
    // interior partition with door gap
    if (!b.collapsed && (w > 11 || d > 11) && rng.chance(0.7)) {
      const ph = Math.min(FH, H);
      if (w > d) { const x = rng.range(b.x0 + 4, b.x1 - 4), gz = rng.range(b.z0 + 1.5, b.z1 - 2.5); this.wallSeg(mat, x, b.z0 + WT, x, gz, ph, tint); this.wallSeg(mat, x, gz + 1.6, x, b.z1 - WT, ph, tint); }
      else { const z = rng.range(b.z0 + 4, b.z1 - 4), gx = rng.range(b.x0 + 1.5, b.x1 - 2.5); this.wallSeg(mat, b.x0 + WT, z, gx, z, ph, tint); this.wallSeg(mat, gx + 1.6, z, b.x1 - WT, z, ph, tint); }
    }
    // interior rubble / clutter
    const area = w * d, nr = Math.floor(area * (b.collapsed ? 0.25 : 0.05 + b.damage * 0.08));
    for (let i = 0; i < nr; i++) this.rubble.add(rng.range(b.x0 + 0.8, b.x1 - 0.8), 0.1, rng.range(b.z0 + 0.8, b.z1 - 0.8), rng.range(0.1, 0.35), rng.range(0, 3), rng.range(0, 3), 0);
    for (let i = 0; i < nr; i++) this.bricks.add(rng.range(b.x0 + 0.5, b.x1 - 0.5), 0.14, rng.range(b.z0 + 0.5, b.z1 - 0.5), 1, rng.range(-0.3, 0.3), rng.range(0, 6), 0);
    for (let i = 0; i < nr / 4; i++) this.debris.add(rng.range(b.x0 + 1, b.x1 - 1), 0.15, rng.range(b.z0 + 1, b.z1 - 1), 1, rng.range(-0.2, 0.2), rng.range(0, 6), rng.range(-0.2, 0.2));
    if (!b.collapsed) this.interiorClutter(b, rng);
    if (b.collapsed) {
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, r = Math.min(w, d) * 0.32;
      const mg = rockGeo(b.seed % 1000, 2); mg.scale(r, rng.range(1.6, 2.6), r * (d / w > 1.3 ? 1.4 : 1)); mg.translate(cx, -0.3, cz);
      boxUV(mg, 0.3); this.batch.add(M.rubble, mg);
      col.add(cx, cz, r * 0.75, r * 0.75, 0, 2.2, { kind: 'rubble' });
      for (let i = 0; i < 30; i++) { const a = rng.range(0, 6.28), rr = rng.range(0, r * 1.3); this.rubble.add(cx + Math.cos(a) * rr, rng.range(0, 1.2), cz + Math.sin(a) * rr, rng.range(0.25, 0.8), rng.range(0, 3), rng.range(0, 3), 0); }
      for (let i = 0; i < 6; i++) { const a = rng.range(0, 6.28); this.addBox(M.rust, cx + Math.cos(a) * r * 0.6, 1.2, cz + Math.sin(a) * r * 0.6, 0.18, 0.3, rng.range(3, 6), rng.range(0, 3), 0xffffff, 1, rng.range(-0.6, 0.6), rng.range(-0.5, 0.5)); }
      // slabs that pancaked onto the heap
      for (let i = 0; i < 3; i++) this.addBox(M.slab, cx + rng.range(-r, r) * 0.6, rng.range(0.6, 1.6), cz + rng.range(-r, r) * 0.6, rng.range(2.5, 4), 0.22, rng.range(2.5, 4), rng.range(0, 3), 0x9c988f, 0.33, rng.range(-0.4, 0.4), rng.range(-0.4, 0.4));
    }
    this.facadeKit(b, sideInfo, H, rng, shop, shopColor);
  }

  // ---- building kit helpers ----------------------------------------------------------------
  // place kit parts on a wall: t along side, y height, out offset from the wall face
  onWall(S, parts, t, y, out = 0) {
    const ry = Math.atan2(S.nx, S.nz); // local +z -> outward normal
    this.place(parts, S.ax + S.ux * t + S.nx * out, y, S.az + S.uz * t + S.nz * out, ry);
  }
  windowFill(S, a, c, y0, y1, rng, shopFront, b) {
    const M = this.M, w = c - a, h = y1 - y0, tc = (a + c) / 2;
    if (w < 0.3 || h < 0.3) return;
    const P = [];
    const depth = -WT * 0.55; // frames sit mid-wall
    const fr = 0.06;
    if (shopFront && rng.chance(0.55)) { // rolling shutter, partly down
      const down = rng.range(0.35, 1) * h;
      P.push({ mat: M.shutter, geo: colorize(K.box(w + 0.1, down, 0.05, 0, h - down / 2, -0.05).toNonIndexed(), 0xffffff) });
      P.push({ mat: M.kitMetal, geo: colorize(K.box(w + 0.2, 0.28, 0.3, 0, h + 0.1, 0.05).toNonIndexed(), 0x8a8a84) });
      if (down < h - 0.2) P.push({ mat: M.interiorDark, geo: colorize(K.box(w, h - down, 0.04, 0, (h - down) / 2, -WT + 0.04).toNonIndexed(), 0xffffff) });
      this.onWall(S, P, tc, y0, 0);
      return;
    }
    P.push({ mat: M.frame, geo: colorize(K.box(w, fr, 0.08, 0, fr / 2, depth).toNonIndexed(), 0xffffff) });
    P.push({ mat: M.frame, geo: colorize(K.box(w, fr, 0.08, 0, h - fr / 2, depth).toNonIndexed(), 0xffffff) });
    P.push({ mat: M.frame, geo: colorize(K.box(fr, h, 0.08, -w / 2 + fr / 2, h / 2, depth).toNonIndexed(), 0xffffff) });
    P.push({ mat: M.frame, geo: colorize(K.box(fr, h, 0.08, w / 2 - fr / 2, h / 2, depth).toNonIndexed(), 0xffffff) });
    if (w > 1.2) P.push({ mat: M.frame, geo: colorize(K.box(0.05, h, 0.06, 0, h / 2, depth).toNonIndexed(), 0xffffff) });
    if (!shopFront) P.push({ mat: M.frame, geo: colorize(K.box(w, 0.04, 0.06, 0, h * 0.62, depth).toNonIndexed(), 0xffffff) });
    const st = rng.next();
    if (st < 0.3) P.push({ mat: M.pane, geo: colorize(K.box(w - 0.1, h - 0.1, 0.02, 0, h / 2, depth).toNonIndexed(), 0xffffff) });
    else if (st < 0.5) { const ph = rng.range(0.2, 0.6) * h; P.push({ mat: M.pane, geo: colorize(K.box(w * rng.range(0.4, 0.9), ph, 0.02, rng.range(-0.1, 0.1), ph / 2 + 0.05, depth).toNonIndexed(), 0xffffff) }); }
    else if (st < 0.62 && !shopFront) { // boarded up
      for (let i = 0; i < rng.int(2, 4); i++) P.push({ mat: M.wood, geo: K.box(w + 0.2, 0.2, 0.03, 0, rng.range(0.2, h - 0.2), 0.03, 0, 0, rng.range(-0.25, 0.25)) });
    }
    if (!shopFront && st >= 0.62 && rng.chance(0.22)) { // someone still lives here: warm/cold lit interior behind the frame
      const col = rng.pick([0xffa050, 0xff9040, 0xffc080, 0x80b0ff, 0xff6040]);
      P.push({ mat: M.windowLit, geo: colorize(K.box(w, h, 0.02, 0, h / 2, -WT - 0.35).toNonIndexed(), new THREE.Color(col).multiplyScalar(rng.range(0.5, 1))) });
      if (this.winLights++ < 40) this.lighting.addSource(new THREE.Vector3(S.ax + S.ux * tc + S.nx * 0.8, y0 + h / 2, S.az + S.uz * tc + S.nz * 0.8), col, 5, 6, rng.chance(0.3) ? 'lamp' : 'steady', { priority: 0.6 });
    }
    this.onWall(S, P, tc, y0, 0);
    if (shopFront && rng.chance(0.5)) { // dark interior shelf silhouettes
      this.onWall(S, [{ mat: M.interiorDark, geo: colorize(K.box(w * 0.8, 1.2, 0.4, 0, 0.6, -WT - 0.6).toNonIndexed(), 0xffffff) }], tc, 0.12, 0);
    }
  }
  doorway(S, a, c, h, rng, shop) {
    const M = this.M, w = c - a, tc = (a + c) / 2, P = [];
    P.push({ mat: M.frame, geo: colorize(K.box(0.1, h, 0.12, -w / 2 + 0.05, h / 2, -WT / 2).toNonIndexed(), 0xffffff) });
    P.push({ mat: M.frame, geo: colorize(K.box(0.1, h, 0.12, w / 2 - 0.05, h / 2, -WT / 2).toNonIndexed(), 0xffffff) });
    P.push({ mat: M.frame, geo: colorize(K.box(w, 0.12, 0.12, 0, h - 0.06, -WT / 2).toNonIndexed(), 0xffffff) });
    if (rng.chance(0.4)) { // door hanging open / fallen
      P.push({ mat: shop ? M.kitMetal : M.wood, geo: colorize(K.box(0.05, h - 0.15, w * 0.45, -w / 2 + 0.1, (h - 0.15) / 2, w * 0.22, 0, 0, 0).toNonIndexed(), 0x707068) });
    }
    this.onWall(S, P, tc, 0.12, 0);
  }
  facadeKit(b, sides, H, rng, shop, shopColor) {
    if (b.collapsed) return;
    const M = this.M, signCell = rng.int(0, SIGN_WORDS.length - 1), shopSign = rng.int(0, SIGN_WORDS.length - 1);
    let bladeDone = false, escape = b.style === 'brick' && b.floors >= 3 && rng.chance(0.6) ? rng.int(0, 3) : -1;
    for (let si = 0; si < 4; si++) {
      const S = sides[si];
      const street = this.facesRoad(S);
      // shop signage + awnings on the ground floor
      for (let k = 0; k < S.bays.length; k++) {
        const bay = S.bays[k], tm = (bay.t0 + bay.t1) / 2, bw = bay.t1 - bay.t0;
        if (bay.top < FH) continue;
        if (shop && street) {
          const g = bay.wins.find((w) => w.f === 0);
          if ((g || bay.isDoor) && rng.chance(0.7)) {
            if (rng.chance(0.45)) this.onWall(S, K.awningParts(bw * 0.95, rng, shopColor), tm, 2.95, 0.02);
            else this.addSign(S, tm, 3.1, Math.min(bw * 0.92, 2.8), rng, false, shopSign);
          }
        }
        // posters on street-level piers
        if (street && rng.chance(0.3) && !bay.isDoor) this.poster(S, bay.t0 + PW / 2 + rng.range(-0.05, 0.05), rng.range(1.1, 1.8), rng);
        // AC units / balconies on upper floors
        for (const win of bay.wins) {
          if (win.f === 0) continue;
          if (rng.chance(0.13)) this.onWall(S, K.acUnitParts(), (win.a + win.c) / 2 + rng.range(-0.2, 0.2), win.sill - 0.4, 0);
          else if (b.style !== 'brick' && rng.chance(0.09) && bw > 2) this.onWall(S, K.balconyParts(bw - 0.2, rng), tm, win.f * FH + 0.05, 0);
        }
        // vertical blade sign at a street corner (1st-2nd floor), flickering neon
        if (!bladeDone && street && (k === 0 || k === S.bays.length - 1) && bay.top > FH * 2 && rng.chance(Math.min(0.95, 0.55 * this.neon))) {
          bladeDone = true;
          const t = k === 0 ? bay.t0 + 0.6 : bay.t1 - 0.6;
          this.addSign(S, t, FH * 1.5 + rng.range(-0.3, 0.8), rng.range(2.2, 3.2), rng, true, signCell);
        }
      }
      // fire escape on a brick side
      if (si === escape && S.len > 6) {
        const t = rng.range(2, S.len - 2.5), fl = Math.floor(Math.min(...S.bays.filter((bb) => Math.abs((bb.t0 + bb.t1) / 2 - t) < 3).map((bb) => bb.top), H) / FH);
        if (fl >= 2) this.onWall(S, K.fireEscapeParts(fl, 3.2, rng), t, 0, 0.02);
      }
      // utility conduit run along the facade with brackets and drops (industrial look)
      if (street && S.len > 6 && rng.chance(b.style === 'brick' ? 0.35 : 0.25)) {
        const y = rng.range(2.9, 3.4), t0 = rng.range(0.6, 2), t1 = S.len - rng.range(0.6, 2), r = rng.range(0.05, 0.09);
        const parts = [{ mat: M.kitMetal, geo: colorize(K.cyl(r, r, t1 - t0, 6, 0, 0, 0.16, 0, 0, Math.PI / 2).toNonIndexed(), 0x7a7a72) }];
        for (let t = 0; t <= t1 - t0; t += 1.6) parts.push({ mat: M.kitRust, geo: colorize(K.box(0.05, 0.16, 0.18, (t0 + t1) / 2 - t0 - t, 0, 0.08).toNonIndexed(), 0xffffff) });
        if (rng.chance(0.6)) parts.push({ mat: M.kitMetal, geo: colorize(K.cyl(r, r, y, 6, rng.range(-1, 1) * (t1 - t0) / 2, -y / 2, 0.16).toNonIndexed(), 0x7a7a72) });
        if (rng.chance(0.5)) parts.push({ mat: M.kitMetal, geo: colorize(K.box(0.5, 0.6, 0.22, rng.range(-1, 1) * (t1 - t0) / 3, -0.6, 0.12).toNonIndexed(), 0x8a8a80) }); // junction box
        this.onWall(S, parts, (t0 + t1) / 2, y, 0);
      }
      // drain pipe on one corner
      if (rng.chance(0.45)) { const h = Math.min(H, S.bays[0] ? S.bays[0].top : H); if (h > 3) this.onWall(S, K.drainpipeParts(h - 0.2), 0.55, 0, 0); }
      // hanging cables between facades: register anchors on street sides
      if (street) for (const bay of S.bays) if (bay.top > 6 && rng.chance(0.4)) this.anchors.push({ x: S.ax + S.ux * ((bay.t0 + bay.t1) / 2) + S.nx * 0.05, y: rng.range(4.5, Math.min(bay.top - 0.5, 9)), z: S.az + S.uz * ((bay.t0 + bay.t1) / 2) + S.nz * 0.05, nx: S.nx, nz: S.nz });
    }
  }
  facesRoad(S) { // outward normal points at a road within a few metres
    const mx = (S.ax + S.bx) / 2 + S.nx * 4, mz = (S.az + S.bz) / 2 + S.nz * 4;
    for (const r of this.L.roads) { if (r.axis === 'z' ? Math.abs(mx - r.x) < r.w / 2 + 3 : Math.abs(mz - r.z) < r.w / 2 + 3) return true; }
    return false;
  }
  addSign(S, t, y, w, rng, blade, cell = rng.int(0, SIGN_WORDS.length - 1)) {
    const dead = rng.chance(0.28), seed = rng.next() < 0.45 ? rng.range(0.5, 0.74) : rng.range(0.76, 1.0);
    const h = blade ? w * 0.5 : w * 0.5;
    this.onWall(S, K.signParts(cell, w, h, blade, seed, dead), t, y, 0);
    const out = blade ? w / 2 + 0.25 : 0.5;
    const pos = new THREE.Vector3(S.ax + S.ux * t + S.nx * (out + 0.6), y, S.az + S.uz * t + S.nz * (out + 0.6));
    const color = new THREE.Color(SIGN_WORDS[cell][1]);
    const flicker = seed < 0.75;
    this.signs.push({ pos, color, flicker, seed, dead, blade, word: SIGN_WORDS[cell][0] });
    if (!dead) this.lighting.addSource(pos, color, blade ? 16 : 10, blade ? 9 : 7, flicker ? 'lamp' : 'steady', { priority: 0.9 });
  }
  poster(S, t, y, rng) {
    const cell = rng.int(0, 7), w = 0.55, h = 0.8;
    const g = new THREE.PlaneGeometry(w, h); const uv = g.attributes.uv;
    const u0 = (cell % 4) / 4, v0 = cell < 4 ? 0.5 : 0;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.25, v0 + uv.getY(i) * 0.5);
    g.rotateZ(rng.range(-0.08, 0.08));
    this.onWall(S, [{ mat: this.M.poster, geo: g }], t, y, 0.025);
    if (rng.chance(0.5)) { const g2 = g.clone(); g2.translate(rng.range(0.25, 0.45), rng.range(-0.25, 0.25), 0.003); this.onWall(S, [{ mat: this.M.poster, geo: g2 }], t, y, 0.025); }
  }
  roofKit(b, H, rng) {
    const M = this.M, w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    // parapet coping
    for (const [x0, z0, x1, z1] of [[b.x0, b.z0, b.x1, b.z0], [b.x0, b.z1, b.x1, b.z1], [b.x0, b.z0, b.x0, b.z1], [b.x1, b.z0, b.x1, b.z1]]) {
      const ax = Math.abs(x1 - x0) > 0.1;
      this.addBox(M.trim, (x0 + x1) / 2, H + 0.35, (z0 + z1) / 2, ax ? w + 0.2 : 0.5, 0.7, ax ? 0.5 : d + 0.2, 0, 0xa8a49c, 0.5);
    }
    const n = Math.max(1, Math.floor((w * d) / 40));
    for (let i = 0; i < n; i++) {
      const x = rng.range(b.x0 + 1.5, b.x1 - 1.5), z = rng.range(b.z0 + 1.5, b.z1 - 1.5);
      if (i === 0 && rng.chance(0.4) && w > 6 && d > 6) this.place(K.waterTankParts(rng), x, H, z, rng.range(0, 3));
      else if (rng.chance(0.55)) this.place(K.roofVentParts(rng), x, H, z, rng.range(0, 6));
      else this.place(K.acUnitParts(), x, H + 0.3, z, rng.range(0, 6));
    }
    if (rng.chance(0.3 * this.neon)) this.addSignRoof(b, H, rng, cx, cz);
  }
  addSignRoof(b, H, rng, cx, cz) { // billboard on the roof facing the street (camera side)
    const M = this.M, w = Math.min(6, (b.x1 - b.x0) * 0.7), h = w * 0.5, cell = rng.int(0, SIGN_WORDS.length - 1), seed = rng.range(0.5, 1), dead = rng.chance(0.35);
    const ry = rng.chance(0.5) ? 0 : Math.PI / 2;
    const parts = [];
    for (const x of [-w * 0.35, w * 0.35]) parts.push({ mat: M.kitRust, geo: colorize(K.box(0.12, 1.6, 0.12, x, 0.8, 0).toNonIndexed(), 0xffffff) });
    const g = K.uvCell(K.box(w, h, 0.12, 0, 1.6 + h / 2, 0), cell); colorize(g, new THREE.Color(seed, seed, seed));
    parts.push({ mat: dead ? M.signDead : M.neon, geo: g });
    this.place(parts, cx, H, cz, ry);
    const pos = new THREE.Vector3(cx + Math.sin(ry) * 1.2, H + 1.6 + h / 2, cz + Math.cos(ry) * 1.2);
    const color = new THREE.Color(SIGN_WORDS[cell][1]);
    this.signs.push({ pos, color, flicker: seed < 0.75, seed, dead, roof: true, word: SIGN_WORDS[cell][0] });
    if (!dead) this.lighting.addSource(pos, color, 22, 12, seed < 0.75 ? 'lamp' : 'steady', { priority: 0.8 });
  }
  interiorClutter(b, rng) { // furniture silhouettes: overturned tables, shelves, crates, mattresses
    const M = this.M, n = Math.floor(((b.x1 - b.x0) * (b.z1 - b.z0)) / 30);
    for (let i = 0; i < n; i++) {
      const x = rng.range(b.x0 + 1.2, b.x1 - 1.2), z = rng.range(b.z0 + 1.2, b.z1 - 1.2), r = rng.range(0, 6.28);
      const k = rng.int(0, 4);
      if (k === 0) this.place(K.crateParts(rng), x, 0.12, z, r);
      else if (k === 1) this.place(K.mattressParts(rng), x, 0.12, z, r);
      else if (k === 2) { this.place([{ mat: M.wood, geo: K.box(1.4, 0.06, 0.8, 0, 0.75, 0) }, ...[[-0.6, -0.3], [0.6, -0.3], [-0.6, 0.3], [0.6, 0.3]].map(([a, c]) => ({ mat: M.wood, geo: K.box(0.06, 0.75, 0.06, a, 0.37, c) }))], x, 0.12, z, r, 1, rng.chance(0.4) ? Math.PI / 2 : 0); }
      else if (k === 3) this.place(K.cardboardParts(rng, rng.int(2, 4)), x, 0.12, z, r);
      else this.place(K.bagPileParts(rng, rng.int(2, 4)), x, 0.12, z, r);
    }
  }

  trim(S, ux, uz, nx, nz, t0, t1, y0, y1, out) {
    const tc = (t0 + t1) / 2, cx = S.ax + ux * tc + nx * (out / 2 - 0.02), cz = S.az + uz * tc + nz * (out / 2 - 0.02);
    const alongX = Math.abs(ux) > 0.5, len = t1 - t0;
    this.addBox(this.M.trim, cx, (y0 + y1) / 2, cz, alongX ? len : out, y1 - y0, alongX ? out : len, 0, 0xffffff, 0.5);
  }
  graffiti(S, ux, uz, nx, nz, t, y, w, cell) {
    const g = new THREE.PlaneGeometry(w, w * 0.62);
    const u0 = (cell % 4) / 4, v0 = cell < 4 ? 0.5 : 0, uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.25, v0 + uv.getY(i) * 0.5);
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.atan2(nx, nz)));
    g.translate(S.ax + ux * t + nx * 0.035, y + w * 0.31, S.az + uz * t + nz * 0.035);
    this.batch.add(this.M.graffiti, g);
  }

  wallSeg(mat, x0, z0, x1, z1, h, tint) {
    const len = Math.hypot(x1 - x0, z1 - z0); if (len < 0.3) return;
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, sx = alongX ? len : 0.25, sz = alongX ? 0.25 : len;
    this.addBox(mat, cx, h / 2, cz, sx, h, sz, 0, tint);
    this.col.add(cx, cz, sx / 2, sz / 2, 0, h, { kind: 'wall' });
  }

  buildProp(p) {
    const M = this.M, col = this.col, rng = new RNG(p.seed || ((p.x * 1000 + p.z) | 0));
    const rot = p.rot || 0;
    switch (p.type) {
      case 'car': {
        const parts = P.carParts(p.variant, p.paint, p.burnt);
        const [hx, hh, hz] = P.carSize(p.variant);
        if (p.flipped && p.variant <= 3) { this.place(parts, p.x, 1.55, p.z, rot, 1, 0, Math.PI); col.add(p.x, p.z, hx, hz, rot, 1.5, { kind: 'car' }); }
        else {
          const sink = p.burnt ? -0.12 : 0, roll = p.burnt ? rng.range(-0.04, 0.04) : rng.range(-0.02, 0.02);
          this.place(parts, p.x, sink, p.z, rot, 1, roll, rng.range(-0.03, 0.03));
          col.add(p.x, p.z, hx, hz, rot, hh * 2 + 0.3, { kind: 'car' });
          // roof cargo / debris on some wrecks
          if (p.variant <= 3 && rng.chance(0.25)) this.place(rng.chance(0.5) ? K.cardboardParts(rng, 2) : K.bagPileParts(rng, 2), p.x, p.variant === 1 ? 2.05 : 1.45, p.z, rot + rng.range(-0.3, 0.3), 0.8);
        }
        // shattered glass + oil under wrecks
        for (let i = 0; i < 14; i++) this.shards.add(p.x + rng.range(-hx, hx) * 0.9, 0.025, p.z + rng.range(-hx, hx) * 0.9, rng.range(0.6, 1.4), rng.range(-0.2, 0.2), rng.range(0, 6), rng.range(-0.2, 0.2));
        if (rng.chance(0.6)) this.decals.push({ kind: rng.chance(0.5) ? 'oil' : 'stain', x: p.x, z: p.z, s: rng.range(2.5, 4.5), rot: rng.range(0, 6) });
        if (p.burnt) this.decals.push({ kind: 'scorch', x: p.x, z: p.z, s: hx * 2 + 1.2, rot: rot });
        if (p.burnt && rng.chance(0.25)) this.smokes.push({ x: p.x, y: 1.2, z: p.z, s: 0.8 });
        if (p.burnt && rng.chance(0.08)) this.addFire(p.x, 0.9, p.z, 1.0);
        break;
      }
      case 'hydrant': this.place(K.hydrantParts(), p.x, this.heightAt(p.x, p.z), p.z, rot); col.add(p.x, p.z, 0.18, 0.18, 0, 0.7, { kind: 'cover' }); break;
      case 'newsbox': this.place(K.newsboxParts(rng), p.x, this.heightAt(p.x, p.z), p.z, rot); col.add(p.x, p.z, 0.26, 0.24, rot, 1.0, { kind: 'cover' }); break;
      case 'trashcan': this.place(K.trashCanParts(rng), p.x, this.heightAt(p.x, p.z), p.z, rot); col.add(p.x, p.z, 0.3, 0.3, 0, 0.9, { kind: 'barrel' }); break;
      case 'bags': this.place(K.bagPileParts(rng, rng.int(3, 8)), p.x, this.heightAt(p.x, p.z), p.z, rot); break;
      case 'cardboard': this.place(K.cardboardParts(rng, rng.int(1, 4)), p.x, this.heightAt(p.x, p.z), p.z, rot); break;
      case 'pallet': this.place(K.palletParts(rng), p.x, this.heightAt(p.x, p.z), p.z, rot, 1, 0, rng.chance(0.2) ? 1.2 : 0); break;
      case 'crates': this.place(K.crateParts(rng), p.x, this.heightAt(p.x, p.z), p.z, rot); col.add(p.x, p.z, 0.8, 0.5, rot, 0.9, { kind: 'cover' }); break;
      case 'cone': { const tip = rng.chance(0.3); this.place(K.coneParts(), p.x, tip ? 0.16 : 0, p.z, rot, 1, tip ? Math.PI / 2 : 0, 0); break; }
      case 'bollard': this.place(K.bollardParts(), p.x, this.heightAt(p.x, p.z), p.z, rot); col.add(p.x, p.z, 0.12, 0.12, 0, 0.9, { kind: 'pole' }); break;
      case 'planter': {
        const y = this.heightAt(p.x, p.z);
        this.place(K.planterParts(rng), p.x, y, p.z, rot);
        if (rng.chance(0.5)) this.place(P.deadTreeParts(rng, 0.55, false), p.x, y + 0.6, p.z, rng.range(0, 6)); else this.place(P.bushParts(rng, 0.8), p.x, y + 0.55, p.z, 0);
        col.add(p.x, p.z, 0.8, 0.8, rot, 0.6, { kind: 'cover' }); break;
      }
      case 'busstop': this.place(K.busStopParts(rng), p.x, this.heightAt(p.x, p.z), p.z, rot); col.add(p.x, p.z, 1.7, 0.75, rot, 2.4, { kind: 'cover', blocksShots: false }); break;
      case 'phone': this.place(K.phoneBoothParts(), p.x, this.heightAt(p.x, p.z), p.z, rot); col.add(p.x, p.z, 0.45, 0.45, rot, 2.3, { kind: 'cover' }); break;
      case 'streetSign': this.place(K.streetSignParts(rng), p.x, this.heightAt(p.x, p.z), p.z, rot); col.add(p.x, p.z, 0.05, 0.05, 0, 2.5, { kind: 'pole', blocksShots: false }); break;
      case 'cart': this.place(K.cartParts(), p.x, 0, p.z, rot, 1, 0, rng.chance(0.4) ? Math.PI / 2 - 0.1 : 0); break;
      case 'mattress': this.place(K.mattressParts(rng), p.x, this.heightAt(p.x, p.z), p.z, rot); break;
      case 'tarp': this.place(K.tarpParts(rng), p.x, 0, p.z, rot); break;
      case 'debrisField': {
        const s2 = p.s || 3;
        for (let i = 0; i < 26 * s2; i++) { const a = rng.range(0, 6.28), r = Math.sqrt(rng.next()) * s2; const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r * rng.range(0.6, 1); const k = rng.next();
          if (k < 0.35) (k < 0.25 ? this.pebbles : this.rubble).add(x, 0.02, z, rng.range(0.05, 0.22), rng.range(0, 3), rng.range(0, 3), 0);
          else if (k < 0.55) this.bricks.add(x, 0.04, z, 1, rng.range(-0.3, 0.3), rng.range(0, 6), rng.range(-0.3, 0.3));
          else if (k < 0.85) this.litter.add(x, 0.015, z, rng.range(0.7, 1.4), rng.range(-0.1, 0.1), rng.range(0, 6.3), 0, rng.pick([0xd8d0bc, 0xb8b0a0, 0x9a9488]));
          else if (k < 0.95) this.debris.add(x, 0.03, z, 1, rng.range(-0.1, 0.1), rng.range(0, 6), rng.range(-0.1, 0.1));
          else this.cans.add(x, 0.04, z, 1, 0, rng.range(0, 6.3), 0, rng.pick([0x8a2a20, 0x6a7a80, 0x2a5a2a]));
        }
        this.decals.push({ kind: rng.chance(0.5) ? 'stain' : 'dirt', x: p.x, z: p.z, s: s2 * 2, rot: rng.range(0, 6) });
        if (rng.chance(0.5)) { const g = rockGeo(rng.int(1, 999), 1); const k = rng.range(0.6, 1.1); g.scale(k, k * 0.4, k); g.translate(p.x, -0.05, p.z); boxUV(g, 0.4); this.batch.add(M.rubble, g); }
        break;
      }
      case 'crater': {
        const s2 = p.s || 2;
        this.decals.push({ kind: 'scorch', x: p.x, z: p.z, s: s2 * 2.6, rot: rng.range(0, 6) });
        this.decals.push({ kind: 'patch', x: p.x, z: p.z, s: s2 * 1.1, rot: rng.range(0, 6) });
        for (let i = 0; i < 16; i++) { const a = (i / 16) * 6.28 + rng.range(-0.2, 0.2), r = s2 * rng.range(0.75, 1.05); this.rubble.add(p.x + Math.cos(a) * r, 0.02, p.z + Math.sin(a) * r, rng.range(0.18, 0.42), rng.range(0, 3), rng.range(0, 3), 0, 0x5a5650); }
        for (let i = 0; i < 10; i++) { const a = rng.range(0, 6.28), r = s2 * rng.range(1.1, 2.2); this.rubble.add(p.x + Math.cos(a) * r, 0.02, p.z + Math.sin(a) * r, rng.range(0.06, 0.16), rng.range(0, 3), rng.range(0, 3), 0, 0x4a4640); }
        break;
      }
      case 'hedgehog': {
        const parts = []; for (let i = 0; i < 3; i++) parts.push({ mat: M.rust, geo: K.box(1.8, 0.12, 0.12, 0, 0.55, 0, i === 0 ? 0.6 : i === 1 ? -0.6 : 0, i * 1.05, i === 2 ? 0.95 : 0) });
        this.place(parts, p.x, 0, p.z, rot); col.add(p.x, p.z, 0.7, 0.7, rot, 1.0, { kind: 'cover', blocksShots: false }); break;
      }
      case 'treepit': {
        const y = this.heightAt(p.x, p.z);
        this.addBox(M.trim, p.x, y + 0.04, p.z, 1.3, 0.1, 1.3, 0, 0x8a8680, 0.5);
        this.place(P.deadTreeParts(rng, p.s || 1, !p.dead), p.x, y, p.z, rng.range(0, 6));
        if (rng.chance(0.6)) this.place(P.bushParts(rng, 0.6), p.x, y, p.z, 0);
        col.add(p.x, p.z, 0.2, 0.2, 0, 4, { kind: 'tree' }); break;
      }
      case 'jersey': this.place(P.jerseyParts(p.len || 2.6), p.x, 0, p.z, rot); col.add(p.x, p.z, (p.len || 2.6) / 2, 0.32, rot, 0.85, { kind: 'cover' }); break;
      case 'sandbags': this.place(P.sandbagParts(p.len || 3, rng), p.x, 0, p.z, rot); col.add(p.x, p.z, (p.len || 3) / 2, 0.3, rot, 0.8, { kind: 'cover' }); break;
      case 'planks': this.place(P.plankParts(p.len || 2.6, rng), p.x, 0, p.z, rot); col.add(p.x, p.z, (p.len || 2.6) / 2, 0.15, rot, 1.5, { kind: 'cover' }); break;
      case 'tires': this.place(P.tireParts(rng), p.x, 0, p.z, rot); col.add(p.x, p.z, 0.9, 0.45, rot, 0.75, { kind: 'cover' }); break;
      case 'barrel': {
        this.place(P.barrelParts(rng), p.x, 0, p.z, rng.range(0, 6));
        col.add(p.x, p.z, 0.3, 0.3, 0, 0.9, { kind: 'barrel' });
        if (p.burning) this.addFire(p.x, 0.95, p.z, 0.6);
        break;
      }
      case 'container': {
        this.place(P.containerParts(p.color || 0), p.x, 0, p.z, rot);
        let h = 2.6;
        if (p.stacked) { this.place(P.containerParts(((p.color || 0) + 1) % 4), p.x, 2.62, p.z, rot + rng.range(-0.1, 0.1)); h = 5.2; }
        col.add(p.x, p.z, 3.05, 1.24, rot, h, { kind: 'container' });
        break;
      }
      case 'dumpster': this.place(P.dumpsterParts(), p.x, 0, p.z, rot); col.add(p.x, p.z, 0.95, 0.55, rot, 1.3, { kind: 'cover' }); break;
      case 'lamp': {
        this.place(P.lampParts(p.bent, p.working), p.x, 0, p.z, rot);
        col.add(p.x, p.z, 0.15, 0.15, 0, 6, { kind: 'pole' });
        if (p.working) {
          const c = Math.cos(rot), s = Math.sin(rot); const lx = p.bent ? 3.5 : 1.55, ly = p.bent ? 5.1 : 5.9; // bent poles are rotated -0.35rad about Z
          const lp = new THREE.Vector3(p.x + c * lx, ly, p.z - s * lx);
          const src = this.lighting.addSource(lp, 0xffa855, 60, 16, 'lamp');
          this.vol.add(lp, 0xffa060, src, ly - 0.1, 2.6);
        }
        break;
      }
      case 'trafficLight': {
        this.place(P.trafficLightParts(p.working), p.x, 0, p.z, rot);
        col.add(p.x, p.z, 0.12, 0.12, 0, 4, { kind: 'pole' });
        if (p.working) { const c = Math.cos(rot), s = Math.sin(rot); this.lighting.addSource(new THREE.Vector3(p.x + c * 3.1, 3.8, p.z - s * 3.1), 0xff2a10, 8, 7, 'strobe'); }
        break;
      }
      case 'tent': this.place(P.tentParts(rng), p.x, 0, p.z, rot); col.add(p.x, p.z, 1.3, 0.95, rot + Math.PI / 4, 1.6, { kind: 'tent', blocksShots: false }); break;
      case 'bench': this.place(P.benchParts(), p.x, 0, p.z, rot); col.add(p.x, p.z, 0.9, 0.3, rot, 0.6, { kind: 'cover' }); break;
      case 'fence': this.place(P.fenceParts(p.len, rng), p.x, 0, p.z, rot); col.add(p.x, p.z, p.len / 2, 0.06, rot, 2.1, { kind: 'fence', blocksShots: false }); break;
      case 'lightRig': {
        this.place(P.lightRigParts(), p.x, 0, p.z, rng.range(0, 6));
        const src = this.lighting.addSource(new THREE.Vector3(p.x, 3.2, p.z), 0xfff0d0, 45, 18, 'lamp', { priority: 1.5 });
        this.vol.add(new THREE.Vector3(p.x, 2.9, p.z), 0xfff0d0, src, 2.8, 3.2);
        col.add(p.x, p.z, 0.4, 0.4, 0, 1.2, { kind: 'pole', blocksShots: false });
        break;
      }
      case 'tree': {
        const parts = P.deadTreeParts(rng, p.s, !p.dead);
        this.place(parts, p.x, 0, p.z, rng.range(0, 6));
        col.add(p.x, p.z, 0.2 * p.s, 0.2 * p.s, 0, 4, { kind: 'tree' });
        break;
      }
      case 'bush': this.place(P.bushParts(rng, p.s || 1), p.x, 0, p.z, rng.range(0, 6)); break;
      case 'fire':
        if (p.debris) { // burning debris heap on the road
          for (let i = 0; i < 6; i++) this.debris.add(p.x + rng.range(-0.6, 0.6), 0.1, p.z + rng.range(-0.6, 0.6), 1, rng.range(-0.4, 0.4), rng.range(0, 6), rng.range(-0.3, 0.3), 0x1a1410);
          this.decals.push({ kind: 'scorch', x: p.x, z: p.z, s: 3.5, rot: rng.range(0, 6) });
        }
        this.addFire(p.x, 0.1, p.z, p.s || 1, p.campfire);
        break;
      case 'flare': {
        const g = new THREE.CylinderGeometry(0.025, 0.025, 0.28, 6); g.rotateZ(Math.PI / 2); g.rotateY(rot); g.translate(p.x, 0.04, p.z);
        this.batch.add(M.redLight, g);
        const src = this.lighting.addSource(new THREE.Vector3(p.x, 0.35, p.z), 0xff2a12, 14, 9, 'fire', { priority: 1.2 });
        this.flares.push({ x: p.x, z: p.z, src });
        break;
      }
      case 'rubblePile': {
        const s = p.s || 1;
        const g = rockGeo(p.seed % 1000, 1); g.scale(s, s * 0.45, s * rng.range(0.8, 1.3)); g.rotateY(rng.range(0, 6)); g.translate(p.x, -0.1, p.z);
        boxUV(g, 0.4); this.batch.add(M.rubble, g);
        for (let i = 0; i < 8 * s; i++) { const a = rng.range(0, 6.28), r = rng.range(0, s * 1.4); this.rubble.add(p.x + Math.cos(a) * r, 0.05, p.z + Math.sin(a) * r, rng.range(0.08, 0.3) * s, rng.range(0, 3), rng.range(0, 3), 0); }
        for (let i = 0; i < 6 * s; i++) { const a = rng.range(0, 6.28), r = rng.range(0, s * 1.6); this.bricks.add(p.x + Math.cos(a) * r, 0.04, p.z + Math.sin(a) * r, 1, rng.range(-0.4, 0.4), rng.range(0, 6), 0); }
        if (s > 1.2) col.add(p.x, p.z, s * 0.7, s * 0.7, 0, s * 0.42, { kind: 'rubble' });
        break;
      }
    }
  }

  addFire(x, y, z, s, campfire = false) {
    const M = this.M;
    if (campfire) {
      const rng = this.rng;
      for (let i = 0; i < 7; i++) { const a = (i / 7) * 6.28; this.rubble.add(x + Math.cos(a) * 0.55 * s, 0.05, z + Math.sin(a) * 0.55 * s, 0.16 * s, rng.range(0, 3), rng.range(0, 3), 0, 0x555048); }
      for (let i = 0; i < 4; i++) this.debris.add(x, 0.12, z, 0.7 * s, rng.range(-0.4, 0.4), (i / 4) * 3.14, rng.range(-0.3, 0.3), 0x221a12);
      this.col.add(x, z, 0.45 * s, 0.45 * s, 0, 0.5, { kind: 'fire', blocksShots: false });
    }
    this.fires.push({ x, y, z, s });
    this.lighting.addSource(new THREE.Vector3(x, y + 0.9, z), 0xff7a2a, 40 * s, 11 * Math.sqrt(s), 'fire', { priority: 1.3 });
  }

  // fine clutter: pebbles/chunks everywhere walkable, dirt drifts along curbs
  scatterGround() {
    const rng = new RNG(this.L.seed ^ 0x9e11), L = this.L;
    for (let i = 0; i < 2600; i++) {
      const x = rng.range(-HALF, HALF), z = rng.range(-HALF, HALF);
      if (this.col.blockedCircle(x, z, 0.2, 0.2)) continue;
      const big = rng.chance(0.15);
      (big ? this.rubble : this.pebbles).add(x, this.heightAt(x, z) + 0.01, z, big ? rng.range(0.12, 0.25) : rng.range(0.04, 0.1), rng.range(0, 3), rng.range(0, 3), rng.range(0, 3));
    }
    for (let i = 0; i < 500; i++) { const x = rng.range(-HALF, HALF), z = rng.range(-HALF, HALF); if (!this.col.blockedCircle(x, z, 0.2, 0.2)) this.bricks.add(x, this.heightAt(x, z) + 0.035, z, 1, 0, rng.range(0, 6), 0); }
    // paper litter, cans, bottles: biased toward curbs and walls via a density noise
    for (let i = 0; i < 3200; i++) {
      const x = rng.range(-HALF - 4, HALF + 4), z = rng.range(-HALF - 4, HALF + 4);
      if (fbm(x * 0.05, z * 0.05, 2, 31) < 0.42 || this.col.blockedCircle(x, z, 0.15, 0.2)) continue;
      const y = this.heightAt(x, z) + 0.012;
      if (rng.chance(0.7)) this.litter.add(x, y, z, rng.range(0.7, 1.4), rng.range(-0.1, 0.1), rng.range(0, 6.3), rng.range(-0.1, 0.1), rng.pick([0xd8d0bc, 0xb8b0a0, 0x9a9488, 0xc8b890, 0x8a8278]));
      else this.cans.add(x, y + 0.025, z, 1, 0, rng.range(0, 6.3), 0, rng.pick([0x8a2a20, 0x6a7a80, 0x2a5a2a, 0xa09060, 0x3a4a2a, 0x5a3a20]));
    }
    for (const r of L.roads) for (let a = -HALF; a < HALF; a += rng.range(3, 7)) {
      const side = rng.sign(), lat = side * (r.w / 2 - rng.range(0.3, 0.9));
      const [x, z] = r.axis === 'z' ? [r.x + lat, a] : [a, r.z + lat];
      L.decals.push({ kind: 'dirt', x, z, s: 1, sx: r.axis === 'z' ? rng.range(1.2, 2.4) : rng.range(3, 6), sz: r.axis === 'z' ? rng.range(3, 6) : rng.range(1.2, 2.4), rot: 0 });
    }
  }

  buildPoles(line) {
    const M = this.M;
    const tops = [];
    for (const p of line) {
      const lean = p.broken ? 0.55 : p.lean;
      const g = []; g.push({ mat: M.wood, geo: cylG(0.12, 0.16, 8.5, 0, 4.25, 0) }); g.push({ mat: M.wood, geo: boxG(0.12, 0.12, 2.0, 0, 7.9, 0) });
      this.place(g, p.x, 0, p.z, 0, 1, lean, 0);
      this.col.add(p.x, p.z, 0.16, 0.16, 0, 8, { kind: 'pole' });
      const topY = 7.95 * Math.cos(lean), topZ = p.z + 7.95 * Math.sin(lean);
      tops.push({ x: p.x, y: topY, z: topZ, broken: p.broken });
    }
    for (let i = 0; i < tops.length - 1; i++) {
      const a = tops[i], b = tops[i + 1];
      for (const off of [-0.85, 0, 0.85]) {
        const sag = 0.9 + Math.abs(off) * 0.3 + (a.broken || b.broken ? 3.5 : 0);
        const pa = new THREE.Vector3(a.x, a.y, a.z + off), pb = new THREE.Vector3(b.x, b.y, b.z + off);
        const mid = pa.clone().lerp(pb, 0.5); mid.y = Math.max(0.3, mid.y - sag);
        const curve = new THREE.QuadraticBezierCurve3(pa, mid, pb);
        const tg = new THREE.TubeGeometry(curve, 14, 0.018, 3, false);
        this.batch.add(M.black, tg);
      }
    }
  }

  // sagging cables strung across streets between facade anchors; some carry string lights or rags
  buildCables() {
    const M = this.M, A = this.anchors, rng = new RNG(this.L.seed ^ 0xca81e), used = new Set();
    this.bulbs = new Scatter(M.bulb, [new THREE.SphereGeometry(0.06, 6, 4)], false);
    this.bulbsCold = new Scatter(M.bulbCold, [new THREE.SphereGeometry(0.06, 6, 4)], false);
    let lightBudget = 26;
    for (let i = 0; i < A.length; i++) {
      if (used.has(i)) continue;
      const a = A[i]; let best = -1, bd = 1e9;
      for (let j = 0; j < A.length; j++) {
        if (j === i || used.has(j)) continue;
        const b = A[j]; if (a.nx * b.nx + a.nz * b.nz > -0.9) continue;
        const dx = b.x - a.x, dz = b.z - a.z, dist = Math.hypot(dx, dz);
        if (dist < 7 || dist > 24) continue;
        const along = (dx * a.nx + dz * a.nz) / dist; if (along < 0.75) continue;
        const sc = dist * (1.6 - along) + rng.range(0, 6); if (sc < bd) { bd = sc; best = j; }
      }
      if (best < 0) continue;
      used.add(i); used.add(best);
      const b = A[best];
      const n = rng.int(1, 3);
      for (let k = 0; k < n; k++) {
        const pa = new THREE.Vector3(a.x, a.y + k * 0.35, a.z), pb = new THREE.Vector3(b.x + rng.range(-1, 1), b.y + rng.range(-0.6, 0.6), b.z + rng.range(-1, 1));
        const mid = pa.clone().lerp(pb, 0.5); mid.y -= rng.range(0.6, 2.0);
        const curve = new THREE.QuadraticBezierCurve3(pa, mid, pb);
        this.batch.add(M.cable, new THREE.TubeGeometry(curve, 16, 0.02, 3, false));
        if (k === 0 && rng.chance(0.42)) { // string lights
          const cold = rng.chance(0.3), sc = cold ? this.bulbsCold : this.bulbs, L = curve.getLength();
          for (let u = 0.03; u < 0.97; u += 0.7 / L) { const q = curve.getPoint(u); sc.add(q.x, q.y - 0.08, q.z, 1, 0, 0, 0); }
          if (lightBudget-- > 0) this.lighting.addSource(curve.getPoint(0.5).add(new THREE.Vector3(0, -0.5, 0)), cold ? 0x90d0ff : 0xffb060, 9, 8, 'steady', { priority: 0.7 });
          this.signs.push({ pos: curve.getPoint(0.5), color: new THREE.Color(cold ? 0x90d0ff : 0xffb060), flicker: false, string: true });
        } else if (k === 0 && rng.chance(0.3)) { // hanging rags / laundry
          for (let u = 0.15; u < 0.9; u += rng.range(0.1, 0.2)) {
            const q = curve.getPoint(u), g = new THREE.PlaneGeometry(rng.range(0.3, 0.7), rng.range(0.4, 0.9)); g.translate(0, -0.3, 0);
            g.rotateY(Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2); g.translate(q.x, q.y, q.z);
            this.batch.add(M.awning, colorize(g.toNonIndexed(), rng.pick([0x8a3a2a, 0x3a5a7a, 0xb0a890, 0x5a5a40, 0x6a2a4a])));
          }
        }
      }
    }
    this.bulbs.build(this.root); this.bulbsCold.build(this.root);
  }

  buildRoadblock(rb) {
    const M = this.M, rng = new RNG(rb.seed);
    const at = (along, lat) => (rb.axis === 'z' ? [rb.c + lat, rb.at + along * rb.side] : [rb.at + along * rb.side, rb.c + lat]);
    const across = rb.axis === 'z' ? Math.PI / 2 : 0, alongRot = rb.axis === 'z' ? 0 : Math.PI / 2; // rotation that lays a prop's +x across the road
    void alongRot;
    const W = rb.w + 4.8;
    if (rb.kind === 'containers') {
      for (let lat = -W / 2 + 1.2; lat < W / 2; lat += 2.5) {
        const [x, z] = at(rng.range(0, 1), lat);
        this.place(P.containerParts(rng.int(0, 3)), x, 0, z, across + Math.PI / 2 + rng.range(-0.08, 0.08));
        if (rng.chance(0.6)) this.place(P.containerParts(rng.int(0, 3)), x, 2.62, z, across + Math.PI / 2 + rng.range(-0.12, 0.12));
      }
    } else if (rb.kind === 'bus') {
      const [x, z] = at(1.5, rng.range(-1, 1));
      this.place(P.carParts(5, rng.int(0, 8), rng.chance(0.6)), x, -0.08, z, across + rng.range(-0.2, 0.2), 1, rng.range(-0.04, 0.04), 0);
      for (const sd of [-1, 1]) { const [x2, z2] = at(-0.5, sd * (W / 2 - 1)); this.place(P.carParts(rng.pick([0, 3, 1]), rng.int(0, 8), true), x2, -0.1, z2, across + rng.range(-0.6, 0.6)); }
    } else if (rb.kind === 'jersey') {
      for (let row = 0; row < 2; row++) for (let lat = -W / 2 + 1.3; lat < W / 2; lat += 2.65) { const [x, z] = at(row * 1.2, lat + row * 1.3); this.place(P.jerseyParts(2.6), x, 0, z, across + rng.range(-0.1, 0.1)); }
      for (let lat = -W / 2 + 1; lat < W / 2; lat += 1.6) { const [x, z] = at(2.6, lat); this.place(P.fenceParts(1.6, rng), x, 0, z, across); }
      for (let i = 0; i < 3; i++) { const [x, z] = at(rng.range(-1, 3), rng.range(-W / 2, W / 2)); this.place(P.sandbagParts(3, rng), x, 0, z, across + rng.range(-0.3, 0.3)); }
    }
    // rubble mound always (also fills under the others)
    for (let i = 0; i < (rb.kind === 'rubble' ? 7 : 3); i++) {
      const [x, z] = at(rng.range(0.5, 4), rng.range(-W / 2, W / 2)); const s = rng.range(1.4, 3.2);
      const g = rockGeo(rng.int(1, 999), 1); g.scale(s, s * 0.6, s * rng.range(0.8, 1.3)); g.rotateY(rng.range(0, 6)); g.translate(x, -0.2, z);
      boxUV(g, 0.4); this.batch.add(M.rubble, g);
      for (let k = 0; k < 8; k++) this.rubble.add(x + rng.range(-s, s) * 1.3, 0.05, z + rng.range(-s, s) * 1.3, rng.range(0.1, 0.4), rng.range(0, 3), rng.range(0, 3), 0);
    }
    if (rng.chance(0.55)) { const [x, z] = at(-0.8, rng.range(-W / 3, W / 3)); this.place(P.barrelParts(rng), x, 0, z, 0); this.addFire(x, 0.95, z, 0.6); }
    if (rng.chance(0.5)) { const [x, z] = at(-0.4, rng.range(-W / 3, W / 3)); this.place(K.signParts(rng.pick([6, 10, 12]), 1.6, 0.8, false, 0.9, true), x, 1.6, z, across + Math.PI / 2 * rb.side); }
  }

  // Outer ring: facade-textured blocks (windows + lit emissive panes), stepped broken tops, rooftop junk,
  // big neon billboards facing the play area.
  buildOuter() {
    const M = this.M, L = this.L;
    for (const o of L.outer || []) {
      const rng = new RNG(o.seed), w = o.x1 - o.x0, d = o.z1 - o.z0;
      if (o.floors < 0) { // low ruin: broken wall stumps on the lot outline, rubble, overgrowth
        const mat = o.style === 'brick' ? M.brickWall : o.style === 'plaster' ? M.plasterWall : M.concreteWall;
        const ins = 0.8, x0 = o.x0 + ins, x1 = o.x1 - ins, z0 = o.z0 + ins, z1 = o.z1 - ins;
        for (const [ax, az, bx, bz] of [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]]) {
          const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 1.6));
          for (let i = 0; i < n; i++) {
            if (rng.chance(0.3)) continue;
            const t = (i + 0.5) / n, h = rng.range(0.3, 2.4), along = Math.abs(bx - ax) > 0.1;
            this.addBox(mat, ax + (bx - ax) * t, h / 2, az + (bz - az) * t, along ? len / n + 0.02 : 0.38, h, along ? 0.38 : len / n + 0.02, 0, o.tint, 0.33, 0, 0, Math.min(h * 0.6, 0.8), true);
          }
        }
        const cx = (o.x0 + o.x1) / 2, cz = (o.z0 + o.z1) / 2;
        const g = rockGeo(o.seed % 997, 1); g.scale(w * 0.3, rng.range(0.8, 1.8), d * 0.3); g.translate(cx, -0.4, cz); boxUV(g, 0.3); this.batch.add(M.rubble, g);
        for (let i = 0; i < w * d / 6; i++) this.rubble.add(rng.range(o.x0, o.x1), 0.05, rng.range(o.z0, o.z1), rng.range(0.1, 0.5), rng.range(0, 3), rng.range(0, 3), 0);
        for (let i = 0; i < w * d / 10; i++) this.bricks.add(rng.range(o.x0, o.x1), 0.05, rng.range(o.z0, o.z1), 1, rng.range(-0.3, 0.3), rng.range(0, 6), 0);
        if (rng.chance(0.6)) this.place(P.deadTreeParts(rng, rng.range(0.8, 1.3), rng.chance(0.3)), cx + rng.range(-w / 3, w / 3), 0, cz + rng.range(-d / 3, d / 3), rng.range(0, 6));
        for (let i = 0; i < 3; i++) this.place(P.bushParts(rng, rng.range(0.7, 1.3)), rng.range(o.x0 + 1, o.x1 - 1), 0, rng.range(o.z0 + 1, o.z1 - 1), 0);
        if (rng.chance(0.3)) this.place(P.carParts(rng.pick([0, 3, 1]), rng.int(0, 8), true), cx + rng.range(-2, 2), -0.1, cz + rng.range(-2, 2), rng.range(0, 6));
        continue;
      }
      if (o.floors === 0) { // empty lot: rubble mound + dead trees + fence
        const cx = (o.x0 + o.x1) / 2, cz = (o.z0 + o.z1) / 2;
        const g = rockGeo(o.seed % 997, 1); g.scale(w * 0.35, rng.range(1, 2.5), d * 0.35); g.translate(cx, -0.4, cz); boxUV(g, 0.3); this.batch.add(M.rubble, g);
        for (let i = 0; i < 2; i++) this.place(P.deadTreeParts(rng, rng.range(0.8, 1.3), false), cx + rng.range(-w / 3, w / 3), 0, cz + rng.range(-d / 3, d / 3), rng.range(0, 6));
        continue;
      }
      const fm = M['facade_' + o.style];
      // 1..3 stepped masses
      const masses = o.broken && w > 8 ? 2 : 1;
      for (let m = 0; m < masses; m++) {
        const mx0 = o.x0 + (w / masses) * m, mx1 = o.x0 + (w / masses) * (m + 1);
        const fl = Math.max(1, o.floors - (m ? rng.int(0, 3) : 0)), H = fl * FH;
        const cx = (mx0 + mx1) / 2, cz = (o.z0 + o.z1) / 2, sx = mx1 - mx0 - 0.1, sz = d - 0.1;
        const g = new THREE.BoxGeometry(sx, H, sz, 1, 1, 1); g.translate(cx, H / 2, cz);
        const ng = g.toNonIndexed(); facadeUV(ng); colorize(ng, o.tint);
        applyGrime(ng);
        // roof face uses the roofing material: split off the top (+y) triangles
        const top = extractTop(ng);
        this.batch.add(fm, ng);
        if (top) { boxUV(top, 0.3); colorize(top, 0xffffff); this.batch.add(M.roof, top); }
        // cornice + parapet
        this.addBox(M.trim, cx, H + 0.3, cz, sx + 0.3, 0.6, sz + 0.3, 0, 0x9a968e, 0.5);
        if (o.broken && rng.chance(0.6)) { // jagged ruined crown
          for (let i = 0; i < 4; i++) this.addBox(M.concreteWall, cx + rng.range(-sx / 2.5, sx / 2.5), H + rng.range(0.6, 2.2), cz + rng.range(-sz / 2.5, sz / 2.5), rng.range(0.4, 2.5), rng.range(1.2, 4), rng.range(0.4, 2.5), rng.range(0, 1), o.tint, 0.33, rng.range(-0.15, 0.15), rng.range(-0.15, 0.15));
          for (let i = 0; i < 6; i++) this.rebar.add(cx + rng.range(-sx / 2, sx / 2), H + 0.5, cz + rng.range(-sz / 2, sz / 2), [1.5, rng.range(1, 2.5), 1.5], rng.range(-0.5, 0.5), 0, rng.range(-0.5, 0.5));
        }
        // rooftop junk: tanks, vents, AC banks, sheds, beacons, lit skylights, roof puddles
        for (let i = 0; i < Math.ceil(sx * sz / 30); i++) {
          const x = cx + rng.range(-sx / 2 + 1.5, sx / 2 - 1.5), z = cz + rng.range(-sz / 2 + 1.5, sz / 2 - 1.5), k = rng.next();
          if (k < 0.2) this.place(K.waterTankParts(rng), x, H, z, rng.range(0, 3));
          else if (k < 0.5) this.place(K.roofVentParts(rng), x, H, z, rng.range(0, 6));
          else if (k < 0.65) this.place(K.acUnitParts(), x, H + 0.3, z, rng.range(0, 6));
          else if (k < 0.78) this.addBox(M.concreteWall, x, H + 1.2, z, rng.range(2, 4), 2.4, rng.range(2, 3.5), rng.pick([0, Math.PI / 2]), o.tint, 0.33, 0, 0, 0, true); // stair hut
          else if (k < 0.9) { // skylight: dim glow under a mullion grid
            const a = rng.range(1, 1.6), c = rng.range(1, 1.6);
            this.batch.add(M.windowLit, colorize(K.box(a, 0.1, c, x, H + 0.05, z).toNonIndexed(), new THREE.Color(rng.pick([0xffa050, 0x80b0ff, 0xffd090])).multiplyScalar(rng.range(0.12, 0.3))));
            for (let q = -1; q <= 1; q++) { this.batch.add(M.frame, colorize(K.box(a + 0.1, 0.08, 0.06, x, H + 0.12, z + q * c / 2).toNonIndexed(), 0xffffff)); this.batch.add(M.frame, colorize(K.box(0.06, 0.08, c + 0.1, x + q * a / 2, H + 0.12, z).toNonIndexed(), 0xffffff)); }
          }
          else this.decals.push({ kind: 'puddle', x, z, s: rng.range(2, 4), rot: rng.range(0, 6), y: H });
        }
        if (fl >= 6 && rng.chance(0.7)) { // antenna mast with a red aviation beacon
          const x = cx + rng.range(-sx / 4, sx / 4), z = cz + rng.range(-sz / 4, sz / 4), mh = rng.range(4, 9);
          this.place([{ mat: M.kitMetal, geo: colorize(K.cyl(0.06, 0.1, mh, 6, 0, mh / 2, 0).toNonIndexed(), 0x707070) }, { mat: M.redLight, geo: new THREE.SphereGeometry(0.16, 8, 6).translate(0, mh, 0) }], x, H, z, 0);
          this.beacons.push(new THREE.Vector3(x, H + mh, z));
        }
        // billboard / blade neon facing the playable square
        if (!o.near && rng.chance(Math.min(0.9, 0.5 * this.neon))) {
          const cell = rng.int(0, SIGN_WORDS.length - 1), seed = rng.next() < 0.4 ? rng.range(0.5, 0.74) : rng.range(0.76, 1);
          // which face looks at the centre: pick the dominant axis toward origin
          const toC = Math.abs(cx) > Math.abs(cz) ? [Math.sign(-cx), 0] : [0, Math.sign(-cz)];
          const fx = cx + toC[0] * (sx / 2), fz = cz + toC[1] * (sz / 2);
          const ry = Math.atan2(toC[0], toC[1]);
          const bw = Math.min(sx, sz, 9) * rng.range(0.6, 0.9), bh = bw * 0.5, by = Math.min(H - bh / 2 - 0.5, rng.range(6, 14));
          if (by > 3) {
            const sg = K.uvCell(K.box(bw, bh, 0.15, 0, 0, 0.12), cell); colorize(sg, new THREE.Color(seed, seed, seed));
            this.place([{ mat: M.neon, geo: sg }], fx, by, fz, ry);
            const color = new THREE.Color(SIGN_WORDS[cell][1]);
            const pos = new THREE.Vector3(fx + toC[0] * 2.5, by, fz + toC[1] * 2.5);
            this.signs.push({ pos, color, flicker: seed < 0.75, seed, outer: true, word: SIGN_WORDS[cell][0] });
            this.lighting.addSource(pos, color, 30, 16, seed < 0.75 ? 'lamp' : 'steady', { priority: 0.6 });
          }
        }
      }
      // ground floor shutters / rubble at the base
      for (let i = 0; i < Math.ceil(w / 4); i++) this.rubble.add(rng.range(o.x0, o.x1), 0.05, rng.range(o.z0 - 0.8, o.z1 + 0.8), rng.range(0.15, 0.5), rng.range(0, 3), rng.range(0, 3), 0);
    }
  }

  buildSkyline() { // far silhouettes beyond the outer ring, mostly lost in fog
    const M = this.M, rng = new RNG(this.L.seed ^ 77), R = HALF + OUTER;
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + rng.range(-0.05, 0.05), r = rng.range(R + 6, R + 30);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (x > R * 0.7 || z > R * 0.7) continue; // never behind the camera
      const w = rng.range(12, 24), d = rng.range(12, 24), h = rng.range(26, 70);
      const g = new THREE.BoxGeometry(w, h, d); g.translate(x, h / 2, z);
      const ng = g.toNonIndexed(); facadeUV(ng); colorize(ng, 0x8a8884);
      this.batch.add(M['facade_' + rng.pick(['concrete', 'concrete', 'brick', 'plaster'])], ng);
    }
  }

  buildDecals() {
    const L = this.L;
    const groups = {};
    const add = (kind, x, z, sx, sz, rot, y = 0.035) => { (groups[kind] = groups[kind] || []).push({ x, z, sx, sz, rot, y }); };
    for (const d of L.decals) {
      if (d.kind === 'parkinglot') {
        const alongX = d.x1 - d.x0 >= d.z1 - d.z0;
        for (let r = 0; r * 11 + 4 < (alongX ? d.z1 - d.z0 : d.x1 - d.x0); r++) {
          for (let s = 1.5; s < (alongX ? d.x1 - d.x0 : d.z1 - d.z0); s += 3) {
            const c = (alongX ? d.z0 : d.x0) + 4 + r * 11;
            if (alongX) add('line', d.x0 + s, c, 0.12, 4.6, 0, 0.04); else add('line', c, d.z0 + s, 4.6, 0.12, 0, 0.04);
          }
        }
        continue;
      }
      if (d.kind === 'dirtlot') continue;
      if (d.kind === 'dash') { add('dash', d.x, d.z, 0.5, 2.4, d.rot); continue; }
      if (d.kind === 'crosswalk') { add('crosswalk', d.x, d.z, d.s, 3.2, d.rot); continue; }
      const y = { puddle: 0.047, wet: 0.026, dirt: 0.028, patch: 0.024, stain: 0.027, manhole: 0.044, drain: 0.044, edge: 0.036, arrow: 0.036 }[d.kind];
      add(d.kind, d.x, d.z, d.sx || d.s, d.sz || d.s, d.rot, (y || 0.03 + ((d.x * 13.7 + d.z * 7.1) % 1 + 1) % 1 * 0.01) + (d.y !== undefined ? d.y + 0.01 : this.heightAt(d.x, d.z)));
    }
    // blood / scorch get dynamic additions via fx; here static only
    const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    for (const [kind, list] of Object.entries(groups)) {
      const tex = kind === 'line' ? null : T.decal(kind === 'line' ? 'dash' : kind);
      const mat = new THREE.MeshStandardMaterial({
        map: tex, color: kind === 'line' ? 0xbab4a0 : 0xffffff, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        roughness: kind === 'puddle' ? 0.04 : kind === 'wet' ? 0.12 : kind === 'oil' ? 0.2 : kind === 'manhole' || kind === 'drain' ? 0.55 : 0.9,
        metalness: kind === 'manhole' || kind === 'drain' ? 0.6 : 0, envMapIntensity: kind === 'puddle' ? 2.0 : kind === 'wet' || kind === 'oil' ? 1.6 : 1,
        opacity: kind === 'line' ? 0.6 : kind === 'crosswalk' || kind === 'dash' || kind === 'edge' || kind === 'arrow' ? 0.6 : 1,
      });
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((it, i) => { q.setFromAxisAngle(up, it.rot || 0); m4.compose(new THREE.Vector3(it.x, it.y, it.z), q, new THREE.Vector3(it.sx, 1, it.sz)); im.setMatrixAt(i, m4); });
      im.receiveShadow = true; im.renderOrder = 1;
      this.root.add(im);
    }
  }

  buildGrass() {
    const M = this.M, L = this.L, col = this.col, rng = new RNG(L.seed ^ 0x5151);
    const pts = [];
    const tryAdd = (x, z, s) => { if (!col.blockedCircle(x, z, 0.25, 0.2)) pts.push([x, z, s]); };
    for (const a of L.grassAreas) {
      const n = Math.floor((a.x1 - a.x0) * (a.z1 - a.z0) * 0.34 * a.density);
      for (let i = 0; i < n; i++) {
        const x = rng.range(a.x0, a.x1), z = rng.range(a.z0, a.z1);
        if (fbm(x * 0.08, z * 0.08, 2, 9) < 0.42) continue;
        tryAdd(x, z, rng.range(0.6, 1.3));
      }
    }
    // along building bases and sidewalk edges
    for (const b of L.buildings) for (let i = 0; i < (b.x1 - b.x0 + b.z1 - b.z0) * 0.5; i++) {
      const side = rng.int(0, 3); let x, z;
      if (side === 0) { x = rng.range(b.x0, b.x1); z = b.z0 - rng.range(0.1, 0.8); } else if (side === 1) { x = rng.range(b.x0, b.x1); z = b.z1 + rng.range(0.1, 0.8); }
      else if (side === 2) { x = b.x0 - rng.range(0.1, 0.8); z = rng.range(b.z0, b.z1); } else { x = b.x1 + rng.range(0.1, 0.8); z = rng.range(b.z0, b.z1); }
      tryAdd(x, z, rng.range(0.5, 1.1));
      if (rng.chance(0.4)) tryAdd(rng.range(b.x0 + 1, b.x1 - 1), rng.range(b.z0 + 1, b.z1 - 1), rng.range(0.4, 0.8));
    }
    for (const r of L.roads) for (let i = 0; i < 160; i++) { // cracks in asphalt
      const along = rng.range(-HALF, HALF), lat = rng.sign() * (r.w / 2 + rng.range(-0.4, 0.4));
      const [x, z] = r.axis === 'z' ? [r.x + lat, along] : [along, r.z + lat];
      tryAdd(x, z, rng.range(0.35, 0.8));
    }
    const MAX = Math.min(pts.length, 14000);
    const gs = [];
    for (let i = 0; i < 3; i++) { const g = new THREE.PlaneGeometry(1.1, 0.75); g.translate(0, 0.37, 0); g.rotateY((i / 3) * Math.PI); gs.push(g.toNonIndexed()); }
    const geo = mergeG(gs);
    { const n = geo.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0); } // light cards like the ground
    const mat = M.grass;
    const prevGrass = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prevGrass.call(mat, sh, r);
      sh.uniforms.uTime = worldUniforms.uTime;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ip = instanceMatrix[3].xyz;
          #else
            vec3 ip = vec3(0.0);
          #endif
          float sway = sin(uTime * 1.7 + ip.x * 0.35 + ip.z * 0.27) * 0.09 + sin(uTime * 3.1 + ip.x) * 0.03;
          transformed.x += sway * uv.y; transformed.z += sway * 0.6 * uv.y;`);
    };
    const im = new THREE.InstancedMesh(geo, mat, MAX);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
    for (let i = 0; i < MAX; i++) {
      const [x, z, s] = pts[i];
      e.set(rng.range(-0.1, 0.1), rng.range(0, 6.28), rng.range(-0.1, 0.1)); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(x, this.heightAt(x, z), z), q, new THREE.Vector3(s, s * rng.range(0.7, 1.3), s));
      im.setMatrixAt(i, m4);
      const dry = rng.next(); im.setColorAt(i, c.setRGB(0.75 + dry * 0.35, 0.8 + dry * 0.1, 0.6));
    }
    im.receiveShadow = true; im.castShadow = false;
    im.computeBoundingSphere();
    this.root.add(im);
  }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.scene.remove(this.root);
    this.vol.dispose();
  }
}

import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
function mergeG(gs) { return mergeGeometries(gs, false); }
// Vertex-colour weathering: dark damp band at the base, soot/rain patches higher up.
function applyGrime(g) {
  const p = g.attributes.position, c = g.attributes.color;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const base = 0.42 + 0.58 * Math.min(1, Math.max(0, y / 1.7)) ** 0.8;
    const patch = 0.82 + 0.3 * fbm(x * 0.21 + z * 0.17, y * 0.33, 2, 5);
    const k = Math.min(1.08, base * patch);
    c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
  }
}
// world-aligned facade UVs: the atlas tile spans 4 bays (12.4 m) x 4 floors (13.2 m)
function facadeUV(g) {
  const p = g.attributes.position, n = g.attributes.normal, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)) > 0.5, along = ax ? p.getZ(i) : p.getX(i);
    uv[i * 2] = along / 12.4; uv[i * 2 + 1] = p.getY(i) / 13.2;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
function extractTop(g) { // move +y-facing triangles out of g into a new geometry
  const p = g.attributes.position, n = g.attributes.normal, keep = [], top = [];
  for (let t = 0; t < p.count; t += 3) (n.getY(t) > 0.9 ? top : keep).push(t);
  if (!top.length) return null;
  const pick = (list) => { const out = new THREE.BufferGeometry(); for (const k of Object.keys(g.attributes)) { const a = g.attributes[k], sz = a.itemSize, arr = new Float32Array(list.length * 3 * sz); list.forEach((t, i) => { for (let v = 0; v < 3; v++) for (let c = 0; c < sz; c++) arr[(i * 3 + v) * sz + c] = a.array[(t + v) * sz + c]; }); out.setAttribute(k, new THREE.BufferAttribute(arr, sz)); } return out; };
  const kept = pick(keep), tp = pick(top);
  for (const k of Object.keys(kept.attributes)) g.setAttribute(k, kept.attributes[k]);
  return tp;
}
function paperGeo(k) { const g = new THREE.PlaneGeometry(k === 2 ? 0.5 : 0.28, k === 1 ? 0.36 : 0.22, 2, 1); g.rotateX(-Math.PI / 2); const p = g.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, Math.abs(p.getX(i)) * 0.15 * (k + 1) * 0.5); g.computeVertexNormals(); return g.toNonIndexed(); }
function pebbleGeo(seed) { const g = new THREE.OctahedronGeometry(1, 0); const r = new RNG(seed), p = g.attributes.position, sx = r.range(0.7, 1.3), sz = r.range(0.7, 1.3); g.rotateY(r.range(0, 1)); for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * sx, p.getY(i) * 0.6, p.getZ(i) * sz); const ng = g.index ? g.toNonIndexed() : g; ng.computeVertexNormals(); boxUV(ng, 0.5); return ng; }
function shardGeo() { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.07, 0, 0.02, 0.02, 0, 0.08], 3)); g.computeVertexNormals(); g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2)); return g; }
function canGeo() { const g = new THREE.CylinderGeometry(0.035, 0.035, 0.12, 7); g.rotateZ(Math.PI / 2); return g.toNonIndexed(); }
function bottleGeo() { const g = new THREE.CylinderGeometry(0.02, 0.04, 0.26, 7); g.rotateZ(Math.PI / 2); return g.toNonIndexed(); }
function box1(w, h, d) { const g = new THREE.BoxGeometry(w, h, d).toNonIndexed(); boxUV(g, 1); return g; }
function cyl1(r, h) { const g = new THREE.CylinderGeometry(r, r, h, 4); g.translate(0, 0, 0); return g; }
function cylG(rt, rb, h, x, y, z) { const g = new THREE.CylinderGeometry(rt, rb, h, 8); g.translate(x, y, z); return g; }
function boxG(w, h, d, x, y, z) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; }
