import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '@/hooks/queries/use-calendar-queries';
import {
  applyEventFilters,
  isNegatedOperator,
  matchesEventFilter,
  matchesEventSearch,
  mergeSearchResults,
} from './event-filters';

const meeting: CalendarEvent = {
  id: 'e1',
  type: 'meeting',
  title: 'Planning',
  startTime: '2026-10-05T09:00:00.000Z',
  calendarId: 'cal_1',
  status: 'confirmed',
  priority: 'normal',
  allDay: false,
};
const call: CalendarEvent = { ...meeting, id: 'e2', type: 'call', title: 'Sync', calendarId: 'cal_2', allDay: true };

describe('isNegatedOperator', () => {
  it('accepts both spellings FilterPills / older callers use', () => {
    expect(isNegatedOperator('is not')).toBe(true);
    expect(isNegatedOperator('is_not')).toBe(true);
    expect(isNegatedOperator('is')).toBe(false);
    expect(isNegatedOperator('')).toBe(false);
  });
});

describe('matchesEventFilter', () => {
  it('"is" keeps only matching events', () => {
    expect(matchesEventFilter(meeting, { field: 'type', operator: 'is', value: 'meeting' })).toBe(true);
    expect(matchesEventFilter(call, { field: 'type', operator: 'is', value: 'meeting' })).toBe(false);
  });

  it('"is not" (the operator FilterPills emits) excludes matching events', () => {
    const f = { field: 'type', operator: 'is not', value: 'meeting' };
    expect(matchesEventFilter(meeting, f)).toBe(false);
    expect(matchesEventFilter(call, f)).toBe(true);
  });

  it('"is_not" is treated the same way', () => {
    expect(matchesEventFilter(meeting, { field: 'calendar', operator: 'is_not', value: 'cal_1' })).toBe(false);
    expect(matchesEventFilter(call, { field: 'calendar', operator: 'is_not', value: 'cal_1' })).toBe(true);
  });

  it('compares allDay as a string and treats a missing allDay as false', () => {
    const noAllDay: CalendarEvent = { ...meeting, allDay: undefined };
    expect(matchesEventFilter(noAllDay, { field: 'allDay', operator: 'is', value: 'false' })).toBe(true);
    expect(matchesEventFilter(call, { field: 'allDay', operator: 'is', value: 'true' })).toBe(true);
    expect(matchesEventFilter(call, { field: 'allDay', operator: 'is not', value: 'true' })).toBe(false);
  });

  it('lets incomplete filters and unknown fields through', () => {
    expect(matchesEventFilter(meeting, { field: 'type', operator: 'is not', value: '' })).toBe(true);
    expect(matchesEventFilter(meeting, { field: 'nope', operator: 'is', value: 'x' })).toBe(true);
  });
});

describe('applyEventFilters', () => {
  it('returns the same array when there are no filters', () => {
    const events = [meeting, call];
    expect(applyEventFilters(events, [])).toBe(events);
  });

  it('requires every filter to match', () => {
    const out = applyEventFilters(
      [meeting, call],
      [
        { field: 'type', operator: 'is not', value: 'call' },
        { field: 'calendar', operator: 'is', value: 'cal_1' },
      ],
    );
    expect(out.map((e) => e.id)).toEqual(['e1']);
  });
});

describe('matchesEventSearch', () => {
  it('matches title, attendees and tags case-insensitively', () => {
    const evt: CalendarEvent = {
      ...meeting,
      attendees: [{ email: 'Ada@Example.com', name: 'Ada' }],
      tags: ['Quarterly'],
    };
    expect(matchesEventSearch(evt, 'plan')).toBe(true);
    expect(matchesEventSearch(evt, 'ada@example')).toBe(true);
    expect(matchesEventSearch(evt, 'QUARTER')).toBe(true);
    expect(matchesEventSearch(evt, 'zzz')).toBe(false);
    expect(matchesEventSearch(evt, '   ')).toBe(true);
  });
});

describe('mergeSearchResults', () => {
  const now = new Date('2026-10-10T00:00:00Z').getTime();
  const at = (id: string, iso: string): CalendarEvent => ({ ...meeting, id, startTime: iso });

  it('dedupes by id, upcoming first (soonest) then past (newest first)', () => {
    const out = mergeSearchResults(
      [at('a', '2026-09-01T09:00:00Z'), at('b', '2026-11-01T09:00:00Z'), at('c', '2026-10-20T09:00:00Z')],
      [at('c', '2026-10-20T09:00:00Z'), at('d', '2026-10-01T09:00:00Z')],
      now,
    );
    expect(out.map((e) => e.id)).toEqual(['c', 'b', 'd', 'a']);
  });
});
