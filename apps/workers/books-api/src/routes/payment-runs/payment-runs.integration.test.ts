/**
 * Vendor payment runs on pglite: ACH runs with dual approval, holds for
 * vendors whose bank details changed, NACHA files and the reveal log, prenotes,
 * check runs with numbering, print data, void and reissue, the check register,
 * Positive Pay and the bank account's payment settings.
 *
 * The books run on a US entity (the US chart template). Vendors get encrypted
 * ACH details through `buildVendorTaxChange`, the same code the contact
 * routes use.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { verifyNachaFile } from '@weldsuite/books-domain/us-compliance/nacha';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { bankAccountsRoutes } from '../bank-accounts';
import { billsRoutes } from '../bills';
import { paymentRunsRoutes } from './index';
import { buildVendorTaxChange } from '../../services/vendor-tax-data';

/** Lets one test make the payments service fail partway through a run. */
const failure = vi.hoisted(() => ({ failAfter: null as number | null, calls: 0 }));
vi.mock('../../services/accounting-payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/accounting-payments')>();
  const { PostingError } = await import('../../services/accounting-posting');
  return {
    ...actual,
    recordPayment: async (...args: Parameters<typeof actual.recordPayment>) => {
      if (failure.failAfter !== null) {
        failure.calls += 1;
        if (failure.calls > failure.failAfter) throw new PostingError('Simulated failure while posting a payment');
      }
      return actual.recordPayment(...args);
    },
  };
});

const ENCRYPTION_KEY = 'ab'.repeat(32);
const events: Array<{ eventType: string; entityId: string; data: Record<string, unknown> }> = [];
const env = {
  DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY,
  ENTITY_EVENTS: {
    send: async (message: { eventType: string; entityId: string; data: Record<string, unknown> }) => {
      events.push(message);
    },
  },
};

const CREATOR = 'user_creator';
const APPROVER_A = 'user_approver_a';
const APPROVER_B = 'user_approver_b';
const CREATOR_PERMS = ['bills:read', 'banking:read', 'banking:create'];
const MANAGER_PERMS = ['bills:read', 'banking:read', 'banking:manage'];

let db: Database;
let entityId: string;
let bankId: string;
let expenseAccountId: string;

const DAY_MS = 86_400_000;
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const PAY_DATE = isoDay(daysFromNow(5));

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  pagination?: Record<string, unknown>;
  text: string;
}

async function callRoutes(
  mount: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routes: Hono<any>,
  path: string,
  opts: { method?: string; body?: unknown; user?: string; perms?: string[] } = {},
): Promise<Reply> {
  const { request } = createTestApp(mount, routes, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: env as any,
    context: { userId: opts.user ?? 'user_admin', permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const res = await request(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(entityId ? { 'X-Accounting-Entity-Id': entityId } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: unknown; error?: Reply['error']; pagination?: Reply['pagination'] }) : {};
  return { status: res.status, data: json.data, error: json.error, pagination: json.pagination, text };
}

const runs = (path = '', opts: Parameters<typeof callRoutes>[3] = {}) =>
  callRoutes('/api/payment-runs', paymentRunsRoutes, `/api/payment-runs${path}`, opts);

async function createRun(body: Record<string, unknown>, user = CREATOR, perms = CREATOR_PERMS): Promise<Reply> {
  return runs('', { method: 'POST', body: { bankAccountId: bankId, paymentDate: PAY_DATE, ...body }, user, perms });
}

const approve = (id: string, user: string) => runs(`/${id}/approve`, { method: 'POST', user, perms: MANAGER_PERMS });

interface VendorOptions {
  routing?: string;
  account?: string;
  type?: 'checking' | 'savings';
  /** Days ago the bank details changed; 0 means just now. Omit for stable details. */
  changedDaysAgo?: number;
  verified?: boolean;
  person?: boolean;
  tin1099?: boolean;
}

async function addVendor(id: string, name: string, opts: VendorOptions = {}) {
  const change = opts.routing
    ? await buildVendorTaxChange(null, { achRoutingNumber: opts.routing, achAccountNumber: opts.account, achAccountType: opts.type ?? 'checking' }, env)
    : { columns: {} };
  const longAgo = daysFromNow(-60);
  await db.insert(schema.parties).values({
    id,
    displayName: name,
    role: 'supplier',
    kind: opts.person ? 'person' : 'company',
    billingAddress: { line1: '12 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
    ...(opts.tin1099 ? { is1099Vendor: true, default1099Form: 'nec', default1099Box: 'nec_1' } : {}),
    ...change.columns,
    ...(opts.routing
      ? {
          bankDetailsChangedAt: opts.changedDaysAgo === undefined ? longAgo : daysFromNow(-opts.changedDaysAgo),
          bankDetailsVerifiedAt: opts.verified === false ? null : opts.changedDaysAgo === undefined ? daysFromNow(-59) : null,
        }
      : {}),
  });
}

async function addBill(partyId: string, number: string, amount: string): Promise<string> {
  const created = await callRoutes('/api/bills', billsRoutes, '/api/bills', {
    method: 'POST',
    body: {
      contactId: partyId,
      billNumber: number,
      issueDate: '2026-09-01',
      dueDate: isoDay(daysFromNow(10)),
      items: [{ description: `Services ${number}`, quantity: '1', unitPrice: amount, taxRateId: 'none', accountId: expenseAccountId }],
    },
  });
  expect(created.status, created.text).toBe(201);
  const approved = await callRoutes('/api/bills', billsRoutes, `/api/bills/${created.data.id}/approve`, { method: 'PATCH' });
  expect(approved.status, approved.text).toBe(200);
  return created.data.id as string;
}

async function billOf(id: string) {
  const [row] = await db.select().from(schema.bills).where(eq(schema.bills.id, id));
  return row;
}

const billId: Record<string, string> = {};
/** A payment of the first ACH run, for the check routes to refuse. */
let achPaymentId = '';

beforeAll(async () => {
  db = (await createPgliteDb()).db;

  const created = await callRoutes('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    body: {
      name: 'Runs Studio LLC',
      legalName: 'Runs Studio, LLC',
      jurisdictionCode: 'US',
      entityType: 'single_member_llc',
      taxIdentifiers: { einOrSsn: '123456789' },
      address: { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' },
    },
  });
  expect(created.status, created.text).toBe(201);
  entityId = created.data.id as string;
  const [expense] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.entityId, entityId), eq(schema.accounts.type, 'expense'))).limit(1);
  expenseAccountId = expense!.id;

  const bank = await callRoutes('/api/bank-accounts', bankAccountsRoutes, '/api/bank-accounts', {
    method: 'POST',
    body: {
      name: 'Operating',
      bankName: 'JPMorgan Chase',
      currency: 'USD',
      accountType: 'checking',
      routingNumber: '021000021',
      accountNumber: '0001 2345-6789',
    },
  });
  expect(bank.status, bank.text).toBe(201);
  bankId = bank.data.id as string;

  await addVendor('pty_alpha', 'Alpha Roofing LLC', { routing: '121000248', account: '5550001111' });
  await addVendor('pty_bravo', 'Bravo Lumber Inc', { routing: '026009593', account: '7770002222', changedDaysAgo: 1, verified: false });
  await addVendor('pty_charlie', 'Charlie Supply');
  await addVendor('pty_delta', 'Delta Design Co', { routing: '026009593', account: '987654321', type: 'savings' });
  await addVendor('pty_echo', 'Echo Freelance', { routing: '121000248', account: '4440003333', tin1099: true });
  await addVendor('pty_foxtrot', 'Foxtrot Partners', { routing: '011000015', account: '3330004444', person: true });
  await addVendor('pty_golf', 'Golf Towing');
  await addVendor('pty_hotel', 'Hotel Linen');
  await addVendor('pty_india', 'India Tools', { routing: '322271627', account: '2220005555' });
  await addVendor('pty_juliet', 'Juliet Paper');
  await addVendor('pty_kilo', 'Kilo Freight');
  await addVendor('pty_lima', 'Lima Glass', { routing: '121000248', account: '1110006666' });
  await addVendor('pty_mike', 'Mike Metals', { routing: '026009593', account: '1110007777' });
  await addVendor('pty_november', 'November Parts', { routing: '322271627', account: '1110008888' });

  billId.a1 = await addBill('pty_alpha', 'A-1', '1000.00');
  billId.a2 = await addBill('pty_alpha', 'A-2', '250.50');
  billId.b1 = await addBill('pty_bravo', 'B-1', '400.00');
  billId.c1 = await addBill('pty_charlie', 'C-1', '300.00');
  billId.d1 = await addBill('pty_delta', 'D-1', '800.00');
  billId.d2 = await addBill('pty_delta', 'D-2', '60.00');
  billId.e1 = await addBill('pty_echo', 'E-1', '5000.00');
  billId.f1 = await addBill('pty_foxtrot', 'F-1', '120.00');
  billId.g1 = await addBill('pty_golf', 'G-1', '150.00');
  billId.h1 = await addBill('pty_hotel', 'H-1', '75.25');
  billId.i1 = await addBill('pty_india', 'I-1', '90.00');
  billId.j1 = await addBill('pty_juliet', 'J-1', '20.00');
  billId.k1 = await addBill('pty_kilo', 'K-1', '30.00');
  billId.l1 = await addBill('pty_lima', 'L-1', '40.00');
  billId.m1 = await addBill('pty_mike', 'M-1', '45.00');
  billId.n1 = await addBill('pty_november', 'N-1', '55.50');
}, 180_000);

// ── Settings ────────────────────────────────────────────────────────────────

describe('payment settings of a bank account', () => {
  it('starts with defaults and says what is missing', async () => {
    const res = await runs(`/settings/${bankId}`);
    expect(res.status, res.text).toBe(200);
    expect(res.data).toMatchObject({
      bankAccountId: bankId,
      nextCheckNumber: null,
      routingNumber: '021000021',
      accountNumberLast4: '6789',
      checkSettings: { layout: 'voucher_top', printMicr: false },
      achSettings: { balanced: false, sameDayAllowed: false, defaultSecCode: 'CCD', holdWindowDays: 10 },
      positivePayFormat: 'generic_csv',
    });
    expect(res.data.readiness.checks).toEqual({ ready: false, missing: ['nextCheckNumber'] });
    // The entity's EIN and the bank's routing number fill the ACH gaps.
    expect(res.data.effectiveAch).toMatchObject({ immediateDestination: '021000021', companyIdentification: '1123456789' });
    expect(res.data.readiness.ach.ready).toBe(true);
    expect(res.text).not.toContain('000123456789');
  });

  it('validates what it stores', async () => {
    const badRouting = await runs(`/settings/${bankId}`, { method: 'PUT', body: { achSettings: { immediateDestination: '021000022' } } });
    expect(badRouting.status).toBe(400);
    const badNumerator = await runs(`/settings/${bankId}`, { method: 'PUT', body: { checkSettings: { fractionalNumerator: 'abc' } } });
    expect(badNumerator.status).toBe(400);
    const reserved = await runs(`/settings/${bankId}`, { method: 'PUT', body: { achSettings: { entryDescription: 'PAYROLL' } } });
    expect(reserved.status).toBe(400);
    const badEin = await runs(`/settings/${bankId}`, { method: 'PUT', body: { achSettings: { ein: '12-345' } } });
    expect(badEin.status).toBe(400);
  });

  it('needs banking:manage to change and merges section by section', async () => {
    const denied = await runs(`/settings/${bankId}`, { method: 'PUT', body: { nextCheckNumber: 1001 }, perms: CREATOR_PERMS });
    expect(denied.status).toBe(403);

    const first = await runs(`/settings/${bankId}`, {
      method: 'PUT',
      body: {
        nextCheckNumber: 1001,
        checkSettings: { layout: 'voucher_top', printMicr: true, fractionalNumerator: '90-7162', bankName: 'JPMorgan Chase', signatureLineText: 'Authorized signature' },
        achSettings: { ein: '123456789', sameDayAllowed: true, companyName: 'Runs Studio' },
      },
    });
    expect(first.status, first.text).toBe(200);
    expect(first.data.nextCheckNumber).toBe(1001);
    expect(first.data.achSettings).toMatchObject({ companyIdentification: '1123456789', sameDayAllowed: true, companyName: 'Runs Studio' });

    const second = await runs(`/settings/${bankId}`, { method: 'PUT', body: { checkSettings: { alignment: { dy: 4 } }, achSettings: { sameDayAllowed: false } } });
    expect(second.data.checkSettings).toMatchObject({ printMicr: true, fractionalNumerator: '90-7162', alignment: { dy: 4 } });
    expect(second.data.achSettings).toMatchObject({ companyName: 'Runs Studio', sameDayAllowed: false });
    expect(second.data.readiness.checks.ready).toBe(true);

    const cleared = await runs(`/settings/${bankId}`, { method: 'PUT', body: { checkSettings: { bankName: null } } });
    expect(cleared.data.checkSettings.bankName).toBeNull();
    expect(cleared.data.checkSettings.fractionalNumerator).toBe('90-7162');

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'settings_updated'));
    expect(audit.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audit)).not.toContain('1123456789');
  });
});

// ── Payable bills ───────────────────────────────────────────────────────────

describe('payable bills', () => {
  it('lists approved bills by vendor with ACH readiness', async () => {
    const res = await runs('/payable-bills', { perms: ['bills:read'] });
    expect(res.status, res.text).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byName: Record<string, any> = Object.fromEntries((res.data as Array<{ name: string }>).map((v) => [v.name, v]));
    expect(Object.keys(byName)).toContain('Alpha Roofing LLC');
    expect(byName['Alpha Roofing LLC']).toMatchObject({ totalDue: '1250.50', ach: { ready: true, verified: true, holdActive: false, last4: '1111', accountType: 'checking' } });
    expect(byName['Alpha Roofing LLC'].bills).toHaveLength(2);
    expect(byName['Bravo Lumber Inc'].ach).toMatchObject({ ready: true, verified: false, holdActive: true, held: true });
    expect(byName['Charlie Supply'].ach).toMatchObject({ ready: false, hasRouting: false, hasAccount: false });
    expect(byName['Echo Freelance'].backupWithholding.applies).toBe(true);
    expect(byName['Alpha Roofing LLC'].backupWithholding).toEqual({ applies: false });
    expect(byName['Alpha Roofing LLC'].ach.prenote).toBe('needed');
    // Bank numbers never appear, only the last four.
    expect(res.text).not.toContain('5550001111');
    expect(res.text).not.toContain('121000248');
  });

  it('filters by vendor and due date', async () => {
    const one = await runs('/payable-bills?partyId=pty_delta', { perms: ['bills:read'] });
    expect(one.data).toHaveLength(1);
    expect(one.data[0].totalDue).toBe('860.00');
    const none = await runs(`/payable-bills?dueBefore=${isoDay(daysFromNow(-30))}`, { perms: ['bills:read'] });
    expect(none.data).toEqual([]);
    const bad = await runs('/payable-bills?dueBefore=soon', { perms: ['bills:read'] });
    expect(bad.status).toBe(400);
  });
});

// ── ACH runs ────────────────────────────────────────────────────────────────

describe('an ACH run', () => {
  let runId: string;
  let paymentAlpha: string;
  let paymentDelta: string;

  it('is planned with holds on the vendors that need attention', async () => {
    const res = await createRun({
      method: 'ach',
      items: [
        { billId: billId.a1, amount: 1000 },
        { billId: billId.a2, amount: 250.5 },
        { billId: billId.b1, amount: 400 },
        { billId: billId.c1, amount: 300 },
        { billId: billId.d1, amount: '800.00' },
      ],
    });
    expect(res.status, res.text).toBe(201);
    runId = res.data.id;
    expect(res.data).toMatchObject({ status: 'draft', method: 'ach', requiredApprovals: 2, totalAmount: '2050.50', heldAmount: '700.00', paymentCount: 2, createdBy: CREATOR });
    const codes = Object.fromEntries((res.data.holds as Array<{ partyName: string; code: string }>).map((h) => [h.partyName, h.code]));
    expect(codes).toEqual({ 'Bravo Lumber Inc': 'bank_details_changed', 'Charlie Supply': 'no_bank_details' });
    expect(res.text).not.toContain('7770002222');
    expect(events.some((e) => e.eventType === 'payment_run:created' && e.entityId === runId)).toBe(true);
  });

  it('refuses fewer than two approvals without banking:manage, and records it when a manager lowers them', async () => {
    const denied = await createRun({ method: 'ach', requiredApprovals: 1, items: [{ billId: billId.f1, amount: 120 }] });
    expect(denied.status).toBe(403);
    expect(denied.error?.code).toBe('APPROVALS_REQUIRE_MANAGE');

    const manager = await createRun({ method: 'ach', requiredApprovals: 1, items: [{ billId: billId.f1, amount: 120 }] }, 'user_boss', ['*']);
    expect(manager.status, manager.text).toBe(201);
    expect(manager.data.requiredApprovals).toBe(1);
    const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, manager.data.id), eq(schema.auditLog.action, 'created')));
    expect(audit[0]?.changes).toMatchObject({ approvalsLowered: { new: true } });
    const gone = await runs(`/${manager.data.id}`, { method: 'DELETE', perms: CREATOR_PERMS });
    expect(gone.status).toBe(204);
  });

  it('validates the bills and amounts', async () => {
    const over = await createRun({ method: 'ach', items: [{ billId: billId.f1, amount: 500 }] });
    expect(over.status).toBe(400);
    expect(over.error?.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    const dupe = await createRun({ method: 'ach', items: [{ billId: billId.f1, amount: 10 }, { billId: billId.f1, amount: 10 }] });
    expect(dupe.error?.code).toBe('DUPLICATE_BILL');
    const missing = await createRun({ method: 'ach', items: [{ billId: 'bil_nope', amount: 10 }] });
    expect(missing.error?.code).toBe('BILL_NOT_FOUND');
    const sameDay = await createRun({ method: 'ach', sameDay: true, items: [{ billId: billId.f1, amount: 10 }] });
    expect(sameDay.error?.code).toBe('SAME_DAY_NOT_ALLOWED');
    const checkWithSec = await createRun({ method: 'check', secCode: 'CCD', items: [{ billId: billId.f1, amount: 10 }] });
    expect(checkWithSec.error?.code).toBe('ACH_ONLY');
    const noNumber = await createRun({ method: 'check', items: [{ billId: billId.f1, amount: 10 }], bankAccountId: 'ba_missing' });
    expect(noNumber.status).toBe(404);
  });

  it('edits only as a draft, then submits', async () => {
    const patched = await runs(`/${runId}`, { method: 'PATCH', body: { notes: 'October vendors' }, perms: CREATOR_PERMS });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.data.notes).toBe('October vendors');

    const submitted = await runs(`/${runId}/submit`, { method: 'POST', user: CREATOR, perms: CREATOR_PERMS });
    expect(submitted.status, submitted.text).toBe(200);
    expect(submitted.data.status).toBe('pending_approval');

    const again = await runs(`/${runId}`, { method: 'PATCH', body: { notes: 'late' }, perms: CREATOR_PERMS });
    expect(again.status).toBe(409);
    expect(again.error?.code).toBe('INVALID_STATE');
    const del = await runs(`/${runId}`, { method: 'DELETE', perms: CREATOR_PERMS });
    expect(del.status).toBe(409);
  });

  it('edits the bills, date and approvals of a draft and works the holds out again', async () => {
    const created = await createRun({ method: 'ach', items: [{ billId: billId.f1, amount: 120 }] });
    expect(created.status, created.text).toBe(201);
    const id = created.data.id as string;

    const needsManage = await runs(`/${id}`, { method: 'PATCH', body: { requiredApprovals: 1 }, perms: CREATOR_PERMS });
    expect(needsManage.status).toBe(403);
    const tooMuch = await runs(`/${id}`, { method: 'PATCH', body: { items: [{ billId: billId.f1, amount: 121 }] }, perms: CREATOR_PERMS });
    expect(tooMuch.error?.code).toBe('AMOUNT_EXCEEDS_BALANCE');

    const patched = await runs(`/${id}`, {
      method: 'PATCH',
      body: { paymentDate: isoDay(daysFromNow(9)), items: [{ billId: billId.f1, amount: 100 }, { billId: billId.e1, amount: 5000 }], requiredApprovals: 1 },
      perms: ['*'],
    });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.data).toMatchObject({ paymentDate: isoDay(daysFromNow(9)), requiredApprovals: 1, totalAmount: '100.00', heldAmount: '5000.00', paymentCount: 1 });
    expect(patched.data.holds.map((h: { code: string }) => h.code)).toEqual(['backup_withholding']);
    expect(patched.data.history.map((h: { action: string }) => h.action)).toEqual(['created', 'updated']);

    const gone = await runs(`/${id}`, { method: 'DELETE', perms: CREATOR_PERMS });
    expect(gone.status).toBe(204);
    expect((await runs(`/${id}`, { perms: ['bills:read'] })).status).toBe(404);
    expect(events.some((e) => e.eventType === 'payment_run:deleted' && e.entityId === id)).toBe(true);
  });

  it('refuses a user without banking:manage, and the same person approving twice', async () => {
    const denied = await runs(`/${runId}/approve`, { method: 'POST', user: CREATOR, perms: CREATOR_PERMS });
    expect(denied.status).toBe(403);

    const first = await approve(runId, CREATOR);
    expect(first.status, first.text).toBe(200);
    expect(first.data).toMatchObject({ approved: false, approvalCount: 1, requiredApprovals: 2 });
    expect(first.data.payments).toEqual([]);
    expect(first.data.run.status).toBe('pending_approval');
    const none = await db.select().from(schema.payments).where(eq(schema.payments.paymentRunId, runId));
    expect(none).toHaveLength(0);

    const again = await approve(runId, CREATOR);
    expect(again.status).toBe(409);
    expect(again.error?.code).toBe('ALREADY_APPROVED');
  });

  it('makes one payment per vendor when the second person approves', async () => {
    const second = await approve(runId, APPROVER_A);
    expect(second.status, second.text).toBe(200);
    expect(second.data).toMatchObject({ approved: true, approvalCount: 2 });
    expect(second.data.run).toMatchObject({ status: 'approved', paymentCount: 2, totalAmount: '2050.50' });
    expect(second.data.run.approvals.map((a: { userId: string }) => a.userId)).toEqual([CREATOR, APPROVER_A]);

    const payments = await db.select().from(schema.payments).where(eq(schema.payments.paymentRunId, runId));
    expect(payments).toHaveLength(2);
    const alpha = payments.find((p) => p.contactId === 'pty_alpha')!;
    const delta = payments.find((p) => p.contactId === 'pty_delta')!;
    paymentAlpha = alpha.id;
    achPaymentId = alpha.id;
    paymentDelta = delta.id;
    expect(alpha).toMatchObject({ amount: '1250.50', paymentMethod: 'ach', type: 'sent', bankAccountId: bankId, checkNumber: null, checkStatus: null });
    expect(delta.amount).toBe('800.00');
    expect(alpha.journalEntryId).toBeTruthy();

    const allocations = await db.select().from(schema.paymentAllocations).where(eq(schema.paymentAllocations.paymentId, alpha.id));
    expect(allocations.map((a) => a.amount).sort()).toEqual(['1000.00', '250.50']);

    expect(await billOf(billId.a1)).toMatchObject({ status: 'paid', balanceDue: '0.00' });
    expect(await billOf(billId.a2)).toMatchObject({ status: 'paid', balanceDue: '0.00' });
    expect(await billOf(billId.d1)).toMatchObject({ status: 'paid' });
    // Held vendors are not paid.
    expect(await billOf(billId.b1)).toMatchObject({ status: 'approved', balanceDue: '400.00' });
    expect(await billOf(billId.c1)).toMatchObject({ status: 'approved', balanceDue: '300.00' });

    const types = events.map((e) => e.eventType);
    expect(types).toContain('payment_run:approved');
    expect(types.filter((t) => t === 'payment:created').length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(events)).not.toContain('5550001111');
  });

  it('approving again does nothing more', async () => {
    const res = await approve(runId, APPROVER_B);
    expect(res.status).toBe(409);
    expect(res.error?.code).toBe('INVALID_STATE');
    expect(await db.select().from(schema.payments).where(eq(schema.payments.paymentRunId, runId))).toHaveLength(2);
  });

  it('makes a NACHA file that verifies, logs every account number it reads, and marks the run exported', async () => {
    const denied = await runs(`/${runId}/nacha`, { perms: CREATOR_PERMS });
    expect(denied.status).toBe(403);

    const res = await runs(`/${runId}/nacha`, { user: APPROVER_B, perms: MANAGER_PERMS });
    expect(res.status, res.text).toBe(200);
    const { fileName, content, summary } = res.data;
    expect(fileName).toBe(`ach-${PAY_DATE}-${runId}.ach`);
    expect(summary).toMatchObject({
      runId,
      paymentCount: 2,
      prenoteCount: 0,
      batchCount: 1,
      balanced: false,
      totalCredit: '2050.50',
      totalDebit: '0.00',
      originator: { immediateDestination: '021000021', companyIdentification: '1123456789', immediateOrigin: '1123456789' },
    });
    expect(summary.payments.map((p: { name: string; secCode: string }) => [p.name, p.secCode])).toEqual([
      ['Alpha Roofing LLC', 'CCD'],
      ['Delta Design Co', 'CCD'],
    ]);
    expect(summary.payments.every((p: { traceNumber: string | null }) => p.traceNumber)).toBe(true);

    const verified = verifyNachaFile(content);
    expect(verified).toMatchObject({ ok: true, batchCount: 1, totalCreditCents: 205050, totalDebitCents: 0 });
    const lines = (content as string).split('\r\n');
    expect(lines.every((l) => l.length === 94 || l === '')).toBe(true);
    expect(lines[0]).toMatch(/^101 021000021 ?1123456789/);
    // Alpha: checking credit (22) to 121000248 account 5550001111. Delta: savings credit (32).
    expect(lines.some((l) => l.startsWith('622121000248') && l.includes('5550001111') && l.includes('0000125050'))).toBe(true);
    expect(lines.some((l) => l.startsWith('632026009593') && l.includes('987654321') && l.includes('0000080000'))).toBe(true);
    // Neither the held vendors nor their accounts are in the file.
    expect(content).not.toContain('7770002222');

    const reveals = await db.select().from(schema.taxIdReveals).where(eq(schema.taxIdReveals.reason, 'nacha_file'));
    expect(reveals.map((r) => `${r.subjectType}:${r.subjectId}:${r.field}`).sort()).toEqual([
      'party:pty_alpha:ach_account_number',
      'party:pty_delta:ach_account_number',
    ]);
    expect(reveals.every((r) => r.revealedBy === APPROVER_B && r.entityId === entityId)).toBe(true);

    const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, runId));
    expect(run).toMatchObject({ status: 'exported', fileName });
    expect(run.fileGeneratedAt).toBeTruthy();
    expect(events.some((e) => e.eventType === 'payment_run:exported' && e.entityId === runId)).toBe(true);
    // The event carries ids and totals, not bank data.
    expect(JSON.stringify(events)).not.toContain('5550001111');
  });

  it('can make the file again, and completes once the bank has it', async () => {
    const again = await runs(`/${runId}/nacha`);
    expect(again.status, again.text).toBe(200);
    // A second run on the same day takes the next file id modifier.
    expect(again.data.summary.fileIdModifier).toBe('A');

    const notYet = await runs(`/${runId}/complete`, { method: 'POST' });
    expect(notYet.status).toBe(200);
    expect(notYet.data.status).toBe('completed');
    const afterwards = await runs(`/${runId}/nacha`);
    expect(afterwards.status).toBe(409);
  });

  it('shows the whole story of the run', async () => {
    const res = await runs(`/${runId}`, { perms: ['bills:read'] });
    expect(res.status).toBe(200);
    expect(res.data.history.map((h: { action: string }) => h.action)).toEqual([
      'created',
      'updated',
      'submitted',
      'approved',
      'approved',
      'exported',
      'exported',
      'completed',
    ]);
    const alpha = res.data.vendors.find((v: { partyId: string }) => v.partyId === 'pty_alpha');
    expect(alpha).toMatchObject({ held: false, amount: '1250.50', billCount: 2, payment: { id: paymentAlpha, amount: '1250.50' } });
    const bravo = res.data.vendors.find((v: { partyId: string }) => v.partyId === 'pty_bravo');
    expect(bravo).toMatchObject({ held: true, payment: null });
    expect(res.data.vendors.find((v: { partyId: string }) => v.partyId === 'pty_delta').payment.id).toBe(paymentDelta);

    const listed = await runs('?status=completed&method=ach', { perms: ['bills:read'] });
    expect(listed.data.map((r: { id: string }) => r.id)).toContain(runId);
    expect(listed.data[0]).toMatchObject({ bankAccountName: 'Operating', billCount: 5, heldVendorCount: 2 });
    expect(listed.pagination).toMatchObject({ hasMore: false });
  });
});

// ── Holds ───────────────────────────────────────────────────────────────────

describe('holds', () => {
  it('a vendor with changed, unverified bank details stays out until the change is verified', async () => {
    const created = await createRun({ method: 'ach', items: [{ billId: billId.b1, amount: 400 }, { billId: billId.d2, amount: 60 }] });
    expect(created.status, created.text).toBe(201);
    const id = created.data.id as string;
    expect(created.data.paymentCount).toBe(1);

    const refused = await runs(`/${id}/release-hold`, { method: 'POST', body: { partyId: 'pty_bravo', reason: 'The vendor called me' }, perms: MANAGER_PERMS });
    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('HOLD_NOT_RELEASABLE');

    // Someone calls the vendor and verifies the change on the vendor record.
    await db.update(schema.parties).set({ bankDetailsVerifiedAt: new Date(), bankDetailsVerifiedBy: 'user_boss' }).where(eq(schema.parties.id, 'pty_bravo'));
    const released = await runs(`/${id}/release-hold`, { method: 'POST', body: { partyId: 'pty_bravo' }, perms: MANAGER_PERMS });
    expect(released.status, released.text).toBe(200);
    expect(released.data.holds).toEqual([]);
    expect(released.data).toMatchObject({ paymentCount: 2, totalAmount: '460.00' });

    const cancelled = await runs(`/${id}/cancel`, { method: 'POST', perms: CREATOR_PERMS });
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.status).toBe('cancelled');
    // Put the vendor back for the tests that follow.
    await db.update(schema.parties).set({ bankDetailsVerifiedAt: null, bankDetailsVerifiedBy: null }).where(eq(schema.parties.id, 'pty_bravo'));
  });

  it('a bill in another open run holds the vendor until released with a reason; backup withholding too', async () => {
    const first = await createRun({ method: 'ach', items: [{ billId: billId.f1, amount: 120 }] });
    expect(first.status, first.text).toBe(201);
    expect(first.data.holds).toEqual([]);

    const second = await createRun({ method: 'ach', items: [{ billId: billId.f1, amount: 120 }, { billId: billId.e1, amount: 5000 }] });
    expect(second.status, second.text).toBe(201);
    const codes = Object.fromEntries((second.data.holds as Array<{ partyName: string; code: string }>).map((h) => [h.partyName, h.code]));
    expect(codes).toEqual({ 'Foxtrot Partners': 'in_other_run', 'Echo Freelance': 'backup_withholding' });
    expect(second.data.paymentCount).toBe(0);
    const id = second.data.id as string;

    const noReason = await runs(`/${id}/release-hold`, { method: 'POST', body: { partyId: 'pty_foxtrot' }, perms: MANAGER_PERMS, user: APPROVER_A });
    expect(noReason.status).toBe(400);
    expect(noReason.error?.code).toBe('REASON_REQUIRED');
    const needsManage = await runs(`/${id}/release-hold`, { method: 'POST', body: { partyId: 'pty_foxtrot', reason: 'First run was a mistake' }, perms: CREATOR_PERMS });
    expect(needsManage.status).toBe(403);

    const released = await runs(`/${id}/release-hold`, { method: 'POST', body: { partyId: 'pty_foxtrot', reason: 'First run was a mistake' }, perms: MANAGER_PERMS, user: APPROVER_A });
    expect(released.status, released.text).toBe(200);
    expect(released.data).toMatchObject({ paymentCount: 1, totalAmount: '120.00' });
    const foxtrot = released.data.holds.find((h: { partyId: string }) => h.partyId === 'pty_foxtrot');
    expect(foxtrot.released).toMatchObject({ by: APPROVER_A, reason: 'First run was a mistake' });
    expect(released.data.vendors.find((v: { partyId: string }) => v.partyId === 'pty_foxtrot').held).toBe(false);
    expect(released.data.vendors.find((v: { partyId: string }) => v.partyId === 'pty_echo').held).toBe(true);

    // The release survives the hold being worked out again on submit.
    const submitted = await runs(`/${id}/submit`, { method: 'POST', perms: CREATOR_PERMS });
    expect(submitted.status, submitted.text).toBe(200);
    expect(submitted.data.vendors.find((v: { partyId: string }) => v.partyId === 'pty_foxtrot').held).toBe(false);

    const oneApproval = await approve(id, APPROVER_A);
    expect(oneApproval.data).toMatchObject({ approved: false, approvalCount: 1 });
    const rejected = await runs(`/${id}/reject`, { method: 'POST', body: { reason: 'Not this week' }, perms: MANAGER_PERMS, user: APPROVER_A });
    expect(rejected.status, rejected.text).toBe(200);
    expect(rejected.data.status).toBe('draft');
    expect(rejected.data.approvals).toEqual([]);
    const history = rejected.data.history.map((h: { action: string }) => h.action);
    expect(history).toContain('hold_released');
    expect(history.at(-1)).toBe('rejected');

    await runs(`/${id}/cancel`, { method: 'POST', perms: CREATOR_PERMS });
    await runs(`/${first.data.id}/cancel`, { method: 'POST', perms: CREATOR_PERMS });
  });

  it('a vendor whose details change after approval blocks the file until verified', async () => {
    const created = await createRun({ method: 'ach', items: [{ billId: billId.f1, amount: 120 }] });
    expect(created.status, created.text).toBe(201);
    const id = created.data.id as string;
    // Foxtrot is an individual: PPD.
    expect(created.data.holds).toEqual([]);
    await runs(`/${id}/submit`, { method: 'POST', perms: CREATOR_PERMS });
    await approve(id, APPROVER_A);
    const done = await approve(id, APPROVER_B);
    expect(done.data.approved).toBe(true);

    await db
      .update(schema.parties)
      .set({ bankDetailsChangedAt: new Date(Date.now() + 60_000), bankDetailsVerifiedAt: null })
      .where(eq(schema.parties.id, 'pty_foxtrot'));
    const blocked = await runs(`/${id}/nacha`, { perms: MANAGER_PERMS });
    expect(blocked.status).toBe(409);
    expect(blocked.error?.code).toBe('BANK_DETAILS_CHANGED');
    expect(JSON.stringify(blocked.error)).toContain('pty_foxtrot');
    expect(JSON.stringify(blocked.error)).not.toContain('3330004444');

    await db.update(schema.parties).set({ bankDetailsVerifiedAt: new Date(Date.now() + 120_000), bankDetailsVerifiedBy: 'user_boss' }).where(eq(schema.parties.id, 'pty_foxtrot'));
    const ok = await runs(`/${id}/nacha`, { perms: MANAGER_PERMS });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.data.summary.payments[0]).toMatchObject({ name: 'Foxtrot Partners', secCode: 'PPD', amount: '120.00' });
    const batch = (ok.data.content as string).split('\r\n').find((l) => l.startsWith('5'));
    expect(batch).toContain('PPD');
    expect(ok.data.summary.fileIdModifier).toBe('B');
  });
});

// ── Prenotes ────────────────────────────────────────────────────────────────

describe('prenotes', () => {
  it('a new account gets a $0 prenote in the next file and its payment waits', async () => {
    const on = await runs(`/settings/${bankId}`, { method: 'PUT', body: { achSettings: { requirePrenotes: true } } });
    expect(on.status, on.text).toBe(200);

    const created = await createRun({ method: 'ach', items: [{ billId: billId.i1, amount: 90 }, { billId: billId.d2, amount: 60 }] });
    expect(created.status, created.text).toBe(201);
    const id = created.data.id as string;
    const codes = Object.fromEntries((created.data.holds as Array<{ partyName: string; code: string }>).map((h) => [h.partyName, h.code]));
    expect(codes).toEqual({ 'India Tools': 'prenote_required' });
    expect(created.data.paymentCount).toBe(1);

    await runs(`/${id}/submit`, { method: 'POST', perms: CREATOR_PERMS });
    await approve(id, APPROVER_A);
    expect((await approve(id, APPROVER_B)).data.approved).toBe(true);
    expect(await billOf(billId.i1)).toMatchObject({ status: 'approved', balanceDue: '90.00' });

    const file = await runs(`/${id}/nacha`, { perms: MANAGER_PERMS, user: APPROVER_B });
    expect(file.status, file.text).toBe(200);
    expect(file.data.summary).toMatchObject({ paymentCount: 1, prenoteCount: 1, totalCredit: '60.00' });
    expect(file.data.summary.prenotes[0]).toMatchObject({ name: 'India Tools' });
    const lines = (file.data.content as string).split('\r\n');
    expect(lines.some((l) => l.startsWith('623322271627') && l.includes('2220005555') && l.includes('0000000000'))).toBe(true);
    expect(verifyNachaFile(file.data.content).ok).toBe(true);

    await runs(`/${id}/complete`, { method: 'POST' });
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { achSettings: { requirePrenotes: false } } });
  });

  it('a prenote-only run still goes through', async () => {
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { achSettings: { requirePrenotes: true } } });
    // India's prenote went out just now: its payment is pending until three banking days pass.
    const created = await createRun({ method: 'ach', items: [{ billId: billId.i1, amount: 90 }] });
    expect(created.data.holds.map((h: { code: string }) => h.code)).toEqual(['prenote_pending']);
    const id = created.data.id as string;
    await runs(`/${id}/submit`, { method: 'POST', perms: CREATOR_PERMS });
    await approve(id, APPROVER_A);
    const nothing = await approve(id, APPROVER_B);
    expect(nothing.status).toBe(409);
    expect(nothing.error?.code).toBe('NOTHING_TO_PAY');
    await runs(`/${id}/cancel`, { method: 'POST', perms: CREATOR_PERMS });
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { achSettings: { requirePrenotes: false } } });
  });
});

// ── File options ────────────────────────────────────────────────────────────

describe('NACHA file options', () => {
  async function approvedRun(items: Array<{ billId: string; amount: number }>, extra: Record<string, unknown> = {}) {
    const created = await createRun({ method: 'ach', items, ...extra });
    expect(created.status, created.text).toBe(201);
    const id = created.data.id as string;
    expect((await runs(`/${id}/submit`, { method: 'POST', perms: CREATOR_PERMS })).status).toBe(200);
    await approve(id, APPROVER_A);
    expect((await approve(id, APPROVER_B)).data.approved).toBe(true);
    return id;
  }

  it('refuses a file with a problem the bank would reject, and keeps the run approved', async () => {
    const id = await approvedRun([{ billId: billId.l1, amount: 40 }]);
    // The routing number is damaged without the change being logged as a bank-detail change.
    await db.update(schema.parties).set({ achRoutingNumber: '121000249' }).where(eq(schema.parties.id, 'pty_lima'));

    const res = await runs(`/${id}/nacha`, { perms: MANAGER_PERMS });
    expect(res.status).toBe(422);
    expect(res.error?.code).toBe('NACHA_INVALID');
    const details = res.error?.details as { errors: Array<{ code: string; paymentId?: string }> };
    expect(details.errors.map((e) => e.code)).toContain('invalid_routing_checksum');
    expect(details.errors[0]?.paymentId).toBeTruthy();
    const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, id));
    expect(run.status).toBe('approved');
    expect(run.fileName).toBeNull();

    await db.update(schema.parties).set({ achRoutingNumber: '121000248' }).where(eq(schema.parties.id, 'pty_lima'));
    expect((await runs(`/${id}/nacha`, { perms: MANAGER_PERMS })).status).toBe(200);
  });

  it('asks for Same Day ACH and sends remittance with CCD+', async () => {
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { achSettings: { sameDayAllowed: true } } });
    const id = await approvedRun([{ billId: billId.m1, amount: 45 }], { sameDay: true, secCode: 'CCD+' });
    const res = await runs(`/${id}/nacha`, { perms: MANAGER_PERMS });
    expect(res.status, res.text).toBe(200);
    expect(res.data.summary).toMatchObject({ sameDay: true, totalCredit: '45.00', payments: [{ name: 'Mike Metals', secCode: 'CCD+' }] });
    const lines = (res.data.content as string).split('\r\n');
    const batch = lines.find((l) => l.startsWith('5'))!;
    expect(batch).toContain('CCD');
    expect(batch).toContain('SD1700');
    // The effective entry date is the file's own date (or the next banking day when the file is made on a closed day).
    expect(res.data.summary.effectiveEntryDate >= res.data.summary.fileDate).toBe(true);
    const addenda = lines.find((l) => l.startsWith('705'))!;
    expect(addenda).toContain('RMR*IV*M-1**45.00');
    expect(verifyNachaFile(res.data.content).ok).toBe(true);
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { achSettings: { sameDayAllowed: false } } });
  });

  it('adds the offsetting debit of a balanced file and logs the company account number too', async () => {
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { achSettings: { balanced: true } } });
    const id = await approvedRun([{ billId: billId.n1, amount: 55.5 }]);
    const before = await db.select().from(schema.taxIdReveals).where(eq(schema.taxIdReveals.subjectType, 'bank_account'));
    const res = await runs(`/${id}/nacha`, { perms: MANAGER_PERMS });
    expect(res.status, res.text).toBe(200);
    expect(res.data.summary).toMatchObject({ balanced: true, totalCredit: '55.50', totalDebit: '55.50' });
    const lines = (res.data.content as string).split('\r\n');
    expect(lines.find((l) => l.startsWith('5'))!.startsWith('5200')).toBe(true);
    expect(lines.some((l) => l.startsWith('627021000021') && l.includes('000123456789') && l.includes('0000005550'))).toBe(true);
    expect(verifyNachaFile(res.data.content)).toMatchObject({ ok: true, totalDebitCents: 5550, totalCreditCents: 5550 });

    const after = await db.select().from(schema.taxIdReveals).where(eq(schema.taxIdReveals.subjectType, 'bank_account'));
    expect(after.length - before.length).toBe(1);
    expect(after.at(-1)).toMatchObject({ subjectId: bankId, reason: 'nacha_file' });
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { achSettings: { balanced: false } } });
  });
});

// ── Check runs ──────────────────────────────────────────────────────────────

describe('a check run', () => {
  let runId: string;
  const payment: Record<string, string> = {};

  it('needs a next check number', async () => {
    const other = await callRoutes('/api/bank-accounts', bankAccountsRoutes, '/api/bank-accounts', {
      method: 'POST',
      body: { name: 'Payroll', currency: 'USD', accountType: 'checking', routingNumber: '121000248', accountNumber: '8887776666' },
    });
    const res = await createRun({ method: 'check', bankAccountId: other.data.id, items: [{ billId: billId.g1, amount: 150 }] });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe('CHECK_NUMBER_REQUIRED');
  });

  it('numbers the checks in vendor order when approved', async () => {
    const created = await createRun({ method: 'check', items: [{ billId: billId.h1, amount: 75.25 }, { billId: billId.g1, amount: 150 }] });
    expect(created.status, created.text).toBe(201);
    runId = created.data.id;
    expect(created.data).toMatchObject({ requiredApprovals: 1, paymentCount: 2, totalAmount: '225.25', secCode: null, sameDay: false });
    await runs(`/${runId}/submit`, { method: 'POST', perms: CREATOR_PERMS });

    const done = await approve(runId, APPROVER_A);
    expect(done.status, done.text).toBe(200);
    expect(done.data.approved).toBe(true);
    const payments = await db.select().from(schema.payments).where(eq(schema.payments.paymentRunId, runId));
    const byName = Object.fromEntries(payments.map((p) => [p.contactId, p]));
    expect(byName.pty_golf).toMatchObject({ checkNumber: '1001', checkStatus: 'to_print', paymentMethod: 'check', amount: '150.00', checkPrintedAt: null });
    expect(byName.pty_hotel).toMatchObject({ checkNumber: '1002', checkStatus: 'to_print', amount: '75.25' });
    payment.golf = byName.pty_golf!.id;
    payment.hotel = byName.pty_hotel!.id;
    const [bank] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, bankId));
    expect(bank.nextCheckNumber).toBe(1003);
    expect(done.data.payments.map((p: { checkNumber: string }) => p.checkNumber)).toEqual(['1001', '1002']);

    const noFile = await runs(`/${runId}/nacha`, { perms: MANAGER_PERMS });
    expect(noFile.status).toBe(409);
    expect(noFile.error?.code).toBe('NOT_AN_ACH_RUN');
  });

  it('gives the platform everything it prints a check from, and logs the MICR reveal', async () => {
    const before = await db.select().from(schema.taxIdReveals).where(eq(schema.taxIdReveals.reason, 'check_micr'));
    expect(before).toHaveLength(0);

    const res = await runs(`/${runId}/checks`, { perms: MANAGER_PERMS, user: APPROVER_A });
    expect(res.status, res.text).toBe(200);
    const data = res.data;
    expect(data.run).toMatchObject({ id: runId, status: 'approved', paymentDate: PAY_DATE });
    expect(data.layout).toMatchObject({ id: 'voucher_top' });
    expect(data.layout.faces).toHaveLength(1);
    // The alignment from the settings is applied to the layout.
    expect(data.settings).toMatchObject({ layout: 'voucher_top', printMicr: true, signatureLineText: 'Authorized signature' });
    expect(data.payer).toMatchObject({ name: 'Runs Studio, LLC', addressLines: ['1 Congress Ave', 'Austin, TX 78701'] });
    expect(data.bank).toMatchObject({ accountNumberLast4: '6789' });

    expect(data.checks).toHaveLength(2);
    const [golf, hotel] = data.checks;
    expect(golf).toMatchObject({
      paymentId: payment.golf,
      checkNumber: '1001',
      checkStatus: 'to_print',
      date: PAY_DATE,
      amount: '150.00',
      amountInWords: 'One hundred fifty and 00/100',
      courtesyAmount: '$**150.00',
      memo: 'Bill G-1',
      fractionalRouting: '90-7162/0210',
      payee: { partyId: 'pty_golf', name: 'Golf Towing', addressLines: ['12 Main St', 'Austin, TX 78701'] },
    });
    expect(golf.dateDisplay).toBe(`${PAY_DATE.slice(5, 7)}/${PAY_DATE.slice(8, 10)}/${PAY_DATE.slice(0, 4)}`);
    expect(golf.micr.fields).toEqual({
      auxOnUs: '⑈001001⑈',
      transit: '⑆021000021⑆',
      onUs: '000123456789⑈',
    });
    expect(golf.micr.line).toBe('⑈001001⑈ ⑆021000021⑆ 000123456789⑈');
    expect(golf.micr.fieldsAsFontLetters.transit).toBe('A021000021A');
    expect(golf.voucher.rows).toEqual([
      { date: '2026-09-01', reference: 'G-1', description: null, amount: '150.00', billTotal: '150.00', discount: null },
    ]);
    expect(golf.voucher.total).toBe('150.00');
    expect(hotel).toMatchObject({ checkNumber: '1002', amount: '75.25', amountInWords: 'Seventy-five and 25/100', courtesyAmount: '$**75.25' });

    const reveals = await db.select().from(schema.taxIdReveals).where(eq(schema.taxIdReveals.reason, 'check_micr'));
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({ subjectType: 'bank_account', subjectId: bankId, field: 'account_number', revealedBy: APPROVER_A });
  });

  it('prints preprinted stock without touching the account number', async () => {
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { checkSettings: { printMicr: false } } });
    const before = (await db.select().from(schema.taxIdReveals)).length;
    const res = await runs(`/${runId}/checks`, { perms: MANAGER_PERMS });
    expect(res.status, res.text).toBe(200);
    expect(res.data.checks.every((c: { micr: unknown }) => c.micr === null)).toBe(true);
    expect(res.data.checks[0].fractionalRouting).toBe('90-7162/0210');
    expect(res.text).not.toContain('000123456789');
    expect((await db.select().from(schema.taxIdReveals)).length).toBe(before);
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { checkSettings: { printMicr: true } } });
  });

  it('marks checks printed and completes the run when none are left to print', async () => {
    const wrong = await runs(`/${runId}/checks/printed`, { method: 'POST', body: { paymentIds: ['pay_nope'] }, perms: MANAGER_PERMS });
    expect(wrong.status).toBe(400);
    expect(wrong.error?.code).toBe('PAYMENT_NOT_IN_RUN');

    const first = await runs(`/${runId}/checks/printed`, { method: 'POST', body: { paymentIds: [payment.golf] }, perms: MANAGER_PERMS });
    expect(first.status, first.text).toBe(200);
    expect(first.data.printed).toEqual([payment.golf]);
    expect(first.data.run.status).toBe('approved');

    const rest = await runs(`/${runId}/checks/printed`, { method: 'POST', body: { paymentIds: [payment.golf, payment.hotel] }, perms: MANAGER_PERMS });
    expect(rest.data).toMatchObject({ printed: [payment.hotel], alreadyPrinted: [payment.golf] });
    expect(rest.data.run.status).toBe('completed');

    const [row] = await db.select().from(schema.payments).where(eq(schema.payments.id, payment.golf));
    expect(row.checkStatus).toBe('printed');
    expect(row.checkPrintedAt).toBeTruthy();

    // Nothing to print any more; the printed checks can still be asked for.
    const none = await runs(`/${runId}/checks`, { perms: MANAGER_PERMS });
    expect(none.data.checks).toEqual([]);
    const all = await runs(`/${runId}/checks?all=true`, { perms: MANAGER_PERMS });
    expect(all.data.checks).toHaveLength(2);
  });

  it('voids a check and reissues it under the next number', async () => {
    const denied = await runs(`/checks/${payment.golf}/void`, { method: 'POST', body: { reason: 'Printer jam', reissue: true }, perms: CREATOR_PERMS });
    expect(denied.status).toBe(403);
    const noReason = await runs(`/checks/${payment.golf}/void`, { method: 'POST', body: { reason: '' }, perms: MANAGER_PERMS });
    expect(noReason.status).toBe(400);

    const res = await runs(`/checks/${payment.golf}/void`, { method: 'POST', body: { reason: 'Printer jam', reissue: true }, perms: MANAGER_PERMS, user: APPROVER_B });
    expect(res.status, res.text).toBe(200);
    expect(res.data.voided).toMatchObject({ paymentId: payment.golf, checkNumber: '1001', amount: '150.00', runId });
    expect(res.data.replacement).toMatchObject({ checkNumber: '1003', amount: '150.00', checkStatus: 'to_print' });
    expect(res.data.run.status).toBe('approved');
    payment.golfReissue = res.data.replacement.paymentId;

    const [old] = await db.select().from(schema.payments).where(eq(schema.payments.id, payment.golf));
    expect(old.deletedAt).toBeTruthy();
    expect(old.checkStatus).toBe('voided');
    expect(old.checkNumber).toBe('1001');
    expect(old.notes).toContain('Printer jam');
    const [replacement] = await db.select().from(schema.payments).where(eq(schema.payments.id, payment.golfReissue));
    expect(replacement).toMatchObject({ checkNumber: '1003', checkStatus: 'to_print', paymentRunId: runId, contactId: 'pty_golf', amount: '150.00' });
    // The bill was reopened by the void and paid again by the replacement.
    expect(await billOf(billId.g1)).toMatchObject({ status: 'paid', balanceDue: '0.00' });
    const [bank] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, bankId));
    expect(bank.nextCheckNumber).toBe(1004);

    const again = await runs(`/checks/${payment.golf}/void`, { method: 'POST', body: { reason: 'Again' }, perms: MANAGER_PERMS });
    expect(again.status).toBe(409);
    expect(again.error?.code).toBe('ALREADY_VOIDED');

    const types = events.map((e) => e.eventType);
    expect(types).toContain('payment:deleted');
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'check_voided'));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to void a check that has cleared the bank', async () => {
    await db.update(schema.payments).set({ checkStatus: 'cleared' }).where(eq(schema.payments.id, payment.hotel));
    const res = await runs(`/checks/${payment.hotel}/void`, { method: 'POST', body: { reason: 'Lost' }, perms: MANAGER_PERMS });
    expect(res.status).toBe(409);
    expect(res.error?.code).toBe('CHECK_CLEARED');
    await db.update(schema.payments).set({ checkStatus: 'printed' }).where(eq(schema.payments.id, payment.hotel));
    const notACheck = await runs(`/checks/${achPaymentId}/void`, { method: 'POST', body: { reason: 'Oops' }, perms: MANAGER_PERMS });
    expect(notACheck.status).toBe(404);
  });

  it('keeps a register with voided checks and the numbers in order', async () => {
    const res = await runs(`/check-register?bankAccountId=${bankId}`, { perms: ['banking:read'] });
    expect(res.status, res.text).toBe(200);
    expect(res.data.map((r: { checkNumber: string; status: string }) => [r.checkNumber, r.status])).toEqual([
      ['1001', 'voided'],
      ['1002', 'printed'],
      ['1003', 'to_print'],
    ]);
    expect(res.data[0]).toMatchObject({ payeeName: 'Golf Towing', amount: '150.00', runId, runStatus: 'approved' });
    expect(res.data[0].voidedAt).toBeTruthy();

    const voided = await runs(`/check-register?bankAccountId=${bankId}&status=voided`, { perms: ['banking:read'] });
    expect(voided.data).toHaveLength(1);
    expect(voided.pagination).toMatchObject({ totalCount: 1, hasMore: false });
    const dated = await runs(`/check-register?bankAccountId=${bankId}&from=${isoDay(daysFromNow(30))}`, { perms: ['banking:read'] });
    expect(dated.data).toEqual([]);

    const body = JSON.parse(res.text) as { summary: Record<string, { count: number; total: string }> };
    expect(body.summary).toMatchObject({ voided: { count: 1, total: '150.00' }, printed: { count: 1, total: '75.25' }, to_print: { count: 1, total: '150.00' } });

    const page = await runs(`/check-register?bankAccountId=${bankId}&limit=2`, { perms: ['banking:read'] });
    expect(page.data).toHaveLength(2);
    expect(page.pagination).toMatchObject({ hasMore: true, totalCount: 3 });
    const next = await runs(`/check-register?bankAccountId=${bankId}&limit=2&cursor=${page.pagination?.cursor as string}`, { perms: ['banking:read'] });
    expect(next.data.map((r: { checkNumber: string }) => r.checkNumber)).toEqual(['1003']);
  });

  it('never lets the next check number go back', async () => {
    const back = await runs(`/settings/${bankId}`, { method: 'PUT', body: { nextCheckNumber: 1003 } });
    expect(back.status).toBe(409);
    expect(back.error).toMatchObject({ code: 'CHECK_NUMBER_IN_USE', details: { highestUsed: 1003 } });
    const forward = await runs(`/settings/${bankId}`, { method: 'PUT', body: { nextCheckNumber: 1010 } });
    expect(forward.data.nextCheckNumber).toBe(1010);
    expect(forward.data.highestCheckNumberUsed).toBe(1003);
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { nextCheckNumber: 1004 } });
  });
});

// ── Positive Pay ────────────────────────────────────────────────────────────

describe('Positive Pay', () => {
  it('lists the formats', async () => {
    const res = await runs('/positive-pay/formats', { perms: ['banking:read'] });
    expect(res.status).toBe(200);
    expect(res.data.map((f: { id: string }) => f.id)).toEqual(['generic_csv', 'generic_fixed', 'bofa', 'chase', 'wells_fargo', 'us_bank']);
  });

  it('reports printed checks as issued and voided ones as void, and leaves out checks not printed yet', async () => {
    const denied = await runs(`/positive-pay?bankAccountId=${bankId}`, { perms: CREATOR_PERMS });
    expect(denied.status).toBe(403);

    const res = await runs(`/positive-pay?bankAccountId=${bankId}`, { perms: MANAGER_PERMS, user: APPROVER_A });
    expect(res.status, res.text).toBe(200);
    expect(res.data.format).toBe('generic_csv');
    expect(res.data.counts).toEqual({ records: 2, issued: 1, voided: 1, totalIssued: '75.25', totalVoided: '150.00' });
    const lines = (res.data.content as string).split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('Account Number,Check Number,Issue Date,Amount,Payee,Void');
    expect(lines[1]).toMatch(/^000123456789,1001,\d\d\/\d\d\/\d{4},150\.00,Golf Towing,V$/);
    expect(lines[2]).toMatch(/^000123456789,1002,\d\d\/\d\d\/\d{4},75\.25,Hotel Linen,$/);
    expect(res.data.content).not.toContain('1003');

    const reveals = await db.select().from(schema.taxIdReveals).where(eq(schema.taxIdReveals.reason, 'positive_pay'));
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({ subjectType: 'bank_account', subjectId: bankId, revealedBy: APPROVER_A });
  });

  it('takes the bank account\'s format and a format override', async () => {
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { positivePayFormat: 'us_bank' } });
    const res = await runs(`/positive-pay?bankAccountId=${bankId}`, { perms: MANAGER_PERMS });
    expect(res.status, res.text).toBe(200);
    expect(res.data.format).toBe('us_bank');
    const lines = (res.data.content as string).split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.slice(0, 22)).toBe('0001234567890000001001');
    expect(lines[0]).toContain('CN');
    expect(lines[1]).toContain('IS');

    const csv = await runs(`/positive-pay?bankAccountId=${bankId}&format=generic_fixed`, { perms: MANAGER_PERMS });
    expect(csv.data.format).toBe('generic_fixed');
    const range = await runs(`/positive-pay?bankAccountId=${bankId}&from=${isoDay(daysFromNow(60))}&to=${isoDay(daysFromNow(61))}`, { perms: MANAGER_PERMS });
    expect(range.status).toBe(422);
    expect(range.error?.code).toBe('POSITIVE_PAY_INVALID');
    const unknown = await runs(`/positive-pay?bankAccountId=${bankId}&format=bogus`, { perms: MANAGER_PERMS });
    expect(unknown.status).toBe(400);
    await runs(`/settings/${bankId}`, { method: 'PUT', body: { positivePayFormat: null } });
  });
});

// ── Interrupted approvals ───────────────────────────────────────────────────

describe('an approval that stops partway', () => {
  it('keeps its approvals, never pays a vendor twice and finishes when approved again', async () => {
    const created = await createRun({ method: 'check', items: [{ billId: billId.j1, amount: 20 }, { billId: billId.k1, amount: 30 }] });
    expect(created.status, created.text).toBe(201);
    const id = created.data.id as string;
    await runs(`/${id}/submit`, { method: 'POST', perms: CREATOR_PERMS });

    failure.calls = 0;
    failure.failAfter = 1;
    const broken = await approve(id, APPROVER_A);
    failure.failAfter = null;
    expect(broken.status).toBe(400);
    expect(broken.error?.message).toContain('Simulated failure');

    const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, id));
    expect(run.status).toBe('pending_approval');
    expect(run.approvals?.map((a) => a.userId)).toEqual([APPROVER_A]);
    const half = await db.select().from(schema.payments).where(eq(schema.payments.paymentRunId, id));
    expect(half.map((p) => [p.contactId, p.checkNumber])).toEqual([['pty_juliet', '1004']]);
    expect(await billOf(billId.j1)).toMatchObject({ status: 'paid' });
    expect(await billOf(billId.k1)).toMatchObject({ status: 'approved', balanceDue: '30.00' });

    // Approving again finishes the run (the approval is already in) without a second payment for Juliet.
    const finished = await approve(id, APPROVER_B);
    expect(finished.status, finished.text).toBe(200);
    expect(finished.data.approved).toBe(true);
    expect(finished.data.approvalCount).toBe(1);
    expect(finished.data.payments.map((p: { partyName: string; checkNumber: string; created: boolean }) => [p.partyName, p.checkNumber, p.created])).toEqual([
      ['Juliet Paper', '1004', false],
      ['Kilo Freight', '1005', true],
    ]);
    const payments = await db.select().from(schema.payments).where(eq(schema.payments.paymentRunId, id));
    expect(payments).toHaveLength(2);
    expect(await billOf(billId.j1)).toMatchObject({ status: 'paid', amountPaid: '20.00' });
    expect(await billOf(billId.k1)).toMatchObject({ status: 'paid' });
    expect(finished.data.run).toMatchObject({ status: 'approved', totalAmount: '50.00', paymentCount: 2 });
  });
});

// ── Access ──────────────────────────────────────────────────────────────────

describe('access', () => {
  it('needs bills:read to look at runs and banking:create to plan them', async () => {
    expect((await runs('', { perms: [] })).status).toBe(403);
    expect((await runs('', { perms: ['banking:read'] })).status).toBe(403);
    expect((await createRun({ method: 'check', items: [{ billId: billId.f1, amount: 10 }] }, CREATOR, ['bills:read'])).status).toBe(403);
    expect((await runs('/prn_nope', { perms: ['bills:read'] })).status).toBe(404);
  });

  it('keeps a run to its own accounting entity', async () => {
    const other = await callRoutes('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      body: { name: 'Second LLC', jurisdictionCode: 'US', entityType: 'single_member_llc' },
    });
    const listed = await callRoutes('/api/payment-runs', paymentRunsRoutes, '/api/payment-runs', {
      perms: ['bills:read'],
    });
    expect(listed.data.length).toBeGreaterThan(0);
    // A header for another entity sees none of the first entity's runs.
    const { request } = createTestApp('/api/payment-runs', paymentRunsRoutes, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env: env as any,
      context: { permissions: permissions('bills:read'), tenantDb: db },
    });
    const res = await request('/api/payment-runs', { headers: { 'X-Accounting-Entity-Id': other.data.id } });
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });
});
