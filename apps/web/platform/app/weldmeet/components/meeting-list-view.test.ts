import { describe, expect, it } from 'vitest';
import { isListedAsUpcoming } from './meeting-list-view';

const now = new Date('2026-11-17T12:00:00Z');

describe('isListedAsUpcoming', () => {
  it('lists running meetings and scheduled ones that have not ended', () => {
    expect(isListedAsUpcoming({ status: 'in_progress' }, now)).toBe(true);
    expect(isListedAsUpcoming({ status: 'scheduled', scheduledStart: '2026-11-18T04:00:00Z' }, now)).toBe(true);
    expect(isListedAsUpcoming({ status: 'scheduled', scheduledStart: null }, now)).toBe(true);
  });

  it('puts a scheduled meeting whose time has passed in History', () => {
    expect(
      isListedAsUpcoming({ status: 'scheduled', scheduledStart: '2026-11-16T09:00:00Z', scheduledEnd: '2026-11-16T10:00:00Z' }, now),
    ).toBe(false);
    // Without an end it counts for an hour after the start.
    expect(isListedAsUpcoming({ status: 'scheduled', scheduledStart: '2026-11-17T11:30:00Z' }, now)).toBe(true);
    expect(isListedAsUpcoming({ status: 'scheduled', scheduledStart: '2026-11-17T10:30:00Z' }, now)).toBe(false);
  });

  it('puts finished and cancelled meetings in History', () => {
    expect(isListedAsUpcoming({ status: 'completed' }, now)).toBe(false);
    expect(isListedAsUpcoming({ status: 'cancelled', scheduledStart: '2026-11-18T04:00:00Z' }, now)).toBe(false);
  });
});
