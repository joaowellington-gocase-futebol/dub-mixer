import { defineConfig } from 'vite';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fork } from 'child_process';

const require = createRequire(import.meta.url);

// Dev only: exposes the desktop AI stem separator (electron/ai) over HTTP so the
// `npm run dev` page (and tests/stemtest.js) can use it. Not part of any build.
function aiDevBridge() {
  return {
    name: 'dub-ai-dev-bridge',
    apply: 'serve',
    configureServer(server) {
      const { createRunner } = require('./electron/ai/runner.cjs');
      const home = os.homedir();
      const userData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'DUB-MIXER')
        : process.platform === 'win32' ? path.join(process.env.APPDATA || home, 'DUB-MIXER')
          : path.join(home, '.config', 'DUB-MIXER');
      const runner = createRunner({
        modelDir: path.join(userData, 'models'),
        fork: (script) => {
          const c = fork(script, [], { stdio: 'inherit' });
          return { post: (m) => c.send(m), onMessage: (f) => c.on('message', f), onExit: (f) => c.on('exit', f), kill: () => c.kill() };
        },
      });
      let available = false;
      try {
        const dir = path.dirname(require.resolve('onnxruntime-node/package.json'));
        available = fs.existsSync(path.join(dir, 'bin', 'napi-v6', process.platform, process.arch, 'onnxruntime_binding.node'));
      } catch (e) { /* not installed */ }
      const results = new Map();
      const query = (req) => new URL(req.url, 'http://x').searchParams;

      server.middlewares.use('/__ai/info', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ available, modelReady: available && runner.hasModel() }));
      });
      server.middlewares.use('/__ai/separate', (req, res) => {
        const q = query(req);
        const id = q.get('id'), sampleRate = +q.get('sr'), frames = +q.get('frames');
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const all = new Float32Array(frames * 2);
          new Uint8Array(all.buffer).set(body.subarray(0, frames * 8));
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
          res.on('close', () => { if (!res.writableFinished) runner.cancel(id); });
          const line = (m) => { if (!res.writableEnded) res.write(JSON.stringify(m) + '\n'); };
          runner.separate({
            id, sampleRate, left: all.subarray(0, frames), right: all.subarray(frames),
            onProgress: (p) => line({ type: 'progress', ...p }),
          }).then((r) => {
            results.set(id, r);
            setTimeout(() => results.delete(id), 120000);
            line({ type: 'done', frames: r.frames, sampleRate: r.sampleRate, scales: r.scales });
            res.end();
          }, (e) => {
            line({ type: 'error', error: e.message, canceled: !!e.canceled });
            res.end();
          });
        });
      });
      server.middlewares.use('/__ai/result', (req, res) => {
        const id = query(req).get('id');
        const r = results.get(id);
        if (!r) { res.statusCode = 404; res.end(); return; }
        results.delete(id);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(r.data);
      });
      server.middlewares.use('/__ai/cancel', (req, res) => {
        res.end(String(runner.cancel(query(req).get('id'))));
      });
    },
  };
}

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  plugins: [aiDevBridge()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
  // DUB_NO_HMR=1: no live reload (long test runs while other files are being edited)
  server: { port: 5199, strictPort: true, hmr: process.env.DUB_NO_HMR ? false : undefined },
});
