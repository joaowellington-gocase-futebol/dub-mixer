// Minimal ID3v2.3 writer (text frames + front cover APIC).
function u16(str) {
  // UTF-16LE with BOM
  const out = new Uint8Array(2 + str.length * 2);
  out[0] = 0xff; out[1] = 0xfe;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = c >> 8;
  }
  return out;
}
function latin1(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}
function concat(parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function frame(id, body) {
  const h = new Uint8Array(10);
  h.set(latin1(id), 0);
  const n = body.length;
  h[4] = (n >>> 24) & 0xff; h[5] = (n >>> 16) & 0xff; h[6] = (n >>> 8) & 0xff; h[7] = n & 0xff;
  return concat([h, body]);
}
const textFrame = (id, text) => frame(id, concat([new Uint8Array([1]), u16(String(text))]));

export function buildId3(meta = {}) {
  const frames = [];
  if (meta.title) frames.push(textFrame('TIT2', meta.title));
  if (meta.artist) frames.push(textFrame('TPE1', meta.artist));
  if (meta.album) frames.push(textFrame('TALB', meta.album));
  if (meta.year) frames.push(textFrame('TYER', meta.year));
  if (meta.genre) frames.push(textFrame('TCON', meta.genre));
  if (meta.bpm) frames.push(textFrame('TBPM', Math.round(meta.bpm)));
  frames.push(textFrame('TSSE', 'DUB-MIXER'));
  if (meta.comment) {
    frames.push(frame('COMM', concat([
      new Uint8Array([1]), latin1('por'), u16(''), new Uint8Array([0, 0]), u16(meta.comment),
    ])));
  }
  if (meta.cover && meta.cover.length) {
    frames.push(frame('APIC', concat([
      new Uint8Array([0]), latin1(meta.coverMime || 'image/jpeg'), new Uint8Array([0]),
      new Uint8Array([3]), latin1('Cover'), new Uint8Array([0]), meta.cover,
    ])));
  }
  const body = concat(frames);
  const pad = 512;
  const size = body.length + pad;
  const h = new Uint8Array(10);
  h.set(latin1('ID3'), 0);
  h[3] = 3; h[4] = 0; h[5] = 0;
  h[6] = (size >>> 21) & 0x7f; h[7] = (size >>> 14) & 0x7f; h[8] = (size >>> 7) & 0x7f; h[9] = size & 0x7f;
  return concat([h, body, new Uint8Array(pad)]);
}

export { concat, latin1 };
