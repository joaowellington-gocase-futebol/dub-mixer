// DUB-MIXER AI stems: model download/cache + one-at-a-time separation jobs in a worker process.
// Shared by the Electron main process and the Vite dev server (tests), which inject `fork`.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MODEL = {
  file: 'htdemucs_fp16weights.onnx',
  // HT-Demucs v4 (Meta, MIT) exported to ONNX by adowu/htdemucs-onnx, pinned revision
  url: 'https://huggingface.co/adowu/htdemucs-onnx/resolve/e6b688a9a9f977e2efaba79d0f18b9b0cfc606ea/htdemucs_fp16weights.onnx',
  sha256: 'd05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a',
  size: 165612636,
};
const WORKER = path.join(__dirname, 'worker.cjs');

class Canceled extends Error { constructor() { super('canceled'); this.canceled = true; } }

function modelPath(dir) { return path.join(dir, MODEL.file); }
function hasModel(dir) {
  try { return fs.statSync(modelPath(dir)).size === MODEL.size; } catch (e) { return false; }
}

async function downloadModel(dir, onProgress, signal) {
  const dest = modelPath(dir);
  if (hasModel(dir)) return dest;
  await fs.promises.mkdir(dir, { recursive: true });
  const part = dest + '.part';
  const res = await fetch(MODEL.url, { signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download do modelo falhou (HTTP ${res.status})`);
  const total = +res.headers.get('content-length') || MODEL.size;
  const hash = crypto.createHash('sha256');
  const fh = await fs.promises.open(part, 'w');
  let got = 0, last = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      await fh.write(value);
      got += value.length;
      if (got - last > 512 * 1024) { last = got; onProgress(got / total); }
    }
  } catch (e) {
    await fh.close().catch(() => {});
    await fs.promises.rm(part, { force: true });
    if (signal && signal.aborted) throw new Canceled();
    throw e;
  }
  await fh.close();
  if (hash.digest('hex') !== MODEL.sha256) {
    await fs.promises.rm(part, { force: true });
    throw new Error('modelo baixado está corrompido (hash não confere)');
  }
  await fs.promises.rename(part, dest);
  onProgress(1);
  return dest;
}

// fork(scriptPath) -> { post(msg), onMessage(fn), onExit(fn), kill() }
function createRunner({ fork, modelDir, tmpDir = path.join(os.tmpdir(), 'dub-mixer-ai') }) {
  let chain = Promise.resolve();
  const jobs = new Map();

  async function exec(job) {
    const { id, sampleRate, left, right, onProgress } = job;
    if (job.canceled) throw new Canceled();
    const ac = new AbortController();
    job.abort = () => ac.abort();
    const model = await downloadModel(modelDir, (p) => onProgress({ stage: 'download', p }), ac.signal)
      .catch((e) => { throw job.canceled ? new Canceled() : e; });
    if (job.canceled) throw new Canceled();

    await fs.promises.mkdir(tmpDir, { recursive: true });
    const frames = left.length;
    const inPath = path.join(tmpDir, `${id}.in.f32`);
    const outPath = path.join(tmpDir, `${id}.out.i16`);
    const fh = await fs.promises.open(inPath, 'w');
    await fh.write(new Uint8Array(left.buffer, left.byteOffset, left.byteLength));
    await fh.write(new Uint8Array(right.buffer, right.byteOffset, right.byteLength));
    await fh.close();
    job.left = job.right = null;

    try {
      const result = await new Promise((resolve, reject) => {
        const child = fork(WORKER);
        let finished = false;
        job.abort = () => { finished = true; child.kill(); reject(new Canceled()); };
        child.onMessage((m) => {
          if (!m) return;
          if (m.type === 'progress') onProgress({ stage: m.stage, p: m.p });
          else if (m.type === 'done') { finished = true; child.kill(); resolve(m); }
          else if (m.type === 'error') { finished = true; child.kill(); reject(new Error(m.message)); }
        });
        child.onExit((code) => {
          if (!finished) reject(new Error(`o processo de separação parou (código ${code}). Pouca memória?`));
        });
        child.post({ type: 'run', modelPath: model, inPath, outPath, sampleRate, frames });
      });
      const data = await fs.promises.readFile(outPath);
      return { frames, sampleRate, scales: result.scales, data };
    } finally {
      fs.promises.rm(inPath, { force: true }).catch(() => {});
      fs.promises.rm(outPath, { force: true }).catch(() => {});
    }
  }

  // left/right: Float32Array at the deck's sample rate
  function separate({ id, sampleRate, left, right, onProgress = () => {} }) {
    const job = { id, sampleRate, left, right, onProgress, canceled: false, abort: null };
    jobs.set(id, job);
    onProgress({ stage: 'queued', p: 0 });
    const p = chain.then(() => exec(job));
    chain = p.catch(() => {});
    return p.finally(() => jobs.delete(id));
  }
  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return false;
    job.canceled = true;
    if (job.abort) job.abort();
    return true;
  }
  return { separate, cancel, hasModel: () => hasModel(modelDir) };
}

module.exports = { createRunner, downloadModel, hasModel, MODEL, WORKER, Canceled };
