/**
 * app-api stores an issue or due date as midnight UTC. Read in the device's own
 * time zone that is the evening before for everyone west of UTC, which is every
 * US user: invoices would show the wrong day and "due today" would read as
 * "overdue".
 *
 * jest.global-setup.js runs the suite in US Pacific time (override with
 * TEST_TZ); the first test fails if that is not in effect, so the rest can't
 * silently pass in a zone where the bug can't show.
 */

import { daysUntil, formatDate, formatShortDate, isOverdue, today, toDateInput } from '@/lib/date';

describe('dates west of UTC', () => {
  it('runs in a zone behind UTC', () => {
    // Pacific is UTC-8 (PST) or UTC-7 (PDT): a positive offset in minutes.
    expect(new Date('2026-08-05T12:00:00Z').getTimezoneOffset()).toBeGreaterThan(0);
  });

  it('reads midnight UTC as the evening before in local time (the problem)', () => {
    expect(new Date('2026-08-05T00:00:00.000Z').getDate()).toBe(4);
  });

  it('shows a UTC-midnight date on the day it was written', () => {
    expect(formatDate('2026-08-05T00:00:00.000Z', 'en-US')).toBe('08/05/2026');
    expect(formatDate('2026-08-05T00:00:00.000Z', 'en-GB')).toBe('5 Aug 2026');
    expect(formatShortDate('2026-01-01T00:00:00.000Z', 'en-US')).toBe('01/01');
    expect(formatDate('2026-12-31T00:00:00.000Z', 'en-US')).toBe('12/31/2026');
    expect(formatDate('2026-08-05T00:00:00Z', 'en-US')).toBe('08/05/2026');
    expect(formatDate('2026-08-05', 'en-US')).toBe('08/05/2026');
  });

  it('counts due dates from the day they were written', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 5, 12, 0, 0)); // noon on 5 Aug, local time
    try {
      expect(daysUntil('2026-08-05T00:00:00.000Z')).toBe(0);
      expect(daysUntil('2026-08-06T00:00:00.000Z')).toBe(1);
      expect(daysUntil('2026-08-04T00:00:00.000Z')).toBe(-1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not call an invoice due today overdue', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 5, 9, 0, 0));
    try {
      expect(isOverdue('2026-08-05T00:00:00.000Z', 100)).toBe(false);
      expect(isOverdue('2026-08-04T00:00:00.000Z', 100)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("uses the device's own calendar day for today, late in the evening too", () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 5, 23, 30, 0)); // 11:30 pm on 5 Aug, local time
    try {
      expect(today()).toBe('2026-08-05');
      expect(toDateInput(new Date(2026, 7, 5, 23, 30, 0))).toBe('2026-08-05');
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats a real instant as the local day it happened on', () => {
    // 3 am UTC on the 6th is 8 pm on the 5th in Pacific time.
    expect(formatDate('2026-08-06T03:00:00.000Z', 'en-US')).toBe('08/05/2026');
  });
});
