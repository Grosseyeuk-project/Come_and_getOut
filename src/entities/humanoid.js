// Procedural humanoid rig (player, raiders, mutants). Hierarchical groups animated procedurally:
// walk/strafe/backpedal cycle, two-bone IK arms holding a weapon, dodge roll, melee swing,
// hit flinch and a physics-ish death fall.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import * as T from '../render/textures.js';
import { clamp, damp } from '../core/rng.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const V = THREE.Vector3;
const UP_NEG = new V(0, -1, 0);

const KINDS = {
  player: { cloth: 0x3a3c30, pants: 0x3d382e, vest: 0x24272a, plate: 0x40464c, skin: 0xa07e66, boots: 0x1a1714, gloves: 0x141414, accent: 0x38d8ff, eye: 0x38d8ff, scale: 1 },
  raider: { cloth: 0x4a2a1c, pants: 0x342e26, vest: 0x2e241c, plate: 0x5a3a26, skin: 0x8a6a56, boots: 0x1c1712, gloves: 0x2a1d14, accent: 0xff3a14, eye: 0xff2a10, scale: 1 },
  mutant: { cloth: 0x2e2a22, pants: 0x2b2820, vest: 0x2a2620, plate: 0x3a3a30, skin: 0x75806a, boots: 0x3b382e, gloves: 0x6a705a, accent: 0xb4ff3a, eye: 0xd4ff30, scale: 1.05 },
  brute: { cloth: 0x2a221c, pants: 0x2a221c, vest: 0x3a2a20, plate: 0x5a3e2a, skin: 0x6a5a4e, boots: 0x2a2018, gloves: 0x5a4a3e, accent: 0xff6a1a, eye: 0xff8a20, scale: 1.45 },
};

function capsule(r, len, seg = 8) { return new THREE.CapsuleGeometry(r, len, 3, seg); }

export class Humanoid {
  constructor(kind = 'player') {
    this.kind = kind;
    const K = this.K = KINDS[kind];
    const fab = T.fabric();
    const mk = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, map: o.noTex ? null : fab.map, normalMap: o.noTex ? null : fab.normalMap, ...o.extra });
    this.mats = {
      cloth: mk(K.cloth), pants: mk(K.pants), vest: mk(K.vest),
      plate: new THREE.MeshStandardMaterial({ color: K.plate, roughness: 0.45, metalness: 0.65 }),
      skin: new THREE.MeshStandardMaterial({ color: K.skin, roughness: kind === 'mutant' || kind === 'brute' ? 0.55 : 0.7 }),
      boots: new THREE.MeshStandardMaterial({ color: K.boots, roughness: 0.6 }),
      gloves: new THREE.MeshStandardMaterial({ color: K.gloves, roughness: 0.7 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: K.accent, emissiveIntensity: 3 }),
      eye: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: K.eye, emissiveIntensity: 6 }),
      bone: new THREE.MeshStandardMaterial({ color: 0xc8bca0, roughness: 0.6 }),
    };
    this.allMats = Object.values(this.mats);
    const m = this.mats;
    const mutant = kind === 'mutant' || kind === 'brute';
    const root = this.root = new THREE.Group();
    const body = this.body = new THREE.Group(); root.add(body);
    const add = (parent, geo, mat, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => {
      const me = new THREE.Mesh(geo, mat); me.position.set(x, y, z); me.scale.set(sx, sy, sz); me.rotation.set(rx, ry, rz);
      me.castShadow = true; me.receiveShadow = true; parent.add(me); return me;
    };
    const G = (parent, x = 0, y = 0, z = 0) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };

    this.hips = G(body, 0, 0.98, 0);
    add(this.hips, new RoundedBoxGeometry(0.34, 0.2, 0.22, 2, 0.06), m.pants, 0, 0, 0);
    add(this.hips, new RoundedBoxGeometry(0.38, 0.06, 0.25, 1, 0.02), m.vest, 0, 0.08, 0); // belt
    if (!mutant) for (const sx of [-1, 1]) add(this.hips, new RoundedBoxGeometry(0.09, 0.1, 0.06, 1, 0.02), m.vest, sx * 0.15, 0.02, 0.1); // pouches
    this.spine = G(this.hips, 0, 0.1, 0);
    this.chest = G(this.spine, 0, 0.22, 0);
    add(this.chest, capsule(0.17, 0.2), mutant ? m.skin : m.cloth, 0, 0.02, 0, 1.3, 1, 0.82);
    if (!mutant) {
      add(this.chest, new RoundedBoxGeometry(0.42, 0.4, 0.3, 2, 0.05), m.vest, 0, 0.04, 0.0);
      add(this.chest, new RoundedBoxGeometry(0.3, 0.26, 0.05, 2, 0.02), m.plate, 0, 0.08, 0.16); // front plate
      for (let i = 0; i < 3; i++) add(this.chest, new RoundedBoxGeometry(0.08, 0.1, 0.05, 1, 0.015), m.vest, -0.1 + i * 0.1, -0.1, 0.17); // mag pouches
      add(this.chest, new RoundedBoxGeometry(0.34, 0.42, 0.18, 2, 0.05), m.cloth, 0, 0.02, -0.24); // backpack
      add(this.chest, new RoundedBoxGeometry(0.26, 0.12, 0.14, 1, 0.04), m.vest, 0, 0.27, -0.24); // bedroll
      add(this.chest, new THREE.BoxGeometry(0.2, 0.025, 0.01), m.accent, 0, -0.06, -0.335);
      for (const sx of [-1, 1]) add(this.chest, new RoundedBoxGeometry(0.16, 0.08, 0.2, 2, 0.03), m.plate, sx * 0.25, 0.2, 0, 0, 0, sx * -0.35); // shoulder pads
      if (kind === 'raider') for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) add(this.chest, new THREE.ConeGeometry(0.025, 0.12, 5), m.bone, sx * (0.26 + i * 0.02), 0.27, -0.05 + i * 0.05, 0, 0, sx * -0.6);
    } else {
      // hunched mutant torso: lumps + exposed ribs
      this.spine.rotation.x = 0.35;
      for (let i = 0; i < 5; i++) add(this.chest, new THREE.SphereGeometry(0.06 + (i % 3) * 0.025, 8, 6), m.skin, (i - 2) * 0.08, 0.1 + (i % 2) * 0.08, -0.14);
      add(this.chest, capsule(0.12, 0.12), m.skin, 0, 0.18, 0.02, 2.2, 1, 1.1, 0, 0, Math.PI / 2); // traps
      if (kind === 'brute') { add(this.chest, new RoundedBoxGeometry(0.46, 0.3, 0.36, 2, 0.04), m.plate, 0, 0.0, 0.03); add(this.chest, new THREE.TorusGeometry(0.18, 0.025, 6, 12), m.plate, 0, 0.32, 0, Math.PI / 2); }
    }
    this.neck = G(this.chest, 0, 0.28, mutant ? 0.06 : 0);
    add(this.neck, new THREE.CylinderGeometry(0.055, 0.065, 0.1, 8), m.skin, 0, 0.02, 0);
    this.head = G(this.neck, 0, 0.13, 0);
    add(this.head, new THREE.SphereGeometry(0.115, 14, 10), m.skin, 0, 0, 0, 0.95, 1.08, 1.0);
    if (kind === 'player') {
      add(this.head, new THREE.SphereGeometry(0.135, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), m.plate, 0, 0.02, -0.005, 1, 0.95, 1.05); // helmet
      add(this.head, new RoundedBoxGeometry(0.2, 0.06, 0.08, 1, 0.02), m.accent, 0, 0.0, 0.1); // visor
      add(this.head, new THREE.CylinderGeometry(0.035, 0.04, 0.06, 8), m.vest, 0, -0.07, 0.1, Math.PI / 2); // respirator
      add(this.head, new THREE.BoxGeometry(0.04, 0.04, 0.08), m.vest, 0.13, 0.04, 0.02); // headlamp
    } else if (kind === 'raider') {
      add(this.head, new THREE.SphereGeometry(0.125, 12, 8), m.bone, 0, -0.01, 0.025, 0.95, 1.0, 0.9); // skull mask
      for (const sx of [-1, 1]) add(this.head, new THREE.SphereGeometry(0.025, 8, 6), m.eye, sx * 0.045, 0.01, 0.125);
      add(this.head, new THREE.BoxGeometry(0.03, 0.09, 0.22), m.cloth, 0, 0.12, -0.02); // mohawk/crest
      add(this.head, new THREE.CylinderGeometry(0.04, 0.045, 0.07, 8), m.vest, 0, -0.08, 0.1, Math.PI / 2);
    } else {
      for (const sx of [-1, 1]) add(this.head, new THREE.SphereGeometry(0.022, 8, 6), m.eye, sx * 0.045, 0.02, 0.105);
      add(this.head, new THREE.BoxGeometry(0.12, 0.04, 0.08), m.skin, 0, -0.07, 0.07); // jaw
      add(this.head, new THREE.SphereGeometry(0.05, 8, 6), m.skin, 0.05, 0.08, -0.03);
    }
    // arms
    const armR = mutant ? 0.07 : 0.055, foreR = mutant ? 0.065 : 0.05;
    this.upperLen = mutant ? 0.34 : 0.29; this.foreLen = mutant ? 0.34 : 0.27;
    this.arms = [-1, 1].map((sx) => {
      const sh = G(this.chest, sx * (mutant ? 0.27 : 0.23), 0.17, 0);
      add(sh, capsule(armR, this.upperLen - armR * 1.6), mutant ? m.skin : m.cloth, 0, -this.upperLen / 2, 0);
      const el = G(sh, 0, -this.upperLen, 0);
      add(el, capsule(foreR, this.foreLen - foreR * 1.8), mutant ? m.skin : m.cloth, 0, -this.foreLen / 2, 0);
      if (!mutant) add(el, new THREE.CylinderGeometry(foreR * 1.15, foreR * 1.2, 0.08, 8), m.gloves, 0, -this.foreLen + 0.07, 0);
      const hand = add(el, new RoundedBoxGeometry(mutant ? 0.1 : 0.075, mutant ? 0.14 : 0.1, 0.05, 1, 0.02), m.gloves, 0, -this.foreLen - 0.03, 0);
      if (mutant) for (let i = 0; i < 3; i++) add(el, new THREE.ConeGeometry(0.012, 0.08, 4), m.bone, -0.03 + i * 0.03, -this.foreLen - 0.13, 0.02, Math.PI);
      return { sh, el, hand, sx };
    });
    // legs
    this.legs = [-1, 1].map((sx) => {
      const hp = G(this.hips, sx * 0.1, -0.06, 0);
      add(hp, capsule(0.075, 0.28), m.pants, 0, -0.21, 0);
      const kn = G(hp, 0, -0.44, 0);
      if (!mutant) add(kn, new RoundedBoxGeometry(0.11, 0.1, 0.06, 1, 0.02), m.plate, 0, 0, 0.065); // knee pad
      add(kn, capsule(0.06, 0.3), mutant && kind !== 'brute' ? m.skin : m.pants, 0, -0.2, 0);
      const ft = G(kn, 0, -0.44, 0);
      add(ft, new RoundedBoxGeometry(0.11, 0.09, 0.25, 1, 0.03), m.boots, 0, 0.0, 0.04);
      return { hp, kn, ft, sx };
    });
    this.weaponMount = G(this.chest, 0.08, 0.02, 0.32);
    this.weapon = null;
    root.scale.setScalar(K.scale);
    this.phase = 0; this.legYaw = 0; this.flash = 0; this.flinch = new V(); this.recoil = 0;
    this.deathT = -1; this.deathDir = 1;
    this.rollT = -1;
    this.attackT = -1;
    this.bake(fab);
  }

  // Merge every bone's meshes into one vertex-coloured mesh (+1 per glow material) -> ~20 draw calls per character.
  bake(fab) {
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.12, normalMap: fab.normalMap });
    this.bodyMat.normalScale.set(0.6, 0.6);
    // fresnel rim light keeps characters readable against the dark ground (The Ascent-style)
    const rimC = { player: [0.35, 0.5, 0.65], raider: [0.5, 0.16, 0.08], mutant: [0.3, 0.42, 0.12], brute: [0.5, 0.25, 0.08] }[this.kind];
    this.rim = { value: new THREE.Color(...rimC) };
    this.bodyMat.onBeforeCompile = (sh) => {
      sh.uniforms.uRim = this.rim;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
        .replace('#include <opaque_fragment>', 'outgoingLight += uRim * pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.5);\n#include <opaque_fragment>');
    };
    this.bodyMat.customProgramCacheKey = () => 'rim';
    const groups = []; this.root.traverse((o) => { if (o.isGroup) groups.push(o); });
    const glow = new Set([this.mats.accent, this.mats.eye]);
    for (const g of groups) {
      const meshes = g.children.filter((c) => c.isMesh);
      if (!meshes.length) continue;
      const buckets = new Map();
      for (const me of meshes) {
        const key = glow.has(me.material) ? me.material : this.bodyMat;
        me.updateMatrix();
        let geo = me.geometry.clone().applyMatrix4(me.matrix);
        if (geo.index) geo = geo.toNonIndexed();
        for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
        if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
        const c = me.material.color, n = geo.attributes.position.count, ca = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { ca[i * 3] = c.r; ca[i * 3 + 1] = c.g; ca[i * 3 + 2] = c.b; }
        geo.setAttribute('color', new THREE.BufferAttribute(ca, 3));
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(geo);
        g.remove(me); me.geometry.dispose();
      }
      for (const [mat, list] of buckets) {
        const merged = mergeGeometries(list, false);
        const mesh = new THREE.Mesh(merged, mat); mesh.castShadow = mat === this.bodyMat; mesh.receiveShadow = true;
        g.add(mesh);
      }
    }
    for (const k of Object.keys(this.mats)) if (!glow.has(this.mats[k])) this.mats[k].dispose();
    this.allMats = [this.bodyMat];
  }

  setWeapon(model) {
    if (this.weapon) this.weaponMount.remove(this.weapon);
    this.weapon = model;
    if (model) { this.weaponMount.add(model); model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.userData.shared = true; } }); }
  }

  hit(dirX, dirZ, strength = 1) { this.flash = 1; this.flinch.set(dirX, 0, dirZ).multiplyScalar(0.25 * strength); }
  die(dirX, dirZ) {
    this.deathT = 0;
    // fall direction relative to facing
    const f = new V(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
    this.deathDir = f.x * dirX + f.z * dirZ > 0 ? -1 : 1;
    this.deathSide = Math.random() - 0.5;
  }

  solveArm(arm, target, pole) {
    const a = this.upperLen, b = this.foreLen;
    const S = arm.sh.position;
    const D = new V().subVectors(target, S);
    const dist = clamp(D.length(), 0.05, a + b - 0.001);
    D.normalize();
    const cosA = clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    const p = pole.clone().addScaledVector(D, -pole.dot(D)).normalize();
    const E = new V().copy(S).addScaledVector(D, a * cosA).addScaledVector(p, a * sinA);
    const T2 = new V().copy(S).addScaledVector(D, dist);
    arm.sh.quaternion.setFromUnitVectors(UP_NEG, new V().subVectors(E, S).normalize());
    const inv = arm.sh.quaternion.clone().invert();
    arm.el.quaternion.setFromUnitVectors(UP_NEG, new V().subVectors(T2, E).normalize().applyQuaternion(inv));
  }

  // s: { speed, moveX, moveZ (world move dir), aiming, rolling, rollP (0..1) }
  update(dt, s) {
    const K = this.K;
    this.flash = Math.max(0, this.flash - dt * 6);
    for (const mt of this.allMats) mt.emissive.setRGB(this.flash * 0.9, this.flash * 0.25, this.flash * 0.15);
    this.flinch.multiplyScalar(Math.exp(-10 * dt));
    this.recoil = Math.max(0, this.recoil - dt * 9);

    if (this.deathT >= 0) { this.updateDeath(dt); return; }

    const face = this.root.rotation.y;
    const speed = s.speed || 0;
    // movement relative to facing
    let rel = 0;
    if (speed > 0.1) rel = Math.atan2(s.moveX, s.moveZ) - face;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    let dirSign = 1, legYaw = rel;
    if (Math.abs(rel) > Math.PI * 0.6) { dirSign = -1; legYaw = Math.atan2(Math.sin(rel + Math.PI), Math.cos(rel + Math.PI)); }
    legYaw = clamp(legYaw, -1.0, 1.0);
    this.legYaw = damp(this.legYaw, speed > 0.1 ? legYaw : 0, 10, dt);
    const stride = this.kind === 'brute' ? 4.2 : 5.4;
    this.phase += dt * speed * stride * 0.55 * dirSign;
    const amp = clamp(speed / 5, 0, 1.1) * 0.75;
    const ph = this.phase;
    this.hips.rotation.y = this.legYaw;
    this.spine.rotation.y = -this.legYaw * 0.85;
    const mutant = this.kind === 'mutant' || this.kind === 'brute';
    this.hips.position.y = 0.98 + Math.abs(Math.sin(ph)) * 0.05 * amp - amp * 0.03;
    this.hips.position.x = this.flinch.x * 0; // reserved
    this.spine.rotation.x = (mutant ? 0.35 : 0.06) + amp * 0.12 + this.recoil * -0.08 + this.flinchLocal(face).z;
    this.spine.rotation.z = Math.sin(ph) * 0.04 * amp + this.flinchLocal(face).x;
    for (const L of this.legs) {
      const p = ph + (L.sx > 0 ? 0 : Math.PI);
      L.hp.rotation.x = -Math.sin(p) * amp;
      L.kn.rotation.x = Math.max(0, Math.cos(p)) * amp * 1.3 + 0.05;
      L.ft.rotation.x = -L.hp.rotation.x * 0.3 - L.kn.rotation.x * 0.4;
    }
    // roll
    if (s.rolling) {
      const p = s.rollP;
      this.body.rotation.x = p * Math.PI * 2;
      this.body.position.y = Math.sin(p * Math.PI) * 0.3 + (1 - Math.cos(p * Math.PI * 2)) * -0.2;
      this.body.position.y = -Math.sin(p * Math.PI) * 0.45;
      for (const L of this.legs) { L.hp.rotation.x = -1.4; L.kn.rotation.x = 2.2; }
      this.spine.rotation.x = 0.9;
    } else {
      this.body.rotation.x = damp(this.body.rotation.x % (Math.PI * 2), 0, 20, dt);
      this.body.position.y = damp(this.body.position.y, 0, 20, dt);
    }

    // arms
    if (this.weapon && !mutant) {
      const wm = this.weaponMount;
      const rk = this.recoil;
      const low = s.reloading ? 1 : 0;
      wm.position.set(0.08, 0.02 - low * 0.12, 0.32 - rk * 0.08 - low * 0.05);
      wm.rotation.set(-rk * 0.25 + low * 0.5, low * -0.3, low * 0.4);
      const grip = new V(0, -0.05, -0.02).applyEuler(wm.rotation).add(wm.position);
      const fore = new V(0, -0.02, this.weapon.userData.foregrip || 0.26).applyEuler(wm.rotation).add(wm.position);
      if (s.reloading) fore.set(0.0, -0.18 + Math.sin(performance.now() * 0.012) * 0.04, 0.2);
      this.solveArm(this.arms[1], grip, new V(1, -0.6, -0.4));
      this.solveArm(this.arms[0], fore, new V(-1, -0.8, -0.2));
    } else {
      // free arms (mutants / unarmed): swing + attack
      for (const A of this.arms) {
        const p = ph + (A.sx > 0 ? Math.PI : 0);
        let rx = Math.sin(p) * amp * 0.8 - (mutant ? 0.5 : 0.1), rz = A.sx * -0.12;
        if (this.attackT >= 0) {
          const t = this.attackT; // 0..1
          const wind = t < 0.4 ? t / 0.4 : 1 - (t - 0.4) / 0.6;
          rx = -2.6 * (t < 0.4 ? wind : Math.max(0, 1 - (t - 0.4) * 3)) + (t >= 0.4 ? 0.8 * Math.sin((t - 0.4) * 5) : 0);
          rz = A.sx * -0.3;
        }
        A.sh.rotation.set(rx, 0, rz); A.sh.quaternion.setFromEuler(A.sh.rotation);
        A.el.rotation.set(-0.5 - (mutant ? 0.3 : 0), 0, 0); A.el.quaternion.setFromEuler(A.el.rotation);
      }
    }
    this.head.rotation.x = mutant ? -0.3 : -0.05;
  }
  flinchLocal(face) { // world flinch -> local x/z rotation offsets
    const c = Math.cos(face), s = Math.sin(face);
    const lx = this.flinch.x * c - this.flinch.z * s, lz = this.flinch.x * s + this.flinch.z * c;
    return { x: -lx, z: lz };
  }
  updateDeath(dt) {
    this.deathT += dt;
    const t = Math.min(1, this.deathT / 0.55);
    const e = t * t * (3 - 2 * t);
    this.body.rotation.x = this.deathDir * -e * (Math.PI / 2 - 0.05);
    this.body.rotation.z = this.deathSide * e * 0.4;
    this.body.position.y = 0.12 * e;
    this.body.position.z = -this.deathDir * e * 0.3;
    for (const A of this.arms) { A.sh.rotation.set(-1.2 * e - 0.2, 0, A.sx * (0.4 + e * 0.8)); A.sh.quaternion.setFromEuler(A.sh.rotation); }
    for (const L of this.legs) { L.hp.rotation.x = -0.2 * e * L.sx; L.kn.rotation.x = 0.4 * e; }
    this.spine.rotation.x = 0.1 * e; this.head.rotation.x = 0.4 * e;
    if (this.deathT > 6) this.root.position.y -= dt * 0.25; // sink away
  }
  dispose() { this.root.traverse((o) => { if (o.isMesh && !o.userData.shared) o.geometry.dispose(); }); this.bodyMat.dispose(); this.mats.accent.dispose(); this.mats.eye.dispose(); }
}
