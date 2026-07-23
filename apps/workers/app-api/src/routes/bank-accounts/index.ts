/**
 * Bank account routes — flat /api/bank-accounts/* surface backed by `bankAccounts`.
 *
 * Ported from apps/api-worker/src/routes/accounting/bank-accounts.ts:
 * entity-scoped CRUD with ledgerAccountId linkage, isDefault flag, and
 * autoReconcile config. lastImportDate / lastImportBalance are maintained
 * by the bank-transactions import route, not editable here.
 *
 * Permissions: banking:read | banking:create | banking:update | banking:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { resolveEntityId } from '../../lib/entity-context';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.bankAccounts;

const createBankAccountSchema = z.object({
  name: z.string().min(1).max(255),
  iban: z.string().max(34).optional(),
  bic: z.string().max(11).optional(),
  bankName: z.string().max(255).optional(),
  accountHolderName: z.string().max(255).optional(),
  currency: z.string().length(3).optional(),
  ledgerAccountId: z.string().max(30).optional(),
  isDefault: z.boolean().optional(),
  autoReconcile: z.boolean().optional(),
});

const updateBankAccountSchema = createBankAccountSchema.partial();

// GET / — all bank accounts for the resolved accounting entity
app.get('/', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const accountingEntityId = await resolveEntityId(c, db);
    if (!accountingEntityId) return error.badRequest(c, 'No accounting entity resolved');
    const results = await db
      .select()
      .from(t)
      .where(and(isNull(t.deletedAt), eq(t.entityId, accountingEntityId)))
      .orderBy(t.name);
    return success(c, results);
  } catch (err) {
    console.error('[app-api/bank-accounts] list failed:', err);
    return error.internal(c, 'Failed to fetch bank accounts');
  }
});

// GET /:id
app.get('/:id', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [account] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!account) return error.notFound(c, 'Bank account', id);
    return success(c, account);
  } catch (err) {
    console.error('[app-api/bank-accounts] get failed:', err);
    return error.internal(c, 'Failed to fetch bank account');
  }
});

// POST /
app.post('/', requirePermission('banking:create'), zValidator('json', createBankAccountSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const accountingEntityId = await resolveEntityId(c, db);
    if (!accountingEntityId) return error.badRequest(c, 'No accounting entity resolved');
    const newAccount = {
      id: generateId('ba'),
      entityId: accountingEntityId,
      ...data,
      isActive: true,
      currentBalance: '0',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(t).values(newAccount);
    publishEntityEvent({
      c,
      entityType: 'bank_account',
      entityId: newAccount.id,
      action: 'created',
      data: newAccount as unknown as Record<string, unknown>,
    });
    return success(c, newAccount, 201);
  } catch (err) {
    console.error('[app-api/bank-accounts] create failed:', err);
    return error.internal(c, 'Failed to create bank account');
  }
});

// PUT|PATCH /:id — PUT preserved from the legacy api-worker surface;
// PATCH added for app-api convention. Same partial-update semantics.
app.on(['PUT', 'PATCH'], '/:id', requirePermission('banking:update'), zValidator('json', updateBankAccountSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [account] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!account) return error.notFound(c, 'Bank account', id);
    await db.update(t).set({ ...data, updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'bank_account',
      entityId: id,
      action: 'updated',
      data: { ...account, ...data } as unknown as Record<string, unknown>,
    });
    return success(c, { ...account, ...data });
  } catch (err) {
    console.error('[app-api/bank-accounts] update failed:', err);
    return error.internal(c, 'Failed to update bank account');
  }
});

// DELETE /:id — soft delete
app.delete('/:id', requirePermission('banking:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [account] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!account) return error.notFound(c, 'Bank account', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'bank_account',
      entityId: id,
      action: 'deleted',
      data: account as unknown as Record<string, unknown>,
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/bank-accounts] delete failed:', err);
    return error.internal(c, 'Failed to delete bank account');
  }
});

export const bankAccountsRoutes = app;
