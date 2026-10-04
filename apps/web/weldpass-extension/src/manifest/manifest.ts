/**
 * The extension manifest, built from the Vite env at build time.
 *
 * It is generated rather than checked in because `host_permissions` has to
 * name exactly the hosts this build talks to — the API, the Clerk sync host
 * and the Clerk Frontend API — and those differ per environment. Nothing here
 * may ever widen to `<all_urls>` or a wildcard host: pages are reached through
 * `activeTab`, which the browser grants for one tab when the user opens the
 * popup.
 */

export interface ManifestEnv {
  publishableKey?: string;
  syncHost?: string;
  apiUrl?: string;
  /** Base64 public key that pins the extension ID (the `key` manifest field). */
  extensionKey?: string;
}

export interface ExtensionManifest {
  manifest_version: 3;
  name: string;
  short_name: string;
  description: string;
  version: string;
  default_locale: string;
  minimum_chrome_version: string;
  key?: string;
  icons?: Record<string, string>;
  action: {
    default_popup: string;
    default_title: string;
    default_icon?: Record<string, string>;
  };
  permissions: string[];
  host_permissions: string[];
  commands: Record<string, { suggested_key: Record<string, string>; description?: string }>;
  content_security_policy: { extension_pages: string };
}

export const ICON_SIZES = [16, 32, 48, 128] as const;

/**
 * - `activeTab` + `scripting`: read or fill the login form of the tab the user
 *   opened the popup on, and only that tab.
 * - `storage`: required by `@clerk/chrome-extension` (it throws without it) to
 *   keep its client token in `chrome.storage.local`.
 * - `cookies`: required by `@clerk/chrome-extension` when `syncHost` is set; it
 *   reads the Clerk cookie of the sync host to reuse the web session.
 */
export const PERMISSIONS = ['activeTab', 'scripting', 'storage', 'cookies'] as const;

/**
 * A Clerk publishable key is `pk_(test|live)_` + base64 of the Frontend API
 * host followed by `$`. Returns the host's origin, or null for anything else.
 */
export function frontendApiFromPublishableKey(key: string | undefined): string | null {
  const match = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/.exec(key?.trim() ?? '');
  if (!match) return null;

  let decoded: string;
  try {
    decoded = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  if (!decoded.endsWith('$')) return null;

  const host = decoded.slice(0, -1);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host.toLowerCase()}` : null;
}

/**
 * The match pattern for one host: scheme and hostname, any path. Ports are
 * dropped (a match pattern without one covers every port, and cookies ignore
 * ports anyway). Null for anything that is not a single http(s) host.
 */
export function hostPermission(url: string | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || parsed.hostname.includes('*')) return null;

  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function hostPermissions(env: ManifestEnv): string[] {
  const patterns = [
    hostPermission(env.apiUrl),
    hostPermission(env.syncHost),
    hostPermission(frontendApiFromPublishableKey(env.publishableKey) ?? undefined),
  ].filter((pattern): pattern is string => pattern !== null);
  return [...new Set(patterns)];
}

export function buildManifest(options: {
  version: string;
  env: ManifestEnv;
  hasIcons: boolean;
}): ExtensionManifest {
  const icons = options.hasIcons
    ? Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/icon-${size}.png`]))
    : undefined;
  const key = options.env.extensionKey?.trim();

  return {
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: 'WeldPass',
    description: '__MSG_extDescription__',
    version: options.version,
    default_locale: 'en',
    minimum_chrome_version: '116',
    ...(key ? { key } : {}),
    ...(icons ? { icons } : {}),
    action: {
      default_popup: 'popup.html',
      default_title: '__MSG_actionTitle__',
      ...(icons ? { default_icon: icons } : {}),
    },
    permissions: [...PERMISSIONS],
    host_permissions: hostPermissions(options.env),
    commands: {
      // A suggestion only: the browser drops it when the combination is taken,
      // and the user can rebind it under chrome://extensions/shortcuts.
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+P', mac: 'Alt+Shift+P' },
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  };
}

/** Chrome's `_locales/<lang>/messages.json` shape. */
export type LocaleMessages = Record<string, { message: string; description?: string }>;
