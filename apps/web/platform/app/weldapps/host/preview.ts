/**
 * Preview URL helpers for the WeldApp iframe host (`weld app dev`).
 *
 * R2 bundles share the app-api origin, so they stay sandboxed without
 * `allow-same-origin`. A localhost / tunnel preview has its own origin, so
 * we add `allow-same-origin` and a concrete postMessage targetOrigin.
 */

export const R2_SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';
export const PREVIEW_SANDBOX = `${R2_SANDBOX} allow-same-origin`;

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

/** postMessage targetOrigin for the iframe. Preview URLs have a real origin. */
export function iframeTargetOrigin(src: string): string {
  if (!isPreviewAppUrl(src)) return '*';
  try {
    return new URL(src).origin;
  } catch {
    return '*';
  }
}

export function iframeSandbox(src: string): string {
  return isPreviewAppUrl(src) ? PREVIEW_SANDBOX : R2_SANDBOX;
}
