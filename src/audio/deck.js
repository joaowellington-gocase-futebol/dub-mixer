// DUB-MIXER deck + channel strip: playback, cues, loops, rewind/brake, stems, EQ, big-knob filter, sends.
import { dbToGain } from './fx.js';
import { separateBuffer } from './ai.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const STEM_NAMES = ['VOCAL', 'DRUMS', 'BASS', 'OTHER'];
// Latency of the DSP stem worklet (N + LA*H samples). The AI path is delayed by the same amount
// so a deck keeps its timing when switching modes and stays in sync with the other decks.
export const STEM_LATENCY = 3072;

// AI mode plays the original mix + vocal/drums/bass stems; OTHER is the residual
// (mix - vocal - drums - bass), so at unity it reconstructs the original exactly.
// gains = effective [vocal, drums, bass, other] -> source gains [mix, vocal, drums, bass]
export function aiSourceGains(g) {
  return [g[3], g[0] - g[3], g[1] - g[3], g[2] - g[3]];
}

export class Deck {
  constructor(engine, index) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.index = index;
    const ctx = this.ctx;

    this.buffer = null;
    this.meta = null;
    this.peaks = null;
    this.bpm = 0;
    this.playing = false;
    this.pos = 0;
    this.rate = 1;
    this.src = null;
    this.cuePoint = 0;
    this.hotCues = [null, null, null, null];
    this.loop = null; // {start, end}
    this.busyFx = false;
    this.autoRestart = true;

    // ---- graph
    this.srcBus = ctx.createGain();
    this.splitter = new AudioWorkletNode(ctx, 'stem-splitter', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    this.stemGains = [1, 1, 1, 1];
    this.stemKill = [false, false, false, false];
    this.trim = ctx.createGain();
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 10;
    this.hpf.Q.value = 0.707;
    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 22000;
    this.lpf.Q.value = 0.707;
    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf'; this.eqLow.frequency.value = 110;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking'; this.eqMid.frequency.value = 1000; this.eqMid.Q.value = 0.7;
    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf'; this.eqHigh.frequency.value = 6500;
    this.pan = ctx.createStereoPanner();
    this.fader = ctx.createGain();
    this.muteGain = ctx.createGain();
    this.sendEcho = ctx.createGain();
    this.sendEcho.gain.value = 0;
    this.sendRev = ctx.createGain();
    this.sendRev.gain.value = 0;
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 1024;

    // AI stems path (desktop): mix + stem sources -> gains -> latency match -> trim
    this.ai = null;          // { vocal, drums, bass } AudioBuffers for this.buffer
    this.aiOn = false;
    this.aiJob = null;       // { stage, p, cancel }
    this.stemSrcs = [];
    this.aiBus = ctx.createGain();
    this.aiDelay = ctx.createDelay(1);
    this.aiDelay.delayTime.value = STEM_LATENCY / ctx.sampleRate;
    this.aiGains = [0, 1, 2, 3].map(() => { const g = ctx.createGain(); g.connect(this.aiBus); return g; });
    this.aiBus.connect(this.aiDelay).connect(this.trim);

    this.srcBus.connect(this.splitter).connect(this.trim).connect(this.hpf).connect(this.lpf)
      .connect(this.eqLow).connect(this.eqMid).connect(this.eqHigh)
      .connect(this.pan).connect(this.fader).connect(this.muteGain);
    this.muteGain.connect(engine.channelsBus);
    this.muteGain.connect(this.sendEcho).connect(engine.echoIn);
    this.muteGain.connect(this.sendRev).connect(engine.revIn);
    this.muteGain.connect(this.meter);

    this.eqDb = { low: 0, mid: 0, high: 0 };
    this.eqKill = { low: false, mid: false, high: false };
    this.sendLevels = { echo: 0, rev: 0 };
    this.throwing = { echo: false, rev: false };
    this.mute = false;
    this.solo = false;
    this.faderValue = 0.8;
    this.setFader(0.8);
    this._mbuf = new Float32Array(1024);
  }

  // ------------------------------------------------------------ loading
  load(buffer, meta = {}) {
    this.stop(true);
    this._dropAi();
    this.buffer = buffer;
    this.meta = { name: meta.name || 'Untitled', ...meta };
    this.pos = 0;
    this.cuePoint = 0;
    this.hotCues = [null, null, null, null];
    this.loop = null;
    this.bpm = meta.bpm || 0;
    this.peaks = computePeaks(buffer);
    this.engine.emit('deck-load', this);
  }
  eject() {
    this.stop(true);
    this._dropAi();
    this.buffer = null;
    this.meta = null;
    this.peaks = null;
    this.bpm = 0;
    this.engine.emit('deck-load', this);
  }
  get duration() { return this.buffer ? this.buffer.duration : 0; }

  // ------------------------------------------------------------ transport
  get position() {
    if (!this.playing || !this.src) return this.pos;
    let p = this.startOff + (this.ctx.currentTime - this.startCtx) * this.rate;
    if (this.loop && p > this.loop.end) {
      const L = this.loop.end - this.loop.start;
      p = this.loop.start + ((p - this.loop.start) % L);
    }
    return clamp(p, 0, this.duration);
  }

  _startSource(offset, when = 0) {
    const ctx = this.ctx;
    const t = Math.max(ctx.currentTime, when || ctx.currentTime);
    const off = clamp(offset, 0, Math.max(0, this.duration - 0.001));
    const make = (buffer, dest) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.playbackRate.value = this.rate;
      if (this.loop) {
        s.loop = true;
        s.loopStart = this.loop.start;
        s.loopEnd = this.loop.end;
      }
      s._dest = dest;
      s.connect(dest);
      s.start(t, off);
      return s;
    };
    const useAi = this.aiOn && this.ai;
    const src = make(this.buffer, useAi ? this.aiGains[0] : this.srcBus);
    this.stemSrcs = useAi
      ? [this.ai.vocal, this.ai.drums, this.ai.bass].map((b, k) => make(b, this.aiGains[k + 1]))
      : [];
    src.onended = () => {
      if (this.src !== src) return;
      this.playing = false;
      this.src = null;
      this.stemSrcs = [];
      this.pos = 0;
      this.engine.emit('deck-state', this);
    };
    this.src = src;
    this.startCtx = t;
    this.startOff = offset;
  }

  _allSrcs() { return this.src ? [this.src, ...this.stemSrcs] : []; }

  _killSource(fade = 0.006) {
    const all = this._allSrcs();
    if (!all.length) return;
    this.src = null;
    this.stemSrcs = [];
    // tiny de-click fade (same ramp on every source so the AI stems stay complementary)
    const now = this.ctx.currentTime;
    for (const s of all) {
      s.onended = null;
      const g = this.ctx.createGain();
      try {
        s.disconnect();
        s.connect(g).connect(s._dest || this.srcBus);
        g.gain.setValueAtTime(1, now);
        g.gain.linearRampToValueAtTime(0, now + fade);
        s.stop(now + fade + 0.002);
        s.onended = () => g.disconnect();
      } catch (e) { /* already stopped */ }
    }
  }

  play() {
    if (!this.buffer || this.playing || this.busyFx) return;
    this.engine.resume();
    if (this.pos >= this.duration - 0.01) this.pos = 0;
    this._startSource(this.pos);
    this.playing = true;
    this.engine.emit('deck-state', this);
  }
  pause() {
    if (!this.playing) return;
    this.pos = this.position;
    this._killSource();
    this.playing = false;
    this.engine.emit('deck-state', this);
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  stop(silent) {
    this.busyFx = false;
    if (this._fxTimer) { clearTimeout(this._fxTimer); this._fxTimer = null; }
    if (this._fxSrc) { try { this._fxSrc.stop(); } catch (e) { /* noop */ } this._fxSrc = null; }
    this._killSource();
    this.playing = false;
    this.pos = 0;
    if (!silent) this.engine.emit('deck-state', this);
  }
  seek(t) {
    if (!this.buffer) return;
    t = clamp(t, 0, this.duration - 0.01);
    if (this.loop && (t < this.loop.start || t > this.loop.end)) this.loop = null;
    if (this.playing) {
      this._killSource();
      this._startSource(t);
    } else {
      this.pos = t;
    }
    this.engine.emit('deck-state', this);
  }
  cue() {
    if (!this.buffer) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cuePoint);
    } else {
      this.cuePoint = this.position;
      this.engine.emit('deck-state', this);
    }
  }
  hotCue(i, clear = false) {
    if (!this.buffer) return;
    if (clear) { this.hotCues[i] = null; this.engine.emit('deck-state', this); return; }
    if (this.hotCues[i] == null) {
      this.hotCues[i] = this.position;
      this.engine.emit('deck-state', this);
    } else {
      this.seek(this.hotCues[i]);
      if (!this.playing) this.play();
    }
  }

  setRate(r) {
    r = clamp(r, 0.5, 1.5);
    if (this.playing && this.src) {
      const p = this.position;
      this.startOff = p;
      this.startCtx = this.ctx.currentTime;
      for (const s of this._allSrcs()) s.playbackRate.setValueAtTime(r, this.ctx.currentTime);
    }
    this.rate = r;
    this.engine.emit('deck-rate', this);
  }
  get effectiveBpm() { return this.bpm ? this.bpm * this.rate : 0; }
  sync() {
    if (!this.bpm) return;
    const target = this.engine.bpm;
    let r = target / this.bpm;
    // allow half/double time matching (one-drop vs steppers)
    if (r > 1.45) r /= 2;
    if (r < 0.6) r *= 2;
    this.setRate(r);
  }

  // ------------------------------------------------------------ loops
  beatLen() { return 60 / (this.bpm || this.engine.bpm); }
  setLoopBeats(beats) {
    if (!this.buffer) return;
    const start = this.loop ? this.loop.start : this.position;
    const end = Math.min(this.duration, start + beats * this.beatLen());
    this.setLoop(start, end, beats);
  }
  setLoop(start, end, beats = null) {
    if (end - start < 0.02) return;
    const p = this.position;
    this.loop = { start, end, beats };
    if (this.playing && this.src) {
      this.startOff = p;
      this.startCtx = this.ctx.currentTime;
      for (const s of this._allSrcs()) {
        s.loopStart = start;
        s.loopEnd = end;
        s.loop = true;
      }
      if (p > end || p < start) this.seek(start);
    }
    this.engine.emit('deck-state', this);
  }
  exitLoop() {
    if (!this.loop) return;
    const p = this.position;
    this.loop = null;
    if (this.playing && this.src) {
      for (const s of this._allSrcs()) s.loop = false;
      this.startOff = p;
      this.startCtx = this.ctx.currentTime;
    }
    this.engine.emit('deck-state', this);
  }

  // ------------------------------------------------------------ dub transport FX
  brake(time = 1.1) {
    if (!this.playing || !this.src || this.busyFx) return;
    const now = this.ctx.currentTime;
    const p = this.position;
    for (const s of this._allSrcs()) {
      s.playbackRate.cancelScheduledValues(now);
      s.playbackRate.setValueAtTime(this.rate, now);
      s.playbackRate.linearRampToValueAtTime(0.001, now + time);
    }
    this.busyFx = true;
    this._fxTimer = setTimeout(() => {
      this._fxTimer = null;
      this.busyFx = false;
      this.pos = clamp(p + this.rate * time * 0.5, 0, this.duration);
      this._killSource();
      this.playing = false;
      this.engine.emit('deck-state', this);
    }, time * 1000);
    this.engine.emit('deck-state', this);
  }

  // Sound system "rewind / pull up": spin back then come again from the cue
  rewind(spin = 1.3) {
    if (!this.buffer || this.busyFx) return;
    const ctx = this.ctx;
    const sr = this.buffer.sampleRate;
    const p = this.position;
    const back = Math.min(p, 9);
    const n = Math.floor(back * sr);
    this._killSource(0.003);
    this.playing = false;
    if (n > sr * 0.2) {
      const rev = ctx.createBuffer(this.buffer.numberOfChannels, n, sr);
      const end = Math.floor(p * sr);
      for (let ch = 0; ch < this.buffer.numberOfChannels; ch++) {
        const src = this.buffer.getChannelData(ch);
        const dst = rev.getChannelData(ch);
        for (let i = 0; i < n; i++) dst[i] = src[end - 1 - i] || 0;
      }
      const s = ctx.createBufferSource();
      s.buffer = rev;
      const g = ctx.createGain();
      const now = ctx.currentTime;
      s.playbackRate.setValueAtTime(0.6, now);
      s.playbackRate.exponentialRampToValueAtTime(5.5, now + spin * 0.75);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(1, now + 0.04);
      g.gain.setValueAtTime(1, now + spin * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, now + spin);
      s.connect(g).connect(this.srcBus);
      s.start(now);
      s.stop(now + spin + 0.02);
      s.onended = () => g.disconnect();
      this._fxSrc = s;
    }
    this.busyFx = true;
    this.engine.emit('deck-state', this);
    this._fxTimer = setTimeout(() => {
      this._fxTimer = null;
      this._fxSrc = null;
      this.busyFx = false;
      this.loop = null;
      this.pos = this.cuePoint || 0;
      if (this.autoRestart) this.play();
      else this.engine.emit('deck-state', this);
    }, (spin + 0.35) * 1000);
  }

  // ------------------------------------------------------------ stems
  setStemGain(i, v) {
    this.stemGains[i] = clamp(v, 0, 1.5);
    this._sendStems();
  }
  setStemKill(i, on) {
    this.stemKill[i] = on;
    this._sendStems();
  }
  stemMode(mode) {
    const presets = {
      FULL: [false, false, false, false],
      DUB: [true, false, false, true],      // drum & bass
      INST: [true, false, false, false],     // instrumental
      ACAP: [false, true, true, true],       // acapella
      RIDDIM: [true, true, false, true],     // bass only
      DRUMS: [true, false, true, true],      // drums only
    }[mode];
    if (!presets) return;
    this.stemKill = presets.slice();
    this._sendStems();
    this.engine.emit('deck-stems', this);
  }
  _sendStems() {
    const gains = this.stemGains.map((g, i) => (this.stemKill[i] ? 0 : g));
    this.splitter.port.postMessage({ gains });
    const now = this.ctx.currentTime;
    aiSourceGains(gains).forEach((v, k) => this.aiGains[k].gain.setTargetAtTime(v, now, 0.01));
  }

  // ------------------------------------------------------------ AI stems (desktop)
  // Separate the loaded track with htdemucs, then switch this deck to the AI stems.
  async runAi() {
    if (!this.buffer || this.aiJob) return;
    if (this.ai) { this.setAiMode(true); return; }
    const buffer = this.buffer;
    const job = separateBuffer(this.ctx, buffer, ({ stage, p }) => {
      if (this.aiJob !== state) return;
      state.stage = stage;
      state.p = p;
      this.engine.emit('deck-ai', this);
    });
    const state = { stage: 'queued', p: 0, cancel: job.cancel };
    this.aiJob = state;
    this.engine.emit('deck-ai', this);
    try {
      const stems = await job.promise;
      if (this.aiJob !== state || this.buffer !== buffer) return;
      this.aiJob = null;
      this.ai = stems;
      this.setAiMode(true);
      this.engine.emit('deck-ai-done', this);
    } catch (e) {
      if (this.aiJob !== state) return;
      this.aiJob = null;
      this.engine.emit('deck-ai', this);
      if (!e.canceled) this.engine.emit('deck-ai-error', { deck: this, error: e });
    }
  }
  cancelAi() {
    const j = this.aiJob;
    if (!j) return;
    this.aiJob = null;
    j.cancel();
    this.engine.emit('deck-ai', this);
  }
  // on = play the AI stems (if separated), off = real-time DSP splitter
  setAiMode(on) {
    on = !!on && !!this.ai;
    if (on === this.aiOn) return;
    this.aiOn = on;
    if (this.playing && this.src && !this.busyFx) {
      const p = this.position;
      this._killSource();
      this._startSource(p);
    }
    this.engine.emit('deck-ai', this);
  }
  _dropAi() {
    if (this.aiJob) { const j = this.aiJob; this.aiJob = null; j.cancel(); }
    this.ai = null;
    this.aiOn = false;
  }

  // ------------------------------------------------------------ channel strip
  setTrim(db) { this.trim.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.02); }
  setFader(v) {
    this.faderValue = clamp(v, 0, 1);
    // console-style taper: 0.8 = 0 dB, 1.0 = +6 dB
    const x = this.faderValue;
    const g = x <= 0 ? 0 : x < 0.8 ? Math.pow(x / 0.8, 2.6) : dbToGain((x - 0.8) * 30);
    this.fader.gain.setTargetAtTime(g, this.ctx.currentTime, 0.012);
  }
  setPan(v) { this.pan.pan.setTargetAtTime(clamp(v, -1, 1), this.ctx.currentTime, 0.02); }
  // "big knob" high-pass filter (Altec-style): 0 = off .. 1 = 4 kHz
  setHpf(v) {
    const f = v <= 0.001 ? 10 : 20 * Math.pow(200, v);
    this.hpf.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.015);
    this.hpfValue = v;
  }
  setLpf(v) {
    // 0 = open .. 1 = 150 Hz
    const f = v <= 0.001 ? 22000 : 22000 * Math.pow(150 / 22000, v);
    this.lpf.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.015);
  }
  setFilterRes(v) {
    const q = 0.707 + v * 9;
    this.hpf.Q.setTargetAtTime(q, this.ctx.currentTime, 0.02);
    this.lpf.Q.setTargetAtTime(q, this.ctx.currentTime, 0.02);
  }
  // v: -1..1 (-1 = kill, 0 = flat, +1 = +12 dB)
  setEq(band, v) {
    this.eqDb[band] = v < 0 ? -40 * v * v : 12 * v;
    this._applyEq(band);
  }
  setEqKill(band, on) { this.eqKill[band] = on; this._applyEq(band); }
  _applyEq(band) {
    const node = { low: this.eqLow, mid: this.eqMid, high: this.eqHigh }[band];
    const db = this.eqKill[band] ? -48 : this.eqDb[band];
    node.gain.setTargetAtTime(db, this.ctx.currentTime, 0.012);
  }
  setSend(which, v) {
    this.sendLevels[which] = clamp(v, 0, 1.2);
    if (!this.throwing[which]) this._applySend(which);
  }
  throwSend(which, on) {
    this.throwing[which] = on;
    this._applySend(which);
  }
  _applySend(which) {
    const node = which === 'echo' ? this.sendEcho : this.sendRev;
    const v = this.throwing[which] ? 1.0 : this.sendLevels[which];
    node.gain.setTargetAtTime(v, this.ctx.currentTime, 0.006);
  }
  setMute(on) { this.mute = on; this.engine.refreshMutes(); }
  setSolo(on) { this.solo = on; this.engine.refreshMutes(); }
  applyMute() {
    const silenced = this.mute || (this.engine.anySolo() && !this.solo);
    this.muteGain.gain.setTargetAtTime(silenced ? 0 : 1, this.ctx.currentTime, 0.006);
    this.engine.emit('deck-mute', this);
  }

  level() {
    const b = this._mbuf;
    this.meter.getFloatTimeDomainData(b);
    let peak = 0;
    for (let i = 0; i < b.length; i++) { const a = Math.abs(b[i]); if (a > peak) peak = a; }
    return peak;
  }
}

// --------------------------------------------------------------------------
// Waveform peaks + "bass-ness" per bin (for the red/yellow/green waveform)
export function computePeaks(buffer, binSize = 512) {
  const n = buffer.length;
  const bins = Math.ceil(n / binSize);
  const min = new Float32Array(bins), max = new Float32Array(bins), low = new Float32Array(bins);
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const a = 1 - Math.exp((-2 * Math.PI * 180) / buffer.sampleRate);
  let lp = 0;
  for (let b = 0; b < bins; b++) {
    let mn = 1, mx = -1, eTot = 1e-9, eLow = 0;
    const end = Math.min(n, (b + 1) * binSize);
    for (let i = b * binSize; i < end; i++) {
      const v = (L[i] + R[i]) * 0.5;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      lp += a * (v - lp);
      eLow += lp * lp;
      eTot += v * v;
    }
    min[b] = mn; max[b] = mx;
    low[b] = Math.min(1, eLow / eTot);
  }
  return { min, max, low, binSize, sampleRate: buffer.sampleRate, bins };
}
