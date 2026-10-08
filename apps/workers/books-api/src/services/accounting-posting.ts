/**
 * The one way a journal entry reaches the ledger.
 *
 * Every posting (invoice, credit note, bill, payment, bank line, write-off,
 * manual entry, reversal, FX adjustment) goes through `postJournalEntry`,
 * which:
 *   - refuses unbalanced entries and accounts from another entity;
 *   - checks closed fiscal periods and lock dates;
 *   - writes the entry, its lines, its tax-ledger rows, the account balance
 *     updates and any caller statements (e.g. "mark the invoice finalized")
 *     as ONE atomic batch — neon-http has no interactive transactions, so
 *     nothing is read between the writes;
 *   - is idempotent per `postingKey`: a retry, or two concurrent requests,
 *     find the entry that already exists instead of posting twice.
 *
 * Amounts are in the entity's base currency (see the journal_lines schema).
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import { assertPostingAllowed, type PostingLockKind } from '@weldsuite/books-domain/accounting-guards';
import { nextEntityNumber } from '../lib/entity-context';

/**
 * Journal entry statuses that are in the ledger. A reversed entry stays in
 * the books next to its (posted) reversal — together they net to zero — so
 * every report and balance must count both.
 */
export const BOOKED_STATUSES = ['posted', 'reversed'];

export class PostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostingError';
  }
}

export interface PostingLine {
  accountId: string;
  debit?: number;
  credit?: number;
  description?: string | null;
  contactId?: string | null;
  taxRateId?: string | null;
  taxAmount?: number | null;
  /** Source document currency and rate (foreign units per base unit). */
  currency?: string | null;
  exchangeRate?: string | null;
}

export interface PostingTaxLine {
  sourceLineId?: string | null;
  direction: 'sales' | 'purchase';
  taxRateId?: string | null;
  taxRateName?: string | null;
  taxCategoryCode?: string | null;
  rate: number;
  component?: string | null;
  selfAssessed?: boolean;
  jurisdictionCode?: string | null;
  jurisdictionLevel?: string | null;
  stateCode?: string | null;
  /** Document-currency amounts, signed (negative on credit notes and reversals). */
  taxableAmount: number;
  taxAmount: number;
  currency: string;
  baseTaxableAmount: number;
  baseTaxAmount: number;
  contactId?: string | null;
}

export interface PostJournalEntryInput {
  entityId: string;
  date: Date;
  description: string;
  reference?: string | null;
  sourceType: string;
  sourceId?: string | null;
  postingKey?: string | null;
  lockKind: PostingLockKind;
  lines: PostingLine[];
  taxLines?: PostingTaxLine[];
  createdBy?: string | null;
  isAutomatic?: boolean;
  reversalOfId?: string | null;
  /** Extra statements written in the same atomic batch as the entry. */
  alsoWrite?: (handle: Database, posted: { journalEntryId: string; entryNumber: string }) => unknown[];
}

export interface PostedEntry {
  /** Null when there was nothing to post (all amounts zero). */
  journalEntryId: string | null;
  entryNumber: string | null;
  alreadyPosted: boolean;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

interface NormalizedLine extends PostingLine {
  debit: number;
  credit: number;
}

function normalizeLines(lines: PostingLine[]): NormalizedLine[] {
  const result: NormalizedLine[] = [];
  for (const line of lines) {
    let debit = roundMoney(line.debit ?? 0);
    let credit = roundMoney(line.credit ?? 0);
    if (!Number.isFinite(debit) || !Number.isFinite(credit)) {
      throw new PostingError('Journal line amounts must be numbers');
    }
    // A negative debit is a credit and vice versa (credit notes build lines
    // from signed amounts).
    if (debit < 0) {
      credit = roundMoney(credit - debit);
      debit = 0;
    }
    if (credit < 0) {
      debit = roundMoney(debit - credit);
      credit = 0;
    }
    const net = roundMoney(debit - credit);
    if (net === 0) continue;
    result.push({ ...line, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
  }
  return result;
}

async function findByPostingKey(db: Database, postingKey: string) {
  const [existing] = await db
    .select({ id: schema.journalEntries.id, entryNumber: schema.journalEntries.entryNumber })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.postingKey, postingKey))
    .limit(1);
  return existing;
}

async function assertAccountsBelongToEntity(db: Database, entityId: string, accountIds: string[]) {
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) return;
  const rows = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.entityId, entityId),
        inArray(schema.accounts.id, unique),
        isNull(schema.accounts.deletedAt),
      ),
    );
  const found = new Set(rows.map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new PostingError(`Account ${missing.join(', ')} does not belong to this accounting entity`);
  }
}

export async function postJournalEntry(db: Database, input: PostJournalEntryInput): Promise<PostedEntry> {
  if (input.postingKey) {
    const existing = await findByPostingKey(db, input.postingKey);
    if (existing) return { journalEntryId: existing.id, entryNumber: existing.entryNumber, alreadyPosted: true };
  }

  const lines = normalizeLines(input.lines);
  const totalDebit = roundMoney(lines.reduce((sum, l) => sum + l.debit, 0));
  const totalCredit = roundMoney(lines.reduce((sum, l) => sum + l.credit, 0));
  if (totalDebit !== totalCredit) {
    throw new PostingError(
      `Journal entry is not balanced. Total debit: ${totalDebit.toFixed(2)}, total credit: ${totalCredit.toFixed(2)}`,
    );
  }
  const taxLines = (input.taxLines ?? []).filter((t) => t.taxableAmount !== 0 || t.taxAmount !== 0);
  if (lines.length === 0 && taxLines.length === 0) {
    return { journalEntryId: null, entryNumber: null, alreadyPosted: false };
  }

  await assertPostingAllowed(db, {
    entityId: input.entityId,
    date: input.date,
    kind: input.lockKind,
    affectsTax: taxLines.length > 0,
    userId: input.createdBy ?? null,
  });
  await assertAccountsBelongToEntity(db, input.entityId, lines.map((l) => l.accountId));

  const { formatted: entryNumber } = await nextEntityNumber(db, input.entityId, 'journal');
  const journalEntryId = generateId('je');
  const now = new Date();
  const taxDate = input.date.toISOString().slice(0, 10);

  const entryRow = {
    id: journalEntryId,
    entityId: input.entityId,
    entryNumber,
    date: input.date,
    status: 'posted',
    description: input.description,
    reference: input.reference ?? null,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    postingKey: input.postingKey ?? null,
    reversalOfId: input.reversalOfId ?? null,
    isAutomatic: input.isAutomatic ?? true,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const lineRows = lines.map((line, idx) => ({
    id: generateId('jl'),
    entityId: input.entityId,
    journalEntryId,
    accountId: line.accountId,
    description: line.description ?? null,
    debit: line.debit.toFixed(2),
    credit: line.credit.toFixed(2),
    taxRateId: line.taxRateId ?? null,
    taxAmount: line.taxAmount == null ? null : roundMoney(line.taxAmount).toFixed(2),
    contactId: line.contactId ?? null,
    currency: line.currency ?? null,
    exchangeRate: line.exchangeRate ?? '1',
    baseCurrencyDebit: line.debit.toFixed(2),
    baseCurrencyCredit: line.credit.toFixed(2),
    sortOrder: idx,
    createdAt: now,
    updatedAt: now,
  }));

  const taxRows = taxLines.map((tax) => ({
    id: generateId('txl'),
    createdAt: now,
    entityId: input.entityId,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    sourceLineId: tax.sourceLineId ?? null,
    journalEntryId,
    taxDate,
    direction: tax.direction,
    taxRateId: tax.taxRateId ?? null,
    taxRateName: tax.taxRateName ?? null,
    taxCategoryCode: tax.taxCategoryCode ?? null,
    rate: tax.rate.toFixed(4),
    component: tax.component ?? null,
    selfAssessed: tax.selfAssessed ?? false,
    jurisdictionCode: tax.jurisdictionCode ?? null,
    jurisdictionLevel: tax.jurisdictionLevel ?? null,
    stateCode: tax.stateCode ?? null,
    taxableAmount: roundMoney(tax.taxableAmount).toFixed(2),
    taxAmount: roundMoney(tax.taxAmount).toFixed(2),
    currency: tax.currency,
    baseTaxableAmount: roundMoney(tax.baseTaxableAmount).toFixed(2),
    baseTaxAmount: roundMoney(tax.baseTaxAmount).toFixed(2),
    contactId: tax.contactId ?? null,
  }));

  // One balance update per account, net of all its lines.
  const netByAccount = new Map<string, number>();
  for (const line of lines) {
    netByAccount.set(line.accountId, roundMoney((netByAccount.get(line.accountId) ?? 0) + line.debit - line.credit));
  }

  try {
    await atomically(db, (h) => {
      const statements: unknown[] = [h.insert(schema.journalEntries).values(entryRow)];
      if (lineRows.length > 0) statements.push(h.insert(schema.journalLines).values(lineRows));
      if (taxRows.length > 0) statements.push(h.insert(schema.taxLines).values(taxRows));
      for (const [accountId, net] of netByAccount) {
        if (net === 0) continue;
        statements.push(
          h
            .update(schema.accounts)
            .set({
              currentBalance: sql`(coalesce(${schema.accounts.currentBalance}, 0)::numeric + ${net.toFixed(2)}::numeric)`,
              updatedAt: now,
            })
            .where(eq(schema.accounts.id, accountId)),
        );
      }
      if (input.alsoWrite) statements.push(...input.alsoWrite(h, { journalEntryId, entryNumber }));
      return statements;
    });
  } catch (err) {
    // Lost a race with an identical posting: the other request's entry stands.
    if (input.postingKey && isUniqueViolation(err)) {
      const existing = await findByPostingKey(db, input.postingKey);
      if (existing) return { journalEntryId: existing.id, entryNumber: existing.entryNumber, alreadyPosted: true };
    }
    throw err;
  }

  return { journalEntryId, entryNumber, alreadyPosted: false };
}

/**
 * Post the mirror image of a posted entry, dated `date`, and mark the
 * original `reversed`. Lines swap debit and credit; tax-ledger rows are
 * negated and count in the reversal's period, which is how a correction
 * belongs on a tax return.
 */
export async function reverseJournalEntry(
  db: Database,
  args: {
    entryId: string;
    date: Date;
    createdBy?: string | null;
    lockKind?: PostingLockKind;
    description?: string;
    postingKey?: string | null;
    alsoWrite?: PostJournalEntryInput['alsoWrite'];
  },
): Promise<PostedEntry> {
  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.id, args.entryId), isNull(schema.journalEntries.deletedAt)))
    .limit(1);
  if (!entry) throw new PostingError('Journal entry not found');
  if (entry.status === 'reversed' || entry.reversedById) {
    throw new PostingError('This journal entry has already been reversed');
  }
  if (entry.status !== 'posted') throw new PostingError('Can only reverse posted journal entries');

  const [lines, taxRows] = await Promise.all([
    db
      .select()
      .from(schema.journalLines)
      .where(and(eq(schema.journalLines.journalEntryId, entry.id), isNull(schema.journalLines.deletedAt))),
    db.select().from(schema.taxLines).where(eq(schema.taxLines.journalEntryId, entry.id)),
  ]);

  return postJournalEntry(db, {
    entityId: entry.entityId,
    date: args.date,
    description: args.description ?? `Reversal of ${entry.entryNumber ?? entry.id}`,
    reference: entry.reference,
    sourceType: entry.sourceType ?? 'manual',
    // A manual entry has no source document; its reversal points at the entry itself.
    sourceId: entry.sourceId ?? entry.id,
    postingKey: args.postingKey ?? `reversal:${entry.id}`,
    lockKind: args.lockKind ?? 'general',
    reversalOfId: entry.id,
    createdBy: args.createdBy ?? null,
    lines: lines.map((line) => ({
      accountId: line.accountId,
      debit: Number(line.credit ?? 0),
      credit: Number(line.debit ?? 0),
      description: `Reversal: ${line.description ?? ''}`.trim(),
      contactId: line.contactId,
      taxRateId: line.taxRateId,
      taxAmount: line.taxAmount == null ? null : -Number(line.taxAmount),
      currency: line.currency,
      exchangeRate: line.exchangeRate,
    })),
    taxLines: taxRows.map((tax) => ({
      sourceLineId: tax.sourceLineId,
      direction: tax.direction as 'sales' | 'purchase',
      taxRateId: tax.taxRateId,
      taxRateName: tax.taxRateName,
      taxCategoryCode: tax.taxCategoryCode,
      rate: Number(tax.rate),
      component: tax.component,
      selfAssessed: tax.selfAssessed,
      jurisdictionCode: tax.jurisdictionCode,
      jurisdictionLevel: tax.jurisdictionLevel,
      stateCode: tax.stateCode,
      taxableAmount: -Number(tax.taxableAmount),
      taxAmount: -Number(tax.taxAmount),
      currency: tax.currency,
      baseTaxableAmount: -Number(tax.baseTaxableAmount),
      baseTaxAmount: -Number(tax.baseTaxAmount),
      contactId: tax.contactId,
    })),
    alsoWrite: (h, posted) => [
      h
        .update(schema.journalEntries)
        .set({ status: 'reversed', reversedById: posted.journalEntryId, updatedAt: new Date() })
        .where(eq(schema.journalEntries.id, entry.id)),
      ...(args.alsoWrite ? args.alsoWrite(h, posted) : []),
    ],
  });
}

/**
 * Post a manual draft entry: draft → posted, account balances and tax-ledger
 * rows applied in one batch. A line that carries a tax rate holds the gross
 * amount with `taxAmount` as its tax part; credit lines count as sales tax,
 * debit lines as purchase tax.
 */
export async function postDraftJournalEntry(
  db: Database,
  args: { entryId: string; userId: string | null },
): Promise<{ entry: typeof schema.journalEntries.$inferSelect }> {
  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.id, args.entryId), isNull(schema.journalEntries.deletedAt)))
    .limit(1);
  if (!entry) throw new PostingError('Journal entry not found');
  if (entry.status !== 'draft') throw new PostingError('Can only post draft journal entries');

  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(and(eq(schema.journalLines.journalEntryId, entry.id), isNull(schema.journalLines.deletedAt)));

  const totalDebit = roundMoney(lines.reduce((sum, l) => sum + Number(l.debit ?? 0), 0));
  const totalCredit = roundMoney(lines.reduce((sum, l) => sum + Number(l.credit ?? 0), 0));
  if (totalDebit !== totalCredit) {
    throw new PostingError(
      `Journal entry is not balanced. Total debit: ${totalDebit.toFixed(2)}, total credit: ${totalCredit.toFixed(2)}`,
    );
  }

  const taxRateIds = [...new Set(lines.map((l) => l.taxRateId).filter((id): id is string => Boolean(id)))];
  const rates =
    taxRateIds.length > 0
      ? await db
          .select()
          .from(schema.taxRates)
          .where(and(eq(schema.taxRates.entityId, entry.entityId), inArray(schema.taxRates.id, taxRateIds)))
      : [];
  const rateById = new Map(rates.map((r) => [r.id, r]));
  const missing = taxRateIds.filter((id) => !rateById.has(id));
  if (missing.length > 0) {
    throw new PostingError(`Tax rate ${missing.join(', ')} does not belong to this accounting entity`);
  }

  await assertPostingAllowed(db, {
    entityId: entry.entityId,
    date: entry.date,
    kind: 'general',
    affectsTax: taxRateIds.length > 0,
    userId: args.userId,
  });
  await assertAccountsBelongToEntity(db, entry.entityId, lines.map((l) => l.accountId));

  const now = new Date();
  const taxDate = entry.date.toISOString().slice(0, 10);
  const taxRows = lines
    .filter((l) => l.taxRateId)
    .map((l) => {
      const rate = rateById.get(l.taxRateId!)!;
      const debit = Number(l.debit ?? 0);
      const credit = Number(l.credit ?? 0);
      const tax = Math.abs(Number(l.taxAmount ?? 0));
      const taxable = roundMoney(Math.abs(credit - debit) - tax);
      return {
        id: generateId('txl'),
        createdAt: now,
        entityId: entry.entityId,
        sourceType: 'journal',
        sourceId: entry.id,
        sourceLineId: l.id,
        journalEntryId: entry.id,
        taxDate,
        direction: credit > debit ? 'sales' : 'purchase',
        taxRateId: rate.id,
        taxRateName: rate.name,
        taxCategoryCode: rate.taxCategoryCode ?? null,
        rate: Number(rate.rate).toFixed(4),
        selfAssessed: false,
        taxableAmount: taxable.toFixed(2),
        taxAmount: tax.toFixed(2),
        currency: l.currency ?? 'EUR',
        baseTaxableAmount: taxable.toFixed(2),
        baseTaxAmount: tax.toFixed(2),
        contactId: l.contactId,
      };
    });

  const netByAccount = new Map<string, number>();
  for (const line of lines) {
    const net = Number(line.debit ?? 0) - Number(line.credit ?? 0);
    netByAccount.set(line.accountId, roundMoney((netByAccount.get(line.accountId) ?? 0) + net));
  }

  await atomically(db, (h) => {
    const statements: unknown[] = [
      h
        .update(schema.journalEntries)
        .set({ status: 'posted', totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2), updatedAt: now })
        .where(and(eq(schema.journalEntries.id, entry.id), eq(schema.journalEntries.status, 'draft'))),
    ];
    if (taxRows.length > 0) statements.push(h.insert(schema.taxLines).values(taxRows));
    for (const [accountId, net] of netByAccount) {
      if (net === 0) continue;
      statements.push(
        h
          .update(schema.accounts)
          .set({
            currentBalance: sql`(coalesce(${schema.accounts.currentBalance}, 0)::numeric + ${net.toFixed(2)}::numeric)`,
            updatedAt: now,
          })
          .where(eq(schema.accounts.id, accountId)),
      );
    }
    return statements;
  });

  return { entry: { ...entry, status: 'posted' } };
}

/** An entity's chart of accounts with lookups by id, system role and code. */
export interface EntityAccounts {
  byId(id: string | null | undefined): typeof schema.accounts.$inferSelect | undefined;
  byRole(role: string): typeof schema.accounts.$inferSelect | undefined;
  byCode(code: string): typeof schema.accounts.$inferSelect | undefined;
  bySubtype(subtype: string): typeof schema.accounts.$inferSelect | undefined;
}

export async function loadEntityAccounts(db: Database, entityId: string): Promise<EntityAccounts> {
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.entityId, entityId), isNull(schema.accounts.deletedAt)));
  const sorted = [...rows].sort((a, b) => a.code.localeCompare(b.code));
  return {
    byId: (id) => (id ? rows.find((a) => a.id === id) : undefined),
    byRole: (role) => rows.find((a) => (a.metadata as { systemRole?: string } | null)?.systemRole === role),
    byCode: (code) => rows.find((a) => a.code === code),
    bySubtype: (subtype) => sorted.find((a) => a.subtype === subtype && a.isActive !== false),
  };
}

/** The account for a system role, falling back to well-known template codes for entities seeded before the role existed. */
export function accountForRole(
  accounts: EntityAccounts,
  role: string,
  fallbackCodes: string[] = [],
): typeof schema.accounts.$inferSelect | undefined {
  const byRole = accounts.byRole(role);
  if (byRole) return byRole;
  for (const code of fallbackCodes) {
    const byCode = accounts.byCode(code);
    if (byCode) return byCode;
  }
  return undefined;
}
