/**
 * Reconciliation rule routes — flat /api/reconciliation-rules/* surface backed by `reconciliationRules`.
 *
 * Ported from apps/api-worker/src/routes/accounting/reconciliation-rules.ts:
 * entity-scoped rule CRUD with multi-condition matcher config (matchMode
 * all|any + field/operator/value conditions), priority ordering, and
 * matchCount tracking (incremented by the auto-reconciliation engine).
 * Every mutation is written to the accounting audit log.
 *
 * Permissions: banking:read | banking:create | banking:update | banking:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { resolveEntityId } from '../../lib/entity-context';
import { writeAccountingAudit } from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.reconciliationRules;

const createRuleSchema = z.object({
  name: z.string().min(1).max(255),
  priority: z.number().optional(),
  matchMode: z.enum(['all', 'any']).optional(),
  conditions: z.array(z.object({
    field: z.enum(['description', 'counterpartyName', 'counterpartyIban', 'amount', 'reference']),
    operator: z.enum(['contains', 'equals', 'starts_with', 'ends_with', 'greater_than', 'less_than', 'between']),
    value: z.union([z.string(), z.number()]),
    value2: z.number().optional(),
  })),
  actions: z.object({
    categoryAccountId: z.string().optional(),
    taxRateId: z.string().optional(),
    contactId: z.string().optional(),
    description: z.string().optional(),
  }),
});

const updateRuleSchema = createRuleSchema.partial();

// GET / — all rules for the resolved accounting entity, highest priority first
app.get('/', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const accountingEntityId = await resolveEntityId(c, db);
    if (!accountingEntityId) return error.badRequest(c, 'No accounting entity resolved');
    const results = await db
      .select()
      .from(t)
      .where(and(isNull(t.deletedAt), eq(t.entityId, accountingEntityId)))
      .orderBy(desc(t.priority));
    return success(c, results);
  } catch (err) {
    console.error('[app-api/reconciliation-rules] list failed:', err);
    return error.internal(c, 'Failed to fetch rules');
  }
});

// GET /:id
app.get('/:id', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Rule', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/reconciliation-rules] get failed:', err);
    return error.internal(c, 'Failed to fetch rule');
  }
});

// POST /
app.post('/', requirePermission('banking:create'), zValidator('json', createRuleSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  try {
    const accountingEntityId = await resolveEntityId(c, db);
    if (!accountingEntityId) return error.badRequest(c, 'No accounting entity resolved');
    const newRule = {
      id: generateId('rr'),
      entityId: accountingEntityId,
      ...data,
      isActive: true,
      matchCount: 0,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(t).values(newRule);

    await writeAccountingAudit(c, db, {
      accountingEntityId,
      entityType: 'reconciliation_rule',
      entityId: newRule.id,
      action: 'created',
    });
    publishEntityEvent({
      c,
      entityType: 'reconciliation_rule',
      entityId: newRule.id,
      action: 'created',
      data: newRule as unknown as Record<string, unknown>,
    });
    return success(c, newRule, 201);
  } catch (err) {
    console.error('[app-api/reconciliation-rules] create failed:', err);
    return error.internal(c, 'Failed to create rule');
  }
});

// PUT|PATCH /:id — PUT preserved from the legacy api-worker surface;
// PATCH added for app-api convention. Same partial-update semantics.
app.on(['PUT', 'PATCH'], '/:id', requirePermission('banking:update'), zValidator('json', updateRuleSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [rule] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!rule) return error.notFound(c, 'Rule', id);
    await db.update(t).set({ ...data, updatedAt: new Date() }).where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: rule.entityId,
      entityType: 'reconciliation_rule',
      entityId: id,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(data)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, { old: (rule as Record<string, unknown>)[k], new: v }]),
      ),
    });
    publishEntityEvent({
      c,
      entityType: 'reconciliation_rule',
      entityId: id,
      action: 'updated',
      data: { ...rule, ...data } as unknown as Record<string, unknown>,
    });
    return success(c, { ...rule, ...data });
  } catch (err) {
    console.error('[app-api/reconciliation-rules] update failed:', err);
    return error.internal(c, 'Failed to update rule');
  }
});

// DELETE /:id — soft delete
app.delete('/:id', requirePermission('banking:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [rule] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!rule) return error.notFound(c, 'Rule', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: rule.entityId,
      entityType: 'reconciliation_rule',
      entityId: id,
      action: 'deleted',
    });
    publishEntityEvent({
      c,
      entityType: 'reconciliation_rule',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/reconciliation-rules] delete failed:', err);
    return error.internal(c, 'Failed to delete rule');
  }
});

export const reconciliationRulesRoutes = app;
