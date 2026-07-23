/**
 * Opens an email attachment on the device.
 *
 * Attachments carry a fully-qualified `downloadUrl` (an R2 public URL, see
 * `mail-inbound-worker`'s email-storage). The detail screens previously
 * rendered the attachment rows as inert `TouchableOpacity`s with no handler,
 * so tapping an attachment did nothing on either platform. This helper wires
 * that tap up: it opens the URL in an in-app browser (Custom Tab on Android,
 * SFSafariViewController on iOS), which renders PDFs/images inline and hands
 * everything else to the OS download flow.
 *
 * Falls back to `Linking.openURL` if the in-app browser can't be opened, and
 * surfaces a friendly alert when the attachment has no resolvable URL.
 */

import { Alert, Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

/** The subset of an attachment shape this helper needs. */
export interface OpenableAttachment {
  downloadUrl?: string | null;
  url?: string | null;
  fileName?: string | null;
  filename?: string | null;
  name?: string | null;
}

/** Resolve the best display name for an attachment (for error messaging). */
function attachmentName(attachment: OpenableAttachment): string {
  return (
    attachment.fileName || attachment.filename || attachment.name || 'attachment'
  );
}

/** Resolve the openable URL for an attachment, if any. */
export function resolveAttachmentUrl(
  attachment: OpenableAttachment,
): string | null {
  const url = attachment.downloadUrl || attachment.url;
  if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) {
    return url.trim();
  }
  return null;
}

/**
 * Open the given attachment. Resolves once the open flow has been dispatched
 * (or an error has been surfaced) — never rejects.
 */
export async function openAttachment(
  attachment: OpenableAttachment,
): Promise<void> {
  const url = resolveAttachmentUrl(attachment);

  if (!url) {
    Alert.alert(
      'Cannot open attachment',
      `"${attachmentName(attachment)}" isn't available to download right now.`,
    );
    return;
  }

  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    // In-app browser unavailable — hand off to the OS default handler.
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert(
        'Cannot open attachment',
        `Something went wrong opening "${attachmentName(attachment)}".`,
      );
    }
  }
}
