// Player hitscan firing (spread, pellets, pierce, crits, falloff), enemy projectiles, damage routing.
import * as THREE from 'three';
import { BASES } from './weapons.js';

const BULLET_Y = 1.3;

export class Combat {
  constructor(game) {
    this.game = game;
    this.projectiles = [];
    const g = new THREE.SphereGeometry(0.07, 8, 6); g.scale(1, 1, 5);
    this.projGeo = g;
    this.projMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.1, 0.3), fog: false });
  }

  playerFire(pl, w) {
    const g = this.game, B = BASES[w.base], s = w.stats;
    w.cooldown = 60 / s.rpm; w.mag--;
    pl.shotsFired++;
    const m = pl.muzzleWorld();
    const ox = m.x, oz = m.z;
    let ax = pl.aim.x - pl.pos.x, az = pl.aim.z - pl.pos.z; const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
    // fire from slightly behind muzzle (so point-blank walls still register) along aim
    const sx = pl.pos.x + ax * 0.3, sz = pl.pos.z + az * 0.3;
    const moving = Math.hypot(pl.vel.x, pl.vel.z) > 1;
    const spreadDeg = s.spread * (moving ? 1.25 : 1) + pl.bloom * (B.pellets > 1 ? 0 : 4);
    pl.bloom = Math.min(1, pl.bloom + B.recoil * 0.25);
    let anyHit = false, kill = false;
    for (let p = 0; p < s.pellets; p++) {
      const a = ((Math.random() - 0.5) * 2 * spreadDeg * Math.PI) / 180 * (B.pellets > 1 ? 1 : Math.random());
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = ax * ca - az * sa, dz = ax * sa + az * ca;
      const range = s.range * (B.pellets > 1 ? 0.85 + Math.random() * 0.3 : 1);
      const r = this.trace(sx, sz, dx, dz, range, s.dmg, s.crit, B.pierce || 0, s.range);
      if (r.hit) anyHit = true; if (r.kill) kill = true;
      const ex = r.x, ez = r.z;
      if (p < 4 || Math.random() < 0.4) g.fx.tracer(m.x, m.y, m.z, ex, r.y, ez, B.pellets > 1 ? 0xffb060 : 0xffd090, B.pellets > 1 ? 0.035 : 0.055, 170);
    }
    g.fx.muzzle(m.x, m.y, m.z, ax, az, B.pellets > 1 ? 1.4 : w.base === 'dmr' ? 1.2 : 1);
    g.fx.casing(m.x - ax * 0.4, m.y, m.z - az * 0.4, ax, az, w.base === 'shotgun');
    g.audio.play(B.sound, pl.pos, { minGap: 0.02 });
    g.renderer.addTrauma(B.shake);
    g.renderer.kick(ax, az, B.recoil * 0.25);
    pl.hum.recoil = Math.min(1, pl.hum.recoil + B.recoil);
    g.enemies.noise(pl.pos.x, pl.pos.z, 32);
    if (anyHit) g.hud.hitmarker(kill);
    g.hud.dirty();
  }

  trace(sx, sz, dx, dz, range, dmg, crit, pierce, fullRange) {
    const g = this.game;
    const ex = sx + dx * range, ez = sz + dz * range;
    const wall = g.col.raycast(sx, sz, ex, ez, BULLET_Y);
    let tMax = wall ? wall.t : 1;
    // enemies along the segment
    const hits = [];
    for (const e of g.enemies.list) {
      if (e.dead) continue;
      const r = e.radius + 0.12;
      const fx = e.pos.x - sx, fz = e.pos.z - sz;
      const tp = (fx * dx + fz * dz) / range; if (tp < 0 || tp > tMax + r / range) continue;
      const px = sx + dx * range * tp - e.pos.x, pz = sz + dz * range * tp - e.pos.z;
      const d2 = px * px + pz * pz; if (d2 > r * r) continue;
      const back = Math.sqrt(r * r - d2) / range;
      hits.push({ e, t: Math.max(0, tp - back) });
    }
    hits.sort((a, b) => a.t - b.t);
    let hit = false, kill = false, endT = tMax, y = BULLET_Y;
    for (const h of hits) {
      if (h.t > tMax) break;
      const dist = h.t * range;
      const fall = dist > fullRange * 0.6 ? Math.max(0.5, 1 - (dist - fullRange * 0.6) / (fullRange * 0.8)) : 1;
      const isCrit = Math.random() < crit;
      const d = dmg * fall * (isCrit ? 2 : 1);
      const hx = sx + dx * dist, hz = sz + dz * dist;
      if (g.enemies.damage(h.e, d, dx, dz, isCrit, hx, hz)) kill = true;
      hit = true;
      endT = h.t; y = 1.2;
      if (pierce-- <= 0) break;
    }
    const x = sx + dx * range * endT, z = sz + dz * range * endT;
    if (!hit && wall) {
      const kind = wall.box.kind === 'car' || wall.box.kind === 'container' || wall.box.kind === 'barrel' || wall.box.kind === 'pole' ? 'metal' : 'concrete';
      g.fx.impact(x - dx * 0.05, BULLET_Y, z - dz * 0.05, wall.nx, wall.nz, kind);
      if (Math.random() < 0.5) g.audio.play(kind === 'metal' ? 'impactMetal' : 'impact', { x, z }, { minGap: 0.04 });
    } else if (!hit) {
      // bullet lands on ground at max range
      g.fx.impact(x, 0.05, z, 0, 0, 'concrete');
      y = 0.2;
    }
    return { hit, kill, x, z, y };
  }

  enemyShoot(e, ox, oy, oz, dx, dz, speed, dmg, color) {
    const m = new THREE.Mesh(this.projGeo, this.projMat);
    m.position.set(ox, BULLET_Y, oz); m.lookAt(ox + dx, BULLET_Y, oz + dz);
    this.game.scene.add(m);
    this.projectiles.push({ m, x: ox, z: oz, dx, dz, speed, dmg, life: 1.6, owner: e });
    this.game.fx.muzzle(ox, oy, oz, dx, dz, 0.8, [1, 0.45, 0.2]);
    this.game.audio.play('enemyShot', { x: ox, z: oz }, { minGap: 0.03 });
  }

  update(dt) {
    const g = this.game, pl = g.player;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      const nx = p.x + p.dx * p.speed * dt, nz = p.z + p.dz * p.speed * dt;
      let done = p.life <= 0;
      const wall = g.col.raycast(p.x, p.z, nx, nz, BULLET_Y);
      // player hit (segment vs circle)
      if (!done && !pl.dead) {
        const fx = pl.pos.x - p.x, fz = pl.pos.z - p.z, segL = p.speed * dt;
        const tp = Math.max(0, Math.min(segL, fx * p.dx + fz * p.dz));
        const cx = p.x + p.dx * tp - pl.pos.x, cz = p.z + p.dz * tp - pl.pos.z;
        if (cx * cx + cz * cz < 0.45 * 0.45 && (!wall || wall.t * segL > tp)) {
          if (pl.damage(p.dmg, p.x, p.z)) { g.fx.impact(pl.pos.x - p.dx * 0.3, 1.2, pl.pos.z - p.dz * 0.3, -p.dx, -p.dz, 'flesh'); g.audio.play('flesh', pl.pos); done = true; }
        }
      }
      if (!done && wall) { done = true; g.fx.impact(wall.x - p.dx * 0.05, BULLET_Y, wall.z - p.dz * 0.05, wall.nx, wall.nz, 'concrete'); }
      p.x = nx; p.z = nz; p.m.position.set(nx, BULLET_Y, nz);
      if (Math.random() < 0.5) g.fx.add.emit({ x: nx, y: BULLET_Y, z: nz, life: 0.12, s0: 0.12, s1: 0.02, c0: [2, 0.5, 0.15, 0.8], c1: [1, 0.2, 0.05, 0] });
      if (done) { g.scene.remove(p.m); this.projectiles.splice(i, 1); }
    }
  }
  clear() { for (const p of this.projectiles) this.game.scene.remove(p.m); this.projectiles.length = 0; }
}
