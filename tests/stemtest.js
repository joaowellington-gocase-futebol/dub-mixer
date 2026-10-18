// Measures how well each stem kill removes its target, using the demo's isolated parts as ground truth.
import { renderDemo } from '/src/audio/demo.js';
import stemsSrc from '/src/audio/worklets/stems.js?raw';
const SR = 48000;
const url = URL.createObjectURL(new Blob([stemsSrc], { type: 'application/javascript' }));
async function split(buf, gains, tune) {
  const off = new OfflineAudioContext(2, buf.length + 4096, SR);
  await off.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(off, 'stem-splitter', { outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { gains, tune } });
  const s = off.createBufferSource(); s.buffer = buf; s.connect(node).connect(off.destination); s.start();
  return off.startRendering();
}
const LAT = 3072;
// SDR-like: how close output is to the ideal (mix minus target)
function compare(out, ideal, target, a, b) {
  let e = 0, t = 0, kept = 0;
  for (let c = 0; c < 2; c++) {
    const o = out.getChannelData(c), id = ideal.getChannelData(c), tg = target.getChannelData(c);
    for (let i = a; i < b; i++) { const d = o[i + LAT] - id[i]; e += d * d; t += tg[i] * tg[i]; kept += id[i] * id[i]; }
  }
  return { targetRemoved_dB: +(10 * Math.log10(t / e)).toFixed(1), residualVsKept_dB: +(10 * Math.log10(e / kept)).toFixed(1) };
}
export async function run(tune) {
  const full = (await renderDemo('onedrop', SR, { raw: true })).buffer;
  const parts = { lead: 0, drums: 1, bass: 2, other: 3 };
  const res = {};
  const a = SR * 15, b = SR * 38; // lead plays in bars 5-12
  for (const [name, idx] of Object.entries(parts)) {
    const rest = Object.keys(parts).filter((k) => k !== name);
    const only = (await renderDemo('onedrop', SR, { raw: true, mute: rest })).buffer;
    const without = (await renderDemo('onedrop', SR, { raw: true, mute: [name] })).buffer;
    const gains = [1, 1, 1, 1]; gains[idx] = 0;
    const out = await split(full, gains, tune);
    res[name] = compare(out, without, only, a, b);
  }
  return res;
}
