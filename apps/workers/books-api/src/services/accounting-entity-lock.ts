/**
 * Which settings of an entity are frozen because the books already rest on
 * them. Base currency and jurisdiction decide how every posted amount and tax
 * line was computed, and the fiscal-year start decides where the periods lie;
 * changing them after the fact would silently re-interpret history.
 *
 * "Postings" means any finalized record: a journal entry that is not a draft,
 * an invoice or bill that is not a draft, a payment, or a VAT return that is
 * not a draft. Soft-deleted rows do not count.
 */

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export interface EntityLockState {
  /** The entity has finalized transactions. */
  hasPostings: boolean;
  /** Fiscal periods have been generated for the entity. */
  hasFiscalPeriods: boolean;
  /** Base currency and jurisdiction can no longer change. */
  baseSettingsLocked: boolean;
  /** The fiscal-year start can no longer change. */
  fiscalYearLocked: boolean;
}

const count = sql<number>`count(*)::int`;

async function nonZero(query: PromiseLike<Array<{ n: number }>>): Promise<boolean> {
  const [row] = await query;
  return Number(row?.n ?? 0) > 0;
}

export async function entityHasPostings(db: Database, entityId: string): Promise<boolean> {
  const checks = await Promise.all([
    nonZero(
      db
        .select({ n: count })
        .from(schema.journalEntries)
        .where(
          and(
            eq(schema.journalEntries.entityId, entityId),
            ne(schema.journalEntries.status, 'draft'),
            isNull(schema.journalEntries.deletedAt),
          ),
        ),
    ),
    nonZero(
      db
        .select({ n: count })
        .from(schema.invoices)
        .where(
          and(eq(schema.invoices.entityId, entityId), ne(schema.invoices.status, 'draft'), isNull(schema.invoices.deletedAt)),
        ),
    ),
    nonZero(
      db
        .select({ n: count })
        .from(schema.bills)
        .where(and(eq(schema.bills.entityId, entityId), ne(schema.bills.status, 'draft'), isNull(schema.bills.deletedAt))),
    ),
    nonZero(
      db
        .select({ n: count })
        .from(schema.payments)
        .where(and(eq(schema.payments.entityId, entityId), isNull(schema.payments.deletedAt))),
    ),
    nonZero(
      db
        .select({ n: count })
        .from(schema.vatReturns)
        .where(
          and(
            eq(schema.vatReturns.entityId, entityId),
            ne(schema.vatReturns.status, 'draft'),
            isNull(schema.vatReturns.deletedAt),
          ),
        ),
    ),
  ]);
  return checks.some(Boolean);
}

export async function entityHasFiscalPeriods(db: Database, entityId: string): Promise<boolean> {
  return nonZero(
    db
      .select({ n: count })
      .from(schema.fiscalPeriods)
      .where(and(eq(schema.fiscalPeriods.entityId, entityId), isNull(schema.fiscalPeriods.deletedAt))),
  );
}

export async function getEntityLockState(db: Database, entityId: string): Promise<EntityLockState> {
  const [hasPostings, hasFiscalPeriods] = await Promise.all([
    entityHasPostings(db, entityId),
    entityHasFiscalPeriods(db, entityId),
  ]);
  return {
    hasPostings,
    hasFiscalPeriods,
    baseSettingsLocked: hasPostings,
    fiscalYearLocked: hasPostings || hasFiscalPeriods,
  };
}
