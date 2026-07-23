import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('weldsuiteTitlebar', {
  platform: process.platform,
  navBack: () => ipcRenderer.invoke('weldsuite:nav-back'),
  navForward: () => ipcRenderer.invoke('weldsuite:nav-forward'),
  navReload: () => ipcRenderer.invoke('weldsuite:nav-reload'),
  getNavState: () => ipcRenderer.invoke('weldsuite:nav-state'),
  onNavState: (listener: (s: { canGoBack: boolean; canGoForward: boolean }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, s: { canGoBack: boolean; canGoForward: boolean }) => listener(s);
    ipcRenderer.on('weldsuite:nav-state', handler);
    return () => ipcRenderer.removeListener('weldsuite:nav-state', handler);
  },
  onTitle: (listener: (title: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, t: string) => listener(t);
    ipcRenderer.on('weldsuite:page-title', handler);
    return () => ipcRenderer.removeListener('weldsuite:page-title', handler);
  },
});
