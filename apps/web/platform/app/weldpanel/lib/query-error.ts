import { isApiError } from '@weldsuite/api-client';

/** 503 from `POST /query`: the analytics store (Basin) is not connected in this environment. */
export function isAnalyticsUnavailable(error: unknown): boolean {
  return isApiError(error) && error.status === 503;
}

export function isForbidden(error: unknown): boolean {
  return isApiError(error) && error.status === 403;
}
