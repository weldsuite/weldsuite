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

declare global {
  interface Window {
    weldsuiteDesktop?: WeldsuiteDesktopApi;
  }
}

export {};
