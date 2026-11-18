import type { ClientConfig } from './wire';

export { DEFAULT_HOST } from './host';

/**
 * The config as the SDK uses it. Values the SDK does not recognise fall to
 * the more private choice: consent required, strict masking, no recording.
 */
export function resolveConfig(raw: Partial<ClientConfig> | null | undefined): ClientConfig {
  const c = raw || {};
  const rate = c.recordingSampleRate;
  const snap = c.snapshot;
  return {
    autocapture: c.autocapture !== false,
    consentMode: c.consentMode === 'none' ? 'none' : 'required',
    maskingLevel: c.maskingLevel === 'balanced' || c.maskingLevel === 'relaxed' ? c.maskingLevel : 'strict',
    excludedUrls: Array.isArray(c.excludedUrls) ? c.excludedUrls.filter((p) => typeof p === 'string' && p) : [],
    recordingSampleRate: typeof rate === 'number' && rate > 0 ? Math.min(rate, 1) : 0,
    recordingBlocked: c.recordingBlocked !== false,
    snapshot:
      snap && typeof snap.pageGroupId === 'string' && typeof snap.urlPattern === 'string' && /^(desktop|tablet|mobile)$/.test(snap.deviceClass)
        ? { pageGroupId: snap.pageGroupId, urlPattern: snap.urlPattern, deviceClass: snap.deviceClass }
        : null,
  };
}

/**
 * A matcher for path patterns (`excludedUrls`, a heatmap page group): each
 * pattern must match the whole `location.pathname`, `*` standing for any
 * characters (`/admin/*`). The path is tried as the browser encodes it and
 * decoded, so `/über/*` works.
 */
export function excludedMatcher(patterns: string[]): (path: string) => boolean {
  if (!patterns.length) return () => false;
  const re = new RegExp(
    `^(?:${patterns.map((p) => p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')).join('|')})$`,
  );
  return (path) => {
    if (re.test(path)) return true;
    try {
      return re.test(decodeURI(path));
    } catch {
      return false;
    }
  };
}

export async function fetchConfig(host: string, token: string): Promise<ClientConfig> {
  const res = await fetch(`${host}/c/${encodeURIComponent(token)}`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`config ${res.status}`);
  return resolveConfig((await res.json()) as Partial<ClientConfig>);
}
