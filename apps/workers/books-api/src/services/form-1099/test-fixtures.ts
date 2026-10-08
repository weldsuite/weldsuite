/**
 * Shared seed for the 1099 tests: a US entity with its real chart, nine
 * vendors created through the contacts route (so TINs are encrypted the way
 * production does it), and a 2025 and 2026 payment history that covers the
 * plan's scenario 8 (docs/plans/weldbooks-us.md, Testing).
 *
 * Not a test file: it has no `.test.ts` suffix.
 */

import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingContactsRoutes } from '../../routes/accounting-contacts';
import { accountingEntitiesRoutes } from '../../routes/accounting-entities';

export const ENCRYPTION_KEY = 'ab'.repeat(32);
export const PAYER_EIN_DIGITS = '123456789';

export interface CapturedEvent {
  eventType: string;
  entityId: string;
  data: Record<string, unknown>;
}

export const events: CapturedEvent[] = [];

export const testEnv = {
  DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY,
  ENTITY_EVENTS: {
    send: async (message: CapturedEvent) => {
      events.push(message);
    },
  },
};

export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { code: string; message: string; details?: unknown };
  text: string;
  headers: Headers;
}

export function caller(db: Database, entityId: () => string | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async function call(mount: string, routes: Hono<any>, path: string, opts: { method?: string; body?: unknown; perms?: string[]; env?: Record<string, unknown> } = {}): Promise<ApiResult> {
    const { request } = createTestApp(mount, routes, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env: { ...testEnv, ...opts.env } as any,
      context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
    });
    const id = entityId();
    const res = await request(`${mount}${path}`, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...(id ? { 'X-Accounting-Entity-Id': id } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = res.status === 204 ? '' : await res.text();
    const json = text ? (JSON.parse(text) as { data?: unknown; error?: { code: string; message: string; details?: unknown } }) : {};
    return { status: res.status, data: json.data, error: json.error, text, headers: res.headers };
  };
}

export interface VendorSpec {
  key: string;
  name: string;
  tin?: { type: 'ein' | 'ssn' | 'itin'; value: string };
  w9?: Record<string, unknown>;
  is1099Vendor?: boolean;
  form?: 'nec' | 'misc';
  box?: string;
  noAddress?: boolean;
  email?: string;
}

export const AUSTIN = { line1: '100 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' };

export const VENDORS: VendorSpec[] = [
  {
    key: 'alpha',
    name: 'Alpha Contractor',
    tin: { type: 'ssn', value: '234-56-7891' },
    w9: { legalName: 'Alice Alpha', businessName: 'Alpha Contractor', federalTaxClassification: 'individual', receivedAt: '2025-01-10', source: 'upload' },
    is1099Vendor: true,
    form: 'nec',
    box: 'nec_1',
  },
  {
    key: 'bravo',
    name: 'Bravo Cleaning LLC',
    tin: { type: 'ein', value: '45-6789012' },
    w9: { legalName: 'Bravo Cleaning LLC', federalTaxClassification: 'llc', llcTaxClassification: 'P' },
    is1099Vendor: true,
    form: 'nec',
    box: 'nec_1',
  },
  {
    key: 'charlie',
    name: 'Charlie Corp',
    tin: { type: 'ein', value: '91-2345678' },
    w9: { legalName: 'Charlie Corp', federalTaxClassification: 'c_corporation' },
    is1099Vendor: true,
    form: 'nec',
    box: 'nec_1',
  },
  {
    key: 'delta',
    name: 'Delta Law Inc',
    tin: { type: 'ein', value: '56-7890123' },
    w9: { legalName: 'Delta Law, Inc.', federalTaxClassification: 'c_corporation', isAttorney: true },
    is1099Vendor: true,
    form: 'nec',
    box: 'nec_1',
  },
  {
    key: 'echo',
    name: 'Echo Landlord Partners',
    tin: { type: 'ein', value: '67-8901234' },
    w9: { legalName: 'Echo Landlord Partners', federalTaxClassification: 'partnership' },
    is1099Vendor: true,
    form: 'misc',
    box: 'misc_1',
  },
  { key: 'foxtrot', name: 'Foxtrot Unflagged', is1099Vendor: false },
  { key: 'golf', name: 'Golf No TIN', is1099Vendor: true, form: 'nec', box: 'nec_1' },
  {
    key: 'hotel',
    name: 'Hotel Cash Contractor',
    tin: { type: 'ssn', value: '345-67-8901' },
    w9: { legalName: 'Henry Hotel', federalTaxClassification: 'individual' },
    is1099Vendor: true,
    form: 'nec',
    box: 'nec_1',
  },
  {
    key: 'india',
    name: 'India Card Vendor',
    tin: { type: 'ein', value: '81-2345670' },
    w9: { legalName: 'India Card Vendor LLC', federalTaxClassification: 'llc', llcTaxClassification: 'P' },
    is1099Vendor: true,
    form: 'nec',
    box: 'nec_1',
  },
];

export interface Fixture {
  db: Database;
  entityId: string;
  /** account code -> id (chart accounts plus `omit`) */
  accounts: Record<string, string>;
  parties: Record<string, string>;
  bankAccounts: { checking: string; card: string };
  call: ReturnType<typeof caller>;
}

let counter = 0;
const next = (prefix: string) => `${prefix}_t${(counter += 1).toString().padStart(4, '0')}`;

export async function seedEntityAndVendors(db: Database): Promise<Fixture> {
  const holder: { entityId?: string } = {};
  const call = caller(db, () => holder.entityId);

  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '', {
    method: 'POST',
    body: {
      name: 'Acme Studio LLC',
      legalName: 'Acme Studio, LLC',
      dba: 'Acme Studio',
      jurisdictionCode: 'US',
      entityType: 'single_member_llc',
      taxIdentifiers: { einOrSsn: '123456789' },
      address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
    },
  });
  if (created.status !== 201) throw new Error(`entity setup failed: ${created.text}`);
  const entityId = created.data.id as string;
  holder.entityId = entityId;
  await db
    .update(schema.entities)
    .set({ contact: { phone: '(512) 555-0100', email: 'books@acme.test' } })
    .where(eq(schema.entities.id, entityId));

  const now = new Date();
  const chart = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  const accounts: Record<string, string> = {};
  for (const account of chart) accounts[account.code] = account.id;
  // An expense account that stays out of 1099 reporting.
  const omitId = next('acc');
  await db.insert(schema.accounts).values({
    id: omitId,
    entityId,
    code: '6999',
    name: 'Reimbursed Expenses',
    type: 'expense',
    normalSide: 'debit',
    currency: 'USD',
    form1099Box: 'omit',
    createdAt: now,
    updatedAt: now,
  });
  accounts['6999'] = omitId;

  const checking = next('bka');
  const card = next('bka');
  await db.insert(schema.bankAccounts).values([
    { id: checking, entityId, name: 'Operating Checking', currency: 'USD', accountType: 'checking', createdAt: now, updatedAt: now },
    { id: card, entityId, name: 'Business Visa', currency: 'USD', accountType: 'credit_card', createdAt: now, updatedAt: now },
  ]);

  const parties: Record<string, string> = {};
  for (const spec of VENDORS) {
    const res = await call('/api/accounting-contacts', accountingContactsRoutes, '', {
      method: 'POST',
      body: {
        fullName: spec.name,
        companyName: spec.tin?.type === 'ssn' ? undefined : spec.name,
        role: 'supplier',
        is1099Vendor: spec.is1099Vendor ?? false,
        ...(spec.form ? { default1099Form: spec.form } : {}),
        ...(spec.box ? { default1099Box: spec.box } : {}),
        ...(spec.tin ? { tinType: spec.tin.type, tin: spec.tin.value } : {}),
        ...(spec.w9 ? { w9: spec.w9 } : {}),
        billingAddress: AUSTIN,
      },
    });
    if (res.status !== 201) throw new Error(`vendor ${spec.name} failed: ${res.text}`);
    parties[spec.key] = res.data.id as string;
  }

  return { db, entityId, accounts, parties, bankAccounts: { checking, card }, call };
}

// ── Documents ───────────────────────────────────────────────────────────────

export interface BillLineSpec {
  description: string;
  amount: number;
  accountCode: string;
  taxAmount?: number;
  form1099Box?: string;
}

export async function seedBill(fx: Fixture, args: { vendor: string; date: string; number: string; lines: BillLineSpec[] }) {
  const id = next('bil');
  const now = new Date();
  const total = args.lines.reduce((sum, l) => sum + l.amount + (l.taxAmount ?? 0), 0);
  await fx.db.insert(schema.bills).values({
    id,
    entityId: fx.entityId,
    billNumber: args.number,
    status: 'approved',
    contactId: fx.parties[args.vendor]!,
    issueDate: new Date(`${args.date}T00:00:00Z`),
    dueDate: new Date(`${args.date}T00:00:00Z`),
    currency: 'USD',
    subtotal: total.toFixed(2),
    total: total.toFixed(2),
    createdAt: now,
    updatedAt: now,
  });
  const lineIds: string[] = [];
  let order = 0;
  for (const line of args.lines) {
    const lineId = next('bli');
    lineIds.push(lineId);
    await fx.db.insert(schema.billItems).values({
      id: lineId,
      entityId: fx.entityId,
      billId: id,
      description: line.description,
      quantity: '1',
      unitPrice: line.amount.toFixed(4),
      lineTotal: line.amount.toFixed(2),
      taxAmount: (line.taxAmount ?? 0).toFixed(2),
      accountId: fx.accounts[line.accountCode],
      form1099Box: line.form1099Box ?? null,
      sortOrder: order,
      createdAt: now,
      updatedAt: now,
    });
    order += 1;
  }
  return { id, lineIds, total };
}

export interface PaymentSpec {
  vendor: string;
  date: string;
  amount: number;
  method?: string;
  checkNumber?: string;
  bankAccount?: 'checking' | 'card';
  /** Pay these bills in full (allocation = the bill's total). */
  bills?: Array<{ id: string; total: number }>;
  backupWithholding?: number;
  paidThroughPayroll?: boolean;
  deleted?: boolean;
  checkStatus?: string;
}

export async function seedPayment(fx: Fixture, spec: PaymentSpec) {
  const id = next('pay');
  const now = new Date();
  await fx.db.insert(schema.payments).values({
    id,
    entityId: fx.entityId,
    type: 'sent',
    amount: spec.amount.toFixed(2),
    currency: 'USD',
    date: new Date(`${spec.date}T00:00:00Z`),
    paymentMethod: spec.method ?? 'check',
    checkNumber: spec.checkNumber ?? null,
    contactId: fx.parties[spec.vendor]!,
    bankAccountId: spec.bankAccount ? fx.bankAccounts[spec.bankAccount] : fx.bankAccounts.checking,
    backupWithholdingAmount: spec.backupWithholding ? spec.backupWithholding.toFixed(2) : null,
    paidThroughPayroll: spec.paidThroughPayroll ?? false,
    checkStatus: spec.checkStatus ?? null,
    deletedAt: spec.deleted ? now : null,
    createdAt: now,
    updatedAt: now,
  });
  for (const bill of spec.bills ?? []) {
    await fx.db.insert(schema.paymentAllocations).values({
      id: next('pal'),
      entityId: fx.entityId,
      paymentId: id,
      billId: bill.id,
      amount: bill.total.toFixed(2),
      createdAt: now,
      updatedAt: now,
    });
  }
  return id;
}

/** Money out of a bank account that was categorized to an expense account and a vendor, with no payment record. */
export async function seedCategorizedBankLine(
  fx: Fixture,
  args: { vendor: string; date: string; amount: number; accountCode: string; bankAccount?: 'checking' | 'card'; description?: string },
) {
  const id = next('btx');
  const now = new Date();
  await fx.db.insert(schema.bankTransactions).values({
    id,
    entityId: fx.entityId,
    bankAccountId: fx.bankAccounts[args.bankAccount ?? 'checking'],
    date: new Date(`${args.date}T00:00:00Z`),
    description: args.description ?? 'Cash app payment',
    amount: (-args.amount).toFixed(2),
    status: 'reconciled',
    reconciliationType: 'manual',
    categoryAccountId: fx.accounts[args.accountCode],
    contactId: fx.parties[args.vendor],
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** The 2025 and 2026 history of the plan's scenario 8. */
export async function seedPaymentHistory(fx: Fixture) {
  // Alpha: a check and a card payment in the same year, a deleted check, a voided check, and a bill with an omitted line.
  const a1 = await seedBill(fx, {
    vendor: 'alpha',
    date: '2025-03-01',
    number: 'ALPHA-1',
    lines: [
      { description: 'Design work', amount: 4000, accountCode: '6030' },
      { description: 'Reimbursed travel', amount: 1000, accountCode: '6999' },
    ],
  });
  await seedPayment(fx, { vendor: 'alpha', date: '2025-03-15', amount: 5000, checkNumber: '1001', bills: [{ id: a1.id, total: a1.total }] });
  const a2 = await seedBill(fx, { vendor: 'alpha', date: '2025-04-01', number: 'ALPHA-2', lines: [{ description: 'Logo work', amount: 3000, accountCode: '6030' }] });
  await seedPayment(fx, { vendor: 'alpha', date: '2025-04-10', amount: 3000, method: 'credit_card', bankAccount: 'card', bills: [{ id: a2.id, total: a2.total }] });
  const a3 = await seedBill(fx, { vendor: 'alpha', date: '2025-05-01', number: 'ALPHA-3', lines: [{ description: 'Mistaken bill', amount: 9000, accountCode: '6030' }] });
  await seedPayment(fx, { vendor: 'alpha', date: '2025-05-05', amount: 9000, checkNumber: '1002', deleted: true, bills: [{ id: a3.id, total: a3.total }] });
  await seedPayment(fx, { vendor: 'alpha', date: '2025-06-05', amount: 700, checkNumber: '1003', checkStatus: 'voided' });
  const a4 = await seedBill(fx, { vendor: 'alpha', date: '2026-02-01', number: 'ALPHA-4', lines: [{ description: 'Design work', amount: 2500, accountCode: '6030' }] });
  await seedPayment(fx, { vendor: 'alpha', date: '2026-02-20', amount: 2500, checkNumber: '1101', bills: [{ id: a4.id, total: a4.total }] });

  // Bravo: $1,500 in each year: over $600, under $2,000.
  const b1 = await seedBill(fx, { vendor: 'bravo', date: '2025-06-01', number: 'BRAVO-1', lines: [{ description: 'Cleaning', amount: 1500, accountCode: '6030' }] });
  await seedPayment(fx, { vendor: 'bravo', date: '2025-06-20', amount: 1500, method: 'ach', bills: [{ id: b1.id, total: b1.total }] });
  const b2 = await seedBill(fx, { vendor: 'bravo', date: '2026-06-01', number: 'BRAVO-2', lines: [{ description: 'Cleaning', amount: 1500, accountCode: '6030' }] });
  await seedPayment(fx, { vendor: 'bravo', date: '2026-06-20', amount: 1500, method: 'ach', bills: [{ id: b2.id, total: b2.total }] });

  // Charlie is a corporation; Delta is a law firm that incorporated.
  const c1 = await seedBill(fx, { vendor: 'charlie', date: '2025-07-01', number: 'CHARLIE-1', lines: [{ description: 'Consulting', amount: 10000, accountCode: '6030' }] });
  await seedPayment(fx, { vendor: 'charlie', date: '2025-07-15', amount: 10000, checkNumber: '1004', bills: [{ id: c1.id, total: c1.total }] });
  const d1 = await seedBill(fx, { vendor: 'delta', date: '2025-08-01', number: 'DELTA-1', lines: [{ description: 'Legal fees', amount: 8000, accountCode: '6030' }] });
  await seedPayment(fx, { vendor: 'delta', date: '2025-08-15', amount: 8000, checkNumber: '1005', bills: [{ id: d1.id, total: d1.total }] });
  const d2 = await seedBill(fx, { vendor: 'delta', date: '2026-08-01', number: 'DELTA-2', lines: [{ description: 'Legal fees', amount: 1999.99, accountCode: '6030' }] });
  await seedPayment(fx, { vendor: 'delta', date: '2026-08-15', amount: 1999.99, checkNumber: '1102', bills: [{ id: d2.id, total: d2.total }] });

  // Echo: rent (MISC box 1).
  const e1 = await seedBill(fx, { vendor: 'echo', date: '2025-01-01', number: 'ECHO-1', lines: [{ description: 'Annual rent', amount: 24000, accountCode: '6140' }] });
  await seedPayment(fx, { vendor: 'echo', date: '2025-01-05', amount: 24000, checkNumber: '1006', bills: [{ id: e1.id, total: e1.total }] });

  // Foxtrot is not flagged as a 1099 vendor but was paid for contract work.
  const f1 = await seedBill(fx, { vendor: 'foxtrot', date: '2025-09-01', number: 'FOX-1', lines: [{ description: 'Contract labor', amount: 4000, accountCode: '6030' }] });
  await seedPayment(fx, { vendor: 'foxtrot', date: '2025-09-10', amount: 4000, checkNumber: '1007', bills: [{ id: f1.id, total: f1.total }] });

  // Golf has no TIN: 24% was withheld.
  const g1 = await seedBill(fx, { vendor: 'golf', date: '2025-10-01', number: 'GOLF-1', lines: [{ description: 'Contract work', amount: 3000, accountCode: '6030' }] });
  await seedPayment(fx, { vendor: 'golf', date: '2025-10-20', amount: 3000, checkNumber: '1008', backupWithholding: 720, bills: [{ id: g1.id, total: g1.total }] });

  // Hotel is paid straight from the bank: $700 in 2025, exactly $2,000 in 2026.
  await seedCategorizedBankLine(fx, { vendor: 'hotel', date: '2025-11-03', amount: 700, accountCode: '6030' });
  await seedCategorizedBankLine(fx, { vendor: 'hotel', date: '2026-11-03', amount: 2000, accountCode: '6030' });

  // India: paid by card, from a card account and through payroll: nothing is reported by us.
  const i1 = await seedBill(fx, { vendor: 'india', date: '2025-12-01', number: 'INDIA-1', lines: [{ description: 'Services', amount: 5000, accountCode: '6030' }] });
  await seedPayment(fx, { vendor: 'india', date: '2025-12-05', amount: 5000, method: 'credit_card', bankAccount: 'card', bills: [{ id: i1.id, total: i1.total }] });
  await seedPayment(fx, { vendor: 'india', date: '2025-12-06', amount: 1000, method: 'ach', bankAccount: 'card' });
  await seedPayment(fx, { vendor: 'india', date: '2025-12-07', amount: 2000, method: 'ach', paidThroughPayroll: true });
  await seedCategorizedBankLine(fx, { vendor: 'india', date: '2025-12-08', amount: 900, accountCode: '6030', bankAccount: 'card' });
}

// ── KV ──────────────────────────────────────────────────────────────────────

/** A WORKSPACE_CACHE stand-in that remembers the TTL of each key. */
export function fakeKv() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv = {
    get: async (key: string, type?: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    delete: async (key: string) => {
      store.delete(key);
      ttls.delete(key);
    },
  };
  return { kv: kv as unknown as KVNamespace, store, ttls };
}
