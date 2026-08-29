/**
 * OS / browser notification helpers for the platform SPA.
 *
 * On desktop, routes through `window.weldsuiteDesktop` so toasts land in the
 * system notification center (and respect the shell's notificationsEnabled
 * setting). In the browser, falls back to the Web Notification API.
 */

import { getDesktop, isDesktop } from '@/lib/desktop';
import type {
  ModuleChannelPreferences,
  NotificationPreferences,
} from '@/hooks/queries/use-notifications-queries';

export interface OsNotificationClickPayload {
  actionUrl?: string;
}

export interface ShowOsNotificationOptions {
  title: string;
  body?: string;
  /** When true, suppress the OS / browser sound. Default false. */
  silent?: boolean;
  /** Path navigated to when the user clicks the toast (e.g. `/weldchat/abc`). */
  actionUrl?: string;
  /**
   * Skip the toast when the app is focused / visible. Default true — matches
   * Slack / Discord behaviour.
   */
  onlyWhenHidden?: boolean;
  /** Browser-only: play the in-app chime. Desktop uses the OS sound instead. */
  playSound?: boolean;
  tag?: string;
  icon?: string;
}

const BROWSER_CLICK_EVENT = 'weldsuite:notification-click';

/** True when the window is backgrounded or unfocused. */
export function isAppInBackground(): boolean {
  if (typeof document === 'undefined') return true;
  return document.hidden || !document.hasFocus();
}

/**
 * Resolve whether the desktop (OS toast) channel is enabled for a category,
 * mirroring the server preference resolution for in-app / email / push.
 */
export function isDesktopChannelEnabled(
  prefs: NotificationPreferences | undefined | null,
  category?: string,
): boolean {
  if (!prefs) return true;
  if (prefs.doNotDisturb) return false;

  if (category) {
    const modulePref = prefs.modulePreferences?.[category] as ModuleChannelPreferences | undefined;
    if (modulePref) {
      if (!modulePref.enabled) return false;
      return modulePref.desktop;
    }
  }

  return prefs.defaultDesktop;
}

/**
 * Show an OS toast (desktop) or browser notification (web).
 * Returns true when a notification was actually shown.
 */
export async function showOsNotification(
  opts: ShowOsNotificationOptions,
): Promise<boolean> {
  const onlyWhenHidden = opts.onlyWhenHidden ?? true;
  if (onlyWhenHidden && !isAppInBackground()) {
    return false;
  }

  const desktop = getDesktop();
  if (desktop) {
    const shown = await desktop.showNotification({
      title: opts.title,
      body: opts.body,
      silent: opts.silent ?? false,
      actionUrl: opts.actionUrl,
    });
    if (shown) {
      void desktop.flashFrame(true);
    }
    return shown;
  }

  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }

  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  if (Notification.permission !== 'granted') {
    return false;
  }

  if (opts.playSound !== false && !opts.silent) {
    try {
      // Dynamic import avoids a static cycle with notification-sound.ts,
      // which delegates showBrowserNotification here.
      const { playMessageReceivedSound } = await import('@/lib/utils/notification-sound');
      playMessageReceivedSound();
    } catch {
      // Sound is best-effort.
    }
  }

  const notification = new Notification(opts.title, {
    body: opts.body,
    icon: opts.icon ?? '/favicon.ico',
    tag: opts.tag,
    silent: opts.silent ?? false,
  });

  if (opts.actionUrl) {
    const actionUrl = opts.actionUrl;
    notification.onclick = () => {
      window.focus();
      window.dispatchEvent(
        new CustomEvent<OsNotificationClickPayload>(BROWSER_CLICK_EVENT, {
          detail: { actionUrl },
        }),
      );
      notification.close();
    };
  }

  return true;
}

/** Sync the dock / taskbar badge with the unread count. No-op in the browser. */
export function syncDesktopBadge(count: number): void {
  const desktop = getDesktop();
  if (!desktop) return;
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  void desktop.setBadgeCount(safe);
}

/** Stop taskbar flashing when the user returns to the app. */
export function clearDesktopAttention(): void {
  const desktop = getDesktop();
  if (!desktop) return;
  void desktop.flashFrame(false);
}

/**
 * Subscribe to OS / browser notification clicks.
 * Returns an unsubscribe function.
 */
export function onOsNotificationClick(
  listener: (payload: OsNotificationClickPayload) => void,
): () => void {
  const unsubs: Array<() => void> = [];

  const desktop = getDesktop();
  if (desktop) {
    unsubs.push(desktop.onNotificationClick(listener));
  }

  if (typeof window !== 'undefined') {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OsNotificationClickPayload>).detail;
      listener(detail ?? {});
    };
    window.addEventListener(BROWSER_CLICK_EVENT, handler);
    unsubs.push(() => window.removeEventListener(BROWSER_CLICK_EVENT, handler));
  }

  return () => {
    for (const unsub of unsubs) unsub();
  };
}

/** Request browser notification permission when not running in the desktop shell. */
export async function ensureNotificationPermission(): Promise<NotificationPermission | 'desktop'> {
  if (isDesktop()) return 'desktop';
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
  if (Notification.permission === 'default') {
    return Notification.requestPermission();
  }
  return Notification.permission;
}
