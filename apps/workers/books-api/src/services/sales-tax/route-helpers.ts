/**
 * Small pieces the sales tax setup routes share: the entity of the request,
 * paging, date and percent validation.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { and, eq, isNull } from 'drizzle-orm';
import { getAdapter, hasAdapter } from '@weldsuite/books-domain/jurisdictions/registry';
import { resolveEntityId } from '../../lib/entity-context';
import { SalesTaxSetupError } from './errors';

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date as YYYY-MM-DD');

/** A percentage with up to four decimals, 0 to 100. Numbers and numeric strings both work. */
export const percentSchema = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === 'number' ? value : Number.parseFloat(value)))
  .refine((value) => Number.isFinite(value) && value >= 0 && value <= 100, 'A rate is a percentage from 0 to 100');

export function pageParams(c: Context): { page: number; pageSize: number; offset: number } {
  const page = Math.max(Number.parseInt(c.req.query('page') || '1', 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(c.req.query('pageSize') || '50', 10) || 50, 1), 200);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** The accounting entity of the request; the sales tax objects exist per entity. */
export async function requireEntityId(c: Context, db: Database): Promise<string> {
  const entityId = await resolveEntityId(c, db);
  if (!entityId) {
    throw new SalesTaxSetupError('No accounting entity resolved. Set X-Accounting-Entity-Id or configure a default entity.');
  }
  return entityId;
}

/** The entity row, and a check that its jurisdiction has sales tax at all. */
export async function requireSalesTaxEntity(c: Context, db: Database) {
  const entityId = await requireEntityId(c, db);
  const [entity] = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  if (!entity) throw new SalesTaxSetupError(`Accounting entity ${entityId} not found`, 404);
  if (!hasAdapter(entity.jurisdictionCode) || !getAdapter(entity.jurisdictionCode).features.salesTax) {
    throw new SalesTaxSetupError('Sales tax is only available for United States accounting entities');
  }
  return entity;
}

/** Like `requireSalesTaxEntity`, but a tenant with no accounting entity yet has simply nothing to list. */
export async function optionalSalesTaxEntity(c: Context, db: Database) {
  if (!(await resolveEntityId(c, db))) return null;
  return requireSalesTaxEntity(c, db);
}

/** An agency of this entity, or a 404. */
export async function requireAgency(db: Database, entityId: string, agencyId: string) {
  const [agency] = await db
    .select()
    .from(schema.salesTaxAgencies)
    .where(
      and(
        eq(schema.salesTaxAgencies.id, agencyId),
        eq(schema.salesTaxAgencies.entityId, entityId),
        isNull(schema.salesTaxAgencies.deletedAt),
      ),
    )
    .limit(1);
  if (!agency) throw new SalesTaxSetupError(`Sales tax agency ${agencyId} not found`, 404);
  return agency;
}

/** Two inclusive date ranges overlap (an empty `to` is open-ended). */
export function rangesOverlap(
  a: { from: string; to?: string | null },
  b: { from: string; to?: string | null },
): boolean {
  const aEnd = a.to ?? '9999-12-31';
  const bEnd = b.to ?? '9999-12-31';
  return a.from <= bEnd && b.from <= aEnd;
}

/** The day before an ISO date. */
export function dayBefore(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function checkDateOrder(from: string, to: string | null | undefined, what: string): void {
  if (to && to < from) throw new SalesTaxSetupError(`The end date of ${what} is before its start date`);
}
