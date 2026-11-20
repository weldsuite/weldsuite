import { toast } from 'sonner';

/**
 * A failed request as a toast: what failed, in the user's language, with the
 * API's own message (`ApiError.message`) underneath when it has one.
 */
export function toastError(message: string, err?: unknown): void {
  const detail = err instanceof Error && err.message && err.message !== message ? err.message : undefined;
  toast.error(message, detail ? { description: detail } : undefined);
}

/** A pasted media link the library can show and PostPeer can fetch: an absolute http(s) URL. */
export function isMediaUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '';
  } catch {
    return false;
  }
}
