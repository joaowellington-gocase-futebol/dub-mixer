// DUB-MIXER effect units: tape echo, spring reverb, bi-phase, dub siren, one-shot sound FX.

export const dbToGain = (db) => Math.pow(10, db / 20);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function tanhCurve(n = 4096) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 3) / Math.tanh(3);
  }
  return c;
}

function smooth(param, value, ctx, tc = 0.02) {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, tc);
}

/* ------------------------------------------------------------------ */
/* TAPE ECHO  (Space-Echo style: saturating, filtered feedback loop,   */
/* wow & flutter, self-oscillation, pitch-glide on time changes)       */
/* ------------------------------------------------------------------ */
export class TapeEcho {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.inGate = ctx.createGain();
    this.output = ctx.createGain();

    this.delay = ctx.createDelay(4.0);
    this.delay.delayTime.value = 0.375;

    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 120;
    this.hp.Q.value = 0.6;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 4500;
    this.lp.Q.value = 0.5;

    this.driveIn = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = (() => {
      const n = 4096, c = new Float32Array(n);
      for (let i = 0; i < n; i++) { const u = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(4 * u); }
      return c;
    })();
    this.shaper.oversample = '2x';
    this.driveOut = ctx.createGain();
    this.fb = ctx.createGain();
    this.fb.gain.value = 0.5;

    // input -> gate -> delay
    this.input.connect(this.inGate).connect(this.delay);
    // feedback: delay -> hp -> lp -> drive -> fb -> delay
    this.delay.connect(this.hp).connect(this.lp).connect(this.driveIn).connect(this.shaper)
      .connect(this.driveOut).connect(this.fb).connect(this.delay);

    // output (stereo spread with Haas delay on the right side)
    this.merger = ctx.createChannelMerger(2);
    this.haas = ctx.createDelay(0.05);
    this.mono = ctx.createGain();
    this.mono.channelCount = 1;
    this.mono.channelCountMode = 'explicit';
    this.mono.channelInterpretation = 'speakers';
    this.lp.connect(this.mono);
    this.mono.connect(this.merger, 0, 0);
    this.mono.connect(this.haas).connect(this.merger, 0, 1);
    this.merger.connect(this.output);

    // wow & flutter
    this.wowOsc = ctx.createOscillator();
    this.wowOsc.frequency.value = 0.55;
    this.wowGain = ctx.createGain();
    this.wowGain.gain.value = 0;
    this.flutOsc = ctx.createOscillator();
    this.flutOsc.frequency.value = 6.3;
    this.flutGain = ctx.createGain();
    this.flutGain.gain.value = 0;
    this.wowOsc.connect(this.wowGain).connect(this.delay.delayTime);
    this.flutOsc.connect(this.flutGain).connect(this.delay.delayTime);
    this.wowOsc.start();
    this.flutOsc.start();

    this.params = { time: 0.375, feedback: 0.5, tone: 0, wow: 0.2, drive: 0.3, spread: 0.4 };
    this.frozen = false;
    this.setDrive(0.3);
    this.setWow(0.2);
    this.setSpread(0.4);
  }

  setTime(sec, glide = 0.09) {
    this.params.time = clamp(sec, 0.01, 3.9);
    smooth(this.delay.delayTime, this.params.time, this.ctx, glide);
  }
  setFeedback(v) {
    this.params.feedback = clamp(v, 0, 1.2);
    if (!this.frozen) smooth(this.fb.gain, this.params.feedback, this.ctx, 0.03);
  }
  // tone: -1 (dark/dub) .. +1 (thin/bright)
  setTone(v) {
    this.params.tone = clamp(v, -1, 1);
    const t = this.params.tone;
    const lpF = t < 0 ? 4500 * Math.pow(2, t * 3.2) : 4500 * Math.pow(2, t * 1.6);
    const hpF = t > 0 ? 120 * Math.pow(2, t * 2.6) : 120 * Math.pow(2, t * 1.2);
    smooth(this.lp.frequency, lpF, this.ctx, 0.04);
    smooth(this.hp.frequency, hpF, this.ctx, 0.04);
  }
  setWow(v) {
    this.params.wow = clamp(v, 0, 1);
    smooth(this.wowGain.gain, this.params.wow * 0.0045, this.ctx, 0.05);
    smooth(this.flutGain.gain, this.params.wow * 0.0006, this.ctx, 0.05);
  }
  setDrive(v) {
    this.params.drive = clamp(v, 0, 1);
    const d = 0.35 + this.params.drive * 2.4;
    smooth(this.driveIn.gain, d * 0.25, this.ctx); // curve slope is 4 at 0
    smooth(this.driveOut.gain, 1 / d, this.ctx);
  }
  setSpread(v) {
    this.params.spread = clamp(v, 0, 1);
    smooth(this.haas.delayTime, this.params.spread * 0.022, this.ctx, 0.05);
  }
  freeze(on) {
    this.frozen = on;
    smooth(this.inGate.gain, on ? 0 : 1, this.ctx, 0.01);
    smooth(this.fb.gain, on ? 1.0 : this.params.feedback, this.ctx, 0.02);
  }
  // kill all echoes immediately
  clear() {
    const now = this.ctx.currentTime;
    this.fb.gain.cancelScheduledValues(now);
    this.fb.gain.setValueAtTime(0, now);
    this.output.gain.setTargetAtTime(0, now, 0.01);
    this.output.gain.setTargetAtTime(1, now + 0.25 + this.params.time, 0.01);
    this.fb.gain.setTargetAtTime(this.frozen ? 1 : this.params.feedback, now + 0.25 + this.params.time, 0.01);
  }
}

/* ------------------------------------------------------------------ */
/* SPRING REVERB (synthesised dispersive spring impulse response,      */
/* A/B convolvers for click-free re-generation, "spring crash")       */
/* ------------------------------------------------------------------ */
// IR energy per channel (sum of squares): 0.16 gives ~0 dB of reverb gain on music-like input
export const SPRING_IR_ENERGY = 0.16;

export class SpringReverb {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.pre = ctx.createBiquadFilter();
    this.pre.type = 'highpass';
    this.pre.frequency.value = 180;
    this.input.connect(this.pre);

    this.convA = ctx.createConvolver();
    this.convB = ctx.createConvolver();
    this.convA.normalize = false;
    this.convB.normalize = false;
    this.gA = ctx.createGain();
    this.gB = ctx.createGain();
    this.gB.gain.value = 0;
    this.pre.connect(this.convA).connect(this.gA);
    this.pre.connect(this.convB).connect(this.gB);

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 5200;
    this.tone.Q.value = 0.4;
    this.body = ctx.createBiquadFilter();
    this.body.type = 'peaking';
    this.body.frequency.value = 900;
    this.body.Q.value = 1.1;
    this.body.gain.value = 4;
    this.gA.connect(this.tone);
    this.gB.connect(this.tone);
    this.tone.connect(this.body).connect(this.output);

    this.active = 'A';
    this.params = { decay: 2.4, drip: 0.55, tone: 0 };
    this._timer = null;
    this.convA.buffer = this.makeIR(this.params.decay, this.params.drip);
  }

  makeIR(decay, drip) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * Math.min(6, decay + 0.3));
    const ir = this.ctx.createBuffer(2, len, sr);
    let seed = 1234567;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      // two springs with different transit times (classic 2-spring tank)
      const periods = ch === 0 ? [0.0331, 0.0413] : [0.0352, 0.0389];
      // diffuse tail
      let lpState = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const env = Math.exp((-6.9 * t) / decay);
        lpState += 0.35 * (rnd() - lpState);
        d[i] = lpState * env * 0.18 * (1 - drip * 0.5);
      }
      // dispersive chirps: high frequencies arrive before low ones
      for (const P of periods) {
        const chirpLen = Math.floor(P * sr * 0.9);
        for (let n = 0; ; n++) {
          const t0 = P * (n + 0.35);
          const start = Math.floor(t0 * sr);
          if (start >= len) break;
          const amp = Math.exp((-6.9 * t0) / decay) * 0.5 * drip * (n % 2 ? -1 : 1);
          let ph = 0;
          for (let i = 0; i < chirpLen && start + i < len; i++) {
            const u = i / chirpLen;
            const f = 3800 * Math.pow(0.06, u); // 3.8k -> ~230 Hz downward sweep
            ph += (2 * Math.PI * f) / sr;
            const w = Math.sin(Math.PI * u);
            d[start + i] += Math.sin(ph) * amp * w * w;
          }
        }
      }
    }
    // normalise the IR energy so the reverb level no longer jumps with decay/drip
    // (unnormalised it ranged from +17 dB to +40 dB of gain and slammed the limiter)
    let e = 0;
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) e += d[i] * d[i]; }
    const k = Math.sqrt((2 * SPRING_IR_ENERGY) / (e || 1));
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] *= k; }
    return ir;
  }

  _regen() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      const buf = this.makeIR(this.params.decay, this.params.drip);
      const now = this.ctx.currentTime;
      const [incoming, inGain, outGain] = this.active === 'A'
        ? [this.convB, this.gB, this.gA]
        : [this.convA, this.gA, this.gB];
      incoming.buffer = buf;
      inGain.gain.cancelScheduledValues(now);
      outGain.gain.cancelScheduledValues(now);
      inGain.gain.setTargetAtTime(1, now + 0.02, 0.08);
      outGain.gain.setTargetAtTime(0, now + 0.02, 0.08);
      this.active = this.active === 'A' ? 'B' : 'A';
    }, 140);
  }
  setDecay(sec) { this.params.decay = clamp(sec, 0.4, 5.5); this._regen(); }
  setDrip(v) { this.params.drip = clamp(v, 0, 1); this._regen(); }
  setTone(v) {
    this.params.tone = clamp(v, -1, 1);
    smooth(this.tone.frequency, 5200 * Math.pow(2, this.params.tone * 1.7), this.ctx, 0.04);
  }
  // silence the tail that is still ringing (output comes back once the tail has died away)
  clear() {
    const now = this.ctx.currentTime;
    const tail = Math.min(6, this.params.decay + 0.3);
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setTargetAtTime(0, now, 0.02);
    this.output.gain.setTargetAtTime(1, now + tail, 0.05);
  }
  // physically kicking the spring tank
  crash(strength = 1) {
    const ctx = this.ctx, sr = ctx.sampleRate;
    const len = Math.floor(sr * 0.09);
    const b = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        d[i] = ((Math.random() * 2 - 1) * Math.exp(-t * 60) + Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t * 30)) * 0.9;
      }
    }
    const s = ctx.createBufferSource();
    s.buffer = b;
    const g = ctx.createGain();
    g.gain.value = (2.3 * strength) / Math.sqrt(SPRING_IR_ENERGY); // keeps the crash peak ~1 with the normalised IR
    s.connect(g).connect(this.convA);
    g.connect(this.convB);
    s.start();
    s.onended = () => g.disconnect();
  }
}

/* ------------------------------------------------------------------ */
/* BI-PHASE (6-stage modulated all-pass phaser, master insert)         */
/* ------------------------------------------------------------------ */
export class Phaser {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.sum = ctx.createGain();
    this.fbDelay = ctx.createDelay(0.01);
    this.fbDelay.delayTime.value = 0;
    this.fb = ctx.createGain();
    this.fb.gain.value = 0;

    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.25;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 700;
    this.lfo.connect(this.lfoDepth);
    this.lfo.start();

    this.stages = [];
    let prev = this.sum;
    this.input.connect(this.sum);
    for (let i = 0; i < 6; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = 900;
      ap.Q.value = 0.55;
      this.lfoDepth.connect(ap.frequency);
      prev.connect(ap);
      prev = ap;
      this.stages.push(ap);
    }
    prev.connect(this.wet);
    prev.connect(this.fbDelay).connect(this.fb).connect(this.sum);
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.wet.connect(this.output);
    this.params = { rate: 0.25, depth: 0.7, feedback: 0.3, mix: 0, center: 0.5 };
    this.setDepth(0.7);
  }
  setRate(hz) { this.params.rate = clamp(hz, 0.02, 8); smooth(this.lfo.frequency, this.params.rate, this.ctx, 0.05); }
  setDepth(v) {
    this.params.depth = clamp(v, 0, 1);
    const c = 200 * Math.pow(2, this.params.center * 4.5);
    smooth(this.lfoDepth.gain, c * 0.92 * this.params.depth, this.ctx, 0.05);
    this.stages.forEach((s) => smooth(s.frequency, c, this.ctx, 0.05));
  }
  setCenter(v) { this.params.center = clamp(v, 0, 1); this.setDepth(this.params.depth); }
  setFeedback(v) { this.params.feedback = clamp(v, 0, 0.85); smooth(this.fb.gain, this.params.feedback, this.ctx); }
  setMix(v) {
    this.params.mix = clamp(v, 0, 1);
    smooth(this.wet.gain, this.params.mix * 0.75, this.ctx, 0.03);
    smooth(this.dry.gain, 1 - this.params.mix * 0.25, this.ctx, 0.03);
  }
}

/* ------------------------------------------------------------------ */
/* DUB SIREN  (NJD-style: VCO + LFO, hold to sound, release sweep)    */
/* ------------------------------------------------------------------ */
export const SIREN_PRESETS = {
  'CLASSIC':    { wave: 'square',   lfoWave: 'square',   pitch: 620,  rate: 5.5, depth: 0.55, decay: 0.9, sweep: 0.35 },
  'RISER':      { wave: 'sawtooth', lfoWave: 'sawtooth', pitch: 380,  rate: 2.2, depth: 0.9,  decay: 1.2, sweep: 0.2 },
  'LASER':      { wave: 'square',   lfoWave: 'sawdown',  pitch: 900,  rate: 9,   depth: 1.0,  decay: 0.5, sweep: 0.6 },
  'WARBLE':     { wave: 'sine',     lfoWave: 'sine',     pitch: 780,  rate: 7.5, depth: 0.35, decay: 1.4, sweep: 0.1 },
  'ALARM':      { wave: 'triangle', lfoWave: 'triangle', pitch: 520,  rate: 1.6, depth: 0.8,  decay: 0.7, sweep: 0 },
  'DEEP SIREN': { wave: 'sawtooth', lfoWave: 'sine',     pitch: 160,  rate: 0.6, depth: 0.9,  decay: 1.8, sweep: 0.5 },
  'BIRD':       { wave: 'sine',     lfoWave: 'square',   pitch: 1500, rate: 14,  depth: 0.25, decay: 0.4, sweep: 0.2 },
  'SPACESHIP':  { wave: 'square',   lfoWave: 'sine',     pitch: 300,  rate: 0.25, depth: 1.0, decay: 2.5, sweep: 0.8 },
};

export class DubSiren {
  constructor(ctx) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0.5;
    this.vco = ctx.createOscillator();
    this.vco.type = 'square';
    this.vco.frequency.value = 620;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'square';
    this.lfo.frequency.value = 5.5;
    this.lfoAmt = ctx.createGain();
    this.lfoAmt.gain.value = 0;
    this.lfoSign = ctx.createGain();
    this.lfoSign.gain.value = 1;
    this.lfo.connect(this.lfoSign).connect(this.lfoAmt).connect(this.vco.detune);
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 5000;
    this.env = ctx.createGain();
    this.env.gain.value = 0;
    this.vco.connect(this.tone).connect(this.env).connect(this.output);
    this.vco.start();
    this.lfo.start();
    this.p = { ...SIREN_PRESETS.CLASSIC };
    this.held = 0;
    this.apply(this.p);
  }
  apply(p) {
    Object.assign(this.p, p);
    const { wave, lfoWave, pitch, rate, depth } = this.p;
    this.vco.type = wave;
    this.lfo.type = lfoWave === 'sawdown' ? 'sawtooth' : lfoWave;
    this.lfoSign.gain.value = lfoWave === 'sawdown' ? -1 : 1;
    smooth(this.vco.frequency, pitch, this.ctx, 0.01);
    smooth(this.lfo.frequency, rate, this.ctx, 0.01);
    smooth(this.lfoAmt.gain, depth * 1200, this.ctx, 0.01);
    this.tone.frequency.value = wave === 'sine' ? 12000 : 4200;
  }
  set(key, v) { this.apply({ [key]: v }); }
  on() {
    const now = this.ctx.currentTime;
    this.held++;
    this.vco.frequency.cancelScheduledValues(now);
    this.vco.frequency.setValueAtTime(this.p.pitch, now);
    // restart LFO phase feel by nudging rate (oscillator phase can't be reset)
    this.env.gain.cancelScheduledValues(now);
    this.env.gain.setTargetAtTime(0.42, now, 0.006);
  }
  off() {
    this.held = Math.max(0, this.held - 1);
    if (this.held) return;
    const now = this.ctx.currentTime;
    const d = this.p.decay;
    this.env.gain.cancelScheduledValues(now);
    this.env.gain.setTargetAtTime(0, now, d / 4.5);
    if (this.p.sweep > 0) {
      this.vco.frequency.cancelScheduledValues(now);
      this.vco.frequency.setValueAtTime(this.p.pitch, now);
      this.vco.frequency.setTargetAtTime(this.p.pitch * (1 - 0.85 * this.p.sweep), now, d / 3);
    }
  }
}

/* ------------------------------------------------------------------ */
/* ONE-SHOT SOUND SYSTEM FX (all synthesised, no samples needed)      */
/* ------------------------------------------------------------------ */
function noiseBuffer(ctx, sec) {
  const len = Math.floor(ctx.sampleRate * sec);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

let _drive;
function driveCurve() {
  if (!_drive) _drive = tanhCurve();
  return _drive;
}

export const SFX = {
  AIRHORN(ctx, out) {
    const t0 = ctx.currentTime + 0.01;
    const blasts = [[0, 0.11], [0.15, 0.11], [0.3, 0.11], [0.45, 0.65]];
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.6;
    const hs = ctx.createBiquadFilter();
    hs.type = 'peaking'; hs.frequency.value = 2800; hs.gain.value = 6;
    const g = ctx.createGain();
    g.gain.value = 0;
    const master = ctx.createGain();
    master.gain.value = 0.32;
    g.connect(shaper).connect(bp).connect(hs).connect(master).connect(out);
    const freqs = [413, 418, 553, 557];
    const oscs = freqs.map((f) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(g);
      return o;
    });
    for (const [s, d] of blasts) {
      g.gain.setValueAtTime(0, t0 + s);
      g.gain.linearRampToValueAtTime(1.6, t0 + s + 0.012);
      g.gain.setValueAtTime(1.6, t0 + s + d - 0.02);
      g.gain.linearRampToValueAtTime(0, t0 + s + d);
      oscs.forEach((o, i) => {
        o.frequency.setValueAtTime(freqs[i] * 0.94, t0 + s);
        o.frequency.exponentialRampToValueAtTime(freqs[i], t0 + s + 0.05);
      });
    }
    const end = t0 + 1.2;
    oscs.forEach((o) => { o.start(t0); o.stop(end); });
    oscs[0].onended = () => master.disconnect();
  },

  GUNSHOT(ctx, out) {
    const t0 = ctx.currentTime + 0.005;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 0.6);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(7000, t0);
    lp.frequency.exponentialRampToValueAtTime(600, t0 + 0.35);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(1.3, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
    n.connect(lp).connect(ng).connect(out);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t0);
    o.frequency.exponentialRampToValueAtTime(38, t0 + 0.18);
    const og = ctx.createGain();
    og.gain.setValueAtTime(1.4, t0);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
    o.connect(og).connect(out);
    n.start(t0); o.start(t0); o.stop(t0 + 0.35);
  },

  LASER(ctx, out) {
    const t0 = ctx.currentTime + 0.005;
    for (let k = 0; k < 3; k++) {
      const s = t0 + k * 0.16;
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(2600, s);
      o.frequency.exponentialRampToValueAtTime(110, s + 0.14);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22, s);
      g.gain.exponentialRampToValueAtTime(0.001, s + 0.15);
      o.connect(g).connect(out);
      o.start(s); o.stop(s + 0.16);
    }
  },

  BOMB(ctx, out) {
    const t0 = ctx.currentTime + 0.005;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t0);
    lp.frequency.exponentialRampToValueAtTime(120, t0 + 2.2);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(1.6, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 2.8);
    n.connect(lp).connect(ng).connect(out);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t0);
    o.frequency.exponentialRampToValueAtTime(28, t0 + 1.5);
    const og = ctx.createGain();
    og.gain.setValueAtTime(1.8, t0);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 2);
    o.connect(og).connect(out);
    n.start(t0); o.start(t0); o.stop(t0 + 2.1);
  },

  ZAP(ctx, out) {
    const t0 = ctx.currentTime + 0.005;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(60, t0);
    o.frequency.exponentialRampToValueAtTime(3200, t0 + 0.4);
    const m = ctx.createOscillator();
    m.frequency.value = 38;
    const mg = ctx.createGain();
    mg.gain.value = 400;
    m.connect(mg).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
    o.connect(g).connect(out);
    o.start(t0); m.start(t0); o.stop(t0 + 0.46); m.stop(t0 + 0.46);
  },

  RISER(ctx, out) {
    const t0 = ctx.currentTime + 0.005;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 4);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(200, t0);
    bp.frequency.exponentialRampToValueAtTime(9000, t0 + 3.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.7, t0 + 3.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.95);
    n.connect(bp).connect(g).connect(out);
    n.start(t0);
  },

  SUBDROP(ctx, out) {
    const t0 = ctx.currentTime + 0.005;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t0);
    o.frequency.exponentialRampToValueAtTime(32, t0 + 1.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(1.1, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 2.2);
    const sh = ctx.createWaveShaper();
    sh.curve = driveCurve();
    o.connect(sh).connect(g).connect(out);
    o.start(t0); o.stop(t0 + 2.25);
  },

  RIMSHOT(ctx, out) {
    const t0 = ctx.currentTime + 0.003;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 1700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 0.08);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.6, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.06);
    o.connect(g).connect(out);
    n.connect(hp).connect(ng).connect(out);
    o.start(t0); o.stop(t0 + 0.06); n.start(t0);
  },
};

export function softClipCurve(n = 8192) {
  const c = new Float32Array(n);
  const th = 0.86;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 4 - 2;
    const a = Math.abs(x);
    let y = a <= th ? a : th + (1 - th) * Math.tanh((a - th) / (1 - th));
    c[i] = Math.sign(x) * Math.min(y, 0.995);
  }
  return c;
}
