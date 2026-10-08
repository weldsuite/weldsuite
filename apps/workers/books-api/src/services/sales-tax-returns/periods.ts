/**
 * Return periods and due dates per sales tax agency.
 *
 * The grid comes from the agency's filing frequency and first period start
 * (`agencyDeadlines` in the domain package: a period ends on the last day of
 * its last month and is due on the agency's due day of the next month, moved to
 * the next business day). Returns already created for a period are matched on
 * the agency and the period end.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  agencyDeadlines,
  type AgencyFilingFrequency,
  type SalesTaxAgencyInput,
} from '@weldsuite/books-domain/us-compliance/tax-calendar';
import { addDays, addMonths, diffDays } from '@weldsuite/books-domain/us-compliance/dates';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { FILED_STATUSES, num, TaxReturnError, type AgencyRow, type ReturnRow } from './common';

const FREQUENCIES: readonly string[] = ['monthly', 'quarterly', 'semiannual', 'annual'];

export interface AgencyPeriod {
  /** The tax calendar key of the deadline (`sales_tax:<agencyId>:<periodEnd>`). */
  key: string;
  agencyId: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  /** The statutory due day before it moves to a business day. */
  nominalDueDate: string;
}

export function agencyToInput(agency: AgencyRow): SalesTaxAgencyInput {
  return {
    id: agency.id,
    name: agency.name,
    stateCode: agency.stateCode,
    filingFrequency: (FREQUENCIES.includes(agency.filingFrequency) ? agency.filingFrequency : 'quarterly') as AgencyFilingFrequency,
    dueDay: Math.min(Math.max(agency.dueDay || 20, 1), 31),
    firstPeriodStart: agency.firstPeriodStart ?? agency.registeredFrom,
    registeredUntil: agency.registeredUntil,
    // The grid ignores the status; callers decide which agencies they want.
    status: 'registered',
  };
}

/** The agency's periods whose last day falls in `[from, to]`, oldest first. */
export function agencyPeriods(agency: AgencyRow, from: string, to: string): AgencyPeriod[] {
  if (to < from) return [];
  // A due date comes at most about 40 days after its period ends.
  const deadlines = agencyDeadlines([agencyToInput(agency)], from, addDays(to, 45));
  return deadlines
    .filter((d) => d.periodStart && d.periodEnd && d.periodEnd >= from && d.periodEnd <= to)
    .map((d) => ({
      key: d.key,
      agencyId: agency.id,
      periodStart: d.periodStart as string,
      periodEnd: d.periodEnd as string,
      dueDate: d.dueDate,
      nominalDueDate: d.nominalDate,
    }))
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

/** The grid period with exactly these dates, or undefined. */
export function matchPeriod(agency: AgencyRow, periodStart: string, periodEnd: string): AgencyPeriod | undefined {
  const found = agencyPeriods(agency, periodEnd, periodEnd).find((p) => p.periodEnd === periodEnd);
  if (found && found.periodStart === periodStart) return found;
  // A closed agency's final return stops at the registration end.
  if (agency.registeredUntil && periodEnd === agency.registeredUntil) {
    const containing = agencyPeriods(agency, periodStart, addMonths(periodEnd, 13)).find(
      (p) => p.periodStart === periodStart && p.periodEnd >= periodEnd,
    );
    if (containing) return { ...containing, periodEnd, key: `sales_tax:${agency.id}:${periodEnd}` };
  }
  return undefined;
}

export type PeriodState = 'upcoming' | 'in_progress' | 'due' | 'overdue' | 'filed' | 'paid';

export interface PeriodReturnSummary {
  id: string;
  status: string;
  totalDue: number;
  filedAt: string | null;
  paidAt: string | null;
  confirmationNumber: string | null;
}

export interface PeriodRow extends AgencyPeriod {
  agencyName: string;
  stateCode: string;
  /** The period's own return (not an amendment), if one was created. */
  return: PeriodReturnSummary | null;
  /** Returns amending it, newest first. */
  amendments: PeriodReturnSummary[];
  state: PeriodState;
  /** The period has ended and no return is filed for it. */
  unfiled: boolean;
  /** Unfiled and past its due date. */
  overdue: boolean;
  /** Days until the due date (negative once past). */
  daysUntilDue: number;
}

function summarize(row: ReturnRow): PeriodReturnSummary {
  return {
    id: row.id,
    status: row.status,
    totalDue: num(row.totalDue),
    filedAt: row.filedAt ? row.filedAt.toISOString() : null,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    confirmationNumber: row.confirmationNumber,
  };
}

export function periodState(args: {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  today: string;
  returnStatus?: string | null;
}): PeriodState {
  if (args.returnStatus === 'paid') return 'paid';
  if (args.returnStatus === 'filed') return 'filed';
  if (args.periodEnd >= args.today) return args.periodStart > args.today ? 'upcoming' : 'in_progress';
  return args.dueDate < args.today ? 'overdue' : 'due';
}

/** Non-deleted returns of an agency (amendments included), newest period first. */
export async function loadAgencyReturns(db: Database, entityId: string, agencyId: string): Promise<ReturnRow[]> {
  return db
    .select()
    .from(schema.taxReturns)
    .where(
      and(
        eq(schema.taxReturns.entityId, entityId),
        eq(schema.taxReturns.agencyId, agencyId),
        isNull(schema.taxReturns.deletedAt),
      ),
    )
    .orderBy(desc(schema.taxReturns.periodEnd), desc(schema.taxReturns.createdAt));
}

/** Periods of one agency with the state of each, from its returns. */
export function buildPeriodRows(agency: AgencyRow, returns: ReturnRow[], from: string, to: string, today: string): PeriodRow[] {
  return agencyPeriods(agency, from, to).map((period) => {
    const forPeriod = returns.filter((r) => r.periodEnd === period.periodEnd);
    const own = forPeriod.find((r) => !r.amendsReturnId) ?? null;
    const amendments = forPeriod.filter((r) => r.amendsReturnId);
    const filed = own && FILED_STATUSES.includes(own.status);
    const state = periodState({ ...period, today, returnStatus: own?.status });
    const unfiled = period.periodEnd < today && !filed;
    return {
      ...period,
      agencyName: agency.name,
      stateCode: agency.stateCode,
      return: own ? summarize(own) : null,
      amendments: amendments.map(summarize),
      state,
      unfiled,
      overdue: unfiled && period.dueDate < today,
      daysUntilDue: diffDays(today, period.dueDate),
    };
  });
}

/** The first period of an agency without a return of its own that has started by `today`. */
export function nextPeriodToOpen(agency: AgencyRow, returns: ReturnRow[], today: string): AgencyPeriod {
  const start = agency.firstPeriodStart ?? agency.registeredFrom;
  if (!start) {
    throw new TaxReturnError('This agency has no first period start; set it on the agency first');
  }
  const taken = new Set(returns.filter((r) => !r.amendsReturnId).map((r) => r.periodEnd));
  const periods = agencyPeriods(agency, start, addMonths(today, 13));
  const next = periods.find((p) => !taken.has(p.periodEnd) && p.periodStart <= today);
  if (!next) throw new TaxReturnError('Every period of this agency up to today already has a return');
  return next;
}
