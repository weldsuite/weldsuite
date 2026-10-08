/**
 * Sales tax agencies: the states (and self-administered local agencies) an
 * entity is registered with or monitors. /api/sales-tax-agencies/*
 *
 * - Creating an agency validates the state, fills in the state's defaults
 *   (name, portal, due day, SST), creates its child payable accounts under
 *   Sales Tax Payable and Use Tax Payable and seeds its shipping/handling
 *   taxability rules.
 * - Tax is charged only while an agency's status is `registered` and the
 *   document date is inside its registration dates.
 * - An agency that carries tax-ledger rows is closed, never deleted.
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
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema } from '@weldsuite/worker-kit/db';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import {
  agencyHasTaxLines,
  createSalesTaxAgency,
  resolveAgencyFields,
} from '../../services/sales-tax/agencies';
import { salesTaxErrorResponse } from '../../services/sales-tax/errors';
import {
  isoDateSchema,
  optionalSalesTaxEntity,
  pageParams,
  requireAgency,
  requireSalesTaxEntity,
} from '../../services/sales-tax/route-helpers';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const statusSchema = z.enum(['registered', 'pending', 'monitoring', 'closed']);
const frequencySchema = z.enum(['monthly', 'quarterly', 'semiannual', 'annual']);

const createAgencySchema = z.object({
  stateCode: z.string().length(2),
  level: z.enum(['state', 'local']).optional(),
  localJurisdictionCode: z.string().max(30).nullish(),
  name: z.string().min(1).max(255).optional(),
  registrationNumber: z.string().max(100).nullish(),
  registeredFrom: isoDateSchema.nullish(),
  registeredUntil: isoDateSchema.nullish(),
  status: statusSchema.optional(),
  filingFrequency: frequencySchema.optional(),
  firstPeriodStart: isoDateSchema.nullish(),
  dueDay: z.number().int().min(1).max(31).optional(),
  reportingBasis: z.enum(['accrual', 'cash']).optional(),
  sstMember: z.boolean().optional(),
  portalUrl: z.string().url().max(500).nullish(),
  notes: z.string().max(5000).nullish(),
});

// The state and level of an agency never change; everything else can.
const updateAgencySchema = createAgencySchema
  .omit({ stateCode: true, level: true, localJurisdictionCode: true })
  .extend({ providerRegistrationRef: z.string().max(255).nullish() })
  .partial();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** What events carry: no registration number. */
function eventData(agency: typeof schema.salesTaxAgencies.$inferSelect) {
  return {
    id: agency.id,
    stateCode: agency.stateCode,
    level: agency.level,
    name: agency.name,
    status: agency.status,
    filingFrequency: agency.filingFrequency,
  };
}

/** The agency with the accounts its liabilities are booked to. */
async function withAccounts<T extends { liabilityAccountId: string | null; useTaxAccountId: string | null }>(
  db: Parameters<typeof requireAgency>[0],
  rows: T[],
) {
  const ids = [...new Set(rows.flatMap((r) => [r.liabilityAccountId, r.useTaxAccountId]).filter((id): id is string => Boolean(id)))];
  const accounts =
    ids.length > 0
      ? await db
          .select({ id: schema.accounts.id, code: schema.accounts.code, name: schema.accounts.name, balance: schema.accounts.currentBalance })
          .from(schema.accounts)
          .where(inArray(schema.accounts.id, ids))
      : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return rows.map((row) => ({
    ...row,
    liabilityAccount: (row.liabilityAccountId && byId.get(row.liabilityAccountId)) || null,
    useTaxAccount: (row.useTaxAccountId && byId.get(row.useTaxAccountId)) || null,
  }));
}

// GET / — agencies of the entity (?status=&stateCode=&level=)
app.get('/', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const t = schema.salesTaxAgencies;
  try {
    const entity = await optionalSalesTaxEntity(c, db);
    if (!entity) return list(c, [], cursorPagination(0, false, null));
    const { page, pageSize, offset } = pageParams(c);

    const conditions: SQL[] = [eq(t.entityId, entity.id), isNull(t.deletedAt)];
    const status = c.req.query('status');
    if (status) conditions.push(eq(t.status, status));
    const stateCode = c.req.query('stateCode');
    if (stateCode) conditions.push(eq(t.stateCode, stateCode.toUpperCase()));
    const level = c.req.query('level');
    if (level) conditions.push(eq(t.level, level));

    const where = and(...conditions);
    const [rows, count] = await Promise.all([
      db.select().from(t).where(where).orderBy(asc(t.stateCode), asc(t.level), asc(t.name)).limit(pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const totalCount = Number(count[0]?.count ?? 0);
    return list(c, await withAccounts(db, rows), cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-agencies] list failed:', err);
    return error.internal(c, 'Failed to fetch sales tax agencies');
  }
});

// GET /:id
app.get('/:id', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const agency = await requireAgency(db, entity.id, c.req.param('id'));
    const [row] = await withAccounts(db, [agency]);
    return success(c, { ...row, hasTaxLines: await agencyHasTaxLines(db, agency.id) });
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-agencies] get failed:', err);
    return error.internal(c, 'Failed to fetch sales tax agency');
  }
});

// POST / — register an agency (creates its payable accounts and seeds shipping rules)
app.post('/', requirePermission('taxes:create'), zValidator('json', createAgencySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const { agency, accountsCreated, rulesSeeded } = await createSalesTaxAgency(db, entity.id, data);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_agency',
      entityId: agency.id,
      action: 'created',
    });
    publishEntityEvent({ c, entityType: 'sales_tax_agency', entityId: agency.id, action: 'created', data: eventData(agency) });

    const [row] = await withAccounts(db, [agency]);
    return success(c, { ...row, accountsCreated, rulesSeeded }, 201);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-agencies] create failed:', err);
    return error.internal(c, 'Failed to create sales tax agency');
  }
});

// PUT/PATCH /:id — status, registration dates, filing setup, notes
app.on(['PUT', 'PATCH'], '/:id', requirePermission('taxes:update'), zValidator('json', updateAgencySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const t = schema.salesTaxAgencies;
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const agency = await requireAgency(db, entity.id, c.req.param('id'));

    // The same checks as at creation, on the merged agency.
    const merged = resolveAgencyFields({
      stateCode: agency.stateCode,
      level: agency.level === 'local' ? 'local' : 'state',
      localJurisdictionCode: agency.localJurisdictionCode,
      name: data.name ?? agency.name,
      registrationNumber: data.registrationNumber === undefined ? agency.registrationNumber : data.registrationNumber,
      registeredFrom: data.registeredFrom === undefined ? agency.registeredFrom : data.registeredFrom,
      registeredUntil: data.registeredUntil === undefined ? agency.registeredUntil : data.registeredUntil,
      status: data.status ?? (agency.status as z.infer<typeof statusSchema>),
      filingFrequency: data.filingFrequency ?? (agency.filingFrequency as z.infer<typeof frequencySchema>),
      firstPeriodStart: data.firstPeriodStart === undefined ? agency.firstPeriodStart : data.firstPeriodStart,
      dueDay: data.dueDay ?? agency.dueDay,
      reportingBasis: data.reportingBasis ?? (agency.reportingBasis as 'accrual' | 'cash'),
      sstMember: data.sstMember ?? agency.sstMember,
      portalUrl: data.portalUrl === undefined ? agency.portalUrl : data.portalUrl,
      notes: data.notes === undefined ? agency.notes : data.notes,
    });

    const update: Partial<typeof agency> = { updatedAt: new Date() };
    if (data.name !== undefined) update.name = merged.name;
    if (data.registrationNumber !== undefined) update.registrationNumber = merged.registrationNumber;
    if (data.registeredFrom !== undefined) update.registeredFrom = merged.registeredFrom;
    if (data.registeredUntil !== undefined) update.registeredUntil = merged.registeredUntil;
    if (data.status !== undefined) update.status = merged.status;
    if (data.filingFrequency !== undefined) update.filingFrequency = merged.filingFrequency;
    if (data.firstPeriodStart !== undefined) update.firstPeriodStart = merged.firstPeriodStart;
    if (data.dueDay !== undefined) update.dueDay = merged.dueDay;
    if (data.reportingBasis !== undefined) update.reportingBasis = merged.reportingBasis;
    if (data.sstMember !== undefined) update.sstMember = merged.sstMember;
    if (data.portalUrl !== undefined) update.portalUrl = merged.portalUrl;
    if (data.notes !== undefined) update.notes = merged.notes;
    if (data.providerRegistrationRef !== undefined) update.providerRegistrationRef = data.providerRegistrationRef ?? null;
    // Closing an agency ends its registration (today, unless a date was given).
    if (data.status === 'closed' && data.registeredUntil === undefined && !agency.registeredUntil) {
      update.registeredUntil = today();
    }
    // Registering again after a close: the old end date no longer applies.
    if (data.status === 'registered' && agency.status === 'closed' && data.registeredUntil === undefined) {
      update.registeredUntil = null;
    }

    await db.update(t).set(update).where(eq(t.id, agency.id));
    const updated = { ...agency, ...update };

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_agency',
      entityId: agency.id,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(update)
          .filter(([k]) => k !== 'updatedAt')
          .map(([k, v]) => [k, { old: (agency as Record<string, unknown>)[k], new: v }]),
      ),
    });
    publishEntityEvent({ c, entityType: 'sales_tax_agency', entityId: agency.id, action: 'updated', data: eventData(updated) });

    const [row] = await withAccounts(db, [updated]);
    return success(c, row);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-agencies] update failed:', err);
    return error.internal(c, 'Failed to update sales tax agency');
  }
});

// DELETE /:id — soft delete when nothing was ever taxed under it, otherwise close it
app.delete('/:id', requirePermission('taxes:delete'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const agency = await requireAgency(db, entity.id, c.req.param('id'));
    const now = new Date();

    if (await agencyHasTaxLines(db, agency.id)) {
      // Tax-ledger rows point at it: the history stays, and so does the agency.
      const closed = {
        status: 'closed',
        registeredUntil: agency.registeredUntil ?? today(),
        updatedAt: now,
      };
      await db.update(schema.salesTaxAgencies).set(closed).where(eq(schema.salesTaxAgencies.id, agency.id));
      await writeAccountingAudit(c, db, {
        accountingEntityId: entity.id,
        entityType: 'sales_tax_agency',
        entityId: agency.id,
        action: 'closed',
        changes: { status: { old: agency.status, new: 'closed' } },
      });
      publishEntityEvent({ c, entityType: 'sales_tax_agency', entityId: agency.id, action: 'updated', data: eventData({ ...agency, ...closed }) });
      return success(c, { id: agency.id, deleted: false, closed: true, status: 'closed', registeredUntil: closed.registeredUntil });
    }

    // Its rates, zones and rules go with it; its payable accounts stay on the chart (a zero balance can be deleted there).
    await atomically(db, (h) => [
      h.update(schema.salesTaxJurisdictionRates).set({ deletedAt: now }).where(
        and(
          eq(schema.salesTaxJurisdictionRates.entityId, entity.id),
          inArray(
            schema.salesTaxJurisdictionRates.jurisdictionId,
            sql`(select id from sales_tax_jurisdictions where agency_id = ${agency.id})`,
          ),
        ),
      ),
      h.update(schema.salesTaxJurisdictions).set({ deletedAt: now }).where(eq(schema.salesTaxJurisdictions.agencyId, agency.id)),
      h.update(schema.salesTaxZones).set({ deletedAt: now }).where(eq(schema.salesTaxZones.agencyId, agency.id)),
      h.update(schema.salesTaxTaxabilityRules).set({ deletedAt: now }).where(eq(schema.salesTaxTaxabilityRules.agencyId, agency.id)),
      h.update(schema.salesTaxAgencies).set({ deletedAt: now, updatedAt: now }).where(eq(schema.salesTaxAgencies.id, agency.id)),
    ]);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_agency',
      entityId: agency.id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'sales_tax_agency', entityId: agency.id, action: 'deleted', data: eventData(agency) });
    return noContent(c);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-agencies] delete failed:', err);
    return error.internal(c, 'Failed to delete sales tax agency');
  }
});

export const salesTaxAgenciesRoutes = app;
