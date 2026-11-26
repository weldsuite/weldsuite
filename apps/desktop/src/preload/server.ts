import { contextBridge, ipcRenderer } from 'electron';

// The "Change server…" window's bridge (src/renderer/server). Main answers
// these from that window only.
contextBridge.exposeInMainWorld('weldsuiteServer', {
  get: () => ipcRenderer.invoke('weldsuite:server:get'),
  use: (address: string | null) => ipcRenderer.invoke('weldsuite:server:use', address),
  close: () => ipcRenderer.send('weldsuite:server:close'),
});
