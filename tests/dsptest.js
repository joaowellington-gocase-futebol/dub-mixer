// Offline DSP verification (run in the dev server page: await (await import('/tests/dsptest.js')).run()).
import { Engine } from '/src/audio/engine.js';
import { renderDemo } from '/src/audio/demo.js';
import stemsSrc from '/src/audio/worklets/stems.js?raw';
import { encodeWav } from '/src/export/wav.js';
import { encodeMp3 } from '/src/export/mp3.js';

const SR = 48000;
const url = (s) => URL.createObjectURL(new Blob([s], { type: 'application/javascript' }));

function stats(buf, from = 0, to) {
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  to = to ?? L.length;
  let peak = 0, sum = 0, nan = 0;
  for (let i = from; i < to; i++) {
    const a = L[i], b = R[i];
    if (!isFinite(a) || !isFinite(b)) { nan++; continue; }
    peak = Math.max(peak, Math.abs(a), Math.abs(b));
    sum += a * a + b * b;
  }
  return { peak: +peak.toFixed(4), rmsDb: +(10 * Math.log10(sum / (2 * (to - from)) + 1e-20)).toFixed(2), nan };
}

// energy in a band via biquad, offline
async function bandEnergy(buf, type, freq, q = 0.7, from = 0, to) {
  const off = new OfflineAudioContext(2, buf.length, buf.sampleRate);
  const s = off.createBufferSource(); s.buffer = buf;
  const f = off.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  s.connect(f).connect(off.destination); s.start();
  return stats(await off.startRendering(), from, to).rmsDb;
}

async function splitter(input, gains) {
  const off = new OfflineAudioContext(2, input.length + 8192, SR);
  await off.audioWorklet.addModule(url(stemsSrc));
  const node = new AudioWorkletNode(off, 'stem-splitter', { outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { gains } });
  const s = off.createBufferSource(); s.buffer = input;
  s.connect(node).connect(off.destination); s.start(0.05);
  return off.startRendering();
}

export async function run() {
  const out = {};
  const demo = (await renderDemo('onedrop', SR)).buffer;
  out.demo = stats(demo);

  // 1) splitter reconstruction at unity
  const rec = await splitter(demo, null);
  const L0 = demo.getChannelData(0), L1 = rec.getChannelData(0);
  const startOff = Math.round(0.05 * SR);
  const bestLag = 3072; // N + LA*H
  let err = 0, ref = 0;
  for (let i = SR * 2; i < demo.length - SR; i++) {
    const d = L0[i] - L1[i + startOff + bestLag];
    err += d * d; ref += L0[i] * L0[i];
  }
  out.splitterLatency = bestLag;
  out.reconstructionSNR_dB = +(10 * Math.log10(ref / err)).toFixed(1);

  // 2) stem kills: compare band energies (bars 4-12 contain the centre lead)
  const seg = [Math.round(SR * 14), Math.round(SR * 36)];
  const full = rec;
  const noVox = await splitter(demo, [0, 1, 1, 1]);
  const noDrums = await splitter(demo, [1, 0, 1, 1]);
  const noBass = await splitter(demo, [1, 1, 0, 1]);
  const dubOnly = await splitter(demo, [0, 1, 1, 0]);
  out.vocalBand_1k = {
    full: await bandEnergy(full, 'bandpass', 900, 1.2, ...seg),
    noVocal: await bandEnergy(noVox, 'bandpass', 900, 1.2, ...seg),
  };
  out.hats_9k = {
    full: await bandEnergy(full, 'highpass', 8000, 0.7, ...seg),
    noDrums: await bandEnergy(noDrums, 'highpass', 8000, 0.7, ...seg),
  };
  out.bass_80 = {
    full: await bandEnergy(full, 'lowpass', 90, 0.7, ...seg),
    noBass: await bandEnergy(noBass, 'lowpass', 90, 0.7, ...seg),
  };
  out.dubOnly = stats(dubOnly, ...seg);

  // 3) full engine offline: deck -> channel -> echo/spring -> master
  const len = SR * 14;
  const off = new OfflineAudioContext(2, len, SR);
  const eng = new Engine();
  await eng.init(2, off);
  eng.setBpm(75);
  const d = eng.decks[0];
  d.load(demo, { name: 'demo', bpm: 75 });
  d.setSend('echo', 0.6);
  d.setSend('rev', 0.4);
  eng.echo.setFeedback(1.15); // self-oscillating
  eng.echo.setDrive(1);
  d.play();
  eng.siren.on();
  eng.playSfx('AIRHORN');
  eng.playSfx('GUNSHOT');
  eng.playSfx('BOMB');
  eng.spring.crash();
  const master = await off.startRendering();
  out.engineMaster = stats(master);
  out.engineTail = stats(master, len - SR, len);

  // 4) encoders
  const ch = [master.getChannelData(0).slice(0, SR * 4), master.getChannelData(1).slice(0, SR * 4)];
  const meta = { title: 'Test Dub', artist: 'Dub Mixer', genre: 'Dub', year: '2026', cover: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) };
  const w24 = encodeWav(ch, SR, 24, meta);
  const w16 = encodeWav(ch, SR, 16, meta);
  const w32 = encodeWav(ch, SR, 32, meta);
  out.wavBytes = { w16: w16.length, w24: w24.length, w32: w32.length };
  // decode our own WAVs back
  const ctx = new OfflineAudioContext(2, 10, SR);
  for (const [k, w] of Object.entries({ w16, w24, w32 })) {
    const b = await ctx.decodeAudioData(w.buffer.slice(0));
    out[`decode_${k}`] = { len: b.length, ch: b.numberOfChannels, sr: b.sampleRate };
  }
  const mp3 = await encodeMp3(ch, SR, 320, meta);
  out.mp3Bytes = mp3.length;
  const mb = await ctx.decodeAudioData(mp3.buffer.slice(0));
  out.decode_mp3 = { len: mb.length, sec: +(mb.duration).toFixed(2) };
  return out;
}
