// Shared item presentation: tooltip/compare cards with stat deltas, rarity frames, icons.
import { RARITY, BASES, dps } from '../combat/weapons.js';
import { itemIcon } from './icons.js';

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const AMMO = { light: 'Light rounds', shells: 'Shells', heavy: 'Heavy rounds' };

// [label, value(it), format, higherIsBetter]
const ROWS = [
  ['Damage', (it) => it.stats.dmg * it.stats.pellets, (v, it) => `${Math.round(it.stats.dmg)}${it.stats.pellets > 1 ? '×' + it.stats.pellets : ''}`, true],
  ['Fire rate', (it) => it.stats.rpm, (v) => `${Math.round(v)} rpm`, true],
  ['Magazine', (it) => it.stats.mag, (v) => `${v}`, true],
  ['Reload', (it) => it.stats.reload, (v) => `${v.toFixed(1)}s`, false],
  ['Crit chance', (it) => it.stats.crit, (v) => `${Math.round(v * 100)}%`, true],
  ['Accuracy', (it) => 1 / (1 + it.stats.spread), (v, it) => `${Math.round(100 - Math.min(90, it.stats.spread * 5))}`, true],
];

export function itemType(it) {
  const R = RARITY[it.rarity];
  return it.kind === 'weapon' ? `${R.name} ${BASES[it.base].name}` : it.kind === 'scrap' ? 'Crafting material' : 'Consumable';
}
export function iconHTML(it, w = 120, h = 46, cls = '') {
  return `<img class="icn ${cls}" src="${itemIcon(it, w, h)}" width="${w}" height="${h}" alt="">`;
}

function delta(a, b, better, fmtPct = false) {
  if (b === undefined || b === null) return '';
  const d = a - b; if (Math.abs(d) < 1e-6 * Math.max(1, Math.abs(b))) return '<i class="dl eq">=</i>';
  const good = better ? d > 0 : d < 0, pct = b !== 0 ? Math.round((d / Math.abs(b)) * 100) : 0;
  return `<i class="dl ${good ? 'up' : 'down'}">${good ? '▲' : '▼'} ${Math.abs(pct)}%</i>`;
}

// Full tooltip card. compare: currently equipped item (or null). opts.title = header tag (e.g. "Equipped").
export function cardHTML(it, compare = null, opts = {}) {
  const R = RARITY[it.rarity], t = R.tier;
  let body = '';
  if (it.kind === 'weapon') {
    const d = dps(it), cd = compare && compare.kind === 'weapon' ? dps(compare) : null;
    const dd = cd !== null ? d - cd : null;
    body += `<div class="dps"><b>${d}</b><span>DPS</span>${dd !== null ? `<em class="${dd > 0 ? 'up' : dd < 0 ? 'down' : 'eq'}">${dd > 0 ? '▲ +' : dd < 0 ? '▼ ' : ''}${dd === 0 ? '=' : dd}</em>` : ''}<small>${AMMO[BASES[it.base].ammo]}</small></div>`;
    body += '<div class="rows">' + ROWS.map(([l, f, fmt, hb]) => { const v = f(it); return `<div><span>${l}</span><b>${fmt(v, it)}</b>${compare && compare.kind === 'weapon' ? delta(v, f(compare), hb) : ''}</div>`; }).join('') + '</div>';
    if (it.affixes.length) body += `<ul class="afx">${it.affixes.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`;
  } else {
    body += `<div class="desc">${it.kind === 'medkit' ? 'Restores 50 HP over 1.4s. Hold [F] in the field.' : it.kind === 'ammo' ? 'Refills light, shell and heavy reserves.' : `Salvage ×${it.amount} — trade-in value.`}</div>`;
  }
  return `<div class="icard r${t}" style="--rc:${R.color}">
    ${opts.title ? `<div class="tag">${esc(opts.title)}</div>` : ''}
    <div class="hd">${iconHTML(it, 132, 50)}<div><div class="nm">${esc(it.name)}</div><div class="ty">${esc(itemType(it))}</div></div></div>
    ${body}
    ${it.value ? `<div class="ft"><span>Value</span><b>${it.value}</b>${opts.keys || ''}</div>` : opts.keys ? `<div class="ft">${opts.keys}</div>` : ''}
  </div>`;
}
