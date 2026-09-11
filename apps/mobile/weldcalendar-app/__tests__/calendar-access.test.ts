import { canEditEvent, canWriteToCalendar, writableCalendars } from '@/lib/calendar-access';
import type { Calendar, CalendarPermission } from '@/types/weldcalendar';

function calendar(
  id: string,
  isOwn: boolean,
  permission: CalendarPermission,
): Calendar {
  return {
    id,
    name: id,
    description: null,
    color: null,
    ownerId: isOwn ? 'user_me' : 'user_them',
    isDefault: false,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    isOwn,
    permission,
  };
}

const mine = calendar('cal_mine', true, 'manage');
const sharedView = calendar('cal_view', false, 'view');
const sharedEdit = calendar('cal_edit', false, 'edit');
const sharedManage = calendar('cal_manage', false, 'manage');

describe('canWriteToCalendar', () => {
  it('allows your own calendars and edit/manage shares', () => {
    expect(canWriteToCalendar(mine)).toBe(true);
    expect(canWriteToCalendar(sharedEdit)).toBe(true);
    expect(canWriteToCalendar(sharedManage)).toBe(true);
  });

  it('refuses a view-only share', () => {
    expect(canWriteToCalendar(sharedView)).toBe(false);
  });
});

describe('writableCalendars', () => {
  it('keeps only the calendars the create route would accept', () => {
    const result = writableCalendars([mine, sharedView, sharedEdit, sharedManage]);
    expect(result.map((c) => c.id)).toEqual(['cal_mine', 'cal_edit', 'cal_manage']);
  });
});

describe('canEditEvent', () => {
  const all = [mine, sharedView, sharedEdit];

  it('follows the calendar, not the organiser', () => {
    expect(canEditEvent({ calendarId: 'cal_edit' }, all)).toBe(true);
    expect(canEditEvent({ calendarId: 'cal_view' }, all)).toBe(false);
  });

  it('treats an unknown calendar as read-only', () => {
    expect(canEditEvent({ calendarId: 'cal_gone' }, all)).toBe(false);
    expect(canEditEvent({ calendarId: 'cal_mine' }, [])).toBe(false);
  });
});
