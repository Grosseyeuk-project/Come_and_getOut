// Turns a layout (mapgen.js) into meshes + colliders: ground, roads, sidewalks, ruined buildings,
// props, rubble, decals, foliage. Also registers light sources and fire emitters.
import * as THREE from 'three';
import { RNG, fbm, clamp } from '../core/rng.js';
import { materials, boxUV, colorize, GeoBatch } from '../render/materials.js';
import * as T from '../render/textures.js';
import * as P from './props.js';
import { HALF } from './mapgen.js';
import { Volumetrics } from '../fx/volumetrics.js';

const FH = 3.3, WT = 0.38, PW = 0.45;
export const worldUniforms = { uTime: { value: 0 } };

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

    this.buildGround();
    for (const b of layout.buildings) this.buildBuilding(b);
    for (const p of layout.props) this.buildProp(p);
    for (const line of layout.poles) this.buildPoles(line);
    const main = this.batch; this.batch = new GeoBatch();
    this.buildSkyline(); // far silhouettes: no shadow casting (they would darken the whole map edge)
    this.batch.build(this.root, { cast: false, receive: false });
    this.batch = main;
    this.buildDecals();
    this.batch.build(this.root);
    this.rubble.build(this.root); this.bricks.build(this.root); this.debris.build(this.root); this.rebar.build(this.root);
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

  addBox(mat, cx, cy, cz, sx, sy, sz, ry = 0, color = 0xffffff, uvScale = 0.33, rx = 0, rz = 0, jag = 0) {
    const g = new THREE.BoxGeometry(sx, sy, sz, jag ? Math.max(1, Math.round(sx / 0.8)) : 1, 1, jag ? Math.max(1, Math.round(sz / 0.8)) : 1);
    if (jag) { // broken top edge: displace top vertices (shared positions moved identically)
      const p = g.attributes.position, off = new Map(), r = this.rng;
      for (let i = 0; i < p.count; i++) {
        if (p.getY(i) <= 0) continue;
        const k = Math.round((p.getX(i) + cx) * 50) + ',' + Math.round((p.getZ(i) + cz) * 50);
        if (!off.has(k)) off.set(k, -r.range(0, jag));
        p.setY(i, p.getY(i) + off.get(k));
      }
    }
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(cx, cy, cz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
    const ng = g.toNonIndexed(); if (jag) ng.computeVertexNormals(); boxUV(ng, uvScale); colorize(ng, color);
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
    for (const r of L.roads) {
      const g = r.axis === 'z' ? new THREE.PlaneGeometry(r.w, (HALF + 8) * 2) : new THREE.PlaneGeometry((HALF + 8) * 2, r.w);
      g.rotateX(-Math.PI / 2); g.translate(r.axis === 'z' ? r.x : 0, 0.02, r.axis === 'z' ? 0 : r.z);
      boxUV(g, 1 / 6); this.batch.add(M.asphalt, g);
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
        this.addBox(M.pavers, (x0 + x1) / 2, 0.075, (z0 + z1) / 2, x1 - x0, 0.15, z1 - z0, 0, 0xffffff, 1 / 2.2);
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
    const shop = rng.chance(0.4);
    const seedOff = (b.seed % 997) * 1.37;
    const prof = (s) => {
      if (b.collapsed) return rng.chance(0.08) ? rng.range(FH, FH * 2) : rng.range(0.2, 2.4);
      const n = fbm(s * 0.07 + seedOff, seedOff, 3, 7);
      const k = clamp((n - 0.3) * 2.0 * b.damage + b.damage * 0.2, 0, 0.95);
      return H * (1 - k);
    };
    // floor slab
    this.addBox(M.concrete, (b.x0 + b.x1) / 2, 0.06, (b.z0 + b.z1) / 2, w, 0.12, d, 0, 0xb8b4ac, 0.25);
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
      sideInfo.push({ ax, az, bx, bz, len, nBays, door: nBays > 2 && rng.chance(0.65) ? rng.int(1, nBays - 2) : -1 });
      if (sideInfo[si].door >= 0) anyOpening = true;
    }
    if (!anyOpening) { const s = sideInfo.reduce((a, c) => (c.len > a.len ? c : a)); s.door = Math.floor(s.nBays / 2); }

    for (let si = 0; si < 4; si++) {
      const S = sideInfo[si];
      const ux = (S.bx - S.ax) / S.len, uz = (S.bz - S.az) / S.len, nx = uz, nz = -ux;
      const alongX = Math.abs(ux) > 0.5;
      const bw = S.len / S.nBays;
      let curTop = H, damaged = false;
      const piece = (t0, t1, y0, y1, collide = true, color = tint) => {
        if (!alongX) { t0 = Math.max(t0, WT); t1 = Math.min(t1, S.len - WT); }
        if (t1 - t0 < 0.05 || y1 - y0 < 0.05) return;
        const tc = (t0 + t1) / 2, cx = S.ax + ux * tc - nx * WT / 2, cz = S.az + uz * tc - nz * WT / 2;
        const sx = alongX ? t1 - t0 : WT, sz = alongX ? WT : t1 - t0;
        const jag = damaged && y1 >= curTop - 0.01 && y1 - y0 > 0.5 ? Math.min(y1 - y0 - 0.2, rng.range(0.3, 1.2)) : 0;
        this.addBox(mat, cx, (y0 + y1) / 2, cz, sx, y1 - y0, sz, 0, color, 0.33, 0, 0, jag);
        if (collide && y0 < 1.0) col.add(cx, cz, sx / 2, sz / 2, 0, y1, { y0, kind: 'wall' });
      };
      for (let k = 0; k < S.nBays; k++) {
        const t0 = k * bw, t1 = (k + 1) * bw, sg = sOff + (t0 + t1) / 2;
        let top = prof(sg);
        for (const [bs, br] of breaches) { const dd = Math.abs(((sg - bs + per * 1.5) % per) - per / 2); if (dd < br) top = Math.min(top, rng.range(0, 0.5)); }
        const isDoor = k === S.door;
        curTop = top; damaged = top < H - 0.2 || b.collapsed;
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
          if (f === 0 && isDoor) { if (yc > 2.6) piece(a, c, 2.6, yc); continue; }
          if (rng.next() < winP) {
            const sill = yb + (f === 0 && shop ? 0.5 : 0.95), lintel = yb + (f === 0 && shop ? 2.8 : 2.35);
            const inset = (c - a) > 2 ? 0.25 : 0.1;
            piece(a, c, yb, Math.min(sill, yc));
            if (inset > 0.1 && yc > sill) { piece(a, a + inset, sill, Math.min(lintel, yc)); piece(c - inset, c, sill, Math.min(lintel, yc)); }
            if (yc > lintel) piece(a, c, lintel, yc);
            if (yc > sill + 0.3) this.trim(S, ux, uz, nx, nz, a - 0.05, c + 0.05, sill - 0.07, sill + 0.02, 0.1);
          } else piece(a, c, yb, yc);
        }
        // broken jagged top + rebar
        if (top < H - 0.2) {
          const nj = rng.int(1, 3);
          if (rng.chance(0.3)) { const ja = rng.range(t0, t1 - 0.4), jb = Math.min(t1, ja + rng.range(0.3, 0.8)); curTop = top + 0.6; piece(ja, jb, top, top + rng.range(0.3, 0.6), false); curTop = top; }
          for (let j = 0; j < rng.int(0, 3); j++) { const t = rng.range(t0, t1); this.rebar.add(S.ax + ux * t - nx * WT / 2, top + 0.3, S.az + uz * t - nz * WT / 2, [1, rng.range(0.5, 1.2), 1], rng.range(-0.5, 0.5), 0, rng.range(-0.5, 0.5)); }
          // fallen chunks at base outside
          if (rng.chance(0.5)) for (let i = 0; i < 3; i++) { const t = rng.range(t0, t1), o = rng.range(0.4, 1.8); this.rubble.add(S.ax + ux * t + nx * o, 0.05, S.az + uz * t + nz * o, rng.range(0.15, 0.45), rng.range(0, 3), rng.range(0, 3), 0); }
        }
        // floor cornice bands on intact spans
        for (let f = 1; f * FH < top - 0.3; f++) this.trim(S, ux, uz, nx, nz, t0, t1, f * FH - 0.12, f * FH + 0.06, 0.12);
        // graffiti on street level
        if (rng.chance(0.12) && top > 2.6 && !isDoor) this.graffiti(S, ux, uz, nx, nz, (t0 + t1) / 2, rng.range(0.9, 1.6), rng.range(1.8, 2.6), rng.int(0, 7));
        // vines
        if (rng.chance(0.18)) {
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
      this.addBox(mat, cx + ix * WT / 2, top / 2, cz + iz * WT / 2, WT + 0.06, top, WT + 0.06, 0, tint);
      col.add(cx + ix * WT / 2, cz + iz * WT / 2, WT / 2 + 0.03, WT / 2 + 0.03, 0, top);
    }
    // upper slabs (partial)
    const cell = 3;
    for (let f = 1; f < b.floors && !b.collapsed; f++) {
      const y = f * FH;
      for (let x = b.x0 + WT; x < b.x1 - WT - 0.5; x += cell) for (let z = b.z0 + WT; z < b.z1 - WT - 0.5; z += cell) {
        const edgeCell = x < b.x0 + cell || z < b.z0 + cell || x > b.x1 - cell * 1.5 || z > b.z1 - cell * 1.5;
        if (rng.next() > (1 - b.damage) * (edgeCell ? 0.75 : 0.35)) continue;
        const sx = Math.min(cell, b.x1 - WT - x), sz = Math.min(cell, b.z1 - WT - z);
        this.addBox(M.slab, x + sx / 2, y - 0.12, z + sz / 2, sx + 0.02, 0.24, sz + 0.02, 0, 0xa8a49c, 0.33);
      }
    }
    // collapsed slab ramp
    if (b.floors >= 2 && !b.collapsed && rng.chance(b.damage * 0.8) && w > 7 && d > 7) {
      const along = rng.chance(0.5), len = 5.5, ang = Math.asin(Math.min(0.95, FH / len));
      const cx = rng.range(b.x0 + 3.5, b.x1 - 3.5), cz = rng.range(b.z0 + 3.5, b.z1 - 3.5);
      const ry = along ? 0 : Math.PI / 2;
      this.addBox(M.slab, cx, FH / 2, cz, len, 0.25, 3.2, ry, 0x9c988f, 0.33, 0, along ? ang * rng.sign() : 0);
      if (!along) { /* rotate around x for the other axis */ }
      col.add(cx, cz, 1.6, 1.4, ry, 1.6, { kind: 'cover' });
      for (let i = 0; i < 8; i++) this.rubble.add(cx + rng.range(-2.5, 2.5), 0.05, cz + rng.range(-2.5, 2.5), rng.range(0.15, 0.5), rng.range(0, 3), rng.range(0, 3), 0);
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
    if (b.collapsed) {
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, r = Math.min(w, d) * 0.32;
      const mg = rockGeo(b.seed % 1000, 2); mg.scale(r, rng.range(1.6, 2.6), r * (d / w > 1.3 ? 1.4 : 1)); mg.translate(cx, -0.3, cz);
      boxUV(mg, 0.3); this.batch.add(M.rubble, mg);
      col.add(cx, cz, r * 0.75, r * 0.75, 0, 2.2, { kind: 'rubble' });
      for (let i = 0; i < 30; i++) { const a = rng.range(0, 6.28), rr = rng.range(0, r * 1.3); this.rubble.add(cx + Math.cos(a) * rr, rng.range(0, 1.2), cz + Math.sin(a) * rr, rng.range(0.25, 0.8), rng.range(0, 3), rng.range(0, 3), 0); }
      for (let i = 0; i < 6; i++) { const a = rng.range(0, 6.28); this.addBox(M.rust, cx + Math.cos(a) * r * 0.6, 1.2, cz + Math.sin(a) * r * 0.6, 0.18, 0.3, rng.range(3, 6), rng.range(0, 3), 0xffffff, 1, rng.range(-0.6, 0.6), rng.range(-0.5, 0.5)); }
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
        if (p.flipped) { this.place(parts, p.x, 1.55, p.z, rot, 1, 0, Math.PI); col.add(p.x, p.z, hx, hz, rot, 1.5, { kind: 'car' }); }
        else {
          const sink = p.burnt ? -0.12 : 0, roll = p.burnt ? rng.range(-0.04, 0.04) : rng.range(-0.02, 0.02);
          this.place(parts, p.x, sink, p.z, rot, 1, roll, rng.range(-0.03, 0.03));
          col.add(p.x, p.z, hx, hz, rot, 1.2, { kind: 'car' });
        }
        if (p.burnt && rng.chance(0.25)) this.smokes.push({ x: p.x, y: 1.2, z: p.z, s: 0.8 });
        if (p.burnt && rng.chance(0.08)) this.addFire(p.x, 0.9, p.z, 1.0);
        break;
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
          const c = Math.cos(rot), s = Math.sin(rot); const lx = p.bent ? 1.2 : 1.55, ly = p.bent ? 5.2 : 5.9;
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
        boxUV(g, 0.4); this.batch.add(rng.chance(0.3) ? M.brickRubble : M.rubble, g);
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

  buildSkyline() { // tall silhouettes beyond the playable area, mostly lost in fog
    const M = this.M, rng = new RNG(this.L.seed ^ 77);
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2 + rng.range(-0.05, 0.05), r = rng.range(92, 115);
      const x = Math.cos(a) * r, z = Math.sin(a) * r, w = rng.range(10, 22), d = rng.range(10, 22), h = rng.range(14, 45);
      this.addBox(M.concreteWall, x, h / 2, z, w, h, d, rng.range(0, 1), 0x7a7874, 0.15);
      if (rng.chance(0.6)) this.addBox(M.concreteWall, x + rng.range(-3, 3), h + 1.5, z + rng.range(-3, 3), w * 0.4, 3, d * 0.3, 0, 0x6a6864, 0.15);
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
      add(d.kind, d.x, d.z, d.s, d.s, d.rot, d.kind === 'puddle' ? 0.045 : 0.03 + ((d.x * 13.7 + d.z * 7.1) % 1 + 1) % 1 * 0.01);
    }
    // blood / scorch get dynamic additions via fx; here static only
    const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    for (const [kind, list] of Object.entries(groups)) {
      const tex = kind === 'line' ? null : T.decal(kind === 'line' ? 'dash' : kind);
      const mat = new THREE.MeshStandardMaterial({
        map: tex, color: kind === 'line' ? 0xbab4a0 : 0xffffff, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        roughness: kind === 'puddle' ? 0.04 : kind === 'oil' ? 0.25 : 0.9, metalness: 0, envMapIntensity: kind === 'puddle' ? 2.0 : 1,
        opacity: kind === 'line' ? 0.6 : kind === 'crosswalk' || kind === 'dash' ? 0.6 : 1,
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
      const n = Math.floor((a.x1 - a.x0) * (a.z1 - a.z0) * 0.22 * a.density);
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
function box1(w, h, d) { const g = new THREE.BoxGeometry(w, h, d).toNonIndexed(); boxUV(g, 1); return g; }
function cyl1(r, h) { const g = new THREE.CylinderGeometry(r, r, h, 4); g.translate(0, 0, 0); return g; }
function cylG(rt, rb, h, x, y, z) { const g = new THREE.CylinderGeometry(rt, rb, h, 8); g.translate(x, y, z); return g; }
function boxG(w, h, d, x, y, z) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; }
