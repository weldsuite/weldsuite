/**
 * Background notification task: receives pushes while the app is in the
 * background or not running, and handles the silent "email read" push by
 * taking that email's new-email banner out of the tray and updating the badge.
 *
 * expo-task-manager loads the JS bundle headless to run it, so the task has to
 * be defined (and registered) in module scope of a module the app imports at
 * startup: `app/_layout.tsx` imports this file for its side effect. Anything
 * that needs React, Clerk or the API stays out of here; the foreground check
 * in NotificationContext covers what this task can't.
 *
 * The OS may skip it (iOS throttles background pushes and never wakes a
 * force-quit app; Android Doze delays them), which is why the server also
 * sets the badge on the push itself.
 */

import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { dismissEmailNotifications, recordInboxUnread } from '@/services/tray-sync';
import { findMailReadPush, findNewEmailCount } from '@/utils/mail-read-push';

export const MAIL_NOTIFICATION_TASK = 'weldmail-background-notification';

TaskManager.defineTask<Notifications.NotificationTaskPayload>(MAIL_NOTIFICATION_TASK, async ({ data, error }) => {
  if (error) return Notifications.BackgroundNotificationTaskResult.Failed;
  try {
    const read = findMailReadPush(data);
    if (read) {
      await dismissEmailNotifications(read.emailIds);
      if (read.inboxUnread !== undefined) await recordInboxUnread({ [read.tenantKind]: read.inboxUnread });
      return Notifications.BackgroundNotificationTaskResult.NewData;
    }
    const newEmail = findNewEmailCount(data);
    if (newEmail) {
      await recordInboxUnread({ [newEmail.tenantKind]: newEmail.inboxUnread });
      return Notifications.BackgroundNotificationTaskResult.NewData;
    }
    return Notifications.BackgroundNotificationTaskResult.NoData;
  } catch {
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
});

Notifications.registerTaskAsync(MAIL_NOTIFICATION_TASK).catch(() => {
  // Not available (Expo Go, web): the foreground tray check still runs.
});
