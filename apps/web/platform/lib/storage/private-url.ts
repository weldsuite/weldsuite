/**
 * Private uploads (TASK-620) are served by app-api at
 * `/api/storage/private/<key>` and read with the files cookie set by
 * `components/private-files-access.tsx`. A `fetch` of one must send
 * credentials; `<img>`, `<a>` and `<video>` already do.
 */
export const PRIVATE_STORAGE_PATH = '/api/storage/private/';

export function isPrivateStorageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url, window.location.href).pathname.startsWith(PRIVATE_STORAGE_PATH);
  } catch {
    return false;
  }
}
