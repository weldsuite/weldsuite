/**
 * Creating the payment of a payment-run vendor, and numbering checks.
 *
 * The payment itself is `recordPayment` (services/accounting-payments.ts): one
 * payment per vendor, allocated over its bills, posted to the ledger, linked
 * to the run and with any backup withholding, all in one posting. The run
 * gives it an id derived from the run and the vendor, so making the payment a
 * second time (an approval that stopped partway and is approved again) returns
 * the payment that exists instead of posting twice.
 *
 * Check numbers are claimed one at a time with an atomic counter bump on the
 * bank account, after the payment exists, so two runs can't take the same
 * number and a payment that fails to post leaves no gap. A number is never
 * reused: the claim skips any number a payment (voided ones included) holds.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { paymentNetAmount, recordPayment } from '../accounting-payments';
import { roundMoney } from '../accounting-posting';
import { PaymentRunError } from './errors';

/** The marker on the `reference` of every payment a run makes. */
export const runReference = (runId: string): string => `Payment run ${runId}`;

/**
 * The id of the payment a run makes to a vendor: `pay_` and 24 hex digits of a
 * SHA-256 over the run and the vendor, inside the 30 characters of a payment
 * id. `attempt` is 0 for the first payment of the vendor in the run and counts
 * up when that payment was voided before the run was fully approved and the
 * vendor is paid again.
 */
export async function runPaymentId(runId: string, partyId: string, attempt = 0): Promise<string> {
  const bytes = new TextEncoder().encode(`payment-run:${runId}:${partyId}${attempt > 0 ? `:${attempt}` : ''}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return `pay_${hex.slice(0, 24)}`;
}

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

/** Give a check its number, once: a check that has one keeps it (a retry must not burn a second number). */
async function numberCheck(db: Database, paymentId: string, bankAccountId: string): Promise<string> {
  const read = async () => {
    const [row] = await db.select({ checkNumber: schema.payments.checkNumber }).from(schema.payments).where(eq(schema.payments.id, paymentId)).limit(1);
    return row?.checkNumber ?? null;
  };
  const current = await read();
  if (current) return current;
  const claimed = await claimCheckNumber(db, bankAccountId);
  const [updated] = await db
    .update(schema.payments)
    .set({ checkNumber: claimed, updatedAt: new Date() })
    .where(and(eq(schema.payments.id, paymentId), isNull(schema.payments.checkNumber)))
    .returning({ checkNumber: schema.payments.checkNumber });
  // Someone numbered it in between: theirs stands and the claimed number stays unused.
  return updated?.checkNumber ?? (await read()) ?? claimed;
}

export interface RunPaymentArgs {
  entityId: string;
  runId: string | null;
  /** A caller-chosen payment id (`runPaymentId`): making the same payment again returns the one that exists. */
  id?: string;
  method: 'check' | 'ach';
  bankAccountId: string;
  partyId: string;
  date: Date;
  allocations: Array<{ billId: string; amount: number }>;
  /** Backup withholding kept back from the vendor: the bills settle for the gross, the bank is credited the net. */
  backupWithholdingAmount?: number | null;
  userId: string | null;
  notes?: string | null;
  /** Checks start `to_print` and get their number; ACH payments don't. */
  reference?: string | null;
}

export interface RunPaymentResult {
  paymentId: string;
  checkNumber: string | null;
  /** What the payment settles: the sum of its allocations (before withholding). */
  amount: number;
  /** Backup withholding kept back; 0 when none. */
  backupWithholdingAmount: number;
  /** What the bank is credited, printed on the check and sent in the NACHA file: `amount` less the withholding. */
  netAmount: number;
  journalEntryId: string | null;
}

/** One vendor's payment: allocated over its bills, posted, linked to the run and (for checks) numbered. */
export async function createRunPayment(db: Database, args: RunPaymentArgs): Promise<RunPaymentResult> {
  const amount = args.allocations.reduce((sum, a) => roundMoney(sum + a.amount), 0);
  const withheld = roundMoney(args.backupWithholdingAmount ?? 0);
  const result = await recordPayment(db, {
    ...(args.id ? { id: args.id } : {}),
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
    paymentRunId: args.runId,
    backupWithholdingAmount: withheld > 0 ? withheld : null,
    allocations: args.allocations.map((a) => ({ billId: a.billId, amount: a.amount })),
    userId: args.userId,
  });

  const checkNumber = args.method === 'check' ? await numberCheck(db, result.paymentId, args.bankAccountId) : null;
  // A payment that already existed (same id) is returned as it was stored.
  const [stored] = await db
    .select({ amount: schema.payments.amount, backupWithholdingAmount: schema.payments.backupWithholdingAmount })
    .from(schema.payments)
    .where(eq(schema.payments.id, result.paymentId))
    .limit(1);
  const storedAmount = stored ? roundMoney(Number.parseFloat(stored.amount)) : amount;
  return {
    paymentId: result.paymentId,
    checkNumber,
    amount: storedAmount,
    backupWithholdingAmount: stored ? roundMoney(Number.parseFloat(stored.backupWithholdingAmount ?? '0')) : withheld,
    netAmount: stored ? paymentNetAmount(stored) : roundMoney(amount - withheld),
    journalEntryId: result.journalEntryId,
  };
}

/** Number any check of the run that was created but not numbered yet (a retry after a failure in between). */
export async function numberUnnumberedChecks(db: Database, runId: string, bankAccountId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(and(eq(schema.payments.paymentRunId, runId), isNull(schema.payments.checkNumber), isNull(schema.payments.deletedAt)))
    .orderBy(schema.payments.createdAt, schema.payments.id);
  for (const row of rows) await numberCheck(db, row.id, bankAccountId);
  return rows.length;
}
