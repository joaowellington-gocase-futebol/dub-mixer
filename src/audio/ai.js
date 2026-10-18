// AI stem separation client (htdemucs). Desktop (Electron) runs it in a utility process;
// the Vite dev server exposes the same worker over HTTP for testing. Android/web: not available.
const native = typeof window !== 'undefined' && window.dubNative && window.dubNative.aiSeparate ? window.dubNative : null;
const devBridge = !native && import.meta.env && import.meta.env.DEV;

let seq = 0;
let infoCache = null;

// -> { available, modelReady }
export async function aiInfo(refresh = false) {
  if (infoCache && !refresh) return infoCache;
  try {
    if (native) infoCache = await native.aiInfo();
    else if (devBridge) infoCache = await (await fetch('/__ai/info')).json();
    else infoCache = { available: false, modelReady: false };
  } catch (e) {
    infoCache = { available: false, modelReady: false };
  }
  return infoCache;
}

// Int16 planes [vocalL, vocalR, drumsL, drumsR, bass] -> AudioBuffers at the source rate
function toBuffers(ctx, { frames, sampleRate, scales, data }) {
  const bytes = data.byteOffset % 2 ? data.slice() : data;
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, frames * 5);
  const mk = (planes) => {
    const b = ctx.createBuffer(planes.length, frames, sampleRate);
    planes.forEach((p, ch) => {
      const out = b.getChannelData(ch);
      const src = i16.subarray(p * frames, (p + 1) * frames);
      const k = scales[p] / 32767;
      for (let i = 0; i < frames; i++) out[i] = src[i] * k;
    });
    return b;
  };
  return { vocal: mk([0, 1]), drums: mk([2, 3]), bass: mk([4]) };
}

// onProgress({ stage: 'queued'|'download'|'prepare'|'load'|'separate'|'write', p })
// -> { promise: Promise<{vocal, drums, bass}>, cancel() }; a canceled job rejects with err.canceled
export function separateBuffer(ctx, buffer, onProgress = () => {}) {
  const id = `ai${Date.now().toString(36)}${seq++}`;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const fail = (r) => { const e = new Error(r.error || 'falhou'); e.canceled = !!r.canceled; throw e; };

  if (native) {
    const promise = native.aiSeparate({ id, sampleRate: buffer.sampleRate, left, right }, onProgress)
      .then((r) => (r.ok ? toBuffers(ctx, r) : fail(r)))
      .finally(() => { infoCache = null; });
    return { promise, cancel: () => native.aiCancel(id) };
  }
  if (devBridge) {
    const ac = new AbortController();
    let canceled = false;
    const promise = (async () => {
      const res = await fetch(`/__ai/separate?id=${id}&sr=${buffer.sampleRate}&frames=${buffer.length}`, {
        method: 'POST', body: new Blob([left, right]), signal: ac.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let text = '', done = null;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        text += dec.decode(value, { stream: true });
        let nl;
        while ((nl = text.indexOf('\n')) >= 0) {
          const m = JSON.parse(text.slice(0, nl));
          text = text.slice(nl + 1);
          if (m.type === 'progress') onProgress(m);
          else if (m.type === 'done') done = m;
          else if (m.type === 'error') fail(m);
        }
      }
      if (!done) fail({ error: 'conexão perdida' });
      const data = new Uint8Array(await (await fetch(`/__ai/result?id=${id}`)).arrayBuffer());
      return toBuffers(ctx, { ...done, data });
    })().catch((e) => { if (canceled) e.canceled = true; throw e; })
      .finally(() => { infoCache = null; });
    return { promise, cancel: () => { canceled = true; ac.abort(); fetch(`/__ai/cancel?id=${id}`).catch(() => {}); } };
  }
  return { promise: Promise.reject(new Error('separação por IA não disponível aqui')), cancel() {} };
}
