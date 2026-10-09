/**
 * Pure parts of the Sales Tax Center: vendor discounts, adjustments, return
 * periods and the cure rule of the export.
 */

import { describe, expect, it } from 'vitest';
import type { TaxReturnLine } from '@weldsuite/books-domain/jurisdictions/types';
import { getUsState } from '@weldsuite/books-domain/jurisdictions/us/states';
import {
  proposeVendorDiscount,
  refreshAdjustments,
  sameWorksheet,
  vendorDiscountFor,
  type ReturnSummary,
} from './calculate';
import { applyCureRule } from './export';
import { agencyPeriods, buildPeriodRows, matchPeriod, nextPeriodToOpen, periodState } from './periods';
import { computeTotalDue, registeredOn, todayIn, type AgencyRow, type ReturnAdjustment, type ReturnRow } from './common';

function agency(over: Partial<AgencyRow> = {}): AgencyRow {
  return {
    id: 'agy_1', createdAt: new Date(), updatedAt: new Date(), deletedAt: null, entityId: 'ent_1', stateCode: 'TX', level: 'state',
    localJurisdictionCode: null, name: 'Texas', registrationNumber: null, registeredFrom: '2026-01-01', registeredUntil: null,
    status: 'registered', filingFrequency: 'quarterly', firstPeriodStart: '2026-01-01', dueDay: 20, reportingBasis: 'accrual',
    sstMember: false, liabilityAccountId: null, useTaxAccountId: null, portalUrl: null, providerRegistrationRef: null, notes: null,
    ...over,
  } as AgencyRow;
}

describe('vendor discount', () => {
  it('applies the percentage, the cap and the tiers of the state', () => {
    // Texas: 0.5%
    expect(vendorDiscountFor(getUsState('TX')?.vendorDiscount, 10_000)).toBe(50);
    // Florida: 2.5% capped at $30
    expect(vendorDiscountFor(getUsState('FL')?.vendorDiscount, 400)).toBe(10);
    expect(vendorDiscountFor(getUsState('FL')?.vendorDiscount, 5_000)).toBe(30);
    // Georgia: 3% of the first $3,000, 0.5% above
    expect(vendorDiscountFor(getUsState('GA')?.vendorDiscount, 20)).toBe(0.6);
    expect(vendorDiscountFor(getUsState('GA')?.vendorDiscount, 3_000)).toBe(90);
    expect(vendorDiscountFor(getUsState('GA')?.vendorDiscount, 5_000)).toBe(100);
    // no rule, nothing due, a credit
    expect(vendorDiscountFor(getUsState('CA')?.vendorDiscount, 1_000)).toBe(0);
    expect(vendorDiscountFor(getUsState('TX')?.vendorDiscount, 0)).toBe(0);
    expect(vendorDiscountFor(getUsState('TX')?.vendorDiscount, -50)).toBe(0);
  });

  it('is a proposal that is dropped once the due date has passed', () => {
    expect(proposeVendorDiscount({ stateCode: 'TX', salesTaxDue: 200, dueDate: '2026-10-20', today: '2026-10-08' })).toEqual({
      available: true, amount: 1, requiresTimelyFilingBy: '2026-10-20', late: false,
      note: '0.5% for timely filing, plus 1.25% for prepayment',
    });
    expect(proposeVendorDiscount({ stateCode: 'TX', salesTaxDue: 200, dueDate: '2026-10-20', today: '2026-10-21' }).late).toBe(true);
    expect(proposeVendorDiscount({ stateCode: 'CA', salesTaxDue: 200, dueDate: '2026-10-20', today: '2026-10-08' }).available).toBe(false);
  });
});

describe('adjustments', () => {
  const summary = (amount: number, late = false): ReturnSummary =>
    ({
      vendorDiscount: { available: true, amount, requiresTimelyFilingBy: '2026-10-20', late, note: 'rule' },
    }) as unknown as ReturnSummary;

  it('proposes the discount when none is set, refreshes an automatic one and leaves a manual one alone', () => {
    const proposed = refreshAdjustments([{ type: 'penalty', amount: 5 }], summary(0.5), false);
    expect(proposed).toEqual([
      { type: 'penalty', amount: 5 },
      expect.objectContaining({ type: 'vendor_discount', amount: -0.5, auto: true }),
    ]);
    const refreshed = refreshAdjustments(proposed, summary(0.7), false);
    expect(refreshed[1]).toMatchObject({ amount: -0.7, auto: true });
    // the user's own discount stays
    const manual: ReturnAdjustment[] = [{ type: 'vendor_discount', amount: -2 }];
    expect(refreshAdjustments(manual, summary(0.7), false)).toEqual(manual);
    // an automatic one goes when late, on an amendment or when the state has none
    expect(refreshAdjustments(proposed, summary(0.7, true), false)).toEqual([{ type: 'penalty', amount: 5 }]);
    expect(refreshAdjustments(proposed, summary(0.7), true)).toEqual([{ type: 'penalty', amount: 5 }]);
    expect(refreshAdjustments([], summary(0.7, true), false)).toEqual([]);
    expect(refreshAdjustments([], summary(0), false)).toEqual([]);
  });

  it('adds the adjustments to the tax payable', () => {
    expect(computeTotalDue({ salesTaxPayable: 100.65, useTaxPayable: 12.5 }, [{ type: 'vendor_discount', amount: -0.46 }, { type: 'penalty', amount: 10.1 }])).toBe(122.79);
    expect(computeTotalDue(null, [])).toBe(0);
  });

  it('compares worksheets on their figures', () => {
    const base = { rowCount: 3, grossSales: 10, taxableSales: 9, salesTaxDue: 1, useTaxDue: 0 } as unknown as ReturnSummary;
    expect(sameWorksheet({ ...base }, base)).toBe(true);
    expect(sameWorksheet({ ...base, rowCount: 4 }, base)).toBe(false);
    expect(sameWorksheet({ ...base, salesTaxDue: 1.01 }, base)).toBe(false);
    expect(sameWorksheet(null, base)).toBe(false);
  });
});

describe('return periods', () => {
  it('follows the filing frequency from the first period start, with the due day rolled to a business day', () => {
    const quarterly = agencyPeriods(agency(), '2026-01-01', '2026-12-31');
    expect(quarterly.map((p) => [p.periodStart, p.periodEnd, p.dueDate])).toEqual([
      ['2026-01-01', '2026-03-31', '2026-04-20'],
      ['2026-04-01', '2026-06-30', '2026-07-20'],
      ['2026-07-01', '2026-09-30', '2026-10-20'],
      ['2026-10-01', '2026-12-31', '2027-01-20'],
    ]);
    const monthly = agencyPeriods(agency({ filingFrequency: 'monthly', firstPeriodStart: '2026-06-15', dueDay: 25 }), '2026-06-01', '2026-08-31');
    // the first period starts when the registration did; 25 July 2026 is a Saturday
    expect(monthly.map((p) => [p.periodStart, p.periodEnd, p.dueDate])).toEqual([
      ['2026-06-15', '2026-06-30', '2026-07-27'],
      ['2026-07-01', '2026-07-31', '2026-08-25'],
      ['2026-08-01', '2026-08-31', '2026-09-25'],
    ]);
    expect(agencyPeriods(agency({ filingFrequency: 'annual', firstPeriodStart: '2026-01-01' }), '2026-01-01', '2027-12-31')).toHaveLength(2);
    expect(agencyPeriods(agency({ firstPeriodStart: null, registeredFrom: null }), '2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('stops at the end of the registration', () => {
    const closing = agency({ status: 'closed', registeredUntil: '2026-05-15' });
    expect(agencyPeriods(closing, '2026-01-01', '2026-12-31').map((p) => p.periodEnd)).toEqual(['2026-03-31', '2026-06-30']);
    // the final return stops where the registration did
    expect(matchPeriod(closing, '2026-04-01', '2026-05-15')).toMatchObject({ periodStart: '2026-04-01', periodEnd: '2026-05-15' });
  });

  it('matches exact grid periods only', () => {
    expect(matchPeriod(agency(), '2026-07-01', '2026-09-30')).toMatchObject({ dueDate: '2026-10-20', key: 'sales_tax:agy_1:2026-09-30' });
    expect(matchPeriod(agency(), '2026-07-01', '2026-08-31')).toBeUndefined();
    expect(matchPeriod(agency(), '2026-07-02', '2026-09-30')).toBeUndefined();
  });

  it('opens the first period without a return that has started', () => {
    const own = (periodEnd: string, over: Partial<ReturnRow> = {}) => ({ id: `r_${periodEnd}`, periodEnd, amendsReturnId: null, ...over }) as ReturnRow;
    expect(nextPeriodToOpen(agency(), [own('2026-03-31')], '2026-10-08').periodEnd).toBe('2026-06-30');
    // an amendment does not take the period
    expect(nextPeriodToOpen(agency(), [own('2026-03-31'), own('2026-06-30', { amendsReturnId: 'x' })], '2026-10-08').periodEnd).toBe('2026-06-30');
    // the fourth quarter has started on 1 October
    expect(nextPeriodToOpen(agency(), [own('2026-03-31'), own('2026-06-30'), own('2026-09-30')], '2026-10-08').periodEnd).toBe('2026-12-31');
    expect(() => nextPeriodToOpen(agency(), [own('2026-03-31'), own('2026-06-30'), own('2026-09-30'), own('2026-12-31')], '2026-10-08')).toThrow(/already has a return/);
    expect(() => nextPeriodToOpen(agency({ firstPeriodStart: null, registeredFrom: null }), [], '2026-10-08')).toThrow(/first period start/);
  });

  it('flags unfiled and overdue periods and keeps amendments apart', () => {
    const filed = { id: 'r1', periodEnd: '2026-03-31', status: 'paid', totalDue: '10.00', filedAt: new Date(), paidAt: new Date(), confirmationNumber: 'C', amendsReturnId: null } as unknown as ReturnRow;
    const amendment = { ...filed, id: 'r2', status: 'calculated', amendsReturnId: 'r1' } as ReturnRow;
    const rows = buildPeriodRows(agency(), [filed, amendment], '2026-01-01', '2026-12-31', '2026-10-08');
    expect(rows.map((r) => [r.periodEnd, r.state, r.unfiled, r.overdue])).toEqual([
      ['2026-03-31', 'paid', false, false],
      ['2026-06-30', 'overdue', true, true],
      ['2026-09-30', 'due', true, false],
      ['2026-12-31', 'in_progress', false, false],
    ]);
    expect(rows[0]!.return).toMatchObject({ id: 'r1', status: 'paid', totalDue: 10 });
    expect(rows[0]!.amendments.map((a) => a.id)).toEqual(['r2']);
    expect(periodState({ periodStart: '2027-01-01', periodEnd: '2027-03-31', dueDate: '2027-04-20', today: '2026-10-08' })).toBe('upcoming');
  });
});

describe('common helpers', () => {
  it('finds today in the entity time zone', () => {
    expect(todayIn('America/Chicago', new Date('2026-10-09T03:00:00Z'))).toBe('2026-10-08');
    expect(todayIn('Pacific/Auckland', new Date('2026-10-08T20:00:00Z'))).toBe('2026-10-09');
    expect(todayIn('Nowhere/Land', new Date('2026-10-08T20:00:00Z'))).toBe('2026-10-08');
  });

  it('tells when a registration holds', () => {
    const agencies = [agency({ registeredFrom: '2026-03-01', registeredUntil: '2026-09-30' }), agency({ id: 'p', stateCode: 'WA', status: 'pending' })];
    expect(registeredOn(agencies, 'tx', '2026-05-01')).toBe(true);
    expect(registeredOn(agencies, 'TX', '2026-02-01')).toBe(false);
    expect(registeredOn(agencies, 'TX', '2026-10-01')).toBe(false);
    expect(registeredOn(agencies, 'WA', '2026-05-01')).toBe(false);
    expect(registeredOn(agencies, null, '2026-05-01')).toBe(false);
  });
});

describe('export cure rule', () => {
  const line = (over: Partial<TaxReturnLine & { certificateId?: string | null }> = {}): TaxReturnLine =>
    ({
      taxRateId: '', taxCategoryCode: '', taxableAmount: 0, taxAmount: 0, kind: 'sales', direction: 'sales', rate: 8.25,
      grossAmount: 100, exemptAmount: 100, nonTaxableAmount: 0, exemptReason: 'resale', taxDate: '2026-07-05', certificateId: null,
      ...over,
    }) as TaxReturnLine;

  it('turns an exempt sale without a certificate past its 90 days into a taxable one', () => {
    const [row] = applyCureRule([line()], '2026-10-08');
    expect(row).toMatchObject({ taxableAmount: 100, taxAmount: 8.25, exemptAmount: 0, exemptReason: null });
  });

  it('leaves certified, in-time, marketplace, use tax and non-exempt rows alone', () => {
    const rows = [
      line({ certificateId: 'cert_1' } as never),
      line({ taxDate: '2026-09-20' }),
      line({ marketplaceFacilitated: true }),
      line({ kind: 'use' }),
      line({ exemptAmount: 0 }),
    ];
    expect(applyCureRule(rows, '2026-10-08')).toEqual(rows);
  });
});
