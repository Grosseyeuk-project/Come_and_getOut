// Player hitscan firing (spread, pellets, pierce, crits, falloff), enemy projectiles, damage routing.
import * as THREE from 'three';
import { BASES } from './weapons.js';

const BULLET_Y = 1.3;

export class Combat {
  constructor(game) {
    this.game = game;
    this.projectiles = [];
    this.stopT = 0; this.stopScale = 1; this.shot = null;
    const g = new THREE.SphereGeometry(0.07, 8, 6); g.scale(1, 1, 5);
    this.projGeo = g;
    this.projMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.1, 0.3), fog: false });
  }

  playerFire(pl, w) {
    const g = this.game, B = BASES[w.base], s = w.stats, shotgun = B.pellets > 1;
    w.cooldown = 60 / s.rpm; w.mag--;
    pl.shotsFired++;
    const m = pl.muzzleWorld();
    let ax = pl.aim.x - pl.pos.x, az = pl.aim.z - pl.pos.z; const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
    // soft aim assist (twin-stick convention): snap toward the enemy nearest the aim ray inside a narrow cone
    { let best = null, bestA = shotgun ? 0.05 : 0.11;
      for (const e of g.enemies.list) {
        if (e.dead) continue;
        const ex = e.pos.x - pl.pos.x, ez = e.pos.z - pl.pos.z, d = Math.hypot(ex, ez); if (d < 0.5 || d > s.range) continue;
        const ang = Math.acos(Math.max(-1, Math.min(1, (ex * ax + ez * az) / d))) - Math.atan2(e.radius, d);
        if (ang < bestA && g.col.los(pl.pos.x, pl.pos.z, e.pos.x, e.pos.z, BULLET_Y)) { bestA = ang; best = { x: ex / d, z: ez / d }; }
      }
      if (best) { ax = ax * 0.25 + best.x * 0.75; az = az * 0.25 + best.z * 0.75; const l = Math.hypot(ax, az) || 1; ax /= l; az /= l; } }
    // fire from slightly behind muzzle (so point-blank walls still register) along aim
    const sx = pl.pos.x + ax * 0.3, sz = pl.pos.z + az * 0.3;
    const moving = Math.hypot(pl.vel.x, pl.vel.z) > 1;
    const spreadDeg = s.spread * (moving ? 1.25 : 1) + pl.bloom * (shotgun ? 0 : 4);
    pl.bloom = Math.min(1, pl.bloom + B.recoil * 0.25);
    let anyHit = false, kill = false;
    this.shot = new Map(); // enemy -> { n, dmg } accumulated over pellets (knockback / gib decisions)
    for (let p = 0; p < s.pellets; p++) {
      // shotgun: even fan with jitter so the pattern reads as a spread, not a random clump
      const a = shotgun ? (((p + 0.5) / s.pellets - 0.5) * 2 + (Math.random() - 0.5) * 0.35) * spreadDeg * Math.PI / 180
        : ((Math.random() - 0.5) * 2 * spreadDeg * Math.PI) / 180 * Math.random();
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = ax * ca - az * sa, dz = ax * sa + az * ca;
      const range = s.range * (shotgun ? 0.85 + Math.random() * 0.3 : 1);
      const r = this.trace(sx, sz, dx, dz, range, s.dmg, s.crit, B.pierce || 0, s.range, shotgun ? 0.55 : w.base === 'dmr' ? 1.8 : 1);
      if (r.hit) anyHit = true; if (r.kill) kill = true;
      g.fx.bullet(m.x, m.y, m.z, r.x, r.y, r.z, w.base);
    }
    // shotgun knockback: proportional to pellets that connected
    for (const [e, h] of this.shot) {
      const kb = shotgun ? h.n * 1.1 : (w.base === 'dmr' ? 2.5 : 0.4);
      const res = e.type === 'brute' ? 0.25 : 1;
      e.vel.x += h.dx * kb * res; e.vel.z += h.dz * kb * res;
      if (shotgun && h.n >= 3 && !e.dead) { e.stagger = Math.max(e.stagger, 0.35 * res); e.hum.hit(h.dx, h.dz, 2.2 * res); }
    }
    this.shot = null;
    g.fx.muzzle(m.x, m.y, m.z, ax, az, 1, undefined, w.base);
    if (shotgun) w.pumpT = 0.28; // casing ejected on the pump
    else g.fx.casing(m.x - ax * 0.45, m.y + 0.03, m.z - az * 0.45, ax, az, false);
    g.audio.play(B.sound, pl.pos, { minGap: 0.02 });
    g.renderer.addTrauma(B.shake * (shotgun ? 1.3 : 0.9));
    g.renderer.kick(ax, az, B.recoil * (shotgun ? 0.75 : 0.32));
    pl.hum.recoil = Math.min(1.4, pl.hum.recoil + B.recoil * (shotgun ? 1.4 : 1));
    // shooter is shoved back a touch by heavy weapons
    if (shotgun || w.base === 'dmr') { pl.vel.x -= ax * (shotgun ? 2.2 : 1.2); pl.vel.z -= az * (shotgun ? 2.2 : 1.2); }
    g.enemies.noise(pl.pos.x, pl.pos.z, 32);
    if (anyHit) g.hud.hitmarker(kill);
    g.hud.dirty();
  }

  // brief global slow-down on kills (hit-stop); game.step scales dt by timeScale()
  hitStop(dur, scale = 0.08) { if (dur > this.stopT) { this.stopT = dur; this.stopScale = scale; } }
  timeScale(dt) {
    if (!(this.stopT > 0)) return 1;
    this.stopT -= dt; // real time
    return this.stopScale;
  }

  trace(sx, sz, dx, dz, range, dmg, crit, pierce, fullRange, power = 1) {
    const g = this.game;
    const ex = sx + dx * range, ez = sz + dz * range;
    const wall = g.col.raycast(sx, sz, ex, ez, BULLET_Y);
    let tMax = wall ? wall.t : 1;
    // enemies along the segment
    const hits = [];
    for (const e of g.enemies.list) {
      if (e.dead) continue;
      const r = e.radius + 0.2;
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
      if (this.shot) { const a = this.shot.get(h.e) || { n: 0, dmg: 0, dx: 0, dz: 0 }; a.n++; a.dmg += d; a.dx = dx; a.dz = dz; this.shot.set(h.e, a); }
      if (g.enemies.damage(h.e, d, dx, dz, isCrit, hx, hz, power)) kill = true;
      hit = true;
      endT = h.t; y = 1.2;
      if (pierce-- <= 0) break;
    }
    const x = sx + dx * range * endT, z = sz + dz * range * endT;
    if (!hit && wall) {
      const k = wall.box.kind;
      const kind = k === 'car' || k === 'container' || k === 'barrel' || k === 'pole' || k === 'fence' ? 'metal' : k === 'tree' || k === 'tent' ? 'wood' : 'concrete';
      g.fx.impact(x - dx * 0.05, BULLET_Y, z - dz * 0.05, wall.nx, wall.nz, kind, dx, dz, power);
      if (Math.random() < 0.6) g.audio.play(kind === 'metal' ? 'impactMetal' : 'impact', { x, z }, { minGap: 0.04, surface: kind });
    } else if (!hit) {
      // bullet lands on the ground at max range: dirt kick-up
      g.fx.impact(x, 0.05, z, -dx * 0.4, -dz * 0.4, 'ground', dx, dz, power * 0.7);
      if (Math.random() < 0.5) g.audio.play('impact', { x, z }, { minGap: 0.05, surface: 'ground', vol: 0.7 });
      y = 0.1;
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
          if (pl.damage(p.dmg, p.x, p.z)) { g.fx.impact(pl.pos.x - p.dx * 0.2, 1.2, pl.pos.z - p.dz * 0.2, -p.dx, -p.dz, 'flesh', p.dx, p.dz, 0.6); g.audio.play('flesh', pl.pos); done = true; }
        }
      }
      if (!done && wall) { done = true; g.fx.impact(wall.x - p.dx * 0.05, BULLET_Y, wall.z - p.dz * 0.05, wall.nx, wall.nz, 'concrete', p.dx, p.dz, 0.6); }
      p.x = nx; p.z = nz; p.m.position.set(nx, BULLET_Y, nz);
      if (Math.random() < 0.5) g.fx.add.emit({ x: nx, y: BULLET_Y, z: nz, life: 0.12, s0: 0.12, s1: 0.02, c0: [2, 0.5, 0.15, 0.8], c1: [1, 0.2, 0.05, 0] });
      if (done) { g.scene.remove(p.m); this.projectiles.splice(i, 1); }
    }
  }
  clear() { for (const p of this.projectiles) this.game.scene.remove(p.m); this.projectiles.length = 0; this.stopT = 0; }
}
