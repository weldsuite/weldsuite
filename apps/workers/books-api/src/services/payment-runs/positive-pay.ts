/**
 * The Positive Pay issued-checks file of a bank account.
 *
 * The bank wants the checks written (and the ones voided) so it can match what
 * is presented. A check is reported as issued once it is printed (a check still
 * to print was never handed to anyone), and as void when it was printed and then
 * voided. The file covers a date range: checks issued in it and checks voided
 * in it; `buildPositivePayFile` decides which of those are marked void. A check
 * is reported for what it is written for: the payment less any backup
 * withholding kept back.
 *
 * The account number is decrypted for the file and the reveal is logged
 * (`positive_pay`).
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  buildPositivePayFile,
  POSITIVE_PAY_FORMATS,
  type PositivePayCheck,
} from '@weldsuite/books-domain/us-compliance/positive-pay';
import { paymentNetAmount } from '../accounting-payments';
import { revealAccountNumber } from '../accounting-bank-accounts';
import { badRequest, PaymentRunError } from './errors';
import { registerWhere } from './checks';
import { loadBankAccount } from './runs';
import { positivePayFormatOf, readPositivePayConfig } from './settings';

type KeyEnv = { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };

export const POSITIVE_PAY_FORMAT_LIST = POSITIVE_PAY_FORMATS;

export interface PositivePayFile {
  fileName: string;
  content: string;
  format: string;
  counts: {
    records: number;
    issued: number;
    voided: number;
    /** Dollars. */
    totalIssued: string;
    totalVoided: string;
  };
  warnings: Array<{ code: string; message: string; checkNumber?: string }>;
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

export async function generatePositivePay(
  db: Database,
  env: KeyEnv,
  args: { entityId: string; userId: string; bankAccountId: string; from?: string; to?: string; format?: string },
): Promise<PositivePayFile> {
  const bank = await loadBankAccount(db, args.entityId, args.bankAccountId);
  if (!bank.accountNumberEncrypted) {
    throw new PaymentRunError('NO_ACCOUNT_NUMBER', 'This bank account has no account number on file: add it before making a Positive Pay file.', 409);
  }
  if (args.format && !POSITIVE_PAY_FORMATS.some((f) => f.id === args.format)) {
    throw badRequest('INVALID_FORMAT', `Unknown Positive Pay format ${args.format}.`);
  }
  const format = positivePayFormatOf(bank, args.format);

  // Every check that was printed, voided ones included; the builder picks the ones issued or voided in the range.
  const t = schema.payments;
  const rows = await db
    .select({ payment: t, payeeName: schema.parties.displayName })
    .from(t)
    .leftJoin(schema.parties, eq(schema.parties.id, t.contactId))
    .where(and(...registerWhere({ entityId: args.entityId, bankAccountId: bank.id }), isNotNull(t.checkPrintedAt)));

  const checks: PositivePayCheck[] = rows.map(({ payment, payeeName }) => {
    const voided = Boolean(payment.deletedAt) || payment.checkStatus === 'voided';
    return {
      checkNumber: payment.checkNumber as string,
      issueDate: isoDay(payment.date),
      amount: paymentNetAmount(payment),
      payee: payeeName ?? payment.contactId,
      status: voided ? 'voided' : 'issued',
      voidDate: voided ? isoDay(payment.deletedAt ?? payment.updatedAt) : null,
    };
  });

  const { accountNumber } = await revealAccountNumber(db, env, { account: bank, userId: args.userId, reason: 'positive_pay' });
  const result = buildPositivePayFile(checks, {
    format,
    accountNumber,
    ...(args.from ? { from: args.from } : {}),
    ...(args.to ? { to: args.to } : {}),
    config: readPositivePayConfig(bank.checkSettings),
  });
  if (!result.ok) {
    throw new PaymentRunError('POSITIVE_PAY_INVALID', 'The Positive Pay file can\'t be made: fix the issues listed and try again.', 422, {
      errors: result.errors,
      warnings: result.warnings,
    });
  }
  return {
    fileName: result.fileName,
    content: result.content,
    format: result.format,
    counts: {
      records: result.recordCount,
      issued: result.issueCount,
      voided: result.voidCount,
      totalIssued: (result.totalIssuedCents / 100).toFixed(2),
      totalVoided: (result.totalVoidedCents / 100).toFixed(2),
    },
    warnings: result.warnings.map((w) => ({
      code: w.code,
      message: w.message,
      ...(w.checkNumber ? { checkNumber: w.checkNumber } : {}),
    })),
  };
}
