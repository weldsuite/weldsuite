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

export function parseSessionDevice(activity: SessionActivityLike | null | undefined): SessionDeviceInfo {
  if (!activity) return { kind: 'unknown' };

  const browser = activity.browserName?.trim() || null;
  const deviceType = activity.deviceType?.trim() || null;
  const isMobile = Boolean(activity.isMobile) || /mobile|phone|tablet/i.test(deviceType ?? '');
  const os = osFromDevice(deviceType);
  const major = majorVersion(activity.browserVersion);

  if (browser) {
    // Native HTTP clients (no UI of their own, so "the Android app").
    if (/^okhttp$|^dalvik$/i.test(browser)) return { kind: 'android-app' };
    if (/^cfnetwork$|^darwin$/i.test(browser)) return { kind: 'ios-app' };

    // WeldSuite desktop app.
    if (/^weldsuite$/i.test(browser) && !isMobile) return { kind: 'desktop-app', os };
    if (/electron|webview2/i.test(browser)) return { kind: 'desktop-app', os };

    // Weld* mobile apps: WeldMail, WeldChat, WeldDesk, ...
    const weld = /^(weld[a-z]+)$/i.exec(browser);
    if (weld?.[1]) {
      const rest = weld[1].slice(4).toLowerCase();
      return { kind: 'weld-app', appName: `Weld${rest.charAt(0).toUpperCase()}${rest.slice(1)}` };
    }

    // Chromium-shell UAs that Clerk reads as an ancient Safari on a desktop OS.
    if (/^safari$/i.test(browser)) {
      const nonAppleDesktop = os === 'Windows' || os === 'Linux';
      const impossiblyOld = major !== null && major < 10;
      if (!isMobile && (nonAppleDesktop || impossiblyOld)) return { kind: 'desktop-app', os };
    }
  }

  if (!browser && !deviceType) return { kind: 'unknown' };

  return {
    kind: 'browser',
    browser,
    version: major === null ? null : String(major),
    device: deviceType,
    isMobile,
  };
}
