/**
 * Accounting dashboard routes — /api/accounting-dashboard/* read-only surface.
 *
 * Returns aggregated KPIs (revenue, expenses, receivables, payables,
 * bank balances, recent payments, upcoming due invoices, pending documents,
 * monthly revenue trend) for the WeldBooks dashboard view. Scoped to a single
 * accounting entity via `resolveEntityId` (X-Accounting-Entity-Id header →
 * `?entityId=` query param → workspace default entity).
 *
 * Read-only — no mutations, no entity events.
 *
 * Permissions: reports:read.
 */

import { Hono } from 'hono';
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';
import { resolveEntityId } from '../../lib/entity-context';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET / — dashboard aggregates
// ---------------------------------------------------------------------------
app.get('/', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { invoices, bills, bankAccounts, payments, documents } = schema;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    // Revenue this month
    const [revenueMonth] = await db
      .select({
        total: sql<string>`coalesce(sum(${invoices.total}::numeric), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.entityId, entityId),
          isNull(invoices.deletedAt),
          gte(invoices.issueDate, startOfMonth),
          eq(invoices.type, 'standard'),
        ),
      );

    // Revenue this year
    const [revenueYear] = await db
      .select({
        total: sql<string>`coalesce(sum(${invoices.total}::numeric), 0)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.entityId, entityId),
          isNull(invoices.deletedAt),
          gte(invoices.issueDate, startOfYear),
          eq(invoices.type, 'standard'),
        ),
      );

    // Expenses this month
    const [expensesMonth] = await db
      .select({
        total: sql<string>`coalesce(sum(${bills.total}::numeric), 0)`,
      })
      .from(bills)
      .where(
        and(
          eq(bills.entityId, entityId),
          isNull(bills.deletedAt),
          gte(bills.issueDate, startOfMonth),
        ),
      );

    // Expenses this year
    const [expensesYear] = await db
      .select({
        total: sql<string>`coalesce(sum(${bills.total}::numeric), 0)`,
      })
      .from(bills)
      .where(
        and(
          eq(bills.entityId, entityId),
          isNull(bills.deletedAt),
          gte(bills.issueDate, startOfYear),
        ),
      );

    // Outstanding receivables
    const [receivables] = await db
      .select({
        total: sql<string>`coalesce(sum(${invoices.balanceDue}::numeric), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.entityId, entityId),
          isNull(invoices.deletedAt),
          sql`${invoices.balanceDue}::numeric > 0`,
        ),
      );

    // Overdue receivables
    const [overdueReceivables] = await db
      .select({
        total: sql<string>`coalesce(sum(${invoices.balanceDue}::numeric), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.entityId, entityId),
          isNull(invoices.deletedAt),
          sql`${invoices.balanceDue}::numeric > 0`,
          lte(invoices.dueDate, now),
        ),
      );

    // Outstanding payables
    const [payables] = await db
      .select({
        total: sql<string>`coalesce(sum(${bills.balanceDue}::numeric), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(bills)
      .where(
        and(
          eq(bills.entityId, entityId),
          isNull(bills.deletedAt),
          sql`${bills.balanceDue}::numeric > 0`,
        ),
      );

    // Bank balances (entity-scoped)
    const bankAccountsList = await db
      .select({
        id: bankAccounts.id,
        name: bankAccounts.name,
        iban: bankAccounts.iban,
        currentBalance: bankAccounts.currentBalance,
        currency: bankAccounts.currency,
      })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.entityId, entityId),
          isNull(bankAccounts.deletedAt),
          eq(bankAccounts.isActive, true),
        ),
      );

    // Recent payments (last 10). Entity scoping added over legacy
    // (which listed payments tenant-wide) — multi-entity correctness.
    const recentPayments = await db
      .select()
      .from(payments)
      .where(and(eq(payments.entityId, entityId), isNull(payments.deletedAt)))
      .orderBy(desc(payments.date))
      .limit(10);

    // Upcoming due invoices (next 30 days)
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcomingDue = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        contactName: invoices.contactName,
        dueDate: invoices.dueDate,
        balanceDue: invoices.balanceDue,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.entityId, entityId),
          isNull(invoices.deletedAt),
          sql`${invoices.balanceDue}::numeric > 0`,
          lte(invoices.dueDate, thirtyDaysFromNow),
          gte(invoices.dueDate, now),
        ),
      )
      .orderBy(invoices.dueDate)
      .limit(10);

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

    // Monthly revenue trend (last 12 months)
    const monthlyRevenue = await db
      .select({
        month: sql<string>`to_char(${invoices.issueDate}, 'YYYY-MM')`,
        total: sql<string>`coalesce(sum(${invoices.total}::numeric), 0)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.entityId, entityId),
          isNull(invoices.deletedAt),
          gte(invoices.issueDate, new Date(now.getFullYear() - 1, now.getMonth(), 1)),
          eq(invoices.type, 'standard'),
        ),
      )
      .groupBy(sql`to_char(${invoices.issueDate}, 'YYYY-MM')`)
      .orderBy(sql`to_char(${invoices.issueDate}, 'YYYY-MM')`);

    return success(c, {
      revenue: {
        month: revenueMonth.total,
        year: revenueYear.total,
        invoiceCount: revenueMonth.count,
      },
      expenses: {
        month: expensesMonth.total,
        year: expensesYear.total,
      },
      profit: {
        month: String(parseFloat(revenueMonth.total) - parseFloat(expensesMonth.total)),
        year: String(parseFloat(revenueYear.total) - parseFloat(expensesYear.total)),
      },
      receivables: {
        outstanding: receivables.total,
        outstandingCount: receivables.count,
        overdue: overdueReceivables.total,
        overdueCount: overdueReceivables.count,
      },
      payables: {
        outstanding: payables.total,
        outstandingCount: payables.count,
      },
      bankAccounts: bankAccountsList,
      recentPayments,
      upcomingDue,
      pendingDocuments: pendingDocs.count,
      monthlyRevenue,
    });
  } catch (err) {
    console.error('[app-api/accounting-dashboard] get failed:', err);
    return error.internal(c, 'Failed to fetch dashboard data');
  }
});

export const accountingDashboardRoutes = app;
