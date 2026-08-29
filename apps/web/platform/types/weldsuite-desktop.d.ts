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
  showNotification(opts: {
    title: string;
    body?: string;
    silent?: boolean;
    actionUrl?: string;
  }): Promise<boolean>;
  flashFrame(flag: boolean): Promise<void>;
  openExternal(url: string): Promise<boolean>;
  signInExternally(opts?: { path?: string; returnTo?: string }): Promise<{ url: string; returnTo: string }>;
  reloadApp(): Promise<boolean>;
  relaunch(): Promise<boolean>;
  settings: SettingsApi;
  onDeepLink(listener: (url: string) => void): () => void;
  onAuthCallback(listener: (payload: AuthCallback) => void): () => void;
  onNotificationClick(listener: (payload: { actionUrl?: string }) => void): () => void;
  /**
   * Register the screen-share source picker.
   *
   * The shell calls `handler` when the page requests display media on a
   * platform with no OS picker (Windows, older macOS, X11), and waits for it
   * to resolve with the id of the chosen source — or `null` to cancel, which
   * makes `getDisplayMedia` reject.
   *
   * While no handler is registered the shell denies screen-share requests
   * outright, so this must stay mounted for the life of the session.
   * `<DesktopSourcePicker />` in the root route does that.
   */
  onSelectSource(handler: (sources: DesktopSource[]) => Promise<string | null> | string | null): () => void;
}

declare global {
  interface Window {
    weldsuiteDesktop?: WeldsuiteDesktopApi;
  }
}

export {};
