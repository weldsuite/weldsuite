/**
 * /api/bank-accounts (pglite): create with and without a ledger account (the
 * chart's own Checking reused, a new asset or card account made), routing and
 * account numbers sealed with only the last four shown, the remembered CSV
 * layout, list filters, update (number changed or cleared, settings merged),
 * the logged reveal, delete, and the refusals: permissions, validation, the
 * ABA check, a ledger account of the wrong kind, no entity, no encryption key.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { bankAccountsRoutes } from './index';

const KEY = `${'0'.repeat(63)}1`;
const ENTITY = 'ent_ba_us';
const OTHER = 'ent_ba_nl';

let db: Database;

interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  perms?: string[];
  entity?: string | null;
  env?: Record<string, unknown>;
}

async function call(path: string, opts: CallOptions = {}) {
  const { request } = createTestApp('/api/bank-accounts', bankAccountsRoutes, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: (opts.env ?? { DATABASE_ENCRYPTION_KEY: KEY }) as any,
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const entity = opts.entity === undefined ? ENTITY : opts.entity;
  const res = await request(`/api/bank-accounts${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(entity ? { 'X-Accounting-Entity-Id': entity } : {}) },
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = res.status === 204 ? '' : await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: { data?: any; error?: { code: string; message: string } } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.status, headers: res.headers, ...json };
}

const csvLayout = {
  dateFormat: 'MDY',
  decimalSeparator: '.',
  thousandsSeparator: ',',
  negativeStyle: 'minus',
  columns: { date: 'Date', description: 'Description', amount: 'Amount' },
  hasHeader: true,
  skipRows: 0,
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.entities).values([
    { id: ENTITY, name: 'Bank US', jurisdictionCode: 'US', baseCurrency: 'USD', locale: 'en-US' },
    { id: OTHER, name: 'Bank NL', jurisdictionCode: 'NL', baseCurrency: 'EUR', locale: 'nl-NL' },
  ]);
  const now = new Date();
  await db.insert(schema.accounts).values([
    { id: 'acc_ba_checking', entityId: ENTITY, code: '1000', name: 'Checking', type: 'asset', subtype: 'bank', normalSide: 'debit', taxLine: 'bs_cash', createdAt: now, updatedAt: now },
    { id: 'acc_ba_savings', entityId: ENTITY, code: '1010', name: 'Savings account', type: 'asset', subtype: 'bank', normalSide: 'debit', createdAt: now, updatedAt: now },
    { id: 'acc_ba_cc', entityId: ENTITY, code: '2100', name: 'Credit Card Payable', type: 'liability', subtype: 'credit_card', normalSide: 'credit', metadata: { systemRole: 'credit_card_payable' }, createdAt: now, updatedAt: now },
    { id: 'acc_ba_rent', entityId: ENTITY, code: '6000', name: 'Rent', type: 'expense', subtype: 'operating_expense', normalSide: 'debit', createdAt: now, updatedAt: now },
    { id: 'acc_ba_nl_bank', entityId: OTHER, code: '1100', name: 'Bank', type: 'asset', subtype: 'bank', normalSide: 'debit', createdAt: now, updatedAt: now },
  ]);
}, 60_000);

describe('POST /api/bank-accounts', () => {
  it('takes over the chart\'s own Checking and seals the account number', async () => {
    const res = await call('', {
      method: 'POST',
      body: { name: 'Operating', accountType: 'checking', routingNumber: '021000021', accountNumber: '1234-5678 9012', unknown: 'dropped' },
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      name: 'Operating',
      accountType: 'checking',
      currency: 'USD',
      ledgerAccountId: 'acc_ba_checking',
      accountNumberLast4: '9012',
      hasAccountNumber: true,
      ledgerAccount: { id: 'acc_ba_checking', code: '1000', name: 'Checking', created: false },
    });
    expect(res.data.accountNumberEncrypted).toBeUndefined();
    expect(res.data.unknown).toBeUndefined();
    const [row] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, res.data.id)).limit(1);
    expect(row?.accountNumberEncrypted).toMatch(/:/);
  });

  it('makes a new asset account once the chart\'s Checking is taken', async () => {
    const res = await call('', { method: 'POST', body: { name: 'Payroll', accountType: 'checking', currency: 'USD', isDefault: true } });
    expect(res.status).toBe(201);
    expect(res.data.ledgerAccount).toMatchObject({ code: '1011', name: 'Payroll', created: true });
    const [ledger] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, res.data.ledgerAccountId)).limit(1);
    expect(ledger).toMatchObject({ type: 'asset', subtype: 'bank', taxLine: 'bs_cash', currency: 'USD' });
  });

  it('puts a card under Credit Card Payable', async () => {
    const res = await call('', { method: 'POST', body: { name: 'Visa', accountType: 'credit_card', nextCheckNumber: 1001 } });
    expect(res.status).toBe(201);
    expect(res.data.ledgerAccount).toMatchObject({ code: '2101', created: true });
    const [ledger] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, res.data.ledgerAccountId)).limit(1);
    expect(ledger).toMatchObject({ type: 'liability', subtype: 'credit_card', parentAccountId: 'acc_ba_cc', normalSide: 'credit' });
  });

  it('links a chosen ledger account, or none at all', async () => {
    const linked = await call('', { method: 'POST', body: { name: 'Reserve', accountType: 'savings', ledgerAccountId: 'acc_ba_savings', importSettings: { csv: csvLayout, note: 'kept' } } });
    expect(linked.status).toBe(201);
    expect(linked.data).toMatchObject({ ledgerAccountId: 'acc_ba_savings', importSettings: { note: 'kept', csv: { dateFormat: 'MDY' } } });
    expect(linked.data.ledgerAccount).toBeUndefined();

    const none = await call('', { method: 'POST', body: { name: 'Petty cash', accountType: 'checking', createLedgerAccount: false, iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' } });
    expect(none.status).toBe(201);
    expect(none.data.ledgerAccountId).toBeNull();
    expect(none.data.hasAccountNumber).toBe(false);

    const plain = await call('', { method: 'POST', body: { name: 'NL bank' }, entity: OTHER });
    expect(plain.status).toBe(201);
    expect(plain.data).toMatchObject({ currency: 'EUR', ledgerAccountId: null, entityId: OTHER });
  });

  it('refuses a ledger account of the wrong kind or of another entity', async () => {
    const wrongKind = await call('', { method: 'POST', body: { name: 'Card', accountType: 'credit_card', ledgerAccountId: 'acc_ba_rent' } });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.error?.message).toBe('A credit card account needs a liability ledger account, but 6000 Rent is a expense account.');
    const foreign = await call('', { method: 'POST', body: { name: 'Elsewhere', ledgerAccountId: 'acc_ba_nl_bank' } });
    expect(foreign.status).toBe(400);
    expect(foreign.error?.message).toBe('Ledger account not found for this accounting entity');
  });

  it('refuses numbers that do not check out', async () => {
    const aba = await call('', { method: 'POST', body: { name: 'X', routingNumber: '021000022' } });
    expect(aba.status).toBe(400);
    expect(aba.error?.message).toBe('That routing number does not pass the ABA check. Check the nine digits.');
    const number = await call('', { method: 'POST', body: { name: 'X', accountNumber: '12#456' } });
    expect(number.status).toBe(400);
    expect(number.error?.message).toBe('An account number has 4 to 34 letters or digits.');
  });

  it('validates the body', async () => {
    const res = await call('', {
      method: 'POST',
      body: { name: '', currency: 'EURO', accountType: 'brokerage', routingNumber: '1234', nextCheckNumber: 0.5, isDefault: 'yes' },
    });
    expect(res.status).toBe(400);
    const layout = await call('', {
      method: 'POST',
      body: { name: 'Bad layout', importSettings: { csv: { ...csvLayout, columns: { date: 'Date', description: 'Text' }, thousandsSeparator: '.', decimalSeparator: '.' } } },
    });
    expect(layout.status).toBe(400);
    const typed = await call('', { method: 'POST', body: { name: 'Bad layout', importSettings: { csv: { ...csvLayout, columns: { date: true, description: '' } } } } });
    expect(typed.status).toBe(400);
    const notJson = await call('', { method: 'POST', rawBody: '{"name":' });
    expect(notJson.status).toBe(400);
  });

  it('needs an entity, banking:create and an encryption key for a number', async () => {
    expect((await call('', { method: 'POST', body: { name: 'X' }, entity: null })).status).toBe(400);
    expect((await call('', { method: 'POST', body: { name: 'X' }, perms: ['banking:read'] })).status).toBe(403);
    const noKey = await call('', { method: 'POST', body: { name: 'X', accountNumber: '987654321' }, env: {} });
    expect(noKey.status).toBe(500);
    expect(noKey.error?.message).toBe('Account numbers cannot be stored: the worker has no encryption key');
  });
});

describe('GET /api/bank-accounts', () => {
  it('lists the entity\'s accounts by name, filtered, without the blob', async () => {
    const all = await call('');
    expect(all.status).toBe(200);
    const names = all.data.map((a: { name: string }) => a.name);
    expect(names).toEqual([...names].sort());
    expect(all.data.every((a: Record<string, unknown>) => !('accountNumberEncrypted' in a))).toBe(true);

    const cards = await call('?accountType=credit_card');
    expect(cards.data.map((a: { name: string }) => a.name)).toEqual(['Visa']);
    const inactive = await call('?isActive=false');
    expect(inactive.data).toEqual([]);
    const none = await call('', { entity: 'ent_missing' });
    expect(none.status).toBe(200);
    expect(none.data).toEqual([]);
    expect((await call('', { perms: ['invoices:read'] })).status).toBe(403);
  });

  it('reads one account and 404s an unknown one', async () => {
    const all = await call('');
    const operating = all.data.find((a: { name: string }) => a.name === 'Operating');
    const one = await call(`/${operating.id}`);
    expect(one.status).toBe(200);
    expect(one.data).toMatchObject({ id: operating.id, accountNumberLast4: '9012', hasAccountNumber: true });
    expect((await call('/ba_missing')).status).toBe(404);
  });
});

describe('PATCH|PUT /api/bank-accounts/:id', () => {
  async function idOf(name: string): Promise<string> {
    const all = await call('');
    return all.data.find((a: { name: string }) => a.name === name).id as string;
  }

  it('changes fields and the number, merges import settings, clears the number on request', async () => {
    const id = await idOf('Reserve');
    const changed = await call(`/${id}`, {
      method: 'PATCH',
      body: { bankName: 'First Bank', accountNumber: '55554444', importSettings: { other: 1 } },
    });
    expect(changed.status).toBe(200);
    expect(changed.data).toMatchObject({ bankName: 'First Bank', accountNumberLast4: '4444', hasAccountNumber: true, importSettings: { note: 'kept', other: 1 } });

    const cleared = await call(`/${id}`, { method: 'PUT', body: { accountNumber: null, routingNumber: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.data).toMatchObject({ accountNumberLast4: null, hasAccountNumber: false, routingNumber: null });

    const renamed = await call(`/${id}`, { method: 'PATCH', body: { name: 'Reserve fund', autoReconcile: false } });
    expect(renamed.data).toMatchObject({ name: 'Reserve fund', autoReconcile: false });
  });

  it('checks a new ledger account or type against each other', async () => {
    const id = await idOf('Operating');
    const card = await call(`/${id}`, { method: 'PATCH', body: { accountType: 'credit_card' } });
    expect(card.status).toBe(400);
    const moved = await call(`/${id}`, { method: 'PATCH', body: { ledgerAccountId: 'acc_ba_savings' } });
    expect(moved.status).toBe(200);
    expect(moved.data.ledgerAccountId).toBe('acc_ba_savings');
  });

  it('refuses bad numbers, an unknown id, and a bad body', async () => {
    const id = await idOf('Operating');
    expect((await call(`/${id}`, { method: 'PATCH', body: { routingNumber: '111111111' } })).status).toBe(400);
    expect((await call('/ba_missing', { method: 'PATCH', body: { name: 'X' } })).status).toBe(404);
    expect((await call(`/${id}`, { method: 'PATCH', body: { name: '' } })).status).toBe(400);
    expect((await call(`/${id}`, { method: 'PUT', body: { name: 'X' }, perms: ['banking:read'] })).status).toBe(403);
  });
});

describe('POST /api/bank-accounts/:id/reveal-account-number', () => {
  it('reveals the full number with tax_ids:reveal and logs it', async () => {
    const all = await call('');
    const operating = all.data.find((a: { name: string }) => a.name === 'Operating');
    const res = await call(`/${operating.id}/reveal-account-number`, { method: 'POST', body: { reason: 'Check printing' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.data).toEqual({ accountNumber: '123456789012', routingNumber: '021000021', accountNumberLast4: '9012' });
    const reveals = await db.select().from(schema.taxIdReveals).where(eq(schema.taxIdReveals.subjectId, operating.id));
    expect(reveals.length).toBeGreaterThan(0);

    const noBody = await call(`/${operating.id}/reveal-account-number`, { method: 'POST', rawBody: 'not json' });
    expect(noBody.status).toBe(200);
  });

  it('refuses without the permission, without a number, for another entity', async () => {
    const all = await call('');
    const operating = all.data.find((a: { name: string }) => a.name === 'Operating');
    const visa = all.data.find((a: { name: string }) => a.name === 'Visa');
    expect((await call(`/${operating.id}/reveal-account-number`, { method: 'POST', perms: ['banking:read'] })).status).toBe(403);
    expect((await call(`/${operating.id}/reveal-account-number`, { method: 'POST', perms: ['tax_ids:reveal'] })).status).toBe(403);
    const none = await call(`/${visa.id}/reveal-account-number`, { method: 'POST' });
    expect(none.status).toBe(400);
    expect(none.error?.message).toBe('This bank account has no account number on file');
    expect((await call(`/${operating.id}/reveal-account-number`, { method: 'POST', entity: OTHER })).status).toBe(404);
    const noKey = await call(`/${operating.id}/reveal-account-number`, { method: 'POST', env: {} });
    expect(noKey.status).toBe(500);
  });
});

describe('DELETE /api/bank-accounts/:id', () => {
  it('soft-deletes and 404s afterwards', async () => {
    const all = await call('');
    const petty = all.data.find((a: { name: string }) => a.name === 'Petty cash');
    expect((await call(`/${petty.id}`, { method: 'DELETE', perms: ['banking:read'] })).status).toBe(403);
    expect((await call(`/${petty.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/${petty.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await call(`/${petty.id}`)).status).toBe(404);
  });
});
