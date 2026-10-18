/*
 * DUB-MIXER real-time stem splitter (AudioWorklet).
 *
 * Splits a stereo signal into 4 stems using STFT spectral masks:
 *   - DRUMS : percussive part (harmonic/percussive separation, median filtering)
 *   - BASS  : harmonic content below ~180 Hz
 *   - VOCAL : harmonic, centre-panned content in the vocal band
 *   - OTHER : everything else (masks always sum to 1, so with all gains at
 *             unity the output is a perfect reconstruction of the input)
 *
 * Gains for each stem arrive via port messages: { gains: [v, d, b, o] }.
 * Constant latency: N + LA*H samples.
 */

const N = 2048;
const H = 512;
const BINS = N / 2 + 1;
const LA = 2;                 // lookahead frames (horizontal median)
const KB = 8;                 // frames back (horizontal median)
const HW = KB + 1 + LA;       // horizontal median window
const VK = 8;                 // vertical median half-width (17 bins)
const DEFAULT_TUNE = { cLo: 0.55, cHi: 0.92, pPow: 1 };
const FIFO = 8192;
const OLA_SCALE = 1 / 1.5;    // Hann analysis * Hann synthesis @ 75% overlap

class FFT {
  constructor(n) {
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }
  run(re, im, inverse) {
    const n = this.n, rev = this.rev, cos = this.cos, sin = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k];
          const wi = inverse ? sin[k] : -sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) {
      const s = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; }
    }
  }
}

function median(arr, len, tmp) {
  for (let i = 0; i < len; i++) {
    const v = arr[i];
    let j = i - 1;
    while (j >= 0 && tmp[j] > v) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = v;
  }
  return tmp[len >> 1];
}

class StemSplitter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.fft = new FFT(N);
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

    this.inL = new Float64Array(N);
    this.inR = new Float64Array(N);
    this.stage = 0;
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);

    this.specLre = []; this.specLim = []; this.specRre = []; this.specRim = [];
    for (let i = 0; i <= LA; i++) {
      this.specLre.push(new Float32Array(BINS)); this.specLim.push(new Float32Array(BINS));
      this.specRre.push(new Float32Array(BINS)); this.specRim.push(new Float32Array(BINS));
    }
    this.mag = [];
    for (let i = 0; i < HW; i++) this.mag.push(new Float32Array(BINS));
    this.frame = 0;

    this.simS = new Float32Array(BINS);
    this.hcol = new Float32Array(HW);
    this.htmp = new Float32Array(HW);
    this.vcol = new Float32Array(2 * VK + 1);
    this.vtmp = new Float32Array(2 * VK + 1);
    this.G = new Float32Array(BINS);

    // Frequency weighting curves
    const nyq = sampleRate / 2;
    this.low = new Float32Array(BINS);
    this.voc = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) {
      const f = (k / (BINS - 1)) * nyq;
      this.low[k] = f <= 150 ? 1 : f >= 260 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * (f - 150) / 110);
      let v = 1;
      if (f < 120) v = 0;
      else if (f < 220) v = 0.5 - 0.5 * Math.cos(Math.PI * (f - 120) / 100);
      else if (f > 9000) v = 0;
      else if (f > 6500) v = 0.5 + 0.5 * Math.cos(Math.PI * (f - 6500) / 2500);
      this.voc[k] = v;
    }

    this.accL = new Float64Array(N);
    this.accR = new Float64Array(N);
    this.outL = new Float32Array(FIFO);
    this.outR = new Float32Array(FIFO);
    this.wp = H; // pre-filled with H samples of silence
    this.rp = 0;

    this.tune = Object.assign({}, DEFAULT_TUNE, (options && options.processorOptions && options.processorOptions.tune) || {});
    this.target = [1, 1, 1, 1];
    const init = options && options.processorOptions && options.processorOptions.gains;
    if (init) this.target = init.slice(0, 4).map((x) => Math.max(0, Math.min(2, +x || 0)));
    this.g = this.target.slice();
    this.silentHops = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.tune) Object.assign(this.tune, d.tune);
      if (d && d.gains) this.target = d.gains.slice(0, 4).map((x) => Math.max(0, Math.min(2, +x || 0)));
    };
  }

  hop() {
    const { inL, inR, re, im, win } = this;
    let silent = true;
    for (let i = N - H; i < N; i++) {
      if (inL[i] !== 0 || inR[i] !== 0) { silent = false; break; }
    }
    this.silentHops = silent ? this.silentHops + 1 : 0;

    if (this.silentHops > HW + N / H + 2) {
      for (let i = 0; i < H; i++) {
        this.outL[(this.wp + i) % FIFO] = 0;
        this.outR[(this.wp + i) % FIFO] = 0;
      }
      this.wp = (this.wp + H) % FIFO;
      return;
    }

    // --- analysis (stereo packed in one complex FFT)
    for (let i = 0; i < N; i++) { re[i] = inL[i] * win[i]; im[i] = inR[i] * win[i]; }
    this.fft.run(re, im, false);
    const f = this.frame;
    const s = f % (LA + 1);
    const Lre = this.specLre[s], Lim = this.specLim[s], Rre = this.specRre[s], Rim = this.specRim[s];
    const m = this.mag[f % HW];
    for (let k = 0; k < BINS; k++) {
      const nk = (N - k) % N;
      const lr = 0.5 * (re[k] + re[nk]);
      const li = 0.5 * (im[k] - im[nk]);
      const rr = 0.5 * (im[k] + im[nk]);
      const ri = -0.5 * (re[k] - re[nk]);
      Lre[k] = lr; Lim[k] = li; Rre[k] = rr; Rim[k] = ri;
      m[k] = 0.5 * (Math.sqrt(lr * lr + li * li) + Math.sqrt(rr * rr + ri * ri));
    }
    this.frame++;
    if (this.frame <= LA) {
      // not enough lookahead yet: emit silence
      for (let i = 0; i < H; i++) {
        this.outL[(this.wp + i) % FIFO] = 0;
        this.outR[(this.wp + i) % FIFO] = 0;
      }
      this.wp = (this.wp + H) % FIFO;
      return;
    }

    // --- synthesis of frame t = newest - LA
    const t = this.frame - 1 - LA;
    const st = t % (LA + 1);
    const tLre = this.specLre[st], tLim = this.specLim[st], tRre = this.specRre[st], tRim = this.specRim[st];
    const mt = this.mag[t % HW];

    const g = this.g, tg = this.target;
    let unity = true;
    for (let i = 0; i < 4; i++) {
      g[i] += (tg[i] - g[i]) * 0.45;
      if (Math.abs(g[i] - tg[i]) < 1e-4) g[i] = tg[i];
      if (g[i] !== 1) unity = false;
    }

    const G = this.G;
    if (unity) {
      G.fill(1);
    } else {
      const { hcol, htmp, vcol, vtmp, simS, low, voc, mag } = this;
      for (let k = 0; k < BINS; k++) {
        for (let j = 0; j < HW; j++) hcol[j] = mag[j][k];
        const hm = median(hcol, HW, htmp);
        let c = 0;
        for (let j = k - VK; j <= k + VK; j++) vcol[c++] = j < 0 || j >= BINS ? 0 : mt[j];
        const pm = median(vcol, c, vtmp);
        const pp = this.tune.pPow;
        const hmp = pp === 1 ? hm : Math.pow(hm, pp), pmp = pp === 1 ? pm : Math.pow(pm, pp);
        const P = pmp / (pmp + hmp + 1e-20);
        const Hh = 1 - P;

        const lr = tLre[k], li = tLim[k], rr = tRre[k], ri = tRim[k];
        const den = lr * lr + li * li + rr * rr + ri * ri + 1e-20;
        const sim = Math.max(0, (2 * (lr * rr + li * ri)) / den);
        simS[k] = 0.55 * simS[k] + 0.45 * sim;
        const cu = Math.max(0, Math.min(1, (simS[k] - this.tune.cLo) / (this.tune.cHi - this.tune.cLo)));
        const centre = cu * cu * (3 - 2 * cu);

        const mD = P;
        const mB = Hh * low[k];
        const mV = Hh * (1 - low[k]) * voc[k] * centre;
        const mO = Math.max(0, 1 - mD - mB - mV);
        G[k] = g[0] * mV + g[1] * mD + g[2] * mB + g[3] * mO;
      }
    }

    // apply gain mask, rebuild packed spectrum
    for (let k = 0; k < BINS; k++) {
      const gk = G[k];
      const yLr = tLre[k] * gk, yLi = tLim[k] * gk, yRr = tRre[k] * gk, yRi = tRim[k] * gk;
      re[k] = yLr - yRi; im[k] = yLi + yRr;
      if (k > 0 && k < N / 2) {
        re[N - k] = yLr + yRi; im[N - k] = yRr - yLi;
      }
    }
    this.fft.run(re, im, true);

    const { accL, accR } = this;
    for (let i = 0; i < N; i++) {
      const w = win[i] * OLA_SCALE;
      accL[i] += re[i] * w;
      accR[i] += im[i] * w;
    }
    for (let i = 0; i < H; i++) {
      this.outL[(this.wp + i) % FIFO] = accL[i];
      this.outR[(this.wp + i) % FIFO] = accR[i];
    }
    this.wp = (this.wp + H) % FIFO;
    accL.copyWithin(0, H); accR.copyWithin(0, H);
    accL.fill(0, N - H); accR.fill(0, N - H);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;
    const iL = input && input[0] ? input[0] : null;
    const iR = input && input[1] ? input[1] : iL;

    let off = 0;
    while (off < n) {
      const take = Math.min(H - this.stage, n - off);
      const base = N - H + this.stage;
      if (iL) {
        for (let i = 0; i < take; i++) { this.inL[base + i] = iL[off + i]; this.inR[base + i] = iR[off + i]; }
      } else {
        for (let i = 0; i < take; i++) { this.inL[base + i] = 0; this.inR[base + i] = 0; }
      }
      this.stage += take;
      off += take;
      if (this.stage === H) {
        this.hop();
        this.inL.copyWithin(0, H); this.inR.copyWithin(0, H);
        this.stage = 0;
      }
    }

    const oL = output[0], oR = output[1] || output[0];
    for (let i = 0; i < n; i++) {
      if (this.rp === this.wp) { oL[i] = 0; oR[i] = 0; continue; }
      oL[i] = this.outL[this.rp];
      oR[i] = this.outR[this.rp];
      this.rp = (this.rp + 1) % FIFO;
    }
    return true;
  }
}

registerProcessor('stem-splitter', StemSplitter);
