/**
 * Manual sales tax engine: tax zones. /api/sales-tax-zones/*
 *
 * A zone is the set of jurisdictions that apply together to a ZIP code (or a
 * ZIP range): the state, county, city and district taxes of one address. The
 * zone marked `isOrigin` is the entity's own location, used for origin-sourced
 * intrastate sales. All of a zone's jurisdictions belong to its agency, so to
 * one state.
 *
 * Permissions: taxes:read | taxes:create | taxes:update | taxes:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { salesTaxErrorResponse, SalesTaxSetupError } from '../../services/sales-tax/errors';
import { optionalSalesTaxEntity, pageParams, requireAgency, requireSalesTaxEntity } from '../../services/sales-tax/route-helpers';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type ZoneRow = typeof schema.salesTaxZones.$inferSelect;

const zip5 = z.string().regex(/^\d{5}$/, 'A ZIP code is five digits');
const postalCodeSchema = z.union([zip5, z.object({ from: zip5, to: zip5 })]);

const createZoneSchema = z.object({
  agencyId: z.string().min(1).max(30),
  name: z.string().min(1).max(255),
  jurisdictionIds: z.array(z.string().min(1).max(30)).min(1),
  postalCodes: z.array(postalCodeSchema).max(5000).optional(),
  isOrigin: z.boolean().optional(),
  priority: z.number().int().min(0).max(10000).optional(),
});

const updateZoneSchema = createZoneSchema.omit({ agencyId: true }).partial();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** ZIP ranges run low to high. */
function checkRanges(codes: Array<string | { from: string; to: string }> | undefined): void {
  for (const code of codes ?? []) {
    if (typeof code !== 'string' && code.from > code.to) {
      throw new SalesTaxSetupError(`The ZIP range ${code.from}-${code.to} runs backwards`);
    }
  }
}

/** The zone's jurisdictions must be live jurisdictions of its own agency. */
async function checkJurisdictions(db: Database, entityId: string, agencyId: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  const rows = await db
    .select({ id: schema.salesTaxJurisdictions.id, agencyId: schema.salesTaxJurisdictions.agencyId })
    .from(schema.salesTaxJurisdictions)
    .where(
      and(
        eq(schema.salesTaxJurisdictions.entityId, entityId),
        inArray(schema.salesTaxJurisdictions.id, unique),
        isNull(schema.salesTaxJurisdictions.deletedAt),
      ),
    );
  const found = new Map(rows.map((r) => [r.id, r.agencyId]));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) throw new SalesTaxSetupError(`Jurisdiction ${missing.join(', ')} does not exist`);
  const foreign = unique.filter((id) => found.get(id) !== agencyId);
  if (foreign.length > 0) {
    throw new SalesTaxSetupError(
      `A zone can only combine jurisdictions of its own agency (state). ${foreign.join(', ')} belong${foreign.length > 1 ? '' : 's'} to another one.`,
    );
  }
}

/** The zone with its jurisdictions' names, levels and the combined rate in force today. */
async function presentZones(db: Database, entityId: string, zones: ZoneRow[]) {
  const ids = [...new Set(zones.flatMap((z) => z.jurisdictionIds))];
  const jurisdictions =
    ids.length > 0
      ? await db
          .select({
            id: schema.salesTaxJurisdictions.id,
            name: schema.salesTaxJurisdictions.name,
            level: schema.salesTaxJurisdictions.level,
          })
          .from(schema.salesTaxJurisdictions)
          .where(and(eq(schema.salesTaxJurisdictions.entityId, entityId), inArray(schema.salesTaxJurisdictions.id, ids)))
      : [];
  const rates =
    ids.length > 0
      ? await db
          .select()
          .from(schema.salesTaxJurisdictionRates)
          .where(
            and(
              eq(schema.salesTaxJurisdictionRates.entityId, entityId),
              inArray(schema.salesTaxJurisdictionRates.jurisdictionId, ids),
              isNull(schema.salesTaxJurisdictionRates.deletedAt),
            ),
          )
      : [];
  const day = today();
  const currentRate = new Map<string, number>();
  for (const rate of rates) {
    if (rate.effectiveFrom <= day && (!rate.effectiveTo || rate.effectiveTo >= day)) {
      currentRate.set(rate.jurisdictionId, Number(rate.rate));
    }
  }
  const byId = new Map(jurisdictions.map((j) => [j.id, j]));
  return zones.map((zone) => {
    const parts = zone.jurisdictionIds
      .map((id) => ({ ...(byId.get(id) ?? { id, name: id, level: 'district' }), currentRate: currentRate.get(id) ?? null }))
      .filter((p) => p.name);
    const combinedRate = Math.round(parts.reduce((sum, p) => sum + (p.currentRate ?? 0), 0) * 10000) / 10000;
    return { ...zone, jurisdictions: parts, combinedRate };
  });
}

async function requireZone(db: Database, entityId: string, id: string): Promise<ZoneRow> {
  const [row] = await db
    .select()
    .from(schema.salesTaxZones)
    .where(and(eq(schema.salesTaxZones.id, id), eq(schema.salesTaxZones.entityId, entityId), isNull(schema.salesTaxZones.deletedAt)))
    .limit(1);
  if (!row) throw new SalesTaxSetupError(`Sales tax zone ${id} not found`, 404);
  return row;
}

function eventData(zone: ZoneRow) {
  return { id: zone.id, agencyId: zone.agencyId, stateCode: zone.stateCode, name: zone.name, isOrigin: zone.isOrigin };
}

// GET / — ?agencyId=&stateCode=
app.get('/', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const t = schema.salesTaxZones;
  try {
    const entity = await optionalSalesTaxEntity(c, db);
    if (!entity) return list(c, [], cursorPagination(0, false, null));
    const { page, pageSize, offset } = pageParams(c);
    const conditions: SQL[] = [eq(t.entityId, entity.id), isNull(t.deletedAt)];
    const agencyId = c.req.query('agencyId');
    if (agencyId) conditions.push(eq(t.agencyId, agencyId));
    const stateCode = c.req.query('stateCode');
    if (stateCode) conditions.push(eq(t.stateCode, stateCode.toUpperCase()));

    const where = and(...conditions);
    const [rows, count] = await Promise.all([
      db.select().from(t).where(where).orderBy(asc(t.stateCode), asc(t.priority), asc(t.name)).limit(pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const totalCount = Number(count[0]?.count ?? 0);
    return list(c, await presentZones(db, entity.id, rows), cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-zones] list failed:', err);
    return error.internal(c, 'Failed to fetch sales tax zones');
  }
});

// GET /:id
app.get('/:id', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const zone = await requireZone(db, entity.id, c.req.param('id'));
    return success(c, (await presentZones(db, entity.id, [zone]))[0]);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-zones] get failed:', err);
    return error.internal(c, 'Failed to fetch sales tax zone');
  }
});

// POST /
app.post('/', requirePermission('taxes:create'), zValidator('json', createZoneSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const agency = await requireAgency(db, entity.id, data.agencyId);
    checkRanges(data.postalCodes);
    await checkJurisdictions(db, entity.id, agency.id, data.jurisdictionIds);

    const now = new Date();
    const zone = {
      id: generateId('stz'),
      entityId: entity.id,
      agencyId: agency.id,
      stateCode: agency.stateCode,
      name: data.name.trim(),
      jurisdictionIds: [...new Set(data.jurisdictionIds)],
      postalCodes: data.postalCodes ?? [],
      isOrigin: data.isOrigin ?? false,
      priority: data.priority ?? 100,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.salesTaxZones).values(zone);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_zone',
      entityId: zone.id,
      action: 'created',
    });
    publishEntityEvent({ c, entityType: 'sales_tax_zone', entityId: zone.id, action: 'created', data: eventData(zone as ZoneRow) });
    return success(c, (await presentZones(db, entity.id, [zone as ZoneRow]))[0], 201);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-zones] create failed:', err);
    return error.internal(c, 'Failed to create sales tax zone');
  }
});

// PUT/PATCH /:id
app.on(['PUT', 'PATCH'], '/:id', requirePermission('taxes:update'), zValidator('json', updateZoneSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const zone = await requireZone(db, entity.id, c.req.param('id'));
    checkRanges(data.postalCodes);
    if (data.jurisdictionIds) await checkJurisdictions(db, entity.id, zone.agencyId, data.jurisdictionIds);

    const update: Partial<ZoneRow> = { updatedAt: new Date() };
    if (data.name !== undefined) update.name = data.name.trim();
    if (data.jurisdictionIds !== undefined) update.jurisdictionIds = [...new Set(data.jurisdictionIds)];
    if (data.postalCodes !== undefined) update.postalCodes = data.postalCodes;
    if (data.isOrigin !== undefined) update.isOrigin = data.isOrigin;
    if (data.priority !== undefined) update.priority = data.priority;
    await db.update(schema.salesTaxZones).set(update).where(eq(schema.salesTaxZones.id, zone.id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_zone',
      entityId: zone.id,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(update)
          .filter(([k]) => k !== 'updatedAt')
          .map(([k, v]) => [k, { old: (zone as Record<string, unknown>)[k], new: v }]),
      ),
    });
    const updated = { ...zone, ...update };
    publishEntityEvent({ c, entityType: 'sales_tax_zone', entityId: zone.id, action: 'updated', data: eventData(updated) });
    return success(c, (await presentZones(db, entity.id, [updated]))[0]);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-zones] update failed:', err);
    return error.internal(c, 'Failed to update sales tax zone');
  }
});

// DELETE /:id
app.delete('/:id', requirePermission('taxes:delete'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const zone = await requireZone(db, entity.id, c.req.param('id'));
    const now = new Date();
    await db.update(schema.salesTaxZones).set({ deletedAt: now, updatedAt: now }).where(eq(schema.salesTaxZones.id, zone.id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_zone',
      entityId: zone.id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'sales_tax_zone', entityId: zone.id, action: 'deleted', data: eventData(zone) });
    return noContent(c);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-zones] delete failed:', err);
    return error.internal(c, 'Failed to delete sales tax zone');
  }
});

export const salesTaxZonesRoutes = app;
