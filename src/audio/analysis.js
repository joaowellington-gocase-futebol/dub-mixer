// Decoding + background analysis helpers.
import BpmWorker from './bpm.worker.js?worker&inline';

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new BpmWorker();
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (p) { pending.delete(e.data.id); p(e.data.bpm || 0); }
    };
  }
  return worker;
}

export function detectBpm(buffer) {
  const sr = buffer.sampleRate;
  // analyse up to 75 s from the middle-ish of the track
  const len = Math.min(buffer.length, Math.floor(sr * 75));
  const start = Math.max(0, Math.min(Math.floor(buffer.length * 0.2), buffer.length - len));
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) mono[i] = (L[start + i] + R[start + i]) * 0.5;
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ id, data: mono, sampleRate: sr }, [mono.buffer]);
  });
}

export async function decodeFile(ctx, file) {
  const ab = await file.arrayBuffer();
  return await ctx.decodeAudioData(ab);
}
