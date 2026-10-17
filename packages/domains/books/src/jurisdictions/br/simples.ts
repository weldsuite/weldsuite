import type { BrSimplesAnexo } from './tax-profiles';

/**
 * Simples Nacional: the monthly DAS (LC 123/2006, Anexos I-V as rewritten by
 * LC 155/2016, in force since 2018).
 *
 * Each annex has six brackets (faixas) on the revenue of the last 12 months
 * (RBT12). The effective rate is (RBT12 x nominal rate - deduction) / RBT12,
 * and the DAS of a month is that rate on the month's revenue of the annex.
 * The DAS is then split over the taxes it pays (repartição), which matters
 * for revenue on which one of those taxes is not due (ISS withheld by the
 * customer, exports) and for the books.
 */

export type SimplesTax = 'irpj' | 'csll' | 'cofins' | 'pis' | 'cpp' | 'icms' | 'ipi' | 'iss';

interface Faixa {
  /** Upper bound of RBT12 for the bracket. */
  upTo: number;
  /** Nominal rate, percent. */
  rate: number;
  /** Parcela a deduzir, BRL. */
  deduction: number;
  /** Share of each tax in the DAS, percent (sums to 100). */
  split: Partial<Record<SimplesTax, number>>;
}

const LIMITS = [180_000, 360_000, 720_000, 1_800_000, 3_600_000, 4_800_000];

function faixas(
  rates: Array<[number, number]>,
  splits: Array<Partial<Record<SimplesTax, number>>>,
): Faixa[] {
  return rates.map(([rate, deduction], i) => ({ upTo: LIMITS[i], rate, deduction, split: splits[i] }));
}

/** Anexo I: commerce. */
const ANEXO_I = faixas(
  [[4, 0], [7.3, 5_940], [9.5, 13_860], [10.7, 22_500], [14.3, 87_300], [19, 378_000]],
  [
    { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 41.5, icms: 34 },
    { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 41.5, icms: 34 },
    { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 42, icms: 33.5 },
    { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 42, icms: 33.5 },
    { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 42, icms: 33.5 },
    { irpj: 13.5, csll: 10, cofins: 28.27, pis: 6.13, cpp: 42.1, icms: 0 },
  ],
);

/** Anexo II: industry. */
const ANEXO_II = faixas(
  [[4.5, 0], [7.8, 5_940], [10, 13_860], [11.2, 22_500], [14.7, 85_500], [30, 720_000]],
  [
    { irpj: 5.5, csll: 3.5, cofins: 11.51, pis: 2.49, cpp: 37.5, ipi: 7.5, icms: 32 },
    { irpj: 5.5, csll: 3.5, cofins: 11.51, pis: 2.49, cpp: 37.5, ipi: 7.5, icms: 32 },
    { irpj: 5.5, csll: 3.5, cofins: 11.51, pis: 2.49, cpp: 37.5, ipi: 7.5, icms: 32 },
    { irpj: 5.5, csll: 3.5, cofins: 11.51, pis: 2.49, cpp: 37.5, ipi: 7.5, icms: 32 },
    { irpj: 5.5, csll: 3.5, cofins: 11.51, pis: 2.49, cpp: 37.5, ipi: 7.5, icms: 32 },
    { irpj: 8.5, csll: 7.5, cofins: 20.96, pis: 4.54, cpp: 23.5, ipi: 35, icms: 0 },
  ],
);

/** Anexo III: services (and services moved here by the fator R). */
const ANEXO_III = faixas(
  [[6, 0], [11.2, 9_360], [13.5, 17_640], [16, 35_640], [21, 125_640], [33, 648_000]],
  [
    { irpj: 4, csll: 3.5, cofins: 12.82, pis: 2.78, cpp: 43.4, iss: 33.5 },
    { irpj: 4, csll: 3.5, cofins: 14.05, pis: 3.05, cpp: 43.4, iss: 32 },
    { irpj: 4, csll: 3.5, cofins: 13.64, pis: 2.96, cpp: 43.4, iss: 32.5 },
    { irpj: 4, csll: 3.5, cofins: 13.64, pis: 2.96, cpp: 43.4, iss: 32.5 },
    { irpj: 4, csll: 3.5, cofins: 12.82, pis: 2.78, cpp: 43.4, iss: 33.5 },
    { irpj: 35, csll: 15, cofins: 16.03, pis: 3.47, cpp: 30.5, iss: 0 },
  ],
);

/** Anexo IV: construction, cleaning, security, law firms. The CPP is paid outside the DAS. */
const ANEXO_IV = faixas(
  [[4.5, 0], [9, 8_100], [10.2, 12_420], [14, 39_780], [22, 183_780], [33, 828_000]],
  [
    { irpj: 18.8, csll: 15.2, cofins: 17.67, pis: 3.83, iss: 44.5 },
    { irpj: 19.8, csll: 15.2, cofins: 20.55, pis: 4.45, iss: 40 },
    { irpj: 20.8, csll: 15.2, cofins: 19.73, pis: 4.27, iss: 40 },
    { irpj: 17.8, csll: 19.2, cofins: 18.9, pis: 4.1, iss: 40 },
    { irpj: 18.8, csll: 19.2, cofins: 18.08, pis: 3.92, iss: 40 },
    { irpj: 53.5, csll: 21.5, cofins: 20.55, pis: 4.45, iss: 0 },
  ],
);

/** Anexo V: intellectual services subject to the fator R (below 28% payroll). */
const ANEXO_V = faixas(
  [[15.5, 0], [18, 4_500], [19.5, 9_900], [20.5, 17_100], [23, 62_100], [30.5, 540_000]],
  [
    { irpj: 25, csll: 15, cofins: 14.1, pis: 3.05, cpp: 28.85, iss: 14 },
    { irpj: 23, csll: 15, cofins: 14.1, pis: 3.05, cpp: 27.85, iss: 17 },
    { irpj: 24, csll: 15, cofins: 14.92, pis: 3.23, cpp: 23.85, iss: 19 },
    { irpj: 21, csll: 15, cofins: 15.74, pis: 3.41, cpp: 23.85, iss: 21 },
    { irpj: 23, csll: 12.5, cofins: 14.1, pis: 3.05, cpp: 23.85, iss: 23.5 },
    { irpj: 35, csll: 15.5, cofins: 16.44, pis: 3.56, cpp: 29.5, iss: 0 },
  ],
);

export const SIMPLES_ANEXOS: Record<BrSimplesAnexo, Faixa[]> = {
  I: ANEXO_I,
  II: ANEXO_II,
  III: ANEXO_III,
  IV: ANEXO_IV,
  V: ANEXO_V,
};

/** Above this RBT12 a company leaves the Simples Nacional (LC 123 art. 3 II). */
export const SIMPLES_REVENUE_LIMIT = 4_800_000;
/** Above this RBT12 ICMS and ISS are paid outside the DAS (sublimite, art. 13-A). */
export const SIMPLES_SUBLIMIT = 3_600_000;
/** Fator R: payroll of 12 months / RBT12 at or above this moves Anexo V activities to Anexo III. */
export const FATOR_R_THRESHOLD = 0.28;
/** The ISS share of the DAS never exceeds 5% of revenue (LC 123 Anexos III and IV, note). */
export const SIMPLES_ISS_CAP = 5;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface SimplesRateResult {
  anexo: BrSimplesAnexo;
  /** 1-6 */
  faixa: number;
  nominalRate: number;
  deduction: number;
  /** Effective rate, percent, before the ISS cap. */
  effectiveRate: number;
  /** Share of each tax in the effective rate, percent of revenue (ISS capped at 5%, excess spread over the others). */
  rateByTax: Partial<Record<SimplesTax, number>>;
}

/** The effective rate of an annex for an RBT12, and how it splits over the taxes. */
export function simplesEffectiveRate(anexo: BrSimplesAnexo, rbt12: number): SimplesRateResult {
  const table = SIMPLES_ANEXOS[anexo];
  const index = table.findIndex((f) => rbt12 <= f.upTo);
  const faixaIndex = index === -1 ? table.length - 1 : index;
  const faixa = table[faixaIndex];
  // The first bracket has no deduction: its effective rate is the nominal one, also for an RBT12 of 0.
  const effectiveRate = rbt12 > 0 ? ((rbt12 * faixa.rate) / 100 - faixa.deduction) / rbt12 * 100 : faixa.rate;

  const rateByTax: Partial<Record<SimplesTax, number>> = {};
  for (const [tax, share] of Object.entries(faixa.split) as Array<[SimplesTax, number]>) {
    rateByTax[tax] = (effectiveRate * share) / 100;
  }
  const iss = rateByTax.iss ?? 0;
  if (iss > SIMPLES_ISS_CAP) {
    // The excess goes to the other taxes in proportion to their shares.
    const excess = iss - SIMPLES_ISS_CAP;
    rateByTax.iss = SIMPLES_ISS_CAP;
    const others = (Object.keys(faixa.split) as SimplesTax[]).filter((t) => t !== 'iss');
    const otherShare = others.reduce((sum, t) => sum + (faixa.split[t] ?? 0), 0);
    for (const t of others) rateByTax[t] = (rateByTax[t] ?? 0) + (excess * (faixa.split[t] ?? 0)) / otherShare;
  }
  return { anexo, faixa: faixaIndex + 1, nominalRate: faixa.rate, deduction: faixa.deduction, effectiveRate, rateByTax };
}

/**
 * RBT12 for a company in its first year: the average monthly revenue of the
 * months it has been active times 12 (LC 123 art. 18 §2); in its first month,
 * that month's revenue times 12.
 */
export function proportionalRbt12(args: { revenueBefore: number; monthsBefore: number; currentMonthRevenue: number }): number {
  if (args.monthsBefore >= 12) return args.revenueBefore;
  if (args.monthsBefore <= 0) return args.currentMonthRevenue * 12;
  return (args.revenueBefore / args.monthsBefore) * 12;
}

/** Fator R: the annex an Anexo V activity is taxed in. */
export function annexAfterFatorR(anexo: BrSimplesAnexo, payroll12m: number, rbt12: number): { anexo: BrSimplesAnexo; fatorR: number | null } {
  if (anexo !== 'V') return { anexo, fatorR: null };
  const fatorR = rbt12 > 0 ? payroll12m / rbt12 : 0;
  return { anexo: fatorR >= FATOR_R_THRESHOLD ? 'III' : 'V', fatorR };
}

export interface SimplesRevenueSlice {
  anexo: BrSimplesAnexo;
  /** Revenue of the month in this annex (net of returns). */
  revenue: number;
  /** Part of it on which the customer withheld the ISS: no ISS share in the DAS. */
  issWithheld?: number;
  /** Part of it from exports: only IRPJ, CSLL and CPP are due (LC 123 art. 18 §4-A IV). */
  exports?: number;
}

export interface SimplesDasLine {
  anexo: BrSimplesAnexo;
  revenue: number;
  faixa: number;
  nominalRate: number;
  deduction: number;
  effectiveRate: number;
  amount: number;
  byTax: Partial<Record<SimplesTax, number>>;
}

export interface SimplesDasResult {
  rbt12: number;
  fatorR: number | null;
  lines: SimplesDasLine[];
  total: number;
  /** RBT12 is over the sublimit: ICMS / ISS are owed outside the DAS. */
  overSublimit: boolean;
  /** RBT12 is over the Simples limit: the company has to leave the regime. */
  overLimit: boolean;
}

const EXPORT_EXEMPT: SimplesTax[] = ['cofins', 'pis', 'icms', 'ipi', 'iss'];

/** The DAS of a month. */
export function computeSimplesDas(args: {
  rbt12: number;
  payroll12m: number;
  slices: SimplesRevenueSlice[];
}): SimplesDasResult {
  let fatorR: number | null = null;
  const byAnexo = new Map<BrSimplesAnexo, SimplesRevenueSlice>();
  for (const slice of args.slices) {
    const moved = annexAfterFatorR(slice.anexo, args.payroll12m, args.rbt12);
    if (moved.fatorR !== null) fatorR = moved.fatorR;
    const existing = byAnexo.get(moved.anexo) ?? { anexo: moved.anexo, revenue: 0, issWithheld: 0, exports: 0 };
    existing.revenue += slice.revenue;
    existing.issWithheld = (existing.issWithheld ?? 0) + (slice.issWithheld ?? 0);
    existing.exports = (existing.exports ?? 0) + (slice.exports ?? 0);
    byAnexo.set(moved.anexo, existing);
  }

  const lines: SimplesDasLine[] = [];
  for (const slice of byAnexo.values()) {
    if (slice.revenue === 0) continue;
    const rate = simplesEffectiveRate(slice.anexo, args.rbt12);
    const byTax: Partial<Record<SimplesTax, number>> = {};
    for (const [tax, taxRate] of Object.entries(rate.rateByTax) as Array<[SimplesTax, number]>) {
      let base = slice.revenue;
      if (tax === 'iss') base -= slice.issWithheld ?? 0;
      if (EXPORT_EXEMPT.includes(tax)) base -= slice.exports ?? 0;
      byTax[tax] = round2((Math.max(0, base) * taxRate) / 100);
    }
    const amount = round2(Object.values(byTax).reduce((sum, v) => sum + (v ?? 0), 0));
    lines.push({
      anexo: slice.anexo,
      revenue: round2(slice.revenue),
      faixa: rate.faixa,
      nominalRate: rate.nominalRate,
      deduction: rate.deduction,
      effectiveRate: Math.round(rate.effectiveRate * 10_000) / 10_000,
      amount,
      byTax,
    });
  }
  return {
    rbt12: round2(args.rbt12),
    fatorR: fatorR === null ? null : Math.round(fatorR * 10_000) / 10_000,
    lines,
    total: round2(lines.reduce((sum, l) => sum + l.amount, 0)),
    overSublimit: args.rbt12 > SIMPLES_SUBLIMIT,
    overLimit: args.rbt12 > SIMPLES_REVENUE_LIMIT,
  };
}
