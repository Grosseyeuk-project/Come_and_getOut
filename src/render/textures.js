// Procedural PBR texture generation (albedo / normal / roughness) on canvases.
// All textures tile seamlessly. Generated once at boot and cached.
import * as THREE from 'three';
import { fbm, vnoise, hash2, RNG, clamp } from '../core/rng.js';

const cache = {};
const GAMMA = 1 / 2.0;
let maxAniso = 4;
export function setAnisotropy(a) { maxAniso = a; }

function canvas(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function toTex(cnv, srgb = true, repeat = true) {
  const t = new THREE.CanvasTexture(cnv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

// Draws random-walk cracks into a canvas and returns its alpha as Float32 mask (tiling via wrapped draws)
function crackMask(size, rng, count, width = 1.5, len = 60) {
  const c = canvas(size), g = c.getContext('2d');
  g.strokeStyle = '#fff'; g.lineCap = 'round';
  for (let k = 0; k < count; k++) {
    let x = rng.range(0, size), y = rng.range(0, size), a = rng.range(0, Math.PI * 2);
    const steps = rng.int(len * 0.4, len);
    let w = width * rng.range(0.6, 1.4);
    const pts = [[x, y]];
    for (let s = 0; s < steps; s++) {
      a += rng.range(-0.6, 0.6); x += Math.cos(a) * 4; y += Math.sin(a) * 4; pts.push([x, y]);
      if (rng.chance(0.04) && count < 400) { // branch
        let bx = x, by = y, ba = a + rng.sign() * rng.range(0.6, 1.3);
        const bp = [[bx, by]];
        for (let q = 0; q < rng.int(4, 14); q++) { ba += rng.range(-0.5, 0.5); bx += Math.cos(ba) * 3; by += Math.sin(ba) * 3; bp.push([bx, by]); }
        drawWrapped(g, bp, size, w * 0.6);
      }
    }
    drawWrapped(g, pts, size, w);
  }
  const d = g.getImageData(0, 0, size, size).data;
  const m = new Float32Array(size * size);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] / 255;
  return m;
}
function drawWrapped(g, pts, size, w) {
  for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
    g.lineWidth = w; g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x + ox, y + oy) : g.moveTo(x + ox, y + oy)));
    g.stroke();
  }
}

// Generic PBR generator. fn(u,v,x,y,o) must fill o.r,o.g,o.b (0..1), o.h (height 0..1), o.ro (roughness 0..1)
function genPBR(size, fn, normalStrength = 2.0, opts = {}) {
  const N = size * size;
  const col = canvas(size), cg = col.getContext('2d'), cid = cg.createImageData(size, size);
  const H = new Float32Array(N), R = new Float32Array(N), M = opts.metal ? new Float32Array(N) : null;
  const o = { r: 0, g: 0, b: 0, h: 0, ro: 0.8, m: 0 };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    o.m = 0;
    fn(x / size, y / size, x, y, o);
    // authored values are ~linear albedo; encode to sRGB-ish for the SRGB texture
    cid.data[i * 4] = Math.pow(clamp(o.r, 0, 1), GAMMA) * 255; cid.data[i * 4 + 1] = Math.pow(clamp(o.g, 0, 1), GAMMA) * 255; cid.data[i * 4 + 2] = Math.pow(clamp(o.b, 0, 1), GAMMA) * 255; cid.data[i * 4 + 3] = 255;
    H[i] = o.h; R[i] = o.ro; if (M) M[i] = o.m;
  }
  cg.putImageData(cid, 0, 0);
  // normal map (tiling sobel)
  const nc = canvas(size), ng = nc.getContext('2d'), nid = ng.createImageData(size, size);
  const rc = canvas(size), rg = rc.getContext('2d'), rid = rg.createImageData(size, size);
  const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) * normalStrength;
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) * normalStrength;
    let nx = -dx, ny = dy, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    nid.data[i * 4] = (nx * 0.5 + 0.5) * 255; nid.data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255; nid.data[i * 4 + 2] = (nz * 0.5 + 0.5) * 255; nid.data[i * 4 + 3] = 255;
    // roughnessMap reads G, metalnessMap reads B
    rid.data[i * 4] = 255; rid.data[i * 4 + 1] = clamp(R[i], 0, 1) * 255; rid.data[i * 4 + 2] = M ? clamp(M[i], 0, 1) * 255 : 0; rid.data[i * 4 + 3] = 255;
  }
  ng.putImageData(nid, 0, 0); rg.putImageData(rid, 0, 0);
  return { map: toTex(col, true), normalMap: toTex(nc, false), roughnessMap: toTex(rc, false), canvas: col };
}

const P = 8; // noise period for tiling at base frequency
function tn(u, v, f, oct, seed) { return fbm(u * f, v * f, oct, seed, f); }

export function asphalt() {
  if (cache.asphalt) return cache.asphalt;
  const S = 512, rng = new RNG(11);
  const cracks = crackMask(S, rng, 9, 1.0, 60);
  cache.asphalt = genPBR(S, (u, v, x, y, o) => {
    const i = y * S + x;
    const n = tn(u, v, 6, 5, 3), fine = hash2(x, y, 7), patch = tn(u, v, 2, 3, 9);
    const agg = fine > 0.86 ? 0.12 : fine < 0.08 ? -0.06 : 0;
    let base = 0.1 + n * 0.08 + agg * 0.5 + (patch > 0.62 ? -0.035 : 0);
    const stain = tn(u, v, 3, 4, 21); if (stain > 0.66) base *= 0.65;
    const c = cracks[i];
    base *= 1 - c * 0.45;
    o.r = base * 1.02; o.g = base * 1.0; o.b = base * 1.04;
    o.h = 0.5 + n * 0.3 + agg - c * 0.5;
    o.ro = clamp(0.92 - (stain > 0.66 ? 0.35 : 0) - c * 0.1 + fine * 0.05, 0, 1);
  }, 2.5);
  return cache.asphalt;
}

export function concrete() {
  if (cache.concrete) return cache.concrete;
  const S = 512, rng = new RNG(5);
  const cracks = crackMask(S, rng, 10, 1.2, 40);
  cache.concrete = genPBR(S, (u, v, x, y, o) => {
    const i = y * S + x;
    const n = tn(u, v, 4, 5, 1), d = tn(u, v, 16, 3, 2), f = hash2(x, y, 3);
    // vertical drip streaks
    const streak = vnoise(u * 40, v * 2, 8, 40) * vnoise(u * 9, v * 1.2, 9, 9);
    const form = (Math.abs(((v * 4) % 1) - 0.5) < 0.006) ? 1 : 0; // formwork lines
    let b = 0.42 + n * 0.16 - streak * 0.18 - form * 0.08 + (f - 0.5) * 0.04;
    const pit = f > 0.985 ? 1 : 0;
    b *= 1 - pit * 0.4 - cracks[i] * 0.6;
    const moss = clamp((tn(u, v, 3, 3, 33) - 0.62) * 4, 0, 1) * (1 - v * 0.4);
    o.r = b * (1 - moss * 0.45); o.g = b * 0.98 * (1 - moss * 0.1); o.b = b * 0.94 * (1 - moss * 0.6);
    o.h = 0.5 + d * 0.25 - pit * 0.4 - cracks[i] * 0.7 - form * 0.2;
    o.ro = 0.88 + f * 0.1 - streak * 0.1;
  }, 2.0);
  return cache.concrete;
}

export function brick() {
  if (cache.brick) return cache.brick;
  const S = 512, rows = 16, cols = 8;
  cache.brick = genPBR(S, (u, v, x, y, o) => {
    const ry = v * rows, row = Math.floor(ry), off = row % 2 ? 0.5 : 0;
    const rx = u * cols + off, col = Math.floor(rx);
    const fx = rx - col, fy = ry - row;
    const mortar = fx < 0.05 || fy < 0.09;
    const id = hash2(((col % cols) + cols) % cols, row, 4);
    const n = tn(u, v, 8, 4, 5), f = hash2(x, y, 6);
    const soot = clamp((tn(u, v, 2, 3, 40) - 0.45) * 2.5, 0, 1);
    if (mortar) {
      const m = 0.33 + n * 0.1;
      o.r = m; o.g = m * 0.97; o.b = m * 0.92; o.h = 0.2 + n * 0.1; o.ro = 0.95;
    } else {
      const chip = n > 0.68 ? 0.4 : 0;
      const br = 0.75 + id * 0.35 - chip;
      o.r = (0.42 * br + f * 0.04); o.g = (0.2 * br + f * 0.02); o.b = (0.14 * br + f * 0.02);
      o.h = 0.75 + f * 0.08 - chip * 0.5; o.ro = 0.85 + f * 0.1;
    }
    o.r *= 1 - soot * 0.6; o.g *= 1 - soot * 0.6; o.b *= 1 - soot * 0.55;
  }, 2.5);
  return cache.brick;
}

export function plaster() {
  if (cache.plaster) return cache.plaster;
  const S = 512;
  cache.plaster = genPBR(S, (u, v, x, y, o) => {
    const n = tn(u, v, 4, 5, 51), peel = tn(u, v, 6, 4, 52), f = hash2(x, y, 53);
    const streak = vnoise(u * 50, v * 1.5, 54, 50) * (0.6 + 0.4 * tn(u, v, 2, 2, 55));
    const exposed = peel > 0.66;
    if (exposed) { // concrete under peeled paint
      const b = 0.4 + n * 0.1; o.r = b * 1.02; o.g = b * 0.95; o.b = b * 0.88; o.h = 0.3; o.ro = 0.95;
    } else {
      const b = 0.68 + n * 0.14 - streak * 0.25 + (f - 0.5) * 0.03; o.r = b; o.g = b; o.b = b; o.h = 0.6 + n * 0.1 + f * 0.03; o.ro = 0.82;
    }
  }, 1.6);
  return cache.plaster;
}

export function dirt() {
  if (cache.dirt) return cache.dirt;
  const S = 512;
  cache.dirt = genPBR(S, (u, v, x, y, o) => {
    const n = tn(u, v, 4, 5, 61), d = tn(u, v, 24, 3, 62), f = hash2(x, y, 63);
    const peb = vnoise(u * 64, v * 64, 64, 64);
    const stone = peb > 0.78 ? (peb - 0.78) * 4 : 0;
    const grass = clamp((tn(u, v, 3, 4, 65) - 0.5) * 3, 0, 1);
    let r = 0.17 + n * 0.09, g = 0.155 + n * 0.08, b = 0.135 + n * 0.07;
    r = r * (1 - grass) + (0.14 + d * 0.06) * grass; g = g * (1 - grass) + (0.17 + d * 0.08) * grass; b = b * (1 - grass) + (0.08 + d * 0.03) * grass;
    r += stone * 0.2; g += stone * 0.19; b += stone * 0.18;
    o.r = r + (f - 0.5) * 0.04; o.g = g + (f - 0.5) * 0.04; o.b = b + (f - 0.5) * 0.03;
    o.h = 0.4 + n * 0.3 + stone * 0.5 + d * 0.15; o.ro = 0.95 - stone * 0.2;
  }, 3.0);
  return cache.dirt;
}

export function pavers() {
  if (cache.pavers) return cache.pavers;
  const S = 512, rng = new RNG(71);
  const cracks = crackMask(S, rng, 8, 1, 30);
  cache.pavers = genPBR(S, (u, v, x, y, o) => {
    const i = y * S + x, g = 4;
    const gx = u * g, gy = v * g, fx = gx % 1, fy = gy % 1;
    const tid = hash2(Math.floor(gx), Math.floor(gy), 72);
    const joint = fx < 0.018 || fy < 0.018;
    const n = tn(u, v, 8, 4, 73), f = hash2(x, y, 74);
    const missing = tid > 0.93;
    let b = joint ? 0.11 : 0.17 + tid * 0.06 + n * 0.08 + (f - 0.5) * 0.04;
    b *= 0.75 + 0.5 * tn(u, v, 3, 3, 76);
    if (missing) b = 0.16 + n * 0.06;
    b *= 1 - cracks[i] * 0.6;
    const dirtiness = tn(u, v, 2, 3, 75);
    o.r = b * (0.98 + dirtiness * 0.06); o.g = b * 0.97; o.b = b * (0.94 - dirtiness * 0.05);
    o.h = joint || missing ? 0.1 : 0.7 + n * 0.1 - cracks[i] * 0.6; o.ro = joint ? 0.98 : 0.86;
  }, 2.0);
  return cache.pavers;
}

export function rustMetal(key, paint = [0.35, 0.38, 0.4]) {
  const k = 'rust_' + key;
  if (cache[k]) return cache[k];
  const S = 256;
  cache[k] = genPBR(S, (u, v, x, y, o) => {
    const n = tn(u, v, 6, 5, 81), r = tn(u, v, 14, 4, 82), f = hash2(x, y, 83);
    const rust = clamp((r + n * 0.4 - 0.7) * 4, 0, 1);
    const pr = paint[0] * (0.85 + n * 0.25), pg = paint[1] * (0.85 + n * 0.25), pb = paint[2] * (0.85 + n * 0.25);
    const rr = 0.22 + f * 0.08, rg = 0.12 + f * 0.04, rb = 0.07;
    o.r = pr * (1 - rust) + rr * rust; o.g = pg * (1 - rust) + rg * rust; o.b = pb * (1 - rust) + rb * rust;
    o.h = 0.5 + rust * 0.3 * f + n * 0.1; o.ro = 0.45 + rust * 0.5 + f * 0.05; o.m = 0.6 * (1 - rust);
  }, 2.0, { metal: true });
  return cache[k];
}

export function corrugated() {
  if (cache.corr) return cache.corr;
  const S = 256;
  cache.corr = genPBR(S, (u, v, x, y, o) => {
    const wave = Math.sin(u * Math.PI * 2 * 12) * 0.5 + 0.5;
    const n = tn(u, v, 4, 5, 91), r = tn(u, v, 6, 4, 92);
    const rust = clamp((r - 0.55) * 4 + (1 - v) * 0.0, 0, 1);
    const b = 0.3 + wave * 0.12 + n * 0.1;
    o.r = b * (1 - rust) + 0.32 * rust; o.g = b * (1 - rust) + 0.15 * rust; o.b = b * 1.05 * (1 - rust) + 0.07 * rust;
    o.h = wave; o.ro = 0.5 + rust * 0.45; o.m = 0.7 * (1 - rust);
  }, 4.0, { metal: true });
  return cache.corr;
}

export function wood() {
  if (cache.wood) return cache.wood;
  const S = 256;
  cache.wood = genPBR(S, (u, v, x, y, o) => {
    const plank = Math.floor(u * 4), fu = (u * 4) % 1;
    const id = hash2(plank, 0, 101);
    const grain = vnoise(u * 4 * 3 + id * 10, v * 60, 102) * 0.5 + vnoise(u * 40, v * 4, 103, 4) * 0.5;
    const gap = fu < 0.03;
    const b = gap ? 0.05 : 0.22 + grain * 0.12 + id * 0.08;
    o.r = b * 1.1; o.g = b * 0.85; o.b = b * 0.62; o.h = gap ? 0 : 0.6 + grain * 0.2; o.ro = 0.9;
  }, 2.0);
  return cache.wood;
}

export function fabric() {
  if (cache.fabric) return cache.fabric;
  const S = 256;
  cache.fabric = genPBR(S, (u, v, x, y, o) => {
    const weave = (Math.sin(x * 1.6) * Math.sin(y * 1.6)) * 0.5 + 0.5;
    const n = tn(u, v, 4, 4, 111), f = hash2(x, y, 112);
    const b = 0.5 + n * 0.25 + weave * 0.06;
    o.r = b; o.g = b; o.b = b; o.h = weave * 0.5 + n * 0.5; o.ro = 0.95 - f * 0.05;
  }, 1.5);
  return cache.fabric;
}

// --- Alpha cards / sprites --------------------------------------------------
// Canvas alpha is premultiplied, so transparent texels are black and mipmaps darken thin blades.
// Bleed the average opaque colour into transparent texels and upload as an un-premultiplied DataTexture.
function cardTex(c) {
  const g = c.getContext('2d'), id = g.getImageData(0, 0, c.width, c.height), d = id.data;
  let r = 0, gg = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
  n = Math.max(1, n); r /= n; gg /= n; b /= n;
  const out = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a < 250) { const k = a / 255; out[i] = d[i] * k + r * (1 - k); out[i + 1] = d[i + 1] * k + gg * (1 - k); out[i + 2] = d[i + 2] * k + b * (1 - k); }
    else { out[i] = d[i]; out[i + 1] = d[i + 1]; out[i + 2] = d[i + 2]; }
    out[i + 3] = a;
  }
  // DataTexture rows start at the bottom: flip manually
  const w = c.width, h = c.height, flipped = new Uint8Array(out.length);
  for (let y = 0; y < h; y++) flipped.set(out.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  const t = new THREE.DataTexture(flipped, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = maxAniso; t.needsUpdate = true;
  return t;
}
export function grassCard() {
  if (cache.grass) return cache.grass;
  const c = canvas(256), g = c.getContext('2d'), rng = new RNG(121);
  for (let i = 0; i < 70; i++) {
    const x = rng.range(20, 236), h = rng.range(90, 240), lean = rng.range(-50, 50), w = rng.range(3, 7);
    const dry = rng.next();
    const r = 95 + dry * 80, gg = 115 + dry * 40, b = 45 + dry * 20;
    const grad = g.createLinearGradient(0, 256, 0, 256 - h);
    grad.addColorStop(0, `rgb(${r * 0.4},${gg * 0.4},${b * 0.4})`); grad.addColorStop(1, `rgb(${r},${gg},${b})`);
    g.fillStyle = grad; g.beginPath(); g.moveTo(x - w, 256); g.quadraticCurveTo(x + lean * 0.3, 256 - h * 0.6, x + lean, 256 - h); g.quadraticCurveTo(x + lean * 0.3 + w * 0.3, 256 - h * 0.6, x + w, 256); g.fill();
  }
  cache.grass = cardTex(c);
  return cache.grass;
}
export function leafCard() {
  if (cache.leaf) return cache.leaf;
  const c = canvas(256), g = c.getContext('2d'), rng = new RNG(131);
  for (let i = 0; i < 140; i++) {
    const x = rng.range(20, 236), y = rng.range(20, 236), s = rng.range(6, 16), a = rng.range(0, 6.28);
    const dry = rng.next();
    g.fillStyle = `rgb(${70 + dry * 70},${90 + dry * 30 + rng.range(0, 30)},${35 + dry * 15})`;
    g.save(); g.translate(x, y); g.rotate(a); g.beginPath(); g.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2); g.fill(); g.restore();
  }
  cache.leaf = cardTex(c);
  return cache.leaf;
}
export function vineCard() {
  if (cache.vine) return cache.vine;
  const c = canvas(256, 512), g = c.getContext('2d'), rng = new RNG(141);
  for (let k = 0; k < 7; k++) {
    let x = rng.range(30, 226), y = 0;
    g.strokeStyle = 'rgba(40,35,20,1)'; g.lineWidth = 2;
    const pts = [];
    while (y < 512 * rng.range(0.5, 1)) { x += rng.range(-8, 8); y += rng.range(6, 14); pts.push([x, y]); }
    g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke();
    for (const [px, py] of pts) for (let l = 0; l < 3; l++) {
      g.fillStyle = `rgb(${35 + rng.range(0, 40)},${50 + rng.range(0, 35)},${20 + rng.range(0, 10)})`;
      g.beginPath(); g.ellipse(px + rng.range(-10, 10), py + rng.range(-6, 6), rng.range(4, 9), rng.range(2, 5), rng.range(0, 6), 0, 7); g.fill();
    }
  }
  cache.vine = cardTex(c);
  return cache.vine;
}
export function softSprite(key = 'soft', inner = 1, outer = 0) {
  if (cache[key]) return cache[key];
  const c = canvas(128), g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, `rgba(255,255,255,${inner})`); grd.addColorStop(0.35, 'rgba(255,255,255,0.45)'); grd.addColorStop(1, `rgba(255,255,255,${outer})`);
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  cache[key] = toTex(c, true, false);
  return cache[key];
}
export function smokeSprite() {
  if (cache.smoke) return cache.smoke;
  const S = 128, c = canvas(S), g = c.getContext('2d'), id = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x / S - 0.5, dy = y / S - 0.5, r = Math.hypot(dx, dy) * 2;
    const n = fbm(x / 20, y / 20, 4, 151);
    const a = clamp((1 - r) * 1.4 * (0.4 + n * 0.9) - 0.15, 0, 1);
    const i = (y * S + x) * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = 200 + n * 55; id.data[i + 3] = a * 255;
  }
  g.putImageData(id, 0, 0);
  cache.smoke = toTex(c, true, false);
  return cache.smoke;
}
export function flameSprite() {
  if (cache.flame) return cache.flame;
  const S = 128, c = canvas(S), g = c.getContext('2d'), id = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S - 0.5, v = y / S; // v: 0 top
    const wid = 0.32 * Math.pow(v, 0.7);
    const n = fbm(x / 14, y / 10, 3, 161);
    const d = Math.abs(u) / (wid + 1e-3);
    const a = clamp((1 - d) * (0.6 + n * 0.8) * clamp(v * 3, 0, 1) * clamp((1 - v) * 8, 0, 1), 0, 1);
    const heat = clamp(a * 1.3, 0, 1);
    const i = (y * S + x) * 4;
    id.data[i] = 255; id.data[i + 1] = 90 + heat * 165; id.data[i + 2] = 20 + heat * heat * 140; id.data[i + 3] = a * 255;
  }
  g.putImageData(id, 0, 0);
  cache.flame = toTex(c, true, false);
  return cache.flame;
}

// Ground decals: kind -> RGBA canvas texture
export function decal(kind) {
  const k = 'decal_' + kind;
  if (cache[k]) return cache[k];
  const S = 256, c = canvas(S), g = c.getContext('2d'), rng = new RNG(hashKind(kind));
  if (kind === 'oil' || kind === 'scorch' || kind === 'puddle' || kind === 'blood') {
    const id = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x / S - 0.5, dy = y / S - 0.5, r = Math.hypot(dx, dy) * 2;
      const n = fbm(x / 40, y / 40, 4, hashKind(kind));
      const a = clamp((1 - r) * 2 + (n - 0.5) * 2.2 - 0.3, 0, 1);
      const i = (y * S + x) * 4;
      if (kind === 'oil') { id.data[i] = 8; id.data[i + 1] = 8; id.data[i + 2] = 10; id.data[i + 3] = a * 200; }
      else if (kind === 'scorch') { id.data[i] = 5; id.data[i + 1] = 4; id.data[i + 2] = 3; id.data[i + 3] = clamp(a * 1.2, 0, 1) * 235; }
      else if (kind === 'blood') { id.data[i] = 70; id.data[i + 1] = 4; id.data[i + 2] = 4; id.data[i + 3] = clamp(a * 1.6, 0, 1) * 230; }
      else { id.data[i] = 20; id.data[i + 1] = 24; id.data[i + 2] = 28; id.data[i + 3] = clamp(a * 2, 0, 1) * 255; }
    }
    g.putImageData(id, 0, 0);
  } else if (kind === 'trash') {
    for (let i = 0; i < 40; i++) {
      { const v = rng.int(60, 170), w = rng.next() < 0.3; g.fillStyle = w ? `rgba(${v + 40},${v + 36},${v + 28},${rng.range(0.5, 0.9)})` : `rgba(${v},${Math.round(v * 0.85)},${Math.round(v * 0.65)},${rng.range(0.5, 0.9)})`; }
      g.save(); g.translate(rng.range(20, 236), rng.range(20, 236)); g.rotate(rng.range(0, 6.3));
      g.fillRect(-rng.range(3, 14), -rng.range(2, 9), rng.range(6, 26), rng.range(4, 16)); g.restore();
    }
  } else if (kind === 'crosswalk') {
    g.fillStyle = 'rgba(200,195,170,0.85)';
    for (let i = 0; i < 6; i++) g.fillRect(8 + i * 42, 10, 24, 236);
    // wear
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(0,0,0,${rng.range(0.2, 0.8)})`; g.beginPath(); g.arc(rng.range(0, 256), rng.range(0, 256), rng.range(1, 5), 0, 7); g.fill(); }
  } else if (kind === 'dash') {
    g.fillStyle = 'rgba(210,180,90,0.85)'; g.fillRect(100, 0, 56, 256);
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 500; i++) { g.fillStyle = `rgba(0,0,0,${rng.range(0.3, 1)})`; g.beginPath(); g.arc(rng.range(90, 166), rng.range(0, 256), rng.range(1, 7), 0, 7); g.fill(); }
  } else if (kind === 'crack') {
    const m = crackMask(S, rng, 4, 1.3, 45);
    const id = g.createImageData(S, S);
    for (let i = 0; i < m.length; i++) { const dx = (i % S) / S - 0.5, dy = Math.floor(i / S) / S - 0.5; const fall = clamp(1 - Math.hypot(dx, dy) * 2, 0, 1); id.data[i * 4] = 30; id.data[i * 4 + 1] = 27; id.data[i * 4 + 2] = 24; id.data[i * 4 + 3] = m[i] * fall * 150; }
    g.putImageData(id, 0, 0);
  }
  cache[k] = toTex(c, true, false);
  return cache[k];
}
function hashKind(s) { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }

// Beam gradient for loot pillars
export function beamTex() {
  if (cache.beam) return cache.beam;
  const c = canvas(4, 128), g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 128, 0, 0);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.45)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 4, 128);
  cache.beam = toTex(c, true, false);
  return cache.beam;
}

// Graffiti atlas: 4x2 cells of spray-painted tags/symbols.
export function graffitiAtlas() {
  if (cache.graffiti) return cache.graffiti;
  const W = 1024, H = 512, c = canvas(W, H), g = c.getContext('2d'), rng = new RNG(909);
  const cols = ['#c8281e', '#e8e2d0', '#e0b020', '#2aa8c8', '#111111', '#7ac040', '#d050a0'];
  const words = ['GET OUT', 'NO GOD', 'RUN', 'KEEP OUT', 'DEAD ZONE', '13', 'EXIT ->', 'THEY HEAR'];
  for (let k = 0; k < 8; k++) {
    const cx = (k % 4) * 256, cy = Math.floor(k / 4) * 256;
    g.save(); g.beginPath(); g.rect(cx, cy, 256, 256); g.clip(); g.translate(cx + 128, cy + 128); g.rotate(rng.range(-0.15, 0.15));
    const col = rng.pick(cols);
    g.shadowColor = col; g.shadowBlur = 6; g.strokeStyle = col; g.fillStyle = col; g.lineCap = 'round'; g.lineJoin = 'round';
    if (k % 3 === 2) { // symbol: anarchy circle / skull-ish / arrow
      g.lineWidth = 10; g.beginPath(); g.arc(0, 0, 70, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(-50, 60); g.lineTo(0, -75); g.lineTo(50, 60); g.moveTo(-60, 10); g.lineTo(60, 10); g.stroke();
    } else {
      g.font = `bold ${rng.int(54, 78)}px Impact, Arial Black, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const w = words[k]; g.lineWidth = 6; g.strokeText(w, 0, 0); g.globalAlpha = 0.85; g.fillText(w, 0, 0); g.globalAlpha = 1;
    }
    // drips
    g.shadowBlur = 0; g.lineWidth = 3;
    for (let i = 0; i < 10; i++) { const x = rng.range(-100, 100), y = rng.range(-10, 30); g.globalAlpha = 0.7; g.beginPath(); g.moveTo(x, y); g.lineTo(x + rng.range(-2, 2), y + rng.range(15, 70)); g.stroke(); }
    // weathering
    g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 1;
    for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(0,0,0,${rng.range(0.2, 0.9)})`; g.beginPath(); g.arc(rng.range(-128, 128), rng.range(-128, 128), rng.range(1, 6), 0, 7); g.fill(); }
    g.restore();
  }
  cache.graffiti = toTex(c, true, false);
  return cache.graffiti;
}

// Muzzle flash: hot core + forward-biased spikes (drawn pointing +x)
export function muzzleTex() {
  if (cache.muzzle) return cache.muzzle;
  const c = canvas(256, 128), g = c.getContext('2d');
  g.globalCompositeOperation = 'lighter';
  const core = g.createRadialGradient(40, 64, 0, 40, 64, 40); core.addColorStop(0, 'rgba(255,250,230,1)'); core.addColorStop(0.4, 'rgba(255,190,90,0.8)'); core.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = core; g.fillRect(0, 0, 256, 128);
  const spike = (ang, len, w) => { g.save(); g.translate(40, 64); g.rotate(ang); const gr = g.createLinearGradient(0, 0, len, 0); gr.addColorStop(0, 'rgba(255,230,170,0.95)'); gr.addColorStop(1, 'rgba(255,120,20,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, -w); g.lineTo(len, 0); g.lineTo(0, w); g.fill(); g.restore(); };
  spike(0, 210, 14); spike(0.5, 70, 8); spike(-0.5, 70, 8); spike(1.4, 40, 6); spike(-1.4, 40, 6); spike(Math.PI, 30, 6);
  cache.muzzle = toTex(c, true, false);
  return cache.muzzle;
}
