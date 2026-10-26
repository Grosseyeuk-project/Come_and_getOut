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
    const i = y * S + x, g = 2;
    const gx = u * g, gy = v * g, fx = gx % 1, fy = gy % 1;
    const tid = hash2(Math.floor(gx), Math.floor(gy), 72);
    const joint = fx < 0.01 || fy < 0.01;
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
  if (kind === 'oil' || kind === 'scorch' || kind === 'puddle' || kind === 'blood' || kind === 'dirt') {
    const id = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x / S - 0.5, dy = y / S - 0.5, r = Math.hypot(dx, dy) * 2;
      const n = fbm(x / 40, y / 40, 4, hashKind(kind));
      const a = clamp((1 - r) * 2 + (n - 0.5) * 2.2 - 0.3, 0, 1);
      const i = (y * S + x) * 4;
      if (kind === 'oil') { id.data[i] = 10; id.data[i + 1] = 9; id.data[i + 2] = 12; id.data[i + 3] = a * 150; }
      else if (kind === 'scorch') { id.data[i] = 9; id.data[i + 1] = 7; id.data[i + 2] = 6; id.data[i + 3] = clamp(a * 1.1, 0, 1) * 205; }
      else if (kind === 'dirt') { const f = fbm(x / 9, y / 9, 3, 77); id.data[i] = 62 + f * 30; id.data[i + 1] = 54 + f * 26; id.data[i + 2] = 42 + f * 20; id.data[i + 3] = clamp(a * 1.3 * (0.5 + f), 0, 1) * 210; }
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
  } else if (kind === 'manhole' || kind === 'drain') {
    const id = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x / S - 0.5, dy = y / S - 0.5, r = Math.hypot(dx, dy) * 2, i = (y * S + x) * 4;
      let a = 0, v = 0;
      if (kind === 'manhole') {
        if (r < 0.86) { v = 34 + ((Math.floor((dx + 1) * 14) + Math.floor((dy + 1) * 14)) % 2) * 10 + fbm(x / 12, y / 12, 3, 5) * 20; a = 1; if (Math.abs(r - 0.8) < 0.03 || Math.abs(r - 0.45) < 0.02) v = 18; }
        else if (r < 0.98) { v = 22; a = (0.98 - r) * 8; }
      } else {
        if (Math.abs(dx) < 0.42 && Math.abs(dy) < 0.24) { const slot = (Math.abs(dx) * 22) % 1 < 0.45 && Math.abs(dy) < 0.19; v = slot ? 6 : 40; a = 1; }
      }
      const rust = fbm(x / 20, y / 20, 3, 9) > 0.6 ? 1 : 0;
      id.data[i] = v + rust * 18; id.data[i + 1] = v + rust * 6; id.data[i + 2] = v; id.data[i + 3] = clamp(a, 0, 1) * 255;
    }
    g.putImageData(id, 0, 0);
  } else if (kind === 'patch' || kind === 'stain' || kind === 'wet') {
    const id = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = Math.abs(x / S - 0.5) * 2, dy = Math.abs(y / S - 0.5) * 2, i = (y * S + x) * 4, n = fbm(x / 30, y / 30, 4, hashKind(kind));
      let a;
      if (kind === 'patch') { const e = Math.max(dx, dy) + (n - 0.5) * 0.12; a = e < 0.9 ? 0.92 : 0; const v = 16 + n * 16 + (hash2(x, y, 3) > 0.9 ? 10 : 0); id.data[i] = v; id.data[i + 1] = v; id.data[i + 2] = v + 2; if (Math.abs(e - 0.88) < 0.025) { id.data[i] = id.data[i + 1] = id.data[i + 2] = 8; a = 1; } }
      else { const r = Math.hypot(dx, dy); a = clamp((1 - r) * 1.6 + (n - 0.5) * 2.4 - 0.2, 0, 1) * (kind === 'wet' ? 0.3 : 0.5); const v = kind === 'wet' ? 22 : 14 + n * 8; id.data[i] = v; id.data[i + 1] = v * 0.95; id.data[i + 2] = v * 0.9; }
      id.data[i + 3] = a * 255;
    }
    g.putImageData(id, 0, 0);
  } else if (kind === 'arrow' || kind === 'edge') {
    g.fillStyle = kind === 'arrow' ? 'rgba(220,216,200,0.85)' : 'rgba(215,212,195,0.8)';
    if (kind === 'arrow') { g.fillRect(112, 90, 32, 160); g.beginPath(); g.moveTo(70, 100); g.lineTo(128, 6); g.lineTo(186, 100); g.fill(); }
    else g.fillRect(108, 0, 40, 256);
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 600; i++) { g.fillStyle = `rgba(0,0,0,${rng.range(0.3, 1)})`; g.beginPath(); g.arc(rng.range(60, 196), rng.range(0, 256), rng.range(1, 6), 0, 7); g.fill(); }
  } else if (kind === 'leaves' || kind === 'paper') {
    for (let i = 0; i < (kind === 'leaves' ? 260 : 26); i++) {
      const r2 = Math.sqrt(rng.next()) * 110, a2 = rng.range(0, 6.3);
      const x = 128 + Math.cos(a2) * r2, y = 128 + Math.sin(a2) * r2;
      g.save(); g.translate(x, y); g.rotate(rng.range(0, 6.3));
      if (kind === 'leaves') { const d = rng.next(); g.fillStyle = `rgba(${70 + d * 60},${45 + d * 30},${20 + d * 10},0.9)`; g.beginPath(); g.ellipse(0, 0, rng.range(3, 7), rng.range(1.5, 3.5), 0, 0, 7); g.fill(); }
      else { const v = rng.int(140, 210); g.fillStyle = `rgba(${v},${v - 6},${v - 18},0.92)`; g.fillRect(-rng.range(4, 12), -rng.range(3, 9), rng.range(8, 22), rng.range(6, 16)); g.fillStyle = 'rgba(40,36,30,0.4)'; g.fillRect(-4, -2, 8, 1.5); }
      g.restore();
    }
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

// ---------------------------------------------------------------------------------------------
// Environment-art kit textures (vehicles, facades, signage, posters, shutters)
// ---------------------------------------------------------------------------------------------

// Vehicle paint: mostly clean dielectric paint, scratches, grime rising from the sills, sparse rust
// blisters around panel seams. UVs are shape-space metres (extrude) so 1 tile ~ 1 m.
export function carPaint(key, paint = [0.4, 0.4, 0.4]) {
  const k = 'car_' + key;
  if (cache[k]) return cache[k];
  const S = 512, rng = new RNG(hashKind(key));
  const scratches = crackMask(S, rng, 34, 0.7, 22);
  cache[k] = genPBR(S, (u, v, x, y, o) => {
    const i = y * S + x;
    const n = tn(u, v, 2, 3, 201), d = tn(u, v, 6, 4, 202), f = hash2(x, y, 203), dd = tn(u, v, 24, 3, 207);
    const rs = tn(u, v, 4, 4, 204), peel = tn(u, v, 5, 4, 205);
    const streak = vnoise(u * 70, v * 2.5, 206, 70) * (0.5 + 0.5 * tn(u, v, 3, 2, 208));
    const rust = clamp((rs - 0.62) * 5 + streak * 0.3, 0, 1);
    const grime = clamp((d - 0.38) * 1.5 + streak * 0.5 + (dd - 0.5) * 0.4, 0, 1) * 0.75;
    const matte = peel > 0.6 && peel < 0.68 ? 1 : 0; // clear-coat failure ring
    const primer = peel > 0.68 ? 1 : 0;           // paint gone: grey primer
    const s = scratches[i];
    const tone = 0.85 + n * 0.25;
    let r = paint[0] * tone, g = paint[1] * tone, b = paint[2] * tone;
    if (primer) { r = 0.16 + n * 0.04; g = 0.16 + n * 0.04; b = 0.155 + n * 0.04; }
    r = r * (1 - grime) + 0.07 * grime; g = g * (1 - grime) + 0.062 * grime; b = b * (1 - grime) + 0.05 * grime;
    const dust = f > 0.93 ? 0.05 : 0; r += dust; g += dust; b += dust * 0.9;
    r += s * 0.16; g += s * 0.16; b += s * 0.16; // bare metal in scratches
    const rr = 0.17 + f * 0.07 + rs * 0.05, rg = 0.075 + f * 0.03, rb = 0.035;
    o.r = r * (1 - rust) + rr * rust; o.g = g * (1 - rust) + rg * rust; o.b = b * (1 - rust) + rb * rust;
    o.h = 0.5 + rust * 0.45 * f - s * 0.25 - primer * 0.08 + dd * 0.06; o.ro = 0.28 + grime * 0.55 + matte * 0.3 + primer * 0.5 + rust * 0.55 + s * 0.15 + f * 0.04; o.m = s * 0.8;
  }, 3.0, { metal: true });
  return cache[k];
}
// Wooden crate: plank faces with a border frame, nails, stencil block, grime
export function crateWood() {
  if (cache.crate) return cache.crate;
  const S = 256;
  cache.crate = genPBR(S, (u, v, x, y, o) => {
    const frame = u < 0.1 || u > 0.9 || v < 0.1 || v > 0.9, diag = Math.abs(u - v) < 0.06;
    const pl = Math.floor(v * 5), fv = (v * 5) % 1, id = hash2(pl, 3, 261);
    const grain = vnoise(u * 3 + id * 9, v * 60, 262) * 0.5 + vnoise(u * 30, v * 4, 263) * 0.5, f = hash2(x, y, 264);
    const gap = !frame && !diag && fv < 0.05;
    const sten = !frame && u > 0.3 && u < 0.7 && v > 0.42 && v < 0.58 && ((u * 30 | 0) % 3 !== 0) && hash2(u * 22 | 0, v * 14 | 0, 265) > 0.35;
    let b = gap ? 0.04 : (frame || diag ? 0.3 : 0.24 + id * 0.08) + grain * 0.1;
    const dirt = clamp((tn(u, v, 3, 3, 266) - 0.45) * 2, 0, 1) * 0.5;
    b *= 1 - dirt;
    o.r = sten ? 0.05 : b * 1.1; o.g = sten ? 0.05 : b * 0.82; o.b = sten ? 0.05 : b * 0.55;
    if ((frame || diag) && f > 0.995) { o.r = o.g = o.b = 0.35; }
    o.h = gap ? 0 : (frame || diag ? 0.85 : 0.6) + grain * 0.15; o.ro = 0.85;
  }, 3.0);
  return cache.crate;
}
export function cardboard() {
  if (cache.cardboard) return cache.cardboard;
  const S = 256;
  cache.cardboard = genPBR(S, (u, v, x, y, o) => {
    const flute = Math.sin(u * Math.PI * 2 * 40) * 0.5 + 0.5, n = tn(u, v, 4, 4, 271), f = hash2(x, y, 272);
    const tape = Math.abs(v - 0.5) < 0.07, wet = clamp((tn(u, v, 3, 3, 273) - 0.55) * 3, 0, 1);
    const print = u > 0.15 && u < 0.45 && v > 0.15 && v < 0.35 && hash2(u * 18 | 0, v * 10 | 0, 274) > 0.5;
    let r = 0.36 + n * 0.08 + flute * 0.02, g = 0.25 + n * 0.06, b = 0.14 + n * 0.04;
    if (tape) { r = 0.42; g = 0.36; b = 0.25; }
    if (print) { r *= 0.3; g *= 0.3; b *= 0.3; }
    r *= 1 - wet * 0.45; g *= 1 - wet * 0.45; b *= 1 - wet * 0.45;
    o.r = r + (f - 0.5) * 0.02; o.g = g; o.b = b; o.h = 0.5 + flute * 0.1 - wet * 0.1; o.ro = tape ? 0.4 : 0.92 - wet * 0.3;
  }, 1.5);
  return cache.cardboard;
}
// Bright, neutral leaf card for vertex-colour tinted foliage masses (saturated reds/oranges/toxic greens)
export function leafBright() {
  if (cache.leafB) return cache.leafB;
  const c = canvas(256), g = c.getContext('2d'), rng = new RNG(133);
  for (let i = 0; i < 220; i++) {
    const r2 = Math.sqrt(rng.next()) * 112, a = rng.range(0, 6.3), x = 128 + Math.cos(a) * r2, y = 128 + Math.sin(a) * r2, s = rng.range(5, 13);
    const l = 120 + rng.int(0, 135) * (1 - r2 / 200);
    g.fillStyle = `rgb(${l},${l * 0.92 | 0},${l * 0.85 | 0})`;
    g.save(); g.translate(x, y); g.rotate(rng.range(0, 6.28)); g.beginPath(); g.ellipse(0, 0, s, s * 0.42, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = `rgba(40,30,25,0.5)`; g.lineWidth = 0.8; g.beginPath(); g.moveTo(-s, 0); g.lineTo(s, 0); g.stroke(); g.restore();
  }
  cache.leafB = cardTex(c);
  return cache.leafB;
}

export function burntMetal() {
  if (cache.burnt) return cache.burnt;
  const S = 256;
  cache.burnt = genPBR(S, (u, v, x, y, o) => {
    const n = tn(u, v, 3, 4, 211), fine = tn(u, v, 20, 3, 212), f = hash2(x, y, 213), ash = tn(u, v, 9, 3, 214);
    const rust = clamp(0.5 + (n - 0.5) * 0.9 + (fine - 0.5) * 0.7, 0, 1);
    const cr = 0.035 + f * 0.015, rr = 0.15 + fine * 0.06, rg = 0.065 + fine * 0.025;
    let r = cr + (rr - cr) * rust, g = cr * 0.95 + (rg - cr * 0.95) * rust, b = cr * 0.9 + (0.03 - cr * 0.9) * rust;
    const a = clamp((ash - 0.68) * 3, 0, 1) * 0.5;
    o.r = r * (1 - a) + 0.26 * a; o.g = g * (1 - a) + 0.25 * a; o.b = b * (1 - a) + 0.24 * a;
    o.h = 0.5 + fine * 0.35 + f * 0.15; o.ro = 0.72 + rust * 0.2 + f * 0.06; o.m = 0.25 * (1 - rust);
  }, 3.0, { metal: true });
  return cache.burnt;
}

// Distant facade atlas: 4 bays x 4 floors per tile, window frames, some lit/broken/boarded.
// Returns { map, normalMap, roughnessMap, emissiveMap }.
export function facade(style = 'concrete') {
  const k = 'facade_' + style;
  if (cache[k]) return cache[k];
  const S = 512, BX = 4, BY = 4, rng = new RNG(hashKind(style));
  const cells = [];
  for (let j = 0; j < BY; j++) for (let i = 0; i < BX; i++) cells.push(rng.weighted([['dark', 8], ['lit', 3], ['litCold', 1.4], ['broken', 2], ['boarded', 1], ['wall', 1]]));
  const base = style === 'brick' ? [0.3, 0.15, 0.1] : style === 'plaster' ? [0.42, 0.38, 0.32] : [0.34, 0.33, 0.31];
  const em = new Float32Array(S * S * 3);
  const tex = genPBR(S, (u, v, x, y, o) => {
    const fx = u * BX, fy = v * BY, ci = Math.floor(fx), cj = Math.floor(fy), lx = fx - ci, ly = fy - cj;
    const cell = cells[cj * BX + ci];
    const n = tn(u, v, 4, 4, 221), f = hash2(x, y, 222);
    const streak = vnoise(u * 60, v * 3, 223, 60) * 0.5;
    const winX = lx > 0.2 && lx < 0.8, winY = ly > 0.22 && ly < 0.78;
    const frame = winX && winY && (lx < 0.24 || lx > 0.76 || ly < 0.26 || ly > 0.74 || Math.abs(lx - 0.5) < 0.015);
    const sill = winX && ly > 0.78 && ly < 0.82;
    const band = ly < 0.05;
    let r = base[0], g = base[1], b = base[2];
    if (style === 'brick' && !band) { const row = Math.floor(v * 128), off = row % 2 ? 0.5 : 0; const bx = (u * 32 + off) % 1; if (bx < 0.08 || (v * 128) % 1 < 0.15) { r = g = b = 0.2; } else { const id = hash2(Math.floor(u * 32 + off), row, 5); r *= 0.8 + id * 0.4; g *= 0.8 + id * 0.4; b *= 0.8 + id * 0.4; } }
    const k2 = (0.85 + n * 0.3) * (1 - streak * 0.5);
    r *= k2; g *= k2; b *= k2;
    o.h = 0.6 + n * 0.1; o.ro = 0.9;
    let e = [0, 0, 0];
    if (band) { r = g = b = 0.32 * k2; o.h = 0.8; }
    if (winX && winY && cell !== 'wall' && !frame) {
      o.h = 0.1; o.ro = 0.2;
      if (cell === 'boarded') { const p = (lx * 6) % 1; r = 0.2 + p * 0.06; g = 0.14 + p * 0.04; b = 0.09; o.ro = 0.9; o.h = 0.4 + p * 0.1; }
      else if (cell === 'lit' || cell === 'litCold') {
        const flick = 0.6 + 0.4 * vnoise(lx * 3, ly * 3, ci + cj * 7);
        const blind = (ly * 18) % 1 < 0.2 && hash2(ci, cj, 9) > 0.5 ? 0.5 : 1;
        e = cell === 'lit' ? [1.0 * flick * blind, 0.58 * flick * blind, 0.25 * flick * blind] : [0.35 * flick, 0.65 * flick, 0.9 * flick];
        r = g = b = 0.05;
      } else if (cell === 'broken') { const shard = hash2(Math.floor(lx * 9), Math.floor(ly * 7), ci * 13 + cj) > 0.6; r = g = b = shard ? 0.09 : 0.015; o.ro = shard ? 0.1 : 0.9; }
      else { const refl = 0.04 + (1 - ly) * 0.05 + f * 0.01; r = refl; g = refl * 1.05; b = refl * 1.15; }
    }
    if (frame && cell !== 'wall') { r = 0.08; g = 0.08; b = 0.085; o.h = 0.7; o.ro = 0.6; }
    if (sill && cell !== 'wall') { r *= 1.2; g *= 1.2; b *= 1.2; o.h = 0.9; }
    o.r = r; o.g = g; o.b = b;
    const i = (y * S + x) * 3; em[i] = e[0]; em[i + 1] = e[1]; em[i + 2] = e[2];
  }, 2.0);
  const ec = canvas(S), eg = ec.getContext('2d'), eid = eg.createImageData(S, S);
  for (let i = 0; i < S * S; i++) { eid.data[i * 4] = clamp(em[i * 3], 0, 1) * 255; eid.data[i * 4 + 1] = clamp(em[i * 3 + 1], 0, 1) * 255; eid.data[i * 4 + 2] = clamp(em[i * 3 + 2], 0, 1) * 255; eid.data[i * 4 + 3] = 255; }
  eg.putImageData(eid, 0, 0);
  tex.emissiveMap = toTex(ec, true);
  cache[k] = tex;
  return tex;
}

// Neon / shop sign atlas: 4 cols x 4 rows, each cell 256x128. map = dark backing + tubes, emissive = tubes.
export const SIGN_WORDS = [
  ['MOTEL', '#ff3070'], ['BAR', '#30e0ff'], ['24/7', '#ffd040'], ['PHARMACY', '#40ff80'],
  ['HOTEL', '#ff5030'], ['LIQUOR', '#ff40c0'], ['OPEN', '#ff3030'], ['PAWN', '#ffb020'],
  ['NOODLES', '#ff6040'], ['CLINIC', '#60c0ff'], ['GUNS', '#ff4020'], ['DINER', '#40f0d0'],
  ['+', '#30ff60'], ['FUEL', '#ff3040'], ['RADIO', '#a070ff'], ['GARAGE', '#ffa030'],
];
function mixWhite(hex, k) { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return `rgb(${r + (255 - r) * k | 0},${g + (255 - g) * k | 0},${b + (255 - b) * k | 0})`; }
export function signAtlas() {
  if (cache.signs) return cache.signs;
  const CW = 256, CH = 128, W = CW * 4, H = CH * 4;
  const c = canvas(W, H), g = c.getContext('2d'), ec = canvas(W, H), e = ec.getContext('2d'), rng = new RNG(4242);
  g.fillStyle = '#0a0a0c'; g.fillRect(0, 0, W, H); e.fillStyle = '#000'; e.fillRect(0, 0, W, H);
  SIGN_WORDS.forEach(([word, col], k) => {
    const cx = (k % 4) * CW, cy = Math.floor(k / 4) * CH;
    // backing board
    g.fillStyle = `rgb(${18 + rng.int(0, 14)},${18 + rng.int(0, 10)},${20 + rng.int(0, 10)})`; g.fillRect(cx + 4, cy + 4, CW - 8, CH - 8);
    g.strokeStyle = '#2a2a2e'; g.lineWidth = 6; g.strokeRect(cx + 7, cy + 7, CW - 14, CH - 14);
    for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(${90 + rng.int(0, 40)},${40 + rng.int(0, 20)},20,${rng.range(0.1, 0.4)})`; g.fillRect(cx + rng.range(4, CW - 10), cy + rng.range(4, CH - 10), rng.range(2, 10), rng.range(2, 8)); }
    const fs = word.length > 6 ? 46 : word.length > 4 ? 58 : 72;
    for (const ctx of [g, e]) {
      ctx.save(); ctx.font = `bold ${fs}px "Arial Black", Impact, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round'; ctx.strokeStyle = col; ctx.lineWidth = 5; ctx.shadowColor = col; ctx.shadowBlur = ctx === e ? 14 : 4;
      if (word === '+') { ctx.lineWidth = 16; ctx.beginPath(); ctx.moveTo(cx + 128, cy + 22); ctx.lineTo(cx + 128, cy + 106); ctx.moveTo(cx + 86, cy + 64); ctx.lineTo(cx + 170, cy + 64); ctx.stroke(); }
      else ctx.strokeText(word, cx + CW / 2, cy + CH / 2 + 2);
      ctx.shadowBlur = 0; ctx.strokeStyle = ctx === e ? mixWhite(col, 0.45) : col; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.8;
      if (word !== '+') ctx.strokeText(word, cx + CW / 2, cy + CH / 2 + 2);
      ctx.restore();
    }
    // dead tube segments
    e.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < rng.int(0, 2); i++) e.fillRect(cx + rng.range(20, CW - 60), cy + 10, rng.range(14, 40), CH - 20);
    e.globalCompositeOperation = 'source-over';
  });
  cache.signs = { map: toTex(c, true, false), emissiveMap: toTex(ec, true, false) };
  return cache.signs;
}

// Paper posters / bills atlas (4x2 cells), alpha-torn edges.
export function posterAtlas() {
  if (cache.posters) return cache.posters;
  const CW = 128, CH = 192, W = CW * 4, H = CH * 2, c = canvas(W, H), g = c.getContext('2d'), rng = new RNG(777);
  const heads = ['WANTED', 'MISSING', 'OBEY', 'VOTE', 'EVACUATE', 'RATIONS', 'REWARD', 'NO ENTRY'];
  for (let k = 0; k < 8; k++) {
    const cx = (k % 4) * CW, cy = Math.floor(k / 4) * CH;
    const paper = rng.pick(['#cfc6ae', '#d8cca0', '#b8b4a8', '#c89a6a', '#a8382c', '#d0c8b8']);
    g.fillStyle = paper; g.fillRect(cx + 6, cy + 6, CW - 12, CH - 12);
    g.fillStyle = paper === '#a8382c' ? '#f0e8d8' : '#1a1612';
    g.font = 'bold 22px Impact, "Arial Black", sans-serif'; g.textAlign = 'center';
    g.fillText(heads[k], cx + CW / 2, cy + 34);
    if (k % 2 === 0) { g.fillStyle = 'rgba(20,18,14,0.75)'; g.fillRect(cx + 26, cy + 46, CW - 52, 70); g.fillStyle = 'rgba(200,190,170,0.4)'; g.beginPath(); g.arc(cx + CW / 2, cy + 72, 16, 0, 7); g.fill(); g.fillRect(cx + CW / 2 - 22, cy + 90, 44, 26); }
    else { g.beginPath(); g.fillStyle = 'rgba(20,18,14,0.8)'; g.arc(cx + CW / 2, cy + 82, 30, 0, 7); g.fill(); }
    g.fillStyle = 'rgba(20,18,14,0.6)';
    for (let l = 0; l < 5; l++) g.fillRect(cx + 18, cy + 130 + l * 9, CW - 36 - rng.range(0, 30), 4);
    // stains + tears
    for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(60,45,25,${rng.range(0.05, 0.25)})`; g.beginPath(); g.arc(cx + rng.range(6, CW - 6), cy + rng.range(6, CH - 6), rng.range(3, 16), 0, 7); g.fill(); }
    g.save(); g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 9; i++) { g.beginPath(); const ex = rng.chance(0.5) ? cx + rng.range(0, CW) : cx + (rng.chance(0.5) ? 6 : CW - 6); const ey = cy + rng.range(0, CH); g.moveTo(ex, ey); for (let q = 0; q < 5; q++) g.lineTo(ex + rng.range(-22, 22), ey + rng.range(-22, 22)); g.fill(); }
    g.restore();
  }
  const t = cardTex(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  cache.posters = t;
  return t;
}

// Rolling shutter / corrugated door: horizontal slats, rust, graffiti scuffs.
export function shutter() {
  if (cache.shutter) return cache.shutter;
  const S = 256;
  cache.shutter = genPBR(S, (u, v, x, y, o) => {
    const sl = (v * 24) % 1, groove = sl < 0.12;
    const n = tn(u, v, 4, 4, 231), r = tn(u, v, 8, 4, 232), f = hash2(x, y, 233);
    const rust = clamp((r + (1 - v) * 0.25 - 0.62) * 4, 0, 1);
    const b = groove ? 0.12 : 0.36 + n * 0.12 + Math.sin(sl * Math.PI) * 0.05;
    o.r = b * (1 - rust) + 0.26 * rust; o.g = b * 1.0 * (1 - rust) + 0.12 * rust; o.b = b * 1.04 * (1 - rust) + 0.06 * rust;
    o.h = groove ? 0.1 : 0.5 + Math.sin(sl * Math.PI) * 0.3; o.ro = 0.55 + rust * 0.4 + f * 0.05; o.m = 0.6 * (1 - rust);
  }, 3.0, { metal: true });
  return cache.shutter;
}

// Rooftop tar / gravel
export function roofing() {
  if (cache.roofing) return cache.roofing;
  const S = 512, rng = new RNG(245);
  const seams = crackMask(S, rng, 10, 2.2, 50);
  cache.roofing = genPBR(S, (u, v, x, y, o) => {
    const i = y * S + x;
    const n = tn(u, v, 4, 4, 241), f = hash2(x, y, 242), p = vnoise(u * 96, v * 96, 243, 96);
    const sheet = (Math.abs(((u * 3) % 1) - 0.5) < 0.004 || Math.abs(((v * 2) % 1) - 0.5) < 0.004) ? 1 : 0; // membrane overlaps
    const patch = tn(u, v, 3, 3, 246) > 0.64 ? 1 : 0;
    const wet = tn(u, v, 2, 3, 244) > 0.66;
    let b = 0.09 + n * 0.06 + (p > 0.72 ? 0.05 : 0) + (f - 0.5) * 0.03 - patch * 0.035 - sheet * 0.03 - seams[i] * 0.05;
    const moss = clamp((tn(u, v, 5, 3, 247) - 0.6) * 3, 0, 1);
    o.r = b * (1 - moss * 0.3); o.g = b * 0.98 + moss * 0.015; o.b = b * 0.94 * (1 - moss * 0.4);
    o.h = 0.4 + p * 0.35 + sheet * 0.3 - seams[i] * 0.4; o.ro = wet ? 0.45 : 0.95 - patch * 0.15;
  }, 2.0);
  return cache.roofing;
}

// Shipping container / painted sheet metal: vertical ribs, paint with rust bleeding down from the top
// edge and seams, faded stencil-ish blocks. 1 tile ~ 3 m with boxUV 0.33.
export function paintedSheet(key, paint) {
  const k = 'sheet_' + key;
  if (cache[k]) return cache[k];
  const S = 512, ribs = 12;
  cache[k] = genPBR(S, (u, v, x, y, o) => {
    const rp = (u * ribs) % 1, rib = Math.sin(rp * Math.PI * 2) * 0.5 + 0.5;
    const n = tn(u, v, 3, 4, 251), f = hash2(x, y, 252);
    const streak = vnoise(u * 90, v * 3, 253, 90) * vnoise(u * 20, v * 1.5, 254, 20);
    const topBleed = clamp((v - 0.72) * 3, 0, 1); // canvas v=0 is top after flip? genPBR v grows downward in canvas = up in UV
    const rustN = tn(u, v, 7, 4, 255);
    const rust = clamp((rustN - 0.66) * 5 + streak * 1.2 * (0.4 + topBleed) - 0.25, 0, 1);
    const fade = 0.85 + n * 0.25 - streak * 0.25;
    let r = paint[0] * fade, g = paint[1] * fade, b = paint[2] * fade;
    const dent = rib * 0.12;
    r *= 0.92 + dent; g *= 0.92 + dent; b *= 0.92 + dent;
    const rr = 0.2 + f * 0.07 + rustN * 0.08, rg = 0.085 + f * 0.03, rb = 0.04;
    o.r = r * (1 - rust) + rr * rust; o.g = g * (1 - rust) + rg * rust; o.b = b * (1 - rust) + rb * rust;
    o.h = rib * 0.7 + rust * 0.15 * f; o.ro = 0.5 + rust * 0.42 + streak * 0.1; o.m = 0.15 * (1 - rust);
  }, 3.5, { metal: true });
  return cache[k];
}
