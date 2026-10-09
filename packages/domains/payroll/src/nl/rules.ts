/**
 * The shape of one Dutch tax year's payroll rules, and the lookup by year.
 *
 * Every figure lives in a `rules-<year>.ts` file next to the official source
 * it comes from. The engine never hard-codes a rate: a new year is a new
 * rule set. Wage-tax parameters keep the units and symbol names of the
 * Belastingdienst's "Rekenvoorschriften voor de geautomatiseerde
 * loonadministratie" (whole euros, factors with 5 decimals, percentages with
 * 2 decimals) so a rule set can be checked line by line against that
 * document. Everything else is in cents or percent.
 */

import type { Cents } from '../money';
import { NL_RULES_2026 } from './rules-2026';
import { NL_RULES_2027 } from './rules-2027';

/** Bracket values of rekenvoorschriften table 2 for one age group (a in euros, b in percent, c in euros). */
export interface NlBrackets {
  /** End of bracket 1 (a2). */
  a2: number;
  /** End of bracket 2 (a3). */
  a3: number;
  b1: number;
  b2: number;
  b3: number;
  /** Cumulated tax over bracket 1 (c2) and brackets 1+2 (c3), whole euros. */
  c2: number;
  c3: number;
}

export interface NlArbeidskorting {
  /** Build-up factors from 0, from g1, from g2, and the phase-out factor from g3. */
  o1: number;
  o2: number;
  o3: number;
  a1: number;
  /** Maximum after build-up 1, 2 and 3 (m3 is the overall maximum). */
  m1: number;
  m2: number;
  m3: number;
}

/** One row of the white special-reward table ("tabel bijzondere beloningen"). Percentages. */
export interface NlSpecialRewardColumn {
  /** Rate without loonheffingskorting. */
  without: number;
  /** "Standaardtarief" with loonheffingskorting. */
  standard: number;
  /** "Verrekeningspercentage loonheffingskorting" (added to the standard rate). */
  offset: number;
}

export interface NlSpecialRewardRow {
  /** Annual wage (previous year) from which this row applies, whole euros. */
  from: number;
  belowAow: NlSpecialRewardColumn;
  /** AOW age, born 1945 or earlier (columns excluding the alleenstaande-ouderenkorting). */
  aow1945: NlSpecialRewardColumn;
  /** AOW age, born 1946 or later (columns excluding the alleenstaande-ouderenkorting). */
  aow1946: NlSpecialRewardColumn;
}

export interface NlMinimumWage {
  /** First day the amounts apply, `YYYY-MM-DD`. */
  from: string;
  /** Gross minimum wage per hour by age (15…20) and `21` for 21 and older, cents. */
  perHour: Record<15 | 16 | 17 | 18 | 19 | 20 | 21, Cents>;
}

export interface NlRuleSet {
  year: number;
  /** Rule-set id stored on each payslip (`PayslipResult.ruleSet`). */
  id: string;
  /** True while the figures are not yet final (e.g. the Prinsjesdag version of next year's rules). */
  provisional: boolean;
  /**
   * Parameters for which no official figure for this year existed when the set
   * was written: they carry the previous year's verified value as a placeholder.
   * Reported in the `provisional_rules` warning.
   */
  unverified: string[];

  /** AOW (state pension) age in this year. */
  aowAge: { years: number; months: number };

  wageTax: {
    /** Annual-wage step of the source table (Lv) and the highest table wage (Lmax), euros. */
    lv: number;
    lmax: number;
    belowAow: NlBrackets;
    /** AOW age, born 1945 or earlier. */
    aow1945: NlBrackets;
    /** AOW age, born 1946 or later. */
    aow1946: NlBrackets;
    /** Algemene heffingskorting: maximum (m1), phase-out from g1 to g2 by factor a1. */
    ahk: { g1: number; g2: number; belowAow: { m1: number; a1: number }; aow: { m1: number; a1: number } };
    /** Ouderenkorting (AOW age only). */
    ouk: { m1: number; g1: number; g2: number; a1: number };
    /** Arbeidskorting (white table only). */
    ark: { g1: number; g2: number; g3: number; g4: number; belowAow: NlArbeidskorting; aow: NlArbeidskorting };
    /** Anonymous rate (anoniementarief), percent. */
    anonymousRatePercent: number;
  };

  /** White special-reward table, rows ascending by `from`. */
  specialRewardTable: NlSpecialRewardRow[];
  /**
   * Green special-reward table, for loon uit vroegere dienstbetrekking such as
   * the transitievergoeding (HB §9.3.3; gegevensspecificaties: SrtIV 62).
   */
  specialRewardTableGreen: NlSpecialRewardRow[];

  premiums: {
    awfLowPercent: number;
    awfHighPercent: number;
    aofLowPercent: number;
    aofHighPercent: number;
    /** Opslag Wko on the Aof premium wage. */
    wkoPercent: number;
    /** Whk sector rate for small employers, keyed by sectorcode (total of WGA + ZWflex). */
    whkSectorPercent: Record<number, number>;
    /** Maximum premieloon / maximum bijdrageloon (same caps for the Zvw), cents. */
    maxPremieloon: { year: Cents; month: Cents; day: Cents };
    zvwEmployerLevyPercent: number;
    zvwWithheldPercent: number;
  };

  minimumWage: NlMinimumWage[];

  /** Werkkostenregeling targeted exemptions. */
  wkr: {
    /** Tax-free allowance per km, cents. */
    perKmCents: Cents;
    /** Tax-free home-working allowance per day, cents. */
    homeWorkingPerDayCents: Cents;
  };

  expat: {
    /** Salary norm (taxable wage excluding the allowance), per year, cents. */
    salaryNormCents: Cents;
    /** WNT norm: maximum base the allowance is computed over, per year, cents. */
    wntCapCents: Cents;
  };

  /** Minimum usual salary of a DGA (gebruikelijkloonregeling), per year, cents. */
  dgaUsualSalaryCents: Cents;
}

const RULE_SETS: Record<number, NlRuleSet> = {
  2026: NL_RULES_2026,
  2027: NL_RULES_2027,
};

/** The rule set for a tax year, or null when the engine has none (→ `unsupported_tax_year`). */
export function nlRulesForYear(year: number): NlRuleSet | null {
  return RULE_SETS[year] ?? null;
}

export function supportedNlTaxYears(): number[] {
  return Object.keys(RULE_SETS).map(Number).sort();
}
