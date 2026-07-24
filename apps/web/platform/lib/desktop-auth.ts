import { getDesktop } from './desktop';
import type { AuthCallback } from '../types/weldsuite-desktop';

/**
 * Open the platform sign-in flow in the user's default browser.
 *
 * Why: Google (and Microsoft) block OAuth inside Electron's embedded webview
 * with a "this browser or app may not be secure" error. The reliable fix is to
 * drive the whole sign-in flow in the system browser and hand the Clerk
 * session back to the desktop shell via the `weldsuite://auth?ticket=...`
 * deep link.
 */
export async function startExternalSignIn(opts?: { path?: string }): Promise<void> {
  const desktop = getDesktop();
  if (!desktop) return;
  await desktop.signInExternally({ path: opts?.path ?? '/auth/login' });
}

/**
 * Subscribe to auth callbacks that arrive via the `weldsuite://auth` deep link.
 * Returns an unsubscribe function.
 *
 * Typical payload params after a browser sign-in handoff:
 *   - `ticket`   — Clerk sign-in ticket (consume with `signIn.create({ strategy: 'ticket', ticket })`)
 *   - `status`   — 'success' | 'error'
 *   - `message`  — optional human-readable error
 */
export function onDesktopAuthCallback(listener: (payload: AuthCallback) => void): () => void {
  const desktop = getDesktop();
  if (!desktop) return () => undefined;
  return desktop.onAuthCallback(listener);
}
