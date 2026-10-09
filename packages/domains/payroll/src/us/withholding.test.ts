import { describe, expect, it } from 'vitest';
import type { UsW4Input } from '../types';
import { FEDERAL_2026 } from './federal-2026';
import type { W4FilingStatus } from './federal-rules';
import { annualScheduleTax, effectiveW4, nraAdditionCents, supplementalWithholding, worksheet1A } from './withholding';

const R = FEDERAL_2026;

function w4(overrides: Partial<UsW4Input> = {}): UsW4Input {
  return {
    formYear: 2026,
    filingStatus: 'single',
    multipleJobs: false,
    dependentsAmount: 0,
    otherIncome: 0,
    deductions: 0,
    extraWithholding: 0,
    exempt: false,
    allowances: null,
    nonresidentAlien: false,
    ...overrides,
  };
}

const usd = (d: number) => Math.round(d * 100);
const withhold = (form: UsW4Input, wages: number, periods: number) => worksheet1A(R, form, usd(wages), periods).withholdingCents;

/**
 * Pub 15-T's wage bracket tables are the percentage method applied to the
 * middle of each bracket, rounded to whole dollars. Rows below are copied from
 * the 2026 tables (https://www.irs.gov/publications/p15t, sections 2 and 3).
 * A scratch check of all 15,845 cells of those tables against Worksheet 1A
 * matched except 12 cells that are exact $x.50 ties the IRS rounds down.
 */
function bracketMidpointDollars(form: UsW4Input, atLeast: number, lessThan: number, periods: number): number {
  const cents = withhold(form, (atLeast + lessThan) / 2, periods);
  return Math.floor(cents / 100 + 0.5);
}

describe('Pub 15-T (2026) annual percentage method tables', () => {
  it('every row is consistent: column C = previous C + previous rate × bracket width', () => {
    for (const schedule of [R.withholding.standard, R.withholding.step2Checked]) {
      for (const status of ['single', 'married_jointly', 'head_of_household'] as W4FilingStatus[]) {
        const rows = schedule[status];
        for (let i = 1; i < rows.length; i += 1) {
          const expected = rows[i - 1].baseCents + ((rows[i].atLeastCents - rows[i - 1].atLeastCents) * rows[i - 1].ratePercent) / 100;
          // Column C is rounded to the cent, and the IRS derived it from column A amounts before
          // rounding them to whole dollars (Step 2 single: $108,937.50 is printed as $108,938), so
          // a row may differ by up to the previous rate × $0.50. The engine uses the published values.
          expect(Math.abs(rows[i].baseCents - expected)).toBeLessThanOrEqual(Math.ceil(rows[i - 1].ratePercent * 0.5) + 1);
        }
      }
    }
  });

  it('reads a schedule row (column A/C/D)', () => {
    // Standard MFJ: $120,100 → $11,600 + 22% of the excess.
    expect(annualScheduleTax(usd(130_100), R.withholding.standard.married_jointly)).toBe(usd(11_600 + 2_200));
    expect(annualScheduleTax(usd(7_499), R.withholding.standard.single)).toBe(0);
  });
});

describe('Pub 15 (2026) section 7 worked examples', () => {
  it('Example 1: 2018 W-4, single, 1 allowance, monthly — $1,000 → $2 and $1,500 → $53 (wage bracket rows $990–$1,020, $1,500–$1,530)', () => {
    const form = w4({ formYear: 2018, allowances: 1 });
    expect(bracketMidpointDollars(form, 990, 1_020, 12)).toBe(2);
    expect(bracketMidpointDollars(form, 1_500, 1_530, 12)).toBe(53);
    // Exact percentage method: (12,000 − 4,300 − 7,500) × 10% ÷ 12.
    expect(withhold(form, 1_000, 12)).toBe(167);
  });

  it('Example 2: 2026 W-4, single, monthly — $2,000 → $65, $3,000 → $179, $5,000 → $419', () => {
    const form = w4();
    expect(bracketMidpointDollars(form, 1_975, 2_005, 12)).toBe(65);
    expect(bracketMidpointDollars(form, 2_985, 3_025, 12)).toBe(179);
    expect(bracketMidpointDollars(form, 4_985, 5_025, 12)).toBe(419);
    // Exact: (24,000 − 8,600 − 7,500) × 10% ÷ 12 = 65.8333…
    expect(withhold(form, 2_000, 12)).toBe(6_583);
  });

  it('Example 3: flat 22% on a separately paid $1,000 bonus → $220', () => {
    const s = supplementalWithholding({
      rules: R,
      w4: w4(),
      supplementalCents: usd(1_000),
      ytdSupplementalCents: 0,
      regularWagesCents: usd(2_000),
      nraAdditionCents: 0,
      periodsPerYear: 12,
      regularWithheldThisYearCents: usd(65),
    });
    expect(s).toMatchObject({ method: 'flat', flatCents: usd(220), mandatoryCents: 0 });
  });
});

describe('Pub 15-T (2026) nonresident alien adjustment', () => {
  it('worked example: weekly $300, 2019 W-4 single 1 allowance, + $226.90 (Table 1) → $31', () => {
    const form = w4({ formYear: 2019, allowances: 1, nonresidentAlien: true });
    const add = nraAdditionCents(R, form, 52);
    expect(add).toBe(22_690);
    // Wage bracket row $520–$535, 1 allowance: $31.
    expect(bracketMidpointDollars(w4({ formYear: 2019, allowances: 1 }), 520, 535, 52)).toBe(31);
    // Exact: (526.90 × 52 − 4,300 − 19,900) × 12% + 1,240, ÷ 52 = 31.228…
    const cents = worksheet1A(R, form, usd(300) + add, 52).withholdingCents;
    expect(cents).toBe(3_123);
    expect(Math.floor(cents / 100 + 0.5)).toBe(31);
  });

  it('2020+ W-4 uses Table 2 ($309.60 weekly, $619.20 biweekly)', () => {
    const form = w4({ nonresidentAlien: true });
    expect(nraAdditionCents(R, form, 52)).toBe(30_960);
    expect(nraAdditionCents(R, form, 26)).toBe(61_920);
    expect(nraAdditionCents(R, form, 24)).toBe(67_080);
    expect(nraAdditionCents(R, form, 12)).toBe(134_170);
    // (809.60 × 52 − 8,600 − 19,900) × 12% + 1,240, ÷ 52 = 55.2289…
    expect(worksheet1A(R, form, usd(500) + nraAdditionCents(R, form, 52), 52).withholdingCents).toBe(5_523);
  });
});

describe('Worksheet 1A, more rows of the 2026 wage bracket tables', () => {
  it.each([
    // [label, W-4, bracket at least, less than, periods, table value]
    ['biweekly MFJ standard $2,495–$2,525', w4({ filingStatus: 'married_jointly' }), 2_495, 2_525, 26, 134],
    ['biweekly HoH Step 2 $2,495–$2,525', w4({ filingStatus: 'head_of_household', multipleJobs: true }), 2_495, 2_525, 26, 314],
    ['weekly single Step 2 $1,195–$1,205', w4({ multipleJobs: true }), 1_195, 1_205, 52, 180],
    ['semimonthly HoH standard $3,975–$4,010', w4({ filingStatus: 'head_of_household' }), 3_975, 4_010, 24, 361],
    ['biweekly 2019 W-4 married 3 allowances $2,955–$3,005', w4({ formYear: 2019, filingStatus: 'married_jointly', allowances: 3 }), 2_955, 3_005, 26, 190],
    ['semimonthly 2019 W-4 single 0 allowances $2,185–$2,235', w4({ formYear: 2019, allowances: 0 }), 2_185, 2_235, 24, 217],
  ])('%s → $%s', (_label, form, atLeast, lessThan, periods, expected) => {
    expect(bracketMidpointDollars(form as UsW4Input, atLeast as number, lessThan as number, periods as number)).toBe(expected);
  });
});

describe('Worksheet 1A, hand-calculated cases', () => {
  it('uses Steps 3, 4(a), 4(b) and 4(c)', () => {
    // Biweekly $3,000; single; Step 3 $2,000; 4(a) $1,200; 4(b) $3,000; 4(c) $25.
    // 1c 78,000; 1e 79,200; 1h 3,000 + 8,600; 1i 67,600 → 5,800 + 22% × 9,700 = 7,934.
    // 2h 7,934/26 = 305.1538; 3b 2,000/26 = 76.9231; 3c 228.2308 → 228.23 + 25.
    const form = w4({ dependentsAmount: 2_000, otherIncome: 1_200, deductions: 3_000, extraWithholding: 25 });
    const ws = worksheet1A(R, form, usd(3_000), 26);
    expect(ws.adjustedAnnualWageCents).toBe(usd(67_600));
    expect(ws.tentativeAnnualCents).toBe(usd(7_934));
    expect(ws.withholdingCents).toBe(usd(253.23));
  });

  it('Step 2 checked, head of household, weekly $1,500 → (78,000 − 64,925) × 24% + 8,077.50, ÷ 52', () => {
    expect(withhold(w4({ filingStatus: 'head_of_household', multipleJobs: true }), 1_500, 52)).toBe(usd(215.68));
  });

  it('top bracket: single, monthly $60,000 → 192,979.25 + 37% × (711,400 − 648,100), ÷ 12', () => {
    expect(withhold(w4(), 60_000, 12)).toBe(usd(18_033.35));
  });

  it('credits larger than the tax leave only the extra withholding', () => {
    expect(withhold(w4({ dependentsAmount: 10_000, extraWithholding: 15 }), 1_500, 26)).toBe(usd(15));
  });

  it('a 53rd weekly payday is annualized as 52 (Table 3)', () => {
    expect(withhold(w4(), 1_000, 53)).toBe(withhold(w4(), 1_000, 52));
  });

  it('the computational bridge for a 2019-or-earlier W-4 gives the same withholding as lines 1j–1l', () => {
    for (const [status, step4a] of [['single', 8_600], ['married_jointly', 12_900]] as const) {
      for (const allowances of [0, 1, 4]) {
        for (const wages of [800, 2_600, 9_000]) {
          const old = w4({ formYear: 2018, filingStatus: status, allowances, extraWithholding: 10 });
          const bridged = w4({ formYear: 2026, filingStatus: status, otherIncome: step4a, deductions: allowances * 4_300, extraWithholding: 10 });
          expect(withhold(old, wages, 24)).toBe(withhold(bridged, wages, 24));
        }
      }
    }
  });

  it('a missing W-4 is Single with no adjustments', () => {
    const form = effectiveW4(null);
    expect(form).toMatchObject({ filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, extraWithholding: 0, exempt: false });
    expect(withhold(form, 2_000, 12)).toBe(6_583);
  });
});

describe('supplemental wages (Pub 15 section 7)', () => {
  const base = {
    rules: R,
    w4: w4(),
    regularWagesCents: usd(10_000),
    nraAdditionCents: 0,
    periodsPerYear: 12,
    regularWithheldThisYearCents: usd(1_000),
  };

  it('37% on the part of the year above $1 million, 22% below it', () => {
    const s = supplementalWithholding({ ...base, supplementalCents: usd(100_000), ytdSupplementalCents: usd(950_000) });
    expect(s.mandatoryCents).toBe(usd(18_500));
    expect(s.flatCents).toBe(usd(11_000));
  });

  it('37% applies even to an employee whose W-4 claims exemption; the rest is not withheld', () => {
    const s = supplementalWithholding({ ...base, w4: w4({ exempt: true }), supplementalCents: usd(50_000), ytdSupplementalCents: usd(990_000) });
    expect(s).toMatchObject({ mandatoryCents: usd(14_800), flatCents: 0, aggregateCents: 0 });
  });

  it('uses the aggregate method when nothing was withheld from regular wages this year', () => {
    // Monthly $1,000 regular (no withholding) + $2,000 bonus: (36,000 − 8,600 − 19,900) × 12% + 1,240, ÷ 12 = 178.33.
    const s = supplementalWithholding({
      ...base,
      regularWagesCents: usd(1_000),
      supplementalCents: usd(2_000),
      ytdSupplementalCents: 0,
      regularWithheldThisYearCents: 0,
    });
    expect(s).toMatchObject({ method: 'aggregate', aggregateCents: usd(178.33), flatCents: 0 });
  });
});
