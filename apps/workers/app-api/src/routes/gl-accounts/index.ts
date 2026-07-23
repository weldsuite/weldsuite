/**
 * GL account routes — flat /api/gl-accounts/* surface backed by `accounts`
 * (the chart of accounts).
 *
 * Ported from apps/api-worker/src/routes/accounting/accounts.ts:
 *   - hierarchy via parentAccountId, type/subtype/normalSide, currentBalance
 *   - system accounts are protected from structural edits and deletion
 *   - accounts with journal lines can never be deleted (administratieplicht —
 *     deactivate instead so the trail stays reconstructable)
 *
 * Permissions: accounts:read | accounts:create | accounts:update | accounts:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { resolveEntityId } from '../../lib/entity-context';
import { writeAccountingAudit } from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.accounts;

const createAccountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  subtype: z.string().max(50).optional(),
  parentAccountId: z.string().max(30).optional(),
  currency: z.string().length(3).optional(),
  normalSide: z.enum(['debit', 'credit']),
  defaultTaxRateId: z.string().max(30).optional(),
  openingBalance: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateAccountSchema = createAccountSchema.partial();

// GET / — list accounts (chart of accounts, entity-scoped, ordered by code)
app.get('/', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');

  try {
    const typeFilter = c.req.query('type');
    const subtypeFilter = c.req.query('subtype');
    const activeFilter = c.req.query('isActive');
    const search = c.req.query('search');
    const parentId = c.req.query('parentAccountId');

    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const conditions = [isNull(t.deletedAt), eq(t.entityId, entityId)];

    if (typeFilter) conditions.push(eq(t.type, typeFilter));
    if (subtypeFilter) conditions.push(eq(t.subtype, subtypeFilter));
    if (activeFilter !== undefined) conditions.push(eq(t.isActive, activeFilter === 'true'));
    if (parentId) conditions.push(eq(t.parentAccountId, parentId));
    if (search) {
      const term = `%${search}%`;
      conditions.push(or(like(t.code, term), like(t.name, term))!);
    }

    const results = await db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(t.code);

    return success(c, results);
  } catch (err) {
    console.error('[app-api/gl-accounts] list failed:', err);
    return error.internal(c, 'Failed to fetch accounts');
  }
});

// GET /:id — account detail
app.get('/:id', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const accountId = c.req.param('id');

  try {
    const [account] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, accountId), isNull(t.deletedAt)))
      .limit(1);

    if (!account) return error.notFound(c, 'Account', accountId);
    return success(c, account);
  } catch (err) {
    console.error('[app-api/gl-accounts] get failed:', err);
    return error.internal(c, 'Failed to fetch account');
  }
});

// GET /:id/transactions — posted journal lines for this account
app.get('/:id/transactions', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const { journalLines, journalEntries } = schema;
  const accountId = c.req.param('id');
  const page = Math.max(parseInt(c.req.query('page') || '1', 10), 1);
  const pageSize = Math.min(Math.max(parseInt(c.req.query('pageSize') || '25', 10), 1), 100);

  try {
    const where = and(
      eq(journalLines.accountId, accountId),
      isNull(journalLines.deletedAt),
      eq(journalEntries.status, 'posted'),
    );

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .where(where);

    const lines = await db
      .select({
        id: journalLines.id,
        journalEntryId: journalLines.journalEntryId,
        description: journalLines.description,
        debit: journalLines.debit,
        credit: journalLines.credit,
        contactId: journalLines.contactId,
        entryNumber: journalEntries.entryNumber,
        entryDate: journalEntries.date,
        entryDescription: journalEntries.description,
        sourceType: journalEntries.sourceType,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .where(where)
      .orderBy(desc(journalEntries.date))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const totalCount = Number(total ?? 0);
    return list(c, lines, cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    console.error('[app-api/gl-accounts] transactions failed:', err);
    return error.internal(c, 'Failed to fetch account transactions');
  }
});

// POST / — create account
app.post('/', requirePermission('accounts:create'), zValidator('json', createAccountSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    // Account codes are unique per entity (multi-entity: the same RGS code
    // may exist in every administration).
    const existing = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.code, data.code), eq(t.entityId, entityId), isNull(t.deletedAt)))
      .limit(1);

    if (existing.length > 0) {
      return error.conflict(c, `Account code '${data.code}' already exists`);
    }

    const newAccount = {
      id: generateId('acc'),
      entityId,
      ...data,
      isActive: true,
      isSystemAccount: false,
      currentBalance: '0',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(t).values(newAccount);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'account',
      entityId: newAccount.id,
      action: 'created',
    });
    publishEntityEvent({ c, entityType: 'account', entityId: newAccount.id, action: 'created', data: newAccount as unknown as Record<string, unknown> });

    return success(c, newAccount, 201);
  } catch (err) {
    console.error('[app-api/gl-accounts] create failed:', err);
    return error.internal(c, 'Failed to create account');
  }
});

// PUT/PATCH /:id — update account (legacy client uses PUT; app-api convention is PATCH)
app.on(['PUT', 'PATCH'], '/:id', requirePermission('accounts:update'), zValidator('json', updateAccountSchema), async (c) => {
  const db = c.get('tenantDb');
  const accountId = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const [account] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, accountId), isNull(t.deletedAt)))
      .limit(1);

    if (!account) return error.notFound(c, 'Account', accountId);

    if (account.isSystemAccount && (data.code || data.type || data.normalSide)) {
      return error.badRequest(c, 'Cannot change code, type, or normalSide of a system account');
    }

    if (data.code && data.code !== account.code) {
      const dup = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.code, data.code), eq(t.entityId, account.entityId), isNull(t.deletedAt)))
        .limit(1);
      if (dup.length > 0) {
        return error.conflict(c, `Account code '${data.code}' already exists`);
      }
    }

    await db
      .update(t)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(t.id, accountId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: account.entityId,
      entityType: 'account',
      entityId: accountId,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(data)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, { old: (account as Record<string, unknown>)[k], new: v }]),
      ),
    });
    publishEntityEvent({ c, entityType: 'account', entityId: accountId, action: 'updated', data: { ...account, ...data } as unknown as Record<string, unknown> });

    return success(c, { ...account, ...data });
  } catch (err) {
    console.error('[app-api/gl-accounts] update failed:', err);
    return error.internal(c, 'Failed to update account');
  }
});

// DELETE /:id — soft delete; blocked for system accounts and accounts with bookings
app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const db = c.get('tenantDb');
  const { journalLines } = schema;
  const accountId = c.req.param('id');

  try {
    const [account] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, accountId), isNull(t.deletedAt)))
      .limit(1);

    if (!account) return error.notFound(c, 'Account', accountId);

    if (account.isSystemAccount) {
      return error.badRequest(c, 'Cannot delete a system account');
    }

    // Accounts that were ever booked against must stay in the administration
    // (administratieplicht) — deactivate instead of deleting.
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(journalLines)
      .where(and(eq(journalLines.accountId, accountId), isNull(journalLines.deletedAt)));

    if (count > 0) {
      return error.badRequest(c, 'Account has bookings — deactivate it instead');
    }

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(t.id, accountId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: account.entityId,
      entityType: 'account',
      entityId: accountId,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'account', entityId: accountId, action: 'deleted', data: { id: accountId } });

    return noContent(c);
  } catch (err) {
    console.error('[app-api/gl-accounts] delete failed:', err);
    return error.internal(c, 'Failed to delete account');
  }
});

export const glAccountsRoutes = app;
