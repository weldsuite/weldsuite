/**
 * Journal entry routes — flat /api/journal-entries/* surface backed by `journalEntries`.
 *
 * Integrity rules (administratieplicht — do not weaken):
 *   - Entries are created as drafts; only drafts may be edited or deleted.
 *   - Posting is the only draft→posted transition and applies account balances.
 *   - Posted entries are immutable; corrections go through POST /:id/reverse,
 *     which creates a counter-entry and never mutates the original amounts.
 *   - Every state change is blocked inside closed fiscal periods and written
 *     to the accounting audit log.
 *
 * Permissions: journal:read | journal:create | journal:update | journal:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { nextEntityNumber, resolveEntityId } from '../../lib/entity-context';
import {
  assertPeriodOpen,
  ClosedPeriodError,
  writeAccountingAudit,
} from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const journalLineSchema = z.object({
  accountId: z.string().min(1),
  description: z.string().optional(),
  debit: z.string().default('0'),
  credit: z.string().default('0'),
  taxRateId: z.string().optional(),
  taxAmount: z.string().optional(),
  contactId: z.string().optional(),
  sortOrder: z.number().optional(),
});

const createJournalEntrySchema = z.object({
  date: z.string(),
  description: z.string().optional(),
  reference: z.string().max(255).optional(),
  lines: z.array(journalLineSchema).min(2),
});

const updateJournalEntrySchema = z.object({
  date: z.string().optional(),
  description: z.string().optional(),
  reference: z.string().max(255).optional(),
});

function sumLines(lines: Array<{ debit?: string; credit?: string }>) {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    totalDebit += parseFloat(line.debit || '0');
    totalCredit += parseFloat(line.credit || '0');
  }
  return { totalDebit, totalCredit };
}

/** Apply each line's net change to its account's running balance. */
async function applyBalances(
  db: any,
  lines: Array<{ accountId: string; debit: string | null; credit: string | null }>,
  direction: 1 | -1,
) {
  const { accounts } = schema;
  for (const line of lines) {
    const debit = parseFloat(line.debit || '0');
    const credit = parseFloat(line.credit || '0');
    const netChange = (debit - credit) * direction;
    if (netChange !== 0) {
      await db
        .update(accounts)
        .set({
          currentBalance: sql`(${accounts.currentBalance}::numeric + ${netChange})::text`,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, line.accountId));
    }
  }
}

// GET /
app.get('/', requirePermission('journal:read'), async (c) => {
  const db = c.get('tenantDb');
  const t = schema.journalEntries;
  const q = c.req.query();
  const page = Math.max(parseInt(q.page || '1', 10), 1);
  const pageSize = Math.min(Math.max(parseInt(q.pageSize || '25', 10), 1), 100);

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const conditions = [isNull(t.deletedAt), eq(t.entityId, entityId)];
    if (q.status) conditions.push(eq(t.status, q.status));
    if (q.sourceType) conditions.push(eq(t.sourceType, q.sourceType));
    if (q.from) conditions.push(gte(t.date, new Date(q.from)));
    if (q.to) conditions.push(lte(t.date, new Date(q.to)));

    const where = and(...conditions);
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.date), desc(t.id))
        .limit(pageSize).offset((page - 1) * pageSize),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, rows, cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    console.error('[app-api/journal-entries] list failed:', err);
    return error.internal(c, 'Failed to list journal entries');
  }
});

// GET /:id — includes lines
app.get('/:id', requirePermission('journal:read'), async (c) => {
  const db = c.get('tenantDb');
  const { journalEntries, journalLines } = schema;
  const id = c.req.param('id');
  try {
    const [entry] = await db.select().from(journalEntries)
      .where(and(eq(journalEntries.id, id), isNull(journalEntries.deletedAt))).limit(1);
    if (!entry) return error.notFound(c, 'Journal entry', id);
    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.journalEntryId, id), isNull(journalLines.deletedAt)))
      .orderBy(journalLines.sortOrder);
    return success(c, { ...entry, lines });
  } catch (err) {
    console.error('[app-api/journal-entries] get failed:', err);
    return error.internal(c, 'Failed to fetch journal entry');
  }
});

// POST / — create draft entry
app.post('/', requirePermission('journal:create'), zValidator('json', createJournalEntrySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const { journalEntries, journalLines } = schema;

  const { totalDebit, totalCredit } = sumLines(data.lines);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return error.badRequest(
      c,
      `Journal entry is not balanced. Total debit: ${totalDebit.toFixed(2)}, total credit: ${totalCredit.toFixed(2)}`,
    );
  }

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    await assertPeriodOpen(db, entityId, data.date);

    const { formatted: entryNumber } = await nextEntityNumber(db, entityId, 'journal');
    const entryId = generateId('je');
    const now = new Date();

    await db.insert(journalEntries).values({
      id: entryId,
      entityId,
      entryNumber,
      date: new Date(data.date),
      status: 'draft',
      description: data.description || null,
      reference: data.reference || null,
      totalDebit: totalDebit.toFixed(2),
      totalCredit: totalCredit.toFixed(2),
      sourceType: 'manual',
      isAutomatic: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    const lineRecords = data.lines.map((line, idx) => ({
      id: generateId('jl'),
      entityId,
      journalEntryId: entryId,
      accountId: line.accountId,
      description: line.description || null,
      debit: line.debit || '0',
      credit: line.credit || '0',
      taxRateId: line.taxRateId || null,
      taxAmount: line.taxAmount || null,
      contactId: line.contactId || null,
      sortOrder: line.sortOrder ?? idx,
      createdAt: now,
      updatedAt: now,
    }));
    await db.insert(journalLines).values(lineRecords);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'journal_entry',
      entityId: entryId,
      action: 'created',
    });
    publishEntityEvent({ c, entityType: 'journal_entry', entityId: entryId, action: 'created', data: { id: entryId, entityId, entryNumber, status: 'draft' } });

    return success(c, { id: entryId, entryNumber, lines: lineRecords }, 201);
  } catch (err) {
    if (err instanceof ClosedPeriodError) return error.badRequest(c, err.message);
    console.error('[app-api/journal-entries] create failed:', err);
    return error.internal(c, 'Failed to create journal entry');
  }
});

// PATCH /:id — header fields only, drafts only. Posted entries are immutable.
app.patch('/:id', requirePermission('journal:update'), zValidator('json', updateJournalEntrySchema), async (c) => {
  const db = c.get('tenantDb');
  const t = schema.journalEntries;
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Journal entry', id);
    if (existing.status !== 'draft') {
      return error.badRequest(
        c,
        'Posted journal entries are immutable — create a reversal via POST /:id/reverse instead',
      );
    }

    if (data.date) await assertPeriodOpen(db, existing.entityId, data.date);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (data.date !== undefined) update.date = new Date(data.date);
    if (data.description !== undefined) update.description = data.description;
    if (data.reference !== undefined) update.reference = data.reference;

    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

    await writeAccountingAudit(c, db, {
      accountingEntityId: existing.entityId,
      entityType: 'journal_entry',
      entityId: id,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(data)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, { old: (existing as Record<string, unknown>)[k], new: v }]),
      ),
    });
    publishEntityEvent({ c, entityType: 'journal_entry', entityId: id, action: 'updated', data: { id, entityId: existing.entityId, entryNumber: existing.entryNumber, status: existing.status } });

    return success(c, { id });
  } catch (err) {
    if (err instanceof ClosedPeriodError) return error.badRequest(c, err.message);
    console.error('[app-api/journal-entries] update failed:', err);
    return error.internal(c, 'Failed to update journal entry');
  }
});

// POST /:id/post — draft → posted; applies account balances
app.post('/:id/post', requirePermission('journal:update'), async (c) => {
  const db = c.get('tenantDb');
  const { journalEntries, journalLines } = schema;
  const entryId = c.req.param('id');

  try {
    const [entry] = await db.select().from(journalEntries)
      .where(and(eq(journalEntries.id, entryId), isNull(journalEntries.deletedAt))).limit(1);
    if (!entry) return error.notFound(c, 'Journal entry', entryId);
    if (entry.status !== 'draft') {
      return error.badRequest(c, 'Can only post draft journal entries');
    }

    await assertPeriodOpen(db, entry.entityId, entry.date);

    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.journalEntryId, entryId), isNull(journalLines.deletedAt)));

    await applyBalances(db, lines, 1);
    await db.update(journalEntries)
      .set({ status: 'posted', updatedAt: new Date() })
      .where(eq(journalEntries.id, entryId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entry.entityId,
      entityType: 'journal_entry',
      entityId: entryId,
      action: 'posted',
      changes: { status: { old: 'draft', new: 'posted' } },
    });
    publishEntityEvent({ c, entityType: 'journal_entry', entityId: entryId, action: 'updated', data: { ...entry, status: 'posted' } as unknown as Record<string, unknown> });

    return success(c, { ...entry, status: 'posted' });
  } catch (err) {
    if (err instanceof ClosedPeriodError) return error.badRequest(c, err.message);
    console.error('[app-api/journal-entries] post failed:', err);
    return error.internal(c, 'Failed to post journal entry');
  }
});

// POST /:id/reverse — posted → reversed via a posted counter-entry
app.post('/:id/reverse', requirePermission('journal:create'), async (c) => {
  const db = c.get('tenantDb');
  const { journalEntries, journalLines } = schema;
  const entryId = c.req.param('id');
  const userId = c.get('userId');

  try {
    const [entry] = await db.select().from(journalEntries)
      .where(and(eq(journalEntries.id, entryId), isNull(journalEntries.deletedAt))).limit(1);
    if (!entry) return error.notFound(c, 'Journal entry', entryId);
    if (entry.status !== 'posted') {
      return error.badRequest(c, 'Can only reverse posted journal entries');
    }

    const reversalDate = new Date();
    await assertPeriodOpen(db, entry.entityId, reversalDate);

    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.journalEntryId, entryId), isNull(journalLines.deletedAt)));

    const { formatted: reversalNumber } = await nextEntityNumber(db, entry.entityId, 'journal');
    const reversalId = generateId('je');
    const now = new Date();

    await db.insert(journalEntries).values({
      id: reversalId,
      entityId: entry.entityId,
      entryNumber: reversalNumber,
      date: reversalDate,
      status: 'posted',
      description: `Reversal of ${entry.entryNumber}`,
      totalDebit: entry.totalCredit,
      totalCredit: entry.totalDebit,
      sourceType: entry.sourceType,
      reversalOfId: entryId,
      isAutomatic: true,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    // Swap debit/credit; keep the tax fields so the counter-entry carries the
    // same tax context as the original.
    const reversalLines = lines.map((line, idx) => ({
      id: generateId('jl'),
      entityId: entry.entityId,
      journalEntryId: reversalId,
      accountId: line.accountId,
      description: `Reversal: ${line.description || ''}`,
      debit: line.credit || '0',
      credit: line.debit || '0',
      taxRateId: line.taxRateId,
      taxAmount: line.taxAmount,
      contactId: line.contactId,
      sortOrder: idx,
      createdAt: now,
      updatedAt: now,
    }));
    await db.insert(journalLines).values(reversalLines);

    // The reversal is born posted, so its balance effect must be applied here
    // (the legacy route skipped this and left balances stale after reversal).
    await applyBalances(db, reversalLines, 1);

    await db.update(journalEntries)
      .set({ status: 'reversed', reversedById: reversalId, updatedAt: new Date() })
      .where(eq(journalEntries.id, entryId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entry.entityId,
      entityType: 'journal_entry',
      entityId: entryId,
      action: 'reversed',
      changes: {
        status: { old: 'posted', new: 'reversed' },
        reversedById: { old: null, new: reversalId },
      },
    });
    publishEntityEvent({ c, entityType: 'journal_entry', entityId: entryId, action: 'updated', data: { id: entryId, status: 'reversed', reversedById: reversalId } });

    return success(c, { id: reversalId, entryNumber: reversalNumber }, 201);
  } catch (err) {
    if (err instanceof ClosedPeriodError) return error.badRequest(c, err.message);
    console.error('[app-api/journal-entries] reverse failed:', err);
    return error.internal(c, 'Failed to reverse journal entry');
  }
});

// DELETE /:id — drafts only
app.delete('/:id', requirePermission('journal:delete'), async (c) => {
  const db = c.get('tenantDb');
  const t = schema.journalEntries;
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Journal entry', id);
    if (existing.status !== 'draft') {
      return error.badRequest(
        c,
        'Posted journal entries cannot be deleted — create a reversal via POST /:id/reverse instead',
      );
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: existing.entityId,
      entityType: 'journal_entry',
      entityId: id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'journal_entry', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/journal-entries] delete failed:', err);
    return error.internal(c, 'Failed to delete journal entry');
  }
});

export const journalEntriesRoutes = app;
