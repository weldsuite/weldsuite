/**
 * The periods of a fiscal year, from the entity's fiscal year setup.
 *
 * A month-based entity (`fiscalYearStart`, 1 = calendar year) gets its twelve
 * calendar months. A 52-53-week entity (`fiscalYearConfig`) gets twelve 4-4-5
 * week periods: four quarters of 4, 4 and 5 weeks, and in a 53-week year the
 * extra week is in period 12 (6 weeks). Fiscal years are named for the
 * calendar year in which they end; see books-domain `us-compliance/fiscal-year`.
 */

import {
  fiscalPeriods,
  fiscalYearConfigOf,
  fiscalYearFor,
  type FiscalYearConfig,
} from '@weldsuite/books-domain/us-compliance/fiscal-year';

export type PlannedPeriodType = 'month' | 'period' | 'quarter' | 'year';

export interface PlannedPeriod {
  name: string;
  type: PlannedPeriodType;
  startDate: string;
  endDate: string;
  /** 1-12 for months and periods, 1-4 for quarters, null for the year. */
  number: number | null;
  /** Length in weeks for 4-4-5 periods, null otherwise. */
  weeks: number | null;
}

export interface FiscalCalendar {
  fiscalYear: number;
  startDate: string;
  endDate: string;
  /** `month` or `fifty_two_fifty_three`. */
  kind: FiscalYearConfig['type'];
  /** 52 or 53 for a 52-53-week year, null for a month-based one. */
  weeks: number | null;
  periods: PlannedPeriod[];
}

export interface CalendarOptions {
  includeQuarters?: boolean;
  includeYear?: boolean;
}

export function fiscalCalendarFor(
  entity: Parameters<typeof fiscalYearConfigOf>[0],
  fiscalYear: number,
  options: CalendarOptions = {},
): FiscalCalendar {
  const config = fiscalYearConfigOf(entity);
  const year = fiscalYearFor(config, fiscalYear);
  const periods = fiscalPeriods(config, fiscalYear);
  const calendarYear = config.type === 'month' && config.startMonth === 1;
  const label = calendarYear ? String(year.year) : `FY${year.year}`;
  const weekBased = config.type === 'fifty_two_fifty_three';

  const planned: PlannedPeriod[] = periods.map((period) => ({
    name: weekBased ? `${label} P${String(period.number).padStart(2, '0')}` : period.start.slice(0, 7),
    type: weekBased ? 'period' : 'month',
    startDate: period.start,
    endDate: period.end,
    number: period.number,
    weeks: period.weeks,
  }));

  if (options.includeQuarters) {
    for (let quarter = 1; quarter <= 4; quarter++) {
      const inQuarter = periods.filter((period) => period.quarter === quarter);
      planned.push({
        name: `${label} Q${quarter}`,
        type: 'quarter',
        startDate: inQuarter[0]!.start,
        endDate: inQuarter[inQuarter.length - 1]!.end,
        number: quarter,
        weeks: weekBased ? inQuarter.reduce((sum, period) => sum + (period.weeks ?? 0), 0) : null,
      });
    }
  }
  if (options.includeYear) {
    planned.push({ name: label, type: 'year', startDate: year.start, endDate: year.end, number: null, weeks: year.weeks });
  }

  return { fiscalYear: year.year, startDate: year.start, endDate: year.end, kind: config.type, weeks: year.weeks, periods: planned };
}
