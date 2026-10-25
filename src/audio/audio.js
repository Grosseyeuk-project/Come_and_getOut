// Fully synthesized WebAudio: weapons, impacts, UI, creatures, and a layered ambience bed
// (wind, low drone, distant events, positional fire crackle). No audio assets.
export class Audio {
  constructor() {
    this.ctx = null; this.enabled = true; this.listener = { x: 0, z: 0 }; this.fireLevel = 0;
    this.lastPlay = {};
  }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) { this.enabled = false; return; }
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = 0.7;
    this.comp = c.createDynamicsCompressor(); this.comp.threshold.value = -14; this.comp.ratio.value = 4;
    this.master.connect(this.comp).connect(c.destination);
    this.sfx = c.createGain(); this.sfx.connect(this.master);
    this.amb = c.createGain(); this.amb.gain.value = 0.5; this.amb.connect(this.master);
    // reverb send (generated impulse: street canyon slap + tail)
    this.verb = c.createConvolver(); this.verb.buffer = this.impulse(2.4, 2.8);
    this.verbSend = c.createGain(); this.verbSend.gain.value = 0.32; this.verbSend.connect(this.verb).connect(this.master);
    this.noiseBuf = this.makeNoise(2);
    this.startAmbience();
  }
  makeNoise(sec) { const c = this.ctx, b = c.createBuffer(1, c.sampleRate * sec, c.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; }
  impulse(sec, decay) {
    const c = this.ctx, n = c.sampleRate * sec, b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) { const t = i / n; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < c.sampleRate * 0.03 ? 0.2 : 1); } }
    return b;
  }
  setListener(x, z) { this.listener.x = x; this.listener.z = z; }

  // spatial routing: returns a node to connect sources into
  out(pos, vol = 1, verb = 0.3) {
    const c = this.ctx;
    const g = c.createGain();
    let att = 1, pan = 0;
    if (pos) {
      const dx = pos.x - this.listener.x, dz = pos.z - this.listener.z, d = Math.hypot(dx, dz);
      att = 1 / (1 + d * d * 0.004 + d * 0.03);
      // camera yaw is 45deg: screen-right = (cos45, -sin45) in xz
      pan = Math.max(-1, Math.min(1, ((dx - dz) * 0.7071) / 18));
    }
    g.gain.value = vol * att;
    const p = c.createStereoPanner(); p.pan.value = pan;
    g.connect(p).connect(this.sfx);
    if (verb > 0) { const s = c.createGain(); s.gain.value = verb * (pos ? 0.6 + (1 - att) * 1.5 : 1); g.connect(s).connect(this.verbSend); }
    return g;
  }
  noise(dst, t, dur, { type = 'bandpass', f0 = 1000, f1 = f0, q = 1, a = 0.001, vol = 1, rate = 1 } = {}) {
    const c = this.ctx, s = c.createBufferSource(); s.buffer = this.noiseBuf; s.playbackRate.value = rate;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + a); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f).connect(g).connect(dst); s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  }
  tone(dst, t, dur, { type = 'sine', f0 = 100, f1 = f0, vol = 1, a = 0.002 } = {}) {
    const c = this.ctx, o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + a); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(dst); o.start(t); o.stop(t + dur + 0.05);
  }

  play(name, pos = null, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    // simple voice limiting per sound
    const lp = this.lastPlay[name] || 0; if (t - lp < (opts.minGap ?? 0.025)) return; this.lastPlay[name] = t;
    const v = opts.vol ?? 1, p = opts.pitch ?? (0.94 + Math.random() * 0.12);
    switch (name) {
      case 'rifle': { const o = this.out(pos, 0.55 * v, 0.5); this.noise(o, t, 0.16, { type: 'lowpass', f0: 6000 * p, f1: 500, vol: 1.2 }); this.noise(o, t, 0.05, { type: 'highpass', f0: 3000, vol: 0.7 }); this.tone(o, t, 0.12, { type: 'sine', f0: 140 * p, f1: 45, vol: 1.1 }); break; }
      case 'smg': { const o = this.out(pos, 0.42 * v, 0.4); this.noise(o, t, 0.09, { type: 'lowpass', f0: 7000 * p, f1: 700, vol: 1 }); this.tone(o, t, 0.07, { f0: 180 * p, f1: 60, vol: 0.8 }); break; }
      case 'shotgun': { const o = this.out(pos, 0.75 * v, 0.7); this.noise(o, t, 0.45, { type: 'lowpass', f0: 4500 * p, f1: 200, vol: 1.4 }); this.tone(o, t, 0.25, { f0: 95 * p, f1: 32, vol: 1.4 }); this.noise(o, t + 0.38, 0.06, { type: 'bandpass', f0: 2500, q: 4, vol: 0.4 }); this.noise(o, t + 0.5, 0.05, { type: 'bandpass', f0: 1800, q: 4, vol: 0.4 }); break; }
      case 'dmr': { const o = this.out(pos, 0.7 * v, 0.8); this.noise(o, t, 0.3, { type: 'lowpass', f0: 8000 * p, f1: 300, vol: 1.3 }); this.tone(o, t, 0.2, { f0: 120 * p, f1: 35, vol: 1.3 }); this.noise(o, t, 0.02, { type: 'highpass', f0: 5000, vol: 1 }); break; }
      case 'enemyShot': { const o = this.out(pos, 0.4 * v, 0.6); this.noise(o, t, 0.14, { type: 'bandpass', f0: 2200 * p, f1: 400, q: 0.8, vol: 1.2 }); this.tone(o, t, 0.08, { type: 'square', f0: 220 * p, f1: 80, vol: 0.25 }); break; }
      case 'impact': { const o = this.out(pos, 0.25 * v, 0.2); this.noise(o, t, 0.06, { type: 'bandpass', f0: 2500 * p, f1: 900, q: 2, vol: 1 }); break; }
      case 'impactMetal': { const o = this.out(pos, 0.25 * v, 0.3); this.tone(o, t, 0.18, { type: 'triangle', f0: 1800 * p, f1: 1500, vol: 0.35 }); this.noise(o, t, 0.04, { type: 'highpass', f0: 4000, vol: 0.6 }); break; }
      case 'flesh': { const o = this.out(pos, 0.4 * v, 0.1); this.noise(o, t, 0.1, { type: 'lowpass', f0: 900 * p, f1: 200, vol: 1.2 }); this.tone(o, t, 0.08, { f0: 90, f1: 50, vol: 0.6 }); break; }
      case 'hitmarker': { const o = this.out(null, 0.18 * v, 0); this.tone(o, t, 0.05, { type: 'square', f0: 1900, f1: 1700, vol: 0.4 }); break; }
      case 'kill': { const o = this.out(null, 0.25 * v, 0.1); this.tone(o, t, 0.08, { type: 'square', f0: 900, f1: 900, vol: 0.3 }); this.tone(o, t + 0.07, 0.14, { type: 'square', f0: 600, f1: 580, vol: 0.3 }); break; }
      case 'reload': { const o = this.out(pos, 0.35 * v, 0.1); this.noise(o, t, 0.05, { type: 'bandpass', f0: 1500, q: 5, vol: 1 }); this.noise(o, t + 0.25, 0.04, { type: 'bandpass', f0: 2600, q: 6, vol: 0.9 }); break; }
      case 'reloadEnd': { const o = this.out(pos, 0.4 * v, 0.1); this.noise(o, t, 0.04, { type: 'bandpass', f0: 3200, q: 6, vol: 1 }); this.noise(o, t + 0.09, 0.05, { type: 'bandpass', f0: 1800, q: 6, vol: 1 }); break; }
      case 'empty': { const o = this.out(pos, 0.3 * v, 0); this.noise(o, t, 0.03, { type: 'bandpass', f0: 4000, q: 8, vol: 1 }); break; }
      case 'dodge': { const o = this.out(pos, 0.3 * v, 0.1); this.noise(o, t, 0.35, { type: 'bandpass', f0: 600, f1: 2000, q: 1, vol: 0.8, a: 0.05 }); break; }
      case 'step': { const o = this.out(pos, 0.12 * v, 0.05); this.noise(o, t, 0.06, { type: 'lowpass', f0: 700 * p, f1: 200, vol: 1 }); break; }
      case 'hurt': { const o = this.out(null, 0.5 * v, 0.1); this.tone(o, t, 0.2, { type: 'sawtooth', f0: 180, f1: 90, vol: 0.25 }); this.noise(o, t, 0.12, { type: 'lowpass', f0: 1200, f1: 300, vol: 0.8 }); break; }
      case 'enemyHurt': { const o = this.out(pos, 0.25 * v, 0.1); this.tone(o, t, 0.15, { type: 'sawtooth', f0: 260 * p, f1: 140, vol: 0.18 }); break; }
      case 'die': { const o = this.out(pos, 0.45 * v, 0.3); this.tone(o, t, 0.5, { type: 'sawtooth', f0: 220 * p, f1: 60, vol: 0.25 }); this.noise(o, t, 0.4, { type: 'lowpass', f0: 800, f1: 100, vol: 0.5 }); break; }
      case 'scream': { const o = this.out(pos, 0.5 * v, 0.5); const osc = c.createOscillator(); osc.type = 'sawtooth'; osc.frequency.setValueAtTime(380 * p, t); osc.frequency.linearRampToValueAtTime(620 * p, t + 0.25); osc.frequency.linearRampToValueAtTime(300 * p, t + 0.7); const lfo = c.createOscillator(); lfo.frequency.value = 28; const lg = c.createGain(); lg.gain.value = 40; lfo.connect(lg).connect(osc.frequency); const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200; f.Q.value = 2; const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.05); g.gain.exponentialRampToValueAtTime(0.001, t + 0.75); osc.connect(f).connect(g).connect(o); osc.start(t); lfo.start(t); osc.stop(t + 0.8); lfo.stop(t + 0.8); break; }
      case 'slam': { const o = this.out(pos, 0.8 * v, 0.6); this.tone(o, t, 0.5, { f0: 70, f1: 25, vol: 1.5 }); this.noise(o, t, 0.5, { type: 'lowpass', f0: 1500, f1: 80, vol: 1.2 }); break; }
      case 'swing': { const o = this.out(pos, 0.3 * v, 0.1); this.noise(o, t, 0.2, { type: 'bandpass', f0: 500, f1: 1600, q: 1.5, vol: 0.8, a: 0.04 }); break; }
      case 'pickup': { const o = this.out(null, 0.3 * v, 0.2); const tier = opts.tier || 0; const base = 520 + tier * 90; for (let i = 0; i <= Math.min(3, tier + 1); i++) this.tone(o, t + i * 0.06, 0.25, { type: 'triangle', f0: base * Math.pow(1.26, i), vol: 0.35 }); break; }
      case 'crate': { const o = this.out(pos, 0.45 * v, 0.3); this.noise(o, t, 0.25, { type: 'lowpass', f0: 900, f1: 150, vol: 1 }); this.noise(o, t + 0.05, 0.12, { type: 'bandpass', f0: 2400, q: 3, vol: 0.5 }); break; }
      case 'legendary': { const o = this.out(null, 0.35 * v, 0.6); [523, 659, 784, 1046].forEach((f, i) => this.tone(o, t + i * 0.09, 0.9, { type: 'sine', f0: f, vol: 0.3 })); break; }
      case 'beep': { const o = this.out(null, 0.25 * v, 0.1); this.tone(o, t, 0.12, { type: 'square', f0: opts.f || 880, vol: 0.2 }); break; }
      case 'extracted': { const o = this.out(null, 0.5 * v, 0.6); [392, 523, 659, 784].forEach((f, i) => this.tone(o, t + i * 0.15, 1.2, { type: 'triangle', f0: f, vol: 0.3 })); break; }
      case 'death': { const o = this.out(null, 0.6 * v, 0.8); this.tone(o, t, 2.5, { type: 'sawtooth', f0: 110, f1: 40, vol: 0.3 }); this.tone(o, t, 2.5, { type: 'sine', f0: 55, f1: 30, vol: 0.6 }); break; }
      case 'ui': { const o = this.out(null, 0.2 * v, 0); this.tone(o, t, 0.06, { type: 'triangle', f0: 1200, f1: 900, vol: 0.4 }); break; }
      case 'boom': { const o = this.out(pos, 1 * v, 0.9); this.tone(o, t, 0.8, { f0: 60, f1: 20, vol: 1.6 }); this.noise(o, t, 1.2, { type: 'lowpass', f0: 2500, f1: 60, vol: 1.5 }); break; }
    }
  }

  startAmbience() {
    const c = this.ctx, t = c.currentTime;
    // wind: looping noise through slowly modulated bandpass
    const src = c.createBufferSource(); src.buffer = this.makeNoise(4); src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 400; bp.Q.value = 0.6;
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07; const lg = c.createGain(); lg.gain.value = 250; lfo.connect(lg).connect(bp.frequency);
    const wg = c.createGain(); wg.gain.value = 0.22;
    const lfo2 = c.createOscillator(); lfo2.frequency.value = 0.13; const lg2 = c.createGain(); lg2.gain.value = 0.1; lfo2.connect(lg2).connect(wg.gain);
    src.connect(bp).connect(wg).connect(this.amb); src.start(); lfo.start(); lfo2.start();
    // drone
    const dg = c.createGain(); dg.gain.value = 0.05; const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
    for (const f of [41.2, 41.6, 61.7]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(); }
    lp.connect(dg).connect(this.amb);
    // fire crackle bed (gain driven by distance to nearest fire)
    const fs = c.createBufferSource(); fs.buffer = this.makeCrackle(3); fs.loop = true;
    this.fireGain = c.createGain(); this.fireGain.gain.value = 0; fs.connect(this.fireGain).connect(this.amb); fs.start();
    this.nextEvent = t + 4;
  }
  makeCrackle(sec) {
    const c = this.ctx, b = c.createBuffer(1, c.sampleRate * sec, c.sampleRate), d = b.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < d.length; i++) { lp = lp * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = lp * 2.5; if (Math.random() < 0.0009) { const n = 40 + Math.random() * 200; for (let k = 0; k < n && i + k < d.length; k++) d[i + k] += (Math.random() * 2 - 1) * (1 - k / n) * 0.9; } }
    return b;
  }
  update(dt, nearestFireDist) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const fl = Math.max(0, 1 - nearestFireDist / 14) * 0.5;
    this.fireGain.gain.setTargetAtTime(fl, t, 0.3);
    if (t > this.nextEvent) { // distant events
      this.nextEvent = t + 6 + Math.random() * 14;
      const r = Math.random();
      const pos = { x: this.listener.x + (Math.random() - 0.5) * 300, z: this.listener.z + (Math.random() - 0.5) * 300 };
      if (r < 0.45) { const n = 3 + Math.floor(Math.random() * 6); for (let i = 0; i < n; i++) setTimeout(() => this.play(Math.random() < 0.5 ? 'rifle' : 'enemyShot', pos, { vol: 0.5, minGap: 0 }), i * (70 + Math.random() * 60)); }
      else if (r < 0.65) this.play('boom', pos, { vol: 0.5 });
      else if (r < 0.85) { const o = this.out(pos, 0.5, 1); this.tone(o, t, 1.6, { type: 'triangle', f0: 180 + Math.random() * 60, f1: 120, vol: 0.12, a: 0.3 }); } // metal groan
      else this.play('scream', pos, { vol: 0.35, pitch: 0.7 });
    }
  }
}
