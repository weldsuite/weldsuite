import type { AgencyPeriods, PeriodRow, PeriodState } from '@/lib/api/domains/weldbooks-sales-tax-center';

/** `attention` is the periods that are due or overdue: what still needs a return. */
export type PeriodStatusFilter = 'all' | 'attention' | PeriodState;

export const PERIOD_STATUS_FILTERS: readonly PeriodStatusFilter[] = [
  'all',
  'attention',
  'overdue',
  'due',
  'in_progress',
  'upcoming',
  'filed',
  'paid',
];

export function periodMatchesStatus(period: Pick<PeriodRow, 'state'>, filter: PeriodStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return period.state === 'due' || period.state === 'overdue';
  return period.state === filter;
}

export interface PeriodFilters {
  /** `all`, or one agency's id. */
  agencyId: string;
  status: PeriodStatusFilter;
}

/** The agencies with the periods that pass the filters, newest period first; an agency without any left is dropped. */
export function filterAgencyPeriods(agencies: readonly AgencyPeriods[], filters: PeriodFilters): AgencyPeriods[] {
  return agencies
    .filter((agency) => filters.agencyId === 'all' || agency.agencyId === filters.agencyId)
    .map((agency) => ({
      ...agency,
      periods: agency.periods
        .filter((period) => periodMatchesStatus(period, filters.status))
        .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)),
    }))
    .filter((agency) => agency.periods.length > 0 || filters.status === 'all');
}
