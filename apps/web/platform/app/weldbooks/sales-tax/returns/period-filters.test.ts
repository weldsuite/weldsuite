import { describe, expect, it } from 'vitest';
import type { AgencyPeriods, PeriodRow, PeriodState } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { filterAgencyPeriods, periodMatchesStatus } from './period-filters';

function period(periodEnd: string, state: PeriodState): PeriodRow {
  return {
    key: `k-${periodEnd}`,
    agencyId: 'a',
    agencyName: 'Agency',
    stateCode: 'WA',
    periodStart: `${periodEnd.slice(0, 8)}01`,
    periodEnd,
    dueDate: periodEnd,
    nominalDueDate: periodEnd,
    return: null,
    amendments: [],
    state,
    unfiled: state !== 'filed' && state !== 'paid',
    overdue: state === 'overdue',
    daysUntilDue: 0,
  };
}

function agency(id: string, periods: PeriodRow[]): AgencyPeriods {
  return {
    agencyId: id,
    agencyName: `Agency ${id}`,
    stateCode: 'WA',
    status: 'registered',
    filingFrequency: 'monthly',
    dueDay: 20,
    reportingBasis: 'accrual',
    periods,
  };
}

const agencies = [
  agency('a', [
    period('2026-07-31', 'paid'),
    period('2026-08-31', 'overdue'),
    period('2026-09-30', 'due'),
    period('2026-10-31', 'in_progress'),
  ]),
  agency('b', [period('2026-09-30', 'filed')]),
  agency('c', []),
];

describe('periodMatchesStatus', () => {
  it('treats due and overdue periods as needing attention', () => {
    expect(periodMatchesStatus({ state: 'due' }, 'attention')).toBe(true);
    expect(periodMatchesStatus({ state: 'overdue' }, 'attention')).toBe(true);
    expect(periodMatchesStatus({ state: 'in_progress' }, 'attention')).toBe(false);
    expect(periodMatchesStatus({ state: 'paid' }, 'attention')).toBe(false);
  });

  it('matches one state exactly, and everything with all', () => {
    expect(periodMatchesStatus({ state: 'filed' }, 'filed')).toBe(true);
    expect(periodMatchesStatus({ state: 'paid' }, 'filed')).toBe(false);
    expect(periodMatchesStatus({ state: 'paid' }, 'all')).toBe(true);
  });
});

describe('filterAgencyPeriods', () => {
  it('shows the newest period first and keeps an agency without periods when nothing is filtered', () => {
    const result = filterAgencyPeriods(agencies, { agencyId: 'all', status: 'all' });
    expect(result.map((a) => a.agencyId)).toEqual(['a', 'b', 'c']);
    expect(result[0]!.periods.map((p) => p.periodEnd)).toEqual(['2026-10-31', '2026-09-30', '2026-08-31', '2026-07-31']);
  });

  it('narrows to one agency', () => {
    expect(filterAgencyPeriods(agencies, { agencyId: 'b', status: 'all' }).map((a) => a.agencyId)).toEqual(['b']);
  });

  it('keeps only the periods of a status and drops agencies left with none', () => {
    const result = filterAgencyPeriods(agencies, { agencyId: 'all', status: 'attention' });
    expect(result.map((a) => a.agencyId)).toEqual(['a']);
    expect(result[0]!.periods.map((p) => p.state)).toEqual(['due', 'overdue']);
  });

  it('does not change the list it is given', () => {
    const before = agencies[0]!.periods.map((p) => p.periodEnd);
    filterAgencyPeriods(agencies, { agencyId: 'all', status: 'all' });
    expect(agencies[0]!.periods.map((p) => p.periodEnd)).toEqual(before);
  });
});
