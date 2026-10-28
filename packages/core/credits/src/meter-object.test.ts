/**
 * The UsageMeter Durable Object with in-memory storage and a real (pglite)
 * master DB for plans and the credit wallet: allowances, hard stops on free
 * plans, overage blocks paid from the wallet, refusals when the wallet is
 * empty, idempotent retries, releases, and concurrent calls never paying for
 * the same block twice.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', () => ({ getMasterDb: () => state.db }));

import { getBalance, grantCredits } from './index';
import { memoryStorage, memoryUsageMeter } from './testing/meters';
import type { MeterKey, MeterUsageParams } from './meters';

const { plans, workspaces } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let db: any;
let seq = 0;

const NOW = Date.parse('2026-10-15T12:00:00Z');

beforeAll(async () => {
  db = (await createMasterPgliteDb()).db;
  state.db = db;
});

/** A workspace on its own plan with `features`, holding `credits`, and its meter. */
async function workspaceOn(plan: { priceMonthly: string; features: Record<string, unknown> }, credits = 0) {
  seq += 1;
  const planId = `plan_meter_${seq}`;
  const workspaceId = `ws_meter_${seq}`;
  await db.insert(plans).values({ id: planId, name: `Plan ${seq}`, slug: `plan-meter-${seq}`, ...plan });
  await db.insert(workspaces).values({ id: workspaceId, name: `Workspace ${seq}`, slug: `ws-meter-${seq}`, planId });
  if (credits > 0) await grantCredits(db, { workspaceId, amount: credits, type: 'purchase' });
  const storage = memoryStorage();
  const meter = memoryUsageMeter(storage);
  const run = (key: MeterKey, extra: Partial<MeterUsageParams> & { quantity?: number; now?: number } = {}) =>
    meter.meter({ workspaceId, meter: key, now: NOW, ...extra, quantity: extra.quantity ?? 1 });
  const counter = (key: MeterKey, period = '2026-10') => storage.data.get(`m:${period}:${key}`);
  const balance = async () => (await getBalance(db, workspaceId)).currentBalance;
  return { workspaceId, meter, storage, run, counter, balance };
}

describe('UsageMeter.meter', () => {
  it('stops a free plan at its allowance without counting the refused unit', async () => {
    const ws = await workspaceOn({ priceMonthly: '0', features: { taskExecutions: 2 } }, 1000);

    expect((await ws.run('workflow_runs')).allowed).toBe(true);
    expect((await ws.run('workflow_runs')).allowed).toBe(true);
    expect(await ws.run('workflow_runs')).toMatchObject({ allowed: false, reason: 'limit_reached', used: 2, allowance: 2 });

    expect(ws.counter('workflow_runs')).toEqual({ used: 2, blocksCharged: 0 });
    expect(await ws.balance()).toBe(1000);
  });

  it('charges each unit past the allowance on a paid plan, then refuses when the wallet runs dry', async () => {
    const ws = await workspaceOn({ priceMonthly: '20', features: { signRequestsPerMonth: 1 } }, 100);

    expect(await ws.run('sign_requests')).toMatchObject({ allowed: true, creditsCharged: 0 });
    expect(await ws.run('sign_requests')).toMatchObject({ allowed: true, creditsCharged: 50 });
    expect(await ws.run('sign_requests')).toMatchObject({ allowed: true, creditsCharged: 50 });
    expect(await ws.run('sign_requests')).toMatchObject({
      allowed: false,
      reason: 'insufficient_credits',
      used: 3,
      required: 50,
      currentBalance: 0,
    });
    expect(ws.counter('sign_requests')).toEqual({ used: 3, blocksCharged: 2 });
  });

  it('charges a block once, on its first unit', async () => {
    const ws = await workspaceOn({ priceMonthly: '20', features: { taskExecutions: 2 } }, 100);

    await ws.run('workflow_runs', { quantity: 2 });
    expect(await ws.run('workflow_runs')).toMatchObject({ creditsCharged: 20, used: 3 });
    expect(await ws.run('workflow_runs', { quantity: 99 })).toMatchObject({ creditsCharged: 0, used: 102 });
    expect(await ws.run('workflow_runs')).toMatchObject({ creditsCharged: 20, used: 103 });
    expect(await ws.balance()).toBe(60);
  });

  it('answers a retry with the first answer instead of counting again', async () => {
    const ws = await workspaceOn({ priceMonthly: '20', features: { signRequestsPerMonth: 0 } }, 100);

    const first = await ws.run('sign_requests', { idempotencyKey: 'sign:env_1' });
    const again = await ws.run('sign_requests', { idempotencyKey: 'sign:env_1' });

    expect(again).toEqual(first);
    expect(ws.counter('sign_requests')).toEqual({ used: 1, blocksCharged: 1 });
    expect(await ws.balance()).toBe(50);
  });

  it('starts every month from zero and forgets old idempotency keys', async () => {
    const ws = await workspaceOn({ priceMonthly: '0', features: { signRequestsPerMonth: 1 } });
    await ws.run('sign_requests', { idempotencyKey: 'aug', now: Date.parse('2026-08-10T00:00:00Z') });
    await ws.run('sign_requests', { idempotencyKey: 'oct' });
    expect((await ws.run('sign_requests')).allowed).toBe(false);

    expect(await ws.run('sign_requests', { now: Date.parse('2026-11-01T00:00:00Z') })).toMatchObject({ allowed: true, used: 1 });
    expect([...ws.storage.data.keys()].filter((k) => k.startsWith('k:'))).toEqual(['k:2026-10:oct']);
  });

  it('counts without limit when the allowance is unlimited', async () => {
    const ws = await workspaceOn({ priceMonthly: '0', features: { taskExecutions: null } });
    expect(await ws.run('workflow_runs', { quantity: 5000 })).toMatchObject({ allowed: true, used: 5000, allowance: null });
  });

  it('never charges concurrent calls twice for the same block', async () => {
    const ws = await workspaceOn({ priceMonthly: '20', features: { taskExecutions: 0 } }, 1000);

    const results = await Promise.all(Array.from({ length: 150 }, () => ws.run('workflow_runs')));

    expect(results.every((r) => r.allowed)).toBe(true);
    expect(results.reduce((sum, r) => sum + (r.allowed ? r.creditsCharged : 0), 0)).toBe(40);
    expect(ws.counter('workflow_runs')).toEqual({ used: 150, blocksCharged: 2 });
    expect(await ws.balance()).toBe(960);
  });

  it('counts and allows when the plan cannot be read', async () => {
    const ws = await workspaceOn({ priceMonthly: '0', features: { signRequestsPerMonth: 0 } });
    state.db = { select: () => { throw new Error('master down'); } };
    try {
      expect(await ws.run('sign_requests')).toMatchObject({ allowed: true, used: 1, allowance: null });
    } finally {
      state.db = db;
    }
  });
});

describe('UsageMeter.release', () => {
  it('hands back the units, refunds the block, and lets the same key be metered again', async () => {
    const ws = await workspaceOn({ priceMonthly: '20', features: { signRequestsPerMonth: 0 } }, 100);
    const result = await ws.run('sign_requests', { idempotencyKey: 'sign:env_2' });
    if (!result.allowed || !result.reservation) throw new Error('expected the request to be allowed');

    await ws.meter.release(result.reservation);

    expect(ws.counter('sign_requests')).toEqual({ used: 0, blocksCharged: 0 });
    expect(await ws.balance()).toBe(100);
    expect(await ws.run('sign_requests', { idempotencyKey: 'sign:env_2' })).toMatchObject({ allowed: true, creditsCharged: 50 });
    expect(await ws.balance()).toBe(50);
  });
});

describe('UsageMeter.usage', () => {
  it('lists every meter with this month’s use, allowance and overage paid', async () => {
    const ws = await workspaceOn({ priceMonthly: '20', features: { taskExecutions: 1 } }, 100);
    await ws.run('workflow_runs', { quantity: 2 });

    const usage = await ws.meter.usage(ws.workspaceId, NOW);

    expect(usage.map((u) => u.meter)).toEqual(['workflow_runs', 'sign_requests', 'emails']);
    expect(usage[0]).toMatchObject({ used: 2, allowance: 1, allowOverage: true, overageCredits: 20 });
    expect(usage[1]).toMatchObject({ used: 0, allowance: 3 });
  });
});
