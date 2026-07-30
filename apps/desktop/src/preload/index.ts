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
  /**
   * Register the screen-share source picker.
   *
   * The shell calls `handler` when the page requests display media on a
   * platform with no OS picker, and waits for it to resolve with the id of the
   * chosen source — or `null` to cancel, which makes `getDisplayMedia` reject.
   *
   * While no handler is registered the shell denies screen-share requests
   * outright, so mount this once, high in the tree. Only one handler is
   * active at a time; registering a second replaces the first.
   */
  onSelectSource(handler: (sources: DesktopSource[]) => Promise<string | null> | string | null): () => void;
}

type SourceHandler = (sources: DesktopSource[]) => Promise<string | null> | string | null;

// Single active picker, dispatched to by one permanent IPC listener. Holding
// the handler in a variable (rather than adding an `ipcRenderer.on` per
// registration) means a re-register genuinely replaces the old picker instead
// of leaving two racing to answer the same request.
let activeSourceHandler: SourceHandler | null = null;

ipcRenderer.on('weldsuite:select-desktop-source', async (
  _event: Electron.IpcRendererEvent,
  payload: { requestId: number; sources: DesktopSource[] },
) => {
  let sourceId: string | null = null;
  try {
    sourceId = (await activeSourceHandler?.(payload.sources)) ?? null;
  } catch (err) {
    console.error('[weldsuite-desktop] source picker threw, cancelling:', err);
    sourceId = null;
  }
  // Always reply. A missing reply would leave the capture request hanging in
  // main until its timeout, with the app frozen behind a permission prompt
  // that never resolves.
  ipcRenderer.send('weldsuite:source-picker-result', { requestId: payload.requestId, sourceId });
});

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
  onSelectSource: (handler) => {
    activeSourceHandler = handler;
    ipcRenderer.send('weldsuite:source-picker-ready', true);
    return () => {
      // Only tear down if this handler is still the active one — under React's
      // StrictMode double-mount the old cleanup runs *after* the replacement
      // registers, and an unconditional clear would leave the shell believing
      // no picker exists.
      if (activeSourceHandler !== handler) return;
      activeSourceHandler = null;
      ipcRenderer.send('weldsuite:source-picker-ready', false);
    };
  },
};

contextBridge.exposeInMainWorld('weldsuiteDesktop', api);

// Alt+Left / Alt+Right browser-style shortcuts — route to the shell.
window.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); ipcRenderer.invoke('weldsuite:nav-back'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); ipcRenderer.invoke('weldsuite:nav-forward'); }
});
