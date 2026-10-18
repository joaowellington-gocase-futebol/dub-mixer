// WAV encoder: 16-bit (TPDF dither), 24-bit, 32-bit float. Embeds LIST/INFO + ID3 (cover art).
import { buildId3, concat, latin1 } from './id3.js';

function chunk(id, body) {
  const pad = body.length & 1;
  const out = new Uint8Array(8 + body.length + pad);
  out.set(latin1(id), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function infoList(meta) {
  const items = [['INAM', meta.title], ['IART', meta.artist], ['IPRD', meta.album], ['ICRD', meta.year],
    ['IGNR', meta.genre], ['ICMT', meta.comment], ['ISFT', 'DUB-MIXER']];
  const parts = [latin1('INFO')];
  for (const [id, v] of items) {
    if (!v) continue;
    const enc = new TextEncoder().encode(String(v) + '\0');
    parts.push(chunk(id, enc));
  }
  return chunk('LIST', concat(parts));
}

export function encodeWav(channels, sampleRate, bits = 24, meta = {}) {
  const nCh = channels.length;
  const n = channels[0].length;
  const float = bits === 32;
  const bps = bits / 8;
  const data = new Uint8Array(n * nCh * bps);
  const dv = new DataView(data.buffer);
  let o = 0;
  if (bits === 16) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nCh; c++) {
        const d = (Math.random() - Math.random()) / 32768; // TPDF dither
        let v = Math.max(-1, Math.min(1, channels[c][i] + d));
        dv.setInt16(o, Math.round(v * 32767), true); o += 2;
      }
    }
  } else if (bits === 24) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nCh; c++) {
        const v = Math.max(-1, Math.min(1, channels[c][i]));
        let s = Math.round(v * 8388607);
        if (s < 0) s += 0x1000000;
        data[o] = s & 0xff; data[o + 1] = (s >> 8) & 0xff; data[o + 2] = (s >> 16) & 0xff; o += 3;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nCh; c++) { dv.setFloat32(o, channels[c][i], true); o += 4; }
    }
  }
  const fmt = new Uint8Array(float ? 18 : 16);
  const f = new DataView(fmt.buffer);
  f.setUint16(0, float ? 3 : 1, true);
  f.setUint16(2, nCh, true);
  f.setUint32(4, sampleRate, true);
  f.setUint32(8, sampleRate * nCh * bps, true);
  f.setUint16(12, nCh * bps, true);
  f.setUint16(14, bits, true);
  const parts = [latin1('WAVE'), chunk('fmt ', fmt)];
  if (float) {
    const fact = new Uint8Array(4);
    new DataView(fact.buffer).setUint32(0, n, true);
    parts.push(chunk('fact', fact));
  }
  parts.push(chunk('data', data));
  parts.push(infoList(meta));
  parts.push(chunk('id3 ', buildId3(meta)));
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  out.set(latin1('RIFF'), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}
