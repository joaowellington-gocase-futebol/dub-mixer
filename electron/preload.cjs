const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dubNative', {
  platform: process.platform,
  saveFile: (name, data, filters) => ipcRenderer.invoke('save-file', { name, data, filters }),
  setDirty: (d) => ipcRenderer.send('set-dirty', d),
  revealFile: (p) => ipcRenderer.invoke('reveal-file', p),
});
