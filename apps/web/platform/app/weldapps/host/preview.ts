/**
 * Preview URL helpers for the WeldApp iframe host (`weld app dev`).
 *
 * Bundles are served from app-api (`/public/user-apps/…`), which is a
 * *different origin* from the platform SPA (`app.weldsuite.org`). That means
 * `allow-same-origin` is safe: the iframe gets a real origin (app-api) so Vite
 * module scripts / CSS load without CORS, but it still cannot touch the parent
 * DOM. Combining `allow-same-origin` + `allow-scripts` is only dangerous when
 * the iframe URL is same-origin as the embedder.
 *
 * Localhost / tunnel previews also need `allow-same-origin` (and a concrete
 * postMessage targetOrigin) so the real bridge works.
 */

export const R2_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-downloads allow-same-origin';
export const PREVIEW_SANDBOX = R2_SANDBOX;

export function isPreviewAppUrl(src: string): boolean {
  try {
    const parsed = new URL(src);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '::1' ||
      host.endsWith('.trycloudflare.com') ||
      host.endsWith('.ngrok-free.app') ||
      host.endsWith('.ngrok.app') ||
      host.endsWith('.ngrok.io') ||
      host.endsWith('.pages.dev')
    );
  } catch {
    return false;
  }
}

/** postMessage targetOrigin for the iframe (always the iframe document origin). */
export function iframeTargetOrigin(src: string): string {
  try {
    return new URL(src).origin;
  } catch {
    return '*';
  }
}

export function iframeSandbox(src: string): string {
  // Preview and R2 both need allow-same-origin; see file header.
  void src;
  return R2_SANDBOX;
}
