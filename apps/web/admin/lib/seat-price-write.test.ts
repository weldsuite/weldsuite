// The seat price write (actions/seat-price.server.ts) through Drizzle's
// pg-proxy driver: the real query builder, against rows the test hands back.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Guard = { ok: true; identity: Record<string, unknown> } | { ok: false; error: string };

const fake = vi.hoisted(() => {
  const state = {
    guard: { ok: true, identity: {} } as Guard,
    queries: [] as Array<{ sql: string; params: unknown[] }>,
    account: [] as unknown[][],
    workspace: [] as unknown[][],
    plan: [] as unknown[][],
  };
  const rowsFor = (sql: string): unknown[][] => {
    if (sql.startsWith('select') && sql.includes('from "billing_accounts"')) return state.account;
    if (sql.startsWith('select') && sql.includes('from "workspaces"')) return state.workspace;
    if (sql.startsWith('select') && sql.includes('from "plans"')) return state.plan;
    return [];
  };
  return { state, rowsFor };
});

vi.mock('@tanstack/react-start/server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ guardWrite: async () => fake.state.guard }));
vi.mock('@/lib/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy');
  const masterSchema = await import('@weldsuite/db/schema/master');
  const db = drizzle(
    async (sql: string, params: unknown[]) => {
      fake.state.queries.push({ sql, params });
      return { rows: fake.rowsFor(sql) };
    },
    { schema: masterSchema },
  );
  return {
    masterSchema,
    getMasterDb: () => db,
    inMasterTransaction: (work: (tx: typeof db) => Promise<unknown>) => work(db),
  };
});

import { SEAT_PRICE_AUDIT_ACTION, setSeatPrice } from '@/actions/seat-price.server';
import { mollieBillingCopyByLocale } from './mollie-billing-copy';

const errors = mollieBillingCopyByLocale.en.seatPriceDialog.errors;
const staff = { userId: 'usr_staff', email: 'staff@example.test', name: null, role: 'admin', isSuperAdmin: false };
// Timestamps as Postgres sends them (`timestamp`, no zone): far ahead, so the period is running.
const LATER = '2099-01-14 10:00:00';

// Rows in the order the write selects their columns.
const accountRow = (unitAmount: number | null = 2500, currency = 'EUR', nextChargeAt: string | null = LATER) => [
  unitAmount,
  currency,
  nextChargeAt,
];
const workspaceRow = (status = 'active') => ['plan_business', status, 'monthly', LATER, 3, null];
const planRow = ['business', '25.00', '0.00', 'EUR'];

const writes = () => fake.state.queries.filter((q) => !q.sql.startsWith('select'));

beforeEach(() => {
  fake.state.guard = { ok: true, identity: staff };
  fake.state.queries = [];
  fake.state.account = [accountRow()];
  fake.state.workspace = [workspaceRow()];
  fake.state.plan = [planRow];
});

describe('setSeatPrice', () => {
  it('locks the account, writes the price and audits it', async () => {
    const result = await setSeatPrice({ workspaceId: 'ws_1', unitAmount: 2000, reason: '  Launch discount  ' });
    expect(result).toEqual({ ok: true, data: { unitAmount: 2000, previous: 2500 } });

    const [lock] = fake.state.queries;
    expect(lock!.sql).toContain('from "billing_accounts"');
    expect(lock!.sql).toMatch(/for update$/);
    expect(lock!.params).toEqual(['ws_1', 'mollie', 1]);

    const [update, audit] = writes();
    expect(update!.sql).toMatch(/^update "billing_accounts" set "unit_amount" = \$1/);
    expect(update!.params).toContain(2000);
    expect(update!.params).toContain('ws_1');
    expect(audit!.sql).toMatch(/^insert into "admin_audit_events"/);
    expect(audit!.params).toContain(SEAT_PRICE_AUDIT_ACTION);
    expect(audit!.params).toContain('Launch discount');
    expect(audit!.params).toContain('staff@example.test');
    const details = audit!.params.find((p) => typeof p === 'string' && p.includes('"listPrice"'));
    expect(JSON.parse(details as string)).toEqual({
      from: 2500,
      to: 2000,
      currency: 'EUR',
      listPrice: 2500,
      planId: 'plan_business',
      cycle: 'monthly',
      seats: 3,
    });
  });

  it('makes the seats free at zero', async () => {
    const result = await setSeatPrice({ workspaceId: 'ws_1', unitAmount: 0, reason: 'Partner programme' });
    expect(result).toEqual({ ok: true, data: { unitAmount: 0, previous: 2500 } });

    const [update, audit] = writes();
    expect(update!.sql).toMatch(/^update "billing_accounts" set "unit_amount" = \$1/);
    expect(update!.params[0]).toBe(0);
    const details = audit!.params.find((p) => typeof p === 'string' && p.includes('"listPrice"'));
    expect(JSON.parse(details as string)).toMatchObject({ from: 2500, to: 0, listPrice: 2500 });
  });

  it('refuses a viewer, a short reason and a bad price before reading anything', async () => {
    fake.state.guard = { ok: false, error: 'Your account has read-only access' };
    expect(await setSeatPrice({ workspaceId: 'ws_1', unitAmount: 2000, reason: 'Discount' })).toEqual({
      ok: false,
      error: 'Your account has read-only access',
    });
    fake.state.guard = { ok: true, identity: staff };
    expect(await setSeatPrice({ workspaceId: 'ws_1', unitAmount: 2000, reason: ' x ' })).toMatchObject({ ok: false });
    expect(await setSeatPrice({ workspaceId: 'ws_1', unitAmount: -100, reason: 'Discount' })).toEqual({
      ok: false,
      error: errors.format,
    });
    expect(await setSeatPrice({ workspaceId: 'ws_1', unitAmount: 1_000_001, reason: 'Discount' })).toMatchObject({
      ok: false,
    });
    expect(fake.state.queries).toEqual([]);
  });

  it('refuses a workspace without a running subscription on Mollie, and writes nothing', async () => {
    fake.state.account = [];
    expect(await setSeatPrice({ workspaceId: 'ws_1', unitAmount: 2000, reason: 'Discount' })).toEqual({
      ok: false,
      error: errors.noSubscription,
    });
    fake.state.account = [accountRow(null, 'EUR', null)];
    expect(await setSeatPrice({ workspaceId: 'ws_1', unitAmount: 2000, reason: 'Discount' })).toMatchObject({
      error: errors.noSubscription,
    });
    fake.state.account = [accountRow()];
    fake.state.workspace = [workspaceRow('canceled')];
    expect(await setSeatPrice({ workspaceId: 'ws_1', unitAmount: 2000, reason: 'Discount' })).toMatchObject({
      error: errors.noSubscription,
    });
    expect(writes()).toEqual([]);
  });

  it('refuses an unknown workspace, another currency and the same price', async () => {
    fake.state.workspace = [];
    expect(await setSeatPrice({ workspaceId: 'ws_x', unitAmount: 2000, reason: 'Discount' })).toMatchObject({
      error: errors.notFound,
    });
    fake.state.workspace = [workspaceRow()];
    fake.state.account = [accountRow(2500, 'USD')];
    expect(await setSeatPrice({ workspaceId: 'ws_1', unitAmount: 2000, reason: 'Discount' })).toMatchObject({
      error: 'This workspace is billed in USD; seat prices are set in EUR only.',
    });
    fake.state.account = [accountRow()];
    expect(await setSeatPrice({ workspaceId: 'ws_1', unitAmount: 2500, reason: 'Discount' })).toMatchObject({
      error: errors.unchanged,
    });
    expect(writes()).toEqual([]);
  });

  it('audits without a list price when the plan is gone', async () => {
    fake.state.plan = [];
    expect(await setSeatPrice({ workspaceId: 'ws_1', unitAmount: 2000, reason: 'Discount' })).toMatchObject({ ok: true });
    const details = writes()[1]!.params.find((p) => typeof p === 'string' && p.includes('"listPrice"'));
    expect(JSON.parse(details as string)).toMatchObject({ listPrice: null });
  });
});
