// Offline sample synthesis for the audio engine: everything here writes raw Float32 sample arrays
// (no WebAudio nodes) so heavy layered sounds — gunshots, explosions, impulse responses, rain and
// fire beds — are built once at unlock with full per-sample control, then replayed cheaply with
// per-shot variation. Pure functions of (sampleRate, params, rng): also used by scripts/audio-test.mjs.

export function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// RBJ biquad, coefficients recomputable per block for sweeps
export class Biquad {
  constructor(type, sr) { this.type = type; this.sr = sr; this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  set(f, q = 0.707, gainDb = 0) {
    const w = 2 * Math.PI * Math.min(f, this.sr * 0.45) / this.sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    switch (this.type) {
      case 'lp': b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'hp': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'bp': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'peak': { const A = Math.pow(10, gainDb / 40); b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; break; }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  p(x) { const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2; this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y; }
}

const softclip = (x, d) => Math.tanh(x * d) / Math.tanh(d);
function normalize(chs, peak = 0.9) {
  let m = 0; for (const d of chs) for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
  if (m > 0) { const k = peak / m; for (const d of chs) for (let i = 0; i < d.length; i++) d[i] *= k; }
  // short fade-out so loops/one-shots never end on a click
  for (const d of chs) { const n = Math.min(d.length, 256); for (let i = 0; i < n; i++) d[d.length - 1 - i] *= i / n; }
  return chs;
}

// ---------------------------------------------------------------------------------------------
// Gunshots: supersonic crack (N-wave + HP noise) -> saturated body (swept sine thump + band-passed
// muzzle blast) -> mechanical action (modal pings) -> stereo tail (decorrelated LP noise + street
// slapback echoes). Each weapon is a parameter set; variants jitter every parameter a few percent.
export const GUNS = {
  rifle: { len: 1.0, crack: 0.55, crackHP: 3200, crackTau: 0.004, nwave: 0.35, body: 1.0, f0: 210, f1: 58, sweepTau: 0.018, bodyTau: 0.055, blast: 1.0, blastF: 1150, blastF1: 380, blastQ: 0.9, blastTau: 0.042, drive: 2.6, mech: 0.18, mechF: [2900, 4350, 6150], mechT: 0.028, tail: 0.38, tailF0: 2400, tailF1: 320, tailTau: 0.24, echo: 0.32, echoD: [0.071, 0.097] },
  smg: { len: 0.6, crack: 0.42, crackHP: 4200, crackTau: 0.0028, nwave: 0.15, body: 0.6, f0: 300, f1: 105, sweepTau: 0.01, bodyTau: 0.026, blast: 1.0, blastF: 2100, blastF1: 900, blastQ: 1.2, blastTau: 0.022, drive: 3.8, mech: 0.26, mechF: [3600, 5300, 7400], mechT: 0.016, tail: 0.24, tailF0: 3400, tailF1: 600, tailTau: 0.11, echo: 0.24, echoD: [0.052, 0.066] },
  shotgun: { len: 1.6, crack: 0.2, crackHP: 1600, crackTau: 0.007, nwave: 0, body: 1.6, f0: 150, f1: 36, sweepTau: 0.035, bodyTau: 0.15, blast: 1.25, blastF: 520, blastF1: 150, blastQ: 0.6, blastTau: 0.095, drive: 4.2, mech: 0, mechF: [], mechT: 0, tail: 0.55, tailF0: 1150, tailF1: 140, tailTau: 0.42, echo: 0.38, echoD: [0.112, 0.141] },
  dmr: { len: 1.9, crack: 1.4, crackHP: 6000, crackTau: 0.007, nwave: 1.2, body: 1.05, f0: 180, f1: 44, sweepTau: 0.03, bodyTau: 0.095, blast: 0.75, blastF: 950, blastF1: 260, blastQ: 0.8, blastTau: 0.06, drive: 3.0, mech: 0.3, mechF: [2050, 3250, 5600], mechT: 0.07, tail: 0.5, tailF0: 4200, tailF1: 220, tailTau: 0.6, echo: 0.42, echoD: [0.151, 0.213] },
  // raider slug-thrower: harsher, buzzier, mid-forward — reads as "not your gun"
  enemy: { len: 0.7, crack: 0.12, crackHP: 2400, crackTau: 0.004, nwave: 0, body: 0.7, f0: 300, f1: 110, sweepTau: 0.03, bodyTau: 0.05, blast: 1.0, blastF: 1050, blastF1: 480, blastQ: 3.0, blastTau: 0.05, drive: 6.5, buzz: 0.75, buzzF: 78, mech: 0.1, mechF: [1500, 2300], mechT: 0.02, tail: 0.26, tailF0: 1500, tailF1: 260, tailTau: 0.16, echo: 0.28, echoD: [0.08, 0.1] },
};

export function gunshot(sr, base, rng) {
  const j = (v, k = 0.08) => v * (1 + (rng() * 2 - 1) * k);
  const S = { ...base };
  for (const k of ['crack', 'crackHP', 'crackTau', 'body', 'f0', 'f1', 'sweepTau', 'bodyTau', 'blast', 'blastF', 'blastF1', 'blastTau', 'tail', 'tailTau']) S[k] = j(S[k]);
  const n = Math.floor(sr * S.len), dry = new Float32Array(n);
  const hp = new Biquad('hp', sr).set(S.crackHP, 0.8), bp = new Biquad('bp', sr), lowShelf = new Biquad('lp', sr).set(9000, 0.6);
  let ph = 0, bodyN = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 31) === 0) bp.set(S.blastF1 + (S.blastF - S.blastF1) * Math.exp(-t / (S.blastTau * 1.5)), S.blastQ);
    const w = rng() * 2 - 1;
    // crack: N-wave (sharp + / - pressure lobes, ~0.6ms) and a bright noise burst
    let x = 0;
    if (S.nwave && t < 0.0012) x += S.nwave * (t < 0.0006 ? 1 - t / 0.0006 : -(1 - (t - 0.0006) / 0.0006)) * 1.4;
    x += S.crack * hp.p(w) * Math.exp(-t / S.crackTau) * Math.min(1, t / 0.0002);
    // body: pitch-swept thump
    const f = S.f1 + (S.f0 - S.f1) * Math.exp(-t / S.sweepTau);
    ph += (2 * Math.PI * f) / sr;
    const benv = Math.min(1, t / 0.0008) * Math.exp(-t / S.bodyTau);
    let body = Math.sin(ph) * S.body * benv;
    // muzzle blast: band-passed noise, optionally buzzy (ring-modulated square)
    let blast = bp.p(w) * 3 * S.blast * Math.min(1, t / 0.0005) * Math.exp(-t / S.blastTau);
    if (S.buzz) blast *= 1 - S.buzz + S.buzz * Math.sign(Math.sin(2 * Math.PI * S.buzzF * t));
    x += softclip(body + blast, S.drive);
    // mechanical action: short inharmonic pings
    if (S.mech && t >= S.mechT) { const tm = t - S.mechT, e = Math.exp(-tm / 0.012); if (e > 1e-4) for (let k = 0; k < S.mechF.length; k++) x += S.mech * e * Math.sin(2 * Math.PI * S.mechF[k] * tm) / (k + 1); }
    dry[i] = lowShelf.p(x);
    bodyN = i;
  }
  // stereo: tails decorrelated per channel + slapback echoes (alternating sides)
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const d = out[ch], lp = new Biquad('lp', sr), elp = new Biquad('lp', sr).set(2600, 0.6);
    const dl = Math.floor(S.echoD[ch] * sr), dl2 = Math.floor(S.echoD[1 - ch] * sr * 1.9);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 31) === 0) lp.set(S.tailF1 + (S.tailF0 - S.tailF1) * Math.exp(-t / (S.tailTau * 0.5)), 0.7);
      const tenv = Math.min(1, t / 0.012) * Math.exp(-t / S.tailTau);
      const tail = lp.p(rng() * 2 - 1) * S.tail * tenv * 2.2;
      const echo = (i >= dl ? dry[i - dl] : 0) * S.echo + (i >= dl2 ? dry[i - dl2] : 0) * S.echo * 0.45;
      d[i] = dry[i] * (ch ? 0.97 : 1) + tail + elp.p(echo);
    }
  }
  return normalize(out, 0.92);
}

// Explosion / heavy slam: sub drop + crushed broadband blast + debris rattle + long rumble
export function explosion(sr, rng, len = 2.6) {
  const n = Math.floor(sr * len), out = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const lp = new Biquad('lp', sr), rum = new Biquad('lp', sr).set(140, 0.8), deb = new Biquad('bp', sr).set(2600, 1.2);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 31) === 0) lp.set(120 + 5000 * Math.exp(-t / 0.08), 0.7);
      const w = rng() * 2 - 1;
      ph += (2 * Math.PI * (28 + 70 * Math.exp(-t / 0.12))) / sr;
      const sub = Math.sin(ph) * Math.min(1, t / 0.004) * Math.exp(-t / 0.45) * 1.3;
      const blast = lp.p(w) * 2.4 * Math.min(1, t / 0.002) * Math.exp(-t / 0.25);
      const rumble = rum.p(w) * 6 * Math.min(1, t / 0.1) * Math.exp(-t / 0.9);
      const debris = rng() < 0.004 * Math.exp(-t / 0.6) ? (rng() * 2 - 1) * 4 : 0;
      out[ch][i] = softclip(sub + blast, 2.2) + rumble + deb.p(debris) * Math.exp(-t / 0.7);
    }
  }
  return normalize(out, 0.95);
}

// Convolution reverb impulse: sparse early reflections (street canyon / room) + frequency-dependent
// diffuse tail (cutoff falls over time so the tail darkens like real air absorption).
export function impulse(sr, rng, { len = 2.2, decay = 0.55, pre = 0.008, early = 10, bright = 7000, dark = 900, width = 1 } = {}) {
  const n = Math.floor(sr * len), out = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const d = out[ch], lp = new Biquad('lp', sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 63) === 0) lp.set(dark + (bright - dark) * Math.exp(-t / (decay * 0.6)), 0.5);
      const env = t < pre ? 0 : Math.min(1, (t - pre) / 0.02) * Math.exp(-(t - pre) / decay);
      d[i] = lp.p(rng() * 2 - 1) * env;
    }
    for (let k = 0; k < early; k++) { const ti = Math.floor((pre + 0.004 + rng() * 0.09) * sr); if (ti < n) d[ti] += (rng() < 0.5 ? -1 : 1) * (0.25 + rng() * 0.5) * Math.exp(-ti / sr / 0.08); }
  }
  // mid/side width control
  if (width !== 1) for (let i = 0; i < n; i++) { const m = (out[0][i] + out[1][i]) / 2, s = (out[0][i] - out[1][i]) / 2 * width; out[0][i] = m + s; out[1][i] = m - s; }
  // calibrate to unity power gain in the low-mids (< 1 kHz, where most game content lives): a dark IR
  // normalized by total energy would boost low frequencies by +15 dB, a peak-normalized one by ~+30 dB.
  // Then the send gains alone set the wet level.
  for (const d of out) {
    const lp = new Biquad('lp', sr).set(1000, 0.707); let e = 0;
    for (let i = 0; i < n; i++) { const y = lp.p(d[i]); e += y * y; }
    const k = Math.sqrt((1000 / (sr / 2)) / (e || 1)); for (let i = 0; i < n; i++) d[i] *= k;
  }
  return out;
}

// Fire bed: low roar + hiss + random pops/snaps of varying size (loopable)
export function fireBed(sr, rng, len = 4) {
  const n = Math.floor(sr * len), out = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const roar = new Biquad('lp', sr).set(260, 0.7), hiss = new Biquad('bp', sr).set(3800, 0.6), pop = new Biquad('bp', sr).set(1800, 1.5);
    let pe = 0, pf = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1, t = i / sr;
      const breathe = 0.7 + 0.3 * Math.sin(2 * Math.PI * (0.5 + ch * 0.13) * t + rng() * 0.02);
      if (rng() < 0.00055) { pe = 0.4 + rng() * 1.2; pf = 900 + rng() * 3200; pop.set(pf, 1.2 + rng() * 2); }
      pe *= 0.9965;
      out[ch][i] = roar.p(w) * 1.8 * breathe + hiss.p(w) * 0.12 + pop.p(w) * pe * 3;
    }
  }
  return loopify(normalize(out, 0.8), sr);
}

// Rain bed: dense highpassed hiss + individual droplet ticks on surfaces + puddle plinks
export function rainBed(sr, rng, len = 4) {
  const n = Math.floor(sr * len), out = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const hiss = new Biquad('bp', sr).set(5200, 0.5), body = new Biquad('lp', sr).set(900, 0.6), drop = new Biquad('bp', sr).set(3000, 4);
    let de = 0, pl = 0, plf = 0, plp = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1, t = i / sr;
      if (rng() < 0.004) { de = 0.3 + rng() * 0.7; drop.set(1800 + rng() * 5000, 3 + rng() * 6); }
      de *= 0.992;
      if (rng() < 0.00012) { pl = 0.25 + rng() * 0.3; plf = 900 + rng() * 1400; plp = 0; }
      pl *= 0.9993; plp += (2 * Math.PI * plf * (1 + 0.6 * pl)) / sr;
      out[ch][i] = hiss.p(w) * 0.9 + body.p(w) * 0.35 + drop.p(w) * de * 2.5 + Math.sin(plp) * pl * 0.3 * (t > 0 ? 1 : 0);
    }
  }
  return loopify(normalize(out, 0.75), sr);
}

// Wind: two decorrelated pink-ish noise channels (loopable); modulation happens live
export function pinkNoise(sr, rng, len = 6) {
  const n = Math.floor(sr * len), out = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      out[ch][i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
  }
  return loopify(normalize(out, 0.8), sr);
}

// crossfade the end into the start so a looping buffer has no seam
function loopify(chs, sr, fade = 0.15) {
  const f = Math.floor(sr * fade);
  return chs.map((d) => {
    const n = d.length, o = d.slice(0, n - f);
    for (let i = 0; i < f; i++) { const k = i / f; o[i] = d[i] * k + d[n - f + i] * (1 - k); }
    return o;
  });
}

export function whiteNoise(sr, rng, len = 2) { const d = new Float32Array(Math.floor(sr * len)); for (let i = 0; i < d.length; i++) d[i] = rng() * 2 - 1; return [d]; }

// soft-knee saturation curve for WaveShaperNodes: linear below `knee`, smooth tanh approach to `ceil`
export function satCurve(knee = 0.7, ceil = 0.94, n = 4096) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x); c[i] = Math.sign(x) * (a < knee ? a : knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee))); }
  return c;
}
export function driveCurve(k = 3, n = 2048) { const c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); } return c; }
