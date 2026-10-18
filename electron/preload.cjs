const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dubNative', {
  platform: process.platform,
  saveFile: (name, data, filters) => ipcRenderer.invoke('save-file', { name, data, filters }),
  setDirty: (d) => ipcRenderer.send('set-dirty', d),
  revealFile: (p) => ipcRenderer.invoke('reveal-file', p),
  aiInfo: () => ipcRenderer.invoke('ai-info'),
  aiSeparate: (job, onProgress) => {
    const h = (_e, p) => { if (p.id === job.id) onProgress(p); };
    ipcRenderer.on('ai-progress', h);
    return ipcRenderer.invoke('ai-separate', job).finally(() => ipcRenderer.removeListener('ai-progress', h));
  },
  aiCancel: (id) => ipcRenderer.invoke('ai-cancel', id),
});
