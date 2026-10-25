// 2.5D collision world: oriented boxes on the XZ plane with a height.
// Used for movement (circle vs OBB), bullets (segment vs OBB at a given height) and line of sight.
export class CollisionWorld {
  constructor(minX, minZ, maxX, maxZ, cell = 4) {
    this.minX = minX; this.minZ = minZ; this.maxX = maxX; this.maxZ = maxZ;
    this.cell = cell;
    this.nx = Math.ceil((maxX - minX) / cell); this.nz = Math.ceil((maxZ - minZ) / cell);
    this.cells = new Array(this.nx * this.nz);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
    this.boxes = [];
    this._stamp = 1;
  }
  // x,z center, hx/hz half extents, rot (radians about Y), h height (top), y0 bottom
  add(x, z, hx, hz, rot = 0, h = 3, opts = {}) {
    const c = Math.cos(rot), s = Math.sin(rot);
    const ex = Math.abs(c * hx) + Math.abs(s * hz), ez = Math.abs(s * hx) + Math.abs(c * hz);
    const b = { x, z, hx, hz, rot, c, s, h, y0: opts.y0 || 0, kind: opts.kind || 'solid', blocksShots: opts.blocksShots !== false, data: opts.data, _s: 0,
      minX: x - ex, maxX: x + ex, minZ: z - ez, maxZ: z + ez, id: this.boxes.length };
    this.boxes.push(b);
    const [i0, j0] = this.cellOf(b.minX, b.minZ), [i1, j1] = this.cellOf(b.maxX, b.maxZ);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.cells[j * this.nx + i].push(b);
    return b;
  }
  cellOf(x, z) {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
    const j = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / this.cell)));
    return [i, j];
  }
  queryAABB(minX, minZ, maxX, maxZ, out = []) {
    const st = ++this._stamp;
    const [i0, j0] = this.cellOf(minX, minZ), [i1, j1] = this.cellOf(maxX, maxZ);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      for (const b of this.cells[j * this.nx + i]) {
        if (b._s === st) continue; b._s = st;
        if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
        out.push(b);
      }
    }
    return out;
  }
  // Push a circle out of all boxes. Mutates pos {x,z}. Returns true if collided.
  resolveCircle(pos, r, iterations = 3) {
    let hit = false;
    const tmp = [];
    for (let it = 0; it < iterations; it++) {
      tmp.length = 0;
      this.queryAABB(pos.x - r, pos.z - r, pos.x + r, pos.z + r, tmp);
      let any = false;
      for (const b of tmp) {
        if (b.h < 0.35 || b.y0 > 1.8) continue; // tiny debris / overhead lintels don't block
        const dx = pos.x - b.x, dz = pos.z - b.z;
        const lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c; // world -> local (rot = mesh.rotation.y)
        const cx = Math.max(-b.hx, Math.min(b.hx, lx)), cz = Math.max(-b.hz, Math.min(b.hz, lz));
        let ox = lx - cx, oz = lz - cz;
        let d2 = ox * ox + oz * oz;
        if (d2 >= r * r) continue;
        let nx, nz, pen;
        if (d2 > 1e-8) { const d = Math.sqrt(d2); nx = ox / d; nz = oz / d; pen = r - d; }
        else { // center inside box: push along smallest axis
          const px = b.hx - Math.abs(lx), pz = b.hz - Math.abs(lz);
          if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; pen = px + r; } else { nx = 0; nz = Math.sign(lz) || 1; pen = pz + r; }
        }
        // local -> world
        const wx = nx * b.c + nz * b.s, wz = -nx * b.s + nz * b.c;
        pos.x += wx * pen; pos.z += wz * pen;
        any = hit = true;
      }
      if (!any) break;
    }
    pos.x = Math.max(this.minX + r, Math.min(this.maxX - r, pos.x));
    pos.z = Math.max(this.minZ + r, Math.min(this.maxZ - r, pos.z));
    return hit;
  }
  // Is a circle overlapping any blocking box?
  blockedCircle(x, z, r, minH = 0.35) {
    const tmp = this.queryAABB(x - r, z - r, x + r, z + r);
    for (const b of tmp) {
      if (b.h < minH || b.y0 > 1.8) continue;
      const dx = x - b.x, dz = z - b.z;
      const lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
      const cx = Math.max(-b.hx, Math.min(b.hx, lx)), cz = Math.max(-b.hz, Math.min(b.hz, lz));
      if ((lx - cx) ** 2 + (lz - cz) ** 2 < r * r) return true;
    }
    return false;
  }
  // Segment test at height y. Returns {t, x, z, nx, nz, box} for nearest hit or null.
  raycast(x0, z0, x1, z1, y = 1.2) {
    const dx = x1 - x0, dz = z1 - z0;
    let best = null, bestT = 1;
    const st = ++this._stamp;
    // DDA through grid cells
    const cs = this.cell;
    let [i, j] = this.cellOf(x0, z0);
    const [ie, je] = this.cellOf(x1, z1);
    const stepI = dx > 0 ? 1 : -1, stepJ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(cs / dx) : Infinity, tDeltaZ = dz !== 0 ? Math.abs(cs / dz) : Infinity;
    const cellX0 = this.minX + (i + (dx > 0 ? 1 : 0)) * cs, cellZ0 = this.minZ + (j + (dz > 0 ? 1 : 0)) * cs;
    let tMaxX = dx !== 0 ? (cellX0 - x0) / dx : Infinity, tMaxZ = dz !== 0 ? (cellZ0 - z0) / dz : Infinity;
    for (let guard = 0; guard < 512; guard++) {
      for (const b of this.cells[j * this.nx + i]) {
        if (b._s === st) continue; b._s = st;
        if (!b.blocksShots || y > b.h || y < b.y0) continue;
        const r = segOBB(x0, z0, dx, dz, b);
        if (r && r.t < bestT) { bestT = r.t; best = r; best.box = b; }
      }
      if (best && bestT <= Math.min(tMaxX, tMaxZ)) break;
      if (i === ie && j === je) break;
      if (tMaxX < tMaxZ) { if (tMaxX > 1) break; i += stepI; tMaxX += tDeltaX; }
      else { if (tMaxZ > 1) break; j += stepJ; tMaxZ += tDeltaZ; }
      if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) break;
    }
    if (best) { best.x = x0 + dx * best.t; best.z = z0 + dz * best.t; }
    return best;
  }
  los(x0, z0, x1, z1, y = 1.3) { return !this.raycast(x0, z0, x1, z1, y); }
}

function segOBB(x0, z0, dx, dz, b) {
  // transform to local frame
  const ox = x0 - b.x, oz = z0 - b.z;
  const lx = ox * b.c - oz * b.s, lz = ox * b.s + oz * b.c;
  const ldx = dx * b.c - dz * b.s, ldz = dx * b.s + dz * b.c;
  let tmin = 0, tmax = 1, nAxis = -1, nSign = 0;
  // X slab
  if (Math.abs(ldx) < 1e-9) { if (lx < -b.hx || lx > b.hx) return null; }
  else {
    let t1 = (-b.hx - lx) / ldx, t2 = (b.hx - lx) / ldx, s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; nAxis = 0; nSign = s; }
    tmax = Math.min(tmax, t2); if (tmin > tmax) return null;
  }
  if (Math.abs(ldz) < 1e-9) { if (lz < -b.hz || lz > b.hz) return null; }
  else {
    let t1 = (-b.hz - lz) / ldz, t2 = (b.hz - lz) / ldz, s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; nAxis = 1; nSign = s; }
    tmax = Math.min(tmax, t2); if (tmin > tmax) return null;
  }
  if (nAxis === -1) return null; // started inside
  const lnx = nAxis === 0 ? nSign : 0, lnz = nAxis === 1 ? nSign : 0;
  return { t: tmin, nx: lnx * b.c + lnz * b.s, nz: -lnx * b.s + lnz * b.c };
}
