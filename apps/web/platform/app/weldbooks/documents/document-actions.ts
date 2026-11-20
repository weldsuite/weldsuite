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

/**
 * What the document dialog says about a document without a usable OCR result: the scan failed, the
 * edition reads no documents (OCR unavailable: the bill is entered by hand), or it was not scanned yet.
 * `ocr` when there is a result to show.
 */
export type DocumentState = 'ocr' | 'failed' | 'noOcr' | 'notScanned';

export function documentState(doc: { status: string; ocrResult?: unknown }, ocrAvailable: boolean): DocumentState {
  if (doc.ocrResult) return 'ocr';
  if (doc.status === 'failed') return 'failed';
  return ocrAvailable ? 'notScanned' : 'noOcr';
}

/** A document opens in the dialog unless it is being scanned right now. */
export function canOpenDocument(doc: { status: string }): boolean {
  return doc.status !== 'processing';
}

/** An image upload is previewed in the dialog; a PDF opens in its own tab. */
export function isImageDocument(doc: { mimeType?: string | null; fileName?: string | null }): boolean {
  if (doc.mimeType) return doc.mimeType.startsWith('image/');
  return /\.(jpe?g|png|webp)$/i.test(doc.fileName ?? '');
}
