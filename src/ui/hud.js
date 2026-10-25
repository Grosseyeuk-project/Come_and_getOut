// DOM HUD: health/dodge/medkits, weapon + ammo, rotating minimap, objective, crosshair + hit markers,
// floating damage numbers, enemy health bars, loot prompts with stat comparison, pickup feed,
// inventory panel, and the title / death / extraction screens.
import * as THREE from 'three';
import './hud.css';
import { RARITY, BASES, dps } from '../combat/weapons.js';
import { PALETTES } from '../world/lighting.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class HUD {
  constructor(game) {
    this.game = game;
    const root = document.createElement('div'); root.id = 'hud';
    root.innerHTML = `
      <div id="objective" class="panel"><div class="label">Objective</div><div class="t" id="objt">Find the extraction point</div><div class="d" id="objd"></div></div>
      <div id="zone"></div>
      <canvas id="minimap" width="420" height="420"></canvas>
      <div id="mmlabel" class="label"></div>
      <div id="health" class="panel"><div class="label">Vitals</div><div id="hptext">100</div><div id="hpbar"><div id="hplag"></div><div id="hpfill"></div></div>
        <div id="pips"><span class="label" style="margin-right:4px">Dodge</span><div class="pip"><i></i></div><div class="pip"><i></i></div><div id="medkits"><b>✚</b> <span id="mk">2</span> <span class="label">[F]</span></div></div></div>
      <div id="weapon" class="panel"><div id="wname"></div><div id="wtype" class="label"></div><div id="ammo"></div><div id="reloadbar"><i></i></div><div id="wsec"></div></div>
      <div id="feed"></div>
      <div id="bars"></div><div id="dmg"></div><div id="prompts"><div id="prompt" class="panel hidden"></div></div>
      <div id="toast"></div>
      <div id="extractbar" class="panel hidden"><div class="label">Extraction</div><div id="extt" style="margin-top:4px;letter-spacing:.1em">HOLD POSITION</div><div class="bar"><i id="extfill"></i></div></div>
      <div id="crosshair"><i class="dot"></i><i id="ch0"></i><i id="ch1"></i><i id="ch2"></i><i id="ch3"></i>
        <svg id="reloadring" viewBox="0 0 34 34"><circle cx="17" cy="17" r="14" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="2"/><circle id="rr" cx="17" cy="17" r="14" fill="none" stroke="#ffb347" stroke-width="2" stroke-dasharray="88" stroke-dashoffset="88" transform="rotate(-90 17 17)"/></svg>
        <div id="hitm"><i style="transform:rotate(45deg) translate(7px)"></i><i style="transform:rotate(135deg) translate(7px)"></i><i style="transform:rotate(225deg) translate(7px)"></i><i style="transform:rotate(315deg) translate(7px)"></i></div></div>
      <div id="inventory" class="hidden"><div class="wrap panel"><h2>Inventory</h2><div class="label">Click a backpack item to equip it in the active slot · right-click to scrap it · [Tab] close</div><div class="slots" id="slots"></div><div class="label">Backpack</div><div class="bag" id="bag" style="margin-top:8px"></div><div class="stats-row" id="invstats"></div></div></div>`;
    document.body.appendChild(root);
    this.root = root;
    this.mm = $('minimap').getContext('2d');
    this.dns = []; this.bars = new Map();
    this.hitT = 0; this.inventoryOpen = false;
    this._dirty = true; this.toastT = 0;
    this.v = new THREE.Vector3();
    const ch = ['ch0', 'ch1', 'ch2', 'ch3'].map($);
    ch.forEach((e, i) => { const h = i % 2 === 0; Object.assign(e.style, { width: h ? '8px' : '2px', height: h ? '2px' : '8px' }); });
    this.ch = ch;
    $('bag').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c && c.dataset.i !== undefined) this.equipFromBag(+c.dataset.i); });
    $('bag').addEventListener('contextmenu', (e) => { e.preventDefault(); const c = e.target.closest('.card'); if (c && c.dataset.i !== undefined) this.scrapFromBag(+c.dataset.i); });
    $('slots').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c && c.dataset.slot !== undefined) { this.game.player.equip(+c.dataset.slot); this.renderInventory(); } });
    this.buildScreens();
  }

  buildScreens() {
    const s = document.createElement('div');
    s.innerHTML = `
    <div id="title" class="screen"><div class="sub">A wasteland extraction shooter</div><h1>Come and <span>Get Out</span></h1>
      <div class="sub" style="margin-top:18px">Loot the ruins · survive the raiders · reach the extraction</div>
      <div class="row"><input id="seedin" class="seed" placeholder="SEED"><button class="btn ghost" id="rnd">Random</button><button class="btn" id="deploy">Deploy</button></div>
      <div class="controls"><div><b>WASD</b>Move</div><div><b>Mouse</b>Aim</div><div><b>LMB</b>Fire</div><div><b>Space</b>Dodge roll</div><div><b>R</b>Reload</div><div><b>Q / 1 2</b>Swap weapon</div><div><b>E</b>Loot / open</div><div><b>F</b>Medkit</div><div><b>Tab</b>Inventory</div><div><b>Esc</b>Pause</div></div></div>
    <div id="dead" class="screen dead hidden"><div class="sub">Signal lost</div><h1>You Died</h1><div class="big" id="deadstats"></div><div class="row"><button class="btn ghost" id="retry">Retry seed</button><button class="btn" id="newrun">New district</button></div></div>
    <div id="win" class="screen win hidden"><div class="sub">Evac confirmed</div><h1>Extracted</h1><div class="big" id="winstats"></div><div class="row"><button class="btn" id="next">Next district</button><button class="btn ghost" id="replay">Replay seed</button></div></div>
    <div id="pause" class="screen hidden"><h1 style="font-size:48px">Paused</h1><div class="row"><button class="btn" id="resume">Resume</button><button class="btn ghost" id="abandon">Abandon run</button></div></div>`;
    document.body.appendChild(s);
    const g = this.game;
    $('seedin').value = g.seed;
    $('rnd').onclick = () => { $('seedin').value = Math.floor(Math.random() * 1e6); g.audio.unlock(); g.audio.play('ui'); };
    $('deploy').onclick = () => { g.audio.unlock(); g.audio.play('ui'); const v = parseInt($('seedin').value, 10); g.startRun(isNaN(v) ? g.seed : v); };
    $('retry').onclick = () => { g.audio.play('ui'); g.startRun(g.seed); };
    $('newrun').onclick = () => { g.audio.play('ui'); g.startRun(Math.floor(Math.random() * 1e6)); };
    $('next').onclick = () => { g.audio.play('ui'); g.startRun(Math.floor(Math.random() * 1e6)); };
    $('replay').onclick = () => { g.audio.play('ui'); g.startRun(g.seed); };
    $('resume').onclick = () => g.setPaused(false);
    $('abandon').onclick = () => { g.setPaused(false); g.showTitle(); };
  }
  show(id, on) { $(id).classList.toggle('hidden', !on); }
  setScreen(mode) {
    this.show('title', mode === 'title'); this.show('dead', mode === 'dead'); this.show('win', mode === 'extracted'); this.show('pause', mode === 'paused');
    this.root.style.display = mode === 'title' ? 'none' : '';
    document.body.style.cursor = mode === 'playing' ? 'none' : 'default';
  }
  runStats() {
    const p = this.game.player, t = this.game.runTime;
    return `District <b>#${this.game.seed}</b> · ${Math.floor(t / 60)}m ${Math.floor(t % 60)}s<br>Kills <b>${p.kills}</b> · Damage dealt <b>${Math.round(p.damageDealt)}</b> · Shots <b>${p.shotsFired}</b><br>Loot value <b>${p.lootValue}</b> · Salvage <b>${p.scrap}</b>`;
  }
  showDeath() { $('deadstats').innerHTML = this.runStats(); }
  showWin() { $('winstats').innerHTML = this.runStats(); }

  newRun() {
    // static minimap layer
    const g = this.game, L = g.layout, S = 3, half = L.half + 6, N = Math.ceil(half * 2 * S);
    const c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d');
    x.fillStyle = '#16181a'; x.fillRect(0, 0, N, N);
    const X = (v) => (v + half) * S;
    x.fillStyle = '#2b2d2f';
    for (const r of L.roads) { if (r.axis === 'z') x.fillRect(X(r.x - r.w / 2), 0, r.w * S, N); else x.fillRect(0, X(r.z - r.w / 2), N, r.w * S); }
    for (const b of L.buildings) { x.fillStyle = b.collapsed ? 'rgba(90,84,74,.5)' : 'rgba(70,72,76,.55)'; x.fillRect(X(b.x0), X(b.z0), (b.x1 - b.x0) * S, (b.z1 - b.z0) * S); }
    for (const bx of g.col.boxes) {
      x.save(); x.translate(X(bx.x), X(bx.z)); x.rotate(-bx.rot);
      x.fillStyle = bx.kind === 'wall' ? '#8d8a84' : bx.kind === 'car' ? '#5a4a3e' : '#55565a';
      x.fillRect(-bx.hx * S, -bx.hz * S, bx.hx * 2 * S, bx.hz * 2 * S); x.restore();
    }
    this.mmStatic = c; this.mmScale = S; this.mmHalf = half;
    $('zone').textContent = `${PALETTES[L.palette].name} · District #${g.seed}`;
    $('feed').innerHTML = '';
    for (const b of this.bars.values()) b.remove(); this.bars.clear();
    for (const d of this.dns) d.el.remove(); this.dns = [];
    this.dirty();
  }

  dirty() { this._dirty = true; }
  toast(msg, color = '#fff') { const t = $('toast'); t.textContent = msg; t.style.color = color; t.style.opacity = 1; this.toastT = 1.6; }
  feed(name, color, sub) {
    const f = $('feed'), d = document.createElement('div'); d.className = 'fi'; d.style.borderColor = color;
    d.innerHTML = `<span style="color:${color}">${esc(name)}</span><small>${esc(sub)}</small>`;
    f.prepend(d); setTimeout(() => d.remove(), 5000);
    while (f.children.length > 6) f.lastChild.remove();
  }
  feedKill(type) { this.feed(`${type[0].toUpperCase() + type.slice(1)} eliminated`, '#ff6a50', ''); }
  hitmarker(kill) { const h = $('hitm'); h.classList.toggle('kill', !!kill); this.hitT = kill ? 0.35 : 0.15; this.game.audio.play('hitmarker'); }
  damageNumber(x, y, z, dmg, crit) {
    const el = document.createElement('div'); el.className = 'dn' + (crit ? ' crit' : ''); el.textContent = Math.round(dmg);
    $('dmg').appendChild(el);
    this.dns.push({ el, x: x + (Math.random() - 0.5) * 0.6, y, z: z + (Math.random() - 0.5) * 0.6, t: 0 });
    if (this.dns.length > 40) this.dns.shift().el.remove();
  }
  project(x, y, z) {
    const v = this.v.set(x, y, z).project(this.game.renderer.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, vis: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
  }

  itemStats(it, compare) {
    if (it.kind !== 'weapon') return it.kind === 'medkit' ? 'Restores 50 HP over time' : it.kind === 'ammo' ? 'Refills all ammo types' : `Salvage value ${it.amount}`;
    const s = it.stats, d = dps(it);
    let cmp = '';
    if (compare) { const cd = dps(compare), diff = d - cd; cmp = ` <span class="${diff >= 0 ? 'up' : 'down'}">(${diff >= 0 ? '+' : ''}${diff})</span>`; }
    return `DPS <b>${d}</b>${cmp} · DMG ${Math.round(s.dmg)}${s.pellets > 1 ? '×' + s.pellets : ''} · ${Math.round(s.rpm)} RPM<br>MAG ${s.mag} · RELOAD ${s.reload.toFixed(1)}s · CRIT ${Math.round(s.crit * 100)}%` + (it.affixes.length ? `<div class="a">${it.affixes.map(esc).join(' · ')}</div>` : '');
  }

  toggleInventory(on = !this.inventoryOpen) {
    this.inventoryOpen = on; this.show('inventory', on);
    document.body.style.cursor = on || this.game.mode !== 'playing' ? 'default' : 'none';
    if (on) this.renderInventory();
  }
  card(it, attrs, sel = false, compare = null) {
    if (!it) return `<div class="card empty">EMPTY</div>`;
    const R = RARITY[it.rarity];
    return `<div class="card${sel ? ' sel' : ''}" ${attrs} style="border-top-color:${R.color}"><div class="n" style="color:${R.color}">${esc(it.name)}</div><div class="r" style="color:${R.color}">${R.name} ${BASES[it.base].name}</div><div class="s">${this.itemStats(it, compare)}</div></div>`;
  }
  renderInventory() {
    const p = this.game.player;
    $('slots').innerHTML = p.weapons.map((w, i) => this.card(w, `data-slot="${i}"`, i === p.cur)).join('');
    let bag = '';
    for (let i = 0; i < p.maxBackpack; i++) bag += p.backpack[i] ? this.card(p.backpack[i], `data-i="${i}"`, false, p.weapon) : this.card(null);
    $('bag').innerHTML = bag;
    $('invstats').innerHTML = `<span>Medkits <b>${p.medkits}</b></span><span>Light <b>${p.ammo.light}</b></span><span>Shells <b>${p.ammo.shells}</b></span><span>Heavy <b>${p.ammo.heavy}</b></span><span>Salvage <b>${p.scrap}</b></span><span>Kills <b>${p.kills}</b></span>`;
  }
  equipFromBag(i) {
    const p = this.game.player, it = p.backpack[i]; if (!it) return;
    p.backpack[i] = p.weapons[p.cur]; p.weapons[p.cur] = it; p.equip(p.cur);
    this.renderInventory(); this.dirty();
  }
  scrapFromBag(i) {
    const p = this.game.player, it = p.backpack[i]; if (!it) return;
    p.backpack.splice(i, 1); const v = Math.round(it.value / 4); p.scrap += v;
    this.feed(`Scrapped ${it.name}`, '#aaa', `+${v} salvage`); this.game.audio.play('crate'); this.renderInventory();
  }

  update(dt) {
    const g = this.game, p = g.player; if (!p) return;
    const input = g.input;
    // crosshair
    const ch = $('crosshair'); ch.style.left = input.mouse.x + 'px'; ch.style.top = input.mouse.y + 'px';
    const w = p.weapon, B = BASES[w.base];
    const spreadPx = 6 + (w.stats.spread * (Math.hypot(p.vel.x, p.vel.z) > 1 ? 1.25 : 1) + p.bloom * 4) * 1.6;
    const offs = [[spreadPx, 0], [0, spreadPx], [-spreadPx - 8, 0], [0, -spreadPx - 8]];
    this.ch.forEach((e, i) => { e.style.left = (i % 2 === 0 ? offs[i][0] : -1) + 'px'; e.style.top = (i % 2 === 1 ? offs[i][1] : -1) + 'px'; });
    this.hitT = Math.max(0, this.hitT - dt); $('hitm').style.opacity = this.hitT > 0 ? 1 : 0;
    const rr = $('rr'); rr.style.strokeDashoffset = w.reloadT > 0 ? 88 * (w.reloadT / (w.reloadTotal || 1)) : 88;
    $('reloadring').style.opacity = w.reloadT > 0 ? 1 : 0;
    // health
    const hpp = (p.hp / p.maxHp) * 100;
    $('hpfill').style.width = hpp + '%'; $('hplag').style.width = hpp + '%'; $('hptext').textContent = Math.ceil(p.hp);
    const pips = this.root.querySelectorAll('.pip i');
    pips.forEach((e, i) => { const v = i < p.charges ? 1 : i === p.charges ? p.chargeT / 1.6 : 0; e.style.transform = `scaleX(${v})`; e.style.opacity = i < p.charges ? 1 : 0.5; });
    if (this._dirty) {
      this._dirty = false;
      if (!$('hpbar').querySelector('.seg')) for (let i = 1; i < 10; i++) { const s = document.createElement('div'); s.className = 'seg'; s.style.left = i * 10 + '%'; $('hpbar').appendChild(s); }
      $('mk').textContent = p.medkits;
      const R = RARITY[w.rarity];
      $('wname').textContent = w.name; $('wname').style.color = R.color;
      $('wtype').textContent = `${R.name} ${B.name} · DPS ${dps(w)}`;
      const other = p.weapons[1 - p.cur];
      $('wsec').innerHTML = other ? `[Q] <span style="color:${RARITY[other.rarity].color}">${esc(other.name)}</span> · ${other.mag}/${other.stats.mag}` : '';
      if (this.inventoryOpen) this.renderInventory();
    }
    $('ammo').innerHTML = `${w.mag}<small> / ${p.ammo[B.ammo]}</small>`;
    $('ammo').style.color = w.mag === 0 ? '#ff5a46' : w.mag <= w.stats.mag * 0.25 ? '#ffb347' : '';
    $('reloadbar').firstChild.style.width = w.reloadT > 0 ? (1 - w.reloadT / (w.reloadTotal || 1)) * 100 + '%' : '0';
    // toast
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) $('toast').style.opacity = 0; }
    // damage numbers
    for (let i = this.dns.length - 1; i >= 0; i--) {
      const d = this.dns[i]; d.t += dt;
      const s = this.project(d.x, d.y + d.t * 1.4, d.z);
      d.el.style.left = s.x + 'px'; d.el.style.top = s.y + 'px'; d.el.style.opacity = Math.max(0, 1 - Math.max(0, d.t - 0.5) * 2);
      d.el.style.transform = `translate(-50%,-50%) scale(${1 + Math.max(0, 0.25 - d.t) * 2})`;
      if (d.t > 1.1) { d.el.remove(); this.dns.splice(i, 1); }
    }
    // enemy bars
    const seen = new Set();
    for (const e of g.enemies.list) {
      if (e.dead || e.hpShow <= 0) continue;
      seen.add(e);
      let b = this.bars.get(e); if (!b) { b = document.createElement('div'); b.className = 'ebar'; b.innerHTML = '<i></i>'; $('bars').appendChild(b); this.bars.set(e, b); }
      const s = this.project(e.pos.x, 2.3 * e.hum.K.scale, e.pos.z);
      b.style.left = s.x + 'px'; b.style.top = s.y + 'px'; b.firstChild.style.width = (e.hp / e.maxHp) * 100 + '%';
      b.style.opacity = Math.min(1, e.hpShow);
    }
    for (const [e, b] of this.bars) if (!seen.has(e)) { b.remove(); this.bars.delete(e); }
    // loot prompt
    const f = g.loot.focus, pr = $('prompt');
    if (f && g.mode === 'playing') {
      const s = this.project(f.x, 1.3, f.z);
      pr.classList.remove('hidden'); pr.style.left = s.x + 'px'; pr.style.top = s.y - 10 + 'px';
      const key = f.kind === 'crate' ? 'crate' + f.tier : 'd' + f.item.id + ':' + p.weapon.id;
      if (pr.dataset.key !== key) {
        pr.dataset.key = key;
        if (f.kind === 'crate') { const tn = ['Supply crate', 'Military crate', 'Armored cache', 'Black-ops cache'][f.tier]; pr.style.borderTopColor = ['#9a9a90', '#4fdc4a', '#3a8cff', '#a850ff'][f.tier]; pr.innerHTML = `<div class="n">${tn}</div><div class="s"><span class="k">E</span>Open</div>`; }
        else {
          const it = f.item, R = RARITY[it.rarity]; pr.style.borderTopColor = R.color;
          pr.innerHTML = `<div class="n" style="color:${R.color}">${esc(it.name)}</div><div class="r" style="color:${R.color}">${R.name}${it.kind === 'weapon' ? ' ' + BASES[it.base].name : ''}</div><div class="s">${this.itemStats(it, p.weapon)}</div><div class="s"><span class="k">E</span>Pick up</div>`;
        }
      }
    } else pr.classList.add('hidden');
    // objective
    const ex = g.extraction;
    if (ex) {
      const d = Math.hypot(ex.x - p.pos.x, ex.z - p.pos.z);
      $('objt').textContent = g.extractT > 0 ? 'Hold the extraction zone' : 'Reach the extraction point';
      $('objd').textContent = `${Math.round(d)} m · ${g.enemies.alive.length} hostiles in district`;
      this.show('extractbar', g.extractT > 0 && g.mode === 'playing');
      if (g.extractT > 0) { $('extfill').style.width = (g.extractT / g.extractDur) * 100 + '%'; $('extt').textContent = `EVAC INBOUND · ${Math.max(0, g.extractDur - g.extractT).toFixed(1)}s`; }
    }
    this.drawMinimap();
  }

  drawMinimap() {
    const g = this.game, p = g.player, x = this.mm, W = 420, R = 210, S = this.mmScale, half = this.mmHalf;
    if (!this.mmStatic) return;
    const zoom = 1.1; // canvas px per static px
    x.save(); x.clearRect(0, 0, W, W);
    x.beginPath(); x.arc(R, R, R - 2, 0, Math.PI * 2); x.clip();
    x.fillStyle = '#0d0e0f'; x.fillRect(0, 0, W, W);
    const yaw = g.renderer.rig.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rot = -Math.PI / 2 - Math.atan2(fz, fx);
    x.translate(R, R); x.rotate(rot); x.scale(zoom, zoom);
    x.translate(-(p.pos.x + half) * S, -(p.pos.z + half) * S);
    x.globalAlpha = 0.95; x.drawImage(this.mmStatic, 0, 0); x.globalAlpha = 1;
    const X = (v) => (v + half) * S;
    // loot + crates
    for (const d of g.loot.drops) { x.fillStyle = RARITY[d.item.rarity].color; x.beginPath(); x.arc(X(d.x), X(d.z), 4, 0, 7); x.fill(); }
    for (const c of g.loot.crates) if (!c.opened) { x.fillStyle = '#d8c070'; x.fillRect(X(c.x) - 4, X(c.z) - 4, 8, 8); }
    // enemies (only alerted or near)
    for (const e of g.enemies.list) {
      if (e.dead) continue; const d = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
      if (d > 34 && !e.alert) continue;
      x.fillStyle = e.alert ? '#ff3a2a' : 'rgba(255,90,60,.6)'; x.beginPath(); x.arc(X(e.pos.x), X(e.pos.z), e.type === 'brute' ? 7 : 5, 0, 7); x.fill();
    }
    // extraction
    const ex = g.extraction;
    if (ex) { const t = performance.now() / 300; x.strokeStyle = '#5dff8a'; x.lineWidth = 3; x.beginPath(); x.arc(X(ex.x), X(ex.z), 14 + Math.sin(t) * 3, 0, 7); x.stroke(); x.fillStyle = '#5dff8a'; x.beginPath(); x.arc(X(ex.x), X(ex.z), 5, 0, 7); x.fill(); }
    x.restore();
    // player arrow (always up = screen up)
    x.save(); x.translate(R, R);
    const ang = Math.atan2(Math.sin(p.face), Math.cos(p.face));
    // facing in screen space: world dir (sin f, cos f) rotated by rot
    const wx = Math.sin(p.face), wz = Math.cos(p.face);
    const sx = wx * Math.cos(rot) - wz * Math.sin(rot), sy = wx * Math.sin(rot) + wz * Math.cos(rot);
    x.rotate(Math.atan2(sy, sx) + Math.PI / 2);
    x.fillStyle = '#7fd6ff'; x.beginPath(); x.moveTo(0, -11); x.lineTo(7, 8); x.lineTo(0, 4); x.lineTo(-7, 8); x.closePath(); x.fill();
    x.restore();
    // extraction direction marker at rim if off-map
    if (ex) {
      const dx = ex.x - p.pos.x, dz = ex.z - p.pos.z;
      const sx = dx * Math.cos(rot) - dz * Math.sin(rot), sy = dx * Math.sin(rot) + dz * Math.cos(rot);
      const d = Math.hypot(sx, sy) * S * zoom;
      if (d > R - 14) { const a = Math.atan2(sy, sx); x.fillStyle = '#5dff8a'; x.beginPath(); x.arc(R + Math.cos(a) * (R - 14), R + Math.sin(a) * (R - 14), 7, 0, 7); x.fill(); }
      $('mmlabel').textContent = `Extraction ${Math.round(Math.hypot(dx, dz))}m`;
    }
    void ang;
  }
}
