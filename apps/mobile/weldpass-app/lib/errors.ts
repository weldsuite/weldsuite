/**
 * What went wrong with a WeldPass request, in words the person can act on.
 * The device checklist asks for two of these to be clear: a viewer's 403 and
 * the 500 `CRYPTO_ERROR` a server without a usable root key answers.
 */

import { isApiError, isNetworkError } from '@weldsuite/api-client/client';

import type { Translations } from '@/lib/i18n';

export type PassErrorKind = 'offline' | 'forbidden' | 'notFound' | 'crypto' | 'generic';

function errorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function passErrorKind(error: unknown): PassErrorKind {
  if (isNetworkError(error)) return 'offline';
  if (!isApiError(error)) return 'generic';
  if (errorCode(error.body) === 'CRYPTO_ERROR') return 'crypto';
  if (error.status === 403) return 'forbidden';
  if (error.status === 404) return 'notFound';
  return 'generic';
}

export function passErrorMessage(t: Translations, error: unknown): string {
  return t.errors[passErrorKind(error)];
}
