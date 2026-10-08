/**
 * Bank transaction routes — flat /api/bank-transactions/* surface backed by `bankTransactions`.
 *
 * Ported from apps/api-worker/src/routes/accounting/bank-transactions.ts.
 * Transactions enter the books via POST / (manual cashbook entry) or
 * POST /import (OFX / QFX / QBO, BAI2, CSV with an explicit layout, MT940,
 * CAMT.053; POST /import/preview reads a file without importing it). POST /
 * can also take `categoryAccountId` to post immediately (fee refunds,
 * settlements). Lines carry `source` (import | feed | manual) and a
 * `checkNumber`; GET /:id/suggestions matches by invoice number, IBAN,
 * counterparty name + amount + date window, check number and deposit total.
 * A line can also be tied to a payment that already exists
 * (POST /:id/match-payment) or to a bank deposit (POST /:id/match-deposit),
 * which links without posting.
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
import {
  CsvFormatRequiredError,
  detectCsvFormat,
  parseBankFile,
  type CsvFormat,
} from '../../services/bank-parsers';
import { csvFormatSchema } from '../../services/bank-parsers/csv-format-schema';
import { countDuplicates, importParsedTransactions } from '../../services/accounting-bank-import';
import { autoReconcileBatch, findMatches } from '../../services/accounting-reconciliation';
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
  reconcileBankTransactionToDeposit,
  reconcileBankTransactionToDocument,
  reconcileBankTransactionToPayment,
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

const fileFormat = z.enum(['mt940', 'camt053', 'csv', 'ofx', 'qfx', 'qbo', 'bai2']);

const importSchema = z.object({
  bankAccountId: z.string().min(1),
  content: z.string().min(1),
  fileName: z.string().min(1),
  /** Forces a format; otherwise it is read from the file's content and extension. */
  format: fileFormat.optional(),
  /** CSV layout; falls back to the one remembered on the bank account. */
  csvFormat: csvFormatSchema.optional(),
  /** Remember `csvFormat` on the bank account for the next import. */
  rememberCsvFormat: z.boolean().optional(),
  /** Import although the file names another account number or currency than the bank account. */
  ignoreAccountMismatch: z.boolean().optional(),
});

const previewSchema = z.object({
  bankAccountId: z.string().min(1).optional(),
  content: z.string().min(1),
  fileName: z.string().min(1).optional(),
  format: fileFormat.optional(),
  csvFormat: csvFormatSchema.optional(),
  sampleSize: z.number().int().min(1).max(100).default(20),
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
    // An empty tenant simply has nothing to list.
    if (!accountingEntityId) return list(c, [], cursorPagination(0, false, null));

    const conditions = [isNull(bankTransactions.deletedAt), eq(bankTransactions.entityId, accountingEntityId)];
    if (q.bankAccountId) conditions.push(eq(bankTransactions.bankAccountId, q.bankAccountId));
    if (q.status) conditions.push(eq(bankTransactions.status, q.status));
    if (q.checkNumber) conditions.push(eq(bankTransactions.checkNumber, q.checkNumber));
    if (q.source) conditions.push(eq(bankTransactions.source, q.source));
    if (q.depositId) conditions.push(eq(bankTransactions.depositId, q.depositId));
    if (q.from) conditions.push(gte(bankTransactions.date, new Date(q.from)));
    if (q.to) conditions.push(lte(bankTransactions.date, new Date(q.to)));
    if (q.search) {
      const term = `%${q.search}%`;
      conditions.push(
        or(
          like(bankTransactions.description, term),
          like(bankTransactions.counterpartyName, term),
          like(bankTransactions.reference, term),
          eq(bankTransactions.checkNumber, q.search.trim()),
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
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const bankAccountId = c.req.query('bankAccountId');
    const results = await db
      .select()
      .from(bankTransactions)
      .where(
        and(
          isNull(bankTransactions.deletedAt),
          eq(bankTransactions.entityId, entityId),
          eq(bankTransactions.status, 'unreconciled'),
          ...(bankAccountId ? [eq(bankTransactions.bankAccountId, bankAccountId)] : []),
        ),
      )
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
    source: 'manual' as const,
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
  rememberedCsvFormat?: CsvFormat,
  importSettings?: BankAccountRow['importSettings'],
): Promise<void> {
  const updateData: Record<string, unknown> = {
    lastImportDate: new Date(),
    updatedAt: new Date(),
  };
  if (closingBalance != null) {
    updateData.lastImportBalance = closingBalance.toString();
    updateData.currentBalance = closingBalance.toString();
  }
  if (rememberedCsvFormat) updateData.importSettings = { ...(importSettings ?? {}), csv: rememberedCsvFormat };
  await db.update(schema.bankAccounts).set(updateData).where(eq(schema.bankAccounts.id, bankAccountId));
}

/** The CSV layout to use: the one sent with the request, else the one remembered on the bank account. */
function csvFormatFor(requested: CsvFormat | undefined, account: BankAccountRow): CsvFormat | undefined {
  if (requested) return requested;
  const remembered = csvFormatSchema.safeParse((account.importSettings as { csv?: unknown } | null)?.csv);
  return remembered.success ? remembered.data : undefined;
}

function sameLast4(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b) && a!.slice(-4).toLowerCase() === b!.slice(-4).toLowerCase();
}

/** Why a file can't go into this bank account (wrong account or currency), or null. */
function fileProblem(parse: ParsedBankFile, account: BankAccountRow): { code: string; message: string; details: Record<string, unknown> } | null {
  const fileNumber = parse.account?.accountNumber;
  if (fileNumber && account.accountNumberLast4 && !sameLast4(fileNumber, account.accountNumberLast4)) {
    return {
      code: 'ACCOUNT_MISMATCH',
      message: `This file is for the account ending ${fileNumber.slice(-4)}, but ${account.name} ends in ${account.accountNumberLast4}. Pick the right bank account, or import anyway.`,
      details: { fileAccountLast4: fileNumber.slice(-4), bankAccountLast4: account.accountNumberLast4 },
    };
  }
  const fileCurrency = parse.currency;
  if (fileCurrency && account.currency && fileCurrency.toUpperCase() !== account.currency.toUpperCase()) {
    return {
      code: 'CURRENCY_MISMATCH',
      message: `This file is in ${fileCurrency} but ${account.name} is in ${account.currency}. Pick the right bank account, or import anyway.`,
      details: { fileCurrency, bankAccountCurrency: account.currency },
    };
  }
  return null;
}

/** 422 with a proposed CSV layout for the user to confirm. */
function csvFormatRequired(c: AppContext, err: CsvFormatRequiredError) {
  return c.json(
    { error: { code: 'CSV_FORMAT_REQUIRED', message: err.message, details: { proposal: err.proposal } } },
    422,
  );
}

// POST /import/preview — parse a statement file without importing it
app.post('/import/preview', requirePermission('banking:create'), zValidator('json', previewSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const bankAccount = data.bankAccountId
      ? (await db.select().from(schema.bankAccounts)
          .where(and(eq(schema.bankAccounts.id, data.bankAccountId), isNull(schema.bankAccounts.deletedAt))).limit(1))[0]
      : undefined;
    if (data.bankAccountId && !bankAccount) return error.notFound(c, 'Bank account', data.bankAccountId);

    let parse: ParsedBankFile;
    try {
      parse = parseBankFile(data.content, data.format, {
        fileName: data.fileName,
        csvFormat: bankAccount ? csvFormatFor(data.csvFormat, bankAccount) : data.csvFormat,
        accountLast4: bankAccount?.accountNumberLast4 ?? undefined,
      });
    } catch (err) {
      if (err instanceof CsvFormatRequiredError) {
        return success(c, { format: 'csv' as const, needsCsvFormat: true, proposal: err.proposal });
      }
      throw err;
    }

    const duplicates = bankAccount ? await countDuplicates(db, bankAccount.id, parse.transactions) : null;
    const problem = bankAccount ? fileProblem(parse, bankAccount) : null;
    return success(c, {
      format: parse.format,
      needsCsvFormat: false,
      proposal: parse.format === 'csv' && !data.csvFormat && !bankAccount?.importSettings ? detectCsvFormat(data.content) : undefined,
      account: parse.account ? { ...parse.account, accountNumber: undefined, accountNumberLast4: parse.account.accountNumber?.slice(-4) } : undefined,
      accounts: parse.accounts?.map((a) => ({ ...a, accountNumber: undefined, accountNumberLast4: a.accountNumber?.slice(-4) })),
      currency: parse.currency,
      dateRange: parse.dateRange,
      openingBalance: parse.openingBalance,
      closingBalance: parse.closingBalance,
      totalParsed: parse.transactions.length,
      duplicates,
      problem,
      errors: parse.errors,
      sample: parse.transactions.slice(0, data.sampleSize),
    });
  } catch (err) {
    console.error('[books-api/bank-transactions] import preview failed:', err);
    return error.internal(c, `Failed to read the bank file: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
});

// POST /import — parse and import a statement: OFX / QFX / QBO, BAI2, CSV (explicit layout), MT940, CAMT.053
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
    let parseResult: ParsedBankFile;
    try {
      parseResult = parseBankFile(data.content, data.format, {
        fileName: data.fileName,
        csvFormat: csvFormatFor(data.csvFormat, bankAccount),
        accountLast4: bankAccount.accountNumberLast4 ?? undefined,
      });
    } catch (err) {
      if (err instanceof CsvFormatRequiredError) return csvFormatRequired(c, err);
      throw err;
    }

    const problem = fileProblem(parseResult, bankAccount);
    if (problem && !data.ignoreAccountMismatch) {
      return c.json({ error: { code: problem.code, message: problem.message, details: problem.details } }, 409);
    }

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
    const { importedCount, duplicateCount } = await importParsedTransactions(db, {
      entityId: accountingEntityId,
      bankAccountId: data.bankAccountId,
      batchId,
      transactions: parseResult.transactions,
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

    // Update bank account last import info, and remember a confirmed CSV layout
    const remember = parseResult.format === 'csv' && data.rememberCsvFormat && data.csvFormat ? data.csvFormat : undefined;
    if (importedCount > 0 || remember) {
      await updateAccountAfterImport(
        db,
        data.bankAccountId,
        importedCount > 0 ? parseResult.closingBalance : undefined,
        remember,
        bankAccount.importSettings,
      );
      publishEntityEvent({
        c,
        entityType: 'bank_account',
        entityId: data.bankAccountId,
        action: 'updated',
        data: { id: data.bankAccountId, lastImportDate: new Date().toISOString(), importedCount },
      });
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
      dateRange: parseResult.dateRange ?? null,
      closingBalance: parseResult.closingBalance ?? null,
      currency: parseResult.currency ?? null,
      csvFormatRemembered: Boolean(remember),
      warning: problem ? { code: problem.code, message: problem.message } : null,
    }, 201);
  } catch (err) {
    console.error('[books-api/bank-transactions] import failed:', err);
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

// GET /:id/suggestions — what the books know about a bank line: open invoices and bills, recorded payments (check numbers), deposits
app.get('/:id/suggestions', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const txnId = c.req.param('id');
  const { bankTransactions } = schema;

  try {
    const [txn] = await db.select().from(bankTransactions)
      .where(and(eq(bankTransactions.id, txnId), isNull(bankTransactions.deletedAt))).limit(1);
    if (!txn) return error.notFound(c, 'Transaction', txnId);

    const matches = await findMatches(db, schema, txn);
    return success(
      c,
      matches.slice(0, 10).map((m) => ({
        type: m.type,
        id: m.entityId,
        number: m.entityNumber,
        contactName: m.contactName,
        amount: m.amount,
        confidence: m.confidence,
        reasons: m.reasons,
      })),
    );
  } catch (err) {
    console.error('[books-api/bank-transactions] suggestions failed:', err);
    return error.internal(c, 'Failed to fetch suggestions');
  }
});

/** Audit trail + events for a line tied to a payment or deposit. */
async function recordLinked(
  c: AppContext,
  txn: BankTransactionRow,
  linked: { kind: 'payment' | 'deposit'; id: string; journalEntryId: string | null },
): Promise<void> {
  const db = c.get('tenantDb');
  await writeAccountingAudit(c, db, {
    accountingEntityId: txn.entityId,
    entityType: 'bank_transaction',
    entityId: txn.id,
    action: 'reconciled',
    changes: {
      status: { old: txn.status, new: 'reconciled' },
      reconciliationType: { old: txn.reconciliationType, new: linked.kind === 'payment' ? 'payment_link' : 'deposit' },
      ...(linked.kind === 'payment' ? { reconciledPaymentId: { old: null, new: linked.id } } : { depositId: { old: null, new: linked.id } }),
    },
  });
  publishEntityEvent({
    c,
    entityType: 'bank_transaction',
    entityId: txn.id,
    action: 'updated',
    data: { id: txn.id, bankAccountId: txn.bankAccountId, amount: txn.amount || '0', description: txn.description, status: 'reconciled' },
  });
  publishEntityEvent({
    c,
    entityType: linked.kind === 'payment' ? 'payment' : 'bank_deposit',
    entityId: linked.id,
    action: 'updated',
    data: { id: linked.id, bankTransactionId: txn.id },
  });
}

/** The bank line of the resolved entity, or null. */
async function findLine(c: AppContext, id: string): Promise<BankTransactionRow | null> {
  const db = c.get('tenantDb');
  const entityId = await resolveEntityId(c, db);
  const [txn] = await db.select().from(schema.bankTransactions)
    .where(and(eq(schema.bankTransactions.id, id), isNull(schema.bankTransactions.deletedAt))).limit(1);
  return txn && (!entityId || txn.entityId === entityId) ? txn : null;
}

// POST /:id/match-deposit — tie an incoming line to the bank deposit it came from
app.post('/:id/match-deposit', requirePermission('banking:update'), zValidator('json', z.object({ depositId: z.string().min(1) })), async (c) => {
  const db = c.get('tenantDb');
  const txnId = c.req.param('id');
  const { depositId } = c.req.valid('json');
  try {
    const txn = await findLine(c, txnId);
    if (!txn) return error.notFound(c, 'Transaction', txnId);
    const linked = await reconcileBankTransactionToDeposit(db, { txn, depositId, userId: c.get('userId') ?? null });
    await recordLinked(c, txn, { kind: 'deposit', id: depositId, journalEntryId: linked.journalEntryId });
    return success(c, { id: txnId, status: 'reconciled', depositId, journalEntryId: linked.journalEntryId });
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-transactions] match-deposit failed:', err);
    return error.internal(c, 'Failed to match the deposit');
  }
});

// POST /:id/match-payment — tie a line to a payment that was recorded earlier (a check that cleared)
app.post('/:id/match-payment', requirePermission('banking:update'), zValidator('json', z.object({ paymentId: z.string().min(1) })), async (c) => {
  const db = c.get('tenantDb');
  const txnId = c.req.param('id');
  const { paymentId } = c.req.valid('json');
  try {
    const txn = await findLine(c, txnId);
    if (!txn) return error.notFound(c, 'Transaction', txnId);
    const linked = await reconcileBankTransactionToPayment(db, { txn, paymentId, userId: c.get('userId') ?? null });
    await recordLinked(c, txn, { kind: 'payment', id: paymentId, journalEntryId: linked.journalEntryId });
    return success(c, { id: txnId, status: 'reconciled', paymentId, journalEntryId: linked.journalEntryId });
  } catch (err) {
    if (isUserFixable(err)) return error.badRequest(c, err.message);
    console.error('[books-api/bank-transactions] match-payment failed:', err);
    return error.internal(c, 'Failed to match the payment');
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
