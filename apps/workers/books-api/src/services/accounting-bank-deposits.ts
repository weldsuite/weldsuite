/**
 * Bank deposits from Undeposited Funds.
 *
 * Checks and cash received on a US entity wait in Undeposited Funds (see
 * `recordPayment`). Taking them to the bank is a deposit: one journal entry
 * that debits the bank account for the slip's total and credits Undeposited
 * Funds for each payment (plus any other lines on the slip, such as cash back),
 * so the single deposit line on the bank statement matches one ledger line.
 *
 * Posting, the payments' `deposit_id` and the deposit row are one atomic
 * batch; voiding reverses the entry and releases the payments and the bank
 * line the same way.
 */

import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  accountForRole,
  loadEntityAccounts,
  postJournalEntry,
  PostingError,
  reverseJournalEntry,
  roundMoney,
  type PostingLine,
} from './accounting-posting';
import { loadEntity } from './accounting-document-posting';

type DepositRow = typeof schema.bankDeposits.$inferSelect;

export interface UndepositedPayment {
  paymentId: string;
  date: Date;
  paymentMethod: string | null;
  checkNumber: string | null;
  reference: string | null;
  /** The payment's own currency and amount. */
  currency: string | null;
  paymentAmount: string;
  /** What sits in Undeposited Funds for it, in the entity's base currency. */
  amount: number;
  contactId: string;
  contactName: string | null;
  journalEntryId: string;
}

/** Received payments whose money sits in Undeposited Funds and isn't in a deposit yet. */
export async function listUndepositedPayments(db: Database, entityId: string): Promise<UndepositedPayment[]> {
  const undeposited = accountForRole(await loadEntityAccounts(db, entityId), 'undeposited_funds');
  if (!undeposited) return [];

  const { payments, journalLines, parties } = schema;
  const rows = await db
    .select({
      payment: payments,
      amount: sql<string>`sum(coalesce(${journalLines.debit}, 0) - coalesce(${journalLines.credit}, 0))`,
      contactName: parties.displayName,
    })
    .from(payments)
    .innerJoin(
      journalLines,
      and(
        eq(journalLines.journalEntryId, payments.journalEntryId),
        eq(journalLines.accountId, undeposited.id),
        isNull(journalLines.deletedAt),
      ),
    )
    .leftJoin(parties, eq(parties.id, payments.contactId))
    .where(
      and(
        eq(payments.entityId, entityId),
        eq(payments.type, 'received'),
        isNull(payments.deletedAt),
        isNull(payments.depositId),
      ),
    )
    .groupBy(payments.id, parties.displayName)
    .orderBy(payments.date, payments.createdAt);

  return rows
    .filter((r) => Number(r.amount) > 0)
    .map((r) => ({
      paymentId: r.payment.id,
      date: r.payment.date,
      paymentMethod: r.payment.paymentMethod,
      checkNumber: r.payment.checkNumber,
      reference: r.payment.reference,
      currency: r.payment.currency,
      paymentAmount: r.payment.amount,
      amount: roundMoney(Number(r.amount)),
      contactId: r.payment.contactId,
      contactName: r.contactName,
      journalEntryId: r.payment.journalEntryId!,
    }));
}

export interface DepositOtherLine {
  accountId: string;
  /** Positive adds to the deposit (a refund received), negative is cash back. */
  amount: number;
  description?: string | null;
}

export interface CreateDepositInput {
  entityId: string;
  bankAccountId: string;
  /** `YYYY-MM-DD` */
  date: string;
  paymentIds: string[];
  otherLines?: DepositOtherLine[];
  memo?: string | null;
  userId: string | null;
}

export async function createDeposit(
  db: Database,
  input: CreateDepositInput,
): Promise<{ depositId: string; journalEntryId: string | null; amount: number }> {
  const accounts = await loadEntityAccounts(db, input.entityId);
  const undeposited = accountForRole(accounts, 'undeposited_funds');
  if (!undeposited) throw new PostingError('This accounting entity has no Undeposited Funds account');

  const [bankAccount] = await db
    .select()
    .from(schema.bankAccounts)
    .where(
      and(
        eq(schema.bankAccounts.id, input.bankAccountId),
        eq(schema.bankAccounts.entityId, input.entityId),
        isNull(schema.bankAccounts.deletedAt),
      ),
    )
    .limit(1);
  if (!bankAccount) throw new PostingError('Bank account not found for this accounting entity');
  const bankLedger = accounts.byId(bankAccount.ledgerAccountId);
  if (!bankLedger) {
    throw new PostingError('This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.');
  }
  if (bankLedger.type !== 'asset') throw new PostingError('Deposits go to a checking, savings or money market account');
  const entity = await loadEntity(db, input.entityId);
  if (bankAccount.currency && bankAccount.currency !== entity.baseCurrency) {
    throw new PostingError(`Deposits into a ${bankAccount.currency} bank account aren't supported on a ${entity.baseCurrency} entity`);
  }

  const paymentIds = [...new Set(input.paymentIds)];
  const otherLines = input.otherLines ?? [];
  if (paymentIds.length === 0 && otherLines.length === 0) throw new PostingError('Pick at least one payment to deposit');

  const candidates = await listUndepositedPayments(db, input.entityId);
  const byId = new Map(candidates.map((c) => [c.paymentId, c]));
  const chosen = paymentIds.map((id) => {
    const found = byId.get(id);
    if (!found) throw new PostingError(`Payment ${id} is not waiting in Undeposited Funds (already deposited, voided, or paid into a bank account)`);
    return found;
  });

  for (const line of otherLines) {
    if (!(Math.abs(line.amount) > 0)) throw new PostingError('Other deposit lines need a non-zero amount');
    const account = accounts.byId(line.accountId);
    if (!account) throw new PostingError(`Account ${line.accountId} does not belong to this accounting entity`);
    if (account.id === undeposited.id || account.id === bankLedger.id) {
      throw new PostingError('Other deposit lines go to an income, expense or other account, not to Undeposited Funds or the bank itself');
    }
  }

  const paymentsTotal = roundMoney(chosen.reduce((sum, p) => sum + p.amount, 0));
  const total = roundMoney(otherLines.reduce((sum, l) => sum + l.amount, paymentsTotal));
  if (!(total > 0)) throw new PostingError('The deposit total must be greater than zero');

  const depositId = generateId('dep');
  const memo = input.memo?.trim() || null;
  const meta = { currency: entity.baseCurrency };
  const lines: PostingLine[] = [
    { accountId: bankLedger.id, debit: total, description: memo ? `Deposit: ${memo}` : 'Deposit', ...meta },
    ...chosen.map((p) => ({
      accountId: undeposited.id,
      credit: p.amount,
      description: `Deposit of ${p.checkNumber ? `check ${p.checkNumber}` : p.paymentMethod ?? 'payment'}${p.contactName ? ` from ${p.contactName}` : ''}`,
      contactId: p.contactId,
      ...meta,
    })),
    ...otherLines.map((l) => ({
      accountId: l.accountId,
      ...(l.amount > 0 ? { credit: l.amount } : { debit: -l.amount }),
      description: l.description ?? (l.amount > 0 ? 'Deposit: other income' : 'Deposit: cash back'),
      ...meta,
    })),
  ];

  const now = new Date();
  const posted = await postJournalEntry(db, {
    entityId: input.entityId,
    date: new Date(`${input.date.slice(0, 10)}T00:00:00Z`),
    description: memo ? `Bank deposit — ${memo}` : 'Bank deposit',
    sourceType: 'bank_deposit',
    sourceId: depositId,
    postingKey: `bank_deposit:${depositId}:post`,
    lockKind: 'general',
    lines,
    createdBy: input.userId,
    alsoWrite: (h, entry) => [
      h.insert(schema.bankDeposits).values({
        id: depositId,
        entityId: input.entityId,
        bankAccountId: bankAccount.id,
        date: input.date.slice(0, 10),
        amount: total.toFixed(2),
        currency: entity.baseCurrency,
        memo,
        otherLines: otherLines.length > 0 ? otherLines.map((l) => ({ ...l, description: l.description ?? undefined })) : null,
        status: 'posted',
        journalEntryId: entry.journalEntryId,
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      }),
      ...(chosen.length > 0
        ? [
            h
              .update(schema.payments)
              .set({ depositId, updatedAt: now })
              .where(and(inArray(schema.payments.id, paymentIds), isNull(schema.payments.depositId))),
          ]
        : []),
    ],
  });

  return { depositId, journalEntryId: posted.journalEntryId, amount: total };
}

/**
 * Void a deposit: reverse its entry (dated today), put its payments back in
 * Undeposited Funds and release the bank line it was matched to, atomically.
 */
export async function voidDeposit(
  db: Database,
  args: { entityId: string; depositId: string; userId: string | null; date?: Date },
): Promise<DepositRow> {
  const [deposit] = await db
    .select()
    .from(schema.bankDeposits)
    .where(
      and(
        eq(schema.bankDeposits.id, args.depositId),
        eq(schema.bankDeposits.entityId, args.entityId),
        isNull(schema.bankDeposits.deletedAt),
      ),
    )
    .limit(1);
  if (!deposit) throw new PostingError('Deposit not found');
  if (deposit.status === 'void') throw new PostingError('This deposit has already been voided');

  const now = args.date ?? new Date();
  const release = (h: Database): unknown[] => [
    h.update(schema.bankDeposits).set({ status: 'void', updatedAt: now }).where(eq(schema.bankDeposits.id, deposit.id)),
    h.update(schema.payments).set({ depositId: null, updatedAt: now }).where(eq(schema.payments.depositId, deposit.id)),
    h
      .update(schema.bankTransactions)
      .set({
        status: 'unreconciled',
        reconciliationType: null,
        depositId: null,
        journalEntryId: null,
        updatedAt: now,
      })
      .where(eq(schema.bankTransactions.depositId, deposit.id)),
  ];

  if (deposit.journalEntryId) {
    await reverseJournalEntry(db, {
      entryId: deposit.journalEntryId,
      date: now,
      createdBy: args.userId,
      description: `Void bank deposit${deposit.memo ? ` — ${deposit.memo}` : ''}`,
      alsoWrite: (h) => release(h),
    });
  } else {
    await atomically(db, release);
  }
  return deposit;
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface ListDepositsFilter {
  bankAccountId?: string;
  status?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string | null;
}

function encodeCursor(deposit: Pick<DepositRow, 'date' | 'id'>): string {
  return btoa(`${deposit.date}|${deposit.id}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): { date: string; id: string } | null {
  try {
    const padded = cursor.replaceAll('-', '+').replaceAll('_', '/');
    const [date, id] = atob(padded).split('|');
    return date && id && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date, id } : null;
  } catch {
    return null;
  }
}

/** Deposits of an entity, newest first, with a keyset cursor over (date, id). */
export async function listDeposits(
  db: Database,
  entityId: string,
  filter: ListDepositsFilter,
): Promise<{ rows: DepositRow[]; totalCount: number; hasMore: boolean; cursor: string | null }> {
  const t = schema.bankDeposits;
  const base = [eq(t.entityId, entityId), isNull(t.deletedAt)];
  if (filter.bankAccountId) base.push(eq(t.bankAccountId, filter.bankAccountId));
  if (filter.status) base.push(eq(t.status, filter.status));
  if (filter.from) base.push(gte(t.date, filter.from));
  if (filter.to) base.push(lte(t.date, filter.to));

  const after = filter.cursor ? decodeCursor(filter.cursor) : null;
  if (filter.cursor && !after) throw new PostingError('Invalid cursor');
  const page = after ? [...base, or(lt(t.date, after.date), and(eq(t.date, after.date), lt(t.id, after.id)))!] : base;

  const [rows, count] = await Promise.all([
    db
      .select()
      .from(t)
      .where(and(...page))
      .orderBy(desc(t.date), desc(t.id))
      .limit(filter.limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(t).where(and(...base)),
  ]);
  const hasMore = rows.length > filter.limit;
  const pageRows = hasMore ? rows.slice(0, filter.limit) : rows;
  return {
    rows: pageRows,
    totalCount: Number(count[0]?.count ?? 0),
    hasMore,
    cursor: hasMore ? encodeCursor(pageRows.at(-1)!) : null,
  };
}

/** A deposit with its payments, other lines (account names) and bank line. */
export async function loadDepositDetail(db: Database, deposit: DepositRow) {
  const { payments, parties, accounts, bankAccounts, journalEntries } = schema;
  const [paymentRows, bankAccount, entry] = await Promise.all([
    db
      .select({
        id: payments.id,
        date: payments.date,
        amount: payments.amount,
        currency: payments.currency,
        paymentMethod: payments.paymentMethod,
        checkNumber: payments.checkNumber,
        reference: payments.reference,
        contactId: payments.contactId,
        contactName: parties.displayName,
        invoiceId: payments.invoiceId,
      })
      .from(payments)
      .leftJoin(parties, eq(parties.id, payments.contactId))
      .where(and(eq(payments.depositId, deposit.id), isNull(payments.deletedAt)))
      .orderBy(payments.date),
    db
      .select({ id: bankAccounts.id, name: bankAccounts.name })
      .from(bankAccounts)
      .where(eq(bankAccounts.id, deposit.bankAccountId))
      .limit(1),
    deposit.journalEntryId
      ? db
          .select({ id: journalEntries.id, entryNumber: journalEntries.entryNumber })
          .from(journalEntries)
          .where(eq(journalEntries.id, deposit.journalEntryId))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const accountIds = (deposit.otherLines ?? []).map((l) => l.accountId);
  const accountRows =
    accountIds.length > 0
      ? await db
          .select({ id: accounts.id, code: accounts.code, name: accounts.name })
          .from(accounts)
          .where(inArray(accounts.id, accountIds))
      : [];
  const accountById = new Map(accountRows.map((a) => [a.id, a]));

  return {
    ...deposit,
    bankAccountName: bankAccount[0]?.name ?? null,
    journalEntryNumber: entry[0]?.entryNumber ?? null,
    payments: paymentRows,
    otherLines: (deposit.otherLines ?? []).map((l) => ({
      ...l,
      accountCode: accountById.get(l.accountId)?.code ?? null,
      accountName: accountById.get(l.accountId)?.name ?? null,
    })),
  };
}
