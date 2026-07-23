import { getDesktop, isDesktop } from './desktop';
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

/**
 * True when the current route is a sign-in / sign-up / SSO callback path
 * inside the desktop shell. The shell tries to intercept these at the
 * navigation layer, but this helper is the belt-and-braces check for
 * client-side route changes (TanStack Router won't trigger `will-navigate`).
 */
function isAuthRoute(pathname: string): boolean {
  return (
    pathname.startsWith('/auth/login') ||
    pathname.startsWith('/auth/register') ||
    pathname.startsWith('/auth/sso-callback')
  );
}

/**
 * Convenience guard to use at the top of the sign-in page component:
 *
 *   useEffect(() => { redirectDesktopAuthToBrowser(); }, []);
 *
 * In desktop: triggers the external-browser handoff and returns true so the
 * caller can render a "Continue in your browser" placeholder.
 * In web: no-op, returns false.
 */
function redirectDesktopAuthToBrowser(path?: string): boolean {
  if (!isDesktop()) return false;
  void startExternalSignIn({ path });
  return true;
}
