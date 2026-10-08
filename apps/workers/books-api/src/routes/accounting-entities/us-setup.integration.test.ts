/**
 * US entity setup (pglite): entity type and tax classification, the seeded
 * chart with its tax-line and 1099 mappings, the write-only SSN and its
 * reveal log, fiscal years, and re-mapping tax lines after a classification
 * change. See docs/plans/weldbooks-us.md §11 and phase 1.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from './index';
import { glAccountsRoutes } from '../gl-accounts';

let db: Database;

const ENV = { DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32) };

interface Result {
  status: number;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string };
  text: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, opts: { method?: string; body?: unknown; entityId?: string; perms?: string[] } = {}): Promise<Result> {
  const { request } = createTestApp(mount, routes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
    env: ENV,
  });
  const res = await request(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.entityId ? { 'X-Accounting-Entity-Id': opts.entityId } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: Record<string, any>; error?: { code: string; message: string } }) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, data: (json.data ?? {}) as Record<string, any>, error: json.error, text }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const entities = (path: string, opts: Parameters<typeof call>[3] = {}) => call('/api/accounting-entities', accountingEntitiesRoutes, `/api/accounting-entities${path}`, opts);
const glAccounts = (path: string, opts: Parameters<typeof call>[3] = {}) => call('/api/gl-accounts', glAccountsRoutes, `/api/gl-accounts${path}`, opts);

async function accountsOf(entityId: string) {
  const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  return new Map(rows.map((a) => [a.code, a]));
}

const austin = { line1: '1 Congress Ave', city: 'Austin', state: 'tx', postalCode: '78701' };

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

describe('create a US entity', () => {
  let llcId: string;

  it('a single-member LLC gets US defaults, an EIN in both slots and a Schedule C chart', async () => {
    const res = await entities('', {
      method: 'POST',
      body: {
        name: 'Acme Studio LLC',
        legalName: 'Acme Studio, LLC',
        dba: 'Acme Studio',
        jurisdictionCode: 'US',
        entityType: 'single_member_llc',
        taxIdentifiers: { einOrSsn: '123456789' },
        address: austin,
      },
    });
    expect(res.status).toBe(201);
    llcId = res.data.id;
    expect(res.data).toMatchObject({
      baseCurrency: 'USD',
      locale: 'en-US',
      timezone: 'America/Chicago',
      entityType: 'single_member_llc',
      taxClassification: 'disregarded',
      accountingMethod: 'accrual',
      dba: 'Acme Studio',
      fiscalYearStart: 1,
      fiscalYearConfig: null,
      hasSsn: false,
      taxIdentifiers: { einOrSsn: '12-3456789', vatNumber: '12-3456789' },
      address: { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
    });
    expect(res.data.accountsCreated).toBeGreaterThan(50);
    expect(res.data.taxRatesCreated).toBe(1);
    expect(res.text).not.toContain('ssnEncrypted');
  });

  it('seeds the chart: system roles, an owner equity section, parents, tax lines and 1099 boxes', async () => {
    const accounts = await accountsOf(llcId);
    const roles = [...accounts.values()].map((a) => (a.metadata as { systemRole?: string } | null)?.systemRole);
    for (const role of ['accounts_receivable', 'accounts_payable', 'sales_tax_payable', 'unapplied_cash_payment_income', 'unapplied_cash_bill_payment_expense', 'owner_equity', 'owner_draws']) {
      expect(roles, role).toContain(role);
    }

    // Schedule C lines
    expect(accounts.get('4020')?.taxLine).toBe('sch_c.1');
    expect(accounts.get('6000')?.taxLine).toBe('sch_c.8');
    expect(accounts.get('6185')?.taxLine).toBe('sch_c.24b');
    expect(accounts.get('1100')?.taxLine).toBe('sch_c.bs');
    // every income and expense account of the base chart is mapped
    const unmapped = [...accounts.values()].filter((a) => (a.type === 'revenue' || a.type === 'expense') && !a.taxLine).map((a) => a.code);
    expect(unmapped).toEqual([]);

    // 1099 boxes
    expect(accounts.get('6030')?.form1099Box).toBe('nec_1');
    expect(accounts.get('6140')?.form1099Box).toBe('misc_1');
    expect(accounts.get('6000')?.form1099Box).toBeNull();

    // parents
    expect(accounts.get('1510')?.parentAccountId).toBe(accounts.get('1500')?.id);
    expect(accounts.get('1500')?.parentAccountId).toBeNull();
  });

  it('an S corporation gets its own return lines and equity accounts', async () => {
    const res = await entities('', {
      method: 'POST',
      body: { name: 'Beta Software Inc', jurisdictionCode: 'US', entityType: 's_corp', fiscalYearStart: 7, address: { ...austin, state: 'CA' } },
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ taxClassification: 's_corp', timezone: 'America/Los_Angeles', fiscalYearStart: 7 });

    const accounts = await accountsOf(res.data.id);
    expect(accounts.get('6000')?.taxLine).toBe('f1120s.16');
    expect(accounts.get('4020')?.taxLine).toBe('f1120s.1a');
    expect(accounts.get('3210')?.name).toMatch(/Accumulated adjustments/);
    expect(accounts.get('6201')?.taxLine).toBe('f1120s.7');
    // no sole proprietor draws account
    expect([...accounts.values()].some((a) => (a.metadata as { systemRole?: string } | null)?.systemRole === 'owner_draws')).toBe(false);
  });

  it('an LLC taxed as an S corporation files 1120-S and keeps S corporation books', async () => {
    const res = await entities('', {
      method: 'POST',
      body: { name: 'Gamma LLC', jurisdictionCode: 'US', entityType: 'multi_member_llc', taxClassification: 's_corp' },
    });
    expect(res.status).toBe(201);
    const accounts = await accountsOf(res.data.id);
    expect(accounts.get('6000')?.taxLine).toBe('f1120s.16');
  });

  it('refuses a classification the entity type cannot have, an unknown type, a bad EIN, an SSN in the EIN field and a bad state', async () => {
    const post = (body: Record<string, unknown>) => entities('', { method: 'POST', body: { name: 'Bad Co', jurisdictionCode: 'US', ...body } });

    const wrongClass = await post({ entityType: 'sole_proprietorship', taxClassification: 's_corp' });
    expect(wrongClass.status).toBe(400);
    expect(wrongClass.error?.message).toMatch(/can't be taxed as s corp/);

    expect((await post({ entityType: 'llc' })).status).toBe(400);
    expect((await post({ entityType: 's_corp', taxIdentifiers: { einOrSsn: '12-34' } })).status).toBe(400);

    const ssnInEin = await post({ entityType: 'sole_proprietorship', taxIdentifiers: { einOrSsn: '123-45-6789' } });
    expect(ssnInEin.status).toBe(400);
    expect(ssnInEin.error?.message).toMatch(/ssn field/);

    expect((await post({ entityType: 's_corp', address: { state: 'XX' } })).status).toBe(400);
    expect((await post({ entityType: 's_corp', address: { state: 'NY', postalCode: '1234' } })).status).toBe(400);

    // a classification means nothing outside the US
    const nl = await entities('', { method: 'POST', body: { name: 'Bedrijf BV', jurisdictionCode: 'NL', taxClassification: 's_corp' } });
    expect(nl.status).toBe(400);
  });
});

describe('the SSN of a sole proprietor', () => {
  let id: string;
  const SSN = '123-45-6789';

  it('is stored encrypted, never returned, and only its last four digits are visible', async () => {
    const res = await entities('', {
      method: 'POST',
      body: { name: 'Jane Doe', jurisdictionCode: 'US', entityType: 'sole_proprietorship', ssn: SSN.replace(/-/g, '') },
    });
    expect(res.status).toBe(201);
    id = res.data.id;
    expect(res.data).toMatchObject({ hasSsn: true, ssnLast4: '6789', taxClassification: 'sole_proprietor' });
    expect(res.text).not.toContain('123-45-6789');
    expect(res.text).not.toContain('ssnEncrypted');

    const [row] = await db.select().from(schema.entities).where(eq(schema.entities.id, id));
    expect(row.ssnEncrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+$|^v2:/);
    // Random hex: three digits can turn up by chance, the whole number can't.
    expect(row.ssnEncrypted).not.toContain('123456789');
    expect(row.ssnLast4).toBe('6789');

    for (const read of [await entities(''), await entities(`/${id}`)]) {
      expect(read.status).toBe(200);
      expect(read.text).not.toContain('ssnEncrypted');
      expect(read.text).not.toContain('123-45-6789');
    }
    const one = await entities(`/${id}`);
    expect(one.data).toMatchObject({ hasSsn: true, ssnLast4: '6789' });
  });

  it('rejects an invalid SSN and an SSN on a non-US entity', async () => {
    expect((await entities(`/${id}`, { method: 'PATCH', body: { ssn: '000-12-3456' } })).status).toBe(400);
    const nl = await entities('', { method: 'POST', body: { name: 'Bedrijf BV', jurisdictionCode: 'NL', ssn: SSN } });
    expect(nl.status).toBe(400);
  });

  it('is revealed only with tax_ids:reveal, and every reveal is logged first', async () => {
    const denied = await entities(`/${id}/reveal-ssn`, { method: 'POST', perms: ['entities:read', 'entities:update'] });
    expect(denied.status).toBe(403);
    expect(await db.select().from(schema.taxIdReveals).where(eq(schema.taxIdReveals.subjectId, id))).toHaveLength(0);

    const revealed = await entities(`/${id}/reveal-ssn`, { method: 'POST', perms: ['tax_ids:reveal'], body: { reason: 'Preparing the 1040' } });
    expect(revealed.status).toBe(200);
    expect(revealed.data).toEqual({ ssn: SSN });

    const log = await db.select().from(schema.taxIdReveals).where(eq(schema.taxIdReveals.subjectId, id));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entityId: id, subjectType: 'entity', field: 'ssn', revealedBy: 'user_test_default', reason: 'Preparing the 1040' });

    // the audit trail records that it happened, never the number
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(audit.some((a) => a.action === 'ssn_revealed')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('123-45-6789');
    expect(JSON.stringify(audit)).not.toContain('123456789');
  });

  it('can be replaced and cleared', async () => {
    const replaced = await entities(`/${id}`, { method: 'PATCH', body: { ssn: '321-54-9876' } });
    expect(replaced.status).toBe(200);
    expect(replaced.data).toMatchObject({ hasSsn: true, ssnLast4: '9876' });
    expect(replaced.text).not.toContain('321-54-9876');

    const cleared = await entities(`/${id}`, { method: 'PATCH', body: { ssn: null } });
    expect(cleared.data).toMatchObject({ hasSsn: false, ssnLast4: null });
    expect((await entities(`/${id}/reveal-ssn`, { method: 'POST' })).status).toBe(404);
  });
});

describe('PATCH a US entity', () => {
  let id: string;

  beforeAll(async () => {
    const res = await entities('', { method: 'POST', body: { name: 'Delta LLC', jurisdictionCode: 'US', entityType: 'single_member_llc' } });
    id = res.data.id;
  });

  it('checks the jurisdiction against the registered adapters', async () => {
    expect((await entities(`/${id}`, { method: 'PATCH', body: { jurisdictionCode: 'ZZ' } })).status).toBe(400);
    expect((await entities(`/${id}`, { method: 'PATCH', body: { jurisdictionCode: 'NL' } })).status).toBe(200);
    expect((await entities(`/${id}`, { method: 'PATCH', body: { jurisdictionCode: 'US' } })).status).toBe(200);
  });

  it('keeps the EIN in both slots, and clears both', async () => {
    const set = await entities(`/${id}`, { method: 'PATCH', body: { taxIdentifiers: { vatNumber: '98-7654321' } } });
    expect(set.data.taxIdentifiers).toMatchObject({ vatNumber: '98-7654321', einOrSsn: '98-7654321' });
    const mismatch = await entities(`/${id}`, { method: 'PATCH', body: { taxIdentifiers: { vatNumber: '98-7654321', einOrSsn: '12-3456789' } } });
    expect(mismatch.status).toBe(400);
    const cleared = await entities(`/${id}`, { method: 'PATCH', body: { taxIdentifiers: { einOrSsn: '' } } });
    expect(cleared.data.taxIdentifiers).not.toHaveProperty('einOrSsn');
    expect(cleared.data.taxIdentifiers).not.toHaveProperty('vatNumber');
  });

  it('switches between month-based and 52–53-week fiscal years', async () => {
    const weeks = await entities(`/${id}`, {
      method: 'PATCH',
      body: { fiscalYearConfig: { type: 'fifty_two_fifty_three', endMonth: 6, weekday: 6, rule: 'last' }, accountingMethod: 'cash' },
    });
    expect(weeks.status).toBe(200);
    expect(weeks.data).toMatchObject({ fiscalYearStart: 7, accountingMethod: 'cash', fiscalYearConfig: { endMonth: 6, weekday: 6, rule: 'last' } });
    expect((await entities(`/${id}`, { method: 'PATCH', body: { fiscalYearConfig: { type: 'fifty_two_fifty_three', endMonth: 13, weekday: 6, rule: 'last' } } })).status).toBe(400);

    const month = await entities(`/${id}`, { method: 'PATCH', body: { fiscalYearStart: 10 } });
    expect(month.data).toMatchObject({ fiscalYearStart: 10, fiscalYearConfig: null });
  });

  it('re-maps tax lines after the classification changes, keeping hand-made mappings unless told to overwrite', async () => {
    const before = await accountsOf(id);
    expect(before.get('6000')?.taxLine).toBe('sch_c.8');
    expect(before.get('6050')?.taxLine).toBe('sch_c.27b');

    const patched = await entities(`/${id}`, { method: 'PATCH', body: { taxClassification: 's_corp' } });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ taxClassification: 's_corp', taxLineRemapNeeded: true });
    // nothing moved yet
    expect((await accountsOf(id)).get('6000')?.taxLine).toBe('sch_c.8');
    // an unrelated edit doesn't ask for a re-map
    expect((await entities(`/${id}`, { method: 'PATCH', body: { dba: 'Delta' } })).data.taxLineRemapNeeded).toBe(false);

    const applied = await entities(`/${id}/apply-tax-lines`, { method: 'POST', body: {} });
    expect(applied.status).toBe(200);
    expect(applied.data).toMatchObject({ form: 'f1120s', formLabel: 'Form 1120-S' });
    expect(applied.data.updated).toBeGreaterThan(50);
    const after = await accountsOf(id);
    expect(after.get('6000')?.taxLine).toBe('f1120s.16');
    expect(after.get('4020')?.taxLine).toBe('f1120s.1a');
    expect(after.get('6050')?.taxLine).toBe('f1120s.20');

    // a hand-made mapping to another line of the return survives a second run...
    const manual = await glAccounts(`/${after.get('6000')!.id}`, { method: 'PATCH', entityId: id, body: { taxLine: 'f1120s.20' } });
    expect(manual.status).toBe(200);
    const again = await entities(`/${id}/apply-tax-lines`, { method: 'POST', body: {} });
    expect(again.data).toMatchObject({ updated: 0, keptOverrides: 1 });
    expect((await accountsOf(id)).get('6000')?.taxLine).toBe('f1120s.20');

    // ...unless the caller overwrites
    const overwritten = await entities(`/${id}/apply-tax-lines`, { method: 'POST', body: { overwrite: true } });
    expect(overwritten.data.updated).toBe(1);
    expect((await accountsOf(id)).get('6000')?.taxLine).toBe('f1120s.16');
  });

  it('refuses tax lines on a non-US entity', async () => {
    const nl = await entities('', { method: 'POST', body: { name: 'Bedrijf BV', jurisdictionCode: 'NL' } });
    expect((await entities(`/${nl.data.id}/apply-tax-lines`, { method: 'POST', body: {} })).status).toBe(400);
  });
});

describe('GET /jurisdictions', () => {
  it('lists the US with its features, terminology and entity types', async () => {
    const res = await entities('/jurisdictions');
    expect(res.status).toBe(200);
    const list = res.data as unknown as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const us = list.find((j) => j.code === 'US')!;
    expect(us).toMatchObject({
      defaultCurrency: 'USD',
      defaultLocale: 'en-US',
      features: { salesTax: true, form1099: true, vatReturn: false },
      terminology: { tax: 'sales_tax', taxId: 'ein', supplier: 'vendor', creditNote: 'credit_memo' },
    });
    const llc = us.entityTypes.find((t: { type: string }) => t.type === 'single_member_llc');
    expect(llc.defaultClassification).toBe('disregarded');
    expect(llc.classifications.map((c: { value: string; form: string }) => [c.value, c.form])).toEqual([
      ['disregarded', 'sch_c'],
      ['s_corp', 'f1120s'],
      ['c_corp', 'f1120'],
    ]);
  });
});

describe('account tax lines and 1099 boxes', () => {
  let entityId: string;
  let accounts: Map<string, typeof schema.accounts.$inferSelect>;

  beforeAll(async () => {
    const res = await entities('', { method: 'POST', body: { name: 'Epsilon Partners', jurisdictionCode: 'US', entityType: 'partnership' } });
    entityId = res.data.id;
    accounts = await accountsOf(entityId);
  });

  it('lists the catalog of the entity\'s return', async () => {
    const res = await glAccounts('/tax-lines?year=2026', { entityId });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ form: 'f1065', formLabel: 'Form 1065', taxYear: 2026 });
    const lines = res.data.lines as Array<{ code: string; section: string }>;
    expect(lines.find((l) => l.code === 'f1065.21')?.section).toBe('other_deduction');
    expect(lines.every((l) => l.code.startsWith('f1065.'))).toBe(true);
    expect((res.data.sections as Array<{ key: string }>).map((s) => s.key)).toContain('balance_sheet');
    expect((await glAccounts('/tax-lines?year=26', { entityId })).status).toBe(400);
  });

  it('accepts a line of the entity\'s return and refuses any other', async () => {
    const account = accounts.get('6000')!;
    expect((await glAccounts(`/${account.id}`, { method: 'PATCH', entityId, body: { taxLine: 'f1065.21' } })).status).toBe(200);
    const listed = await glAccounts('', { entityId });
    expect((listed.data as unknown as Array<{ code: string; taxLine: string }>).find((a) => a.code === '6000')?.taxLine).toBe('f1065.21');

    const otherForm = await glAccounts(`/${account.id}`, { method: 'PATCH', entityId, body: { taxLine: 'sch_c.8' } });
    expect(otherForm.status).toBe(400);
    expect(otherForm.error?.message).toMatch(/not a line of Form 1065/);
    expect((await glAccounts(`/${account.id}`, { method: 'PATCH', entityId, body: { taxLine: 'f1065.999' } })).status).toBe(400);

    expect((await glAccounts(`/${account.id}`, { method: 'PATCH', entityId, body: { taxLine: null } })).status).toBe(200);
    const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id));
    expect(row.taxLine).toBeNull();
  });

  it('sets a 1099 box on create, validates it, and filters the unmapped accounts', async () => {
    const created = await glAccounts('', {
      method: 'POST',
      entityId,
      body: { code: '6031', name: 'Subcontractors', type: 'expense', normalSide: 'debit', form1099Box: 'nec_1', taxLine: 'f1065.21' },
    });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ form1099Box: 'nec_1', taxLine: 'f1065.21' });

    expect((await glAccounts('', { method: 'POST', entityId, body: { code: '6032', name: 'X', type: 'expense', normalSide: 'debit', form1099Box: 'box_9' } })).status).toBe(400);
    expect((await glAccounts('', { method: 'POST', entityId, body: { code: '6033', name: 'X', type: 'expense', normalSide: 'debit', form1099Box: 'omit' } })).status).toBe(201);

    const unmapped = await glAccounts('?taxLine=none', { entityId });
    expect((unmapped.data as unknown as Array<{ code: string }>).map((a) => a.code)).toEqual(expect.arrayContaining(['6000', '6033']));
    const online = await glAccounts('?taxLine=f1065.21', { entityId });
    expect((online.data as unknown as Array<{ code: string }>).map((a) => a.code)).toContain('6031');
  });

  it('does not accept tax lines or 1099 boxes on a Dutch entity', async () => {
    const nl = await entities('', { method: 'POST', body: { name: 'Bedrijf BV', jurisdictionCode: 'NL' } });
    const [revenue] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.entityId, nl.data.id), eq(schema.accounts.type, 'revenue'))).limit(1);
    expect((await glAccounts(`/${revenue.id}`, { method: 'PATCH', entityId: nl.data.id, body: { taxLine: 'sch_c.1' } })).status).toBe(400);
    expect((await glAccounts(`/${revenue.id}`, { method: 'PATCH', entityId: nl.data.id, body: { form1099Box: 'nec_1' } })).status).toBe(400);
    expect((await glAccounts('/tax-lines', { entityId: nl.data.id })).status).toBe(400);
  });
});
