import { describe, expect, it } from 'vitest';
import { WHITE_DAILY_2026, WHITE_MONTHLY_2026, WHITE_MONTHLY_2027_PRINSJESDAG } from './fixtures/white-tables';
import { nlRulesForYear } from './rules';
import { anonymousTax, periodWageTax, PERIOD_FACTOR, specialRewardPercent, specialRewardTax, type NlAgeColumn } from './wage-tax';

const rules2026 = nlRulesForYear(2026)!;
const rules2027 = nlRulesForYear(2027)!;

/** "1.234,56" / "1234,56" → cents. */
const cents = (s: string) => Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100);

/** [column, index of the tax column, index of the labour-credit column or null for "without LHK"]. */
const COLUMNS: Array<[NlAgeColumn, number, number | null]> = [
  ['belowAow', 1, null],
  ['belowAow', 2, 3],
  ['aow1945', 4, null],
  ['aow1945', 5, 7],
  ['aow1946', 8, null],
  ['aow1946', 9, 11],
];

function checkTable(rows: string[], factor: number, year: 2026 | 2027) {
  const rules = year === 2026 ? rules2026 : rules2027;
  for (const row of rows) {
    const f = row.split(';').map(cents);
    for (const [column, taxIdx, arkIdx] of COLUMNS) {
      const r = periodWageTax(f[0]!, factor, column, arkIdx !== null, rules);
      expect({ row: f[0], column, lhk: arkIdx !== null, tax: r.taxCents }).toEqual({ row: f[0], column, lhk: arkIdx !== null, tax: f[taxIdx] });
      if (arkIdx !== null) expect(r.labourCreditCents).toBe(f[arkIdx]);
    }
  }
}

describe('white period tables (rekenvoorschriften 2026)', () => {
  it(`reproduces ${WHITE_MONTHLY_2026.length} rows of the official 2026 white monthly table to the cent, in every column`, () => {
    checkTable(WHITE_MONTHLY_2026, PERIOD_FACTOR.month, 2026);
  });

  it(`reproduces ${WHITE_DAILY_2026.length} rows of the official 2026 white daily table`, () => {
    checkTable(WHITE_DAILY_2026, PERIOD_FACTOR.day, 2026);
  });

  it(`reproduces ${WHITE_MONTHLY_2027_PRINSJESDAG.length} rows of the 2027 Prinsjesdag white monthly table`, () => {
    checkTable(WHITE_MONTHLY_2027_PRINSJESDAG, PERIOD_FACTOR.month, 2027);
  });

  it('reads a wage between two table rows at the lower row (annual wage rounded down to a multiple of Lv)', () => {
    // € 4.000,00 → L = 47.952 → table row € 3.996,00: 818,67 with LHK, arbeidskorting 461,00.
    const r = periodWageTax(400_000, 12, 'belowAow', true, rules2026);
    expect(r).toMatchObject({ taxCents: 81_867, labourCreditCents: 46_100, annualWage: 47_952, tableWageCents: 399_600 });
  });

  it('above the highest table wage adds 49,50% of the excess, rounded down (table footnote and RV §2.2.4)', () => {
    // Highest monthly row 11.092,50 → 4.651,67 (official table).
    expect(periodWageTax(1_109_250, 12, 'belowAow', true, rules2026).taxCents).toBe(465_167);
    expect(periodWageTax(1_200_000, 12, 'belowAow', true, rules2026).taxCents).toBe(465_167 + Math.floor((1_200_000 - 1_109_250) * 0.495));
    expect(periodWageTax(1_200_000, 12, 'belowAow', true, rules2026).labourCreditCents).toBe(0);
  });

  it('a daily wage of 511,97 is still a table wage (Lmax/F rounded up), RV §2.2.5', () => {
    const atMax = periodWageTax(51_197, 260, 'belowAow', false, rules2026);
    expect(atMax.annualWage).toBe(133_110);
  });

  it('a zero or negative wage withholds nothing', () => {
    expect(periodWageTax(0, 12, 'belowAow', true, rules2026).taxCents).toBe(0);
    expect(periodWageTax(-10_000, 12, 'belowAow', true, rules2026).taxCents).toBe(0);
  });
});

describe('special-reward table (witte tabel bijzondere beloningen 2026)', () => {
  it.each([
    // [annual wage €, column, LHK, expected %] — standaardtarief + verrekeningspercentage.
    [10_000, 'belowAow', true, 0],
    [10_000, 'belowAow', false, 35.75],
    [11_358, 'belowAow', true, 27.43],
    [20_000, 'belowAow', true, 4.74],
    [25_000, 'belowAow', true, 33.8],
    [35_000, 'belowAow', true, 40.2],
    [45_309, 'belowAow', true, 42.01],
    [50_000, 'belowAow', true, 50.47],
    [70_000, 'belowAow', true, 50.47],
    [80_000, 'belowAow', true, 56.01],
    [150_000, 'belowAow', true, 49.5],
    [150_000, 'belowAow', false, 49.5],
    [40_000, 'aow1946', true, 39.78],
    [40_000, 'aow1945', true, 20.07],
    [50_000, 'aow1946', true, 59.01],
    [30_000, 'aow1946', true, 0],
    [30_000, 'aow1946', false, 17.85],
  ] as const)('annual wage %i, %s, LHK %s → %d%%', (annual, column, lhk, pct) => {
    expect(specialRewardPercent(annual * 100, column, lhk, rules2026)).toBe(pct);
  });

  it('rounds the tax down to cents in the employee’s favour', () => {
    // 1.234,56 × 50,47% = 623,08...
    expect(specialRewardTax(123_456, 50.47)).toBe(62_308);
  });

  it('uses the green table for loon uit vroegere dienstbetrekking (no labour credit in the offset)', () => {
    expect(specialRewardPercent(5_000_000, 'belowAow', true, rules2026, 'green')).toBe(43.96);
    expect(specialRewardPercent(5_000_000, 'belowAow', true, rules2026, 'white')).toBe(50.47);
  });

  it('2027 Prinsjesdag table', () => {
    expect(specialRewardPercent(5_000_000, 'belowAow', true, rules2027)).toBe(51.31);
    expect(specialRewardPercent(5_000_000, 'belowAow', false, rules2027)).toBe(38.16);
  });
});

describe('anonymous rate', () => {
  it('is 52% of the wage, rounded down', () => {
    expect(anonymousTax(300_001, rules2026)).toBe(156_000);
  });
});
