/**
 * The ledger every financial report reads, on accrual or cash basis.
 *
 * The journal itself is always accrual. Cash basis is computed at report time
 * from payments, the way QuickBooks does it (docs/plans/weldbooks-us.md §10):
 *
 *   - invoices, credit notes, bills and write-offs are not income or expense
 *     when they are issued; their receivable / payable lines drop out;
 *   - a payment recognises its allocations: every non-receivable line of the
 *     document (revenue, expense, sales tax, ...) is booked on the payment
 *     date, pro rata to the part of the document the payment covers (a partial
 *     payment is spread over the lines in proportion to their amounts, which
 *     puts the tax share of it on sales tax);
 *   - the part of a payment that is not allocated lands in "Unapplied cash
 *     payment income" (received) or "Unapplied cash bill payment expense"
 *     (sent), virtual lines when the chart has no such account;
 *   - manual entries, bank categorizations, FX differences and everything else
 *     that is not a document count on their own date. Receivable and payable
 *     accounts carry no balance.
 *
 * Voided payments are treated as if they never happened.
 */

import { and, asc, eq, gte, inArray, isNull, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { toBaseCurrency } from './accounting-currency';
import { accountForRole, BOOKED_STATUSES, roundMoney, type EntityAccounts } from './accounting-posting';

export type ReportBasis = 'accrual' | 'cash';

/** Journal source types of documents: income and expense are recognised at payment on cash basis. */
const DOCUMENT_SOURCE_TYPES = ['invoice', 'credit_note', 'bill', 'bill_credit_note'] as const;
type DocumentSourceType = (typeof DOCUMENT_SOURCE_TYPES)[number];
/** Source types left out of the cash ledger as entries: documents, and write-offs of unpaid receivables. */
const CASH_EXCLUDED_SOURCE_TYPES: string[] = [...DOCUMENT_SOURCE_TYPES, 'write_off'];
const PAYMENT_SOURCE_TYPES = ['payment', 'payment_fx_adjustment'];

export const UNAPPLIED_INCOME_ACCOUNT_ID = 'virtual:unapplied_cash_payment_income';
export const UNAPPLIED_EXPENSE_ACCOUNT_ID = 'virtual:unapplied_cash_bill_payment_expense';

export class ReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportInputError';
  }
}

export interface LedgerAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  normalSide: 'debit' | 'credit';
  isActive: boolean;
  taxLine: string | null;
  form1099Box: string | null;
  /** Not a chart account: the cash-basis unapplied-payment line of a chart without the system role. */
  virtual: boolean;
}

export interface LedgerRange {
  /** Inclusive; null/undefined = from the beginning of the books. */
  from?: Date | null;
  /** Inclusive. */
  to: Date;
}

export interface AggregateRow {
  accountId: string;
  contactId: string | null;
  debit: number;
  credit: number;
}

export interface LedgerLine {
  id: string;
  journalEntryId: string | null;
  entryNumber: string | null;
  entryDate: Date;
  entryStatus: string;
  description: string | null;
  debit: number;
  credit: number;
  contactId: string | null;
  sourceType: string | null;
  /** Cash basis: the payment that recognised this line (the document is `journalEntryId`). */
  paymentId?: string | null;
}

export interface LedgerFilters {
  classId?: string | null;
  locationId?: string | null;
}

interface CashEvent {
  date: Date;
  accountId: string;
  /** Debit minus credit, in the entity's base currency. */
  amount: number;
  contactId: string | null;
  classId: string | null;
  locationId: string | null;
  journalEntryId: string | null;
  entryNumber: string | null;
  paymentId: string;
  description: string;
  sourceType: string;
}

export interface Ledger {
  readonly basis: ReportBasis;
  readonly entityId: string;
  readonly accounts: Map<string, LedgerAccount>;
  /** Debit and credit totals per account (and per contact when `byContact`) over a range. */
  aggregate(
    range: LedgerRange,
    opts?: { accountTypes?: string[]; accountIds?: string[]; byContact?: boolean },
  ): Promise<AggregateRow[]>;
  /** Every line of one account in a range, oldest first. */
  accountLines(accountId: string, range: LedgerRange): Promise<LedgerLine[]>;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A request date: `YYYY-MM-DD` is a whole day (UTC), anything else an instant. */
export function parseReportDate(value: string, edge: 'start' | 'end'): Date {
  const date = DATE_ONLY.test(value)
    ? new Date(`${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ReportInputError(`Invalid date '${value}'`);
  return date;
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Basis
// ---------------------------------------------------------------------------

export function parseBasis(value: string | undefined | null): ReportBasis | null {
  if (!value) return null;
  if (value === 'accrual' || value === 'cash') return value;
  throw new ReportInputError("basis must be 'accrual' or 'cash'");
}

/** Requested basis, else the entity's accounting method, else the workspace setting, else accrual. */
export async function resolveBasis(
  db: Database,
  entity: { accountingMethod: string | null },
  requested: ReportBasis | null,
): Promise<ReportBasis> {
  if (requested) return requested;
  if (entity.accountingMethod === 'cash' || entity.accountingMethod === 'accrual') return entity.accountingMethod;
  const [settings] = await db
    .select({ accountingMethod: schema.settings.accountingMethod })
    .from(schema.settings)
    .where(isNull(schema.settings.deletedAt))
    .limit(1);
  return settings?.accountingMethod === 'cash' ? 'cash' : 'accrual';
}

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------

function toLedgerAccount(row: typeof schema.accounts.$inferSelect): LedgerAccount {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    subtype: row.subtype,
    normalSide: row.normalSide === 'credit' ? 'credit' : 'debit',
    isActive: row.isActive !== false,
    taxLine: row.taxLine,
    form1099Box: row.form1099Box,
    virtual: false,
  };
}

/** The receivable and payable control accounts the posting service books documents against. */
function controlAccountIds(accounts: EntityAccounts): string[] {
  const ids = [
    accountForRole(accounts, 'accounts_receivable', ['1300'])?.id,
    accountForRole(accounts, 'accounts_payable', ['1600'])?.id,
  ];
  return ids.filter((id): id is string => Boolean(id));
}

/** The role and code lookups the posting service uses, over rows already loaded. */
function chartLookup(rows: Array<typeof schema.accounts.$inferSelect>): EntityAccounts {
  return {
    byId: (id) => (id ? rows.find((a) => a.id === id) : undefined),
    byRole: (role) => rows.find((a) => (a.metadata as { systemRole?: string } | null)?.systemRole === role),
    byCode: (code) => rows.find((a) => a.code === code),
    bySubtype: (subtype) => rows.find((a) => a.subtype === subtype),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const isMoneyZero = (value: number) => Math.abs(value) < 0.005;

// ---------------------------------------------------------------------------
// Cash recognition
// ---------------------------------------------------------------------------

interface PaymentRow {
  id: string;
  type: string;
  amount: string;
  currency: string | null;
  exchangeRate: string | null;
  date: Date;
  contactId: string;
  reference: string | null;
  invoiceId: string | null;
  billId: string | null;
}

interface AllocationRow {
  paymentId: string;
  invoiceId: string | null;
  billId: string | null;
  amount: number;
}

interface DocumentRow {
  id: string;
  total: number;
  number: string | null;
}

interface DocumentLineGroup {
  accountId: string;
  contactId: string | null;
  classId: string | null;
  locationId: string | null;
  /** Debit minus credit of the accrual entry. */
  net: number;
}

interface DocumentEntry {
  journalEntryId: string;
  entryNumber: string | null;
  sourceType: DocumentSourceType;
  groups: DocumentLineGroup[];
}

function baseConverter(baseCurrency: string, currency: string | null, exchangeRate: string | null) {
  const rate = Number.parseFloat(exchangeRate ?? '1');
  const sameCurrency = !currency || currency === baseCurrency;
  return (amount: number) =>
    sameCurrency || !Number.isFinite(rate) || rate === 0 ? roundMoney(amount) : toBaseCurrency(amount, rate);
}

async function loadCashEvents(
  db: Database,
  entity: { id: string; baseCurrency: string },
  upTo: Date,
  controlIds: Set<string>,
  unappliedIncomeId: string,
  unappliedExpenseId: string,
): Promise<CashEvent[]> {
  const { payments, paymentAllocations, invoices, bills, journalEntries, journalLines } = schema;

  const paymentRows: PaymentRow[] = await db
    .select({
      id: payments.id,
      type: payments.type,
      amount: payments.amount,
      currency: payments.currency,
      exchangeRate: payments.exchangeRate,
      date: payments.date,
      contactId: payments.contactId,
      reference: payments.reference,
      invoiceId: payments.invoiceId,
      billId: payments.billId,
    })
    .from(payments)
    .where(and(eq(payments.entityId, entity.id), isNull(payments.deletedAt), lte(payments.date, upTo)));
  if (paymentRows.length === 0) return [];

  const allocationRows = await db
    .select({
      paymentId: paymentAllocations.paymentId,
      invoiceId: paymentAllocations.invoiceId,
      billId: paymentAllocations.billId,
      amount: paymentAllocations.amount,
    })
    .from(paymentAllocations)
    .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
    .where(
      and(
        eq(payments.entityId, entity.id),
        isNull(payments.deletedAt),
        isNull(paymentAllocations.deletedAt),
        lte(payments.date, upTo),
      ),
    );

  const allocationsByPayment = new Map<string, AllocationRow[]>();
  for (const a of allocationRows) {
    const list = allocationsByPayment.get(a.paymentId) ?? [];
    list.push({ paymentId: a.paymentId, invoiceId: a.invoiceId, billId: a.billId, amount: Number.parseFloat(a.amount) });
    allocationsByPayment.set(a.paymentId, list);
  }
  // Payments recorded before allocations existed settle one document with their full amount.
  for (const p of paymentRows) {
    if (allocationsByPayment.has(p.id)) continue;
    if (p.invoiceId || p.billId) {
      allocationsByPayment.set(p.id, [
        { paymentId: p.id, invoiceId: p.invoiceId, billId: p.billId, amount: Number.parseFloat(p.amount) },
      ]);
    }
  }

  const invoiceIds = new Set<string>();
  const billIds = new Set<string>();
  for (const list of allocationsByPayment.values()) {
    for (const a of list) {
      if (a.invoiceId) invoiceIds.add(a.invoiceId);
      if (a.billId) billIds.add(a.billId);
    }
  }

  const documents = new Map<string, DocumentRow>();
  for (const ids of chunk([...invoiceIds], 400)) {
    const rows = await db
      .select({ id: invoices.id, total: invoices.total, number: invoices.invoiceNumber })
      .from(invoices)
      .where(and(eq(invoices.entityId, entity.id), inArray(invoices.id, ids)));
    for (const r of rows) documents.set(r.id, { id: r.id, total: Number.parseFloat(r.total ?? '0'), number: r.number });
  }
  for (const ids of chunk([...billIds], 400)) {
    const rows = await db
      .select({ id: bills.id, total: bills.total, number: bills.billNumber })
      .from(bills)
      .where(and(eq(bills.entityId, entity.id), inArray(bills.id, ids)));
    for (const r of rows) documents.set(r.id, { id: r.id, total: Number.parseFloat(r.total ?? '0'), number: r.number });
  }

  // The accrual entry of every document that has a payment.
  const documentEntries = new Map<string, DocumentEntry>();
  for (const ids of chunk([...documents.keys()], 400)) {
    const rows = await db
      .select({
        sourceId: journalEntries.sourceId,
        sourceType: journalEntries.sourceType,
        journalEntryId: journalEntries.id,
        entryNumber: journalEntries.entryNumber,
        accountId: journalLines.accountId,
        contactId: journalLines.contactId,
        classId: journalLines.classId,
        locationId: journalLines.locationId,
        net: sql<string>`coalesce(sum(${journalLines.debit}::numeric - ${journalLines.credit}::numeric), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.entityId, entity.id),
          isNull(journalEntries.deletedAt),
          isNull(journalEntries.reversalOfId),
          inArray(journalEntries.status, BOOKED_STATUSES),
          inArray(journalEntries.sourceType, [...DOCUMENT_SOURCE_TYPES]),
          inArray(journalEntries.sourceId, ids),
          isNull(journalLines.deletedAt),
        ),
      )
      .groupBy(
        journalEntries.sourceId,
        journalEntries.sourceType,
        journalEntries.id,
        journalEntries.entryNumber,
        journalLines.accountId,
        journalLines.contactId,
        journalLines.classId,
        journalLines.locationId,
      );
    for (const r of rows) {
      if (!r.sourceId || controlIds.has(r.accountId)) continue;
      const entry =
        documentEntries.get(r.sourceId) ??
        { journalEntryId: r.journalEntryId, entryNumber: r.entryNumber, sourceType: r.sourceType as DocumentSourceType, groups: [] };
      entry.groups.push({
        accountId: r.accountId,
        contactId: r.contactId,
        classId: r.classId,
        locationId: r.locationId,
        net: roundMoney(Number.parseFloat(r.net)),
      });
      documentEntries.set(r.sourceId, entry);
    }
  }

  const paymentById = new Map(paymentRows.map((p) => [p.id, p]));
  const events: CashEvent[] = [];

  // Allocations per document, oldest payment first, so cumulative rounding is stable.
  const allocationsByDocument = new Map<string, AllocationRow[]>();
  for (const list of allocationsByPayment.values()) {
    for (const a of list) {
      const documentId = a.invoiceId ?? a.billId;
      if (!documentId) continue;
      const bucket = allocationsByDocument.get(documentId) ?? [];
      bucket.push(a);
      allocationsByDocument.set(documentId, bucket);
    }
  }

  for (const [documentId, list] of allocationsByDocument) {
    const document = documents.get(documentId);
    const entry = documentEntries.get(documentId);
    if (!document || !entry || !(document.total > 0) || entry.groups.length === 0) continue;

    const sorted = [...list].sort((a, b) => {
      const pa = paymentById.get(a.paymentId)!;
      const pb = paymentById.get(b.paymentId)!;
      return pa.date.getTime() - pb.date.getTime() || pa.id.localeCompare(pb.id);
    });

    const sum = roundMoney(entry.groups.reduce((total, g) => total + g.net, 0));
    // The group that absorbs rounding, so the lines always add up to the share of the whole.
    const largest = entry.groups.reduce((best, g, i) => (Math.abs(g.net) > Math.abs(entry.groups[best].net) ? i : best), 0);
    let paid = 0;
    let previous = entry.groups.map(() => 0);

    for (const allocation of sorted) {
      const payment = paymentById.get(allocation.paymentId)!;
      paid = Math.min(document.total, roundMoney(paid + allocation.amount));
      const share = paid / document.total;
      const recognised = entry.groups.map((g) => roundMoney(g.net * share));
      recognised[largest] = roundMoney(recognised[largest] + roundMoney(sum * share) - recognised.reduce((t, v) => t + v, 0));

      entry.groups.forEach((group, i) => {
        const delta = roundMoney(recognised[i] - previous[i]);
        if (isMoneyZero(delta)) return;
        events.push({
          date: payment.date,
          accountId: group.accountId,
          amount: delta,
          contactId: group.contactId,
          classId: group.classId,
          locationId: group.locationId,
          journalEntryId: entry.journalEntryId,
          entryNumber: entry.entryNumber,
          paymentId: payment.id,
          description: `${document.number ?? documentId} paid${payment.reference ? ` (${payment.reference})` : ''}`,
          sourceType: entry.sourceType,
        });
      });
      previous = recognised;
    }
  }

  // The part of a payment no document claims.
  for (const payment of paymentRows) {
    const allocations = allocationsByPayment.get(payment.id) ?? [];
    const allocated = allocations.reduce((total, a) => total + a.amount, 0);
    const unapplied = roundMoney(Number.parseFloat(payment.amount) - allocated);
    if (unapplied <= 0.004) continue;
    const toBase = baseConverter(entity.baseCurrency, payment.currency, payment.exchangeRate);
    const baseTotal = toBase(Number.parseFloat(payment.amount));
    const baseAllocated = allocations.reduce((total, a) => roundMoney(total + toBase(a.amount)), 0);
    const base = roundMoney(baseTotal - baseAllocated);
    if (isMoneyZero(base)) continue;
    const received = payment.type === 'received';
    events.push({
      date: payment.date,
      accountId: received ? unappliedIncomeId : unappliedExpenseId,
      amount: received ? -base : base,
      contactId: payment.contactId,
      classId: null,
      locationId: null,
      journalEntryId: null,
      entryNumber: null,
      paymentId: payment.id,
      description: `Unapplied ${received ? 'payment received' : 'payment sent'}${payment.reference ? ` ${payment.reference}` : ''}`,
      sourceType: 'unapplied_payment',
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export async function createLedger(
  db: Database,
  args: {
    entityId: string;
    basis: ReportBasis;
    filters?: LedgerFilters;
    /** The latest date any range will reach; cash recognition is computed up to here. */
    upTo: Date;
  },
): Promise<Ledger> {
  const { entityId, basis } = args;
  const filters = args.filters ?? {};
  const { journalLines: jl, journalEntries: je, accounts: accountsTable, payments } = schema;

  const accountRows = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.entityId, entityId), isNull(accountsTable.deletedAt)));
  const accounts = new Map<string, LedgerAccount>(accountRows.map((r) => [r.id, toLedgerAccount(r)]));
  const chart = chartLookup(accountRows);

  const unappliedIncome = accountForRole(chart, 'unapplied_cash_payment_income');
  const unappliedExpense = accountForRole(chart, 'unapplied_cash_bill_payment_expense');
  const unappliedIncomeId = unappliedIncome?.id ?? UNAPPLIED_INCOME_ACCOUNT_ID;
  const unappliedExpenseId = unappliedExpense?.id ?? UNAPPLIED_EXPENSE_ACCOUNT_ID;

  const controlIds = new Set(controlAccountIds(chart));
  let events: CashEvent[] = [];

  if (basis === 'cash') {
    const [entity] = await db
      .select({ id: schema.entities.id, baseCurrency: schema.entities.baseCurrency })
      .from(schema.entities)
      .where(eq(schema.entities.id, entityId))
      .limit(1);
    events = await loadCashEvents(db, entity ?? { id: entityId, baseCurrency: 'USD' }, args.upTo, controlIds, unappliedIncomeId, unappliedExpenseId);
    if (!unappliedIncome) {
      accounts.set(UNAPPLIED_INCOME_ACCOUNT_ID, {
        id: UNAPPLIED_INCOME_ACCOUNT_ID,
        code: '',
        name: 'Unapplied cash payment income',
        type: 'revenue',
        subtype: 'other_income',
        normalSide: 'credit',
        isActive: true,
        taxLine: null,
        form1099Box: null,
        virtual: true,
      });
    }
    if (!unappliedExpense) {
      accounts.set(UNAPPLIED_EXPENSE_ACCOUNT_ID, {
        id: UNAPPLIED_EXPENSE_ACCOUNT_ID,
        code: '',
        name: 'Unapplied cash bill payment expense',
        type: 'expense',
        subtype: 'other_expense',
        normalSide: 'debit',
        isActive: true,
        taxLine: null,
        form1099Box: null,
        virtual: true,
      });
    }
  }

  /** Entry and line conditions shared by every journal query of this ledger. */
  function lineConditions(range: LedgerRange): SQL[] {
    const conditions: SQL[] = [
      eq(jl.entityId, entityId),
      isNull(jl.deletedAt),
      isNull(je.deletedAt),
      inArray(je.status, BOOKED_STATUSES),
      lte(je.date, range.to),
    ];
    if (range.from) conditions.push(gte(je.date, range.from));
    if (filters.classId) conditions.push(eq(jl.classId, filters.classId));
    if (filters.locationId) conditions.push(eq(jl.locationId, filters.locationId));
    if (basis === 'cash') {
      conditions.push(or(isNull(je.sourceType), notInArray(je.sourceType, CASH_EXCLUDED_SOURCE_TYPES))!);
      if (controlIds.size > 0) conditions.push(notInArray(jl.accountId, [...controlIds]));
      // A voided payment is gone: its entry, the reversal and its FX entry all stay out.
      conditions.push(
        sql`not coalesce(${je.sourceType} in (${sql.join(PAYMENT_SOURCE_TYPES.map((t) => sql`${t}`), sql`, `)}) and ${je.sourceId} in (select ${payments.id} from ${payments} where ${payments.deletedAt} is not null), false)`,
      );
    }
    return conditions;
  }

  function eventsIn(range: LedgerRange): CashEvent[] {
    const from = range.from?.getTime() ?? Number.NEGATIVE_INFINITY;
    const to = range.to.getTime();
    return events.filter((e) => {
      const t = e.date.getTime();
      if (t < from || t > to) return false;
      if (filters.classId && e.classId !== filters.classId) return false;
      if (filters.locationId && e.locationId !== filters.locationId) return false;
      return true;
    });
  }

  return {
    basis,
    entityId,
    accounts,

    async aggregate(range, opts = {}) {
      const conditions = lineConditions(range);
      if (opts.accountTypes?.length) conditions.push(inArray(accountsTable.type, opts.accountTypes));
      if (opts.accountIds?.length) conditions.push(inArray(jl.accountId, opts.accountIds));

      const rows = await db
        .select({
          accountId: jl.accountId,
          contactId: opts.byContact ? jl.contactId : sql<string | null>`null`,
          debit: sql<string>`coalesce(sum(${jl.debit}::numeric), 0)`,
          credit: sql<string>`coalesce(sum(${jl.credit}::numeric), 0)`,
        })
        .from(jl)
        .innerJoin(je, eq(jl.journalEntryId, je.id))
        .innerJoin(accountsTable, eq(jl.accountId, accountsTable.id))
        .where(and(...conditions))
        .groupBy(...(opts.byContact ? [jl.accountId, jl.contactId] : [jl.accountId]));

      const merged = new Map<string, AggregateRow>();
      const key = (accountId: string, contactId: string | null) => (opts.byContact ? `${accountId}|${contactId ?? ''}` : accountId);
      for (const r of rows) {
        merged.set(key(r.accountId, r.contactId ?? null), {
          accountId: r.accountId,
          contactId: opts.byContact ? (r.contactId ?? null) : null,
          debit: Number.parseFloat(r.debit),
          credit: Number.parseFloat(r.credit),
        });
      }

      for (const e of eventsIn(range)) {
        const account = accounts.get(e.accountId);
        if (!account) continue;
        if (opts.accountTypes?.length && !opts.accountTypes.includes(account.type)) continue;
        if (opts.accountIds?.length && !opts.accountIds.includes(e.accountId)) continue;
        const k = key(e.accountId, e.contactId);
        const row = merged.get(k) ?? { accountId: e.accountId, contactId: opts.byContact ? e.contactId : null, debit: 0, credit: 0 };
        if (e.amount > 0) row.debit = roundMoney(row.debit + e.amount);
        else row.credit = roundMoney(row.credit - e.amount);
        merged.set(k, row);
      }

      return [...merged.values()];
    },

    async accountLines(accountId, range) {
      const lines: LedgerLine[] = [];
      if (!accountId.startsWith('virtual:')) {
        const rows = await db
          .select({
            id: jl.id,
            journalEntryId: jl.journalEntryId,
            entryNumber: je.entryNumber,
            entryDate: je.date,
            entryStatus: je.status,
            description: jl.description,
            debit: jl.debit,
            credit: jl.credit,
            contactId: jl.contactId,
            sourceType: je.sourceType,
            entryId: je.id,
            sortOrder: jl.sortOrder,
          })
          .from(jl)
          .innerJoin(je, eq(jl.journalEntryId, je.id))
          .where(and(...lineConditions(range), eq(jl.accountId, accountId)))
          .orderBy(asc(je.date), asc(je.id), asc(jl.sortOrder));
        for (const r of rows) {
          lines.push({
            id: r.id,
            journalEntryId: r.journalEntryId,
            entryNumber: r.entryNumber,
            entryDate: r.entryDate,
            entryStatus: r.entryStatus,
            description: r.description,
            debit: Number.parseFloat(r.debit ?? '0'),
            credit: Number.parseFloat(r.credit ?? '0'),
            contactId: r.contactId,
            sourceType: r.sourceType,
          });
        }
      }

      const recognised = eventsIn(range)
        .filter((e) => e.accountId === accountId)
        .map((e, i) => ({
          id: `cash:${e.paymentId}:${i}`,
          journalEntryId: e.journalEntryId,
          entryNumber: e.entryNumber,
          entryDate: e.date,
          entryStatus: 'posted',
          description: e.description,
          debit: e.amount > 0 ? e.amount : 0,
          credit: e.amount < 0 ? -e.amount : 0,
          contactId: e.contactId,
          sourceType: e.sourceType,
          paymentId: e.paymentId,
        }));

      return [...lines, ...recognised].sort((a, b) => a.entryDate.getTime() - b.entryDate.getTime());
    },
  };
}
