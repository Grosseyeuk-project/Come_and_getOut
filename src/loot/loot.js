// Loot: supply crates (E to open), enemy drops, rarity light beams, pickups, auto-pickup of ammo/scrap.
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { RARITIES, RARITY, rollWeapon, makeConsumable, weaponModel, dps, BASES } from '../combat/weapons.js';
import { materials } from '../render/materials.js';
import * as T from '../render/textures.js';

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
    this.beamGeo = new THREE.CylinderGeometry(0.09, 0.16, 1, 10, 1, true); this.beamGeo.translate(0, 0.5, 0);
    this.ringGeo = new THREE.RingGeometry(0.35, 0.55, 28); this.ringGeo.rotateX(-Math.PI / 2);
    this.beamMats = {}; this.ringMats = {};
    for (const r of RARITIES) {
      this.beamMats[r.key] = new THREE.MeshBasicMaterial({ map: T.beamTex(), color: new THREE.Color(r.hex).multiplyScalar(2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
      this.ringMats[r.key] = new THREE.MeshBasicMaterial({ map: T.softSprite('ring', 1, 0), color: new THREE.Color(r.hex).multiplyScalar(1.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    }
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
    const g = this.game, R = RARITY[item.rarity];
    const grp = new THREE.Group();
    const holder = new THREE.Group(); grp.add(holder);
    let model;
    if (item.kind === 'weapon') { model = weaponModel(item.base, item.rarity); model.rotation.set(0, 0, Math.PI / 2); model.scale.setScalar(1.6); model.position.y = 0.0; }
    else {
      model = new THREE.Group();
      const M = materials();
      if (item.kind === 'medkit') {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 0.3), new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.6 })); model.add(b);
        const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.01, 0.06), new THREE.MeshStandardMaterial({ color: 0, emissive: 0xff2020, emissiveIntensity: 2 })); c1.position.y = 0.095; model.add(c1);
        const c2 = c1.clone(); c2.rotation.y = Math.PI / 2; model.add(c2);
      } else if (item.kind === 'ammo') {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.25, 0.25), M.container[2]); model.add(b);
        const s = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.26), new THREE.MeshStandardMaterial({ color: 0, emissive: 0xffc030, emissiveIntensity: 1.5 })); s.position.y = 0.06; model.add(s);
      } else {
        for (let i = 0; i < 3; i++) { const t = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.03, 6, 8), M.chrome); t.position.set((i - 1) * 0.12, 0, (i % 2) * 0.1); t.rotation.x = Math.PI / 2 + i; model.add(t); }
      }
      model.position.y = 0.0;
    }
    model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    holder.add(model);
    const showBeam = item.kind === 'weapon' || item.kind === 'medkit';
    const beam = new THREE.Mesh(this.beamGeo, this.beamMats[item.rarity]); beam.scale.set(1, showBeam ? R.beam : 0.9, 1); beam.renderOrder = 6; grp.add(beam);
    const ring = new THREE.Mesh(this.ringGeo, this.ringMats[item.rarity]); ring.position.y = 0.04; ring.renderOrder = 6; grp.add(ring);
    let tx = x, tz = z;
    if (pop) {
      for (let i = 0; i < 8; i++) {
        const a = this.rng.range(0, 6.28), r = this.rng.range(0.8, 1.8);
        const cx = x + Math.cos(a) * r, cz = z + Math.sin(a) * r;
        if (g.nav.walkable(cx, cz)) { tx = cx; tz = cz; break; }
      }
    }
    const d = { kind: 'drop', item, g: grp, holder, beam, ring, x: tx, z: tz, fx: x, fz: z, t: pop ? 0 : 1, bob: this.rng.range(0, 6) };
    grp.position.set(pop ? x : tx, 0, pop ? z : tz);
    g.scene.add(grp);
    if (R.tier >= 3 && item.kind === 'weapon') d.light = g.lighting.addSource(new THREE.Vector3(tx, 1.0, tz), R.hex, 6, 5, 'pulse');
    if (R.tier === 4 && item.kind === 'weapon') g.audio.play('legendary');
    this.drops.push(d);
    return d;
  }

  pickup(d) {
    const g = this.game, pl = g.player, it = d.item;
    if (it.kind === 'weapon') {
      if (pl.backpack.length < pl.maxBackpack) { pl.backpack.push(it); g.hud.feed(`${it.name}`, RARITY[it.rarity].color, 'Weapon → backpack'); }
      else {
        const old = pl.weapons[pl.cur]; pl.weapons[pl.cur] = it; pl.equip(pl.cur, true);
        this.dropItem(old, pl.pos.x, pl.pos.z, true);
        g.hud.feed(`${it.name}`, RARITY[it.rarity].color, 'Equipped (backpack full)');
      }
      pl.lootValue += it.value;
    } else if (it.kind === 'medkit') { if (pl.medkits >= 5) { g.hud.toast('Medkits full', '#aaa'); return false; } pl.medkits++; g.hud.feed('Field Medkit', '#ff5050', '+1 medkit'); }
    else if (it.kind === 'ammo') { pl.ammo.light += 60; pl.ammo.shells += 12; pl.ammo.heavy += 10; g.hud.feed('Ammo Cache', '#ffc030', '+60 light · +12 shells · +10 heavy'); }
    else if (it.kind === 'scrap') { pl.scrap += it.amount; pl.lootValue += it.amount; g.hud.feed(`Salvage ×${it.amount}`, '#c8c8c0', ''); }
    g.audio.play('pickup', null, { tier: RARITY[it.rarity].tier });
    this.removeDrop(d);
    g.hud.dirty();
    return true;
  }
  removeDrop(d) {
    const g = this.game;
    g.scene.remove(d.g);
    if (d.light) g.lighting.removeSource(d.light);
    const i = this.drops.indexOf(d); if (i >= 0) this.drops.splice(i, 1);
  }

  update(dt, input) {
    const g = this.game, pl = g.player;
    for (const d of this.drops) {
      if (d.t < 1) { // pop arc
        d.t = Math.min(1, d.t + dt * 2.2);
        const x = d.fx + (d.x - d.fx) * d.t, z = d.fz + (d.z - d.fz) * d.t, y = Math.sin(d.t * Math.PI) * 1.3;
        d.g.position.set(x, 0, z); d.holder.position.y = y + 0.25;
      } else {
        d.bob += dt;
        d.holder.position.y = 0.3 + Math.sin(d.bob * 2.2) * 0.06;
        d.holder.rotation.y += dt * 0.9;
        d.ring.material.opacity = 0.7 + Math.sin(d.bob * 3) * 0.3;
      }
    }
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
    for (const d of this.drops) this.game.scene.remove(d.g);
    for (const c of this.crates) this.game.scene.remove(c.g);
    this.drops.length = 0; this.crates.length = 0;
  }
}
export { dps, BASES };
