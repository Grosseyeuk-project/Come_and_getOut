#!/usr/bin/env node
// Objective audio checks (we can't listen): renders every synthesized sound through the real mix
// chain with OfflineAudioContext in headless Chromium and measures peak / RMS / spectral centroid /
// octave-band spectrum / duration / stereo balance. Fails on NaN, clipping, silence, non-distinct
// weapon spectra, broken panning/muffle/mute, page errors, or a mix-bus overload in a stress burst.
// Usage: node scripts/audio-test.mjs [--game]   (--game also boots dist/ with a live AudioContext
//        and plays a short firefight through window.__game to catch runtime errors in update()).
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = process.argv.includes('--game');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { Audio } from '/src/audio/audio.js';
window.Audio_ = Audio;
window.ready = true;
</script>`;
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/test.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
  const base = p.startsWith('/dist/') ? root : join(root);
  if (p.startsWith('/game/')) p = '/dist/' + p.slice(6);
  const f = join(base, p);
  if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const { chromium } = require('playwright');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('[page:error]', m.text()); } });
page.on('pageerror', (e) => { errors.push(String(e)); console.log('[pageerror]', e); });
await page.goto(`http://localhost:${port}/test.html`);
await page.waitForFunction(() => window.ready, null, { timeout: 30000 });

const results = await page.evaluate(async () => {
  const SR = 48000, T0 = 0.15; // the master dynamics chain needs ~100 ms to settle after creation: start sounds after it
  // ---------- analysis
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
  }
  function analyze(buf, from = 0, to = buf.length) {
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    let peak = 0, nan = 0, eL = 0, eR = 0;
    for (let i = from; i < to; i++) { const a = L[i], b = R[i]; if (!Number.isFinite(a) || !Number.isFinite(b)) { nan++; continue; } peak = Math.max(peak, Math.abs(a), Math.abs(b)); eL += a * a; eR += b * b; }
    // 10 ms RMS envelope -> active duration (until last point above -50 dB re peak window)
    const W = 480; let maxW = 0; const env = [];
    for (let i = from; i + W <= to; i += W) { let s = 0; for (let k = 0; k < W; k++) { const m = (L[i + k] + R[i + k]) / 2; s += m * m; } const r = Math.sqrt(s / W); env.push(r); maxW = Math.max(maxW, r); }
    let last = 0; for (let k = 0; k < env.length; k++) if (env[k] > maxW * 0.00316) last = k;
    const dur = (last + 1) * W / SR;
    const n = Math.max(W, Math.min(to - from, Math.floor((last + 1) * W)));
    const rms = Math.sqrt((eL + eR) / 2 / n);
    // average magnitude spectrum over active part (4096-pt Hann frames, 50% hop)
    const N = 4096, mag = new Float64Array(N / 2); let frames = 0;
    for (let s = from; s + N <= from + Math.max(n, N) && s + N <= to; s += N / 2) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let k = 0; k < N; k++) re[k] = ((L[s + k] + R[s + k]) / 2) * (0.5 - 0.5 * Math.cos(2 * Math.PI * k / (N - 1)));
      fft(re, im); for (let k = 0; k < N / 2; k++) mag[k] += Math.hypot(re[k], im[k]); frames++;
    }
    let num = 0, den = 0; for (let k = 1; k < N / 2; k++) { const f = k * SR / N; num += f * mag[k]; den += mag[k]; }
    const centroid = den ? num / den : 0;
    const edges = [20, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, 24000], bands = [];
    for (let b = 0; b < edges.length - 1; b++) { let e = 0; for (let k = 1; k < N / 2; k++) { const f = k * SR / N; if (f >= edges[b] && f < edges[b + 1]) e += mag[k] * mag[k]; } bands.push(e); }
    const tot = bands.reduce((a, b) => a + b, 0) || 1;
    return { peak, rms, nan, dur, centroid, bands: bands.map((e) => e / tot), balance: eR / (eL + eR || 1) };
  }
  const P = { x: 0, z: 0 };
  const fakeGame = (over = {}) => ({ mode: 'playing', player: { pos: P, hp: 100, maxHp: 100, weapon: { base: 'rifle', reloadT: 0, stats: { mag: 30 }, mag: 30 }, dead: false }, enemies: { list: [] }, extractT: 0, ...over });
  async function render(sec, setup, opts = {}) {
    const ctx = new OfflineAudioContext(2, Math.floor(SR * sec), SR);
    const a = new window.Audio_({ context: ctx, ambience: opts.ambience ?? false, music: opts.music ?? false });
    a.game = opts.game ?? fakeGame(); a.setListener(0, 0);
    if (opts.frames) { // drive update() like the game loop via suspend/resume
      for (let t = 0.05; t < sec - 0.05; t += 0.05) ctx.suspend(t).then(() => { a.update(0.05, opts.fireDist ?? Infinity, a.game); opts.frames(a, ctx.currentTime); ctx.resume(); });
    }
    setup(a, ctx);
    const buf = await ctx.startRendering();
    return { buf, a };
  }
  const out = { sounds: {}, checks: [] };
  const check = (name, ok, info = '') => out.checks.push({ name, ok: !!ok, info });
  const one = async (label, name, pos, opts, sec = 2.5, game) => {
    const { buf } = await render(sec + T0, (a) => a.play(name, pos, { ...(opts || {}), delay: T0 }), { game });
    const r = analyze(buf, Math.floor(T0 * SR)); out.sounds[label] = r; return r;
  };
  // ---------- individual sounds
  const E = (type) => ({ x: 6, z: 2 });
  const enemyGame = (type, pos) => fakeGame({ enemies: { list: [{ type, pos, dead: false, alert: false }] } });
  const list = [
    ['rifle', 'rifle', P], ['smg', 'smg', P], ['shotgun', 'shotgun', P], ['dmr', 'dmr', P], ['enemyShot', 'enemyShot', { x: 8, z: 3 }],
    ['impact.concrete', 'impact', { x: 5, z: 5 }, { surface: 'concrete' }], ['impact.wood', 'impact', { x: 5, z: 5 }, { surface: 'wood' }],
    ['impact.ground', 'impact', { x: 5, z: 5 }, { surface: 'ground' }], ['impact.metal', 'impactMetal', { x: 5, z: 5 }],
    ['ricochet', 'ricochet', { x: 5, z: 5 }], ['casing', 'casing', P, { brass: true }],
    ['step', 'step', P], ['dodge', 'dodge', P], ['reload', 'reload', P], ['magIn', 'magIn', P], ['reloadEnd', 'reloadEnd', P], ['pump', 'pump', P], ['shellIn', 'shellIn', P], ['equip', 'equip', P], ['empty', 'empty', P],
    ['hurt', 'hurt', null], ['death', 'death', null, {}, 4.5], ['hitmarker', 'hitmarker', null], ['kill', 'kill', null],
    ['crate', 'crate', { x: 1, z: 1 }], ['drop.t0', 'drop', { x: 1, z: 1 }, { tier: 0 }], ['drop.t1', 'drop', { x: 1, z: 1 }, { tier: 1 }], ['drop.t2', 'drop', { x: 1, z: 1 }, { tier: 2 }], ['drop.t3', 'drop', { x: 1, z: 1 }, { tier: 3 }],
    ['legendary', 'legendary', null, {}, 5], ['pickup.t0', 'pickup', null, { tier: 0 }], ['pickup.t4', 'pickup', null, { tier: 4 }],
    ['ui', 'ui', null], ['beep', 'beep', null, { f: 880 }], ['extracted', 'extracted', null, {}, 5.5], ['boom', 'boom', { x: 10, z: 0 }, {}, 3.5], ['slam', 'slam', { x: 3, z: 0 }, {}, 3], ['swing', 'swing', { x: 2, z: 0 }],
  ];
  for (const [label, name, pos, opts, sec] of list) await one(label, name, pos, opts, sec);
  for (const ty of ['raider', 'mutant', 'brute']) {
    const pos = { x: 6, z: 2 }, gm = enemyGame(ty, pos);
    await one(`bark.${ty}`, 'bark', pos, { kind: 'alert' }, 2.5, gm);
    await one(`idle.${ty}`, 'bark', pos, { kind: 'idle' }, 2.5, gm);
    await one(`flesh.${ty}`, 'flesh', pos, {}, 1.5, gm);
    await one(`hurt.${ty}`, 'enemyHurt', pos, {}, 1.5, gm);
    await one(`die.${ty}`, 'die', pos, {}, 3, gm);
  }
  for (const [k, r] of Object.entries(out.sounds)) {
    check(`${k}: finite`, r.nan === 0, `nan=${r.nan}`);
    check(`${k}: no clip`, r.peak < 0.99, `peak=${r.peak.toFixed(3)}`);
    check(`${k}: audible`, r.peak > 0.01 && r.rms > 0.0015, `peak=${r.peak.toFixed(3)} rms=${r.rms.toFixed(4)}`);
  }
  // ---------- weapon distinctness: octave-band spectra (cosine distance in dB) + centroid + duration
  const W = ['rifle', 'smg', 'shotgun', 'dmr', 'enemyShot'];
  const vec = (r) => r.bands.map((e) => 10 * Math.log10(e + 1e-6));
  const cosd = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return 1 - d / Math.sqrt(na * nb); };
  const bandDiff = (a, b) => { let m = 0; const va = vec(a), vb = vec(b); for (let i = 1; i < va.length - 1; i++) m = Math.max(m, Math.abs(va[i] - vb[i])); return m; };
  for (let i = 0; i < W.length; i++) for (let j = i + 1; j < W.length; j++) {
    const a = out.sounds[W[i]], b = out.sounds[W[j]], bd = bandDiff(a, b), cd = Math.abs(a.centroid - b.centroid) / Math.max(a.centroid, b.centroid), dd = Math.abs(a.dur - b.dur) / Math.max(a.dur, b.dur);
    check(`distinct ${W[i]} vs ${W[j]}`, bd > 3 && (cd > 0.08 || dd > 0.15), `maxBandDiff=${bd.toFixed(1)}dB centroidΔ=${(cd * 100).toFixed(0)}% durΔ=${(dd * 100).toFixed(0)}%`);
  }
  check('shotgun lowest centroid of player guns', ['rifle', 'smg', 'dmr'].every((k) => out.sounds.shotgun.centroid < out.sounds[k].centroid), W.map((k) => `${k}=${out.sounds[k].centroid.toFixed(0)}Hz`).join(' '));
  check('smg tail shorter than rifle; dmr/shotgun longest', out.sounds.smg.dur < out.sounds.rifle.dur && out.sounds.rifle.dur < out.sounds.dmr.dur && out.sounds.rifle.dur < out.sounds.shotgun.dur, W.map((k) => `${k}=${out.sounds[k].dur.toFixed(2)}s`).join(' '));
  check('legendary louder/longer than common drop', out.sounds.legendary.dur > out.sounds['drop.t0'].dur * 2 && out.sounds.legendary.rms > out.sounds['drop.t0'].rms, `leg ${out.sounds.legendary.dur.toFixed(2)}s vs ${out.sounds['drop.t0'].dur.toFixed(2)}s`);
  check('drop chimes brighten with rarity', out.sounds['drop.t3'].dur > out.sounds['drop.t0'].dur, [0, 1, 2, 3].map((t) => out.sounds['drop.t' + t].centroid.toFixed(0)).join('/'));
  const vb = ['raider', 'mutant', 'brute'].map((t) => out.sounds['bark.' + t].centroid);
  for (const [x, y] of [['raider', 'mutant'], ['raider', 'brute'], ['mutant', 'brute']]) {
    const a = out.sounds['bark.' + x], b = out.sounds['bark.' + y], cd = Math.abs(a.centroid - b.centroid) / Math.max(a.centroid, b.centroid);
    check(`faction barks distinct ${x} vs ${y}`, bandDiff(a, b) > 3 && cd > 0.1, `maxBandDiff=${bandDiff(a, b).toFixed(1)}dB centroidΔ=${(cd * 100).toFixed(0)}%`);
  }
  check('brute bark lowest', vb[2] < vb[0] && vb[2] < vb[1], vb.map((v) => v.toFixed(0)).join('/'));
  // ---------- variation: two renders of the same shot differ
  { const a = (await render(1, (x) => x.play('rifle', P, { delay: T0 }))).buf.getChannelData(0), b = (await render(1, (x) => x.play('rifle', P, { delay: T0 }))).buf.getChannelData(0);
    let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); check('per-shot random variation', d > 1, `L1=${d.toFixed(1)}`); }
  // ---------- panning: screen-right source is right-heavy; distance attenuates + darkens
  { const right = analyze((await render(1.5, (a) => a.play('impact', { x: 7, z: -7 }, { surface: 'wood', delay: T0 }))).buf);
    const left = analyze((await render(1.5, (a) => a.play('impact', { x: -7, z: 7 }, { surface: 'wood', delay: T0 }))).buf);
    check('pan follows screen x', right.balance > 0.6 && left.balance < 0.4, `R=${right.balance.toFixed(2)} L=${left.balance.toFixed(2)}`);
    const near = analyze((await render(2, (a) => a.play('enemyShot', { x: 3, z: 0 }, { delay: T0 }))).buf), far = analyze((await render(2, (a) => a.play('enemyShot', { x: 60, z: 0 }, { delay: T0 }))).buf);
    check('distance: quieter + darker', far.rms < near.rms * 0.5 && far.centroid < near.centroid, `rms ${near.rms.toFixed(3)}->${far.rms.toFixed(3)} centroid ${near.centroid.toFixed(0)}->${far.centroid.toFixed(0)}`); }
  // ---------- low-health muffle + heartbeat; mute
  { const lowG = fakeGame(); lowG.player.hp = 8;
    const hi = analyze((await render(2, (a) => a.ctx.suspend(0.52).then(() => { a.play('rifle', { x: 4, z: 0 }); a.ctx.resume(); }), { frames: () => {} })).buf);
    const lo = analyze((await render(2, (a) => a.ctx.suspend(0.52).then(() => { a.play('rifle', { x: 4, z: 0 }); a.ctx.resume(); }), { frames: () => {}, game: lowG })).buf);
    check('low-health muffle darkens SFX', lo.centroid < hi.centroid * 0.6, `centroid ${hi.centroid.toFixed(0)} -> ${lo.centroid.toFixed(0)}Hz`);
    const hb = analyze((await render(3, () => {}, { frames: () => {}, game: lowG })).buf);
    check('heartbeat audible at low hp', hb.rms > 0.003 && hb.centroid < 400, `rms=${hb.rms.toFixed(4)} centroid=${hb.centroid.toFixed(0)}`);
    const m = analyze((await render(1, (a) => { a.muted = true; a.master.gain.value = 0; a.play('shotgun', P, { delay: T0 }); })).buf);
    check('mute silences master', m.peak < 1e-4, `peak=${m.peak}`); }
  // ---------- stress: sustained autofire + shotgun + explosions + many impacts through the limiter
  { const { buf, a } = await render(5, (a) => {
      for (let i = 0; i < 45; i++) a.play('rifle', P, { delay: T0 + i * 0.097, minGap: 0 });
      for (let i = 0; i < 8; i++) a.play('shotgun', { x: 2, z: 1 }, { delay: 0.3 + i * 0.5, minGap: 0 });
      for (let i = 0; i < 4; i++) a.play('boom', { x: 4, z: 0 }, { delay: 0.5 + i * 1.1, minGap: 0 });
      for (let i = 0; i < 60; i++) { a.play('impact', { x: 6, z: i % 5 }, { delay: Math.random() * 4.5, surface: ['concrete', 'metal', 'wood'][i % 3], minGap: 0 }); a.play('flesh', { x: 5, z: 1 }, { delay: Math.random() * 4.5, minGap: 0 }); }
      for (let i = 0; i < 20; i++) a.play('enemyShot', { x: 9, z: -3 }, { delay: Math.random() * 4.5, minGap: 0 });
    });
    const r = analyze(buf); out.sounds.stress = r;
    check('stress: finite + below ceiling', r.nan === 0 && r.peak < 0.96, `peak=${r.peak.toFixed(3)} rms=${r.rms.toFixed(3)}`);
    check('stress: voice cap respected', a.voices.length <= a.maxVoices, `voices=${a.voices.length}`); }
  // ---------- ambience bed + music: rain, near fire, neon sign, extraction siren + dropship, combat ramp
  { const pos = { x: 6, z: 2 }, sign = { pos: { x: 3, y: 4, z: 1 }, flicker: true };
    const gm = fakeGame({ lighting: { p: { rain: 1 } }, fx: { fires: [{ x: -4, z: 1, s: 1 }] }, env: { signs: [sign] }, enemies: { list: [{ type: 'raider', pos, dead: false, alert: true }, { type: 'brute', pos: { x: -6, z: 3 }, dead: false, alert: true }] }, extraction: { x: 10, z: 10 }, extractT: 8, extractDur: 20 });
    let maxI = 0;
    const { buf, a } = await render(8, (a) => { for (let i = 0; i < 20; i++) a.play('rifle', P, { delay: 0.2 + i * 0.1, minGap: 0 }); }, { ambience: true, music: true, game: gm, frames: (a) => { maxI = Math.max(maxI, a.intensity); } });
    const r = analyze(buf); out.sounds.ambienceCombat = r;
    check('ambience+music: finite, no clip, audible', r.nan === 0 && r.peak < 0.96 && r.rms > 0.01, `peak=${r.peak.toFixed(3)} rms=${r.rms.toFixed(3)}`);
    check('combat raises music intensity', maxI > 0.7, `maxI=${maxI.toFixed(2)}`);
    const tail = analyze(buf, Math.floor(SR * 6), buf.length);
    check('bed keeps playing (rain/fire/neon/siren/ship)', tail.rms > 0.01, `rms(6-8s)=${tail.rms.toFixed(3)}`);
    const calm = fakeGame({ mode: 'playing' });
    const { a: a2 } = await render(6, () => {}, { ambience: true, music: true, game: calm, frames: (x) => { if (x.ctx.currentTime < 0.2) { x.intensity = 1; x.calmHold = 0; } } });
    check('music calms down after combat', a2.intensity < 0.9, `I=${a2.intensity.toFixed(2)} after 6s calm`);
    const title = analyze((await render(4, () => {}, { ambience: true, music: true, game: fakeGame({ mode: 'title' }), frames: () => {} })).buf);
    check('title bed audible but quiet', title.rms > 0.003 && title.rms < 0.2 && title.nan === 0, `rms=${title.rms.toFixed(4)}`); }
  return out;
});

let fail = 0;
console.log('\nsound               peak    rms     centroid  dur');
for (const [k, r] of Object.entries(results.sounds)) console.log(`${k.padEnd(18)} ${r.peak.toFixed(3)}  ${r.rms.toFixed(4)}  ${r.centroid.toFixed(0).padStart(6)}Hz  ${r.dur.toFixed(2)}s`);
console.log('');
for (const c of results.checks) { if (!c.ok) fail++; if (!c.ok || !/: (finite|no clip|audible)$/.test(c.name)) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.info}`); }
console.log(`\n${results.checks.length - fail}/${results.checks.length} checks passed`);

if (GAME) {
  if (!existsSync(join(root, 'dist', 'index.html'))) { console.log('[game] dist/ missing: run npm run build'); fail++; }
  else {
    const gp = await browser.newPage({ viewport: { width: 960, height: 540 } });
    gp.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('[game:error]', m.text()); } });
    gp.on('pageerror', (e) => { errors.push(String(e)); console.log('[game:pageerror]', e); });
    await gp.goto(`http://localhost:${port}/dist/index.html?seed=1337&q=low`);
    await gp.waitForFunction(() => window.__game && window.__game.state().ready, null, { timeout: 120000 });
    const st = await gp.evaluate(async () => {
      const G = window.__game, g = G.game; G.manual(true);
      g.audio.unlock(); G.start(1337);
      const p = g.player.pos; G.spawnEnemy('raider', p.x + 6, p.z + 3); G.spawnEnemy('mutant', p.x - 5, p.z + 4); G.spawnEnemy('brute', p.x + 7, p.z - 5);
      G.aimAt(p.x + 6, p.z + 3); g.input.mouse.down = true; G.advance(2); g.input.mouse.down = false;
      g.input.simKey('KeyR', true); G.advance(0.1); g.input.simKey('KeyR', false); G.advance(2.5);
      G.giveLoot('legendary'); G.giveLoot('epic'); G.advance(1.5); G.damagePlayer(80); G.advance(1); g.player.god = true;
      await new Promise((r) => setTimeout(r, 300));
      return { state: g.audio.ctx.state, voices: g.audio.voices.length, intensity: g.audio.intensity, heat: g.audio.heat };
    });
    console.log('[game]', JSON.stringify(st));
    if (st.intensity <= 0) { console.log('FAIL  game: combat did not raise intensity'); fail++; } else console.log('PASS  game: live firefight ran through audio.update without errors');
  }
}
if (errors.length) { console.log(`FAIL  ${errors.length} page errors`); fail++; }
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
