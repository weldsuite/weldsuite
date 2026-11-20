import { getDesktop } from './desktop';
import { getLocale, getTranslations } from '@/lib/i18n';
import { BrowserSignInError, type BrowserSignIn } from '@/lib/auth/oidc/browser-sign-in';
import type { AuthCallback, OidcSignInPageText } from '../types/weldsuite-desktop';

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

/** The page the browser shows once it is back from the provider, in the platform's language. */
function callbackPageText(): OidcSignInPageText {
  const copy = getTranslations('common').auth.desktop.browser.callback;
  return {
    lang: getLocale(),
    successTitle: copy.successTitle,
    successBody: copy.successBody,
    failureTitle: copy.failureTitle,
    failureBody: copy.failureBody,
  };
}

/**
 * The desktop shell's sign-in through the system browser (OIDC editions,
 * RFC 8252; `lib/auth/oidc/browser-sign-in.ts`). Null outside the shell and
 * in shells older than 0.3.0, which have no loopback listener: those keep
 * signing in inside their own window.
 */
export function desktopBrowserSignIn(): BrowserSignIn | null {
  const desktop = getDesktop();
  const bridge = desktop?.oidcSignIn;
  if (
    !desktop ||
    typeof bridge?.start !== 'function' ||
    typeof bridge.authorize !== 'function' ||
    typeof bridge.cancel !== 'function'
  ) {
    return null;
  }
  return {
    start: () => bridge.start(),
    authorize: async (id, url) => {
      const outcome = await bridge.authorize({ id, url, page: callbackPageText() });
      switch (outcome.status) {
        case 'callback':
          return outcome.callbackUrl;
        case 'cancelled':
        case 'timeout':
          throw new BrowserSignInError(outcome.status);
        default:
          throw new BrowserSignInError('failed');
      }
    },
    cancel: async (id) => {
      await bridge.cancel(id);
    },
    openExternal: async (url) => {
      await desktop.openExternal(url);
    },
  };
}
