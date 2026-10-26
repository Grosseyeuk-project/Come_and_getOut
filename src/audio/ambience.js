// Dynamic ambient bed: gusting stereo wind, rain (when the palette rains), positional fire crackle,
// neon-sign buzz near live signage, distant war (gunfire bursts, explosions, metal groans, screams,
// thunder in rain) through the big hall reverb, plus the extraction siren and the dropship engines.
import { pinkNoise, rainBed, fireBed, mulberry, driveCurve } from './dsp.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Ambience {
  constructor(A) {
    this.A = A; const c = A.ctx, sr = c.sampleRate, rng = mulberry(0xa11b);
    const loop = (buf, dst, rate = 1) => { const s = c.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.connect(dst); s.start(c.currentTime, Math.random() * buf.duration * 0.9); return s; };
    const G = (v, dst) => { const g = c.createGain(); g.gain.value = v; if (dst) g.connect(dst); return g; };
    const F = (type, f, q, dst) => { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; if (dst) b.connect(dst); return b; };
    const P = (dst) => { const p = c.createStereoPanner(); p.connect(dst); return p; };
    // wind: low body + whistling band, each with its own gust gain
    const pink = A.mkBuf(pinkNoise(sr, rng, 6));
    this.windLo = G(0.0, A.amb); loop(pink, F('lowpass', 380, 0.5, this.windLo), 0.8);
    this.windHi = G(0.0, A.amb); this.whistle = F('bandpass', 900, 3.5, this.windHi); loop(pink, this.whistle, 1.13);
    this.gustT = 0;
    // rain
    this.rainG = G(0, A.amb); loop(A.mkBuf(rainBed(sr, rng, 4)), F('highpass', 200, 0.5, this.rainG));
    // fire (panned toward the nearest fire)
    this.fireP = P(A.amb); this.fireG = G(0, this.fireP); loop(A.mkBuf(fireBed(sr, rng, 4)), this.fireG);
    // neon: 120 Hz mains buzz with harmonics through a mild drive; flicker crackle on top
    this.neonP = P(A.amb); this.neonG = G(0, this.neonP);
    const ws = c.createWaveShaper(); ws.curve = driveCurve(2.5); const nb = F('bandpass', 360, 0.9, this.neonG); ws.connect(nb);
    for (const [f, ty, v] of [[120, 'sawtooth', 0.3], [240, 'square', 0.08], [60, 'sine', 0.15]]) { const o = c.createOscillator(); o.type = ty; o.frequency.value = f; const og = G(v, ws); o.connect(og); o.start(); }
    this.neonCrk = G(0, this.neonG); loop(A.noiseBuf, F('highpass', 3000, 0.7, this.neonCrk));
    // extraction siren: slow-whoop saw through formant band + drive, positioned at the pad
    this.sirenP = P(A.sfx); this.sirenG = G(0, this.sirenP);
    { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 640; const l = c.createOscillator(); l.type = 'triangle'; l.frequency.value = 0.42; const lg = G(260); l.connect(lg).connect(o.frequency);
      const sw = c.createWaveShaper(); sw.curve = driveCurve(2); o.connect(F('bandpass', 1000, 1.2, sw)); sw.connect(F('lowpass', 2800, 0.6, this.sirenG)); o.start(); l.start(); }
    // dropship: turbine whine pair + jet roar + rotor/blade thump + sub, all into one positional gain
    this.shipP = P(A.sfx); this.shipLP = F('lowpass', 900, 0.6, this.shipP); this.shipG = G(0, this.shipLP);
    this.shipOsc = [];
    for (const [f, v] of [[1180, 0.05], [1193, 0.05], [590, 0.04]]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(F('bandpass', f, 8, G(v, this.shipG))); o.start(); this.shipOsc.push([o, f]); }
    loop(pink, F('lowpass', 1400, 0.6, G(0.9, this.shipG)), 1.4);
    { const thump = G(0, this.shipG); const ro = c.createOscillator(); ro.type = 'sine'; ro.frequency.value = 11; const rg = G(0.6); ro.connect(rg).connect(thump.gain); loop(pink, F('lowpass', 180, 1, thump), 0.6); ro.start();
      const sub = c.createOscillator(); sub.frequency.value = 38; sub.connect(G(0.35, this.shipG)); sub.start(); }
    this.nextEvent = c.currentTime + rnd(3, 6); this.scanT = 0; this.fire = null; this.sign = null; this.flick = 0;
  }

  update(dt, g, nf) {
    const A = this.A, c = A.ctx, t = c.currentTime, mode = g ? g.mode : 'playing';
    // wind gusts: retarget every few seconds
    this.gustT -= dt;
    if (this.gustT <= 0) {
      this.gustT = rnd(2.5, 7); const gust = Math.random() < 0.3 ? rnd(0.7, 1) : rnd(0.25, 0.55);
      this.windLo.gain.setTargetAtTime(0.18 + gust * 0.22, t, this.gustT * 0.35);
      this.windHi.gain.setTargetAtTime(gust * gust * 0.12, t, this.gustT * 0.3);
      this.whistle.frequency.setTargetAtTime(600 + gust * 900, t, this.gustT * 0.4);
    }
    this.rainG.gain.setTargetAtTime(clamp(A.rain || 0, 0, 1) * 0.35, t, 1);
    // nearest fire / live neon sign (scanned at 5 Hz)
    this.scanT -= dt;
    if (this.scanT <= 0 && g) {
      this.scanT = 0.2; const L = A.listener;
      this.fire = null; let bd = 1e9;
      if (g.fx && g.fx.fires) for (const f of g.fx.fires) { const d = Math.hypot(f.x - L.x, f.z - L.z); if (d < bd) { bd = d; this.fire = f; } }
      this.sign = null; bd = 1e9;
      const signs = g.env && g.env.signs;
      if (signs) for (const s of signs) { if (s.dead || !s.pos) continue; const d = Math.hypot(s.pos.x - L.x, s.pos.z - L.z); if (d < bd) { bd = d; this.sign = s; } }
    }
    const play = mode === 'playing' || mode === 'dead' || mode === 'extracted';
    if (this.fire) { const sp = A.spatial(this.fire); const k = clamp(1 - sp.dist / 15, 0, 1); this.fireG.gain.setTargetAtTime(k * k * 0.9 * (this.fire.s || 1), t, 0.25); this.fireP.pan.setTargetAtTime(sp.pan, t, 0.2); }
    else this.fireG.gain.setTargetAtTime(Math.max(0, 1 - nf / 14) * 0.5, t, 0.3);
    if (this.sign && play) {
      const sp = A.spatial(this.sign.pos), k = clamp(1 - sp.dist / 11, 0, 1);
      let lvl = k * k * 0.22;
      if (this.sign.flicker) { this.flick -= dt; if (this.flick <= 0) { this.flick = rnd(0.05, 0.6); this.flickOn = Math.random() < 0.8; } if (!this.flickOn) lvl *= 0.1; this.neonCrk.gain.setTargetAtTime(this.flickOn ? 0 : 0.6, t, 0.01); }
      else this.neonCrk.gain.setTargetAtTime(0, t, 0.05);
      this.neonG.gain.setTargetAtTime(lvl, t, 0.05); this.neonP.pan.setTargetAtTime(sp.pan, t, 0.2);
    } else this.neonG.gain.setTargetAtTime(0, t, 0.2);
    // extraction: siren while holding the pad, dropship approaching (distant -> overhead), then flyout
    const ex = g && g.extraction;
    let siren = 0, ship = 0, shipPos = null, shipPitch = 1;
    if (ex && mode === 'playing' && g.extractT > 0) {
      const k = clamp(g.extractT / (g.extractDur || 20), 0, 1);
      siren = 0.16; ship = 0.05 + k * k * 0.5; shipPitch = 0.8 + k * 0.25;
      shipPos = { x: ex.x - 20 * (1 - k), z: ex.z - 20 * (1 - k) };
      const sp = A.spatial(ex); this.sirenP.pan.setTargetAtTime(sp.pan, t, 0.2); siren *= 0.4 + 0.6 * sp.att;
    } else if (mode === 'extracted' && g) {
      const sh = g.hud && g.hud.screens && g.hud.screens.ship;
      if (sh && sh.g) { shipPos = { x: sh.g.position.x, z: sh.g.position.z }; ship = 0.85 * clamp(1 - Math.max(0, sh.g.position.y - 6) / 30, 0, 1); shipPitch = 1 + clamp((sh.g.position.y - 4.6) / 20, -0.1, 0.3); }
    }
    this.sirenG.gain.setTargetAtTime(siren, t, siren ? 0.3 : 1.2);
    if (shipPos) { const sp = A.spatial(shipPos); this.shipP.pan.setTargetAtTime(sp.pan * 0.7, t, 0.2); this.shipLP.frequency.setTargetAtTime(clamp(6000 * sp.att + 400, 400, 6000), t, 0.3); ship *= 0.35 + 0.65 * sp.att; }
    this.shipG.gain.setTargetAtTime(ship, t, 0.6);
    for (const [o, f] of this.shipOsc) o.frequency.setTargetAtTime(f * shipPitch, t, 0.5);
    // distant war events
    if (t > this.nextEvent) {
      this.nextEvent = t + rnd(5, 16);
      const a = Math.random() * Math.PI * 2, pan = Math.cos(a) * 0.8, r = Math.random();
      const far = { pan, lp: rnd(600, 1400), verb: 0, big: 0.9 };
      if (r < 0.42) { // burst of distant fire, mixed weapons
        const n = 3 + (Math.random() * 7 | 0), name = Math.random() < 0.5 ? 'rifle' : 'enemyShot', gap = name === 'rifle' ? 0.1 : 0.14;
        for (let i = 0; i < n; i++) this.distant(name, t + i * gap * rnd(0.8, 1.3), far, rnd(0.08, 0.16));
        if (Math.random() < 0.4) { const t2 = t + n * gap + rnd(0.4, 1.2); for (let i = 0; i < 3 + (Math.random() * 4 | 0); i++) this.distant(name === 'rifle' ? 'enemyShot' : 'rifle', t2 + i * 0.12, { ...far, pan: -pan * 0.6 }, rnd(0.06, 0.12)); }
      } else if (r < 0.6) this.distant('boom', t, far, 0.28);
      else if (r < 0.78) { const o = A.voice('amb', null, 0.12, { pan, lp: 900, verb: 0, big: 1, dur: 3, t }); if (o) { A.O(o, t, 2.4, { type: 'triangle', f0: rnd(150, 220), f1: rnd(100, 130), vol: 0.5, a: 0.5 }); A.O(o, t + 0.3, 1.8, { type: 'sawtooth', f0: rnd(80, 95), f1: 70, vol: 0.12, a: 0.4 }); } } // metal groan
      else if (r < 0.9) A.play('bark', null, { type: Math.random() < 0.6 ? 'mutant' : 'brute', vol: 0.18, pitch: rnd(0.7, 0.9), minGap: 0 });
      else if (A.rain > 0.2) this.distant('boom', t, { ...far, lp: 300 }, 0.5); // thunder
      else { const o = A.voice('amb', null, 0.06, { pan, lp: 1500, verb: 0, big: 1, dur: 5, t }); if (o) { const s = A.O(o, t, 4.5, { type: 'sawtooth', f0: 500, f1: 500, vol: 0.4, a: 1 }); const l = c.createOscillator(); l.frequency.value = 0.25; const lg = c.createGain(); lg.gain.value = 180; l.connect(lg).connect(s.frequency); l.start(t); l.stop(t + 4.6); } } // far siren
    }
  }
  distant(name, t, o, vol) {
    const A = this.A, delay = Math.max(0, t - A.ctx.currentTime);
    A.lastPlay[name] = -1; A.play(name, null, { delay, vol, lp: o.lp, verbMul: 0, big: o.big, pan: o.pan, distant: true, minGap: 0 });
  }
}
