// Player controller: camera-relative twin-stick movement, dodge roll with i-frames, weapon handling
// (fire / reload / swap), medkits, interaction, inventory state, footsteps and a shoulder flashlight.
import * as THREE from 'three';
import { Humanoid } from './humanoid.js';
import { weaponModel, rollWeapon, BASES, RARITY } from '../combat/weapons.js';
import { RNG, clamp, damp } from '../core/rng.js';
import { ringTex } from '../fx/fxtex.js';

export class Player {
  constructor(game) {
    this.game = game;
    this.hum = new Humanoid('player');
    this.root = this.hum.root;
    game.scene.add(this.root);
    this.pos = { x: 0, z: 0 }; this.y = 0;
    this.vel = { x: 0, z: 0 };
    this.face = 0; this.radius = 0.42;
    this.maxHp = 100; this.hp = 100;
    this.charges = 2; this.maxCharges = 2; this.chargeT = 0;
    this.rollT = -1; this.rollDur = 0.5; this.rollDir = { x: 0, z: 1 };
    this.invuln = 0; this.god = false;
    const rng = new RNG(game.seed ^ 0x77);
    this.weapons = [rollWeapon(rng, 'common', 'rifle'), rollWeapon(rng, 'common', 'shotgun')];
    this.cur = 0;
    this.backpack = []; this.maxBackpack = 8;
    this.medkits = 2; this.healT = 0; this.healLeft = 0;
    this.ammo = { light: 210, shells: 36, heavy: 30 };
    this.scrap = 0; this.kills = 0; this.damageDealt = 0; this.shotsFired = 0; this.lootValue = 0;
    this.bloom = 0; this.stepAcc = 0;
    this.aim = new THREE.Vector3();
    this.equip(0, true);
    // flashlight
    const spot = this.spot = new THREE.SpotLight(0xdde8ff, 55, 26, 0.42, 0.55, 1.6);
    spot.position.set(0, 1.6, 0); spot.castShadow = false;
    this.spotTarget = new THREE.Object3D(); game.scene.add(this.spotTarget); spot.target = this.spotTarget;
    game.scene.add(spot);
    // soft warm-neutral key/fill that rides with the hero so he reads as a pale figure on dark asphalt
    this.fill = new THREE.PointLight(0xffe6c8, 1.8, 5, 1.8); this.fill.castShadow = false; game.scene.add(this.fill);
    this.dead = false;
    // ground ring + aim chevron (readability on dark asphalt, The Ascent-style)
    const rg = new THREE.PlaneGeometry(1.9, 1.9); rg.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({ map: ringTex(), color: new THREE.Color(0.35, 1.3, 1.8), transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.ring = new THREE.Mesh(rg, this.ringMat); this.ring.renderOrder = 2; game.scene.add(this.ring);
    this.hum.stepCb = () => { if (Math.hypot(this.vel.x, this.vel.z) > 3) this.game.fx.puff(this.pos.x, this.pos.z, 0.6, 1); };
  }
  get weapon() { return this.weapons[this.cur]; }
  equip(i, silent = false) {
    if (!this.weapons[i]) return;
    if (this.weapon && this.weapon.reloadT > 0) this.weapon.reloadT = 0;
    this.cur = i;
    const w = this.weapon;
    this.hum.setWeapon(weaponModel(w.base, w.rarity));
    w.cooldown = Math.max(w.cooldown, 0.25);
    if (!silent) this.game.audio.play('equip', this.pos, { vol: 0.8 });
    this.game.hud && this.game.hud.dirty();
  }
  muzzleWorld() {
    const wm = this.hum.weaponMount; wm.updateWorldMatrix(true, false);
    return new THREE.Vector3(0, 0.035, this.hum.weapon ? this.hum.weapon.userData.muzzle : 0.6).applyMatrix4(wm.matrixWorld);
  }
  placeAt(x, z) { this.pos.x = x; this.pos.z = z; this.vel.x = this.vel.z = 0; this.root.position.set(x, 0, z); }

  damage(amount, fromX, fromZ) {
    if (this.dead || this.invuln > 0 || this.god) return false;
    this.hp -= amount;
    const dx = this.pos.x - fromX, dz = this.pos.z - fromZ, l = Math.hypot(dx, dz) || 1;
    this.hum.hit(dx / l, dz / l, 1);
    this.game.onPlayerHurt(amount);
    if (this.hp <= 0) { this.hp = 0; this.dead = true; this.hum.die(dx / l, dz / l); this.game.onPlayerDeath(); }
    return true;
  }

  update(dt, input, aimPoint) {
    const g = this.game;
    this.aim.copy(aimPoint);
    if (this.dead) { this.ring.visible = false; this.hum.update(dt, {}); this.root.position.set(this.pos.x, this.y, this.pos.z); return; }
    this.invuln = Math.max(0, this.invuln - dt);
    // charges
    if (this.charges < this.maxCharges) { this.chargeT += dt; if (this.chargeT >= 1.6) { this.chargeT = 0; this.charges++; } }
    // movement input (camera relative)
    const yaw = g.renderer.rig.yaw;
    const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) }, right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    let ix = 0, iz = 0;
    if (input.down('KeyW') || input.down('ArrowUp')) { ix += fwd.x; iz += fwd.z; }
    if (input.down('KeyS') || input.down('ArrowDown')) { ix -= fwd.x; iz -= fwd.z; }
    if (input.down('KeyD') || input.down('ArrowRight')) { ix += right.x; iz += right.z; }
    if (input.down('KeyA') || input.down('ArrowLeft')) { ix -= right.x; iz -= right.z; }
    const il = Math.hypot(ix, iz); if (il > 0) { ix /= il; iz /= il; }
    const w = this.weapon;
    const firing = input.mouse.down && g.mode === 'playing';
    // aim facing
    const ax = aimPoint.x - this.pos.x, az = aimPoint.z - this.pos.z;
    const targetFace = Math.atan2(ax, az);
    // dodge roll
    if (this.rollT >= 0) {
      this.rollT += dt;
      const p = this.rollT / this.rollDur;
      const sp = 11.5 * (1 - p * 0.55);
      this.vel.x = this.rollDir.x * sp; this.vel.z = this.rollDir.z * sp;
      this.face = Math.atan2(this.rollDir.x, this.rollDir.z);
      this.trailAcc = (this.trailAcc || 0) + dt * 40;
      while (this.trailAcc > 1) { this.trailAcc -= 1; g.fx.puff(this.pos.x - this.rollDir.x * 0.3, this.pos.z - this.rollDir.z * 0.3, 0.8, 1); }
      if (this.rollT >= this.rollDur) { this.rollT = -1; g.fx.puff(this.pos.x, this.pos.z, 1.1, 4); }
    } else {
      if (input.hit('Space') && this.charges > 0) {
        this.charges--; this.chargeT = 0;
        this.rollT = 0; this.invuln = this.rollDur * 0.85;
        const dx = il > 0 ? ix : Math.sin(this.face), dz = il > 0 ? iz : Math.cos(this.face);
        this.rollDir = { x: dx, z: dz };
        if (w.reloadT > 0) w.reloadT = Math.max(w.reloadT, 0.01);
        g.audio.play('dodge', this.pos);
        g.fx.dustRing(this.pos.x, this.pos.z, 0.8);
      }
      const maxSp = (firing ? 4.4 : 5.6) * (this.healT > 0 ? 0.6 : 1);
      const tx = ix * maxSp, tz = iz * maxSp;
      const acc = il > 0 ? 14 : 18;
      this.vel.x = damp(this.vel.x, tx, acc, dt); this.vel.z = damp(this.vel.z, tz, acc, dt);
      let df = targetFace - this.face; df = Math.atan2(Math.sin(df), Math.cos(df));
      this.face += df * Math.min(1, dt * 22);
    }
    const p = { x: this.pos.x + this.vel.x * dt, z: this.pos.z + this.vel.z * dt };
    g.col.resolveCircle(p, this.radius);
    this.pos.x = p.x; this.pos.z = p.z;
    this.y = damp(this.y, g.env.heightAt(this.pos.x, this.pos.z), 20, dt);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    // footsteps
    this.stepAcc += speed * dt;
    if (this.stepAcc > 1.45 && this.rollT < 0) { this.stepAcc = 0; g.audio.play('step', this.pos, { vol: 0.8 }); }

    // weapons
    this.bloom = Math.max(0, this.bloom - dt * 4);
    w.cooldown -= dt;
    if (w.pumpT > 0) { // shotgun pump: rack + eject the spent shell
      const prev = w.pumpT; w.pumpT -= dt;
      if (prev > 0.14 && w.pumpT <= 0.14) { const m = this.muzzleWorld(), fx = Math.sin(this.face), fz = Math.cos(this.face); g.fx.casing(m.x - fx * 0.5, m.y, m.z - fz * 0.5, fx, fz, true); g.audio.play('pump', this.pos, { vol: 0.7 }); }
    }
    if (w.reloadT > 0 && this.rollT < 0) {
      w.reloadT -= dt;
      if (w.reloadT <= 0) {
        const need = w.stats.mag - w.mag, have = this.ammo[BASES[w.base].ammo];
        const take = Math.min(need, have); w.mag += take; this.ammo[BASES[w.base].ammo] -= take;
        g.audio.play('reloadEnd', this.pos); g.hud.dirty();
      }
    }
    if (g.mode === 'playing' && this.rollT < 0) {
      if (input.hit('KeyR')) this.reload();
      if (input.hit('KeyQ') || input.wheel !== 0) this.equip(1 - this.cur);
      if (input.hit('Digit1')) this.equip(0);
      if (input.hit('Digit2')) this.equip(1);
      if (input.hit('KeyF')) this.useMedkit();
      // holding fire works for every weapon; fire rate is the limiter (twin-stick convention)
      const wantFire = input.mouse.down || input.mouse.clicked;
      if (wantFire && w.reloadT <= 0 && w.cooldown <= 0 && !g.hud.inventoryOpen) {
        if (w.mag > 0) { g.combat.playerFire(this, w); }
        else { if (input.mouse.clicked) g.audio.play('empty', this.pos); this.reload(); }
      }
    }
    // healing over time
    if (this.healT > 0) { const h = Math.min(this.healLeft, (50 / 1.4) * dt); this.hp = Math.min(this.maxHp, this.hp + h); this.healLeft -= h; this.healT -= dt; }

    // animate
    this.root.position.set(this.pos.x, this.y, this.pos.z);
    this.root.rotation.y = this.face;
    this.hum.update(dt, { speed, moveX: this.vel.x, moveZ: this.vel.z, rolling: this.rollT >= 0, rollP: this.rollT / this.rollDur, reloading: w.reloadT > 0, reloadP: w.reloadT > 0 ? 1 - w.reloadT / (w.reloadTotal || 1) : 0,
      pump: w.pumpT > 0 ? Math.sin(clamp(1 - w.pumpT / 0.28, 0, 1) * Math.PI) : 0 });
    // ground ring follows; chevron points at the aim
    this.ring.position.set(this.pos.x, this.y + 0.06, this.pos.z);
    this.ring.rotation.y = Math.atan2(-(aimPoint.z - this.pos.z), aimPoint.x - this.pos.x);
    this.ringMat.opacity = (this.rollT >= 0 ? 1 : 0.7) * (this.invuln > 0 ? 1 : 0.85);
    // flashlight
    // flashlight sits ahead of the body (never lights the hero's own back/helmet) and dims while rolling
    this.spot.position.set(this.pos.x + Math.sin(this.face) * 0.75, 2.1, this.pos.z + Math.cos(this.face) * 0.75);
    this.spot.intensity = damp(this.spot.intensity, this.rollT >= 0 ? 0 : 55, 18, dt);
    this.fill.position.set(this.pos.x + 1.2, this.y + 3.2, this.pos.z + 1.6); // camera side, above
    this.spotTarget.position.set(this.pos.x + Math.sin(this.face) * 10, 0, this.pos.z + Math.cos(this.face) * 10);
  }
  reload() {
    const w = this.weapon;
    if (w.reloadT > 0 || w.mag >= w.stats.mag) return;
    if (this.ammo[BASES[w.base].ammo] <= 0) { this.game.hud.toast('No ammo', '#ff6040'); return; }
    w.reloadT = w.stats.reload; w.reloadTotal = w.stats.reload;
    this.game.audio.play('reload', this.pos);
  }
  useMedkit() {
    if (this.medkits <= 0 || this.hp >= this.maxHp || this.healT > 0) return;
    this.medkits--; this.healT = 1.4; this.healLeft = 50;
    this.game.audio.play('pickup', null, { tier: 1 }); this.game.hud.dirty();
  }
  dispose() { this.game.scene.remove(this.ring); this.ringMat.dispose(); this.game.scene.remove(this.root); this.game.scene.remove(this.spot); this.game.scene.remove(this.fill); this.game.scene.remove(this.spotTarget); this.hum.dispose(); }
}
