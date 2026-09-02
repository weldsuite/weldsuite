/**
 * Desktop notifications for newly arrived mail.
 *
 * Thin wrapper over the browser Notification API: it keeps the permission
 * dance and the "browser doesn't support this" checks out of the components,
 * and never throws — a blocked or unsupported notification is not a reason for
 * the inbox to stop updating.
 */

const STORAGE_KEY = 'weldmail:notifications-asked';

export type NotificationPermissionState = 'unsupported' | NotificationPermission;

export function notificationState(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/** True once we've shown the browser prompt, so we only ask a user once. */
function alreadyAsked(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Private mode / storage disabled — treat as "not asked" and rely on the
    // browser's own prompt throttling.
    return false;
  }
}

function markAsked(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Non-fatal: worst case we ask again next session.
  }
}

/**
 * Ask for notification permission, at most once per browser.
 *
 * Returns the resulting permission, or 'unsupported'. Safe to call on mount —
 * it no-ops when permission was already granted or denied.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  const state = notificationState();
  if (state !== 'default') return state;
  if (alreadyAsked()) return 'default';

  markAsked();
  try {
    return await Notification.requestPermission();
  } catch {
    return 'default';
  }
}

export interface MailNotification {
  title: string;
  body: string;
  /** Collapses repeat notifications for the same message into one. */
  tag?: string;
  onClick?: () => void;
}

/** Show a desktop notification. No-op unless permission was granted. */
export function showMailNotification(notification: MailNotification): void {
  if (notificationState() !== 'granted') return;

  try {
    const instance = new Notification(notification.title, {
      body: notification.body,
      tag: notification.tag,
      icon: '/favicon.ico',
    });
    if (notification.onClick) {
      instance.onclick = () => {
        window.focus();
        notification.onClick?.();
        instance.close();
      };
    }
  } catch {
    // Some browsers throw when constructing notifications outside a service
    // worker (notably Android Chrome). Silently skip — the in-app list still
    // updates from the same realtime event.
  }
}
