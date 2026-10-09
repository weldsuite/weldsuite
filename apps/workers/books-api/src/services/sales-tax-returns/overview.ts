/**
 * The Sales Tax Center's two entry views: periods per agency, and one line per
 * registered agency with what is due next.
 */

import { addMonths } from '@weldsuite/books-domain/us-compliance/dates';
import type { Database } from '@weldsuite/worker-kit/db';
import { FILED_STATUSES, num, todayIn, type AgencyRow, type EntityRow, type ReturnRow } from './common';
import { calculateReturn, reportingBasisOf } from './calculate';
import { loadAgencies } from './context';
import { buildPeriodRows, loadAgencyReturns, type PeriodRow } from './periods';

export interface AgencyPeriods {
  agencyId: string;
  agencyName: string;
  stateCode: string;
  status: string;
  filingFrequency: string;
  dueDay: number;
  reportingBasis: string;
  periods: PeriodRow[];
}

export interface PeriodsQuery {
  agencyId?: string;
  from?: string;
  to?: string;
}

/** Default window: the last twelve months and the next three. */
export function defaultWindow(today: string, query: PeriodsQuery): { from: string; to: string } {
  return { from: query.from ?? addMonths(today, -12), to: query.to ?? addMonths(today, 3) };
}

export async function listPeriods(
  db: Database,
  entity: EntityRow,
  query: PeriodsQuery,
  now: Date = new Date(),
): Promise<{ today: string; from: string; to: string; agencies: AgencyPeriods[] }> {
  const today = todayIn(entity.timezone, now);
  const { from, to } = defaultWindow(today, query);
  const agencies = (await loadAgencies(db, entity.id)).filter(
    (a) => (!query.agencyId || a.id === query.agencyId) && a.status !== 'monitoring',
  );
  const out: AgencyPeriods[] = [];
  for (const agency of agencies) {
    const returns = await loadAgencyReturns(db, entity.id, agency.id);
    out.push({
      agencyId: agency.id,
      agencyName: agency.name,
      stateCode: agency.stateCode,
      status: agency.status,
      filingFrequency: agency.filingFrequency,
      dueDay: agency.dueDay,
      reportingBasis: agency.reportingBasis,
      periods: buildPeriodRows(agency, returns, from, to, today),
    });
  }
  return { today, from, to, agencies: out };
}

export interface AgencyOverview {
  agencyId: string;
  agencyName: string;
  stateCode: string;
  filingFrequency: string;
  reportingBasis: string;
  nextPeriod: {
    periodStart: string;
    periodEnd: string;
    dueDate: string;
    daysUntilDue: number;
    overdue: boolean;
    state: string;
    returnId: string | null;
    returnStatus: string | null;
    /** Tax of the period's ledger rows no return counted yet (sales tax + use tax). */
    estimatedTaxDue: number;
    estimatedSalesTax: number;
    estimatedUseTax: number;
  } | null;
  /** Periods that ended with no filed return and are past their due date. */
  overduePeriods: number;
  lastFiled: {
    returnId: string;
    periodEnd: string;
    filedAt: string | null;
    totalDue: number;
    status: string;
  } | null;
}

export interface SalesTaxOverview {
  today: string;
  agencies: AgencyOverview[];
  totals: { estimatedTaxDue: number; overduePeriods: number; dueWithin14Days: number };
}

/** The earliest period that has started and has no filed return; the next one when all are filed. */
function pickNextPeriod(rows: PeriodRow[], today: string): PeriodRow | undefined {
  const open = rows.filter((p) => !p.return || !FILED_STATUSES.includes(p.return.status));
  return open.find((p) => p.periodStart <= today) ?? open[0];
}

export async function salesTaxOverview(db: Database, entity: EntityRow, now: Date = new Date()): Promise<SalesTaxOverview> {
  const today = todayIn(entity.timezone, now);
  const agencies = (await loadAgencies(db, entity.id)).filter((a) => a.status === 'registered' || a.status === 'pending');
  const rows: AgencyOverview[] = [];

  for (const agency of agencies) {
    const returns = await loadAgencyReturns(db, entity.id, agency.id);
    const start = agency.firstPeriodStart ?? agency.registeredFrom;
    const periods = start ? buildPeriodRows(agency, returns, start, addMonths(today, 13), today) : [];
    const next = pickNextPeriod(periods, today);

    let nextPeriod: AgencyOverview['nextPeriod'] = null;
    if (next) {
      const estimate = await estimatePeriod(db, entity, agency, next, returns, now);
      nextPeriod = {
        periodStart: next.periodStart,
        periodEnd: next.periodEnd,
        dueDate: next.dueDate,
        daysUntilDue: next.daysUntilDue,
        overdue: next.overdue,
        state: next.state,
        returnId: next.return?.id ?? null,
        returnStatus: next.return?.status ?? null,
        ...estimate,
      };
    }
    const filed = returns
      .filter((r) => !r.amendsReturnId && FILED_STATUSES.includes(r.status))
      .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
    rows.push({
      agencyId: agency.id,
      agencyName: agency.name,
      stateCode: agency.stateCode,
      filingFrequency: agency.filingFrequency,
      reportingBasis: agency.reportingBasis,
      nextPeriod,
      overduePeriods: periods.filter((p) => p.overdue).length,
      lastFiled: filed
        ? { returnId: filed.id, periodEnd: filed.periodEnd, filedAt: filed.filedAt?.toISOString() ?? null, totalDue: num(filed.totalDue), status: filed.status }
        : null,
    });
  }

  return {
    today,
    agencies: rows,
    totals: {
      estimatedTaxDue: Math.round(rows.reduce((sum, r) => sum + (r.nextPeriod?.estimatedTaxDue ?? 0), 0) * 100) / 100,
      overduePeriods: rows.reduce((sum, r) => sum + r.overduePeriods, 0),
      dueWithin14Days: rows.filter((r) => r.nextPeriod && !r.nextPeriod.returnStatus?.match(/filed|paid/) && r.nextPeriod.daysUntilDue >= 0 && r.nextPeriod.daysUntilDue <= 14).length,
    },
  };
}

/** What the period's unfiled ledger rows add up to (the calculation of a not-yet-created return). */
async function estimatePeriod(
  db: Database,
  entity: EntityRow,
  agency: AgencyRow,
  period: PeriodRow,
  returns: ReturnRow[],
  now: Date,
): Promise<{ estimatedTaxDue: number; estimatedSalesTax: number; estimatedUseTax: number }> {
  const existing = returns.find((r) => r.id === period.return?.id);
  const ret: ReturnRow =
    existing ??
    ({
      id: 'estimate',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      entityId: entity.id,
      jurisdictionCode: 'US',
      agencyId: agency.id,
      stateCode: agency.stateCode,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      dueDate: period.dueDate,
      status: 'open',
      reportingBasis: reportingBasisOf(agency),
      summary: null,
      lines: null,
      adjustments: null,
      exceptions: null,
      totalDue: '0',
      filedAt: null,
      filedBy: null,
      confirmationNumber: null,
      paidAt: null,
      paymentAmount: null,
      paymentBankAccountId: null,
      paymentJournalEntryId: null,
      amendsReturnId: null,
      notes: null,
    } satisfies ReturnRow);
  const calc = await calculateReturn(db, { entity, agency, ret, now });
  return {
    estimatedTaxDue: calc.summary.totalTaxDue,
    estimatedSalesTax: calc.summary.salesTaxDue,
    estimatedUseTax: calc.summary.useTaxDue,
  };
}
