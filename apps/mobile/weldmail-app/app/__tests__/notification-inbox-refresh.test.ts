import { readFileSync } from 'fs';
import { join } from 'path';
import {
  NOTIFICATION_LIST_RETRY_DELAYS_MS,
  nextNotificationListRetryMs,
} from '../../utils/notification-target';

/**
 * Source guards for "refresh inbox when a new-email notification arrives /
 * is tapped". Text-level (same style as personal-push-notifications.test.ts)
 * so a quiet revert of the receive-path refresh or cold-start replay fails CI.
 */
describe('Notification inbox refresh', () => {
  const notificationContext = readFileSync(
    join(__dirname, '../../contexts/NotificationContext.tsx'),
    'utf8',
  );

  it('refreshes the inbox when a notification is received (not only on tap)', () => {
    expect(notificationContext).toMatch(/refreshInboxFromNotification/);
    // The received listener must call the refresh helper, not only badge updates.
    const receivedHandler = notificationContext.slice(
      notificationContext.indexOf('setupNotificationListeners('),
      notificationContext.indexOf('queueNavigationFromResponse,'),
    );
    expect(receivedHandler).toMatch(/refreshInboxFromNotification\(target\)/);

    const refreshHelper = notificationContext.slice(
      notificationContext.indexOf('const refreshInboxFromNotification'),
      notificationContext.indexOf('const queueNavigationFromResponse'),
    );
    expect(refreshHelper).toMatch(/expectNotificationEmailRef\.current/);
    expect(refreshHelper).toMatch(/refreshMailRef\.current/);
  });

  it('replays the last notification response on cold start with a handled-id guard', () => {
    expect(notificationContext).toMatch(/getLastNotificationResponseAsync/);
    expect(notificationContext).toMatch(/HANDLED_NOTIF_KEY/);
    expect(notificationContext).toMatch(/AsyncStorage\.getItem\(HANDLED_NOTIF_KEY\)/);
    // Must not leave the old "do not replay" early-exit comment as the only path.
    expect(notificationContext).not.toMatch(
      /Do not replay getLastNotificationResponseAsync on cold start/,
    );
  });

  it('keeps a longer backoff so the list can catch a late insert after a tap', () => {
    expect(NOTIFICATION_LIST_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(4);
    expect(nextNotificationListRetryMs(0)).toBe(400);
    expect(nextNotificationListRetryMs(3)).toBe(4000);
    expect(nextNotificationListRetryMs(4)).toBeNull();
  });
});
