/**
 * Safe external-URL opening for WeldChat.
 *
 * Attachment / link URLs in chat messages are SERVER-supplied but ultimately
 * originate from other users. Passing them straight to `Linking.openURL` lets a
 * crafted `javascript:`, `file:`, `intent:`, or `content:` URL reach the OS,
 * which on Android can fire arbitrary intents (deep-link hijack) or read local
 * files. We allowlist the only schemes a chat attachment / contact action should
 * ever use and reject everything else.
 */

import { Alert, Linking } from 'react-native';

/** Schemes a chat attachment or link is allowed to open. */
const SAFE_URL_SCHEMES = /^(https?|mailto|tel):/i;

/**
 * Open an external URL only if its scheme is in the allowlist. Returns `true`
 * when the URL was handed to the OS, `false` when it was rejected. On rejection
 * (or OS failure) an alert is shown unless `silent` is set.
 */
export async function openExternalUrl(
  url: unknown,
  opts: { silent?: boolean } = {},
): Promise<boolean> {
  if (typeof url !== 'string' || !SAFE_URL_SCHEMES.test(url.trim())) {
    if (!opts.silent) Alert.alert('Cannot open link', 'This link is not a supported web address.');
    return false;
  }
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    if (!opts.silent) Alert.alert('Cannot open link', 'No app is available to open this link.');
    return false;
  }
}
