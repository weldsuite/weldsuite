import { describe, expect, it } from 'vitest';
import { parseEventLink } from './event-link';

describe('parseEventLink', () => {
  it('reads the day as a local date and keeps the event id', () => {
    const link = parseEventLink('2026-11-18', 'evt_1');
    expect(link.eventId).toBe('evt_1');
    expect(link.date?.getFullYear()).toBe(2026);
    expect(link.date?.getMonth()).toBe(10);
    expect(link.date?.getDate()).toBe(18);
    expect(link.date?.getHours()).toBe(0);
  });

  it('gives no date for a missing or impossible day', () => {
    expect(parseEventLink(null, 'evt_1').date).toBeNull();
    expect(parseEventLink('2026-02-31', null).date).toBeNull();
    expect(parseEventLink('tomorrow', null)).toEqual({ date: null, eventId: null });
  });
});
