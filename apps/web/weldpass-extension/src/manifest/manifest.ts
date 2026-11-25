/**
 * The extension manifest, built at build time (ADR PASS-009).
 *
 * The permission set is exact, and `manifest.test.ts` fails the build on any
 * change until the ADR is amended:
 *
 * - `storage`: the session (refresh token in `local`, access token and
 *   pending saves in `session`), the server choice and the settings.
 * - `identity`: `launchWebAuthFlow`, the WeldID sign-in in its own window,
 *   redirecting to `https://<extension id>.chromiumapp.org/`.
 * - `scripting`: the popup's Fill / Save / generator on the active tab, and
 *   bringing the content script into tabs that were open at install.
 * - `activeTab`: the URL of the tab the popup was opened on, without `tabs`.
 * - host permissions: the default server and its sign-in server only. A
 *   self-hosted server is granted at run time (`optional_host_permissions`).
 * - the content script on every `https://` page and `http://localhost`, in
 *   every frame: inline menus and save prompts.
 *
 * Never `tabs`, `cookies`, `<all_urls>`, `webRequest` or remote code.
 */

import { hostPatternsFor, type DefaultServer } from '../lib/origins';
import { DEVELOPMENT_KEY } from './dev-key';

export interface ManifestOptions {
  version: string;
  defaultServer: DefaultServer;
  /**
   * `store`: the Chrome Web Store / Edge Add-ons upload, which must carry no
   * `key`. Otherwise the build is pinned to `extensionKey`, or to the
   * development key.
   */
  store: boolean;
  extensionKey?: string;
  hasIcons: boolean;
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
  background: { service_worker: string; type: 'module' };
  content_scripts: Array<{
    matches: string[];
    js: string[];
    all_frames: boolean;
    run_at: 'document_idle';
  }>;
  web_accessible_resources: Array<{ resources: string[]; matches: string[]; use_dynamic_url: boolean }>;
  options_ui: { page: string; open_in_tab: boolean };
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions: string[];
  commands: Record<string, { suggested_key: Record<string, string>; description?: string }>;
  content_security_policy: { extension_pages: string };
}

export const ICON_SIZES = [16, 32, 48, 128] as const;

export const PERMISSIONS = ['activeTab', 'identity', 'scripting', 'storage'] as const;

/** Where the content script runs, and where its framed pages may be shown. */
export const PAGE_MATCHES = ['https://*/*', 'http://localhost/*'] as const;

/** What "use your own server" may ask for: an https server (or a local one), never plain http elsewhere. */
export const OPTIONAL_HOST_PERMISSIONS = ['https://*/*', 'http://localhost/*'] as const;

/** Extension pages a web page may frame: the inline menu and the save bar, nothing else. */
export const FRAMED_PAGES = ['menu.html', 'prompt.html'] as const;

export function buildManifest(options: ManifestOptions): ExtensionManifest {
  const icons = options.hasIcons
    ? Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/icon-${size}.png`]))
    : undefined;
  const key = options.store ? undefined : options.extensionKey?.trim() || DEVELOPMENT_KEY;

  return {
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: 'WeldPass',
    description: '__MSG_extDescription__',
    version: options.version,
    default_locale: 'en',
    // Popover (top layer) 114, storage.session and documentId messaging earlier.
    minimum_chrome_version: '116',
    ...(key ? { key } : {}),
    ...(icons ? { icons } : {}),
    action: {
      default_popup: 'popup.html',
      default_title: '__MSG_actionTitle__',
      ...(icons ? { default_icon: icons } : {}),
    },
    background: { service_worker: 'background.js', type: 'module' },
    content_scripts: [
      {
        matches: [...PAGE_MATCHES],
        js: ['content.js'],
        all_frames: true,
        run_at: 'document_idle',
      },
    ],
    web_accessible_resources: [
      {
        resources: [...FRAMED_PAGES],
        matches: [...PAGE_MATCHES],
        // A per-session URL: a page can't probe for the extension by a fixed one.
        use_dynamic_url: true,
      },
    ],
    options_ui: { page: 'settings.html', open_in_tab: true },
    permissions: [...PERMISSIONS],
    host_permissions: hostPatternsFor([options.defaultServer.origin, options.defaultServer.issuer]),
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
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
