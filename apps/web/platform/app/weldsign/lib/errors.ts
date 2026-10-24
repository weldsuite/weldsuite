import { isApiError } from '@weldsuite/api-client';

/** The server's message for a failed request (sign-api writes them for people), or a generic one. */
export function apiErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

export function isNotFound(err: unknown): boolean {
  return isApiError(err) && err.status === 404;
}
