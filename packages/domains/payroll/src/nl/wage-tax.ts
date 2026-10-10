/**
 * Loonbelasting/premie volksverzekeringen: the Belastingdienst's
 * "Rekenvoorschriften voor de geautomatiseerde loonadministratie" (RV),
 * implemented exactly, including every rounding step. The printed tables are
 * generated from these rules and are binding (RV §1 "Let op 1"), so the tests
 * reproduce the official white monthly table to the cent.
 *
 * Units follow the RV: the annual wage L and the annual amounts (X, credits)
 * are whole euros below Lmax; period amounts are cents. Integer arithmetic is
 * used wherever the RV rounds, so no floating-point residue can move a cent.
 *
 * Also here: the special-reward table (tabel bijzondere beloningen) and the
 * anonymous rate.
 */

import type { Cents } from '../money';
import { roundHalfAwayFromZero } from '../money';
import type { NlArbeidskorting, NlBrackets, NlRuleSet, NlSpecialRewardColumn } from './rules';

/** Which column of the tables applies (RV table 2; HB §9.3.1 "Hoe kiest u de goede kolom?"). */
export type NlAgeColumn = 'belowAow' | 'aow1945' | 'aow1946';

/** RV table 1b: tijdvakfactor F. */
export const PERIOD_FACTOR = { quarter: 4, month: 12, fourWeeks: 13, week: 52, day: 260 } as const;

export interface PeriodTaxResult {
  /** Withheld loonbelasting/premie volksverzekeringen for the period, cents. */
  taxCents: Cents;
  /** Verrekende arbeidskorting for the period (RV table 8: ark = ARK/F), cents. */
  labourCreditCents: Cents;
  /** Annual wage L the table row is based on, euros (5 decimals above Lmax). */
  annualWage: number;
  /** Tabelloon ℓ = L/F rounded up to cents (RV table 8). */
  tableWageCents: Cents;
}

/** Factors in the RV have 5 decimals and percentages 2: scale them to integers once. */
function scaled(value: number, decimals: number): number {
  return Math.round(value * 10 ** decimals);
}

function bracketsFor(rules: NlRuleSet, column: NlAgeColumn): NlBrackets {
  return rules.wageTax[column];
}

/** RV §2.2.2 + §2.2.4: X1 for L ≤ Lmax, whole euros, rounded down, at least 0. */
function x1BelowLmax(L: number, br: NlBrackets): number {
  let a = 0;
  let b = br.b1;
  let c = 0;
  if (L > br.a3) {
    a = br.a3;
    b = br.b3;
    c = br.c3;
  } else if (L > br.a2) {
    a = br.a2;
    b = br.b2;
    c = br.c2;
  }
  // (L - a) * b / 100 + c, with b in hundredths of a percent → divide by 10_000.
  const x1 = Math.floor(((L - a) * scaled(b, 2)) / 10_000) + c;
  return Math.max(0, x1);
}

/** RV §2.2.3.1: algemene heffingskorting, whole euros (rounded up during phase-out). */
function algemeneHeffingskorting(L: number, rules: NlRuleSet, aow: boolean): number {
  const { g1, g2 } = rules.wageTax.ahk;
  const { m1, a1 } = aow ? rules.wageTax.ahk.aow : rules.wageTax.ahk.belowAow;
  if (L <= g1) return m1;
  if (L > g2) return 0;
  // AHK = m1 - (L - g1) * a1, rounded up: m1 - floor((L - g1) * a1).
  const reduction = Math.floor(((L - g1) * scaled(a1, 5)) / 100_000);
  return Math.max(0, m1 - reduction);
}

/** RV §2.2.3.2: ouderenkorting (AOW age only), whole euros. */
function ouderenkorting(L: number, rules: NlRuleSet): number {
  const { m1, g1, g2, a1 } = rules.wageTax.ouk;
  if (L <= g1) return m1;
  if (L > g2) return 0;
  const reduction = Math.floor(((L - g1) * scaled(a1, 5)) / 100_000);
  return Math.max(0, m1 - reduction);
}

/**
 * RV §2.2.3.4: arbeidskorting, whole euros. The terms are computed in units of
 * 1e-5 euro (each "rekenkundig afgerond op 5 decimalen" is exact for whole-euro
 * L), capped cumulatively at arkm1/arkm2/arkm3, and the result rounded up.
 */
function arbeidskorting(L: number, rules: NlRuleSet, aow: boolean): number {
  const { g1, g2, g3, g4 } = rules.wageTax.ark;
  if (L > g4 || L <= 0) return 0;
  const p: NlArbeidskorting = aow ? rules.wageTax.ark.aow : rules.wageTax.ark.belowAow;
  const E5 = 100_000;
  const pos = (n: number) => Math.max(0, n);
  const t1 = Math.min(L * scaled(p.o1, 5), p.m1 * E5);
  const t2 = Math.min(t1 + pos(L - g1) * scaled(p.o2, 5), p.m2 * E5);
  const t3 = Math.min(t2 + pos(L - g2) * scaled(p.o3, 5), p.m3 * E5);
  const total = t3 - pos(L - g3) * scaled(p.a1, 5);
  if (total <= 0) return 0;
  return Math.ceil(total / E5);
}

/** Period wage → annual wage L per RV §2.2.1 and §2.2.5 (table wage at most ⌈Lmax/F⌉). */
function annualWageFor(periodWageCents: Cents, factor: number, rules: NlRuleSet): { L: number; aboveLmax: boolean } {
  if (periodWageCents <= 0) return { L: 0, aboveLmax: false };
  const { lv, lmax } = rules.wageTax;
  // Highest period wage still read from the table: Lmax / F rounded up to cents (RV §2.2.5).
  const tableMaxCents = Math.ceil((lmax * 100) / factor);
  if (periodWageCents <= tableMaxCents) {
    const annualCents = periodWageCents * factor;
    const steps = Math.floor(annualCents / (lv * 100));
    return { L: Math.min(lmax, steps * lv), aboveLmax: false };
  }
  return { L: (periodWageCents * factor) / 100, aboveLmax: true };
}

/**
 * Loonbelasting/premie volksverzekeringen over one period wage with the white
 * period table (RV chapter 2), for an employee living in the Netherlands in
 * the standard situation.
 *
 * @param factor RV table 1b (12 for a month, 260 for a day).
 */
export function periodWageTax(
  periodWageCents: Cents,
  factor: number,
  column: NlAgeColumn,
  applyLoonheffingskorting: boolean,
  rules: NlRuleSet,
): PeriodTaxResult {
  const { L, aboveLmax } = annualWageFor(periodWageCents, factor, rules);
  const tableWageCents = Math.ceil((L * 100) / factor - 1e-9);
  if (L <= 0) return { taxCents: 0, labourCreditCents: 0, annualWage: 0, tableWageCents: 0 };

  const br = bracketsFor(rules, column);
  const aow = column !== 'belowAow';

  if (aboveLmax) {
    // RV §2.2.4 "Systematiek 2 (met de rekenregel)". Above Lmax every credit is 0
    // (arkg4, ahkg2 and oukg2 are below Lmax), so X = X1.
    const lmax = rules.wageTax.lmax;
    const yAnnual = Math.floor(((lmax - br.a3) * scaled(br.b3, 2)) / 10_000) + br.c3;
    const yPeriodCents = roundHalfAwayFromZero((yAnnual * 100) / factor);
    // [(L - Lmax) / F] rounded to 5 decimals, in 1e-5 euro; L - Lmax = tvl*F - Lmax.
    const excessPer5 = roundHalfAwayFromZero(((periodWageCents * factor - lmax * 100) * 1_000) / factor);
    // × bmax / 100, rounded down to cents: excessPer5 (1e-5 €) × b (1e-2 %) → 1e-9 €·% → /1e9*... in cents.
    const xBovenCents = Math.floor((excessPer5 * scaled(br.b3, 2)) / 10_000_000);
    return { taxCents: yPeriodCents + xBovenCents, labourCreditCents: 0, annualWage: L, tableWageCents };
  }

  const x1 = x1BelowLmax(L, br);
  let ahk = 0;
  let ouk = 0;
  let ark = 0;
  if (applyLoonheffingskorting) {
    ahk = algemeneHeffingskorting(L, rules, aow);
    ouk = aow ? ouderenkorting(L, rules) : 0;
    ark = arbeidskorting(L, rules, aow);
  }
  // Alleenstaande-ouderenkorting (AOK) is not applied: it needs the employee's
  // explicit consent recorded in the loonstaat (HB §11.1), which the input does not carry.
  let X: number;
  if (x1 >= ahk + ouk + ark) {
    X = x1 - (ahk + ouk + ark);
  } else {
    // RV §2.2.4: X = 0 and the credits are topped off in the order AOK, ARK, OUK, AHK.
    X = 0;
    let excess = ahk + ouk + ark - x1;
    const cut = (amount: number) => {
      const take = Math.min(amount, excess);
      excess -= take;
      return amount - take;
    };
    ark = cut(ark);
    ouk = cut(ouk);
    ahk = cut(ahk);
  }
  return {
    taxCents: roundHalfAwayFromZero((X * 100) / factor),
    labourCreditCents: roundHalfAwayFromZero((ark * 100) / factor),
    annualWage: L,
    tableWageCents,
  };
}

/** White table for current employment; green table for loon uit vroegere dienstbetrekking (HB §9.3.2–9.3.3). */
export type NlTableColour = 'white' | 'green';

/** The row of the special-reward table for an annual wage (HB §9.3.6: take the lower amount). */
export function specialRewardColumn(
  annualWageCents: Cents,
  column: NlAgeColumn,
  rules: NlRuleSet,
  colour: NlTableColour = 'white',
): NlSpecialRewardColumn {
  const table = colour === 'green' ? rules.specialRewardTableGreen : rules.specialRewardTable;
  const euros = Math.floor(Math.max(0, annualWageCents) / 100);
  let row = table[0]!;
  for (const r of table) {
    if (r.from <= euros) row = r;
    else break;
  }
  return row[column];
}

/** Percentage applied to a special reward, as the sum of standard rate and offset (HB §9.3.6). */
export function specialRewardPercent(
  annualWageCents: Cents,
  column: NlAgeColumn,
  applyLoonheffingskorting: boolean,
  rules: NlRuleSet,
  colour: NlTableColour = 'white',
): number {
  const c = specialRewardColumn(annualWageCents, column, rules, colour);
  return applyLoonheffingskorting ? Math.round((c.standard + c.offset) * 100) / 100 : c.without;
}

/**
 * Tax on special rewards: amount × percentage, "afgerond op centen in het
 * voordeel van de werknemer" (footnote of the special-reward table), i.e.
 * rounded down.
 */
export function specialRewardTax(amountCents: Cents, percent: number): Cents {
  return Math.floor((amountCents * scaled(percent, 2)) / 10_000 + 1e-9);
}

/** Anonymous rate: 52% of the wage (RV §4.3), rounded down to cents in the employee's favour. */
export function anonymousTax(amountCents: Cents, rules: NlRuleSet): Cents {
  return Math.floor((amountCents * scaled(rules.wageTax.anonymousRatePercent, 2)) / 10_000 + 1e-9);
}
