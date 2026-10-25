// Weapon definitions, rarity tiers, randomized item rolls and procedural weapon models.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RNG } from '../core/rng.js';

export const RARITIES = [
  { key: 'common', name: 'Common', color: '#b8b8b0', hex: 0xb8b8b0, mult: 1.0, affixes: 0, beam: 2.2 },
  { key: 'uncommon', name: 'Uncommon', color: '#5fd35a', hex: 0x4fdc4a, mult: 1.12, affixes: 1, beam: 3.2 },
  { key: 'rare', name: 'Rare', color: '#3f9bff', hex: 0x3a8cff, mult: 1.26, affixes: 1, beam: 5 },
  { key: 'epic', name: 'Epic', color: '#b45cff', hex: 0xa850ff, mult: 1.42, affixes: 2, beam: 7 },
  { key: 'legendary', name: 'Legendary', color: '#ff9a1f', hex: 0xff8a10, mult: 1.62, affixes: 3, beam: 10 },
];
export const RARITY = Object.fromEntries(RARITIES.map((r, i) => [r.key, { ...r, tier: i }]));

export const BASES = {
  rifle: { name: 'Assault Rifle', short: 'AR', dmg: 13, rpm: 620, mag: 30, reload: 1.9, spread: 2.6, pellets: 1, range: 40, auto: true, ammo: 'light', recoil: 0.35, shake: 0.12, sound: 'rifle', muzzle: 0.66, fore: 0.3 },
  smg: { name: 'SMG', short: 'SMG', dmg: 8.5, rpm: 920, mag: 36, reload: 1.5, spread: 5.0, pellets: 1, range: 28, auto: true, ammo: 'light', recoil: 0.25, shake: 0.08, sound: 'smg', muzzle: 0.46, fore: 0.22 },
  shotgun: { name: 'Shotgun', short: 'SG', dmg: 10, rpm: 78, mag: 6, reload: 2.4, spread: 13, pellets: 9, range: 17, auto: false, ammo: 'shells', recoil: 1.0, shake: 0.35, sound: 'shotgun', muzzle: 0.74, fore: 0.34 },
  dmr: { name: 'Marksman Rifle', short: 'DMR', dmg: 46, rpm: 170, mag: 10, reload: 2.2, spread: 0.5, pellets: 1, range: 55, auto: false, ammo: 'heavy', recoil: 0.8, shake: 0.22, sound: 'dmr', muzzle: 0.86, fore: 0.36, pierce: 1 },
};
const MODEL_NAMES = { rifle: ['AR-7 Kestrel', 'M4 Scrapper', 'Vulture-9', 'Ironhide AR'], smg: ['Wasp', 'Rattler-45', 'Hornet SMG', 'Gutter Rat'], shotgun: ['Boomstick', 'Doorkicker', 'Mauler-12', 'Sawn Widow'], dmr: ['Longwatch', 'Hawkeye M14', 'Spectre DMR', 'Pale Rider'] };
const AFFIXES = [
  { k: 'dmg', label: '+{v}% damage', roll: (r) => r.int(8, 22), apply: (s, v) => (s.dmg *= 1 + v / 100) },
  { k: 'rpm', label: '+{v}% fire rate', roll: (r) => r.int(8, 20), apply: (s, v) => (s.rpm *= 1 + v / 100) },
  { k: 'mag', label: '+{v}% magazine', roll: (r) => r.int(20, 50), apply: (s, v) => (s.mag = Math.round(s.mag * (1 + v / 100))) },
  { k: 'reload', label: '{v}% faster reload', roll: (r) => r.int(15, 35), apply: (s, v) => (s.reload *= 1 - v / 100) },
  { k: 'crit', label: '+{v}% crit chance', roll: (r) => r.int(6, 16), apply: (s, v) => (s.crit += v / 100) },
  { k: 'spread', label: '{v}% tighter spread', roll: (r) => r.int(15, 35), apply: (s, v) => (s.spread *= 1 - v / 100) },
];
const PREFIX = { common: ['Rusty', 'Worn', 'Scrap'], uncommon: ['Reliable', 'Tuned', 'Militia'], rare: ['Veteran', 'Hardened', 'Precise'], epic: ['Vicious', 'Warlord\'s', 'Blackened'], legendary: ['Hellfire', 'Last Light', 'Wasteland King\'s'] };

let uid = 1;
export function rollWeapon(rng, rarityKey = 'common', baseKey = null) {
  const R = RARITY[rarityKey];
  const base = baseKey || rng.pick(Object.keys(BASES));
  const B = BASES[base];
  const s = { dmg: B.dmg * R.mult * rng.range(0.94, 1.06), rpm: B.rpm * rng.range(0.96, 1.04), mag: B.mag, reload: B.reload, spread: B.spread, crit: 0.05, pellets: B.pellets, range: B.range };
  const pool = rng.shuffle(AFFIXES.slice());
  const affixes = [];
  for (let i = 0; i < R.affixes; i++) { const a = pool[i]; const v = a.roll(rng); a.apply(s, v); affixes.push(a.label.replace('{v}', v)); }
  const item = {
    id: uid++, kind: 'weapon', base, rarity: rarityKey,
    name: `${rng.pick(PREFIX[rarityKey])} ${rng.pick(MODEL_NAMES[base])}`,
    stats: s, affixes, mag: s.mag, cooldown: 0, reloadT: 0,
  };
  item.dps = dps(item);
  item.value = Math.round(item.dps * (1 + R.tier * 0.6));
  return item;
}
export function dps(item) { const s = item.stats; return Math.round(s.dmg * s.pellets * (s.rpm / 60) * (1 + s.crit)); }

export function makeConsumable(kind, rarity = 'common', amount = 1) {
  const names = { medkit: 'Field Medkit', ammo: 'Ammo Cache', scrap: 'Salvage' };
  return { id: uid++, kind, rarity, name: names[kind], amount, value: kind === 'scrap' ? amount : 10 };
}

// ---------- models ----------
const modelMats = {};
function mats() {
  if (modelMats.dark) return modelMats;
  modelMats.dark = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.45, metalness: 0.8 });
  modelMats.poly = new THREE.MeshStandardMaterial({ color: 0x2c2b28, roughness: 0.8, metalness: 0.1 });
  modelMats.wood = new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.7 });
  modelMats.glass = new THREE.MeshStandardMaterial({ color: 0x102030, roughness: 0.05, metalness: 0.5, emissive: 0x0a2030 });
  for (const r of RARITIES) modelMats['acc_' + r.key] = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: r.hex, emissiveIntensity: 2.5 });
  return modelMats;
}
const modelCache = {};
export function weaponModel(base, rarity = 'common') {
  const key = base + rarity;
  const M = mats();
  if (!modelCache[key]) {
    const parts = { dark: [], poly: [], wood: [], glass: [], acc: [] };
    const bx = (k, w, h, d, x, y, z, rx = 0, r = 0.01) => { const g = new RoundedBoxGeometry(w, h, d, 1, Math.min(r, w / 2.2, h / 2.2, d / 2.2)); if (rx) g.rotateX(rx); g.translate(x, y, z); parts[k].push(g); };
    const cy = (k, r, l, x, y, z, seg = 10) => { const g = new THREE.CylinderGeometry(r, r, l, seg); g.rotateX(Math.PI / 2); g.translate(x, y, z); parts[k].push(g); };
    if (base === 'rifle') {
      bx('dark', 0.055, 0.09, 0.42, 0, 0.02, 0.12); cy('dark', 0.012, 0.3, 0, 0.035, 0.5); bx('poly', 0.06, 0.065, 0.22, 0, 0.03, 0.36);
      bx('poly', 0.04, 0.16, 0.07, 0, -0.08, 0.14, 0.25); bx('poly', 0.035, 0.1, 0.05, 0, -0.07, -0.02, -0.3);
      bx('poly', 0.045, 0.085, 0.24, 0, 0.0, -0.2); cy('dark', 0.022, 0.16, 0, 0.11, 0.1); cy('glass', 0.018, 0.005, 0, 0.11, 0.185);
      cy('dark', 0.02, 0.06, 0, 0.035, 0.66); bx('acc', 0.062, 0.012, 0.18, 0, 0.068, 0.36);
    } else if (base === 'smg') {
      bx('dark', 0.05, 0.08, 0.3, 0, 0.02, 0.08); cy('dark', 0.014, 0.12, 0, 0.03, 0.29); bx('poly', 0.03, 0.18, 0.045, 0, -0.1, 0.12);
      bx('poly', 0.035, 0.1, 0.05, 0, -0.07, -0.03, -0.3); bx('dark', 0.03, 0.04, 0.16, 0, 0.02, -0.15); bx('poly', 0.04, 0.05, 0.1, 0, -0.04, 0.24);
      cy('dark', 0.02, 0.1, 0, 0.03, 0.4); bx('acc', 0.052, 0.01, 0.12, 0, 0.062, 0.12);
    } else if (base === 'shotgun') {
      cy('dark', 0.019, 0.55, 0, 0.04, 0.42); cy('dark', 0.016, 0.45, 0, 0.0, 0.38); bx('wood', 0.06, 0.06, 0.18, 0, 0.0, 0.36);
      bx('dark', 0.055, 0.085, 0.24, 0, 0.02, 0.03); bx('wood', 0.04, 0.1, 0.05, 0, -0.07, -0.08, -0.3); bx('wood', 0.05, 0.09, 0.28, 0, -0.01, -0.26);
      bx('acc', 0.062, 0.012, 0.1, 0, 0.068, 0.04);
    } else {
      bx('dark', 0.055, 0.09, 0.48, 0, 0.02, 0.14); cy('dark', 0.013, 0.5, 0, 0.035, 0.62); bx('poly', 0.03, 0.12, 0.08, 0, -0.07, 0.14, 0.15);
      bx('poly', 0.035, 0.1, 0.05, 0, -0.07, -0.02, -0.3); bx('poly', 0.05, 0.1, 0.26, 0, 0.0, -0.22); cy('dark', 0.028, 0.26, 0, 0.12, 0.14); cy('glass', 0.025, 0.005, 0, 0.12, 0.275);
      cy('dark', 0.022, 0.07, 0, 0.035, 0.86); bx('acc', 0.06, 0.012, 0.2, 0, 0.07, 0.4);
    }
    const out = [];
    for (const [k, list] of Object.entries(parts)) {
      if (!list.length) continue;
      const geo = mergeGeometries(list.map((g) => { const n = g.index ? g.toNonIndexed() : g; for (const a of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(a)) n.deleteAttribute(a); return n; }), false);
      out.push({ geo, mat: k === 'acc' ? M['acc_' + rarity] : M[k] });
    }
    modelCache[key] = out;
  }
  const g = new THREE.Group();
  for (const p of modelCache[key]) { const m = new THREE.Mesh(p.geo, p.mat); m.castShadow = true; m.userData.shared = true; g.add(m); }
  g.userData.muzzle = BASES[base].muzzle; g.userData.foregrip = BASES[base].fore;
  return g;
}
