// DUB-MIXER AI stem separation worker (htdemucs, ONNX Runtime, CPU).
// Runs in its own process (Electron utilityProcess, or child_process.fork in dev) so it can be
// killed instantly on cancel and its ~2 GB of model memory goes away with it.
//
// in : { type: 'run', modelPath, inPath, outPath, sampleRate, frames }
//      inPath = raw Float32 [L(frames), R(frames)] at the deck's sample rate
// out: { type: 'progress', stage, p }  p = overall 0..1
//      { type: 'done', planes, scales } outPath = raw Int16 planes [vocalL, vocalR, drumsL, drumsR, bass(mono)]
//      { type: 'error', message }
'use strict';
const fs = require('fs');

const MODEL_SR = 44100;
const SEG = 343980;              // 7.8 s @ 44.1 kHz (fixed model input)
const OVERLAP = SEG >> 2;
const STRIDE = SEG - OVERLAP;
const SRC = { drums: 0, bass: 1, other: 2, vocals: 3 };

const send = (m) => {
  if (process.parentPort) process.parentPort.postMessage(m);
  else if (process.send) process.send(m);
};
const onMessage = (fn) => {
  if (process.parentPort) process.parentPort.on('message', (e) => fn(e.data));
  else process.on('message', fn);
};

// ---------------------------------------------------------------- resampling
// Polyphase windowed-sinc (Kaiser) resampler. Exact rational phases when the ratio is simple
// (48000 -> 44100 is 147/160), otherwise 4096 quantised phases.
function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
function besselI0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-12 * s) break; }
  return s;
}
function makeResampler(fin, fout) {
  const g = gcd(fin, fout);
  let L = fout / g, M = fin / g;
  let exact = true;
  if (L > 4096) { exact = false; }
  const PH = exact ? L : 4096;
  const fc = Math.min(1, fout / fin) * 0.94;     // cutoff relative to input Nyquist
  const Z = 24;                                   // zero crossings per side
  const half = Math.ceil(Z / fc);
  const taps = 2 * half;
  const beta = 8.6, i0b = besselI0(beta);
  const table = new Float32Array(PH * taps);
  for (let p = 0; p < PH; p++) {
    const frac = p / PH;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const x = k - half + 1 - frac;              // distance from output position, input samples
      const r = x / half;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
      const a = Math.PI * fc * x;
      const s = x === 0 ? 1 : Math.sin(a) / a;
      const v = fc * s * w;
      table[p * taps + k] = v;
      sum += v;
    }
    const n = fc / sum;                           // unity DC gain per phase
    for (let k = 0; k < taps; k++) table[p * taps + k] *= n / fc;
  }
  return function resample(input, outLen) {
    const out = new Float32Array(outLen);
    const n = input.length;
    for (let i = 0; i < outLen; i++) {
      let base, p;
      if (exact) {
        const num = i * M;
        base = Math.floor(num / L);
        p = num - base * L;
      } else {
        const pos = (i * fin) / fout;
        base = Math.floor(pos);
        p = Math.min(PH - 1, Math.round((pos - base) * PH));
      }
      const off = p * taps;
      const start = base - half + 1;
      let acc = 0;
      if (start >= 0 && start + taps <= n) {
        for (let k = 0; k < taps; k++) acc += input[start + k] * table[off + k];
      } else {
        for (let k = 0; k < taps; k++) {
          const j = start + k;
          if (j >= 0 && j < n) acc += input[j] * table[off + k];
        }
      }
      out[i] = acc;
    }
    return out;
  };
}
function resample(input, fin, fout, outLen) {
  if (fin === fout) return input.length === outLen ? input : input.slice(0, outLen);
  return makeResampler(fin, fout)(input, outLen);
}

// ---------------------------------------------------------------- separation
async function run(msg) {
  const { modelPath, inPath, outPath, sampleRate, frames } = msg;
  const ort = require('onnxruntime-node');
  // leave CPU for the live audio thread (separation can run while other decks play)
  try { require('os').setPriority(5); } catch (e) { /* not permitted: keep default */ }
  const threads = Math.max(2, require('os').cpus().length - 2);
  const progress = (stage, p) => send({ type: 'progress', stage, p: Math.max(0, Math.min(1, p)) });

  progress('prepare', 0);
  const raw = fs.readFileSync(inPath);
  const all = new Float32Array(raw.buffer, raw.byteOffset, frames * 2);
  const total = Math.round((frames * MODEL_SR) / sampleRate);
  const mixL = resample(all.subarray(0, frames), sampleRate, MODEL_SR, total);
  progress('prepare', 0.02);
  const mixR = resample(all.subarray(frames), sampleRate, MODEL_SR, total);
  progress('prepare', 0.04);

  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    intraOpNumThreads: threads,
    // Electron/Chromium's allocator traps (SIGTRAP) on ORT's big arena blocks: allocate per tensor
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  progress('load', 0.08);

  // accumulators @44.1k: vocal L/R, drums L/R, bass mono
  const acc = [0, 1, 2, 3, 4].map(() => new Float32Array(total));
  const weight = new Float32Array(total);
  const win = new Float32Array(SEG).fill(1);
  for (let i = 0; i < OVERLAP; i++) { const v = i / (OVERLAP - 1); win[i] = v; win[SEG - 1 - i] = v; }
  const x = new Float32Array(2 * SEG);
  const chunks = Math.max(1, Math.ceil(Math.max(0, total - OVERLAP) / STRIDE));

  for (let c = 0; c < chunks; c++) {
    const start = c * STRIDE;
    const len = Math.min(SEG, total - start);
    x.fill(0);
    x.set(mixL.subarray(start, start + len), 0);
    x.set(mixR.subarray(start, start + len), SEG);
    const res = await session.run({ mix: new ort.Tensor('float32', x, [1, 2, SEG]) });
    const y = res.stems.data; // [4][2][SEG]
    const plane = (s, ch) => (s * 2 + ch) * SEG;
    const vL = plane(SRC.vocals, 0), vR = plane(SRC.vocals, 1);
    const dL = plane(SRC.drums, 0), dR = plane(SRC.drums, 1);
    const bL = plane(SRC.bass, 0), bR = plane(SRC.bass, 1);
    // first / last chunk: no fade on the outer edge
    for (let i = 0; i < len; i++) {
      let w = win[i];
      if (c === 0 && i < OVERLAP) w = 1;
      if (c === chunks - 1 && i >= SEG - OVERLAP) w = 1;
      const j = start + i;
      acc[0][j] += y[vL + i] * w;
      acc[1][j] += y[vR + i] * w;
      acc[2][j] += y[dL + i] * w;
      acc[3][j] += y[dR + i] * w;
      acc[4][j] += 0.5 * (y[bL + i] + y[bR + i]) * w;
      weight[j] += w;
    }
    progress('separate', 0.08 + 0.86 * ((c + 1) / chunks));
  }
  await session.release();

  // normalise, back to the deck rate, Int16 with per-plane scale
  const fd = fs.openSync(outPath, 'w');
  const scales = [];
  try {
    for (let p = 0; p < 5; p++) {
      const a = acc[p];
      for (let i = 0; i < total; i++) a[i] /= weight[i] > 1e-6 ? weight[i] : 1;
      const back = resample(a, MODEL_SR, sampleRate, frames);
      acc[p] = null;
      let peak = 0;
      for (let i = 0; i < frames; i++) { const v = Math.abs(back[i]); if (v > peak) peak = v; }
      const scale = Math.max(peak, 1e-9);
      const k = 32767 / scale;
      const q = new Int16Array(frames);
      for (let i = 0; i < frames; i++) q[i] = Math.round(back[i] * k);
      fs.writeSync(fd, Buffer.from(q.buffer, q.byteOffset, q.byteLength), 0, q.byteLength, p * frames * 2);
      scales.push(scale);
      progress('write', 0.94 + 0.06 * ((p + 1) / 5));
    }
  } finally {
    fs.closeSync(fd);
  }
  send({ type: 'done', planes: 5, scales });
}

// The parent kills this process once it has the result: a normal process.exit() while ONNX
// Runtime's thread pool is alive aborts with "mutex lock failed".
onMessage((msg) => {
  if (!msg || msg.type !== 'run') return;
  run(msg).catch((e) => send({ type: 'error', message: String((e && e.message) || e) }));
});
if (process.send) process.on('disconnect', () => process.kill(process.pid, 'SIGKILL'));

module.exports = { makeResampler, resample };
