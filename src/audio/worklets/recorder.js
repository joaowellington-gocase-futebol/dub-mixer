/*
 * DUB-MIXER master recorder (AudioWorklet).
 * Captures the master bus as 32-bit float PCM and ships it to the main
 * thread in chunks. Messages in: {cmd:'start'} / {cmd:'stop'}.
 * Messages out: {chunk:[Float32Array L, Float32Array R]} and {done:true}.
 */
const CHUNK = 16384;

class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rec = false;
    this.L = new Float32Array(CHUNK);
    this.R = new Float32Array(CHUNK);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data.cmd === 'start') { this.rec = true; this.n = 0; }
      if (e.data.cmd === 'stop') { this.flush(); this.rec = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (!this.n) return;
    const L = this.L.slice(0, this.n), R = this.R.slice(0, this.n);
    this.port.postMessage({ chunk: [L, R] }, [L.buffer, R.buffer]);
    this.n = 0;
  }
  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0];
    if (inp && inp[0]) {
      const l = inp[0], r = inp[1] || inp[0];
      if (out && out[0]) { out[0].set(l); if (out[1]) out[1].set(r); }
      if (this.rec) {
        for (let i = 0; i < l.length; i++) {
          this.L[this.n] = l[i];
          this.R[this.n] = r[i];
          if (++this.n === CHUNK) this.flush();
        }
      }
    } else if (this.rec) {
      // silence still counts as time on tape
      const len = out && out[0] ? out[0].length : 128;
      for (let i = 0; i < len; i++) {
        this.L[this.n] = 0; this.R[this.n] = 0;
        if (++this.n === CHUNK) this.flush();
      }
    }
    return true;
  }
}

registerProcessor('dub-recorder', Recorder);
