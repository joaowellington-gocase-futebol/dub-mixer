// DUB-MIXER audio engine: master bus, FX sends/returns, dub FX, metering and recording.
import stemsSrc from './worklets/stems.js?raw';
import recorderSrc from './worklets/recorder.js?raw';
import { TapeEcho, SpringReverb, Phaser, DubSiren, SFX, softClipCurve, dbToGain } from './fx.js';
import { Deck } from './deck.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function moduleURL(src) {
  return URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
}

export const DIVISIONS = {
  '1/16': 0.25, '1/8': 0.5, '1/8T': 1 / 3, '1/8D': 0.75, '1/4': 1, '1/4T': 2 / 3,
  '1/4D': 1.5, '1/2': 2, '1/2D': 3, '1 BAR': 4,
};

// approximate length of each one-shot (for the "sons tocando" indicator)
const SFX_LEN = { AIRHORN: 1.3, GUNSHOT: 1, LASER: 0.9, BOMB: 3, ZAP: 0.7, RISER: 3, SUBDROP: 2.2, RIMSHOT: 0.4 };

export class Engine {
  constructor() {
    this.ctx = null;
    this.decks = [];
    this.bpm = 75;
    this.echoSync = true;
    this.echoDiv = '1/4D';
    this.echoFreeMs = 375;
    this.recording = false;
    this.recChunks = [];
    this.listeners = new Set();
  }

  async init(numDecks = 4, ctxOverride = null) {
    const ctx = ctxOverride || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(moduleURL(stemsSrc));
    await ctx.audioWorklet.addModule(moduleURL(recorderSrc));

    // ---- busses
    this.channelsBus = ctx.createGain();
    this.mix = ctx.createGain();
    this.echoIn = ctx.createGain();
    this.revIn = ctx.createGain();
    this.channelsBus.connect(this.mix);

    // ---- tape echo
    this.echo = new TapeEcho(ctx);
    this.echoIn.connect(this.echo.input);
    this.echoReturn = ctx.createGain();
    this.echoReturn.gain.value = 0.9;
    this.echo.output.connect(this.echoReturn).connect(this.mix);
    this.echoToRev = ctx.createGain();
    this.echoToRev.gain.value = 0.25;
    this.echo.output.connect(this.echoToRev).connect(this.revIn);

    // ---- spring reverb
    this.spring = new SpringReverb(ctx);
    this.revIn.connect(this.spring.input);
    this.revReturn = ctx.createGain();
    this.revReturn.gain.value = 0.8;
    this.spring.output.connect(this.revReturn).connect(this.mix);

    // ---- master echo throw (whole mix into the echo)
    this.masterThrow = ctx.createGain();
    this.masterThrow.gain.value = 0;
    this.channelsBus.connect(this.masterThrow).connect(this.echoIn);

    // ---- dub siren
    this.siren = new DubSiren(ctx);
    this.sirenEcho = ctx.createGain();
    this.sirenEcho.gain.value = 0.7;
    this.sirenRev = ctx.createGain();
    this.sirenRev.gain.value = 0.25;
    this.siren.output.connect(this.mix);
    this.siren.output.connect(this.sirenEcho).connect(this.echoIn);
    this.siren.output.connect(this.sirenRev).connect(this.revIn);

    // ---- one-shot sound FX bus
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.8;
    this.sfxEcho = ctx.createGain();
    this.sfxEcho.gain.value = 0.6;
    this.sfxRev = ctx.createGain();
    this.sfxRev.gain.value = 0.2;
    this.sfxBus.connect(this.mix);
    this.sfxBus.connect(this.sfxEcho).connect(this.echoIn);
    this.sfxBus.connect(this.sfxRev).connect(this.revIn);

    // ---- master chain
    this.phaser = new Phaser(ctx);
    this.mix.connect(this.phaser.input);

    this.mfLP = ctx.createBiquadFilter();
    this.mfLP.type = 'lowpass';
    this.mfLP.frequency.value = 22000;
    this.mfHP = ctx.createBiquadFilter();
    this.mfHP.type = 'highpass';
    this.mfHP.frequency.value = 10;
    this.bassCut = ctx.createBiquadFilter();
    this.bassCut.type = 'highpass';
    this.bassCut.frequency.value = 10;
    this.bassCut.Q.value = 0.9;

    this.eqSub = ctx.createBiquadFilter();
    this.eqSub.type = 'lowshelf'; this.eqSub.frequency.value = 65;
    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'peaking'; this.eqLow.frequency.value = 220; this.eqLow.Q.value = 0.8;
    this.eqPres = ctx.createBiquadFilter();
    this.eqPres.type = 'peaking'; this.eqPres.frequency.value = 3200; this.eqPres.Q.value = 0.7;
    this.eqAir = ctx.createBiquadFilter();
    this.eqAir.type = 'highshelf'; this.eqAir.frequency.value = 10000;

    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -6;
    this.glue.ratio.value = 1;
    this.glue.knee.value = 10;
    this.glue.attack.value = 0.02;
    this.glue.release.value = 0.25;
    this.glueMakeup = ctx.createGain();

    this.master = ctx.createGain();
    this.master.gain.value = dbToGain(-6);

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.1;
    this.limiterOn = true;
    this.preClip = ctx.createGain();
    this.preClip.gain.value = 0.5;
    this.clipper = ctx.createWaveShaper();
    this.clipper.curve = softClipCurve();
    this.clipper.oversample = '4x';
    this.limiterBypass = ctx.createGain();
    this.limiterBypass.gain.value = 0;
    this.limitIn = ctx.createGain();
    this.out = ctx.createGain();

    this.phaser.output.connect(this.mfLP).connect(this.mfHP).connect(this.bassCut)
      .connect(this.eqSub).connect(this.eqLow).connect(this.eqPres).connect(this.eqAir)
      .connect(this.glue).connect(this.glueMakeup).connect(this.master).connect(this.limitIn);
    this.limitIn.connect(this.limiter).connect(this.preClip).connect(this.clipper).connect(this.out);
    this.limitIn.connect(this.limiterBypass).connect(this.out);

    // ---- metering
    this.split = ctx.createChannelSplitter(2);
    this.anL = ctx.createAnalyser();
    this.anR = ctx.createAnalyser();
    this.anL.fftSize = 2048; this.anR.fftSize = 2048;
    this.out.connect(this.split);
    this.split.connect(this.anL, 0);
    this.split.connect(this.anR, 1);
    this.spec = ctx.createAnalyser();
    this.spec.fftSize = 4096;
    this.spec.smoothingTimeConstant = 0.75;
    this.out.connect(this.spec);

    // ---- recorder (in-line, passes audio through)
    this.recorder = new AudioWorkletNode(ctx, 'dub-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit',
    });
    this.recorder.port.onmessage = (e) => {
      if (e.data.chunk) this.recChunks.push(e.data.chunk);
      if (e.data.done && this._recDone) { this._recDone(); this._recDone = null; }
    };
    this.out.connect(this.recorder).connect(ctx.destination);

    for (let i = 0; i < numDecks; i++) this.decks.push(new Deck(this, i));
    this.updateEchoTime();
    this._buf = new Float32Array(2048);
  }

  resume() {
    if (this.offline || this.ctx.state === 'running' || this.ctx.state === 'closed') return Promise.resolve();
    return this.ctx.resume().catch(() => {});
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { this.listeners.forEach((fn) => fn(type, data)); }

  // ---------------- tempo / echo
  setBpm(bpm) {
    this.bpm = clamp(bpm, 40, 220);
    this.updateEchoTime();
    this.emit('bpm', this.bpm);
  }
  setEchoDivision(div) { this.echoDiv = div; this.echoSync = true; this.updateEchoTime(); }
  setEchoFree(ms) { this.echoFreeMs = ms; this.echoSync = false; this.updateEchoTime(); }
  updateEchoTime(glide) {
    const t = this.echoSync ? (60 / this.bpm) * DIVISIONS[this.echoDiv] : this.echoFreeMs / 1000;
    this.echo.setTime(t, glide);
  }

  // ---------------- master
  setMasterFilter(v, res = 0.7) {
    // v: -1 (low-pass) .. 0 (open) .. +1 (high-pass)
    const now = this.ctx.currentTime;
    const lp = v < 0 ? 22000 * Math.pow(2, v * 9.4) : 22000;
    const hp = v > 0 ? 10 * Math.pow(2, v * 10.2) : 10;
    this.mfLP.frequency.setTargetAtTime(lp, now, 0.02);
    this.mfHP.frequency.setTargetAtTime(hp, now, 0.02);
    const q = 0.7 + res * 11;
    this.mfLP.Q.setTargetAtTime(v < -0.02 ? q : 0.7, now, 0.02);
    this.mfHP.Q.setTargetAtTime(v > 0.02 ? q : 0.7, now, 0.02);
  }
  setMasterGain(db) { this.master.gain.setTargetAtTime(db <= -60 ? 0 : dbToGain(db), this.ctx.currentTime, 0.02); }
  setEq(band, db) {
    const node = { sub: this.eqSub, low: this.eqLow, pres: this.eqPres, air: this.eqAir }[band];
    node.gain.setTargetAtTime(db, this.ctx.currentTime, 0.03);
  }
  setGlue(amount) {
    // 0 = off .. 1 = heavy "bus glue"
    const now = this.ctx.currentTime;
    this.glue.ratio.setTargetAtTime(1 + amount * 5, now, 0.05);
    this.glue.threshold.setTargetAtTime(-4 - amount * 18, now, 0.05);
    this.glueMakeup.gain.setTargetAtTime(dbToGain(amount * 3), now, 0.05);
  }
  setLimiter(on) {
    this.limiterOn = on;
    const now = this.ctx.currentTime;
    this.preClip.gain.setTargetAtTime(on ? 0.5 : 0, now, 0.01);
    this.limiterBypass.gain.setTargetAtTime(on ? 0 : 1, now, 0.01);
  }
  bassDrop(on) {
    this.bassDropOn = !!on;
    const now = this.ctx.currentTime;
    this.bassCut.frequency.cancelScheduledValues(now);
    this.bassCut.frequency.setTargetAtTime(on ? 320 : 10, now, on ? 0.015 : 0.01);
  }
  masterEchoThrow(on, amount = 1) {
    this.throwAllOn = !!on;
    this.masterThrow.gain.setTargetAtTime(on ? amount : 0, this.ctx.currentTime, 0.008);
  }

  // ---------------- sound FX
  // every one-shot gets its own gain so it can be faded out while it plays
  _shot(gain = 1, life = 8) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(this.sfxBus);
    const shot = { g, until: this.ctx.currentTime + life, src: null };
    if (!this.shots) this.shots = new Set();
    this.shots.add(shot);
    shot.timer = setTimeout(() => { this.shots.delete(shot); g.disconnect(); }, life * 1000 + 200);
    return shot;
  }
  playSfx(name) {
    if (!SFX[name]) return;
    const shot = this._shot(1, 8);
    shot.until = this.ctx.currentTime + (SFX_LEN[name] || 3);
    SFX[name](this.ctx, shot.g);
  }
  playSample(buffer, gain = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    const shot = this._shot(gain, buffer.duration + 0.5);
    shot.src = s;
    s.connect(shot.g);
    s.start();
    return s;
  }
  soundsPlaying() {
    if (!this.shots) return false;
    const now = this.ctx.currentTime;
    for (const sh of this.shots) if (sh.until > now) return true;
    return false;
  }
  // fade out every sound effect / sample that is still playing (and the siren)
  stopSounds(fade = 0.12) {
    const now = this.ctx.currentTime;
    for (const sh of this.shots || []) {
      sh.g.gain.cancelScheduledValues(now);
      sh.g.gain.setTargetAtTime(0, now, fade / 4);
      sh.until = now;
      if (sh.src) { try { sh.src.stop(now + fade + 0.05); } catch (e) { /* already stopped */ } }
    }
    this.siren.held = 0;
    this.siren.env.gain.cancelScheduledValues(now);
    this.siren.env.gain.setTargetAtTime(0, now, fade / 4);
  }

  // ---------------- metering
  readMeter(an) {
    const b = this._buf;
    an.getFloatTimeDomainData(b);
    let peak = 0, sum = 0;
    for (let i = 0; i < b.length; i++) { const a = Math.abs(b[i]); if (a > peak) peak = a; sum += b[i] * b[i]; }
    return { peak, rms: Math.sqrt(sum / b.length) };
  }
  masterLevels() { return [this.readMeter(this.anL), this.readMeter(this.anR)]; }

  // ---------------- recording
  startRecording() {
    this.recChunks = [];
    this.recording = true;
    this.recStart = performance.now();
    this.recorder.port.postMessage({ cmd: 'start' });
    this.emit('rec', true);
  }
  stopRecording() {
    return new Promise((resolve) => {
      this._recDone = () => {
        this.recording = false;
        let len = 0;
        for (const [l] of this.recChunks) len += l.length;
        const L = new Float32Array(len), R = new Float32Array(len);
        let o = 0;
        for (const [l, r] of this.recChunks) { L.set(l, o); R.set(r, o); o += l.length; }
        this.recChunks = [];
        this.emit('rec', false);
        resolve({ channels: [L, R], sampleRate: this.ctx.sampleRate });
      };
      this.recorder.port.postMessage({ cmd: 'stop' });
    });
  }

  anySolo() { return this.decks.some((d) => d.solo); }
  refreshMutes() { this.decks.forEach((d) => d.applyMute()); }
}
