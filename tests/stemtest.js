// Measures how well each stem kill removes its target, using isolated parts as ground truth.
// Run in the dev server page:  await (await import('/tests/stemtest.js')).run()
//   DSP = real-time worklet (all platforms), AI = htdemucs via the dev bridge (desktop mode),
//   played through a real Deck's AI path (same gains/latency as the app).
// Songs: 'riddim' = demo one-drop (its "vocal" is a synth lead),
//        'vocal'  = same riddim without the lead + a real voice (tests/fixtures, macOS `say`) with stereo echo.
import { renderDemo } from '/src/audio/demo.js';
import { Engine } from '/src/audio/engine.js';
import { aiInfo, separateBuffer } from '/src/audio/ai.js';
import stemsSrc from '/src/audio/worklets/stems.js?raw';
const SR = 48000;
const url = URL.createObjectURL(new Blob([stemsSrc], { type: 'application/javascript' }));
async function split(buf, gains, tune) {
  const off = new OfflineAudioContext(2, buf.length + 4096, SR);
  await off.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(off, 'stem-splitter', { outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { gains, tune } });
  const s = off.createBufferSource(); s.buffer = buf; s.connect(node).connect(off.destination); s.start();
  return off.startRendering();
}
// a real Deck in AI mode, tapped right after its stem stage (before EQ/filters/fader)
async function splitAi(buf, stems, gains) {
  const off = new OfflineAudioContext(2, buf.length + 4096, SR);
  const eng = new Engine();
  await eng.init(1, off);
  const d = eng.decks[0];
  d.trim.disconnect();
  d.trim.connect(off.destination);
  d.load(buf, { name: 'test', bpm: 75 });
  d.ai = stems;
  d.setAiMode(true);
  gains.forEach((g, k) => d.setStemKill(k, g === 0));
  d.play();
  return off.startRendering();
}
const LAT = 3072;
// SDR-like: how close output is to the ideal (mix minus target)
function compare(out, ideal, target, a, b) {
  let e = 0, t = 0, kept = 0;
  for (let c = 0; c < 2; c++) {
    const o = out.getChannelData(c), id = ideal.getChannelData(c), tg = target.getChannelData(c);
    for (let i = a; i < b; i++) { const d = o[i + LAT] - id[i]; e += d * d; t += tg[i] * tg[i]; kept += id[i] * id[i]; }
  }
  return { targetRemoved_dB: +(10 * Math.log10(t / e)).toFixed(1), residualVsKept_dB: +(10 * Math.log10(e / kept)).toFixed(1) };
}
function sum(a, b) {
  const out = new AudioBuffer({ numberOfChannels: 2, length: a.length, sampleRate: SR });
  for (let c = 0; c < 2; c++) {
    const o = out.getChannelData(c), x = a.getChannelData(c), y = b.getChannelData(c);
    for (let i = 0; i < a.length; i++) o[i] = x[i] + (y[i] || 0);
  }
  return out;
}
async function vocalPart(length) {
  const off = new OfflineAudioContext(2, length, SR);
  const load = async (f) => off.decodeAudioData(await (await fetch(`/tests/fixtures/${f}`)).arrayBuffer());
  const [spoken, sung] = await Promise.all([load('vocal-spoken.wav'), load('vocal-sung.wav')]);
  const bus = off.createGain(); bus.gain.value = 0.55;
  bus.connect(off.destination);
  for (const [pan, time] of [[-0.8, 0.4], [0.8, 0.6]]) { // stereo slap echo, like a mixed vocal
    const dl = off.createDelay(1); dl.delayTime.value = time;
    const g = off.createGain(); g.gain.value = 0.22;
    const p = off.createStereoPanner(); p.pan.value = pan;
    bus.connect(dl).connect(g).connect(p).connect(off.destination);
  }
  [[spoken, 12], [sung, 24]].forEach(([b, t]) => { const s = off.createBufferSource(); s.buffer = b; s.connect(bus); s.start(t); });
  return off.startRendering();
}
async function song(name) {
  const demo = async (mute) => (await renderDemo('onedrop', SR, { raw: true, mute })).buffer;
  if (name === 'riddim') {
    const parts = {};
    for (const p of ['lead', 'drums', 'bass', 'other']) parts[p] = await demo(['lead', 'drums', 'bass', 'other'].filter((k) => k !== p));
    return { mix: await demo([]), parts, a: SR * 15, b: SR * 38 }; // lead plays in bars 5-12
  }
  const parts = {};
  for (const p of ['drums', 'bass', 'other']) parts[p] = await demo(['lead', 'drums', 'bass', 'other'].filter((k) => k !== p));
  parts.vocal = await vocalPart(parts.drums.length);
  let mix = parts.drums;
  for (const p of ['bass', 'other', 'vocal']) mix = sum(mix, parts[p]);
  return { mix, parts, a: SR * 12, b: SR * 50 };
}

export async function run(tune, { ai = true, songs = ['riddim', 'vocal'] } = {}) {
  const info = ai ? await aiInfo(true) : { available: false };
  const res = {};
  for (const name of songs) {
    const { mix, parts, a, b } = await song(name);
    const names = Object.keys(parts);
    let stems = null;
    if (info.available) {
      const t0 = performance.now();
      const job = separateBuffer(new OfflineAudioContext(2, 1, SR), mix, (p) => console.log(`[stemtest ${name}] ${p.stage} ${(p.p * 100).toFixed(0)}%`));
      stems = await job.promise;
      console.log(`[stemtest ${name}] AI separation took ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    }
    res[name] = {};
    for (const part of names) {
      const idx = { lead: 0, vocal: 0, drums: 1, bass: 2, other: 3 }[part];
      const rest = names.filter((k) => k !== part);
      let without = parts[rest[0]];
      for (const k of rest.slice(1)) without = sum(without, parts[k]);
      const gains = [1, 1, 1, 1]; gains[idx] = 0;
      const row = { dsp: compare(await split(mix, gains, tune), without, parts[part], a, b) };
      if (stems) row.ai = compare(await splitAi(mix, stems, gains), without, parts[part], a, b);
      res[name][part] = row;
    }
    if (stems) { // unity gains must give back the original (AI path reconstruction)
      const out = await splitAi(mix, stems, [1, 1, 1, 1]);
      const snr = compare(out, mix, mix, a, b).targetRemoved_dB;
      res[name].aiUnitySNR_dB = Number.isFinite(snr) ? snr : 'exact (bit-identical)';
    }
  }
  const table = [];
  for (const [s, rows] of Object.entries(res)) {
    for (const [part, r] of Object.entries(rows)) {
      if (typeof r !== 'object') continue;
      table.push({ song: s, kill: part, dsp_removed_dB: r.dsp.targetRemoved_dB, ai_removed_dB: r.ai ? r.ai.targetRemoved_dB : '—', dsp_residual_dB: r.dsp.residualVsKept_dB, ai_residual_dB: r.ai ? r.ai.residualVsKept_dB : '—' });
    }
  }
  console.table(table);
  return { ai: info.available, ...res, table };
}
