/**
 * Opens a payslip, annual statement or receipt on the device.
 *
 * None of these has a public URL: hr-api serves them only to the signed-in
 * employee (and audits payslip views), so the file is downloaded with the
 * member's session into the app's cache and then handed to the OS — the share
 * sheet on iOS (Quick Look, Save to Files), an ACTION_VIEW intent on Android,
 * a new tab in the browser preview. Same approach as WeldMail's attachments
 * (apps/mobile/weldmail-app/utils/open-attachment.ts).
 *
 * Resolves to `true` once the document is shown, `false` when it could not
 * be; never rejects. The caller shows the message.
 */

import { Platform, Share } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

import { getAppApiRequestInit } from '@/services/app-api';

/** android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION */
const FLAG_GRANT_READ_URI_PERMISSION = 0x1;

/** Folder inside the OS-managed cache; the OS may clear it, which is fine. */
const CACHE_FOLDER = 'weldhr-documents';

export interface DocumentRequest {
  /** API path under `/api`, e.g. `/weldhr/me/payslips/ps_1/pdf`. */
  path: string;
  /** File name to save as, e.g. `payslip-2026-03.pdf`. */
  fileName: string;
  /** Defaults to the type the file name's extension implies. */
  mimeType?: string;
}

/** A file name that is safe on disk: no separators, control characters or leading dots. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'document.pdf';
}

async function openOnWeb({ path }: DocumentRequest): Promise<void> {
  const { url, headers } = await getAppApiRequestInit(path);
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const objectUrl = URL.createObjectURL(await response.blob());
  window.open(objectUrl, '_blank', 'noopener');
  // Give the new tab time to load before the URL is released.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/** The MIME type Android needs to pick a viewer, from the file name. */
export function mimeTypeFor(fileName: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  switch (extension) {
    case 'pdf':
      return 'application/pdf';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return '*/*';
  }
}

async function openOnDevice({ path, fileName, mimeType = mimeTypeFor(fileName) }: DocumentRequest): Promise<void> {
  const { url, headers } = await getAppApiRequestInit(path);
  const directory = new Directory(Paths.cache, CACHE_FOLDER);
  directory.create({ intermediates: true, idempotent: true });
  const file = await File.downloadFileAsync(url, new File(directory, safeFileName(fileName)), {
    headers,
    idempotent: true,
  });

  if (Platform.OS === 'android') {
    // Required lazily: on a binary that predates the native module (an OTA
    // update to an older build) loading it throws, and that must end in the
    // caller's message instead of taking down every screen importing this file.
    const { startActivityAsync } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose, see above
      require('expo-intent-launcher') as typeof import('expo-intent-launcher');
    await startActivityAsync('android.intent.action.VIEW', {
      data: file.contentUri,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
      type: mimeType,
    });
    return;
  }
  await Share.share({ url: file.uri });
}

export async function openDocument(request: DocumentRequest): Promise<boolean> {
  try {
    if (Platform.OS === 'web') await openOnWeb(request);
    else await openOnDevice(request);
    return true;
  } catch {
    return false;
  }
}
