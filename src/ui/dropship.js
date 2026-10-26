// Extraction sequence: procedural VTOL dropship that swoops in over the pad, hovers with a searchlight
// while the player is winched up, then climbs away. Self-contained (own meshes/materials), driven by the HUD.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { glowTex, shaftTex } from '../loot/lootfx.js';

const add = (map, color, extra = {}) => new THREE.MeshBasicMaterial({ map, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, ...extra });

export class Dropship {
  // away: unit (x,z) pointing from the camera into the scene; the ship hovers a little beyond the pad so it
  // never hides the player, and arrives / leaves along that axis.
  constructor(scene, x, z, away = { x: -0.7, z: -0.7 }) {
    this.scene = scene; this.ax = away.x; this.az = away.z; this.x = x; this.z = z; this.px = x; this.pz = z; this.t = 0;
    const g = this.g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0x8a8c82, roughness: 0.5, metalness: 0.45, emissive: 0x1a1c1a });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1e1f1f, roughness: 0.6, metalness: 0.5 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0xc89a2a, roughness: 0.6, metalness: 0.3 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0a1418, roughness: 0.1, metalness: 0.8, emissive: 0x40c8e0, emissiveIntensity: 1.6 });
    const box = (m, w, h, d, x, y, z, r = 0.12) => { const o = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), m); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };
    box(hull, 2.4, 1.7, 6.2, 0, 0, 0, 0.4);             // fuselage
    box(hull, 1.9, 1.2, 1.6, 0, -0.15, 3.6, 0.45);       // nose
    box(glass, 1.6, 0.55, 1.1, 0, 0.35, 3.85, 0.2);      // canopy
    box(dark, 2.0, 0.7, 2.6, 0, 0.75, -0.4, 0.25);       // spine / engine housing
    box(hull, 0.9, 1.5, 2.2, 0, 0.6, -3.6, 0.2).rotation.x = -0.35; // tail fin
    box(hull, 4.2, 0.18, 0.9, 0, 0.75, -3.6, 0.08);      // tail plane
    box(stripe, 2.42, 0.25, 0.6, 0, -0.2, 1.6, 0.08);    // hazard stripe
    box(dark, 1.8, 0.2, 3.2, 0, -0.9, -0.2, 0.08);       // open ramp bay
    this.pods = [];
    for (const s of [-1, 1]) {
      box(hull, 2.6, 0.22, 1.6, s * 2.3, 0.3, 0.2, 0.08); // stub wing
      const pod = new THREE.Group(); pod.position.set(s * 3.7, 0.3, 0.2); g.add(pod);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.85, 1.5, 18, 1, true), dark); c.castShadow = true; pod.add(c);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.12, 8, 24), hull); ring.rotation.x = Math.PI / 2; ring.position.y = 0.7; pod.add(ring);
      const jet = new THREE.Mesh(new THREE.CircleGeometry(0.7, 20).rotateX(Math.PI / 2), add(glowTex(), new THREE.Color(1.6, 1.0, 0.5))); jet.position.y = -0.76; pod.add(jet);
      const plume = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 3).translate(0, -1.5, 0), add(shaftTex(), new THREE.Color(1.2, 0.7, 0.35), { side: THREE.DoubleSide })); plume.rotation.x = Math.PI; plume.position.y = -0.7; pod.add(plume);
      plume.material.map = shaftTex(); this.pods.push({ pod, plume, jet, s });
      const nav = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: s < 0 ? new THREE.Color(4, 0.3, 0.2) : new THREE.Color(0.3, 4, 0.6) })); nav.position.set(s * 3.7, 1.05, 0.2); g.add(nav);
    }
    // running lights along the hull + ramp light
    const amber = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.2, 0.6) });
    for (let i = 0; i < 6; i++) for (const s of [-1, 1]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.3), amber); l.position.set(s * 1.22, 0.35, -2.4 + i * 0.9); g.add(l); }
    const ramp = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 3).rotateX(Math.PI / 2), add(glowTex(), new THREE.Color(2.2, 1.6, 0.9))); ramp.position.set(0, -1.02, -0.2); g.add(ramp);
    // searchlight cone + ground pool
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 3.2, 1, 24, 1, true).translate(0, -0.5, 0), add(shaftTex(), new THREE.Color(0.45, 0.5, 0.42), { side: THREE.DoubleSide, opacity: 0.0 }));
    this.beam.position.set(0, -0.8, 1.2); g.add(this.beam);
    this.pool = new THREE.Mesh(new THREE.PlaneGeometry(6, 6).rotateX(-Math.PI / 2), add(glowTex(), new THREE.Color(0.6, 0.65, 0.55), { opacity: 0 }));
    this.pool.position.set(x, 0.06, z); this.pool.renderOrder = 4; scene.add(this.pool);
    this.strobe = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 5, 5) })); this.strobe.position.set(0, -0.9, -2.8); g.add(this.strobe);
    this.cable = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1, 6).translate(0, -0.5, 0), new THREE.MeshBasicMaterial({ color: 0x111111 })); this.cable.position.set(0, -0.9, 0.2); g.add(this.cable);
    this.yaw = Math.atan2(-this.ax, -this.az) + 1.2; g.rotation.y = this.yaw; g.scale.setScalar(0.72);
    // hover to the screen-left of the player (summary panel is on the right), slightly beyond it
    this.x = x + this.az * 4.6 + this.ax * 1.2; this.z = z - this.ax * 4.6 + this.az * 1.2;
    scene.add(g);
    this.update(0);
  }
  // phase timeline: 0-3.2s approach + flare, 3.2-5.6 hover & winch, 5.6+ climb out
  update(dt, player) {
    this.t += dt; const t = this.t, x = this.x, z = this.z, g = this.g;
    const ease = (k) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
    const hoverY = 4.6, ax = this.ax, az = this.az;
    let px, py, pz, pitch = 0, roll = 0;
    if (t < 3.2) {
      const k = ease(t / 3.2), from = { x: x + ax * 46 - az * 14, y: 24, z: z + az * 46 + ax * 14 };
      px = from.x + (x - from.x) * k; pz = from.z + (z - from.z) * k; py = from.y + (hoverY - from.y) * k;
      pitch = -0.35 * (1 - k) + (k > 0.8 ? (k - 0.8) * 1.5 : 0); roll = 0.25 * (1 - k);
    } else if (t < 5.6) {
      px = x + Math.sin(t * 1.3) * 0.15; pz = z + Math.cos(t * 1.1) * 0.12; py = hoverY + Math.sin(t * 2.1) * 0.18; pitch = Math.sin(t * 1.7) * 0.03;
    } else {
      const k = (t - 5.6) / 3; px = x + (ax * 30 + az * 18) * k * k; pz = z + (az * 30 - ax * 18) * k * k; py = hoverY + k * k * 26; pitch = -0.25 * Math.min(1, k * 2);
    }
    g.position.set(px, py, pz); g.rotation.set(pitch, this.yaw + (t < 3.2 ? (1 - ease(t / 3.2)) * 0.5 : 0), roll);
    const hov = t > 2.6 && t < 6.2 ? 1 : 0;
    this.beam.material.opacity += ((hov ? 0.55 : 0) - this.beam.material.opacity) * Math.min(1, dt * 3);
    this.beam.scale.y = Math.max(0.1, (py - 0.6) / 0.72);
    this.pool.material.opacity = this.beam.material.opacity * 0.9;
    this.pool.position.set(this.px, 0.06, this.pz);
    for (const p of this.pods) { const f = 0.85 + Math.random() * 0.3; p.plume.scale.set(f, f * (1.2 + (t < 3.2 ? 0.8 : 0.3)), 1); p.pod.rotation.x = t < 3.2 ? -0.5 * (1 - ease(t / 3.2)) : 0; }
    this.strobe.visible = Math.floor(t * 2.2) % 2 === 0;
    // winch the player up during the hover
    const wk = Math.min(1, Math.max(0, (t - 3.6) / 1.6));
    this.cable.visible = false;
    if (player) {
      if (t > 3.6) { const e = wk * wk; player.root.position.set(this.px + (px - this.px) * e, e * (py - 1.6), this.pz + (pz - this.pz) * e); player.root.rotation.y += dt * 0.6; }
      if (t > 5.3) player.root.visible = false;
      if (player.ring) player.ring.visible = t < 3.6;
    }
    return t;
  }
  dispose() { this.scene.remove(this.g); this.scene.remove(this.pool); }
}
