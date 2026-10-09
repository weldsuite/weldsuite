import { describe, expect, it } from 'vitest';
import { californiaSplit, computeOvertime, workweekStart, type HoursEntry } from './overtime';

const SUNDAY = 0;
// 2026-03-01 is a Sunday.
const day = (offset: number): string => {
  const d = new Date(Date.UTC(2026, 2, 1 + offset));
  return d.toISOString().slice(0, 10);
};
const hours = (offsets: number[], h: number, rateDollars = 20): HoursEntry[] =>
  offsets.map((o) => ({ date: day(o), hours: h, rateCents: rateDollars * 100, multiplier: null }));

describe('FLSA workweeks', () => {
  it('finds the workweek start for any start day', () => {
    expect(workweekStart('2026-03-04', SUNDAY)).toBe('2026-03-01');
    expect(workweekStart('2026-03-04', 1)).toBe('2026-03-02');
    expect(workweekStart('2026-03-01', 1)).toBe('2026-02-23');
  });

  it('pays half-time on hours over 40 and reports it as qualified overtime (FS-2026-13 Q12)', () => {
    const r = computeOvertime({
      entries: hours([1, 2, 3, 4, 5], 9),
      periodStart: day(0),
      periodEnd: day(6),
      workweekStartDay: SUNDAY,
      california: false,
      salariedRegularRateCents: null,
      ytd: {},
    });
    expect(r.weeks[0]).toMatchObject({ hours: 45, flsaOvertimeHours: 5, regularRateCents: 2_000 });
    expect(r.lines).toEqual([{ kind: 'overtime_premium', hours: 5, rate: 10, amountCents: 5_000 }]);
    expect(r.qualifiedOvertimeCents).toBe(5_000);
  });

  it('does not average two workweeks (38 h and 46 h)', () => {
    const r = computeOvertime({
      entries: [...hours([1, 2, 3, 4], 9.5), ...hours([8, 9, 10, 11, 12], 9.2)],
      periodStart: day(0),
      periodEnd: day(13),
      workweekStartDay: SUNDAY,
      california: false,
      salariedRegularRateCents: null,
      ytd: {},
    });
    expect(r.weeks.map((w) => w.flsaOvertimeHours)).toEqual([0, 6]);
    expect(r.qualifiedOvertimeCents).toBe(6_000);
  });

  it('regular rate is the weighted average of different hourly rates (FS-2026-13 Q15)', () => {
    const r = computeOvertime({
      entries: [...hours([1, 2, 3, 4], 10, 20), ...hours([5], 10, 30)],
      periodStart: day(0),
      periodEnd: day(6),
      workweekStartDay: SUNDAY,
      california: false,
      salariedRegularRateCents: null,
      ytd: {},
    });
    // (40 × 20 + 10 × 30) / 50 = 22.00; premium 10 × 11.00.
    expect(r.weeks[0].regularRateCents).toBe(2_200);
    expect(r.qualifiedOvertimeCents).toBe(11_000);
  });

  it('FS-2026-13 Q16: double time paid by the employer — only the FLSA half-time ($100) is qualified', () => {
    const manual: HoursEntry = { date: day(5), hours: 10, rateCents: 2_000, multiplier: 2 };
    const r = computeOvertime({
      entries: [...hours([1, 2, 3, 4], 10), manual],
      periodStart: day(0),
      periodEnd: day(6),
      workweekStartDay: SUNDAY,
      california: false,
      salariedRegularRateCents: null,
      ytd: {},
    });
    // The $200 premium paid through the manual line covers the $100 FLSA premium: nothing more is due.
    expect(r.lines).toEqual([]);
    expect(r.weeks[0]).toMatchObject({ hours: 50, creditedCents: 20_000, requiredCents: 10_000 });
    expect(r.qualifiedOvertimeCents).toBe(10_000);
  });

  it('settles a workweek that straddles two pay periods in the period where it ends', () => {
    // Period 1 ends Wednesday 4 March; the workweek runs Sunday 1 – Saturday 7 March.
    const first = computeOvertime({
      entries: hours([0, 1, 2, 3], 10),
      periodStart: '2026-02-19',
      periodEnd: day(3),
      workweekStartDay: SUNDAY,
      california: false,
      salariedRegularRateCents: null,
      ytd: {},
    });
    expect(first.lines).toEqual([]);
    expect(first.carryOut).toEqual({
      'us.ot_carry.2026-03-01.d0': 1_000,
      'us.ot_carry.2026-03-01.d1': 1_000,
      'us.ot_carry.2026-03-01.d2': 1_000,
      'us.ot_carry.2026-03-01.d3': 1_000,
      'us.ot_carry.2026-03-01.pay': 80_000,
    });
    const second = computeOvertime({
      entries: hours([4, 5, 6], 8),
      periodStart: day(4),
      periodEnd: day(17),
      workweekStartDay: SUNDAY,
      california: false,
      salariedRegularRateCents: null,
      ytd: { ...first.carryOut, 'us.gross': 123 },
    });
    // 64 hours: 24 overtime hours × $10.
    expect(second.weeks[0]).toMatchObject({ weekStart: '2026-03-01', hours: 64, flsaOvertimeHours: 24 });
    expect(second.qualifiedOvertimeCents).toBe(24_000);
    expect(second.settledCarryKeys.sort()).toEqual(Object.keys(first.carryOut).sort());
    expect(second.carryOut).toEqual({});
  });

  it('salaried non-exempt: hours over 40 are paid in full at 1.5 × (weekly salary ÷ 40)', () => {
    const r = computeOvertime({
      entries: hours([1, 2, 3, 4, 5], 9, 0),
      periodStart: day(0),
      periodEnd: day(6),
      workweekStartDay: SUNDAY,
      california: false,
      salariedRegularRateCents: 2_500,
      ytd: {},
    });
    expect(r.lines).toEqual([{ kind: 'overtime', hours: 5, rate: 37.5, amountCents: 18_750 }]);
    expect(r.qualifiedOvertimeCents).toBe(6_250);
  });
});

describe('California daily overtime', () => {
  it('splits days into regular, 1.5× over 8 and 2× over 12', () => {
    expect(californiaSplit([0, 10, 13, 8, 8, 8, 0])).toEqual({ regular: 40, overtime: 6, doubleTime: 1 });
  });

  it('applies the seventh-consecutive-day rule: 1.5× for the first 8 hours, 2× after', () => {
    expect(californiaSplit([6, 6, 6, 6, 6, 6, 6])).toEqual({ regular: 36, overtime: 6, doubleTime: 0 });
    expect(californiaSplit([6, 6, 6, 6, 6, 6, 10])).toEqual({ regular: 36, overtime: 8, doubleTime: 2 });
  });

  it('counts regular hours over 40 in the week as overtime', () => {
    expect(californiaSplit([0, 8, 8, 8, 8, 8, 8])).toEqual({ regular: 40, overtime: 8, doubleTime: 0 });
  });

  it('pays CA premiums but reports only the FLSA half-time premium as qualified', () => {
    const entries = [...hours([1], 10), ...hours([2], 13), ...hours([3, 4, 5], 8)];
    const r = computeOvertime({
      entries,
      periodStart: day(0),
      periodEnd: day(6),
      workweekStartDay: SUNDAY,
      california: true,
      salariedRegularRateCents: null,
      ytd: {},
    });
    // 47 hours: CA 6 h at +0.5 and 1 h at +1.0 → $60 + $20; FLSA 7 h over 40 → $70 qualified.
    expect(r.lines).toEqual([
      { kind: 'overtime_premium', hours: 6, rate: 10, amountCents: 6_000 },
      { kind: 'double_time_premium', hours: 1, rate: 20, amountCents: 2_000 },
    ]);
    expect(r.qualifiedOvertimeCents).toBe(7_000);
  });

  it('daily overtime in a week under 40 hours has no qualified overtime', () => {
    const r = computeOvertime({
      entries: hours([1, 2, 3], 11),
      periodStart: day(0),
      periodEnd: day(6),
      workweekStartDay: SUNDAY,
      california: true,
      salariedRegularRateCents: null,
      ytd: {},
    });
    expect(r.lines).toEqual([{ kind: 'overtime_premium', hours: 9, rate: 10, amountCents: 9_000 }]);
    expect(r.qualifiedOvertimeCents).toBe(0);
  });
});
