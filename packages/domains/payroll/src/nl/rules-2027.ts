/**
 * Dutch payroll rules for tax year 2027 — PROVISIONAL.
 *
 * As of 9 October 2026 the Belastingdienst has published only the Prinsjesdag
 * version of the 2027 calculation rules (Belastingplan 2027 as sent to
 * parliament); the Tweede Kamer version follows on 1 December 2026 and may
 * still change figures. The engine marks every 2027 payslip with a
 * `provisional_rules` warning until this file is replaced by the final set.
 *
 * Sources (fetched 9 October 2026):
 * - [RV27] Rekenvoorschriften LH 2027, Prinsjesdagversie 15 september 2026
 *   (`1_rekenvoorschriften LH 2027_prinsjesdagversie_15sept2026.xlsx`, sheet
 *   "Symbolen en waarden"), and [BB27] `wit_bb_nl_std_20270101.csv` from the
 *   OSWO table set, both in the ODB release Loonheffingen Aangifte 2027v1.5
 *   (8 October 2026): https://odb.belastingdienst.nl/wp-content/uploads/2026/10/LH2027v1.5.zip
 * - [SZW27] Memorie van toelichting begroting SZW 2027, §7.1.1 (premiums of the
 *   social funds; "voorlopig", final rates follow in the Staatscourant):
 *   https://www.rijksfinancien.nl/memorie-van-toelichting/2027/OWB/XV
 * - [UWV27] UWV, Gedifferentieerde premies WGA en Ziektewet 2027, tabel 1.2
 *   (sector premiums, set by the Besluit gedifferentieerde premie Whk 2027):
 *   https://www.uwv.nl/assets-kai/files/e465c57e-dd6a-447a-8feb-bee3c9a41575/gedifferentieerde-premies-wga-en-ziektewet-2027.pdf
 * - [HB] Handboek Loonheffingen 2026 §18.21 (AOW age 67 up to and including
 *   2027) and §19.4.3 (expat percentage 27% from 2027, with transition rights).
 *
 * Figures without a 2027 source yet carry the 2026 value and are listed in
 * `unverified`: the maximum premium wage, the Zvw percentages, the minimum
 * wage (adult amount not yet set; youth percentages rise from 1 January 2027),
 * the WKR per-km and home-working amounts, the expat salary norm and WNT norm,
 * and the DGA usual salary.
 */

import { NL_RULES_2026 } from './rules-2026';
import type { NlRuleSet } from './rules';

/** [UWV27] tabel 1.2: sector → [WGA, ZW]; the small-employer rate is their sum. */
const WHK_SECTORS_2027: Record<number, [number, number]> = {
  1: [0.88, 0.39], 2: [1.09, 0.61], 3: [0.94, 0.39], 4: [1.38, 0.3], 5: [1.17, 0.56], 6: [0.72, 0.42],
  7: [1.11, 0.56], 8: [0.87, 0.45], 9: [1.3, 0.62], 10: [1.17, 0.45], 11: [0.82, 0.26],
  12: [1.05, 0.47], 13: [1.44, 0.76], 14: [1.7, 0.68], 15: [1.56, 0.76], 16: [1.98, 0.67],
  17: [1.33, 0.79], 18: [3.1, 1.33], 19: [1.33, 0.58], 20: [0.92, 0.68], 21: [2.59, 0.71],
  22: [0.87, 0.56], 23: [1.4, 0.21], 24: [0.67, 0.3], 25: [1.09, 0.61], 26: [1.09, 0.61],
  27: [2.06, 1.49], 28: [2.97, 1.96], 29: [1.17, 0.47], 30: [1.5, 0.72], 31: [0.69, 0.64],
  32: [1.07, 0.81], 33: [1, 0.9], 34: [2.14, 1.6], 35: [1.31, 0.78], 38: [1.07, 0.41],
  39: [0.59, 0.18], 40: [1.08, 0.52], 41: [0.85, 0.49], 42: [0.99, 0.56], 43: [0.92, 0.37],
  44: [0.55, 0.46], 45: [0.83, 0.56], 46: [1.55, 0.66], 47: [1.28, 0.53], 48: [1.85, 0.64],
  49: [1.55, 0.66], 50: [1.33, 0.73], 51: [1.41, 0.63], 52: [3.31, 3.41], 53: [1.69, 1.37],
  54: [0.99, 0.65], 55: [1.28, 0.73], 56: [1.45, 0.48], 57: [1.46, 0.46], 58: [1.68, 0.72],
  59: [1.34, 0.99], 60: [1.46, 0.46], 61: [1.28, 0.23], 62: [1.26, 0.1], 63: [1.09, 0.61],
  64: [1.22, 0.3], 65: [1.09, 0.61], 66: [1.18, 0.21], 67: [3.73, 1.09], 68: [1.52, 0.61],
  69: [0.95, 0.6],
};

function sectorTotals(pairs: Record<number, [number, number]>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [code, [wga, zw]] of Object.entries(pairs)) {
    out[Number(code)] = (Math.round(wga * 100) + Math.round(zw * 100)) / 100;
  }
  return out;
}

export const NL_RULES_2027: NlRuleSet = {
  year: 2027,
  id: 'nl-2027.0-prinsjesdag',
  provisional: true,
  unverified: [
    'premiums.maxPremieloon',
    'premiums.zvwEmployerLevyPercent',
    'premiums.zvwWithheldPercent',
    'minimumWage',
    'wkr.perKmCents',
    'wkr.homeWorkingPerDayCents',
    'expat.salaryNormCents',
    'expat.wntCapCents',
    'dgaUsualSalaryCents',
  ],

  // HB §18.21: 67 years for 2024 up to and including 2027.
  aowAge: { years: 67, months: 0 },

  wageTax: {
    // RV27 symbols Lv, Lmax.
    lv: 54,
    lmax: 139_050,
    // RV27 symbols a2.x, a3.x, b1.x–b3.x, c2.x, c3.x.
    belowAow: { a2: 39_247, a3: 78_426, b1: 36.23, b2: 38.16, b3: 49.5, c2: 14_219, c3: 29_169 },
    aow1945: { a2: 41_637, a3: 78_426, b1: 18.33, b2: 38.16, b3: 49.5, c2: 7_632, c3: 21_670 },
    aow1946: { a2: 39_247, a3: 78_426, b1: 18.33, b2: 38.16, b3: 49.5, c2: 7_193, c3: 22_143 },
    // RV27 ahkm1.1/.2, ahkg1, ahkg2, ahka1.1/.2.
    ahk: { g1: 30_910, g2: 78_426, belowAow: { m1: 3_154, a1: 0.06638 }, aow: { m1: 1_596, a1: 0.03358 } },
    // RV27 oukm1.2, oukg1.2, oukg2.2, ouka1.2.
    ouk: { m1: 1_993, g1: 46_577, g2: 59_864, a1: 0.15 },
    // RV27 arko*, arka1, arkg*, arkm*.
    ark: {
      g1: 12_438,
      g2: 26_865,
      g3: 47_834,
      g4: 138_910,
      belowAow: { o1: 0.09503, o2: 0.30207, o3: 0.01855, a1: 0.0651, m1: 1_182, m2: 5_540, m3: 5_929 },
      aow: { o1: 0.04808, o2: 0.15283, o3: 0.00938, a1: 0.03294, m1: 599, m2: 2_803, m3: 3_001 },
    },
    // Anoniementarief 52%: the RV27 structure is unchanged ("geen structurele wijzigingen ten opzichte van 2026").
    anonymousRatePercent: 52,
  },

  // BB27, every row; AOW columns "excl. alleenstaande-ouderenkorting".
  specialRewardTable: [
    { from: 0, belowAow: { without: 36.23, standard: 0, offset: 0 }, aow1945: { without: 18.33, standard: 0, offset: 0 }, aow1946: { without: 18.33, standard: 0, offset: 0 } },
    { from: 11_801, belowAow: { without: 36.23, standard: 36.23, offset: -9.5 }, aow1945: { without: 18.33, standard: 0, offset: 0 }, aow1946: { without: 18.33, standard: 0, offset: 0 } },
    { from: 13_434, belowAow: { without: 36.23, standard: 36.23, offset: -30.21 }, aow1945: { without: 18.33, standard: 0, offset: 0 }, aow1946: { without: 18.33, standard: 0, offset: 0 } },
    { from: 24_876, belowAow: { without: 36.23, standard: 36.23, offset: -1.86 }, aow1945: { without: 18.33, standard: 0, offset: 0 }, aow1946: { without: 18.33, standard: 0, offset: 0 } },
    { from: 30_911, belowAow: { without: 36.23, standard: 36.23, offset: 4.78 }, aow1945: { without: 18.33, standard: 0, offset: 0 }, aow1946: { without: 18.33, standard: 0, offset: 0 } },
    { from: 34_593, belowAow: { without: 36.23, standard: 36.23, offset: 4.78 }, aow1945: { without: 18.33, standard: 18.33, offset: 2.42 }, aow1946: { without: 18.33, standard: 18.33, offset: 2.42 } },
    { from: 37_229, belowAow: { without: 36.23, standard: 36.23, offset: 4.78 }, aow1945: { without: 18.33, standard: 18.33, offset: 2.42 }, aow1946: { without: 18.33, standard: 18.33, offset: 2.42 } },
    { from: 39_248, belowAow: { without: 38.16, standard: 38.16, offset: 4.78 }, aow1945: { without: 18.33, standard: 18.33, offset: 2.42 }, aow1946: { without: 38.16, standard: 38.16, offset: 2.42 } },
    { from: 41_638, belowAow: { without: 38.16, standard: 38.16, offset: 4.78 }, aow1945: { without: 38.16, standard: 38.16, offset: 2.42 }, aow1946: { without: 38.16, standard: 38.16, offset: 2.42 } },
    { from: 46_578, belowAow: { without: 38.16, standard: 38.16, offset: 4.78 }, aow1945: { without: 38.16, standard: 38.16, offset: 17.42 }, aow1946: { without: 38.16, standard: 38.16, offset: 17.42 } },
    { from: 47_835, belowAow: { without: 38.16, standard: 38.16, offset: 13.15 }, aow1945: { without: 38.16, standard: 38.16, offset: 21.65 }, aow1946: { without: 38.16, standard: 38.16, offset: 21.65 } },
    { from: 59_865, belowAow: { without: 38.16, standard: 38.16, offset: 13.15 }, aow1945: { without: 38.16, standard: 38.16, offset: 6.65 }, aow1946: { without: 38.16, standard: 38.16, offset: 6.65 } },
    { from: 78_427, belowAow: { without: 49.5, standard: 49.5, offset: 6.51 }, aow1945: { without: 49.5, standard: 49.5, offset: 3.29 }, aow1946: { without: 49.5, standard: 49.5, offset: 3.29 } },
    { from: 150_024, belowAow: { without: 49.5, standard: 49.5, offset: 0 }, aow1945: { without: 49.5, standard: 49.5, offset: 0 }, aow1946: { without: 49.5, standard: 49.5, offset: 0 } },
  ],

  // Groene tabel bijzondere beloning 2027, Prinsjesdag (groen_bb_nl_std_20270101.csv, OSWO table set in LH2027v1.5).
  specialRewardTableGreen: [
    { from: 0, belowAow: { without: 36.23, standard: 0, offset: 0 }, aow1945: { without: 18.33, standard: 0, offset: 0 }, aow1946: { without: 18.33, standard: 0, offset: 0 } },
    { from: 8_706, belowAow: { without: 36.23, standard: 36.23, offset: 0 }, aow1945: { without: 18.33, standard: 0, offset: 0 }, aow1946: { without: 18.33, standard: 0, offset: 0 } },
    { from: 19_580, belowAow: { without: 36.23, standard: 36.23, offset: 0 }, aow1945: { without: 18.33, standard: 18.33, offset: 0 }, aow1946: { without: 18.33, standard: 18.33, offset: 0 } },
    { from: 22_565, belowAow: { without: 36.23, standard: 36.23, offset: 0 }, aow1945: { without: 18.33, standard: 18.33, offset: 0 }, aow1946: { without: 18.33, standard: 18.33, offset: 0 } },
    { from: 30_911, belowAow: { without: 36.23, standard: 36.23, offset: 6.64 }, aow1945: { without: 18.33, standard: 18.33, offset: 3.36 }, aow1946: { without: 18.33, standard: 18.33, offset: 3.36 } },
    { from: 39_248, belowAow: { without: 38.16, standard: 38.16, offset: 6.64 }, aow1945: { without: 18.33, standard: 18.33, offset: 3.36 }, aow1946: { without: 38.16, standard: 38.16, offset: 3.36 } },
    { from: 41_638, belowAow: { without: 38.16, standard: 38.16, offset: 6.64 }, aow1945: { without: 38.16, standard: 38.16, offset: 3.36 }, aow1946: { without: 38.16, standard: 38.16, offset: 3.36 } },
    { from: 46_578, belowAow: { without: 38.16, standard: 38.16, offset: 6.64 }, aow1945: { without: 38.16, standard: 38.16, offset: 18.36 }, aow1946: { without: 38.16, standard: 38.16, offset: 18.36 } },
    { from: 59_865, belowAow: { without: 38.16, standard: 38.16, offset: 6.64 }, aow1945: { without: 38.16, standard: 38.16, offset: 3.36 }, aow1946: { without: 38.16, standard: 38.16, offset: 3.36 } },
    { from: 78_427, belowAow: { without: 49.5, standard: 49.5, offset: 0 }, aow1945: { without: 49.5, standard: 49.5, offset: 0 }, aow1946: { without: 49.5, standard: 49.5, offset: 0 } },
  ],

  premiums: {
    // SZW27 §7.1.1: AWf 2,74% / 7,74% (unchanged), Aof 6,67% / 8,03%, Wko 0,5%.
    awfLowPercent: 2.74,
    awfHighPercent: 7.74,
    aofLowPercent: 6.67,
    aofHighPercent: 8.03,
    wkoPercent: 0.5,
    whkSectorPercent: sectorTotals(WHK_SECTORS_2027),
    // UNVERIFIED for 2027: 2026 placeholders.
    maxPremieloon: NL_RULES_2026.premiums.maxPremieloon,
    zvwEmployerLevyPercent: NL_RULES_2026.premiums.zvwEmployerLevyPercent,
    zvwWithheldPercent: NL_RULES_2026.premiums.zvwWithheldPercent,
  },

  // UNVERIFIED for 2027: the 1 July 2026 amounts as placeholder.
  minimumWage: [{ from: '2027-01-01', perHour: NL_RULES_2026.minimumWage[1]!.perHour }],

  // UNVERIFIED for 2027: 2026 placeholders.
  wkr: { ...NL_RULES_2026.wkr },
  expat: { ...NL_RULES_2026.expat },
  dgaUsualSalaryCents: NL_RULES_2026.dgaUsualSalaryCents,
};
