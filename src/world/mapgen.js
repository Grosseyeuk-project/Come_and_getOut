// Seeded layout generation for a ruined city district. Produces a pure-data description
// (roads, blocks, buildings, props, lights) that environment.js turns into meshes + colliders.
// populate() runs afterwards (needs the nav grid) to place spawn, extraction, enemies and loot.
import { RNG } from '../core/rng.js';
import { PALETTES } from './lighting.js';

export const HALF = 72;
const SIDEWALK = 2.4;

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
  for (const r of rx) L.roads.push({ axis: 'z', x: r.p, w: r.w, z0: -HALF, z1: HALF });
  for (const r of rz) L.roads.push({ axis: 'x', z: r.p, w: r.w, x0: -HALF, x1: HALF });
  L.roadsX = rx; L.roadsZ = rz;
  if (forced && PALETTES[forced]) L.palette = forced;

  const intervals = (roads) => {
    const iv = []; let a = -HALF - 6;
    for (const r of roads) { iv.push([a, r.p - r.w / 2 - SIDEWALK]); a = r.p + r.w / 2 + SIDEWALK; }
    iv.push([a, HALF + 6]);
    return iv.filter(([x0, x1]) => x1 - x0 > 6);
  };
  const ix = intervals(rx), iz = intervals(rz);

  // sidewalks (strips along both sides of each road, full length)
  for (const r of rx) { L.sidewalks.push({ x0: r.p - r.w / 2 - SIDEWALK, x1: r.p - r.w / 2, z0: -HALF - 6, z1: HALF + 6 }); L.sidewalks.push({ x0: r.p + r.w / 2, x1: r.p + r.w / 2 + SIDEWALK, z0: -HALF - 6, z1: HALF + 6 }); }
  for (const r of rz) { L.sidewalks.push({ z0: r.p - r.w / 2 - SIDEWALK, z1: r.p - r.w / 2, x0: -HALF - 6, x1: HALF + 6 }); L.sidewalks.push({ z0: r.p + r.w / 2, z1: r.p + r.w / 2 + SIDEWALK, x0: -HALF - 6, x1: HALF + 6 }); }

  // blocks
  const types = [['buildings', 50], ['collapsed', 14], ['park', 12], ['parking', 10], ['camp', 9], ['yard', 6]];
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
          floors: b.edge ? rng.int(3, 6) : rng.weighted([[1, 2], [2, 4], [3, 3], [4, 2], [5, 1]]),
          style: rng.weighted([['brick', 4], ['plaster', 3], ['concrete', 3]]),
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
    for (let i = 0; i < rng.int(1, 3); i++) P.push({ type: 'car', x: rng.range(b.x0 + 4, b.x1 - 4), z: rng.range(b.z0 + 4, b.z1 - 4), rot: rng.range(0, 6.28), variant: rng.int(0, 2), paint: 5, burnt: true, seed: rng.int(1, 1e9) });
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
        P.push({ type: 'car', x: px + rng.range(-0.3, 0.3), z: pz + rng.range(-0.4, 0.4), rot: (alongX ? Math.PI / 2 : 0) + rng.range(-0.25, 0.25) + (rng.chance(0.5) ? Math.PI : 0), variant: rng.int(0, 2), paint: rng.int(0, 5), burnt: rng.chance(0.25), seed: rng.int(1, 1e9) });
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
  for (const s of segs) {
    const len = s.b - s.a; if (len < 6) continue;
    // cars
    const nc = rng.int(0, Math.ceil(len / 9));
    for (let i = 0; i < nc; i++) {
      const along = rng.range(s.a + 3, s.b - 3), lat = rng.range(-s.w / 2 + 1.3, s.w / 2 - 1.3);
      const p = at(s, along, lat);
      const crashed = rng.chance(0.3);
      P.push({ type: 'car', ...p, rot: rotAlong(s) + (rng.chance(0.5) ? Math.PI : 0) + (crashed ? rng.range(-1.2, 1.2) : rng.range(-0.2, 0.2)), variant: rng.weighted([[0, 5], [1, 2], [2, 2]]), paint: rng.int(0, 5), burnt: rng.chance(0.3), flipped: rng.chance(0.06), seed: rng.int(1, 1e9) });
    }
    // debris / rubble piles partially blocking road
    if (rng.chance(0.45)) { const p = at(s, rng.range(s.a + 2, s.b - 2), rng.range(-s.w / 2, s.w / 2) * 0.6); P.push({ type: 'rubblePile', ...p, s: rng.range(1, 2.4), seed: rng.int(1, 1e9) }); }
    // barricade line across road with a gap
    if (rng.chance(0.18) && len > 12) {
      const along = rng.range(s.a + 4, s.b - 4), gap = rng.range(-s.w / 2 + 2, s.w / 2 - 2);
      const kind = rng.pick(['jersey', 'sandbags', 'planks']);
      for (let lat = -s.w / 2 + 1; lat < s.w / 2 - 0.5; lat += 2.6) {
        if (Math.abs(lat - gap) < 1.8) continue;
        const p = at(s, along + rng.range(-0.3, 0.3), lat);
        P.push({ type: kind, ...p, rot: rotAlong(s) + Math.PI / 2 + rng.range(-0.15, 0.15), len: 2.5 });
      }
    }
    // decals
    for (let i = 0; i < Math.ceil(len / 6); i++) { const p = at(s, rng.range(s.a, s.b), rng.range(-s.w / 2, s.w / 2)); L.decals.push({ kind: rng.weighted([['crack', 4], ['oil', 2], ['puddle', 3], ['trash', 2], ['scorch', 1]]), ...p, s: rng.range(1.5, 5), rot: rng.range(0, 6.28) }); }
    // center line dashes
    for (let a = s.a + 2; a < s.b - 2; a += 4.5) { if (rng.chance(0.15)) continue; const p = at(s, a, 0); L.decals.push({ kind: 'dash', ...p, s: 2.2, rot: rotAlong(s), sx: 0.6 }); }
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
    // sidewalk clutter
    for (let i = 0; i < Math.ceil(len / 12); i++) {
      const side = rng.sign(); const p = at(s, rng.range(s.a + 1, s.b - 1), side * (s.w / 2 + rng.range(0.6, 2)));
      const t = rng.weighted([['barrel', 2], ['tires', 1], ['dumpster', 1], ['rubblePile', 2], ['bush', 2]]);
      P.push({ type: t, ...p, rot: rng.range(0, 6.28), s: rng.range(0.6, 1.2), seed: rng.int(1, 1e9), burning: rng.chance(0.15) });
    }
  }
  // intersections: crosswalks + traffic lights
  for (const x of xs) for (const z of zs) {
    if (rng.chance(0.75)) { L.decals.push({ kind: 'crosswalk', x: x.p, z: z.p - z.w / 2 - 1.6, s: x.w * 0.8, rot: 0, sx: 1, sy: 0.35 }); }
    if (rng.chance(0.75)) { L.decals.push({ kind: 'crosswalk', x: x.p - x.w / 2 - 1.6, z: z.p, s: z.w * 0.8, rot: Math.PI / 2, sx: 1, sy: 0.35 }); }
    if (rng.chance(0.5)) P.push({ type: 'trafficLight', x: x.p + (x.w / 2 + 0.9) * rng.sign(), z: z.p + (z.w / 2 + 0.9) * rng.sign(), rot: rng.pick([0, 1.57, 3.14, 4.71]), working: rng.chance(0.4) });
    if (rng.chance(0.25)) P.push({ type: 'car', x: x.p + rng.range(-2, 2), z: z.p + rng.range(-2, 2), rot: rng.range(0, 6.28), variant: rng.int(0, 2), paint: rng.int(0, 5), burnt: true, seed: rng.int(1, 1e9) });
    if (rng.chance(0.2)) L.decals.push({ kind: 'scorch', x: x.p, z: z.p, s: rng.range(4, 7), rot: rng.range(0, 6) });
  }
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
