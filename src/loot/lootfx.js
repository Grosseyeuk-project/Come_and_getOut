// Loot presentation textures + small self-contained effects: ground glow pools, rune rings,
// soft light shafts (camera-facing), rising motes and the legendary/epic drop "pop" (shockwave + sparks).
import * as THREE from 'three';

const cache = {};
const cv = (w, h = w) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const tex = (c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t; };

export function glowTex() {
  if (cache.glow) return cache.glow;
  const S = 256, c = cv(S), g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.12, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.16)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return (cache.glow = tex(c));
}
// crisp thin ring with notches + inner tick marks (reads as a "marker" decal on the ground)
export function runeRingTex() {
  if (cache.rune) return cache.rune;
  const S = 256, c = cv(S), g = c.getContext('2d'), m = S / 2;
  g.strokeStyle = '#fff'; g.lineWidth = 3;
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.18; g.beginPath(); g.arc(m, m, 112, a, a + Math.PI / 2 - 0.36); g.stroke(); }
  g.lineWidth = 1.5; g.globalAlpha = 0.6; g.beginPath(); g.arc(m, m, 98, 0, 7); g.stroke();
  g.globalAlpha = 1;
  for (let i = 0; i < 4; i++) { g.save(); g.translate(m, m); g.rotate(i * Math.PI / 2 + Math.PI / 4); g.beginPath(); g.moveTo(0, -122); g.lineTo(7, -110); g.lineTo(-7, -110); g.closePath(); g.fillStyle = '#fff'; g.fill(); g.restore(); }
  g.globalAlpha = 0.45; for (let i = 0; i < 48; i++) { g.save(); g.translate(m, m); g.rotate(i / 48 * Math.PI * 2); g.fillRect(-1, -96, 2, i % 4 ? 4 : 8); g.restore(); }
  return (cache.rune = tex(c));
}
export function shockTex() {
  if (cache.shock) return cache.shock;
  const S = 256, c = cv(S), g = c.getContext('2d'), m = S / 2;
  const gr = g.createRadialGradient(m, m, m * 0.6, m, m, m);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.75, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.85, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return (cache.shock = tex(c));
}
// soft light shaft: gaussian across, bright at the base and fading quickly with height, faint streaks
export function shaftTex() {
  if (cache.shaft) return cache.shaft;
  const W = 64, H = 256, c = cv(W, H), g = c.getContext('2d'), id = g.createImageData(W, H);
  const streak = []; for (let x = 0; x < W; x++) streak.push(0.75 + 0.25 * Math.sin(x * 0.9) * Math.sin(x * 0.37 + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x / (W - 1)) * 2 - 1, v = 1 - y / (H - 1); // v=0 bottom
    const across = Math.exp(-u * u * 9) * 0.85 + Math.exp(-u * u * 60) * 0.6;
    const up = Math.pow(1 - v, 2.2) * (v < 0.04 ? v / 0.04 : 1);
    const a = Math.min(1, across * up * streak[x]);
    const i = (y * W + x) * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = 255; id.data[i + 3] = a * 255;
  }
  g.putImageData(id, 0, 0);
  return (cache.shaft = tex(c));
}
export function moteTex() {
  if (cache.mote) return cache.mote;
  const S = 64, c = cv(S), g = c.getContext('2d'), m = S / 2;
  const gr = g.createRadialGradient(m, m, 0, m, m, m); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(m - 0.75, 4, 1.5, S - 8); g.fillRect(4, m - 0.75, S - 8, 1.5);
  return (cache.mote = tex(c));
}

const additive = (map, color, extra = {}) => new THREE.MeshBasicMaterial({ map, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: true, ...extra });

// One short-lived burst: expanding shockwave ring + spark points with gravity + vertical flash.
export class LootBursts {
  constructor(scene) {
    this.scene = scene; this.list = [];
    this.ringGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.flashGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  }
  spawn(x, y, z, hex, power = 1) {
    const col = new THREE.Color(hex);
    const ring = new THREE.Mesh(this.ringGeo, additive(shockTex(), col.clone().multiplyScalar(2.2)));
    ring.position.set(x, y + 0.05, z); ring.renderOrder = 7; this.scene.add(ring);
    const flash = new THREE.Mesh(this.flashGeo, additive(shaftTex(), col.clone().multiplyScalar(3), { side: THREE.DoubleSide }));
    flash.position.set(x, y, z); flash.renderOrder = 7; this.scene.add(flash);
    const N = Math.round(26 * power), pos = new Float32Array(N * 3), vel = [];
    for (let i = 0; i < N; i++) {
      pos.set([x, y + 0.3, z], i * 3);
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 4.5 * power;
      vel.push(Math.cos(a) * s, 3 + Math.random() * 6 * power, Math.sin(a) * s);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ map: moteTex(), color: col.clone().multiplyScalar(2.5), size: 0.32, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    pts.renderOrder = 8; pts.frustumCulled = false; this.scene.add(pts);
    this.list.push({ ring, flash, pts, vel, t: 0, power });
  }
  update(dt, cam) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i]; b.t += dt; const t = b.t;
      const k = 1 - Math.exp(-t * 6); b.ring.scale.setScalar(0.5 + k * 6 * b.power); b.ring.material.opacity = Math.max(0, 1 - t / 0.7);
      b.flash.scale.set(0.9 * b.power * (1 + t * 2), 9 * b.power * (1 - Math.exp(-t * 20)), 1); b.flash.material.opacity = Math.max(0, 1 - t / 0.45);
      if (cam) b.flash.rotation.y = Math.atan2(cam.position.x - b.flash.position.x, cam.position.z - b.flash.position.z);
      const p = b.pts.geometry.attributes.position;
      for (let j = 0; j < p.count; j++) {
        b.vel[j * 3 + 1] -= 14 * dt; b.vel[j * 3] *= 1 - dt * 1.5; b.vel[j * 3 + 2] *= 1 - dt * 1.5;
        let y = p.getY(j) + b.vel[j * 3 + 1] * dt; if (y < 0.05) { y = 0.05; b.vel[j * 3 + 1] *= -0.3; }
        p.setXYZ(j, p.getX(j) + b.vel[j * 3] * dt, y, p.getZ(j) + b.vel[j * 3 + 2] * dt);
      }
      p.needsUpdate = true; b.pts.material.opacity = Math.max(0, 1 - Math.max(0, t - 0.6) / 0.8);
      if (t > 1.4) { for (const o of [b.ring, b.flash, b.pts]) { this.scene.remove(o); o.material.dispose(); } b.pts.geometry.dispose(); this.list.splice(i, 1); }
    }
  }
  clear() { for (const b of this.list) for (const o of [b.ring, b.flash, b.pts]) this.scene.remove(o); this.list.length = 0; }
}
export { additive };
