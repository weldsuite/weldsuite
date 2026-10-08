/**
 * Creating the payment of a payment-run vendor, and numbering checks.
 *
 * The payment itself is `recordPayment` (services/accounting-payments.ts): one
 * payment per vendor, allocated over its bills, posted to the ledger. The
 * service doesn't know about runs, so the run link and the check number are
 * written to the payment row right after.
 *
 * Check numbers are claimed one at a time with an atomic counter bump on the
 * bank account, after the payment exists, so two runs can't take the same
 * number and a payment that fails to post leaves no gap. A number is never
 * reused: the claim skips any number a payment (voided ones included) holds.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { recordPayment } from '../accounting-payments';
import { PaymentRunError } from './errors';

/** The marker on the `reference` of every payment a run makes. */
export const runReference = (runId: string): string => `Payment run ${runId}`;

const MAX_CLAIM_ATTEMPTS = 100;

export async function claimCheckNumber(db: Database, bankAccountId: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const [row] = await db
      .update(schema.bankAccounts)
      .set({ nextCheckNumber: sql`coalesce(${schema.bankAccounts.nextCheckNumber}, 1) + 1`, updatedAt: new Date() })
      .where(eq(schema.bankAccounts.id, bankAccountId))
      .returning({ next: schema.bankAccounts.nextCheckNumber });
    if (!row || row.next === null) {
      throw new PaymentRunError('CHECK_NUMBER_REQUIRED', 'Set the next check number in the bank account\'s check settings.', 409);
    }
    const claimed = String(row.next - 1);
    const [taken] = await db
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(and(eq(schema.payments.bankAccountId, bankAccountId), eq(schema.payments.checkNumber, claimed)))
      .limit(1);
    if (!taken) return claimed;
  }
  throw new PaymentRunError(
    'CHECK_NUMBER_EXHAUSTED',
    'The next check numbers are all in use already. Set a higher next check number in the bank account\'s check settings.',
    409,
  );
}

export interface RunPaymentArgs {
  entityId: string;
  runId: string | null;
  method: 'check' | 'ach';
  bankAccountId: string;
  partyId: string;
  date: Date;
  allocations: Array<{ billId: string; amount: number }>;
  userId: string | null;
  notes?: string | null;
  /** Checks start `to_print` and get their number; ACH payments don't. */
  reference?: string | null;
}

export interface RunPaymentResult {
  paymentId: string;
  checkNumber: string | null;
  amount: number;
  journalEntryId: string | null;
}

/** One vendor's payment: allocated over its bills, posted, linked to the run and (for checks) numbered. */
export async function createRunPayment(db: Database, args: RunPaymentArgs): Promise<RunPaymentResult> {
  const amount = args.allocations.reduce((sum, a) => Math.round((sum + a.amount) * 100) / 100, 0);
  const result = await recordPayment(db, {
    entityId: args.entityId,
    type: 'sent',
    amount,
    date: args.date,
    paymentMethod: args.method,
    checkStatus: args.method === 'check' ? 'to_print' : null,
    reference: args.reference ?? (args.runId ? runReference(args.runId) : null),
    notes: args.notes ?? null,
    contactId: args.partyId,
    bankAccountId: args.bankAccountId,
    allocations: args.allocations.map((a) => ({ billId: a.billId, amount: a.amount })),
    userId: args.userId,
  });

  const checkNumber = args.method === 'check' ? await claimCheckNumber(db, args.bankAccountId) : null;
  await db
    .update(schema.payments)
    .set({ paymentRunId: args.runId, ...(checkNumber ? { checkNumber } : {}), updatedAt: new Date() })
    .where(eq(schema.payments.id, result.paymentId));
  return { paymentId: result.paymentId, checkNumber, amount, journalEntryId: result.journalEntryId };
}

/** Number any check of the run that was created but not numbered yet (a retry after a failure in between). */
export async function numberUnnumberedChecks(db: Database, runId: string, bankAccountId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(and(eq(schema.payments.paymentRunId, runId), isNull(schema.payments.checkNumber), isNull(schema.payments.deletedAt)))
    .orderBy(schema.payments.createdAt, schema.payments.id);
  for (const row of rows) {
    const checkNumber = await claimCheckNumber(db, bankAccountId);
    await db.update(schema.payments).set({ checkNumber, updatedAt: new Date() }).where(eq(schema.payments.id, row.id));
  }
  return rows.length;
}
