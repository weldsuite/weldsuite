/**
 * Iframe origin + sandbox helpers for the WeldApp host (published bundles and
 * `weld app dev` previews).
 *
 * Bundles are served from app-api (`/public/user-apps/…`) or, when configured,
 * a dedicated bundle origin: a *different origin* from the platform SPA
 * (`app.weldsuite.org`). `allow-same-origin` is therefore safe against the
 * embedder: the iframe gets a real origin, so Vite module scripts / CSS load
 * without CORS, and it still cannot touch the parent DOM. Combining
 * `allow-same-origin` + `allow-scripts` is only dangerous when the iframe URL is
 * same-origin as the embedder.
 *
 * What it does NOT give is isolation between apps that share a bundle origin:
 * see `isolateCommunityApps` in frame-src.ts and `ISOLATED_SANDBOX` below.
 *
 * Localhost / tunnel previews also need `allow-same-origin` (and a concrete
 * postMessage targetOrigin) so the real bridge works.
 *
 * Previews are developer-chosen code that runs next to the member's session, so
 * the rules here are strict: loopback is always fine, but a public tunnel
 * (`*.ngrok.app`, `*.pages.dev`, … anyone can host there) is only rendered when
 * its origin is EXACTLY the one the server has on record for this developer's
 * dev session.
 */

export const R2_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-downloads allow-same-origin';
export const PREVIEW_SANDBOX = R2_SANDBOX;
/**
 * Opaque-origin sandbox: scripts run, but with no origin of their own to share,
 * so no common storage and no DOM access to a sibling frame. Used for community
 * apps when `VITE_USER_APP_ISOLATE_COMMUNITY_APPS` is on.
 */
export const ISOLATED_SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';

/** What an iframe shows: the published bundle, or a `weld app dev` preview. */
export type FrameKind = 'bundle' | 'preview';

/** Hosts of public tunnels / previews; mirrors `isAllowedDevSessionUrl` on the server. */
const TUNNEL_HOST_SUFFIXES = [
  '.trycloudflare.com',
  '.ngrok-free.app',
  '.ngrok.app',
  '.ngrok.io',
  '.pages.dev',
] as const;

function parse(src: string): URL | null {
  try {
    return new URL(src);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * Whether the host may render `src` as a `weld app dev` preview.
 *
 * - Loopback (http or https): always.
 * - A public tunnel host: only over https and only when `registeredOrigin` (the
 *   origin the server stored for this developer's session) is exactly the
 *   origin of `src`. The host suffix alone never qualifies.
 * - Anything else, or a URL with credentials: no.
 */
export function isPreviewAppUrl(src: string, registeredOrigin?: string | null): boolean {
  const url = parse(src);
  if (!url || url.username || url.password) return false;
  if (isLoopbackHost(url.hostname)) return url.protocol === 'http:' || url.protocol === 'https:';
  if (url.protocol !== 'https:') return false;
  if (!registeredOrigin || url.origin !== registeredOrigin) return false;
  const host = url.hostname.toLowerCase();
  return TUNNEL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export interface AcceptedPreview {
  url: string;
  /** The exact origin the frame and its bridge are pinned to. */
  origin: string;
}

/**
 * The dev session the host may act on, or null. `session.origin` is what the
 * server registered (older servers omit it, then the URL's own origin stands in,
 * which keeps loopback working and still demands an allowlisted tunnel host).
 */
export function acceptPreviewSession(
  session: { url: string; origin?: string } | null | undefined,
): AcceptedPreview | null {
  if (!session) return null;
  const url = parse(session.url);
  if (!url) return null;
  if (!isPreviewAppUrl(session.url, session.origin ?? url.origin)) return null;
  return { url: session.url, origin: url.origin };
}

/** The origin of the iframe document, or null when `src` is not a usable URL. */
export function iframeTargetOrigin(src: string): string | null {
  const url = parse(src);
  if (!url || url.origin === 'null') return null;
  return url.origin;
}

export function iframeSandbox(options: { kind?: FrameKind; isolated?: boolean } = {}): string {
  // Previews always keep a real origin (their own, never shared with another
  // app), whatever the isolation setting says.
  if (options.isolated && options.kind !== 'preview') return ISOLATED_SANDBOX;
  // Preview and R2 both need allow-same-origin today (see file header), so
  // the two sandboxes are otherwise identical; keep the split so they can
  // diverge without touching callers.
  return options.kind === 'preview' ? PREVIEW_SANDBOX : R2_SANDBOX;
}

/** Where the host posts to, and the origin it accepts messages from, for one frame. */
export interface FrameBridgeOrigins {
  postTarget: string;
  eventOrigin: string;
}

/**
 * The bridge's origin pins for a frame at `origin`. A normal frame is pinned to
 * its exact origin both ways. An isolated frame has the opaque origin `null`,
 * which cannot be named as a postMessage target (`*` is the only way to reach
 * it) and is the origin its messages arrive with; the window check in the bridge
 * (`event.source === iframe.contentWindow`) is what binds it then. Returns null
 * when the frame has no usable origin, which makes the bridge refuse everything.
 */
export function bridgeOrigins(origin: string | null, isolated: boolean): FrameBridgeOrigins | null {
  if (!origin) return null;
  return isolated ? { postTarget: '*', eventOrigin: 'null' } : { postTarget: origin, eventOrigin: origin };
}
