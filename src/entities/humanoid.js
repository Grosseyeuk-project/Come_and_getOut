// Procedural humanoid rig (player, raiders, mutants, brutes). Hierarchical groups animated procedurally:
// walk/run cycle with lean + bob, two-bone IK arms holding a weapon (recoil, pump, reload), dodge roll
// tucked around the body centre, melee swings, hit flinches, momentum-driven death falls with
// variants (blown back / crumple / spin), decapitation, gibbing and a burning dissolve.
// Each faction has its own silhouette: ragged raiders with randomised gear, hunched long-armed
// mutants with glowing growths, and a huge armoured brute with a rebar maul.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import * as T from '../render/textures.js';
import { clamp, damp } from '../core/rng.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const V = THREE.Vector3;
const UP_NEG = new V(0, -1, 0);
const _v1 = new V(), _v2 = new V(), _v3 = new V(), _v4 = new V(), _q = new THREE.Quaternion();

const KINDS = {
  player: { cloth: 0x8a867e, pants: 0x4e4b46, vest: 0x3a3834, plate: 0xa9a59d, skin: 0xa07e66, boots: 0x2a2622, gloves: 0x3a3632, accent: 0xff9a3a, eye: 0xffb060, scale: 1.22, rim: [0.18, 0.16, 0.12] },
  raider: { cloth: 0x5a2a18, pants: 0x3a3226, vest: 0x2e241c, plate: 0x6a4a2e, skin: 0x8a6a56, boots: 0x1c1712, gloves: 0x2a1d14, accent: 0xff3a14, eye: 0xff2a10, scale: 1.14, rim: [0.6, 0.15, 0.06] },
  mutant: { cloth: 0x2e2a22, pants: 0x2b2820, vest: 0x2a2620, plate: 0x3a3a30, skin: 0x8a9478, boots: 0x3b382e, gloves: 0x7a8468, accent: 0xb4ff3a, eye: 0xd4ff30, scale: 1.12, rim: [0.4, 0.75, 0.1] },
  brute: { cloth: 0x2a221c, pants: 0x2a221c, vest: 0x3a2a20, plate: 0x6a6258, skin: 0x7a6252, boots: 0x2a2018, gloves: 0x3a3430, accent: 0xff6a1a, eye: 0xff8a20, scale: 1.72, rim: [0.6, 0.28, 0.06] },
};
const RAIDER_CLOTH = [0x5a2a18, 0x6a3a1a, 0x4a3a28, 0x5e4a30, 0x3a2e2a, 0x6a2420];

function capsule(r, len, seg = 8) { return new THREE.CapsuleGeometry(r, len, 3, seg); }

export class Humanoid {
  constructor(kind = 'player', variant = Math.random()) {
    this.kind = kind;
    const K = this.K = { ...KINDS[kind] };
    let rs = Math.floor(variant * 1e6) | 0; const rnd = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
    if (kind === 'raider') { K.cloth = RAIDER_CLOTH[Math.floor(rnd() * RAIDER_CLOTH.length)]; K.pants = [0x3a3226, 0x2e2a24, 0x44382a][Math.floor(rnd() * 3)]; }
    const fab = T.fabric();
    const mk = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    this.mats = {
      cloth: mk(K.cloth), pants: mk(K.pants), vest: mk(K.vest),
      plate: new THREE.MeshStandardMaterial({ color: K.plate, roughness: 0.45, metalness: 0.65 }),
      skin: new THREE.MeshStandardMaterial({ color: K.skin, roughness: 0.6 }),
      boots: new THREE.MeshStandardMaterial({ color: K.boots, roughness: 0.6 }),
      gloves: new THREE.MeshStandardMaterial({ color: K.gloves, roughness: 0.7 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: K.accent, emissiveIntensity: kind === 'mutant' ? 2.6 : kind === 'player' ? 1.4 : 3.5 }),
      eye: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: K.eye, emissiveIntensity: 6 }),
      bone: new THREE.MeshStandardMaterial({ color: 0xc8bca0, roughness: 0.6 }),
      rust: new THREE.MeshStandardMaterial({ color: 0x5a3a26, roughness: 0.8, metalness: 0.4 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }),
      cloth2: mk(kind === 'raider' ? RAIDER_CLOTH[Math.floor(rnd() * RAIDER_CLOTH.length)] : kind === 'player' ? 0x8a3a1c : K.cloth),
      flesh: new THREE.MeshStandardMaterial({ color: 0x8a3a30, roughness: 0.4 }),
    };
    const m = this.mats;
    const mutant = kind === 'mutant', brute = kind === 'brute', beast = mutant || brute;
    const root = this.root = new THREE.Group();
    const body = this.body = new THREE.Group(); root.add(body);
    const add = (parent, geo, mat, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => {
      const me = new THREE.Mesh(geo, mat); me.position.set(x, y, z); me.scale.set(sx, sy, sz); me.rotation.set(rx, ry, rz);
      parent.add(me); return me;
    };
    const addR = (parent, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => add(parent, geo, mat, x, y, z, 1, 1, 1, rx, ry, rz);
    const G = (parent, x = 0, y = 0, z = 0) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };
    const RB = (w, h, d, r = 0.03, s = 2) => new RoundedBoxGeometry(w, h, d, s, Math.min(r, w / 2.2, h / 2.2, d / 2.2));

    // proportions
    const P = this.P = {
      hipY: mutant ? 0.9 : 0.98, chestW: brute ? 1.55 : mutant ? 0.85 : 1, armR: brute ? 0.11 : mutant ? 0.055 : 0.068,
      upper: brute ? 0.33 : mutant ? 0.38 : 0.29, fore: brute ? 0.33 : mutant ? 0.42 : 0.27, shoulderX: brute ? 0.36 : mutant ? 0.22 : 0.23,
      hunch: mutant ? 0.62 : brute ? 0.3 : 0.06,
    };
    this.upperLen = P.upper; this.foreLen = P.fore;

    this.hips = G(body, 0, P.hipY, 0);
    add(this.hips, RB(0.34 * (brute ? 1.3 : 1), 0.2, 0.22, 0.06), m.pants);
    add(this.hips, RB(0.38 * (brute ? 1.3 : 1), 0.06, 0.25, 0.02, 1), m.vest, 0, 0.08, 0); // belt
    if (!beast) for (const sx of [-1, 1]) add(this.hips, RB(0.09, 0.1, 0.06, 0.02, 1), m.vest, sx * 0.15, 0.02, 0.1); // pouches
    this.spine = G(this.hips, 0, 0.1, 0);
    this.chest = G(this.spine, 0, 0.22, 0);
    const cw = P.chestW;
    if (kind === 'player') {
      // dark scavenger-operator: gunmetal plate carrier, rust scarf, asymmetric heavy left pauldron,
      // long split duster coat (separate swaying bone), cyan running lights for identity.
      add(this.chest, capsule(0.17, 0.2), m.cloth, 0, 0.02, 0, 1.3, 1, 0.85);
      add(this.chest, RB(0.44, 0.42, 0.31, 0.05), m.vest, 0, 0.03, 0);
      add(this.chest, RB(0.36, 0.3, 0.07, 0.025), m.plate, 0, 0.08, 0.16); // front plate
      add(this.chest, new THREE.BoxGeometry(0.22, 0.03, 0.012), m.accent, 0, 0.17, 0.2); // chest light bar
      for (let i = 0; i < 3; i++) add(this.chest, RB(0.085, 0.11, 0.06, 0.015, 1), m.pants, -0.11 + i * 0.11, -0.11, 0.19);
      add(this.chest, new THREE.TorusGeometry(0.13, 0.055, 6, 14), m.cloth2, 0, 0.27, 0.0, 1.1, 1, 0.9, Math.PI / 2, 0, 0); // scarf
      addR(this.chest, RB(0.12, 0.3, 0.05, 0.02), m.cloth2, 0.06, 0.12, 0.17, 0.1, 0, 0.25); // scarf tail
      add(this.chest, RB(0.34, 0.4, 0.2, 0.05), m.vest, 0, 0.04, -0.25); // pack
      add(this.chest, new THREE.CylinderGeometry(0.06, 0.06, 0.34, 8), m.plate, 0, 0.27, -0.27, 1, 1, 1, 0, 0, Math.PI / 2); // bedroll/canister
      for (const sx of [-1, 1]) add(this.chest, new THREE.BoxGeometry(0.025, 0.3, 0.012), m.accent, sx * 0.12, 0.03, -0.355);
      addR(this.chest, new THREE.CylinderGeometry(0.01, 0.01, 0.45, 4), m.vest, -0.12, 0.45, -0.3, -0.15); // antenna
      add(this.chest, new THREE.SphereGeometry(0.022, 6, 4), m.accent, -0.12, 0.68, -0.34);
      // asymmetric shoulders: heavy layered plate on the left, light strap on the right
      addR(this.chest, RB(0.24, 0.12, 0.3, 0.05), m.plate, -0.28, 0.23, 0, 0, 0, 0.45);
      addR(this.chest, RB(0.2, 0.08, 0.26, 0.04), m.plate, -0.31, 0.13, 0, 0, 0, 0.75);
      addR(this.chest, new THREE.BoxGeometry(0.14, 0.018, 0.012), m.accent, -0.3, 0.27, 0.15, 0, 0, 0.45);
      addR(this.chest, RB(0.14, 0.06, 0.18, 0.02), m.vest, 0.26, 0.21, 0, 0, 0, -0.4);
      // duster coat tails hang from the belt on their own bone
      this.cape = G(this.hips, 0, 0.06, 0);
      for (const [x, z, ry] of [[-0.17, -0.06, 0.25], [-0.06, -0.14, 0], [0.06, -0.14, 0], [0.17, -0.06, -0.25], [-0.19, 0.06, 0.6], [0.19, 0.06, -0.6]]) addR(this.cape, new THREE.BoxGeometry(0.13, 0.62, 0.02), m.cloth, x, -0.33, z, 0, ry, 0);
        } else if (kind === 'raider') {
      add(this.chest, capsule(0.17, 0.2), m.cloth, 0, 0.02, 0, 1.3, 1, 0.82);
      add(this.chest, RB(0.4, 0.36, 0.28, 0.05), m.vest, 0, 0.02, 0);
      // scavenged armour: random plates, tyre pauldron, bandolier
      if (rnd() < 0.6) add(this.chest, RB(0.26, 0.2, 0.04, 0.01), m.rust, (rnd() - 0.5) * 0.08, 0.1, 0.16, 1, 1, 1, 0, 0, (rnd() - 0.5) * 0.4);
      add(this.chest, new THREE.BoxGeometry(0.06, 0.5, 0.31), m.vest, 0, 0.02, 0, 1, 1, 1, 0, 0, 0.75); // bandolier
      // faction glow tape: red bars front + back so raiders read against the street at range
      add(this.chest, new THREE.BoxGeometry(0.3, 0.035, 0.012), m.accent, 0, -0.08, 0.15);
      add(this.chest, new THREE.BoxGeometry(0.035, 0.26, 0.012), m.accent, 0.09, 0.06, -0.15);
      add(this.chest, new THREE.BoxGeometry(0.035, 0.26, 0.012), m.accent, -0.09, 0.06, -0.15);
      for (let i = 0; i < 5; i++) add(this.chest, new THREE.CylinderGeometry(0.014, 0.014, 0.06, 5), m.bone, -0.13 + i * 0.065, 0.13 - i * 0.065 * 0.95, 0.17);
      const tyreSide = rnd() < 0.5 ? -1 : 1;
      addR(this.chest, new THREE.TorusGeometry(0.11, 0.05, 6, 12), m.rubber, tyreSide * 0.27, 0.2, 0, Math.PI / 2, 0.3 * tyreSide, 0);
      addR(this.chest, RB(0.16, 0.07, 0.2, 0.03), m.rust, -tyreSide * 0.26, 0.21, 0, 0, 0, tyreSide * 0.4);
      for (let i = 0; i < 3; i++) addR(this.chest, new THREE.ConeGeometry(0.025, 0.14, 5), m.bone, -tyreSide * (0.27 + i * 0.02), 0.28, -0.06 + i * 0.06, 0, 0, tyreSide * 0.6);
      const back = rnd();
      if (back < 0.55) { // junk pack + antenna with red light, or a banner pole
        add(this.chest, RB(0.32, 0.38, 0.18, 0.04), m.cloth2, 0, 0.0, -0.24);
        addR(this.chest, new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8), m.rust, 0, 0.28, -0.26, 0, 0, Math.PI / 2);
        if (rnd() < 0.5) { addR(this.chest, new THREE.CylinderGeometry(0.01, 0.01, 0.8, 4), m.vest, -0.1, 0.55, -0.3, -0.12); addR(this.chest, new THREE.SphereGeometry(0.03, 6, 4), m.accent, -0.1, 0.95, -0.35); }
        else { add(this.chest, new THREE.CylinderGeometry(0.014, 0.014, 1.2, 4), m.rust, 0.12, 0.6, -0.3); add(this.chest, new THREE.BoxGeometry(0.01, 0.36, 0.3), m.cloth2, 0.12, 1.0, -0.46); }
      }
      if (back >= 0.35) { // ragged cape: torn strips that sway
        this.cape = G(this.chest, 0, 0.26, -0.17);
        const n = 5;
        for (let i = 0; i < n; i++) { const l = 0.55 + rnd() * 0.35; add(this.cape, new THREE.BoxGeometry(0.1, l, 0.012), i % 2 ? m.cloth2 : m.cloth, -0.2 + i * 0.1, -l / 2, -0.02 - Math.abs(i - 2) * 0.015, 1, 1, 1, 0, 0, (rnd() - 0.5) * 0.15); }
      }
    } else if (mutant) {
      add(this.chest, capsule(0.15, 0.22), m.skin, 0, 0.02, 0, 1.15, 1, 0.9);
      // spine ridge + glowing pustules + exposed ribs
      for (let i = 0; i < 6; i++) addR(this.chest, new THREE.ConeGeometry(0.03, 0.12 - i * 0.008, 5), m.bone, 0, 0.26 - i * 0.075, -0.14 - Math.sin(i * 0.5) * 0.02, -1.1);
      for (let i = 0; i < 7; i++) add(this.chest, new THREE.SphereGeometry(0.035 + (i % 3) * 0.02, 8, 6), i % 3 === 0 ? m.accent : m.skin, (rnd() - 0.5) * 0.3, rnd() * 0.3 - 0.05, -0.1 - rnd() * 0.06);
      for (let i = 0; i < 4; i++) addR(this.chest, new THREE.TorusGeometry(0.15, 0.012, 4, 10, Math.PI), m.bone, 0, 0.08 - i * 0.06, 0.03, 0, 0, Math.PI);
      add(this.chest, capsule(0.1, 0.14), m.skin, 0, 0.2, 0.0, 2.4, 1, 1.1, 0, 0, Math.PI / 2); // traps
      for (let i = 0; i < 4; i++) add(this.chest, new THREE.SphereGeometry(0.04, 6, 5), m.accent, (i - 1.5) * 0.09, 0.22 - (i % 2) * 0.12, -0.15); // glowing back boils
      add(this.hips, new THREE.BoxGeometry(0.36, 0.16, 0.24), m.cloth, 0, -0.08, 0); // torn shorts
      for (let i = 0; i < 4; i++) add(this.hips, new THREE.BoxGeometry(0.08, 0.2, 0.01), m.cloth, -0.13 + i * 0.09, -0.18, 0.125);
    } else { // brute
      add(this.chest, capsule(0.2, 0.2), m.skin, 0, 0.0, 0, 1.6, 1.05, 1.0);
      add(this.chest, RB(0.62, 0.42, 0.42, 0.06), m.plate, 0, 0.04, 0.02); // cuirass
      add(this.chest, RB(0.5, 0.1, 0.1, 0.03), m.rust, 0, -0.14, 0.2);
      for (let i = 0; i < 4; i++) addR(this.chest, new THREE.CylinderGeometry(0.02, 0.02, 0.03, 6), m.bone, -0.18 + i * 0.12, 0.18, 0.235, Math.PI / 2);
      for (const sx of [-1, 1]) { // huge layered pauldrons
        addR(this.chest, RB(0.3, 0.14, 0.36, 0.05), m.plate, sx * 0.42, 0.26, 0, 0, 0, sx * -0.35);
        addR(this.chest, RB(0.24, 0.1, 0.3, 0.04), m.rust, sx * 0.46, 0.16, 0, 0, 0, sx * -0.6);
        addR(this.chest, new THREE.ConeGeometry(0.04, 0.2, 5), m.bone, sx * 0.46, 0.4, -0.02, 0, 0, sx * -0.3);
      }
      add(this.chest, new THREE.CylinderGeometry(0.16, 0.16, 0.5, 10), m.rust, 0, 0.12, -0.3); // fuel tank back
      for (let i = 0; i < 2; i++) addR(this.chest, new THREE.CylinderGeometry(0.02, 0.02, 0.4, 5), m.vest, -0.08 + i * 0.16, 0.5, -0.33, 0.3);
      add(this.chest, new THREE.BoxGeometry(0.2, 0.025, 0.012), m.accent, 0, 0.12, -0.465);
    }
    // head
    this.neck = G(this.chest, 0, brute ? 0.3 : 0.28, mutant ? 0.1 : brute ? 0.06 : 0);
    add(this.neck, new THREE.CylinderGeometry(brute ? 0.09 : 0.055, brute ? 0.11 : 0.065, 0.1, 8), m.skin, 0, 0.02, 0);
    this.head = G(this.neck, 0, brute ? 0.12 : 0.13, mutant ? 0.04 : 0);
    if (kind === 'player') {
      add(this.head, new THREE.SphereGeometry(0.115, 14, 10), m.skin, 0, 0, 0, 0.95, 1.08, 1.0);
      add(this.head, new THREE.SphereGeometry(0.145, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), m.plate, 0, 0.02, -0.01, 1, 0.98, 1.08); // helmet
      add(this.head, RB(0.24, 0.07, 0.09, 0.025, 1), m.accent, 0, 0.0, 0.1); // visor
      add(this.head, RB(0.16, 0.08, 0.1, 0.03), m.vest, 0, -0.08, 0.08); // rebreather
      for (const sx of [-1, 1]) add(this.head, new THREE.CylinderGeometry(0.03, 0.03, 0.05, 8), m.vest, sx * 0.08, -0.1, 0.07, 1, 1, 1, 1.2, 0, sx * 0.5);
      add(this.head, new THREE.BoxGeometry(0.04, 0.05, 0.1), m.vest, 0.15, 0.03, 0.02); // headlamp
      add(this.head, new THREE.BoxGeometry(0.03, 0.015, 0.012), m.accent, 0.15, 0.03, 0.075);
    } else if (kind === 'raider') {
      const hv = rnd();
      add(this.head, new THREE.SphereGeometry(0.115, 12, 8), m.skin, 0, 0, 0, 0.95, 1.08, 1.0);
      if (hv < 0.4) { // skull mask + mohawk
        add(this.head, new THREE.SphereGeometry(0.125, 12, 8), m.bone, 0, -0.01, 0.025, 0.95, 1.0, 0.9);
        for (const sx of [-1, 1]) add(this.head, new THREE.SphereGeometry(0.025, 8, 6), m.eye, sx * 0.045, 0.01, 0.125);
        for (let i = 0; i < 5; i++) addR(this.head, new THREE.ConeGeometry(0.025, 0.12, 4), m.cloth2, 0, 0.12, -0.08 + i * 0.045, -0.3 + i * 0.15);
      } else if (hv < 0.75) { // hood + glowing goggles + scarf
        add(this.head, new THREE.ConeGeometry(0.17, 0.34, 8), m.cloth, 0, 0.08, -0.03, 1, 1, 1, -0.25);
        add(this.head, new THREE.CylinderGeometry(0.13, 0.15, 0.1, 8), m.cloth2, 0, -0.08, 0.0);
        for (const sx of [-1, 1]) addR(this.head, new THREE.CylinderGeometry(0.032, 0.032, 0.03, 8), m.eye, sx * 0.045, 0.02, 0.11, Math.PI / 2);
      } else { // gas mask + helmet
        add(this.head, new THREE.SphereGeometry(0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), m.rust, 0, 0.02, 0, 1, 0.9, 1.05);
        add(this.head, RB(0.16, 0.12, 0.08, 0.03), m.rubber, 0, -0.03, 0.09);
        for (const sx of [-1, 1]) { addR(this.head, new THREE.CylinderGeometry(0.03, 0.03, 0.02, 8), m.eye, sx * 0.045, 0.02, 0.125, Math.PI / 2); addR(this.head, new THREE.CylinderGeometry(0.035, 0.035, 0.06, 8), m.vest, sx * 0.07, -0.09, 0.1, 1.2, 0, sx * 0.4); }
      }
    } else if (mutant) {
      add(this.head, new THREE.SphereGeometry(0.11, 12, 8), m.skin, 0, 0, 0, 0.9, 1.0, 1.15);
      for (const sx of [-1, 1]) add(this.head, new THREE.SphereGeometry(0.024, 8, 6), m.eye, sx * 0.045, 0.02, 0.11);
      add(this.head, new THREE.BoxGeometry(0.13, 0.05, 0.12), m.skin, 0, -0.08, 0.06, 1, 1, 1, 0.3); // slack jaw
      for (let i = 0; i < 4; i++) addR(this.head, new THREE.ConeGeometry(0.008, 0.035, 3), m.bone, -0.04 + i * 0.027, -0.06, 0.12, Math.PI);
      add(this.head, new THREE.SphereGeometry(0.06, 8, 6), m.accent, 0.06, 0.08, -0.04);
    } else {
      add(this.head, new THREE.SphereGeometry(0.12, 12, 8), m.skin, 0, 0, 0, 1.1, 1, 1.05);
      add(this.head, RB(0.27, 0.24, 0.27, 0.05), m.plate, 0, 0.02, 0); // welded helmet
      add(this.head, new THREE.BoxGeometry(0.22, 0.04, 0.02), m.eye, 0, 0.03, 0.137); // visor slit
      for (const sx of [-1, 1]) add(this.chest, new THREE.BoxGeometry(0.04, 0.3, 0.012), m.accent, sx * 0.2, 0.04, 0.235); // furnace vents
      add(this.head, new THREE.BoxGeometry(0.04, 0.12, 0.3), m.rust, 0, 0.16, 0); // crest
    }
    // arms
    const armR = P.armR, foreR = armR * (brute ? 1.15 : 0.92), bare = kind === 'raider' && rnd() < 0.5, armMat = beast || bare ? m.skin : m.cloth;
    this.arms = [-1, 1].map((sx) => {
      const sh = G(this.chest, sx * P.shoulderX * (brute ? 1.1 : 1), brute ? 0.2 : 0.17, 0);
      add(sh, capsule(armR, P.upper - armR * 1.6), armMat, 0, -P.upper / 2, 0);
      const el = G(sh, 0, -P.upper, 0);
      add(el, capsule(foreR, P.fore - foreR * 1.8), brute ? m.plate : armMat, 0, -P.fore / 2, 0, brute ? 1.15 : 1, 1, brute ? 1.15 : 1);
      add(el, new THREE.SphereGeometry(armR * 1.05, 8, 6), armMat); // elbow
      if (bare) for (let i = 0; i < 2; i++) addR(el, new THREE.CylinderGeometry(foreR * 1.18, foreR * 1.18, 0.035, 7), m.cloth2, 0, -P.fore * (0.3 + i * 0.25), 0, 0.2, 0, 0.3 - i * 0.5); // wraps
      if (kind === 'player' || kind === 'raider') addR(sh, RB(armR * 2.6, 0.12, armR * 2.6, 0.03), kind === 'player' ? m.plate : m.rust, 0, -P.upper * 0.45, 0); // upper-arm guard
      if (!beast) add(el, new THREE.CylinderGeometry(foreR * 1.15, foreR * 1.2, 0.08, 8), m.gloves, 0, -P.fore + 0.07, 0);
      if (kind === 'raider' && rnd() < 0.5) add(el, new THREE.CylinderGeometry(foreR * 1.25, foreR * 1.3, 0.05, 8), m.cloth2, 0, -P.fore * 0.45, 0);
      const hand = add(el, RB(mutant ? 0.09 : brute ? 0.16 : 0.075, mutant ? 0.16 : brute ? 0.16 : 0.1, brute ? 0.1 : 0.05, 0.02, 1), m.gloves, 0, -P.fore - 0.03, 0);
      if (mutant) for (let i = 0; i < 3; i++) addR(el, new THREE.ConeGeometry(0.014, 0.12, 4), m.bone, -0.03 + i * 0.03, -P.fore - 0.16, 0.02, Math.PI);
      return { sh, el, hand, sx };
    });
    if (brute) { // rebar maul: pipe + concrete block, in the right hand
      const w = this.maul = G(this.arms[1].el, 0, -P.fore - 0.05, 0);
      addR(w, new THREE.CylinderGeometry(0.03, 0.03, 1.1, 6), m.rust, 0, 0, 0.35, Math.PI / 2);
      add(w, RB(0.3, 0.26, 0.3, 0.03), m.bone, 0, 0, 0.9);
      for (let i = 0; i < 3; i++) addR(w, new THREE.CylinderGeometry(0.012, 0.012, 0.4, 4), m.rust, -0.08 + i * 0.08, 0.1, 0.9, 0.3 * i, 0, 0.5);
      this.mats.bone.color.setHex(0x8a8680); // concrete block grey
    }
    // legs
    const legL = brute ? 0.44 : 0.44;
    this.legs = [-1, 1].map((sx) => {
      const hp = G(this.hips, sx * (brute ? 0.14 : 0.1), -0.06, 0);
      add(hp, capsule(brute ? 0.11 : mutant ? 0.065 : 0.092, 0.26), m.pants, 0, -0.21, 0, 1.05, 1, 1);
      add(hp, new THREE.SphereGeometry(brute ? 0.1 : mutant ? 0.06 : 0.08, 8, 6), m.pants, 0, -0.42, 0); // knee joint
      const kn = G(hp, 0, -legL, 0);
      if (!beast) add(kn, RB(0.11, 0.1, 0.06, 0.02, 1), kind === 'player' ? m.plate : m.rust, 0, 0, 0.065);
      if (brute) add(kn, RB(0.16, 0.3, 0.16, 0.04), m.plate, 0, -0.16, 0.02);
      add(kn, capsule(brute ? 0.09 : mutant ? 0.05 : 0.072, 0.28), mutant ? m.skin : m.pants, 0, -0.2, 0);
      if (!beast) add(kn, new THREE.CylinderGeometry(0.075, 0.085, 0.16, 8), m.boots, 0, -0.36, 0.0); // boot shaft
      const ft = G(kn, 0, -legL, 0);
      add(ft, RB(brute ? 0.16 : 0.11, 0.09, brute ? 0.3 : 0.25, 0.03, 1), mutant ? m.skin : m.boots, 0, 0.0, 0.04);
      if (mutant) for (let i = 0; i < 3; i++) addR(ft, new THREE.ConeGeometry(0.012, 0.06, 3), m.bone, -0.03 + i * 0.03, -0.02, 0.18, Math.PI / 2);
      return { hp, kn, ft, sx };
    });
    this.weaponMount = G(this.chest, 0.08, 0.02, 0.32);
    this.weapon = null;
    root.scale.setScalar(K.scale);
    this.flashC = { player: [1.2, 0.3, 0.2], raider: [1.5, 0.9, 0.55], mutant: [0.9, 1.2, 0.35], brute: [1.6, 0.95, 0.4] }[kind];
    this.phase = Math.random() * 6; this.legYaw = 0; this.flash = 0; this.flinch = new V(); this.flinchV = new V(); this.recoil = 0;
    this.deathT = -1; this.deathDir = 1; this.dissolve = 0; this.dissolveAt = 11;
    this.attackT = -1; this.crouch = 0; this.crouchB = 0; this.capeSwing = 0; this.lean = { x: 0, z: 0 }; this.lastFace = 0; this.turnRate = 0;
    this.pump = 0; this.stepCb = null; this.lastStep = 0;
    this.bake(fab);
  }

  // Bake the whole rig into ONE vertex-coloured SkinnedMesh (each Group is a rigid bone, glow parts carry a
  // per-vertex emissive attribute) -> 1 draw call (+1 shadow) per character, so hordes stay cheap.
  bake(fab) {
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.15, normalMap: fab.normalMap });
    this.bodyMat.normalScale.set(0.6, 0.6);
    // fresnel rim light keeps characters readable against the dark ground (The Ascent-style); hits add a
    // short tinted rim flash; corpses burn away with a noise dissolve.
    this.rim = { value: new THREE.Color(...this.K.rim) };
    this.uFlash = { value: new THREE.Color(0, 0, 0) };
    this.uDissolve = { value: 0 };
    this.bodyMat.onBeforeCompile = (sh) => {
      sh.uniforms.uRim = this.rim; sh.uniforms.uDissolve = this.uDissolve; sh.uniforms.uFlash = this.uFlash;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vDPos; attribute vec3 aEmis; varying vec3 vEmis;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDPos = position; vEmis = aEmis;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform vec3 uRim; uniform vec3 uFlash; uniform float uDissolve; varying vec3 vDPos; varying vec3 vEmis;
float dh(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float dn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dh(i), dh(i + vec3(1,0,0)), f.x), mix(dh(i + vec3(0,1,0)), dh(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(dh(i + vec3(0,0,1)), dh(i + vec3(1,0,1)), f.x), mix(dh(i + vec3(0,1,1)), dh(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
float dsv = 1.0; if (uDissolve > 0.0) { dsv = dn(vDPos * 18.0) * 0.6 + dn(vDPos * 47.0) * 0.4; if (dsv < uDissolve) discard; }`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmis;')
        .replace('#include <opaque_fragment>', `float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.8);
outgoingLight += uRim * fres + uFlash * (fres * 1.6 + 0.08);
if (uDissolve > 0.0) { float e = 1.0 - smoothstep(0.0, 0.07, dsv - uDissolve); outgoingLight = mix(outgoingLight * (1.0 - uDissolve * 0.6), vec3(6.0, 1.6, 0.25), e); }
#include <opaque_fragment>`);
    };
    this.bodyMat.customProgramCacheKey = () => 'rim-dissolve-skin';
    this.root.updateMatrixWorld(true);
    const invRoot = this.root.matrixWorld.clone().invert();
    const bones = []; this.root.traverse((o) => { if (o.isGroup) bones.push(o); });
    const glow = new Map([[this.mats.accent, this.mats.accent.emissive.clone().multiplyScalar(this.mats.accent.emissiveIntensity)], [this.mats.eye, this.mats.eye.emissive.clone().multiplyScalar(this.mats.eye.emissiveIntensity)]]);
    const parts = [], M = new THREE.Matrix4();
    bones.forEach((g, bi) => {
      for (const me of g.children.filter((c) => c.isMesh)) {
        me.updateMatrix();
        g.remove(me);
        if (Math.abs(me.matrix.determinant()) < 1e-12) { me.geometry.dispose(); continue; } // degenerate scale -> NaN normals
        M.multiplyMatrices(invRoot, g.matrixWorld).multiply(me.matrix); // part -> root (bind) space
        let geo = me.geometry.clone().applyMatrix4(M);
        me.geometry.dispose();
        if (geo.index) geo = geo.toNonIndexed();
        for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
        if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
        const n = geo.attributes.position.count, ca = new Float32Array(n * 3), ea = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
        const em = glow.get(me.material), c = em ? new THREE.Color(0, 0, 0) : me.material.color;
        for (let i = 0; i < n; i++) {
          ca[i * 3] = c.r; ca[i * 3 + 1] = c.g; ca[i * 3 + 2] = c.b;
          if (em) { ea[i * 3] = em.r; ea[i * 3 + 1] = em.g; ea[i * 3 + 2] = em.b; }
          si[i * 4] = bi; sw[i * 4] = 1;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(ca, 3));
        geo.setAttribute('aEmis', new THREE.BufferAttribute(ea, 3));
        geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
        geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
        parts.push(geo);
      }
    });
    const merged = mergeGeometries(parts, false); for (const p of parts) p.dispose();
    const mesh = this.skin = new THREE.SkinnedMesh(merged, this.bodyMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.root.add(mesh); mesh.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(bones), mesh.matrixWorld);
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2.2); // cheap culling bound (animated)
    if (this.kind === 'player') this.addSilhouette(merged, mesh.skeleton);
    for (const k of Object.keys(this.mats)) this.mats[k].dispose();
    this.allMats = [this.bodyMat];
  }

  // Hero-only readability: an inverted-hull outline drawn after the VFX so it stays visible through sparks/smoke.
  addSilhouette(geo, skeleton) {
    const hull = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.86, 0.6), side: THREE.BackSide, transparent: true, opacity: 0.45, depthWrite: false, fog: false });
    hull.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace('#include <skinning_vertex>', '#include <skinning_vertex>\ntransformed += normalize(objectNormal) * 0.035;'); };
    hull.customProgramCacheKey = () => 'hero-hull';
    for (const [mat, order] of [[hull, 9]]) { // (an x-ray fill self-occludes without a stencil buffer; walls are cut out instead)
      const m = new THREE.SkinnedMesh(geo, mat); m.bind(skeleton, this.skin.bindMatrix); m.renderOrder = order; m.frustumCulled = false;
      this.root.add(m); (this.silhouette = this.silhouette || []).push(m);
    }
  }

  setWeapon(model) {
    if (this.weapon) this.weaponMount.remove(this.weapon);
    this.weapon = model;
    if (model) { this.weaponMount.add(model); model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.userData.shared = true; } }); }
  }

  hit(dirX, dirZ, strength = 1) {
    this.flash = 1;
    // spring impulse: torso snaps away from the shot
    this.flinchV.x += dirX * 4.5 * strength; this.flinchV.z += dirZ * 4.5 * strength;
  }
  // opts: { push, gib, headshot, kind }
  die(dirX, dirZ, opts = {}) {
    this.deathT = 0; this.flash = 0.6;
    const l = Math.hypot(dirX, dirZ) || 1; dirX /= l; dirZ /= l;
    this.deathHit = { x: dirX, z: dirZ };
    const push = opts.push ?? 2.5;
    this.corpseVel = { x: dirX * push, z: dirZ * push };
    // turn to face the shooter so "blown back" falls along the shot
    const r = Math.random();
    this.deathMode = opts.gib ? 'gib' : this.kind === 'brute' ? 'knees' : this.kind === 'mutant' && r < 0.45 ? 'crumple' : r < 0.25 ? 'spin' : 'back';
    this.deathYaw0 = this.root.rotation.y;
    let target = Math.atan2(-dirX, -dirZ);
    if (this.deathMode === 'crumple') target = this.deathYaw0; // keep momentum forward
    let d = target - this.deathYaw0; d = Math.atan2(Math.sin(d), Math.cos(d));
    this.deathYaw1 = this.deathYaw0 + d;
    this.deathSide = (Math.random() - 0.5) * 2;
    this.deathArms = [Math.random(), Math.random()];
    if (opts.gib) this.root.visible = false;
    if (opts.headshot) { this.headless = 1.2; this.head.scale.setScalar(0.001); }
    this.deathPose = { sp: this.spine.rotation.x, hy: this.hips.position.y };
  }
  bodyAnchor() { this.hips.updateWorldMatrix(true, false); return _v4.setFromMatrixPosition(this.hips.matrixWorld); }
  neckWorld() { this.neck.updateWorldMatrix(true, false); return new V().setFromMatrixPosition(this.neck.matrixWorld); }

  solveArm(arm, target, pole) {
    const a = this.upperLen, b = this.foreLen;
    const S = arm.sh.position;
    const D = _v1.subVectors(target, S);
    const dist = clamp(D.length(), 0.05, a + b - 0.001);
    D.normalize();
    const cosA = clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    const p = _v2.copy(pole).addScaledVector(D, -pole.dot(D));
    if (p.lengthSq() < 1e-8) p.set(0, 0, 1); p.normalize();
    const E = _v3.copy(S).addScaledVector(D, a * cosA).addScaledVector(p, a * sinA);
    const T2 = new V().copy(S).addScaledVector(D, dist);
    arm.sh.quaternion.setFromUnitVectors(UP_NEG, new V().subVectors(E, S).normalize());
    _q.copy(arm.sh.quaternion).invert();
    arm.el.quaternion.setFromUnitVectors(UP_NEG, T2.sub(E).normalize().applyQuaternion(_q));
  }

  // s: { speed, moveX, moveZ (world move dir), rolling, rollP (0..1), reloading, reloadP, pump, crouch, sprint }
  update(dt, s) {
    this.flash = Math.max(0, this.flash - dt * 14);
    const fl = this.flash * this.flash;
    this.uFlash.value.setRGB(fl * this.flashC[0], fl * this.flashC[1], fl * this.flashC[2]); // tinted rim flash
    // damped spring flinch (overshoots a little = reads as impact)
    this.flinchV.addScaledVector(this.flinch, -160 * dt).multiplyScalar(Math.exp(-14 * dt));
    this.flinch.addScaledVector(this.flinchV, dt);
    this.recoil = Math.max(0, this.recoil - dt * 7);
    this.pump = s.pump || 0;

    if (this.deathT >= 0) { this.updateDeath(dt); return; }

    const face = this.root.rotation.y;
    let dYaw = face - this.lastFace; dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw)); this.lastFace = face;
    this.turnRate = damp(this.turnRate, dt > 0 ? dYaw / dt : 0, 8, dt);
    const speed = s.speed || 0;
    const mutant = this.kind === 'mutant', brute = this.kind === 'brute', beast = mutant || brute;
    // movement relative to facing
    let rel = 0;
    if (speed > 0.1) rel = Math.atan2(s.moveX, s.moveZ) - face;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    let dirSign = 1, legYaw = rel;
    if (Math.abs(rel) > Math.PI * 0.6) { dirSign = -1; legYaw = Math.atan2(Math.sin(rel + Math.PI), Math.cos(rel + Math.PI)); }
    legYaw = clamp(legYaw, -1.0, 1.0);
    this.legYaw = damp(this.legYaw, speed > 0.1 ? legYaw : 0, 10, dt);
    const stride = brute ? 3.4 : mutant ? 4.4 : 4.9;
    this.phase += dt * speed * stride * 0.55 * dirSign / Math.max(0.6, this.K.scale * 0.85);
    const run = clamp(speed / 5, 0, 1.3);
    const amp = run * 0.72;
    const ph = this.phase;
    // footstep callback (dust, sound) on each foot plant
    const stepIdx = Math.floor(ph / Math.PI);
    if (stepIdx !== this.lastStep) { this.lastStep = stepIdx; if (speed > 1 && this.stepCb) this.stepCb(stepIdx & 1); }
    // lean into the move direction (local), and into turns
    const lf = Math.cos(rel) * run * (beast ? 0.22 : 0.16), ls = Math.sin(rel) * run * 0.1;
    this.lean.x = damp(this.lean.x, lf, 6, dt); this.lean.z = damp(this.lean.z, ls - clamp(this.turnRate * 0.02, -0.15, 0.15), 6, dt);
    const fL = this.flinchLocal(face);
    this.crouchB = damp(this.crouchB, s.crouch || this.crouch ? 1 : 0, 10, dt);
    const cr = this.crouchB;
    this.hips.rotation.y = this.legYaw + Math.sin(ph) * 0.08 * amp;
    this.spine.rotation.y = -this.legYaw * 0.85 - Math.sin(ph) * 0.1 * amp;
    const bob = Math.abs(Math.cos(ph)) * (brute ? 0.07 : 0.06) * amp;
    this.hips.position.y = this.P.hipY + bob - amp * 0.05 - cr * 0.32 - (beast ? amp * 0.04 : 0);
    this.hips.position.x = Math.sin(ph) * 0.025 * amp;
    this.spine.rotation.x = this.P.hunch + this.lean.x + this.recoil * -0.12 + fL.z * 1.0 + cr * 0.25 + (mutant ? Math.sin(ph * 2) * 0.06 * amp : 0);
    this.spine.rotation.z = Math.sin(ph) * 0.05 * amp + this.lean.z + fL.x;
    this.chest.rotation.x = fL.z * 0.6; this.chest.rotation.z = fL.x * 0.6;
    for (const L of this.legs) {
      const p = ph + (L.sx > 0 ? 0 : Math.PI);
      const swing = Math.sin(p);
      L.hp.rotation.x = -swing * amp * (brute ? 0.8 : 1) - (mutant ? 0.35 : 0) - cr * 1.0;
      // knee folds while the leg swings forward (cos>0), stays nearly straight in stance
      L.kn.rotation.x = Math.max(0, Math.cos(p)) * amp * 1.5 + 0.06 + (mutant ? 0.7 : 0) + cr * 1.7;
      L.ft.rotation.x = -L.hp.rotation.x * 0.3 - L.kn.rotation.x * 0.45 + cr * 0.2;
      L.hp.rotation.z = L.sx * (brute ? 0.12 : 0.03);
    }
    // roll: tucked somersault pivoting around the body centre
    if (s.rolling) {
      // anticipation (dip + lean) -> tucked somersault around the body centre -> recovery crouch
      const p = clamp(s.rollP, 0, 1), A = 0.14, R = 0.78;
      const rp = clamp((p - A) / (R - A), 0, 1), e = rp < 0.5 ? 2 * rp * rp : 1 - Math.pow(-2 * rp + 2, 2) / 2;
      const th = e * Math.PI * 2, C = 0.72;
      const ant = p < A ? p / A : Math.max(0, 1 - (p - A) / 0.12), rec = p > R ? 1 - (p - R) / (1 - R) : 0;
      const tuck = Math.min(1, Math.sin(rp * Math.PI) * 1.6);
      this.body.rotation.x = th + ant * 0.35;
      const Cw = C - tuck * 0.12 - ant * 0.1 - rec * 0.15;
      this.body.position.set(0, Cw - C * Math.cos(th), -C * Math.sin(th));
      const crouch = Math.max(tuck, ant * 0.6, rec * 0.8);
      this.hips.position.y = this.P.hipY - crouch * 0.3;
      for (const L of this.legs) { L.hp.rotation.x = -1.6 * crouch - 0.2 * (1 - rec); L.kn.rotation.x = 2.3 * crouch + 0.1; L.ft.rotation.x = crouch * 0.4; }
      this.spine.rotation.x = 0.2 + crouch * 0.9;
      this.head.rotation.x = crouch * 0.6;
    } else {
      this.body.rotation.x = damp(this.body.rotation.x % (Math.PI * 2), 0, 20, dt);
      this.body.position.y = damp(this.body.position.y, 0, 20, dt);
      this.body.position.z = damp(this.body.position.z, 0, 20, dt);
    }
    if (this.cape) { // cloth lags behind motion
      this.capeSwing = damp(this.capeSwing, run * 0.7 + Math.sin(ph * 2) * 0.06 * amp, 4, dt);
      this.cape.rotation.x = (-this.capeSwing - fL.z * 0.6) * (this.kind === 'player' ? 0.5 : 1) - this.P.hunch * 0.5; this.cape.rotation.z = -this.lean.z * 1.5 + Math.sin(ph) * 0.05;
    }

    // arms
    if (this.weapon && !beast) {
      const wm = this.weaponMount;
      const rk = this.recoil, low = s.reloading ? 1 : 0, rp = s.reloadP || 0;
      const sway = Math.sin(ph * 2) * 0.012 * amp;
      wm.position.set(0.08 + Math.sin(ph) * 0.01 * amp, 0.02 - low * 0.12 + sway - cr * 0.02, 0.32 - rk * 0.11 - low * 0.05);
      wm.rotation.set(-rk * 0.32 + low * (0.5 + Math.sin(rp * Math.PI) * 0.25), low * -0.3, low * 0.4 + this.flinch.length() * 0.3);
      const grip = new V(0, -0.05, -0.02).applyEuler(wm.rotation).add(wm.position);
      const fore = new V(0, -0.02, (this.weapon.userData.foregrip || 0.26) - this.pump * 0.12).applyEuler(wm.rotation).add(wm.position);
      if (s.reloading) { // grab a fresh mag from the vest, slam it in
        const t = rp, mag = new V(-0.08, -0.18, 0.14), well = new V(0.0, -0.1, 0.16).applyEuler(wm.rotation).add(wm.position);
        const k = t < 0.35 ? t / 0.35 : t < 0.7 ? 1 - (t - 0.35) / 0.35 : 0;
        fore.lerpVectors(well, mag, k);
      }
      this.solveArm(this.arms[1], grip, new V(1, -0.6, -0.4));
      this.solveArm(this.arms[0], fore, new V(-1, -0.8, -0.2));
    } else {
      // free arms (mutants / brute): swing + attack
      for (const A of this.arms) {
        const p = ph + (A.sx > 0 ? Math.PI : 0);
        let rx = Math.sin(p) * amp * (mutant ? 1.1 : 0.7) - (mutant ? 0.35 + run * 0.5 : brute ? 0.15 : 0.1), rz = A.sx * (mutant ? -0.25 : brute ? -0.35 : -0.12);
        let elx = -0.5 - (mutant ? 0.4 * run : 0) - (brute ? 0.3 : 0);
        if (brute && A.sx > 0 && this.attackT < 0) { rx = -0.35 + Math.sin(p) * amp * 0.3; elx = -1.0; } // maul carried low/forward
        if (this.attackT >= 0) {
          const t = this.attackT; // 0..1
          if (brute) { // two-handed overhead slam
            const up = clamp(t / 0.5, 0, 1), ue = Math.sin(up * Math.PI / 2);
            if (t < 0.5) rx = -3.0 * ue;
            else if (t < 0.62) rx = -3.0 + ((t - 0.5) / 0.12) * 2.1;
            else rx = -0.9 + (t - 0.62) * 1.5;
            elx = t < 0.5 ? -0.6 - ue * 0.6 : -0.3; rz = A.sx * -0.15;
          } else {
            const lead = A.sx > 0 ? 0 : 0.12; const tt = clamp(t - lead, 0, 1);
            rx = tt < 0.4 ? -2.6 * (tt / 0.4) : -2.6 + (tt - 0.4) / 0.25 * 3.4; if (tt > 0.65) rx = 0.8 - (tt - 0.65) * 2;
            rz = A.sx * (tt < 0.4 ? -0.6 : 0.2); elx = tt < 0.4 ? -1.4 : -0.3;
          }
        }
        A.sh.rotation.set(rx, 0, rz); A.sh.quaternion.setFromEuler(A.sh.rotation);
        A.el.rotation.set(elx, 0, 0); A.el.quaternion.setFromEuler(A.el.rotation);
      }
      if (this.attackT >= 0 && brute) { const t = this.attackT; this.spine.rotation.x += t < 0.5 ? -0.35 * (t / 0.5) : t < 0.65 ? 0.6 : 0.6 - (t - 0.65) * 1.5; }
      else if (this.attackT >= 0) { const t = this.attackT; this.spine.rotation.x += t < 0.4 ? -0.25 : 0.4; }
    }
    this.head.rotation.x = (mutant ? -0.75 : brute ? -0.3 : -0.05) - this.lean.x * 0.6 + fL.z * -1.2;
    this.head.rotation.z = fL.x * -1.2;
  }
  flinchLocal(face) { // world flinch -> local x/z rotation offsets
    const c = Math.cos(face), s = Math.sin(face);
    const lx = this.flinch.x * c - this.flinch.z * s, lz = this.flinch.x * s + this.flinch.z * c;
    return { x: -lx * 0.5, z: lz * 0.5 };
  }
  updateDeath(dt) {
    this.deathT += dt;
    const T0 = this.deathT, mode = this.deathMode;
    this.uDissolve.value = T0 > this.dissolveAt && this.kind !== 'player' ? Math.min(1.05, (T0 - this.dissolveAt) / 2.4) : 0;
    this.dissolve = this.uDissolve.value;
    if (mode === 'gib') return;
    // yaw toward the fall direction (fast), plus spin variant
    const ty = clamp(T0 / 0.12, 0, 1);
    this.root.rotation.y = this.deathYaw0 + (this.deathYaw1 - this.deathYaw0) * ty + (mode === 'spin' ? (1 - Math.exp(-T0 * 5)) * 2.2 * Math.sign(this.deathSide || 1) : 0);
    const A = this.arms, L = this.legs;
    const setArm = (a, rx, rz, el) => { a.sh.rotation.set(rx, 0, rz); a.sh.quaternion.setFromEuler(a.sh.rotation); a.el.rotation.set(el, 0, 0); a.el.quaternion.setFromEuler(a.el.rotation); };
    if (this.weapon && T0 > 0.05) this.weapon.visible = false; // dropped (loot handles the real drop)
    if (mode === 'knees' || mode === 'crumple') {
      // legs give out: drop to knees, then topple forward face-down with a thud bounce
      const k = clamp(T0 / (mode === 'knees' ? 0.45 : 0.25), 0, 1), ke = k * k * (3 - 2 * k);
      const f = clamp((T0 - (mode === 'knees' ? 0.55 : 0.2)) / 0.4, 0, 1), fe = f * f;
      const bounce = f >= 1 ? Math.exp(-(T0 - (mode === 'knees' ? 0.95 : 0.6)) * 10) * Math.sin((T0 - 0.6) * 30) * 0.06 : 0;
      this.hips.position.y = this.P.hipY - ke * 0.45 - fe * 0.3;
      for (const l of L) { l.hp.rotation.x = -ke * 0.3 + fe * 0.9; l.kn.rotation.x = ke * 1.7 - fe * 1.2; l.ft.rotation.x = ke * 0.4; }
      this.body.rotation.x = fe * 1.35 + bounce;
      this.body.position.y = 0;
      this.spine.rotation.x = this.P.hunch * (1 - fe) + ke * 0.3 + fe * 0.1;
      this.head.rotation.x = fe * -0.4 + 0.3 * ke; this.head.rotation.z = this.deathSide * 0.5 * fe;
      setArm(A[0], -0.4 - ke * 0.5 - fe * 1.6, 0.3 + fe * 0.3, -0.3); setArm(A[1], -0.4 - ke * 0.4 - fe * 1.4, -0.3 - fe * 0.4, -0.4);
    } else {
      // blown back: torso whips back, arms fling, then fall flat on the back with a small bounce
      const whip = Math.min(1, T0 / 0.09);
      const f = clamp((T0 - 0.04) / 0.42, 0, 1), fe = f * f * (2.2 - 1.2 * f);
      const land = T0 - 0.46, bounce = land > 0 ? Math.exp(-land * 9) * Math.abs(Math.sin(land * 22)) * 0.12 : 0;
      const ang = Math.min(1, fe) * (Math.PI / 2 - 0.08) - bounce;
      this.body.rotation.x = -ang;
      this.body.rotation.z = this.deathSide * 0.25 * fe;
      this.body.position.y = 0.1 * fe + bounce * 0.4;
      this.hips.position.y = this.P.hipY - Math.sin(f * Math.PI) * 0.15;
      this.spine.rotation.x = -0.45 * whip * (1 - f * 0.6) + this.P.hunch * (1 - f);
      this.head.rotation.x = -0.6 * whip * (1 - f) + 0.25 * f; this.head.rotation.z = this.deathSide * 0.6 * f;
      const a0 = this.deathArms[0], a1 = this.deathArms[1];
      setArm(A[0], -2.4 * whip * (1 - f) - (1.6 + a0 * 1.2) * f, 0.6 + f * (0.4 + a0 * 0.8), -0.4 * f - 0.3);
      setArm(A[1], -2.0 * whip * (1 - f) - (1.0 + a1 * 1.6) * f, -0.5 - f * (0.3 + a1 * 0.9), -0.6 * f - 0.2);
      for (const l of L) { l.hp.rotation.x = -0.5 * Math.sin(f * Math.PI) * (l.sx > 0 ? 1 : 0.4) - 0.1 * f; l.hp.rotation.z = l.sx * 0.2 * f; l.kn.rotation.x = 0.5 * Math.sin(f * Math.PI) + 0.25 * f * (l.sx > 0 ? 1 : 0.3); }
    }
    if (this.headless > 0) this.headless -= dt;
  }
  dispose() { if (this.silhouette) for (const m of this.silhouette) m.material.dispose(); this.root.traverse((o) => { if (o.isMesh && !o.userData.shared) o.geometry.dispose(); }); this.bodyMat.dispose(); if (this.skin) this.skin.skeleton.dispose(); }
}
