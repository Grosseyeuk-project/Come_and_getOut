// Field pack (inventory): docked to the right edge so the player stays visible. Equipped slots, 4x2 backpack
// grid with procedural weapon icons in rarity frames, side-by-side compare (selected vs equipped) with
// green/red stat deltas, and actions: equip (LMB / E), drop to ground (RMB / G), scrap (X).
import { RARITY } from '../combat/weapons.js';
import { esc, iconHTML, cardHTML } from './itemcard.js';

const $ = (id) => document.getElementById(id);

export class Inventory {
  constructor(hud) {
    this.hud = hud; this.game = hud.game; this.sel = null; // {from:'bag'|'slot', i}
    const el = this.el = document.createElement('div'); el.id = 'inventory'; el.className = 'hidden';
    el.innerHTML = `<div class="ishade"></div><div class="ipanel mpanel">
      <div class="ihead"><div><div class="kick">Field pack</div><h2 class="stencil">Inventory</h2></div><div class="ires" id="ires"></div></div>
      <div class="lbl">Equipped</div><div class="islots" id="slots"></div>
      <div class="lbl" id="baglbl">Backpack</div><div class="ibag" id="bag"></div>
      <div class="icmp" id="icmp"></div>
      <div class="ikeys"><span><kbd>LMB</kbd>Equip</span><span><kbd>RMB</kbd>Drop</span><span><kbd>X</kbd>Scrap</span><span><kbd>Tab</kbd>Close</span></div>
    </div>`;
    hud.root.appendChild(el);
    const tile = (e) => e.target.closest('[data-k]');
    el.addEventListener('mouseover', (e) => { const t = tile(e); if (t && t.dataset.k !== 'none') { this.sel = { from: t.dataset.k, i: +t.dataset.i }; this.renderCompare(); this.mark(); } });
    el.addEventListener('click', (e) => { const t = tile(e); if (!t) return; if (t.dataset.k === 'bag') this.equip(+t.dataset.i); else if (t.dataset.k === 'slot') { this.game.player.equip(+t.dataset.i); this.render(); } });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); const t = tile(e); if (t && t.dataset.k === 'bag') this.drop(+t.dataset.i); });
    addEventListener('keydown', (e) => {
      if (!this.open || !this.sel || this.sel.from !== 'bag') return;
      if (e.code === 'KeyX') this.scrap(this.sel.i); else if (e.code === 'KeyG') this.drop(this.sel.i); else if (e.code === 'KeyE') this.equip(this.sel.i);
    });
  }
  get open() { return this.hud.inventoryOpen; }
  show(on) {
    this.el.classList.toggle('hidden', !on);
    if (on) { const p = this.game.player; this.sel = p.backpack.length ? { from: 'bag', i: 0 } : { from: 'slot', i: p.cur }; this.render(); }
  }
  tile(it, k, i, extra = '') {
    if (!it) return `<div class="itile empty" data-k="none"><span>${i + 1}</span></div>`;
    const R = RARITY[it.rarity];
    return `<div class="itile r${R.tier}${extra}" data-k="${k}" data-i="${i}" style="--rc:${R.color}">${iconHTML(it, 112, 42)}<div class="tn">${esc(it.name)}</div></div>`;
  }
  render() {
    const p = this.game.player; if (!p) return;
    $('slots').innerHTML = p.weapons.map((w, i) => {
      const R = RARITY[w.rarity];
      return `<div class="islot r${R.tier}${i === p.cur ? ' act' : ''}" data-k="slot" data-i="${i}" style="--rc:${R.color}"><kbd>${i + 1}</kbd>${iconHTML(w, 150, 56)}<div><div class="nm">${esc(w.name)}</div><div class="ty">${R.name} · ${w.dps} DPS</div></div></div>`;
    }).join('');
    let bag = ''; for (let i = 0; i < p.maxBackpack; i++) bag += this.tile(p.backpack[i], 'bag', i);
    $('bag').innerHTML = bag;
    $('baglbl').innerHTML = `Backpack <b>${p.backpack.length}/${p.maxBackpack}</b>`;
    $('ires').innerHTML = `<div><i class="ri med"></i><b>${p.medkits}</b><span>Medkits</span></div><div><i class="ri amm"></i><b>${p.ammo.light}·${p.ammo.shells}·${p.ammo.heavy}</b><span>Ammo L·S·H</span></div><div><i class="ri scr"></i><b>${p.scrap}</b><span>Salvage</span></div>`;
    if (this.sel && this.sel.from === 'bag' && !p.backpack[this.sel.i]) this.sel = p.backpack.length ? { from: 'bag', i: Math.min(this.sel.i, p.backpack.length - 1) } : { from: 'slot', i: p.cur };
    this.renderCompare(); this.mark();
  }
  mark() { this.el.querySelectorAll('[data-k]').forEach((t) => t.classList.toggle('sel', !!this.sel && t.dataset.k === this.sel.from && +t.dataset.i === this.sel.i)); }
  renderCompare() {
    const p = this.game.player, s = this.sel, box = $('icmp');
    if (!s) { box.innerHTML = ''; return; }
    const it = s.from === 'bag' ? p.backpack[s.i] : p.weapons[s.i];
    if (!it) { box.innerHTML = ''; return; }
    if (s.from === 'bag') box.innerHTML = cardHTML(it, p.weapon, { title: 'Selected' }) + cardHTML(p.weapon, null, { title: `Equipped · slot ${p.cur + 1}` });
    else box.innerHTML = cardHTML(it, null, { title: s.i === p.cur ? 'Equipped · active' : `Equipped · slot ${s.i + 1}` }) + `<div class="icard ghost"><div class="hint">Hover a backpack item to compare it against your active weapon.</div></div>`;
  }
  equip(i) {
    const p = this.game.player, it = p.backpack[i]; if (!it) return;
    p.backpack[i] = p.weapons[p.cur]; p.weapons[p.cur] = it; p.equip(p.cur);
    this.game.audio.play('ui'); this.render(); this.hud.dirty();
  }
  drop(i) {
    const p = this.game.player, it = p.backpack[i]; if (!it) return;
    p.backpack.splice(i, 1); this.game.loot.dropAtPlayer(it);
    this.hud.feed(`Dropped ${it.name}`, '#9a9488', '', it); this.game.audio.play('crate'); this.render(); this.hud.dirty();
  }
  scrap(i) {
    const p = this.game.player, it = p.backpack[i]; if (!it) return;
    p.backpack.splice(i, 1); const v = Math.round(it.value / 4); p.scrap += v;
    this.hud.feed(`Scrapped ${it.name}`, '#aaa', `+${v} salvage`, it); this.game.audio.play('crate'); this.render(); this.hud.dirty();
  }
}
