import Mp3Worker from './mp3.worker.js?worker&inline';
import { buildId3, concat } from './id3.js';

const MP3_RATES = [32000, 44100, 48000];

async function resample(channels, from, to) {
  const len = Math.ceil((channels[0].length * to) / from);
  const off = new OfflineAudioContext(2, len, to);
  const b = off.createBuffer(2, channels[0].length, from);
  b.copyToChannel(channels[0], 0);
  b.copyToChannel(channels[1], 1);
  const s = off.createBufferSource();
  s.buffer = b;
  s.connect(off.destination);
  s.start();
  const r = await off.startRendering();
  return [r.getChannelData(0), r.getChannelData(1)];
}

export async function encodeMp3(channels, sampleRate, kbps, meta, onProgress) {
  let ch = channels, sr = sampleRate;
  if (!MP3_RATES.includes(sr)) { ch = await resample(channels, sr, 48000); sr = 48000; }
  const L = ch[0].slice(), R = ch[1].slice();
  const raw = await new Promise((resolve, reject) => {
    const w = new Mp3Worker();
    w.onmessage = (e) => {
      if (e.data.progress != null && onProgress) onProgress(e.data.progress);
      if (e.data.done) { w.terminate(); resolve(e.data.data); }
      if (e.data.error) { w.terminate(); reject(new Error(e.data.error)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'MP3 worker error')); };
    w.postMessage({ L, R, sampleRate: sr, kbps }, [L.buffer, R.buffer]);
  });
  return concat([buildId3(meta), raw]);
}
