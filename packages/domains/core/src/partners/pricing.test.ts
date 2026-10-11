/**
 * The reseller billing maths (`@weldsuite/app-api-client/schemas/partners`):
 * floor with credits, revenue share, per-seat peaks, day proration from the
 * licence history, and the dunning clock. The worked examples are the ones in
 * docs/plans/reseller-licensing.md.
 */

import { describe, expect, it } from 'vitest';
import {
  creditsToCents,
  dunningStage,
  fromCents,
  licenceSegments,
  monthPeriod,
  previousMonthPeriod,
  priceWorkspaceMonth,
  priceWorkspacePeriod,
  toCents,
  type LicenceChangePoint,
  type PricingContract,
} from '@weldsuite/app-api-client/schemas/partners';

const contract: PricingContract = {
  revenueShareBps: 7500,
  baseMinimum: '50.00',
  includedCredits: 2000,
  creditFloorPrice: '0.004',
};

const flat = (amount: string) => ({ model: 'flat' as const, amount });

describe('money helpers', () => {
  it('round-trips cents and rejects junk', () => {
    expect(toCents('199.5')).toBe(19950);
    expect(toCents('0.07')).toBe(7);
    expect(fromCents(19950)).toBe('199.50');
    expect(fromCents(-1000)).toBe('-10.00');
    expect(() => toCents('1,5')).toThrow();
    expect(() => toCents('-1')).toThrow();
  });

  it('prices credits in micro-units without float drift', () => {
    expect(creditsToCents(18_000, '0.004')).toBe(7200);
    expect(creditsToCents(3, '0.333333')).toBe(100);
    expect(creditsToCents(0, '9.99')).toBe(0);
  });
});

describe('priceWorkspaceMonth (plan worked examples)', () => {
  it('Acme: flat $400 → WeldSuite bills 75%', () => {
    const p = priceWorkspaceMonth(contract, { monthlyCredits: 2000, resalePricing: flat('400') }, 0);
    expect(p).toMatchObject({ resale: 40000, share: 30000, floor: 5000, due: 30000, margin: 10000, basis: 'share' });
  });

  it('Beta: $12 × 5 seats → the $50 floor wins', () => {
    const p = priceWorkspaceMonth(contract, { monthlyCredits: 2000, resalePricing: { model: 'per_seat', amount: '12' } }, 5);
    expect(p).toMatchObject({ resale: 6000, share: 4500, due: 5000, margin: 1000, basis: 'floor' });
  });

  it('Gamma: 20,000 credits raise the floor to $122', () => {
    const p = priceWorkspaceMonth(contract, { monthlyCredits: 20_000, resalePricing: flat('150') }, 0);
    expect(p).toMatchObject({ baseFloor: 5000, creditFloor: 7200, floor: 12200, share: 11250, due: 12200, margin: 2800 });
  });

  it('Delta: given away at $0 still costs the floor', () => {
    const p = priceWorkspaceMonth(contract, { monthlyCredits: 0, resalePricing: flat('0') }, 0);
    expect(p).toMatchObject({ resale: 0, due: 5000, margin: -5000 });
  });

  it('per-seat pricing honours minSeats', () => {
    const p = priceWorkspaceMonth(contract, { monthlyCredits: 0, resalePricing: { model: 'per_seat', amount: '20', minSeats: 10 } }, 3);
    expect(p.resale).toBe(20000);
  });
});

describe('licenceSegments', () => {
  const october = monthPeriod(new Date('2026-10-15T00:00:00Z'));
  const snap = (amount: string, status: 'active' | 'suspended' | 'ended' = 'active') => ({
    status,
    monthlyCredits: 2000,
    resalePricing: flat(amount),
  });

  it('bills from the day a workspace is created', () => {
    const changes: LicenceChangePoint[] = [{ changedAt: new Date('2026-10-10T15:00:00Z'), snapshot: snap('100') }];
    const segs = licenceSegments(changes, october.start, october.end);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ days: 22, firstDay: '2026-10-10', lastDay: '2026-10-31' });
  });

  it('splits on a price change and carries the licence from before the period', () => {
    const changes: LicenceChangePoint[] = [
      { changedAt: new Date('2026-09-01T00:00:00Z'), snapshot: snap('100') },
      { changedAt: new Date('2026-10-21T09:00:00Z'), snapshot: snap('200') },
    ];
    const segs = licenceSegments(changes, october.start, october.end);
    expect(segs.map((s) => [s.days, s.snapshot.resalePricing.amount])).toEqual([
      [20, '100'],
      [11, '200'],
    ]);
  });

  it('bills the day a licence ends and stops the day after, and bills suspended days', () => {
    const changes: LicenceChangePoint[] = [
      { changedAt: new Date('2026-09-01T00:00:00Z'), snapshot: snap('100') },
      { changedAt: new Date('2026-10-05T12:00:00Z'), snapshot: snap('100', 'suspended') },
      { changedAt: new Date('2026-10-20T12:00:00Z'), snapshot: snap('100', 'ended') },
    ];
    const segs = licenceSegments(changes, october.start, october.end);
    expect(segs.reduce((n, s) => n + s.days, 0)).toBe(20); // 1–20 Oct
  });
});

describe('licenceSegments: credits are billed at the day\'s high-water mark', () => {
  const october = monthPeriod(new Date('2026-10-15T00:00:00Z'));
  const at = (iso: string, monthlyCredits: number, status: 'active' | 'suspended' | 'ended' = 'active'): LicenceChangePoint => ({
    changedAt: new Date(iso),
    snapshot: { status, monthlyCredits, resalePricing: flat('100') },
  });
  /** Day runs by credits (segments split on any licence change, even a same-credit one). */
  const summary = (changes: LicenceChangePoint[]) => {
    const runs: Array<[string, string, number, number]> = [];
    for (const s of licenceSegments(changes, october.start, october.end)) {
      const last = runs[runs.length - 1];
      const next = new Date(Date.parse(`${s.firstDay}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      if (last && last[3] === s.snapshot.monthlyCredits && last[1] === next) {
        last[1] = s.lastDay;
        last[2] += s.days;
      } else runs.push([s.firstDay, s.lastDay, s.days, s.snapshot.monthlyCredits]);
    }
    return runs;
  };

  it('bills a raise-use-lower within one day at the raised level for that day', () => {
    const segs = summary([
      at('2026-09-01T00:00:00Z', 1000),
      at('2026-10-10T09:00:00Z', 9000), // raised in the morning
      at('2026-10-10T18:00:00Z', 1000), // lowered before midnight
    ]);
    expect(segs).toEqual([
      ['2026-10-01', '2026-10-09', 9, 1000],
      ['2026-10-10', '2026-10-10', 1, 9000],
      ['2026-10-11', '2026-10-31', 21, 1000],
    ]);
  });

  it('bills the day of a decrease at the old level and the days after at the new one', () => {
    expect(summary([at('2026-09-01T00:00:00Z', 5000), at('2026-10-20T12:00:00Z', 1000)])).toEqual([
      ['2026-10-01', '2026-10-20', 20, 5000],
      ['2026-10-21', '2026-10-31', 11, 1000],
    ]);
  });

  it('bills the day of an increase at the new level', () => {
    expect(summary([at('2026-09-01T00:00:00Z', 1000), at('2026-10-20T12:00:00Z', 5000)])).toEqual([
      ['2026-10-01', '2026-10-19', 19, 1000],
      ['2026-10-20', '2026-10-31', 12, 5000],
    ]);
  });

  it('takes the highest of several changes in one day', () => {
    const segs = summary([
      at('2026-09-01T00:00:00Z', 1000),
      at('2026-10-05T01:00:00Z', 3000),
      at('2026-10-05T02:00:00Z', 7000),
      at('2026-10-05T03:00:00Z', 2000),
    ]);
    expect(segs).toEqual([
      ['2026-10-01', '2026-10-04', 4, 1000],
      ['2026-10-05', '2026-10-05', 1, 7000],
      ['2026-10-06', '2026-10-31', 26, 2000],
    ]);
  });

  it('does not let an ended licence\'s credits raise a day, and keeps the status rules', () => {
    const segs = summary([
      at('2026-09-01T00:00:00Z', 9000),
      at('2026-10-10T00:00:00Z', 9000, 'ended'),
      at('2026-10-12T08:00:00Z', 1000), // re-activated at 1000: the ended 9000 must not count
    ]);
    // 1–9 Oct active at 9000, 10–11 ended (not billed), 12–31 at 1000.
    expect(segs).toEqual([
      ['2026-10-01', '2026-10-09', 9, 9000],
      ['2026-10-12', '2026-10-31', 20, 1000],
    ]);
  });

  it('bills the day a licence ends at the credits raised earlier that day', () => {
    const segs = summary([
      at('2026-09-01T00:00:00Z', 1000),
      at('2026-10-20T08:00:00Z', 9000),
      at('2026-10-20T20:00:00Z', 9000, 'ended'),
    ]);
    // Raise, spend and end before midnight is still billed for the 20th.
    expect(segs).toEqual([
      ['2026-10-01', '2026-10-19', 19, 1000],
      ['2026-10-20', '2026-10-20', 1, 9000],
    ]);
  });

  it('does not bill a day the licence spent wholly ended, even if its credits were lowered meanwhile', () => {
    const segs = summary([
      at('2026-09-01T00:00:00Z', 1000),
      at('2026-10-20T08:00:00Z', 9000, 'ended'),
      at('2026-10-21T08:00:00Z', 0, 'ended'),
      at('2026-10-22T08:00:00Z', 0),
    ]);
    expect(segs).toEqual([
      ['2026-10-01', '2026-10-20', 20, 1000],
      ['2026-10-22', '2026-10-31', 10, 0],
    ]);
  });

  it('prices the raised day through priceWorkspacePeriod (credit floor follows the high-water mark)', () => {
    const segs = licenceSegments(
      [
        at('2026-09-01T00:00:00Z', 2000),
        at('2026-10-10T09:00:00Z', 22_000),
        at('2026-10-10T18:00:00Z', 2000),
      ],
      october.start,
      october.end,
    );
    const line = priceWorkspacePeriod({ contract, segments: segs, daysInPeriod: 31, peakSeats: 0 });
    // Only 10 Oct carries the 20,000 credits above the 2,000 included: $80 / 31 days.
    expect(line.creditFloor).toBe(Math.round((8000 * 1) / 31));
  });
});

describe('priceWorkspacePeriod', () => {
  it('prorates each segment and adds extra credits unprorated', () => {
    const october = monthPeriod(new Date('2026-10-01T00:00:00Z'));
    const segs = licenceSegments(
      [{ changedAt: new Date('2026-10-17T08:00:00Z'), snapshot: { status: 'active', monthlyCredits: 2000, resalePricing: flat('310') } }],
      october.start,
      october.end,
    );
    const line = priceWorkspacePeriod({ contract, segments: segs, daysInPeriod: 31, peakSeats: 4, extraCreditsCents: 1234 });
    // 15 of 31 days of $310 → $150 resale, $112.50 share (floor $24.19 prorated loses).
    expect(line).toMatchObject({ daysActive: 15, resale: 15000, share: 11250, extraCredits: 1234 });
    expect(line.due).toBe(11250 + 1234);
    expect(line.margin).toBe(15000 - 11250);
  });

  it('bills the period peak on per-seat licences', () => {
    const october = monthPeriod(new Date('2026-10-01T00:00:00Z'));
    const segs = licenceSegments(
      [{ changedAt: new Date('2026-09-01T00:00:00Z'), snapshot: { status: 'active', monthlyCredits: 0, resalePricing: { model: 'per_seat', amount: '10' } } }],
      october.start,
      october.end,
    );
    const line = priceWorkspacePeriod({ contract, segments: segs, daysInPeriod: 31, peakSeats: 12 });
    expect(line).toMatchObject({ seatsBilled: 12, resale: 12000, share: 9000, due: 9000 });
  });
});

describe('periods and dunning', () => {
  it('computes UTC months', () => {
    expect(previousMonthPeriod(new Date('2026-01-01T03:00:00Z')).start.toISOString()).toBe('2025-12-01T00:00:00.000Z');
  });

  it('walks the 14 / 23 / 30 day clock', () => {
    const dueAt = new Date('2026-10-01T00:00:00Z');
    const at = (d: number) => dunningStage({ dueAt, now: new Date(dueAt.getTime() + d * 86_400_000), pastDueAfterDays: 14, readOnlyAfterDays: 30 });
    expect(at(13).stage).toBe('current');
    expect(at(14).stage).toBe('past_due');
    expect(at(23).stage).toBe('final_warning');
    expect(at(30).stage).toBe('suspended');
  });

  it('holds the clock while paused', () => {
    const dueAt = new Date('2026-10-01T00:00:00Z');
    const now = new Date('2026-11-15T00:00:00Z');
    expect(dunningStage({ dueAt, now, pastDueAfterDays: 14, readOnlyAfterDays: 30, pausedUntil: new Date('2026-12-01T00:00:00Z') }).stage).toBe('current');
  });
});
