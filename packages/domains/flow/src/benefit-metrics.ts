/**
 * The benefit metric catalogue (FLOW-014): a fixed set of measures, each one
 * read-only aggregate over an indexed month range of other modules' tables in
 * the same tenant database. Writing nothing outside WeldFlow, it is not
 * subject to the rule that writes go through the owning module's domain.
 *
 *   key                            reads                          value (unit)
 *   desk_tickets_by_tag            helpdesk_tickets               tickets created in the month with the tag (tickets)
 *   commerce_repeat_online_share   orders                         share of the month's repeat orders placed online (%)
 *   books_days_to_pay              invoices                       average days from issue to payment of invoices paid in the month (days)
 *   books_supplier_cost            bills                          cost billed by one supplier in the 12 months ending with the month (amount)
 *   time_hours_per_week_by_tag     time_entries + tasks           hours logged on tasks with the tag, per week of the month (hours)
 *   manual                         nothing                        typed in
 *
 * A metric returns the value as the numeric column stores it (text, four
 * decimals for ratios, two for money), or null when the month has nothing to
 * measure (no repeat orders, no paid invoices). Every metric needs a test
 * against the pglite harness (`benefit-metrics.db.test.ts`), so a schema
 * change in another module breaks CI here; the Rust flow-domain runs the same
 * SQL.
 */

import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  BENEFIT_METRICS,
  BENEFIT_METRIC_PARAMS,
  type BenefitMetric,
} from '@weldsuite/app-api-client/schemas/project-governance';

export { BENEFIT_METRICS, type BenefitMetric };

export interface MetricDefinition {
  /** The unit a benefit gets when it has none of its own. */
  unit: string | null;
  /** Whether the monthly sweep measures it (false: typed in). */
  measured: boolean;
}

export const METRIC_CATALOGUE: Readonly<Record<BenefitMetric, MetricDefinition>> = {
  manual: { unit: null, measured: false },
  desk_tickets_by_tag: { unit: 'tickets', measured: true },
  commerce_repeat_online_share: { unit: '%', measured: true },
  books_days_to_pay: { unit: 'days', measured: true },
  books_supplier_cost: { unit: null, measured: true },
  time_hours_per_week_by_tag: { unit: 'hours', measured: true },
};

/** The online sources of orders when a benefit names none (the storefront and the customer portal). */
export const DEFAULT_ONLINE_SOURCES: readonly string[] = ['web', 'b2b_portal'];

/** Bill statuses that count as cost: approved, partly paid and paid. */
export const COST_BILL_STATUSES: readonly string[] = ['approved', 'partial', 'paid'];

export function isMetric(value: string): value is BenefitMetric {
  return (BENEFIT_METRICS as readonly string[]).includes(value);
}

export function metricIsMeasured(metric: string): boolean {
  return isMetric(metric) && METRIC_CATALOGUE[metric].measured;
}

/**
 * The parameters a benefit stores for its metric, checked and cleaned (text is
 * trimmed), or the message of the 400. A metric that is not in the catalogue is
 * the caller's to refuse (the body schema does).
 */
export function metricParamsError(
  metric: string,
  params: Record<string, unknown>,
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  if (!isMetric(metric)) return { ok: false, message: `Unknown metric '${metric}'` };
  const parsed = BENEFIT_METRIC_PARAMS[metric].safeParse(params);
  if (!parsed.success) return { ok: false, message: `Invalid parameters for the '${metric}' metric` };
  return { ok: true, params: parsed.data as Record<string, unknown> };
}

// ── Months ──────────────────────────────────────────────────────────────────

export interface MonthRange {
  period: string;
  /** First instant of the month (UTC). */
  start: Date;
  /** First instant of the next month (UTC). */
  end: Date;
  days: number;
}

/** `2026-10` of a date (UTC). */
export function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month before the one `now` falls in: the month the sweep measures. */
export function previousPeriod(now: Date): string {
  return periodOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

/** The first instant of the month after the one `now` falls in (UTC): when the next measurement is due. */
export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** The range of a `YYYY-MM` month. */
export function monthRange(period: string): MonthRange {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { period, start, end, days: Math.round((end.getTime() - start.getTime()) / 86_400_000) };
}

/** Whether a month lies after the one `now` falls in. */
export function isFuturePeriod(period: string, now: Date): boolean {
  return period > periodOf(now);
}

/** The date of a day as the `date` column compares it: `2026-10-01`. */
function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ── Measuring ───────────────────────────────────────────────────────────────

const { helpdeskTickets, orders, invoices, bills, timeEntries, tasks } = schema;

/** A numeric result as text, or null. */
function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Measure a benefit's metric for a month: one aggregate query. Returns the
 * value as text (the numeric column's form), or null when there is nothing to
 * measure that month, and always null for `manual`.
 */
export async function measureMetric(
  db: Database,
  metric: string,
  params: Record<string, unknown>,
  period: string,
): Promise<string | null> {
  const range = monthRange(period);
  switch (metric) {
    case 'desk_tickets_by_tag': {
      const tag = String(params.tag ?? '');
      const [row] = await db
        .select({ value: sql<string>`count(*)::text` })
        .from(helpdeskTickets)
        .where(
          and(
            isNull(helpdeskTickets.deletedAt),
            gte(helpdeskTickets.createdAt, range.start),
            lt(helpdeskTickets.createdAt, range.end),
            sql`${helpdeskTickets.tags} @> ${JSON.stringify([tag])}::jsonb`,
          ),
        );
      return text(row?.value);
    }
    case 'commerce_repeat_online_share': {
      const sources = Array.isArray(params.sources) && params.sources.length > 0 ? (params.sources as string[]) : [...DEFAULT_ONLINE_SOURCES];
      // A repeat order: its buyer (the counterparty, else the legacy customer) ordered before.
      const earlier = (column: 'counterparty_id' | 'customer_id', value: unknown) =>
        sql`exists (select 1 from orders p where p.${sql.raw(column)} = ${value} and p.created_at < ${orders.createdAt} and p.deleted_at is null and p.status <> 'cancelled')`;
      const [row] = await db
        .select({
          value: sql<string | null>`round(count(*) filter (where ${inArray(orders.source, sources)}) * 100.0 / nullif(count(*), 0), 4)::text`,
        })
        .from(orders)
        .where(
          and(
            isNull(orders.deletedAt),
            ne(orders.status, 'cancelled'),
            gte(orders.createdAt, range.start),
            lt(orders.createdAt, range.end),
            or(
              sql`(${orders.counterpartyId} is not null and ${earlier('counterparty_id', orders.counterpartyId)})`,
              sql`(${orders.counterpartyId} is null and ${orders.customerId} is not null and ${earlier('customer_id', orders.customerId)})`,
            ),
          ),
        );
      return text(row?.value);
    }
    case 'books_days_to_pay': {
      const issuedAfter = new Date(Date.UTC(range.start.getUTCFullYear() - 1, range.start.getUTCMonth(), 1));
      const [row] = await db
        .select({
          value: sql<string | null>`round(avg(extract(epoch from (${invoices.paidAt} - ${invoices.issueDate})) / 86400.0)::numeric, 4)::text`,
        })
        .from(invoices)
        .where(
          and(
            isNull(invoices.deletedAt),
            eq(invoices.type, 'standard'),
            eq(invoices.status, 'paid'),
            gte(invoices.paidAt, range.start),
            lt(invoices.paidAt, range.end),
            gte(invoices.issueDate, issuedAfter),
          ),
        );
      return text(row?.value);
    }
    case 'books_supplier_cost': {
      const supplierId = String(params.supplierId ?? '');
      const from = new Date(Date.UTC(range.end.getUTCFullYear() - 1, range.end.getUTCMonth(), 1));
      const [row] = await db
        .select({ value: sql<string>`round(coalesce(sum(${bills.total}), 0)::numeric, 2)::text` })
        .from(bills)
        .where(
          and(
            isNull(bills.deletedAt),
            eq(bills.type, 'standard'),
            inArray(bills.status, [...COST_BILL_STATUSES]),
            or(eq(bills.contactId, supplierId), eq(bills.counterpartyId, supplierId)),
            gte(bills.issueDate, from),
            lt(bills.issueDate, range.end),
          ),
        );
      return text(row?.value);
    }
    case 'time_hours_per_week_by_tag': {
      const tag = String(params.tag ?? '');
      const [row] = await db
        .select({
          value: sql<string>`round(coalesce(sum(${timeEntries.duration}), 0)::numeric * 7 / (60 * ${range.days}::int), 4)::text`,
        })
        .from(timeEntries)
        .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
        .where(
          and(
            isNull(timeEntries.deletedAt),
            isNull(tasks.deletedAt),
            ne(timeEntries.status, 'rejected'),
            gte(timeEntries.date, dayOf(range.start)),
            lt(timeEntries.date, dayOf(range.end)),
            sql`${tasks.tags} @> ${JSON.stringify([tag])}::jsonb`,
          ),
        );
      return text(row?.value);
    }
    default:
      return null;
  }
}
