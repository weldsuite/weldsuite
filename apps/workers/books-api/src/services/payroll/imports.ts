/**
 * Posting and reversing imported payrolls.
 *
 * One payroll = one journal entry (posting key `payroll:<importId>`) and one
 * `payroll_imports` row, written in the same atomic batch. A payroll imports
 * once: (entity, source, externalId) is unique, so a repeated CSV or a second
 * Gusto sync finds it instead of posting it again.
 *
 * Deleting an import reverses its entry (`reverseJournalEntry`) and marks the
 * import `reversed`; the row stays, so the external id stays taken and a
 * reversed Gusto payroll is not imported again by the next sync.
 */

import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import { postJournalEntry, reverseJournalEntry, PostingError, type PostingLine } from '../accounting-posting';
import { PayrollImportError } from './journal';

const importsTable = schema.payrollImports;

export type PayrollImportRow = typeof importsTable.$inferSelect;

export class DuplicatePayrollError extends Error {
  constructor(
    readonly externalId: string,
    readonly existing: { id: string; status: string },
  ) {
    super(`This payroll was already imported (${existing.status})`);
    this.name = 'DuplicatePayrollError';
  }
}

export interface PostPayrollArgs {
  entityId: string;
  userId: string | null;
  source: 'csv' | 'gusto';
  connectionId?: string | null;
  externalId: string;
  payDate: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  lines: PostingLine[];
  summary: Record<string, number>;
  sourceFileName?: string | null;
  description: string;
  reference?: string | null;
}

export interface PostedPayroll {
  importId: string;
  journalEntryId: string;
  entryNumber: string | null;
  payDate: string;
}

export async function findImportByExternalId(
  db: Database,
  entityId: string,
  source: string,
  externalId: string,
): Promise<PayrollImportRow | null> {
  const [row] = await db
    .select()
    .from(importsTable)
    .where(and(eq(importsTable.entityId, entityId), eq(importsTable.source, source), eq(importsTable.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

export async function postPayrollImport(db: Database, args: PostPayrollArgs): Promise<PostedPayroll> {
  const existing = await findImportByExternalId(db, args.entityId, args.source, args.externalId);
  if (existing) throw new DuplicatePayrollError(args.externalId, { id: existing.id, status: existing.status });

  const importId = generateId('pri');
  const now = new Date();
  let posted;
  try {
    posted = await postJournalEntry(db, {
      entityId: args.entityId,
      date: new Date(`${args.payDate}T00:00:00.000Z`),
      description: args.description,
      reference: args.reference ?? null,
      sourceType: 'payroll',
      sourceId: importId,
      postingKey: `payroll:${importId}`,
      lockKind: 'general',
      createdBy: args.userId,
      isAutomatic: args.source !== 'csv',
      lines: args.lines,
      alsoWrite: (h, entry) => [
        h.insert(importsTable).values({
          id: importId,
          createdAt: now,
          updatedAt: now,
          entityId: args.entityId,
          source: args.source,
          connectionId: args.connectionId ?? null,
          externalId: args.externalId,
          periodStart: args.periodStart ?? null,
          periodEnd: args.periodEnd ?? null,
          payDate: args.payDate,
          summary: args.summary,
          status: 'posted',
          journalEntryId: entry.journalEntryId,
          sourceFileName: args.sourceFileName ?? null,
          createdBy: args.userId,
        }),
      ],
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const raced = await findImportByExternalId(db, args.entityId, args.source, args.externalId);
      if (raced) throw new DuplicatePayrollError(args.externalId, { id: raced.id, status: raced.status });
    }
    throw err;
  }
  if (!posted.journalEntryId) throw new PayrollImportError('The payroll has no amounts to post');
  return { importId, journalEntryId: posted.journalEntryId, entryNumber: posted.entryNumber, payDate: args.payDate };
}

export async function loadImport(db: Database, id: string): Promise<PayrollImportRow | null> {
  const [row] = await db.select().from(importsTable).where(eq(importsTable.id, id)).limit(1);
  return row ?? null;
}

/** Reverse an import's entry, dated `date` (default: the pay date, so it nets in the same period). */
export async function reversePayrollImport(
  db: Database,
  args: { importId: string; userId: string | null; date?: string },
): Promise<PayrollImportRow> {
  const row = await loadImport(db, args.importId);
  if (!row) throw new PostingError('Payroll import not found');
  if (row.status === 'reversed') throw new PostingError('This payroll import has already been reversed');
  if (!row.journalEntryId) throw new PostingError('This payroll import has no journal entry to reverse');

  const date = args.date ?? row.payDate;
  await reverseJournalEntry(db, {
    entryId: row.journalEntryId,
    date: new Date(`${date}T00:00:00.000Z`),
    createdBy: args.userId,
    description: `Reversal of payroll ${row.payDate}`,
    postingKey: `payroll:${row.id}:reversal`,
    alsoWrite: (h) => [
      h.update(importsTable).set({ status: 'reversed', updatedAt: new Date() }).where(eq(importsTable.id, row.id)),
    ],
  });
  return { ...row, status: 'reversed' };
}
