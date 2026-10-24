import { isApiError } from '@weldsuite/api-client';

/** The server's message for a failed request (sign-api writes them for people), or a generic one. */
export function apiErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

export function isNotFound(err: unknown): boolean {
  return isApiError(err) && err.status === 404;
}

/** 409: the request is no longer open (or, for a reminder, everyone was reminded a moment ago). */
export function isConflict(err: unknown): boolean {
  return isApiError(err) && err.status === 409;
}

/**
 * Toast text for a failed lifecycle action: the "no longer open" message on a
 * 409, otherwise the action's own message with the server's reason (an email
 * limit, for instance) after it.
 */
export function lifecycleErrorMessage(err: unknown, failed: string, notOpen: string): string {
  return isConflict(err) ? notOpen : `${failed}: ${apiErrorMessage(err)}`;
}
