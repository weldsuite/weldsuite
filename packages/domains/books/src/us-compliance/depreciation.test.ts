import { describe, it, expect } from 'vitest';
import {
  calendarFiscalYears,
  depreciationBasis,
  depreciationSchedule,
  disposalYearFraction,
  fiscalYearsFrom,
  gainOnDisposal,
  macrsConventions,
  midQuarterTest,
  midQuarterTestBasis,
  monthlySchedule,
  requiresAds,
  type DepreciationAsset,
  type DepreciationBook,
  type FiscalPeriod,
} from './depreciation';
import { MACRS_HALF_YEAR, MACRS_MID_QUARTER, type MacrsTableClass } from './depreciation-tables';
import { addDays } from './dates';

function asset(over: Partial<DepreciationAsset> = {}): DepreciationAsset {
  return { cost: 10_000, acquisitionDate: '2024-01-01', placedInServiceDate: '2026-03-15', ...over };
}

function gds(recoveryYears: number, convention: DepreciationBook['convention'] = 'half_year', over: Partial<DepreciationBook> = {}): DepreciationBook {
  return { method: 'macrs_gds', convention, recoveryYears, ...over };
}

function book(method: DepreciationBook['method'], convention: DepreciationBook['convention'], recoveryYears: number, over: Partial<DepreciationBook> = {}): DepreciationBook {
  return { method, convention, recoveryYears, ...over };
}

const amounts = (schedule: ReturnType<typeof depreciationSchedule>) => schedule.rows.map((row) => row.amount);
const total = (values: readonly number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100;

/** Fiscal years of whole weeks, for 52-53 week companies. */
function weekYears(start: string, weeks: number[]): FiscalPeriod[] {
  const periods: FiscalPeriod[] = [];
  let first = start;
  weeks.forEach((count, index) => {
    const last = addDays(first, count * 7 - 1);
    periods.push({ label: `FY${index + 1}`, start: first, end: last });
    first = addDays(last, 1);
  });
  return periods;
}

describe('MACRS GDS with the percentage tables', () => {
  it('depreciates 5-year property by the half-year table (20, 32, 19.2, 11.52, 11.52, 5.76)', () => {
    const schedule = depreciationSchedule(asset(), gds(5));
    expect(amounts(schedule)).toEqual([2_000, 3_200, 1_920, 1_152, 1_152, 576]);
    expect(schedule.rows.map((row) => row.label)).toEqual(['2026', '2027', '2028', '2029', '2030', '2031']);
    expect(schedule.rows.map((row) => row.accumulated)).toEqual([2_000, 5_200, 7_120, 8_272, 9_424, 10_000]);
    expect(schedule.rows.map((row) => row.remaining)).toEqual([8_000, 4_800, 2_880, 1_728, 576, 0]);
    expect(schedule.issues).toEqual([]);
    expect(schedule.method).toBe('macrs_gds');
  });

  it('depreciates 7-year property by the half-year table', () => {
    expect(amounts(depreciationSchedule(asset(), gds(7)))).toEqual([1_429, 2_449, 1_749, 1_249, 893, 892, 893, 446]);
  });

  it('uses the mid-quarter table of the quarter the property was placed in service', () => {
    const firstYear = (placedInServiceDate: string) => amounts(depreciationSchedule(asset({ placedInServiceDate }), gds(5, 'mid_quarter')))[0];
    expect(firstYear('2026-02-10')).toBe(3_500);
    expect(firstYear('2026-05-10')).toBe(2_500);
    expect(firstYear('2026-08-10')).toBe(1_500);
    expect(firstYear('2026-11-10')).toBe(500);
    expect(amounts(depreciationSchedule(asset({ placedInServiceDate: '2026-11-15' }), gds(5, 'mid_quarter')))).toEqual([500, 3_800, 2_280, 1_368, 1_094, 958]);
  });

  it('adds to the exact basis for every class, convention and quarter', () => {
    for (const cost of [100_000, 12_345.67]) {
      for (const years of [3, 5, 7, 10, 15, 20] as const) {
        const dates = ['2026-02-10', '2026-05-10', '2026-08-10', '2026-11-10'];
        const cases = [
          { convention: 'half_year' as const, date: '2026-03-15' },
          ...dates.map((date) => ({ convention: 'mid_quarter' as const, date })),
        ];
        for (const { convention, date } of cases) {
          const schedule = depreciationSchedule(asset({ cost, placedInServiceDate: date }), gds(years, convention));
          const label = `${years}-year ${convention} ${date} cost ${cost}`;
          expect(schedule.rows, label).toHaveLength(years + 1);
          expect(schedule.rows.at(-1)?.accumulated, label).toBe(cost);
          expect(schedule.rows.at(-1)?.remaining, label).toBe(0);
          expect(Math.min(...amounts(schedule)), label).toBeGreaterThanOrEqual(0);
          expect(total(amounts(schedule)), label).toBe(cost);
        }
      }
    }
  });

  it('depreciates 27.5-year residential rental property by the mid-month table', () => {
    const schedule = depreciationSchedule(asset({ cost: 100_000 }), gds(27.5, 'mid_month'));
    const rows = amounts(schedule);
    expect(rows[0]).toBe(2_879);
    expect(rows.slice(1, 9)).toEqual(Array(8).fill(3_636));
    expect(rows[9]).toBe(3_637);
    expect(rows[10]).toBe(3_636);
    expect(rows).toHaveLength(28);
    expect(rows.at(-1)).toBe(2_576);
    expect(total(rows)).toBe(100_000);
  });

  it('puts the part year of residential property placed in service late in the year in year 29', () => {
    const schedule = depreciationSchedule(asset({ cost: 100_000, placedInServiceDate: '2026-12-10' }), gds(27.5, 'mid_month'));
    expect(amounts(schedule)[0]).toBe(152);
    expect(schedule.rows).toHaveLength(29);
    expect(schedule.rows.at(-2)?.amount).toBe(3_636);
    expect(schedule.rows.at(-1)?.amount).toBe(1_667);
    expect(schedule.rows.at(-1)?.accumulated).toBe(100_000);
  });

  it('depreciates 39-year nonresidential property by the mid-month table', () => {
    const january = amounts(depreciationSchedule(asset({ cost: 100_000, placedInServiceDate: '2026-01-20' }), gds(39, 'mid_month')));
    expect(january).toHaveLength(40);
    expect(january[0]).toBe(2_461);
    expect(january.slice(1, 39)).toEqual(Array(38).fill(2_564));
    expect(january[39]).toBe(107);
    expect(total(january)).toBe(100_000);
    const december = amounts(depreciationSchedule(asset({ cost: 100_000, placedInServiceDate: '2026-12-02' }), gds(39, 'mid_month')));
    expect([december[0], december[39]]).toEqual([107, 2_461]);
    const march = amounts(depreciationSchedule(asset({ cost: 100_000, placedInServiceDate: '2026-03-02' }), gds(39, 'mid_month')));
    expect(march[0]).toBe(2_033);
  });

  it('corrects a convention that does not fit the property and says so', () => {
    const real = depreciationSchedule(asset(), gds(39, 'half_year'));
    expect(real.convention).toBe('mid_month');
    expect(real.issues.map((issue) => issue.code)).toEqual(['convention_changed']);
    const personal = depreciationSchedule(asset(), gds(5, 'mid_month'));
    expect(personal.convention).toBe('half_year');
    expect(amounts(personal)[0]).toBe(2_000);
    expect(personal.issues.map((issue) => issue.code)).toEqual(['convention_changed']);
    expect(depreciationSchedule(asset(), gds(5, 'full_month')).convention).toBe('half_year');
  });

  it('takes business use into account', () => {
    const schedule = depreciationSchedule(asset({ businessUsePercent: 80 }), gds(5));
    expect(schedule.basis).toMatchObject({ baseCost: 8_000, depreciableBasis: 8_000, totalDepreciable: 8_000 });
    expect(amounts(schedule)).toEqual([1_600, 2_560, 1_536, 921.6, 921.6, 460.8]);
    expect(total(amounts(schedule))).toBe(8_000);
  });

  it('refuses a class without a table', () => {
    const schedule = depreciationSchedule(asset(), gds(31.5, 'half_year'));
    expect(schedule.rows).toEqual([]);
    expect(schedule.issues).toMatchObject([{ severity: 'error', code: 'unsupported_recovery_period' }]);
  });
});

describe('straight line GDS and ADS', () => {
  it('depreciates 25-year water utility property straight line', () => {
    const rows = amounts(depreciationSchedule(asset(), gds(25)));
    expect(rows).toHaveLength(26);
    expect([rows[0], rows[1], rows[24], rows[25]]).toEqual([200, 400, 400, 200]);
    expect(total(rows)).toBe(10_000);
  });

  it('depreciates qualified improvement property straight line when elected', () => {
    const schedule = depreciationSchedule(asset(), gds(15, 'half_year', { straightLine: true }));
    const rows = amounts(schedule);
    expect(rows).toHaveLength(16);
    expect([rows[0], rows[1], rows[14], rows[15]]).toEqual([333.33, 666.67, 666.67, 333.33]);
    expect(total(rows)).toBe(10_000);
  });

  it('depreciates ADS property straight line with the half-year or mid-quarter convention', () => {
    expect(amounts(depreciationSchedule(asset(), book('macrs_ads', 'half_year', 5)))).toEqual([1_000, 2_000, 2_000, 2_000, 2_000, 1_000]);
    const quarter = depreciationSchedule(asset({ placedInServiceDate: '2026-11-15' }), book('macrs_ads', 'mid_quarter', 12));
    expect(quarter.rows).toHaveLength(13);
    expect(quarter.rows[0]?.amount).toBe(104.17);
    expect(quarter.rows[1]?.amount).toBe(833.33);
    expect(quarter.rows.at(-1)?.amount).toBe(729.17);
    expect(quarter.rows.at(-1)?.accumulated).toBe(10_000);
  });

  it('depreciates ADS real property from the middle of its month', () => {
    const rows = amounts(depreciationSchedule(asset({ cost: 100_000, placedInServiceDate: '2026-01-10' }), book('macrs_ads', 'mid_month', 40)));
    expect(rows).toHaveLength(41);
    expect(rows[0]).toBe(2_395.83);
    expect(rows[1]).toBe(2_500);
    expect(rows.at(-1)).toBe(104.17);
    expect(total(rows)).toBe(100_000);
  });

  it('forces ADS on listed property used 50% or less for business and drops section 179 and bonus', () => {
    expect(requiresAds({ listedProperty: true, businessUsePercent: 50 })).toBe(true);
    expect(requiresAds({ listedProperty: true, businessUsePercent: 51 })).toBe(false);
    expect(requiresAds({ listedProperty: false, businessUsePercent: 10 })).toBe(false);
    const schedule = depreciationSchedule(
      asset({ listedProperty: true, businessUsePercent: 50 }),
      gds(5, 'half_year', { section179Amount: 3_000, bonusPercent: 100, adsRecoveryYears: 6 }),
    );
    expect(schedule.method).toBe('macrs_ads');
    expect(schedule.recoveryYears).toBe(6);
    expect(schedule.basis).toMatchObject({ baseCost: 5_000, section179: 0, bonus: 0, depreciableBasis: 5_000 });
    expect(schedule.issues.map((issue) => issue.code).sort()).toEqual(['ads_required', 'bonus_not_allowed', 'section_179_not_allowed']);
    expect(amounts(schedule)).toEqual([416.67, 833.33, 833.33, 833.34, 833.33, 833.33, 416.67]);
    const noLife = depreciationSchedule(asset({ listedProperty: true, businessUsePercent: 40 }), gds(5));
    expect(noLife.issues.map((issue) => issue.code)).toContain('ads_life_assumed');
  });

  it('keeps listed property used more than 50% for business on GDS with section 179', () => {
    const schedule = depreciationSchedule(asset({ listedProperty: true, businessUsePercent: 60 }), gds(5, 'half_year', { section179Amount: 1_000 }));
    expect(schedule.method).toBe('macrs_gds');
    expect(schedule.basis).toMatchObject({ baseCost: 6_000, section179: 1_000, depreciableBasis: 5_000 });
  });
});

describe('section 179 and bonus depreciation', () => {
  it('works out the basis: cost times business use, less section 179, less bonus on what is left', () => {
    const basis = depreciationBasis(asset({ cost: 100_000 }), gds(7, 'half_year', { section179Amount: 20_000, bonusPercent: 20 }));
    expect(basis).toEqual({
      cost: 100_000,
      businessUsePercent: 100,
      baseCost: 100_000,
      salvage: 0,
      section179: 20_000,
      bonus: 16_000,
      depreciableBasis: 64_000,
      totalDepreciable: 100_000,
    });
  });

  it('deducts section 179 and bonus in the first year with the regular depreciation', () => {
    const schedule = depreciationSchedule(asset({ cost: 100_000 }), gds(7, 'half_year', { section179Amount: 20_000, bonusPercent: 20 }));
    expect(schedule.rows[0]).toMatchObject({ amount: 45_145.6, regular: 9_145.6, section179: 20_000, bonus: 16_000, accumulated: 45_145.6, remaining: 54_854.4 });
    expect(schedule.rows[1]).toMatchObject({ amount: 15_673.6, section179: 0, bonus: 0 });
    expect(schedule.rows.at(-1)?.accumulated).toBe(100_000);
    expect(schedule.rows.at(-1)?.remaining).toBe(0);
  });

  it('expenses everything in the first year with 100% bonus', () => {
    const schedule = depreciationSchedule(asset({ cost: 50_000, acquisitionDate: '2026-02-01' }), gds(5, 'half_year', { bonusPercent: 100 }));
    expect(schedule.rows).toHaveLength(1);
    expect(schedule.rows[0]).toMatchObject({ amount: 50_000, bonus: 50_000, regular: 0, remaining: 0 });
  });

  it('cannot take more section 179 than the cost, or than the year\'s limit', () => {
    const over = depreciationBasis(asset({ cost: 4_000 }), gds(5, 'half_year', { section179Amount: 9_000 }));
    expect(over).toMatchObject({ section179: 4_000, depreciableBasis: 0 });
    const huge = depreciationSchedule(asset({ cost: 5_000_000 }), gds(5, 'half_year', { section179Amount: 3_000_000 }));
    expect(huge.basis.section179).toBe(2_560_000);
    expect(huge.issues.map((issue) => issue.code)).toContain('section_179_reduced');
  });

  it('allows section 179 only above 50% business use', () => {
    const schedule = depreciationSchedule(asset({ businessUsePercent: 50 }), gds(5, 'half_year', { section179Amount: 1_000 }));
    expect(schedule.basis.section179).toBe(0);
    expect(schedule.issues.map((issue) => issue.code)).toEqual(['section_179_not_allowed']);
  });

  it('gives no bonus to real property and no section 179 or bonus to a book method', () => {
    const real = depreciationSchedule(asset(), gds(39, 'mid_month', { bonusPercent: 100 }));
    expect(real.basis.bonus).toBe(0);
    expect(real.issues.map((issue) => issue.code)).toEqual(['bonus_not_allowed']);
    const bookMethod = depreciationSchedule(asset(), book('straight_line', 'full_month', 5, { section179Amount: 1_000, bonusPercent: 50 }));
    expect(bookMethod.basis).toMatchObject({ section179: 0, bonus: 0, depreciableBasis: 10_000 });
    expect(bookMethod.issues.map((issue) => issue.code)).toEqual(['section_179_not_allowed', 'bonus_not_allowed']);
  });
});

describe('mid-quarter test', () => {
  const year = { label: '2026', start: '2026-01-01', end: '2026-12-31' };
  const placed = (id: string, placedInServiceDate: string, basis: number, over: object = {}) => ({ id, placedInServiceDate, basis, ...over });

  it('applies when more than 40% of the basis is placed in service in the last quarter', () => {
    const result = midQuarterTest([placed('a', '2026-02-01', 59_999), placed('b', '2026-11-01', 40_001)], year);
    expect(result.applies).toBe(true);
    expect(result.totalBasis).toBe(100_000);
    expect(result.lastQuarterBasis).toBe(40_001);
    expect(result.lastQuarterShare).toBeCloseTo(0.40001, 6);
    expect(result.quarterBasis).toEqual([59_999, 0, 0, 40_001]);
  });

  it('does not apply at exactly 40%', () => {
    expect(midQuarterTest([placed('a', '2026-02-01', 60_000), placed('b', '2026-12-31', 40_000)], year).applies).toBe(false);
  });

  it('leaves out real property, same-year disposals and other years', () => {
    const result = midQuarterTest(
      [
        placed('a', '2026-03-01', 10_000),
        placed('building', '2026-11-01', 500_000, { realProperty: true }),
        placed('sold', '2026-12-01', 500_000, { disposedInSameYear: true }),
        placed('last-year', '2025-12-01', 500_000),
      ],
      year,
    );
    expect(result).toMatchObject({ applies: false, totalBasis: 10_000, lastQuarterBasis: 0 });
  });

  it('counts basis after section 179 and not after bonus', () => {
    expect(midQuarterTestBasis(100_000, 100, 30_000)).toBe(70_000);
    expect(midQuarterTestBasis(100_000, 80, 30_000)).toBe(50_000);
    expect(midQuarterTestBasis(10_000, 100, 20_000)).toBe(0);
    // $60,000 early; $40,000 late of which $15,000 was expensed under section 179: the late share is 25,000 of 85,000.
    const result = midQuarterTest([placed('a', '2026-02-01', 60_000), placed('b', '2026-11-01', midQuarterTestBasis(40_000, 100, 15_000))], year);
    expect(result.applies).toBe(false);
    expect(result.lastQuarterShare).toBeCloseTo(25_000 / 85_000, 6);
  });

  it('is false for a year without property', () => {
    expect(midQuarterTest([], year)).toMatchObject({ applies: false, totalBasis: 0, lastQuarterShare: 0 });
  });

  it('uses the quarters of a fiscal year that does not start in January', () => {
    const fy = fiscalYearsFrom('2026-04-01', 1)[0] as FiscalPeriod;
    // April to March: the last quarter is January to March.
    expect(midQuarterTest([placed('a', '2026-05-01', 50_000), placed('b', '2027-01-15', 50_000)], fy).quarterBasis).toEqual([50_000, 0, 0, 50_000]);
  });

  it('splits a 52-53 week year into four equal parts by day', () => {
    const [fy] = weekYears('2025-02-02', [52]) as [FiscalPeriod];
    expect(fy.end).toBe('2026-01-31');
    expect(midQuarterTest([placed('a', '2025-11-01', 1)], fy).quarterBasis).toEqual([0, 0, 1, 0]);
    expect(midQuarterTest([placed('a', '2025-11-02', 1)], fy).quarterBasis).toEqual([0, 0, 0, 1]);
  });

  it('picks the convention of each asset across the years', () => {
    const periods = calendarFiscalYears(2026, 2);
    const conventions = macrsConventions(
      [
        { id: 'early', placedInServiceDate: '2026-02-01', basis: 10_000 },
        { id: 'late', placedInServiceDate: '2026-11-01', basis: 90_000 },
        { id: 'building', placedInServiceDate: '2026-11-01', basis: 900_000, realProperty: true },
        { id: 'next', placedInServiceDate: '2027-02-01', basis: 10_000 },
        { id: 'sold', placedInServiceDate: '2027-03-01', basis: 500_000, disposalDate: '2027-06-01' },
        { id: 'outside', placedInServiceDate: '2030-01-01', basis: 1 },
      ],
      periods,
    );
    expect(conventions).toEqual({ early: 'mid_quarter', late: 'mid_quarter', building: 'mid_month', next: 'half_year', sold: 'half_year' });
  });
});

describe('book methods', () => {
  it('depreciates straight line over the useful life with salvage, full month', () => {
    const schedule = depreciationSchedule(asset({ salvageValue: 1_000 }), book('straight_line', 'full_month', 5));
    expect(schedule.basis).toMatchObject({ salvage: 1_000, depreciableBasis: 9_000, totalDepreciable: 9_000 });
    expect(amounts(schedule)).toEqual([1_500, 1_800, 1_800, 1_800, 1_800, 300]);
    expect(schedule.rows.at(-1)).toMatchObject({ accumulated: 9_000, remaining: 0 });
  });

  it('counts the month placed in service as half under mid-month', () => {
    const rows = amounts(depreciationSchedule(asset({ salvageValue: 1_000 }), book('straight_line', 'mid_month', 5)));
    expect(rows).toEqual([1_425, 1_800, 1_800, 1_800, 1_800, 375]);
  });

  it('takes half a year in the first and last year under half-year', () => {
    expect(amounts(depreciationSchedule(asset(), book('straight_line', 'half_year', 5)))).toEqual([1_000, 2_000, 2_000, 2_000, 2_000, 1_000]);
  });

  it('follows the fiscal year of an April to March company', () => {
    const periods = fiscalYearsFrom('2026-04-01', 8);
    const schedule = depreciationSchedule(asset({ placedInServiceDate: '2026-10-01', cost: 6_000 }), book('straight_line', 'full_month', 3), periods);
    // Six months of FY2027 (October to March), then three full years, then six months.
    expect(schedule.rows.map((row) => row.label)).toEqual(['FY2027', 'FY2028', 'FY2029', 'FY2030']);
    expect(amounts(schedule)).toEqual([1_000, 2_000, 2_000, 1_000]);
    expect(schedule.rows[0]).toMatchObject({ periodStart: '2026-04-01', periodEnd: '2027-03-31' });
  });

  it('declining balance 200% with the half-year convention matches the MACRS 5-year table', () => {
    const schedule = depreciationSchedule(asset(), book('declining_balance', 'half_year', 5));
    expect(amounts(schedule)).toEqual([2_000, 3_200, 1_920, 1_152, 1_152, 576]);
  });

  it('declining balance 150% switches to straight line when that is larger', () => {
    const schedule = depreciationSchedule(asset(), book('declining_balance', 'half_year', 10, { decliningBalanceFactor: 1.5 }));
    expect(amounts(schedule)[0]).toBe(750);
    expect(amounts(schedule)[1]).toBe(1_387.5);
    expect(total(amounts(schedule))).toBe(10_000);
    expect(schedule.rows).toHaveLength(11);
  });

  it('never goes below salvage', () => {
    const schedule = depreciationSchedule(asset({ salvageValue: 2_500 }), book('declining_balance', 'full_month', 5));
    expect(schedule.rows.at(-1)).toMatchObject({ accumulated: 7_500, remaining: 0 });
    for (const row of schedule.rows) expect(10_000 - row.accumulated).toBeGreaterThanOrEqual(2_500);
  });

  it('reproduces the MACRS tables with declining balance and a switch to straight line', () => {
    const quarterDates = ['2026-02-10', '2026-05-10', '2026-08-10', '2026-11-10'];
    for (const cls of [3, 5, 7, 10, 15, 20] as MacrsTableClass[]) {
      const factor = cls <= 10 ? 2 : 1.5;
      const tolerance = cls === 20 ? 0.009 : 0.015;
      const compare = (schedule: ReturnType<typeof depreciationSchedule>, table: readonly number[], label: string) => {
        expect(schedule.rows, label).toHaveLength(table.length);
        schedule.rows.forEach((row, index) => {
          expect(Math.abs(row.amount / 1000 - (table[index] as number)), `${label} year ${index + 1}`).toBeLessThanOrEqual(tolerance);
        });
      };
      const half = depreciationSchedule(asset({ cost: 100_000 }), book('declining_balance', 'half_year', cls, { decliningBalanceFactor: factor as 1.5 | 2 }));
      compare(half, MACRS_HALF_YEAR[cls], `A-1 ${cls}-year`);
      quarterDates.forEach((date, index) => {
        const quarter = (index + 1) as 1 | 2 | 3 | 4;
        const schedule = depreciationSchedule(
          asset({ cost: 100_000, placedInServiceDate: date }),
          book('declining_balance', 'mid_quarter', cls, { decliningBalanceFactor: factor as 1.5 | 2 }),
        );
        compare(schedule, MACRS_MID_QUARTER[quarter][cls], `A-${quarter + 1} ${cls}-year`);
      });
    }
  });
});

describe('disposal', () => {
  it('takes half a year in the year of disposal under half-year', () => {
    const schedule = depreciationSchedule(asset({ disposalDate: '2028-06-01' }), gds(5));
    expect(amounts(schedule)).toEqual([2_000, 3_200, 960]);
    expect(schedule.rows.at(-1)?.remaining).toBe(3_840);
  });

  it('takes 12.5%, 37.5%, 62.5% or 87.5% of the year under mid-quarter', () => {
    const run = (disposalDate: string) =>
      amounts(depreciationSchedule(asset({ placedInServiceDate: '2026-02-10', disposalDate }), gds(5, 'mid_quarter'))).at(-1);
    // Third year of the first-quarter table is 15.6%: 1,560.
    expect(run('2028-02-20')).toBe(195);
    expect(run('2028-05-20')).toBe(585);
    expect(run('2028-08-20')).toBe(975);
    expect(run('2028-11-20')).toBe(1_365);
  });

  it('takes the months before the disposal month plus half of it under mid-month', () => {
    const schedule = depreciationSchedule(
      asset({ cost: 100_000, placedInServiceDate: '2026-01-20', disposalDate: '2030-04-20' }),
      gds(39, 'mid_month'),
    );
    expect(amounts(schedule)).toEqual([2_461, 2_564, 2_564, 2_564, 747.83]);
  });

  it('takes no depreciation for property placed in service and disposed of in the same year', () => {
    const schedule = depreciationSchedule(asset({ disposalDate: '2026-09-01' }), gds(5));
    expect(amounts(schedule)).toEqual([0]);
    const withBonus = depreciationSchedule(asset({ disposalDate: '2026-09-01', cost: 1_000 }), gds(5, 'half_year', { section179Amount: 400 }));
    expect(amounts(withBonus)).toEqual([400]);
  });

  it('counts only the months before the disposal month under full-month straight line', () => {
    const schedule = depreciationSchedule(asset({ salvageValue: 1_000, disposalDate: '2027-06-20' }), book('straight_line', 'full_month', 5));
    expect(amounts(schedule)).toEqual([1_500, 750]);
  });

  it('does not stop for a disposal after the periods given', () => {
    const schedule = depreciationSchedule(asset({ disposalDate: '2040-01-01' }), gds(5));
    expect(schedule.rows).toHaveLength(6);
  });

  it('gives the share of the year allowed in the disposal year', () => {
    const year = { label: '2028', start: '2028-01-01', end: '2028-12-31' };
    expect(disposalYearFraction('half_year', '2028-06-01', year)).toBe(0.5);
    expect(disposalYearFraction('half_year', '2028-12-30', year)).toBe(0.5);
    expect(disposalYearFraction('mid_quarter', '2028-02-20', year)).toBe(0.125);
    expect(disposalYearFraction('mid_quarter', '2028-05-20', year)).toBe(0.375);
    expect(disposalYearFraction('mid_quarter', '2028-08-20', year)).toBe(0.625);
    expect(disposalYearFraction('mid_quarter', '2028-11-20', year)).toBe(0.875);
    expect(disposalYearFraction('mid_month', '2028-01-15', year)).toBeCloseTo(0.5 / 12, 10);
    expect(disposalYearFraction('mid_month', '2028-12-15', year)).toBeCloseTo(11.5 / 12, 10);
    expect(disposalYearFraction('full_month', '2028-03-10', year)).toBeCloseTo(2 / 12, 10);
    expect(disposalYearFraction('half_year', '2028-06-01', year, '2028-02-01')).toBe(0);
    expect(() => disposalYearFraction('half_year', '2029-06-01', year)).toThrow(RangeError);
  });
});

describe('gain on disposal', () => {
  it('works out gain or loss against cost less accumulated depreciation', () => {
    expect(gainOnDisposal(10_000, 7_120, 5_000)).toMatchObject({ adjustedBasis: 2_880, gainOrLoss: 2_120, result: 'gain' });
    expect(gainOnDisposal(10_000, 7_120, 1_000)).toMatchObject({ gainOrLoss: -1_880, result: 'loss', ordinaryRecapture: 0 });
    expect(gainOnDisposal(10_000, 10_000, 0)).toMatchObject({ gainOrLoss: 0, result: 'none' });
  });

  it('recaptures depreciation as ordinary income on personal property', () => {
    expect(gainOnDisposal(10_000, 7_120, 5_000)).toMatchObject({ ordinaryRecapture: 2_120, remainingGain: 0, unrecapturedSection1250: 0 });
    expect(gainOnDisposal(10_000, 7_120, 12_000)).toMatchObject({ gainOrLoss: 9_120, ordinaryRecapture: 7_120, remainingGain: 2_000 });
  });

  it('reports unrecaptured section 1250 gain on real property', () => {
    expect(gainOnDisposal(100_000, 20_000, 150_000, { propertyType: 'section_1250' })).toMatchObject({
      gainOrLoss: 70_000,
      ordinaryRecapture: 0,
      unrecapturedSection1250: 20_000,
      remainingGain: 50_000,
    });
  });

  it('rounds to the cent', () => {
    expect(gainOnDisposal(100.1, 33.33, 70.005)).toMatchObject({ adjustedBasis: 66.77, gainOrLoss: 3.24 });
  });
});

describe('fiscal periods', () => {
  it('labels April to March years by the year they end in', () => {
    expect(fiscalYearsFrom('2026-04-01', 2)).toEqual([
      { label: 'FY2027', start: '2026-04-01', end: '2027-03-31' },
      { label: 'FY2028', start: '2027-04-01', end: '2028-03-31' },
    ]);
    expect(() => fiscalYearsFrom('2026-04-15', 1)).toThrow(RangeError);
  });

  it('finds the fiscal year and quarter of an April to March company', () => {
    const periods = fiscalYearsFrom('2026-04-01', 8);
    // January 2027 is in the last quarter of FY2027.
    const schedule = depreciationSchedule(asset({ placedInServiceDate: '2027-01-10' }), gds(5, 'mid_quarter'), periods);
    expect(schedule.rows[0]).toMatchObject({ label: 'FY2027', amount: 500 });
  });

  it('works with 52-53 week years', () => {
    const periods = weekYears('2025-02-02', [52, 52, 52, 53, 52, 52, 52, 52]);
    expect(periods[3]).toMatchObject({ start: '2028-01-30' });
    expect(periods[3]?.end).toBe('2029-02-03');
    const late = depreciationSchedule(asset({ placedInServiceDate: '2025-11-02' }), gds(5, 'mid_quarter'), periods);
    expect(late.rows[0]).toMatchObject({ label: 'FY1', amount: 500 });
    const early = depreciationSchedule(asset({ placedInServiceDate: '2025-11-01' }), gds(5, 'mid_quarter'), periods);
    expect(early.rows[0]?.amount).toBe(1_500);
    expect(total(amounts(early))).toBe(10_000);
    const straight = depreciationSchedule(asset({ placedInServiceDate: '2025-06-10' }), book('straight_line', 'half_year', 4), periods);
    expect(amounts(straight)).toEqual([1_250, 2_500, 2_500, 2_500, 1_250]);
  });

  it('uses calendar years from the placed-in-service year when none are given', () => {
    const schedule = depreciationSchedule(asset(), gds(5));
    expect(schedule.rows[0]?.periodStart).toBe('2026-01-01');
    expect(schedule.rows.at(-1)?.periodEnd).toBe('2031-12-31');
  });
});

describe('monthly schedule', () => {
  it('posts straight line depreciation month by month, full month', () => {
    const schedule = monthlySchedule(asset({ cost: 3_600 }), book('straight_line', 'full_month', 3));
    expect(schedule.rows).toHaveLength(36);
    expect(schedule.rows[0]).toEqual({ label: '2026-03', periodStart: '2026-03-01', periodEnd: '2026-03-31', amount: 100, accumulated: 100, remaining: 3_500 });
    expect(schedule.rows.at(-1)).toMatchObject({ label: '2029-02', periodEnd: '2029-02-28', accumulated: 3_600, remaining: 0 });
    expect(new Set(schedule.rows.map((row) => row.amount))).toEqual(new Set([100]));
  });

  it('counts half a month at each end under mid-month', () => {
    const schedule = monthlySchedule(asset({ cost: 1_200, placedInServiceDate: '2026-03-15' }), book('straight_line', 'mid_month', 1));
    expect(schedule.rows).toHaveLength(13);
    expect(schedule.rows[0]).toMatchObject({ label: '2026-03', amount: 50 });
    expect(schedule.rows[1]).toMatchObject({ label: '2026-04', amount: 100 });
    expect(schedule.rows.at(-1)).toMatchObject({ label: '2027-03', amount: 50, accumulated: 1_200 });
  });

  it('starts in the middle of the year under half-year', () => {
    const schedule = monthlySchedule(asset({ cost: 2_400 }), book('straight_line', 'half_year', 2));
    expect(schedule.rows[0]).toMatchObject({ label: '2026-07', amount: 100 });
    expect(schedule.rows.at(-1)).toMatchObject({ label: '2028-06', amount: 100, accumulated: 2_400 });
    expect(schedule.rows).toHaveLength(24);
  });

  it('adds up to the yearly schedule for declining balance', () => {
    const a = asset({ cost: 12_345.67, placedInServiceDate: '2026-02-10' });
    const b = book('declining_balance', 'full_month', 5);
    const yearly = depreciationSchedule(a, b);
    const monthly = monthlySchedule(a, b);
    for (const row of yearly.rows) {
      const months = monthly.rows.filter((m) => m.periodStart >= row.periodStart && m.periodEnd <= row.periodEnd);
      expect(Math.abs(total(months.map((m) => m.amount)) - row.amount), row.label).toBeLessThanOrEqual(0.011);
    }
    expect(monthly.rows.at(-1)?.accumulated).toBe(12_345.67);
  });

  it('stops at the disposal month', () => {
    const schedule = monthlySchedule(asset({ cost: 3_600, disposalDate: '2026-08-10' }), book('straight_line', 'full_month', 3));
    expect(schedule.rows.map((row) => row.label)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
    expect(schedule.rows.at(-1)?.remaining).toBe(3_100);
  });

  it('needs fiscal years made of whole months', () => {
    const periods = weekYears('2025-02-02', [52, 52, 52, 52, 52]);
    const schedule = monthlySchedule(asset({ placedInServiceDate: '2025-03-10' }), book('straight_line', 'full_month', 3), periods);
    expect(schedule.rows).toEqual([]);
    expect(schedule.issues.map((issue) => issue.code)).toEqual(['monthly_requires_month_periods']);
  });

  it('follows an April to March fiscal year', () => {
    const schedule = monthlySchedule(asset({ cost: 1_200, placedInServiceDate: '2026-10-05' }), book('straight_line', 'full_month', 1), fiscalYearsFrom('2026-04-01', 3));
    expect(schedule.rows.map((row) => row.label)).toEqual([
      '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09',
    ]);
  });
});

describe('other methods and invalid input', () => {
  it('expenses everything in the first year with the expensed method', () => {
    const schedule = depreciationSchedule(asset({ cost: 1_800 }), book('expensed', 'full_month', 0));
    expect(schedule.rows).toEqual([
      { label: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', amount: 1_800, regular: 1_800, section179: 0, bonus: 0, accumulated: 1_800, remaining: 0 },
    ]);
  });

  it('has no rows for a book that does not depreciate', () => {
    const schedule = depreciationSchedule(asset(), book('none', 'full_month', 0));
    expect(schedule.rows).toEqual([]);
    expect(schedule.issues).toEqual([]);
  });

  it('reports what is wrong instead of a schedule', () => {
    const code = (over: Partial<DepreciationAsset>, b: DepreciationBook = gds(5), periods?: FiscalPeriod[]) =>
      depreciationSchedule(asset(over), b, periods).issues.map((issue) => issue.code);
    expect(code({ cost: 0 })).toEqual(['invalid_amount']);
    expect(code({ cost: Number.NaN })).toEqual(['invalid_amount']);
    expect(code({ businessUsePercent: 120 })).toEqual(['invalid_amount']);
    expect(code({ salvageValue: -1 })).toEqual(['invalid_amount']);
    expect(code({ placedInServiceDate: '03/15/2026' })).toEqual(['invalid_dates']);
    expect(code({ disposalDate: '2025-01-01' })).toEqual(['disposal_before_service']);
    expect(code({}, book('straight_line', 'full_month', 0))).toEqual(['unsupported_recovery_period']);
    expect(code({}, gds(5), calendarFiscalYears(2027, 8))).toEqual(['placed_in_service_outside_periods']);
    expect(code({}, gds(5), [])).toEqual(['invalid_periods']);
    expect(code({}, gds(5), [{ label: 'a', start: '2026-01-01', end: '2026-12-31' }, { label: 'b', start: '2026-06-01', end: '2027-12-31' }])).toEqual(['invalid_periods']);
  });

  it('warns when the fiscal periods end before the asset is fully depreciated', () => {
    const schedule = depreciationSchedule(asset(), gds(5), calendarFiscalYears(2026, 3));
    expect(amounts(schedule)).toEqual([2_000, 3_200, 1_920]);
    expect(schedule.rows.at(-1)?.remaining).toBe(2_880);
    expect(schedule.issues.map((issue) => issue.code)).toEqual(['periods_end_before_fully_depreciated']);
  });
});
