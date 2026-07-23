import { contextBridge, ipcRenderer } from 'electron';

export interface DesktopSource {
  id: string;
  name: string;
  displayId: string;
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
}

export interface AuthCallback {
  url: string;
  params: Record<string, string>;
}

export interface DesktopSettings {
  autoLaunch: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  notificationsEnabled: boolean;
  hardwareAcceleration: boolean;
}

export interface SettingsApi {
  get(): Promise<DesktopSettings>;
  set(partial: Partial<DesktopSettings>): Promise<{ settings: DesktopSettings; restartRequired: Array<keyof DesktopSettings> }>;
  defaults(): Promise<DesktopSettings>;
}

export interface WeldsuiteDesktopApi {
  readonly isDesktop: true;
  readonly platform: NodeJS.Platform;
  getAppInfo(): Promise<{ platform: NodeJS.Platform; version: string; appUrl: string; deepLinkScheme: string }>;
  getDesktopSources(opts?: {
    types?: Array<'screen' | 'window'>;
    thumbnailSize?: { width: number; height: number };
  }): Promise<DesktopSource[]>;
  setBadgeCount(count: number): Promise<boolean>;
  showNotification(opts: { title: string; body?: string; silent?: boolean }): Promise<boolean>;
  flashFrame(flag: boolean): Promise<void>;
  openExternal(url: string): Promise<boolean>;
  signInExternally(opts?: { path?: string; returnTo?: string }): Promise<{ url: string; returnTo: string }>;
  reloadApp(): Promise<boolean>;
  relaunch(): Promise<boolean>;
  settings: SettingsApi;
  onDeepLink(listener: (url: string) => void): () => void;
  onAuthCallback(listener: (payload: AuthCallback) => void): () => void;
}

const api: WeldsuiteDesktopApi = {
  isDesktop: true,
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('weldsuite:app-info'),
  getDesktopSources: (opts) => ipcRenderer.invoke('weldsuite:get-desktop-sources', opts ?? {}),
  setBadgeCount: (count) => ipcRenderer.invoke('weldsuite:set-badge-count', count),
  showNotification: (opts) => ipcRenderer.invoke('weldsuite:show-notification', opts),
  flashFrame: (flag) => ipcRenderer.invoke('weldsuite:flash-frame', flag),
  openExternal: (url) => ipcRenderer.invoke('weldsuite:open-external', url),
  signInExternally: (opts) => ipcRenderer.invoke('weldsuite:sign-in-external', opts ?? {}),
  reloadApp: () => ipcRenderer.invoke('weldsuite:reload-app'),
  relaunch: () => ipcRenderer.invoke('weldsuite:relaunch'),
  settings: {
    get: () => ipcRenderer.invoke('weldsuite:settings:get'),
    set: (partial) => ipcRenderer.invoke('weldsuite:settings:set', partial),
    defaults: () => ipcRenderer.invoke('weldsuite:settings:defaults'),
  },
  onDeepLink: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) => listener(url);
    ipcRenderer.on('weldsuite:deep-link', handler);
    return () => ipcRenderer.removeListener('weldsuite:deep-link', handler);
  },
  onAuthCallback: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AuthCallback) => listener(payload);
    ipcRenderer.on('weldsuite:auth-callback', handler);
    return () => ipcRenderer.removeListener('weldsuite:auth-callback', handler);
  },
};

contextBridge.exposeInMainWorld('weldsuiteDesktop', api);

// Alt+Left / Alt+Right browser-style shortcuts — route to the shell.
window.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); ipcRenderer.invoke('weldsuite:nav-back'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); ipcRenderer.invoke('weldsuite:nav-forward'); }
});
