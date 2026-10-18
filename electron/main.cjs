const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

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
