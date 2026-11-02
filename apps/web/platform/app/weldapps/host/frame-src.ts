import { getAppApiUrl } from '@/lib/api/public-env';
import { publicEnv } from '@/lib/runtime-config';

/**
 * Where a WeldApp iframe loads from: the API origin, or the dedicated bundle
 * origin when one is configured. Pure helpers (no hooks) so the bridge and its
 * tests can import them without pulling in the data layer.
 */

export const APP_API_BASE = getAppApiUrl();

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function apiOrigin(apiBase: string): string {
  try {
    return new URL(apiBase).origin;
  } catch {
    return apiBase;
  }
}

export interface BundleOrigin {
  origin: string;
  /** True when the template gives every app its own origin (`https://{code}.…`). */
  perApp: boolean;
}

/**
 * The origin that serves `code`'s bundle.
 *
 * `template` is `VITE_USER_APP_BUNDLE_ORIGIN`: a plain origin
 * (`https://weldappcontent.net`) or a per-app one (`https://{code}.weldappcontent.net`).
 * Unset (or unusable) keeps today's behaviour: the API origin. Like the API url,
 * a localhost value is ignored on a hosted SPA, so a stray `.env.local` cannot
 * leak into a deployed build. Must mirror app-api's `USER_APP_BUNDLE_ORIGIN`.
 */
export function resolveBundleOrigin(params: {
  template: string | undefined;
  code: string;
  apiBase: string;
  /** `window.location.hostname` of the SPA, when known. */
  spaHost?: string;
}): BundleOrigin {
  const fallback: BundleOrigin = { origin: apiOrigin(params.apiBase), perApp: false };
  const template = params.template?.trim();
  if (!template) return fallback;
  const perApp = template.includes('{code}');
  let url: URL;
  try {
    url = new URL(template.replaceAll('{code}', params.code));
  } catch {
    return fallback;
  }
  const local = isLocalHost(url.hostname);
  if (local && params.spaHost && !isLocalHost(params.spaHost)) return fallback;
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if (!secure || !bare) return fallback;
  return { origin: url.origin, perApp };
}

/** The bundle origin of `code` for this build. */
export function getBundleOrigin(code: string): BundleOrigin {
  return resolveBundleOrigin({
    template: publicEnv('VITE_USER_APP_BUNDLE_ORIGIN'),
    code,
    apiBase: APP_API_BASE,
    spaHost: typeof window === 'undefined' ? undefined : window.location.hostname,
  });
}

/**
 * Community apps share one origin with every other bundle (and, without a
 * dedicated bundle origin, with the API), so a sibling frame could reach into
 * them. Setting `VITE_USER_APP_ISOLATE_COMMUNITY_APPS=true` renders such frames
 * in an opaque origin (no `allow-same-origin`): no shared storage and no
 * cross-frame DOM access, at the price of `localStorage` / `IndexedDB` /
 * cookies being unavailable to those apps. Off by default; irrelevant once
 * every app has its own origin (`{code}` in the bundle origin).
 */
export function isolateCommunityApps(): boolean {
  return publicEnv('VITE_USER_APP_ISOLATE_COMMUNITY_APPS') === 'true';
}

/**
 * The iframe URL for a link path returned by `POST /user-apps/code/:code/bundle-url`,
 * on this build's bundle origin. Only the two shapes the API mints are accepted
 * (plain, or signed with an opaque link segment), so a response cannot steer the
 * frame anywhere else.
 */
export function bundleSrcFromPath(code: string, path: string): string | null {
  const prefix = `/public/user-apps/${code}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!/^(s\/[A-Za-z0-9._-]{20,200}\/)?index\.html$/.test(rest)) return null;
  return `${getBundleOrigin(code).origin}${path}`;
}

/**
 * Bootstrap theme + route into the URL so first paint already matches the
 * platform. Only used for the initial `src`; later changes go over the bridge
 * so the iframe never reloads on navigation.
 */
export function bootstrapFrameSrc(src: string, theme: 'light' | 'dark', path: string): string {
  if (!src) return src;
  try {
    const url = new URL(src);
    url.searchParams.set('theme', theme);
    url.hash = path && path !== '/' ? path.replace(/^\//, '') : '';
    return url.toString();
  } catch {
    return src;
  }
}
