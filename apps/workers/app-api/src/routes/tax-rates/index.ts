/**
 * Tax rate routes — flat /api/tax-rates/* surface backed by `taxRates`.
 *
 * Ported from the legacy api-worker accounting/tax-rates routes:
 *   - list is entity-scoped via `resolveEntityId` (header → query → default)
 *     with optional `type` and `isActive` filters, ordered by name;
 *   - jurisdiction-specific codes (NL btwRubriek, DE Umsatzsteuer box, ...)
 *     live in `jurisdictionMetadata`; optional ledger linkage via
 *     `ledgerAccountId`; `isDefault` / `isActive` flags supported.
 *
 * Integrity: a tax rate referenced by journal lines cannot be deleted
 * (deactivate it instead), and every mutation is written to the
 * accounting audit log.
 *
 * Permissions: settings:read | settings:create | settings:update | settings:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { resolveEntityId } from '../../lib/entity-context';
import { writeAccountingAudit } from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.taxRates;

const taxRateBaseSchema = z.object({
  entityId: z.string().min(1).max(30),
  jurisdictionCode: z.string().min(2).max(5).optional(),
  /** Shared-schema alias for jurisdictionCode. */
  jurisdiction: z.string().min(2).max(5).optional(),
  name: z.string().min(1).max(100),
  rate: z.union([z.string(), z.number()]).transform((v) => String(v)),
  type: z.enum(['sales', 'purchase', 'both']).default('both'),
  taxCategoryCode: z.string().max(30).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: z.string().optional(),
  ledgerAccountId: z.string().max(30).optional(),
  /** Jurisdiction-specific codes (NL btwRubriek, DE Umsatzsteuer box, ...) live here. */
  jurisdictionMetadata: z.record(z.unknown()).optional(),
});

const createTaxRateSchema = taxRateBaseSchema.refine(
  (v) => v.jurisdictionCode || v.jurisdiction,
  { message: 'jurisdictionCode is required', path: ['jurisdictionCode'] },
);

const updateTaxRateSchema = taxRateBaseSchema.partial();

// ---------------------------------------------------------------------------
// GET / — list tax rates for the resolved entity
// ---------------------------------------------------------------------------
app.get('/', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const conditions = [isNull(t.deletedAt), eq(t.entityId, entityId)];

    const typeFilter = c.req.query('type');
    if (typeFilter) {
      conditions.push(eq(t.type, typeFilter));
    }

    const activeFilter = c.req.query('isActive');
    if (activeFilter !== undefined) {
      conditions.push(eq(t.isActive, activeFilter === 'true'));
    }

    const results = await db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(t.name);

    return success(c, results);
  } catch (err) {
    console.error('[app-api/tax-rates] list failed:', err);
    return error.internal(c, 'Failed to list tax rates');
  }
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------
app.get('/:id', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Tax rate', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/tax-rates] get failed:', err);
    return error.internal(c, 'Failed to fetch tax rate');
  }
});

// ---------------------------------------------------------------------------
// POST /
// ---------------------------------------------------------------------------
app.post('/', requirePermission('settings:create'), zValidator('json', createTaxRateSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  try {
    const { jurisdiction, ...rest } = data;
    const newRate = {
      id: generateId('txr'),
      ...rest,
      jurisdictionCode: (data.jurisdictionCode ?? jurisdiction ?? '').toUpperCase(),
      isActive: data.isActive ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(t).values(newRate as unknown as typeof t.$inferInsert);

    await writeAccountingAudit(c, db, {
      accountingEntityId: data.entityId,
      entityType: 'tax_rate',
      entityId: newRate.id,
      action: 'created',
    });
    publishEntityEvent({
      c,
      entityType: 'tax_rate',
      entityId: newRate.id,
      action: 'created',
      data: newRate as unknown as Record<string, unknown>,
    });
    return success(c, newRate, 201);
  } catch (err) {
    console.error('[app-api/tax-rates] create failed:', err);
    return error.internal(c, 'Failed to create tax rate');
  }
});

// ---------------------------------------------------------------------------
// PUT /:id + PATCH /:id — legacy api-worker exposed PUT; PATCH is the
// app-api convention. Both accept the same partial payload.
// ---------------------------------------------------------------------------
app.on(
  ['PUT', 'PATCH'],
  '/:id',
  requirePermission('settings:update'),
  zValidator('json', updateTaxRateSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');

    try {
      const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
      if (!existing) return error.notFound(c, 'Tax rate', id);

      const update: Record<string, unknown> = { updatedAt: new Date() };
      for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
      if (typeof update.jurisdictionCode === 'string') {
        update.jurisdictionCode = update.jurisdictionCode.toUpperCase();
      }

      await db.update(t).set(update).where(eq(t.id, id));

      await writeAccountingAudit(c, db, {
        accountingEntityId: existing.entityId,
        entityType: 'tax_rate',
        entityId: id,
        action: 'updated',
        changes: Object.fromEntries(
          Object.entries(data)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, { old: (existing as Record<string, unknown>)[k], new: v }]),
        ),
      });
      publishEntityEvent({
        c,
        entityType: 'tax_rate',
        entityId: id,
        action: 'updated',
        data: { ...existing, ...data } as unknown as Record<string, unknown>,
      });
      return success(c, { ...existing, ...data });
    } catch (err) {
      console.error('[app-api/tax-rates] update failed:', err);
      return error.internal(c, 'Failed to update tax rate');
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /:id — blocked while journal lines reference the rate
// ---------------------------------------------------------------------------
app.delete('/:id', requirePermission('settings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Tax rate', id);

    // Integrity guard: rates referenced by bookings must stay resolvable
    // for the audit trail — deactivate instead of deleting.
    const { journalLines } = schema;
    const [{ count: usageCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(journalLines)
      .where(and(eq(journalLines.taxRateId, id), isNull(journalLines.deletedAt)));

    if (Number(usageCount) > 0) {
      return error.badRequest(c, 'Tax rate is used by bookings — deactivate it instead');
    }

    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: existing.entityId,
      entityType: 'tax_rate',
      entityId: id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'tax_rate', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/tax-rates] delete failed:', err);
    return error.internal(c, 'Failed to delete tax rate');
  }
});

export const taxRatesRoutes = app;
