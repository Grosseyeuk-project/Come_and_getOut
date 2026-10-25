// Combat + ambient visual effects: tracers, muzzle flashes, impacts (sparks/dust/blood), shell casings,
// fires, smoke columns, ambient dust motes, ground decals (blood, scorch), transient lights.
import * as THREE from 'three';
import { ParticleSystem } from './particles.js';
import * as T from '../render/textures.js';

export class Effects {
  constructor(scene, lighting, renderer) {
    this.scene = scene; this.lighting = lighting; this.renderer = renderer;
    this.add = new ParticleSystem(scene, { max: 3000, map: T.softSprite('spark', 1, 0), additive: true });
    this.fire = new ParticleSystem(scene, { max: 1500, map: T.softSprite('fire', 1, 0), additive: true });
    this.smoke = new ParticleSystem(scene, { max: 1600, map: T.smokeSprite(), additive: false });
    this.debris = new ParticleSystem(scene, { max: 800, map: T.softSprite('chunk', 1, 0.9), additive: false });
    this.tracers = [];
    const tg = new THREE.PlaneGeometry(1, 1); tg.rotateX(-Math.PI / 2); tg.translate(0, 0, 0.5);
    const tg2 = new THREE.PlaneGeometry(1, 1); tg2.rotateY(Math.PI / 2); tg2.translate(0, 0, 0.5);
    this.tracerGeo = mergeTwo(tg, tg2);
    this.flashTex = flashTexture();
    this.lights = [];
    this.fires = []; this.smokers = [];
    this.decals = [];
    const dg = new THREE.PlaneGeometry(1, 1); dg.rotateX(-Math.PI / 2); this.decalGeo = dg;
    this.decalMats = {
      blood: new THREE.MeshStandardMaterial({ map: T.decal('blood'), transparent: true, depthWrite: false, roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
      scorch: new THREE.MeshStandardMaterial({ map: T.decal('scorch'), transparent: true, depthWrite: false, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    };
    this.time = 0;
    this.dustT = 0; this.mistT = 0; this.emberT = 0;
    this.mistColor = [0.5, 0.5, 0.52]; this.ambientEmbers = 0.5; this.ash = 0;
  }
  setAtmosphere({ mist, embers, ash }) { if (mist) this.mistColor = mist; this.ambientEmbers = embers ?? 0.5; this.ash = ash ?? 0; }

  addFire(x, y, z, s) { this.fires.push({ x, y, z, s, acc: 0 }); }
  addSmoker(x, y, z, s) { this.smokers.push({ x, y, z, s, acc: 0 }); }
  addFlare(x, z) { this.flares = this.flares || []; this.flares.push({ x, z, acc: 0 }); }

  tracer(x0, y0, z0, x1, y1, z1, color = 0xffc070, width = 0.06, speed = 160) {
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const m = new THREE.Mesh(this.tracerGeo, new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    m.position.set(x0, y0, z0); m.lookAt(x1, y1, z1);
    const seg = Math.min(len, 5);
    m.scale.set(width, width, seg);
    m.renderOrder = 4;
    this.scene.add(m);
    this.tracers.push({ m, x0, y0, z0, dx: (x1 - x0) / len, dy: (y1 - y0) / len, dz: (z1 - z0) / len, len, d: 0, seg, speed });
  }

  muzzle(x, y, z, dx, dz, scale = 1, color = [1, 0.75, 0.4]) {
    for (let i = 0; i < 3; i++) this.add.emit({ x: x + dx * 0.1 * i, y, z: z + dz * 0.1 * i, vx: dx * (3 + i * 3), vz: dz * (3 + i * 3), life: 0.06, s0: (0.55 - i * 0.12) * scale, s1: 0.1, c0: [color[0] * 4, color[1] * 4, color[2] * 4, 1], c1: [color[0], color[1] * 0.5, 0.1, 0] });
    for (let i = 0; i < 4; i++) this.add.emit({ x, y, z, vx: dx * 6 + (Math.random() - 0.5) * 5, vy: Math.random() * 2, vz: dz * 6 + (Math.random() - 0.5) * 5, life: 0.12, s0: 0.06, s1: 0.02, c0: [3, 2, 0.8, 1], c1: [1, 0.3, 0, 0] });
    this.smoke.emit({ x: x + dx * 0.2, y, z: z + dz * 0.2, vx: dx * 1.2, vy: 0.6, vz: dz * 1.2, life: 0.8, s0: 0.25 * scale, s1: 1.0 * scale, c0: [0.6, 0.58, 0.55, 0.25], c1: [0.5, 0.5, 0.5, 0], drag: 2 });
    this.flashLight(x, y + 0.2, z, 0xffa040, 25 * scale, 9, 0.06);
  }

  flashLight(x, y, z, color, intensity, range, ttl) {
    const s = this.lighting.addSource(new THREE.Vector3(x, y, z), color, intensity, range, 'steady', { priority: 2.5 });
    this.lights.push({ s, ttl, t: 0, i0: intensity });
  }

  casing(x, y, z, dx, dz, shell = false) {
    const px = -dz, pz = dx;
    this.debris.emit({ x, y, z, vx: px * 2.5 + (Math.random() - 0.5), vy: 2 + Math.random(), vz: pz * 2.5 + (Math.random() - 0.5), life: 1.4, s0: shell ? 0.09 : 0.06, c0: shell ? [0.6, 0.08, 0.05, 1] : [0.75, 0.55, 0.2, 1], c1: [0.4, 0.3, 0.1, 1], grav: 14, bounce: 0.35, floor: 0.03, drag: 0.5, rotV: 20 });
  }

  impact(x, y, z, nx, nz, kind = 'concrete') {
    if (kind === 'flesh') {
      for (let i = 0; i < 9; i++) this.debris.emit({ x, y, z, vx: nx * 2 + (Math.random() - 0.5) * 3, vy: Math.random() * 2.5, vz: nz * 2 + (Math.random() - 0.5) * 3, life: 0.6, s0: 0.12, s1: 0.06, c0: [0.35, 0.02, 0.02, 1], c1: [0.2, 0, 0, 0.8], grav: 12, floor: 0.03 });
      this.smoke.emit({ x, y, z, vx: nx, vy: 0.3, vz: nz, life: 0.4, s0: 0.2, s1: 0.6, c0: [0.4, 0.02, 0.02, 0.5], c1: [0.3, 0, 0, 0], drag: 3 });
      return;
    }
    const metal = kind === 'metal';
    const n = metal ? 10 : 6;
    for (let i = 0; i < n; i++) {
      const sp = 3 + Math.random() * 6;
      this.add.emit({ x, y, z, vx: (nx + (Math.random() - 0.5) * 1.6) * sp, vy: Math.random() * 4, vz: (nz + (Math.random() - 0.5) * 1.6) * sp, life: 0.15 + Math.random() * 0.25, s0: 0.07, s1: 0.02, c0: [4, 2.4, 0.9, 1], c1: [1, 0.3, 0.05, 0], grav: 9, drag: 1.5 });
    }
    this.add.emit({ x, y, z, life: 0.05, s0: 0.5, s1: 0.2, c0: [3, 2, 1, 1], c1: [1, 0.5, 0.2, 0] });
    if (!metal) {
      for (let i = 0; i < 4; i++) this.smoke.emit({ x, y, z, vx: nx * (1 + Math.random() * 2) + (Math.random() - 0.5), vy: Math.random() * 1.2, vz: nz * (1 + Math.random() * 2) + (Math.random() - 0.5), life: 0.9 + Math.random() * 0.5, s0: 0.2, s1: 1.0, c0: [0.55, 0.52, 0.48, 0.45], c1: [0.5, 0.48, 0.45, 0], drag: 3 });
      for (let i = 0; i < 4; i++) this.debris.emit({ x, y, z, vx: nx * 3 + (Math.random() - 0.5) * 3, vy: 1 + Math.random() * 3, vz: nz * 3 + (Math.random() - 0.5) * 3, life: 0.9, s0: 0.06, c0: [0.35, 0.33, 0.3, 1], c1: [0.3, 0.3, 0.28, 1], grav: 14, bounce: 0.3, floor: 0.03 });
    }
  }

  blood(x, z, s = 1) { this.decal('blood', x, z, s * (0.8 + Math.random() * 0.8)); }
  scorch(x, z, s = 2) { this.decal('scorch', x, z, s); }
  decal(kind, x, z, s) {
    const m = new THREE.Mesh(this.decalGeo, this.decalMats[kind]);
    m.position.set(x, 0.05 + this.decals.length * 0.0001 % 0.01, z); m.rotation.y = Math.random() * 6.28; m.scale.set(s, 1, s); m.receiveShadow = true; m.renderOrder = 1;
    this.scene.add(m); this.decals.push(m);
    if (this.decals.length > 80) { const o = this.decals.shift(); this.scene.remove(o); }
  }

  explosion(x, y, z, r = 3) {
    for (let i = 0; i < 30; i++) { const a = Math.random() * 6.28, sp = Math.random() * 10; this.add.emit({ x, y, z, vx: Math.cos(a) * sp, vy: Math.random() * 8, vz: Math.sin(a) * sp, life: 0.4 + Math.random() * 0.4, s0: 0.12, s1: 0.03, c0: [4, 2.2, 0.6, 1], c1: [1, 0.2, 0, 0], grav: 10, drag: 1 }); }
    for (let i = 0; i < 14; i++) { const a = Math.random() * 6.28, sp = Math.random() * 3; this.fire.emit({ x, y: y + Math.random(), z, vx: Math.cos(a) * sp, vy: 1 + Math.random() * 2, vz: Math.sin(a) * sp, life: 0.5, s0: r * 0.6, s1: r * 0.2, c0: [3, 1.4, 0.4, 1], c1: [1, 0.2, 0.05, 0], drag: 2 }); }
    for (let i = 0; i < 14; i++) { const a = Math.random() * 6.28, sp = Math.random() * 2.5; this.smoke.emit({ x, y: y + 0.5, z, vx: Math.cos(a) * sp, vy: 1 + Math.random() * 2, vz: Math.sin(a) * sp, life: 2.5, s0: 1, s1: r * 1.6, c0: [0.12, 0.11, 0.1, 0.7], c1: [0.2, 0.2, 0.2, 0], drag: 1.2 }); }
    this.flashLight(x, y + 1, z, 0xff8030, 120, 16, 0.25);
  }

  dustRing(x, z, r = 2.5) { // melee slam / heavy landing
    for (let i = 0; i < 22; i++) { const a = (i / 22) * 6.28; this.smoke.emit({ x: x + Math.cos(a) * 0.4, y: 0.2, z: z + Math.sin(a) * 0.4, vx: Math.cos(a) * r * 2, vy: 0.4, vz: Math.sin(a) * r * 2, life: 1.0, s0: 0.5, s1: 1.6, c0: [0.45, 0.42, 0.38, 0.5], c1: [0.4, 0.4, 0.38, 0], drag: 3.5 }); }
  }

  update(dt, focus, camera) {
    this.time += dt;
    const scale = this.renderer.renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    // tracers
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.d += t.speed * dt;
      const head = Math.min(t.d, t.len), tail = Math.max(0, head - t.seg);
      t.m.position.set(t.x0 + t.dx * tail, t.y0 + t.dy * tail, t.z0 + t.dz * tail);
      t.m.scale.z = Math.max(0.01, head - tail);
      if (t.d - t.seg > t.len) { this.scene.remove(t.m); t.m.material.dispose(); this.tracers.splice(i, 1); }
      else t.m.material.color.multiplyScalar(1);
    }
    // transient lights
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const l = this.lights[i]; l.t += dt; l.s.intensity = l.i0 * Math.max(0, 1 - l.t / l.ttl);
      if (l.t >= l.ttl) { this.lighting.removeSource(l.s); this.lights.splice(i, 1); }
    }
    // fires: only emit for fires near the focus
    for (const f of this.fires) {
      const d = Math.hypot(f.x - focus.x, f.z - focus.z); if (d > 45) continue;
      f.acc += dt * 38 * f.s;
      while (f.acc > 1) {
        f.acc -= 1;
        const r = 0.25 * f.s;
        this.fire.emit({ x: f.x + (Math.random() - 0.5) * r, y: f.y, z: f.z + (Math.random() - 0.5) * r, vx: (Math.random() - 0.5) * 0.3, vy: 1.4 + Math.random() * 1.2, vz: (Math.random() - 0.5) * 0.3, life: 0.5 + Math.random() * 0.35, s0: 0.75 * f.s, s1: 0.15 * f.s, c0: [2.6, 1.1, 0.3, 0.9], c1: [1.2, 0.18, 0.02, 0], drag: 1.2, fadeIn: 0.06 });
        if (Math.random() < 0.12) this.add.emit({ x: f.x, y: f.y + 0.3, z: f.z, vx: (Math.random() - 0.5) * 1.4, vy: 2 + Math.random() * 2.5, vz: (Math.random() - 0.5) * 1.4, life: 1.2 + Math.random(), s0: 0.05, s1: 0.02, c0: [4, 1.6, 0.4, 1], c1: [2, 0.4, 0, 0], drag: 0.5, grav: -0.5 });
        if (Math.random() < 0.15) this.smoke.emit({ x: f.x, y: f.y + 1.0 * f.s, z: f.z, vx: 0.3, vy: 1.2, vz: 0.15, life: 3.5, s0: 0.6 * f.s, s1: 2.6 * f.s, c0: [0.08, 0.075, 0.07, 0], c1: [0.16, 0.15, 0.15, 0], drag: 0.3, arc: 0.45 });
      }
    }
    for (const s of this.smokers) {
      const d = Math.hypot(s.x - focus.x, s.z - focus.z); if (d > 50) continue;
      s.acc += dt * 4 * s.s;
      while (s.acc > 1) { s.acc -= 1; this.smoke.emit({ x: s.x + (Math.random() - 0.5), y: s.y, z: s.z + (Math.random() - 0.5), vx: 0.4, vy: 1.0 + Math.random() * 0.5, vz: 0.2, life: 5, s0: 0.8, s1: 4 * s.s, c0: [0.07, 0.07, 0.07, 0.55], c1: [0.2, 0.2, 0.2, 0], drag: 0.2, fadeIn: 0.8 }); }
    }
    for (const f of this.flares || []) {
      if (Math.hypot(f.x - focus.x, f.z - focus.z) > 40) continue;
      f.acc += dt * 30;
      while (f.acc > 1) { f.acc -= 1; this.add.emit({ x: f.x, y: 0.06, z: f.z, vx: (Math.random() - 0.5) * 0.6, vy: 0.5 + Math.random(), vz: (Math.random() - 0.5) * 0.6, life: 0.35, s0: 0.22, s1: 0.05, c0: [5, 0.6, 0.2, 1], c1: [2, 0.1, 0.05, 0] }); if (Math.random() < 0.08) this.smoke.emit({ x: f.x, y: 0.2, z: f.z, vx: 0.3, vy: 0.8, vz: 0.1, life: 3, s0: 0.3, s1: 1.8, c0: [0.5, 0.15, 0.12, 0], c1: [0.4, 0.2, 0.2, 0], arc: 0.25 }); }
    }
    // ambient dust motes around focus
    this.dustT += dt * 30;
    while (this.dustT > 1) {
      this.dustT -= 1;
      this.add.emit({ x: focus.x + (Math.random() - 0.5) * 50, y: Math.random() * 6, z: focus.z + (Math.random() - 0.5) * 50, vx: 0.4 + Math.random() * 0.3, vy: (Math.random() - 0.5) * 0.2, vz: 0.2, life: 6, s0: 0.05, s1: 0.05, c0: [0.5, 0.45, 0.4, 0], c1: [0.5, 0.45, 0.4, 0], arc: 0.35 });
    }
    this.add.update(dt, scale); this.fire.update(dt, scale); this.smoke.update(dt, scale); this.debris.update(dt, scale);
  }

  dispose() {
    for (const s of [this.add, this.fire, this.smoke, this.debris]) s.dispose();
    for (const t of this.tracers) this.scene.remove(t.m);
    for (const d of this.decals) this.scene.remove(d);
  }
}

import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
function mergeTwo(a, b) { return mergeGeometries([a, b], false); }
function flashTexture() { return T.softSprite('flash', 1, 0); }
