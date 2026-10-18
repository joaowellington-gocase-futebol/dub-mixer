// Tempo detection: onset envelope + autocorrelation with a tempo prior suited to reggae/dub.
self.onmessage = (e) => {
  const { id, data, sampleRate } = e.data;
  try {
    self.postMessage({ id, bpm: detect(data, sampleRate) });
  } catch (err) {
    self.postMessage({ id, bpm: 0, error: String(err) });
  }
};

function detect(x, sr) {
  const hop = Math.round(sr / 200);
  const fps = sr / hop;
  const frames = Math.floor(x.length / hop) - 1;
  if (frames < fps * 6) return 0;
  const eFull = new Float32Array(frames), eLow = new Float32Array(frames);
  const a = 1 - Math.exp((-2 * Math.PI * 160) / sr);
  let lp = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0, sl = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) {
      const v = x[i];
      lp += a * (v - lp);
      s += v * v; sl += lp * lp;
    }
    eFull[f] = Math.log(1e-6 + s);
    eLow[f] = Math.log(1e-6 + sl);
  }
  const on = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    on[f] = Math.max(0, eFull[f] - eFull[f - 1]) + 1.4 * Math.max(0, eLow[f] - eLow[f - 1]);
  }
  // remove local mean
  const w = Math.round(fps * 0.25);
  const onc = new Float32Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += on[f];
    if (f >= w) acc -= on[f - w];
    onc[f] = Math.max(0, on[f] - acc / Math.min(f + 1, w));
  }
  const ac = (lag) => {
    const l0 = Math.floor(lag), fr = lag - l0;
    let s = 0;
    for (let f = 0; f + l0 + 1 < frames; f++) s += onc[f] * (onc[f + l0] * (1 - fr) + onc[f + l0 + 1] * fr);
    return s / (frames - l0);
  };
  let best = 0, bestScore = -1;
  for (let bpm = 55; bpm <= 185; bpm += 0.25) {
    const lag = (60 * fps) / bpm;
    let s = ac(lag) + 0.5 * ac(lag * 2) + 0.33 * ac(lag * 4);
    const oct = Math.log2(bpm / 88);
    s *= Math.exp(-0.5 * (oct / 0.9) ** 2);
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  // refine
  let fine = best, fs = -1;
  for (let bpm = best - 0.5; bpm <= best + 0.5; bpm += 0.05) {
    const lag = (60 * fps) / bpm;
    const s = ac(lag) + 0.5 * ac(lag * 2) + 0.33 * ac(lag * 4);
    if (s > fs) { fs = s; fine = bpm; }
  }
  return Math.round(fine * 10) / 10;
}
