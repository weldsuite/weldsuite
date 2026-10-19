/**
 * Opens an email attachment on the device.
 *
 * Attachments carry no public URL: the bucket's public URL served files without
 * any authentication, so mail-api no longer returns `downloadUrl` /
 * `storagePath`. The bytes only come from the authenticated
 * `GET /api/mail-attachments/:id/download` (Clerk bearer, mailbox access check;
 * 404 when the caller may not read it).
 *
 * Tapping an attachment therefore downloads it with the member's session to a
 * cache file named after the attachment, then hands that file to the OS:
 * the share sheet on iOS (Open in / Save to Files / Quick Look apps), an
 * ACTION_VIEW intent on a content:// URI on Android. Failures surface in an
 * alert, like before. The helper never rejects.
 */

import { Alert, Linking, Platform, Share } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { getAppApiRequestInit } from '@/services/app-api';

/** The subset of an attachment shape this helper needs. */
export interface OpenableAttachment {
  id?: string | null;
  fileName?: string | null;
  filename?: string | null;
  name?: string | null;
}

/** Folder (inside the OS-managed cache) the downloads land in, one subfolder per attachment id. */
const CACHE_FOLDER = 'mail-attachments';

/** Resolve the best display name for an attachment (for messaging). */
function attachmentName(attachment: OpenableAttachment): string {
  return (
    attachment.fileName || attachment.filename || attachment.name || 'attachment'
  );
}

/** The attachment's id, or null when it has none we can download by. */
export function resolveAttachmentId(attachment: OpenableAttachment): string | null {
  const id = attachment.id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * A file name that is safe to create on disk: no path separators, control
 * characters or leading dots (a stranger chose it), never empty.
 */
export function safeCacheFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'attachment';
}

/** Download the attachment through the authenticated endpoint into the cache. */
async function downloadAttachment(id: string, name: string): Promise<File> {
  const { url, headers } = await getAppApiRequestInit(
    `/mail-attachments/${encodeURIComponent(id)}/download`,
  );
  // One folder per id: two attachments may share a file name.
  const directory = new Directory(Paths.cache, CACHE_FOLDER, safeCacheFileName(id));
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, safeCacheFileName(name));
  return File.downloadFileAsync(url, file, { headers, idempotent: true });
}

/** Hand a downloaded file to the OS. */
async function presentFile(file: File): Promise<void> {
  if (Platform.OS === 'android') {
    await Linking.openURL(file.contentUri);
    return;
  }
  await Share.share({ url: file.uri });
}

/** True when the failure was the endpoint saying the attachment is not (or no longer) there. */
function isNotAvailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b(404|403)\b/.test(message);
}

/**
 * Open the given attachment. Resolves once the open flow has been dispatched
 * (or an error has been surfaced) — never rejects.
 */
export async function openAttachment(
  attachment: OpenableAttachment,
): Promise<void> {
  const name = attachmentName(attachment);
  const id = resolveAttachmentId(attachment);

  if (!id) {
    Alert.alert(
      'Cannot open attachment',
      `"${name}" isn't available to download right now.`,
    );
    return;
  }

  let file: File;
  try {
    file = await downloadAttachment(id, name);
  } catch (err) {
    Alert.alert(
      'Cannot open attachment',
      isNotAvailable(err)
        ? `"${name}" isn't available to download right now.`
        : `Could not download "${name}". Check your connection and try again.`,
    );
    return;
  }

  try {
    await presentFile(file);
  } catch {
    Alert.alert(
      'Cannot open attachment',
      `Something went wrong opening "${name}".`,
    );
  }
}
