// Adaptive tension score (D minor, 96 BPM, i-VI-iv-V). A continuous drone + dread pad always under
// the world; combat intensity (0..1, from audio.update) opens the drone filter and gates in layers on
// a 16th-note lookahead sequencer: pulse bass -> hats -> kick/snare -> toms + arps + stabs.
// Layers rise fast when shooting starts and fade over ~10 s after the last threat.

const BPM = 96, STEP = 60 / BPM / 4, LOOK = 0.2;
const ROOTS = [73.42, 58.27, 49.0, 55.0];           // D2, Bb1, G1, A1
const CHORDS = [[0, 3, 7], [0, 4, 7], [0, 3, 7], [0, 4, 7]]; // semitone offsets: m, M, m, M
const BASS = [0, 0, 12, 0, 0, 7, 0, 12, 0, 0, 12, 0, 3, 0, 7, 10];
const sm = (x, a, b) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

export class Music {
  constructor(A) {
    this.A = A; const c = A.ctx;
    this.out = c.createGain(); this.out.gain.value = 0; this.out.connect(A.mus); this.out.connect(A.musVerb);
    // drone: detuned saws through a cutoff driven by intensity
    this.droneLP = c.createBiquadFilter(); this.droneLP.type = 'lowpass'; this.droneLP.frequency.value = 160; this.droneLP.Q.value = 2;
    this.droneG = c.createGain(); this.droneG.gain.value = 0.16; this.droneLP.connect(this.droneG).connect(this.out);
    this.drone = [];
    for (const [m, det] of [[0.5, -6], [0.5, 5], [0.75, 0], [1, 3]]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = ROOTS[0] * m; o.detune.value = det; o.connect(this.droneLP); o.start(); this.drone.push([o, m]); }
    const lfo = c.createOscillator(); lfo.frequency.value = 0.05; const lg = c.createGain(); lg.gain.value = 60; lfo.connect(lg).connect(this.droneLP.frequency); lfo.start();
    // dread pad: high glassy fifths with slow tremolo (strongest when calm)
    this.padG = c.createGain(); this.padG.gain.value = 0.02; this.padG.connect(this.out);
    this.pad = [];
    for (const [m, det] of [[8, 0], [12, 7], [16, -5]]) { const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = ROOTS[0] * m; o.detune.value = det; const g = c.createGain(); g.gain.value = 0.5; const tl = c.createOscillator(); tl.frequency.value = 0.1 + Math.random() * 0.15; const tg = c.createGain(); tg.gain.value = 0.45; tl.connect(tg).connect(g.gain); o.connect(g).connect(this.padG); o.start(); tl.start(); this.pad.push([o, m]); }
    this.step = 0; this.next = c.currentTime + 0.1; this.I = 0; this.bar = 0; this.mode = null;
  }
  update(dt, I, mode) {
    const A = this.A, c = A.ctx, t = c.currentTime;
    this.I = I;
    const level = mode === 'playing' ? 1 : mode === 'title' ? 0.55 : mode === 'paused' ? 0.4 : 0;
    if (mode !== this.mode) { this.out.gain.setTargetAtTime(level, t, mode === 'dead' || mode === 'extracted' ? 0.6 : 1.5); this.mode = mode; }
    this.droneLP.frequency.setTargetAtTime(160 + I * 1300, t, 0.6);
    this.droneG.gain.setTargetAtTime(0.14 + I * 0.06, t, 0.6);
    this.padG.gain.setTargetAtTime(0.025 * (1 - I * 0.7), t, 1);
    if (this.next < t - 0.5) this.next = t + 0.05; // after a stall (tab hidden / pause), resync instead of bursting
    while (this.next < t + LOOK) { this.tick(this.next, this.step); this.next += STEP; this.step = (this.step + 1) % 64; }
  }
  tick(t, s) {
    const I = this.I, A = this.A, o = this.out, st = s % 16, bar = (s / 16) | 0;
    const root = ROOTS[bar], ch = CHORDS[bar];
    if (st === 0) { // chord change: glide drone + pad
      for (const [osc, m] of this.drone) osc.frequency.setTargetAtTime(root * m * (root < 60 ? 2 : 1), t, 0.25);
      for (const [osc, m] of this.pad) osc.frequency.setTargetAtTime(ROOTS[0] * m * Math.pow(2, ch[1] === 4 && m === 12 ? 1 / 12 : 0), t, 1.2);
    }
    if (this.mode !== 'playing' || I < 0.15) return;
    const bass = sm(I, 0.15, 0.4), hat = sm(I, 0.28, 0.5), kick = sm(I, 0.42, 0.6), snare = sm(I, 0.52, 0.7), hi = sm(I, 0.7, 0.9);
    // pulse bass (8ths, 16ths at high intensity)
    if (bass > 0 && (st % 2 === 0 || hi > 0.5)) {
      const f = root * 2 * Math.pow(2, BASS[st] / 12) * (BASS[st] === 3 && ch[1] === 4 ? Math.pow(2, 1 / 12) : 1);
      this.pluck(o, t, f, 0.16 * bass * (st % 4 === 0 ? 1 : 0.7), 300 + I * 1500);
    }
    if (hat > 0) { const acc = st % 4 === 2 ? 1 : st % 2 ? 0.45 : 0.7; if (st % 2 === 0 || I > 0.6) A.N(o, t, st % 8 === 6 && I > 0.8 ? 0.12 : 0.035, { type: 'highpass', f0: 7500, vol: 0.13 * hat * acc }); }
    if (kick > 0 && (st === 0 || st === 8 || (hi > 0.3 && (st === 3 || st === 11)) || (I > 0.95 && st === 14))) {
      A.O(o, t, 0.28, { f0: 140, f1: 42, vol: 0.55 * kick }); A.N(o, t, 0.01, { type: 'highpass', f0: 3000, vol: 0.15 * kick });
    }
    if (snare > 0 && (st === 4 || st === 12)) { // industrial snare: noise crack + body tone + clap smear
      A.N(o, t, 0.18, { type: 'bandpass', f0: 2000, f1: 900, q: 0.8, vol: 0.32 * snare }); A.O(o, t, 0.09, { type: 'triangle', f0: 210, f1: 150, vol: 0.25 * snare });
      for (let k = 1; k < 3; k++) A.N(o, t + k * 0.011, 0.04, { type: 'bandpass', f0: 1400, q: 1.5, vol: 0.12 * snare });
    }
    if (hi > 0) {
      if (bar === 3 && st >= 12) A.O(o, t, 0.25, { f0: [180, 150, 120, 100][st - 12], f1: 60, vol: 0.3 * hi }); // tom fill
      if (st % 2 === 1 || I > 0.9) { const n = ch[(s * 7) % 3] + 12 * (1 + (st % 3 === 0)); this.pluck(o, t, root * 4 * Math.pow(2, n / 12), 0.045 * hi, 2500, 'square'); } // arp
      if (st === 0 && bar % 2 === 0) A.M(o, t, [root * 8, root * 8 * 2.76, root * 8 * 5.4], { decay: 0.9, vol: 0.05 * hi, tilt: 0.5 }); // metallic stab
    }
  }
  pluck(dst, t, f, vol, cut, type = 'sawtooth') {
    const c = this.A.ctx, o = c.createOscillator(); o.type = type; o.frequency.value = f;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 4; lp.frequency.setValueAtTime(cut, t); lp.frequency.exponentialRampToValueAtTime(Math.max(60, cut * 0.15), t + 0.14);
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.2);
    o.connect(lp).connect(g).connect(dst); o.start(t); o.stop(t + 0.25);
  }
}
