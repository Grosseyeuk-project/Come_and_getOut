// Combat + ambient visual effects: tracers, muzzle flashes, impacts (sparks/dust/blood), shell casings,
// fires, smoke columns, ambient dust motes, ground decals (blood, scorch), transient lights.
import * as THREE from 'three';
import { ParticleSystem, StreakSystem, DebrisSystem } from './particles.js';
import { splatTex, poolTex, starTex } from './fxtex.js';
import * as T from '../render/textures.js';

export class Effects {
  constructor(scene, lighting, renderer) {
    this.scene = scene; this.lighting = lighting; this.renderer = renderer;
    this.add = new ParticleSystem(scene, { max: 3000, map: T.softSprite('spark', 1, 0), additive: true });
    this.fire = new ParticleSystem(scene, { max: 1500, map: T.softSprite('fire', 1, 0), additive: true });
    this.smoke = new ParticleSystem(scene, { max: 1600, map: T.smokeSprite(), additive: false });
    this.debris = new ParticleSystem(scene, { max: 800, map: T.softSprite('chunk', 1, 0.9), additive: false });
    this.star = new ParticleSystem(scene, { max: 300, map: starTex(), additive: true });
    this.wet = new ParticleSystem(scene, { max: 1500, map: T.softSprite('wet', 1, 0), additive: false });
    this.streaks = new StreakSystem(scene, 1800);
    const brass = new THREE.MeshStandardMaterial({ color: 0xc89a48, metalness: 1, roughness: 0.28, emissive: 0x2a1a06 });
    const cg = new THREE.CylinderGeometry(0.012, 0.012, 0.05, 6); cg.rotateZ(Math.PI / 2);
    this.casings = new DebrisSystem(scene, cg, brass, 260);
    const sg = new THREE.CylinderGeometry(0.022, 0.022, 0.07, 7); sg.rotateZ(Math.PI / 2);
    this.shells = new DebrisSystem(scene, sg, new THREE.MeshStandardMaterial({ color: 0xa81e14, roughness: 0.45, metalness: 0.2, emissive: 0x200402 }), 120);
    this.chunks = new DebrisSystem(scene, new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), 400, { shadow: false });
    this.scrap = new DebrisSystem(scene, new THREE.BoxGeometry(1, 0.15, 0.6), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.8 }), 100);
    const gg = new THREE.IcosahedronGeometry(1, 0); gg.scale(1, 0.7, 0.8);
    this.gibs = new DebrisSystem(scene, gg, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.05, flatShading: true }), 220, { shadow: true });
    this.growing = []; this.decalN = 0;
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
    const wetMat = (tex, color, rough = 0.18) => new THREE.MeshStandardMaterial({ map: tex, color, transparent: true, depthWrite: false, roughness: rough, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    BLOOD.splatMats = [0, 1, 2].map((v) => wetMat(splatTex(v), 0x8a0c0a)); BLOOD.poolMat = wetMat(poolTex(), 0x7a0a08, 0.22);
    ICHOR.splatMats = [0, 1, 2].map((v) => wetMat(splatTex(v), 0x5a6a10)); ICHOR.poolMat = wetMat(poolTex(), 0x4a5a0a, 0.25);
    this.wetMats = [...BLOOD.splatMats, BLOOD.poolMat, ...ICHOR.splatMats, ICHOR.poolMat];
    this.flashes = [];
    const fg = new THREE.PlaneGeometry(1, 0.5); fg.rotateX(-Math.PI / 2); fg.translate(0.5 - 40 / 256, 0, 0); this.flashGeo = fg;
    this.flashMat = new THREE.MeshBasicMaterial({ map: T.muzzleTex(), color: new THREE.Color(2.2, 1.7, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
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
    if (!(len > 0.05)) return; // degenerate (point-blank): lookAt/normalise would produce NaN
    const c = new THREE.Color(color).multiplyScalar(2.2);
    const m = new THREE.Mesh(this.tracerGeo, new THREE.MeshBasicMaterial({ color: c, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    m.position.set(x0, y0, z0); m.lookAt(x1, y1, z1);
    const seg = Math.min(len, 6);
    m.scale.set(width, width, seg);
    m.renderOrder = 4;
    this.scene.add(m);
    this.tracers.push({ m, x0, y0, z0, dx: (x1 - x0) / len, dy: (y1 - y0) / len, dz: (z1 - z0) / len, len, d: 0, seg, speed });
  }

  // Muzzle blast: oriented flash card + star + forward cone of sparks + smoke, and a short bright light pulse
  muzzle(x, y, z, dx, dz, scale = 1, color = [1, 0.75, 0.4]) {
    const fm = new THREE.Mesh(this.flashGeo, this.flashMat);
    fm.position.set(x, y, z); fm.rotation.y = Math.atan2(-dz, dx); fm.rotation.x = (Math.random() - 0.5) * 0.6;
    const fs = (1.1 + Math.random() * 0.6) * scale; fm.scale.set(fs, 1, fs * (0.8 + Math.random() * 0.5)); fm.renderOrder = 8;
    this.scene.add(fm); this.flashes.push({ m: fm, t: 0 });
    this.star.emit({ x: x + dx * 0.05, y, z: z + dz * 0.05, life: 0.05, s0: 0.75 * scale, s1: 0.4 * scale, c0: [color[0] * 5, color[1] * 5, color[2] * 5, 1], c1: [color[0] * 2, color[1], color[2] * 0.5, 0] });
    for (let i = 0; i < 3; i++) this.add.emit({ x: x + dx * 0.12 * i, y, z: z + dz * 0.12 * i, vx: dx * (3 + i * 3), vz: dz * (3 + i * 3), life: 0.06, s0: (0.7 - i * 0.15) * scale, s1: 0.12, c0: [color[0] * 4, color[1] * 4, color[2] * 4, 1], c1: [color[0], color[1] * 0.5, 0.1, 0] });
    const ns = Math.round(5 * scale);
    for (let i = 0; i < ns; i++) {
      const sp = 10 + Math.random() * 14, a = (Math.random() - 0.5) * 0.7, ca = Math.cos(a), sa = Math.sin(a);
      this.streaks.emit({ x, y, z, vx: (dx * ca - dz * sa) * sp, vy: (Math.random() - 0.3) * 3, vz: (dx * sa + dz * ca) * sp, life: 0.05 + Math.random() * 0.08, trail: 0.02, w: 0.018, c0: [5, 3.2, 1.2, 1], c1: [2, 0.6, 0.1, 0], grav: 2, drag: 4 });
    }
    this.smoke.emit({ x: x + dx * 0.25, y, z: z + dz * 0.25, vx: dx * 1.6, vy: 0.5, vz: dz * 1.6, life: 0.9, s0: 0.3 * scale, s1: 1.3 * scale, c0: [0.55, 0.53, 0.5, 0.3], c1: [0.5, 0.5, 0.5, 0], drag: 2.2 });
    this.flashLight(x + dx * 0.3, y + 0.25, z + dz * 0.3, 0xffa850, 45 * scale, 12 * Math.sqrt(scale), 0.055);
  }

  flashLight(x, y, z, color, intensity, range, ttl) {
    if (!isFinite(x + y + z + intensity + range)) return;
    // cap simultaneous transient lights: refresh the oldest instead of growing the list
    if (this.lights.length >= 6) { const o = this.lights.shift(); this.lighting.removeSource(o.s); }
    const s = this.lighting.addSource(new THREE.Vector3(x, y, z), color, intensity, range, 'steady', { priority: 2.5 });
    this.lights.push({ s, ttl, t: 0, i0: intensity });
  }

  casing(x, y, z, dx, dz, shell = false) {
    if (!isFinite(x + y + z)) return;
    const px = -dz, pz = dx, sp = 2.2 + Math.random() * 1.4;
    const sys = shell ? this.shells : this.casings;
    sys.emit({ x, y, z, vx: px * sp - dx * 0.6 + (Math.random() - 0.5) * 0.6, vy: 2.6 + Math.random() * 1.4, vz: pz * sp - dz * 0.6 + (Math.random() - 0.5) * 0.6, life: 9, spin: 40, grav: 15, bounce: 0.4, floor: 0.03 });
    // a wisp of smoke from the ejection port
    this.smoke.emit({ x, y: y + 0.05, z, vx: px * 0.4, vy: 0.5, vz: pz * 0.4, life: 0.6, s0: 0.08, s1: 0.4, c0: [0.6, 0.58, 0.55, 0.2], c1: [0.5, 0.5, 0.5, 0], drag: 2 });
  }

  // Bullet impact. (nx, nz) = surface normal / spray direction back toward the shooter,
  // (bx, bz) = bullet travel direction (used for exit spray on flesh).
  impact(x, y, z, nx, nz, kind = 'concrete', bx = -nx, bz = -nz, power = 1) {
    if (!isFinite(x + y + z + nx + nz)) return;
    if (kind === 'flesh' || kind === 'ichor') return this.bloodHit(x, y, z, bx, bz, kind === 'ichor' ? ICHOR : BLOOD, power);
    const metal = kind === 'metal';
    const P = Math.min(2, power);
    // white-hot flash
    this.star.emit({ x: x + nx * 0.05, y, z: z + nz * 0.05, life: 0.07, s0: (metal ? 1.3 : 0.9) * (0.7 + P * 0.3), s1: 0.3, c0: metal ? [5, 4.2, 3, 1] : [4, 2.6, 1.4, 1], c1: [1.5, 0.6, 0.2, 0], rot: Math.random() * 6 });
    // sparks: streaks spraying off the surface (reflect-ish cone around the normal)
    const wood = kind === 'wood', ground = kind === 'ground';
    const n = Math.round((metal ? 18 : wood ? 3 : ground ? 4 : 9) * P);
    for (let i = 0; i < n; i++) {
      const sp = (metal ? 6 : 4) + Math.random() * (metal ? 14 : 9);
      const ox = nx + (Math.random() - 0.5) * 1.8, oz = nz + (Math.random() - 0.5) * 1.8;
      this.streaks.emit({ x, y, z, vx: ox * sp, vy: (Math.random() * 1.2 - 0.2) * sp * 0.6, vz: oz * sp, life: 0.15 + Math.random() * (metal ? 0.5 : 0.3), trail: 0.025, w: metal ? 0.022 : 0.018,
        c0: metal ? [6, 4.5, 2.2, 1] : [5, 2.6, 0.9, 1], c1: [1.4, 0.25, 0.02, 0], grav: 11, drag: 1.2, bounce: 0.45 });
    }
    // hot embers that linger
    for (let i = 0; i < (metal ? 4 : 2); i++) this.add.emit({ x, y, z, vx: (nx + (Math.random() - 0.5)) * 3, vy: Math.random() * 3, vz: (nz + (Math.random() - 0.5)) * 3, life: 0.4 + Math.random() * 0.5, s0: 0.07, s1: 0.02, c0: [4, 2, 0.6, 1], c1: [1, 0.2, 0, 0], grav: 8, drag: 1, floor: 0.03, bounce: 0.3 });
    if (!metal) {
      // dust puff: billowing cloud pushed out of the wall, lit by nothing (kept mid-grey to read in the dark)
      for (let i = 0; i < (ground ? 4 : 5); i++) {
        const sp = 0.8 + Math.random() * 2.6;
        this.smoke.emit({ x, y, z, vx: nx * sp + (Math.random() - 0.5) * 1.2, vy: 0.2 + Math.random() * 1.0, vz: nz * sp + (Math.random() - 0.5) * 1.2, life: 0.9 + Math.random() * 0.9, s0: 0.25, s1: 1.3 + Math.random() * 0.6, c0: [0.62, 0.58, 0.52, 0.55], c1: [0.5, 0.48, 0.45, 0], drag: 3.2 });
      }
      // chips: 3D chunks + fine grit sprites
      const nc = Math.round((1 + Math.random() * 3) * P);
      for (let i = 0; i < nc; i++) {
        const sp = 2 + Math.random() * 4, gv = 0.25 + Math.random() * 0.35;
        this.chunks.emit({ x, y, z, vx: (nx + (Math.random() - 0.5) * 1.4) * sp, vy: 1 + Math.random() * 3.5, vz: (nz + (Math.random() - 0.5) * 1.4) * sp, s: 0.03 + Math.random() * 0.05, life: 5 + Math.random() * 4, color: (wood ? WOODC : CHIP)[(Math.random() * CHIP.length) | 0], sx: wood ? 2.5 : 1, sy: wood ? 0.5 : 1, bounce: 0.3 });
        void gv;
      }
      for (let i = 0; i < 6; i++) this.debris.emit({ x, y, z, vx: nx * 3 + (Math.random() - 0.5) * 4, vy: 1 + Math.random() * 3.5, vz: nz * 3 + (Math.random() - 0.5) * 4, life: 0.8, s0: 0.04, c0: [0.42, 0.4, 0.36, 1], c1: [0.35, 0.33, 0.3, 0], grav: 14, bounce: 0.3, floor: 0.03 });
    } else {
      this.smoke.emit({ x, y, z, vx: nx, vy: 0.5, vz: nz, life: 0.6, s0: 0.15, s1: 0.7, c0: [0.4, 0.4, 0.42, 0.35], c1: [0.4, 0.4, 0.4, 0], drag: 3 });
      if (Math.random() < 0.3 * P) this.scrap.emit({ x, y, z, vx: nx * 3 + (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 2, vz: nz * 3 + (Math.random() - 0.5) * 2, s: 0.05, life: 5, color: 0x6a6660 });
    }
  }

  // Flesh hit: exit spray in the bullet direction (mist + droplets + splat on the ground), small entry puff.
  bloodHit(x, y, z, bx, bz, B = BLOOD, power = 1) {
    const P = Math.min(2.5, power);
    const nd = Math.round(16 * P);
    for (let i = 0; i < nd; i++) {
      const sp = 2 + Math.random() * 5;
      this.wet.emit({ x, y, z, vx: (bx + (Math.random() - 0.5) * 1.1) * sp, vy: (Math.random() - 0.1) * 3.2, vz: (bz + (Math.random() - 0.5) * 1.1) * sp, life: 0.5 + Math.random() * 0.4, s0: 0.1 + Math.random() * 0.12, s1: 0.05, c0: B.drop, c1: B.dropEnd, grav: 13, floor: 0.04, drag: 0.6 });
    }
    // mist cloud
    for (let i = 0; i < 3; i++) this.wet.emit({ x: x + bx * 0.15, y, z: z + bz * 0.15, vx: bx * (1.5 + Math.random() * 2) + (Math.random() - 0.5), vy: Math.random() * 0.8, vz: bz * (1.5 + Math.random() * 2) + (Math.random() - 0.5), life: 0.35 + Math.random() * 0.25, s0: 0.35, s1: 1.2 + P * 0.35, c0: B.mist, c1: B.mistEnd, drag: 4 });
    // bright wet glint + hot fragments (additive) so hits read against dark bodies at gameplay zoom
    this.star.emit({ x, y, z, life: 0.06, s0: 0.7 + P * 0.2, s1: 0.25, c0: B.glint, c1: [0, 0, 0, 0] });
    for (let i = 0; i < 3 + P * 2; i++) {
      const sp = 4 + Math.random() * 7;
      this.streaks.emit({ x, y, z, vx: (bx + (Math.random() - 0.5) * 1.6) * sp, vy: Math.random() * 3, vz: (bz + (Math.random() - 0.5) * 1.6) * sp, life: 0.12 + Math.random() * 0.15, trail: 0.025, w: 0.016, c0: B.spark, c1: [0.6, 0.05, 0.02, 0], grav: 10, drag: 2 });
    }
    if (P > 1.2 && Math.random() < 0.5) this.gibs.emit({ x, y, z, vx: bx * 4 + (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3, vz: bz * 4 + (Math.random() - 0.5) * 2, s: 0.04 + Math.random() * 0.04, life: 8, color: B.gib[(Math.random() * B.gib.length) | 0], spin: 25, bounce: 0.2 });
    for (let i = 0; i < Math.max(1, Math.round(P * 1.5)); i++) {
      const d = 0.6 + Math.random() * 1.6 * P;
      this.splat(x + bx * d + (Math.random() - 0.5) * 0.5, z + bz * d + (Math.random() - 0.5) * 0.5, Math.atan2(bz, bx), 0.7 + Math.random() * 0.6 * P, B);
    }
  }

  // Death burst: big directional gore + optional gibs (overkill).
  gore(x, z, bx, bz, kind = 'blood', gibs = 0, size = 1) {
    const B = kind === 'ichor' ? ICHOR : BLOOD;
    this.bloodHit(x, 1.1 * size, z, bx, bz, B, 2.5);
    for (let i = 0; i < 4; i++) this.wet.emit({ x, y: 1 * size, z, vx: bx * 3 + (Math.random() - 0.5) * 3, vy: 1 + Math.random() * 2, vz: bz * 3 + (Math.random() - 0.5) * 3, life: 0.7, s0: 0.5, s1: 1.8 * size, c0: B.mist, c1: B.mistEnd, drag: 3 });
    for (let i = 0; i < gibs; i++) {
      const sp = 3 + Math.random() * 6;
      this.gibs.emit({ x: x + (Math.random() - 0.5) * 0.4, y: 0.6 + Math.random() * 0.9 * size, z: z + (Math.random() - 0.5) * 0.4,
        vx: (bx + (Math.random() - 0.5) * 1.6) * sp, vy: 2 + Math.random() * 5, vz: (bz + (Math.random() - 0.5) * 1.6) * sp,
        s: (0.06 + Math.random() * 0.09) * size, sx: 1 + Math.random(), life: 10 + Math.random() * 4, color: B.gib[(Math.random() * B.gib.length) | 0], spin: 25, bounce: 0.2,
        onLand: (q) => this.splat(q.x, q.z, Math.atan2(q.vz, q.vx), 0.45 + Math.random() * 0.4, B) });
    }
    this.splat(x + bx * 1.2, z + bz * 1.2, Math.atan2(bz, bx), 2 * size, B);
  }
  pool(x, z, s = 1.6, kind = 'blood', delay = 0.5) { const B = kind === 'ichor' ? ICHOR : BLOOD; this.decal(B.poolMat, x, z, s, Math.random() * 6.28, 3.5, delay); }

  splat(x, z, ang, s, B = BLOOD) { this.decal(B.splatMats[(Math.random() * B.splatMats.length) | 0], x, z, s, -ang, 0.12); }
  blood(x, z, s = 1) { this.splat(x, z, Math.random() * 6.28, s * (0.8 + Math.random() * 0.8)); }
  scorch(x, z, s = 2) { this.decal(this.decalMats.scorch, x, z, s, Math.random() * 6.28, 0); }
  decal(mat, x, z, s, rot = Math.random() * 6.28, grow = 0, delay = 0) {
    if (typeof mat === 'string') mat = this.decalMats[mat];
    if (!isFinite(x + z + s)) return;
    const m = new THREE.Mesh(this.decalGeo, mat);
    m.position.set(x, 0.045 + (this.decalN++ % 64) * 0.0004, z); m.rotation.y = rot; m.receiveShadow = true; m.renderOrder = 1;
    m.scale.set(grow ? 0.001 : s, 1, grow ? 0.001 : s);
    this.scene.add(m); this.decals.push(m);
    if (grow) this.growing.push({ m, s, t: -delay, dur: grow });
    if (this.decals.length > 150) { const o = this.decals.shift(); this.scene.remove(o); }
  }

  // footstep / roll dust
  puff(x, z, s = 1, n = 2) {
    for (let i = 0; i < n; i++) this.smoke.emit({ x: x + (Math.random() - 0.5) * 0.3, y: 0.12, z: z + (Math.random() - 0.5) * 0.3, vx: (Math.random() - 0.5) * 1.2 * s, vy: 0.3 + Math.random() * 0.4, vz: (Math.random() - 0.5) * 1.2 * s, life: 0.8 + Math.random() * 0.5, s0: 0.25 * s, s1: 1.0 * s, c0: [0.5, 0.47, 0.42, 0.4], c1: [0.45, 0.43, 0.4, 0], drag: 2.5 });
  }
  // dissolve embers rising off a corpse
  embers(x, y, z, n = 3, color = [4, 1.4, 0.3]) {
    for (let i = 0; i < n; i++) this.add.emit({ x: x + (Math.random() - 0.5) * 0.8, y: y + Math.random() * 0.4, z: z + (Math.random() - 0.5) * 0.8, vx: (Math.random() - 0.5) * 0.4, vy: 0.8 + Math.random() * 1.2, vz: (Math.random() - 0.5) * 0.4, life: 0.8 + Math.random() * 0.8, s0: 0.06, s1: 0.01, c0: [color[0], color[1], color[2], 1], c1: [color[0] * 0.3, color[1] * 0.1, 0, 0], drag: 0.8, grav: -0.6 });
  }

  explosion(x, y, z, r = 3) {
    for (let i = 0; i < 30; i++) { const a = Math.random() * 6.28, sp = Math.random() * 10; this.add.emit({ x, y, z, vx: Math.cos(a) * sp, vy: Math.random() * 8, vz: Math.sin(a) * sp, life: 0.4 + Math.random() * 0.4, s0: 0.12, s1: 0.03, c0: [4, 2.2, 0.6, 1], c1: [1, 0.2, 0, 0], grav: 10, drag: 1 }); }
    for (let i = 0; i < 14; i++) { const a = Math.random() * 6.28, sp = Math.random() * 3; this.fire.emit({ x, y: y + Math.random(), z, vx: Math.cos(a) * sp, vy: 1 + Math.random() * 2, vz: Math.sin(a) * sp, life: 0.5, s0: r * 0.6, s1: r * 0.2, c0: [3, 1.4, 0.4, 1], c1: [1, 0.2, 0.05, 0], drag: 2 }); }
    for (let i = 0; i < 14; i++) { const a = Math.random() * 6.28, sp = Math.random() * 2.5; this.smoke.emit({ x, y: y + 0.5, z, vx: Math.cos(a) * sp, vy: 1 + Math.random() * 2, vz: Math.sin(a) * sp, life: 2.5, s0: 1, s1: r * 1.6, c0: [0.12, 0.11, 0.1, 0.7], c1: [0.2, 0.2, 0.2, 0], drag: 1.2 }); }
    this.flashLight(x, y + 1, z, 0xff8030, 120, 16, 0.25);
  }

  dustRing(x, z, r = 2.5) { // melee slam / heavy landing / dodge: irregular billow + grit
    const n = Math.round(10 + r * 6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.28 + Math.random() * 0.5, sp = r * (0.8 + Math.random() * 1.6);
      this.smoke.emit({ x: x + Math.cos(a) * 0.3, y: 0.15 + Math.random() * 0.2, z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * sp, vy: 0.2 + Math.random() * 0.6, vz: Math.sin(a) * sp, life: 0.7 + Math.random() * 0.7, s0: 0.3 + Math.random() * 0.4, s1: 1.0 + Math.random() * 1.0 + r * 0.2, c0: [0.5, 0.47, 0.42, 0.42], c1: [0.42, 0.4, 0.38, 0], drag: 3.5 });
    }
    if (r > 1.5) for (let i = 0; i < r * 5; i++) { const a = Math.random() * 6.28, sp = 2 + Math.random() * 4; this.chunks.emit({ x, y: 0.1, z, vx: Math.cos(a) * sp, vy: 2 + Math.random() * 4, vz: Math.sin(a) * sp, s: 0.04 + Math.random() * 0.06, life: 5, color: CHIP[(Math.random() * CHIP.length) | 0] }); }
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
    for (let i = this.flashes.length - 1; i >= 0; i--) { const f = this.flashes[i]; f.t += dt; if (f.t > 0.045) { this.scene.remove(f.m); this.flashes.splice(i, 1); } }
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
    for (let i = this.growing.length - 1; i >= 0; i--) {
      const d = this.growing[i]; d.t += dt; if (d.t < 0) continue;
      const f = Math.min(1, d.t / d.dur), e = 1 - Math.pow(1 - f, 3), sc = Math.max(0.001, d.s * e);
      d.m.scale.set(sc, 1, sc); if (f >= 1) this.growing.splice(i, 1);
    }
    this.add.update(dt, scale); this.fire.update(dt, scale); this.smoke.update(dt, scale); this.debris.update(dt, scale);
    this.star.update(dt, scale); this.wet.update(dt, scale); this.streaks.update(dt);
    for (const d of [this.casings, this.shells, this.chunks, this.scrap, this.gibs]) d.update(dt);
  }

  dispose() {
    for (const s of [this.add, this.fire, this.smoke, this.debris, this.star, this.wet, this.streaks, this.casings, this.shells, this.chunks, this.scrap, this.gibs]) s.dispose();
    for (const t of this.tracers) this.scene.remove(t.m);
    for (const d of this.decals) this.scene.remove(d);
  }
}

import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
function mergeTwo(a, b) { return mergeGeometries([a, b], false); }
function flashTexture() { return T.softSprite('flash', 1, 0); }

// gore palettes (linear colours; droplets are unlit sprites so keep them saturated enough to read)
const BLOOD = { drop: [0.85, 0.05, 0.03, 1], dropEnd: [0.45, 0.02, 0.01, 0.9], mist: [0.6, 0.05, 0.04, 0.6], mistEnd: [0.25, 0.01, 0.01, 0], glint: [2.4, 0.35, 0.15, 1], spark: [4, 0.9, 0.3, 1], gib: [0x7a1410, 0x5a0c0a, 0x8a2a20, 0x9a7a6a] };
const ICHOR = { drop: [0.38, 0.45, 0.05, 1], dropEnd: [0.18, 0.22, 0.02, 0.9], mist: [0.3, 0.38, 0.06, 0.5], mistEnd: [0.15, 0.2, 0.02, 0], glint: [1.4, 1.9, 0.2, 1], spark: [2.4, 3, 0.5, 1], gib: [0x4a5a14, 0x3a3a10, 0x6a7a2a, 0x8a8a6a] };
const CHIP = [0x6a6660, 0x5a5650, 0x7a746a, 0x4a4640, 0x807a70];
const WOODC = [0x5a3a20, 0x6a4628, 0x4a2e18, 0x7a5432, 0x3a2414];
