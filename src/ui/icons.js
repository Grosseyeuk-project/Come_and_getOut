// Procedural item icons (side-profile weapon silhouettes, consumables) and UI surface textures
// (grain, brushed metal). Everything is drawn on canvas once and cached as data URLs.
import { RARITY } from '../combat/weapons.js';

const cache = new Map();
const cv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

// ---- weapon silhouettes: 240x90 design space, muzzle to the right ----
const P = (pts) => { const p = new Path2D(); pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); return p; };
const R = (x, y, w, h, r = 2) => { const p = new Path2D(); p.roundRect(x, y, w, h, r); return p; };
function shapes(base) {
  const metal = [], dark = [], wood = [], acc = [], lens = [], cut = [];
  if (base === 'rifle') {
    dark.push(P([[8, 33], [60, 29], [62, 29], [62, 49], [48, 51], [16, 63], [8, 63]]));
    metal.push(R(60, 26, 82, 21, 3), R(140, 28, 56, 16, 2), R(194, 33, 30, 5, 1), R(220, 30, 14, 11, 2), R(70, 21, 110, 5, 1));
    dark.push(R(94, 9, 34, 12, 3), P([[103, 46], [121, 46], [128, 74], [111, 79]]), P([[72, 46], [87, 46], [83, 71], [68, 69]]));
    lens.push(R(124, 11, 4, 8, 1));
    acc.push(R(142, 26, 52, 3, 1));
    for (let i = 0; i < 5; i++) cut.push(R(146 + i * 10, 33, 6, 6, 1));
  } else if (base === 'smg') {
    metal.push(R(66, 27, 96, 22, 3), R(160, 31, 38, 12, 2), R(196, 33, 12, 8, 1), R(84, 21, 60, 6, 1));
    dark.push(R(118, 49, 14, 38, 2), P([[80, 48], [95, 48], [91, 73], [76, 71]]), R(100, 15, 10, 7, 2));
    acc.push(R(66, 25, 50, 3, 1));
    cut.push(R(166, 34, 26, 3, 1), R(166, 39, 26, 2, 1));
  } else if (base === 'shotgun') {
    wood.push(P([[6, 35], [70, 32], [74, 38], [74, 52], [60, 55], [14, 67], [6, 65]]), R(138, 37, 48, 12, 3));
    dark.push(R(70, 27, 50, 24, 3));
    metal.push(R(118, 27, 116, 8, 2), R(118, 37, 84, 7, 2), R(228, 25, 5, 3, 1));
    acc.push(R(72, 25, 44, 3, 1));
    for (let i = 0; i < 4; i++) cut.push(R(143 + i * 11, 39, 3, 8, 1));
  } else {
    dark.push(P([[4, 31], [66, 29], [66, 51], [52, 53], [12, 65], [4, 65]]));
    cut.push(new Path2D('M22 44 a10 6 0 1 0 20 -1 a10 6 0 1 0 -20 1'));
    metal.push(R(64, 27, 88, 20, 3), R(150, 29, 48, 15, 2), R(196, 34, 40, 4, 1), R(232, 31, 8, 10, 2));
    dark.push(R(86, 10, 56, 9, 3), R(76, 7, 14, 15, 3), R(138, 6, 18, 17, 3), R(96, 18, 8, 9, 1), R(124, 18, 8, 9, 1), R(112, 47, 18, 20, 2), P([[76, 46], [91, 46], [87, 69], [72, 67]]));
    lens.push(R(152, 8, 4, 13, 1));
    acc.push(R(152, 27, 44, 3, 1));
  }
  return { metal, dark, wood, acc, lens, cut };
}

function drawWeapon(g, base, color, W, H) {
  const s = Math.min(W / 244, H / 92); g.save();
  g.translate((W - 244 * s) / 2, (H - 92 * s) / 2 + 2 * s); g.scale(s, s);
  const sh = shapes(base);
  const all = [...sh.metal, ...sh.dark, ...sh.wood];
  // drop shadow + rarity rim glow
  g.save(); g.shadowColor = color; g.shadowBlur = 14; g.fillStyle = 'rgba(0,0,0,0.9)'; g.translate(0, 0);
  for (const p of all) g.fill(p); g.restore();
  const grad = (a, b) => { const gr = g.createLinearGradient(0, 6, 0, 80); gr.addColorStop(0, a); gr.addColorStop(0.5, b); gr.addColorStop(1, a); return gr; };
  g.fillStyle = grad('#9d988d', '#e6e1d4'); for (const p of sh.metal) g.fill(p);
  g.fillStyle = grad('#4e4c48', '#8a867c'); for (const p of sh.dark) g.fill(p);
  g.fillStyle = grad('#6a4026', '#b5794a'); for (const p of sh.wood) g.fill(p);
  // cut-outs (vents, thumbhole)
  g.globalCompositeOperation = 'destination-out'; for (const p of sh.cut) g.fill(p); g.globalCompositeOperation = 'source-over';
  // edge highlight + outline
  g.lineWidth = 1.2; g.strokeStyle = 'rgba(20,18,16,0.85)'; for (const p of all) g.stroke(p);
  g.fillStyle = color; g.shadowColor = color; g.shadowBlur = 6; for (const p of sh.acc) g.fill(p);
  g.shadowBlur = 0; g.fillStyle = '#9ad8ff'; for (const p of sh.lens) g.fill(p);
  // scratches
  g.globalAlpha = 0.25; g.strokeStyle = '#2a2824'; g.lineWidth = 0.8;
  let h = base.length * 977; const rnd = () => ((h = (h * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 14; i++) { const x = 60 + rnd() * 140, y = 28 + rnd() * 16; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 3 + rnd() * 8, y + (rnd() - 0.5) * 3); g.stroke(); }
  g.restore();
}

function drawConsumable(g, kind, W, H) {
  const s = Math.min(W, H) / 100; g.save(); g.translate(W / 2 - 50 * s, H / 2 - 50 * s); g.scale(s, s);
  g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 8;
  if (kind === 'medkit') {
    g.fillStyle = '#d9d4c6'; g.beginPath(); g.roundRect(14, 30, 72, 50, 6); g.fill(); g.shadowBlur = 0;
    g.fillStyle = '#7a756a'; g.fillRect(38, 22, 24, 9); g.fillStyle = '#d9d4c6'; g.fillRect(42, 25, 16, 6);
    g.fillStyle = '#e0352a'; g.fillRect(44, 38, 12, 34); g.fillRect(33, 49, 34, 12);
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(14, 70, 72, 10);
  } else if (kind === 'ammo') {
    g.fillStyle = '#5d6b3c'; g.beginPath(); g.roundRect(12, 40, 76, 42, 4); g.fill(); g.shadowBlur = 0;
    g.fillStyle = '#48542d'; g.fillRect(12, 40, 76, 9);
    g.fillStyle = '#e8b53a'; g.font = 'bold 13px sans-serif'; g.fillText('7.62', 34, 72);
    for (let i = 0; i < 5; i++) { const x = 22 + i * 12; g.fillStyle = '#c9a050'; g.fillRect(x, 20, 8, 20); g.fillStyle = '#8a6a30'; g.beginPath(); g.moveTo(x, 20); g.lineTo(x + 4, 10); g.lineTo(x + 8, 20); g.fill(); }
  } else {
    g.fillStyle = '#a8a59c'; g.beginPath();
    for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2, r = i % 2 ? 26 : 34; g.lineTo(42 + Math.cos(a) * r, 52 + Math.sin(a) * r); }
    g.closePath(); g.fill(); g.shadowBlur = 0; g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(42, 52, 11, 0, 7); g.fill(); g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#c87a3a'; g.beginPath(); g.roundRect(64, 18, 12, 40, 2); g.fill(); g.fillStyle = '#8f5428'; g.fillRect(60, 18, 20, 8);
  }
  g.restore();
}

// Returns a data URL for an item icon. size: [w, h] in CSS px (rendered at 2x).
export function itemIcon(it, w = 120, h = 46) {
  const kind = it.kind === 'weapon' ? it.base : it.kind, key = `${kind}|${it.rarity}|${w}x${h}`;
  if (cache.has(key)) return cache.get(key);
  const c = cv(w * 2, h * 2), g = c.getContext('2d');
  if (it.kind === 'weapon') drawWeapon(g, it.base, RARITY[it.rarity].color, c.width, c.height); else drawConsumable(g, it.kind, c.width, c.height);
  const url = c.toDataURL(); cache.set(key, url); return url;
}

// Grain + brushed-metal + rust swatches for CSS panel backgrounds.
export function surfaces() {
  if (cache.has('surf')) return cache.get('surf');
  const n = cv(160, 160), g = n.getContext('2d'), id = g.createImageData(160, 160);
  for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 14 + Math.random() * 16; }
  g.putImageData(id, 0, 0);
  const m = cv(512, 256), x = m.getContext('2d');
  x.fillStyle = '#1b1a18'; x.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 900; i++) { const y = Math.random() * 256; x.strokeStyle = `rgba(${Math.random() < 0.5 ? '255,240,220' : '0,0,0'},${0.015 + Math.random() * 0.03})`; x.beginPath(); x.moveTo(Math.random() * 512 - 60, y); x.lineTo(Math.random() * 512 + 60, y + (Math.random() - 0.5) * 2); x.stroke(); }
  for (let i = 0; i < 26; i++) { // rust / grime blotches
    const px = Math.random() * 512, py = Math.random() * 256, r = 10 + Math.random() * 60;
    const gr = x.createRadialGradient(px, py, 0, px, py, r); gr.addColorStop(0, `rgba(${Math.random() < 0.4 ? '120,60,25' : '0,0,0'},${0.06 + Math.random() * 0.08})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr; x.fillRect(px - r, py - r, r * 2, r * 2);
  }
  for (let i = 0; i < 40; i++) { x.strokeStyle = `rgba(255,245,230,${0.03 + Math.random() * 0.05})`; x.lineWidth = 0.6; const px = Math.random() * 512, py = Math.random() * 256; x.beginPath(); x.moveTo(px, py); x.lineTo(px + (Math.random() - 0.5) * 40, py + (Math.random() - 0.5) * 12); x.stroke(); }
  const out = { grain: n.toDataURL(), metal: m.toDataURL('image/jpeg', 0.85) };
  cache.set('surf', out); return out;
}

// Stencil logo "COME AND GET OUT": condensed caps, stencil bridges, spray grain, chipped edges.
export function logo(w = 760, h = 300) {
  const c = cv(w * 2, h * 2), g = c.getContext('2d'), W = c.width, H = c.height;
  const font = (px) => `900 ${px}px "Bahnschrift", "DIN Condensed", "Oswald", Inter, "Arial Black", sans-serif`;
  const line = (txt, y, px, color, sx) => {
    g.save(); g.font = font(px); const mw = g.measureText(txt).width; g.translate(8, y); g.scale(sx, 1);
    g.fillStyle = color; g.fillText(txt, 0, 0); g.restore(); return mw * sx;
  };
  g.textBaseline = 'alphabetic';
  // small top line
  g.save(); g.font = font(64); g.fillStyle = '#d8cfbd'; g.translate(12, 96); g.scale(0.92, 1);
  const top = 'COME  AND'; let x0 = 0; for (const ch of top) { g.fillText(ch, x0, 0); x0 += g.measureText(ch).width + 18; } g.restore();
  // hazard bar under the top line
  g.save(); g.beginPath(); g.rect(12, 116, W * 0.55, 18); g.clip(); g.fillStyle = '#e8a630'; g.fillRect(12, 116, W, 18); g.fillStyle = '#16130f';
  for (let i = -2; i < 60; i++) { g.beginPath(); g.moveTo(12 + i * 36, 134); g.lineTo(30 + i * 36, 116); g.lineTo(48 + i * 36, 116); g.lineTo(30 + i * 36, 134); g.fill(); }
  g.restore();
  const gw = line('GET OUT', H * 0.88, H * 0.62, '#f0a13a', 0.86);
  // stencil bridges: vertical + horizontal knock-outs through the big letters
  g.globalCompositeOperation = 'destination-out';
  g.fillRect(0, H * 0.88 - H * 0.62 * 0.42, gw + 30, 7);
  for (let x = 40; x < gw; x += 63) g.fillRect(x + ((x * 7) % 13), H * 0.88 - H * 0.62 * 0.76, 5, H * 0.62 * 0.3);
  // chips and spray speckle
  for (let i = 0; i < 2600; i++) { const r = Math.random() ** 3 * 5 + 0.5; g.globalAlpha = 0.25 + Math.random() * 0.75; g.beginPath(); g.arc(Math.random() * W, Math.random() * H, r, 0, 7); g.fill(); }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-atop';
  // vertical grime gradient
  const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(60,20,0,0.35)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  return c;
}
