/**
 * Build-time configuration, read from the Vite env. The build never fails on a
 * missing value; the popup shows a "not configured" screen naming what is
 * missing instead.
 */

export interface ExtensionConfig {
  publishableKey: string;
  /** Passed to Clerk as `syncHost`: the host whose Clerk cookie carries the web session. */
  syncHost: string;
  /** app-api origin. Requests go to `${apiUrl}/api/...`. */
  apiUrl: string;
  /** The WeldSuite web app, opened by the "Open WeldSuite" button. */
  appUrl: string;
}

export type ConfigResult = { ok: true; config: ExtensionConfig } | { ok: false; missing: string[] };

/** An http(s) origin plus path, without a trailing slash. Null for anything else. */
export function normaliseBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function readConfig(env: Record<string, unknown>): ConfigResult {
  const text = (name: string) => {
    const value = env[name];
    return typeof value === 'string' ? value : undefined;
  };

  const publishableKey = text('VITE_CLERK_PUBLISHABLE_KEY')?.trim() ?? '';
  const syncHost = normaliseBaseUrl(text('VITE_SYNC_HOST'));
  const apiUrl = normaliseBaseUrl(text('VITE_API_URL'));
  const appUrl = normaliseBaseUrl(text('VITE_APP_URL')) ?? syncHost;

  const missing: string[] = [];
  if (!/^pk_(test|live)_/.test(publishableKey)) missing.push('VITE_CLERK_PUBLISHABLE_KEY');
  if (!syncHost) missing.push('VITE_SYNC_HOST');
  if (!apiUrl) missing.push('VITE_API_URL');

  if (!syncHost || !apiUrl || !appUrl || missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { publishableKey, syncHost, apiUrl, appUrl } };
}
