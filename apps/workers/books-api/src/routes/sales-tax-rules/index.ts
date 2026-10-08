/**
 * Manual sales tax engine: taxability rules. /api/sales-tax-rules/*
 *
 * Per agency and tax code: whether the code is taxable, from when, on what
 * share of the price (Texas taxes SaaS on 80%), for business or personal use
 * only, and optionally at a different combined rate (Maryland SaaS for
 * business use: 3%). No rule means taxable at 100%. Rules of one agency,
 * code and use never overlap in time.
 *
 * Permissions: taxes:read | taxes:create | taxes:update | taxes:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import {
  isAvalaraTaxCode,
  isStripeTaxCode,
  isWeldTaxCode,
} from '@weldsuite/books-domain/jurisdictions/us/tax-codes';
import { salesTaxErrorResponse, SalesTaxSetupError } from '../../services/sales-tax/errors';
import {
  checkDateOrder,
  isoDateSchema,
  optionalSalesTaxEntity,
  pageParams,
  percentSchema,
  rangesOverlap,
  requireAgency,
  requireSalesTaxEntity,
} from '../../services/sales-tax/route-helpers';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type RuleRow = typeof schema.salesTaxTaxabilityRules.$inferSelect;

const taxCodeSchema = z
  .string()
  .min(1)
  .max(30)
  .refine((code) => isWeldTaxCode(code) || isStripeTaxCode(code) || isAvalaraTaxCode(code), 'Use a WeldBooks tax code (general, saas, shipping, ...)');

const createRuleSchema = z.object({
  agencyId: z.string().min(1).max(30),
  taxCode: taxCodeSchema,
  taxable: z.boolean(),
  /** Share of the price that is taxable, 0 to 100. */
  taxablePercent: percentSchema.optional(),
  appliesToUse: z.enum(['any', 'business', 'personal']).optional(),
  /** Replaces the combined rate for this code. */
  rateOverride: percentSchema.nullish(),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullish(),
  notes: z.string().max(2000).nullish(),
});

const updateRuleSchema = createRuleSchema.omit({ agencyId: true }).partial();

async function requireRule(db: Database, entityId: string, id: string): Promise<RuleRow> {
  const [row] = await db
    .select()
    .from(schema.salesTaxTaxabilityRules)
    .where(
      and(
        eq(schema.salesTaxTaxabilityRules.id, id),
        eq(schema.salesTaxTaxabilityRules.entityId, entityId),
        isNull(schema.salesTaxTaxabilityRules.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new SalesTaxSetupError(`Sales tax rule ${id} not found`, 404);
  return row;
}

/** Another rule of the same agency, code and use covering any of the same days. */
async function assertNoOverlap(
  db: Database,
  rule: { entityId: string; agencyId: string; taxCode: string; appliesToUse: string; from: string; to?: string | null },
  ignoreId?: string,
): Promise<void> {
  const t = schema.salesTaxTaxabilityRules;
  const existing = await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.entityId, rule.entityId),
        eq(t.agencyId, rule.agencyId),
        eq(t.taxCode, rule.taxCode),
        eq(t.appliesToUse, rule.appliesToUse),
        isNull(t.deletedAt),
      ),
    );
  const clash = existing.find((r) => r.id !== ignoreId && rangesOverlap({ from: r.effectiveFrom, to: r.effectiveTo }, { from: rule.from, to: rule.to }));
  if (clash) {
    throw new SalesTaxSetupError(
      `A rule for ${rule.taxCode} already applies from ${clash.effectiveFrom}${clash.effectiveTo ? ` to ${clash.effectiveTo}` : ' onward'}. End it before adding one that overlaps.`,
      409,
    );
  }
}

function eventData(rule: RuleRow) {
  return {
    id: rule.id,
    agencyId: rule.agencyId,
    taxCode: rule.taxCode,
    taxable: rule.taxable,
    taxablePercent: Number(rule.taxablePercent),
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
  };
}

// GET / — ?agencyId=&taxCode=
app.get('/', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const t = schema.salesTaxTaxabilityRules;
  try {
    const entity = await optionalSalesTaxEntity(c, db);
    if (!entity) return list(c, [], cursorPagination(0, false, null));
    const { page, pageSize, offset } = pageParams(c);
    const conditions: SQL[] = [eq(t.entityId, entity.id), isNull(t.deletedAt)];
    const agencyId = c.req.query('agencyId');
    if (agencyId) conditions.push(eq(t.agencyId, agencyId));
    const taxCode = c.req.query('taxCode');
    if (taxCode) conditions.push(eq(t.taxCode, taxCode));

    const where = and(...conditions);
    const [rows, count] = await Promise.all([
      db.select().from(t).where(where).orderBy(asc(t.agencyId), asc(t.taxCode), asc(t.effectiveFrom)).limit(pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const totalCount = Number(count[0]?.count ?? 0);
    return list(c, rows, cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-rules] list failed:', err);
    return error.internal(c, 'Failed to fetch sales tax rules');
  }
});

// GET /:id
app.get('/:id', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    return success(c, await requireRule(db, entity.id, c.req.param('id')));
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-rules] get failed:', err);
    return error.internal(c, 'Failed to fetch sales tax rule');
  }
});

// POST /
app.post('/', requirePermission('taxes:create'), zValidator('json', createRuleSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const agency = await requireAgency(db, entity.id, data.agencyId);
    checkDateOrder(data.effectiveFrom, data.effectiveTo, 'the rule');
    const appliesToUse = data.appliesToUse ?? 'any';
    await assertNoOverlap(db, {
      entityId: entity.id,
      agencyId: agency.id,
      taxCode: data.taxCode,
      appliesToUse,
      from: data.effectiveFrom,
      to: data.effectiveTo,
    });

    const now = new Date();
    const rule = {
      id: generateId('str'),
      entityId: entity.id,
      agencyId: agency.id,
      taxCode: data.taxCode,
      taxable: data.taxable,
      taxablePercent: (data.taxablePercent ?? 100).toFixed(4),
      appliesToUse,
      rateOverride: data.rateOverride === null || data.rateOverride === undefined ? null : data.rateOverride.toFixed(4),
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo ?? null,
      notes: data.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.salesTaxTaxabilityRules).values(rule);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_rule',
      entityId: rule.id,
      action: 'created',
    });
    publishEntityEvent({ c, entityType: 'sales_tax_rule', entityId: rule.id, action: 'created', data: eventData(rule as RuleRow) });
    return success(c, rule, 201);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-rules] create failed:', err);
    return error.internal(c, 'Failed to create sales tax rule');
  }
});

// PUT/PATCH /:id
app.on(['PUT', 'PATCH'], '/:id', requirePermission('taxes:update'), zValidator('json', updateRuleSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const rule = await requireRule(db, entity.id, c.req.param('id'));

    const merged = {
      taxCode: data.taxCode ?? rule.taxCode,
      appliesToUse: data.appliesToUse ?? rule.appliesToUse,
      from: data.effectiveFrom ?? rule.effectiveFrom,
      to: data.effectiveTo === undefined ? rule.effectiveTo : data.effectiveTo,
    };
    checkDateOrder(merged.from, merged.to, 'the rule');
    await assertNoOverlap(db, { entityId: entity.id, agencyId: rule.agencyId, ...merged }, rule.id);

    const update: Partial<RuleRow> = { updatedAt: new Date() };
    if (data.taxCode !== undefined) update.taxCode = data.taxCode;
    if (data.taxable !== undefined) update.taxable = data.taxable;
    if (data.taxablePercent !== undefined) update.taxablePercent = data.taxablePercent.toFixed(4);
    if (data.appliesToUse !== undefined) update.appliesToUse = data.appliesToUse;
    if (data.rateOverride !== undefined) update.rateOverride = data.rateOverride === null ? null : data.rateOverride.toFixed(4);
    if (data.effectiveFrom !== undefined) update.effectiveFrom = data.effectiveFrom;
    if (data.effectiveTo !== undefined) update.effectiveTo = data.effectiveTo ?? null;
    if (data.notes !== undefined) update.notes = data.notes ?? null;
    await db.update(schema.salesTaxTaxabilityRules).set(update).where(eq(schema.salesTaxTaxabilityRules.id, rule.id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_rule',
      entityId: rule.id,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(update)
          .filter(([k]) => k !== 'updatedAt')
          .map(([k, v]) => [k, { old: (rule as Record<string, unknown>)[k], new: v }]),
      ),
    });
    const updated = { ...rule, ...update };
    publishEntityEvent({ c, entityType: 'sales_tax_rule', entityId: rule.id, action: 'updated', data: eventData(updated) });
    return success(c, updated);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-rules] update failed:', err);
    return error.internal(c, 'Failed to update sales tax rule');
  }
});

// DELETE /:id
app.delete('/:id', requirePermission('taxes:delete'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const rule = await requireRule(db, entity.id, c.req.param('id'));
    const now = new Date();
    await db
      .update(schema.salesTaxTaxabilityRules)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.salesTaxTaxabilityRules.id, rule.id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'sales_tax_rule',
      entityId: rule.id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'sales_tax_rule', entityId: rule.id, action: 'deleted', data: eventData(rule) });
    return noContent(c);
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax-rules] delete failed:', err);
    return error.internal(c, 'Failed to delete sales tax rule');
  }
});

export const salesTaxRulesRoutes = app;
