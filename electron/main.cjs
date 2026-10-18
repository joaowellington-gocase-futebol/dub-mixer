const { app, BrowserWindow, ipcMain, dialog, Menu, shell, utilityProcess, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const { createRunner } = require('./ai/runner.cjs');

let win;
let dirty = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0d0c0b',
    title: 'DUB-MIXER',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Sair', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'DUB-MIXER',
      message: 'Você tem gravações não exportadas. Fechar o DUB-MIXER mesmo assim?',
    });
    if (choice !== 0) e.preventDefault();
  });
}

ipcMain.handle('save-file', async (_e, { name, data, filters }) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('music'), name),
    filters: filters || [],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  await fs.promises.writeFile(res.filePath, Buffer.from(data));
  return { ok: true, path: res.filePath };
});

ipcMain.on('set-dirty', (_e, d) => { dirty = !!d; });

ipcMain.handle('reveal-file', (_e, p) => shell.showItemInFolder(p));

// ---- AI stems (htdemucs in a utility process; model downloaded on first use)
let aiRunner = null;
function ai() {
  if (!aiRunner) {
    aiRunner = createRunner({
      modelDir: path.join(app.getPath('userData'), 'models'),
      tmpDir: path.join(app.getPath('temp'), 'dub-mixer-ai'),
      fork: (script) => {
        const c = utilityProcess.fork(script, [], { serviceName: 'DUB-MIXER AI', stdio: 'inherit' });
        return { post: (m) => c.postMessage(m), onMessage: (f) => c.on('message', f), onExit: (f) => c.on('exit', f), kill: () => c.kill() };
      },
    });
  }
  return aiRunner;
}
function aiSupported() {
  try {
    const dir = path.dirname(require.resolve('onnxruntime-node/package.json'));
    return fs.existsSync(path.join(dir, 'bin', 'napi-v6', process.platform, process.arch, 'onnxruntime_binding.node'));
  } catch (e) {
    return false;
  }
}

ipcMain.handle('ai-info', () => ({ available: aiSupported(), modelReady: aiSupported() && ai().hasModel() }));

ipcMain.handle('ai-separate', async (e, { id, sampleRate, left, right }) => {
  if (!aiSupported()) return { ok: false, error: 'separação por IA não disponível neste computador' };
  // keep macOS App Nap from throttling a separation that runs while the window is in the background
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  try {
    const r = await ai().separate({
      id, sampleRate, left, right,
      onProgress: (p) => { if (!e.sender.isDestroyed()) e.sender.send('ai-progress', { id, ...p }); },
    });
    return { ok: true, frames: r.frames, sampleRate: r.sampleRate, scales: r.scales, data: new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength) };
  } catch (err) {
    return { ok: false, canceled: !!err.canceled, error: err.message };
  } finally {
    powerSaveBlocker.stop(blocker);
  }
});

ipcMain.handle('ai-cancel', (_e, id) => (aiRunner ? aiRunner.cancel(id) : false));

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
