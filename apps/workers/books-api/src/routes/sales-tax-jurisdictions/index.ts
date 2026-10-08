/**
 * Manual sales tax engine: taxing jurisdictions (state, county, city, special
 * district) and their dated rates. /api/sales-tax-jurisdictions/*
 *
 * A jurisdiction belongs to an agency (and so to a state). Its rate is picked
 * by the document's tax point, never today's date, so rates only ever get new
 * rows with new dates: ranges of one jurisdiction never overlap.
 *
 * Permissions: taxes:read | taxes:create | taxes:update | taxes:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { salesTaxErrorResponse, SalesTaxSetupError } from '../../services/sales-tax/errors';
import {
  checkDateOrder,
  dayBefore,
  isoDateSchema,
  optionalSalesTaxEntity,
  pageParams,
  percentSchema,
  rangesOverlap,
  requireAgency,
  requireSalesTaxEntity,
} from '../../services/sales-tax/route-helpers';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type JurisdictionRow = typeof schema.salesTaxJurisdictions.$inferSelect;
type RateRow = typeof schema.salesTaxJurisdictionRates.$inferSelect;

const levelSchema = z.enum(['state', 'county', 'city', 'district']);

const rateBodySchema = z.object({
  rate: percentSchema,
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullish(),
});

const createJurisdictionSchema = z.object({
  agencyId: z.string().min(1).max(30),
  level: levelSchema,
  name: z.string().min(1).max(255),
  code: z.string().max(30).nullish(),
  reportingCode: z.string().max(30).nullish(),
  isActive: z.boolean().optional(),
  /** The first rate, as a convenience. */
  rate: rateBodySchema.optional(),
});

const updateJurisdictionSchema = z
  .object({
    level: levelSchema,
    name: z.string().min(1).max(255),
    code: z.string().max(30).nullish(),
    reportingCode: z.string().max(30).nullish(),
    isActive: z.boolean(),
  })
  .partial();

const createRateSchema = rateBodySchema.extend({
  /** End the open-ended rate in force before this one the day before it starts. */
  closePrevious: z.boolean().optional(),
});

const updateRateSchema = rateBodySchema.partial();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The rate in force on a day (the latest start wins); null when none is. */
function rateOn(rates: RateRow[], day: string): RateRow | null {
  return (
    rates
      .filter((r) => r.effectiveFrom <= day && (!r.effectiveTo || r.effectiveTo >= day))
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null
  );
}

async function loadRates(db: Database, entityId: string, jurisdictionIds: string[]): Promise<Map<string, RateRow[]>> {
  const byJurisdiction = new Map<string, RateRow[]>();
  if (jurisdictionIds.length === 0) return byJurisdiction;
  const rows = await db
    .select()
    .from(schema.salesTaxJurisdictionRates)
    .where(
      and(
        eq(schema.salesTaxJurisdictionRates.entityId, entityId),
        inArray(schema.salesTaxJurisdictionRates.jurisdictionId, jurisdictionIds),
        isNull(schema.salesTaxJurisdictionRates.deletedAt),
      ),
    )
    .orderBy(desc(schema.salesTaxJurisdictionRates.effectiveFrom));
  for (const row of rows) {
    const list = byJurisdiction.get(row.jurisdictionId);
    if (list) list.push(row);
    else byJurisdiction.set(row.jurisdictionId, [row]);
  }
  return byJurisdiction;
}

function present(row: JurisdictionRow, rates: RateRow[]) {
  const current = rateOn(rates, today());
  return { ...row, currentRate: current ? Number(current.rate) : null, rates };
}

async function requireJurisdiction(db: Database, entityId: string, id: string): Promise<JurisdictionRow> {
  const [row] = await db
    .select()
    .from(schema.salesTaxJurisdictions)
    .where(
      and(
        eq(schema.salesTaxJurisdictions.id, id),
        eq(schema.salesTaxJurisdictions.entityId, entityId),
        isNull(schema.salesTaxJurisdictions.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new SalesTaxSetupError(`Sales tax jurisdiction ${id} not found`, 404);
  return row;
}

/** No two rates of a jurisdiction cover the same day. */
function assertNoOverlap(
  existing: RateRow[],
  candidate: { from: string; to?: string | null },
  ignoreId?: string,
): void {
  const clash = existing.find((r) => r.id !== ignoreId && rangesOverlap({ from: r.effectiveFrom, to: r.effectiveTo }, candidate));
  if (clash) {
    throw new SalesTaxSetupError(
      `This rate overlaps the ${Number(clash.rate)}% rate that applies from ${clash.effectiveFrom}${clash.effectiveTo ? ` to ${clash.effectiveTo}` : ' onward'}. End that rate first, or use closePrevious.`,
      409,
    );
  }
}

function eventData(row: JurisdictionRow, currentRate?: number | null) {
  return { id: row.id, agencyId: row.agencyId, stateCode: row.stateCode, level: row.level, name: row.name, currentRate: currentRate ?? null };
}

// GET / — ?agencyId=&stateCode=&level=
app.get('/', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const t = schema.salesTaxJurisdictions;
  try {
    const entity = await optionalSalesTaxEntity(c, db);
    if (!entity) return list(c, [], cursorPagination(0, false, null));
    const { page, pageSize, offset } = pageParams(c);

    const conditions: SQL[] = [eq(t.entityId, entity.id), isNull(t.deletedAt)];
    const agencyId = c.req.query('agencyId');
    if (agencyId) conditions.push(eq(t.agencyId, agencyId));
    const stateCode = c.req.query('stateCode');
    if (stateCode) conditions.push(eq(t.stateCode, stateCode.toUpperCase()));
    const level = c.req.query('level');
    if (level) conditions.push(eq(t.level, level));

    const where = and(...conditions);
    const [rows, count] = await Promise.all([
      db.select().from(t).where(where).orderBy(asc(t.stateCode), asc(t.level), asc(t.name)).limit(pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const rates = await loadRates(db, entity.id, rows.map((r) => r.id));
    const totalCount = Number(count[0]?.count ?? 0);
    return list(
      c,
      rows.map((row) => present(row, rates.get(row.id) ?? [])),
      cursorPagination(totalCount, page * pageSize < totalCount, null),
    );
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-jurisdictions] list failed:', err);
    return error.internal(c, 'Failed to fetch sales tax jurisdictions');
  }
});

// GET /:id — with all its rates
app.get('/:id', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const row = await requireJurisdiction(db, entity.id, c.req.param('id'));
    const rates = await loadRates(db, entity.id, [row.id]);
    return success(c, present(row, rates.get(row.id) ?? []));
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-jurisdictions] get failed:', err);
    return error.internal(c, 'Failed to fetch sales tax jurisdiction');
  }
});

// POST / — add a jurisdiction (optionally with its first rate)
app.post('/', requirePermission('taxes:create'), zValidator('json', createJurisdictionSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const agency = await requireAgency(db, entity.id, data.agencyId);
    if (data.rate) checkDateOrder(data.rate.effectiveFrom, data.rate.effectiveTo, 'the rate');

    const now = new Date();
    const jurisdiction = {
      id: generateId('stj'),
      entityId: entity.id,
      agencyId: agency.id,
      stateCode: agency.stateCode,
      level: data.level,
      code: data.code ?? null,
      name: data.name.trim(),
      reportingCode: data.reportingCode ?? null,
      isActive: data.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };
    const rate = data.rate
      ? {
          id: generateId('stjr'),
          entityId: entity.id,
          jurisdictionId: jurisdiction.id,
          rate: data.rate.rate.toFixed(4),
          effectiveFrom: data.rate.effectiveFrom,
          effectiveTo: data.rate.effectiveTo ?? null,
          createdAt: now,
          updatedAt: now,
        }
      : null;
    await atomically(db, (h) => [
      h.insert(schema.salesTaxJurisdictions).values(jurisdiction),
      ...(rate ? [h.insert(schema.salesTaxJurisdictionRates).values(rate)] : []),
    ]);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_jurisdiction',
      entityId: jurisdiction.id,
      action: 'created',
    });
    publishEntityEvent({
      c,
      entityType: 'sales_tax_jurisdiction',
      entityId: jurisdiction.id,
      action: 'created',
      data: eventData(jurisdiction as JurisdictionRow, rate ? Number(rate.rate) : null),
    });
    return success(c, present(jurisdiction as JurisdictionRow, rate ? [rate as RateRow] : []), 201);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-jurisdictions] create failed:', err);
    return error.internal(c, 'Failed to create sales tax jurisdiction');
  }
});

// PUT/PATCH /:id
app.on(['PUT', 'PATCH'], '/:id', requirePermission('taxes:update'), zValidator('json', updateJurisdictionSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const row = await requireJurisdiction(db, entity.id, c.req.param('id'));
    const update: Partial<JurisdictionRow> = { updatedAt: new Date() };
    if (data.level !== undefined) update.level = data.level;
    if (data.name !== undefined) update.name = data.name.trim();
    if (data.code !== undefined) update.code = data.code ?? null;
    if (data.reportingCode !== undefined) update.reportingCode = data.reportingCode ?? null;
    if (data.isActive !== undefined) update.isActive = data.isActive;
    await db.update(schema.salesTaxJurisdictions).set(update).where(eq(schema.salesTaxJurisdictions.id, row.id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_jurisdiction',
      entityId: row.id,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(update)
          .filter(([k]) => k !== 'updatedAt')
          .map(([k, v]) => [k, { old: (row as Record<string, unknown>)[k], new: v }]),
      ),
    });
    const updated = { ...row, ...update };
    publishEntityEvent({ c, entityType: 'sales_tax_jurisdiction', entityId: row.id, action: 'updated', data: eventData(updated) });
    const rates = await loadRates(db, entity.id, [row.id]);
    return success(c, present(updated, rates.get(row.id) ?? []));
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-jurisdictions] update failed:', err);
    return error.internal(c, 'Failed to update sales tax jurisdiction');
  }
});

// DELETE /:id — soft delete with its rates; refused while a zone still uses it
app.delete('/:id', requirePermission('taxes:delete'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const row = await requireJurisdiction(db, entity.id, c.req.param('id'));

    const zones = await db
      .select({ id: schema.salesTaxZones.id, name: schema.salesTaxZones.name, jurisdictionIds: schema.salesTaxZones.jurisdictionIds })
      .from(schema.salesTaxZones)
      .where(and(eq(schema.salesTaxZones.agencyId, row.agencyId), isNull(schema.salesTaxZones.deletedAt)));
    const using = zones.filter((z) => z.jurisdictionIds.includes(row.id));
    if (using.length > 0) {
      throw new SalesTaxSetupError(
        `This jurisdiction is part of the tax zone${using.length > 1 ? 's' : ''} ${using.map((z) => `"${z.name}"`).join(', ')}. Remove it from ${using.length > 1 ? 'them' : 'it'} first.`,
        409,
      );
    }

    const now = new Date();
    await atomically(db, (h) => [
      h.update(schema.salesTaxJurisdictionRates).set({ deletedAt: now }).where(eq(schema.salesTaxJurisdictionRates.jurisdictionId, row.id)),
      h.update(schema.salesTaxJurisdictions).set({ deletedAt: now, updatedAt: now }).where(eq(schema.salesTaxJurisdictions.id, row.id)),
    ]);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_jurisdiction',
      entityId: row.id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'sales_tax_jurisdiction', entityId: row.id, action: 'deleted', data: eventData(row) });
    return noContent(c);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-jurisdictions] delete failed:', err);
    return error.internal(c, 'Failed to delete sales tax jurisdiction');
  }
});

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

// GET /:id/rates
app.get('/:id/rates', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const row = await requireJurisdiction(db, entity.id, c.req.param('id'));
    const rates = (await loadRates(db, entity.id, [row.id])).get(row.id) ?? [];
    return list(c, rates, cursorPagination(rates.length, false, null));
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-jurisdictions] list rates failed:', err);
    return error.internal(c, 'Failed to fetch rates');
  }
});

// POST /:id/rates — a rate from a date (closePrevious ends the open-ended one before it)
app.post('/:id/rates', requirePermission('taxes:create'), zValidator('json', createRateSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const row = await requireJurisdiction(db, entity.id, c.req.param('id'));
    checkDateOrder(data.effectiveFrom, data.effectiveTo, 'the rate');
    const existing = (await loadRates(db, entity.id, [row.id])).get(row.id) ?? [];

    const closing: RateRow[] = [];
    if (data.closePrevious) {
      const open = existing.find((r) => !r.effectiveTo && r.effectiveFrom < data.effectiveFrom);
      if (open) closing.push({ ...open, effectiveTo: dayBefore(data.effectiveFrom) });
    }
    const others = existing.filter((r) => !closing.some((x) => x.id === r.id));
    assertNoOverlap([...others, ...closing], { from: data.effectiveFrom, to: data.effectiveTo });

    const now = new Date();
    const rate = {
      id: generateId('stjr'),
      entityId: entity.id,
      jurisdictionId: row.id,
      rate: data.rate.toFixed(4),
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await atomically(db, (h) => [
      ...closing.map((r) =>
        h
          .update(schema.salesTaxJurisdictionRates)
          .set({ effectiveTo: r.effectiveTo, updatedAt: now })
          .where(eq(schema.salesTaxJurisdictionRates.id, r.id)),
      ),
      h.insert(schema.salesTaxJurisdictionRates).values(rate),
    ]);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_jurisdiction',
      entityId: row.id,
      action: 'rate_added',
      changes: { rate: { old: null, new: rate.rate }, effectiveFrom: { old: null, new: rate.effectiveFrom } },
    });
    publishEntityEvent({ c, entityType: 'sales_tax_jurisdiction', entityId: row.id, action: 'updated', data: eventData(row, data.rate) });
    return success(c, rate, 201);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-jurisdictions] add rate failed:', err);
    return error.internal(c, 'Failed to add rate');
  }
});

// PATCH /:id/rates/:rateId
app.patch('/:id/rates/:rateId', requirePermission('taxes:update'), zValidator('json', updateRateSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const row = await requireJurisdiction(db, entity.id, c.req.param('id'));
    const existing = (await loadRates(db, entity.id, [row.id])).get(row.id) ?? [];
    const rate = existing.find((r) => r.id === c.req.param('rateId'));
    if (!rate) throw new SalesTaxSetupError(`Rate ${c.req.param('rateId')} not found`, 404);

    const from = data.effectiveFrom ?? rate.effectiveFrom;
    const to = data.effectiveTo === undefined ? rate.effectiveTo : data.effectiveTo;
    checkDateOrder(from, to, 'the rate');
    assertNoOverlap(existing, { from, to }, rate.id);

    const update = {
      ...(data.rate !== undefined ? { rate: data.rate.toFixed(4) } : {}),
      effectiveFrom: from,
      effectiveTo: to ?? null,
      updatedAt: new Date(),
    };
    await db.update(schema.salesTaxJurisdictionRates).set(update).where(eq(schema.salesTaxJurisdictionRates.id, rate.id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_jurisdiction',
      entityId: row.id,
      action: 'rate_updated',
      changes: Object.fromEntries(
        Object.entries(update)
          .filter(([k]) => k !== 'updatedAt')
          .map(([k, v]) => [k, { old: (rate as Record<string, unknown>)[k], new: v }]),
      ),
    });
    publishEntityEvent({ c, entityType: 'sales_tax_jurisdiction', entityId: row.id, action: 'updated', data: eventData(row) });
    return success(c, { ...rate, ...update });
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-jurisdictions] update rate failed:', err);
    return error.internal(c, 'Failed to update rate');
  }
});

// DELETE /:id/rates/:rateId
app.delete('/:id/rates/:rateId', requirePermission('taxes:delete'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const row = await requireJurisdiction(db, entity.id, c.req.param('id'));
    const existing = (await loadRates(db, entity.id, [row.id])).get(row.id) ?? [];
    const rate = existing.find((r) => r.id === c.req.param('rateId'));
    if (!rate) throw new SalesTaxSetupError(`Rate ${c.req.param('rateId')} not found`, 404);

    const now = new Date();
    await db
      .update(schema.salesTaxJurisdictionRates)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.salesTaxJurisdictionRates.id, rate.id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_jurisdiction',
      entityId: row.id,
      action: 'rate_deleted',
      changes: { rate: { old: rate.rate, new: null } },
    });
    publishEntityEvent({ c, entityType: 'sales_tax_jurisdiction', entityId: row.id, action: 'updated', data: eventData(row) });
    return noContent(c);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-jurisdictions] delete rate failed:', err);
    return error.internal(c, 'Failed to delete rate');
  }
});

export const salesTaxJurisdictionsRoutes = app;
