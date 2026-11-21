import { downloadBlob } from '@/lib/weldbooks/download';

/**
 * The file name from a `Content-Disposition` header, or `fallback`. A browser
 * only lets a cross-origin page read the header when the API exposes it, so
 * the fallback is a real possibility.
 */
export function fileNameFromResponse(response: Response, fallback: string): string {
  const header = response.headers.get('content-disposition');
  const match = header ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header) : null;
  if (!match?.[1]) return fallback;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Save a fetched file response as the file name it names, or `fallback`. Returns the name used. */
export async function saveResponseAsFile(response: Response, fallback: string): Promise<string> {
  const fileName = fileNameFromResponse(response, fallback);
  downloadBlob(await response.blob(), fileName);
  return fileName;
}
