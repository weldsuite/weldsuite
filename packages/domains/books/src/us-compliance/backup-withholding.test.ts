import { describe, it, expect } from 'vitest';
import {
  BACKUP_WITHHOLDING_RATE,
  backupWithholdingDetail,
  backupWithholdingFor,
  backupWithholdingReason,
  form945Summary,
} from './backup-withholding';

describe('backupWithholdingFor', () => {
  it('withholds 24% from a vendor without a TIN or under an IRS notice', () => {
    expect(BACKUP_WITHHOLDING_RATE).toBe(0.24);
    expect(backupWithholdingFor(1000, { hasTin: false })).toBe(240);
    expect(backupWithholdingFor(1000, { backupWithholding: true })).toBe(240);
    expect(backupWithholdingDetail(1000, { backupWithholding: true })).toEqual({
      applies: true,
      reason: 'flagged',
      withheld: 240,
      net: 760,
    });
    expect(backupWithholdingReason({ hasTin: false, backupWithholding: true })).toBe('no_tin');
  });

  it('withholds nothing from a vendor in good standing, an exempt payee or a non-positive amount', () => {
    expect(backupWithholdingFor(1000, {})).toBe(0);
    expect(backupWithholdingFor(1000, { hasTin: true, backupWithholding: false })).toBe(0);
    expect(backupWithholdingFor(1000, { hasTin: false, exemptPayee: true })).toBe(0);
    expect(backupWithholdingFor(0, { hasTin: false })).toBe(0);
    expect(backupWithholdingFor(-50, { hasTin: false })).toBe(0);
    expect(backupWithholdingDetail(1000, {})).toEqual({ applies: false, reason: null, withheld: 0, net: 1000 });
  });

  it('rounds to the cent, half a cent up', () => {
    expect(backupWithholdingFor(0.1 + 0.2, { hasTin: false })).toBe(0.07); // 0.30 * 24% = 0.072
    expect(backupWithholdingFor(33.33, { hasTin: false })).toBe(8); // 7.9992
    expect(backupWithholdingFor(0.02, { hasTin: false })).toBe(0); // 0.0048
    expect(backupWithholdingFor(0.03, { hasTin: false })).toBe(0.01); // 0.0072
    expect(backupWithholdingFor(0.625, { hasTin: false })).toBe(0.15); // 0.15
    expect(backupWithholdingDetail(33.33, { hasTin: false }).net).toBe(25.33);
  });

  it('starts at the payment that reaches the reporting threshold', () => {
    const vendor = { hasTin: false };
    expect(backupWithholdingFor(500, vendor, { yearToDate: 0, threshold: 2000 })).toBe(0);
    expect(backupWithholdingFor(500, vendor, { yearToDate: 1500, threshold: 2000 })).toBe(120);
    expect(backupWithholdingFor(500, vendor, { yearToDate: 3000, threshold: 2000 })).toBe(120);
    expect(backupWithholdingFor(500, vendor, { yearToDate: 0, threshold: null })).toBe(120);
  });
});

describe('form945Summary', () => {
  const payments = [
    { id: 'p1', partyId: 'a', date: '2026-01-10', backupWithholdingAmount: 240 },
    { id: 'p2', partyId: 'a', date: '2026-01-25', backupWithholdingAmount: 120.5 },
    { id: 'p3', partyId: 'b', date: '2026-12-30', backupWithholdingAmount: 48 },
    { id: 'p4', partyId: 'b', date: '2025-12-31', backupWithholdingAmount: 1000 },
    { id: 'p5', partyId: 'b', date: '2026-05-05', backupWithholdingAmount: 0 },
    { id: 'p6', partyId: 'c', date: '2026-06-06', backupWithholdingAmount: 500, voided: true },
    { id: 'p7', partyId: 'c', date: '2026-06-07' },
  ];

  it('totals the year by month and by vendor', () => {
    const summary = form945Summary(2026, payments);
    expect(summary.backupWithholding).toBe(408.5);
    expect(summary.totalTaxes).toBe(408.5);
    expect(summary.months).toHaveLength(12);
    expect(summary.months[0]).toMatchObject({ month: 1, amount: 360.5 });
    expect(summary.months[11]).toMatchObject({ month: 12, amount: 48 });
    expect(summary.months.slice(1, 11).every((month) => month.amount === 0)).toBe(true);
    expect(summary.byVendor).toEqual([
      { partyId: 'a', amount: 360.5, paymentIds: ['p1', 'p2'] },
      { partyId: 'b', amount: 48, paymentIds: ['p3'] },
    ]);
  });

  it('dates the deposits and the return', () => {
    const summary = form945Summary(2026, payments);
    expect(summary.dueDate).toBe('2027-02-01');
    expect(summary.months[0]?.depositDue).toBe('2026-02-17'); // 15 Feb is a Sunday, then Presidents' Day
    expect(summary.months[11]?.depositDue).toBe('2027-01-15');
    expect(summary.months[2]?.depositDue).toBe('2026-04-15');
  });

  it('handles a year without withholding', () => {
    const summary = form945Summary(2026, []);
    expect(summary).toMatchObject({ backupWithholding: 0, totalTaxes: 0, byVendor: [] });
  });
});
