// Loot: supply crates (E to open), enemy drops, ground-glow / light-shaft rarity presentation, drop pops,
// pickups (fly-to-player + HUD), auto-pickup of ammo/scrap.
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { RARITIES, RARITY, rollWeapon, makeConsumable, weaponModel, dps, BASES } from '../combat/weapons.js';
import { materials } from '../render/materials.js';
import { glowTex, runeRingTex, shaftTex, moteTex, additive, LootBursts } from './lootfx.js';

const TIER_RARITY = [
  [['common', 60], ['uncommon', 28], ['rare', 10], ['epic', 2], ['legendary', 0.3]],
  [['common', 30], ['uncommon', 38], ['rare', 22], ['epic', 8], ['legendary', 1.5]],
  [['common', 8], ['uncommon', 30], ['rare', 36], ['epic', 20], ['legendary', 5]],
  [['uncommon', 15], ['rare', 40], ['epic', 33], ['legendary', 12]],
];

export class LootManager {
  constructor(game) {
    this.game = game; this.drops = []; this.crates = []; this.focus = null;
    this.rng = new RNG(game.seed ^ 0x1007);
    this.planeGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shaftGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    this.glowMats = {}; this.ringMats = {}; this.shaftMats = {}; this.moteMats = {};
    for (const r of RARITIES) {
      const c = new THREE.Color(r.hex), t = RARITY[r.key].tier;
      this.glowMats[r.key] = additive(glowTex(), c.clone().multiplyScalar(0.55 + t * 0.22));
      this.ringMats[r.key] = additive(runeRingTex(), c.clone().multiplyScalar(1.3 + t * 0.25));
      this.shaftMats[r.key] = additive(shaftTex(), c.clone().multiplyScalar(0.55 + t * 0.2), { side: THREE.DoubleSide });
      this.moteMats[r.key] = new THREE.PointsMaterial({ map: moteTex(), color: c.clone().multiplyScalar(2.2), size: 0.16, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    }
    this.collecting = []; this.bursts = new LootBursts(game.scene);
    const M = materials();
    this.crateMats = [M.wood, M.container[2], M.container[1], M.container[0]];
    this.markerMats = [0x9a9a90, 0x4fdc4a, 0x3a8cff, 0xa850ff].map((c) => new THREE.MeshStandardMaterial({ color: 0, emissive: c, emissiveIntensity: 3 }));
  }
  rollRarity(tier) { return this.rng.weighted(TIER_RARITY[Math.max(0, Math.min(3, Math.floor(tier)))]); }

  spawnCrate({ x, z, rot = 0, tier = 0 }) {
    const M = materials(), g = new THREE.Group();
    const mat = this.crateMats[tier];
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.5, 0.7), mat); body.position.y = 0.27; g.add(body);
    const lid = new THREE.Group(); lid.position.set(0, 0.52, -0.35); g.add(lid);
    const lm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.74), mat); lm.position.set(0, 0.04, 0.35); lid.add(lm);
    for (const sx of [-0.4, 0.4]) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.56, 0.74), M.metal); s.position.set(sx, 0.28, 0); g.add(s); }
    const mk = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.04), this.markerMats[tier]); mk.position.set(0, 0.3, 0.37); g.add(mk);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.position.set(x, this.game.env.heightAt(x, z), z); g.rotation.y = rot;
    this.game.scene.add(g);
    const box = this.game.col.add(x, z, 0.6, 0.38, rot, 0.62, { kind: 'cover' });
    const c = { kind: 'crate', g, lid, x, z, tier, opened: false, openT: 0, box, marker: mk };
    if (tier >= 2) c.light = this.game.lighting.addSource(new THREE.Vector3(x, 0.8, z), tier === 3 ? 0xa850ff : 0x3a8cff, 4, 4, 'pulse');
    this.crates.push(c);
    return c;
  }

  openCrate(c) {
    if (c.opened) return;
    c.opened = true;
    const g = this.game;
    g.audio.play('crate', c);
    g.fx.dustRing(c.x, c.z, 0.5);
    c.marker.visible = false;
    if (c.light) { g.lighting.removeSource(c.light); c.light = null; }
    const n = 1 + this.rng.int(0, 1) + (c.tier >= 2 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const item = i === 0 || this.rng.chance(0.45) ? rollWeapon(this.rng, this.rollRarity(c.tier)) : this.consumable();
      this.dropItem(item, c.x, c.z, true);
    }
    if (this.rng.chance(0.6)) this.dropItem(makeConsumable('ammo', 'common', 1), c.x, c.z, true);
  }
  consumable() {
    const r = this.rng.next();
    if (r < 0.35) return makeConsumable('medkit', 'uncommon', 1);
    if (r < 0.7) return makeConsumable('ammo', 'common', 1);
    return makeConsumable('scrap', 'common', this.rng.int(5, 25));
  }

  onEnemyKilled(e) {
    const d = e.def;
    if (this.rng.chance(0.5)) this.dropItem(makeConsumable('scrap', 'common', this.rng.int(3, 12) * (e.type === 'brute' ? 3 : 1)), e.pos.x, e.pos.z, true);
    if (!this.rng.chance(d.dropChance)) return;
    const item = this.rng.chance(e.type === 'brute' ? 0.85 : 0.4) ? rollWeapon(this.rng, this.rollRarity(d.tierBonus + this.rng.range(0, 0.8))) : this.consumable();
    this.dropItem(item, e.pos.x, e.pos.z, true);
  }

  dropItem(item, x, z, pop = false) {
    const g = this.game, R = RARITY[item.rarity], tier = R.tier, weapon = item.kind === 'weapon';
    const col = new THREE.Color(R.hex);
    const grp = new THREE.Group();
    const holder = new THREE.Group(); grp.add(holder);
    let model;
    if (weapon) { model = weaponModel(item.base, item.rarity); model.scale.setScalar(1.55); }
    else {
      model = new THREE.Group();
      const M = materials();
      if (item.kind === 'medkit') {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 0.3), new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.6 })); b.position.y = 0.09; model.add(b);
        const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.01, 0.06), new THREE.MeshStandardMaterial({ color: 0, emissive: 0xff2020, emissiveIntensity: 2 })); c1.position.y = 0.185; model.add(c1);
        const c2 = c1.clone(); c2.rotation.y = Math.PI / 2; model.add(c2);
      } else if (item.kind === 'ammo') {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.25, 0.25), M.container[2]); b.position.y = 0.125; model.add(b);
        const s = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.26), new THREE.MeshStandardMaterial({ color: 0, emissive: 0xffc030, emissiveIntensity: 1.5 })); s.position.y = 0.19; model.add(s);
      } else {
        for (let i = 0; i < 3; i++) { const t = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.03, 6, 8), M.chrome); t.position.set((i - 1) * 0.12, 0.04, (i % 2) * 0.1); t.rotation.x = Math.PI / 2 + i * 0.2; model.add(t); }
      }
    }
    model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    holder.add(model);
    // ground presentation: soft light pool + crisp marker ring (rare+), camera-facing soft shaft (rare+), motes (epic+)
    const glowS = weapon ? 1.4 + tier * 0.45 : 0.9;
    const glow = new THREE.Mesh(this.planeGeo, this.glowMats[item.rarity]); glow.scale.setScalar(glowS); glow.position.y = 0.035; glow.renderOrder = 5; grp.add(glow);
    let ring = null, shaft = null, motes = null;
    if (weapon && tier >= 1) { ring = new THREE.Mesh(this.planeGeo, this.ringMats[item.rarity]); ring.scale.setScalar(1.25 + tier * 0.12); ring.position.y = 0.045; ring.renderOrder = 6; grp.add(ring); }
    if (weapon && tier >= 2) { shaft = new THREE.Mesh(this.shaftGeo, this.shaftMats[item.rarity]); shaft.scale.set(0.55 + tier * 0.12, [0, 0, 2.6, 4.2, 7][tier], 1); shaft.renderOrder = 6; grp.add(shaft); }
    if (weapon && tier >= 3) {
      const N = tier === 4 ? 14 : 8, pos = new Float32Array(N * 3), seeds = [];
      for (let i = 0; i < N; i++) { seeds.push(Math.random() * 6.28, 0.2 + Math.random() * 0.5, Math.random()); }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      motes = new THREE.Points(geo, this.moteMats[item.rarity]); motes.userData.seeds = seeds; motes.frustumCulled = false; motes.renderOrder = 7; grp.add(motes);
    }
    let tx = x, tz = z;
    if (pop) {
      for (let i = 0; i < 8; i++) {
        const a = this.rng.range(0, 6.28), r = this.rng.range(0.8, 1.8);
        const cx = x + Math.cos(a) * r, cz = z + Math.sin(a) * r;
        if (g.nav.walkable(cx, cz)) { tx = cx; tz = cz; break; }
      }
    }
    const rest = { ry: this.rng.range(0, 6.28), rz: weapon ? Math.PI / 2 * (this.rng.chance(0.5) ? 1 : -1) : 0 };
    const d = { kind: 'drop', item, g: grp, holder, glow, ring, shaft, motes, col, glowS, x: tx, z: tz, fx: x, fz: z, t: pop ? 0 : 1, bob: this.rng.range(0, 6), rest, spin: pop ? this.rng.range(6, 11) : 0, landed: !pop };
    holder.rotation.set(0, rest.ry, rest.rz); holder.position.y = weapon ? 0.06 : 0;
    grp.position.set(pop ? x : tx, 0, pop ? z : tz);
    if (pop) { glow.scale.setScalar(0.01); if (shaft) shaft.visible = false; }
    g.scene.add(grp);
    if (tier >= 3 && weapon) d.light = g.lighting.addSource(new THREE.Vector3(tx, 0.9, tz), R.hex, tier === 4 ? 7 : 5, 5, 'pulse');
    if (!pop) this.land(d, true);
    this.drops.push(d);
    return d;
  }
  // landing moment: drop "pop" for epic/legendary (shockwave, sparks, flash, chime, a little shake)
  land(d, quiet = false) {
    d.landed = true; const g = this.game, tier = RARITY[d.item.rarity].tier;
    if (d.item.kind !== 'weapon' || quiet) return;
    if (tier >= 3) {
      this.bursts.spawn(d.x, 0, d.z, d.col, tier === 4 ? 1.25 : 0.75);
      if (d.light) d.light.intensity = tier === 4 ? 40 : 22, d.flashT = 1;
      if (tier === 4) { g.audio.play('legendary'); g.renderer.addTrauma(0.18); if (g.hud.lootCallout) g.hud.lootCallout(d.item); }
      else g.audio.play('pickup', null, { tier: 2, vol: 0.6 });
    }
  }

  pickup(d) {
    const g = this.game, pl = g.player, it = d.item;
    if (it.kind === 'weapon') {
      if (pl.backpack.length < pl.maxBackpack) { pl.backpack.push(it); g.hud.feed(`${it.name}`, RARITY[it.rarity].color, 'Backpack', it); }
      else {
        const old = pl.weapons[pl.cur]; pl.weapons[pl.cur] = it; pl.equip(pl.cur, true);
        this.dropItem(old, pl.pos.x, pl.pos.z, true);
        g.hud.feed(`${it.name}`, RARITY[it.rarity].color, 'Equipped · pack full', it);
      }
      pl.lootValue += it.value;
      (pl.lootLog || (pl.lootLog = [])).push(it);
    } else if (it.kind === 'medkit') { if (pl.medkits >= 5) { g.hud.toast('Medkits full', '#aaa'); return false; } pl.medkits++; g.hud.feed('Field Medkit', '#ff5050', '+1 medkit', it); }
    else if (it.kind === 'ammo') { pl.ammo.light += 60; pl.ammo.shells += 12; pl.ammo.heavy += 10; g.hud.feed('Ammo Cache', '#ffc030', '+60 light · +12 shells · +10 heavy', it); }
    else if (it.kind === 'scrap') { pl.scrap += it.amount; pl.lootValue += it.amount; g.hud.feed(`Salvage ×${it.amount}`, '#c8c8c0', '', it); }
    g.audio.play('pickup', null, { tier: RARITY[it.rarity].tier });
    if (g.hud.pickupFx) g.hud.pickupFx(it, d.x, 0.4, d.z);
    // fly the 3D item into the player, then remove
    const i = this.drops.indexOf(d); if (i >= 0) this.drops.splice(i, 1);
    if (d.light) { g.lighting.removeSource(d.light); d.light = null; }
    d.ct = 0; d.sx = d.g.position.x; d.sz = d.g.position.z; this.collecting.push(d);
    g.hud.dirty();
    return true;
  }
  removeDrop(d) {
    const g = this.game;
    g.scene.remove(d.g);
    if (d.light) g.lighting.removeSource(d.light);
    const i = this.drops.indexOf(d); if (i >= 0) this.drops.splice(i, 1);
  }
  // put an item back on the ground at the player's feet (inventory "drop")
  dropAtPlayer(item) { const p = this.game.player.pos; return this.dropItem(item, p.x, p.z, true); }

  update(dt, input) {
    const g = this.game, pl = g.player, cam = g.renderer.camera, now = performance.now() / 1000;
    for (const d of this.drops) {
      const tier = RARITY[d.item.rarity].tier;
      if (d.t < 1) { // pop arc with tumble
        d.t = Math.min(1, d.t + dt * 2.0);
        const x = d.fx + (d.x - d.fx) * d.t, z = d.fz + (d.z - d.fz) * d.t, y = Math.sin(d.t * Math.PI) * 1.4;
        d.g.position.set(x, 0, z); d.holder.position.y = y + 0.06;
        d.holder.rotation.set(d.t * d.spin * 0.6, d.rest.ry + d.t * d.spin, d.rest.rz * Math.min(1, d.t * 1.4));
        d.glow.scale.setScalar(Math.max(0.01, d.glowS * d.t * d.t));
        if (d.t >= 1) { d.holder.rotation.set(0, d.rest.ry, d.rest.rz); d.holder.position.y = d.item.kind === 'weapon' ? 0.06 : 0; if (d.shaft) d.shaft.visible = true; d.settle = 0; this.land(d); }
      } else {
        d.bob += dt;
        if (d.settle !== undefined && d.settle < 1) { d.settle = Math.min(1, d.settle + dt * 5); d.holder.position.y = 0.06 + Math.sin(d.settle * Math.PI) * 0.08 * (1 - d.settle); }
        const pulse = 0.82 + Math.sin(d.bob * 2.4) * 0.18;
        d.glow.material.opacity = 1; d.glow.scale.setScalar(d.glowS * (0.96 + 0.04 * pulse));
        if (d.ring) { d.ring.rotation.y += dt * (0.35 + tier * 0.1); }
        if (d.shaft) { d.shaft.rotation.y = Math.atan2(cam.position.x - d.g.position.x, cam.position.z - d.g.position.z); d.shaft.scale.x = (0.55 + tier * 0.12) * (0.92 + 0.08 * pulse); }
        if (d.flashT > 0) { d.flashT = Math.max(0, d.flashT - dt * 1.6); if (d.light) d.light.intensity = (tier === 4 ? 7 : 5) + d.flashT * d.flashT * (tier === 4 ? 33 : 17); }
      }
      if (d.motes) {
        const p = d.motes.geometry.attributes.position, s = d.motes.userData.seeds;
        for (let j = 0; j < p.count; j++) { const ph = (now * 0.35 + s[j * 3 + 2]) % 1, a = s[j * 3] + now * 0.6; p.setXYZ(j, Math.cos(a) * s[j * 3 + 1], 0.1 + ph * (tier === 4 ? 3.2 : 2), Math.sin(a) * s[j * 3 + 1]); }
        p.needsUpdate = true;
      }
    }
    // pickups flying into the player
    for (let i = this.collecting.length - 1; i >= 0; i--) {
      const d = this.collecting[i]; d.ct += dt / 0.22; const k = Math.min(1, d.ct), e = k * k;
      d.g.position.set(d.sx + (pl.pos.x - d.sx) * e, 0, d.sz + (pl.pos.z - d.sz) * e);
      d.holder.position.y = 0.06 + Math.sin(k * Math.PI) * 0.7 + e * 0.6; d.holder.scale.setScalar(1 - e * 0.85);
      d.glow.scale.setScalar(d.glowS * (1 - k)); if (d.ring) d.ring.visible = false; if (d.shaft) d.shaft.scale.y *= 0.8; if (d.motes) d.motes.visible = false;
      if (k >= 1) { g.scene.remove(d.g); this.collecting.splice(i, 1); }
    }
    this.bursts.update(dt, cam);
    // auto pickup of ammo/scrap/medkits
    if (!pl.dead) for (const d of this.drops.slice()) {
      if (d.t < 1 || d.item.kind === 'weapon') continue;
      if (Math.hypot(d.x - pl.pos.x, d.z - pl.pos.z) < 1.3) this.pickup(d);
    }
    // crate lids
    for (const c of this.crates) if (c.opened && c.openT < 1) { c.openT = Math.min(1, c.openT + dt * 3); c.lid.rotation.x = -c.openT * 1.9; }
    // interaction focus
    let best = null, bd = 2.3;
    if (!pl.dead) {
      for (const d of this.drops) { if (d.t < 1) continue; const dd = Math.hypot(d.x - pl.pos.x, d.z - pl.pos.z); if (dd < bd) { bd = dd; best = d; } }
      for (const c of this.crates) { if (c.opened) continue; const dd = Math.hypot(c.x - pl.pos.x, c.z - pl.pos.z) - 0.4; if (dd < bd) { bd = dd; best = c; } }
    }
    this.focus = best;
    if (best && input.hit('KeyE') && g.mode === 'playing') {
      if (best.kind === 'crate') this.openCrate(best); else this.pickup(best);
    }
  }
  clear() {
    for (const d of this.drops.concat(this.collecting)) this.game.scene.remove(d.g);
    this.collecting.length = 0; this.bursts.clear();
    for (const c of this.crates) this.game.scene.remove(c.g);
    this.drops.length = 0; this.crates.length = 0;
  }
}
export { dps, BASES };
