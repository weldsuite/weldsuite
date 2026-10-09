/**
 * Accounting reports routes — /api/accounting-reports/* read-only surface.
 *
 * All reports compute from posted journal entries scoped to a single
 * accounting entity, resolved via `resolveEntityId` (X-Accounting-Entity-Id
 * header → `?entityId=` query param → workspace default entity).
 *
 * Query parameters shared by the financial reports:
 *   basis=accrual|cash   Default: the entity's accounting method, then the
 *                        workspace setting, then accrual. Cash basis is
 *                        computed at report time from payments (see
 *                        services/accounting-reports-basis.ts).
 *   from, to / asOf      YYYY-MM-DD. Defaults come from the entity's fiscal
 *                        year (month-based or 52–53 weeks), not 1 January.
 *   compare=prior_period|prior_year   Adds a `prior` column and deltas
 *                        (profit-loss, balance-sheet, trial-balance, cash-flow).
 *   periods=months|quarters           profit-loss only: a column per month or
 *                        quarter plus `total` (not combinable with compare).
 *   classId, locationId  Only journal lines with that dimension.
 *   format=json|csv|print   csv downloads the table; print returns a
 *                        print-ready document (title, entity header, paper,
 *                        table) that the platform renders to PDF.
 *
 * Cash flow keeps its `{ period, monthly, totals }` shape: `monthly` is one
 * row per calendar month of bank activity, `totals` the sum of those rows.
 *
 * Reports are read-only — no mutations, no entity events.
 *
 * Permissions: reports:read.
 */

import { Hono, type Context } from 'hono';
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { taxFormForEntity } from '@weldsuite/books-domain/jurisdictions/us/entity-types';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { resolveEntityId } from '../../lib/entity-context';
import { BOOKED_STATUSES } from '../../services/accounting-posting';
import {
  createLedger,
  parseBasis,
  parseReportDate,
  ReportInputError,
  resolveBasis,
  type ReportBasis,
} from '../../services/accounting-reports-basis';
import {
  buildAgedReport,
  buildBalanceSheet,
  buildExpenseByCategory,
  buildGeneralLedger,
  buildProfitLoss,
  buildRevenueByCustomer,
  buildTrialBalance,
  deltaOf,
  latestDate,
  money,
} from '../../services/accounting-reports';
import {
  fiscalYearContaining,
  fiscalYearNamed,
  parseCompare,
  parsePeriods,
  periodColumns,
  pointInTimeColumns,
  priorPeriodOf,
  priorYearOf,
  requireIsoDate,
  resolvePeriod,
  splitColumns,
  todayFor,
  type DateRange,
} from '../../services/accounting-report-periods';
import {
  agedTable,
  balanceSheetTable,
  buildPrintDocument,
  cashFlowTable,
  csvResponse,
  expenseByCategoryTable,
  generalLedgerTable,
  profitLossTable,
  revenueByCustomerTable,
  toCsv,
  trialBalanceTable,
  type PrintEntity,
  type ReportMeta,
  type ReportTable,
} from '../../services/accounting-report-export';
import { buildTaxWorksheet, taxWorksheetTable } from '../../services/accounting-tax-worksheet';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type EntityRow = typeof schema.entities.$inferSelect;
type Format = 'json' | 'csv' | 'print';

interface ReportContext {
  db: Database;
  entity: EntityRow;
  basis: ReportBasis;
  format: Format;
  filters: { classId: string | null; locationId: string | null };
  query: Record<string, string>;
}

class EntityNotFoundError extends Error {
  constructor(readonly entityId: string) {
    super('Entity not found');
  }
}

async function reportContext(c: Context<{ Bindings: Env; Variables: Variables }>, opts: { basis: boolean }): Promise<ReportContext> {
  const db = c.get('tenantDb');
  const query = c.req.query();
  const entityId = await resolveEntityId(c, db);
  if (!entityId) throw new ReportInputError('No accounting entity resolved');

  const [entity] = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  if (!entity) throw new EntityNotFoundError(entityId);

  const format = query.format ?? 'json';
  if (format !== 'json' && format !== 'csv' && format !== 'print') {
    throw new ReportInputError("format must be 'json', 'csv' or 'print'");
  }

  // Reports that don't depend on the basis (aging, cash flow, tax summary) leave it out of their export.
  const basis = opts.basis ? await resolveBasis(db, entity, parseBasis(query.basis)) : 'accrual';

  return {
    db,
    entity,
    basis,
    format,
    filters: { classId: query.classId || null, locationId: query.locationId || null },
    query,
  };
}

function printEntity(entity: EntityRow): PrintEntity {
  const ids = entity.taxIdentifiers;
  const ein = ids?.einOrSsn && /^\d{2}-\d{7}$/.test(ids.einOrSsn) ? ids.einOrSsn : null;
  return {
    name: entity.name,
    legalName: entity.legalName,
    dba: entity.dba,
    address: entity.address,
    taxId: entity.jurisdictionCode === 'US' ? ein : (ids?.vatNumber ?? ids?.registrationNumber ?? null),
    jurisdictionCode: entity.jurisdictionCode,
    locale: entity.locale,
    timezone: entity.timezone,
  };
}

function respond<T>(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  ctx: ReportContext,
  args: { table: ReportTable; periodLabel: string; filename: string; json: T; showBasis?: boolean },
) {
  if (ctx.format === 'json') return success(c, args.json);
  const meta: ReportMeta = {
    entityName: ctx.entity.name,
    basis: args.showBasis === false ? null : ctx.basis,
    periodLabel: args.periodLabel,
    currency: ctx.entity.baseCurrency,
  };
  if (ctx.format === 'csv') return csvResponse(toCsv(args.table, meta), `${args.filename}.csv`);
  return success(c, buildPrintDocument(args.table, meta, printEntity(ctx.entity)));
}

function failure(c: Context<{ Bindings: Env; Variables: Variables }>, err: unknown, name: string) {
  if (err instanceof ReportInputError) return error.badRequest(c, err.message);
  if (err instanceof EntityNotFoundError) return error.notFound(c, 'Entity', err.entityId);
  console.error(`[books-api/accounting-reports] ${name} failed:`, err);
  return error.internal(c, `Failed to generate ${name} report`);
}

const rangeLabel = (r: DateRange) => `Period: ${r.from} to ${r.to}`;

function periodArgs(entity: EntityRow, query: Record<string, string>, allow: { periods: boolean }) {
  const range = resolvePeriod(entity, query);
  const compare = parseCompare(query.compare);
  const periods = allow.periods ? parsePeriods(query.periods) : null;
  if (compare && periods) throw new ReportInputError('Use either compare or periods, not both');
  const columns = periods ? splitColumns(entity, range, periods) : periodColumns(entity, range, compare);
  return { range, columns };
}

// ---------------------------------------------------------------------------
// GET /profit-loss
// ---------------------------------------------------------------------------
app.get('/profit-loss', requirePermission('reports:read'), async (c) => {
  try {
    const ctx = await reportContext(c, { basis: true });
    const { range, columns } = periodArgs(ctx.entity, ctx.query, { periods: true });
    const ledger = await createLedger(ctx.db, { entityId: ctx.entity.id, basis: ctx.basis, filters: ctx.filters, upTo: latestDate(columns) });
    const report = await buildProfitLoss(ledger, columns, range);
    return respond(c, ctx, {
      table: profitLossTable(report),
      periodLabel: rangeLabel(range),
      filename: `profit-and-loss-${range.from}_${range.to}`,
      json: report,
    });
  } catch (err) {
    return failure(c, err, 'profit & loss');
  }
});

// ---------------------------------------------------------------------------
// GET /balance-sheet
// ---------------------------------------------------------------------------
app.get('/balance-sheet', requirePermission('reports:read'), async (c) => {
  try {
    const ctx = await reportContext(c, { basis: true });
    const asOf = ctx.query.asOf ? requireIsoDate(ctx.query.asOf, 'asOf') : todayFor(ctx.entity);
    const compare = parseCompare(ctx.query.compare);
    const periodStart = ctx.query.from ? requireIsoDate(ctx.query.from, 'from') : null;
    const columns = pointInTimeColumns(asOf, compare, periodStart);
    const ledger = await createLedger(ctx.db, { entityId: ctx.entity.id, basis: ctx.basis, filters: ctx.filters, upTo: latestDate(columns) });
    const report = await buildBalanceSheet(ledger, columns, (date) => fiscalYearContaining(ctx.entity, date).from);
    return respond(c, ctx, {
      table: balanceSheetTable(report),
      periodLabel: `As of ${asOf}`,
      filename: `balance-sheet-${asOf}`,
      json: report,
    });
  } catch (err) {
    return failure(c, err, 'balance sheet');
  }
});

// ---------------------------------------------------------------------------
// GET /trial-balance
// ---------------------------------------------------------------------------
app.get('/trial-balance', requirePermission('reports:read'), async (c) => {
  try {
    const ctx = await reportContext(c, { basis: true });
    const { range, columns } = periodArgs(ctx.entity, ctx.query, { periods: false });
    const ledger = await createLedger(ctx.db, { entityId: ctx.entity.id, basis: ctx.basis, filters: ctx.filters, upTo: latestDate(columns) });
    const report = await buildTrialBalance(ledger, columns, range);
    return respond(c, ctx, {
      table: trialBalanceTable(report),
      periodLabel: rangeLabel(range),
      filename: `trial-balance-${range.from}_${range.to}`,
      json: report,
    });
  } catch (err) {
    return failure(c, err, 'trial balance');
  }
});

// ---------------------------------------------------------------------------
// GET /aged-receivables, /aged-payables
//
// Aging works on open documents, so the basis doesn't change it. `asOf` sets
// the day days-past-due count to (default today); balances are the current
// ones.
// ---------------------------------------------------------------------------
for (const kind of ['receivables', 'payables'] as const) {
  app.get(`/aged-${kind}`, requirePermission('reports:read'), async (c) => {
    try {
      const ctx = await reportContext(c, { basis: false });
      const asOf = ctx.query.asOf ? requireIsoDate(ctx.query.asOf, 'asOf') : todayFor(ctx.entity);
      const report = await buildAgedReport(ctx.db, ctx.entity.id, kind, asOf);
      // Aged payables always answered with plain strings per bucket; the counts are new next to them.
      const json =
        kind === 'payables'
          ? {
              ...report,
              buckets: Object.fromEntries(Object.entries(report.buckets).map(([bucket, v]) => [bucket, v.total])),
              bucketCounts: Object.fromEntries(Object.entries(report.buckets).map(([bucket, v]) => [bucket, v.count])),
            }
          : report;
      return respond(c, ctx, {
        table: agedTable(report, kind),
        periodLabel: `As of ${asOf}`,
        filename: `aged-${kind}-${asOf}`,
        json,
        showBasis: false,
      });
    } catch (err) {
      return failure(c, err, `aged ${kind}`);
    }
  });
}

// ---------------------------------------------------------------------------
// GET /vat-summary — tax per rate from the journal lines (tax ledger of NL entities)
// ---------------------------------------------------------------------------
app.get('/vat-summary', requirePermission('reports:read'), async (c) => {
  try {
    const ctx = await reportContext(c, { basis: false });
    const range = resolvePeriod(ctx.entity, ctx.query);
    const { journalLines, journalEntries, taxRates } = schema;

    const results = await ctx.db
      .select({
        taxRateId: journalLines.taxRateId,
        taxRateName: taxRates.name,
        rate: taxRates.rate,
        taxCategoryCode: taxRates.taxCategoryCode,
        jurisdictionMetadata: taxRates.jurisdictionMetadata,
        totalTax: sql<string>`coalesce(sum(${journalLines.taxAmount}::numeric), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .leftJoin(taxRates, eq(journalLines.taxRateId, taxRates.id))
      .where(
        and(
          eq(journalLines.entityId, ctx.entity.id),
          isNull(journalLines.deletedAt),
          inArray(journalEntries.status, BOOKED_STATUSES),
          gte(journalEntries.date, parseReportDate(range.from, 'start')),
          lte(journalEntries.date, parseReportDate(range.to, 'end')),
          sql`${journalLines.taxRateId} is not null`,
        ),
      )
      .groupBy(
        journalLines.taxRateId,
        taxRates.name,
        taxRates.rate,
        taxRates.taxCategoryCode,
        taxRates.jurisdictionMetadata,
      );

    const table: ReportTable = {
      report: 'tax_summary',
      title: 'Tax summary',
      hasCode: false,
      columns: [
        { key: 'rate', label: 'Rate', numeric: true },
        { key: 'tax', label: 'Tax', numeric: true },
      ],
      rows: results.map((r) => ({
        kind: 'account' as const,
        depth: 0,
        label: r.taxRateName ?? r.taxRateId ?? '',
        values: { rate: r.rate ?? null, tax: money(Number.parseFloat(r.totalTax)) },
      })),
      notes: [],
    };
    return respond(c, ctx, {
      table,
      periodLabel: rangeLabel(range),
      filename: `tax-summary-${range.from}_${range.to}`,
      json: { period: range, breakdown: results },
      showBasis: false,
    });
  } catch (err) {
    return failure(c, err, 'tax summary');
  }
});

// ---------------------------------------------------------------------------
// GET /general-ledger — per-account drill-down with running balance
//
// `runningBalance` is debit minus credit, starting from `openingBalance` (the
// balance before `from`). csv and print export every line of the period.
// ---------------------------------------------------------------------------
app.get('/general-ledger', requirePermission('reports:read'), async (c) => {
  try {
    const ctx = await reportContext(c, { basis: true });
    const accountId = ctx.query.accountId;
    if (!accountId) return error.badRequest(c, 'accountId is required');

    const range = resolvePeriod(ctx.entity, ctx.query);
    const exporting = ctx.format !== 'json';
    const page = exporting ? 1 : Math.max(Number.parseInt(ctx.query.page ?? '1', 10) || 1, 1);
    const pageSize = exporting ? Number.MAX_SAFE_INTEGER : Math.min(Math.max(Number.parseInt(ctx.query.pageSize ?? '50', 10) || 50, 1), 500);

    const ledger = await createLedger(ctx.db, {
      entityId: ctx.entity.id,
      basis: ctx.basis,
      filters: ctx.filters,
      upTo: parseReportDate(range.to, 'end'),
    });
    const report = await buildGeneralLedger(ledger, accountId, range, { page, pageSize });
    if (!report) return error.notFound(c, 'Account', accountId);

    return respond(c, ctx, {
      table: generalLedgerTable(report),
      periodLabel: rangeLabel(range),
      filename: `general-ledger-${report.account.code || 'account'}-${range.from}_${range.to}`,
      json: report,
    });
  } catch (err) {
    return failure(c, err, 'general ledger');
  }
});

// ---------------------------------------------------------------------------
// GET /cash-flow — bank movements by calendar month
// ---------------------------------------------------------------------------

interface CashFlowMonth {
  month: string;
  inflows: string;
  outflows: string;
  net: string;
}

async function cashFlowFor(db: Database, entityId: string, range: DateRange) {
  const { bankTransactions } = schema;
  const monthly: CashFlowMonth[] = await db
    .select({
      month: sql<string>`to_char(${bankTransactions.date}, 'YYYY-MM')`,
      inflows: sql<string>`coalesce(sum(case when ${bankTransactions.amount}::numeric > 0 then ${bankTransactions.amount}::numeric else 0 end), 0)`,
      outflows: sql<string>`coalesce(sum(case when ${bankTransactions.amount}::numeric < 0 then ${bankTransactions.amount}::numeric else 0 end), 0)`,
      net: sql<string>`coalesce(sum(${bankTransactions.amount}::numeric), 0)`,
    })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.entityId, entityId),
        isNull(bankTransactions.deletedAt),
        gte(bankTransactions.date, parseReportDate(range.from, 'start')),
        lte(bankTransactions.date, parseReportDate(range.to, 'end')),
      ),
    )
    .groupBy(sql`to_char(${bankTransactions.date}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${bankTransactions.date}, 'YYYY-MM')`);

  const sum = (key: 'inflows' | 'outflows' | 'net') => monthly.reduce((total, m) => total + Number.parseFloat(m[key]), 0);
  return {
    period: range,
    monthly,
    totals: { inflows: money(sum('inflows')), outflows: money(sum('outflows')), net: money(sum('net')) },
  };
}

app.get('/cash-flow', requirePermission('reports:read'), async (c) => {
  try {
    const ctx = await reportContext(c, { basis: false });
    const range = resolvePeriod(ctx.entity, ctx.query);
    const compare = parseCompare(ctx.query.compare);

    const report = await cashFlowFor(ctx.db, ctx.entity.id, range);
    let json: Record<string, unknown> = report;
    if (compare) {
      const priorRange = compare === 'prior_year' ? priorYearOf(ctx.entity, range) : priorPeriodOf(range);
      const prior = await cashFlowFor(ctx.db, ctx.entity.id, priorRange);
      json = {
        ...report,
        comparison: {
          mode: compare,
          ...prior,
          delta: {
            inflows: deltaOf(Number(report.totals.inflows), Number(prior.totals.inflows)),
            outflows: deltaOf(Number(report.totals.outflows), Number(prior.totals.outflows)),
            net: deltaOf(Number(report.totals.net), Number(prior.totals.net)),
          },
        },
      };
    }
    return respond(c, ctx, {
      table: cashFlowTable(report),
      periodLabel: rangeLabel(range),
      filename: `cash-flow-${range.from}_${range.to}`,
      json,
      showBasis: false,
    });
  } catch (err) {
    return failure(c, err, 'cash flow');
  }
});

// ---------------------------------------------------------------------------
// GET /revenue-by-customer
// ---------------------------------------------------------------------------
app.get('/revenue-by-customer', requirePermission('reports:read'), async (c) => {
  try {
    const ctx = await reportContext(c, { basis: true });
    const range = resolvePeriod(ctx.entity, ctx.query);
    const ledger = await createLedger(ctx.db, {
      entityId: ctx.entity.id,
      basis: ctx.basis,
      filters: ctx.filters,
      upTo: parseReportDate(range.to, 'end'),
    });
    const result = await buildRevenueByCustomer(ctx.db, ledger, {
      from: parseReportDate(range.from, 'start'),
      to: parseReportDate(range.to, 'end'),
    });
    return respond(c, ctx, {
      table: revenueByCustomerTable(result),
      periodLabel: rangeLabel(range),
      filename: `revenue-by-customer-${range.from}_${range.to}`,
      json: { basis: ctx.basis, period: range, ...result },
    });
  } catch (err) {
    return failure(c, err, 'revenue by customer');
  }
});

// ---------------------------------------------------------------------------
// GET /expense-by-category
// ---------------------------------------------------------------------------
app.get('/expense-by-category', requirePermission('reports:read'), async (c) => {
  try {
    const ctx = await reportContext(c, { basis: true });
    const range = resolvePeriod(ctx.entity, ctx.query);
    const ledger = await createLedger(ctx.db, {
      entityId: ctx.entity.id,
      basis: ctx.basis,
      filters: ctx.filters,
      upTo: parseReportDate(range.to, 'end'),
    });
    const result = await buildExpenseByCategory(ledger, {
      from: parseReportDate(range.from, 'start'),
      to: parseReportDate(range.to, 'end'),
    });
    return respond(c, ctx, {
      table: expenseByCategoryTable(result),
      periodLabel: rangeLabel(range),
      filename: `expenses-by-category-${range.from}_${range.to}`,
      json: { basis: ctx.basis, period: range, ...result },
    });
  } catch (err) {
    return failure(c, err, 'expense by category');
  }
});

// ---------------------------------------------------------------------------
// GET /tax-worksheet?year=&basis= — the fiscal year's trial balance grouped by
// the lines of the entity's income-tax return (US)
//
// `year` names the fiscal year by the calendar year it ends in (July–June
// FY2026 is 1 July 2025 to 30 June 2026); without it, the current fiscal year.
// `from` / `to` override the dates. The return's line catalog is the one of the
// year the fiscal year starts in.
// ---------------------------------------------------------------------------
app.get('/tax-worksheet', requirePermission('reports:read'), async (c) => {
  try {
    const ctx = await reportContext(c, { basis: true });
    const { entity } = ctx;
    if (entity.jurisdictionCode !== 'US') {
      return error.badRequest(c, 'The tax return worksheet is available for US entities');
    }

    let range: DateRange;
    if (ctx.query.from || ctx.query.to) {
      range = resolvePeriod(entity, ctx.query);
    } else if (ctx.query.year) {
      const year = Number.parseInt(ctx.query.year, 10);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ReportInputError('year must be a four-digit year');
      range = fiscalYearNamed(entity, year);
    } else {
      range = fiscalYearContaining(entity, todayFor(entity));
    }

    const form = taxFormForEntity(entity.entityType, entity.taxClassification);
    const ledger = await createLedger(ctx.db, {
      entityId: entity.id,
      basis: ctx.basis,
      filters: ctx.filters,
      upTo: parseReportDate(range.to, 'end'),
    });
    const worksheet = await buildTaxWorksheet(
      ledger,
      {
        id: entity.id,
        name: entity.name,
        legalName: entity.legalName,
        entityType: entity.entityType,
        taxClassification: entity.taxClassification,
      },
      form,
      range,
      ctx.query.includeZero === 'true',
    );
    return respond(c, ctx, {
      table: taxWorksheetTable(worksheet),
      periodLabel: `${worksheet.formLabel}, ${rangeLabel(range)}`,
      filename: `tax-worksheet-${form}-${range.from}_${range.to}`,
      json: worksheet,
    });
  } catch (err) {
    return failure(c, err, 'tax worksheet');
  }
});

export const accountingReportsRoutes = app;
