import {
  addMonths,
  buildMonthMatrix,
  dayKey,
  formatDuration,
  formatEventTimeRange,
  groupByDay,
  isOngoing,
  isPastEvent,
  isSameDay,
  relativeDayLabel,
  weekdayInitials,
} from '@/lib/date';

/** Local-time ISO, so the assertions do not move with the runner's zone. */
function local(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

describe('buildMonthMatrix', () => {
  it('always returns six Monday-first weeks', () => {
    for (const month of [new Date(2026, 1, 1), new Date(2026, 7, 15), new Date(2027, 0, 31)]) {
      const weeks = buildMonthMatrix(month);
      expect(weeks).toHaveLength(6);
      for (const week of weeks) expect(week).toHaveLength(7);
      // getDay() 1 === Monday.
      expect(weeks[0][0].getDay()).toBe(1);
    }
  });

  it('starts on the Monday on or before the 1st', () => {
    // 1 Aug 2026 is a Saturday, so the grid opens on Monday 27 July.
    const weeks = buildMonthMatrix(new Date(2026, 7, 1));
    expect(weeks[0][0].getDate()).toBe(27);
    expect(weeks[0][0].getMonth()).toBe(6);
  });

  it('covers the whole month', () => {
    const weeks = buildMonthMatrix(new Date(2026, 1, 1));
    const flat = weeks.flat();
    const februaryDays = flat.filter((d) => d.getMonth() === 1).map((d) => d.getDate());
    expect(februaryDays).toContain(1);
    expect(februaryDays).toContain(28);
  });
});

describe('addMonths', () => {
  it('clamps rather than rolling over a short month', () => {
    const result = addMonths(new Date(2026, 0, 31), 1);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(28);
  });

  it('steps backwards across a year boundary', () => {
    const result = addMonths(new Date(2026, 0, 15), -1);
    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(11);
    expect(result.getDate()).toBe(15);
  });
});

describe('weekdayInitials', () => {
  it('returns seven labels starting at Monday', () => {
    const labels = weekdayInitials('en-GB');
    expect(labels).toHaveLength(7);
    expect(labels[0]).toBe('M');
  });
});

describe('dayKey', () => {
  it('formats local YYYY-MM-DD and pads', () => {
    expect(dayKey(local(2026, 3, 7, 14, 30))).toBe('2026-03-07');
  });

  it('returns an empty string for missing or unparseable values', () => {
    expect(dayKey(null)).toBe('');
    expect(dayKey('not a date')).toBe('');
  });
});

describe('formatEventTimeRange', () => {
  const options = { allDayLabel: 'All day', locale: 'en-GB' };

  it('joins start and end for a same-day event', () => {
    const result = formatEventTimeRange(
      local(2026, 3, 7, 9, 0),
      local(2026, 3, 7, 10, 30),
      options,
    );
    expect(result).toBe('09:00 – 10:30');
  });

  it('shows just the start when the event is open-ended', () => {
    expect(formatEventTimeRange(local(2026, 3, 7, 9, 0), null, options)).toBe('09:00');
  });

  it('uses the all-day label instead of times', () => {
    const result = formatEventTimeRange(local(2026, 3, 7), local(2026, 3, 7, 23, 59), {
      ...options,
      allDay: true,
    });
    expect(result).toBe('All day');
  });

  it('spells out the dates for a multi-day all-day event', () => {
    const result = formatEventTimeRange(local(2026, 3, 7), local(2026, 3, 9, 23, 59), {
      ...options,
      allDay: true,
    });
    expect(result).toContain('All day');
    expect(result).toContain('7 Mar');
    expect(result).toContain('9 Mar');
  });
});

describe('formatDuration', () => {
  it('renders hours and minutes', () => {
    expect(formatDuration(local(2026, 3, 7, 9, 0), local(2026, 3, 7, 10, 30))).toBe('1h 30m');
    expect(formatDuration(local(2026, 3, 7, 9, 0), local(2026, 3, 7, 9, 45))).toBe('45m');
    expect(formatDuration(local(2026, 3, 7, 9, 0), local(2026, 3, 7, 11, 0))).toBe('2h');
  });

  it('is empty when there is nothing to measure', () => {
    expect(formatDuration(local(2026, 3, 7, 9, 0), null)).toBe('');
    expect(formatDuration(local(2026, 3, 7, 9, 0), local(2026, 3, 7, 9, 0))).toBe('');
  });
});

describe('isPastEvent and isOngoing', () => {
  it('measures against the end when there is one', () => {
    const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(isPastEvent(start, end)).toBe(false);
    expect(isOngoing(start, end)).toBe(true);
  });

  it('treats an open-ended event as live for an hour', () => {
    const justStarted = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const longGone = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    expect(isOngoing(justStarted, null)).toBe(true);
    expect(isOngoing(longGone, null)).toBe(false);
    expect(isPastEvent(longGone, null)).toBe(true);
  });
});

describe('relativeDayLabel', () => {
  const labels = { today: 'Today', tomorrow: 'Tomorrow', yesterday: 'Yesterday' };

  it('names today, tomorrow and yesterday', () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    expect(relativeDayLabel(now, labels)).toBe('Today');
    expect(relativeDayLabel(tomorrow, labels)).toBe('Tomorrow');
    expect(relativeDayLabel(yesterday, labels)).toBe('Yesterday');
  });

  it('falls back to a weekday and date for anything further out', () => {
    const later = new Date();
    later.setDate(later.getDate() + 9);
    expect(relativeDayLabel(later, labels)).not.toBe('Today');
  });
});

describe('groupByDay', () => {
  it('buckets by local day and sorts within each bucket', () => {
    const items = [
      { id: 'b', startTime: local(2026, 3, 7, 14, 0) },
      { id: 'c', startTime: local(2026, 3, 8, 9, 0) },
      { id: 'a', startTime: local(2026, 3, 7, 9, 0) },
    ];
    const sections = groupByDay(items, (item) => item.startTime);

    expect(sections.map((s) => s.key)).toEqual(['2026-03-07', '2026-03-08']);
    expect(sections[0].data.map((i) => i.id)).toEqual(['a', 'b']);
    expect(isSameDay(sections[0].date, new Date(2026, 2, 7))).toBe(true);
  });

  it('drops rows with no usable start rather than throwing', () => {
    const sections = groupByDay(
      [{ id: 'a', startTime: null }, { id: 'b', startTime: local(2026, 3, 7, 9, 0) }],
      (item) => item.startTime,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].data.map((i) => i.id)).toEqual(['b']);
  });
});
