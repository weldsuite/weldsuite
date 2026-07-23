/**
 * Accounting reports routes — /api/accounting-reports/* read-only surface.
 *
 * All reports compute from posted journal entries scoped to a single
 * accounting entity, resolved via `resolveEntityId` (X-Accounting-Entity-Id
 * header → `?entityId=` query param → workspace default entity).
 *
 * Multi-entity correctness: the legacy api-worker versions of
 * aged-receivables, aged-payables and cash-flow were NOT entity-scoped —
 * that is fixed here (invoices/bills/bankTransactions all filter on entityId).
 *
 * Reports are read-only — no mutations, no entity events.
 *
 * Permissions: reports:read.
 */

import { Hono } from 'hono';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';
import { resolveEntityId } from '../../lib/entity-context';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /profit-loss
// ---------------------------------------------------------------------------
app.get('/profit-loss', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();

  const from = q.from ?? new Date(new Date().getFullYear(), 0, 1).toISOString();
  const to = q.to ?? new Date().toISOString();

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { journalLines, journalEntries, accounts } = schema;

    const results = await db
      .select({
        accountId: journalLines.accountId,
        accountCode: accounts.code,
        accountName: accounts.name,
        accountType: accounts.type,
        accountSubtype: accounts.subtype,
        totalDebit: sql<string>`coalesce(sum(${journalLines.debit}::numeric), 0)`,
        totalCredit: sql<string>`coalesce(sum(${journalLines.credit}::numeric), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(
        and(
          eq(journalLines.entityId, entityId),
          isNull(journalLines.deletedAt),
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, new Date(from)),
          lte(journalEntries.date, new Date(to)),
          sql`${accounts.type} in ('revenue', 'expense')`,
        ),
      )
      .groupBy(
        journalLines.accountId,
        accounts.code,
        accounts.name,
        accounts.type,
        accounts.subtype,
      )
      .orderBy(accounts.code);

    const revenue = results.filter((r) => r.accountType === 'revenue');
    const expenses = results.filter((r) => r.accountType === 'expense');

    const totalRevenue = revenue.reduce(
      (sum, r) => sum + parseFloat(r.totalCredit) - parseFloat(r.totalDebit),
      0,
    );
    const totalExpenses = expenses.reduce(
      (sum, r) => sum + parseFloat(r.totalDebit) - parseFloat(r.totalCredit),
      0,
    );

    return success(c, {
      period: { from, to },
      revenue: revenue.map((r) => ({
        ...r,
        balance: (parseFloat(r.totalCredit) - parseFloat(r.totalDebit)).toFixed(2),
      })),
      expenses: expenses.map((r) => ({
        ...r,
        balance: (parseFloat(r.totalDebit) - parseFloat(r.totalCredit)).toFixed(2),
      })),
      totalRevenue: totalRevenue.toFixed(2),
      totalExpenses: totalExpenses.toFixed(2),
      netProfit: (totalRevenue - totalExpenses).toFixed(2),
    });
  } catch (err) {
    console.error('[app-api/accounting-reports] profit-loss failed:', err);
    return error.internal(c, 'Failed to generate profit & loss report');
  }
});

// ---------------------------------------------------------------------------
// GET /balance-sheet
// ---------------------------------------------------------------------------
app.get('/balance-sheet', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();

  const asOf = q.asOf ?? new Date().toISOString();

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { journalLines, journalEntries, accounts } = schema;

    const results = await db
      .select({
        accountId: journalLines.accountId,
        accountCode: accounts.code,
        accountName: accounts.name,
        accountType: accounts.type,
        accountSubtype: accounts.subtype,
        normalSide: accounts.normalSide,
        totalDebit: sql<string>`coalesce(sum(${journalLines.debit}::numeric), 0)`,
        totalCredit: sql<string>`coalesce(sum(${journalLines.credit}::numeric), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(
        and(
          eq(journalLines.entityId, entityId),
          isNull(journalLines.deletedAt),
          eq(journalEntries.status, 'posted'),
          lte(journalEntries.date, new Date(asOf)),
          sql`${accounts.type} in ('asset', 'liability', 'equity')`,
        ),
      )
      .groupBy(
        journalLines.accountId,
        accounts.code,
        accounts.name,
        accounts.type,
        accounts.subtype,
        accounts.normalSide,
      )
      .orderBy(accounts.code);

    const computeBalance = (r: (typeof results)[0]) => {
      const debit = parseFloat(r.totalDebit);
      const credit = parseFloat(r.totalCredit);
      return r.normalSide === 'debit'
        ? (debit - credit).toFixed(2)
        : (credit - debit).toFixed(2);
    };

    const assets = results
      .filter((r) => r.accountType === 'asset')
      .map((r) => ({ ...r, balance: computeBalance(r) }));
    const liabilities = results
      .filter((r) => r.accountType === 'liability')
      .map((r) => ({ ...r, balance: computeBalance(r) }));
    const equity = results
      .filter((r) => r.accountType === 'equity')
      .map((r) => ({ ...r, balance: computeBalance(r) }));

    const totalAssets = assets.reduce((sum, r) => sum + parseFloat(r.balance), 0);
    const totalLiabilities = liabilities.reduce((sum, r) => sum + parseFloat(r.balance), 0);
    const totalEquity = equity.reduce((sum, r) => sum + parseFloat(r.balance), 0);

    return success(c, {
      asOf,
      assets,
      liabilities,
      equity,
      totalAssets: totalAssets.toFixed(2),
      totalLiabilities: totalLiabilities.toFixed(2),
      totalEquity: totalEquity.toFixed(2),
      totalLiabilitiesAndEquity: (totalLiabilities + totalEquity).toFixed(2),
    });
  } catch (err) {
    console.error('[app-api/accounting-reports] balance-sheet failed:', err);
    return error.internal(c, 'Failed to generate balance sheet');
  }
});

// ---------------------------------------------------------------------------
// GET /trial-balance
// ---------------------------------------------------------------------------
app.get('/trial-balance', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();

  const from = q.from ?? new Date(new Date().getFullYear(), 0, 1).toISOString();
  const to = q.to ?? new Date().toISOString();

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { journalLines, journalEntries, accounts } = schema;

    const results = await db
      .select({
        accountCode: accounts.code,
        accountName: accounts.name,
        accountType: accounts.type,
        totalDebit: sql<string>`coalesce(sum(${journalLines.debit}::numeric), 0)`,
        totalCredit: sql<string>`coalesce(sum(${journalLines.credit}::numeric), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(
        and(
          eq(journalLines.entityId, entityId),
          isNull(journalLines.deletedAt),
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, new Date(from)),
          lte(journalEntries.date, new Date(to)),
        ),
      )
      .groupBy(accounts.code, accounts.name, accounts.type)
      .orderBy(accounts.code);

    const totalDebit = results.reduce((sum, r) => sum + parseFloat(r.totalDebit), 0);
    const totalCredit = results.reduce((sum, r) => sum + parseFloat(r.totalCredit), 0);

    return success(c, {
      period: { from, to },
      accounts: results,
      totalDebit: totalDebit.toFixed(2),
      totalCredit: totalCredit.toFixed(2),
      isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
    });
  } catch (err) {
    console.error('[app-api/accounting-reports] trial-balance failed:', err);
    return error.internal(c, 'Failed to generate trial balance');
  }
});

// ---------------------------------------------------------------------------
// GET /aged-receivables
// ---------------------------------------------------------------------------
app.get('/aged-receivables', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { invoices } = schema;

    // Entity scoping added over legacy (which aggregated tenant-wide).
    const openInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.entityId, entityId),
          isNull(invoices.deletedAt),
          sql`${invoices.balanceDue}::numeric > 0`,
        ),
      )
      .orderBy(invoices.dueDate);

    const now = new Date();
    const buckets = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 };
    const bucketItems: Record<string, typeof openInvoices> = {
      current: [],
      days30: [],
      days60: [],
      days90: [],
      over90: [],
    };

    for (const inv of openInvoices) {
      const daysPast = Math.floor(
        (now.getTime() - new Date(inv.dueDate).getTime()) / (1000 * 60 * 60 * 24),
      );
      const balance = parseFloat(inv.balanceDue ?? '0');

      if (daysPast <= 0) {
        buckets.current += balance;
        bucketItems.current.push(inv);
      } else if (daysPast <= 30) {
        buckets.days30 += balance;
        bucketItems.days30.push(inv);
      } else if (daysPast <= 60) {
        buckets.days60 += balance;
        bucketItems.days60.push(inv);
      } else if (daysPast <= 90) {
        buckets.days90 += balance;
        bucketItems.days90.push(inv);
      } else {
        buckets.over90 += balance;
        bucketItems.over90.push(inv);
      }
    }

    return success(c, {
      buckets: {
        current: { total: buckets.current.toFixed(2), count: bucketItems.current.length },
        '1-30': { total: buckets.days30.toFixed(2), count: bucketItems.days30.length },
        '31-60': { total: buckets.days60.toFixed(2), count: bucketItems.days60.length },
        '61-90': { total: buckets.days90.toFixed(2), count: bucketItems.days90.length },
        '90+': { total: buckets.over90.toFixed(2), count: bucketItems.over90.length },
      },
      total: (
        buckets.current +
        buckets.days30 +
        buckets.days60 +
        buckets.days90 +
        buckets.over90
      ).toFixed(2),
    });
  } catch (err) {
    console.error('[app-api/accounting-reports] aged-receivables failed:', err);
    return error.internal(c, 'Failed to generate aged receivables');
  }
});

// ---------------------------------------------------------------------------
// GET /aged-payables
// ---------------------------------------------------------------------------
app.get('/aged-payables', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { bills } = schema;

    // Entity scoping added over legacy (which aggregated tenant-wide).
    const openBills = await db
      .select()
      .from(bills)
      .where(
        and(
          eq(bills.entityId, entityId),
          isNull(bills.deletedAt),
          sql`${bills.balanceDue}::numeric > 0`,
        ),
      )
      .orderBy(bills.dueDate);

    const now = new Date();
    const buckets = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 };

    for (const bill of openBills) {
      const daysPast = Math.floor(
        (now.getTime() - new Date(bill.dueDate).getTime()) / (1000 * 60 * 60 * 24),
      );
      const balance = parseFloat(bill.balanceDue ?? '0');
      if (daysPast <= 0) buckets.current += balance;
      else if (daysPast <= 30) buckets.days30 += balance;
      else if (daysPast <= 60) buckets.days60 += balance;
      else if (daysPast <= 90) buckets.days90 += balance;
      else buckets.over90 += balance;
    }

    return success(c, {
      buckets: {
        current: buckets.current.toFixed(2),
        '1-30': buckets.days30.toFixed(2),
        '31-60': buckets.days60.toFixed(2),
        '61-90': buckets.days90.toFixed(2),
        '90+': buckets.over90.toFixed(2),
      },
      total: (
        buckets.current +
        buckets.days30 +
        buckets.days60 +
        buckets.days90 +
        buckets.over90
      ).toFixed(2),
    });
  } catch (err) {
    console.error('[app-api/accounting-reports] aged-payables failed:', err);
    return error.internal(c, 'Failed to generate aged payables');
  }
});

// ---------------------------------------------------------------------------
// GET /vat-summary
// ---------------------------------------------------------------------------
app.get('/vat-summary', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();

  const from = q.from ?? new Date(new Date().getFullYear(), 0, 1).toISOString();
  const to = q.to ?? new Date().toISOString();

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { journalLines, journalEntries, taxRates } = schema;

    const results = await db
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
          eq(journalLines.entityId, entityId),
          isNull(journalLines.deletedAt),
          eq(journalEntries.status, 'posted'),
          gte(journalEntries.date, new Date(from)),
          lte(journalEntries.date, new Date(to)),
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

    return success(c, { period: { from, to }, breakdown: results });
  } catch (err) {
    console.error('[app-api/accounting-reports] vat-summary failed:', err);
    return error.internal(c, 'Failed to generate VAT summary');
  }
});

// ---------------------------------------------------------------------------
// GET /general-ledger — per-account drill-down with running balance
// ---------------------------------------------------------------------------
app.get('/general-ledger', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();

  const accountId = q.accountId;
  if (!accountId) return error.badRequest(c, 'accountId is required');

  const from = q.from ?? new Date(new Date().getFullYear(), 0, 1).toISOString();
  const to = q.to ?? new Date().toISOString();
  const page = parseInt(q.page ?? '1', 10);
  const pageSize = parseInt(q.pageSize ?? '50', 10);

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { journalLines, journalEntries, accounts } = schema;

    const [account] = await db
      .select({
        id: accounts.id,
        code: accounts.code,
        name: accounts.name,
        normalSide: accounts.normalSide,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account) return error.notFound(c, 'Account', accountId);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalLines.entityId, entityId),
          isNull(journalLines.deletedAt),
          eq(journalEntries.status, 'posted'),
          eq(journalLines.accountId, accountId),
          gte(journalEntries.date, new Date(from)),
          lte(journalEntries.date, new Date(to)),
        ),
      );

    const totalCount = Number(count);
    const totalPages = Math.ceil(totalCount / pageSize);
    const offset = (page - 1) * pageSize;

    const lines = await db
      .select({
        id: journalLines.id,
        journalEntryId: journalLines.journalEntryId,
        entryNumber: journalEntries.entryNumber,
        entryDate: journalEntries.date,
        entryStatus: journalEntries.status,
        description: journalLines.description,
        debit: sql<string>`coalesce(${journalLines.debit}::numeric, 0)`,
        credit: sql<string>`coalesce(${journalLines.credit}::numeric, 0)`,
        runningBalance: sql<string>`sum(coalesce(${journalLines.debit}::numeric, 0) - coalesce(${journalLines.credit}::numeric, 0)) over (order by ${journalEntries.date} asc, ${journalEntries.id} asc)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalLines.entityId, entityId),
          isNull(journalLines.deletedAt),
          eq(journalEntries.status, 'posted'),
          eq(journalLines.accountId, accountId),
          gte(journalEntries.date, new Date(from)),
          lte(journalEntries.date, new Date(to)),
        ),
      )
      .orderBy(asc(journalEntries.date), asc(journalEntries.id))
      .limit(pageSize)
      .offset(offset);

    return success(c, {
      account,
      period: { from, to },
      lines,
      pagination: { page, pageSize, totalCount, totalPages, hasMore: page < totalPages },
    });
  } catch (err) {
    console.error('[app-api/accounting-reports] general-ledger failed:', err);
    return error.internal(c, 'Failed to generate general ledger');
  }
});

// ---------------------------------------------------------------------------
// GET /cash-flow
// ---------------------------------------------------------------------------
app.get('/cash-flow', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();

  const from = q.from ?? new Date(new Date().getFullYear(), 0, 1).toISOString();
  const to = q.to ?? new Date().toISOString();

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { bankTransactions } = schema;

    // Entity scoping added over legacy (which aggregated tenant-wide).
    const monthly = await db
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
          gte(bankTransactions.date, new Date(from)),
          lte(bankTransactions.date, new Date(to)),
        ),
      )
      .groupBy(sql`to_char(${bankTransactions.date}, 'YYYY-MM')`)
      .orderBy(sql`to_char(${bankTransactions.date}, 'YYYY-MM')`);

    const totalInflows = monthly.reduce((sum, m) => sum + parseFloat(m.inflows), 0);
    const totalOutflows = monthly.reduce((sum, m) => sum + parseFloat(m.outflows), 0);
    const totalNet = monthly.reduce((sum, m) => sum + parseFloat(m.net), 0);

    return success(c, {
      period: { from, to },
      monthly,
      totals: {
        inflows: totalInflows.toFixed(2),
        outflows: totalOutflows.toFixed(2),
        net: totalNet.toFixed(2),
      },
    });
  } catch (err) {
    console.error('[app-api/accounting-reports] cash-flow failed:', err);
    return error.internal(c, 'Failed to generate cash flow report');
  }
});

// ---------------------------------------------------------------------------
// GET /revenue-by-customer
// ---------------------------------------------------------------------------
app.get('/revenue-by-customer', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();

  const from = q.from ?? new Date(new Date().getFullYear(), 0, 1).toISOString();
  const to = q.to ?? new Date().toISOString();

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { journalLines, journalEntries, accounts, parties } = schema;

    const results = await db
      .select({
        contactId: journalLines.contactId,
        contactName: parties.displayName,
        totalRevenue: sql<string>`coalesce(sum(${journalLines.credit}::numeric - ${journalLines.debit}::numeric), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .leftJoin(parties, eq(journalLines.contactId, parties.id))
      .where(
        and(
          eq(journalLines.entityId, entityId),
          isNull(journalLines.deletedAt),
          eq(journalEntries.status, 'posted'),
          eq(accounts.type, 'revenue'),
          gte(journalEntries.date, new Date(from)),
          lte(journalEntries.date, new Date(to)),
          sql`${journalLines.contactId} is not null`,
        ),
      )
      .groupBy(journalLines.contactId, parties.displayName)
      .orderBy(
        desc(
          sql`coalesce(sum(${journalLines.credit}::numeric - ${journalLines.debit}::numeric), 0)`,
        ),
      );

    const grandTotal = results.reduce((sum, r) => sum + parseFloat(r.totalRevenue), 0);

    return success(c, {
      period: { from, to },
      customers: results,
      grandTotal: grandTotal.toFixed(2),
    });
  } catch (err) {
    console.error('[app-api/accounting-reports] revenue-by-customer failed:', err);
    return error.internal(c, 'Failed to generate revenue by customer report');
  }
});

// ---------------------------------------------------------------------------
// GET /expense-by-category
// ---------------------------------------------------------------------------
app.get('/expense-by-category', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();

  const from = q.from ?? new Date(new Date().getFullYear(), 0, 1).toISOString();
  const to = q.to ?? new Date().toISOString();

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { journalLines, journalEntries, accounts } = schema;

    const results = await db
      .select({
        accountId: journalLines.accountId,
        accountCode: accounts.code,
        accountName: accounts.name,
        totalExpense: sql<string>`coalesce(sum(${journalLines.debit}::numeric - ${journalLines.credit}::numeric), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(
        and(
          eq(journalLines.entityId, entityId),
          isNull(journalLines.deletedAt),
          eq(journalEntries.status, 'posted'),
          eq(accounts.type, 'expense'),
          gte(journalEntries.date, new Date(from)),
          lte(journalEntries.date, new Date(to)),
        ),
      )
      .groupBy(journalLines.accountId, accounts.code, accounts.name)
      .orderBy(
        desc(
          sql`coalesce(sum(${journalLines.debit}::numeric - ${journalLines.credit}::numeric), 0)`,
        ),
      );

    const grandTotal = results.reduce((sum, r) => sum + parseFloat(r.totalExpense), 0);

    return success(c, {
      period: { from, to },
      categories: results,
      grandTotal: grandTotal.toFixed(2),
    });
  } catch (err) {
    console.error('[app-api/accounting-reports] expense-by-category failed:', err);
    return error.internal(c, 'Failed to generate expense by category report');
  }
});

export const accountingReportsRoutes = app;
