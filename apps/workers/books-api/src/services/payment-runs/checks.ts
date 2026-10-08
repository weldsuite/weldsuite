/**
 * Checks of a payment run: the data the platform prints them from, marking
 * them printed, voiding and reissuing, and the check register.
 *
 * A check is a payment with `payment_method = 'check'`. Its status is
 * `to_print` until the platform prints it, `printed`, `cleared` (set by bank
 * reconciliation) or `voided`. A voided check keeps its row and its number:
 * `voidPayment` soft-deletes the payment, reverses the ledger entry and
 * reopens the bills, so everything below reads checks with deleted rows
 * included and calls a deleted check voided.
 */

import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { assertPostingAllowed } from '@weldsuite/books-domain/accounting-guards';
import { formatPostalAddressLines } from '@weldsuite/books-domain/accounting-address';
import {
  amountInWords,
  buildMicrFields,
  buildMicrLine,
  courtesyAmount,
  fractionalRouting,
  getCheckLayout,
  micrToFontLetters,
  type MicrFields,
} from '@weldsuite/books-domain/us-compliance/checks';
import { revealAccountNumber } from '../accounting-bank-accounts';
import { voidPayment } from '../accounting-payments';
import { badRequest, notFound, PaymentRunError } from './errors';
import { createRunPayment } from './payments';
import { loadBankAccount, loadRun, type RunRow } from './runs';
import { readCheckSettings } from './settings';

type PaymentRow = typeof schema.payments.$inferSelect;
type KeyEnv = { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };

export type CheckStatus = 'to_print' | 'printed' | 'cleared' | 'voided';

export function checkStatusOf(payment: Pick<PaymentRow, 'deletedAt' | 'checkStatus'>): CheckStatus {
  if (payment.deletedAt || payment.checkStatus === 'voided') return 'voided';
  if (payment.checkStatus === 'to_print' || payment.checkStatus === 'cleared') return payment.checkStatus;
  return 'printed';
}

/** Check numbers compare as numbers when they are digits (shorter first), as text otherwise. */
export function compareCheckNumbers(a: string | null, b: string | null): number {
  const x = a ?? '';
  const y = b ?? '';
  return x.length === y.length ? x.localeCompare(y) : x.length - y.length;
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

function usDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function addressLines(address: Parameters<typeof formatPostalAddressLines>[0]): string[] {
  return formatPostalAddressLines(address ? { country: 'US', ...address } : null, { omitCountry: 'US' });
}

// ---------------------------------------------------------------------------
// Print data

export interface VoucherRow {
  date: string | null;
  reference: string | null;
  description: string | null;
  amount: string;
  billTotal: string | null;
  discount: string | null;
}

export interface CheckPrintItem {
  paymentId: string;
  checkNumber: string;
  checkStatus: CheckStatus;
  /** YYYY-MM-DD */
  date: string;
  /** MM/DD/YYYY, as printed. */
  dateDisplay: string;
  amount: string;
  amountInWords: string;
  /** "$**1,234.56" */
  courtesyAmount: string;
  payee: { partyId: string; name: string; addressLines: string[] };
  memo: string | null;
  /** Fractional routing number ("90-7162/0210"), when the bank's numerator is set. */
  fractionalRouting: string | null;
  /** The MICR line for blank check stock; null when the stock is preprinted. */
  micr: {
    line: string;
    fields: MicrFields;
    /** The same fields with the E-13B symbols as the letters common MICR fonts use (A transit, C on-us, D dash). */
    fieldsAsFontLetters: MicrFields;
  } | null;
  voucher: {
    rows: VoucherRow[];
    total: string;
  };
}

export interface CheckPrintData {
  run: { id: string; status: string; paymentDate: string; bankAccountId: string };
  layout: ReturnType<typeof getCheckLayout>;
  settings: {
    layout: string;
    printMicr: boolean;
    signatureLineText: string | null;
    checkNumberWidth: number;
  };
  payer: { name: string; dba: string | null; addressLines: string[] };
  bank: { name: string | null; addressLines: string[]; accountNumberLast4: string | null };
  checks: CheckPrintItem[];
}

export async function buildCheckPrintData(
  db: Database,
  env: KeyEnv,
  args: { entityId: string; runId: string; userId: string; includePrinted?: boolean },
): Promise<CheckPrintData> {
  const run = await loadRun(db, args.entityId, args.runId);
  if (run.method !== 'check') throw new PaymentRunError('NOT_A_CHECK_RUN', 'This is an ACH run: it has no checks to print.', 409);
  if (run.status !== 'approved' && run.status !== 'completed') {
    throw new PaymentRunError('RUN_NOT_APPROVED', 'Checks can be printed once the run is approved.', 409, { status: run.status });
  }
  const bank = await loadBankAccount(db, args.entityId, run.bankAccountId);
  const settings = readCheckSettings(bank.checkSettings);
  const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, args.entityId)).limit(1);
  if (!entity) throw notFound('Accounting entity', args.entityId);

  const payments = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.paymentRunId, run.id), isNull(schema.payments.deletedAt)));
  const wanted = payments
    .filter((p) => args.includePrinted || checkStatusOf(p) === 'to_print')
    .filter((p) => p.checkNumber)
    .sort((a, b) => compareCheckNumbers(a.checkNumber, b.checkNumber));

  const paymentIds = wanted.map((p) => p.id);
  const partyIds = [...new Set(wanted.map((p) => p.contactId))];
  const [allocations, parties] = await Promise.all([
    paymentIds.length
      ? db
          .select({
            paymentId: schema.paymentAllocations.paymentId,
            amount: schema.paymentAllocations.amount,
            bill: schema.bills,
          })
          .from(schema.paymentAllocations)
          .innerJoin(schema.bills, eq(schema.bills.id, schema.paymentAllocations.billId))
          .where(and(inArray(schema.paymentAllocations.paymentId, paymentIds), isNull(schema.paymentAllocations.deletedAt)))
      : Promise.resolve([]),
    partyIds.length ? db.select().from(schema.parties).where(inArray(schema.parties.id, partyIds)) : Promise.resolve([]),
  ]);
  const partyById = new Map(parties.map((p) => [p.id, p]));

  // Blank stock with MICR: the account number comes out of storage once for the whole sheet, and the reveal is logged.
  let accountNumber: string | null = null;
  if (settings.printMicr && wanted.length > 0) {
    if (!bank.routingNumber || !bank.accountNumberEncrypted) {
      throw new PaymentRunError(
        'MICR_UNAVAILABLE',
        'MICR printing needs the bank account\'s routing number and account number. Add them, or turn MICR printing off for preprinted stock.',
        409,
      );
    }
    accountNumber = (await revealAccountNumber(db, env, { account: bank, userId: args.userId, reason: 'check_micr' })).accountNumber;
  }

  const checks: CheckPrintItem[] = wanted.map((payment) => {
    const checkNumber = payment.checkNumber as string;
    const amount = Number.parseFloat(payment.amount);
    const rows = allocations.filter((a) => a.paymentId === payment.id);
    const party = partyById.get(payment.contactId);
    const billNumbers = rows.map((r) => r.bill.billNumber ?? r.bill.reference ?? r.bill.id);

    let micr: CheckPrintItem['micr'] = null;
    if (accountNumber && bank.routingNumber) {
      const input = {
        routingNumber: bank.routingNumber,
        accountNumber,
        checkNumber,
        layout: settings.micrLayout,
        checkNumberWidth: settings.checkNumberWidth,
      } as const;
      try {
        const fields = buildMicrFields(input);
        micr = {
          line: buildMicrLine(input),
          fields,
          fieldsAsFontLetters: {
            auxOnUs: micrToFontLetters(fields.auxOnUs),
            transit: micrToFontLetters(fields.transit),
            onUs: micrToFontLetters(fields.onUs),
          },
        };
      } catch (err) {
        throw new PaymentRunError('MICR_INVALID', `The MICR line for check ${checkNumber} can't be made: ${(err as Error).message}`, 409);
      }
    }

    let fractional: string | null = null;
    if (bank.routingNumber) {
      try {
        fractional = fractionalRouting(bank.routingNumber, settings.fractionalNumerator);
      } catch {
        fractional = null;
      }
    }

    return {
      paymentId: payment.id,
      checkNumber,
      checkStatus: checkStatusOf(payment),
      date: isoDay(payment.date),
      dateDisplay: usDate(isoDay(payment.date)),
      amount: amount.toFixed(2),
      amountInWords: amountInWords(amount),
      courtesyAmount: courtesyAmount(amount),
      payee: {
        partyId: payment.contactId,
        name: party?.displayName ?? payment.contactId,
        addressLines: party ? addressLines(party.billingAddress) : [],
      },
      memo: billNumbers.length === 0 ? null : `${billNumbers.length === 1 ? 'Bill' : 'Bills'} ${billNumbers.join(', ')}`.slice(0, 60),
      fractionalRouting: fractional,
      micr,
      voucher: {
        rows: rows.map((r) => {
          const covers = Math.abs(Number.parseFloat(r.bill.total ?? '0') - Number.parseFloat(r.amount)) < 0.005;
          const discount = Number.parseFloat(r.bill.discountTotal ?? '0');
          return {
            date: r.bill.issueDate ? isoDay(r.bill.issueDate) : null,
            reference: r.bill.billNumber ?? r.bill.externalReference,
            description: r.bill.reference ?? r.bill.notes ?? null,
            amount: Number.parseFloat(r.amount).toFixed(2),
            billTotal: r.bill.total,
            discount: covers && discount > 0 ? discount.toFixed(2) : null,
          };
        }),
        total: amount.toFixed(2),
      },
    };
  });

  return {
    run: { id: run.id, status: run.status, paymentDate: run.paymentDate, bankAccountId: run.bankAccountId },
    layout: getCheckLayout(settings.layout, settings.alignment),
    settings: {
      layout: settings.layout,
      printMicr: settings.printMicr,
      signatureLineText: settings.signatureLineText,
      checkNumberWidth: settings.checkNumberWidth,
    },
    payer: {
      name: entity.legalName ?? entity.name,
      dba: entity.dba ?? null,
      addressLines: addressLines(entity.address),
    },
    bank: {
      name: settings.bankName ?? bank.bankName ?? null,
      addressLines: settings.bankAddressLines,
      accountNumberLast4: bank.accountNumberLast4 ?? null,
    },
    checks,
  };
}

// ---------------------------------------------------------------------------
// Marking printed

/**
 * A check run is completed once nothing is left to print; a check reissued
 * after that puts it back to approved until the replacement is printed.
 */
export async function syncCheckRunStatus(db: Database, run: RunRow): Promise<RunRow> {
  if (run.method !== 'check' || (run.status !== 'approved' && run.status !== 'completed')) return run;
  const payments = await db
    .select({ checkStatus: schema.payments.checkStatus })
    .from(schema.payments)
    .where(and(eq(schema.payments.paymentRunId, run.id), isNull(schema.payments.deletedAt)));
  if (payments.length === 0) return run;
  const next = payments.some((p) => p.checkStatus === 'to_print') ? 'approved' : 'completed';
  if (next === run.status) return run;
  const [updated] = await db
    .update(schema.paymentRuns)
    .set({ status: next, updatedAt: new Date() })
    .where(eq(schema.paymentRuns.id, run.id))
    .returning();
  return updated ?? run;
}

export async function markChecksPrinted(
  db: Database,
  args: { entityId: string; runId: string; paymentIds: string[] },
): Promise<{ run: RunRow; printed: string[]; alreadyPrinted: string[] }> {
  const run = await loadRun(db, args.entityId, args.runId);
  if (run.method !== 'check') throw new PaymentRunError('NOT_A_CHECK_RUN', 'This is an ACH run: it has no checks to print.', 409);
  if (run.status !== 'approved' && run.status !== 'completed') {
    throw new PaymentRunError('RUN_NOT_APPROVED', 'Checks can be printed once the run is approved.', 409, { status: run.status });
  }
  const ids = [...new Set(args.paymentIds)];
  const payments = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.paymentRunId, run.id), inArray(schema.payments.id, ids), isNull(schema.payments.deletedAt)));
  const found = new Set(payments.map((p) => p.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw badRequest('PAYMENT_NOT_IN_RUN', 'Some of these payments are not active checks of this run.', { paymentIds: missing });
  }

  const toMark = payments.filter((p) => p.checkStatus === 'to_print').map((p) => p.id);
  const alreadyPrinted = payments.filter((p) => p.checkStatus !== 'to_print').map((p) => p.id);
  if (toMark.length > 0) {
    const now = new Date();
    await db
      .update(schema.payments)
      .set({ checkStatus: 'printed', checkPrintedAt: now, updatedAt: now })
      .where(and(inArray(schema.payments.id, toMark), eq(schema.payments.checkStatus, 'to_print')));
  }
  const synced = await syncCheckRunStatus(db, run);
  return { run: synced, printed: toMark, alreadyPrinted };
}

// ---------------------------------------------------------------------------
// Void and reissue

export interface VoidCheckResult {
  voided: { paymentId: string; checkNumber: string | null; amount: string; partyId: string; runId: string | null };
  replacement: { paymentId: string; checkNumber: string | null; amount: string; checkStatus: CheckStatus } | null;
  run: RunRow | null;
}

/**
 * Void a check: the payment is voided through the payments service (the
 * ledger entry is reversed, the bills are open again) and keeps its number.
 * With `reissue` the same amount goes out again on a new payment under the
 * next check number, to print.
 */
export async function voidCheck(
  db: Database,
  args: {
    entityId: string;
    paymentId: string;
    userId: string;
    reason: string;
    reissue?: boolean;
    /** Date of the replacement check; today when omitted. */
    date?: string;
  },
): Promise<VoidCheckResult> {
  const [payment] = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.id, args.paymentId), eq(schema.payments.entityId, args.entityId)))
    .limit(1);
  if (!payment || payment.type !== 'sent' || payment.paymentMethod !== 'check') throw notFound('Check', args.paymentId);
  if (payment.deletedAt || payment.checkStatus === 'voided') {
    throw new PaymentRunError('ALREADY_VOIDED', 'This check is already voided.', 409);
  }
  if (payment.checkStatus === 'cleared') {
    throw new PaymentRunError('CHECK_CLEARED', 'This check has cleared the bank: it can\'t be voided.', 409);
  }
  if (!payment.bankAccountId) throw new PaymentRunError('NO_BANK_ACCOUNT', 'This check has no bank account.', 409);

  const allocationRows = await db
    .select()
    .from(schema.paymentAllocations)
    .where(and(eq(schema.paymentAllocations.paymentId, payment.id), isNull(schema.paymentAllocations.deletedAt)));
  const allocations = allocationRows
    .filter((a) => a.billId)
    .map((a) => ({ billId: a.billId as string, amount: Number.parseFloat(a.amount) }));
  if (allocations.length === 0 && payment.billId) {
    allocations.push({ billId: payment.billId, amount: Number.parseFloat(payment.amount) });
  }

  const replacementDate = args.date ?? isoDay(new Date());
  if (args.reissue) {
    if (allocations.length === 0) {
      throw badRequest('NOTHING_TO_REISSUE', 'This check paid no bills, so there is nothing to reissue.');
    }
    // Fail before voiding, not after: the replacement posts on this date.
    await assertPostingAllowed(db, {
      entityId: args.entityId,
      date: replacementDate,
      kind: 'general',
      affectsTax: false,
      userId: args.userId,
    });
  }

  await voidPayment(db, payment.id, { userId: args.userId });
  const note = `Voided ${isoDay(new Date())}: ${args.reason.trim()}`;
  await db
    .update(schema.payments)
    .set({ checkStatus: 'voided', notes: payment.notes ? `${payment.notes}\n${note}` : note, updatedAt: new Date() })
    .where(eq(schema.payments.id, payment.id));

  let replacement: VoidCheckResult['replacement'] = null;
  if (args.reissue) {
    const created = await createRunPayment(db, {
      entityId: args.entityId,
      runId: payment.paymentRunId,
      method: 'check',
      bankAccountId: payment.bankAccountId,
      partyId: payment.contactId,
      date: new Date(`${replacementDate}T00:00:00.000Z`),
      allocations,
      userId: args.userId,
      reference: payment.reference,
      notes: `Replaces check ${payment.checkNumber ?? payment.id}`,
    });
    replacement = {
      paymentId: created.paymentId,
      checkNumber: created.checkNumber,
      amount: created.amount.toFixed(2),
      checkStatus: 'to_print',
    };
  }

  let run: RunRow | null = null;
  if (payment.paymentRunId) {
    const [row] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, payment.paymentRunId)).limit(1);
    run = row ? await syncCheckRunStatus(db, row) : null;
  }
  return {
    voided: {
      paymentId: payment.id,
      checkNumber: payment.checkNumber,
      amount: payment.amount,
      partyId: payment.contactId,
      runId: payment.paymentRunId,
    },
    replacement,
    run,
  };
}

// ---------------------------------------------------------------------------
// Check register

export interface RegisterFilter {
  entityId: string;
  bankAccountId?: string;
  from?: string;
  to?: string;
  status?: CheckStatus;
  limit: number;
  cursor?: string;
}

const STATUS_SQL = sql<string>`case when ${schema.payments.deletedAt} is not null or ${schema.payments.checkStatus} = 'voided' then 'voided' else coalesce(${schema.payments.checkStatus}, 'printed') end`;

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number(atob(cursor));
  if (!Number.isInteger(offset) || offset < 0) throw badRequest('INVALID_CURSOR', 'Invalid cursor');
  return offset;
}

export function registerWhere(filter: Omit<RegisterFilter, 'limit' | 'cursor' | 'status'>): SQL[] {
  const t = schema.payments;
  const conditions: SQL[] = [
    eq(t.entityId, filter.entityId),
    eq(t.type, 'sent'),
    eq(t.paymentMethod, 'check'),
    isNotNull(t.checkNumber),
  ];
  if (filter.bankAccountId) conditions.push(eq(t.bankAccountId, filter.bankAccountId));
  if (filter.from) conditions.push(gte(t.date, new Date(`${filter.from}T00:00:00.000Z`)));
  if (filter.to) conditions.push(lte(t.date, new Date(`${filter.to}T23:59:59.999Z`)));
  return conditions;
}

/** Every check written on the account, voided ones included, by check number. */
export async function checkRegister(db: Database, filter: RegisterFilter) {
  const t = schema.payments;
  const base = registerWhere(filter);
  const withStatus = filter.status ? [...base, sql`${STATUS_SQL} = ${filter.status}`] : base;
  const offset = decodeOffset(filter.cursor);

  const [rows, totals] = await Promise.all([
    db
      .select({
        payment: t,
        payeeName: schema.parties.displayName,
        runStatus: schema.paymentRuns.status,
      })
      .from(t)
      .leftJoin(schema.parties, eq(schema.parties.id, t.contactId))
      .leftJoin(schema.paymentRuns, eq(schema.paymentRuns.id, t.paymentRunId))
      .where(and(...withStatus))
      .orderBy(sql`length(${t.checkNumber})`, asc(t.checkNumber), asc(t.id))
      .limit(filter.limit + 1)
      .offset(offset),
    db
      .select({
        status: STATUS_SQL,
        count: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${t.amount}), 0)`,
      })
      .from(t)
      .where(and(...base))
      .groupBy(STATUS_SQL),
  ]);

  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  const summary: Record<string, { count: number; total: string }> = {};
  for (const row of totals) summary[row.status] = { count: Number(row.count), total: Number(row.total).toFixed(2) };

  return {
    rows: page.map(({ payment, payeeName, runStatus }) => ({
      paymentId: payment.id,
      checkNumber: payment.checkNumber,
      date: isoDay(payment.date),
      payeeId: payment.contactId,
      payeeName: payeeName ?? payment.contactId,
      amount: payment.amount,
      status: checkStatusOf(payment),
      bankAccountId: payment.bankAccountId,
      runId: payment.paymentRunId,
      runStatus: runStatus ?? null,
      printedAt: payment.checkPrintedAt,
      voidedAt: payment.deletedAt,
      reference: payment.reference,
      notes: payment.notes,
    })),
    totalCount: filter.status
      ? (summary[filter.status]?.count ?? 0)
      : Object.values(summary).reduce((sum, s) => sum + s.count, 0),
    summary,
    hasMore,
    cursor: hasMore ? btoa(String(offset + filter.limit)) : null,
  };
}
