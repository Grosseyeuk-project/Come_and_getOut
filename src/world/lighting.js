// Scene lighting: per-seed palette (time of day / weather), shadowed key light following the player,
// image-based ambient + wet reflections via a procedural "city glow" env map, and a fixed-size pool of point
// lights that is assigned every frame to the nearest dynamic light sources (fires, lamps, flares) - so the
// shader light count never changes and there are no recompiles. Sources outside the pool keep lighting the
// street through LightFx ground pools + puddle reflections. Colour design is complementary: cool teal
// ambient / rim / mercury lamps against warm sodium, fire and muzzle light (The Ascent / Diablo IV night).
import * as THREE from 'three';
import { vnoise } from '../core/rng.js';
import { atmo } from '../render/atmosphere.js';
import { LightFx, Rain } from './lightingFx.js';

const C3 = (h) => { const c = new THREE.Color(h); return { r: c.r, g: c.g, b: c.b }; };

// fields used elsewhere: name, fog, mist, embers, ash, tint, shadowTint, sat, exposure
export const PALETTES = {
  dusk: {
    name: 'Burning Dusk', fog: 0x1a1a20, fogD: 0.012, haze: 0x40343a, fogH: [0.15, 0.05], scatter: 0.0009, mist: [0.42, 0.36, 0.34], embers: 1.0, ash: 0,
    sun: 0xff9c60, sunI: 2.5, sunDir: [-0.6, 0.62, -0.45], hemiS: 0x3a6070, hemiG: 0x1c140f, hemiI: 0.85,
    sky: [0x0a0c10, 0x24303a, 0x8a5a48], glows: [[0xff7a30, 1.8, -0.6, 0.15, -0.45], [0x30d0ff, 1.1, 0.7, 0.45, 0.3], [0x30d0ff, 0.9, -0.7, 0.6, 0.9], [0xff4020, 0.8, 0.9, 0.25, -0.8]], envI: 0.55,
    lamps: [[0xff9440, 0.65], [0x7fe8ff, 0.35]], flood: 0xbfefff, wet: 0.35, puddle: 0.62, rain: 0, rim: 0x5cc8ff, rimI: 0.55,
    tint: [1.06, 0.98, 0.88], shadowTint: [0.82, 0.99, 1.12], exposure: 1.05, contrast: 1.18, sat: 0.92, warmSat: 0.3, lift: [0.006, 0.009, 0.012], lampScale: 1,
  },
  night: {
    name: 'Dead Night', fog: 0x0a1016, fogD: 0.012, haze: 0x1c3038, fogH: [0.14, 0.06], scatter: 0.0012, mist: [0.24, 0.32, 0.38], embers: 0.3, ash: 0,
    sun: 0x86b8f0, sunI: 1.35, sunDir: [0.42, 0.85, -0.5], hemiS: 0x2c5a6c, hemiG: 0x0c0e12, hemiI: 1.05,
    sky: [0x05070a, 0x102028, 0x1c3a48], glows: [[0x20e0ff, 2.2, -0.65, 0.5, -0.6], [0xff8a30, 1.6, -0.3, 0.3, -0.9], [0xff2a70, 1.2, -0.9, 0.55, 0.1], [0x30f0c0, 1.0, 0.6, 0.4, 0.6]], envI: 0.65,
    lamps: [[0xff8a30, 0.55], [0x70f0e0, 0.45]], flood: 0xa8f0ff, wet: 0.95, puddle: 0.5, rain: 1, rim: 0x48d8ff, rimI: 0.75,
    tint: [1.04, 0.99, 0.92], shadowTint: [0.78, 1.0, 1.16], exposure: 1.25, contrast: 1.16, sat: 0.98, warmSat: 0.35, lift: [0.004, 0.009, 0.012], lampScale: 1.4,
  },
  toxic: {
    name: 'Toxic Smog', fog: 0x121614, fogD: 0.013, haze: 0x2c3626, fogH: [0.13, 0.1], scatter: 0.001, mist: [0.34, 0.4, 0.28], embers: 0.1, ash: 0,
    sun: 0xf0d8a0, sunI: 1.15, sunDir: [0.5, 0.78, 0.35], hemiS: 0x2e5260, hemiG: 0x12110e, hemiI: 0.95,
    sky: [0x080a08, 0x1c2418, 0x5a6038], glows: [[0x90ff40, 1.4, -0.6, 0.4, -0.5], [0x20d0c0, 1.3, 0.5, 0.5, -0.7], [0xffa030, 1.2, -0.8, 0.25, 0.5]], envI: 0.55,
    lamps: [[0xffa040, 0.5], [0x60ffc0, 0.5]], flood: 0xd0ffd8, wet: 0.6, puddle: 0.56, rain: 0.35, rim: 0x60ffd0, rimI: 0.55,
    tint: [1.06, 1.0, 0.86], shadowTint: [0.8, 0.98, 1.12], exposure: 1.1, contrast: 1.18, sat: 0.8, warmSat: 0.3, lift: [0.006, 0.009, 0.009], lampScale: 1.15,
  },
  ash: {
    name: 'Ashfall', fog: 0x1e2024, fogD: 0.012, haze: 0x40444a, fogH: [0.12, 0.2], scatter: 0.0009, mist: [0.45, 0.46, 0.48], embers: 0.25, ash: 1.2,
    sun: 0xe6ecf4, sunI: 1.9, sunDir: [-0.35, 0.86, 0.5], hemiS: 0x4a5a6a, hemiG: 0x18181a, hemiI: 1.0,
    sky: [0x0c0d10, 0x2c3038, 0x7a8088], glows: [[0xff6a20, 1.5, -0.5, 0.2, -0.6], [0x80c8ff, 0.9, 0.6, 0.6, 0.4]], envI: 0.5,
    lamps: [[0xff9040, 0.7], [0xd8f0ff, 0.3]], flood: 0xe8f4ff, wet: 0.15, puddle: 0.7, rain: 0, rim: 0x9ad0ff, rimI: 0.5,
    tint: [1.05, 0.99, 0.92], shadowTint: [0.86, 0.96, 1.1], exposure: 1.05, contrast: 1.14, sat: 0.8, warmSat: 0.4, lift: [0.007, 0.008, 0.01], lampScale: 1.1,
  },
};

const hash2 = (x, z) => { const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return s - Math.floor(s); };

export class Lighting {
  constructor(scene, renderer, paletteKey, quality) {
    this.scene = scene; this.renderer = renderer; this.quality = quality;
    const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const p = this.p = { ...(PALETTES[paletteKey] || PALETTES.dusk) };
    if (q.get('rain') != null) p.rain = +q.get('rain');
    if (q.get('wet') != null) p.wet = +q.get('wet');
    scene.fog = new THREE.FogExp2(p.fog, p.fogD);
    scene.background = new THREE.Color(p.fog);
    // shared atmosphere uniforms (height fog, in-scatter, wetness, rim)
    Object.assign(atmo.fog, { x: p.fogH[0], y: 0, z: p.fogH[1], w: 0 });
    Object.assign(atmo.wet, { x: p.wet, y: p.puddle, z: p.rimI });
    const rim = new THREE.Color(p.rim); Object.assign(atmo.rim, { r: rim.r, g: rim.g, b: rim.b });
    Object.assign(atmo.haze, C3(p.haze));
    // final grade parameters, picked up by Renderer.render() from the active scene
    scene.userData.grade = { exposure: p.exposure, contrast: p.contrast, sat: p.sat, warmSat: p.warmSat, tint: p.tint, shadowTint: p.shadowTint, lift: p.lift, scatter: p.scatter };

    this.hemi = new THREE.HemisphereLight(p.hemiS, p.hemiG, p.hemiI);
    scene.add(this.hemi);
    const sun = this.sun = new THREE.DirectionalLight(p.sun, p.sunI);
    this.sunDir = new THREE.Vector3(...p.sunDir).normalize();
    sun.castShadow = true;
    const sm = quality === 'low' ? 1024 : 2048;
    sun.shadow.mapSize.set(sm, sm);
    const S = quality === 'high' ? 40 : 34;
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 140 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
    scene.add(sun); scene.add(sun.target);
    this.makeEnv(p);

    this.sources = [];
    const POOL = quality === 'low' ? 6 : quality === 'high' ? 14 : 12;
    this.pool = [];
    for (let i = 0; i < POOL; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false; scene.add(l); this.pool.push(l);
    }
    scene.userData.scatterLights = this.pool;
    this.fx = new LightFx(scene, quality);
    this.rain = p.rain > 0 ? new Rain(scene, quality, p.rain) : null;
    this.time = 0;
  }

  makeEnv(p) {
    const pm = new THREE.PMREMGenerator(this.renderer);
    const s = new THREE.Scene();
    const geo = new THREE.SphereGeometry(10, 48, 24);
    const c0 = new THREE.Color(p.sky[0]), c1 = new THREE.Color(p.sky[1]), c2 = new THREE.Color(p.sky[2]);
    const col = [];
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 10; const c = new THREE.Color();
      if (y < 0) c.copy(c0).lerp(c1, Math.max(0, y + 1) * 0.6); else c.copy(c1).lerp(c2, Math.pow(1 - y, 2.2) * 0.8);
      col.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    s.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    // city glow: neon + sodium patches at mid elevations, so glossy / wet surfaces pick up coloured sheens
    for (const [hex, I, x, y, z] of p.glows || []) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(I) }));
      m.position.set(x, y * 1.8 + 0.25, z).normalize().multiplyScalar(8.5); m.scale.set(2.2, 0.8, 2.2); m.lookAt(0, 0, 0); s.add(m);
    }
    const sunCard = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(p.sun).multiplyScalar(3) }));
    sunCard.position.copy(new THREE.Vector3(...p.sunDir).normalize().multiplyScalar(8)); s.add(sunCard);
    const rt = pm.fromScene(s, 0.035);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = p.envI ?? 0.5;
    pm.dispose();
  }

  // kind: 'fire' | 'lamp' | 'steady' | 'strobe' | 'pulse'
  addSource(pos, color, intensity, range, kind = 'steady', extra = {}) {
    const P = pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z);
    let c = color;
    // street lamps / flood lights get palette colours (sodium vs mercury) instead of one identical white-orange
    if (kind === 'lamp' && (color === 0xffa855 || color === 0xfff0d0)) {
      if (color === 0xfff0d0) c = this.p.flood;
      else { const r = hash2(Math.round(P.x), Math.round(P.z)); let acc = 0; for (const [hex, w] of this.p.lamps) { acc += w; if (r <= acc) { c = hex; break; } } }
    }
    // extraction beacon: lift + tame it so the pad does not blow out into glare during the evac fight
    if (kind === 'pulse' && color === 0x40ff80 && intensity >= 20) { P.y = Math.max(P.y, 3.4); intensity = 13; range = 13; }
    const s = { pos: P, color: new THREE.Color(c), intensity, range, kind, seed: Math.random() * 100, on: true, _lit: 0, ...extra };
    this.sources.push(s); return s;
  }
  removeSource(s) { const i = this.sources.indexOf(s); if (i >= 0) this.sources.splice(i, 1); }

  flicker(s, t) {
    switch (s.kind) {
      case 'fire': return 0.75 + 0.35 * vnoise(t * 9 + s.seed, s.seed) + 0.15 * vnoise(t * 23, s.seed * 2);
      case 'lamp': { // broken lamp: mostly on, occasional stutters
        const n = vnoise(t * 3 + s.seed, s.seed);
        if (n > 0.8) return vnoise(t * 40, s.seed) > 0.5 ? 1 : 0.08;
        return 1;
      }
      case 'strobe': return Math.sin(t * 6 + s.seed) > 0.4 ? 1 : 0.05;
      case 'pulse': return 0.7 + 0.3 * Math.sin(t * 3 + s.seed);
      default: return 1;
    }
  }

  update(dt, focus) {
    if (!(dt >= 0)) dt = 0;
    this.time += dt;
    const t = this.time;
    atmo.wet.w = t;
    // key light follows focus, snapped to texel grid to avoid shimmering
    const sun = this.sun, d = this.sunDir;
    const texel = (sun.shadow.camera.right * 2) / sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    sun.target.position.set(fx, 0, fz);
    sun.position.set(fx + d.x * 70, d.y * 70, fz + d.z * 70);
    // assign pool to nearest sources (score by distance / range)
    for (const s of this.sources) {
      const dx = s.pos.x - focus.x, dz = s.pos.z - focus.z;
      s._score = s.on && Number.isFinite(dx + dz + s.pos.y) && s.intensity > 0 ? (dx * dx + dz * dz) / (s.range * s.range * (s.priority || 1)) : Infinity;
      s.level = this.flicker(s, t);
      s._lit = 0;
    }
    const sorted = this.sources.filter((s) => s._score < 40).sort((a, b) => a._score - b._score);
    for (let i = 0; i < this.pool.length; i++) {
      const l = this.pool[i], s = sorted[i];
      if (!s) { l.intensity = 0; continue; } // never toggle visibility: keeps light count constant (no shader recompiles)
      l.position.copy(s.pos);
      l.color.copy(s.color);
      l.distance = s.range;
      // fade by distance to avoid popping when pool reassigns
      const fade = Math.min(1, Math.max(0, (40 - s._score) / 10));
      s._lit = fade;
      const I = s.intensity * s.level * fade * (s.kind === 'lamp' ? this.p.lampScale : 1);
      l.intensity = Number.isFinite(I) ? Math.min(I, 400) : 0;
    }
    this.fx.update(dt, this.sources, focus, 1.0, 1.0);
    if (this.rain) this.rain.update(dt, focus);
  }
}
