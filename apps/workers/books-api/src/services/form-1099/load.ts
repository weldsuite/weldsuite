/**
 * Loads what the yearly 1099 computation needs from the tenant DB and builds
 * the `compute1099Totals` input (docs/plans/weldbooks-us.md section 8).
 *
 * Cash basis, calendar year: the bill payments (`payments.type = 'sent'`) dated
 * in the year, spread over the bills they paid through `payment_allocations`;
 * bank lines categorized straight to a vendor (no payment behind them); the
 * accounts' default boxes. Voided payments (deleted, or a voided check) are
 * left out. Dates are read as UTC days, the way payment dates are written
 * (`new Date('YYYY-MM-DD')`).
 *
 * The full TIN never passes through here: vendors carry `tinLast4` only.
 */

import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import type { Form1099Type } from '@weldsuite/books-domain/jurisdictions/us/form-1099';
import type {
  Compute1099Adjustment,
  Compute1099Bill,
  Compute1099BankTransaction,
  Compute1099Input,
  Compute1099Payment,
  Compute1099Vendor,
  VendorTinType,
} from '@weldsuite/books-domain/us-compliance/form-1099-compute';
import type { PartyW9 } from '../vendor-tax-data';
import { Form1099Error } from './errors';

export type PartyRow = typeof schema.parties.$inferSelect;
export type EntityRow = typeof schema.entities.$inferSelect;

export interface Load1099Options {
  /** Only these vendors (recomputing one filing line). Default: every 1099 vendor and everyone paid in the year. */
  partyIds?: string[];
  adjustments?: Compute1099Adjustment[];
}

export interface PaymentDoc {
  id: string;
  date: string;
  paymentMethod: string | null;
  checkNumber: string | null;
  reference: string | null;
  amount: number;
  backupWithholdingAmount: number;
}

export interface BillDoc {
  id: string;
  number: string | null;
  issueDate: string;
  reference: string | null;
}

export interface BillLineDoc {
  id: string;
  billId: string;
  description: string;
  accountId: string | null;
}

export interface BankTransactionDoc {
  id: string;
  date: string;
  description: string | null;
  counterpartyName: string | null;
  checkNumber: string | null;
  amount: number;
}

export interface AccountDoc {
  id: string;
  code: string;
  name: string;
}

export interface Loaded1099 {
  entity: EntityRow;
  taxYear: number;
  input: Compute1099Input;
  parties: Map<string, PartyRow>;
  docs: {
    payments: Map<string, PaymentDoc>;
    bills: Map<string, BillDoc>;
    billLines: Map<string, BillLineDoc>;
    bankTransactions: Map<string, BankTransactionDoc>;
    accounts: Map<string, AccountDoc>;
  };
}

const CHUNK = 500;

async function selectIn<T>(ids: string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) rows.push(...(await run(ids.slice(i, i + CHUNK))));
  return rows;
}

const cents = (value: number) => Math.round(value * 100) / 100;

export function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function yearBounds(taxYear: number): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(taxYear, 0, 1)), end: new Date(Date.UTC(taxYear + 1, 0, 1)) };
}

/** US vendors need a street, city, state and ZIP; a foreign address needs no state. */
export function isAddressComplete(address: PartyRow['billingAddress']): boolean {
  const normalized = normalizePostalAddress(address);
  if (!normalized?.line1 || !normalized.city || !normalized.postalCode) return false;
  const foreign = Boolean(normalized.country && normalized.country !== 'US');
  return foreign || Boolean(normalized.state);
}

function lineAmount(item: typeof schema.billItems.$inferSelect): number {
  if (item.lineTotal !== null && item.lineTotal !== undefined) return Number(item.lineTotal);
  const quantity = Number(item.quantity ?? 1);
  const discount = Number(item.discountPercent ?? 0);
  return cents(quantity * Number(item.unitPrice) * (1 - discount / 100));
}

function toVendor(party: PartyRow): Compute1099Vendor {
  const w9 = party.w9 as PartyW9 | null;
  return {
    partyId: party.id,
    name: party.displayName ?? undefined,
    is1099Vendor: Boolean(party.is1099Vendor),
    defaultForm: (party.default1099Form as Form1099Type | null) ?? null,
    defaultBox: party.default1099Box,
    tinType: (party.tinType as VendorTinType | null) ?? null,
    tinLast4: party.tinLast4,
    federalTaxClassification: w9?.federalTaxClassification ?? null,
    llcTaxClassification: w9?.llcTaxClassification ?? null,
    isAttorney: Boolean(w9?.isAttorney),
    addressComplete: isAddressComplete(party.billingAddress),
    backupWithholding: Boolean(party.backupWithholding),
  };
}

export async function loadEntityOrThrow(db: Database, entityId: string): Promise<EntityRow> {
  const [entity] = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  if (!entity) throw new Form1099Error('not_found', `Accounting entity ${entityId} not found`);
  return entity;
}

export async function load1099Input(
  db: Database,
  entityId: string,
  taxYear: number,
  options: Load1099Options = {},
): Promise<Loaded1099> {
  const entity = await loadEntityOrThrow(db, entityId);
  const { start, end } = yearBounds(taxYear);
  const only = options.partyIds && options.partyIds.length > 0 ? options.partyIds : null;

  const paymentRows = await db
    .select()
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.entityId, entityId),
        eq(schema.payments.type, 'sent'),
        isNull(schema.payments.deletedAt),
        gte(schema.payments.date, start),
        lt(schema.payments.date, end),
        only ? inArray(schema.payments.contactId, only) : undefined,
      ),
    );

  const bankAccountRows = await db
    .select({ id: schema.bankAccounts.id, accountType: schema.bankAccounts.accountType })
    .from(schema.bankAccounts)
    .where(eq(schema.bankAccounts.entityId, entityId));
  const creditCardAccounts = new Set(bankAccountRows.filter((a) => a.accountType === 'credit_card').map((a) => a.id));

  // Bank lines categorized straight to a vendor: money out, no payment, bill or invoice behind them.
  const bankRows = await db
    .select()
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.entityId, entityId),
        isNull(schema.bankTransactions.deletedAt),
        eq(schema.bankTransactions.status, 'reconciled'),
        gte(schema.bankTransactions.date, start),
        lt(schema.bankTransactions.date, end),
        isNotNull(schema.bankTransactions.contactId),
        isNotNull(schema.bankTransactions.categoryAccountId),
        isNull(schema.bankTransactions.reconciledPaymentId),
        isNull(schema.bankTransactions.reconciledBillId),
        isNull(schema.bankTransactions.reconciledInvoiceId),
        sql`${schema.bankTransactions.amount} < 0`,
        only ? inArray(schema.bankTransactions.contactId, only) : undefined,
      ),
    );

  const paymentIds = paymentRows.map((p) => p.id);
  const allocationRows = await selectIn(paymentIds, (chunk) =>
    db
      .select()
      .from(schema.paymentAllocations)
      .where(
        and(
          inArray(schema.paymentAllocations.paymentId, chunk),
          isNull(schema.paymentAllocations.deletedAt),
          isNotNull(schema.paymentAllocations.billId),
        ),
      ),
  );
  const billIds = [...new Set(allocationRows.map((a) => a.billId!))];
  const billRows = await selectIn(billIds, (chunk) =>
    db.select().from(schema.bills).where(inArray(schema.bills.id, chunk)),
  );
  const itemRows = await selectIn(billIds, (chunk) =>
    db
      .select()
      .from(schema.billItems)
      .where(and(inArray(schema.billItems.billId, chunk), isNull(schema.billItems.deletedAt)))
      .orderBy(schema.billItems.sortOrder),
  );

  const accountRows = await db
    .select({
      id: schema.accounts.id,
      code: schema.accounts.code,
      name: schema.accounts.name,
      form1099Box: schema.accounts.form1099Box,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.entityId, entityId));

  // Vendors: everyone paid in the year, plus every 1099 vendor.
  const partyIds = new Set<string>();
  for (const payment of paymentRows) partyIds.add(payment.contactId);
  for (const txn of bankRows) if (txn.contactId) partyIds.add(txn.contactId);
  const byId = await selectIn([...partyIds], (chunk) =>
    db.select().from(schema.parties).where(inArray(schema.parties.id, chunk)),
  );
  const partyRows = new Map(byId.map((p) => [p.id, p]));
  const flagged = await db
    .select()
    .from(schema.parties)
    .where(
      and(
        eq(schema.parties.is1099Vendor, true),
        isNull(schema.parties.deletedAt),
        only ? inArray(schema.parties.id, only) : undefined,
      ),
    );
  for (const party of flagged) partyRows.set(party.id, party);

  const allocationsByPayment = new Map<string, Array<{ billId: string; amount: number }>>();
  for (const allocation of allocationRows) {
    const list = allocationsByPayment.get(allocation.paymentId) ?? [];
    list.push({ billId: allocation.billId!, amount: Number(allocation.amount) });
    allocationsByPayment.set(allocation.paymentId, list);
  }

  const rateOf = (currency: string | null, exchangeRate: string | null): number => {
    if (!currency || currency === entity.baseCurrency) return 1;
    const rate = Number(exchangeRate ?? 1);
    return Number.isFinite(rate) && rate > 0 ? rate : 1;
  };

  const payments: Compute1099Payment[] = paymentRows.map((payment) => {
    const rate = rateOf(payment.currency, payment.exchangeRate);
    return {
      id: payment.id,
      partyId: payment.contactId,
      date: toDay(payment.date),
      amount: cents(Number(payment.amount) * rate),
      paymentMethod: payment.paymentMethod,
      fromCreditCardAccount: payment.bankAccountId ? creditCardAccounts.has(payment.bankAccountId) : false,
      paidThroughPayroll: Boolean(payment.paidThroughPayroll),
      voided: payment.checkStatus === 'voided',
      backupWithholdingAmount: cents(Number(payment.backupWithholdingAmount ?? 0) * rate),
      allocations: (allocationsByPayment.get(payment.id) ?? []).map((a) => ({
        billId: a.billId,
        amount: cents(a.amount * rate),
      })),
    };
  });

  const itemsByBill = new Map<string, typeof itemRows>();
  for (const item of itemRows) {
    const list = itemsByBill.get(item.billId) ?? [];
    list.push(item);
    itemsByBill.set(item.billId, list);
  }
  const bills: Compute1099Bill[] = billRows.map((bill) => ({
    id: bill.id,
    lines: (itemsByBill.get(bill.id) ?? []).map((item) => ({
      id: item.id,
      amount: lineAmount(item),
      taxAmount: Number(item.taxAmount ?? 0),
      accountId: item.accountId,
      form1099Box: item.form1099Box,
    })),
  }));

  const bankTransactions: Compute1099BankTransaction[] = bankRows.map((txn) => ({
    id: txn.id,
    partyId: txn.contactId!,
    date: toDay(txn.date),
    amount: Math.abs(Number(txn.amount)),
    accountId: txn.categoryAccountId,
    fromCreditCardAccount: creditCardAccounts.has(txn.bankAccountId),
    matchedPaymentId: txn.reconciledPaymentId,
  }));

  const accountBoxes: Record<string, string | null> = {};
  for (const account of accountRows) if (account.form1099Box) accountBoxes[account.id] = account.form1099Box;

  return {
    entity,
    taxYear,
    parties: partyRows,
    input: {
      taxYear,
      vendors: [...partyRows.values()].map(toVendor),
      payments,
      bills,
      bankTransactions,
      accountBoxes,
      adjustments: options.adjustments,
    },
    docs: {
      payments: new Map(
        paymentRows.map((p) => [
          p.id,
          {
            id: p.id,
            date: toDay(p.date),
            paymentMethod: p.paymentMethod,
            checkNumber: p.checkNumber,
            reference: p.reference,
            amount: Number(p.amount),
            backupWithholdingAmount: Number(p.backupWithholdingAmount ?? 0),
          },
        ]),
      ),
      bills: new Map(
        billRows.map((b) => [
          b.id,
          { id: b.id, number: b.billNumber, issueDate: toDay(b.issueDate), reference: b.externalReference ?? b.reference },
        ]),
      ),
      billLines: new Map(
        itemRows.map((i) => [i.id, { id: i.id, billId: i.billId, description: i.description, accountId: i.accountId }]),
      ),
      bankTransactions: new Map(
        bankRows.map((t) => [
          t.id,
          {
            id: t.id,
            date: toDay(t.date),
            description: t.description,
            counterpartyName: t.counterpartyName,
            checkNumber: t.checkNumber,
            amount: Math.abs(Number(t.amount)),
          },
        ]),
      ),
      accounts: new Map(accountRows.map((a) => [a.id, { id: a.id, code: a.code, name: a.name }])),
    },
  };
}
