/**
 * Turn Clerk's parsed session activity (browserName / browserVersion /
 * deviceType / isMobile) into a human device label.
 *
 * Clerk parses the User-Agent for us and only hands back those four fields, so
 * the raw UA is gone by the time we render. Clerk's parser does badly with our
 * own clients, which is what this module compensates for:
 *
 *  - The Electron desktop app (and WebView2) sends a Chromium-style UA that
 *    Clerk reads as `Safari 2` on Windows/Linux. Real Safari never ran on
 *    Windows/Linux this decade and has not been version 2 since 2006, so
 *    Safari on a non-Apple desktop OS, or Safari below 10, is the desktop app.
 *  - The Expo mobile apps (`WeldMail/12 CFNetwork/33 …`) come back as browser
 *    `WeldMail`, version `12/33`, device `Mobile`.
 *  - Android's native HTTP client announces itself as `OkHttp/5`.
 *
 * Kept free of React/i18n so it can be unit tested; the page maps the result
 * to translated strings.
 */

export interface SessionActivityLike {
  browserName?: string | null;
  browserVersion?: string | null;
  deviceType?: string | null;
  isMobile?: boolean | null;
}

export type SessionDeviceInfo =
  /** The WeldSuite Electron desktop app. `os` is Windows / macOS / Linux when known. */
  | { kind: 'desktop-app'; os: string | null }
  /** One of the Weld* Expo apps, e.g. `WeldMail`. */
  | { kind: 'weld-app'; appName: string }
  /** A native Android HTTP client (OkHttp / Dalvik). */
  | { kind: 'android-app' }
  /** A native iOS HTTP client (CFNetwork / Darwin). */
  | { kind: 'ios-app' }
  /** An ordinary browser; `device` is Clerk's device/OS string when present. */
  | { kind: 'browser'; browser: string | null; version: string | null; device: string | null; isMobile: boolean }
  | { kind: 'unknown' };

const OS_NAMES: Array<[RegExp, string]> = [
  [/windows/i, 'Windows'],
  [/mac|darwin/i, 'macOS'],
  [/linux|ubuntu|debian|fedora/i, 'Linux'],
];

function osFromDevice(deviceType: string | null | undefined): string | null {
  if (!deviceType) return null;
  for (const [re, name] of OS_NAMES) if (re.test(deviceType)) return name;
  return null;
}

function majorVersion(version: string | null | undefined): number | null {
  if (!version) return null;
  const n = Number.parseInt(version, 10);
  return Number.isFinite(n) ? n : null;
}

/** Native HTTP clients (no UI of their own, so "the Android app"). */
function nativeClient(browser: string): SessionDeviceInfo | null {
  if (/^okhttp$|^dalvik$/i.test(browser)) return { kind: 'android-app' };
  if (/^cfnetwork$|^darwin$/i.test(browser)) return { kind: 'ios-app' };
  return null;
}

/** Weld* mobile apps: WeldMail, WeldChat, WeldDesk, ... */
function weldApp(browser: string): SessionDeviceInfo | null {
  const weld = /^(weld[a-z]+)$/i.exec(browser);
  if (!weld?.[1]) return null;
  const rest = weld[1].slice(4).toLowerCase();
  return { kind: 'weld-app', appName: `Weld${rest.charAt(0).toUpperCase()}${rest.slice(1)}` };
}

/** The WeldSuite desktop app, including Chromium-shell UAs Clerk reads as an ancient Safari. */
function isDesktopApp(browser: string, os: string | null, isMobile: boolean, major: number | null): boolean {
  if (/electron|webview2/i.test(browser)) return true;
  if (isMobile) return false;
  if (/^weldsuite$/i.test(browser)) return true;
  if (!/^safari$/i.test(browser)) return false;
  const nonAppleDesktop = os === 'Windows' || os === 'Linux';
  const impossiblyOld = major !== null && major < 10;
  return nonAppleDesktop || impossiblyOld;
}

/** Our own clients, which Clerk's parser misreads; null for an ordinary browser. */
function ownClient(browser: string, os: string | null, isMobile: boolean, major: number | null): SessionDeviceInfo | null {
  const native = nativeClient(browser);
  if (native) return native;
  if (isDesktopApp(browser, os, isMobile, major)) return { kind: 'desktop-app', os };
  return weldApp(browser);
}

export function parseSessionDevice(activity: SessionActivityLike | null | undefined): SessionDeviceInfo {
  if (!activity) return { kind: 'unknown' };

  const browser = activity.browserName?.trim() || null;
  const deviceType = activity.deviceType?.trim() || null;
  const isMobile = Boolean(activity.isMobile) || /mobile|phone|tablet/i.test(deviceType ?? '');
  const os = osFromDevice(deviceType);
  const major = majorVersion(activity.browserVersion);

  const own = browser ? ownClient(browser, os, isMobile, major) : null;
  if (own) return own;

  if (!browser && !deviceType) return { kind: 'unknown' };

  return {
    kind: 'browser',
    browser,
    version: major === null ? null : String(major),
    device: deviceType,
    isMobile,
  };
}
