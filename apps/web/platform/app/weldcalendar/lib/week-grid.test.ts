import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/use-settings-queries', () => ({ useUserPreferences: () => ({ data: undefined }) }));

import { buildMonthGrid, orderWeekdays } from './week-grid';

describe('buildMonthGrid', () => {
  it('starts rows on Monday by default', () => {
    // October 2026 starts on a Thursday.
    const weeks = buildMonthGrid(new Date(2026, 9, 15));
    expect(weeks[0][0]).toEqual(new Date(2026, 8, 28));
    expect(weeks[0][3]).toEqual(new Date(2026, 9, 1));
    expect(weeks.every((w) => w.length === 7 && w[0].getDay() === 1)).toBe(true);
    expect(weeks).toHaveLength(5);
    expect(weeks[4][6]).toEqual(new Date(2026, 10, 1));
  });

  it('supports a Sunday start', () => {
    const weeks = buildMonthGrid(new Date(2026, 9, 15), { weekStartsOn: 0 });
    expect(weeks[0][0]).toEqual(new Date(2026, 8, 27));
  });

  it('needs six rows when the month spills over', () => {
    // March 2026 starts on a Sunday: Mon-start grid begins 23 Feb and ends 5 Apr.
    expect(buildMonthGrid(new Date(2026, 2, 1))).toHaveLength(6);
  });

  it('pads to minWeeks', () => {
    // February 2027 starts on a Monday and has 28 days: exactly 4 weeks.
    expect(buildMonthGrid(new Date(2027, 1, 1))).toHaveLength(4);
    expect(buildMonthGrid(new Date(2027, 1, 1), { minWeeks: 5 })).toHaveLength(5);
  });
});

describe('orderWeekdays', () => {
  const sundayFirst = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  it('rotates to Monday-first', () => {
    expect(orderWeekdays(sundayFirst)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  });

  it('leaves Sunday-first alone for a Sunday start', () => {
    expect(orderWeekdays(sundayFirst, 0)).toEqual(sundayFirst);
  });
});
