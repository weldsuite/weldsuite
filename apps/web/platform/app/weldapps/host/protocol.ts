/**
 * Host side of the WeldApps iframe bridge.
 *
 * PROTOCOL SYNC WARNING: these shapes mirror
 * `packages/sdk/app-sdk/src/core/types.ts` (the app side) and the CLI local
 * shell in `packages/sdk/cli/src/local-shell/`. Change all three together.
 *
 * Protocol 2 (this host): no credential ever enters the sandbox. `init`
 * carries `token: null`; the app sends `fetch` requests and the host performs
 * them with the member's own platform session, outside the iframe.
 */

/** Bridge protocol this host speaks. */
export const HOST_BRIDGE_PROTOCOL = 2;

export type WeldAppSurface = 'page' | 'modal';

export interface WeldDesignTokens {
  vars: Record<string, string>;
  fontFamily?: string;
  fontStylesheet?: string;
}

export interface WeldAppBreadcrumb {
  label: string;
  path?: string;
}

export interface ShortcutPayload {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type WeldAppRequestMethod =
  | 'getToken'
  | 'navigate'
  | 'toast'
  | 'fetch'
  | 'setBreadcrumbs'
  | 'setDirty'
  | 'confirm'
  | 'openModal'
  | 'closeModal';

export type IncomingWeldAppMessage =
  | { type: 'weldapp:ready' }
  | { type: 'weldapp:request'; id: string; method: WeldAppRequestMethod; payload?: unknown }
  | { type: 'weldapp:notify'; event: 'mounted' }
  | { type: 'weldapp:notify'; event: 'shortcut'; payload?: unknown };

export interface ProxyFetchRequest {
  method: string;
  path: string;
  headers: [string, string][];
  body: string | ArrayBuffer | null;
}

export interface ProxyFetchResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

export interface ConfirmRequest {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive: boolean;
}

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface OpenModalRequest {
  path: string;
  title?: string;
  size: ModalSize;
  params?: unknown;
}

const PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Only headers a browser sends cross-origin without widening app-api's CORS
 * allowlist. Credentials the app might try to set are dropped here and the
 * host adds its own `Authorization`.
 */
const PROXY_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type']);

/** Shortcuts the platform owns: Cmd/Ctrl+K (search) and Cmd/Ctrl+J (agent). */
const HOST_SHORTCUT_KEYS = new Set(['k', 'j']);

const MAX_LABEL_LENGTH = 80;
const MAX_BREADCRUMBS = 5;
const MAX_TEXT_LENGTH = 500;

/**
 * App-relative or API path check shared by proxying and breadcrumbs: must be
 * rooted, with no traversal, protocol-relative or encoded-slash tricks.
 */
export function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  if (path.length > 2048) return false;
  // Query strings may legitimately contain `//` (e.g. a URL filter value).
  const pathname = path.split(/[?#]/)[0] ?? '';
  if (pathname.includes('//') || path.includes('\\')) return false;
  if (/%2f|%5c/i.test(pathname)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  return !decoded.split('/').some((segment) => segment === '..' || segment === '.');
}

/**
 * Where a proxied `fetch` goes, or null when the app may not call it.
 *
 * - Official apps (platform session) call app-api directly, under `/api/`.
 * - Community apps call external-api `/v1/*` through the app-api gateway,
 *   which swaps the member's session for the install's scoped token.
 */
export function resolveProxyUrl(params: {
  apiBase: string;
  appCode: string;
  usesPlatformSession: boolean;
  path: unknown;
}): string | null {
  const { apiBase, appCode, usesPlatformSession, path } = params;
  if (!isSafeRelativePath(path)) return null;
  const base = apiBase.replace(/\/+$/, '');
  if (usesPlatformSession) {
    return path.startsWith('/api/') ? `${base}${path}` : null;
  }
  if (!path.startsWith('/v1/')) return null;
  return `${base}/api/user-apps/code/${encodeURIComponent(appCode)}/gateway${path}`;
}

/** Validate an incoming `fetch` payload; returns null when malformed. */
export function parseProxyFetchRequest(payload: unknown): ProxyFetchRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Partial<ProxyFetchRequest>;
  const method = typeof raw.method === 'string' ? raw.method.toUpperCase() : 'GET';
  if (!PROXY_METHODS.has(method)) return null;
  if (typeof raw.path !== 'string') return null;
  const headers: [string, string][] = [];
  if (Array.isArray(raw.headers)) {
    for (const entry of raw.headers) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue;
      const name = entry[0].toLowerCase();
      if (PROXY_REQUEST_HEADERS.has(name)) headers.push([name, entry[1]]);
    }
  }
  let body: string | ArrayBuffer | null = null;
  if (method !== 'GET' && method !== 'HEAD') {
    if (typeof raw.body === 'string' || raw.body instanceof ArrayBuffer) body = raw.body;
  }
  return { method, path: raw.path, headers, body };
}

function cleanText(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** App breadcrumbs → platform crumbs (hrefs under `/apps/{code}`). */
export function toPlatformBreadcrumbs(
  appCode: string,
  items: unknown,
): { label: string; href?: string }[] {
  if (!Array.isArray(items)) return [];
  const crumbs: { label: string; href?: string }[] = [];
  for (const item of items.slice(0, MAX_BREADCRUMBS)) {
    if (!item || typeof item !== 'object') continue;
    const label = cleanText((item as WeldAppBreadcrumb).label, MAX_LABEL_LENGTH);
    if (!label) continue;
    const path = (item as WeldAppBreadcrumb).path;
    if (isSafeRelativePath(path)) {
      crumbs.push({ label, href: path === '/' ? `/apps/${appCode}` : `/apps/${appCode}${path}` });
    } else {
      crumbs.push({ label });
    }
  }
  return crumbs;
}

export function parseConfirmRequest(payload: unknown): ConfirmRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  const title = cleanText(raw.title, MAX_LABEL_LENGTH * 2);
  if (!title) return null;
  return {
    title,
    description: cleanText(raw.description),
    confirmLabel: cleanText(raw.confirmLabel, MAX_LABEL_LENGTH),
    cancelLabel: cleanText(raw.cancelLabel, MAX_LABEL_LENGTH),
    destructive: raw.destructive === true,
  };
}

export function parseOpenModalRequest(payload: unknown): OpenModalRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  if (!isSafeRelativePath(raw.path)) return null;
  const size: ModalSize =
    raw.size === 'sm' || raw.size === 'lg' || raw.size === 'xl' ? raw.size : 'md';
  return { path: raw.path, title: cleanText(raw.title, MAX_LABEL_LENGTH * 2), size, params: raw.params };
}

/** A shortcut the platform should handle, or null. */
export function parseShortcut(payload: unknown): ShortcutPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Partial<ShortcutPayload>;
  if (typeof raw.key !== 'string') return null;
  const key = raw.key.toLowerCase();
  const metaKey = raw.metaKey === true;
  const ctrlKey = raw.ctrlKey === true;
  if (!HOST_SHORTCUT_KEYS.has(key) || !(metaKey || ctrlKey)) return null;
  return { key, metaKey, ctrlKey, shiftKey: raw.shiftKey === true, altKey: raw.altKey === true };
}
