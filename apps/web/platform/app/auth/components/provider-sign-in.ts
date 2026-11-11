/**
 * Shared by the sign-in, sign-up and password pages on an OIDC provider
 * (ADR SEC-016): what a refusal from `/api/sign-in/*` says on screen, and
 * starting a sign-in again without looping.
 */

import { redirectToSignIn } from '@/lib/auth';
import { SignInError, type SignInErrorCode } from '@/lib/auth/oidc/sign-in-api';
import { getTranslations } from '@/lib/i18n';

/** How long one restart counts, so a provider that keeps refusing can't loop the page. */
const RESTART_WINDOW_MS = 30_000;
const RESTART_KEY = 'weldsuite:sign-in:restarted';

/** Only paths on this origin are places to return to. */
export function sameOriginPath(value: string | null | undefined): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function restartedRecently(): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(RESTART_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < RESTART_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * The provider no longer knows this sign-in (an old link, the back button):
 * start a new one. False when this tab did so a moment ago, and the page
 * should say sign-in failed instead.
 */
export function restartSignIn(intent: 'sign-in' | 'sign-up' = 'sign-in'): boolean {
  if (restartedRecently()) return false;
  try {
    window.sessionStorage.setItem(RESTART_KEY, String(Date.now()));
  } catch {
    // Storage blocked: the restart still happens, without the loop guard.
  }
  void redirectToSignIn({ intent, returnTo: '/' });
  return true;
}

export function signInErrorCode(err: unknown): SignInErrorCode {
  return err instanceof SignInError ? err.code : 'UNAVAILABLE';
}

/** What a refusal means, in the person's language; `fallback` for the ones a screen words itself. */
export function signInErrorMessage(code: SignInErrorCode, fallback: string): string {
  const t = getTranslations('common').auth;
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return t.login.invalidEmailOrPassword;
    case 'ACCOUNT_LOCKED':
      return t.identityProvider.accountLocked;
    case 'RATE_LIMITED':
      return t.identityProvider.tooManyAttempts;
    case 'EMAIL_TAKEN':
      return t.identityProvider.emailTaken;
    case 'WEAK_PASSWORD':
      return t.register.passwordDoesNotMeetRequirements;
    case 'SIGN_UP_DISABLED':
      return t.identityProvider.signUpDisabled;
    default:
      return fallback;
  }
}
