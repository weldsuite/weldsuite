/**
 * Licence write path and credit allowance maths. Partner tables are not in the
 * pglite test databases, so the db handle is a scripted fake and the credits
 * engine is a spy: these tests pin what is granted or taken back and when,
 * not Drizzle's SQL.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';

const credits = vi.hoisted(() => ({
  getOrCreateWorkspaceCredits: vi.fn(),
  grantCredits: vi.fn(),
}));
vi.mock('@weldsuite/credits', () => credits);

import {
  applyLicenceCredits,
  LicenceError,
  monthRemainder,
  proratedDecreaseTakeBack,
  proratedIncreaseGrant,
  upsertWorkspaceLicence,
  validateLicenceTerms,
} from './licences';
import type { PartnerDb } from './types';

interface Op {
  op: 'insert' | 'update';
  table: unknown;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
}

/** select() results are consumed in call order; insert/update record what they were given. */
function fakeDb(selects: unknown[][] = [], returnings: unknown[][] = []) {
  const ops: Op[] = [];
  const chain = (result: unknown[], op?: Op): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(result);
          return (...args: unknown[]) => {
            if (op && prop === 'values') op.values = args[0] as Record<string, unknown>;
            if (op && prop === 'set') op.set = args[0] as Record<string, unknown>;
            return chain(result, op);
          };
        },
      },
    );
  const db = {
    select: () => chain(selects.shift() ?? []),
    insert: (table: unknown) => {
      const op: Op = { op: 'insert', table };
      ops.push(op);
      return chain(returnings.shift() ?? [], op);
    },
    update: (table: unknown) => {
      const op: Op = { op: 'update', table };
      ops.push(op);
      return chain(returnings.shift() ?? [], op);
    },
  };
  return { db: db as unknown as PartnerDb, ops };
}

describe('month proration helpers', () => {
  it('counts the days left in the UTC month, today included', () => {
    expect(monthRemainder(new Date('2026-10-01T00:00:00Z'))).toEqual({ remainingDays: 31, daysInMonth: 31 });
    expect(monthRemainder(new Date('2026-10-16T23:59:00Z'))).toEqual({ remainingDays: 16, daysInMonth: 31 });
    expect(monthRemainder(new Date('2026-10-31T12:00:00Z'))).toEqual({ remainingDays: 1, daysInMonth: 31 });
    expect(monthRemainder(new Date('2028-02-10T00:00:00Z'))).toEqual({ remainingDays: 20, daysInMonth: 29 });
  });

  it('grants an increase for the rest of the month, rounded down', () => {
    expect(proratedIncreaseGrant(3100, new Date('2026-10-01T10:00:00Z'))).toBe(3100);
    expect(proratedIncreaseGrant(3100, new Date('2026-10-16T10:00:00Z'))).toBe(1600); // 16 of 31 days
    expect(proratedIncreaseGrant(1000, new Date('2026-10-16T10:00:00Z'))).toBe(516); // 516.12 → 516
    expect(proratedIncreaseGrant(3100, new Date('2026-10-31T10:00:00Z'))).toBe(100);
    expect(proratedIncreaseGrant(0, new Date('2026-10-16T10:00:00Z'))).toBe(0);
  });

  it('takes back the days after today on a decrease, rounded up', () => {
    expect(proratedDecreaseTakeBack(3100, new Date('2026-10-01T10:00:00Z'))).toBe(3000); // 30 of 31 days
    expect(proratedDecreaseTakeBack(3100, new Date('2026-10-16T10:00:00Z'))).toBe(1500); // 15 of 31 days
    expect(proratedDecreaseTakeBack(1000, new Date('2026-10-16T10:00:00Z'))).toBe(484); // 483.87 → 484
    expect(proratedDecreaseTakeBack(3100, new Date('2026-10-31T10:00:00Z'))).toBe(0); // today is the last day
  });

  it('never leaves more granted than billed when a raise is undone the same day', () => {
    // Billing prices that day at the higher allowance: delta × 1 / daysInMonth.
    for (const delta of [1, 7, 100, 999, 3100, 100_000]) {
      for (const day of [1, 2, 10, 15, 28, 30, 31]) {
        const now = new Date(Date.UTC(2026, 9, day, 12));
        const { daysInMonth } = monthRemainder(now);
        const net = proratedIncreaseGrant(delta, now) - proratedDecreaseTakeBack(delta, now);
        expect(net).toBeLessThanOrEqual(delta / daysInMonth + 1e-9);
      }
    }
  });
});

describe('applyLicenceCredits', () => {
  const NOW = new Date('2026-10-16T10:00:00Z'); // 16 of 31 days left
  const wallet = (over: Record<string, unknown> = {}) => ({
    currentBalance: 5000,
    periodStart: new Date('2026-10-01T00:00:00Z'),
    lastResetAt: new Date('2026-10-01T02:00:00Z'),
    ...over,
  });
  const base = { workspaceId: 'ws_1', creditRolloverCap: 0, changeId: 'wlc_1', now: NOW };

  beforeEach(() => {
    credits.getOrCreateWorkspaceCredits.mockReset().mockResolvedValue(wallet());
    credits.grantCredits.mockReset().mockResolvedValue({ ok: true, transactionId: 'ctx_1', newBalance: 0, duplicate: false });
  });

  it('grants only the prorated delta on an increase, once per change', async () => {
    const { db, ops } = fakeDb();
    const out = await applyLicenceCredits({ ...base, db, previousMonthlyCredits: 1000, monthlyCredits: 4100 });
    expect(out).toEqual({ granted: 1600, takenBack: 0 });
    expect(credits.grantCredits).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ workspaceId: 'ws_1', amount: 1600, type: 'adjustment', idempotencyKey: 'partner_licence:wlc_1' }),
    );
    const update = ops.find((o) => o.op === 'update')!;
    expect(update.set).toMatchObject({ monthlyAllocation: 4100, planCredits: 4100 });
    // An existing licence leaves the reset bookkeeping to the sweep.
    expect(update.set).not.toHaveProperty('lastResetAt');
  });

  it('reports nothing granted for a replayed change', async () => {
    credits.grantCredits.mockResolvedValue({ ok: true, transactionId: 'ctx_1', newBalance: 0, duplicate: true });
    const out = await applyLicenceCredits({ ...base, db: fakeDb().db, previousMonthlyCredits: 1000, monthlyCredits: 4100 });
    expect(out).toEqual({ granted: 0, takenBack: 0 });
  });

  it('takes back the unused part on a decrease, under the same key', async () => {
    const { db } = fakeDb();
    const out = await applyLicenceCredits({ ...base, db, previousMonthlyCredits: 4100, monthlyCredits: 1000 });
    // 3100 × 15 days after today / 31 = 1500.
    expect(out).toEqual({ granted: 0, takenBack: 1500 });
    expect(credits.grantCredits).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ amount: -1500, type: 'adjustment', idempotencyKey: 'partner_licence:wlc_1' }),
    );
  });

  it('caps the take-back at the available balance and never goes negative', async () => {
    credits.getOrCreateWorkspaceCredits.mockResolvedValue(wallet({ currentBalance: 400 }));
    const out = await applyLicenceCredits({ ...base, db: fakeDb().db, previousMonthlyCredits: 4100, monthlyCredits: 1000 });
    expect(out.takenBack).toBe(400);
    expect(credits.grantCredits).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: -400 }));
  });

  it('takes nothing back from an empty or negative balance', async () => {
    for (const currentBalance of [0, -250]) {
      credits.grantCredits.mockClear();
      credits.getOrCreateWorkspaceCredits.mockResolvedValue(wallet({ currentBalance }));
      const out = await applyLicenceCredits({ ...base, db: fakeDb().db, previousMonthlyCredits: 4100, monthlyCredits: 1000 });
      expect(out).toEqual({ granted: 0, takenBack: 0 });
      expect(credits.grantCredits).not.toHaveBeenCalled();
    }
  });

  it('moves no credits when the allowance is unchanged or the grant rounds to zero', async () => {
    let out = await applyLicenceCredits({ ...base, db: fakeDb().db, previousMonthlyCredits: 1000, monthlyCredits: 1000 });
    expect(out).toEqual({ granted: 0, takenBack: 0 });
    out = await applyLicenceCredits({ ...base, db: fakeDb().db, previousMonthlyCredits: 1000, monthlyCredits: 1001, now: new Date('2026-10-31T10:00:00Z') });
    expect(out).toEqual({ granted: 0, takenBack: 0 }); // 1 × 1 / 31 → 0
    expect(credits.grantCredits).not.toHaveBeenCalled();
  });

  it('grants a first licence prorated and marks the wallet reset this month', async () => {
    const { db, ops } = fakeDb();
    credits.getOrCreateWorkspaceCredits.mockResolvedValue(wallet({ lastResetAt: null, periodStart: new Date('2026-09-01T00:00:00Z') }));
    const out = await applyLicenceCredits({ ...base, db, previousMonthlyCredits: null, monthlyCredits: 3100 });
    expect(out.granted).toBe(1600);
    expect(credits.grantCredits).toHaveBeenCalledWith(db, expect.objectContaining({ type: 'monthly_allocation', amount: 1600 }));
    expect(ops.find((o) => o.op === 'update')!.set).toMatchObject({
      periodStart: new Date('2026-10-01T00:00:00Z'),
      periodEnd: new Date('2026-11-01T00:00:00Z'),
      lastResetAt: NOW,
    });
  });

  it('leaves the move to the monthly reset while it has not run this month', async () => {
    credits.getOrCreateWorkspaceCredits.mockResolvedValue(wallet({ lastResetAt: new Date('2026-09-01T02:00:00Z'), periodStart: new Date('2026-09-01T00:00:00Z') }));
    const { db, ops } = fakeDb();
    const out = await applyLicenceCredits({ ...base, db, previousMonthlyCredits: 1000, monthlyCredits: 4100, now: new Date('2026-10-01T00:30:00Z') });
    expect(out).toEqual({ granted: 0, takenBack: 0 });
    expect(credits.grantCredits).not.toHaveBeenCalled();
    // The allocation still follows the licence, so the reset grants the new amount.
    expect(ops.find((o) => o.op === 'update')!.set).toMatchObject({ monthlyAllocation: 4100 });
  });
});

describe('upsertWorkspaceLicence packageId', () => {
  const terms = {
    allowedApps: ['weldcrm'],
    monthlyCredits: 1000,
    creditRolloverCap: 0,
    maxSeats: null,
    featurePlanId: null,
    storageGb: null,
    resalePricing: { model: 'flat' as const, amount: '100.00' },
  };
  const existing = {
    id: 'wsl_1',
    workspaceId: 'ws_1',
    partnerId: 'ptr_1',
    ...terms,
    status: 'active' as const,
    packageId: 'plp_1',
    endsAt: null,
  };

  async function run(packageId: string | null | undefined) {
    const { db, ops } = fakeDb([[existing]], [[{ ...existing }]]);
    await upsertWorkspaceLicence({
      db,
      workspaceId: 'ws_1',
      partnerId: 'ptr_1',
      terms,
      ...(packageId === undefined ? {} : { packageId }),
      actor: { id: 'user_1', type: 'partner' },
    });
    return ops.find((o) => o.op === 'update' && o.table === masterSchema.workspaceLicences)!.set!;
  }

  it('keeps the current package when packageId is omitted', async () => {
    expect((await run(undefined)).packageId).toBe('plp_1');
  });

  it('clears the link on an explicit null', async () => {
    expect((await run(null)).packageId).toBeNull();
  });

  it('switches to another package', async () => {
    expect((await run('plp_2')).packageId).toBe('plp_2');
  });
});

describe('validateLicenceTerms: minimum selling price', () => {
  // $100 a month including 5 seats, $10 for each seat above that.
  const contract = {
    id: 'ptc_1',
    partnerId: 'ptr_1',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    currency: 'EUR',
    revenueShareBps: 7500,
    baseMinimum: '100.00',
    includedSeats: 5,
    seatFloorPrice: '10.00',
    includedCredits: 2000,
    creditFloorPrice: '0',
    allowedFeaturePlanIds: [],
  };
  const terms = (amount: string, maxSeats: number | null) => ({
    allowedApps: [],
    monthlyCredits: 2000,
    creditRolloverCap: 0,
    maxSeats,
    featurePlanId: null,
    storageGb: null,
    resalePricing: { model: 'flat' as const, amount },
  });

  it('accepts a price at the minimum for the seat limit', async () => {
    const { db } = fakeDb([[contract]]);
    await expect(validateLicenceTerms(db, 'ptr_1', terms('150', 10))).resolves.toBeUndefined();
  });

  it('refuses a price below it, with where it falls short', async () => {
    const { db } = fakeDb([[contract]]);
    const err = await validateLicenceTerms(db, 'ptr_1', terms('120', 10)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LicenceError);
    expect(err).toMatchObject({
      code: 'BELOW_MINIMUM',
      details: { reason: 'below_minimum', currency: 'EUR', seats: 10, minimum: '150.00', price: '120.00' },
    });
  });

  it('refuses a flat price without a seat limit', async () => {
    const { db } = fakeDb([[contract]]);
    await expect(validateLicenceTerms(db, 'ptr_1', terms('1000', null))).rejects.toMatchObject({
      code: 'BELOW_MINIMUM',
      details: { reason: 'needs_seat_limit', seatFloorPrice: '10.00' },
    });
  });
});
