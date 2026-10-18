// MP3 encoding off the UI thread (LAME). Input: Float32 L/R, output: raw MP3 frames.
import { Mp3Encoder } from '@breezystack/lamejs';

self.onmessage = (e) => {
  const { L, R, sampleRate, kbps } = e.data;
  try {
    const enc = new Mp3Encoder(2, sampleRate, kbps);
    const BLOCK = 1152 * 16;
    const parts = [];
    let total = 0;
    const l16 = new Int16Array(BLOCK), r16 = new Int16Array(BLOCK);
    for (let i = 0; i < L.length; i += BLOCK) {
      const n = Math.min(BLOCK, L.length - i);
      for (let j = 0; j < n; j++) {
        const a = Math.max(-1, Math.min(1, L[i + j])), b = Math.max(-1, Math.min(1, R[i + j]));
        l16[j] = a < 0 ? a * 32768 : a * 32767;
        r16[j] = b < 0 ? b * 32768 : b * 32767;
      }
      const buf = enc.encodeBuffer(l16.subarray(0, n), r16.subarray(0, n));
      if (buf.length) { parts.push(new Uint8Array(buf)); total += buf.length; }
      if ((i / BLOCK) % 20 === 0) self.postMessage({ progress: i / L.length });
    }
    const end = enc.flush();
    if (end.length) { parts.push(new Uint8Array(end)); total += end.length; }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    self.postMessage({ done: true, data: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
