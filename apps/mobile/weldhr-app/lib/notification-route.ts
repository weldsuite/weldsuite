/**
 * Where a tapped push notification leads. Notifications carry a `data` bag;
 * the ones WeldHR sends are recognised by `notificationType`, the app's own
 * `route` (set by older senders) is followed as is. Null means stay where you are.
 */

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

export function notificationTarget(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  if (data.notificationType === 'hr_announcement') {
    const id = text(data.announcementId);
    // Without an id (an old push) the announcements tab still shows what is new.
    return id ? `/announcement/${encodeURIComponent(id)}` : '/announcements';
  }
  return text(data.route);
}
