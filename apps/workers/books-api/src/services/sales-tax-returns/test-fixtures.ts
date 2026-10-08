/**
 * Fixtures for the Sales Tax Center tests (pglite): a US entity with its chart,
 * agencies with their payable accounts, and documents posted the way the
 * posting service writes them (a balanced journal entry plus tax-ledger rows
 * with the US detail columns). Rates are fixtures, not real-world rates.
 */

import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { accountingEntitiesRoutes } from '../../routes/accounting-entities';
import { postJournalEntry } from '../accounting-posting';

export interface UsFixture {
  db: Database;
  entityId: string;
  /** Account ids by code. */
  accountId: Record<string, string>;
  bankAccountId: string;
}

export const ENCRYPTION_ENV = { DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32) };

export interface CallResult {
  status: number;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  list: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  pagination?: { totalCount: number; hasMore: boolean; cursor: string | null };
  error?: { code: string; message: string; details?: unknown };
  text: string;
}

export async function callRoute(
  db: Database,
  mount: string,
  routes: Hono<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  path: string,
  opts: { method?: string; body?: unknown; entityId?: string; perms?: string[]; userId?: string } = {},
): Promise<CallResult> {
  const { request } = createTestApp(mount, routes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db, ...(opts.userId ? { userId: opts.userId } : {}) },
    env: ENCRYPTION_ENV,
  });
  const res = await request(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.entityId ? { 'X-Accounting-Entity-Id': opts.entityId } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  let json: { data?: unknown; pagination?: CallResult['pagination']; error?: CallResult['error'] } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return {
    status: res.status,
    data: (Array.isArray(json.data) ? {} : (json.data ?? {})) as CallResult['data'],
    list: (Array.isArray(json.data) ? json.data : []) as CallResult['list'],
    pagination: json.pagination,
    error: json.error,
    text,
  };
}

export async function createUsFixture(db: Database, name = 'Acme Studio LLC'): Promise<UsFixture> {
  const res = await callRoute(db, '/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    body: {
      name,
      legalName: name,
      jurisdictionCode: 'US',
      entityType: 'single_member_llc',
      taxIdentifiers: { einOrSsn: '123456789' },
      address: { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' },
    },
  });
  if (res.status !== 201) throw new Error(`entity setup failed: ${res.text}`);
  const entityId = res.data.id as string;
  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  const accountId = Object.fromEntries(accounts.map((a) => [a.code, a.id]));

  const bankAccountId = generateId('bnk');
  await db.insert(schema.bankAccounts).values({
    id: bankAccountId,
    entityId,
    name: 'Operating checking',
    currency: 'USD',
    ledgerAccountId: accountId['1000'],
  });
  return { db, entityId, accountId, bankAccountId };
}

export interface AgencySpec {
  id: string;
  stateCode: string;
  name: string;
  filingFrequency?: 'monthly' | 'quarterly' | 'semiannual' | 'annual';
  firstPeriodStart?: string;
  dueDay?: number;
  reportingBasis?: 'accrual' | 'cash';
  status?: string;
  registeredFrom?: string;
  registeredUntil?: string;
  /** Create child payable accounts (default true). */
  ownAccounts?: boolean;
}

/** An agency with a child account under Sales Tax Payable and one under Use Tax Payable. */
export async function addAgency(f: UsFixture, spec: AgencySpec): Promise<{ liabilityAccountId: string | null; useTaxAccountId: string | null }> {
  let liabilityAccountId: string | null = null;
  let useTaxAccountId: string | null = null;
  if (spec.ownAccounts !== false) {
    liabilityAccountId = generateId('acc');
    useTaxAccountId = generateId('acc');
    await f.db.insert(schema.accounts).values([
      {
        id: liabilityAccountId,
        entityId: f.entityId,
        code: `22${spec.stateCode}`,
        name: `Sales Tax Payable - ${spec.name}`,
        type: 'liability',
        subtype: 'tax_payable',
        normalSide: 'credit',
        parentAccountId: f.accountId['2200'],
        currency: 'USD',
      },
      {
        id: useTaxAccountId,
        entityId: f.entityId,
        code: `23${spec.stateCode}`,
        name: `Use Tax Payable - ${spec.name}`,
        type: 'liability',
        subtype: 'tax_payable',
        normalSide: 'credit',
        parentAccountId: f.accountId['2210'],
        currency: 'USD',
      },
    ]);
  }
  await f.db.insert(schema.salesTaxAgencies).values({
    id: spec.id,
    entityId: f.entityId,
    stateCode: spec.stateCode,
    name: spec.name,
    status: spec.status ?? 'registered',
    filingFrequency: spec.filingFrequency ?? 'quarterly',
    firstPeriodStart: spec.firstPeriodStart ?? '2026-07-01',
    registeredFrom: spec.registeredFrom ?? spec.firstPeriodStart ?? '2026-07-01',
    registeredUntil: spec.registeredUntil ?? null,
    dueDay: spec.dueDay ?? 20,
    reportingBasis: spec.reportingBasis ?? 'accrual',
    liabilityAccountId,
    useTaxAccountId,
  });
  return { liabilityAccountId, useTaxAccountId };
}

export interface TaxRow {
  code: string;
  name: string;
  level: 'state' | 'county' | 'city' | 'district';
  /** Percent. */
  rate: number;
  /** Tax in dollars (before the document's sign). */
  tax: number;
  reportingCode?: string;
}

export interface SaleLine {
  id: string;
  gross: number;
  taxable: number;
  exempt?: number;
  nonTaxable?: number;
  exemptReason?: string;
  certificateId?: string;
  taxCode?: string;
  /** Tax the user set by hand on the line. */
  override?: { amount: number; reason: string };
  rows: TaxRow[];
}

export interface SaleSpec {
  id: string;
  number: string;
  /** `YYYY-MM-DD`. */
  date: string;
  agencyId: string | null;
  stateCode: string;
  /** Ship-to state on the invoice (default: stateCode). Empty string leaves the address without a state. */
  shipToState?: string;
  contactName?: string;
  contactId?: string;
  lines: SaleLine[];
  marketplace?: boolean;
  /** A credit memo: negative amounts, sourceType `credit_note`. */
  creditNoteFor?: string;
  /** Do not write tax-ledger rows (an invoice posted without tax data). */
  noTaxRows?: boolean;
  /** Payable account to credit (default: the agency's own, else Sales Tax Payable). */
  liabilityAccountId?: string | null;
}

function money(value: number): string {
  return value.toFixed(2);
}

/** Posts an invoice (or credit memo) the way the posting service does and writes its tax-ledger rows. */
export async function postSale(f: UsFixture, spec: SaleSpec): Promise<{ journalEntryId: string }> {
  const sign = spec.creditNoteFor ? -1 : 1;
  const sourceType = spec.creditNoteFor ? 'credit_note' : 'invoice';
  const gross = spec.lines.reduce((sum, l) => sum + l.gross, 0) * sign;
  const tax = spec.lines.reduce((sum, l) => sum + l.rows.reduce((s, r) => s + r.tax, 0), 0) * sign;
  const date = new Date(`${spec.date}T00:00:00Z`);
  const shipTo = spec.shipToState ?? spec.stateCode;

  const [agency] = spec.agencyId
    ? await f.db.select().from(schema.salesTaxAgencies).where(eq(schema.salesTaxAgencies.id, spec.agencyId))
    : [];
  const liabilityId = spec.liabilityAccountId ?? agency?.liabilityAccountId ?? f.accountId['2200'];

  await f.db.insert(schema.invoices).values({
    id: spec.id,
    entityId: f.entityId,
    invoiceNumber: spec.number,
    type: spec.creditNoteFor ? 'credit_note' : 'standard',
    status: 'sent',
    contactId: spec.contactId ?? 'pty_customer',
    contactName: spec.contactName ?? 'Customer Inc',
    issueDate: date,
    dueDate: new Date(date.getTime() + 30 * 86_400_000),
    currency: 'USD',
    subtotal: money(Math.abs(gross)),
    taxTotal: money(Math.abs(tax)),
    total: money(Math.abs(gross + tax)),
    balanceDue: money(Math.abs(gross + tax)),
    shippingAddress: shipTo ? { line1: '1 Main St', city: 'Anywhere', state: shipTo, postalCode: '00000', country: 'US' } : undefined,
    billingAddress: shipTo ? { line1: '1 Main St', city: 'Anywhere', state: shipTo, postalCode: '00000', country: 'US' } : undefined,
    marketplaceFacilitated: spec.marketplace ?? false,
    creditNoteForInvoiceId: spec.creditNoteFor ?? null,
  });
  await f.db.insert(schema.invoiceItems).values(
    spec.lines.map((l, i) => ({
      id: l.id,
      entityId: f.entityId,
      invoiceId: spec.id,
      description: `Line ${i + 1}`,
      unitPrice: money(l.gross),
      lineTotal: money(l.gross),
      sortOrder: i,
      ...(l.override ? { taxOverrideAmount: money(l.override.amount), taxOverrideReason: l.override.reason } : {}),
    })),
  );

  const posted = await postJournalEntry(f.db, {
    entityId: f.entityId,
    date,
    description: `${spec.creditNoteFor ? 'Credit note' : 'Invoice'} ${spec.number}`,
    sourceType,
    sourceId: spec.id,
    postingKey: `invoice:${spec.id}:issue`,
    lockKind: 'sales',
    lines: [
      { accountId: f.accountId['1100'], debit: gross + tax, description: `AR ${spec.number}` },
      { accountId: f.accountId['4020'], credit: gross, description: `Revenue ${spec.number}` },
      ...(tax !== 0 ? [{ accountId: liabilityId, credit: tax, description: `Sales tax ${spec.number}` }] : []),
    ],
  });
  const journalEntryId = posted.journalEntryId as string;
  await f.db.update(schema.invoices).set({ journalEntryId }).where(eq(schema.invoices.id, spec.id));

  if (!spec.noTaxRows) {
    await f.db.insert(schema.taxLines).values(
      spec.lines.flatMap((line) =>
        line.rows.map((row) => ({
          id: generateId('txl'),
          createdAt: new Date(),
          entityId: f.entityId,
          sourceType,
          sourceId: spec.id,
          sourceLineId: line.id,
          journalEntryId,
          taxDate: spec.date,
          contactId: spec.contactId ?? 'pty_customer',
          direction: 'sales',
          rate: row.rate.toFixed(4),
          jurisdictionCode: row.code,
          jurisdictionName: row.name,
          jurisdictionLevel: row.level,
          reportingCode: row.reportingCode ?? null,
          stateCode: spec.stateCode,
          taxableAmount: money(line.taxable * sign),
          taxAmount: money(row.tax * sign),
          currency: 'USD',
          baseTaxableAmount: money(line.taxable * sign),
          baseTaxAmount: money(row.tax * sign),
          agencyId: spec.agencyId,
          grossAmount: money(line.gross * sign),
          exemptAmount: money((line.exempt ?? 0) * sign),
          nonTaxableAmount: money((line.nonTaxable ?? 0) * sign),
          exemptReason: line.exemptReason ?? null,
          certificateId: line.certificateId ?? null,
          shipToState: shipTo || null,
          taxCode: line.taxCode ?? 'general',
          marketplaceFacilitated: spec.marketplace ?? false,
          engine: 'manual',
        })),
      ),
    );
  }
  return { journalEntryId };
}

export interface UseTaxSpec {
  id: string;
  number: string;
  date: string;
  agencyId: string;
  stateCode: string;
  taxable: number;
  rows: TaxRow[];
}

/** A bill with accrued use tax: debit expense, credit payable and the agency's use tax payable. */
export async function postUseTax(f: UsFixture, spec: UseTaxSpec): Promise<{ journalEntryId: string }> {
  const tax = spec.rows.reduce((sum, r) => sum + r.tax, 0);
  const date = new Date(`${spec.date}T00:00:00Z`);
  const [agency] = await f.db.select().from(schema.salesTaxAgencies).where(eq(schema.salesTaxAgencies.id, spec.agencyId));
  await f.db.insert(schema.bills).values({
    id: spec.id,
    entityId: f.entityId,
    billNumber: spec.number,
    status: 'approved',
    contactId: 'pty_vendor',
    contactName: 'Vendor LLC',
    issueDate: date,
    dueDate: new Date(date.getTime() + 30 * 86_400_000),
    currency: 'USD',
    subtotal: money(spec.taxable),
    total: money(spec.taxable),
  });
  const posted = await postJournalEntry(f.db, {
    entityId: f.entityId,
    date,
    description: `Bill ${spec.number}`,
    sourceType: 'bill',
    sourceId: spec.id,
    postingKey: `bill:${spec.id}:approve`,
    lockKind: 'purchase',
    lines: [
      { accountId: f.accountId['6000'], debit: spec.taxable + tax, description: `Expense ${spec.number}` },
      { accountId: f.accountId['2000'], credit: spec.taxable, description: `AP ${spec.number}` },
      { accountId: agency!.useTaxAccountId ?? f.accountId['2210'], credit: tax, description: `Use tax ${spec.number}` },
    ],
  });
  const journalEntryId = posted.journalEntryId as string;
  await f.db.insert(schema.taxLines).values(
    spec.rows.map((row) => ({
      id: generateId('txl'),
      createdAt: new Date(),
      entityId: f.entityId,
      sourceType: 'bill',
      sourceId: spec.id,
      sourceLineId: `${spec.id}_l1`,
      journalEntryId,
      taxDate: spec.date,
      direction: 'use',
      rate: row.rate.toFixed(4),
      jurisdictionCode: row.code,
      jurisdictionName: row.name,
      jurisdictionLevel: row.level,
      stateCode: spec.stateCode,
      taxableAmount: money(spec.taxable),
      taxAmount: money(row.tax),
      currency: 'USD',
      baseTaxableAmount: money(spec.taxable),
      baseTaxAmount: money(row.tax),
      agencyId: spec.agencyId,
      grossAmount: money(spec.taxable),
      exemptAmount: '0.00',
      nonTaxableAmount: '0.00',
      shipToState: spec.stateCode,
      taxCode: 'general',
      engine: 'manual',
    })),
  );
  return { journalEntryId };
}

/** Records a customer payment against an invoice (payment + allocation rows; no posting). */
export async function addPayment(
  f: UsFixture,
  spec: { id: string; invoiceId: string; amount: number; date: string; createdAt?: Date },
): Promise<void> {
  const date = new Date(`${spec.date}T00:00:00Z`);
  await f.db.insert(schema.payments).values({
    id: spec.id,
    entityId: f.entityId,
    type: 'received',
    amount: money(spec.amount),
    currency: 'USD',
    date,
    contactId: 'pty_customer',
    invoiceId: spec.invoiceId,
    createdAt: spec.createdAt ?? new Date(),
  });
  await f.db.insert(schema.paymentAllocations).values({
    id: `${spec.id}_a`,
    entityId: f.entityId,
    paymentId: spec.id,
    invoiceId: spec.invoiceId,
    amount: money(spec.amount),
  });
}

/** The standard Texas jurisdictions of the fixtures: state, city and a transit district. */
export function texasRows(taxable: number): TaxRow[] {
  const cents = (rate: number) => Math.round(taxable * rate) / 100;
  return [
    { code: 'TX-STATE', name: 'Texas', level: 'state', rate: 6.25, tax: cents(6.25), reportingCode: 'TX' },
    { code: 'TX-CITY-AUSTIN', name: 'Austin', level: 'city', rate: 1, tax: cents(1), reportingCode: '2227006' },
    { code: 'TX-TRANSIT', name: 'Capital Metro', level: 'district', rate: 1, tax: cents(1), reportingCode: '5227001' },
  ];
}
