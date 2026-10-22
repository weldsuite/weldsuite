/**
 * Turns Clerk sign-in errors into copy the login screen can show.
 *
 * Clerk's own messages are never passed through: "Couldn't find your account"
 * vs. "Password is incorrect" tells anyone whether an email address has an
 * account. Everything that comes down to wrong credentials or a wrong code gets
 * the caller's generic fallback. Only problems the user can act on and that say
 * nothing about the account keep their own message.
 */

import type { LoginScreenCopy } from '../constants/login-copy';

type AuthErrorCopy = Pick<LoginScreenCopy, 'tooManyAttempts' | 'accountLocked' | 'networkError'>;
type PasswordErrorCopy = Pick<LoginScreenCopy, 'passwordRequirements' | 'passwordCompromised'>;

interface ClerkLikeError {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  errors?: { code?: unknown }[];
}

const PASSWORD_RULE_CODES = new Set([
  'form_password_length_too_short',
  'form_password_length_too_long',
  'form_password_not_strong_enough',
  'form_password_size_in_bytes_exceeded',
  'form_password_validation_failed',
]);

/** Shape check for "looks like an email", before asking Clerk. */
export function isValidEmail(value: string): boolean {
  const email = value.trim();
  if (/\s/.test(email)) return false;
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  const dot = domain.lastIndexOf('.');
  return local.length > 0 && dot > 0 && dot < domain.length - 1;
}

function errorCodes(error: unknown): string[] {
  const e = (error ?? {}) as ClerkLikeError;
  const codes = (e.errors ?? [])
    .map((item) => item?.code)
    .filter((code): code is string => typeof code === 'string');
  if (typeof e.code === 'string') codes.push(e.code);
  return codes;
}

function isNetworkError(error: unknown): boolean {
  if (errorCodes(error).includes('network_error')) return true;
  const e = (error ?? {}) as ClerkLikeError;
  // React Native's fetch rejects with a bare TypeError when offline.
  return !e.errors && typeof e.message === 'string' && /network request failed/i.test(e.message);
}

export function authErrorMessage(error: unknown, fallback: string, copy: AuthErrorCopy): string {
  const codes = errorCodes(error);
  if (codes.includes('user_locked')) return copy.accountLocked;
  if ((error as ClerkLikeError | null)?.status === 429 || codes.includes('too_many_requests')) {
    return copy.tooManyAttempts;
  }
  if (isNetworkError(error)) return copy.networkError;
  return fallback;
}

/** A rejected new password during reset, or null when the error is about something else. */
export function passwordErrorMessage(error: unknown, copy: PasswordErrorCopy): string | null {
  const codes = errorCodes(error);
  if (codes.includes('form_password_pwned')) return copy.passwordCompromised;
  if (codes.some((code) => PASSWORD_RULE_CODES.has(code))) return copy.passwordRequirements;
  return null;
}
