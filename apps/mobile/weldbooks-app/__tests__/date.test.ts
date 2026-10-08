import {
  formatDate,
  formatShortDate,
  toDateInput,
  addDays,
  daysUntil,
  isOverdue,
  currentMonthRange,
  currentYearRange,
  dateInputPlaceholder,
  formatDateInput,
  parseDateInput,
} from '@/lib/date';

describe('formatDate', () => {
  it('formats an ISO timestamp in English by default', () => {
    expect(formatDate('2026-08-05T10:30:00.000Z')).toBe('5 Aug 2026');
  });

  it('follows the locale passed from the user profile language', () => {
    expect(formatDate('2026-08-05T10:30:00.000Z', 'nl-NL')).toMatch(/aug/i);
  });

  it('returns an em dash for missing or malformed values instead of "Invalid Date"', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });
});

describe('formatShortDate', () => {
  it('drops the year', () => {
    expect(formatShortDate('2026-08-05T00:00:00.000Z')).toBe('5 Aug');
  });
});

describe('toDateInput', () => {
  it('produces the YYYY-MM-DD the forms expect', () => {
    expect(toDateInput('2026-08-05T23:00:00.000Z')).toBe('2026-08-05');
    // A Date is read in local time, so one built from local parts reads back the same day in any zone.
    expect(toDateInput(new Date(2026, 0, 9))).toBe('2026-01-09');
  });

  it('returns an empty string for an unusable value', () => {
    expect(toDateInput(null)).toBe('');
    expect(toDateInput('nonsense')).toBe('');
  });
});

describe('addDays', () => {
  it('offsets from the given date', () => {
    expect(addDays(30, new Date(2026, 7, 5, 12))).toBe('2026-09-04');
  });

  it('handles month and year boundaries', () => {
    expect(addDays(1, new Date(2026, 11, 31, 12))).toBe('2027-01-01');
  });
});

describe('daysUntil', () => {
  // Midday timestamps on both sides so the result is the same whatever the
  // runner's timezone — a near-midnight value would land on a different local
  // calendar day east or west of UTC.
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts whole days forward and backward', () => {
    expect(daysUntil('2026-08-10T12:00:00.000Z')).toBe(5);
    expect(daysUntil('2026-08-01T12:00:00.000Z')).toBe(-4);
  });

  it('is 0 for today', () => {
    expect(daysUntil('2026-08-05T12:00:00.000Z')).toBe(0);
  });

  it('returns null when there is no usable date', () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil('rubbish')).toBeNull();
  });
});

describe('isOverdue', () => {
  it('is false once the balance is settled, however old the due date', () => {
    // A paid invoice must never render as overdue.
    expect(isOverdue('2020-01-01T00:00:00.000Z', 0)).toBe(false);
    expect(isOverdue('2020-01-01T00:00:00.000Z', -5)).toBe(false);
  });

  it('is true for a past due date with an open balance', () => {
    expect(isOverdue('2020-01-01T00:00:00.000Z', 100)).toBe(true);
  });

  it('is false for a future due date', () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(isOverdue(future, 100)).toBe(false);
  });

  it('is false when the due date is unusable', () => {
    expect(isOverdue(null, 100)).toBe(false);
  });
});

describe('period ranges', () => {
  it('returns a month range that starts on the 1st and ends on the last day', () => {
    const { from, to } = currentMonthRange();
    expect(from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(new Date(to).getTime()).toBeGreaterThanOrEqual(new Date(from).getTime());
    // The end must still be inside the same month.
    expect(to.slice(0, 7)).toBe(from.slice(0, 7));
  });

  it('returns a full calendar year', () => {
    const { from, to } = currentYearRange();
    expect(from).toMatch(/^\d{4}-01-01$/);
    expect(to).toMatch(/^\d{4}-12-31$/);
    expect(from.slice(0, 4)).toBe(to.slice(0, 4));
  });
});

describe('US dates', () => {
  it('formats US English as MM/DD/YYYY', () => {
    expect(formatDate('2026-08-05T00:00:00.000Z', 'en-US')).toBe('08/05/2026');
    expect(formatDate('2026-12-25', 'en-US')).toBe('12/25/2026');
    expect(formatShortDate('2026-08-05T00:00:00.000Z', 'en-US')).toBe('08/05');
  });

  it('leaves other locales on the day-month-name style', () => {
    expect(formatDate('2026-08-05T00:00:00.000Z', 'en-GB')).toBe('5 Aug 2026');
    expect(formatDate('2026-08-05T00:00:00.000Z', 'nl-NL')).toMatch(/^5 aug/i);
  });
});

describe('calendar dates', () => {
  // app-api stores an issue or due date as midnight UTC. Read in the device's local
  // time that is the evening of the day before anywhere west of UTC, i.e. all of the US.
  it('keeps the written day of a UTC-midnight timestamp, whatever the time zone', () => {
    expect(formatDate('2026-08-05T00:00:00.000Z')).toBe('5 Aug 2026');
    expect(formatDate('2026-08-05T00:00:00Z')).toBe('5 Aug 2026');
    expect(formatDate('2026-08-05')).toBe('5 Aug 2026');
    expect(formatShortDate('2026-01-01T00:00:00.000Z')).toBe('1 Jan');
  });

  it('counts days from the written day of a UTC-midnight due date', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 5, 12));
    try {
      expect(daysUntil('2026-08-05T00:00:00.000Z')).toBe(0);
      expect(daysUntil('2026-08-06T00:00:00.000Z')).toBe(1);
      expect(daysUntil('2026-08-04T00:00:00.000Z')).toBe(-1);
      expect(daysUntil('2026-08-05')).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('typing dates', () => {
  it('shows MM/DD/YYYY as the placeholder for US English and ISO elsewhere', () => {
    expect(dateInputPlaceholder('en-US')).toBe('MM/DD/YYYY');
    expect(dateInputPlaceholder('nl-NL')).toBe('YYYY-MM-DD');
    expect(dateInputPlaceholder('en-GB')).toBe('YYYY-MM-DD');
  });

  it('shows a stored ISO date the way the field expects it', () => {
    expect(formatDateInput('2026-08-05', 'en-US')).toBe('08/05/2026');
    expect(formatDateInput('2026-08-05', 'nl-NL')).toBe('2026-08-05');
  });

  it('parses US input as month first', () => {
    expect(parseDateInput('08/05/2026', 'en-US')).toBe('2026-08-05');
    expect(parseDateInput('8/5/2026', 'en-US')).toBe('2026-08-05');
    expect(parseDateInput('8-5-26', 'en-US')).toBe('2026-08-05');
    expect(parseDateInput('12/31/2026', 'en-US')).toBe('2026-12-31');
  });

  it('parses other locales day first', () => {
    expect(parseDateInput('05-08-2026', 'nl-NL')).toBe('2026-08-05');
    expect(parseDateInput('5/8/2026', 'en-GB')).toBe('2026-08-05');
  });

  it('always accepts ISO', () => {
    expect(parseDateInput('2026-08-05', 'en-US')).toBe('2026-08-05');
    expect(parseDateInput('2026-8-5', 'nl-NL')).toBe('2026-08-05');
  });

  it('rejects what is not a real calendar day', () => {
    expect(parseDateInput('13/01/2026', 'en-US')).toBeNull();
    expect(parseDateInput('02/30/2026', 'en-US')).toBeNull();
    expect(parseDateInput('31-02-2026', 'nl-NL')).toBeNull();
    expect(parseDateInput('2026-13-01', 'en-US')).toBeNull();
    expect(parseDateInput('', 'en-US')).toBeNull();
    expect(parseDateInput('tomorrow', 'en-US')).toBeNull();
  });

  it('accepts a leap day only in a leap year', () => {
    expect(parseDateInput('02/29/2028', 'en-US')).toBe('2028-02-29');
    expect(parseDateInput('02/29/2027', 'en-US')).toBeNull();
  });
});
