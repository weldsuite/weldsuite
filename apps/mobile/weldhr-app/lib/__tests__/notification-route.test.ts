import { notificationTarget } from '../notification-route';

describe('notificationTarget', () => {
  it('opens the announcement a push is about', () => {
    expect(
      notificationTarget({
        notificationType: 'hr_announcement',
        announcementId: 'hran_123',
        actionUrl: '/weldhr/me/announcements?announcement=hran_123',
      }),
    ).toBe('/announcement/hran_123');
  });

  it('falls back to the announcements tab without an id', () => {
    expect(notificationTarget({ notificationType: 'hr_announcement' })).toBe('/announcements');
    expect(notificationTarget({ notificationType: 'hr_announcement', announcementId: '' })).toBe('/announcements');
  });

  it('keeps an id with odd characters in one path segment', () => {
    expect(notificationTarget({ notificationType: 'hr_announcement', announcementId: 'a/b' })).toBe('/announcement/a%2Fb');
  });

  it('follows the route an older push carries', () => {
    expect(notificationTarget({ route: '/schedule' })).toBe('/schedule');
  });

  it('stays where it is for anything else', () => {
    expect(notificationTarget(undefined)).toBeNull();
    expect(notificationTarget({})).toBeNull();
    expect(notificationTarget({ notificationType: 'other', route: 3 })).toBeNull();
  });
});
