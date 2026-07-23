/**
 * Bank transaction routes — flat /api/bank-transactions/* surface backed by `bankTransactions`.
 *
 * Ported from apps/api-worker/src/routes/accounting/bank-transactions.ts.
 * Transactions enter the ledger exclusively via POST /import (MT940 /
 * CAMT.053 / CSV statement files) — there is deliberately no generic
 * create/update/delete surface. Reconciliation state changes go through
 * /:id/reconcile, /:id/exclude, and /auto-reconcile, and every one of them
 * is written to the accounting audit log (administratieplicht).
 *
 * Permissions: banking:read | banking:create | banking:update.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, like, lte, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { resolveEntityId } from '../../lib/entity-context';
import { parseBankFile } from '../../services/bank-parsers';
import { autoReconcileBatch } from '../../services/accounting-reconciliation';
import { writeAccountingAudit } from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const reconcileSchema = z.object({
  type: z.enum(['invoice', 'bill', 'manual']),
  entityId: z.string().optional(),
  categoryAccountId: z.string().optional(),
  taxRateId: z.string().optional(),
  contactId: z.string().optional(),
});

const importSchema = z.object({
  bankAccountId: z.string().min(1),
  content: z.string().min(1),
  fileName: z.string().min(1),
  format: z.enum(['mt940', 'camt053', 'csv']).optional(),
});

const autoReconcileSchema = z.object({
  bankAccountId: z.string().min(1),
});

// GET / — paged list, entity-scoped, filterable
app.get('/', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const { bankTransactions } = schema;
  const q = c.req.query();
  const page = Math.max(parseInt(q.page || '1', 10), 1);
  const pageSize = Math.min(Math.max(parseInt(q.pageSize || '25', 10), 1), 100);

  try {
    const accountingEntityId = await resolveEntityId(c, db);
    if (!accountingEntityId) return error.badRequest(c, 'No accounting entity resolved');

    const conditions = [isNull(bankTransactions.deletedAt), eq(bankTransactions.entityId, accountingEntityId)];
    if (q.bankAccountId) conditions.push(eq(bankTransactions.bankAccountId, q.bankAccountId));
    if (q.status) conditions.push(eq(bankTransactions.status, q.status));
    if (q.from) conditions.push(gte(bankTransactions.date, new Date(q.from)));
    if (q.to) conditions.push(lte(bankTransactions.date, new Date(q.to)));
    if (q.search) {
      const term = `%${q.search}%`;
      conditions.push(
        or(
          like(bankTransactions.description, term),
          like(bankTransactions.counterpartyName, term),
          like(bankTransactions.reference, term),
        )!,
      );
    }

    const where = and(...conditions);
    const [rows, countRes] = await Promise.all([
      db.select().from(bankTransactions).where(where).orderBy(desc(bankTransactions.date))
        .limit(pageSize).offset((page - 1) * pageSize),
      db.select({ count: sql<number>`count(*)::int` }).from(bankTransactions).where(where),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, rows, cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    console.error('[app-api/bank-transactions] list failed:', err);
    return error.internal(c, 'Failed to fetch bank transactions');
  }
});

// GET /unreconciled
app.get('/unreconciled', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const { bankTransactions } = schema;
  try {
    const results = await db
      .select()
      .from(bankTransactions)
      .where(and(isNull(bankTransactions.deletedAt), eq(bankTransactions.status, 'unreconciled')))
      .orderBy(desc(bankTransactions.date))
      .limit(100);
    return success(c, results);
  } catch (err) {
    console.error('[app-api/bank-transactions] unreconciled failed:', err);
    return error.internal(c, 'Failed to fetch unreconciled transactions');
  }
});

// POST /import — parse and import bank transactions from MT940/CAMT.053/CSV files
app.post('/import', requirePermission('banking:create'), zValidator('json', importSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const { bankTransactions, bankImportBatches, bankAccounts } = schema;

  try {
    // Verify bank account exists
    const [bankAccount] = await db.select().from(bankAccounts)
      .where(and(eq(bankAccounts.id, data.bankAccountId), isNull(bankAccounts.deletedAt))).limit(1);
    if (!bankAccount) return error.notFound(c, 'Bank account', data.bankAccountId);

    // Parse the file
    const parseResult = parseBankFile(data.content, data.format);

    // Bank account already resolved above — inherit its entityId onto the batch/txns.
    const accountingEntityId = bankAccount.entityId;

    // Create import batch
    const batchId = generateId('bib');
    await db.insert(bankImportBatches).values({
      id: batchId,
      entityId: accountingEntityId,
      bankAccountId: data.bankAccountId,
      fileName: data.fileName,
      format: parseResult.format,
      totalTransactions: parseResult.transactions.length,
      importedCount: 0,
      duplicateCount: 0,
      autoReconciledCount: 0,
      status: 'processing',
      dateRange: parseResult.dateRange ? { from: parseResult.dateRange.from, to: parseResult.dateRange.to } : null,
      openingBalance: parseResult.openingBalance?.toString() ?? null,
      closingBalance: parseResult.closingBalance?.toString() ?? null,
      errors: parseResult.errors.length > 0 ? parseResult.errors : null,
      importedBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Import transactions (skip duplicates by externalId)
    let importedCount = 0;
    let duplicateCount = 0;

    for (const txn of parseResult.transactions) {
      // Check for duplicate
      if (txn.externalId) {
        const existing = await db.select({ id: bankTransactions.id })
          .from(bankTransactions)
          .where(and(
            eq(bankTransactions.bankAccountId, data.bankAccountId),
            eq(bankTransactions.externalId, txn.externalId),
            isNull(bankTransactions.deletedAt),
          )).limit(1);
        if (existing.length > 0) {
          duplicateCount++;
          continue;
        }
      }

      await db.insert(bankTransactions).values({
        id: generateId('bt'),
        entityId: accountingEntityId,
        bankAccountId: data.bankAccountId,
        date: new Date(txn.date),
        valueDate: txn.valueDate ? new Date(txn.valueDate) : null,
        description: txn.description,
        amount: txn.amount.toString(),
        runningBalance: txn.runningBalance?.toString() ?? null,
        counterpartyName: txn.counterpartyName ?? null,
        counterpartyIban: txn.counterpartyIban ?? null,
        counterpartyBic: txn.counterpartyBic ?? null,
        reference: txn.reference ?? null,
        transactionCode: txn.transactionCode ?? null,
        endToEndId: txn.endToEndId ?? null,
        mandateId: txn.mandateId ?? null,
        importBatchId: batchId,
        externalId: txn.externalId ?? null,
        status: 'unreconciled',
        rawData: txn.rawData ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      importedCount++;
    }

    // Run auto-reconciliation
    let autoReconciledCount = 0;
    if (bankAccount.autoReconcile) {
      try {
        const reconcileResult = await autoReconcileBatch(db, schema, data.bankAccountId);
        autoReconciledCount = reconcileResult.reconciledCount;
      } catch {
        // Auto-reconciliation is best-effort
      }
    }

    // Update batch status
    await db.update(bankImportBatches).set({
      status: parseResult.errors.length > 0 && importedCount > 0 ? 'partial' : importedCount > 0 ? 'completed' : 'failed',
      importedCount,
      duplicateCount,
      autoReconciledCount,
      updatedAt: new Date(),
    }).where(eq(bankImportBatches.id, batchId));

    // Update bank account last import info
    if (importedCount > 0) {
      const updateData: Record<string, unknown> = {
        lastImportDate: new Date(),
        updatedAt: new Date(),
      };
      if (parseResult.closingBalance != null) {
        updateData.lastImportBalance = parseResult.closingBalance.toString();
        updateData.currentBalance = parseResult.closingBalance.toString();
      }
      await db.update(bankAccounts).set(updateData).where(eq(bankAccounts.id, data.bankAccountId));
    }

    await writeAccountingAudit(c, db, {
      accountingEntityId,
      entityType: 'bank_import_batch',
      entityId: batchId,
      action: 'imported',
      changes: {
        fileName: { old: null, new: data.fileName },
        format: { old: null, new: parseResult.format },
        totalTransactions: { old: null, new: parseResult.transactions.length },
        importedCount: { old: null, new: importedCount },
        duplicateCount: { old: null, new: duplicateCount },
        autoReconciledCount: { old: null, new: autoReconciledCount },
        errorCount: { old: null, new: parseResult.errors.length },
      },
    });

    return success(c, {
      batchId,
      format: parseResult.format,
      totalParsed: parseResult.transactions.length,
      imported: importedCount,
      duplicates: duplicateCount,
      autoReconciled: autoReconciledCount,
      errors: parseResult.errors,
    }, 201);
  } catch (err) {
    console.error('[app-api/bank-transactions] import failed:', err);
    const message = err instanceof Error ? err.message : 'unknown error';
    return error.internal(c, `Failed to import bank file: ${message}`);
  }
});

// POST /auto-reconcile — run auto-matching on all unreconciled transactions for a bank account
app.post('/auto-reconcile', requirePermission('banking:update'), zValidator('json', autoReconcileSchema), async (c) => {
  const db = c.get('tenantDb');
  const { bankAccountId } = c.req.valid('json');
  const { bankAccounts } = schema;
  try {
    const [bankAccount] = await db.select().from(bankAccounts)
      .where(and(eq(bankAccounts.id, bankAccountId), isNull(bankAccounts.deletedAt))).limit(1);
    if (!bankAccount) return error.notFound(c, 'Bank account', bankAccountId);

    const result = await autoReconcileBatch(db, schema, bankAccountId);

    await writeAccountingAudit(c, db, {
      accountingEntityId: bankAccount.entityId,
      entityType: 'bank_account',
      entityId: bankAccountId,
      action: 'auto_reconciled',
      changes: {
        reconciledCount: { old: null, new: result.reconciledCount },
      },
    });

    return success(c, result);
  } catch (err) {
    console.error('[app-api/bank-transactions] auto-reconcile failed:', err);
    return error.internal(c, 'Failed to auto-reconcile');
  }
});

// GET /:id
app.get('/:id', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const { bankTransactions } = schema;
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(bankTransactions)
      .where(and(eq(bankTransactions.id, id), isNull(bankTransactions.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Bank transaction', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/bank-transactions] get failed:', err);
    return error.internal(c, 'Failed to fetch bank transaction');
  }
});

// GET /:id/suggestions — matching suggestions for a transaction
app.get('/:id/suggestions', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const txnId = c.req.param('id');
  const { bankTransactions, invoices: invoicesTable, bills: billsTable, parties } = schema;

  try {
    const [txn] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, txnId)).limit(1);
    if (!txn) return error.notFound(c, 'Transaction', txnId);

    const amount = parseFloat(txn.amount || '0');
    const suggestions: Array<{ type: string; id: string; number: string | null; contactName: string | null; amount: string | null; confidence: number }> = [];

    if (amount > 0) {
      // Incoming: match against open invoices
      const openInvoices = await db
        .select()
        .from(invoicesTable)
        .where(and(isNull(invoicesTable.deletedAt), sql`${invoicesTable.balanceDue}::numeric > 0`))
        .limit(20);

      for (const inv of openInvoices) {
        let confidence = 0;
        if (Math.abs(parseFloat(inv.balanceDue || '0') - Math.abs(amount)) < 0.01) confidence += 0.5;
        if (txn.counterpartyIban && txn.reference && inv.invoiceNumber && txn.reference.includes(inv.invoiceNumber)) confidence += 0.3;

        // Check IBAN match via contact
        if (txn.counterpartyIban && inv.contactId) {
          const [contact] = await db.select().from(parties)
            .where(and(eq(parties.id, inv.contactId), eq(parties.iban, txn.counterpartyIban))).limit(1);
          if (contact) confidence += 0.2;
        }

        if (confidence > 0) {
          suggestions.push({ type: 'invoice', id: inv.id, number: inv.invoiceNumber, contactName: inv.contactName, amount: inv.balanceDue, confidence });
        }
      }
    } else {
      // Outgoing: match against open bills
      const openBills = await db
        .select()
        .from(billsTable)
        .where(and(isNull(billsTable.deletedAt), sql`${billsTable.balanceDue}::numeric > 0`))
        .limit(20);

      for (const bill of openBills) {
        let confidence = 0;
        if (Math.abs(parseFloat(bill.balanceDue || '0') - Math.abs(amount)) < 0.01) confidence += 0.5;
        if (txn.reference && bill.externalReference && txn.reference.includes(bill.externalReference)) confidence += 0.3;

        if (confidence > 0) {
          suggestions.push({ type: 'bill', id: bill.id, number: bill.billNumber, contactName: bill.contactName, amount: bill.balanceDue, confidence });
        }
      }
    }

    suggestions.sort((a, b) => b.confidence - a.confidence);
    return success(c, suggestions.slice(0, 10));
  } catch (err) {
    console.error('[app-api/bank-transactions] suggestions failed:', err);
    return error.internal(c, 'Failed to fetch suggestions');
  }
});

// POST /:id/reconcile
app.post('/:id/reconcile', requirePermission('banking:update'), zValidator('json', reconcileSchema), async (c) => {
  const db = c.get('tenantDb');
  const txnId = c.req.param('id');
  const data = c.req.valid('json');
  const { bankTransactions } = schema;

  try {
    const [txn] = await db.select().from(bankTransactions)
      .where(and(eq(bankTransactions.id, txnId), isNull(bankTransactions.deletedAt))).limit(1);
    if (!txn) return error.notFound(c, 'Transaction', txnId);

    const updateData: Record<string, unknown> = {
      status: 'reconciled',
      reconciliationType: data.type,
      updatedAt: new Date(),
    };

    if (data.type === 'invoice') updateData.reconciledInvoiceId = data.entityId;
    if (data.type === 'bill') updateData.reconciledBillId = data.entityId;
    if (data.categoryAccountId) updateData.categoryAccountId = data.categoryAccountId;
    if (data.taxRateId) updateData.taxRateId = data.taxRateId;
    if (data.contactId) updateData.contactId = data.contactId;

    await db.update(bankTransactions).set(updateData).where(eq(bankTransactions.id, txnId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: txn.entityId,
      entityType: 'bank_transaction',
      entityId: txnId,
      action: 'reconciled',
      changes: {
        status: { old: txn.status, new: 'reconciled' },
        reconciliationType: { old: txn.reconciliationType, new: data.type },
        ...(data.type === 'invoice' ? { reconciledInvoiceId: { old: txn.reconciledInvoiceId, new: data.entityId ?? null } } : {}),
        ...(data.type === 'bill' ? { reconciledBillId: { old: txn.reconciledBillId, new: data.entityId ?? null } } : {}),
      },
    });
    publishEntityEvent({
      c,
      entityType: 'bank_transaction',
      entityId: txnId,
      action: 'updated',
      data: { id: txnId, bankAccountId: txn.bankAccountId, amount: txn.amount || '0', description: txn.description, status: 'reconciled' },
    });

    return success(c, { id: txnId, status: 'reconciled' });
  } catch (err) {
    console.error('[app-api/bank-transactions] reconcile failed:', err);
    return error.internal(c, 'Failed to reconcile transaction');
  }
});

// POST /:id/exclude
app.post('/:id/exclude', requirePermission('banking:update'), async (c) => {
  const db = c.get('tenantDb');
  const txnId = c.req.param('id');
  const { bankTransactions } = schema;
  try {
    const [txn] = await db.select().from(bankTransactions)
      .where(and(eq(bankTransactions.id, txnId), isNull(bankTransactions.deletedAt))).limit(1);
    if (!txn) return error.notFound(c, 'Transaction', txnId);

    await db.update(bankTransactions)
      .set({ status: 'excluded', updatedAt: new Date() })
      .where(eq(bankTransactions.id, txnId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: txn.entityId,
      entityType: 'bank_transaction',
      entityId: txnId,
      action: 'excluded',
      changes: { status: { old: txn.status, new: 'excluded' } },
    });
    publishEntityEvent({
      c,
      entityType: 'bank_transaction',
      entityId: txnId,
      action: 'updated',
      data: { id: txnId, bankAccountId: txn.bankAccountId, amount: txn.amount || '0', description: txn.description, status: 'excluded' },
    });

    return success(c, { message: 'Transaction excluded' });
  } catch (err) {
    console.error('[app-api/bank-transactions] exclude failed:', err);
    return error.internal(c, 'Failed to exclude transaction');
  }
});

export const bankTransactionsRoutes = app;
