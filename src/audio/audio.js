// Fully synthesized WebAudio engine. No assets: weapons / explosions / reverbs / beds are rendered
// sample-by-sample at unlock (dsp.js); everything else is built live from oscillators, filtered noise,
// formant voices and modal (struck-object) partials.
//
// Graph:  voices -> [distance LP] -> panner -> sfx bus -> low-health muffle LP ------\
//                         \-> street reverb send (convolver) -> muffle             +-> mix -> master vol
//         ambience (ambience.js) -> duck -> muffle                                  |   -> glue comp -> limiter
//         music (music.js) -> duck ---------------------------------------------- /     -> soft clip -> out
//         ui / heartbeat ------------------------------------------------------- /
// Voice management: global cap + per-sound caps with oldest-voice stealing (quick fade), per-sound minGap.
// Panning follows on-screen x (camera right vector); attenuation + air absorption follow world distance.
// Keys: M = mute, - / = = master volume (persisted).
import { mulberry, GUNS, gunshot, explosion, impulse, whiteNoise, satCurve, driveCurve } from './dsp.js';
import { Ambience } from './ambience.js';
import { Music } from './music.js';

const BRUTE = [[320, 620, 1300], [420, 760, 1500]], SHRIEK = [[900, 2300, 3400], [700, 2700, 3800]];
const VOW = { a: [730, 1090, 2440], e: [530, 1840, 2480], i: [270, 2290, 3010], o: [570, 840, 2410], u: [300, 870, 2240], uh: [640, 1190, 2390], ae: [660, 1720, 2410] };
const CAPS = { rifle: 8, smg: 10, shotgun: 4, dmr: 4, enemyShot: 8, impact: 6, impactMetal: 5, flesh: 5, casing: 6, step: 3, enemyHurt: 3, die: 4, scream: 3, bark: 3, ricochet: 3, hitmarker: 2, kill: 3 };
const PRIO = { rifle: 3, smg: 3, shotgun: 4, dmr: 4, boom: 5, slam: 4, legendary: 5, death: 5, extracted: 5, die: 3, enemyShot: 2, flesh: 2, hurt: 4, casing: 0, step: 0, impact: 1, impactMetal: 1, ricochet: 1 };
const GUN_VOL = { rifle: 0.62, smg: 0.5, shotgun: 0.85, dmr: 0.8, enemyShot: 0.42 };
const GUN_VERB = { rifle: 0.35, smg: 0.28, shotgun: 0.45, dmr: 0.55, enemyShot: 0.4 };

let store = null; try { store = typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { store = null; }
const load = (k, d) => { try { const v = store && store.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const save = (k, v) => { try { store && store.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export class Audio {
  // opts.context: render into an existing (e.g. Offline) AudioContext — used by scripts/audio-test.mjs
  constructor(opts = {}) {
    this.ctx = null; this.enabled = true; this.listener = { x: 0, z: 0 }; this.lastPlay = {};
    this.voices = []; this.maxVoices = 48; this.game = null; this.heat = 0; this.intensity = 0; this.calmHold = 0;
    this.volume = load('cago.vol', 0.8); this.muted = load('cago.mute', false);
    this.alertSeen = new WeakSet(); this.idleT = 3; this.barkT = 0; this.scanT = 0; this.rl = null; this.nextBeat = 0;
    this.opts = opts;
    if (opts.context) this.init(opts.context);
    else if (typeof window !== 'undefined') {
      const gesture = () => { this.unlock(); };
      addEventListener('pointerdown', gesture, { passive: true }); addEventListener('keydown', gesture);
      addEventListener('keydown', (e) => {
        if (e.repeat || (e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) return;
        if (e.code === 'KeyM') this.setMuted(!this.muted);
        else if (e.code === 'Minus' || e.code === 'NumpadSubtract') this.setVolume(this.volume - 0.1);
        else if (e.code === 'Equal' || e.code === 'NumpadAdd') this.setVolume(this.volume + 0.1);
      });
    }
  }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume(); return; }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext); if (!AC) { this.enabled = false; return; }
    try { this.init(new AC({ latencyHint: 'interactive' })); } catch (e) { this.enabled = false; }
  }
  init(c) {
    this.ctx = c; const sr = c.sampleRate, rng = this.rng = mulberry(0xc0ffee);
    this.readyAt = c.currentTime + 0.12; // DynamicsCompressor gain settles over its first ~100 ms: hold one-shots until then
    const mk = (chs) => { const b = c.createBuffer(chs.length, chs[0].length, sr); chs.forEach((d, i) => b.copyToChannel ? b.copyToChannel(d, i) : b.getChannelData(i).set(d)); return b; };
    this.mkBuf = mk;
    this.noiseBuf = mk(whiteNoise(sr, rng, 2));
    this.guns = {}; for (const k in GUNS) { this.guns[k] = []; for (let v = 0; v < 4; v++) this.guns[k].push(mk(gunshot(sr, GUNS[k], rng))); }
    this.booms = [mk(explosion(sr, rng)), mk(explosion(sr, rng, 2.2))];
    // --- mix graph
    const G = (v = 1) => { const g = c.createGain(); g.gain.value = v; return g; };
    this.master = G(this.muted ? 0 : this.volume);
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 24; hp.Q.value = 0.6;
    const glue = this.glue = c.createDynamicsCompressor(); glue.threshold.value = -20; glue.knee.value = 8; glue.ratio.value = 3; glue.attack.value = 0.004; glue.release.value = 0.2;
    const lim = this.limiter = c.createDynamicsCompressor(); lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
    const clip = c.createWaveShaper(); clip.curve = satCurve(0.72, 0.94); clip.oversample = '2x';
    this.mix = G(1);
    this.mix.connect(this.master).connect(hp).connect(glue).connect(lim).connect(clip).connect(c.destination);
    this.muffle = c.createBiquadFilter(); this.muffle.type = 'lowpass'; this.muffle.frequency.value = 20000; this.muffle.Q.value = 0.9;
    this.muffle.connect(this.mix);
    this.sfx = G(1); this.sfx.connect(this.muffle);
    this.ui = G(0.9); this.ui.connect(this.mix);
    this.ambDuck = G(1); this.ambDuck.connect(this.muffle); this.amb = G(0.55); this.amb.connect(this.ambDuck);
    this.musDuck = G(1); this.musDuck.connect(this.mix); this.mus = G(0.42); this.mus.connect(this.musDuck);
    const verb = c.createConvolver(); verb.normalize = false; verb.buffer = mk(impulse(sr, rng, { len: 1.9, decay: 0.42, early: 14, bright: 6500, dark: 700 }));
    this.verbSend = G(0.55); this.verbSend.connect(verb).connect(this.muffle);
    const big = c.createConvolver(); big.normalize = false; big.buffer = mk(impulse(sr, rng, { len: 4.5, decay: 1.4, pre: 0.03, early: 6, bright: 3500, dark: 300, width: 1.3 }));
    this.bigSend = G(0.5); this.bigSend.connect(big).connect(this.ambDuck);
    this.musVerb = G(0.35); this.musVerb.connect(big); // music shares the big hall; returns via ambience duck as well
    this.ambience = this.opts.ambience === false ? null : new Ambience(this);
    this.music = this.opts.music === false ? null : new Music(this);
  }

  setVolume(v) { this.volume = clamp(Math.round(v * 10) / 10, 0, 1); save('cago.vol', this.volume); if (this.muted) this.setMuted(false); else this.applyMaster(); this.notice(`Volume ${Math.round(this.volume * 100)}%`); }
  setMuted(m) { this.muted = m; save('cago.mute', m); this.applyMaster(); this.notice(m ? 'Sound muted [M]' : `Sound on · ${Math.round(this.volume * 100)}%`); }
  applyMaster() { if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.03); }
  notice(msg) { const h = this.game && this.game.hud; if (h && h.toast) h.toast(msg, '#c8c8c0'); }
  setListener(x, z) { this.listener.x = x; this.listener.z = z; }

  // ------------------------------------------------------------------ spatial voices
  spatial(pos) {
    const dx = pos.x - this.listener.x, dz = pos.z - this.listener.z, dist = Math.hypot(dx, dz);
    let rx = 0.7071, rz = -0.7071;
    const cam = this.game && this.game.renderer && this.game.renderer.camera;
    if (cam && cam.matrixWorld) { const e = cam.matrixWorld.elements, l = Math.hypot(e[0], e[2]) || 1; rx = e[0] / l; rz = e[2] / l; }
    const pan = clamp((dx * rx + dz * rz) / 15, -0.85, 0.85);
    const att = 1 / (1 + 0.03 * dist + 0.0022 * dist * dist);
    return { dist, pan, att };
  }
  // returns the voice's input node (or null if the voice limiter refused it)
  voice(name, pos, vol, { verb = 0.25, dur = 1, ui = false, pan = null, lp = null, big = 0, t = null } = {}) {
    const c = this.ctx, now = c.currentTime;
    if (!this.alloc(name, dur, now)) return null;
    const g = c.createGain();
    let att = 1, p = pan ?? 0, dist = 0;
    if (pos) { const sp = this.spatial(pos); att = sp.att; dist = sp.dist; if (pan == null) p = sp.pan; }
    g.gain.value = vol * att;
    let node = g;
    const cut = lp ?? (dist > 10 ? clamp(20000 * Math.exp(-(dist - 10) / 45), 700, 20000) : 0);
    if (cut) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cut; f.Q.value = 0.5; node.connect(f); node = f; }
    const pn = c.createStereoPanner(); pn.pan.value = p; node.connect(pn).connect(ui ? this.ui : this.sfx);
    if (verb > 0) { const s = c.createGain(); s.gain.value = verb * (pos ? 0.8 + Math.min(1.6, dist / 20) : 1); node.connect(s).connect(this.verbSend); }
    if (big > 0) { const s = c.createGain(); s.gain.value = big; node.connect(s).connect(this.bigSend); }
    this.voices.push({ name, end: (t ?? now) + dur, prio: PRIO[name] ?? 1, g, start: now });
    return g;
  }
  alloc(name, dur, now) {
    const v = this.voices;
    for (let i = v.length - 1; i >= 0; i--) if (v[i].end < now) v.splice(i, 1);
    const cap = CAPS[name] ?? 5, same = v.filter((x) => x.name === name);
    if (same.length >= cap) this.steal(same[0]);
    if (v.length >= this.maxVoices) {
      const pr = PRIO[name] ?? 1; let w = null;
      for (const x of v) if (x.prio <= pr && (!w || x.prio < w.prio || (x.prio === w.prio && x.start < w.start))) w = x;
      if (!w) return false; this.steal(w);
    }
    return true;
  }
  steal(x) { const t = this.ctx.currentTime; try { x.g.gain.cancelScheduledValues(t); x.g.gain.setValueAtTime(x.g.gain.value, t); x.g.gain.linearRampToValueAtTime(0, t + 0.03); } catch (e) { /* already stopped */ } x.end = 0; const i = this.voices.indexOf(x); if (i >= 0) this.voices.splice(i, 1); }

  // ------------------------------------------------------------------ synthesis primitives
  N(dst, t, dur, { type = 'bandpass', f0 = 1000, f1 = f0, q = 1, a = 0.001, vol = 1, rate = 1 } = {}) {
    const c = this.ctx, s = c.createBufferSource(); s.buffer = this.noiseBuf; s.playbackRate.value = rate;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t); if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + a); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    s.connect(f).connect(g).connect(dst); s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
    return f;
  }
  O(dst, t, dur, { type = 'sine', f0 = 100, f1 = f0, vol = 1, a = 0.002, curve = 'exp' } = {}) {
    const c = this.ctx, o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) curve === 'exp' ? o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur) : o.frequency.linearRampToValueAtTime(f1, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + a); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(dst); o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  // struck object: inharmonic partials with individual decays (metal, brass, glass, bells)
  M(dst, t, freqs, { decay = 0.2, vol = 0.3, tilt = 0.7, type = 'sine' } = {}) {
    freqs.forEach((f, i) => this.O(dst, t, decay * Math.pow(0.75, i) * rnd(0.8, 1.2), { type, f0: f, f1: f * 0.997, vol: vol * Math.pow(tilt, i), a: 0.0008 }));
  }
  B(dst, t, buf, { rate = 1, vol = 1 } = {}) {
    const c = this.ctx, s = c.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    const g = c.createGain(); g.gain.value = vol; s.connect(g).connect(dst); s.start(t); return s;
  }
  // formant voice: saw source(s) with pitch contour, vibrato, roughness AM, breath noise and a
  // parallel band-pass formant bank gliding between two vowels.
  vox(dst, t, { pts = [[0, 150]], dur = 0.3, v0 = VOW.a, v1 = v0, q = 8, vib = [5, 3], rough = 0, roughF = 28, breath = 0.15, drive = 0, sub = 0, voices = 1, detune = 12, a = 0.02, vol = 0.6, ring = 0, lp = 0, fg = [1, 0.55, 0.3] } = {}) {
    const c = this.ctx, S = c.createGain(); S.gain.value = 1;
    const env = c.createGain(); env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(vol, t + a); env.gain.setValueAtTime(vol, t + dur * 0.55); env.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    const end = t + dur + 0.05, oscs = [];
    const contour = (o, k) => { o.frequency.setValueAtTime(pts[0][1] * k, t); for (const [pt, f] of pts.slice(1)) o.frequency.linearRampToValueAtTime(f * k, t + pt * dur); };
    const lfo = c.createOscillator(); lfo.frequency.value = vib[0] * rnd(0.85, 1.15); const lg = c.createGain(); lg.gain.value = vib[1]; lfo.connect(lg); oscs.push(lfo);
    for (let v = 0; v < voices; v++) {
      const o = c.createOscillator(); o.type = 'sawtooth'; contour(o, 1); o.detune.value = (v - (voices - 1) / 2) * detune; lg.connect(o.frequency); o.connect(S); oscs.push(o);
    }
    if (sub) { const o = c.createOscillator(); o.type = 'sawtooth'; contour(o, 0.5); const sg = c.createGain(); sg.gain.value = sub; o.connect(sg).connect(S); oscs.push(o); }
    let src = S;
    if (ring) { const r = c.createGain(); r.gain.value = 0; const ro = c.createOscillator(); ro.frequency.value = ring; ro.connect(r.gain); S.connect(r); const mixr = c.createGain(); S.connect(mixr); r.connect(mixr); src = mixr; oscs.push(ro); }
    if (rough) { const am = c.createGain(); am.gain.value = 1 - rough / 2; const ro = c.createOscillator(); ro.type = 'square'; ro.frequency.value = roughF * rnd(0.9, 1.1); const rg = c.createGain(); rg.gain.value = rough / 2; ro.connect(rg).connect(am.gain); src.connect(am); src = am; oscs.push(ro); }
    if (breath) { const n = c.createBufferSource(); n.buffer = this.noiseBuf; const hf = c.createBiquadFilter(); hf.type = 'highpass'; hf.frequency.value = 1200; const bg = c.createGain(); bg.gain.value = breath * 1.3; n.connect(hf).connect(bg).connect(src); n.start(t, Math.random()); n.stop(end); }
    if (drive) { const ws = c.createWaveShaper(); ws.curve = driveCurve(drive); const pre = c.createGain(); pre.gain.value = 0.6; src.connect(pre).connect(ws); src = ws; }
    const fq = [q, q * 1.3, q * 1.6];
    for (let k = 0; k < 3; k++) {
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = fq[k]; f.frequency.setValueAtTime(v0[k], t); f.frequency.linearRampToValueAtTime(v1[k], t + dur * 0.8);
      const g = c.createGain(); g.gain.value = fg[k] * 0.45; src.connect(f).connect(g).connect(env);
    }
    const body = c.createBiquadFilter(); body.type = 'lowpass'; body.frequency.value = 700; const bg = c.createGain(); bg.gain.value = 0.08; src.connect(body).connect(bg).connect(env);
    if (lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; f.Q.value = 0.7; env.connect(f).connect(dst); } else env.connect(dst);
    for (const o of oscs) { o.start(t); o.stop(end); }
  }
  // gritty helmet-radio chain for raider callouts
  radio(dst) {
    const c = this.ctx, h = c.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = 420;
    const l = c.createBiquadFilter(); l.type = 'lowpass'; l.frequency.value = 3200; const ws = c.createWaveShaper(); ws.curve = driveCurve(3.5);
    h.connect(l).connect(ws).connect(dst); return h;
  }

  // ------------------------------------------------------------------ helpers over game state
  typeAt(pos) {
    const g = this.game; if (!g || !pos) return null;
    if (g.player && pos === g.player.pos) return 'player';
    if (g.enemies) for (const e of g.enemies.list) if (e.pos === pos) return e.type;
    return null;
  }
  isPlayer(pos) { const g = this.game; return !!(pos && g && g.player && (pos === g.player.pos || Math.hypot(pos.x - g.player.pos.x, pos.z - g.player.pos.z) < 0.3)); }
  near(pos, r) { return !pos || Math.hypot(pos.x - this.listener.x, pos.z - this.listener.z) < r; }
  duck(amount = 0.35, rel = 0.9) {
    const t = this.ctx.currentTime;
    for (const g of [this.ambDuck.gain, this.musDuck.gain]) { g.cancelScheduledValues(t); g.setTargetAtTime(amount, t, 0.012); g.setTargetAtTime(1, t + 0.12, rel / 3); }
  }

  // ------------------------------------------------------------------ public: one-shots
  play(name, pos = null, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const t = Math.max(this.readyAt, this.ctx.currentTime + (opts.delay || 0));
    const lp = this.lastPlay[name] ?? -1; if (t - lp < (opts.minGap ?? 0.025)) return; this.lastPlay[name] = t;
    const v = opts.vol ?? 1, p = opts.pitch ?? rnd(0.95, 1.05);
    const fn = this.S[name]; if (fn) fn.call(this, t, pos, v, p, opts);
  }

  gun(name, t, pos, v, opts) {
    const bufs = this.guns[name === 'enemyShot' ? 'enemy' : name], b = pick(bufs), player = this.isPlayer(pos);
    const o = this.voice(opts.distant ? 'amb' : name, pos, GUN_VOL[name] * v * rnd(0.88, 1.05), { verb: GUN_VERB[name] * (opts.verbMul ?? 1), dur: b.duration, lp: opts.lp ?? null, big: opts.big ?? 0, pan: opts.pan ?? null, t });
    if (!o) return;
    this.B(o, t, b, { rate: rnd(0.965, 1.035) * (opts.rate ?? 1) });
    if (opts.distant) return;
    if (this.near(pos, 40)) this.heat = Math.min(1.5, this.heat + (player ? 0.06 : 0.1));
    if (player) {
      if (name === 'shotgun' || name === 'dmr') this.duck(name === 'shotgun' ? 0.55 : 0.7, 0.5);
      if (name !== 'shotgun') this.S.casing.call(this, t + rnd(0.32, 0.5), pos, 0.55, 1, { brass: true, heavy: name === 'dmr' });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Sound table: (t, pos, vol, pitch, opts). `this` is the Audio instance.
const S = Audio.prototype.S = {
  rifle(t, pos, v, p, o) { this.gun('rifle', t, pos, v, o); },
  smg(t, pos, v, p, o) { this.gun('smg', t, pos, v, o); },
  shotgun(t, pos, v, p, o) { this.gun('shotgun', t, pos, v, o); },
  dmr(t, pos, v, p, o) { this.gun('dmr', t, pos, v, o); },
  enemyShot(t, pos, v, p, o) { this.gun('enemyShot', t, pos, v, o); },

  casing(t, pos, v, p, o) {
    const out = this.voice('casing', pos, 0.22 * v, { verb: 0.08, dur: 0.5, t }); if (!out) return;
    if (o.brass === false || o.shell) { // shotgun hull: dull plastic/brass-base clack
      for (let k = 0; k < 3; k++) { const tk = t + [0, 0.11, 0.18][k]; this.M(out, tk, [rnd(1100, 1500), rnd(2300, 2900)], { decay: 0.05, vol: 0.5 * Math.pow(0.5, k) }); this.N(out, tk, 0.03, { type: 'bandpass', f0: 1800, q: 2, vol: 0.5 * Math.pow(0.5, k) }); }
      return;
    }
    const f = (o.heavy ? 3400 : 4600) * rnd(0.9, 1.12);
    for (let k = 0; k < 3; k++) { const tk = t + [0, 0.085, 0.14][k] * rnd(0.85, 1.15); this.M(out, tk, [f * rnd(0.97, 1.03), f * 1.58, f * 2.31, f * 0.62], { decay: 0.09 * Math.pow(0.7, k), vol: 0.32 * Math.pow(0.55, k), tilt: 0.6 }); }
  },

  // ---- impacts per surface (+ ricochets)
  impact(t, pos, v, p, o) {
    const surf = o.surface || 'concrete';
    const out = this.voice('impact', pos, 0.32 * v, { verb: 0.22, dur: 0.6, t }); if (!out) return;
    if (surf === 'metal') return S.impactMetal.call(this, t, pos, v, p, { ...o, out });
    if (surf === 'wood') {
      this.N(out, t, 0.09, { type: 'bandpass', f0: 420 * p, f1: 300, q: 4, vol: 1.6 });
      this.O(out, t, 0.07, { f0: 210 * p, f1: 150, vol: 0.7 });
      this.N(out, t, 0.04, { type: 'highpass', f0: 3200, vol: 0.5 });
      for (let k = 0; k < 3; k++) this.N(out, t + 0.03 + Math.random() * 0.12, 0.02, { type: 'bandpass', f0: rnd(1800, 3500), q: 3, vol: 0.25 });
    } else if (surf === 'ground') {
      this.N(out, t, 0.08, { type: 'lowpass', f0: 500 * p, f1: 150, vol: 1.1 });
      this.N(out, t + 0.004, 0.18, { type: 'bandpass', f0: 2400, f1: 1400, q: 0.8, vol: 0.45, a: 0.02 });
    } else { // concrete / masonry: sharp crack + chip + debris trickle
      this.N(out, t, 0.02, { type: 'highpass', f0: 2600 * p, vol: 0.6 });
      this.N(out, t, 0.08, { type: 'bandpass', f0: 1300 * p, f1: 700, q: 1.5, vol: 1.6 });
      this.O(out, t, 0.04, { f0: 260, f1: 120, vol: 0.4 });
      for (let k = 0; k < 4; k++) this.N(out, t + 0.04 + Math.random() * 0.25, 0.015, { type: 'bandpass', f0: rnd(2500, 6000), q: 4, vol: rnd(0.1, 0.3) });
      if (Math.random() < 0.18) S.ricochet.call(this, t + 0.01, pos, v * 0.7, p, o);
    }
  },
  impactMetal(t, pos, v, p, o) {
    const out = o.out || this.voice('impactMetal', pos, 0.3 * v, { verb: 0.3, dur: 0.8, t }); if (!out) return;
    const f = rnd(850, 1700) * p;
    this.N(out, t, 0.02, { type: 'highpass', f0: 4000, vol: 1 });
    this.M(out, t, [f, f * 1.47, f * 2.09, f * 2.56, f * 3.37], { decay: 0.45, vol: 0.32, tilt: 0.75, type: 'triangle' });
    this.O(out, t, 0.06, { f0: 180, f1: 90, vol: 0.5 });
    if (Math.random() < 0.35) S.ricochet.call(this, t + 0.015, pos, v, p, o);
  },
  ricochet(t, pos, v, p) {
    const out = this.voice('ricochet', pos, 0.16 * v, { verb: 0.4, dur: 0.6, t }); if (!out) return;
    const c = this.ctx, osc = c.createOscillator(), f0 = rnd(3200, 5200);
    osc.frequency.setValueAtTime(f0, t); osc.frequency.exponentialRampToValueAtTime(f0 * rnd(0.35, 0.5), t + 0.45);
    const lfo = c.createOscillator(); lfo.frequency.value = rnd(30, 60); const lg = c.createGain(); lg.gain.value = f0 * 0.03; lfo.connect(lg).connect(osc.frequency);
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.5);
    const pan = c.createStereoPanner(); const s = Math.random() < 0.5 ? -1 : 1; pan.pan.setValueAtTime(-0.3 * s, t); pan.pan.linearRampToValueAtTime(0.7 * s, t + 0.45);
    osc.connect(g).connect(pan).connect(out); osc.start(t); lfo.start(t); osc.stop(t + 0.55); lfo.stop(t + 0.55);
    this.N(out, t, 0.3, { type: 'bandpass', f0: f0 * 0.8, f1: f0 * 0.4, q: 6, vol: 0.25 });
  },

  // ---- bodies
  flesh(t, pos, v, p, o) {
    const ty = this.typeAt(pos);
    const out = this.voice('flesh', pos, 0.42 * v, { verb: 0.08, dur: 0.4, t }); if (!out) return;
    const wet = ty === 'mutant' ? 1.6 : 1, heavy = ty === 'brute' ? 0.7 : 1;
    this.O(out, t, 0.06, { f0: 140 * heavy * p, f1: 55, vol: 0.9 });
    this.N(out, t, 0.09, { type: 'lowpass', f0: 1100 * p, f1: 220, vol: 1.2 });
    // wet squelch: amplitude-modulated band of noise
    const c = this.ctx, am = c.createGain(); am.gain.value = 0.5; const lfo = c.createOscillator(); lfo.frequency.value = rnd(35, 70); const lg = c.createGain(); lg.gain.value = 0.5; lfo.connect(lg).connect(am.gain); lfo.start(t); lfo.stop(t + 0.25);
    am.connect(out); this.N(am, t + 0.008, 0.16 * wet, { type: 'bandpass', f0: (ty === 'mutant' ? 700 : 1300) * p, f1: 450, q: 2.5, vol: 0.9 * wet, a: 0.01 });
    if (ty === 'brute' && Math.random() < 0.5) this.M(out, t, [rnd(700, 1100), 1650], { decay: 0.12, vol: 0.18, type: 'triangle' }); // armour plate
    else if (Math.random() < 0.25) { this.N(out, t + 0.01, 0.02, { type: 'highpass', f0: 2500, vol: 0.6 }); } // bone snap
  },
  hitmarker(t, pos, v) {
    const out = this.voice('hitmarker', null, 0.3 * v, { verb: 0, dur: 0.08, ui: true, t }); if (!out) return;
    this.N(out, t, 0.018, { type: 'bandpass', f0: 3400, q: 3, vol: 1 });
    this.O(out, t, 0.04, { type: 'triangle', f0: 2100, f1: 1900, vol: 0.35 });
  },
  kill(t, pos, v) {
    const out = this.voice('kill', null, 0.2 * v, { verb: 0.15, dur: 0.4, ui: true, t }); if (!out) return;
    this.O(out, t, 0.09, { f0: 110, f1: 48, vol: 1 });
    this.N(out, t, 0.03, { type: 'bandpass', f0: 2600, q: 2, vol: 0.6 });
    this.O(out, t + 0.03, 0.18, { type: 'triangle', f0: 1320, f1: 1310, vol: 0.18 });
    this.O(out, t + 0.03, 0.22, { type: 'sine', f0: 1980, vol: 0.08 });
  },
  enemyHurt(t, pos, v, p) {
    const ty = this.typeAt(pos) || 'raider';
    const out = this.voice('enemyHurt', pos, 0.35 * v, { verb: 0.15, dur: 0.5, t }); if (!out) return;
    if (ty === 'mutant') this.vox(out, t, { pts: [[0, 520 * p], [0.3, 760 * p], [1, 420 * p]], dur: 0.28, v0: SHRIEK[0], v1: SHRIEK[1], fg: [0.5, 1, 0.7], q: 6, vib: [24, 40], rough: 0.5, roughF: 40, breath: 0.35, voices: 2, detune: 30, vol: 0.7, ring: 130 });
    else if (ty === 'brute') this.vox(out, t, { pts: [[0, 90 * p], [0.3, 110 * p], [1, 70 * p]], dur: 0.4, v0: BRUTE[0], v1: BRUTE[1], q: 5, rough: 0.7, roughF: 24, breath: 0.15, sub: 0.6, drive: 3, vol: 0.9, lp: 1400 });
    else this.vox(out, t, { pts: [[0, 150 * p], [0.25, 175 * p], [1, 105 * p]], dur: 0.22, v0: VOW.uh, v1: VOW.u, q: 7, rough: 0.25, breath: 0.25, drive: 1.5, vol: 0.9 });
  },
  die(t, pos, v, p) {
    const ty = this.typeAt(pos) || 'raider';
    const out = this.voice('die', pos, 0.5 * v, { verb: 0.3, dur: 2, t }); if (!out) return;
    if (ty === 'mutant') {
      this.vox(out, t, { pts: [[0, 640 * p], [0.15, 880 * p], [1, 160 * p]], dur: 0.85, v0: SHRIEK[1], v1: VOW.uh, fg: [0.5, 1, 0.6], q: 6, vib: [22, 60], rough: 0.6, roughF: 34, breath: 0.4, voices: 3, detune: 35, vol: 0.65, ring: 110 });
      const c = this.ctx, am = c.createGain(); am.gain.value = 0.4; const l = c.createOscillator(); l.type = 'square'; l.frequency.value = 13; const lg = c.createGain(); lg.gain.value = 0.4; l.connect(lg).connect(am.gain); l.start(t + 0.4); l.stop(t + 1.2); am.connect(out);
      this.N(am, t + 0.4, 0.7, { type: 'bandpass', f0: 500, f1: 260, q: 4, vol: 0.9, a: 0.05 }); // gurgle
    } else if (ty === 'brute') {
      this.vox(out, t, { pts: [[0, 95 * p], [0.2, 120 * p], [1, 45 * p]], dur: 1.3, v0: BRUTE[1], v1: BRUTE[0], q: 5, rough: 0.8, roughF: 20, breath: 0.2, sub: 0.8, drive: 4, voices: 2, detune: 18, vol: 0.95, lp: 1500 });
      this.B(out, t + 0.75, this.booms[1], { rate: 1.6, vol: 0.5 }); // body slam
      this.N(out, t + 0.75, 0.4, { type: 'lowpass', f0: 600, f1: 80, vol: 1.2 });
      this.duck(0.6, 0.6);
    } else {
      this.vox(out, t, { pts: [[0, 165 * p], [0.15, 185 * p], [1, 85 * p]], dur: 0.65, v0: VOW.a, v1: VOW.uh, q: 7, rough: 0.35, breath: 0.3, drive: 1.6, vol: 0.55 });
    }
    // body + gear hitting the ground
    if (ty !== 'brute') { this.N(out, t + 0.48, 0.18, { type: 'lowpass', f0: 500, f1: 120, vol: 1.1 }); this.O(out, t + 0.48, 0.1, { f0: 90, f1: 50, vol: 0.6 }); if (ty === 'raider') this.M(out, t + 0.52, [rnd(1400, 2000), 2900], { decay: 0.1, vol: 0.12, type: 'triangle' }); }
  },

  // ---- faction barks
  scream(t, pos, v, p) { S.bark.call(this, t, pos, v, p, { type: 'mutant' }); },
  bark(t, pos, v, p, o) {
    const ty = o.type || this.typeAt(pos) || 'raider', kind = o.kind || 'alert';
    const out = this.voice('bark', pos, 0.5 * v, { verb: 0.45, dur: 1.6, t }); if (!out) return;
    if (ty === 'mutant') {
      if (kind === 'idle') { // insect-like chitter + throat gurgle
        const n = 6 + (Math.random() * 6 | 0);
        for (let k = 0; k < n; k++) this.N(out, t + k * rnd(0.035, 0.055), 0.025, { type: 'bandpass', f0: rnd(1600, 3200), q: 6, vol: 0.5 });
        this.vox(out, t, { pts: [[0, 210 * p], [1, 160 * p]], dur: 0.5, v0: VOW.u, v1: VOW.o, rough: 0.8, roughF: 18, breath: 0.4, vol: 0.25 });
        return;
      }
      this.vox(out, t, { pts: [[0, 420 * p], [0.3, 720 * p], [0.7, 610 * p], [1, 330 * p]], dur: 0.75, v0: SHRIEK[0], v1: SHRIEK[1], fg: [0.5, 1, 0.8], q: 6, vib: [28, 45], rough: 0.45, roughF: 36, breath: 0.35, voices: 3, detune: 28, vol: 0.7, ring: 145 });
    } else if (ty === 'brute') {
      if (kind === 'idle') { // heavy breathing
        for (let k = 0; k < 2; k++) this.N(out, t + k * 0.7, 0.6, { type: 'bandpass', f0: k ? 380 : 520, f1: k ? 260 : 380, q: 1.5, vol: 0.7, a: 0.25 });
        this.vox(out, t + 0.7, { pts: [[0, 62], [1, 55]], dur: 0.6, v0: BRUTE[0], rough: 0.9, roughF: 16, breath: 0.2, sub: 0.6, vol: 0.3, a: 0.2, lp: 1200 });
        return;
      }
      this.vox(out, t, { pts: [[0, 70 * p], [0.25, 98 * p], [0.75, 88 * p], [1, 55 * p]], dur: 1.25, v0: BRUTE[0], v1: BRUTE[1], q: 4, rough: 0.8, roughF: 22, breath: 0.2, sub: 1, drive: 4.5, voices: 2, detune: 22, vol: 0.95, a: 0.06, lp: 1500 });
      this.O(out, t, 1.1, { f0: 42, f1: 34, vol: 0.5, a: 0.08 });
    } else { // raider: helmet-radio shouts — syllables of formant gibberish + squelch
      const r = this.radio(out);
      this.N(r, t, 0.04, { type: 'highpass', f0: 2500, vol: 0.5 });
      const n = kind === 'idle' ? 3 + (Math.random() * 4 | 0) : 1 + (Math.random() * 3 | 0);
      let tt = t + 0.05; const base = (kind === 'idle' ? 125 : 165) * p;
      for (let k = 0; k < n; k++) {
        const d = rnd(0.1, 0.22), va = pick(['a', 'e', 'o', 'uh', 'ae']), vb = pick(['a', 'e', 'i', 'o', 'u']);
        const up = kind === 'idle' ? rnd(0.95, 1.08) : rnd(1.1, 1.3);
        this.vox(r, tt, { pts: [[0, base * rnd(0.9, 1.05)], [0.3, base * up], [1, base * rnd(0.75, 0.9)]], dur: d, v0: VOW[va], v1: VOW[vb], q: 7, rough: 0.2, breath: 0.2, drive: kind === 'idle' ? 1 : 2.4, vol: kind === 'idle' ? 0.35 : 0.7, a: 0.015 });
        tt += d + rnd(0.03, 0.09);
      }
      this.N(r, tt, 0.06, { type: 'highpass', f0: 2000, vol: 0.4 }); // release squelch
    }
  },
  slam(t, pos, v) {
    const out = this.voice('slam', pos, 0.95 * v, { verb: 0.5, dur: 2, t }); if (!out) return;
    this.B(out, t, this.booms[1], { rate: 1.25, vol: 0.9 });
    for (let k = 0; k < 6; k++) this.N(out, t + 0.05 + Math.random() * 0.4, 0.04, { type: 'bandpass', f0: rnd(900, 3000), q: 3, vol: 0.3 });
    if (this.near(pos, 14)) this.duck(0.4, 0.8);
  },
  swing(t, pos, v) {
    const out = this.voice('swing', pos, 0.35 * v, { verb: 0.1, dur: 0.4, t }); if (!out) return;
    const f = this.N(out, t, 0.3, { type: 'bandpass', f0: 380, q: 1.8, vol: 0.9, a: 0.09 });
    f.frequency.cancelScheduledValues(t); f.frequency.setValueAtTime(380, t); f.frequency.exponentialRampToValueAtTime(1800, t + 0.14); f.frequency.exponentialRampToValueAtTime(600, t + 0.3);
  },
  boom(t, pos, v, p, o) {
    const out = this.voice(o.distant ? 'amb' : 'boom', pos, 1.0 * v, { verb: o.distant ? 0 : 0.5, dur: 2.7, big: o.distant ? 0.8 : 0.2, lp: o.lp ?? null, pan: o.pan ?? null, t }); if (!out) return;
    this.B(out, t, pick(this.booms), { rate: rnd(0.85, 1.05) });
    if (!o.distant) this.duck(0.25, 1.4);
  },

  // ---- player foley
  step(t, pos, v, p) {
    const out = this.voice('step', pos, 0.32 * v, { verb: 0.04, dur: 0.25, t }); if (!out) return;
    this.foot = !this.foot; const k = this.foot ? 1 : 0.92;
    this.N(out, t, 0.05, { type: 'lowpass', f0: 420 * k * p, f1: 140, vol: 1.1 });
    this.N(out, t + 0.012, 0.09, { type: 'bandpass', f0: 2600 * p, f1: 1700, q: 0.9, vol: 0.45, a: 0.012 }); // gravel scuff
    for (let i = 0; i < 2; i++) this.N(out, t + 0.01 + Math.random() * 0.06, 0.012, { type: 'bandpass', f0: rnd(3000, 6500), q: 5, vol: 0.18 });
    if (this.rain > 0.2) this.N(out, t + 0.005, 0.14, { type: 'bandpass', f0: 1400, f1: 2600, q: 1.5, vol: 0.55 * this.rain, a: 0.01 }); // splash
    if (Math.random() < 0.25) this.M(out, t + 0.02, [rnd(4200, 5600), 7100], { decay: 0.05, vol: 0.06 }); // kit jingle
  },
  dodge(t, pos, v) {
    const out = this.voice('dodge', pos, 0.4 * v, { verb: 0.12, dur: 0.7, t }); if (!out) return;
    const f = this.N(out, t, 0.32, { type: 'bandpass', f0: 300, q: 1.2, vol: 0.9, a: 0.06 });
    f.frequency.cancelScheduledValues(t); f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(1500, t + 0.16); f.frequency.exponentialRampToValueAtTime(500, t + 0.32);
    for (let k = 0; k < 5; k++) this.M(out, t + 0.04 + k * rnd(0.04, 0.06), [rnd(2500, 4200), rnd(5000, 6500)], { decay: 0.04, vol: 0.1 }); // gear rattle
    this.N(out, t + 0.3, 0.12, { type: 'lowpass', f0: 600, f1: 120, vol: 1 }); this.O(out, t + 0.3, 0.08, { f0: 95, f1: 55, vol: 0.5 }); // shoulder lands
    this.N(out, t + 0.33, 0.2, { type: 'bandpass', f0: 2200, f1: 1200, q: 0.8, vol: 0.4, a: 0.02 }); // grit slide
  },
  hurt(t, pos, v, p) {
    const out = this.voice('hurt', null, 0.55 * v, { verb: 0.1, dur: 0.6, t }); if (!out) return;
    this.N(out, t, 0.1, { type: 'lowpass', f0: 1400, f1: 200, vol: 1 }); this.O(out, t, 0.12, { f0: 120, f1: 50, vol: 0.9 });
    if (Math.random() < 0.65) this.vox(out, t + 0.02, { pts: [[0, 125 * p], [0.3, 140 * p], [1, 95 * p]], dur: 0.24, v0: VOW.uh, v1: VOW.u, q: 7, rough: 0.3, breath: 0.35, drive: 1.3, vol: 0.45 });
    this.hurtDip = 1;
  },
  death(t) {
    const out = this.voice('death', null, 0.6, { verb: 0.6, dur: 4, ui: true, t }); if (!out) return;
    this.B(out, t, this.booms[0], { rate: 0.7, vol: 0.6 });
    this.O(out, t, 3.5, { type: 'sine', f0: 3900, f1: 3850, vol: 0.05, a: 0.3 }); // tinnitus
    this.O(out, t, 3, { type: 'sawtooth', f0: 98, f1: 36, vol: 0.12, a: 0.2 }); this.O(out, t, 3, { type: 'sine', f0: 49, f1: 28, vol: 0.5, a: 0.1 });
    this.duck(0.1, 3);
  },

  // ---- weapon handling foley
  reload(t, pos, v) { // mag release + mag out (+ spent mag clatter); insert/shells come from update()
    const base = this.curBase();
    const out = this.voice('reload', pos, 0.4 * v, { verb: 0.06, dur: 0.8, t }); if (!out) return;
    if (base === 'shotgun') { this.N(out, t, 0.1, { type: 'bandpass', f0: 900, f1: 1400, q: 1.5, vol: 0.4, a: 0.03 }); return; }
    this.M(out, t, [rnd(2600, 3000), 4100], { decay: 0.03, vol: 0.4 }); // release button
    this.N(out, t + 0.04, 0.14, { type: 'bandpass', f0: 1500, f1: 900, q: 2, vol: 0.5, a: 0.03 }); // slide out
    this.N(out, t + 0.38, 0.05, { type: 'lowpass', f0: 1200, f1: 300, vol: 0.5 }); this.M(out, t + 0.38, [rnd(1300, 1700), 2700], { decay: 0.06, vol: 0.12, type: 'triangle' }); // mag hits ground
  },
  magIn(t, pos, v) {
    const out = this.voice('reload', pos, 0.45 * v, { verb: 0.06, dur: 0.4, t }); if (!out) return;
    this.N(out, t, 0.06, { type: 'bandpass', f0: 1100, f1: 1700, q: 2, vol: 0.4, a: 0.02 });
    this.N(out, t + 0.06, 0.03, { type: 'bandpass', f0: 2300, q: 4, vol: 1 }); this.M(out, t + 0.06, [rnd(1800, 2200), 3300, 5200], { decay: 0.05, vol: 0.35 }); this.O(out, t + 0.06, 0.04, { f0: 200, f1: 120, vol: 0.4 });
  },
  shellIn(t, pos, v) {
    const out = this.voice('reload', pos, 0.4 * v, { verb: 0.05, dur: 0.3, t }); if (!out) return;
    this.N(out, t, 0.05, { type: 'bandpass', f0: 1600, f1: 900, q: 2, vol: 0.6, a: 0.015 });
    this.N(out, t + 0.05, 0.025, { type: 'bandpass', f0: 2800, q: 5, vol: 0.9 }); this.M(out, t + 0.05, [rnd(1500, 1800), 2600], { decay: 0.04, vol: 0.2 });
  },
  reloadEnd(t, pos, v) { // charging handle / bolt / pump to chamber
    const base = this.curBase();
    if (base === 'shotgun') return S.pump.call(this, t, pos, v);
    const out = this.voice('reload', pos, 0.45 * v, { verb: 0.08, dur: 0.4, t }); if (!out) return;
    const lo = base === 'dmr' ? 0.75 : base === 'smg' ? 1.2 : 1;
    this.N(out, t, 0.07, { type: 'bandpass', f0: 1400 * lo, f1: 2600 * lo, q: 2, vol: 0.5, a: 0.03 }); this.M(out, t + 0.06, [2600 * lo, 3900 * lo], { decay: 0.03, vol: 0.3 });
    this.N(out, t + 0.13, 0.04, { type: 'bandpass', f0: 2000 * lo, q: 3, vol: 1.1 }); this.M(out, t + 0.13, [1700 * lo, 2950 * lo, 4800 * lo], { decay: 0.06, vol: 0.4 }); this.O(out, t + 0.13, 0.05, { f0: 180 * lo, f1: 100, vol: 0.5 });
  },
  pump(t, pos, v) {
    const out = this.voice('reload', pos, 0.55 * v, { verb: 0.1, dur: 0.6, t }); if (!out) return;
    this.N(out, t, 0.08, { type: 'bandpass', f0: 900, f1: 1800, q: 1.5, vol: 0.7, a: 0.02 }); // slide back
    this.N(out, t + 0.08, 0.03, { type: 'bandpass', f0: 2200, q: 4, vol: 1 }); this.M(out, t + 0.08, [1500, 2450, 3900], { decay: 0.06, vol: 0.35 });
    this.N(out, t + 0.14, 0.07, { type: 'bandpass', f0: 1700, f1: 1000, q: 1.5, vol: 0.6, a: 0.02 }); // forward
    this.N(out, t + 0.21, 0.03, { type: 'bandpass', f0: 2600, q: 4, vol: 1.1 }); this.M(out, t + 0.21, [1300, 2200, 3600], { decay: 0.07, vol: 0.4 }); this.O(out, t + 0.21, 0.05, { f0: 160, f1: 90, vol: 0.5 });
    S.casing.call(this, t + 0.5, pos, 0.6, 1, { shell: true, brass: false });
  },
  equip(t, pos, v) {
    const out = this.voice('reload', pos, 0.4 * v, { verb: 0.06, dur: 0.5, t }); if (!out) return;
    this.N(out, t, 0.18, { type: 'bandpass', f0: 700, f1: 1500, q: 0.9, vol: 0.5, a: 0.05 }); // sling / cloth
    this.N(out, t + 0.17, 0.03, { type: 'bandpass', f0: 2400, q: 4, vol: 0.8 }); this.M(out, t + 0.17, [1900, 3100], { decay: 0.05, vol: 0.3 });
  },
  empty(t, pos, v) {
    const out = this.voice('empty', pos, 0.35 * v, { verb: 0, dur: 0.12, t }); if (!out) return;
    this.M(out, t, [rnd(3000, 3400), 5100], { decay: 0.025, vol: 0.6 }); this.N(out, t, 0.015, { type: 'highpass', f0: 4000, vol: 0.4 });
  },

  // ---- loot
  crate(t, pos, v) {
    const out = this.voice('crate', pos, 0.45 * v, { verb: 0.25, dur: 1.2, t }); if (!out) return;
    this.M(out, t, [2400, 3700], { decay: 0.04, vol: 0.3 }); // latch
    const c = this.ctx, o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(140, t + 0.05); o.frequency.linearRampToValueAtTime(260, t + 0.3); o.frequency.linearRampToValueAtTime(190, t + 0.45);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 6; const g = c.createGain(); g.gain.setValueAtTime(0, t + 0.05); g.gain.linearRampToValueAtTime(0.18, t + 0.12); g.gain.exponentialRampToValueAtTime(0.001, t + 0.48);
    o.connect(bp).connect(g).connect(out); o.start(t + 0.05); o.stop(t + 0.5); // hinge creak
    this.N(out, t + 0.45, 0.25, { type: 'lowpass', f0: 900, f1: 150, vol: 1 }); this.O(out, t + 0.45, 0.12, { f0: 120, f1: 60, vol: 0.6 }); // lid lands
    for (let k = 0; k < 4; k++) this.N(out, t + 0.55 + k * 0.08, 0.06, { type: 'bandpass', f0: rnd(1200, 3000), q: 2, vol: 0.25 }); // rummage
  },
  // a drop landing on the ground; chime brightness/size scales with rarity (legendary has its own)
  drop(t, pos, v, p, o) {
    const tier = o.tier || 0; if (tier >= 4) return S.legendary.call(this, t, pos, v);
    const out = this.voice('drop', pos, 0.4 * v, { verb: 0.3 + tier * 0.1, dur: 2, t, big: tier * 0.08 }); if (!out) return;
    this.N(out, t, 0.08, { type: 'lowpass', f0: 900, f1: 200, vol: 0.9 }); this.M(out, t, [rnd(900, 1300), 2200], { decay: 0.08, vol: 0.15, type: 'triangle' });
    const scale = [[], [880], [988, 1319], [740, 1109, 1480, 2217]][tier] || [];
    scale.forEach((f, i) => { this.O(out, t + 0.05 + i * 0.07, 0.9 + tier * 0.2, { type: 'sine', f0: f, vol: 0.16 }); this.O(out, t + 0.05 + i * 0.07, 0.5, { type: 'sine', f0: f * 2.01, vol: 0.04 }); });
    if (tier >= 3) { this.N(out, t, 0.9, { type: 'bandpass', f0: 3000, f1: 9000, q: 3, vol: 0.18, a: 0.3 }); this.O(out, t, 1.4, { f0: 55, f1: 50, vol: 0.35, a: 0.2 }); }
  },
  legendary(t, pos, v) {
    const out = this.voice('legendary', null, 0.5 * v, { verb: 0.5, dur: 4.5, ui: true, big: 0.4, t }); if (!out) return;
    // reverse-swell riser -> impact -> golden choir chord + bell arpeggio + sparkle
    this.N(out, t, 0.55, { type: 'bandpass', f0: 600, f1: 6000, q: 1.2, vol: 0.5, a: 0.5 });
    const ti = t + 0.5;
    this.B(out, ti, this.booms[1], { rate: 1.4, vol: 0.45 }); this.O(out, ti, 1.2, { f0: 70, f1: 40, vol: 0.6 });
    const chord = [146.8, 220, 293.7, 370, 440];
    for (const f of chord) this.vox(out, ti, { pts: [[0, f]], dur: 2.8, v0: VOW.a, v1: VOW.o, q: 10, vib: [5, f * 0.012], breath: 0.05, voices: 3, detune: 14, vol: 0.18, a: 0.25 });
    [1175, 1480, 1760, 2349, 2960].forEach((f, i) => this.M(out, ti + 0.06 + i * 0.09, [f, f * 2.76, f * 5.4], { decay: 1.6, vol: 0.13, tilt: 0.4 }));
    for (let k = 0; k < 10; k++) this.M(out, ti + 0.3 + Math.random() * 1.4, [rnd(4000, 9000)], { decay: 0.2, vol: 0.05 });
    this.duck(0.35, 2);
  },
  pickup(t, pos, v, p, o) {
    const tier = o.tier || 0;
    const out = this.voice('pickup', null, 0.28 * v, { verb: 0.2, dur: 1, ui: true, t }); if (!out) return;
    this.N(out, t, 0.09, { type: 'bandpass', f0: 900, f1: 1600, q: 1.2, vol: 0.5, a: 0.02 }); this.M(out, t + 0.06, [rnd(1800, 2200), 3300], { decay: 0.05, vol: 0.25 }); // grab
    const base = 523 * Math.pow(2, tier / 6);
    for (let i = 0; i <= Math.min(4, tier + 1); i++) this.O(out, t + 0.05 + i * 0.055, 0.35 + tier * 0.08, { type: 'triangle', f0: base * [1, 1.25, 1.5, 2, 2.5][i], vol: 0.26 });
  },

  // ---- UI / meta
  ui(t, pos, v) {
    const out = this.voice('ui', null, 0.45 * v, { verb: 0, dur: 0.1, ui: true, t }); if (!out) return;
    this.N(out, t, 0.006, { type: 'highpass', f0: 5000, vol: 0.8 });
    this.O(out, t, 0.05, { type: 'triangle', f0: 1650, f1: 1150, vol: 0.45 }); this.O(out, t + 0.012, 0.03, { type: 'sine', f0: 3300, vol: 0.12 });
  },
  beep(t, pos, v, p, o) { // evac countdown pip (radio-ish)
    const out = this.voice('beep', null, 0.22 * v, { verb: 0.15, dur: 0.3, ui: true, t }); if (!out) return;
    const f = o.f || 880; this.O(out, t, 0.14, { type: 'square', f0: f, vol: 0.18 }); this.O(out, t, 0.2, { type: 'sine', f0: f * 2, vol: 0.12 });
  },
  extracted(t) {
    const out = this.voice('extracted', null, 0.5, { verb: 0.5, dur: 5, ui: true, big: 0.4, t }); if (!out) return;
    this.B(out, t, this.booms[1], { rate: 1.1, vol: 0.4 });
    for (const f of [73.4, 110, 146.8, 185, 220, 293.7, 370]) this.vox(out, t + 0.05, { pts: [[0, f]], dur: 4, v0: VOW.o, v1: VOW.a, q: 9, vib: [4.5, f * 0.008], breath: 0.03, voices: 2, detune: 10, vol: 0.14, a: 0.6 });
    [587, 740, 880, 1175].forEach((f, i) => this.M(out, t + 0.6 + i * 0.16, [f, f * 2.76], { decay: 2, vol: 0.12, tilt: 0.4 }));
  },
};
Audio.prototype.curBase = function () { const g = this.game, w = g && g.player && g.player.weapon; return w ? w.base : 'rifle'; };

// ------------------------------------------------------------------ per-frame update
Audio.prototype.update = function (dt, nearestFireDist = Infinity, game = null) {
  if (!this.ctx || !this.enabled) return;
  if (game) this.game = game;
  const g = this.game, c = this.ctx, t = c.currentTime;
  const mode = g ? g.mode : 'playing', pl = g && g.player;
  this.rain = g && g.lighting && g.lighting.p ? g.lighting.p.rain || 0 : 0;
  // --- reload foley timeline (mag in / shell inserts), driven by the weapon's own reload timer
  if (pl && pl.weapon) {
    const w = pl.weapon;
    if (w.reloadT > 0 && w.reloadTotal) {
      const k = 1 - w.reloadT / w.reloadTotal;
      if (!this.rl || this.rl.w !== w || k < this.rl.k - 0.05) this.rl = { w, k: 0, n: 0, shells: w.base === 'shotgun' ? clamp(w.stats.mag - w.mag, 1, 6) : 0 };
      const R = this.rl;
      if (R.shells) { const due = Math.floor(clamp((k - 0.1) / 0.8, 0, 1) * R.shells + 0.0001); while (R.n < due && R.n < R.shells) { R.n++; this.play('shellIn', pl.pos, { minGap: 0 }); } }
      else if (R.k < 0.55 && k >= 0.55) this.play('magIn', pl.pos, { minGap: 0 });
      R.k = k;
    } else this.rl = null;
  }
  // --- barks: new alerts (raiders / brutes; mutants scream from the AI), callouts, idle vocals
  this.barkT -= dt; this.idleT -= dt;
  if (g && g.enemies && mode === 'playing') {
    for (const e of g.enemies.list) {
      if (e.dead || !e.alert || this.alertSeen.has(e)) continue;
      this.alertSeen.add(e);
      if (e.type !== 'mutant' && this.barkT <= 0 && this.near(e.pos, 40)) { this.barkT = 0.7; this.play('bark', e.pos, { type: e.type, kind: 'alert', minGap: 0.3, delay: rnd(0.05, 0.35) }); }
    }
    if (this.idleT <= 0) {
      this.idleT = rnd(2.5, 6);
      const cand = g.enemies.list.filter((e) => !e.dead && this.near(e.pos, 24));
      if (cand.length) { const e = pick(cand); this.play('bark', e.pos, { type: e.type, kind: e.alert && e.type === 'raider' ? 'alert' : 'idle', vol: e.alert ? 0.8 : 0.55, minGap: 0.5 }); }
    }
  }
  // --- combat intensity -> music
  this.heat = Math.max(0, this.heat - dt * 0.25);
  let alertNear = 0;
  if (g && g.enemies && mode === 'playing') for (const e of g.enemies.list) if (!e.dead && e.alert && this.near(e.pos, 35)) alertNear++;
  let target = Math.min(1, alertNear * 0.16 + this.heat * 0.7);
  if (g && g.extractT > 0 && mode === 'playing') target = Math.max(target, 0.75 + 0.25 * Math.min(1, g.extractT / (g.extractDur || 20)));
  const hpR = pl ? pl.hp / pl.maxHp : 1;
  if (target > this.intensity) { this.intensity = Math.min(target, this.intensity + dt * 1.2); this.calmHold = 3; }
  else { this.calmHold -= dt; if (this.calmHold <= 0) this.intensity = Math.max(target, this.intensity - dt * 0.08); }
  if (mode !== 'playing') this.intensity = Math.max(0, this.intensity - dt * 0.5);
  if (this.music) this.music.update(dt, this.intensity, mode);
  // --- low health: heartbeat + muffle; hurt dip
  this.hurtDip = Math.max(0, (this.hurtDip || 0) - dt * 2.5);
  const low = mode === 'playing' && pl && !pl.dead ? clamp((0.35 - hpR) / 0.3, 0, 1) : 0;
  const cut = Math.min(20000 * Math.pow(0.06, low), 20000 * Math.pow(0.1, this.hurtDip));
  this.muffle.frequency.setTargetAtTime(Math.max(500, cut), t, 0.08);
  if (low > 0 && t >= this.nextBeat - 0.1) {
    const bt = Math.max(t + 0.02, this.nextBeat), bpm = 72 + low * 58;
    const out = this.voice('heart', null, 0.5 + low * 0.4, { verb: 0, dur: 0.6, ui: true, t: bt });
    if (out) { this.O(out, bt, 0.13, { f0: 62, f1: 38, vol: 1 }); this.N(out, bt, 0.08, { type: 'lowpass', f0: 160, f1: 60, vol: 0.6 }); this.O(out, bt + 0.2, 0.11, { f0: 55, f1: 36, vol: 0.7 }); }
    this.nextBeat = bt + 60 / bpm;
  }
  // --- ambience bed + extraction/dropship loops
  if (this.ambience) this.ambience.update(dt, g, nearestFireDist);
};
