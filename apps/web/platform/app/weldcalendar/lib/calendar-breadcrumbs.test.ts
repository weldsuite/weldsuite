import { describe, expect, it } from 'vitest';
import { buildCalendarBreadcrumbs, schedulingPageIdFromPath } from './calendar-breadcrumbs';

const labels = {
  root: 'Calendar',
  scheduling: 'Scheduling',
  newBookingPage: 'New booking page',
  bookingPage: 'Booking page',
  details: 'Details',
  edit: 'Edit',
};

const names = (pathname: string, bookingPageName?: string | null) =>
  buildCalendarBreadcrumbs(pathname, { labels, bookingPageName }).map((c) => c.label);

describe('buildCalendarBreadcrumbs', () => {
  it('keeps the generic trail for non-scheduling paths', () => {
    expect(names('/weldcalendar')).toEqual(['Calendar']);
    expect(names('/weldcalendar/events')).toEqual(['Calendar', 'Events']);
  });

  it('shows "New booking page" instead of __draft__ or new', () => {
    expect(names('/weldcalendar/scheduling/__draft__')).toEqual(['Calendar', 'Scheduling', 'New booking page']);
    expect(names('/weldcalendar/scheduling/new')).toEqual(['Calendar', 'Scheduling', 'New booking page']);
  });

  it('shows the booking page name, never its raw id', () => {
    expect(names('/weldcalendar/scheduling/bpg_muryljv7oij0hi4z/view', 'Intro call')).toEqual([
      'Calendar',
      'Scheduling',
      'Intro call',
    ]);
    expect(names('/weldcalendar/scheduling/bpg_muryljv7oij0hi4z/edit', 'Intro call')).toEqual([
      'Calendar',
      'Scheduling',
      'Intro call',
      'Edit',
    ]);
    expect(names('/weldcalendar/scheduling/bpg_muryljv7oij0hi4z', 'Intro call')).toEqual([
      'Calendar',
      'Scheduling',
      'Intro call',
      'Details',
    ]);
  });

  it('falls back to a generic label while the name loads', () => {
    expect(names('/weldcalendar/scheduling/bpg_muryljv7oij0hi4z/view')).toEqual([
      'Calendar',
      'Scheduling',
      'Booking page',
    ]);
    expect(names('/weldcalendar/scheduling/bpg_muryljv7oij0hi4z/view', '  ')).toEqual([
      'Calendar',
      'Scheduling',
      'Booking page',
    ]);
  });

  it('links the booking page crumb to its view page', () => {
    const crumbs = buildCalendarBreadcrumbs('/weldcalendar/scheduling/bpg_1/edit', {
      labels,
      bookingPageName: 'Intro call',
    });
    expect(crumbs[2]?.href).toBe('/weldcalendar/scheduling/bpg_1/view');
  });
});

describe('schedulingPageIdFromPath', () => {
  it('extracts the booking page id', () => {
    expect(schedulingPageIdFromPath('/weldcalendar/scheduling/bpg_1/view')).toBe('bpg_1');
    expect(schedulingPageIdFromPath('/weldcalendar/scheduling/bpg_1')).toBe('bpg_1');
  });

  it('returns null for placeholders and other pages', () => {
    expect(schedulingPageIdFromPath('/weldcalendar/scheduling/new')).toBeNull();
    expect(schedulingPageIdFromPath('/weldcalendar/scheduling/__draft__')).toBeNull();
    expect(schedulingPageIdFromPath('/weldcalendar/scheduling')).toBeNull();
    expect(schedulingPageIdFromPath('/weldcalendar/events')).toBeNull();
  });
});
