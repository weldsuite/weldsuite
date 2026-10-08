/**
 * The tax due-date calendar of a US entity (docs/plans/weldbooks-us.md §5, phase
 * 8): income tax returns and extensions, estimated tax, 1099s, payroll
 * deadlines (informational) and the sales tax returns of every agency, from the
 * domain's `taxCalendar`, merged with what the user marked done and with the
 * state of the sales tax returns.
 *
 * What the calendar knows about the entity: its return form (entity type and
 * tax classification), fiscal year, payroll (imports or activity on payroll
 * accounts), 1099 vendors, backup withholding and agencies.
 */

import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { taxFormForEntity } from '@weldsuite/books-domain/jurisdictions/us/entity-types';
import { fiscalYearConfigOf } from '@weldsuite/books-domain/us-compliance/fiscal-year';
import {
  taxCalendar,
  type SalesTaxAgencyInput,
  type TaxCalendarEntity,
  type TaxDeadline,
} from '@weldsuite/books-domain/us-compliance/tax-calendar';
import { diffDays } from '@weldsuite/books-domain/us-compliance/dates';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { FILED_STATUSES, todayIn, type AgencyRow, type EntityRow } from './sales-tax-returns/common';
import { agencyToInput } from './sales-tax-returns/periods';
import { loadAgencies } from './sales-tax-returns/context';

const PAYROLL_ROLES = ['payroll_wages_expense', 'payroll_tax_expense', 'payroll_liabilities'];

export interface CalendarItem extends TaxDeadline {
  completed: boolean;
  completedAt: string | null;
  completedBy: string | null;
  completionNotes: string | null;
  /** `manual`: marked done by a user. `return`: the sales tax return is filed. */
  completionSource: 'manual' | 'return' | null;
  /** Sales tax deadlines: the return of the period, when one exists. */
  returnId: string | null;
  returnStatus: string | null;
  daysUntilDue: number;
  overdue: boolean;
}

export interface EntityCalendar {
  /** False for entities outside the US (the calendar knows US filings only). */
  supported: boolean;
  year: number;
  today: string;
  /** Income tax return form of the entity (`sch_c`, `f1065`, `f1120s`, `f1120`, `f990`). */
  form: string | null;
  facts: { hasPayroll: boolean; files1099: boolean; hasBackupWithholding: boolean; agencies: number } | null;
  items: CalendarItem[];
  message?: string;
}

export async function hasPayroll(db: Database, entityId: string): Promise<boolean> {
  const [imported] = await db
    .select({ id: schema.payrollImports.id })
    .from(schema.payrollImports)
    .where(and(eq(schema.payrollImports.entityId, entityId), eq(schema.payrollImports.status, 'posted')))
    .limit(1);
  if (imported) return true;
  const accounts = await db
    .select({ id: schema.accounts.id, metadata: schema.accounts.metadata, balance: schema.accounts.currentBalance })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.entityId, entityId), isNull(schema.accounts.deletedAt)));
  const payroll = accounts.filter((a) => PAYROLL_ROLES.includes((a.metadata as { systemRole?: string } | null)?.systemRole ?? ''));
  if (payroll.some((a) => Number(a.balance ?? 0) !== 0)) return true;
  if (payroll.length === 0) return false;
  const [line] = await db
    .select({ id: schema.journalLines.id })
    .from(schema.journalLines)
    .where(and(inArray(schema.journalLines.accountId, payroll.map((a) => a.id)), isNull(schema.journalLines.deletedAt)))
    .limit(1);
  return Boolean(line);
}

async function files1099(db: Database): Promise<boolean> {
  const [vendor] = await db
    .select({ id: schema.parties.id })
    .from(schema.parties)
    .where(and(eq(schema.parties.is1099Vendor, true), isNull(schema.parties.deletedAt)))
    .limit(1);
  return Boolean(vendor);
}

async function hasBackupWithholding(db: Database, entityId: string, year: number): Promise<boolean> {
  const [payment] = await db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.entityId, entityId),
        isNull(schema.payments.deletedAt),
        sql`coalesce(${schema.payments.backupWithholdingAmount}, 0) > 0`,
        gte(schema.payments.date, new Date(`${year - 1}-01-01T00:00:00Z`)),
        lte(schema.payments.date, new Date(`${year}-12-31T23:59:59Z`)),
      ),
    )
    .limit(1);
  return Boolean(payment);
}

function agencyInputs(agencies: AgencyRow[]): SalesTaxAgencyInput[] {
  return agencies.map((a) => ({ ...agencyToInput(a), status: a.status }));
}

export async function entityCalendar(db: Database, entity: EntityRow, year: number, now: Date = new Date()): Promise<EntityCalendar> {
  const today = todayIn(entity.timezone, now);
  if (entity.jurisdictionCode !== 'US') {
    return {
      supported: false,
      year,
      today,
      form: null,
      facts: null,
      items: [],
      message: 'The tax calendar covers US filings only; this accounting entity is outside the US.',
    };
  }

  const [payroll, vendors1099, backup, agencies] = await Promise.all([
    hasPayroll(db, entity.id),
    files1099(db),
    hasBackupWithholding(db, entity.id, year),
    loadAgencies(db, entity.id),
  ]);
  const form = taxFormForEntity(entity.entityType, entity.taxClassification);
  const calendarEntity: TaxCalendarEntity = {
    form,
    fiscalYear: fiscalYearConfigOf(entity),
    hasPayroll: payroll,
    files1099: vendors1099,
    hasBackupWithholding: backup,
  };
  const deadlines = taxCalendar(calendarEntity, year, { agencies: agencyInputs(agencies) });

  const completions = await db
    .select()
    .from(schema.taxCalendarCompletions)
    .where(eq(schema.taxCalendarCompletions.entityId, entity.id));
  const done = new Map(completions.map((c) => [c.deadlineKey, c]));

  const salesTax = deadlines.filter((d) => d.kind === 'sales_tax');
  const returns = salesTax.length
    ? await db
        .select()
        .from(schema.taxReturns)
        .where(
          and(
            eq(schema.taxReturns.entityId, entity.id),
            isNull(schema.taxReturns.deletedAt),
            isNull(schema.taxReturns.amendsReturnId),
            inArray(schema.taxReturns.agencyId, [...new Set(salesTax.map((d) => d.agencyId ?? ''))]),
          ),
        )
    : [];
  const returnByKey = new Map(returns.map((r) => [`sales_tax:${r.agencyId}:${r.periodEnd}`, r]));

  const items: CalendarItem[] = deadlines.map((d) => {
    const manual = done.get(d.key);
    const ret = returnByKey.get(d.key);
    const filed = ret && FILED_STATUSES.includes(ret.status);
    const completed = Boolean(manual) || Boolean(filed);
    return {
      ...d,
      completed,
      completedAt: manual ? manual.createdAt.toISOString() : filed && ret?.filedAt ? ret.filedAt.toISOString() : null,
      completedBy: manual ? manual.completedBy : filed ? (ret?.filedBy ?? null) : null,
      completionNotes: manual?.notes ?? null,
      completionSource: manual ? 'manual' : filed ? 'return' : null,
      returnId: ret?.id ?? null,
      returnStatus: ret?.status ?? null,
      daysUntilDue: diffDays(today, d.dueDate),
      overdue: !completed && !d.informational && d.dueDate < today,
    };
  });
  return {
    supported: true,
    year,
    today,
    form,
    facts: { hasPayroll: payroll, files1099: vendors1099, hasBackupWithholding: backup, agencies: agencies.length },
    items,
  };
}

export async function completeDeadline(
  db: Database,
  args: { entityId: string; deadlineKey: string; dueDate: string; notes?: string | null; userId: string | null },
): Promise<typeof schema.taxCalendarCompletions.$inferSelect> {
  const t = schema.taxCalendarCompletions;
  await db
    .insert(t)
    .values({
      id: generateId('tcc'),
      entityId: args.entityId,
      deadlineKey: args.deadlineKey,
      dueDate: args.dueDate,
      completedBy: args.userId,
      notes: args.notes ?? null,
    })
    .onConflictDoUpdate({
      target: [t.entityId, t.deadlineKey],
      set: { dueDate: args.dueDate, completedBy: args.userId, notes: args.notes ?? null },
    });
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.entityId, args.entityId), eq(t.deadlineKey, args.deadlineKey)))
    .limit(1);
  return row!;
}

export async function uncompleteDeadline(db: Database, entityId: string, deadlineKey: string): Promise<boolean> {
  const t = schema.taxCalendarCompletions;
  const removed = await db
    .delete(t)
    .where(and(eq(t.entityId, entityId), eq(t.deadlineKey, deadlineKey)))
    .returning({ id: t.id });
  return removed.length > 0;
}
