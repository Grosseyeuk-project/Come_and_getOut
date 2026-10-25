// Scene lighting: per-seed palette (time of day / weather), shadowed key light following the player,
// image-based ambient via a procedural env map, and a fixed-size pool of point lights that is
// assigned every frame to the nearest dynamic light sources (fires, lamps, flares) - so the shader
// light count never changes and there are no recompiles.
import * as THREE from 'three';
import { vnoise } from '../core/rng.js';

export const PALETTES = {
  dusk: { name: 'Burning Dusk', fog: 0x1f1c1c, fogD: 0.017, mist: [0.42, 0.36, 0.32], embers: 1.0, ash: 0, sun: 0xffbf94, sunI: 2.6, sunDir: [-0.55, 0.85, -0.4], hemiS: 0x46526a, hemiG: 0x1e1712, hemiI: 1.00, sky: [0x1a1514, 0x6a4030, 0xd08050], tint: [1.04, 0.97, 0.9], shadowTint: [0.84, 0.93, 1.12], exposure: 1.0, sat: 0.74, lampScale: 1 },
  night: { name: 'Dead Night', fog: 0x0c1118, fogD: 0.019, mist: [0.24, 0.3, 0.38], embers: 0.3, ash: 0, sun: 0x9fb4dc, sunI: 1.7, sunDir: [0.4, 0.9, -0.45], hemiS: 0x3c4e68, hemiG: 0x101014, hemiI: 1.3, sky: [0x05070a, 0x142030, 0x2a3a50], tint: [0.98, 0.98, 1.04], shadowTint: [0.8, 0.95, 1.2], exposure: 1.15, sat: 0.8, lampScale: 1.6 },
  toxic: { name: 'Toxic Smog', fog: 0x1b2117, fogD: 0.021, mist: [0.36, 0.42, 0.26], embers: 0.1, ash: 0, sun: 0xd8e090, sunI: 1.6, sunDir: [0.5, 0.85, 0.3], hemiS: 0x55603e, hemiG: 0x15160f, hemiI: 1.20, sky: [0x101208, 0x3a4220, 0x8a9050], tint: [1.0, 1.03, 0.88], shadowTint: [0.9, 1.0, 1.05], exposure: 1.0, sat: 0.75, lampScale: 1.2 },
  ash: { name: 'Ashfall', fog: 0x26282b, fogD: 0.017, mist: [0.45, 0.46, 0.48], embers: 0.2, ash: 1.2, sun: 0xe8ecf0, sunI: 1.8, sunDir: [-0.35, 0.9, 0.5], hemiS: 0x5a6068, hemiG: 0x1a1a1c, hemiI: 1.20, sky: [0x111214, 0x3a3e44, 0x8a9098], tint: [1.0, 0.99, 0.97], shadowTint: [0.88, 0.94, 1.08], exposure: 1.0, sat: 0.68, lampScale: 1.1 },
};

export class Lighting {
  constructor(scene, renderer, paletteKey, quality) {
    this.scene = scene; this.renderer = renderer;
    const p = this.p = PALETTES[paletteKey] || PALETTES.dusk;
    scene.fog = new THREE.FogExp2(p.fog, p.fogD);
    scene.background = new THREE.Color(p.fog);
    this.hemi = new THREE.HemisphereLight(p.hemiS, p.hemiG, p.hemiI);
    scene.add(this.hemi);
    const sun = this.sun = new THREE.DirectionalLight(p.sun, p.sunI);
    this.sunDir = new THREE.Vector3(...p.sunDir).normalize();
    sun.castShadow = true;
    const sm = quality === 'low' ? 1024 : 2048;
    sun.shadow.mapSize.set(sm, sm);
    const S = 34;
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 120 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
    scene.add(sun); scene.add(sun.target);
    this.makeEnv(p);

    this.sources = [];
    const POOL = quality === 'low' ? 6 : 12;
    this.pool = [];
    for (let i = 0; i < POOL; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false; scene.add(l); this.pool.push(l);
    }
    this.time = 0;
  }

  makeEnv(p) {
    const pm = new THREE.PMREMGenerator(this.renderer);
    const s = new THREE.Scene();
    const geo = new THREE.SphereGeometry(10, 32, 16);
    const c0 = new THREE.Color(p.sky[0]), c1 = new THREE.Color(p.sky[1]), c2 = new THREE.Color(p.sky[2]);
    const col = [];
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 10; const c = new THREE.Color();
      if (y < 0) c.copy(c0).lerp(c1, y + 1); else c.copy(c1).lerp(c2, Math.pow(y, 0.6));
      col.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    s.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const sunCard = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(p.sun).multiplyScalar(4) }));
    sunCard.position.copy(new THREE.Vector3(...p.sunDir).normalize().multiplyScalar(8)); s.add(sunCard);
    const rt = pm.fromScene(s, 0.04);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.4;
    pm.dispose();
  }

  // kind: 'fire' | 'lamp' | 'steady' | 'strobe' | 'pulse'
  addSource(pos, color, intensity, range, kind = 'steady', extra = {}) {
    const s = { pos: pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z), color: new THREE.Color(color), intensity, range, kind, seed: Math.random() * 100, on: true, ...extra };
    this.sources.push(s); return s;
  }
  removeSource(s) { const i = this.sources.indexOf(s); if (i >= 0) this.sources.splice(i, 1); }

  flicker(s, t) {
    switch (s.kind) {
      case 'fire': return 0.75 + 0.35 * vnoise(t * 9 + s.seed, s.seed) + 0.15 * vnoise(t * 23, s.seed * 2);
      case 'lamp': { // broken sodium lamp: mostly on, occasional stutters
        const n = vnoise(t * 3 + s.seed, s.seed);
        if (n > 0.78) return vnoise(t * 40, s.seed) > 0.5 ? 1 : 0.08;
        return 1;
      }
      case 'strobe': return Math.sin(t * 6 + s.seed) > 0.4 ? 1 : 0.05;
      case 'pulse': return 0.7 + 0.3 * Math.sin(t * 3 + s.seed);
      default: return 1;
    }
  }

  update(dt, focus) {
    this.time += dt;
    const t = this.time;
    // key light follows focus, snapped to texel grid to avoid shimmering
    const sun = this.sun, d = this.sunDir;
    const texel = (sun.shadow.camera.right * 2) / sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    sun.target.position.set(fx, 0, fz);
    sun.position.set(fx + d.x * 60, d.y * 60, fz + d.z * 60);
    // assign pool to nearest sources (score by distance / range)
    for (const s of this.sources) {
      const dx = s.pos.x - focus.x, dz = s.pos.z - focus.z;
      s._score = s.on ? (dx * dx + dz * dz) / (s.range * s.range * (s.priority || 1)) : Infinity;
    }
    const sorted = this.sources.filter((s) => s.on && s._score < 40).sort((a, b) => a._score - b._score);
    for (let i = 0; i < this.pool.length; i++) {
      const l = this.pool[i], s = sorted[i];
      if (!s) { l.intensity = 0; continue; } // never toggle visibility: keeps light count constant (no shader recompiles)
      l.position.copy(s.pos);
      l.color.copy(s.color);
      l.distance = s.range;
      const f = this.flicker(s, t);
      s.level = f;
      // fade by distance to avoid popping when pool reassigns
      const fade = Math.min(1, Math.max(0, (40 - s._score) / 10));
      l.intensity = s.intensity * f * fade * (s.kind === 'lamp' ? this.p.lampScale : 1);
    }
  }
}
