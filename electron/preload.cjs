// Exposes a minimal, safe API to the renderer (contextIsolation stays on).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // Native "choose a folder" dialog; resolves to an absolute path or null.
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
