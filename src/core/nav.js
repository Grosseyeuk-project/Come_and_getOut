// Grid navigation: walkability grid built from the collision world, a Dijkstra flow field
// toward the player (shared by all chasing enemies), and reachability checks for placement.
export class NavGrid {
  constructor(col, res = 1, agentR = 0.45) {
    this.col = col; this.res = res;
    this.minX = col.minX; this.minZ = col.minZ;
    this.w = Math.floor((col.maxX - col.minX) / res); this.h = Math.floor((col.maxZ - col.minZ) / res);
    const n = this.w * this.h;
    this.block = new Uint8Array(n);
    for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) {
      const x = this.minX + (i + 0.5) * res, z = this.minZ + (j + 0.5) * res;
      this.block[j * this.w + i] = col.blockedCircle(x, z, agentR) ? 1 : 0;
    }
    this.dist = new Float32Array(n).fill(Infinity);
    this.reach = new Uint8Array(n);
    this._heap = new Int32Array(n * 4); this._hk = new Float32Array(n * 4);
  }
  idx(x, z) {
    const i = Math.floor((x - this.minX) / this.res), j = Math.floor((z - this.minZ) / this.res);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return j * this.w + i;
  }
  center(id) { return { x: this.minX + ((id % this.w) + 0.5) * this.res, z: this.minZ + (Math.floor(id / this.w) + 0.5) * this.res }; }
  walkable(x, z) { const id = this.idx(x, z); return id >= 0 && !this.block[id]; }
  nearestWalkable(x, z, maxR = 6) {
    const id0 = this.idx(x, z);
    if (id0 >= 0 && !this.block[id0]) return this.center(id0);
    for (let r = 1; r <= maxR; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const id = this.idx(x + di * this.res, z + dj * this.res);
      if (id >= 0 && !this.block[id]) return this.center(id);
    }
    return null;
  }
  // Flood fill from a point; marks this.reach.
  computeReach(x, z) {
    this.reach.fill(0);
    const s = this.idx(x, z); if (s < 0) return 0;
    const q = [s]; this.reach[s] = 1; let count = 0;
    while (q.length) {
      const c = q.pop(); count++;
      const i = c % this.w, j = (c / this.w) | 0;
      if (i > 0) this._r(c - 1, q); if (i < this.w - 1) this._r(c + 1, q);
      if (j > 0) this._r(c - this.w, q); if (j < this.h - 1) this._r(c + this.w, q);
    }
    return count;
  }
  _r(n, q) { if (!this.block[n] && !this.reach[n]) { this.reach[n] = 1; q.push(n); } }
  isReachable(x, z) { const id = this.idx(x, z); return id >= 0 && this.reach[id] === 1; }

  // Dijkstra flow field toward target, limited radius (in cost) for speed.
  computeFlow(tx, tz, maxCost = 70) {
    const d = this.dist; d.fill(Infinity);
    let s = this.idx(tx, tz); if (s < 0) return;
    if (this.block[s]) { const p = this.nearestWalkable(tx, tz, 3); if (!p) return; s = this.idx(p.x, p.z); }
    const heap = this._heap, hk = this._hk; let hn = 0;
    const push = (id, k) => { let i = hn++; heap[i] = id; hk[i] = k; while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= hk[i]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; [hk[p], hk[i]] = [hk[i], hk[p]]; i = p; } };
    const pop = () => { const r = heap[0]; hn--; heap[0] = heap[hn]; hk[0] = hk[hn]; let i = 0; for (;;) { const l = 2 * i + 1, rr = l + 1; let m = i; if (l < hn && hk[l] < hk[m]) m = l; if (rr < hn && hk[rr] < hk[m]) m = rr; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; [hk[m], hk[i]] = [hk[i], hk[m]]; i = m; } return r; };
    d[s] = 0; push(s, 0);
    const w = this.w, h = this.h, B = this.block;
    while (hn > 0 && hn < heap.length - 8) {
      const k0 = hk[0]; const c = pop();
      if (k0 > d[c]) continue;
      if (k0 > maxCost) break;
      const i = c % w, j = (c / w) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const n = nj * w + ni; if (B[n]) continue;
        if (di && dj && (B[j * w + ni] || B[nj * w + i])) continue; // no corner cutting
        const nd = d[c] + (di && dj ? 1.4142 : 1);
        if (nd < d[n]) { d[n] = nd; push(n, nd); }
      }
    }
  }
  // Direction to step along the flow field from (x,z). Returns {x,z} unit or null.
  flowDir(x, z) {
    const c = this.idx(x, z); if (c < 0) return null;
    const w = this.w, h = this.h, d = this.dist;
    const i = c % w, j = (c / w) | 0;
    let best = d[c], bi = 0, bj = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
      const n = nj * w + ni;
      if (di && dj && (this.block[j * w + ni] || this.block[nj * w + i])) continue;
      if (d[n] < best) { best = d[n]; bi = di; bj = dj; }
    }
    if (!bi && !bj) return null;
    // aim at neighbour cell centre for smoother following
    const tx = this.minX + (i + bi + 0.5) * this.res, tz = this.minZ + (j + bj + 0.5) * this.res;
    const dx = tx - x, dz = tz - z, l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l, cost: d[c] };
  }
  costAt(x, z) { const c = this.idx(x, z); return c < 0 ? Infinity : this.dist[c]; }
}
