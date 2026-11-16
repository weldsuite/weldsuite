/**
 * Accounting dashboard routes — /api/accounting-dashboard/* read-only surface.
 *
 * Returns aggregated KPIs (revenue, expenses, receivables, payables,
 * bank balances, recent payments, upcoming due invoices, pending documents,
 * monthly revenue trend (12 months) and revenue / expenses / profit trend
 * (24 months), receivables and payables aging)
 * for the WeldBooks dashboard view. Scoped to a single
 * accounting entity via `resolveEntityId` (X-Accounting-Entity-Id header →
 * `?entityId=` query param → workspace default entity).
 *
 * Every money figure is in the entity's base currency (returned as
 * `currency`):
 *   - revenue / expenses / profit and the monthly trend come from the ledger,
 *     the same profit & loss the report shows (net of VAT, posted entries
 *     only, the entity's accounting basis);
 *   - receivables / payables are the aged-receivables / aged-payables
 *     documents: posted only, credit notes reduce the total, balances
 *     converted at the document's exchange rate. Overdue leaves credit notes out.
 *
 * Read-only — no mutations, no entity events.
 *
 * Permissions: reports:read.
 */

import { Hono } from 'hono';
import { and, desc, eq, gte, isNull, lte, notInArray, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import { resolveEntityId } from '../../lib/entity-context';
import { createLedger, parseReportDate, resolveBasis } from '../../services/accounting-reports-basis';
import { balanceInBase, buildAgedReport, buildProfitLoss, money } from '../../services/accounting-reports';
import { todayFor, type ReportColumn } from '../../services/accounting-report-periods';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Documents that are not posted to the ledger: they are no revenue, expense, receivable or payable. */
const UNPOSTED_STATUSES = ['draft', 'cancelled', 'void'];

const pad = (n: number) => String(n).padStart(2, '0');
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** `YYYY-MM` columns for the last `count` calendar months ending with the month of `today`. */
function monthColumns(today: string, count: number): ReportColumn[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const columns: ReportColumn[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const key = `${y}-${pad(m)}`;
    columns.push({ key, label: key, from: `${key}-01`, to: `${key}-${pad(lastDayOf(y, m))}` });
  }
  return columns;
}

// ---------------------------------------------------------------------------
// GET / — dashboard aggregates
// ---------------------------------------------------------------------------
app.get('/', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { invoices, bankAccounts, payments, documents, entities } = schema;

    const [entity] = await db
      .select()
      .from(entities)
      .where(and(eq(entities.id, entityId), isNull(entities.deletedAt)))
      .limit(1);
    if (!entity) return error.notFound(c, 'Accounting entity', entityId);
    const baseCurrency = entity.baseCurrency;

    const now = new Date();
    const today = todayFor(entity, now);
    const year = Number(today.slice(0, 4));
    const monthStart = new Date(Date.UTC(year, Number(today.slice(5, 7)) - 1, 1));

    // Revenue, expenses and profit: the ledger's profit & loss. The trend runs
    // 24 months so the dashboard can compare any range with the one before it.
    const trend = monthColumns(today, 24);
    const lastTwelve = trend.slice(-12);
    const currentMonth = trend[trend.length - 1];
    const yearColumn: ReportColumn = { key: 'year', label: String(year), from: `${year}-01-01`, to: `${year}-12-31` };
    const basis = await resolveBasis(db, entity, null);
    const ledger = await createLedger(db, { entityId, basis, upTo: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)) });
    const profitLoss = await buildProfitLoss(ledger, [...trend, yearColumn], { from: trend[0].from!, to: yearColumn.to });
    const revenueRow = profitLoss.totals.totalRevenue.values;
    const expensesRow = profitLoss.totals.totalExpenses.values;
    const profitRow = profitLoss.totals.netProfit.values;

    // Posted standard invoices issued this month.
    const [issuedThisMonth] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(invoices)
      .where(
        and(
          eq(invoices.entityId, entityId),
          isNull(invoices.deletedAt),
          gte(invoices.issueDate, monthStart),
          eq(invoices.type, 'standard'),
          notInArray(invoices.status, UNPOSTED_STATUSES),
        ),
      );

    // Receivables and payables: the aged reports' documents, in base currency.
    const [agedReceivables, agedPayables] = await Promise.all([
      buildAgedReport(db, entityId, 'receivables', today),
      buildAgedReport(db, entityId, 'payables', today),
    ]);
    const summarize = (report: typeof agedReceivables) => {
      const overdue = report.documents.filter((d) => d.daysPastDue > 0 && Number(d.balance) > 0);
      return {
        outstanding: report.total,
        outstandingCount: report.documents.length,
        overdue: money(overdue.reduce((total, d) => total + Number(d.balance), 0)),
        overdueCount: overdue.length,
        aging: report.buckets,
      };
    };
    const receivables = summarize(agedReceivables);
    const payables = summarize(agedPayables);

    // Bank balances (entity-scoped)
    const bankAccountsList = await db
      .select({
        id: bankAccounts.id,
        name: bankAccounts.name,
        iban: bankAccounts.iban,
        currentBalance: bankAccounts.currentBalance,
        currency: bankAccounts.currency,
        ledgerAccountId: bankAccounts.ledgerAccountId,
      })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.entityId, entityId),
          isNull(bankAccounts.deletedAt),
          eq(bankAccounts.isActive, true),
        ),
      );

    // Cash: the ledger balance of the money accounts. `currentBalance` above moves only with bank
    // transactions, so a payment recorded without a statement line would not show in it.
    const moneyAccountIds = new Set(
      bankAccountsList.map((b) => b.ledgerAccountId).filter((id): id is string => Boolean(id)),
    );
    const [anyLinkedBank] = await db
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.entityId, entityId),
          isNull(bankAccounts.deletedAt),
          sql`${bankAccounts.ledgerAccountId} is not null`,
        ),
      )
      .limit(1);
    if (!anyLinkedBank) {
      // No bank account is linked to the ledger: payments post to the chart's bank account (see resolveMoneyAccount).
      const chartAccounts = [...ledger.accounts.values()].filter((a) => !a.virtual);
      const templateCode = entity.jurisdictionCode === 'IN' ? '1200' : '1100';
      const fallback =
        chartAccounts.find((a) => a.code === templateCode && a.subtype === 'bank') ??
        chartAccounts.find((a) => a.subtype === 'bank');
      if (fallback) moneyAccountIds.add(fallback.id);
    }
    const cashRows = moneyAccountIds.size
      ? await ledger.aggregate(
          { from: null, to: parseReportDate(today, 'end') },
          { accountIds: [...moneyAccountIds] },
        )
      : [];
    const cashBalance = money(
      cashRows.reduce((total, row) => {
        const account = ledger.accounts.get(row.accountId);
        return total + (account?.normalSide === 'credit' ? row.credit - row.debit : row.debit - row.credit);
      }, 0),
    );

    // Recent payments (last 10). Entity scoping added over legacy
    // (which listed payments tenant-wide) — multi-entity correctness.
    const recentPayments = await db
      .select()
      .from(payments)
      .where(and(eq(payments.entityId, entityId), isNull(payments.deletedAt)))
      .orderBy(desc(payments.date))
      .limit(10);

    // Upcoming due invoices (next 30 days): posted, no credit notes, in base currency
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcomingRows = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        contactName: invoices.contactName,
        dueDate: invoices.dueDate,
        balanceDue: invoices.balanceDue,
        currency: invoices.currency,
        exchangeRate: invoices.exchangeRate,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.entityId, entityId),
          isNull(invoices.deletedAt),
          sql`${invoices.balanceDue}::numeric > 0`,
          notInArray(invoices.status, [...UNPOSTED_STATUSES, 'paid', 'uncollectible', 'written_off']),
          notInArray(invoices.type, ['credit_note', 'proforma']),
          lte(invoices.dueDate, thirtyDaysFromNow),
          gte(invoices.dueDate, now),
        ),
      )
      .orderBy(invoices.dueDate)
      .limit(10);
    const upcomingDue = upcomingRows.map(({ currency, exchangeRate, ...row }) => ({
      ...row,
      balanceDue: money(balanceInBase(Number(row.balanceDue ?? 0), { currency, exchangeRate }, baseCurrency)),
    }));

    // Pending documents
    const [pendingDocs] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(
        and(
          eq(documents.entityId, entityId),
          isNull(documents.deletedAt),
          sql`${documents.status} in ('pending', 'processing', 'processed')`,
        ),
      );

    return success(c, {
      currency: baseCurrency,
      revenue: {
        month: revenueRow[currentMonth.key],
        year: revenueRow.year,
        invoiceCount: issuedThisMonth.count,
      },
      expenses: {
        month: expensesRow[currentMonth.key],
        year: expensesRow.year,
      },
      profit: {
        month: profitRow[currentMonth.key],
        year: profitRow.year,
      },
      receivables,
      payables,
      cashBalance,
      bankAccounts: bankAccountsList.map((b) => ({ id: b.id, name: b.name, iban: b.iban, currentBalance: b.currentBalance, currency: b.currency })),
      recentPayments,
      upcomingDue,
      pendingDocuments: pendingDocs.count,
      monthlyRevenue: lastTwelve.map((column) => ({ month: column.key, total: revenueRow[column.key] })),
      monthlyTrend: trend.map((column) => ({
        month: column.key,
        revenue: revenueRow[column.key],
        expenses: expensesRow[column.key],
        profit: profitRow[column.key],
      })),
    });
  } catch (err) {
    console.error('[app-api/accounting-dashboard] get failed:', err);
    return error.internal(c, 'Failed to fetch dashboard data');
  }
});

export const accountingDashboardRoutes = app;
