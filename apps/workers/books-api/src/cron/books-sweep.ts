/**
 * Daily WeldBooks sweep (books-api cron).
 *
 * Which workspaces use WeldBooks is only known inside each tenant DB, and a
 * cron must not open every tenant to find out. So books-api keeps a small
 * index in the WORKSPACE_CACHE KV namespace: every workspace that calls
 * books-api is registered under `books:active:<clerkOrgId>` (refreshed at most
 * once per isolate, kept 120 days). The sweep lists that prefix and only opens
 * those tenants.
 *
 * Per tenant it:
 *   - marks finalized invoices past their due date as overdue;
 *   - generates recurring invoices whose next issue date has come (one period
 *     per schedule per run; the claim in generateRecurringInvoice makes a
 *     concurrent manual "generate" safe);
 *   - stores today's ECB rates in fx_rates.
 */

import { and, eq, gt, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { getTenantDbForWorkspace, schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';
import { generateRecurringInvoice, RecurringAlreadyGeneratedError } from '../services/accounting-recurring';
import { persistDailyEcbRates } from '../services/accounting-currency';

export const BOOKS_ACTIVE_PREFIX = 'books:active:';
const ACTIVE_TTL_SECONDS = 120 * 24 * 60 * 60;
/** Stop starting new tenants after this long; the next run picks up the rest. */
const SWEEP_BUDGET_MS = 10 * 60 * 1000;

const registered = new Set<string>();

/** Remember that this workspace uses WeldBooks, so the daily sweep visits it. */
export async function registerBooksWorkspace(env: Pick<Env, 'WORKSPACE_CACHE'>, clerkOrgId: string | null | undefined) {
  if (!clerkOrgId || registered.has(clerkOrgId)) return;
  registered.add(clerkOrgId);
  try {
    await env.WORKSPACE_CACHE.put(`${BOOKS_ACTIVE_PREFIX}${clerkOrgId}`, '1', { expirationTtl: ACTIVE_TTL_SECONDS });
  } catch (err) {
    registered.delete(clerkOrgId);
    console.warn('[books-sweep] could not register workspace:', err instanceof Error ? err.message : err);
  }
}

export interface TenantSweepResult {
  overdue: number;
  recurringGenerated: number;
  recurringFailed: number;
  fxRates: number;
}

export async function sweepTenant(db: Database, now: Date = new Date()): Promise<TenantSweepResult> {
  const result: TenantSweepResult = { overdue: 0, recurringGenerated: 0, recurringFailed: 0, fxRates: 0 };

  const overdue = await db
    .update(schema.invoices)
    .set({ status: 'overdue', updatedAt: now })
    .where(
      and(
        eq(schema.invoices.status, 'sent'),
        isNull(schema.invoices.deletedAt),
        lt(schema.invoices.dueDate, now),
        gt(sql`coalesce(${schema.invoices.balanceDue}, '0')::numeric`, 0),
        inArray(schema.invoices.type, ['standard', 'correction']),
      ),
    )
    .returning({ id: schema.invoices.id });
  result.overdue = overdue.length;

  const due = await db
    .select()
    .from(schema.recurringInvoices)
    .where(
      and(
        eq(schema.recurringInvoices.status, 'active'),
        isNull(schema.recurringInvoices.deletedAt),
        lte(schema.recurringInvoices.nextIssueDate, now),
      ),
    );
  for (const rec of due) {
    try {
      const generated = await generateRecurringInvoice(db, rec, { userId: null, now });
      result.recurringGenerated += 1;
      if (generated.finalizeError) {
        console.warn(`[books-sweep] recurring ${rec.id}: invoice ${generated.invoiceNumber} left as draft: ${generated.finalizeError}`);
      }
    } catch (err) {
      if (err instanceof RecurringAlreadyGeneratedError) continue;
      result.recurringFailed += 1;
      console.error(`[books-sweep] recurring ${rec.id} failed:`, err instanceof Error ? err.message : err);
    }
  }

  const [anyEntity] = await db
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(isNull(schema.entities.deletedAt))
    .limit(1);
  if (anyEntity) {
    try {
      result.fxRates = await persistDailyEcbRates(db, now);
    } catch (err) {
      console.warn('[books-sweep] FX rates not stored:', err instanceof Error ? err.message : err);
    }
  }

  return result;
}

export async function runBooksDailySweep(env: Env, now: Date = new Date()): Promise<{ tenants: number; failed: number }> {
  const started = Date.now();
  let tenants = 0;
  let failed = 0;
  let cursor: string | undefined;

  do {
    const page = await env.WORKSPACE_CACHE.list({ prefix: BOOKS_ACTIVE_PREFIX, cursor });
    for (const key of page.keys) {
      if (Date.now() - started > SWEEP_BUDGET_MS) {
        console.warn(`[books-sweep] time budget reached after ${tenants} tenants; the rest run tomorrow`);
        return { tenants, failed };
      }
      const clerkOrgId = key.name.slice(BOOKS_ACTIVE_PREFIX.length);
      try {
        const db = (await getTenantDbForWorkspace(env, clerkOrgId)) as unknown as Database;
        const result = await sweepTenant(db, now);
        tenants += 1;
        if (result.overdue || result.recurringGenerated || result.recurringFailed) {
          console.log(`[books-sweep] ${clerkOrgId}: ${JSON.stringify(result)}`);
        }
      } catch (err) {
        failed += 1;
        console.error(`[books-sweep] ${clerkOrgId} failed:`, err instanceof Error ? err.message : err);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  console.log(`[books-sweep] done: ${tenants} tenants, ${failed} failed`);
  return { tenants, failed };
}
