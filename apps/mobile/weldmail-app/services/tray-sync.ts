/**
 * Keeps the notification tray and the app badge in step with the inbox.
 *
 * Used from two places: the background task that receives the silent
 * "email read" push (`utils/notification-tasks.ts`), and NotificationContext,
 * which re-checks the tray whenever the app comes to the foreground because
 * iOS may never deliver that push (throttling, or the app was force-quit).
 */

import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  dismissPresentedNotificationsWhere,
  setBadgeCount,
} from '@weldsuite/mobile-ui/services/notifications';
import {
  badgeFromCounts,
  parseCount,
  presentedEmailId,
  type InboxUnreadCounts,
} from '@/utils/mail-read-push';

/** Last known unread inbox count per tenancy (workspace / personal). */
const COUNTS_KEY = '@weldmail_inbox_unread';

/** Take the new-email banners for these emails out of the tray. */
export async function dismissEmailNotifications(emailIds: Iterable<string>): Promise<void> {
  const ids = new Set(emailIds);
  if (ids.size === 0) return;
  await dismissPresentedNotificationsWhere((data) => {
    const emailId = presentedEmailId(data);
    return emailId !== undefined && ids.has(emailId);
  });
}

/** Email ids of the new-email banners in the tray, deduplicated. */
export async function presentedEmailIds(): Promise<string[]> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    const ids = presented
      .map((n) => presentedEmailId(n.request.content.data))
      .filter((id): id is string => !!id);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

async function readCounts(): Promise<InboxUnreadCounts> {
  try {
    const raw = await AsyncStorage.getItem(COUNTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const record = parsed as Record<string, unknown>;
    return { workspace: parseCount(record.workspace), personal: parseCount(record.personal) };
  } catch {
    return {};
  }
}

/**
 * Store unread counts and set the badge to their sum. A push carries one
 * tenancy's count (`merge`); the foreground check knows them all and passes
 * `replace` so a tenancy the user no longer has stops counting.
 */
export async function recordInboxUnread(
  counts: InboxUnreadCounts,
  mode: 'merge' | 'replace' = 'merge',
): Promise<void> {
  const next = mode === 'replace' ? counts : { ...(await readCounts()), ...counts };
  try {
    await AsyncStorage.setItem(COUNTS_KEY, JSON.stringify(next));
  } catch {
    // The badge below is what matters; the stored counts only help the next push.
  }
  await setBadgeCount(badgeFromCounts(next));
}

/** Forget the counts (sign-out, workspace switch); the caller clears the badge. */
export async function clearInboxUnread(): Promise<void> {
  try {
    await AsyncStorage.removeItem(COUNTS_KEY);
  } catch {
    // ignore — the next foreground check replaces the counts anyway
  }
}
