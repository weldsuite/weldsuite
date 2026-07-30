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
    : 'https://app.weldsuite.org');

const DEEP_LINK_SCHEME = 'weldsuite';
const TITLEBAR_HEIGHT = 32;

// How long the app gets to answer a screen-share source request before we
// deny it. Generous — the user is reading a grid of window thumbnails — but
// bounded, so a wedged renderer can't leave the capture request hanging.
const SOURCE_PICKER_TIMEOUT_MS = 120_000;

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

// Screen-share source picker state. `rendererPickerReady` tracks whether the
// loaded app has a picker mounted; without one we deny capture rather than
// choose a screen on the user's behalf.
let rendererPickerReady = false;
let pickerRequestSeq = 0;
const pendingSourcePicks = new Map<number, (sourceId: string | null) => void>();

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
    // Electron 35+ carries the details on the event object, with `level` as a
    // string union. The legacy positional form — `(event, level: number, …)`,
    // where level is 0-3 — still fires as of 39 but is deprecated.
    mainWindow.webContents.on('console-message', ({ level, message }) => {
      if (level === 'warning' || level === 'error') {
        console.log(`[titlebar-renderer] ${level}: ${message}`);
      }
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
    mainWindow.webContents.send('weldsuite:nav-state', readNavState());
  };

  // A main-frame navigation replaces the document, taking the mounted picker
  // with it. Fires before the new document's scripts run, so the fresh app
  // re-registers after this.
  appView.webContents.on('did-navigate', resetSourcePicker);

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
    resetSourcePicker();
    mainWindow = null;
    appView = null;
  });

  loadAppUrl();
}

/**
 * Back/forward availability for the app view.
 *
 * Uses `webContents.navigationHistory` exclusively. The older
 * `webContents.canGoBack()` / `goBack()` / `canGoForward()` / `goForward()`
 * methods still exist as of Electron 39 but are deprecated and log a warning
 * on every call, so we don't fall back to them.
 */
function readNavState(): { canGoBack: boolean; canGoForward: boolean } {
  const history = appView?.webContents.navigationHistory;
  if (!history) return { canGoBack: false, canGoForward: false };
  return { canGoBack: history.canGoBack(), canGoForward: history.canGoForward() };
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
    return sources.map(serializeSource);
  });

  // Screen-share picker handshake. Both are `on` (fire-and-forget) rather than
  // `handle` because they flow renderer→main only. The sender check keeps any
  // other webContents — the titlebar, a stray popup — from answering a pick or
  // claiming a picker exists.
  ipcMain.on('weldsuite:source-picker-ready', (event, ready: unknown) => {
    if (event.sender !== appWebContents()) return;
    rendererPickerReady = ready === true;
  });

  ipcMain.on('weldsuite:source-picker-result', (event, payload: { requestId?: unknown; sourceId?: unknown }) => {
    if (event.sender !== appWebContents()) return;
    const requestId = payload?.requestId;
    if (typeof requestId !== 'number') return;
    const resolve = pendingSourcePicks.get(requestId);
    // Already resolved by the timeout, or a duplicate reply — ignore.
    if (!resolve) return;
    pendingSourcePicks.delete(requestId);
    resolve(typeof payload.sourceId === 'string' ? payload.sourceId : null);
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
    const history = appView?.webContents.navigationHistory;
    if (!history?.canGoBack()) return false;
    history.goBack();
    return true;
  });

  ipcMain.handle('weldsuite:nav-forward', () => {
    const history = appView?.webContents.navigationHistory;
    if (!history?.canGoForward()) return false;
    history.goForward();
    return true;
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

  ipcMain.handle('weldsuite:nav-state', () => readNavState());
}

/**
 * Screen-share capture, i.e. what happens when the page calls
 * `navigator.mediaDevices.getDisplayMedia()` (RealtimeKit does this itself
 * inside `enableScreenShare()`, so the call sites in WeldMeet/WeldChat never
 * see the request).
 *
 * `useSystemPicker: true` routes the request to the OS picker wherever one
 * exists — macOS 15+ and Wayland — and this handler is never invoked there.
 * Everywhere else (Windows, older macOS, X11) Electron calls the handler and
 * expects us to produce a source. There is no built-in UI for that, so the
 * choice is delegated to the app, which renders the picker over the meeting.
 *
 * Anything other than an explicit choice denies the request. `callback({})`
 * makes `getDisplayMedia` reject exactly as a cancelled browser picker does,
 * which the call contexts already handle (they check `screenShareEnabled`
 * after the SDK swallows the rejection).
 */
function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    let sources: Electron.DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });
    } catch (err) {
      console.error('[weldsuite-desktop] desktopCapturer.getSources failed:', err);
      callback({});
      return;
    }

    if (sources.length === 0) {
      console.warn('[weldsuite-desktop] no capturable sources — denying screen share');
      callback({});
      return;
    }

    const chosenId = await requestSourceFromRenderer(sources.map(serializeSource));
    if (!chosenId) {
      callback({});
      return;
    }

    // Match back to the live source object — `callback` needs the real
    // DesktopCapturerSource, not the serialized copy the app picked from.
    const chosen = sources.find((s) => s.id === chosenId);
    if (!chosen) {
      console.warn(`[weldsuite-desktop] picker chose unknown source id "${chosenId}"`);
      callback({});
      return;
    }

    callback({ video: chosen });
  }, { useSystemPicker: true });
}

function serializeSource(s: Electron.DesktopCapturerSource): SerializedDesktopSource {
  return {
    id: s.id,
    name: s.name,
    displayId: s.display_id,
    thumbnailDataUrl: s.thumbnail.toDataURL(),
    appIconDataUrl: s.appIcon?.toDataURL() ?? null,
  };
}

interface SerializedDesktopSource {
  id: string;
  name: string;
  displayId: string;
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
}

/**
 * Ask the app to show its source picker. Resolves to the chosen source id, or
 * null if the user cancelled, the request timed out, or no picker is mounted.
 */
function requestSourceFromRenderer(sources: SerializedDesktopSource[]): Promise<string | null> {
  const wc = appWebContents();
  if (!wc || !rendererPickerReady) {
    console.warn('[weldsuite-desktop] app has no screen-share picker mounted — denying screen share');
    return Promise.resolve(null);
  }

  const requestId = ++pickerRequestSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSourcePicks.delete(requestId);
      console.warn(`[weldsuite-desktop] source pick #${requestId} timed out — denying screen share`);
      resolve(null);
    }, SOURCE_PICKER_TIMEOUT_MS);

    pendingSourcePicks.set(requestId, (sourceId) => {
      clearTimeout(timer);
      resolve(sourceId);
    });

    wc.send('weldsuite:select-desktop-source', { requestId, sources });
  });
}

/**
 * Drop picker state. Called when the app document is replaced or the window
 * goes away — the picker that would have answered no longer exists, so every
 * in-flight request has to fail closed instead of waiting out its timeout.
 */
function resetSourcePicker() {
  rendererPickerReady = false;
  const pending = [...pendingSourcePicks.values()];
  pendingSourcePicks.clear();
  for (const resolve of pending) resolve(null);
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
