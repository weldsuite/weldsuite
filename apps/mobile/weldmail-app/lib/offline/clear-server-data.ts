/**
 * Switching server (WeldSuite cloud, EU, self-hosted) must leave nothing of the
 * old server's mail on the device: the offline read-cache, the offline outbox,
 * the realtime cursors, the selected account, pinned messages and the tray
 * counts are all per server. `registerServerDataCleaner()` hooks this into
 * `onClearServerData`, which runs after sign-out and before the app restarts
 * on the new server.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { onClearServerData } from '@weldsuite/mobile-platform/runtime';

/** Key prefixes of everything stored per server (the offline cache and outbox, realtime cursors). */
const SERVER_KEY_PREFIXES = ['weldmail.cache', 'weldmail.outbox', 'weldmail.realtime.cursor.'];

/** Single keys stored per server (selected account, handled push, pins, tray counts). */
const SERVER_KEYS = [
  '@weldmail_selected_account',
  '@weldmail_handled_notification_id',
  '@weldmail_inbox_unread',
  'weldmail:pinnedMessages',
];

/** Remove every AsyncStorage entry WeldMail keeps for the current server. Never throws. */
export async function clearServerData(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const doomed = keys.filter(
      (key) => SERVER_KEYS.includes(key) || SERVER_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );
    if (doomed.length > 0) await AsyncStorage.multiRemove(doomed);
  } catch {
    // Best effort: a leftover cache entry is keyed by org id and ignored on the next server.
  }
}

/** Register `clearServerData` for a server switch. Returns the unregister function. */
export function registerServerDataCleaner(): () => void {
  return onClearServerData('weldmail-offline', clearServerData);
}
