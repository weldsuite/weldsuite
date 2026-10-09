/**
 * The internal payroll endpoint hr-api calls when a WeldHR pay run is
 * approved: balanced journal from run totals (NL and US), signed totals for a
 * correction, idempotent per run, refused when the totals do not balance.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../accounting-entities';
import type { Env, Variables } from '../../types';
import { payrollInternalRoutes } from './internal';

let db: Database;
let nlEntity: string;
let usEntity: string;
const sent: Array<{ eventType: string; data: Record<string, unknown> }> = [];
const env = { ENTITY_EVENTS: { send: async (m: { eventType: string; data: Record<string, unknown> }) => void sent.push(m) } };

async function createEntity(body: Record<string, unknown>): Promise<string> {
  const { request } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
    context: { permissions: permissions('*'), tenantDb: db },
    env: env as unknown as Partial<Env>,
  });
  const res = await request('/api/accounting-entities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** The internal app as books-api serves it: trusted by topology, tenant resolved by the caller. */
function internal() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('internalTrusted', true);
    c.set('tenantDb', db);
    c.set('workspaceId', 'ws_test');
    c.set('orgId', 'org_test');
    c.set('userId', 'system');
    await next();
  });
  app.route('/internal/payroll', payrollInternalRoutes);
  const executionCtx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  return (path: string, body: unknown, trusted = true) => {
    const target = trusted ? app : new Hono<{ Bindings: Env; Variables: Variables }>().route('/internal/payroll', payrollInternalRoutes);
    return target.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env, executionCtx);
  };
}

async function entryLines(journalEntryId: string) {
  const rows = await db
    .select({ code: schema.accounts.code, debit: schema.journalLines.debit, credit: schema.journalLines.credit })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.journalLines.journalEntryId, journalEntryId));
  return rows.map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit) })).sort((a, b) => a.code.localeCompare(b.code));
}

const NL_TOTALS = {
  grossWages: 6000,
  employerTaxes: 620,
  employerBenefits: 300,
  reimbursements: 46,
  employeeTaxes: 1200,
  employeeDeductions: 300,
  netPay: 4500,
};

const post = internal();

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  nlEntity = await createEntity({ name: 'Acme BV', jurisdictionCode: 'NL' });
  usEntity = await createEntity({
    name: 'Acme Inc',
    jurisdictionCode: 'US',
    entityType: 'single_member_llc',
    taxIdentifiers: { einOrSsn: '123456789' },
    address: { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' },
  });
}, 120_000);

describe('POST /internal/payroll/imports', () => {
  it('posts a balanced entry on the Dutch payroll accounts and the bank', async () => {
    const res = await post('/internal/payroll/imports', {
      entityId: nlEntity,
      externalId: 'hrpr_nl_1',
      payDate: '2026-07-24',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      description: 'Payroll Acme 2026-07-01 - 2026-07-31',
      country: 'NL',
      totals: NL_TOTALS,
      postedBy: 'user_admin',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { importId: string; journalEntryId: string; duplicate: boolean } };
    expect(body.data.duplicate).toBe(false);

    // 4110 wages, 4120 social charges, 4130 pension (employer benefits), 1800 owed, 1100 bank.
    expect(await entryLines(body.data.journalEntryId)).toEqual([
      { code: '1100', debit: 0, credit: 4546 },
      { code: '1800', debit: 0, credit: 2420 },
      { code: '4110', debit: 6000, credit: 0 },
      { code: '4120', debit: 620, credit: 0 },
      { code: '4130', debit: 300, credit: 0 },
      { code: '4600', debit: 46, credit: 0 },
    ]);
    const [imported] = await db.select().from(schema.payrollImports).where(eq(schema.payrollImports.id, body.data.importId));
    expect(imported).toMatchObject({ source: 'weldhr', externalId: 'hrpr_nl_1', status: 'posted', payDate: '2026-07-24', createdBy: 'user_admin' });
    expect(imported!.summary).toMatchObject({ gross_wages: 6000, net_pay: 4500 });
    const [entry] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, body.data.journalEntryId));
    expect(entry).toMatchObject({ sourceType: 'payroll', postingKey: `payroll:${body.data.importId}`, status: 'posted' });
    expect(sent.some((m) => m.eventType === 'payroll_import:created')).toBe(true);
  });

  it('is idempotent: the same run posts once and the repeat answers with the first posting', async () => {
    const payload = {
      entityId: nlEntity,
      externalId: 'hrpr_nl_1',
      payDate: '2026-07-24',
      description: 'again',
      country: 'NL',
      totals: NL_TOTALS,
    };
    const again = await post('/internal/payroll/imports', payload);
    expect(again.status).toBe(200);
    const body = (await again.json()) as { data: { duplicate: boolean; journalEntryId: string | null } };
    expect(body.data.duplicate).toBe(true);
    expect(body.data.journalEntryId).toBeTruthy();
    const entries = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.entityId, nlEntity));
    expect(entries.filter((e) => e.sourceType === 'payroll')).toHaveLength(1);
  });

  it('refuses totals that do not balance, with the difference', async () => {
    const res = await post('/internal/payroll/imports', {
      entityId: nlEntity,
      externalId: 'hrpr_bad',
      payDate: '2026-08-24',
      description: 'bad',
      country: 'NL',
      totals: { ...NL_TOTALS, netPay: 4000 },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('off by 500.00');
    expect(await db.select().from(schema.payrollImports).where(eq(schema.payrollImports.externalId, 'hrpr_bad'))).toHaveLength(0);
  });

  it('posts a correction with negative amounts on the opposite sides', async () => {
    const res = await post('/internal/payroll/imports', {
      entityId: nlEntity,
      externalId: 'hrpr_nl_corr',
      payDate: '2026-08-25',
      description: 'Payroll correction',
      country: 'NL',
      totals: { grossWages: -100, employerTaxes: -10, employerBenefits: 0, reimbursements: 0, employeeTaxes: -20, employeeDeductions: 0, netPay: -80 },
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { journalEntryId: string } };
    expect(await entryLines(data.journalEntryId)).toEqual([
      { code: '1100', debit: 80, credit: 0 },
      { code: '1800', debit: 30, credit: 0 },
      { code: '4110', debit: 0, credit: 100 },
      { code: '4120', debit: 0, credit: 10 },
    ]);
  });

  it('falls back to the template codes on a Dutch entity created before the payroll roles existed', async () => {
    const legacy = await createEntity({ name: 'Legacy BV', jurisdictionCode: 'NL' });
    const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, legacy));
    for (const account of accounts) {
      const meta = (account.metadata ?? {}) as Record<string, unknown>;
      if (['payroll_wages_expense', 'payroll_tax_expense', 'payroll_liabilities'].includes(String(meta.systemRole))) {
        await db.update(schema.accounts).set({ metadata: { ...meta, systemRole: undefined } }).where(eq(schema.accounts.id, account.id));
      }
    }
    const res = await post('/internal/payroll/imports', {
      entityId: legacy,
      externalId: 'hrpr_legacy',
      payDate: '2026-07-24',
      description: 'legacy',
      country: 'NL',
      totals: { grossWages: 1000, employerTaxes: 100, employerBenefits: 0, reimbursements: 0, employeeTaxes: 200, employeeDeductions: 0, netPay: 800 },
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { journalEntryId: string } };
    expect((await entryLines(data.journalEntryId)).map((l) => l.code)).toEqual(['1100', '1800', '4110', '4120']);
  });

  it('posts a US payroll on the US payroll roles and the checking account', async () => {
    const res = await post('/internal/payroll/imports', {
      entityId: usEntity,
      externalId: 'hrpr_us_1',
      payDate: '2026-07-31',
      description: 'US payroll',
      country: 'US',
      totals: { grossWages: 10000, employerTaxes: 765, employerBenefits: 300, reimbursements: 0, employeeTaxes: 2100, employeeDeductions: 400, netPay: 7500 },
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { journalEntryId: string } };
    expect(await entryLines(data.journalEntryId)).toEqual([
      { code: '1000', debit: 0, credit: 7500 },
      { code: '2300', debit: 0, credit: 3565 },
      { code: '6175', debit: 765, credit: 0 },
      { code: '6200', debit: 10300, credit: 0 },
    ]);
  });

  it('honours an explicit account mapping and rejects an account of another entity', async () => {
    const usAccounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, usEntity));
    const nlAccounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, nlEntity));
    const savings = usAccounts.find((a) => a.code === '1010')!;
    const ok = await post('/internal/payroll/imports', {
      entityId: usEntity,
      externalId: 'hrpr_us_map',
      payDate: '2026-08-31',
      description: 'mapped',
      country: 'US',
      totals: { grossWages: 100, employerTaxes: 0, employerBenefits: 0, reimbursements: 0, employeeTaxes: 20, employeeDeductions: 0, netPay: 80 },
      mapping: { net_pay: savings.id },
    });
    expect(ok.status).toBe(201);
    const { data } = (await ok.json()) as { data: { journalEntryId: string } };
    expect((await entryLines(data.journalEntryId)).find((l) => l.credit === 80)?.code).toBe('1010');

    const foreign = await post('/internal/payroll/imports', {
      entityId: usEntity,
      externalId: 'hrpr_us_foreign',
      payDate: '2026-08-31',
      description: 'foreign',
      country: 'US',
      totals: { grossWages: 100, employerTaxes: 0, employerBenefits: 0, reimbursements: 0, employeeTaxes: 20, employeeDeductions: 0, netPay: 80 },
      mapping: { net_pay: nlAccounts[0]!.id },
    });
    expect(foreign.status).toBe(400);
  });

  it('answers 404 for an unknown entity and 400 for a malformed body', async () => {
    const missing = await post('/internal/payroll/imports', {
      entityId: 'ent_nope',
      externalId: 'x',
      payDate: '2026-07-24',
      description: 'x',
      country: 'NL',
      totals: NL_TOTALS,
    });
    expect(missing.status).toBe(404);
    expect((await post('/internal/payroll/imports', { entityId: nlEntity })).status).toBe(400);
  });

  it('is not reachable without the internal entrypoint', async () => {
    const res = await post('/internal/payroll/imports', { entityId: nlEntity, externalId: 'z', payDate: '2026-07-24', description: 'z', country: 'NL', totals: NL_TOTALS }, false);
    expect(res.status).toBe(401);
  });
});
