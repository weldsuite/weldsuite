/**
 * Writing parsed statement lines to `bank_transactions`.
 *
 * A re-imported file must not double the lines. Every line gets an id (the
 * bank's own FITID where the file has one, otherwise a hash of its date,
 * amount and text) and counts as a duplicate when the account already holds a
 * line with the same id, amount and date. Importing never touches lines that
 * were reconciled.
 *
 * The way back: `deleteBankLines` removes lines that were never booked
 * (unreconciled or excluded), one at a time or a whole import batch, and takes
 * their amounts back out of the account balance.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { ParsedBankTransaction } from './bank-parsers';
import { occurrenceCounter, syntheticExternalId } from './bank-parsers/ids';

const CHUNK = 100;
const LOOKUP_CHUNK = 300;

function clip(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** Give lines without an id a stable one, so the same file imported twice finds them again. */
export function withExternalIds(transactions: ParsedBankTransaction[]): Array<ParsedBankTransaction & { externalId: string }> {
  const nextOccurrence = occurrenceCounter();
  return transactions.map((txn) => {
    if (txn.externalId) return { ...txn, externalId: txn.externalId };
    const parts = [txn.date, txn.amount.toFixed(2), txn.description, txn.counterpartyName, txn.checkNumber];
    const key = parts.map((p) => String(p ?? '').toLowerCase()).join('|');
    return { ...txn, externalId: syntheticExternalId('imp', parts, nextOccurrence(key)) };
  });
}

function duplicateKey(externalId: string, amount: number | string, date: Date | string): string {
  const day = typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);
  return `${externalId}|${Number(amount).toFixed(2)}|${day}`;
}

/** Which of these lines the bank account already holds. */
export async function findExistingImports(
  db: Database,
  bankAccountId: string,
  lines: Array<{ externalId: string }>,
): Promise<Set<string>> {
  const known = new Set<string>();
  const ids = [...new Set(lines.map((l) => l.externalId))];
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const rows = await db
      .select({ externalId: schema.bankTransactions.externalId, amount: schema.bankTransactions.amount, date: schema.bankTransactions.date })
      .from(schema.bankTransactions)
      .where(
        and(
          eq(schema.bankTransactions.bankAccountId, bankAccountId),
          inArray(schema.bankTransactions.externalId, ids.slice(i, i + LOOKUP_CHUNK)),
          isNull(schema.bankTransactions.deletedAt),
        ),
      );
    for (const row of rows) {
      if (row.externalId) known.add(duplicateKey(row.externalId, row.amount, row.date));
    }
  }
  return known;
}

export interface ImportCounts {
  importedCount: number;
  duplicateCount: number;
  /** Sum of the imported lines' amounts, for files that carry no closing balance. */
  importedNet: number;
}

/** Number of lines of a file the account already holds, without writing anything. */
export async function countDuplicates(
  db: Database,
  bankAccountId: string,
  transactions: ParsedBankTransaction[],
): Promise<number> {
  const lines = withExternalIds(transactions);
  const known = await findExistingImports(db, bankAccountId, lines);
  return lines.filter((l) => known.has(duplicateKey(l.externalId, l.amount, l.date))).length;
}

/** Insert the lines the account does not hold yet, as unreconciled `import` transactions. */
export async function importParsedTransactions(
  db: Database,
  args: { entityId: string; bankAccountId: string; batchId: string; transactions: ParsedBankTransaction[] },
): Promise<ImportCounts> {
  const lines = withExternalIds(args.transactions);
  const known = await findExistingImports(db, args.bankAccountId, lines);

  const now = new Date();
  const fresh: Array<typeof schema.bankTransactions.$inferInsert> = [];
  let duplicateCount = 0;
  for (const txn of lines) {
    const key = duplicateKey(txn.externalId, txn.amount, txn.date);
    if (known.has(key)) {
      duplicateCount += 1;
      continue;
    }
    known.add(key);
    fresh.push({
      id: generateId('bt'),
      entityId: args.entityId,
      bankAccountId: args.bankAccountId,
      date: new Date(txn.date),
      valueDate: txn.valueDate ? new Date(txn.valueDate) : null,
      description: txn.description,
      amount: txn.amount.toFixed(2),
      runningBalance: txn.runningBalance?.toFixed(2) ?? null,
      counterpartyName: clip(txn.counterpartyName, 255),
      counterpartyIban: clip(txn.counterpartyIban, 34),
      counterpartyBic: clip(txn.counterpartyBic, 11),
      reference: clip(txn.reference, 255),
      transactionCode: clip(txn.transactionCode, 20),
      checkNumber: clip(txn.checkNumber, 30),
      endToEndId: clip(txn.endToEndId, 255),
      mandateId: clip(txn.mandateId, 255),
      importBatchId: args.batchId,
      externalId: clip(txn.externalId, 255),
      status: 'unreconciled',
      source: 'import',
      rawData: txn.rawData ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  for (let i = 0; i < fresh.length; i += CHUNK) {
    await db.insert(schema.bankTransactions).values(fresh.slice(i, i + CHUNK));
  }
  return { importedCount: fresh.length, duplicateCount, importedNet: sumAmounts(fresh) };
}

function sumAmounts(rows: Array<{ amount: string | number }>): number {
  const cents = rows.reduce((total, row) => total + Math.round(Number(row.amount) * 100), 0);
  return cents / 100;
}

type BankLine = typeof schema.bankTransactions.$inferSelect;

/** Lines that were never booked, so removing them leaves the ledger alone. */
const DELETABLE_STATUSES = new Set(['unreconciled', 'excluded']);
/** Feed lines come back on the next sync, so they are excluded instead. */
const DELETABLE_SOURCES = new Set(['import', 'manual']);

/** Why this line can't be deleted, or null when it can. */
export function lineDeleteBlocker(line: Pick<BankLine, 'status' | 'source'>): 'reconciled' | 'feed' | null {
  if (!DELETABLE_STATUSES.has(line.status)) return 'reconciled';
  if (!DELETABLE_SOURCES.has(line.source ?? 'import')) return 'feed';
  return null;
}

export interface DeleteLinesResult {
  deleted: BankLine[];
  /** Lines left in place: reconciled, or from a bank feed. */
  kept: number;
}

/** Which lines to delete: one line, or every line of an import batch (whose status follows). */
export type DeleteLinesScope = { lineId: string } | { importBatchId: string };

/**
 * Soft-delete the deletable lines in `scope` and take their amounts back out
 * of their accounts' balances; undoing an import also marks the batch undone.
 * The others are left alone and counted.
 *
 * One statement does all of it, so it commits as a whole, and the deletable
 * check runs in its WHERE: a request that loses a race with another delete or a
 * reconcile finds no row to delete and takes nothing off the balance. `lines`
 * is the caller's read of the scope, for the rows returned.
 */
export async function deleteBankLines(
  db: Database,
  lines: BankLine[],
  scope: DeleteLinesScope,
): Promise<DeleteLinesResult> {
  const now = new Date().toISOString();
  const inScope = 'lineId' in scope ? sql`id = ${scope.lineId}` : sql`import_batch_id = ${scope.importBatchId}`;
  const batch = 'importBatchId' in scope
    ? sql`, batch as (
        update bank_import_batches
        set status = case when exists (
              select 1 from bank_transactions
              where import_batch_id = ${scope.importBatchId} and deleted_at is null
                and id not in (select id from gone)
            ) then 'partly_undone' else 'undone' end,
            updated_at = ${now}::timestamp
        where id = ${scope.importBatchId}
      )`
    : sql``;
  const result = await db.execute<{ id: string }>(sql`
    with gone as (
      update bank_transactions
      set deleted_at = ${now}::timestamp, updated_at = ${now}::timestamp
      where ${inScope} and deleted_at is null
        and status in ('unreconciled', 'excluded')
        and coalesce(source, 'import') in ('import', 'manual')
      returning id, bank_account_id, amount
    ), balances as (
      update bank_accounts a
      set current_balance = coalesce(a.current_balance, 0)::numeric - g.total, updated_at = ${now}::timestamp
      from (select bank_account_id, sum(amount) as total from gone group by bank_account_id) g
      where a.id = g.bank_account_id and g.total <> 0
    )${batch}
    select id from gone
  `);
  const rows = (result as unknown as { rows?: Array<{ id: string }> }).rows ?? (result as unknown as Array<{ id: string }>);
  const goneIds = new Set(rows.map((row) => row.id));
  const deleted = lines.filter((line) => goneIds.has(line.id));
  return { deleted, kept: lines.filter((line) => lineDeleteBlocker(line) !== null).length };
}
