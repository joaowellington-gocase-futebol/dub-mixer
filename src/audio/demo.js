// Built-in demo riddims, synthesised offline (no samples shipped).
// 'onedrop' = roots one-drop @ 75 BPM, 'steppers' = four-to-the-floor @ 72 BPM (half-time feel 144).

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);

export async function renderDemo(style = 'onedrop', sampleRate = 44100, opts = {}) {
  const mute = new Set(opts.mute || []);
  let seed = 20240917;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const bpm = style === 'steppers' ? 72 : 75;
  const beat = 60 / bpm;
  const bars = 16;
  const len = bars * 4 * beat + 2;
  const ctx = new OfflineAudioContext(2, Math.ceil(len * sampleRate), sampleRate);

  const master = ctx.createGain();
  master.gain.value = 0.62;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10; comp.ratio.value = 3;
  if (opts.raw) master.connect(ctx.destination);
  else master.connect(comp).connect(ctx.destination);

  const panned = (p, g = 1) => {
    const pn = ctx.createStereoPanner(); pn.pan.value = p;
    const gn = ctx.createGain(); gn.gain.value = g;
    gn.connect(pn).connect(master);
    return gn;
  };
  const g = (k, v) => (mute.has(k) ? 0 : v);
  const drumBus = panned(0, g('drums', 0.95));
  const hatBus = panned(0.35, g('drums', 0.35));
  const bassBus = panned(0, g('bass', 0.9));
  const gtrBus = panned(-0.6, g('other', 0.32));
  const organBus = panned(0.55, g('other', 0.22));
  const leadBus = panned(0, g('lead', 0.3));

  const noise = ctx.createBuffer(1, sampleRate, sampleRate);
  { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = random() * 2 - 1; }

  const kick = (t) => {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(g).connect(drumBus);
    o.start(t); o.stop(t + 0.5);
  };
  const rim = (t, v = 0.5) => {
    const o = ctx.createOscillator();
    o.type = 'triangle'; o.frequency.value = 1750;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    o.connect(g).connect(drumBus);
    o.start(t); o.stop(t + 0.05);
    const n = ctx.createBufferSource(); n.buffer = noise;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(v * 0.9, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    n.connect(hp).connect(ng).connect(drumBus);
    n.start(t, random() * 0.5, 0.08);
  };
  const hat = (t, v = 0.5, open = false) => {
    const n = ctx.createBufferSource(); n.buffer = noise;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7500;
    const g = ctx.createGain();
    const d = open ? 0.22 : 0.045;
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    n.connect(hp).connect(g).connect(hatBus);
    n.start(t, random() * 0.5, d + 0.02);
  };
  const bass = (t, note, dur) => {
    const f = NOTE(note);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f * 2;
    const g2 = ctx.createGain(); g2.gain.value = 0.18;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + 0.015);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.85, 0.04);
    o.connect(lp); o2.connect(g2).connect(lp);
    lp.connect(g).connect(bassBus);
    o.start(t); o2.start(t); o.stop(t + dur + 0.3); o2.stop(t + dur + 0.3);
  };
  const chop = (t, notes, bus, type, dur, cutoff) => {
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = cutoff; bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    bp.connect(g).connect(bus);
    for (const n of notes) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = NOTE(n);
      o.detune.value = (random() - 0.5) * 8;
      o.connect(bp); o.start(t); o.stop(t + dur + 0.02);
    }
  };
  const lead = (t, note, dur) => {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = NOTE(note);
    const vib = ctx.createOscillator(); vib.frequency.value = 5.2;
    const vg = ctx.createGain(); vg.gain.value = 0; vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(14, t + dur);
    vib.connect(vg).connect(o.detune);
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 750; f1.Q.value = 4;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1200; f2.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + 0.06);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.9, 0.06);
    o.connect(f1).connect(g); o.connect(f2).connect(g);
    g.connect(leadBus);
    o.start(t); vib.start(t); o.stop(t + dur + 0.4); vib.stop(t + dur + 0.4);
  };

  // Am - Am - Dm - Em  (one bar each), A minor dub progression
  const prog = [
    { root: 33, chord: [57, 60, 64] },
    { root: 33, chord: [57, 60, 64] },
    { root: 38, chord: [57, 62, 65] },
    { root: 40, chord: [59, 64, 67] },
  ];
  const bassLines = {
    33: [[0, 33, 1.4], [1.5, 36, 0.4], [2, 40, 0.9], [3, 38, 0.45], [3.5, 36, 0.45]],
    38: [[0, 38, 1.4], [1.5, 41, 0.4], [2, 45, 0.9], [3, 43, 0.45], [3.5, 41, 0.45]],
    40: [[0, 40, 1.4], [1.5, 43, 0.4], [2, 47, 0.9], [3, 45, 0.45], [3.5, 43, 0.45]],
  };
  const melody = [
    [0, 69, 1.4], [1.5, 72, 0.5], [2, 71, 1], [3, 69, 0.9],
    [4, 67, 1.9], [6, 64, 1.9],
    [8, 65, 1.4], [9.5, 69, 0.5], [10, 67, 1.9],
    [12, 64, 1.4], [13.5, 67, 0.5], [14, 69, 1.9],
  ];
  const swing = beat * 0.17;
  const t0 = 0.25;

  for (let bar = 0; bar < bars; bar++) {
    const bt = t0 + bar * 4 * beat;
    const p = prog[bar % 4];
    const intro = bar < 2;
    const drop = bar >= 12 && bar < 14;
    // drums
    for (let b = 0; b < 4; b++) {
      const tb = bt + b * beat;
      if (style === 'steppers') { if (!intro) kick(tb); }
      else if (b === 2 && !intro) kick(tb);
      if (b === 2) rim(tb, 0.55);
      if (!drop) {
        hat(tb, 0.45);
        hat(tb + beat / 2 + swing, 0.3, b === 3 && bar % 2 === 1);
      }
    }
    if (bar % 4 === 3 && !drop) { rim(bt + 3.5 * beat + swing, 0.35); rim(bt + 3.75 * beat, 0.3); }
    // bass
    if (!intro) for (const [o, n, d] of bassLines[p.root]) bass(bt + o * beat, n, d * beat);
    // skank on 2 & 4 (guitar) + organ bubble on the off-beats
    if (!drop || bar === 13) {
      for (const b of [1, 3]) chop(bt + b * beat, p.chord, gtrBus, 'sawtooth', 0.11, 1800);
      if (bar >= 2) for (let b = 0; b < 4; b++) chop(bt + b * beat + beat / 2 + swing, p.chord.map((n) => n - 12), organBus, 'square', 0.16, 900);
    }
    // lead / "vocal" (centre panned)
    if (bar >= 4 && bar < 12) {
      const mOff = (bar - 4) % 4;
      for (const [o, n, d] of melody) {
        if (o >= mOff * 4 && o < (mOff + 1) * 4) lead(bt + (o - mOff * 4) * beat, n, d * beat);
      }
    }
  }

  const buf = await ctx.startRendering();
  return { buffer: buf, bpm, name: style === 'steppers' ? 'Demo Riddim - Steppers' : 'Demo Riddim - One Drop' };
}
