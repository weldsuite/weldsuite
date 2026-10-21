import { describe, it, expect } from 'vitest';
import type { CalendarEvent, UserCalendar } from '@/hooks/queries/use-calendar-queries';
import { bookingConflictEvents } from './booking-conflicts';

const calendar = (id: string, ownerId: string, isOwn: boolean): UserCalendar => ({
  id,
  name: id,
  ownerId,
  isOwn,
  permission: isOwn ? 'manage' : 'view',
});

const calendars = [
  calendar('cal_own', 'user_owner', true),
  calendar('cal_own_2', 'user_owner', true),
  calendar('cal_teammate', 'user_teammate', false),
];

const event = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'evt',
  type: 'meeting',
  title: 'Event',
  startTime: '2026-10-21T09:00:00.000Z',
  endTime: '2026-10-21T10:00:00.000Z',
  calendarId: 'cal_own',
  organizerId: 'user_owner',
  status: 'confirmed',
  ...overrides,
});

const ids = (events: CalendarEvent[]) => events.map((e) => e.id);

describe('bookingConflictEvents', () => {
  it("keeps events on any of the owner's calendars, tasks included", () => {
    const own = event({ id: 'own' });
    const second = event({ id: 'second', calendarId: 'cal_own_2' });
    const ownTask = event({ id: 'task', type: 'reminder', sourceType: 'task', sourceId: 'task_1' });
    expect(ids(bookingConflictEvents([own, second, ownTask], calendars, 'user_owner'))).toEqual(['own', 'second', 'task']);
  });

  it("drops a teammate's events and tasks on a calendar shared with the viewer", () => {
    const teammateTask = event({
      id: 'teammate-task',
      type: 'reminder',
      calendarId: 'cal_teammate',
      organizerId: 'user_teammate',
      sourceType: 'task',
      sourceId: 'task_2',
    });
    const teammateMeeting = event({ id: 'teammate-meeting', calendarId: 'cal_teammate', organizerId: 'user_teammate' });
    expect(bookingConflictEvents([teammateTask, teammateMeeting], calendars, 'user_owner')).toEqual([]);
  });

  it('keeps an event the owner organizes on a calendar they do not own', () => {
    const organized = event({ id: 'organized', calendarId: 'cal_teammate', organizerId: 'user_owner' });
    expect(ids(bookingConflictEvents([organized], calendars, 'user_owner'))).toEqual(['organized']);
  });

  it('drops cancelled events and keeps tentative ones', () => {
    const cancelled = event({ id: 'cancelled', status: 'cancelled' });
    const tentative = event({ id: 'tentative', status: 'tentative' });
    const noStatus = event({ id: 'no-status', status: undefined });
    expect(ids(bookingConflictEvents([cancelled, tentative, noStatus], calendars, 'user_owner'))).toEqual([
      'tentative',
      'no-status',
    ]);
  });

  it('follows the page owner, not the viewer', () => {
    // A viewer looking at a teammate's page: the teammate's events are the ones that count.
    const teammateMeeting = event({ id: 'teammate-meeting', calendarId: 'cal_teammate', organizerId: 'user_teammate' });
    const viewerMeeting = event({ id: 'viewer-meeting' });
    expect(ids(bookingConflictEvents([teammateMeeting, viewerMeeting], calendars, 'user_teammate'))).toEqual([
      'teammate-meeting',
    ]);
  });

  it('returns nothing while the owner is unknown', () => {
    expect(bookingConflictEvents([event({})], calendars, undefined)).toEqual([]);
  });
});
