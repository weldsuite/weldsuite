import { isApiError } from '@weldsuite/api-client';

/** The API's own message for a refusal (400, 403, 404, 409), else the localized fallback. */
export function apiMessage(error: unknown, fallback: string): string {
  if (isApiError(error) && error.status >= 400 && error.status < 500 && error.message) return error.message;
  return fallback;
}
