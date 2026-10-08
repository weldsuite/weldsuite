import { describe, it, expect } from 'vitest';
import {
  DE_MINIMIS_SAFE_HARBOR,
  MACRS_HALF_YEAR,
  MACRS_MID_QUARTER,
  MACRS_TABLE_CLASSES,
  OBBBA_BONUS_CUTOFF,
  SECTION_179_PARAMETERS,
  bonusDepreciationPercent,
  bonusEligible,
  deMinimisApplies,
  deMinimisThreshold,
  macrsRealPropertyPercentages,
  section179Allowance,
  section179Parameters,
} from './depreciation-tables';

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe('MACRS percentage tables (Publication 946 appendix A)', () => {
  it('has a row for every class and each row adds to 100', () => {
    for (const cls of MACRS_TABLE_CLASSES) {
      expect(sum(MACRS_HALF_YEAR[cls]), `A-1 ${cls}`).toBeCloseTo(100, 6);
      for (const quarter of [1, 2, 3, 4] as const) {
        expect(sum(MACRS_MID_QUARTER[quarter][cls]), `A-${quarter + 1} ${cls}`).toBeCloseTo(100, 6);
      }
    }
  });

  it('spans one year more than the class', () => {
    for (const cls of MACRS_TABLE_CLASSES) {
      expect(MACRS_HALF_YEAR[cls], `A-1 ${cls}`).toHaveLength(cls + 1);
      for (const quarter of [1, 2, 3, 4] as const) {
        expect(MACRS_MID_QUARTER[quarter][cls], `A-${quarter + 1} ${cls}`).toHaveLength(cls + 1);
      }
    }
  });

  it('matches the half-year rows (table A-1)', () => {
    expect(MACRS_HALF_YEAR[3]).toEqual([33.33, 44.45, 14.81, 7.41]);
    expect(MACRS_HALF_YEAR[5]).toEqual([20, 32, 19.2, 11.52, 11.52, 5.76]);
    expect(MACRS_HALF_YEAR[7]).toEqual([14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46]);
    expect(MACRS_HALF_YEAR[10].slice(0, 4)).toEqual([10, 18, 14.4, 11.52]);
    expect(MACRS_HALF_YEAR[15].at(-1)).toBe(2.95);
    expect(MACRS_HALF_YEAR[20].slice(0, 3)).toEqual([3.75, 7.219, 6.677]);
    expect(MACRS_HALF_YEAR[20].at(-1)).toBe(2.231);
  });

  it('matches the first-year percentages of every mid-quarter table', () => {
    const firstYear = (quarter: 1 | 2 | 3 | 4) => MACRS_TABLE_CLASSES.map((cls) => MACRS_MID_QUARTER[quarter][cls][0]);
    expect(firstYear(1)).toEqual([58.33, 35, 25, 17.5, 8.75, 6.563]);
    expect(firstYear(2)).toEqual([41.67, 25, 17.85, 12.5, 6.25, 4.688]);
    expect(firstYear(3)).toEqual([25, 15, 10.71, 7.5, 3.75, 2.813]);
    expect(firstYear(4)).toEqual([8.33, 5, 3.57, 2.5, 1.25, 0.938]);
  });

  it('keeps the last-year remainders of the mid-quarter tables', () => {
    expect(MACRS_MID_QUARTER[1][5].at(-1)).toBe(1.38);
    expect(MACRS_MID_QUARTER[4][5].at(-1)).toBe(9.58);
    expect(MACRS_MID_QUARTER[4][15].at(-1)).toBe(5.17);
    expect(MACRS_MID_QUARTER[4][20].at(-1)).toBe(3.901);
  });
});

describe('real property tables (A-6 and A-7a, mid-month)', () => {
  it('adds each month of the 27.5-year table to 100 over 29 years', () => {
    for (let month = 1; month <= 12; month++) {
      const rows = macrsRealPropertyPercentages(27.5, month);
      expect(rows, `month ${month}`).toHaveLength(29);
      expect(sum(rows), `month ${month}`).toBeCloseTo(100, 6);
    }
  });

  it('adds each month of the 39-year table to 100 over 40 years', () => {
    for (let month = 1; month <= 12; month++) {
      const rows = macrsRealPropertyPercentages(39, month);
      expect(rows, `month ${month}`).toHaveLength(40);
      expect(sum(rows), `month ${month}`).toBeCloseTo(100, 6);
    }
  });

  it('matches the printed 27.5-year first, 28th and 29th years', () => {
    const first = [3.485, 3.182, 2.879, 2.576, 2.273, 1.97, 1.667, 1.364, 1.061, 0.758, 0.455, 0.152];
    const year28 = [1.97, 2.273, 2.576, 2.879, 3.182, 3.485, 3.636, 3.636, 3.636, 3.636, 3.636, 3.636];
    const year29 = [0, 0, 0, 0, 0, 0, 0.152, 0.455, 0.758, 1.061, 1.364, 1.667];
    for (let month = 1; month <= 12; month++) {
      const rows = macrsRealPropertyPercentages(27.5, month);
      expect(rows[0], `first year, month ${month}`).toBe(first[month - 1]);
      expect(rows[27], `28th year, month ${month}`).toBeCloseTo(year28[month - 1] as number, 6);
      expect(rows[28], `29th year, month ${month}`).toBeCloseTo(year29[month - 1] as number, 6);
      expect(rows[1], 'year 2').toBe(3.636);
      expect(rows[8], 'year 9').toBe(3.636);
    }
  });

  it('alternates 3.637 and 3.636 in years 10 to 27', () => {
    const january = macrsRealPropertyPercentages(27.5, 1);
    expect([january[9], january[10], january[11], january[25], january[26]]).toEqual([3.637, 3.636, 3.637, 3.637, 3.636]);
    const october = macrsRealPropertyPercentages(27.5, 10);
    expect([october[9], october[10], october[11], october[25], october[26]]).toEqual([3.636, 3.637, 3.636, 3.636, 3.637]);
  });

  it('matches the printed 39-year first and 40th years and holds 2.564 in between', () => {
    const first = [2.461, 2.247, 2.033, 1.819, 1.605, 1.391, 1.177, 0.963, 0.749, 0.535, 0.321, 0.107];
    for (let month = 1; month <= 12; month++) {
      const rows = macrsRealPropertyPercentages(39, month);
      expect(rows[0]).toBe(first[month - 1]);
      expect(rows[39]).toBe(first[12 - month]);
      expect(new Set(rows.slice(1, 39))).toEqual(new Set([2.564]));
    }
  });

  it('rejects a month that does not exist', () => {
    expect(() => macrsRealPropertyPercentages(39, 0)).toThrow(RangeError);
    expect(() => macrsRealPropertyPercentages(27.5, 13)).toThrow(RangeError);
  });
});

describe('section 179 parameters', () => {
  it('holds the research figures for 2025 and 2026', () => {
    expect(section179Parameters(2025)).toMatchObject({ limit: 2_500_000, phaseOutThreshold: 4_000_000, suvCap: 31_300, source: 'research' });
    expect(section179Parameters(2026)).toMatchObject({ limit: 2_560_000, phaseOutThreshold: 4_090_000, suvCap: 32_000, source: 'research' });
  });

  it('has one row per year in order from 2018', () => {
    expect(SECTION_179_PARAMETERS.map((row) => row.taxYear)).toEqual([2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    expect(section179Parameters(2024)?.limit).toBe(1_220_000);
    expect(section179Parameters(2017)).toBeUndefined();
  });

  it('uses the latest known figures for a later year', () => {
    expect(section179Parameters(2030)?.taxYear).toBe(2026);
  });

  it('phases the limit out dollar for dollar above the threshold', () => {
    expect(section179Allowance(2026, 1_000_000)).toMatchObject({ dollarLimit: 2_560_000, phaseOutReduction: 0, allowable: 2_560_000 });
    expect(section179Allowance(2026, 4_090_000)?.dollarLimit).toBe(2_560_000);
    expect(section179Allowance(2026, 4_590_000)).toMatchObject({ phaseOutReduction: 500_000, dollarLimit: 2_060_000 });
    expect(section179Allowance(2026, 6_650_000)?.dollarLimit).toBe(0);
    expect(section179Allowance(2026, 9_000_000)?.dollarLimit).toBe(0);
    expect(section179Allowance(2025, 4_500_000)?.dollarLimit).toBe(2_000_000);
  });

  it('limits to business income when given', () => {
    expect(section179Allowance(2026, 100_000, 300_000)?.allowable).toBe(300_000);
    expect(section179Allowance(2026, 100_000, 5_000_000)?.allowable).toBe(2_560_000);
    expect(section179Allowance(2026, 100_000, -10)?.allowable).toBe(0);
    expect(section179Allowance(2010, 1)).toBeUndefined();
  });
});

describe('bonus depreciation', () => {
  it('is 100% for property acquired and placed in service after 19 January 2025', () => {
    expect(OBBBA_BONUS_CUTOFF).toBe('2025-01-19');
    expect(bonusDepreciationPercent({ acquisitionDate: '2025-01-20', placedInServiceDate: '2025-02-01' })).toEqual({ percent: 100, rule: 'obbba_100' });
    expect(bonusDepreciationPercent({ acquisitionDate: '2026-05-01', placedInServiceDate: '2026-06-01' })).toEqual({ percent: 100, rule: 'obbba_100' });
    expect(bonusDepreciationPercent({ acquisitionDate: '2030-05-01', placedInServiceDate: '2030-06-01' }).percent).toBe(100);
  });

  it('is 40% for property acquired on or before 19 January 2025 and placed in service in 2025', () => {
    expect(bonusDepreciationPercent({ acquisitionDate: '2025-01-19', placedInServiceDate: '2025-03-01' })).toEqual({ percent: 40, rule: 'tcja_40' });
    expect(bonusDepreciationPercent({ acquisitionDate: '2024-11-01', placedInServiceDate: '2025-01-25' }).percent).toBe(40);
    // Placed in service before the cut-off date: the phase-down applies whatever the acquisition date.
    expect(bonusDepreciationPercent({ acquisitionDate: '2025-01-10', placedInServiceDate: '2025-01-15' }).percent).toBe(40);
  });

  it('is 20% in 2026 and nothing after for property acquired before the cut-off', () => {
    expect(bonusDepreciationPercent({ acquisitionDate: '2024-12-01', placedInServiceDate: '2026-02-01' })).toEqual({ percent: 20, rule: 'tcja_20' });
    expect(bonusDepreciationPercent({ acquisitionDate: '2024-12-01', placedInServiceDate: '2027-02-01' })).toEqual({ percent: 0, rule: 'tcja_0' });
  });

  it('follows the TCJA phase-down for earlier years', () => {
    const at = (placedInServiceDate: string) => bonusDepreciationPercent({ acquisitionDate: '2018-06-01', placedInServiceDate }).percent;
    expect(at('2018-07-01')).toBe(100);
    expect(at('2022-12-31')).toBe(100);
    expect(at('2023-01-01')).toBe(80);
    expect(at('2024-06-01')).toBe(60);
  });

  it('offers the 40% election for the first year after the cut-off', () => {
    expect(bonusDepreciationPercent({ acquisitionDate: '2025-03-01', placedInServiceDate: '2025-04-01', reducedElection: true })).toEqual({
      percent: 40,
      rule: 'obbba_reduced_election',
    });
    // The election only concerns property acquired after the cut-off.
    expect(bonusDepreciationPercent({ acquisitionDate: '2024-03-01', placedInServiceDate: '2026-04-01', reducedElection: true }).percent).toBe(20);
  });

  it('does not model property acquired before the TCJA', () => {
    expect(bonusDepreciationPercent({ acquisitionDate: '2017-01-01', placedInServiceDate: '2018-01-01' })).toEqual({ percent: 0, rule: 'not_modeled' });
  });

  it('applies to recovery periods of 20 years or less and water utility property', () => {
    for (const years of [3, 5, 7, 10, 15, 20, 25]) expect(bonusEligible(years), String(years)).toBe(true);
    expect(bonusEligible(27.5)).toBe(false);
    expect(bonusEligible(39)).toBe(false);
  });
});

describe('de minimis safe harbor', () => {
  it('is $2,500 without and $5,000 with an applicable financial statement', () => {
    expect(DE_MINIMIS_SAFE_HARBOR).toEqual([{ effectiveFrom: '2016-01-01', withoutAfs: 2_500, withAfs: 5_000 }]);
    expect(deMinimisThreshold('2026-10-08', false)).toBe(2_500);
    expect(deMinimisThreshold('2026-10-08', true)).toBe(5_000);
    expect(deMinimisThreshold('2015-12-31', true)).toBeUndefined();
  });

  it('lets an item at the threshold be expensed but not above it', () => {
    expect(deMinimisApplies(2_500, '2026-10-08', false)).toBe(true);
    expect(deMinimisApplies(2_500.01, '2026-10-08', false)).toBe(false);
    expect(deMinimisApplies(5_000, '2026-10-08', true)).toBe(true);
    expect(deMinimisApplies(5_000.01, '2026-10-08', true)).toBe(false);
    expect(deMinimisApplies(100, '2015-01-01', true)).toBe(false);
  });
});
