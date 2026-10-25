// Procedural canvas textures owned by the combat FX: blood splats/pools, impact star flash, ground ring.
import * as THREE from 'three';

const cache = {};
function cv(S) { const c = document.createElement('canvas'); c.width = c.height = S; return c; }
function tex(c, srgb = true) { const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true; return t; }
function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// Directional splatter (spray goes toward +x): core blob, droplets, streaks. White RGB, alpha = coverage.
export function splatTex(variant = 0) {
  const k = 'splat' + variant; if (cache[k]) return cache[k];
  const S = 256, c = cv(S), g = c.getContext('2d'), r = rnd(91 + variant * 977);
  g.fillStyle = '#fff';
  const blob = (x, y, rad, a = 1) => { g.globalAlpha = a; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill(); };
  // core: overlapping blobs biased forward
  for (let i = 0; i < 14; i++) blob(96 + r() * 40, 128 + (r() - 0.5) * 40, 10 + r() * 22, 0.9);
  // streaks fanning forward
  for (let i = 0; i < 16; i++) {
    const a = (r() - 0.5) * 1.3, len = 40 + r() * 100, w = 2 + r() * 5;
    g.save(); g.translate(110, 128); g.rotate(a); g.globalAlpha = 0.85;
    g.beginPath(); g.moveTo(0, -w); g.quadraticCurveTo(len * 0.6, -w * 0.6, len, 0); g.quadraticCurveTo(len * 0.6, w * 0.6, 0, w); g.fill();
    blob(len, 0, w * 1.1, 0.9); g.restore();
  }
  // droplets
  for (let i = 0; i < 70; i++) { const a = (r() - 0.5) * 2.2, d = 30 + r() * 100; blob(110 + Math.cos(a) * d, 128 + Math.sin(a) * d, 1 + r() * 4.5 * (1 - d / 160), 0.95); }
  g.globalAlpha = 1;
  return (cache[k] = tex(c));
}
// Rounded pool with noisy edge.
export function poolTex() {
  if (cache.pool) return cache.pool;
  const S = 256, c = cv(S), g = c.getContext('2d'), r = rnd(4242);
  g.fillStyle = '#fff';
  for (let i = 0; i < 26; i++) { const a = r() * 6.28, d = r() * 50; g.globalAlpha = 0.9; g.beginPath(); g.arc(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 30 + r() * 40, 0, 7); g.fill(); }
  for (let i = 0; i < 30; i++) { const a = r() * 6.28, d = 70 + r() * 45; g.beginPath(); g.arc(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 2 + r() * 7, 0, 7); g.fill(); }
  g.globalAlpha = 1;
  return (cache.pool = tex(c));
}
// Sharp 6-point star for impact / muzzle flashes (additive).
export function starTex() {
  if (cache.star) return cache.star;
  const S = 128, c = cv(S), g = c.getContext('2d'), id = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x + 0.5) / S - 0.5, dy = (y + 0.5) / S - 0.5, d = Math.hypot(dx, dy) * 2, a = Math.atan2(dy, dx);
    const ray = Math.pow(Math.abs(Math.cos(a * 3)), 18) * Math.max(0, 1 - d) * 1.2 + Math.pow(Math.abs(Math.cos(a * 2 + 0.4)), 30) * Math.max(0, 1 - d * 1.3) * 0.6;
    const core = Math.exp(-d * d * 30) + Math.exp(-d * 6) * 0.4;
    const v = Math.min(1, core + ray);
    const i = (y * S + x) * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = 255; id.data[i + 3] = v * 255;
  }
  g.putImageData(id, 0, 0);
  return (cache.star = tex(c, false));
}
// Player ground ring: thin circle with tick marks + a forward chevron (texture faces +x = forward).
export function ringTex() {
  if (cache.ring) return cache.ring;
  const S = 256, c = cv(S), g = c.getContext('2d');
  g.strokeStyle = '#fff'; g.lineWidth = 5; g.globalAlpha = 0.9;
  g.beginPath(); g.arc(128, 128, 100, 0.35, Math.PI * 2 - 0.35); g.stroke();
  g.lineWidth = 2; g.globalAlpha = 0.45; g.beginPath(); g.arc(128, 128, 88, 0, Math.PI * 2); g.stroke();
  g.globalAlpha = 1; g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(246, 128); g.lineTo(214, 106); g.lineTo(222, 128); g.lineTo(214, 150); g.closePath(); g.fill();
  for (let i = 1; i < 4; i++) { const a = (i / 4) * Math.PI * 2; g.save(); g.translate(128, 128); g.rotate(a); g.fillRect(94, -2, 14, 4); g.restore(); }
  return (cache.ring = tex(c, false));
}
