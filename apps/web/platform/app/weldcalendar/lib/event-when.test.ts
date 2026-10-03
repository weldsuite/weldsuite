import { describe, it, expect, vi } from 'vitest';

vi.mock('@/hooks/queries/use-settings-queries', () => ({ useUserPreferences: () => ({ data: undefined }) }));

import { formatEventWhen } from './event-when';

describe('formatEventWhen', () => {
  it('uses the 12h clock', () => {
    expect(
      formatEventWhen({ startTime: '2026-10-05T18:00:00', endTime: '2026-10-05T19:30:00' }, '12h'),
    ).toBe('Mon, Oct 5 · 6:00 PM – 7:30 PM');
  });

  it('uses the 24h clock', () => {
    expect(
      formatEventWhen({ startTime: '2026-10-05T18:00:00', endTime: '2026-10-05T19:30:00' }, '24h'),
    ).toBe('Mon, Oct 5 · 18:00 – 19:30');
  });

  it('shows only the start when there is no end, or the end is not after the start', () => {
    expect(formatEventWhen({ startTime: '2026-10-05T09:00:00' }, '24h')).toBe('Mon, Oct 5 · 09:00');
    expect(
      formatEventWhen({ startTime: '2026-10-05T09:00:00', endTime: '2026-10-05T08:00:00' }, '24h'),
    ).toBe('Mon, Oct 5 · 09:00');
  });

  it('names the end day when the event runs past midnight', () => {
    expect(
      formatEventWhen({ startTime: '2026-10-05T23:00:00', endTime: '2026-10-06T01:00:00' }, '24h'),
    ).toBe('Mon, Oct 5 · 23:00 – Tue, Oct 6 · 01:00');
  });

  it('formats all-day events as dates', () => {
    expect(formatEventWhen({ startTime: '2026-10-05T00:00:00', allDay: true }, '12h')).toBe('Monday, October 5');
    expect(
      formatEventWhen({ startTime: '2026-10-05T00:00:00', endTime: '2026-10-07T23:59:59', allDay: true }, '12h'),
    ).toBe('Mon, Oct 5 – Wed, Oct 7');
  });
});
