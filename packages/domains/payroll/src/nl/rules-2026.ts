/**
 * Dutch payroll rules for tax year 2026 (final).
 *
 * Sources (all fetched and checked on 9 October 2026):
 * - [RV] Rekenvoorschriften voor de geautomatiseerde loonadministratie 2026,
 *   uitgave januari 2026, versie 2:
 *   https://download.belastingdienst.nl/belastingdienst/docs/rekenvoorschriften_voor_geautomatiseerde_loonadministratie_lh991z62fd.pdf
 * - [BB] Witte tabel bijzondere beloning Nederland, Standaard (uitgave januari 2026):
 *   https://download.belastingdienst.nl/belastingdienst/dl/rekenhulpen/loonheffing/2026/v01/pdf/wit_bb_nl_std_20260101.pdf
 *   (identical to `wit_bb_nl_std_20260101.csv` in the ODB release LH2026v09,
 *   https://odb.belastingdienst.nl/wp-content/uploads/2026/01/LH2026v09.zip)
 * - [Annex] Tarieven, bedragen en percentages loonheffingen vanaf 1 januari 2026,
 *   bijlage bij de Nieuwsbrief Loonheffingen 2026, uitgave 4 (25 juni 2026):
 *   https://download.belastingdienst.nl/belastingdienst/docs/bijlage-nieuwsbrief-loonheffingen-2026-lh2091b64fd.pdf
 * - [HB] Handboek Loonheffingen 2026, versie maart 2026:
 *   https://download.belastingdienst.nl/belastingdienst/docs/handboek-loonheffingen-lh0221t61fd.pdf
 * - [WML] Bedragen minimumloon 2026, rijksoverheid.nl:
 *   https://www.rijksoverheid.nl/onderwerpen/minimumloon/bedragen-minimumloon/bedragen-minimumloon-2026
 */

import type { NlRuleSet } from './rules';

export const NL_RULES_2026: NlRuleSet = {
  year: 2026,
  id: 'nl-2026.1',
  provisional: false,
  unverified: [],

  // HB §18.21 and §2.3.1: "De AOW-leeftijd is voor 2024 tot en met 2027 vastgesteld op 67 jaar."
  aowAge: { years: 67, months: 0 },

  wageTax: {
    // RV §2.2.1 table 1a.
    lv: 54,
    lmax: 133_110,
    // RV §2.2.2 table 2 (bracket 2 rate 37,56 per versie 2 erratum).
    belowAow: { a2: 38_883, a3: 78_426, b1: 35.75, b2: 37.56, b3: 49.5, c2: 13_900, c3: 28_752 },
    aow1945: { a2: 41_123, a3: 78_426, b1: 17.85, b2: 37.56, b3: 49.5, c2: 7_340, c3: 21_351 },
    aow1946: { a2: 38_883, a3: 78_426, b1: 17.85, b2: 37.56, b3: 49.5, c2: 6_940, c3: 21_792 },
    // RV §2.2.3.1 table 3.
    ahk: { g1: 29_736, g2: 78_426, belowAow: { m1: 3_115, a1: 0.06398 }, aow: { m1: 1_556, a1: 0.03195 } },
    // RV §2.2.3.2 table 4.
    ouk: { m1: 2_067, g1: 46_002, g2: 59_782, a1: 0.15 },
    // RV §2.2.3.4 table 6.
    ark: {
      g1: 11_965,
      g2: 25_845,
      g3: 45_592,
      g4: 132_920,
      belowAow: { o1: 0.08324, o2: 0.31009, o3: 0.0195, a1: 0.0651, m1: 996, m2: 5_300, m3: 5_685 },
      aow: { o1: 0.04156, o2: 0.15483, o3: 0.00974, a1: 0.0325, m1: 498, m2: 2_647, m3: 2_840 },
    },
    // RV §4.3: "Het anoniementarief is 52%."
    anonymousRatePercent: 52,
  },

  // BB, every row; AOW columns "excl. alleenstaande-ouderenkorting".
  specialRewardTable: [
    { from: 0, belowAow: { without: 35.75, standard: 0, offset: 0 }, aow1945: { without: 17.85, standard: 0, offset: 0 }, aow1946: { without: 17.85, standard: 0, offset: 0 } },
    { from: 11_358, belowAow: { without: 35.75, standard: 35.75, offset: -8.32 }, aow1945: { without: 17.85, standard: 0, offset: 0 }, aow1946: { without: 17.85, standard: 0, offset: 0 } },
    { from: 12_923, belowAow: { without: 35.75, standard: 35.75, offset: -31.01 }, aow1945: { without: 17.85, standard: 0, offset: 0 }, aow1946: { without: 17.85, standard: 0, offset: 0 } },
    { from: 23_931, belowAow: { without: 35.75, standard: 35.75, offset: -1.95 }, aow1945: { without: 17.85, standard: 0, offset: 0 }, aow1946: { without: 17.85, standard: 0, offset: 0 } },
    { from: 29_737, belowAow: { without: 35.75, standard: 35.75, offset: 4.45 }, aow1945: { without: 17.85, standard: 0, offset: 0 }, aow1946: { without: 17.85, standard: 0, offset: 0 } },
    { from: 34_719, belowAow: { without: 35.75, standard: 35.75, offset: 4.45 }, aow1945: { without: 17.85, standard: 17.85, offset: 2.22 }, aow1946: { without: 17.85, standard: 17.85, offset: 2.22 } },
    { from: 37_409, belowAow: { without: 35.75, standard: 35.75, offset: 4.45 }, aow1945: { without: 17.85, standard: 17.85, offset: 2.22 }, aow1946: { without: 17.85, standard: 17.85, offset: 2.22 } },
    { from: 38_884, belowAow: { without: 37.56, standard: 37.56, offset: 4.45 }, aow1945: { without: 17.85, standard: 17.85, offset: 2.22 }, aow1946: { without: 37.56, standard: 37.56, offset: 2.22 } },
    { from: 41_124, belowAow: { without: 37.56, standard: 37.56, offset: 4.45 }, aow1945: { without: 37.56, standard: 37.56, offset: 2.22 }, aow1946: { without: 37.56, standard: 37.56, offset: 2.22 } },
    { from: 45_593, belowAow: { without: 37.56, standard: 37.56, offset: 12.91 }, aow1945: { without: 37.56, standard: 37.56, offset: 6.45 }, aow1946: { without: 37.56, standard: 37.56, offset: 6.45 } },
    { from: 46_003, belowAow: { without: 37.56, standard: 37.56, offset: 12.91 }, aow1945: { without: 37.56, standard: 37.56, offset: 21.45 }, aow1946: { without: 37.56, standard: 37.56, offset: 21.45 } },
    { from: 59_783, belowAow: { without: 37.56, standard: 37.56, offset: 12.91 }, aow1945: { without: 37.56, standard: 37.56, offset: 6.45 }, aow1946: { without: 37.56, standard: 37.56, offset: 6.45 } },
    { from: 78_427, belowAow: { without: 49.5, standard: 49.5, offset: 6.51 }, aow1945: { without: 49.5, standard: 49.5, offset: 3.25 }, aow1946: { without: 49.5, standard: 49.5, offset: 3.25 } },
    { from: 143_555, belowAow: { without: 49.5, standard: 49.5, offset: 0 }, aow1945: { without: 49.5, standard: 49.5, offset: 0 }, aow1946: { without: 49.5, standard: 49.5, offset: 0 } },
  ],

  // Groene tabel bijzondere beloning Nederland, Standaard 2026 (groen_bb_nl_std_20260101.csv,
  // OSWO table set in LH2026v09), AOW columns excl. alleenstaande-ouderenkorting.
  specialRewardTableGreen: [
    { from: 0, belowAow: { without: 35.75, standard: 0, offset: 0 }, aow1945: { without: 17.85, standard: 0, offset: 0 }, aow1946: { without: 17.85, standard: 0, offset: 0 } },
    { from: 8_714, belowAow: { without: 35.75, standard: 35.75, offset: 0 }, aow1945: { without: 17.85, standard: 0, offset: 0 }, aow1946: { without: 17.85, standard: 0, offset: 0 } },
    { from: 20_297, belowAow: { without: 35.75, standard: 35.75, offset: 0 }, aow1945: { without: 17.85, standard: 17.85, offset: 0 }, aow1946: { without: 17.85, standard: 17.85, offset: 0 } },
    { from: 23_323, belowAow: { without: 35.75, standard: 35.75, offset: 0 }, aow1945: { without: 17.85, standard: 17.85, offset: 0 }, aow1946: { without: 17.85, standard: 17.85, offset: 0 } },
    { from: 29_737, belowAow: { without: 35.75, standard: 35.75, offset: 6.4 }, aow1945: { without: 17.85, standard: 17.85, offset: 3.2 }, aow1946: { without: 17.85, standard: 17.85, offset: 3.2 } },
    { from: 38_884, belowAow: { without: 37.56, standard: 37.56, offset: 6.4 }, aow1945: { without: 17.85, standard: 17.85, offset: 3.2 }, aow1946: { without: 37.56, standard: 37.56, offset: 3.2 } },
    { from: 41_124, belowAow: { without: 37.56, standard: 37.56, offset: 6.4 }, aow1945: { without: 37.56, standard: 37.56, offset: 3.2 }, aow1946: { without: 37.56, standard: 37.56, offset: 3.2 } },
    { from: 46_003, belowAow: { without: 37.56, standard: 37.56, offset: 6.4 }, aow1945: { without: 37.56, standard: 37.56, offset: 18.2 }, aow1946: { without: 37.56, standard: 37.56, offset: 18.2 } },
    { from: 59_783, belowAow: { without: 37.56, standard: 37.56, offset: 6.4 }, aow1945: { without: 37.56, standard: 37.56, offset: 3.2 }, aow1946: { without: 37.56, standard: 37.56, offset: 3.2 } },
    { from: 78_427, belowAow: { without: 49.5, standard: 49.5, offset: 0 }, aow1945: { without: 49.5, standard: 49.5, offset: 0 }, aow1946: { without: 49.5, standard: 49.5, offset: 0 } },
  ],

  premiums: {
    // Annex table 9 (also HB §7.2, §7.5).
    awfLowPercent: 2.74,
    awfHighPercent: 7.74,
    aofLowPercent: 6.27,
    aofHighPercent: 7.63,
    wkoPercent: 0.5,
    // Annex table 10, column "Totaal" (sector rates for small employers, HB §7.6.1).
    whkSectorPercent: {
      1: 1.17, 2: 1.47, 3: 1.31, 4: 1.57, 5: 1.66, 6: 1.06, 7: 1.5, 8: 1.16, 9: 1.75, 10: 1.44,
      11: 0.97, 12: 1.38, 13: 2.2, 14: 2.19, 15: 2.12, 16: 2.46, 17: 1.93, 18: 4.2, 19: 1.75, 20: 1.42,
      21: 2.9, 22: 1.36, 23: 1.5, 24: 0.88, 25: 1.52, 26: 1.52, 27: 3.45, 28: 4.76, 29: 1.88, 30: 2.1,
      31: 1.12, 32: 1.76, 33: 1.77, 34: 3.55, 35: 1.81, 38: 1.41, 39: 0.76, 40: 1.47, 41: 1.25, 42: 1.45,
      43: 1.16, 44: 0.94, 45: 1.25, 46: 2.03, 47: 1.61, 48: 2.31, 49: 2.1, 50: 1.92, 51: 1.96, 52: 6.63,
      53: 2.97, 54: 1.5, 55: 1.93, 56: 1.88, 57: 1.87, 58: 2.34, 59: 2.13, 60: 1.87, 61: 1.4, 62: 1.67,
      63: 1.31, 64: 1.49, 65: 1.29, 66: 1.35, 67: 4.91, 68: 1.92, 69: 1.52,
    },
    // Annex table 11: dag 305,41 / maand 6.617,41 / jaar 79.409,00.
    maxPremieloon: { year: 7_940_900, month: 661_741, day: 30_541 },
    // Annex table 12; HB §8.2.1 and §8.2.2.
    zvwEmployerLevyPercent: 6.1,
    zvwWithheldPercent: 4.85,
  },

  // WML (gross minimum wage per hour; youth rates by age).
  minimumWage: [
    { from: '2026-01-01', perHour: { 15: 441, 16: 507, 17: 581, 18: 736, 19: 883, 20: 1177, 21: 1471 } },
    { from: '2026-07-01', perHour: { 15: 450, 16: 517, 17: 592, 18: 750, 19: 899, 20: 1199, 21: 1499 } },
  ],

  wkr: {
    // Annex (uitgave 4) table 13: € 0,25 per km, retroactive to 1 January 2026 by the
    // decision of the State Secretary of 17 May 2026 (the March Handboek still says € 0,23).
    perKmCents: 25,
    // Annex table 13; HB §22.1.12: € 2,45 per home-working day.
    homeWorkingPerDayCents: 245,
  },

  expat: {
    // HB §19.4.3: at most 30% of the wage including the allowance in 2025 and 2026 (the
    // percentage in force comes with the employee); Annex table 12: salary norm 48.013, WNT norm 262.000.
    salaryNormCents: 4_801_300,
    wntCapCents: 26_200_000,
  },

  // Annex table 12; HB §18.1: "Minimumbedrag gebruikelijk loon … 58.000".
  dgaUsualSalaryCents: 5_800_000,
};
