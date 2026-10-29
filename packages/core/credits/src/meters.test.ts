/**
 * The meter catalog's pure parts (plan limits, the decision per call) and the
 * callers' side failing open. The Durable Object is in meter-object.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Plan } from '@weldsuite/db/schema/master';
import { decideMeter, getMeterUsage, limitsFromPlan, meterPeriod, meterUsage, releaseMeterUsage, type UsageMeterEnv } from './meters';

const base = { id: 'p', name: 'Business', priceMonthly: '0', pricePerUser: null, features: {} } as unknown as Plan;
const paid = (allowance: number | null) => ({ allowance, allowOverage: true, planName: 'Business' });

describe('limitsFromPlan', () => {
  it('falls back to the default allowance and stops on a free plan', () => {
    expect(limitsFromPlan('workflow_runs', base)).toMatchObject({ allowance: 500, allowOverage: false });
  });

  it('allows overage on a paid plan, unless the plan says otherwise', () => {
    expect(limitsFromPlan('sign_requests', { ...base, pricePerUser: '49' }).allowOverage).toBe(true);
    expect(limitsFromPlan('sign_requests', { ...base, priceMonthly: '20', features: { allowOverage: false } }).allowOverage).toBe(false);
  });

  it('treats null as unlimited and ignores nonsense', () => {
    expect(limitsFromPlan('workflow_runs', { ...base, features: { taskExecutions: null } }).allowance).toBeNull();
    expect(limitsFromPlan('workflow_runs', { ...base, features: { taskExecutions: -5 } }).allowance).toBe(500);
    expect(limitsFromPlan('sign_requests', { ...base, features: { signRequestsPerMonth: 25 } }).allowance).toBe(25);
  });

  it('gives a workspace without any plan the free limits', () => {
    expect(limitsFromPlan('sign_requests', null)).toEqual({ allowance: 3, allowOverage: false, planName: 'Free' });
  });
});

describe('decideMeter', () => {
  it('is free inside the allowance', () => {
    expect(decideMeter('sign_requests', { used: 0, blocksCharged: 0 }, 1, paid(1))).toEqual({ kind: 'free', used: 1 });
  });

  it('charges a block on its first unit only', () => {
    expect(decideMeter('workflow_runs', { used: 2, blocksCharged: 0 }, 1, paid(2))).toEqual({
      kind: 'charge',
      used: 3,
      blocks: 1,
      credits: 20,
      blocksCharged: 1,
    });
    expect(decideMeter('workflow_runs', { used: 3, blocksCharged: 1 }, 99, paid(2))).toEqual({ kind: 'free', used: 102 });
    expect(decideMeter('workflow_runs', { used: 102, blocksCharged: 1 }, 1, paid(2))).toMatchObject({ kind: 'charge', blocks: 1, blocksCharged: 2 });
  });

  it('charges every block a large quantity opens', () => {
    expect(decideMeter('sign_requests', { used: 0, blocksCharged: 0 }, 4, paid(1))).toMatchObject({ kind: 'charge', blocks: 3, credits: 150 });
  });

  it('stops a plan without overage, and never stops an unlimited one', () => {
    expect(decideMeter('sign_requests', { used: 3, blocksCharged: 0 }, 1, { allowance: 3, allowOverage: false, planName: 'Free' })).toEqual({
      kind: 'limit_reached',
    });
    expect(decideMeter('sign_requests', { used: 10_000, blocksCharged: 0 }, 1, paid(null))).toEqual({ kind: 'free', used: 10_001 });
  });
});

describe('meterPeriod', () => {
  it('is the UTC month', () => {
    expect(meterPeriod(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(meterPeriod(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11');
  });
});

describe('the callers’ side', () => {
  const unreachable = {
    USAGE_METER: {
      idFromName: () => 'id',
      get: () => ({
        meter: vi.fn().mockRejectedValue(new Error('down')),
        release: vi.fn().mockRejectedValue(new Error('down')),
        usage: vi.fn().mockRejectedValue(new Error('down')),
      }),
    },
  } as unknown as UsageMeterEnv;

  it('runs unmetered without the binding or a reachable meter', async () => {
    const unmetered = { allowed: true, reservation: null, used: 0, allowance: null, creditsCharged: 0 };
    expect(await meterUsage({}, { workspaceId: 'ws_1', meter: 'sign_requests' })).toEqual(unmetered);
    expect(await meterUsage(unreachable, { workspaceId: 'ws_1', meter: 'sign_requests' })).toEqual(unmetered);
    expect(await getMeterUsage(unreachable, 'ws_1')).toEqual([]);
    await expect(
      releaseMeterUsage(unreachable, {
        workspaceId: 'ws_1',
        meter: 'sign_requests',
        period: '2026-10',
        quantity: 1,
        idempotencyKey: null,
        blocks: 0,
        credits: 0,
        transactionId: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a quantity that is not a positive whole number', async () => {
    await expect(meterUsage({}, { workspaceId: 'ws_1', meter: 'sign_requests', quantity: 0 })).rejects.toThrow('positive integer');
  });
});
