import { app, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, shell, nativeImage, desktopCapturer, session, Notification } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings, loadSettingsSync, getSettings, applySettings, DEFAULT_SETTINGS, type DesktopSettings } from './settings';

process.on('uncaughtException', (err) => {
  console.error('[weldsuite-desktop] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[weldsuite-desktop] unhandledRejection:', reason);
});

// Read settings synchronously BEFORE app.whenReady() so we can honour the
// `hardwareAcceleration` flag — it must be disabled pre-ready or it's a no-op.
// Wrapped defensively: any failure here falls back to defaults (hw-accel on)
// rather than crashing the process.
try {
  const earlySettings = loadSettingsSync();
  if (!earlySettings.hardwareAcceleration) {
    app.disableHardwareAcceleration();
  }
} catch (err) {
  console.error('[weldsuite-desktop] failed to load early settings:', err);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_URL = process.env.DESKTOP_APP_URL
  ?? (process.env.NODE_ENV === 'development'
    ? 'http://localhost:3000'
    : 'https://app.weldsuite.com');

const DEEP_LINK_SCHEME = 'weldsuite';
const TITLEBAR_HEIGHT = 32;

// OAuth providers + identity hosts that MUST be driven through the system
// browser (they detect Electron webviews and refuse, or we want them isolated).
const EXTERNAL_AUTH_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'github.com/login',
  'www.facebook.com/dialog',
  'oauth.slack.com',
  'slack.com/openid',
];

// Inline email/password sign-in works fine inside Electron. Only OAuth
// providers are pushed to the system browser.
function shouldOpenExternally(targetUrl: string): boolean {
  try {
    const u = new URL(targetUrl);
    return EXTERNAL_AUTH_HOSTS.some((h) => (u.host + u.pathname).startsWith(h));
  } catch {
    return false;
  }
}

// Brand-chrome color — matches the WeldSuite app's dark sidebar/background so
// the titlebar flows visually into the content below. Tweak here to re-theme.
const CHROME_BG = '#0b0b0f';
const CHROME_FG = '#e6e6ea';

let mainWindow: BrowserWindow | null = null;
let appView: WebContentsView | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function appWebContents(): Electron.WebContents | null {
  return appView?.webContents ?? null;
}

console.log('[weldsuite-desktop] main starting, pid=', process.pid);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[weldsuite-desktop] another instance already running, exiting');
  app.quit();
  process.exit(0);
}
console.log('[weldsuite-desktop] got single-instance lock');

app.on('second-instance', (_event, argv) => {
  focusMainWindow();
  const deepLink = argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`));
  if (deepLink) routeDeepLink(deepLink);
});

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1]!)]);
  }
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  routeDeepLink(url);
});

function routeDeepLink(url: string) {
  const wc = appWebContents();
  if (!wc) return;
  focusMainWindow();
  wc.send('weldsuite:deep-link', url);
  try {
    const parsed = new URL(url);
    if (parsed.host === 'auth' || parsed.pathname.startsWith('/auth')) {
      const params: Record<string, string> = {};
      parsed.searchParams.forEach((v, k) => { params[k] = v; });
      wc.send('weldsuite:auth-callback', { url, params });
    }
  } catch {
    // ignore malformed deep links
  }
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: CHROME_BG,
    icon: getTrayIcon(),
    // BrowserWindow's own webContents renders our titlebar HTML at the top;
    // the app renders below in a WebContentsView shifted down by TITLEBAR_HEIGHT.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'win32' ? {
      titleBarOverlay: {
        color: CHROME_BG,
        symbolColor: CHROME_FG,
        height: TITLEBAR_HEIGHT,
      },
    } : {}),
    trafficLightPosition: process.platform === 'darwin' ? { x: 10, y: 8 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/titlebar.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    resizeAppView();
    if (!getSettings().startMinimized) {
      mainWindow?.show();
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  // Dev only: diagnostics for titlebar webContents load.
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[titlebar] did-fail-load ${url}: ${desc} (${code})`);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      console.log(`[titlebar] loaded ${mainWindow?.webContents.getURL()}`);
    });
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log(`[titlebar-renderer] ${message}`);
    });
  }

  // Titlebar HTML → BrowserWindow's own webContents.
  const titlebarUrl = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/titlebar/index.html`
    : `file://${path.join(__dirname, '../renderer/titlebar/index.html')}`;
  mainWindow.loadURL(titlebarUrl).catch((err) => {
    console.error('[weldsuite-desktop] failed to load titlebar:', err);
  });

  // App view — positioned below the titlebar, fills the remaining area.
  appView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  mainWindow.contentView.addChildView(appView);
  appView.setBackgroundColor(CHROME_BG);
  resizeAppView();

  mainWindow.on('resize', resizeAppView);
  mainWindow.on('maximize', resizeAppView);
  mainWindow.on('unmaximize', resizeAppView);
  mainWindow.on('enter-full-screen', resizeAppView);
  mainWindow.on('leave-full-screen', resizeAppView);

  appView.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  appView.webContents.on('will-navigate', (event, targetUrl) => {
    if (shouldOpenExternally(targetUrl)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  appView.webContents.on('will-redirect', (event, targetUrl) => {
    if (shouldOpenExternally(targetUrl)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  const pushNavState = () => {
    if (!appView || !mainWindow) return;
    const wc = appView.webContents;
    const history = wc.navigationHistory;
    mainWindow.webContents.send('weldsuite:nav-state', {
      canGoBack: history ? history.canGoBack() : wc.canGoBack(),
      canGoForward: history ? history.canGoForward() : wc.canGoForward(),
    });
  };

  appView.webContents.on('did-navigate', pushNavState);
  appView.webContents.on('did-navigate-in-page', pushNavState);
  appView.webContents.on('did-finish-load', pushNavState);

  appView.webContents.on('page-title-updated', (_e, title) => {
    mainWindow?.webContents.send('weldsuite:page-title', title);
  });

  appView.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    console.warn(`[weldsuite-desktop] failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && getSettings().closeToTray && process.platform !== 'linux') {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    appView = null;
  });

  loadAppUrl();
}

function resizeAppView() {
  if (!mainWindow || !appView) return;
  const bounds = mainWindow.getContentBounds();
  // Guard against a (0,0) bounds return that can happen before the window
  // is shown — positioning the child view with width/height 0 can leave stale
  // layout even after bounds become valid.
  if (bounds.width <= 0 || bounds.height <= 0) return;
  appView.setBounds({
    x: 0,
    y: TITLEBAR_HEIGHT,
    width: bounds.width,
    height: Math.max(0, bounds.height - TITLEBAR_HEIGHT),
  });
}

function loadAppUrl() {
  appView?.webContents.loadURL(APP_URL).catch(() => undefined);
}

function getTrayIcon() {
  const iconPath = path.join(process.resourcesPath ?? path.join(__dirname, '../../resources'), 'trayTemplate.png');
  return nativeImage.createFromPath(iconPath);
}

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('WeldSuite');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open WeldSuite', click: () => focusMainWindow() },
    { label: 'Reload', click: () => appView?.webContents.reload() },
    { type: 'separator' },
    { label: 'Check for updates', click: () => autoUpdater.checkForUpdatesAndNotify().catch(() => undefined) },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => focusMainWindow());
}

function registerIpc() {
  ipcMain.handle('weldsuite:get-desktop-sources', async (_event, opts: { types?: Array<'screen' | 'window'>; thumbnailSize?: { width: number; height: number } } = {}) => {
    const sources = await desktopCapturer.getSources({
      types: opts.types ?? ['screen', 'window'],
      thumbnailSize: opts.thumbnailSize ?? { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      displayId: s.display_id,
      thumbnailDataUrl: s.thumbnail.toDataURL(),
      appIconDataUrl: s.appIcon?.toDataURL() ?? null,
    }));
  });

  ipcMain.handle('weldsuite:set-badge-count', (_event, count: number) => {
    if (typeof count !== 'number' || Number.isNaN(count)) return false;
    if (process.platform === 'darwin') {
      app.dock?.setBadge(count > 0 ? String(count) : '');
    } else {
      app.setBadgeCount(count);
    }
    return true;
  });

  ipcMain.handle('weldsuite:show-notification', (_event, opts: { title: string; body?: string; silent?: boolean }) => {
    if (!Notification.isSupported()) return false;
    if (!getSettings().notificationsEnabled) return false;
    const n = new Notification({
      title: opts.title,
      body: opts.body ?? '',
      silent: opts.silent ?? false,
    });
    n.on('click', () => focusMainWindow());
    n.show();
    return true;
  });

  ipcMain.handle('weldsuite:flash-frame', (_event, flag: boolean) => {
    mainWindow?.flashFrame(flag);
  });

  ipcMain.handle('weldsuite:open-external', (_event, url: string) => {
    if (!/^https?:\/\//.test(url)) return false;
    shell.openExternal(url);
    return true;
  });

  ipcMain.handle('weldsuite:app-info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    appUrl: APP_URL,
    deepLinkScheme: DEEP_LINK_SCHEME,
  }));

  ipcMain.handle('weldsuite:sign-in-external', (_event, opts: { path?: string; returnTo?: string } = {}) => {
    const appOrigin = new URL(APP_URL).origin;
    const returnTo = `${DEEP_LINK_SCHEME}://auth`;
    const targetPath = opts.path ?? '/auth/login';
    const url = new URL(targetPath, appOrigin);
    url.searchParams.set('desktop', '1');
    url.searchParams.set('return_to', opts.returnTo ?? returnTo);
    shell.openExternal(url.toString());
    return { url: url.toString(), returnTo };
  });

  ipcMain.handle('weldsuite:reload-app', () => {
    loadAppUrl();
    return true;
  });

  ipcMain.handle('weldsuite:nav-back', () => {
    if (!appView) return false;
    const wc = appView.webContents;
    const history = wc.navigationHistory;
    if (history?.canGoBack()) { history.goBack(); return true; }
    if (wc.canGoBack()) { wc.goBack(); return true; }
    return false;
  });

  ipcMain.handle('weldsuite:nav-forward', () => {
    if (!appView) return false;
    const wc = appView.webContents;
    const history = wc.navigationHistory;
    if (history?.canGoForward()) { history.goForward(); return true; }
    if (wc.canGoForward()) { wc.goForward(); return true; }
    return false;
  });

  ipcMain.handle('weldsuite:nav-reload', () => {
    appView?.webContents.reload();
    return true;
  });

  ipcMain.handle('weldsuite:settings:get', async () => {
    return loadSettings();
  });

  ipcMain.handle('weldsuite:settings:set', async (_event, partial: Partial<DesktopSettings>) => {
    const next = await saveSettings(partial);
    const restartRequired = applySettings(next);
    return { settings: next, restartRequired };
  });

  ipcMain.handle('weldsuite:settings:defaults', () => {
    return DEFAULT_SETTINGS;
  });

  ipcMain.handle('weldsuite:relaunch', () => {
    app.relaunch();
    isQuitting = true;
    app.quit();
    return true;
  });

  ipcMain.handle('weldsuite:nav-state', () => {
    if (!appView) return { canGoBack: false, canGoForward: false };
    const wc = appView.webContents;
    const history = wc.navigationHistory;
    return {
      canGoBack: history ? history.canGoBack() : wc.canGoBack(),
      canGoForward: history ? history.canGoForward() : wc.canGoForward(),
    };
  });
}

function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const first = sources[0];
    if (!first) {
      callback({});
      return;
    }
    callback({ video: first });
  }, { useSystemPicker: true });
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  // Load full settings async (re-validates file) and apply login-item / OS-level
  // preferences. Hardware-accel was already handled pre-ready using the sync load.
  try {
    const settings = await loadSettings();
    applySettings(settings);
  } catch (err) {
    console.error('[weldsuite-desktop] applySettings failed:', err);
  }

  registerIpc();
  registerDisplayMediaHandler();
  createMainWindow();
  createTray();

  if (process.env.NODE_ENV !== 'development') {
    autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else focusMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
