// Seeded layout generation for a ruined city district. Produces a pure-data description
// (roads, blocks, buildings, props, lights) that environment.js turns into meshes + colliders.
// populate() runs afterwards (needs the nav grid) to place spawn, extraction, enemies and loot.
import { RNG } from '../core/rng.js';
import { PALETTES } from './lighting.js';

export const HALF = 72;
export const OUTER = 46; // visual-only city ring beyond the playable square
const SIDEWALK = 2.4;

// District themes: each seed rolls one; it biases block types, building stock, signage and clutter so
// seeds read as different parts of the city (neon strip, industrial docks, tenements, front line).
export const THEMES = {
  strip: { name: 'Neon Strip', types: [['buildings', 64], ['collapsed', 8], ['park', 5], ['parking', 10], ['camp', 8], ['yard', 3]], styles: [['plaster', 3], ['concrete', 4], ['brick', 2]], floors: [[2, 3], [3, 4], [4, 3], [5, 2]], neon: 1.6, shop: 0.8, burnt: 0.25, war: 0.3, trees: 0.4 },
  industrial: { name: 'Freight Yards', types: [['buildings', 34], ['collapsed', 10], ['park', 4], ['parking', 12], ['camp', 10], ['yard', 30]], styles: [['concrete', 5], ['brick', 4], ['plaster', 1]], floors: [[1, 3], [2, 4], [3, 2]], neon: 0.5, shop: 0.25, burnt: 0.35, war: 0.5, trees: 0.3 },
  tenements: { name: 'Tenements', types: [['buildings', 56], ['collapsed', 12], ['park', 16], ['parking', 6], ['camp', 8], ['yard', 2]], styles: [['brick', 5], ['plaster', 4], ['concrete', 1]], floors: [[2, 2], [3, 4], [4, 4], [5, 2]], neon: 0.9, shop: 0.5, burnt: 0.3, war: 0.4, trees: 1.0 },
  frontline: { name: 'Front Line', types: [['buildings', 36], ['collapsed', 30], ['park', 8], ['parking', 6], ['camp', 16], ['yard', 4]], styles: [['concrete', 4], ['brick', 4], ['plaster', 2]], floors: [[1, 3], [2, 4], [3, 3], [4, 1]], neon: 0.4, shop: 0.3, burnt: 0.6, war: 1.0, trees: 0.6 },
};

export function generateLayout(seed) {
  const rng = new RNG(seed);
  const forced = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('palette') : null;
  const L = { seed, half: HALF, palette: rng.pick(Object.keys(PALETTES)), roads: [], sidewalks: [], blocks: [], buildings: [], props: [], decals: [], lamps: [], grassAreas: [], poles: [] };

  const mk = (r) => {
    const out = []; let p = -HALF + r.range(14, 24);
    while (p < HALF - 16) { const main = r.chance(0.45); out.push({ p, w: main ? r.range(9, 11) : r.range(6.5, 8) }); p += r.range(25, 36); }
    return out;
  };
  const rx = mk(rng.fork('rx')), rz = mk(rng.fork('rz'));
  // optionally drop a road segment entirely to create larger superblocks (variety per seed)
  for (const r of rx) L.roads.push({ axis: 'z', x: r.p, w: r.w, z0: -HALF - OUTER, z1: HALF + OUTER });
  for (const r of rz) L.roads.push({ axis: 'x', z: r.p, w: r.w, x0: -HALF - OUTER, x1: HALF + OUTER });
  L.roadsX = rx; L.roadsZ = rz;
  if (forced && PALETTES[forced]) L.palette = forced;
  const ft = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('theme') : null;
  L.theme = THEMES[ft] ? ft : rng.fork('theme').pick(Object.keys(THEMES));
  const TH = L.themeDef = THEMES[L.theme];

  const intervals = (roads) => {
    const iv = []; let a = -HALF - 6;
    for (const r of roads) { iv.push([a, r.p - r.w / 2 - SIDEWALK]); a = r.p + r.w / 2 + SIDEWALK; }
    iv.push([a, HALF + 6]);
    return iv.filter(([x0, x1]) => x1 - x0 > 6);
  };
  const ix = intervals(rx), iz = intervals(rz);

  // sidewalks (strips along both sides of each road, full length)
  const E = HALF + OUTER;
  for (const r of rx) { L.sidewalks.push({ x0: r.p - r.w / 2 - SIDEWALK, x1: r.p - r.w / 2, z0: -E, z1: E }); L.sidewalks.push({ x0: r.p + r.w / 2, x1: r.p + r.w / 2 + SIDEWALK, z0: -E, z1: E }); }
  for (const r of rz) { L.sidewalks.push({ z0: r.p - r.w / 2 - SIDEWALK, z1: r.p - r.w / 2, x0: -E, x1: E }); L.sidewalks.push({ z0: r.p + r.w / 2, z1: r.p + r.w / 2 + SIDEWALK, x0: -E, x1: E }); }

  // blocks
  const types = TH.types;
  let campCount = 0;
  for (const [x0, x1] of ix) for (const [z0, z1] of iz) {
    const edge = x0 < -HALF || x1 > HALF || z0 < -HALF || z1 > HALF;
    const b = { x0: Math.max(x0, -HALF - 6), x1: Math.min(x1, HALF + 6), z0: Math.max(z0, -HALF - 6), z1: Math.min(z1, HALF + 6), edge };
    let t = rng.weighted(types);
    if (edge && (t === 'camp')) t = 'buildings';
    if (t === 'camp') campCount++;
    b.type = t; L.blocks.push(b);
  }
  if (campCount < 2) { // guarantee some raider camps
    const inner = L.blocks.filter((b) => !b.edge && b.type !== 'camp');
    rng.shuffle(inner).slice(0, 2 - campCount).forEach((b) => (b.type = 'camp'));
  }

  for (const b of L.blocks) fillBlock(L, b, rng.fork('b' + b.x0 + ',' + b.z0));
  decorateRoads(L, rng.fork('roads'));
  buildOuterRing(L, rng.fork('outer'));
  return L;
}

function fillBlock(L, b, rng) {
  const w = b.x1 - b.x0, d = b.z1 - b.z0;
  const P = L.props;
  if (b.type === 'buildings' || b.type === 'collapsed') {
    const alongX = w >= d;
    const len = alongX ? w : d;
    const n = len > 34 ? rng.int(2, 3) : len > 20 ? rng.int(1, 2) : 1;
    const cuts = [0]; for (let i = 1; i < n; i++) cuts.push((i / n + rng.range(-0.08, 0.08)) * len); cuts.push(len);
    for (let i = 0; i < n; i++) {
      const a = cuts[i] + (i ? 1.4 : 0), c = cuts[i + 1] - (i < n - 1 ? 1.4 : 0);
      let lot = alongX ? { x0: b.x0 + a, x1: b.x0 + c, z0: b.z0, z1: b.z1 } : { x0: b.x0, x1: b.x1, z0: b.z0 + a, z1: b.z0 + c };
      // optionally split across the short axis too (back-to-back buildings with an alley)
      const lots = [];
      const sw = alongX ? lot.z1 - lot.z0 : lot.x1 - lot.x0;
      if (sw > 26 && rng.chance(0.6)) {
        const m = sw * rng.range(0.42, 0.58);
        if (alongX) { lots.push({ ...lot, z1: lot.z0 + m - 1.2 }); lots.push({ ...lot, z0: lot.z0 + m + 1.2 }); }
        else { lots.push({ ...lot, x1: lot.x0 + m - 1.2 }); lots.push({ ...lot, x0: lot.x0 + m + 1.2 }); }
      } else lots.push(lot);
      for (const lt of lots) {
        if (lt.x1 - lt.x0 < 7 || lt.z1 - lt.z0 < 7) continue;
        if (b.type === 'buildings' && rng.chance(0.1)) { // empty lot
          L.grassAreas.push({ ...lt, density: 0.7 });
          scatterRubble(P, lt, rng, 3);
          continue;
        }
        const ins = () => rng.range(0.2, 1.6);
        const f = { x0: lt.x0 + ins(), x1: lt.x1 - ins(), z0: lt.z0 + ins(), z1: lt.z1 - ins() };
        L.buildings.push({
          ...f,
          floors: b.edge ? rng.int(3, 6) : rng.weighted(L.themeDef.floors),
          style: rng.weighted(L.themeDef.styles),
          tint: rng.pick([0xffffff, 0xf0e6d8, 0xd8dcd8, 0xe8d0c0, 0xc8c0b0, 0xdcd4bc, 0xbfc8cc]),
          damage: b.type === 'collapsed' ? 1 : rng.range(0.15, 0.85),
          collapsed: b.type === 'collapsed',
          edge: b.edge,
          seed: rng.int(1, 1e9),
        });
      }
    }
  } else if (b.type === 'park') {
    L.grassAreas.push({ ...b, density: 1.3, ground: 'dirt' });
    const nt = Math.floor((w * d) / 110);
    for (let i = 0; i < nt; i++) P.push({ type: 'tree', x: rng.range(b.x0 + 2, b.x1 - 2), z: rng.range(b.z0 + 2, b.z1 - 2), s: rng.range(0.8, 1.4), dead: rng.chance(0.45), seed: rng.int(1, 1e9) });
    for (let i = 0; i < nt * 1.5; i++) P.push({ type: 'bush', x: rng.range(b.x0 + 1, b.x1 - 1), z: rng.range(b.z0 + 1, b.z1 - 1), s: rng.range(0.7, 1.5), seed: rng.int(1, 1e9) });
    for (let i = 0; i < rng.int(1, 4); i++) P.push({ type: 'bench', x: rng.range(b.x0 + 3, b.x1 - 3), z: rng.range(b.z0 + 3, b.z1 - 3), rot: rng.pick([0, Math.PI / 2]) + rng.range(-0.2, 0.2) });
    if (rng.chance(0.5)) P.push({ type: 'fire', x: (b.x0 + b.x1) / 2 + rng.range(-4, 4), z: (b.z0 + b.z1) / 2 + rng.range(-4, 4), s: 1.2, campfire: true });
    for (let i = 0; i < rng.int(1, 3); i++) P.push({ type: 'car', x: rng.range(b.x0 + 4, b.x1 - 4), z: rng.range(b.z0 + 4, b.z1 - 4), rot: rng.range(0, 6.28), variant: rng.weighted([[0, 3], [3, 2], [2, 1]]), paint: 0, burnt: true, seed: rng.int(1, 1e9) });
  } else if (b.type === 'parking') {
    L.decals.push({ kind: 'parkinglot', ...b });
    const alongX = w >= d;
    const rows = Math.max(1, Math.floor((alongX ? d : w) / 11));
    for (let r = 0; r < rows; r++) {
      const cross = (alongX ? b.z0 : b.x0) + 4 + r * 11;
      const span = alongX ? w : d;
      for (let s = 3; s < span - 3; s += 3) {
        if (!rng.chance(0.42)) continue;
        const along = (alongX ? b.x0 : b.x0) + s;
        const px = alongX ? b.x0 + s : cross, pz = alongX ? cross : b.z0 + s;
        P.push({ type: 'car', x: px + rng.range(-0.3, 0.3), z: pz + rng.range(-0.4, 0.4), rot: (alongX ? Math.PI / 2 : 0) + rng.range(-0.25, 0.25) + (rng.chance(0.5) ? Math.PI : 0), variant: rng.weighted([[0, 4], [3, 3], [1, 1], [2, 1]]), paint: rng.int(0, 8), burnt: rng.chance(0.25), seed: rng.int(1, 1e9) });
      }
    }
    for (let i = 0; i < 2; i++) P.push({ type: 'lamp', x: rng.range(b.x0 + 3, b.x1 - 3), z: rng.range(b.z0 + 3, b.z1 - 3), rot: rng.range(0, 6.28), working: rng.chance(0.6), bent: rng.chance(0.3) });
    L.grassAreas.push({ ...b, density: 0.25 });
    if (rng.chance(0.5)) P.push({ type: 'dumpster', x: b.x0 + 2, z: b.z0 + 2, rot: rng.range(-0.3, 0.3) });
  } else if (b.type === 'camp') {
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const R = Math.min(w, d) / 2 - 2.5;
    L.decals.push({ kind: 'dirtlot', ...b });
    // barricade ring with 2 gaps
    const gapA = rng.range(0, 6.28), gapB = gapA + Math.PI + rng.range(-0.6, 0.6);
    const segs = Math.floor((Math.PI * 2 * R) / 3.2);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const da = (x) => Math.abs(Math.atan2(Math.sin(a - x), Math.cos(a - x)));
      if (da(gapA) < 0.32 || da(gapB) < 0.32) continue;
      const kind = rng.weighted([['sandbags', 4], ['jersey', 3], ['planks', 2], ['tires', 1], ['container', 1]]);
      const rr = R * rng.range(0.85, 1.0);
      if (kind === 'container' && rng.chance(0.5)) { P.push({ type: 'container', x: cx + Math.cos(a) * rr, z: cz + Math.sin(a) * rr, rot: -a + Math.PI / 2, color: rng.int(0, 3) }); i += 2; continue; }
      P.push({ type: kind === 'container' ? 'sandbags' : kind, x: cx + Math.cos(a) * rr, z: cz + Math.sin(a) * rr, rot: -a + Math.PI / 2 + rng.range(-0.1, 0.1), len: 3 });
    }
    P.push({ type: 'fire', x: cx + rng.range(-2, 2), z: cz + rng.range(-2, 2), s: 1.4, campfire: true });
    for (let i = 0; i < rng.int(2, 4); i++) P.push({ type: 'barrel', x: cx + rng.range(-R + 3, R - 3), z: cz + rng.range(-R + 3, R - 3), burning: rng.chance(0.6) });
    for (let i = 0; i < rng.int(1, 3); i++) { const a = rng.range(0, 6.28), r = R * 0.55; P.push({ type: 'tent', x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, rot: -a + rng.range(-0.5, 0.5), seed: rng.int(1, 1e9) }); }
    if (rng.chance(0.7)) P.push({ type: 'container', x: cx + rng.range(-R * 0.4, R * 0.4), z: cz + rng.range(-R * 0.4, R * 0.4), rot: rng.range(0, 3.14), color: rng.int(0, 3) });
    P.push({ type: 'lightRig', x: cx + rng.range(-3, 3), z: cz + rng.range(-3, 3) });
    L.camps = L.camps || []; L.camps.push({ x: cx, z: cz, r: R });
    L.grassAreas.push({ ...b, density: 0.2 });
  } else if (b.type === 'yard') {
    L.decals.push({ kind: 'dirtlot', ...b });
    const n = rng.int(2, 5);
    for (let i = 0; i < n; i++) P.push({ type: 'container', x: rng.range(b.x0 + 4, b.x1 - 4), z: rng.range(b.z0 + 3, b.z1 - 3), rot: rng.pick([0, Math.PI / 2]) + rng.range(-0.15, 0.15), color: rng.int(0, 3), stacked: rng.chance(0.3) });
    for (let i = 0; i < rng.int(2, 6); i++) P.push({ type: 'barrel', x: rng.range(b.x0 + 2, b.x1 - 2), z: rng.range(b.z0 + 2, b.z1 - 2), burning: rng.chance(0.15) });
    for (let i = 0; i < rng.int(1, 3); i++) P.push({ type: 'fence', x: rng.range(b.x0 + 3, b.x1 - 3), z: rng.range(b.z0 + 3, b.z1 - 3), rot: rng.pick([0, Math.PI / 2]), len: rng.range(6, 12) });
    L.grassAreas.push({ ...b, density: 0.5 });
    scatterRubble(P, b, rng, 4);
  }
}

function scatterRubble(P, r, rng, n) {
  for (let i = 0; i < n; i++) P.push({ type: 'rubblePile', x: rng.range(r.x0 + 1.5, r.x1 - 1.5), z: rng.range(r.z0 + 1.5, r.z1 - 1.5), s: rng.range(0.8, 2.2), seed: rng.int(1, 1e9) });
}

function decorateRoads(L, rng) {
  const P = L.props;
  const xs = L.roadsX, zs = L.roadsZ;
  // segments between intersections
  const segs = [];
  for (const r of xs) { const cuts = [-HALF, ...zs.map((z) => z.p), HALF]; for (let i = 0; i < cuts.length - 1; i++) segs.push({ axis: 'z', c: r.p, w: r.w, a: cuts[i] + (i ? zs[i - 1].w / 2 : 0), b: cuts[i + 1] - (i < zs.length ? zs[i].w / 2 : 0) }); }
  for (const r of zs) { const cuts = [-HALF, ...xs.map((x) => x.p), HALF]; for (let i = 0; i < cuts.length - 1; i++) segs.push({ axis: 'x', c: r.p, w: r.w, a: cuts[i] + (i ? xs[i - 1].w / 2 : 0), b: cuts[i + 1] - (i < xs.length ? xs[i].w / 2 : 0) }); }
  const at = (s, along, lat) => (s.axis === 'z' ? { x: s.c + lat, z: along } : { x: along, z: s.c + lat });
  const rotAlong = (s) => (s.axis === 'z' ? 0 : Math.PI / 2);
  const carVariant = (main) => rng.weighted([[0, 5], [3, 3], [1, 2], [2, 2], [4, main ? 1.2 : 0.5], [5, main ? 0.6 : 0]]);
  const TH = L.themeDef;
  const car = (p, rot, main, extra = {}) => P.push({ type: 'car', ...p, rot, variant: carVariant(main), paint: rng.int(0, 8), burnt: rng.chance(TH.burnt), flipped: rng.chance(0.05), seed: rng.int(1, 1e9), ...extra });
  for (const s of segs) {
    const len = s.b - s.a; if (len < 6) continue;
    const main = s.w >= 9;
    const median = main && len > 14 && rng.chance(0.45);
    // cars: scattered wrecks + occasional abandoned traffic jam along one lane
    const nc = rng.int(1, Math.ceil(len / 8));
    for (let i = 0; i < nc; i++) {
      const along = rng.range(s.a + 3, s.b - 3), lat = rng.range(-s.w / 2 + 1.3, s.w / 2 - 1.3);
      const crashed = rng.chance(0.3);
      car(at(s, along, median && Math.abs(lat) < 1.6 ? Math.sign(lat || 1) * 2.2 : lat), rotAlong(s) + (rng.chance(0.5) ? Math.PI : 0) + (crashed ? rng.range(-1.2, 1.2) : rng.range(-0.2, 0.2)), main);
    }
    if (len > 16 && rng.chance(0.35)) {
      const lane = rng.sign() * s.w * 0.25, dir = lane > 0 ? 0 : Math.PI;
      for (let a = s.a + 3 + rng.range(0, 3); a < s.b - 4; a += rng.range(5.8, 7.5)) if (rng.chance(0.75)) car(at(s, a, lane + rng.range(-0.3, 0.3)), rotAlong(s) + dir + rng.range(-0.12, 0.12), main);
    }
    if (median) {
      for (let a = s.a + 2; a < s.b - 2; a += 2.7) { if (rng.chance(0.12)) { a += 2; continue; } P.push({ type: 'jersey', ...at(s, a + 1.3, rng.range(-0.08, 0.08)), rot: rotAlong(s) + Math.PI / 2 + rng.range(-0.05, 0.05), len: 2.6 }); }
    }
    // front-line damage: shell craters (scorch + rubble ring), sandbag nests, tank traps
    if (rng.chance(TH.war * 0.6)) { const p = at(s, rng.range(s.a + 3, s.b - 3), rng.range(-s.w / 2 + 1.5, s.w / 2 - 1.5)); P.push({ type: 'crater', ...p, s: rng.range(1.6, 2.8), seed: rng.int(1, 1e9) }); }
    if (rng.chance(TH.war * 0.25)) { const p = at(s, rng.range(s.a + 3, s.b - 3), rng.range(-s.w / 2 + 2, s.w / 2 - 2)); for (let i = 0; i < 3; i++) P.push({ type: 'hedgehog', x: p.x + rng.range(-2.5, 2.5), z: p.z + rng.range(-2.5, 2.5), rot: rng.range(0, 6.28) }); }
    // tree pits with dead / overgrown street trees
    if (rng.chance(0.6 * TH.trees)) { const side = rng.sign(); for (let a = s.a + rng.range(3, 7); a < s.b - 3; a += rng.range(8, 13)) if (rng.chance(0.7)) P.push({ type: 'treepit', ...at(s, a, side * (s.w / 2 + 1.25)), s: rng.range(0.7, 1.1), dead: rng.chance(0.6), seed: rng.int(1, 1e9) }); }
    // debris / rubble piles partially blocking road
    if (rng.chance(0.55)) { const p = at(s, rng.range(s.a + 2, s.b - 2), rng.range(-s.w / 2, s.w / 2) * 0.6); P.push({ type: 'rubblePile', ...p, s: rng.range(1, 2.4), seed: rng.int(1, 1e9) }); }
    // loose road clutter (no or small colliders)
    for (let i = 0; i < Math.ceil(len / 3.2); i++) {
      const p = at(s, rng.range(s.a + 1, s.b - 1), rng.range(-s.w / 2 + 0.5, s.w / 2 - 0.5));
      P.push({ type: rng.weighted([['cone', 2], ['tires', 1], ['bags', 2], ['cardboard', 2], ['pallet', 1], ['crates', 1], ['tarp', 1], ['barrel', 1], ['mattress', 0.5], ['cart', 0.5]]), ...p, rot: rng.range(0, 6.28), seed: rng.int(1, 1e9) });
    }
    // debris fields: dense clusters of chunks, paper, planks (no collider beyond the small piles)
    for (let i = 0; i < Math.ceil(len / 22); i++) { const p = at(s, rng.range(s.a + 2, s.b - 2), rng.range(-s.w / 2 + 1, s.w / 2 - 1)); P.push({ type: 'debrisField', ...p, s: rng.range(2, 4), seed: rng.int(1, 1e9) }); }
    // barricade line across road with a gap
    if (rng.chance(0.22) && len > 12) {
      const along = rng.range(s.a + 4, s.b - 4), gap = rng.range(-s.w / 2 + 2, s.w / 2 - 2);
      const kind = rng.pick(['jersey', 'sandbags', 'planks']);
      for (let lat = -s.w / 2 + 1; lat < s.w / 2 - 0.5; lat += 2.6) {
        if (Math.abs(lat - gap) < 1.8) continue;
        const p = at(s, along + rng.range(-0.3, 0.3), lat);
        P.push({ type: kind, ...p, rot: rotAlong(s) + Math.PI / 2 + rng.range(-0.15, 0.15), len: 2.5 });
      }
    }
    // decals
    for (let i = 0; i < Math.ceil(len / 4); i++) { const p = at(s, rng.range(s.a, s.b), rng.range(-s.w / 2, s.w / 2)); L.decals.push({ kind: rng.weighted([['crack', 4], ['oil', 3], ['puddle', 3], ['trash', 2], ['scorch', 1], ['patch', 2], ['stain', 3], ['wet', 3], ['leaves', 1.5], ['paper', 2]]), ...p, s: rng.range(1.5, 5), rot: rng.range(0, 6.28) }); }
    for (let i = 0; i < Math.ceil(len / 14); i++) { const p = at(s, rng.range(s.a, s.b), rng.range(-s.w / 2, s.w / 2) * 0.7); L.decals.push({ kind: 'wet', ...p, s: rng.range(5, 9), rot: rng.range(0, 6.28) }); }
    if (rng.chance(0.6)) L.decals.push({ kind: 'manhole', ...at(s, rng.range(s.a + 2, s.b - 2), rng.range(-1.5, 1.5)), s: 1.0, rot: 0 });
    for (const side of [-1, 1]) {
      if (rng.chance(0.7)) L.decals.push({ kind: 'drain', ...at(s, rng.range(s.a + 2, s.b - 2), side * (s.w / 2 - 0.3)), s: 1.0, rot: rotAlong(s) + Math.PI / 2 });
      for (let a = s.a + 1; a < s.b - 2; a += 4) if (rng.chance(0.85)) L.decals.push({ kind: 'edge', ...at(s, a + 2, side * (s.w / 2 - 0.7)), s: 1, sx: 0.8, sz: 4.1, rot: rotAlong(s) });
    }
    if (len > 14 && rng.chance(0.6)) for (const side of [-1, 1]) L.decals.push({ kind: 'arrow', ...at(s, side > 0 ? s.b - 5 : s.a + 5, side * s.w * 0.25), s: 1, sx: 1.0, sz: 3.0, rot: rotAlong(s) + (side > 0 ? 0 : Math.PI) });
    // center line dashes
    if (!median) for (let a = s.a + 2; a < s.b - 2; a += 4.5) { if (rng.chance(0.15)) continue; const p = at(s, a, 0); L.decals.push({ kind: 'dash', ...p, s: 2.2, rot: rotAlong(s), sx: 0.6 }); }
    // lamps along sidewalks
    for (let a = s.a + rng.range(2, 6); a < s.b - 2; a += rng.range(13, 18)) {
      const side = rng.sign(); const p = at(s, a, side * (s.w / 2 + 0.8));
      P.push({ type: 'lamp', ...p, rot: rotAlong(s) + (side > 0 ? Math.PI : 0) + Math.PI / 2, working: rng.chance(0.62), bent: rng.chance(0.2), axis: s.axis, side });
    }
    // utility poles + sagging wires along one side
    if (rng.chance(0.5)) {
      const side = rng.sign(); const line = [];
      for (let a = s.a + 3; a < s.b - 2; a += rng.range(11, 15)) line.push({ ...at(s, a, side * (s.w / 2 + 1.9)), lean: rng.range(-0.08, 0.08), broken: rng.chance(0.12) });
      if (line.length > 1) L.poles.push(line);
    }
    // practical light sources: trash fires, road flares (key for the dark mood)
    if (rng.chance(0.38)) { const side = rng.sign(); const p = at(s, rng.range(s.a + 2, s.b - 2), side * (s.w / 2 + rng.range(-0.6, 1.2))); P.push({ type: 'barrel', ...p, burning: true }); }
    if (rng.chance(0.22)) { const p = at(s, rng.range(s.a + 2, s.b - 2), rng.range(-s.w / 2 + 1, s.w / 2 - 1)); P.push({ type: 'flare', ...p, rot: rng.range(0, 6.28) }); }
    if (rng.chance(0.12)) { const p = at(s, rng.range(s.a + 2, s.b - 2), rng.range(-s.w / 2 + 1, s.w / 2 - 1)); P.push({ type: 'fire', ...p, s: rng.range(0.7, 1.1), campfire: false, debris: true }); }
    // sidewalk furniture: something every few metres, curb side or wall side
    for (const side of [-1, 1]) {
      for (let a = s.a + rng.range(0.5, 2); a < s.b - 0.8; a += rng.range(2.2, 4.2)) {
        const t = rng.weighted([['hydrant', 1], ['newsbox', 1.2], ['trashcan', 2], ['bags', 3], ['cardboard', 2], ['bollard', 1.2], ['sign', 1.2], ['busstop', 0.35], ['phone', 0.3], ['planter', 0.8], ['bench', 0.5], ['crates', 0.8], ['pallet', 0.6], ['mattress', 0.4], ['cart', 0.3], ['tires', 0.6], ['barrel', 0.6], ['dumpster', 0.5], ['bush', 1]]);
        const wall = ['bags', 'cardboard', 'crates', 'pallet', 'mattress', 'dumpster', 'bush', 'trashcan', 'phone'].includes(t) && rng.chance(0.7);
        const lat = side * (s.w / 2 + (wall ? SIDEWALK - 0.45 : 0.45));
        const p = at(s, a, lat);
        const face = rotAlong(s) + (side > 0 ? Math.PI : 0); // local +x along street; +z toward road for side>0? (approx)
        P.push({ type: t === 'sign' ? 'streetSign' : t, ...p, rot: ['busstop', 'bench', 'dumpster', 'newsbox', 'phone'].includes(t) ? face + Math.PI / 2 * side + Math.PI / 2 : rng.range(0, 6.28), s: rng.range(0.6, 1.2), seed: rng.int(1, 1e9), burning: rng.chance(0.12) });
        if (t === 'busstop') a += 3;
      }
    }
  }
  // intersections: crosswalks + traffic lights
  for (const x of xs) for (const z of zs) {
    if (rng.chance(0.75)) { L.decals.push({ kind: 'crosswalk', x: x.p, z: z.p - z.w / 2 - 1.6, s: x.w * 0.8, rot: 0, sx: 1, sy: 0.35 }); }
    if (rng.chance(0.75)) { L.decals.push({ kind: 'crosswalk', x: x.p - x.w / 2 - 1.6, z: z.p, s: z.w * 0.8, rot: Math.PI / 2, sx: 1, sy: 0.35 }); }
    if (rng.chance(0.5)) P.push({ type: 'trafficLight', x: x.p + (x.w / 2 + 0.9) * rng.sign(), z: z.p + (z.w / 2 + 0.9) * rng.sign(), rot: rng.pick([0, 1.57, 3.14, 4.71]), working: rng.chance(0.4) });
    if (rng.chance(0.35)) P.push({ type: 'car', x: x.p + rng.range(-2, 2), z: z.p + rng.range(-2, 2), rot: rng.range(0, 6.28), variant: rng.weighted([[0, 3], [3, 2], [1, 1], [4, 1], [5, 0.5]]), paint: rng.int(0, 8), burnt: true, seed: rng.int(1, 1e9) });
    if (rng.chance(0.5)) L.decals.push({ kind: 'manhole', x: x.p + rng.range(-2, 2), z: z.p + rng.range(-2, 2), s: 1, rot: 0 });
    if (rng.chance(0.6)) L.decals.push({ kind: 'wet', x: x.p + rng.range(-3, 3), z: z.p + rng.range(-3, 3), s: rng.range(6, 10), rot: rng.range(0, 6) });
    if (rng.chance(0.2)) L.decals.push({ kind: 'scorch', x: x.p, z: z.p, s: rng.range(4, 7), rot: rng.range(0, 6) });
    if (rng.chance(0.6)) P.push({ type: 'debrisField', x: x.p + rng.range(-2, 2), z: z.p + rng.range(-2, 2), s: rng.range(2.5, 4.5), seed: rng.int(1, 1e9) });
  }
}

// --- Outer ring: dense visual-only city that seals the map edge ----------------
// Tall wrecked facades on the far (-x/-z, top of screen) sides; low ruins on the camera-facing sides so
// they never hide the player. Every road leaving the square ends in a roadblock.
function buildOuterRing(L, rng) {
  const E = HALF + OUTER, B = HALF + 6;
  L.outer = []; L.outerRoads = []; L.roadblocks = [];
  const ext = (inner) => { // continue the road rhythm outward on both sides
    const lo = [], hi = [];
    let p = (inner.length ? inner[0].p : 0) - rng.range(26, 34); while (p > -E + 6) { if (p < -B - 6) lo.push({ p, w: rng.range(6.5, 8.5) }); p -= rng.range(24, 32); }
    p = (inner.length ? inner[inner.length - 1].p : 0) + rng.range(26, 34); while (p < E - 6) { if (p > B + 6) hi.push({ p, w: rng.range(6.5, 8.5) }); p += rng.range(24, 32); }
    return [...lo.reverse(), ...inner, ...hi];
  };
  const ax = ext(L.roadsX), az = ext(L.roadsZ);
  for (const r of ax) if (!L.roadsX.includes(r)) L.outerRoads.push({ axis: 'z', x: r.p, w: r.w });
  for (const r of az) if (!L.roadsZ.includes(r)) L.outerRoads.push({ axis: 'x', z: r.p, w: r.w });
  const iv = (roads) => {
    const out = []; let a = -E;
    for (const r of roads) { out.push([a, r.p - r.w / 2 - SIDEWALK]); a = r.p + r.w / 2 + SIDEWALK; }
    out.push([a, E]);
    const split = [];
    for (const [u, v] of out) { // split at the playable border so inner cells stay owned by the main generator
      const cuts = [u, ...[-B, B].filter((c) => c > u + 0.5 && c < v - 0.5), v];
      for (let i = 0; i < cuts.length - 1; i++) split.push([cuts[i], cuts[i + 1]]);
    }
    return split.filter(([u, v]) => v - u > 5);
  };
  const ix = iv(ax), iz = iv(az);
  for (const [x0, x1] of ix) for (const [z0, z1] of iz) {
    const inner = x0 >= -B - 0.01 && x1 <= B + 0.01 && z0 >= -B - 0.01 && z1 <= B + 0.01;
    if (inner) continue;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const near = cx > B || cz > B; // camera-facing side -> keep low
    const dist = Math.max(Math.abs(cx), Math.abs(cz)) - B;
    // subdivide the block into frontage lots
    const alongX = x1 - x0 >= z1 - z0, len = alongX ? x1 - x0 : z1 - z0;
    let t = 0;
    while (t < len - 3) {
      const lw = Math.min(len - t, rng.range(7, 14));
      const lot = alongX ? { x0: x0 + t, x1: x0 + t + lw, z0, z1 } : { x0, x1, z0: z0 + t, z1: z0 + t + lw };
      t += lw + rng.range(0, 1.2);
      let floors;
      if (near) floors = dist < 14 ? rng.weighted([[0, 3], [1, 3], [2, 2]]) : rng.int(1, 4);
      else floors = rng.weighted([[3, 1], [4, 2], [5, 3], [7, 3], [9, 2], [12, 1]]) + (dist > 20 ? rng.int(0, 3) : 0);
      L.outer.push({ ...lot, floors, style: rng.weighted(L.themeDef.styles), tint: rng.pick([0xffffff, 0xe8e0d4, 0xd0d4d8, 0xc8bcb0, 0xb8b0a4]), broken: rng.chance(0.45), near, seed: rng.int(1, 1e9) });
    }
  }
  // roadblocks where playable roads leave the square
  for (const r of L.roadsX) for (const side of [-1, 1]) L.roadblocks.push({ axis: 'z', c: r.p, w: r.w, at: side * (HALF + 2.5), side, kind: rng.weighted([['containers', 3], ['bus', 2], ['rubble', 2], ['jersey', 2]]), seed: rng.int(1, 1e9) });
  for (const r of L.roadsZ) for (const side of [-1, 1]) L.roadblocks.push({ axis: 'x', c: r.p, w: r.w, at: side * (HALF + 2.5), side, kind: rng.weighted([['containers', 3], ['bus', 2], ['rubble', 2], ['jersey', 2]]), seed: rng.int(1, 1e9) });
}

// --- Population (after colliders + nav exist) ------------------------------
export function populate(L, nav, rng) {
  const H = HALF - 4;
  const roadPoints = [];
  for (const r of L.roadsX) for (let z = -H; z < H; z += 4) roadPoints.push({ x: r.p, z });
  for (const r of L.roadsZ) for (let x = -H; x < H; x += 4) roadPoints.push({ x, z: r.p });
  // spawn: road point near an edge
  const edgeish = roadPoints.filter((p) => Math.max(Math.abs(p.x), Math.abs(p.z)) > H - 10 && nav.walkable(p.x, p.z));
  const spawn = rng.pick(edgeish.length ? edgeish : roadPoints);
  nav.computeReach(spawn.x, spawn.z);
  nav.computeFlow(spawn.x, spawn.z, 9999);
  // extraction: far (by path) from spawn, prefer open areas
  const cands = roadPoints.filter((p) => nav.isReachable(p.x, p.z)).map((p) => ({ ...p, c: nav.costAt(p.x, p.z) })).filter((p) => isFinite(p.c));
  cands.sort((a, b) => b.c - a.c);
  const top = cands.slice(0, Math.max(3, Math.floor(cands.length * 0.08)));
  const extraction = rng.pick(top);

  const randomReach = (filter, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      const x = rng.range(-H, H), z = rng.range(-H, H);
      if (!nav.isReachable(x, z)) continue;
      if (filter && !filter(x, z)) continue;
      return { x, z };
    }
    return null;
  };
  const farFromSpawn = (d) => (x, z) => Math.hypot(x - spawn.x, z - spawn.z) > d;

  const enemies = [];
  for (const c of L.camps || []) {
    const n = rng.int(3, 5);
    for (let i = 0; i < n; i++) {
      const p = nav.nearestWalkable(c.x + rng.range(-c.r * 0.6, c.r * 0.6), c.z + rng.range(-c.r * 0.6, c.r * 0.6), 5);
      if (p && nav.isReachable(p.x, p.z) && Math.hypot(p.x - spawn.x, p.z - spawn.z) > 22) enemies.push({ ...p, type: rng.weighted([['raider', 6], ['mutant', 1]]), group: 'camp' });
    }
  }
  const roam = 8 + rng.int(0, 5);
  for (let g = 0; g < roam; g++) {
    const p = randomReach(farFromSpawn(28)); if (!p) continue;
    const type = rng.weighted([['raider', 4], ['mutant', 4], ['brute', 1]]);
    const n = type === 'mutant' ? rng.int(2, 4) : type === 'brute' ? 1 : rng.int(1, 3);
    for (let i = 0; i < n; i++) { const q = nav.nearestWalkable(p.x + rng.range(-2.5, 2.5), p.z + rng.range(-2.5, 2.5), 4); if (q && nav.isReachable(q.x, q.z)) enemies.push({ ...q, type, group: 'roam' + g }); }
  }
  // guard extraction
  for (let i = 0; i < 3; i++) { const q = nav.nearestWalkable(extraction.x + rng.range(-7, 7), extraction.z + rng.range(-7, 7), 5); if (q && nav.isReachable(q.x, q.z)) enemies.push({ ...q, type: rng.pick(['raider', 'raider', 'brute']), group: 'extract' }); }

  // crates: inside buildings (reachable interior) + camps
  const crates = [];
  for (const b of L.buildings) {
    if (b.collapsed || !rng.chance(0.45)) continue;
    const p = nav.nearestWalkable(rng.range(b.x0 + 1.5, b.x1 - 1.5), rng.range(b.z0 + 1.5, b.z1 - 1.5), 3);
    if (p && nav.isReachable(p.x, p.z) && p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1) crates.push({ ...p, rot: rng.range(0, 6.28), tier: rng.weighted([[0, 5], [1, 3], [2, 1]]) });
  }
  for (const c of L.camps || []) for (let i = 0; i < 2; i++) { const p = nav.nearestWalkable(c.x + rng.range(-3, 3), c.z + rng.range(-3, 3), 4); if (p && nav.isReachable(p.x, p.z)) crates.push({ ...p, rot: rng.range(0, 6.28), tier: rng.weighted([[1, 2], [2, 2], [3, 1]]) }); }
  for (let i = 0; i < 6; i++) { const p = randomReach(); if (p) crates.push({ ...p, rot: rng.range(0, 6.28), tier: 0 }); }
  return { spawn, extraction, enemies, crates };
}
