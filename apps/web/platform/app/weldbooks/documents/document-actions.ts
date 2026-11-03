import { isApiError } from '@weldsuite/api-client';
import { getAppApiUrl } from '@/lib/api/public-env';
import { PRIVATE_STORAGE_PATH } from '@/lib/storage/private-url';

/** Statuses whose document never got an OCR result, so it can be scanned again. */
export const RESCANNABLE_STATUSES: ReadonlySet<string> = new Set(['pending', 'failed']);

/** The uploaded file, served by app-api's private storage route to workspace members. */
export function documentFileUrl(fileKey: string, apiOrigin: string = getAppApiUrl()): string {
  const path = fileKey.split('/').map(encodeURIComponent).join('/');
  return `${apiOrigin.replace(/\/$/, '')}${PRIVATE_STORAGE_PATH}${path}`;
}

/** A scan failure in words: a 402 means the workspace is out of AI credits. */
export function processErrorMessage(
  err: unknown,
  messages: Readonly<{ insufficientCredits: string; fallback: string }>,
): string {
  if (isApiError(err) && err.status === 402) return messages.insufficientCredits;
  return err instanceof Error && err.message ? err.message : messages.fallback;
}
