// Run-loop screens: title (stencil logo, drifting ash, broadcast readout), death dossier (run stats + lost
// gear), extraction sequence (dropship + haul summary on the right so the pad stays visible), pause.
import { RARITY, BASES, dps } from '../combat/weapons.js';
import { PALETTES } from '../world/lighting.js';
import { logo } from './icons.js';
import { esc, iconHTML, itemType } from './itemcard.js';
import { Dropship } from './dropship.js';

const $ = (id) => document.getElementById(id);
const fmtT = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export class Screens {
  constructor(hud) {
    this.hud = hud; const g = this.game = hud.game;
    const s = document.createElement('div'); s.id = 'screens';
    s.innerHTML = `
    <div id="title" class="screen title">
      <canvas id="ash"></canvas><div class="scan"></div>
      <div class="tcol">
        <div class="kick">// Wasteland extraction protocol</div>
        <div id="logo"></div>
        <div class="tag">Loot the ruins. Outgun the raiders. Reach the evac. <b>Don't die with the goods.</b></div>
        <div class="menu">
          <button class="btn big" id="deploy"><span>Deploy</span><i>Enter</i></button>
          <div class="seedrow"><label>District seed</label><input id="seedin" class="seed" spellcheck="false"><button class="btn ghost sq" id="rnd" title="Random district">⟳</button></div>
        </div>
        <div class="controls">
          <div><kbd>WASD</kbd>Move</div><div><kbd>LMB</kbd>Fire</div><div><kbd>Space</kbd>Dodge</div><div><kbd>R</kbd>Reload</div>
          <div><kbd>Q</kbd>Swap</div><div><kbd>E</kbd>Loot</div><div><kbd>F</kbd>Medkit</div><div><kbd>Tab</kbd>Pack</div>
        </div>
      </div>
      <div class="bcast"><div class="lbl">Broadcast intercept</div><div id="bcast"></div></div>
      <div class="ver">CAGO // build ${new Date().getFullYear()}.${String(new Date().getMonth() + 1).padStart(2, '0')} · procedural district generator</div>
    </div>
    <div id="dead" class="screen dossier dead hidden">
      <div class="dcol">
        <div class="kick">Signal lost · operator down</div>
        <h1 class="stencil">K.I.A.</h1>
        <div class="where" id="dwhere"></div>
        <div class="sgrid" id="dstats"></div>
        <div class="lost"><div class="lbl">Left in the zone</div><div id="dlost" class="haul"></div></div>
        <div class="row"><button class="btn" id="newrun"><span>New district</span></button><button class="btn ghost" id="retry"><span>Retry seed</span></button></div>
      </div>
    </div>
    <div id="win" class="screen win hidden">
      <div class="banner"><div class="kick">Evac confirmed</div><div class="stencil">Extracted</div></div>
      <div class="wcol">
        <div class="lbl">Haul secured</div>
        <div class="total"><b id="wval">0</b><span>Haul value</span></div>
        <div id="whaul" class="haul"></div>
        <div class="sgrid" id="wstats"></div>
        <div class="row"><button class="btn" id="next"><span>Next district</span></button><button class="btn ghost" id="replay"><span>Replay seed</span></button></div>
      </div>
    </div>
    <div id="pause" class="screen dossier hidden"><div class="dcol"><div class="kick">Comms hold</div><h1 class="stencil" style="font-size:72px">Paused</h1><div class="row"><button class="btn" id="resume"><span>Resume</span></button><button class="btn ghost" id="abandon"><span>Abandon run</span></button></div></div></div>`;
    document.body.appendChild(s);
    const L = logo(); L.style.width = '100%'; L.style.height = 'auto'; $('logo').appendChild(L);
    $('seedin').value = g.seed;
    const go = (seed) => { g.audio.unlock(); g.audio.play('ui'); g.startRunAsync(seed); };
    $('rnd').onclick = () => { $('seedin').value = Math.floor(Math.random() * 1e6); g.audio.unlock(); g.audio.play('ui'); this.broadcast(); };
    $('deploy').onclick = () => { const v = parseInt($('seedin').value, 10); go(isNaN(v) ? g.seed : v); };
    addEventListener('keydown', (e) => { if (e.code === 'Enter' && g.mode === 'title') $('deploy').click(); });
    $('retry').onclick = () => go(g.seed);
    $('newrun').onclick = $('next').onclick = () => go(Math.floor(Math.random() * 1e6));
    $('replay').onclick = () => go(g.seed);
    $('resume').onclick = () => g.setPaused(false);
    $('abandon').onclick = () => { g.setPaused(false); g.showTitle(); };
    this.ash(); this.broadcast();
  }
  broadcast() {
    const g = this.game, v = parseInt($('seedin').value, 10), seed = isNaN(v) ? g.seed : v;
    const pal = g.layout && seed === g.seed ? PALETTES[g.layout.palette].name : 'Unknown conditions';
    $('bcast').innerHTML = `<div>District <b>#${seed}</b></div><div>${esc(pal)}</div><div class="warn">Hostile density: high</div><div>Evac window: open</div>`;
  }
  // drifting embers / ash on a cheap 2D canvas behind the title column
  ash() {
    const c = $('ash'), x = c.getContext('2d'), P = [];
    for (let i = 0; i < 90; i++) P.push({ x: Math.random(), y: Math.random(), s: Math.random(), v: 0.2 + Math.random(), e: Math.random() < 0.25 });
    let last = performance.now();
    const tick = (now) => {
      requestAnimationFrame(tick);
      if (this.game.mode !== 'title') return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (c.width !== innerWidth) { c.width = innerWidth; c.height = innerHeight; }
      x.clearRect(0, 0, c.width, c.height);
      for (const p of P) {
        p.y -= dt * 0.018 * p.v; p.x += dt * (0.008 + Math.sin(now / 1500 + p.s * 9) * 0.006);
        if (p.y < -0.02) { p.y = 1.02; p.x = Math.random(); } if (p.x > 1.02) p.x = -0.02;
        const r = p.e ? 1.2 + p.s * 1.4 : 0.8 + p.s * 1.8, a = p.e ? 0.5 + 0.5 * Math.sin(now / 200 + p.s * 40) : 0.25;
        x.fillStyle = p.e ? `rgba(255,${140 + p.s * 60 | 0},60,${a})` : `rgba(200,190,175,${a})`;
        x.beginPath(); x.arc(p.x * c.width, p.y * c.height, r, 0, 7); x.fill();
      }
    };
    requestAnimationFrame(tick);
  }

  statGrid(extra = []) {
    const g = this.game, p = g.player;
    const cells = [['Time', fmtT(g.runTime)], ['Kills', p.kills], ['Damage', Math.round(p.damageDealt).toLocaleString()], ['Shots', p.shotsFired], ['Salvage', p.scrap], ...extra];
    return cells.map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join('');
  }
  haul(items, delay = 0.25) {
    const sorted = items.filter(Boolean).slice().sort((a, b) => RARITY[b.rarity].tier - RARITY[a.rarity].tier || (b.value || 0) - (a.value || 0));
    if (!sorted.length) return '<div class="none">Nothing but the clothes on your back.</div>';
    return sorted.slice(0, 8).map((it, i) => `<div class="hi r${RARITY[it.rarity].tier}" style="--rc:${RARITY[it.rarity].color};animation-delay:${delay + i * 0.12}s">${iconHTML(it, 84, 32)}<div><div class="nm">${esc(it.name)}</div><div class="ty">${esc(itemType(it))}${it.kind === 'weapon' ? ' · ' + dps(it) + ' DPS' : ''}</div></div><b>${it.value || ''}</b></div>`).join('') + (sorted.length > 8 ? `<div class="none">+${sorted.length - 8} more</div>` : '');
  }
  showDeath() {
    const g = this.game, p = g.player, L = g.layout;
    $('dwhere').innerHTML = `District #${g.seed} · ${esc(PALETTES[L.palette].name)} · ${Math.round(Math.hypot(g.extraction.x - p.pos.x, g.extraction.z - p.pos.z))} m from evac`;
    $('dstats').innerHTML = this.statGrid([['Loot value', p.lootValue]]);
    $('dlost').innerHTML = this.haul([...p.weapons, ...p.backpack]);
  }
  showWin() {
    const g = this.game, p = g.player;
    p.god = true;
    const items = [...p.weapons, ...p.backpack], total = items.reduce((s, it) => s + (it ? it.value || 0 : 0), 0) + p.scrap;
    $('whaul').innerHTML = this.haul(items, 2.6);
    $('wstats').innerHTML = this.statGrid([['Items', items.filter(Boolean).length]]);
    this.countTo = total; this.countT = 0; $('wval').textContent = '0';
    if (this.ship) this.ship.dispose();
    const cam = g.renderer.camera.position, ex = g.extraction, dl = Math.hypot(ex.x - cam.x, ex.z - cam.z) || 1;
    this.ship = new Dropship(g.scene, p.pos.x, p.pos.z, { x: (ex.x - cam.x) / dl, z: (ex.z - cam.z) / dl });
  }
  update(dt) {
    const g = this.game;
    if (this.ship && g.mode === 'extracted') {
      const t = this.ship.update(dt, g.player);
      if (t > 1.2) { this.countT += dt; const k = Math.min(1, Math.max(0, (this.countT - 1.8) / 1.4)); $('wval').textContent = Math.round(this.countTo * (1 - Math.pow(1 - k, 3))).toLocaleString(); }
      if (t > 9) { this.ship.dispose(); this.ship = null; }
    }
  }
  reset() { if (this.ship) { this.ship.dispose(); this.ship = null; } }
  setScreen(mode) {
    const sh = (id, on) => $(id).classList.toggle('hidden', !on);
    sh('title', mode === 'title'); sh('dead', mode === 'dead'); sh('win', mode === 'extracted'); sh('pause', mode === 'paused');
    if (mode === 'title') { $('seedin').value = this.game.seed; this.broadcast(); }
  }
}
