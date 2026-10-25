// Enemy archetypes + AI. Raiders: ranged, telegraphed bursts (laser sight), strafe, seek cover.
// Mutants: fast zig-zag melee rushers. Brutes: slow tanky ground-slam. Shared perception
// (sight cone + LOS, gunfire noise, group alerts) and flow-field pathing toward the player.
import * as THREE from 'three';
import { Humanoid } from './humanoid.js';
import { weaponModel } from '../combat/weapons.js';
import { clamp, damp } from '../core/rng.js';

export const DEFS = {
  raider: { hp: 60, speed: 3.6, walk: 1.5, radius: 0.42, sight: 26, ranged: true, range: 20, burst: 3, burstGap: 0.12, aimTime: 0.55, cd: [0.9, 1.7], projSpeed: 30, dmg: 7, xp: 10, dropChance: 0.5, tierBonus: 0 },
  mutant: { hp: 45, speed: 6.4, walk: 1.8, radius: 0.42, sight: 22, melee: true, reach: 1.9, dmg: 13, atkTime: 0.7, hitAt: 0.45, xp: 8, dropChance: 0.3, tierBonus: 0 },
  brute: { hp: 280, speed: 3.1, walk: 1.3, radius: 0.55, sight: 22, melee: true, slam: true, reach: 2.9, dmg: 32, atkTime: 1.25, hitAt: 0.6, xp: 40, dropChance: 1, tierBonus: 1.5 },
};

let laserGeo = null;
export class EnemyManager {
  constructor(game) {
    this.game = game; this.list = [];
    if (!laserGeo) { laserGeo = new THREE.PlaneGeometry(1, 1); laserGeo.rotateX(-Math.PI / 2); laserGeo.translate(0, 0, 0.5); }
    this.laserMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.15, 0.05), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
    this.losT = 0;
  }
  spawn(type, x, z, group = 'debug') {
    const def = DEFS[type]; if (!def) return null;
    const hum = new Humanoid(type);
    if (def.ranged) hum.setWeapon(weaponModel('rifle', 'common'));
    this.game.scene.add(hum.root);
    const e = { type, def, hum, pos: { x, z }, vel: { x: 0, z: 0 }, face: Math.random() * 6.28, hp: def.hp, maxHp: def.hp, radius: def.radius * hum.K.scale,
      state: 'patrol', alert: false, sees: false, lastSeen: null, home: { x, z }, group, wait: Math.random() * 2, goal: null,
      fireT: 1 + Math.random(), burstLeft: 0, aimT: 0, strafe: Math.random() < 0.5 ? 1 : -1, strafeT: 0, coverT: 0, cover: null,
      atkT: -1, atkCd: 0, stagger: 0, dead: false, deadT: 0, id: this.list.length, losCheck: Math.random() * 0.2, stuckT: 0, lastPos: { x, z }, hpShow: 0, zig: Math.random() * 6 };
    hum.root.position.set(x, 0, z);
    if (type === 'brute') hum.stepCb = () => { const g = this.game, d = Math.hypot(g.player.pos.x - e.pos.x, g.player.pos.z - e.pos.z); g.fx.puff(e.pos.x, e.pos.z, 1.4, 2); if (e.alert) g.renderer.addTrauma(0.06 * clamp(1 - d / 16, 0, 1)); };
    else if (type === 'mutant') hum.stepCb = () => { if (Math.random() < 0.35) this.game.fx.puff(e.pos.x, e.pos.z, 0.7, 1); };
    if (def.ranged) { e.laser = new THREE.Mesh(laserGeo, this.laserMat); e.laser.visible = false; e.laser.renderOrder = 5; this.game.scene.add(e.laser); }
    this.list.push(e);
    return e;
  }
  get alive() { return this.list.filter((e) => !e.dead); }

  noise(x, z, r) {
    for (const e of this.list) if (!e.dead && Math.hypot(e.pos.x - x, e.pos.z - z) < r) this.alertE(e, x, z);
  }
  alertE(e, x, z, spread = true) {
    const was = e.alert;
    e.alert = true; e.alertT = 10; if (!e.sees) e.lastSeen = { x, z };
    if (!was) {
      if (e.type === 'mutant' && Math.random() < 0.6) this.game.audio.play('scream', e.pos, { pitch: 0.9 + Math.random() * 0.3 });
      if (spread) for (const o of this.list) if (o !== e && !o.dead && o.group === e.group && Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z) < 22) this.alertE(o, x, z, false);
    }
  }

  damage(e, dmg, dx, dz, crit, hx, hz, power = 1) {
    if (e.dead) return false;
    const g = this.game;
    const prevHp = e.hp;
    e.hp -= dmg; e.hpShow = 3;
    g.player.damageDealt += dmg;
    const brute = e.type === 'brute';
    e.hum.hit(dx, dz, (brute ? 0.45 : 1.2) * Math.min(1.6, 0.6 + power * 0.5));
    if (!brute) { e.vel.x += dx * 1.6 * power; e.vel.z += dz * 1.6 * power; e.stagger = Math.max(e.stagger, 0.1 + 0.06 * power); }
    else e.stagger = Math.max(e.stagger, 0.04);
    const hy = 1.15 * e.hum.K.scale;
    // brutes wear plate: half the hits spark off the armour
    if (brute && Math.random() < 0.5) g.fx.impact(hx - dx * 0.25, hy, hz - dz * 0.25, -dx, -dz, 'metal', dx, dz, 0.6);
    else g.fx.impact(hx - dx * 0.2, hy, hz - dz * 0.2, -dx, -dz, e.type === 'mutant' ? 'ichor' : 'flesh', dx, dz, power);
    g.hud.damageNumber(e.pos.x, 2.1 * e.hum.K.scale, e.pos.z, dmg, crit, e);
    g.audio.play('flesh', e.pos, { minGap: 0.05 });
    this.alertE(e, g.player.pos.x, g.player.pos.z);
    if (e.hp <= 0) { this.kill(e, dx, dz, { overkill: -e.hp, dmg, power, firstHp: prevHp }); return true; }
    if (Math.random() < 0.3) g.audio.play('enemyHurt', e.pos, { minGap: 0.2 });
    // ranged enemies under fire like to break for cover
    if (e.def.ranged && e.hp < e.maxHp * 0.6 && e.state !== 'cover' && Math.random() < 0.25) this.goCover(e);
    return false;
  }
  kill(e, dx, dz, info = {}) {
    const g = this.game;
    e.dead = true; e.deadT = 0; e.hp = 0;
    if (e.laser) e.laser.visible = false;
    const brute = e.type === 'brute', sc = e.hum.K.scale;
    const blood = e.type === 'mutant' ? 'ichor' : 'blood';
    // overkill -> gibs (shotgun at point blank, DMR crits); otherwise a physical death fall
    const ok = (info.overkill || 0) + (info.dmg || 0) * ((info.power || 1) - 1);
    const shot = g.combat.shot && g.combat.shot.get(e);
    const pellets = shot ? shot.n : 1;
    const gib = !brute && (pellets >= 6 || ok > e.maxHp * 0.55 || (info.power >= 1.8 && Math.random() < 0.5));
    const push = brute ? 1.5 : 3 + pellets * 0.9 + (info.power || 1) * 1.5;
    e.hum.die(dx, dz, { push, gib, kind: e.type, headshot: !gib && Math.random() < 0.25 });
    g.fx.gore(e.pos.x, e.pos.z, dx, dz, blood, gib ? 14 : brute ? 6 : 3, sc);
    if (gib) { g.fx.gore(e.pos.x, e.pos.z, dx, dz, blood, 8, sc); g.fx.pool(e.pos.x, e.pos.z, 1.6, blood, 0.1); }
    else e.poolAt = 0.9; // pool once the body has landed
    if (brute) { g.fx.dustRing(e.pos.x, e.pos.z, 2.5); g.renderer.addTrauma(0.5); }
    // kill punctuation: hit-stop + camera trauma (bigger for heavies / gibs)
    g.combat.hitStop(brute ? 0.12 : gib ? 0.075 : 0.05, brute ? 0.05 : 0.1);
    g.renderer.addTrauma(brute ? 0.35 : gib ? 0.22 : 0.12);
    g.audio.play('die', e.pos);
    g.audio.play('kill', null);
    g.player.kills++;
    g.loot.onEnemyKilled(e);
    g.hud.feedKill(e.type);
    if (g.hud.killPop) g.hud.killPop(e.pos.x, 2.4 * sc, e.pos.z, gib);
  }

  goCover(e) {
    const g = this.game, pl = g.player;
    let best = null, bestScore = Infinity;
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2, r = 2 + (i % 4) * 1.8;
      const x = e.pos.x + Math.cos(a) * r, z = e.pos.z + Math.sin(a) * r;
      if (!g.nav.walkable(x, z)) continue;
      // cover = something between player and point, close to the point
      const hit = g.col.raycast(pl.pos.x, pl.pos.z, x, z, 1.0);
      if (!hit) continue;
      const hx = hit.x - x, hz = hit.z - z; const dc = Math.hypot(hx, hz);
      if (dc > 1.6) continue;
      const dPl = Math.hypot(x - pl.pos.x, z - pl.pos.z); if (dPl < 6) continue;
      const score = r + Math.abs(dPl - 13) * 0.3;
      if (score < bestScore) { bestScore = score; best = { x, z }; }
    }
    if (best) { e.state = 'cover'; e.cover = best; e.coverT = 0; e.coverWait = 1.0 + Math.random() * 1.4; }
  }

  update(dt) {
    const g = this.game, pl = g.player, col = g.col;
    for (const e of this.list) {
      const hum = e.hum, def = e.def;
      if (e.dead) {
        e.deadT += dt;
        // corpse slides with its death momentum (friction), collides with walls
        if (hum.corpseVel) {
          const cv = hum.corpseVel, k = Math.exp(-(e.deadT < 0.25 ? 2 : 7) * dt);
          cv.x *= k; cv.z *= k;
          const np = { x: e.pos.x + cv.x * dt, z: e.pos.z + cv.z * dt }; col.resolveCircle(np, 0.3);
          e.pos.x = np.x; e.pos.z = np.z; hum.root.position.x = e.pos.x; hum.root.position.z = e.pos.z;
        }
        hum.update(dt, {});
        if (hum.headless > 0 && Math.random() < 0.7) { const n = hum.neckWorld(); g.fx.bloodHit(n.x, n.y, n.z, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, undefined, 0.35); }
        if (e.poolAt && e.deadT > e.poolAt) { e.poolAt = 0; const b = hum.bodyAnchor(); g.fx.pool(b.x, b.z, 1.2 + Math.random() * 0.8 * hum.K.scale, e.type === 'mutant' ? 'ichor' : 'blood', 0); }
        if (hum.dissolve > 0 && Math.random() < 0.5) { const b = hum.bodyAnchor(); g.fx.embers(b.x, 0.2, b.z, 1); }
        if (e.deadT > 8.5) { e.remove = true; }
        continue;
      }
      // cheap distance culling: far, unalerted enemies idle
      const dxp = pl.pos.x - e.pos.x, dzp = pl.pos.z - e.pos.z, dist = Math.hypot(dxp, dzp);
      hum.root.visible = dist < 60;
      if (dist > 70 && !e.alert) continue;
      // perception
      e.losCheck -= dt;
      if (e.losCheck <= 0) {
        e.losCheck = 0.15 + Math.random() * 0.1;
        const fdx = Math.sin(e.face), fdz = Math.cos(e.face);
        const inFov = (dxp * fdx + dzp * fdz) / (dist || 1) > -0.2;
        e.sees = !pl.dead && dist < def.sight * (pl.lowProfile ? 0.6 : 1) && (e.alert || dist < 9 || inFov) && col.los(e.pos.x, e.pos.z, pl.pos.x, pl.pos.z, 1.5);
        if (e.sees) { e.lastSeen = { x: pl.pos.x, z: pl.pos.z }; if (!e.alert) this.alertE(e, pl.pos.x, pl.pos.z); e.alertT = 10; }
      }
      if (e.alert && !e.sees) { e.alertT -= dt; if (e.alertT <= 0 || pl.dead) { e.alert = false; e.state = 'patrol'; } }
      if (pl.dead && e.alert) { e.alert = false; e.state = 'patrol'; }
      e.stagger = Math.max(0, e.stagger - dt);
      e.atkCd = Math.max(0, e.atkCd - dt);
      e.hpShow = Math.max(0, e.hpShow - dt);

      let mvx = 0, mvz = 0, speed = 0, faceX = null, faceZ = null;
      const toward = (tx, tz) => { const dx = tx - e.pos.x, dz = tz - e.pos.z, l = Math.hypot(dx, dz) || 1; return { x: dx / l, z: dz / l, l }; };
      const pathTo = (tx, tz, usePlayerFlow) => {
        if (usePlayerFlow) { const f = g.nav.flowDir(e.pos.x, e.pos.z); if (f && isFinite(f.cost)) return f; }
        return toward(tx, tz);
      };

      if (!e.alert) {
        // patrol around home
        if (e.wait > 0) e.wait -= dt;
        else {
          if (!e.goal) { const a = Math.random() * 6.28, r = 2 + Math.random() * 7; const p = g.nav.nearestWalkable(e.home.x + Math.cos(a) * r, e.home.z + Math.sin(a) * r, 3); e.goal = p || { x: e.home.x, z: e.home.z }; }
          const t = toward(e.goal.x, e.goal.z);
          if (t.l < 0.6 || e.stuckT > 1.5) { e.goal = null; e.wait = 1.5 + Math.random() * 3; e.stuckT = 0; }
          else { mvx = t.x; mvz = t.z; speed = def.walk; }
        }
        if (e.laser) e.laser.visible = false;
      } else if (def.ranged) {
        if (e.state === 'cover' && e.cover) {
          const t = toward(e.cover.x, e.cover.z);
          if (t.l > 0.5 && e.coverT < 4) { mvx = t.x; mvz = t.z; speed = def.speed * 1.1; e.coverT += dt; }
          else { e.coverWait -= dt; hum.crouch = 1; if (e.coverWait <= 0) { e.state = 'engage'; e.cover = null; hum.crouch = 0; e.fireT = 0.2; } }
          if (e.laser) e.laser.visible = false;
        } else {
          e.state = 'engage';
          if (e.sees && dist < def.range) {
            faceX = dxp; faceZ = dzp;
            // keep preferred distance + strafe
            e.strafeT -= dt; if (e.strafeT <= 0) { e.strafeT = 1 + Math.random() * 2; e.strafe *= -1; }
            const nx = dxp / dist, nz = dzp / dist;
            let fwd = dist > 15 ? 0.6 : dist < 7 ? -0.8 : 0;
            mvx = nx * fwd + -nz * e.strafe * 0.7; mvz = nz * fwd + nx * e.strafe * 0.7;
            speed = e.aimT > 0 || e.burstLeft > 0 ? def.walk * 0.6 : def.walk * 1.4;
            // shooting cycle
            e.fireT -= dt;
            if (e.burstLeft > 0) {
              e.fireT -= 0;
              if (e.fireT <= 0) {
                e.burstLeft--; e.fireT = def.burstGap;
                const m = this.muzzle(e);
                const spread = (Math.random() - 0.5) * 0.12 + (pl.rollT >= 0 ? (Math.random() - 0.5) * 0.2 : 0);
                // lead the target a little
                const lead = dist / def.projSpeed * 0.5;
                const tx = pl.pos.x + pl.vel.x * lead - m.x, tz = pl.pos.z + pl.vel.z * lead - m.z, tl = Math.hypot(tx, tz) || 1;
                const ca = Math.cos(spread), sa = Math.sin(spread);
                const ddx = (tx / tl) * ca - (tz / tl) * sa, ddz = (tx / tl) * sa + (tz / tl) * ca;
                g.combat.enemyShoot(e, m.x, m.y, m.z, ddx, ddz, def.projSpeed, def.dmg);
                hum.recoil = Math.min(1, hum.recoil + 0.5);
                if (e.burstLeft === 0) { e.fireT = def.cd[0] + Math.random() * (def.cd[1] - def.cd[0]); if (Math.random() < (e.hp < e.maxHp * 0.5 ? 0.55 : 0.25)) this.goCover(e); }
              }
              if (e.laser) e.laser.visible = false;
            } else if (e.aimT > 0) {
              e.aimT -= dt;
              this.updateLaser(e, true);
              if (e.aimT <= 0) { e.burstLeft = def.burst; e.fireT = 0; }
            } else if (e.fireT <= 0) { e.aimT = def.aimTime; }
            else if (e.laser) e.laser.visible = false;
          } else {
            // chase to regain sight
            const t = pathTo(e.lastSeen ? e.lastSeen.x : pl.pos.x, e.lastSeen ? e.lastSeen.z : pl.pos.z, true);
            mvx = t.x; mvz = t.z; speed = def.speed; e.aimT = 0; e.burstLeft = 0;
            if (e.laser) e.laser.visible = false;
          }
        }
      } else if (def.melee) {
        if (e.atkT >= 0) {
          e.atkT += dt / def.atkTime;
          hum.attackT = e.atkT;
          faceX = dxp; faceZ = dzp;
          const prev = e.atkT - dt / def.atkTime;
          if (prev < def.hitAt && e.atkT >= def.hitAt) {
            if (def.slam) {
              g.fx.dustRing(e.pos.x + Math.sin(e.face) * 1.2, e.pos.z + Math.cos(e.face) * 1.2, 3);
              g.renderer.addTrauma(0.45 * clamp(1 - dist / 14, 0, 1));
              g.audio.play('slam', e.pos);
              if (dist < def.reach + 0.6) pl.damage(def.dmg, e.pos.x, e.pos.z) && (pl.vel.x += dxp / dist * 9, pl.vel.z += dzp / dist * 9);
            } else {
              g.audio.play('swing', e.pos);
              const fdx = Math.sin(e.face), fdz = Math.cos(e.face);
              if (dist < def.reach + 0.35 && (dxp * fdx + dzp * fdz) / dist > 0.3) { if (pl.damage(def.dmg, e.pos.x, e.pos.z)) { g.fx.impact(pl.pos.x, 1.2, pl.pos.z, dxp / dist, dzp / dist, 'flesh'); g.audio.play('flesh', pl.pos); } }
            }
          }
          if (e.atkT >= 1) { e.atkT = -1; hum.attackT = -1; e.atkCd = def.slam ? 1.0 : 0.35; }
          // lunge during wind-up
          if (!def.slam && e.atkT < def.hitAt) { mvx = dxp / dist; mvz = dzp / dist; speed = def.speed * 0.5; }
        } else if (dist < def.reach && e.sees && e.atkCd <= 0) {
          e.atkT = 0;
        } else {
          const t = e.sees && dist < 12 ? toward(pl.pos.x, pl.pos.z) : pathTo(pl.pos.x, pl.pos.z, true);
          mvx = t.x; mvz = t.z; speed = def.speed;
          if (e.type === 'mutant' && e.sees && dist > 3) { e.zig += dt * 5; const z = Math.sin(e.zig) * 0.6; const px = -mvz, pz = mvx; mvx += px * z; mvz += pz * z; }
        }
      }
      // separation from other enemies
      for (const o of this.list) {
        if (o === e || o.dead) continue;
        const sx = e.pos.x - o.pos.x, sz = e.pos.z - o.pos.z, d2 = sx * sx + sz * sz, rr = e.radius + o.radius + 0.2;
        if (d2 < rr * rr && d2 > 1e-4) { const d = Math.sqrt(d2); mvx += (sx / d) * (rr - d) * 2; mvz += (sz / d) * (rr - d) * 2; }
      }
      const ml = Math.hypot(mvx, mvz); if (ml > 1) { mvx /= ml; mvz /= ml; }
      const sp = speed * (e.stagger > 0 ? 0.2 : 1);
      e.vel.x = damp(e.vel.x, mvx * sp, 8, dt); e.vel.z = damp(e.vel.z, mvz * sp, 8, dt);
      const np = { x: e.pos.x + e.vel.x * dt, z: e.pos.z + e.vel.z * dt };
      col.resolveCircle(np, e.radius);
      // keep out of the player
      const px = np.x - pl.pos.x, pz = np.z - pl.pos.z, pd = Math.hypot(px, pz), pr = e.radius + pl.radius;
      if (pd < pr && pd > 1e-3 && !pl.dead) { np.x = pl.pos.x + (px / pd) * pr; np.z = pl.pos.z + (pz / pd) * pr; }
      // stuck detection
      const moved = Math.hypot(np.x - e.pos.x, np.z - e.pos.z);
      if (speed > 0.5 && moved < speed * dt * 0.25) e.stuckT += dt; else e.stuckT = Math.max(0, e.stuckT - dt);
      if (e.stuckT > 0.8 && e.alert) { e.vel.x += (Math.random() - 0.5) * 6; e.vel.z += (Math.random() - 0.5) * 6; e.stuckT = 0; }
      e.pos.x = np.x; e.pos.z = np.z;
      // facing
      const fx = faceX ?? e.vel.x, fz = faceZ ?? e.vel.z;
      if (Math.hypot(fx, fz) > 0.05) { let df = Math.atan2(fx, fz) - e.face; df = Math.atan2(Math.sin(df), Math.cos(df)); e.face += df * Math.min(1, dt * (faceX !== null ? 10 : 6)); }
      const y = g.env.heightAt(e.pos.x, e.pos.z);
      hum.root.position.set(e.pos.x, damp(hum.root.position.y, y, 15, dt), e.pos.z);
      hum.root.rotation.y = e.face;
      hum.update(dt, { speed: Math.hypot(e.vel.x, e.vel.z), moveX: e.vel.x, moveZ: e.vel.z });
    }
    // remove finished corpses
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.remove) { g.scene.remove(e.hum.root); e.hum.dispose(); if (e.laser) g.scene.remove(e.laser); this.list.splice(i, 1); }
    }
  }
  muzzle(e) {
    const wm = e.hum.weaponMount; wm.updateWorldMatrix(true, false);
    return new THREE.Vector3(0, 0.035, 0.66).applyMatrix4(wm.matrixWorld);
  }
  updateLaser(e, on) {
    if (!e.laser) return;
    e.laser.visible = on;
    if (!on) return;
    const g = this.game, pl = g.player;
    const m = this.muzzle(e);
    const dx = pl.pos.x - m.x, dz = pl.pos.z - m.z, l = Math.hypot(dx, dz) || 1;
    const hit = g.col.raycast(m.x, m.z, m.x + (dx / l) * 30, m.z + (dz / l) * 30, 1.3);
    const len = hit ? hit.t * 30 : Math.min(30, l + 2);
    e.laser.position.set(m.x, 1.3, m.z); e.laser.lookAt(m.x + dx, 1.3, m.z + dz);
    e.laser.scale.set(0.03 + (1 - e.aimT / e.def.aimTime) * 0.03, 1, len);
  }
  clear() {
    for (const e of this.list) { this.game.scene.remove(e.hum.root); e.hum.dispose(); if (e.laser) this.game.scene.remove(e.laser); }
    this.list.length = 0;
  }
}
