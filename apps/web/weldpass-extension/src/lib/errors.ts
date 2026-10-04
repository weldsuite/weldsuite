import { isApiError, isNetworkError } from '@weldsuite/api-client';
import type { MessageKey } from './i18n';

/** The message to show for a failed API call. Never echoes the error's own text. */
export function errorMessageKey(error: unknown): MessageKey {
  if (isNetworkError(error)) return 'errorNetwork';
  if (isApiError(error)) {
    if (error.status === 401) return 'errorSession';
    if (error.status === 403) return 'errorForbidden';
    if (error.status === 404) return 'errorNotFound';
    return 'errorGeneric';
  }
  // createClientApi throws this when Clerk has no token to give.
  if (error instanceof Error && error.message === 'Authentication required') return 'errorSession';
  return 'errorGeneric';
}
