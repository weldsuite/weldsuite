/**
 * Fixed assets on pglite: default books, the mid-quarter test, section 179 and
 * bonus, monthly depreciation posting (balanced, idempotent, lock-aware),
 * disposal with gain or loss, the register, the de minimis check, assets from
 * bill lines, and a non-US entity. US entities use the US chart (roles
 * `fixed_assets`, `accumulated_depreciation`, `depreciation_expense`,
 * `gain_loss_on_disposal`).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../../routes/accounting-entities';
import { fixedAssetsRoutes } from '../../routes/fixed-assets';
import { postJournalEntry } from '../accounting-posting';
import { runDepreciation, runMonthlyDepreciation } from './depreciation-run';

let db: Database;
const sent: Array<{ eventType: string; data: Record<string, unknown> }> = [];
const env = {
  DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32),
  ENTITY_EVENTS: { send: async (message: { eventType: string; data: Record<string, unknown> }) => void sent.push(message) },
};

interface Result {
  status: number;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, opts: { method?: string; body?: unknown; entityId?: string; perms?: string[] } = {}): Promise<Result> {
  const { request } = createTestApp(mount, routes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
    env,
  });
  const res = await request(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.entityId ? { 'X-Accounting-Entity-Id': opts.entityId } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: unknown; error?: { code: string; message: string } }) : {};
  return { status: res.status, data: (json.data ?? {}) as Record<string, any>, error: json.error }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const assets = (entityId: string, path: string, opts: Omit<Parameters<typeof call>[3], 'entityId'> = {}) =>
  call('/api/fixed-assets', fixedAssetsRoutes, `/api/fixed-assets${path}`, { ...opts, entityId });

async function createEntity(name: string, jurisdictionCode: 'US' | 'NL' = 'US'): Promise<{ id: string; accounts: Record<string, string> }> {
  const res = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    body:
      jurisdictionCode === 'US'
        ? {
            name,
            jurisdictionCode: 'US',
            entityType: 'single_member_llc',
            taxIdentifiers: { einOrSsn: '123456789' },
            address: { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' },
          }
        : { name, jurisdictionCode: 'NL', vatNumber: 'NL123456789B01', taxIdentifiers: { registrationNumber: '12345678' }, bankDetails: { iban: 'NL91ABNA0417164300' } },
  });
  expect(res.status).toBe(201);
  const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, res.data.id));
  return { id: res.data.id, accounts: Object.fromEntries(rows.map((a) => [a.code, a.id])) };
}

async function entryLines(journalEntryId: string) {
  const rows = await db
    .select({ code: schema.accounts.code, debit: schema.journalLines.debit, credit: schema.journalLines.credit, classId: schema.journalLines.classId })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.journalLines.journalEntryId, journalEntryId));
  return rows
    .map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit), classId: r.classId }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.debit - b.debit);
}

const sum = (lines: Array<{ debit: number; credit: number }>, key: 'debit' | 'credit') => Math.round(lines.reduce((s, l) => s + l[key], 0) * 100) / 100;

async function depreciationEntries(entityId: string) {
  return db
    .select()
    .from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.entityId, entityId), eq(schema.journalEntries.sourceType, 'fixed_asset_depreciation')))
    .orderBy(schema.journalEntries.date);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

// ---------------------------------------------------------------------------

describe('creating assets', () => {
  let entityId: string;

  beforeAll(async () => {
    entityId = (await createEntity('Create LLC')).id;
  });

  it('a US asset gets a straight-line ledger book and a federal MACRS book with the bonus its dates give', async () => {
    const res = await assets(entityId, '', {
      method: 'POST',
      body: { name: 'MacBook Pro', assetNumber: 'FA-1', assetClass: '5', acquisitionDate: '2026-03-01', placedInServiceDate: '2026-03-15', cost: 10000 },
    });
    expect(res.status).toBe(201);
    expect(res.data.books).toHaveLength(2);
    expect(res.data.books[0]).toMatchObject({ book: 'book', method: 'straight_line', convention: 'full_month', recoveryYears: '5.0', postsToLedger: true, depreciableBasis: '10000.00' });
    expect(res.data.books[1]).toMatchObject({ book: 'federal', method: 'macrs_gds', convention: 'half_year', bonusPercent: '100.0000', depreciableBasis: '0.00', postsToLedger: false });
    expect(sent.some((m) => m.eventType === 'fixed_asset:created')).toBe(true);

    const detail = await assets(entityId, `/${res.data.id}`);
    expect(detail.data.ledgerRows).toHaveLength(60);
    expect(detail.data.ledgerRows[0]).toMatchObject({ periodStart: '2026-03-01', periodEnd: '2026-03-31', amount: '166.67' });
    expect(detail.data.ledgerRows[59]).toMatchObject({ periodEnd: '2031-02-28', accumulated: '10000.00' });
    // The federal book takes everything in year one: 100% bonus.
    expect(detail.data.books[1].schedule.annual[0]).toMatchObject({ bonus: 10000, amount: 10000, remaining: 0 });
    expect(detail.data.accumulatedPosted).toBe('0.00');
  });

  it('bonus depreciation follows the 19 January 2025 acquisition cut-off', async () => {
    const before = await assets(entityId, '', {
      method: 'POST',
      body: { name: 'Bought before', assetClass: '7', acquisitionDate: '2025-01-10', placedInServiceDate: '2025-02-01', cost: 5000 },
    });
    const after = await assets(entityId, '', {
      method: 'POST',
      body: { name: 'Bought after', assetClass: '7', acquisitionDate: '2025-01-20', placedInServiceDate: '2025-02-01', cost: 5000 },
    });
    const old = await assets(entityId, '', {
      method: 'POST',
      body: { name: 'Bought 2023', assetClass: '7', acquisitionDate: '2023-02-01', placedInServiceDate: '2023-02-15', cost: 5000 },
    });
    expect(before.data.books[1].bonusPercent).toBe('40.0000');
    expect(after.data.books[1].bonusPercent).toBe('100.0000');
    expect(old.data.books[1].bonusPercent).toBe('80.0000');
  });

  it('section 179 comes off first and bonus applies to what is left; the rest is MACRS', async () => {
    const created = await assets(entityId, '', {
      method: 'POST',
      body: {
        name: 'CNC machine',
        assetClass: '7',
        acquisitionDate: '2024-06-01',
        placedInServiceDate: '2024-06-15',
        cost: 50000,
        books: [{ book: 'federal', method: 'macrs_gds', recoveryYears: 7, section179Amount: 20000, bonusPercent: 60 }],
      },
    });
    expect(created.status).toBe(201);
    expect(created.data.books).toHaveLength(1);
    // 50,000 - 20,000 (179) = 30,000; 60% bonus = 18,000; 12,000 left for MACRS.
    expect(created.data.books[0]).toMatchObject({ depreciableBasis: '12000.00', section179Amount: '20000.00' });

    const report = await assets(entityId, '/tax-depreciation?taxYear=2024');
    expect(report.status).toBe(200);
    const line = report.data.lines.find((l: { name: string }) => l.name === 'CNC machine');
    expect(line).toMatchObject({ section179: 20000, bonus: 18000, macrs: 1714.8, total: 39714.8, placedInServiceThisYear: true });
    expect(report.data.form4562.part1).toMatchObject({ elected: 20000, limit: 1_220_000 });
    expect(report.data.form4562.part2.bonus).toBeGreaterThanOrEqual(18000);
    expect(report.data.form4562.part3.currentYearAssets.find((c: { recoveryYears: number }) => c.recoveryYears === 7)).toBeTruthy();
  });

  it('section 179 above the business cost, a state book without a state and a second ledger book are refused', async () => {
    const base = { name: 'Bad', assetClass: '5', acquisitionDate: '2026-03-01', placedInServiceDate: '2026-03-01', cost: 1000 };
    const over = await assets(entityId, '', { method: 'POST', body: { ...base, books: [{ book: 'federal', method: 'macrs_gds', recoveryYears: 5, section179Amount: 2000 }] } });
    expect(over.status).toBe(400);
    expect(over.error?.message).toMatch(/Section 179/);
    const noState = await assets(entityId, '', { method: 'POST', body: { ...base, books: [{ book: 'state', method: 'macrs_gds', recoveryYears: 5 }] } });
    expect(noState.status).toBe(400);
    const taxPosting = await assets(entityId, '', { method: 'POST', body: { ...base, books: [{ book: 'federal', method: 'macrs_gds', recoveryYears: 5, postsToLedger: true }] } });
    expect(taxPosting.status).toBe(400);
    const early = await assets(entityId, '', { method: 'POST', body: { ...base, placedInServiceDate: '2026-02-01' } });
    expect(early.status).toBe(400);
  });

  it('the ledger book depreciates the whole cost; the tax book only the business share', async () => {
    const res = await assets(entityId, '', {
      method: 'POST',
      body: { name: 'Shared van', assetClass: '5', acquisitionDate: '2026-02-01', cost: 10000, businessUsePercent: 60, books: [
        { book: 'book', method: 'straight_line', recoveryYears: 5 },
        { book: 'federal', method: 'macrs_gds', recoveryYears: 5, bonusPercent: 0 },
      ] },
    });
    expect(res.status).toBe(201);
    expect(res.data.books[0].depreciableBasis).toBe('10000.00');
    expect(res.data.books[1].depreciableBasis).toBe('6000.00');
    const detail = await assets(entityId, `/${res.data.id}`);
    expect(detail.data.ledgerRows[detail.data.ledgerRows.length - 1].accumulated).toBe('10000.00');
    expect(detail.data.books[1].schedule.annual.reduce((s: number, r: { amount: number }) => s + r.amount, 0)).toBe(6000);
  });

  it('listed property used 50% or less for business is converted to ADS, with no section 179 or bonus', async () => {
    const res = await assets(entityId, '', {
      method: 'POST',
      body: { name: 'Pickup', assetClass: '5', acquisitionDate: '2026-02-01', placedInServiceDate: '2026-02-01', cost: 40000, businessUsePercent: 40, listedProperty: true },
    });
    expect(res.status).toBe(201);
    expect(res.data.books[1]).toMatchObject({ method: 'macrs_ads', bonusPercent: '0.0000', section179Amount: '0.00' });
    expect(res.data.issues.some((i: { code: string }) => i.code === 'ads_required')).toBe(true);
  });

  it('asset numbers are unique and the financial facts freeze once depreciation is posted', async () => {
    const duplicate = await assets(entityId, '', {
      method: 'POST',
      body: { name: 'Again', assetNumber: 'FA-1', acquisitionDate: '2026-03-01', cost: 100 },
    });
    expect(duplicate.status).toBe(409);

    const created = await assets(entityId, '', {
      method: 'POST',
      body: { name: 'Chair', assetNumber: 'FA-9', acquisitionDate: '2026-01-05', cost: 1200, usefulLifeYears: 1 },
    });
    expect(created.status).toBe(201);
    const id = created.data.id as string;
    // Before anything is posted the cost can change and the rows follow.
    const raised = await assets(entityId, `/${id}`, { method: 'PATCH', body: { cost: 2400 } });
    expect(raised.status).toBe(200);
    const rows = await assets(entityId, `/${id}`);
    expect(rows.data.ledgerRows[0].amount).toBe('200.00');

    await runDepreciation(db, { entityId, through: '2026-01-31' });
    const frozen = await assets(entityId, `/${id}`, { method: 'PATCH', body: { cost: 3000 } });
    expect(frozen.status).toBe(409);
    expect(frozen.error?.message).toMatch(/posted/);
    const renamed = await assets(entityId, `/${id}`, { method: 'PATCH', body: { name: 'Office chair', notes: 'Blue' } });
    expect(renamed.status).toBe(200);
    expect(renamed.data.name).toBe('Office chair');
    const removed = await assets(entityId, `/${id}`, { method: 'DELETE' });
    expect(removed.status).toBe(409);
  });

  it('an asset with nothing posted can be deleted, and its rows go with it', async () => {
    const created = await assets(entityId, '', { method: 'POST', body: { name: 'Temp', acquisitionDate: '2026-05-01', cost: 600, usefulLifeYears: 3 } });
    const id = created.data.id as string;
    const removed = await assets(entityId, `/${id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await assets(entityId, `/${id}`)).status).toBe(404);
    const rows = await db.select().from(schema.fixedAssetDepreciation).where(eq(schema.fixedAssetDepreciation.assetId, id));
    expect(rows).toHaveLength(0);
  });

  it('refuses the calls without the permission', async () => {
    expect((await assets(entityId, '', { perms: ['accounts:read'], method: 'POST', body: {} })).status).toBe(403);
    expect((await assets(entityId, '/depreciation/run', { perms: ['accounts:read', 'accounts:update'], method: 'POST', body: { through: '2026-01-31' } })).status).toBe(403);
    expect((await assets(entityId, '/some_id/dispose', { perms: ['accounts:update'], method: 'POST', body: { date: '2026-01-31' } })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('the mid-quarter test', () => {
  let entityId: string;
  let marchId: string;
  let decemberId: string;
  const federalOnly = (years = 5) => [{ book: 'federal', method: 'macrs_gds', recoveryYears: years, bonusPercent: 0 }];

  beforeAll(async () => {
    entityId = (await createEntity('MQ LLC')).id;
  });

  it('a March asset alone uses the half-year convention', async () => {
    const res = await assets(entityId, '', {
      method: 'POST',
      body: { name: 'March machine', assetClass: '5', acquisitionDate: '2026-03-01', placedInServiceDate: '2026-03-10', cost: 10000, books: federalOnly() },
    });
    marchId = res.data.id;
    const detail = await assets(entityId, `/${marchId}`);
    expect(detail.data.books[0].convention).toBe('half_year');
    // Table A-1, 5-year property: 20%.
    expect(detail.data.books[0].schedule.annual.map((r: { amount: number }) => r.amount)).toEqual([2000, 3200, 1920, 1152, 1152, 576]);
    const test = await assets(entityId, '/mid-quarter-test?taxYear=2026');
    expect(test.data).toMatchObject({ applies: false, totalBasis: 10000, lastQuarterBasis: 0 });
  });

  it('a big December purchase puts the whole year on the mid-quarter convention', async () => {
    const res = await assets(entityId, '', {
      method: 'POST',
      body: { name: 'December press', assetClass: '5', acquisitionDate: '2026-12-01', placedInServiceDate: '2026-12-05', cost: 30000, books: federalOnly() },
    });
    decemberId = res.data.id;
    // 30,000 of 40,000 (75%) was placed in service in the last quarter.
    expect(res.data.books[0].convention).toBe('mid_quarter');

    const test = await assets(entityId, '/mid-quarter-test?taxYear=2026');
    expect(test.data).toMatchObject({ applies: true, totalBasis: 40000, lastQuarterBasis: 30000, lastQuarterShare: 0.75, quarterBasis: [10000, 0, 0, 30000] });
    expect(test.data.assets).toHaveLength(2);
    expect(test.data.assets.map((a: { convention: string }) => a.convention)).toEqual(['mid_quarter', 'mid_quarter']);

    // The March asset moved too: Table A-2 (first quarter), 5-year: 35%. December: Table A-5 (fourth quarter): 5%.
    const march = await assets(entityId, `/${marchId}`);
    expect(march.data.books[0].convention).toBe('mid_quarter');
    expect(march.data.books[0].schedule.annual[0].amount).toBe(3500);
    const december = await assets(entityId, `/${decemberId}`);
    expect(december.data.books[0].schedule.annual[0].amount).toBe(1500);
    expect(march.data.books[0].schedule.annual.reduce((s: number, r: { amount: number }) => s + r.amount, 0)).toBe(10000);
  });

  it('removing the December asset takes the March asset back to half-year', async () => {
    expect((await assets(entityId, `/${decemberId}`, { method: 'DELETE' })).status).toBe(204);
    const march = await assets(entityId, `/${marchId}`);
    expect(march.data.books[0].convention).toBe('half_year');
    expect(march.data.books[0].schedule.annual[0].amount).toBe(2000);
  });

  it('exactly 40% in the last quarter does not trigger the test, and real property is left out', async () => {
    const other = (await createEntity('MQ Edge LLC')).id;
    for (const [name, date, cost, years] of [
      ['A', '2026-02-10', 6000, 5],
      ['B', '2026-11-10', 4000, 5],
      ['Building', '2026-12-20', 900000, 39],
    ] as const) {
      const res = await assets(other, '', {
        method: 'POST',
        body: { name, assetClass: String(years), acquisitionDate: date, placedInServiceDate: date, cost, books: federalOnly(years) },
      });
      expect(res.status).toBe(201);
    }
    const test = await assets(other, '/mid-quarter-test?taxYear=2026');
    expect(test.data).toMatchObject({ applies: false, totalBasis: 10000, lastQuarterBasis: 4000 });
    expect(test.data.assets.find((a: { name: string }) => a.name === 'Building')).toMatchObject({ counted: false, excludedReason: 'real_property', convention: 'mid_month' });
  });
});

// ---------------------------------------------------------------------------

describe('posting depreciation', () => {
  let entityId: string;
  let accounts: Record<string, string>;
  let machineId: string;
  let deskId: string;

  beforeAll(async () => {
    const entity = await createEntity('Posting LLC');
    entityId = entity.id;
    accounts = entity.accounts;
    // A class so the class dimension can be checked on the lines.
    await db.insert(schema.accountingDimensionValues).values({ id: 'dim_ops', entityId, dimension: 'class', name: 'Operations' });
    const machine = await assets(entityId, '', { method: 'POST', body: { name: 'Machine', assetNumber: 'M-1', acquisitionDate: '2026-01-10', cost: 12000, usefulLifeYears: 5, classId: 'dim_ops' } });
    const desk = await assets(entityId, '', { method: 'POST', body: { name: 'Desk', assetNumber: 'D-1', acquisitionDate: '2026-02-05', cost: 3600, usefulLifeYears: 3 } });
    expect(machine.status).toBe(201);
    machineId = machine.data.id;
    deskId = desk.data.id;
  });

  it('three months post three balanced entries, one per period, with a pair of lines per asset', async () => {
    const res = await assets(entityId, '/depreciation/run', { method: 'POST', body: { through: '2026-03-31' } });
    expect(res.status).toBe(200);
    expect(res.data.posted.map((p: { periodEnd: string; amount: number; assets: number }) => [p.periodEnd, p.amount, p.assets])).toEqual([
      ['2026-01-31', 200, 1],
      ['2026-02-28', 300, 2],
      ['2026-03-31', 300, 2],
    ]);
    expect(res.data.totalPosted).toBe(800);

    const entries = await depreciationEntries(entityId);
    expect(entries.map((e) => e.date.toISOString().slice(0, 10))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    for (const entry of entries) {
      const lines = await entryLines(entry.id);
      expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
      expect(entry.postingKey).toMatch(/^fixed_asset:dep:2026-0[123]-\d\d:[0-9a-f]{16}$/);
    }
    const february = await entryLines(entries[1].id);
    expect(february).toEqual([
      { code: '1590', debit: 0, credit: 100, classId: null },
      { code: '1590', debit: 0, credit: 200, classId: 'dim_ops' },
      { code: '6040', debit: 100, credit: 0, classId: null },
      { code: '6040', debit: 200, credit: 0, classId: 'dim_ops' },
    ]);

    const rows = await db.select().from(schema.fixedAssetDepreciation).where(eq(schema.fixedAssetDepreciation.assetId, machineId));
    expect(rows.filter((r) => r.journalEntryId).length).toBe(3);
    const [balance] = await db.select({ b: schema.accounts.currentBalance }).from(schema.accounts).where(eq(schema.accounts.id, accounts['6040']));
    expect(Number(balance.b)).toBe(800);
  });

  it('running again posts nothing, and two runs at once post each period once', async () => {
    const again = await assets(entityId, '/depreciation/run', { method: 'POST', body: { through: '2026-03-31' } });
    expect(again.data.posted).toEqual([]);
    expect(await depreciationEntries(entityId)).toHaveLength(3);

    const [a, b] = await Promise.all([
      runDepreciation(db, { entityId, through: '2026-04-30' }),
      runDepreciation(db, { entityId, through: '2026-04-30' }),
    ]);
    const april = (await depreciationEntries(entityId)).filter((e) => e.date.toISOString().startsWith('2026-04'));
    expect(april).toHaveLength(1);
    const posted = [...a.posted, ...b.posted].filter((p) => p.periodEnd === '2026-04-30');
    expect(new Set(posted.map((p) => p.journalEntryId)).size).toBe(1);
    const rows = await db.select().from(schema.fixedAssetDepreciation).where(eq(schema.fixedAssetDepreciation.entityId, entityId));
    expect(rows.filter((r) => r.periodEnd <= '2026-04-30').every((r) => r.journalEntryId)).toBe(true);
  });

  it('an asset added to a period that is already posted gets its own entry for it', async () => {
    const late = await assets(entityId, '', { method: 'POST', body: { name: 'Late', acquisitionDate: '2026-03-02', cost: 600, usefulLifeYears: 1 } });
    expect(late.status).toBe(201);
    const run = await assets(entityId, '/depreciation/run', { method: 'POST', body: { through: '2026-04-30' } });
    expect(run.data.posted.map((p: { periodEnd: string }) => p.periodEnd)).toEqual(['2026-03-31', '2026-04-30']);
    expect(run.data.posted.every((p: { alreadyPosted: boolean }) => !p.alreadyPosted)).toBe(true);
    const march = (await depreciationEntries(entityId)).filter((e) => e.date.toISOString().startsWith('2026-03'));
    expect(march).toHaveLength(2);
  });

  it('a locked period is skipped and reported, and the rest of the run goes on', async () => {
    const old = await assets(entityId, '', { method: 'POST', body: { name: 'Old', acquisitionDate: '2025-11-03', cost: 2400, usefulLifeYears: 2 } });
    expect(old.status).toBe(201);
    await db.update(schema.entities).set({ periodLockDate: '2025-12-31' }).where(eq(schema.entities.id, entityId));
    const run = await assets(entityId, '/depreciation/run', { method: 'POST', body: { through: '2026-05-31' } });
    expect(run.status).toBe(200);
    expect(run.data.skipped.map((s: { periodEnd: string }) => s.periodEnd)).toEqual(['2025-11-30', '2025-12-31']);
    expect(run.data.skipped[0].reason).toMatch(/locked/i);
    expect(run.data.posted.map((p: { periodEnd: string }) => p.periodEnd)).toContain('2026-05-31');
    const unposted = await db
      .select()
      .from(schema.fixedAssetDepreciation)
      .where(and(eq(schema.fixedAssetDepreciation.assetId, old.data.id), eq(schema.fixedAssetDepreciation.periodEnd, '2025-11-30')));
    expect(unposted[0].journalEntryId).toBeNull();
    await db.update(schema.entities).set({ periodLockDate: null }).where(eq(schema.entities.id, entityId));
    const retry = await assets(entityId, '/depreciation/run', { method: 'POST', body: { through: '2026-05-31' } });
    expect(retry.data.posted.map((p: { periodEnd: string }) => p.periodEnd)).toEqual(['2025-11-30', '2025-12-31']);
  });

  it('the last posting marks the asset fully depreciated', async () => {
    const entity = await createEntity('Done LLC');
    const created = await assets(entity.id, '', { method: 'POST', body: { name: 'Short life', acquisitionDate: '2025-01-02', cost: 1200, usefulLifeYears: 1 } });
    const run = await assets(entity.id, '/depreciation/run', { method: 'POST', body: { through: '2025-12-31' } });
    expect(run.data.fullyDepreciatedAssetIds).toEqual([created.data.id]);
    const detail = await assets(entity.id, `/${created.data.id}`);
    expect(detail.data.status).toBe('fully_depreciated');
    expect(detail.data.accumulatedPosted).toBe('1200.00');
    expect(detail.data.netBookValuePosted).toBe('0.00');
    expect(sent.some((m) => m.eventType === 'fixed_asset:updated' && m.data.status === 'fully_depreciated')).toBe(true);
  });

  it('the register shows cost, accumulated depreciation and net book value, next to what is posted', async () => {
    const entity = await createEntity('Register LLC');
    await assets(entity.id, '', { method: 'POST', body: { name: 'Machine', assetNumber: 'M-1', acquisitionDate: '2026-01-10', cost: 12000, usefulLifeYears: 5 } });
    await assets(entity.id, '', { method: 'POST', body: { name: 'Desk', assetNumber: 'D-1', acquisitionDate: '2026-02-05', cost: 3600, usefulLifeYears: 3 } });
    await assets(entity.id, '/depreciation/run', { method: 'POST', body: { through: '2026-02-28' } });
    const register = await assets(entity.id, '/register?asOf=2026-03-31&book=book');
    expect(register.status).toBe(200);
    expect(register.data.totals).toEqual({ cost: 15600, accumulatedDepreciation: 800, netBookValue: 14800, accumulatedPosted: 500 });
    expect(register.data.lines.map((l: { assetNumber: string; accumulatedDepreciation: number }) => [l.assetNumber, l.accumulatedDepreciation])).toEqual([
      ['D-1', 200],
      ['M-1', 600],
    ]);
    const federal = await assets(entity.id, '/register?asOf=2026-12-31&book=federal');
    expect(federal.status).toBe(200);
    expect(federal.data.lines).toEqual([]);
  });

  it('runMonthlyDepreciation posts every entity that has something due', async () => {
    const entity = await createEntity('Cron LLC');
    await assets(entity.id, '', { method: 'POST', body: { name: 'Server', acquisitionDate: '2026-06-01', cost: 2400, usefulLifeYears: 2 } });
    const results = await runMonthlyDepreciation(db, { through: '2026-07-31' });
    const mine = results.find((r) => r.entityId === entity.id);
    expect(mine?.posted.map((p) => [p.periodEnd, p.amount])).toEqual([
      ['2026-06-30', 100],
      ['2026-07-31', 100],
    ]);
    expect(await runMonthlyDepreciation(db, { entityId: entity.id, through: '2026-07-31' })).toEqual([]);
    // Entities whose assets are all posted do not show up at all.
    expect(deskId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('disposal', () => {
  let entityId: string;

  beforeAll(async () => {
    entityId = (await createEntity('Disposal LLC')).id;
  });

  it('after posting through May, a June sale books the gain against the gain-or-loss account', async () => {
    const created = await assets(entityId, '', { method: 'POST', body: { name: 'Truck', acquisitionDate: '2026-01-10', cost: 12000, usefulLifeYears: 5, classId: null } });
    const id = created.data.id as string;
    await assets(entityId, '/depreciation/run', { method: 'POST', body: { through: '2026-05-31' } });

    const res = await assets(entityId, `/${id}/dispose`, { method: 'POST', body: { date: '2026-06-20', proceeds: 11500 } });
    expect(res.status).toBe(200);
    // Full-month convention: nothing for June. Five months at 200 = 1,000; net book value 11,000; gain 500.
    expect(res.data).toMatchObject({ proceeds: 11500, accumulatedDepreciation: 1000, netBookValue: 11000, gainOrLoss: 500, result: 'gain', catchUp: [], disposalMonthDepreciation: 0 });
    expect(await entryLines(res.data.journalEntryId)).toEqual([
      { code: '1050', debit: 11500, credit: 0, classId: null },
      { code: '1500', debit: 0, credit: 12000, classId: null },
      { code: '1590', debit: 1000, credit: 0, classId: null },
      { code: '8100', debit: 0, credit: 500, classId: null },
    ]);
    const detail = await assets(entityId, `/${id}`);
    expect(detail.data).toMatchObject({ status: 'disposed', disposalDate: '2026-06-20', disposalProceeds: '11500.00', disposalJournalEntryId: res.data.journalEntryId });
    expect(detail.data.ledgerRows).toHaveLength(5);
    expect(sent.some((m) => m.eventType === 'fixed_asset:disposed')).toBe(true);

    const twice = await assets(entityId, `/${id}/dispose`, { method: 'POST', body: { date: '2026-06-21', proceeds: 0 } });
    expect(twice.status).toBe(409);
    const edit = await assets(entityId, `/${id}`, { method: 'PATCH', body: { cost: 1 } });
    expect(edit.status).toBe(409);
  });

  it('an asset never posted gets its depreciation caught up month by month, then a loss', async () => {
    const created = await assets(entityId, '', {
      method: 'POST',
      body: { name: 'Laptop', assetClass: '5', acquisitionDate: '2026-01-15', cost: 10000 },
    });
    const id = created.data.id as string;
    const res = await assets(entityId, `/${id}/dispose`, { method: 'POST', body: { date: '2026-06-20', proceeds: 5000 } });
    expect(res.status).toBe(200);
    expect(res.data.catchUp.map((p: { periodEnd: string }) => p.periodEnd)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    // 5 of 60 months of 10,000 = 833.33.
    expect(res.data.accumulatedDepreciation).toBe(833.33);
    expect(res.data).toMatchObject({ netBookValue: 9166.67, gainOrLoss: -4166.67, result: 'loss' });
    const lines = await entryLines(res.data.journalEntryId);
    expect(lines).toEqual([
      { code: '1050', debit: 5000, credit: 0, classId: null },
      { code: '1500', debit: 0, credit: 10000, classId: null },
      { code: '1590', debit: 833.33, credit: 0, classId: null },
      { code: '8100', debit: 4166.67, credit: 0, classId: null },
    ]);
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
    for (const posted of res.data.catchUp) {
      const catchLines = await entryLines(posted.journalEntryId);
      expect(sum(catchLines, 'debit')).toBe(sum(catchLines, 'credit'));
    }
    // The tax book posts nothing; it reports the gain: 100% bonus was taken, so all 5,000 is section 1245 recapture.
    expect(res.data.taxBooks).toHaveLength(1);
    expect(res.data.taxBooks[0]).toMatchObject({ book: 'federal', accumulated: 10000, gainOrLoss: 5000, ordinaryRecapture: 5000, result: 'gain' });
    const entries = await db.select().from(schema.journalEntries).where(and(eq(schema.journalEntries.entityId, entityId), eq(schema.journalEntries.sourceId, id)));
    expect(entries).toHaveLength(1);
  });

  it('refuses a disposal that would change depreciation already posted, and a date before service', async () => {
    const created = await assets(entityId, '', { method: 'POST', body: { name: 'Printer', acquisitionDate: '2026-01-05', cost: 1200, usefulLifeYears: 1 } });
    const id = created.data.id as string;
    await assets(entityId, '/depreciation/run', { method: 'POST', body: { through: '2026-06-30' } });
    const early = await assets(entityId, `/${id}/dispose`, { method: 'POST', body: { date: '2026-03-15', proceeds: 100 } });
    expect(early.status).toBe(409);
    expect(early.error?.message).toMatch(/already posted/);
    const before = await assets(entityId, `/${id}/dispose`, { method: 'POST', body: { date: '2025-12-31', proceeds: 100 } });
    expect(before.status).toBe(400);
    // Still intact: the schedule was not touched by the refused attempts.
    const detail = await assets(entityId, `/${id}`);
    expect(detail.data.status).toBe('active');
    expect(detail.data.ledgerRows).toHaveLength(12);
  });

  it('scrapping with no proceeds writes off the net book value', async () => {
    const created = await assets(entityId, '', { method: 'POST', body: { name: 'Old monitor', acquisitionDate: '2026-01-05', cost: 1200, usefulLifeYears: 1 } });
    const res = await assets(entityId, `/${created.data.id}/dispose`, { method: 'POST', body: { date: '2026-04-10', proceeds: 0 } });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ accumulatedDepreciation: 300, netBookValue: 900, gainOrLoss: -900, result: 'loss' });
    expect(await entryLines(res.data.journalEntryId)).toEqual([
      { code: '1500', debit: 0, credit: 1200, classId: null },
      { code: '1590', debit: 300, credit: 0, classId: null },
      { code: '8100', debit: 900, credit: 0, classId: null },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('de minimis safe harbor', () => {
  it('advises expensing up to $2,500 per item ($5,000 with an applicable financial statement)', async () => {
    const entityId = (await createEntity('De Minimis LLC')).id;
    const check = async (amount: number, hasAfs: boolean) =>
      (await assets(entityId, '/de-minimis-check', { method: 'POST', body: { amount, hasAfs, date: '2026-05-01' } })).data;
    expect(await check(2400, false)).toMatchObject({ threshold: 2500, applies: true, advice: 'expense' });
    expect(await check(2500, false)).toMatchObject({ applies: true, advice: 'expense' });
    expect(await check(2600, false)).toMatchObject({ applies: false, advice: 'capitalize' });
    expect(await check(4900, true)).toMatchObject({ threshold: 5000, applies: true, advice: 'expense' });
    expect(await check(5100, true)).toMatchObject({ applies: false, advice: 'capitalize' });
    const invalid = await assets(entityId, '/de-minimis-check', { method: 'POST', body: { amount: -1 } });
    expect(invalid.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('assets from bill lines', () => {
  let entityId: string;
  let accounts: Record<string, string>;
  let billId: string;

  async function addLine(id: string, accountCode: string, net: string, tax: string) {
    await db.insert(schema.billItems).values({
      id,
      entityId,
      billId,
      description: `Line ${id}`,
      quantity: '1',
      unitPrice: net,
      lineTotal: net,
      taxAmount: tax,
      lineTotalWithTax: (Number(net) + Number(tax)).toFixed(2),
      accountId: accounts[accountCode],
    });
  }

  beforeAll(async () => {
    const entity = await createEntity('Bill LLC');
    entityId = entity.id;
    accounts = entity.accounts;
    const posted = await postJournalEntry(db, {
      entityId,
      date: new Date('2026-04-02T00:00:00.000Z'),
      description: 'Bill BILL-1',
      sourceType: 'bill',
      sourceId: 'bill_test_1',
      postingKey: 'bill:bill_test_1:approve',
      lockKind: 'purchase',
      lines: [
        { accountId: accounts['6050'], debit: 1800 },
        { accountId: accounts['1530'], debit: 5000 },
        { accountId: accounts['2000'], credit: 6800 },
      ],
    });
    billId = 'bill_test_1';
    await db.insert(schema.bills).values({
      id: billId,
      entityId,
      billNumber: 'BILL-1',
      status: 'approved',
      contactId: 'pty_vendor',
      issueDate: new Date('2026-04-02T00:00:00.000Z'),
      dueDate: new Date('2026-05-02T00:00:00.000Z'),
      journalEntryId: posted.journalEntryId,
      currency: 'USD',
    });
    await addLine('bi_expense', '6050', '1800.00', '148.50');
    await addLine('bi_expense2', '6050', '900.00', '0.00');
    await addLine('bi_capitalized', '1530', '5000.00', '0.00');
  });

  it('a line on an expense account becomes an asset costing the line with its sales tax, and says a reclass is needed', async () => {
    const res = await assets(entityId, '/from-bill-line', { method: 'POST', body: { billItemId: 'bi_expense', assetClass: '7', placedInServiceDate: '2026-04-10' } });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ cost: '1948.50', billId, billItemId: 'bi_expense', acquisitionDate: '2026-04-02', placedInServiceDate: '2026-04-10' });
    expect(res.data.source).toMatchObject({ capitalized: false, reclassNeeded: true, reclassJournalEntryId: null, lineAccountCode: '6050' });
    const again = await assets(entityId, '/from-bill-line', { method: 'POST', body: { billItemId: 'bi_expense', assetClass: '7' } });
    expect(again.status).toBe(409);
  });

  it('reclass: true moves the cost from the expense account to the asset account', async () => {
    const res = await assets(entityId, '/from-bill-line', { method: 'POST', body: { billItemId: 'bi_expense2', assetClass: '5', reclass: true } });
    expect(res.status).toBe(201);
    expect(res.data.source.reclassNeeded).toBe(false);
    expect(await entryLines(res.data.source.reclassJournalEntryId)).toEqual([
      { code: '1500', debit: 900, credit: 0, classId: null },
      { code: '6050', debit: 0, credit: 900, classId: null },
    ]);
  });

  it('a line already on a fixed asset account needs no reclass', async () => {
    const res = await assets(entityId, '/from-bill-line', { method: 'POST', body: { billItemId: 'bi_capitalized', assetClass: '7' } });
    expect(res.status).toBe(201);
    expect(res.data.assetAccountId).toBe(accounts['1530']);
    expect(res.data.source).toMatchObject({ capitalized: true, reclassNeeded: false });
    const refused = await assets(entityId, '/from-bill-line', { method: 'POST', body: { billItemId: 'bi_capitalized', assetClass: '7', reclass: true } });
    expect(refused.status).toBe(409);
    const missing = await assets(entityId, '/from-bill-line', { method: 'POST', body: { billItemId: 'nope', assetClass: '7' } });
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('entities outside the US', () => {
  it('a Dutch asset gets only the ledger book and needs its accounts named', async () => {
    const entity = await createEntity('Nederland BV', 'NL');
    const base = { name: 'Laptop', acquisitionDate: '2026-03-01', cost: 1200, usefulLifeYears: 4 };
    const missing = await assets(entity.id, '', { method: 'POST', body: base });
    expect(missing.status).toBe(400);
    expect(missing.error?.message).toMatch(/accumulated depreciation account/);

    await db.insert(schema.accounts).values([
      { id: 'acc_nl_accum', entityId: entity.id, code: '0290', name: 'Cumulatieve afschrijving', type: 'asset', subtype: 'fixed_assets', normalSide: 'credit' },
    ]);
    const res = await assets(entity.id, '', {
      method: 'POST',
      body: { ...base, assetClass: '5', accumulatedDepreciationAccountId: 'acc_nl_accum', depreciationExpenseAccountId: entity.accounts['4700'] },
    });
    expect(res.status).toBe(201);
    expect(res.data.books.map((b: { book: string }) => b.book)).toEqual(['book']);
    expect(res.data.assetAccountId).toBeTruthy();

    const run = await assets(entity.id, '/depreciation/run', { method: 'POST', body: { through: '2026-04-30' } });
    expect(run.data.posted.map((p: { amount: number }) => p.amount)).toEqual([25, 25]);
    const report = await assets(entity.id, '/tax-depreciation?taxYear=2026');
    expect(report.data.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('52-53-week fiscal years', () => {
  it('book depreciation posts per 4-4-5 period and sums to the cost', async () => {
    const res = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      body: {
        name: 'Retail Weeks LLC',
        jurisdictionCode: 'US',
        entityType: 'single_member_llc',
        taxIdentifiers: { einOrSsn: '123456780' },
        address: { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' },
        fiscalYearConfig: { type: 'fifty_two_fifty_three', endMonth: 12, weekday: 6, rule: 'last' },
      },
    });
    expect(res.status).toBe(201);
    const entityId = res.data.id as string;
    const created = await assets(entityId, '', { method: 'POST', body: { name: 'Shelving', acquisitionDate: '2026-02-10', cost: 5200, usefulLifeYears: 2, assetClass: '7' } });
    expect(created.status).toBe(201);
    const detail = await assets(entityId, `/${created.data.id}`);
    const rows = detail.data.ledgerRows as Array<{ periodStart: string; periodEnd: string; amount: string; accumulated: string }>;
    // Periods of 4, 4 and 5 weeks: each row is a whole number of weeks.
    const lengths = new Set(rows.map((r) => (Date.parse(r.periodEnd) - Date.parse(r.periodStart)) / 86_400_000 + 1));
    expect([...lengths].every((days) => days % 7 === 0)).toBe(true);
    expect(rows[rows.length - 1].accumulated).toBe('5200.00');
    expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBeCloseTo(5200, 2);

    const run = await assets(entityId, '/depreciation/run', { method: 'POST', body: { through: '2026-12-31' } });
    expect(run.data.skipped).toEqual([]);
    expect(run.data.posted.length).toBeGreaterThan(8);
    for (const posted of run.data.posted) {
      const lines = await entryLines(posted.journalEntryId);
      expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
    }
    expect(run.data.totalPosted).toBeGreaterThan(2000);
  });
});
