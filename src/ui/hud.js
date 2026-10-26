// DOM HUD in a worn-metal / stencil post-apo frame: vitals with damage chip-away + heal preview, compact
// diegetic weapon panel (icon, mag pips, reserve, reload bar, secondary), circular bezel minimap,
// objective plate, Ascent-style enemy level/health bars, Diablo-style loot nameplates + side-docked compare
// tooltip (never over the player), pickup fly-to-HUD, legendary callouts, pickup feed with icons.
// Inventory lives in inventory.js, run-loop screens in screens.js. Damage numbers stay here (combat-owned).
import * as THREE from 'three';
import './hud.css';
import { RARITY, BASES, dps } from '../combat/weapons.js';
import { PALETTES } from '../world/lighting.js';
import { itemIcon, surfaces } from './icons.js';
import { esc, cardHTML, iconHTML } from './itemcard.js';
import { Inventory } from './inventory.js';
import { Screens } from './screens.js';

const $ = (id) => document.getElementById(id);
const ENEMY_LV = { mutant: 3, raider: 4, brute: 7 };
const AMMO_NAME = { light: 'Light', shells: 'Shells', heavy: 'Heavy' };

export class HUD {
  constructor(game) {
    this.game = game;
    const S = surfaces(), ds = document.documentElement.style;
    ds.setProperty('--grain', `url(${S.grain})`); ds.setProperty('--metal', `url(${S.metal})`);
    const root = document.createElement('div'); root.id = 'hud';
    root.innerHTML = `
      <div id="objective" class="mpanel"><div class="ohd"><i class="haz"></i><span class="lbl">Objective</span><span id="zone"></span></div><div class="t" id="objt">Find the extraction point</div><div class="d"><i class="chev"></i><span id="objd"></span></div></div>
      <div id="mmwrap"><canvas id="minimap" width="400" height="400"></canvas><div id="mmlabel"></div></div>
      <div id="health" class="mpanel"><div class="vhd"><span class="lbl">Vitals</span><span class="cs">Scav-07</span><b id="hptext">100</b><small id="hpmax">/100</small></div>
        <div id="hpbar"><div id="hpheal"></div><div id="hpchip"></div><div id="hpfill"></div><div id="hpsegs"></div></div>
        <div id="pips"><span class="lbl">Dodge</span><div class="pip"><i></i></div><div class="pip"><i></i></div><div id="salv" class="cnt"><i class="ri scr"></i><b id="sv">0</b></div><div id="medkits" class="cnt"><i class="ri med"></i><b id="mk">2</b><kbd>F</kbd></div></div></div>
      <div id="weapon" class="mpanel"><div class="wtop"><span id="wname"></span><span id="wtype"></span></div>
        <div class="wmain"><img id="wicon" alt=""><div class="wammo"><b id="ammo">0</b><span id="reserve"></span><small id="atype"></small></div></div>
        <div id="magpips"></div><div id="reloadbar"><i></i><span>Reloading</span></div>
        <div id="wsec"><kbd>Q</kbd><img id="w2icon" alt=""><span id="w2name"></span><b id="w2mag"></b></div></div>
      <div id="feed"></div>
      <div id="bars"></div><div id="lootlabels"></div><div id="dmg"></div><div id="prompts"><div id="prompt" class="hidden"></div></div>
      <div id="toast"></div><div id="callout"></div><div id="flyers"></div>
      <div id="extractbar" class="mpanel hidden"><div class="ehd"><i class="haz"></i><span id="extt">Evac inbound</span><b id="extn"></b></div><div class="bar"><i id="extfill"></i></div><div class="lbl">Hold the zone</div></div>
      <div id="crosshair"><i class="dot"></i><i id="ch0"></i><i id="ch1"></i><i id="ch2"></i><i id="ch3"></i>
        <svg id="reloadring" viewBox="0 0 34 34"><circle cx="17" cy="17" r="14" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="2"/><circle id="rr" cx="17" cy="17" r="14" fill="none" stroke="#ffb347" stroke-width="2" stroke-dasharray="88" stroke-dashoffset="88" transform="rotate(-90 17 17)"/></svg>
        <div id="hitm"><i style="transform:rotate(45deg) translate(7px)"></i><i style="transform:rotate(135deg) translate(7px)"></i><i style="transform:rotate(225deg) translate(7px)"></i><i style="transform:rotate(315deg) translate(7px)"></i></div></div>`;
    document.body.appendChild(root);
    this.root = root;
    this.mm = $('minimap').getContext('2d');
    this.dns = []; this.bars = new Map(); this.labels = new Map();
    this.hitT = 0; this.inventoryOpen = false;
    this._dirty = true; this.toastT = 0; this.calloutT = 0;
    this.hpChip = 1; this.chipHold = 0; this.lastHp = 1;
    this.v = new THREE.Vector3();
    const ch = ['ch0', 'ch1', 'ch2', 'ch3'].map($);
    ch.forEach((e, i) => { const h = i % 2 === 0; Object.assign(e.style, { width: h ? '8px' : '2px', height: h ? '2px' : '8px' }); });
    this.ch = ch;
    for (let i = 1; i < 10; i++) { const s = document.createElement('i'); s.style.left = i * 10 + '%'; $('hpsegs').appendChild(s); }
    this.inv = new Inventory(this);
    this.screens = new Screens(this);
  }

  // ---------- screens ----------
  show(id, on) { $(id).classList.toggle('hidden', !on); }
  setScreen(mode) {
    this.screens.setScreen(mode);
    this.root.style.display = mode === 'title' ? 'none' : '';
    this.root.classList.toggle('faded', mode === 'dead' || mode === 'extracted' || mode === 'paused');
    document.body.style.cursor = mode === 'playing' ? 'none' : 'default';
    $('crosshair').style.display = mode === 'playing' ? '' : 'none';
    if (mode !== 'playing' && this.inventoryOpen) this.toggleInventory(false);
  }
  showDeath() { this.screens.showDeath(); }
  showWin() { this.screens.showWin(); }

  newRun() {
    // static minimap layer
    const g = this.game, L = g.layout, S = 3, half = L.half + 6, N = Math.ceil(half * 2 * S);
    const c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d');
    x.fillStyle = '#141412'; x.fillRect(0, 0, N, N);
    const X = (v) => (v + half) * S;
    x.fillStyle = '#2a2a27';
    for (const r of L.roads) { if (r.axis === 'z') x.fillRect(X(r.x - r.w / 2), 0, r.w * S, N); else x.fillRect(0, X(r.z - r.w / 2), N, r.w * S); }
    for (const b of L.buildings) { x.fillStyle = b.collapsed ? 'rgba(96,86,70,.5)' : 'rgba(76,74,70,.6)'; x.fillRect(X(b.x0), X(b.z0), (b.x1 - b.x0) * S, (b.z1 - b.z0) * S); }
    for (const bx of g.col.boxes) {
      x.save(); x.translate(X(bx.x), X(bx.z)); x.rotate(-bx.rot);
      x.fillStyle = bx.kind === 'wall' ? '#9a958a' : bx.kind === 'car' ? '#5e4c3c' : '#575650';
      x.fillRect(-bx.hx * S, -bx.hz * S, bx.hx * 2 * S, bx.hz * 2 * S); x.restore();
    }
    this.mmStatic = c; this.mmScale = S; this.mmHalf = half;
    $('zone').textContent = `${PALETTES[L.palette].name} · #${g.seed}`;
    $('feed').innerHTML = ''; $('callout').innerHTML = ''; $('flyers').innerHTML = '';
    for (const b of this.bars.values()) b.el.remove(); this.bars.clear();
    for (const l of this.labels.values()) l.el.remove(); this.labels.clear();
    for (const d of this.dns) d.el.remove(); this.dns = [];
    this.hpChip = 1; this.lastHp = 1;
    this.screens.reset();
    this.dirty();
  }

  dirty() { this._dirty = true; }
  toast(msg, color = '#fff') { const t = $('toast'); t.textContent = msg; t.style.color = color; t.style.opacity = 1; this.toastT = 2.2; }
  feed(name, color, sub, item = null) {
    const f = $('feed'), d = document.createElement('div'); d.className = 'fi'; d.style.setProperty('--rc', color);
    d.innerHTML = `${item ? iconHTML(item, 52, 20) : '<i class="fdot"></i>'}<span>${esc(name)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}`;
    f.prepend(d); setTimeout(() => d.classList.add('out'), 4200); setTimeout(() => d.remove(), 4700);
    while (f.children.length > 5) f.lastChild.remove();
  }
  feedKill(type) { this.feed(`${type[0].toUpperCase() + type.slice(1)} eliminated`, '#ff6a50', ''); }
  hitmarker(kill) { const h = $('hitm'); h.classList.toggle('kill', !!kill); this.hitT = kill ? 0.35 : 0.15; this.game.audio.play('hitmarker'); }
  // big top-centre banner for legendary drops (never over the player)
  lootCallout(it) {
    const R = RARITY[it.rarity], c = $('callout');
    c.innerHTML = `<div class="co r${R.tier}" style="--rc:${R.color}"><div class="lbl">${R.name} drop</div><div class="nm">${esc(it.name)}</div></div>`;
    this.calloutT = 3;
  }
  // icon flies from the item's screen position into the relevant HUD element
  pickupFx(it, x, y, z) {
    const s = this.project(x, y, z), tgt = $(it.kind === 'weapon' ? 'wicon' : it.kind === 'medkit' ? 'medkits' : it.kind === 'ammo' ? 'ammo' : 'salv');
    if (!tgt || !s.vis) return;
    const r = tgt.getBoundingClientRect(), img = document.createElement('img');
    img.src = itemIcon(it, it.kind === 'weapon' ? 96 : 40, it.kind === 'weapon' ? 36 : 40); img.className = 'flyer';
    img.style.setProperty('--rc', RARITY[it.rarity].color);
    img.style.left = s.x + 'px'; img.style.top = s.y + 'px'; $('flyers').appendChild(img);
    const dx = r.left + r.width / 2 - s.x, dy = r.top + r.height / 2 - s.y;
    const a = img.animate([
      { transform: 'translate(-50%,-50%) scale(0.6)', opacity: 0 },
      { transform: `translate(calc(-50% + ${dx * 0.08}px), calc(-50% + ${dy * 0.08 - 46}px)) scale(1.25)`, opacity: 1, offset: 0.25 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.55)`, opacity: 0.9 },
    ], { duration: 650, easing: 'cubic-bezier(.5,0,.6,1)', fill: 'forwards' });
    a.onfinish = () => { img.remove(); tgt.classList.remove('bump'); void tgt.offsetWidth; tgt.classList.add('bump'); };
  }
  // Damage numbers: rapid hits on the same enemy merge into one growing number (pops on each hit);
  // crits spawn their own larger yellow number. Numbers rise on an arc and fade.
  damageNumber(x, y, z, dmg, crit, src = null) {
    const now = this.dnClock || 0;
    if (src) {
      const d = this.dns.find((d) => d.src === src && d.crit === !!crit && now - d.last < 0.45 && d.t < 0.8);
      if (d) { d.val += dmg; d.last = now; d.t = Math.min(d.t, 0.15); d.pop = 1; d.el.textContent = Math.round(d.val); d.x = x; d.z = z; d.el.classList.toggle('big', d.val >= 50); return; }
    }
    const el = document.createElement('div'); el.className = 'dn' + (crit ? ' crit' : ''); el.textContent = Math.round(dmg);
    $('dmg').appendChild(el);
    this.dnSide = -(this.dnSide || 1);
    this.dns.push({ el, src, crit: !!crit, val: dmg, last: now, pop: 1, x, y, z, t: 0, side: this.dnSide * (0.4 + Math.random() * 0.5) * (crit ? 1.4 : 1) });
    if (this.dns.length > 40) this.dns.shift().el.remove();
  }
  project(x, y, z) {
    const v = this.v.set(x, y, z).project(this.game.renderer.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, vis: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
  }
  toggleInventory(on = !this.inventoryOpen) {
    this.inventoryOpen = on; this.inv.show(on);
    this.root.classList.toggle('invopen', on);
    document.body.style.cursor = on || this.game.mode !== 'playing' ? 'default' : 'none';
  }

  update(dt) {
    const g = this.game, p = g.player; if (!p) return;
    const input = g.input;
    this.screens.update(dt);
    // crosshair
    const ch = $('crosshair'); ch.style.left = input.mouse.x + 'px'; ch.style.top = input.mouse.y + 'px';
    const w = p.weapon, B = BASES[w.base];
    const spreadPx = 6 + (w.stats.spread * (Math.hypot(p.vel.x, p.vel.z) > 1 ? 1.25 : 1) + p.bloom * 4) * 1.6;
    const offs = [[spreadPx, 0], [0, spreadPx], [-spreadPx - 8, 0], [0, -spreadPx - 8]];
    this.ch.forEach((e, i) => { e.style.left = (i % 2 === 0 ? offs[i][0] : -1) + 'px'; e.style.top = (i % 2 === 1 ? offs[i][1] : -1) + 'px'; });
    this.hitT = Math.max(0, this.hitT - dt); $('hitm').style.opacity = this.hitT > 0 ? 1 : 0;
    const rr = $('rr'); rr.style.strokeDashoffset = w.reloadT > 0 ? 88 * (w.reloadT / (w.reloadTotal || 1)) : 88;
    $('reloadring').style.opacity = w.reloadT > 0 ? 1 : 0;
    // health: chip-away (lagging white chunk drains after a short hold), heal preview
    const hpk = Math.max(0, p.hp / p.maxHp);
    if (hpk < this.lastHp - 1e-4) this.chipHold = 0.45;
    if (hpk > this.hpChip) this.hpChip = hpk;
    this.chipHold -= dt; if (this.chipHold <= 0) this.hpChip = Math.max(hpk, this.hpChip - dt * 0.45);
    this.lastHp = hpk;
    $('hpfill').style.width = hpk * 100 + '%'; $('hpchip').style.width = this.hpChip * 100 + '%';
    const heal = p.healT > 0 ? Math.min(1, hpk + (p.healLeft || 0) / p.maxHp) : hpk; $('hpheal').style.width = heal * 100 + '%';
    $('hptext').textContent = Math.ceil(Math.max(0, p.hp));
    $('health').classList.toggle('low', hpk < 0.3 && !p.dead);
    const pips = this.root.querySelectorAll('.pip i');
    pips.forEach((e, i) => { const v = i < p.charges ? 1 : i === p.charges ? p.chargeT / 1.6 : 0; e.style.transform = `scaleX(${v})`; e.style.opacity = i < p.charges ? 1 : 0.45; });
    if (this._dirty) {
      this._dirty = false;
      $('mk').textContent = p.medkits; $('sv').textContent = p.scrap;
      const R = RARITY[w.rarity];
      $('weapon').style.setProperty('--rc', R.color);
      $('wname').textContent = w.name; $('wtype').textContent = `${R.name} ${B.short} · ${dps(w)} DPS`;
      $('wicon').src = itemIcon(w, 132, 50);
      $('atype').textContent = AMMO_NAME[B.ammo];
      const mp = $('magpips'); mp.innerHTML = ''; mp.className = w.stats.mag > 24 ? 'dense' : '';
      for (let i = 0; i < w.stats.mag; i++) mp.appendChild(document.createElement('i'));
      this.lastMag = -1;
      const other = p.weapons[1 - p.cur];
      $('wsec').style.display = other ? '' : 'none';
      if (other) { $('w2icon').src = itemIcon(other, 64, 24); $('w2name').textContent = other.name; $('w2name').style.color = RARITY[other.rarity].color; }
      if (this.inventoryOpen) this.inv.render();
    }
    const other = p.weapons[1 - p.cur]; if (other) $('w2mag').textContent = `${other.mag}/${other.stats.mag}`;
    $('ammo').textContent = w.mag; $('reserve').textContent = `/ ${p.ammo[B.ammo]}`;
    const wp = $('weapon'); wp.classList.toggle('lowammo', w.mag > 0 && w.mag <= w.stats.mag * 0.25); wp.classList.toggle('empty', w.mag === 0); wp.classList.toggle('reloading', w.reloadT > 0);
    if (this.lastMag !== w.mag) { this.lastMag = w.mag; const kids = $('magpips').children; for (let i = 0; i < kids.length; i++) kids[i].className = i < w.mag ? '' : 'spent'; }
    $('reloadbar').firstChild.style.width = w.reloadT > 0 ? (1 - w.reloadT / (w.reloadTotal || 1)) * 100 + '%' : '0';
    // toast + callout
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) $('toast').style.opacity = 0; }
    if (this.calloutT > 0) { this.calloutT -= dt; if (this.calloutT <= 0) $('callout').innerHTML = ''; }
    // damage numbers
    this.dnClock = (this.dnClock || 0) + dt;
    for (let i = this.dns.length - 1; i >= 0; i--) {
      const d = this.dns[i]; d.t += dt; d.pop = Math.max(0, d.pop - dt * 7);
      const life = d.crit ? 1.25 : 1.0;
      // screen-space arc: rise fast then hang, drift sideways
      const s = this.project(d.x, d.y, d.z);
      const k = 1 - Math.exp(-d.t * 5);
      const px = s.x + d.side * 46 * k, py = s.y - 38 * k - 14 * d.t + (d.t > 0.6 ? (d.t - 0.6) * (d.t - 0.6) * 60 : 0);
      d.el.style.left = px + 'px'; d.el.style.top = py + 'px';
      d.el.style.opacity = Math.max(0, 1 - Math.max(0, d.t - life * 0.6) / (life * 0.4));
      d.el.style.transform = `translate(-50%,-50%) scale(${1 + d.pop * (d.crit ? 0.9 : 0.5)})`;
      if (d.t > life) { d.el.remove(); this.dns.splice(i, 1); }
    }
    // enemy bars: level plate + health with yellow chip-away; shown when damaged or alerted nearby
    const seen = new Set();
    for (const e of g.enemies.list) {
      if (e.dead) continue;
      const near = e.alert && Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) < 26;
      if (e.hpShow <= 0 && !near) continue;
      seen.add(e);
      let b = this.bars.get(e);
      if (!b) {
        const el = document.createElement('div'); el.className = 'ebar' + (e.type === 'brute' ? ' elite' : '');
        el.innerHTML = `${e.type === 'brute' ? '<div class="en">Brute</div>' : ''}<span class="lv">${(ENEMY_LV[e.type] || 3) + (e.group === 'wave' ? 1 : 0)}</span><div class="eb"><i class="chip"></i><i class="fill"></i></div>`;
        $('bars').appendChild(el); b = { el, chip: e.hp / e.maxHp, hold: 0, last: e.hp / e.maxHp, fill: el.querySelector('.fill'), chipEl: el.querySelector('.chip') }; this.bars.set(e, b);
      }
      const k = Math.max(0, e.hp / e.maxHp);
      if (k < b.last - 1e-4) b.hold = 0.35; b.last = k;
      b.hold -= dt; if (b.hold <= 0) b.chip = Math.max(k, b.chip - dt * 0.8);
      const s = this.project(e.pos.x, 2.3 * e.hum.K.scale, e.pos.z);
      b.el.style.transform = `translate(${s.x | 0}px,${s.y | 0}px)`;
      b.fill.style.width = k * 100 + '%'; b.chipEl.style.width = b.chip * 100 + '%';
      b.el.style.opacity = s.vis ? Math.max(near ? 0.85 : 0, Math.min(1, e.hpShow)) : 0;
    }
    for (const [e, b] of this.bars) if (!seen.has(e)) { b.el.remove(); this.bars.delete(e); }
    this.updateLoot(dt);
    // objective
    const ex = g.extraction;
    if (ex) {
      const d = Math.hypot(ex.x - p.pos.x, ex.z - p.pos.z);
      $('objt').textContent = g.extractT > 0 ? 'Hold the extraction zone' : 'Reach the extraction point';
      $('objd').textContent = `${Math.round(d)} m · ${g.enemies.alive.length} hostiles in district`;
      this.show('extractbar', g.extractT > 0 && g.mode === 'playing');
      if (g.extractT > 0) { $('extfill').style.width = (g.extractT / g.extractDur) * 100 + '%'; $('extn').textContent = `${Math.max(0, g.extractDur - g.extractT).toFixed(1)}s`; }
    }
    this.drawMinimap();
  }

  // Diablo-style nameplates over nearby drops (stacked so they never overlap) + compare tooltip docked to
  // the side of the focused item, away from the player.
  updateLoot() {
    const g = this.game, p = g.player, f = g.loot.focus, playing = g.mode === 'playing' && !this.inventoryOpen;
    const ps = this.project(p.pos.x, 1.0, p.pos.z);
    const seen = new Set(), placed = [];
    const drops = playing ? g.loot.drops.filter((d) => d.t >= 1 && Math.hypot(d.x - p.pos.x, d.z - p.pos.z) < (d.item.kind === 'weapon' ? 15 : 7)) : [];
    const items = [];
    for (const d of drops) { const s = this.project(d.x, 0.25, d.z); if (s.vis) items.push({ d, s }); }
    items.sort((a, b) => b.s.y - a.s.y);
    for (const { d, s } of items) {
      seen.add(d);
      let l = this.labels.get(d);
      if (!l) {
        const it = d.item, R = RARITY[it.rarity], el = document.createElement('div');
        el.className = `ll r${R.tier}${it.kind === 'weapon' ? '' : ' minor'}`; el.style.setProperty('--rc', R.color);
        el.innerHTML = `<kbd>E</kbd><i class="dia"></i><span>${esc(it.kind === 'scrap' ? `Salvage ×${it.amount}` : it.name)}</span>`;
        $('lootlabels').appendChild(el); l = { el, w: 0 }; this.labels.set(d, l);
      }
      if (!l.w) l.w = l.el.offsetWidth || 120;
      const h = 22; let y = s.y - 30; const x0 = s.x - l.w / 2;
      for (let it = 0; it < 8; it++) { const hit = placed.find((r) => x0 < r.x1 && x0 + l.w > r.x0 && y < r.y1 && y + h > r.y0); if (!hit) break; y = hit.y0 - h - 2; }
      placed.push({ x0, x1: x0 + l.w, y0: y, y1: y + h });
      l.el.style.transform = `translate(${x0 | 0}px,${y | 0}px)`;
      l.el.classList.toggle('focus', d === f);
    }
    for (const [d, l] of this.labels) if (!seen.has(d)) { l.el.remove(); this.labels.delete(d); }
    // focused item / crate tooltip
    const pr = $('prompt');
    if (!f || !playing) { pr.classList.add('hidden'); return; }
    const s = this.project(f.x, 0.3, f.z);
    const key = f.kind === 'crate' ? 'crate' + f.tier + f.x : 'd' + f.item.id + ':' + p.weapon.id;
    if (pr.dataset.key !== key) {
      pr.dataset.key = key; pr.classList.remove('hidden');
      if (f.kind === 'crate') {
        const tn = ['Supply crate', 'Military crate', 'Armored cache', 'Black-ops cache'][f.tier], tc = ['#b8b8b0', '#5fd35a', '#3f9bff', '#b45cff'][f.tier];
        pr.className = 'crate'; pr.innerHTML = `<div class="cp" style="--rc:${tc}"><kbd>E</kbd><div><div class="nm">${tn}</div><div class="ty">Open · ${['common', 'military', 'armored', 'black-ops'][f.tier]} loot table</div></div></div>`;
      } else { pr.className = 'card'; pr.innerHTML = cardHTML(f.item, f.item.kind === 'weapon' ? p.weapon : null, { keys: '<span class="k"><kbd>E</kbd>Pick up</span>' }); }
      pr.dataset.w = pr.offsetWidth; pr.dataset.h = pr.offsetHeight;
    }
    const W = +pr.dataset.w || 280, H = +pr.dataset.h || 200;
    const side = s.x >= ps.x ? 1 : -1, gap = f.kind === 'crate' ? 34 : 46;
    let x = side > 0 ? Math.max(s.x, ps.x + 34) + gap : Math.min(s.x, ps.x - 34) - gap - W;
    if (x + W > innerWidth - 250 && side > 0) x = Math.min(s.x, ps.x - 34) - gap - W;
    if (x < 12) x = Math.max(s.x, ps.x + 34) + gap;
    const y = Math.max(70, Math.min(innerHeight - 140 - H, s.y - H * 0.5));
    pr.style.transform = `translate(${x | 0}px,${y | 0}px)`;
  }

  drawMinimap() {
    const g = this.game, p = g.player, x = this.mm, W = 400, R = 200, S = this.mmScale, half = this.mmHalf;
    if (!this.mmStatic) return;
    const zoom = 1.15;
    x.save(); x.clearRect(0, 0, W, W);
    x.beginPath(); x.arc(R, R, R - 14, 0, Math.PI * 2); x.clip();
    x.fillStyle = '#0d0d0c'; x.fillRect(0, 0, W, W);
    const yaw = g.renderer.rig.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rot = -Math.PI / 2 - Math.atan2(fz, fx);
    x.translate(R, R); x.rotate(rot); x.scale(zoom, zoom);
    x.translate(-(p.pos.x + half) * S, -(p.pos.z + half) * S);
    x.globalAlpha = 0.95; x.drawImage(this.mmStatic, 0, 0); x.globalAlpha = 1;
    const X = (v) => (v + half) * S;
    for (const d of g.loot.drops) { const t = RARITY[d.item.rarity].tier; if (d.item.kind !== 'weapon' && t < 1) { x.fillStyle = 'rgba(220,210,190,.5)'; x.fillRect(X(d.x) - 2, X(d.z) - 2, 4, 4); continue; } x.fillStyle = RARITY[d.item.rarity].color; x.save(); x.translate(X(d.x), X(d.z)); x.rotate(Math.PI / 4); x.fillRect(-4, -4, 8, 8); x.restore(); }
    for (const c of g.loot.crates) if (!c.opened) { x.strokeStyle = '#e8c070'; x.lineWidth = 2; x.strokeRect(X(c.x) - 4, X(c.z) - 4, 8, 8); }
    for (const e of g.enemies.list) {
      if (e.dead) continue; const d = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
      if (d > 34 && !e.alert) continue;
      x.fillStyle = e.alert ? '#ff3a2a' : 'rgba(255,90,60,.6)'; x.beginPath(); x.arc(X(e.pos.x), X(e.pos.z), e.type === 'brute' ? 7 : 4.5, 0, 7); x.fill();
    }
    const ex = g.extraction;
    if (ex) { const t = performance.now() / 300; x.strokeStyle = '#5dff8a'; x.lineWidth = 3; x.beginPath(); x.arc(X(ex.x), X(ex.z), 14 + Math.sin(t) * 3, 0, 7); x.stroke(); x.fillStyle = '#5dff8a'; x.beginPath(); x.arc(X(ex.x), X(ex.z), 5, 0, 7); x.fill(); }
    x.restore();
    // scanlines + vignette inside the glass
    x.save(); x.beginPath(); x.arc(R, R, R - 14, 0, 7); x.clip();
    x.fillStyle = 'rgba(0,0,0,0.18)'; for (let y = 0; y < W; y += 4) x.fillRect(0, y, W, 1.5);
    const vg = x.createRadialGradient(R, R, R * 0.55, R, R, R - 14); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.75)'); x.fillStyle = vg; x.fillRect(0, 0, W, W);
    // view cone
    x.translate(R, R); const wx = Math.sin(p.face), wz = Math.cos(p.face);
    const sx = wx * Math.cos(rot) - wz * Math.sin(rot), sy = wx * Math.sin(rot) + wz * Math.cos(rot), fa = Math.atan2(sy, sx);
    const cg = x.createRadialGradient(0, 0, 0, 0, 0, 120); cg.addColorStop(0, 'rgba(127,214,255,0.22)'); cg.addColorStop(1, 'rgba(127,214,255,0)');
    x.fillStyle = cg; x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, 120, fa - 0.5, fa + 0.5); x.closePath(); x.fill();
    x.rotate(fa + Math.PI / 2);
    x.fillStyle = '#7fd6ff'; x.strokeStyle = '#06222e'; x.lineWidth = 2; x.beginPath(); x.moveTo(0, -12); x.lineTo(8, 9); x.lineTo(0, 4); x.lineTo(-8, 9); x.closePath(); x.stroke(); x.fill();
    x.restore();
    // bezel: worn metal ring, tick marks, compass N
    x.save(); x.translate(R, R);
    x.lineWidth = 14; x.strokeStyle = '#22211e'; x.beginPath(); x.arc(0, 0, R - 7, 0, 7); x.stroke();
    x.lineWidth = 1.5; x.strokeStyle = 'rgba(255,240,215,0.22)'; x.beginPath(); x.arc(0, 0, R - 1, 0, 7); x.stroke(); x.strokeStyle = 'rgba(0,0,0,0.8)'; x.beginPath(); x.arc(0, 0, R - 14, 0, 7); x.stroke();
    for (let i = 0; i < 72; i++) { const a = i / 72 * Math.PI * 2 + rot; x.strokeStyle = i % 18 === 0 ? 'rgba(232,166,48,0.9)' : i % 6 === 0 ? 'rgba(230,220,200,0.55)' : 'rgba(230,220,200,0.2)'; x.lineWidth = i % 6 === 0 ? 2 : 1; const r0 = R - (i % 6 === 0 ? 12 : 8); x.beginPath(); x.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); x.lineTo(Math.cos(a) * (R - 3), Math.sin(a) * (R - 3)); x.stroke(); }
    // world north (-z) direction on the rotated map
    const na = Math.atan2(-Math.cos(rot) * 1, Math.sin(rot) * 1) ; // dir of (0,-1) rotated
    const nx = Math.cos(na) * (R - 26), ny = Math.sin(na) * (R - 26);
    x.fillStyle = '#e8a630'; x.font = 'bold 20px Inter, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('N', nx, ny);
    x.restore();
    if (ex) {
      const dx = ex.x - p.pos.x, dz = ex.z - p.pos.z;
      const sx2 = dx * Math.cos(rot) - dz * Math.sin(rot), sy2 = dx * Math.sin(rot) + dz * Math.cos(rot);
      const d = Math.hypot(sx2, sy2) * S * zoom;
      if (d > R - 30) { const a = Math.atan2(sy2, sx2); x.save(); x.translate(R + Math.cos(a) * (R - 30), R + Math.sin(a) * (R - 30)); x.rotate(a); x.fillStyle = '#5dff8a'; x.beginPath(); x.moveTo(9, 0); x.lineTo(-6, -7); x.lineTo(-6, 7); x.closePath(); x.fill(); x.restore(); }
      $('mmlabel').innerHTML = `<i></i>Evac <b>${Math.round(Math.hypot(dx, dz))} m</b>`;
    }
  }
}
