/**
 * Bank transaction routes — flat /api/bank-transactions/* surface backed by `bankTransactions`.
 *
 * Ported from apps/api-worker/src/routes/accounting/bank-transactions.ts.
 * Transactions enter the ledger via POST / (manual cashbook entry) or
 * POST /import (MT940 / CAMT.053 / CSV statement files). POST / can also
 * take `categoryAccountId` to post immediately (fee refunds, settlements).
 * Reconciliation state changes go through /:id/reconcile (invoice or bill →
 * a posted payment that settles the document; manual + categoryAccountId →
 * a posted entry, with the tax split out when a rate is given),
 * /:id/unreconcile (voids that payment or reverses that entry), /:id/exclude
 * and /auto-reconcile. Every one of them is written to the accounting audit
 * log (administratieplicht).
 *
 * Permissions: banking:read | banking:create | banking:update.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, like, lte, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createBankTransactionSchema } from '@weldsuite/core-api-client/schemas/bank-transactions';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { resolveEntityId } from '../../lib/entity-context';
import { parseBankFile } from '../../services/bank-parsers';
import { autoReconcileBatch } from '../../services/accounting-reconciliation';
import {
  ClosedPeriodError,
  LockedPeriodError,
  writeAccountingAudit,
} from '@weldsuite/books-domain/accounting-guards';
import {
  BankCategorizeError,
  categorizeBankTransaction,
} from '../../services/accounting-bank-categorize';
import {
  reconcileBankTransactionToDocument,
  unreconcileBankTransaction,
} from '../../services/accounting-bank-match';
import { PostingError } from '../../services/accounting-posting';

/** Errors the user can fix: answered with 400 and the message. */
function isUserFixable(err: unknown): err is Error {
  return (
    err instanceof BankCategorizeError ||
    err instanceof ClosedPeriodError ||
    err instanceof LockedPeriodError ||
    err instanceof PostingError
  );
}

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
  const page = Math.max(Number.parseInt(q.page || '1', 10), 1);
  const pageSize = Math.min(Math.max(Number.parseInt(q.pageSize || '25', 10), 1), 100);

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

function roundMoney(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function parseDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type BankAccountRow = typeof schema.bankAccounts.$inferSelect;
type BankTransactionRow = typeof schema.bankTransactions.$inferSelect;
type CreateBankTransactionInput = z.infer<typeof createBankTransactionSchema>;

/** Parse the manual entry's `date` / `valueDate`, or return the 400 message. */
function parseManualDates(
  data: CreateBankTransactionInput,
): { date: Date; valueDate: Date | null } | { errorMessage: string } {
  const date = parseDate(data.date);
  if (!date) return { errorMessage: 'Invalid date' };
  const valueDate = data.valueDate ? parseDate(data.valueDate) : null;
  if (data.valueDate && !valueDate) return { errorMessage: 'Invalid valueDate' };
  return { date, valueDate };
}

/** Build the row for a manually recorded (cashbook) transaction. */
function buildManualTransaction(
  bankAccount: BankAccountRow,
  data: CreateBankTransactionInput,
  dates: { date: Date; valueDate: Date | null },
) {
  const amountNumber = typeof data.amount === 'number' ? data.amount : Number(data.amount);
  const amount = roundMoney(amountNumber);
  const previousBalance = Number(bankAccount.currentBalance || '0');
  const runningBalance = roundMoney(previousBalance + Number(amount));
  const now = new Date();
  const counterpartyIban = data.counterpartyIban
    ? data.counterpartyIban.replace(/\s+/g, '').toUpperCase()
    : null;

  return {
    id: generateId('bt'),
    entityId: bankAccount.entityId,
    bankAccountId: data.bankAccountId,
    date: dates.date,
    valueDate: dates.valueDate,
    description: data.description?.trim() || null,
    amount,
    runningBalance,
    counterpartyName: data.counterpartyName?.trim() || null,
    counterpartyIban,
    counterpartyBic: data.counterpartyBic?.trim().toUpperCase() || null,
    reference: data.reference?.trim() || null,
    notes: data.notes?.trim() || null,
    importBatchId: null,
    externalId: null,
    status: 'unreconciled' as const,
    rawData: { source: 'manual' },
    createdAt: now,
    updatedAt: now,
  };
}

/** Write the audit trail and entity events for a manually created transaction. */
async function recordManualCreated(
  c: AppContext,
  db: Database,
  txn: ReturnType<typeof buildManualTransaction>,
  journalEntryId: string | null,
): Promise<void> {
  await writeAccountingAudit(c, db, {
    accountingEntityId: txn.entityId,
    entityType: 'bank_transaction',
    entityId: txn.id,
    action: 'created',
    changes: {
      bankAccountId: { old: null, new: txn.bankAccountId },
      date: { old: null, new: txn.date.toISOString() },
      amount: { old: null, new: txn.amount },
      description: { old: null, new: txn.description },
      source: { old: null, new: 'manual' },
      ...(journalEntryId ? { journalEntryId: { old: null, new: journalEntryId } } : {}),
    },
  });
  publishEntityEvent({
    c,
    entityType: 'bank_transaction',
    entityId: txn.id,
    action: 'created',
    data: {
      id: txn.id,
      bankAccountId: txn.bankAccountId,
      amount: txn.amount,
      description: txn.description,
      date: txn.date.toISOString(),
      status: journalEntryId ? 'reconciled' : 'unreconciled',
    },
  });
  if (journalEntryId) {
    publishEntityEvent({
      c,
      entityType: 'journal_entry',
      entityId: journalEntryId,
      action: 'created',
      data: { id: journalEntryId, sourceType: 'bank_transaction', sourceId: txn.id },
    });
  }
}

// POST / — manually record a single bank transaction (cashbook entry)
app.post('/', requirePermission('banking:create'), zValidator('json', createBankTransactionSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const { bankTransactions, bankAccounts } = schema;

  try {
    const [bankAccount] = await db.select().from(bankAccounts)
      .where(and(eq(bankAccounts.id, data.bankAccountId), isNull(bankAccounts.deletedAt))).limit(1);
    if (!bankAccount) return error.notFound(c, 'Bank account', data.bankAccountId);
    if (data.categoryAccountId && !bankAccount.ledgerAccountId) {
      return error.badRequest(
        c,
        'This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.',
      );
    }

    const dates = parseManualDates(data);
    if ('errorMessage' in dates) return error.badRequest(c, dates.errorMessage);

    const txn = buildManualTransaction(bankAccount, data, dates);

    await db.insert(bankTransactions).values(txn);
    await db.update(bankAccounts).set({
      currentBalance: txn.runningBalance,
      updatedAt: txn.updatedAt,
    }).where(eq(bankAccounts.id, data.bankAccountId));

    let journalEntryId: string | null = null;
    if (data.categoryAccountId) {
      const [inserted] = await db.select().from(bankTransactions)
        .where(eq(bankTransactions.id, txn.id)).limit(1);
      if (!inserted) return error.internal(c, 'Failed to create bank transaction');
      const posted = await categorizeBankTransaction(db, {
        txn: inserted,
        categoryAccountId: data.categoryAccountId,
        taxRateId: (data as { taxRateId?: string | null }).taxRateId ?? null,
        userId: c.get('userId') ?? null,
      });
      journalEntryId = posted.journalEntryId;
    }

    await recordManualCreated(c, db, txn, journalEntryId);

    return success(c, {
      ...txn,
      status: journalEntryId ? 'reconciled' : 'unreconciled',
      journalEntryId,
      categoryAccountId: data.categoryAccountId ?? null,
    }, 201);
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[app-api/bank-transactions] create failed:', err);
    return error.internal(c, 'Failed to create bank transaction');
  }
});

type ParsedBankFile = ReturnType<typeof parseBankFile>;
type ParsedBankTransaction = ParsedBankFile['transactions'][number];

/** Create the import batch row in `processing` state. */
async function createImportBatch(
  db: Database,
  args: {
    batchId: string;
    accountingEntityId: string;
    bankAccountId: string;
    fileName: string;
    userId: string;
    parseResult: ParsedBankFile;
  },
): Promise<void> {
  const { batchId, accountingEntityId, bankAccountId, fileName, userId, parseResult } = args;
  await db.insert(schema.bankImportBatches).values({
    id: batchId,
    entityId: accountingEntityId,
    bankAccountId,
    fileName,
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
}

/** Whether a transaction with this externalId was already imported for the account. */
async function isDuplicateImport(db: Database, bankAccountId: string, externalId: string): Promise<boolean> {
  const { bankTransactions } = schema;
  const existing = await db.select({ id: bankTransactions.id })
    .from(bankTransactions)
    .where(and(
      eq(bankTransactions.bankAccountId, bankAccountId),
      eq(bankTransactions.externalId, externalId),
      isNull(bankTransactions.deletedAt),
    )).limit(1);
  return existing.length > 0;
}

/** Insert one parsed statement line as an unreconciled transaction. */
async function insertImportedTransaction(
  db: Database,
  txn: ParsedBankTransaction,
  ids: { accountingEntityId: string; bankAccountId: string; batchId: string },
): Promise<void> {
  await db.insert(schema.bankTransactions).values({
    id: generateId('bt'),
    entityId: ids.accountingEntityId,
    bankAccountId: ids.bankAccountId,
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
    importBatchId: ids.batchId,
    externalId: txn.externalId ?? null,
    status: 'unreconciled',
    rawData: txn.rawData ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Import transactions, skipping duplicates by externalId. */
async function importTransactions(
  db: Database,
  transactions: ParsedBankTransaction[],
  ids: { accountingEntityId: string; bankAccountId: string; batchId: string },
): Promise<{ importedCount: number; duplicateCount: number }> {
  let importedCount = 0;
  let duplicateCount = 0;

  for (const txn of transactions) {
    if (txn.externalId && (await isDuplicateImport(db, ids.bankAccountId, txn.externalId))) {
      duplicateCount++;
      continue;
    }
    await insertImportedTransaction(db, txn, ids);
    importedCount++;
  }

  return { importedCount, duplicateCount };
}

/** Best-effort auto-reconciliation; a failure never fails the import. */
async function tryAutoReconcile(db: Database, bankAccountId: string): Promise<number> {
  try {
    const reconcileResult = await autoReconcileBatch(db, schema, bankAccountId, null);
    return reconcileResult.reconciledCount;
  } catch {
    // Auto-reconciliation is best-effort
    return 0;
  }
}

/** Final batch status derived from what was parsed and imported. */
function importBatchStatus(errorCount: number, importedCount: number): 'partial' | 'completed' | 'failed' {
  if (importedCount === 0) return 'failed';
  return errorCount > 0 ? 'partial' : 'completed';
}

/** Record the last import date / closing balance on the bank account. */
async function updateAccountAfterImport(
  db: Database,
  bankAccountId: string,
  closingBalance: ParsedBankFile['closingBalance'],
): Promise<void> {
  const updateData: Record<string, unknown> = {
    lastImportDate: new Date(),
    updatedAt: new Date(),
  };
  if (closingBalance != null) {
    updateData.lastImportBalance = closingBalance.toString();
    updateData.currentBalance = closingBalance.toString();
  }
  await db.update(schema.bankAccounts).set(updateData).where(eq(schema.bankAccounts.id, bankAccountId));
}

// POST /import — parse and import bank transactions from MT940/CAMT.053/CSV files
app.post('/import', requirePermission('banking:create'), zValidator('json', importSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const { bankImportBatches, bankAccounts } = schema;

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
    await createImportBatch(db, {
      batchId,
      accountingEntityId,
      bankAccountId: data.bankAccountId,
      fileName: data.fileName,
      userId,
      parseResult,
    });

    // Import transactions (skip duplicates by externalId)
    const { importedCount, duplicateCount } = await importTransactions(db, parseResult.transactions, {
      accountingEntityId,
      bankAccountId: data.bankAccountId,
      batchId,
    });

    // Run auto-reconciliation
    const autoReconciledCount = bankAccount.autoReconcile
      ? await tryAutoReconcile(db, data.bankAccountId)
      : 0;

    // Update batch status
    await db.update(bankImportBatches).set({
      status: importBatchStatus(parseResult.errors.length, importedCount),
      importedCount,
      duplicateCount,
      autoReconciledCount,
      updatedAt: new Date(),
    }).where(eq(bankImportBatches.id, batchId));

    // Update bank account last import info
    if (importedCount > 0) {
      await updateAccountAfterImport(db, data.bankAccountId, parseResult.closingBalance);
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

    const result = await autoReconcileBatch(db, schema, bankAccountId, c.get('userId') ?? null);

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

interface MatchSuggestion {
  type: string;
  id: string;
  number: string | null;
  contactName: string | null;
  amount: string | null;
  confidence: number;
}

/** Whether an open balance equals the transaction amount (within one cent). */
function balanceMatches(balanceDue: string | null, amount: number): boolean {
  return Math.abs(Number.parseFloat(balanceDue || '0') - Math.abs(amount)) < 0.01;
}

/** Confidence that an incoming transaction settles the given open invoice. */
async function invoiceConfidence(
  db: Database,
  txn: BankTransactionRow,
  inv: typeof schema.invoices.$inferSelect,
  amount: number,
): Promise<number> {
  let confidence = 0;
  if (balanceMatches(inv.balanceDue, amount)) confidence += 0.5;
  if (txn.counterpartyIban && txn.reference && inv.invoiceNumber && txn.reference.includes(inv.invoiceNumber)) confidence += 0.3;

  // Check IBAN match via contact
  if (txn.counterpartyIban && inv.contactId) {
    const [contact] = await db.select().from(schema.parties)
      .where(and(eq(schema.parties.id, inv.contactId), eq(schema.parties.iban, txn.counterpartyIban))).limit(1);
    if (contact) confidence += 0.2;
  }
  return confidence;
}

/** Incoming: match against open invoices. */
async function suggestInvoices(db: Database, txn: BankTransactionRow, amount: number): Promise<MatchSuggestion[]> {
  const invoicesTable = schema.invoices;
  const openInvoices = await db
    .select()
    .from(invoicesTable)
    .where(and(isNull(invoicesTable.deletedAt), sql`${invoicesTable.balanceDue}::numeric > 0`))
    .limit(20);

  const suggestions: MatchSuggestion[] = [];
  for (const inv of openInvoices) {
    const confidence = await invoiceConfidence(db, txn, inv, amount);
    if (confidence > 0) {
      suggestions.push({ type: 'invoice', id: inv.id, number: inv.invoiceNumber, contactName: inv.contactName, amount: inv.balanceDue, confidence });
    }
  }
  return suggestions;
}

/** Outgoing: match against open bills. */
async function suggestBills(db: Database, txn: BankTransactionRow, amount: number): Promise<MatchSuggestion[]> {
  const billsTable = schema.bills;
  const openBills = await db
    .select()
    .from(billsTable)
    .where(and(isNull(billsTable.deletedAt), sql`${billsTable.balanceDue}::numeric > 0`))
    .limit(20);

  const suggestions: MatchSuggestion[] = [];
  for (const bill of openBills) {
    let confidence = 0;
    if (balanceMatches(bill.balanceDue, amount)) confidence += 0.5;
    if (txn.reference && bill.externalReference && txn.reference.includes(bill.externalReference)) confidence += 0.3;

    if (confidence > 0) {
      suggestions.push({ type: 'bill', id: bill.id, number: bill.billNumber, contactName: bill.contactName, amount: bill.balanceDue, confidence });
    }
  }
  return suggestions;
}

// GET /:id/suggestions — matching suggestions for a transaction
app.get('/:id/suggestions', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const txnId = c.req.param('id');
  const { bankTransactions } = schema;

  try {
    const [txn] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, txnId)).limit(1);
    if (!txn) return error.notFound(c, 'Transaction', txnId);

    const amount = Number.parseFloat(txn.amount || '0');
    const suggestions = amount > 0
      ? await suggestInvoices(db, txn, amount)
      : await suggestBills(db, txn, amount);

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

    if (data.type === 'manual') {
      if (!data.categoryAccountId) {
        return error.badRequest(c, 'categoryAccountId is required to categorize a transaction without an invoice or bill');
      }
      const posted = await categorizeBankTransaction(db, {
        txn,
        categoryAccountId: data.categoryAccountId,
        contactId: data.contactId,
        taxRateId: data.taxRateId ?? null,
        userId: c.get('userId') ?? null,
      });
      await writeAccountingAudit(c, db, {
        accountingEntityId: txn.entityId,
        entityType: 'bank_transaction',
        entityId: txnId,
        action: 'reconciled',
        changes: {
          status: { old: txn.status, new: 'reconciled' },
          reconciliationType: { old: txn.reconciliationType, new: 'manual' },
          categoryAccountId: { old: txn.categoryAccountId, new: data.categoryAccountId },
          journalEntryId: { old: txn.journalEntryId, new: posted.journalEntryId },
        },
      });
      publishEntityEvent({
        c,
        entityType: 'bank_transaction',
        entityId: txnId,
        action: 'updated',
        data: { id: txnId, bankAccountId: txn.bankAccountId, amount: txn.amount || '0', description: txn.description, status: 'reconciled' },
      });
      publishEntityEvent({
        c,
        entityType: 'journal_entry',
        entityId: posted.journalEntryId,
        action: 'created',
        data: { id: posted.journalEntryId, sourceType: 'bank_transaction', sourceId: txnId },
      });
      return success(c, { id: txnId, status: 'reconciled', journalEntryId: posted.journalEntryId });
    }

    if (!data.entityId) return error.badRequest(c, 'entityId (the invoice or bill id) is required');
    const matched = await reconcileBankTransactionToDocument(db, {
      txn,
      type: data.type,
      documentId: data.entityId,
      userId: c.get('userId') ?? null,
    });

    await writeAccountingAudit(c, db, {
      accountingEntityId: txn.entityId,
      entityType: 'bank_transaction',
      entityId: txnId,
      action: 'reconciled',
      changes: {
        status: { old: txn.status, new: 'reconciled' },
        reconciliationType: { old: txn.reconciliationType, new: 'manual' },
        reconciledPaymentId: { old: txn.reconciledPaymentId, new: matched.paymentId },
        ...(data.type === 'invoice' ? { reconciledInvoiceId: { old: txn.reconciledInvoiceId, new: data.entityId } } : {}),
        ...(data.type === 'bill' ? { reconciledBillId: { old: txn.reconciledBillId, new: data.entityId } } : {}),
      },
    });
    publishEntityEvent({
      c,
      entityType: 'bank_transaction',
      entityId: txnId,
      action: 'updated',
      data: { id: txnId, bankAccountId: txn.bankAccountId, amount: txn.amount || '0', description: txn.description, status: 'reconciled' },
    });
    publishEntityEvent({
      c,
      entityType: 'payment',
      entityId: matched.paymentId,
      action: 'created',
      data: {
        id: matched.paymentId,
        amount: String(Math.abs(Number(txn.amount))),
        invoiceId: data.type === 'invoice' ? data.entityId : undefined,
        billId: data.type === 'bill' ? data.entityId : undefined,
      },
    });

    return success(c, { id: txnId, status: 'reconciled', paymentId: matched.paymentId, journalEntryId: matched.journalEntryId });
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[app-api/bank-transactions] reconcile failed:', err);
    return error.internal(c, 'Failed to reconcile transaction');
  }
});

// POST /:id/unreconcile — undo a match or categorization (voids the payment / reverses the entry)
app.post('/:id/unreconcile', requirePermission('banking:update'), async (c) => {
  const db = c.get('tenantDb');
  const txnId = c.req.param('id');
  const { bankTransactions } = schema;
  try {
    const [txn] = await db.select().from(bankTransactions)
      .where(and(eq(bankTransactions.id, txnId), isNull(bankTransactions.deletedAt))).limit(1);
    if (!txn) return error.notFound(c, 'Transaction', txnId);

    await unreconcileBankTransaction(db, { txn, userId: c.get('userId') ?? null });

    await writeAccountingAudit(c, db, {
      accountingEntityId: txn.entityId,
      entityType: 'bank_transaction',
      entityId: txnId,
      action: 'unreconciled',
      changes: {
        status: { old: txn.status, new: 'unreconciled' },
        reconciledPaymentId: { old: txn.reconciledPaymentId, new: null },
        journalEntryId: { old: txn.journalEntryId, new: null },
      },
    });
    publishEntityEvent({
      c,
      entityType: 'bank_transaction',
      entityId: txnId,
      action: 'updated',
      data: { id: txnId, bankAccountId: txn.bankAccountId, amount: txn.amount || '0', description: txn.description, status: 'unreconciled' },
    });
    return success(c, { id: txnId, status: 'unreconciled' });
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-transactions] unreconcile failed:', err);
    return error.internal(c, 'Failed to unreconcile transaction');
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
