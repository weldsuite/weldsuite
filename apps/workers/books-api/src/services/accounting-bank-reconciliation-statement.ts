/**
 * Statement reconciliation.
 *
 * The bookkeeper enters the statement's ending date and balance, ticks the
 * ledger lines on the bank (or card) account that cleared, and finishes when
 * the difference is zero. Finishing stamps `journal_lines.reconciliation_id`
 * and `reconciled`, and stores a report snapshot. An admin can undo the latest
 * completed reconciliation of an account, which clears the stamps again.
 *
 * Works on the bank account's LEDGER lines, not on bank_transactions: bank
 * lines are matched to documents elsewhere, this is the bookkeeper's check
 * that the books agree with the statement.
 *
 * Signs. A debit to the ledger account is an inflow (a deposit; on a card, a
 * payment to the card) and a credit an outflow (a payment; on a card, a
 * charge) from the statement's point of view, on a bank and a card alike. The
 * statement balance of a bank account is what it holds, of a card what is owed:
 *   bank: cleared = beginning + inflows - outflows
 *   card: cleared = beginning - inflows + outflows
 */

import { and, desc, eq, gt, gte, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  BOOKED_STATUSES,
  loadEntityAccounts,
  postJournalEntry,
  PostingError,
  reverseJournalEntry,
  roundMoney,
} from './accounting-posting';

type RecRow = typeof schema.bankReconciliations.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;

/** A second reconciliation can't start while one is open. */
export class ReconciliationConflictError extends PostingError {
  constructor(
    message: string,
    readonly existingId: string,
  ) {
    super(message);
    this.name = 'ReconciliationConflictError';
  }
}

const EPSILON = 0.005;

// ── Ledger lines ────────────────────────────────────────────────────────────

export interface LedgerLine {
  id: string;
  journalEntryId: string;
  entryNumber: string | null;
  /** `YYYY-MM-DD` */
  date: string;
  description: string | null;
  debit: number;
  credit: number;
  contactId: string | null;
  contactName: string | null;
  reference: string | null;
  sourceType: string | null;
  sourceId: string | null;
  reversedById: string | null;
  reversalOfId: string | null;
  reconciliationId: string | null;
}

export interface LineDocument {
  type: string;
  id: string | null;
  number: string | null;
  checkNumber: string | null;
  method: string | null;
}

export interface LineView {
  id: string;
  journalEntryId: string;
  entryNumber: string | null;
  date: string;
  description: string | null;
  /** Always positive; `inflows` / `outflows` say which way it went. */
  amount: number;
  contactId: string | null;
  contactName: string | null;
  reference: string | null;
  sourceType: string | null;
  document: LineDocument | null;
  cleared: boolean;
}

function dayAfter(statementDate: string): Date {
  const next = new Date(`${statementDate.slice(0, 10)}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

async function loadLines(
  db: Database,
  args: { entityId: string; ledgerAccountId: string; where: ReturnType<typeof and> },
): Promise<LedgerLine[]> {
  const { journalLines: jl, journalEntries: je, parties } = schema;
  const rows = await db
    .select({
      id: jl.id,
      journalEntryId: jl.journalEntryId,
      entryNumber: je.entryNumber,
      date: je.date,
      description: jl.description,
      entryDescription: je.description,
      debit: jl.debit,
      credit: jl.credit,
      contactId: jl.contactId,
      contactName: parties.displayName,
      reference: je.reference,
      sourceType: je.sourceType,
      sourceId: je.sourceId,
      reversedById: je.reversedById,
      reversalOfId: je.reversalOfId,
      reconciliationId: jl.reconciliationId,
    })
    .from(jl)
    .innerJoin(je, eq(jl.journalEntryId, je.id))
    .leftJoin(parties, eq(parties.id, jl.contactId))
    .where(
      and(
        eq(jl.accountId, args.ledgerAccountId),
        eq(jl.entityId, args.entityId),
        isNull(jl.deletedAt),
        isNull(je.deletedAt),
        inArray(je.status, BOOKED_STATUSES),
        args.where,
      ),
    )
    .orderBy(je.date, je.createdAt, jl.sortOrder);
  return rows.map((r) => ({
    id: r.id,
    journalEntryId: r.journalEntryId,
    entryNumber: r.entryNumber,
    date: r.date.toISOString().slice(0, 10),
    description: r.description ?? r.entryDescription,
    debit: Number(r.debit ?? 0),
    credit: Number(r.credit ?? 0),
    contactId: r.contactId,
    contactName: r.contactName,
    reference: r.reference,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    reversedById: r.reversedById,
    reversalOfId: r.reversalOfId,
    reconciliationId: r.reconciliationId,
  }));
}

/** Lines on the ledger account that no reconciliation has cleared, dated on or before the statement date. */
async function loadOpenLines(db: Database, rec: Pick<RecRow, 'entityId' | 'ledgerAccountId' | 'statementDate'>): Promise<LedgerLine[]> {
  return loadLines(db, {
    entityId: rec.entityId,
    ledgerAccountId: rec.ledgerAccountId,
    where: and(isNull(schema.journalLines.reconciliationId), lt(schema.journalEntries.date, dayAfter(rec.statementDate))),
  });
}

/** Lines this reconciliation cleared. */
async function loadClearedLines(db: Database, rec: Pick<RecRow, 'id' | 'entityId' | 'ledgerAccountId'>): Promise<LedgerLine[]> {
  return loadLines(db, {
    entityId: rec.entityId,
    ledgerAccountId: rec.ledgerAccountId,
    where: eq(schema.journalLines.reconciliationId, rec.id),
  });
}

/** Uncleared lines dated after the statement date, for the report. */
async function loadLaterLines(db: Database, rec: Pick<RecRow, 'entityId' | 'ledgerAccountId' | 'statementDate'>): Promise<LedgerLine[]> {
  return loadLines(db, {
    entityId: rec.entityId,
    ledgerAccountId: rec.ledgerAccountId,
    where: and(isNull(schema.journalLines.reconciliationId), gte(schema.journalEntries.date, dayAfter(rec.statementDate))),
  });
}

/**
 * An entry that was reversed and its reversal net to zero and never reach a
 * statement. When both are open and in range they are set aside (and cleared
 * with the reconciliation) instead of asking the bookkeeper to tick both.
 */
function splitNettedPairs(lines: LedgerLine[]): { open: LedgerLine[]; netted: LedgerLine[] } {
  const byEntry = new Map<string, LedgerLine[]>();
  for (const line of lines) byEntry.set(line.journalEntryId, [...(byEntry.get(line.journalEntryId) ?? []), line]);

  const nettedEntries = new Set<string>();
  for (const [entryId, entryLines] of byEntry) {
    const reversedBy = entryLines[0].reversedById;
    if (!reversedBy || !byEntry.has(reversedBy)) continue;
    const sum = (ls: LedgerLine[]) => roundMoney(ls.reduce((t, l) => t + l.debit - l.credit, 0));
    if (Math.abs(sum(entryLines) + sum(byEntry.get(reversedBy)!)) < EPSILON) {
      nettedEntries.add(entryId);
      nettedEntries.add(reversedBy);
    }
  }
  return {
    open: lines.filter((l) => !nettedEntries.has(l.journalEntryId)),
    netted: lines.filter((l) => nettedEntries.has(l.journalEntryId)),
  };
}

async function loadDocuments(db: Database, lines: LedgerLine[]): Promise<Map<string, LineDocument>> {
  const documents = new Map<string, LineDocument>();
  const idsOf = (type: string) => [...new Set(lines.filter((l) => l.sourceType === type && l.sourceId).map((l) => l.sourceId!))];

  const paymentIds = idsOf('payment');
  const depositIds = idsOf('bank_deposit');
  const invoiceIds = idsOf('invoice');
  const billIds = idsOf('bill');
  const [payments, deposits, invoices, bills] = await Promise.all([
    paymentIds.length ? db.select().from(schema.payments).where(inArray(schema.payments.id, paymentIds)) : [],
    depositIds.length ? db.select().from(schema.bankDeposits).where(inArray(schema.bankDeposits.id, depositIds)) : [],
    invoiceIds.length ? db.select({ id: schema.invoices.id, number: schema.invoices.invoiceNumber }).from(schema.invoices).where(inArray(schema.invoices.id, invoiceIds)) : [],
    billIds.length ? db.select({ id: schema.bills.id, number: schema.bills.billNumber }).from(schema.bills).where(inArray(schema.bills.id, billIds)) : [],
  ]);
  for (const p of payments) {
    documents.set(`payment:${p.id}`, {
      type: p.type === 'received' ? 'payment_received' : 'payment_sent',
      id: p.id,
      number: p.reference,
      checkNumber: p.checkNumber,
      method: p.paymentMethod,
    });
  }
  for (const d of deposits) {
    documents.set(`bank_deposit:${d.id}`, { type: 'bank_deposit', id: d.id, number: d.memo, checkNumber: null, method: null });
  }
  for (const i of invoices) documents.set(`invoice:${i.id}`, { type: 'invoice', id: i.id, number: i.number, checkNumber: null, method: null });
  for (const b of bills) documents.set(`bill:${b.id}`, { type: 'bill', id: b.id, number: b.number, checkNumber: null, method: null });
  return documents;
}

function toView(line: LedgerLine, documents: Map<string, LineDocument>, cleared: boolean): LineView {
  const inflow = line.debit > 0;
  return {
    id: line.id,
    journalEntryId: line.journalEntryId,
    entryNumber: line.entryNumber,
    date: line.date,
    description: line.description,
    amount: roundMoney(inflow ? line.debit - line.credit : line.credit - line.debit),
    contactId: line.contactId,
    contactName: line.contactName,
    reference: line.reference,
    sourceType: line.sourceType,
    document: line.sourceType && line.sourceId ? (documents.get(`${line.sourceType}:${line.sourceId}`) ?? {
      type: line.sourceType,
      id: line.sourceId,
      number: null,
      checkNumber: null,
      method: null,
    }) : null,
    cleared,
  };
}

const isInflow = (line: LedgerLine) => line.debit - line.credit > 0;

// ── Balances ────────────────────────────────────────────────────────────────

export interface Balances {
  beginningBalance: number;
  statementEndingBalance: number;
  clearedBalance: number;
  difference: number;
  clearedInflows: { count: number; total: number };
  clearedOutflows: { count: number; total: number };
}

function total(lines: LedgerLine[]): { count: number; total: number } {
  return { count: lines.length, total: roundMoney(lines.reduce((t, l) => t + Math.abs(l.debit - l.credit), 0)) };
}

/** Cleared balance and difference for the ticked lines; a card's balance is what is owed, so the signs flip. */
export function computeBalances(
  rec: Pick<RecRow, 'beginningBalance' | 'statementEndingBalance'>,
  ticked: LedgerLine[],
  liability: boolean,
): Balances {
  const beginning = Number(rec.beginningBalance);
  const ending = Number(rec.statementEndingBalance);
  const inflows = total(ticked.filter(isInflow));
  const outflows = total(ticked.filter((l) => !isInflow(l)));
  const sign = liability ? -1 : 1;
  const cleared = roundMoney(beginning + sign * (inflows.total - outflows.total));
  return {
    beginningBalance: beginning,
    statementEndingBalance: ending,
    clearedBalance: cleared,
    difference: roundMoney(ending - cleared),
    clearedInflows: inflows,
    clearedOutflows: outflows,
  };
}

async function loadLedger(db: Database, entityId: string, ledgerAccountId: string): Promise<AccountRow> {
  const accounts = await loadEntityAccounts(db, entityId);
  const ledger = accounts.byId(ledgerAccountId);
  if (!ledger) throw new PostingError('The ledger account of this bank account was not found');
  return ledger;
}

// ── Starting and editing ────────────────────────────────────────────────────

export async function startReconciliation(
  db: Database,
  args: {
    entityId: string;
    bankAccountId: string;
    statementDate: string;
    statementEndingBalance: number;
    /** Only for the first reconciliation of an account; later ones begin where the last ended. */
    beginningBalance?: number;
    userId: string | null;
  },
): Promise<RecRow> {
  const [bankAccount] = await db
    .select()
    .from(schema.bankAccounts)
    .where(
      and(
        eq(schema.bankAccounts.id, args.bankAccountId),
        eq(schema.bankAccounts.entityId, args.entityId),
        isNull(schema.bankAccounts.deletedAt),
      ),
    )
    .limit(1);
  if (!bankAccount) throw new PostingError('Bank account not found for this accounting entity');
  if (!bankAccount.ledgerAccountId) {
    throw new PostingError('This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.');
  }
  await loadLedger(db, args.entityId, bankAccount.ledgerAccountId);

  const [open] = await db
    .select({ id: schema.bankReconciliations.id })
    .from(schema.bankReconciliations)
    .where(and(eq(schema.bankReconciliations.bankAccountId, bankAccount.id), eq(schema.bankReconciliations.status, 'in_progress')))
    .limit(1);
  if (open) throw new ReconciliationConflictError('A reconciliation is already in progress for this account. Finish or discard it first.', open.id);

  const [last] = await db
    .select()
    .from(schema.bankReconciliations)
    .where(and(eq(schema.bankReconciliations.bankAccountId, bankAccount.id), eq(schema.bankReconciliations.status, 'completed')))
    .orderBy(desc(schema.bankReconciliations.statementDate), desc(schema.bankReconciliations.completedAt))
    .limit(1);
  if (last && args.statementDate <= last.statementDate) {
    throw new PostingError(`The statement date must be after the last reconciled statement (${last.statementDate}).`);
  }

  const beginning = last ? Number(last.statementEndingBalance) : (args.beginningBalance ?? 0);
  const now = new Date();
  const row: typeof schema.bankReconciliations.$inferInsert = {
    id: generateId('brec'),
    entityId: args.entityId,
    bankAccountId: bankAccount.id,
    ledgerAccountId: bankAccount.ledgerAccountId,
    statementDate: args.statementDate,
    beginningBalance: beginning.toFixed(2),
    statementEndingBalance: args.statementEndingBalance.toFixed(2),
    clearedBalance: beginning.toFixed(2),
    difference: roundMoney(args.statementEndingBalance - beginning).toFixed(2),
    status: 'in_progress',
    clearedLineIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.bankReconciliations).values(row);
  return row as RecRow;
}

export interface ReconciliationView {
  id: string;
  bankAccountId: string;
  bankAccountName: string | null;
  ledgerAccountId: string;
  ledger: { code: string; name: string; type: string };
  /** `bank` or `credit_card`: a card's balance is what is owed and its signs flip. */
  accountKind: 'bank' | 'credit_card';
  status: string;
  statementDate: string;
  beginningBalance: string;
  statementEndingBalance: string;
  clearedBalance: string;
  difference: string;
  clearedLineIds: string[];
  /** Debit lines: deposits and credits on a bank account, payments to a card. */
  inflows: LineView[];
  /** Credit lines: checks and payments on a bank account, charges on a card. */
  outflows: LineView[];
  totals: {
    inflows: { count: number; total: number; clearedCount: number; clearedTotal: number };
    outflows: { count: number; total: number; clearedCount: number; clearedTotal: number };
  };
  /** Pairs of an entry and its reversal that net to zero and are cleared automatically. */
  nettedLineCount: number;
  adjustmentJournalEntryId: string | null;
  completedAt: Date | null;
  completedBy: string | null;
  undoneAt: Date | null;
  undoneBy: string | null;
}

function sumOf(lines: LineView[]): number {
  return roundMoney(lines.reduce((t, l) => t + l.amount, 0));
}

/** The reconciliation screen: open lines up to the statement date, what is ticked, cleared balance and difference. */
export async function getReconciliationView(db: Database, rec: RecRow): Promise<ReconciliationView> {
  const ledger = await loadLedger(db, rec.entityId, rec.ledgerAccountId);
  const liability = ledger.type === 'liability';
  const [bankAccount] = await db
    .select({ name: schema.bankAccounts.name })
    .from(schema.bankAccounts)
    .where(eq(schema.bankAccounts.id, rec.bankAccountId))
    .limit(1);

  const inProgress = rec.status === 'in_progress';
  const rawLines = rec.status === 'completed' ? await loadClearedLines(db, rec) : inProgress ? await loadOpenLines(db, rec) : [];
  const { open, netted } = inProgress ? splitNettedPairs(rawLines) : { open: rawLines, netted: [] };
  const documents = await loadDocuments(db, open);

  const savedIds = new Set(rec.clearedLineIds ?? []);
  const isTicked = (line: LedgerLine) => (rec.status === 'completed' ? true : savedIds.has(line.id));
  const ticked = open.filter(isTicked);
  const balances = computeBalances(rec, ticked, liability);

  const views = open.map((line) => toView(line, documents, isTicked(line)));
  const inflows = views.filter((_, i) => isInflow(open[i]));
  const outflows = views.filter((_, i) => !isInflow(open[i]));
  const part = (list: LineView[]) => ({
    count: list.length,
    total: sumOf(list),
    clearedCount: list.filter((l) => l.cleared).length,
    clearedTotal: sumOf(list.filter((l) => l.cleared)),
  });

  const completed = rec.status === 'completed';
  return {
    id: rec.id,
    bankAccountId: rec.bankAccountId,
    bankAccountName: bankAccount?.name ?? null,
    ledgerAccountId: rec.ledgerAccountId,
    ledger: { code: ledger.code, name: ledger.name, type: ledger.type },
    accountKind: liability ? 'credit_card' : 'bank',
    status: rec.status,
    statementDate: rec.statementDate,
    beginningBalance: Number(rec.beginningBalance).toFixed(2),
    statementEndingBalance: Number(rec.statementEndingBalance).toFixed(2),
    clearedBalance: (completed ? Number(rec.clearedBalance ?? 0) : balances.clearedBalance).toFixed(2),
    difference: (completed ? Number(rec.difference ?? 0) : balances.difference).toFixed(2),
    clearedLineIds: ticked.map((l) => l.id),
    inflows,
    outflows,
    totals: { inflows: part(inflows), outflows: part(outflows) },
    nettedLineCount: netted.length,
    adjustmentJournalEntryId: rec.adjustmentJournalEntryId,
    completedAt: rec.completedAt,
    completedBy: rec.completedBy,
    undoneAt: rec.undoneAt,
    undoneBy: rec.undoneBy,
  };
}

/** Save the ticked lines (and a corrected statement date or balance) of an open reconciliation. */
export async function saveProgress(
  db: Database,
  rec: RecRow,
  patch: { clearedLineIds?: string[]; statementDate?: string; statementEndingBalance?: number },
): Promise<RecRow> {
  if (rec.status !== 'in_progress') throw new PostingError('Only a reconciliation in progress can be changed');

  const [last] = await db
    .select({ statementDate: schema.bankReconciliations.statementDate })
    .from(schema.bankReconciliations)
    .where(and(eq(schema.bankReconciliations.bankAccountId, rec.bankAccountId), eq(schema.bankReconciliations.status, 'completed')))
    .orderBy(desc(schema.bankReconciliations.statementDate))
    .limit(1);
  if (patch.statementDate && last && patch.statementDate <= last.statementDate) {
    throw new PostingError(`The statement date must be after the last reconciled statement (${last.statementDate}).`);
  }

  const next = {
    ...rec,
    statementDate: patch.statementDate ?? rec.statementDate,
    statementEndingBalance: patch.statementEndingBalance === undefined ? rec.statementEndingBalance : patch.statementEndingBalance.toFixed(2),
    clearedLineIds: patch.clearedLineIds ?? rec.clearedLineIds ?? [],
  };
  const { open } = splitNettedPairs(await loadOpenLines(db, next));
  const available = new Map(open.map((l) => [l.id, l]));
  const unknown = next.clearedLineIds.filter((id) => !available.has(id));
  if (unknown.length > 0) {
    throw new PostingError(`Line ${unknown[0]} is not open on or before ${next.statementDate} (already cleared, not on this account, or dated later)`);
  }

  const ledger = await loadLedger(db, rec.entityId, rec.ledgerAccountId);
  const ticked = [...new Set(next.clearedLineIds)].map((id) => available.get(id)!);
  const balances = computeBalances(next, ticked, ledger.type === 'liability');
  const update = {
    statementDate: next.statementDate,
    statementEndingBalance: next.statementEndingBalance,
    clearedLineIds: [...new Set(next.clearedLineIds)],
    clearedBalance: balances.clearedBalance.toFixed(2),
    difference: balances.difference.toFixed(2),
    updatedAt: new Date(),
  };
  await db.update(schema.bankReconciliations).set(update).where(eq(schema.bankReconciliations.id, rec.id));
  return { ...rec, ...update };
}

// ── Completing ──────────────────────────────────────────────────────────────

export interface CompleteArgs {
  /** Final ticks; defaults to the ones saved with PATCH. */
  clearedLineIds?: string[];
  /** Post the remaining difference to this account (bank charges, interest, a rounding account). */
  adjustment?: { accountId: string; memo?: string };
  userId: string | null;
}

interface LineSnapshot {
  id: string;
  date: string;
  entryNumber: string | null;
  description: string | null;
  amount: number;
  contactName: string | null;
  checkNumber: string | null;
  documentType: string | null;
  documentNumber: string | null;
}

function snapshot(line: LedgerLine, documents: Map<string, LineDocument>): LineSnapshot {
  const view = toView(line, documents, false);
  return {
    id: line.id,
    date: line.date,
    entryNumber: line.entryNumber,
    description: line.description,
    amount: view.amount,
    contactName: line.contactName,
    checkNumber: view.document?.checkNumber ?? null,
    documentType: view.document?.type ?? null,
    documentNumber: view.document?.number ?? null,
  };
}

const group = (lines: LedgerLine[], documents: Map<string, LineDocument>) => ({
  ...total(lines),
  items: lines.map((l) => snapshot(l, documents)),
});

/** Statement reconciliation report, as stored when a reconciliation completes (and shown live while it is open). */
export async function buildReport(
  db: Database,
  rec: RecRow,
  args: {
    ledger: AccountRow;
    bankAccountName: string | null;
    ticked: LedgerLine[];
    uncleared: LedgerLine[];
    adjustment?: { journalEntryId: string | null; amount: number; accountId: string; accountName: string | null; memo: string | null } | null;
  },
): Promise<Record<string, unknown>> {
  const liability = args.ledger.type === 'liability';
  const later = splitNettedPairs(await loadLaterLines(db, rec)).open;
  const documents = await loadDocuments(db, [...args.ticked, ...args.uncleared, ...later]);
  const balances = computeBalances(rec, args.ticked, liability);
  const sign = liability ? -1 : 1;

  const unclearedIn = args.uncleared.filter(isInflow);
  const unclearedOut = args.uncleared.filter((l) => !isInflow(l));
  const laterIn = later.filter(isInflow);
  const laterOut = later.filter((l) => !isInflow(l));
  const registerAsOfStatement = roundMoney(
    balances.clearedBalance + sign * (total(unclearedIn).total - total(unclearedOut).total),
  );
  const registerNow = roundMoney(registerAsOfStatement + sign * (total(laterIn).total - total(laterOut).total));

  return {
    version: 1,
    bankAccountId: rec.bankAccountId,
    bankAccountName: args.bankAccountName,
    ledgerAccount: { id: args.ledger.id, code: args.ledger.code, name: args.ledger.name },
    accountKind: liability ? 'credit_card' : 'bank',
    statementDate: rec.statementDate,
    summary: {
      beginningBalance: balances.beginningBalance,
      clearedInflows: balances.clearedInflows,
      clearedOutflows: balances.clearedOutflows,
      clearedBalance: balances.clearedBalance,
      statementEndingBalance: balances.statementEndingBalance,
      difference: balances.difference,
      unclearedInflows: total(unclearedIn),
      unclearedOutflows: total(unclearedOut),
      registerBalanceAtStatementDate: registerAsOfStatement,
      unclearedAfterStatementInflows: total(laterIn),
      unclearedAfterStatementOutflows: total(laterOut),
      registerBalanceToday: registerNow,
    },
    clearedInflows: group(args.ticked.filter(isInflow), documents),
    clearedOutflows: group(args.ticked.filter((l) => !isInflow(l)), documents),
    unclearedInflows: group(unclearedIn, documents),
    unclearedOutflows: group(unclearedOut, documents),
    unclearedAfterStatementInflows: group(laterIn, documents),
    unclearedAfterStatementOutflows: group(laterOut, documents),
    adjustment: args.adjustment ?? null,
  };
}

/** The report of a reconciliation: the stored snapshot once completed, a live preview while open. */
export async function getReport(db: Database, rec: RecRow): Promise<Record<string, unknown>> {
  if (rec.report && Object.keys(rec.report).length > 0) return { status: rec.status, ...rec.report };
  if (rec.status !== 'in_progress') throw new PostingError('This reconciliation has no report');
  const ledger = await loadLedger(db, rec.entityId, rec.ledgerAccountId);
  const { open } = splitNettedPairs(await loadOpenLines(db, rec));
  const savedIds = new Set(rec.clearedLineIds ?? []);
  const [bankAccount] = await db
    .select({ name: schema.bankAccounts.name })
    .from(schema.bankAccounts)
    .where(eq(schema.bankAccounts.id, rec.bankAccountId))
    .limit(1);
  const report = await buildReport(db, rec, {
    ledger,
    bankAccountName: bankAccount?.name ?? null,
    ticked: open.filter((l) => savedIds.has(l.id)),
    uncleared: open.filter((l) => !savedIds.has(l.id)),
  });
  return { status: rec.status, preview: true, ...report };
}

export async function completeReconciliation(
  db: Database,
  rec: RecRow,
  args: CompleteArgs,
): Promise<{ reconciliation: RecRow; adjustmentJournalEntryId: string | null }> {
  if (rec.status !== 'in_progress') throw new PostingError('Only a reconciliation in progress can be completed');

  const ledger = await loadLedger(db, rec.entityId, rec.ledgerAccountId);
  const liability = ledger.type === 'liability';
  const { open, netted } = splitNettedPairs(await loadOpenLines(db, rec));
  const available = new Map(open.map((l) => [l.id, l]));
  const tickedIds = [...new Set(args.clearedLineIds ?? rec.clearedLineIds ?? [])];
  const unknown = tickedIds.filter((id) => !available.has(id));
  if (unknown.length > 0) {
    throw new PostingError(`Line ${unknown[0]} is not open on or before ${rec.statementDate} (already cleared, not on this account, or dated later)`);
  }
  const ticked = tickedIds.map((id) => available.get(id)!);
  const balances = computeBalances(rec, ticked, liability);
  const uncleared = open.filter((l) => !tickedIds.includes(l.id));

  const [bankAccount] = await db
    .select({ name: schema.bankAccounts.name })
    .from(schema.bankAccounts)
    .where(eq(schema.bankAccounts.id, rec.bankAccountId))
    .limit(1);

  const differs = Math.abs(balances.difference) >= EPSILON;
  if (differs && !args.adjustment) {
    throw new PostingError(
      `The difference is ${balances.difference.toFixed(2)}. It must be 0.00 to finish: tick the lines that cleared, or post the difference to an account.`,
    );
  }

  const now = new Date();
  const stamp = { reconciliationId: rec.id, reconciled: true, updatedAt: now };
  const stampIds = [...tickedIds, ...netted.map((l) => l.id)];
  const bankAccountName = bankAccount?.name ?? null;

  /** Stamp the cleared lines and close the reconciliation; `adjustmentEntryId` clears the adjustment's bank line too. */
  const finish = (h: Database, report: Record<string, unknown>, adjustmentEntryId: string | null): unknown[] => [
    ...(stampIds.length > 0 ? [h.update(schema.journalLines).set(stamp).where(inArray(schema.journalLines.id, stampIds))] : []),
    ...(adjustmentEntryId
      ? [
          h
            .update(schema.journalLines)
            .set(stamp)
            .where(and(eq(schema.journalLines.journalEntryId, adjustmentEntryId), eq(schema.journalLines.accountId, ledger.id))),
        ]
      : []),
    h
      .update(schema.bankReconciliations)
      .set({
        status: 'completed',
        clearedLineIds: tickedIds,
        clearedBalance: roundMoney(balances.clearedBalance + (adjustmentEntryId ? balances.difference : 0)).toFixed(2),
        difference: '0.00',
        adjustmentJournalEntryId: adjustmentEntryId,
        report,
        completedAt: now,
        completedBy: args.userId,
        updatedAt: now,
      })
      .where(and(eq(schema.bankReconciliations.id, rec.id), eq(schema.bankReconciliations.status, 'in_progress'))),
  ];

  if (!differs) {
    const report = await buildReport(db, rec, { ledger, bankAccountName, ticked, uncleared });
    await atomically(db, (h) => finish(h, report, null));
    return { reconciliation: await reload(db, rec.id), adjustmentJournalEntryId: null };
  }

  // Post the difference to the chosen account, clear it with this reconciliation, and finish: one batch.
  const accounts = await loadEntityAccounts(db, rec.entityId);
  const adjustmentAccount = accounts.byId(args.adjustment!.accountId);
  if (!adjustmentAccount) throw new PostingError('The adjustment account does not belong to this accounting entity');
  if (adjustmentAccount.id === ledger.id) throw new PostingError('Post the adjustment to another account than the bank account itself');

  const amount = Math.abs(balances.difference);
  // The bank's cleared balance goes up with a debit; a card's owed balance goes up with a credit.
  const raisesLedgerDebit = (balances.difference > 0) !== liability;
  const memo = args.adjustment!.memo?.trim() || null;
  const description = `Reconciliation adjustment${memo ? ` — ${memo}` : ''} (statement ${rec.statementDate})`;
  const adjustment = {
    journalEntryId: null as string | null,
    amount,
    difference: balances.difference,
    accountId: adjustmentAccount.id,
    accountName: adjustmentAccount.name,
    memo,
  };
  // The report names the adjustment's entry, which only exists once it is posted: fill the id in inside the batch.
  const baseReport = await buildReport(db, rec, { ledger, bankAccountName, ticked, uncleared, adjustment });
  const withEntry = (entryId: string) => ({ ...baseReport, adjustment: { ...adjustment, journalEntryId: entryId } });

  const posted = await postJournalEntry(db, {
    entityId: rec.entityId,
    date: new Date(`${rec.statementDate}T00:00:00Z`),
    description,
    sourceType: 'bank_reconciliation',
    sourceId: rec.id,
    postingKey: `bank_reconciliation:${rec.id}:adjustment`,
    lockKind: 'general',
    createdBy: args.userId,
    lines: [
      { accountId: ledger.id, ...(raisesLedgerDebit ? { debit: amount } : { credit: amount }), description },
      { accountId: adjustmentAccount.id, ...(raisesLedgerDebit ? { credit: amount } : { debit: amount }), description },
    ],
    alsoWrite: (h, entry) => finish(h, withEntry(entry.journalEntryId), entry.journalEntryId),
  });
  // A retry finds the adjustment already posted and runs no batch: finish the reconciliation on its own.
  if (posted.alreadyPosted && posted.journalEntryId) {
    const entryId = posted.journalEntryId;
    await atomically(db, (h) => finish(h, withEntry(entryId), entryId));
  }

  return { reconciliation: await reload(db, rec.id), adjustmentJournalEntryId: posted.journalEntryId };
}

async function reload(db: Database, id: string): Promise<RecRow> {
  const [row] = await db.select().from(schema.bankReconciliations).where(eq(schema.bankReconciliations.id, id)).limit(1);
  return row;
}

// ── Undo and discard ────────────────────────────────────────────────────────

/** Undo the latest completed reconciliation of an account: clear the stamps, reverse the adjustment. */
export async function undoReconciliation(db: Database, rec: RecRow, args: { userId: string | null }): Promise<RecRow> {
  if (rec.status !== 'completed') throw new PostingError('Only a completed reconciliation can be undone');

  const [later] = await db
    .select({ statementDate: schema.bankReconciliations.statementDate })
    .from(schema.bankReconciliations)
    .where(
      and(
        eq(schema.bankReconciliations.bankAccountId, rec.bankAccountId),
        eq(schema.bankReconciliations.status, 'completed'),
        ne(schema.bankReconciliations.id, rec.id),
        or(
          gt(schema.bankReconciliations.statementDate, rec.statementDate),
          and(
            eq(schema.bankReconciliations.statementDate, rec.statementDate),
            gt(schema.bankReconciliations.completedAt, rec.completedAt ?? new Date(0)),
          ),
        ),
      ),
    )
    .limit(1);
  if (later) {
    throw new PostingError(`Undo the latest reconciliation first (statement of ${later.statementDate}). Only the most recent one can be undone.`);
  }

  const now = new Date();
  const release = (h: Database): unknown[] => [
    h
      .update(schema.journalLines)
      .set({ reconciliationId: null, reconciled: false, updatedAt: now })
      .where(eq(schema.journalLines.reconciliationId, rec.id)),
    h
      .update(schema.bankReconciliations)
      .set({ status: 'undone', undoneAt: now, undoneBy: args.userId, updatedAt: now })
      .where(and(eq(schema.bankReconciliations.id, rec.id), eq(schema.bankReconciliations.status, 'completed'))),
  ];

  if (rec.adjustmentJournalEntryId) {
    await reverseJournalEntry(db, {
      entryId: rec.adjustmentJournalEntryId,
      date: now,
      createdBy: args.userId,
      description: `Undo reconciliation adjustment (statement ${rec.statementDate})`,
      alsoWrite: (h) => release(h),
    });
  } else {
    await atomically(db, release);
  }
  return reload(db, rec.id);
}

/** Throw away a reconciliation that is still in progress; nothing was posted or stamped. */
export async function discardReconciliation(db: Database, rec: RecRow): Promise<void> {
  if (rec.status !== 'in_progress') throw new PostingError('Only a reconciliation in progress can be discarded');
  await db
    .delete(schema.bankReconciliations)
    .where(and(eq(schema.bankReconciliations.id, rec.id), eq(schema.bankReconciliations.status, 'in_progress')));
}
