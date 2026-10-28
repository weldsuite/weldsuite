/**
 * Usage meters against a real (pglite) master DB: allowances, hard stops on
 * free plans, overage blocks paid from the wallet, refusals when the wallet is
 * empty, releases, and concurrent callers never paying for a block twice.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { getBalance, grantCredits } from './index';
import { getMeterUsage, limitsFromPlan, meterUsage, releaseMeterUsage, type MeterKey } from './meters';

const { plans, workspaces, workspaceMeterUsage } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let db: any;
let seq = 0;

const NOW = new Date('2026-10-15T12:00:00Z');

beforeAll(async () => {
  db = (await createMasterPgliteDb()).db;
});

/** A workspace on its own plan with `features`, holding `credits`. */
async function workspaceOn(plan: { priceMonthly: string; features: Record<string, unknown> }, credits = 0): Promise<string> {
  seq += 1;
  const planId = `plan_meter_${seq}`;
  const id = `ws_meter_${seq}`;
  await db.insert(plans).values({ id: planId, name: `Plan ${seq}`, slug: `plan-meter-${seq}`, ...plan });
  await db.insert(workspaces).values({ id, name: `Workspace ${seq}`, slug: `ws-meter-${seq}`, planId });
  if (credits > 0) await grantCredits(db, { workspaceId: id, amount: credits, type: 'purchase' });
  return id;
}

async function row(workspaceId: string, meter: MeterKey) {
  const [r] = await db
    .select()
    .from(workspaceMeterUsage)
    .where(and(eq(workspaceMeterUsage.workspaceId, workspaceId), eq(workspaceMeterUsage.meter, meter)));
  return r as { used: number; blocksCharged: number; period: string };
}

const run = (workspaceId: string, meter: MeterKey, quantity = 1) => meterUsage(db, { workspaceId, meter, quantity, now: NOW });

describe('limitsFromPlan', () => {
  const base = { id: 'p', name: 'P', priceMonthly: '0', pricePerUser: null } as never as typeof plans.$inferSelect;

  it('falls back to the default allowance and stops on a free plan', () => {
    expect(limitsFromPlan('workflow_runs', { ...base, features: {} })).toMatchObject({ allowance: 500, allowOverage: false });
  });

  it('allows overage on a paid plan, unless the plan says otherwise', () => {
    expect(limitsFromPlan('sign_requests', { ...base, pricePerUser: '49', features: {} }).allowOverage).toBe(true);
    expect(limitsFromPlan('sign_requests', { ...base, priceMonthly: '20', features: { allowOverage: false } }).allowOverage).toBe(false);
  });

  it('treats null as unlimited and ignores nonsense', () => {
    expect(limitsFromPlan('workflow_runs', { ...base, features: { taskExecutions: null } }).allowance).toBeNull();
    expect(limitsFromPlan('workflow_runs', { ...base, features: { taskExecutions: -5 } }).allowance).toBe(500);
  });

  it('gives a workspace without any plan the free limits', () => {
    expect(limitsFromPlan('sign_requests', null)).toEqual({ allowance: 3, allowOverage: false, planName: 'Free' });
  });
});

describe('meterUsage', () => {
  it('stops a free plan at its allowance without counting the refused unit', async () => {
    const ws = await workspaceOn({ priceMonthly: '0', features: { taskExecutions: 2 } }, 1000);

    expect((await run(ws, 'workflow_runs')).allowed).toBe(true);
    expect((await run(ws, 'workflow_runs')).allowed).toBe(true);
    const third = await run(ws, 'workflow_runs');

    expect(third).toMatchObject({ allowed: false, reason: 'limit_reached', used: 2, allowance: 2 });
    expect(await row(ws, 'workflow_runs')).toMatchObject({ used: 2, blocksCharged: 0, period: '2026-10' });
    expect((await getBalance(db, ws)).currentBalance).toBe(1000);
  });

  it('charges each unit past the allowance on a paid plan, then refuses when the wallet runs dry', async () => {
    const ws = await workspaceOn({ priceMonthly: '20', features: { signRequestsPerMonth: 1 } }, 100);

    expect(await run(ws, 'sign_requests')).toMatchObject({ allowed: true, creditsCharged: 0 });
    expect(await run(ws, 'sign_requests')).toMatchObject({ allowed: true, creditsCharged: 50 });
    expect(await run(ws, 'sign_requests')).toMatchObject({ allowed: true, creditsCharged: 50 });
    const fourth = await run(ws, 'sign_requests');

    expect(fourth).toMatchObject({ allowed: false, reason: 'insufficient_credits', used: 3, required: 50, currentBalance: 0 });
    expect(await row(ws, 'sign_requests')).toMatchObject({ used: 3, blocksCharged: 2 });
  });

  it('charges a block once, on its first unit', async () => {
    const ws = await workspaceOn({ priceMonthly: '20', features: { taskExecutions: 2 } }, 100);

    await run(ws, 'workflow_runs', 2);
    expect(await run(ws, 'workflow_runs')).toMatchObject({ creditsCharged: 20, used: 3 });
    expect(await run(ws, 'workflow_runs', 99)).toMatchObject({ creditsCharged: 0, used: 102 });
    expect(await run(ws, 'workflow_runs')).toMatchObject({ creditsCharged: 20, used: 103 });
    expect((await getBalance(db, ws)).currentBalance).toBe(60);
  });

  it('counts without limit when the allowance is unlimited', async () => {
    const ws = await workspaceOn({ priceMonthly: '0', features: { taskExecutions: null } });
    expect(await run(ws, 'workflow_runs', 5000)).toMatchObject({ allowed: true, used: 5000, allowance: null, creditsCharged: 0 });
  });

  it('starts every month from zero', async () => {
    const ws = await workspaceOn({ priceMonthly: '0', features: { signRequestsPerMonth: 1 } });
    await run(ws, 'sign_requests');
    expect((await run(ws, 'sign_requests')).allowed).toBe(false);
    const next = await meterUsage(db, { workspaceId: ws, meter: 'sign_requests', now: new Date('2026-11-01T00:00:00Z') });
    expect(next).toMatchObject({ allowed: true, used: 1 });
  });

  it('never charges concurrent callers twice for the same block', async () => {
    const ws = await workspaceOn({ priceMonthly: '20', features: { signRequestsPerMonth: 0 } }, 1000);

    const results = await Promise.all(Array.from({ length: 5 }, () => run(ws, 'sign_requests')));

    expect(results.every((r) => r.allowed)).toBe(true);
    expect(results.reduce((sum, r) => sum + (r.allowed ? r.creditsCharged : 0), 0)).toBe(250);
    expect(await row(ws, 'sign_requests')).toMatchObject({ used: 5, blocksCharged: 5 });
    expect((await getBalance(db, ws)).currentBalance).toBe(750);
  });
});

describe('releaseMeterUsage', () => {
  it('hands back the units and refunds the block the call paid for', async () => {
    const ws = await workspaceOn({ priceMonthly: '20', features: { signRequestsPerMonth: 0 } }, 100);
    const result = await run(ws, 'sign_requests');
    if (!result.allowed) throw new Error('expected the request to be allowed');

    await releaseMeterUsage(db, result.reservation);

    expect(await row(ws, 'sign_requests')).toMatchObject({ used: 0, blocksCharged: 0 });
    expect((await getBalance(db, ws)).currentBalance).toBe(100);
  });
});

describe('getMeterUsage', () => {
  it('lists every meter with this month’s use, allowance and overage paid', async () => {
    const ws = await workspaceOn({ priceMonthly: '20', features: { taskExecutions: 1 } }, 100);
    await run(ws, 'workflow_runs', 2);

    const usage = await getMeterUsage(db, ws, NOW);

    expect(usage.map((u) => u.meter)).toEqual(['workflow_runs', 'sign_requests', 'emails']);
    expect(usage[0]).toMatchObject({ used: 2, allowance: 1, allowOverage: true, overageCredits: 20 });
    expect(usage[1]).toMatchObject({ used: 0, allowance: 3 });
  });
});
