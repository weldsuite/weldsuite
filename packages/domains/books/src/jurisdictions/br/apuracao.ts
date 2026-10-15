import type { BrTaxRegime } from './regimes';
import { computeSimplesDas, type SimplesDasResult, type SimplesRevenueSlice } from './simples';

/**
 * Apuração: the monthly worksheet of what a Brazilian entity owes, from the
 * month's revenue and its tax ledger.
 *
 * - Simples Nacional: the DAS (simples.ts), due on the 20th of the next month.
 * - MEI: the fixed DAS-MEI.
 * - Lucro Presumido / Real: ISS, ICMS, IPI, PIS and COFINS of the month, each
 *   debits (on sales) less credits (on purchases) less what customers withheld;
 *   at the end of each quarter, IRPJ and CSLL.
 * - Every regime: the withholdings the entity kept back from suppliers and has
 *   to pay over.
 *
 * The due dates are the nominal ones (day of month); weekends and holidays
 * move them, and ISS and ICMS dates are set by each municipality and state.
 */

/** 2026 minimum wage (Decreto 12.797/2025): the DAS-MEI is 5% of it plus R$1 ICMS and/or R$5 ISS. */
export const BR_MINIMUM_WAGE: Record<number, number> = { 2025: 1518, 2026: 1621 };
export const MEI_REVENUE_LIMIT = 81_000;

/** LC 224/2025: presumption percentages x 1.10 on revenue above R$ 5 million a year (R$ 1.25 million a quarter). */
export const LC224_QUARTER_ALLOWANCE = 1_250_000;
export const LC224_FACTOR = 1.1;

export type BrTaxCode = 'iss' | 'icms' | 'ipi' | 'pis' | 'cofins' | 'cbs' | 'ibs';
export type BrWithholdingCode = 'irrf' | 'csrf' | 'inss' | 'iss';

export interface BrTaxLedgerTotal {
  /** tax_lines.component: iss, icms, fcp, ipi, pis, cofins, cbs, ibs, iss_ret, irrf, pis_ret, cofins_ret, csll_ret, inss_ret */
  component: string;
  direction: 'sales' | 'purchase';
  taxableAmount: number;
  taxAmount: number;
}

export interface BrQuarterRevenue {
  /** Revenue of each quarter of the year so far, index 0 = Q1; the last one is the quarter being closed. */
  services: number[];
  goods: number[];
  /** Financial and other income of the quarter being closed (added to the base in full). */
  otherIncome: number;
  /** Lucro Real: profit before IRPJ/CSLL of the quarter, from the ledger. */
  profitBeforeTax?: number;
}

export interface BrApuracaoInput {
  /** YYYY-MM */
  period: string;
  regime: BrTaxRegime;
  /** MEI: what it does (decides the ICMS / ISS part of the DAS-MEI). */
  meiActivity?: 'commerce' | 'services' | 'both';
  simples?: { slices: SimplesRevenueSlice[]; rbt12: number; payroll12m: number };
  ledger: BrTaxLedgerTotal[];
  /** Present when the period closes a quarter (March, June, September, December). */
  quarter?: BrQuarterRevenue;
  /** Apply LC 224/2025 (on unless the entity holds an injunction against it). */
  applyLc224?: boolean;
}

export interface BrTaxLine {
  code: BrTaxCode;
  debits: number;
  credits: number;
  /** Withheld by customers (ISS retido) or offset from withholdings (PIS/COFINS retidos). */
  offsets: number;
  payable: number;
  dueDate: string | null;
}

export interface BrWithholdingLine {
  code: BrWithholdingCode;
  base: number;
  amount: number;
  dueDate: string;
  /** DARF revenue code where there is one. */
  darfCode?: string;
}

export interface BrQuarterlyIncomeTax {
  quarter: number;
  irpjBase: number;
  csllBase: number;
  irpj: number;
  irpjAdditional: number;
  csll: number;
  /** IRRF and CSLL customers withheld during the quarter, offset here. */
  irrfOffset: number;
  csllOffset: number;
  irpjPayable: number;
  csllPayable: number;
  dueDate: string;
  lc224Applied: boolean;
}

export interface BrApuracao {
  period: string;
  regime: BrTaxRegime;
  simples: (SimplesDasResult & { dueDate: string }) | null;
  mei: { amount: number; inss: number; icms: number; iss: number; dueDate: string } | null;
  taxes: BrTaxLine[];
  withholdingsToPay: BrWithholdingLine[];
  /** What customers withheld in the month, by tax: credits against the entity's own taxes. */
  withheldByCustomers: Record<'irrf' | 'pis' | 'cofins' | 'csll' | 'inss' | 'iss', number>;
  quarterly: BrQuarterlyIncomeTax | null;
  /** CBS / IBS of the 2026 test year, shown on documents only. */
  informational: { cbs: number; ibs: number };
  /** Everything payable this period. */
  total: number;
  warnings: string[];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function nextMonthDay(period: string, day: number): string {
  const [y, m] = period.split('-').map(Number);
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastDayOfNextMonth(period: string): string {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

function sum(ledger: BrTaxLedgerTotal[], direction: 'sales' | 'purchase', ...components: string[]): { base: number; tax: number } {
  let base = 0;
  let tax = 0;
  for (const row of ledger) {
    if (row.direction === direction && components.includes(row.component)) {
      base += row.taxableAmount;
      tax += row.taxAmount;
    }
  }
  return { base: round2(base), tax: round2(tax) };
}

/** The part of a quarter's revenue above the LC 224 allowance, given the year's quarters so far. */
export function lc224Excess(quarters: number[], allowancePerQuarter = LC224_QUARTER_ALLOWANCE): number {
  const q = quarters.length;
  const through = quarters.reduce((a, b) => a + b, 0);
  const before = through - (quarters[q - 1] ?? 0);
  const excessThrough = Math.max(0, through - allowancePerQuarter * q);
  const excessBefore = Math.max(0, before - allowancePerQuarter * (q - 1));
  return Math.max(0, excessThrough - excessBefore);
}

/** Presumed profit of a quarter: each activity's percentage, x1.10 on the share of revenue above the LC 224 allowance. */
function presumedBase(
  services: number,
  goods: number,
  excess: number,
  rates: { services: number; goods: number },
): number {
  const total = services + goods;
  const excessShare = total > 0 ? Math.min(1, excess / total) : 0;
  const part = (revenue: number, rate: number) =>
    revenue * (1 - excessShare) * rate + revenue * excessShare * rate * LC224_FACTOR;
  return part(services, rates.services) + part(goods, rates.goods);
}

function quarterOf(period: string): number | null {
  const month = Number(period.slice(5, 7));
  return month % 3 === 0 ? month / 3 : null;
}

function computeQuarterly(input: BrApuracaoInput, withheld: BrApuracao['withheldByCustomers'], warnings: string[]): BrQuarterlyIncomeTax | null {
  const quarter = quarterOf(input.period);
  const q = input.quarter;
  if (!quarter || !q || (input.regime !== 'lucro_presumido' && input.regime !== 'lucro_real')) return null;
  const year = Number(input.period.slice(0, 4));
  const services = q.services.at(-1) ?? 0;
  const goods = q.goods.at(-1) ?? 0;

  let irpjBase: number;
  let csllBase: number;
  let lc224Applied = false;
  if (input.regime === 'lucro_presumido') {
    const totals = q.services.map((s, i) => s + (q.goods[i] ?? 0));
    const applyIrpj = input.applyLc224 !== false && year >= 2026;
    // CSLL follows the 90-day rule: from 1 April 2026, so 2026 counts from the second quarter.
    const applyCsll = applyIrpj && (year > 2026 || quarter >= 2);
    const irpjExcess = applyIrpj ? lc224Excess(totals) : 0;
    const csllExcess = applyCsll ? lc224Excess(year === 2026 ? totals.slice(1) : totals) : 0;
    lc224Applied = irpjExcess > 0 || csllExcess > 0;
    irpjBase = presumedBase(services, goods, irpjExcess, { services: 0.32, goods: 0.08 }) + q.otherIncome;
    csllBase = presumedBase(services, goods, csllExcess, { services: 0.32, goods: 0.12 }) + q.otherIncome;
  } else {
    const profit = q.profitBeforeTax ?? 0;
    irpjBase = Math.max(0, profit);
    csllBase = Math.max(0, profit);
    warnings.push(
      'Lucro Real: IRPJ and CSLL are worked out on the book profit of the quarter, without LALUR adjustments or loss carry-forward. Have your accountant review it.',
    );
  }

  const irpj = round2(irpjBase * 0.15);
  const irpjAdditional = round2(Math.max(0, irpjBase - 60_000) * 0.1);
  const csll = round2(csllBase * 0.09);
  const irrfOffset = round2(Math.min(withheld.irrf, irpj + irpjAdditional));
  const csllOffset = round2(Math.min(withheld.csll, csll));
  return {
    quarter,
    irpjBase: round2(irpjBase),
    csllBase: round2(csllBase),
    irpj,
    irpjAdditional,
    csll,
    irrfOffset,
    csllOffset,
    irpjPayable: round2(irpj + irpjAdditional - irrfOffset),
    csllPayable: round2(csll - csllOffset),
    dueDate: lastDayOfNextMonth(input.period),
    lc224Applied,
  };
}

export function computeBrApuracao(input: BrApuracaoInput): BrApuracao {
  const warnings: string[] = [];
  const { ledger, period } = input;
  const year = Number(period.slice(0, 4));

  const withheldByCustomers = {
    irrf: sum(ledger, 'sales', 'irrf').tax,
    pis: sum(ledger, 'sales', 'pis_ret').tax,
    cofins: sum(ledger, 'sales', 'cofins_ret').tax,
    csll: sum(ledger, 'sales', 'csll_ret').tax,
    inss: sum(ledger, 'sales', 'inss_ret').tax,
    iss: sum(ledger, 'sales', 'iss_ret').tax,
  };

  // Withholdings we kept back from suppliers: paid over by the 20th of the next month.
  const withholdingsToPay: BrWithholdingLine[] = [];
  const irrf = sum(ledger, 'purchase', 'irrf');
  if (irrf.tax) withholdingsToPay.push({ code: 'irrf', base: irrf.base, amount: irrf.tax, dueDate: nextMonthDay(period, 20), darfCode: '1708' });
  const csrf = sum(ledger, 'purchase', 'pis_ret', 'cofins_ret', 'csll_ret');
  if (csrf.tax) {
    withholdingsToPay.push({ code: 'csrf', base: sum(ledger, 'purchase', 'csll_ret').base, amount: csrf.tax, dueDate: nextMonthDay(period, 20), darfCode: '5952' });
  }
  const inss = sum(ledger, 'purchase', 'inss_ret');
  if (inss.tax) withholdingsToPay.push({ code: 'inss', base: inss.base, amount: inss.tax, dueDate: nextMonthDay(period, 20) });
  const issRet = sum(ledger, 'purchase', 'iss_ret');
  if (issRet.tax) {
    withholdingsToPay.push({ code: 'iss', base: issRet.base, amount: issRet.tax, dueDate: nextMonthDay(period, 10) });
    warnings.push('ISS withheld from suppliers is due on the date of the municipality where the service was provided.');
  }

  let simples: BrApuracao['simples'] = null;
  let mei: BrApuracao['mei'] = null;
  const taxes: BrTaxLine[] = [];

  if (input.regime === 'simples_nacional') {
    const das = computeSimplesDas({
      rbt12: input.simples?.rbt12 ?? 0,
      payroll12m: input.simples?.payroll12m ?? 0,
      slices: input.simples?.slices ?? [],
    });
    simples = { ...das, dueDate: nextMonthDay(period, 20) };
    if (das.overLimit) warnings.push('Revenue of the last 12 months is above R$ 4.8 million: the company has to leave the Simples Nacional.');
    else if (das.overSublimit) warnings.push('Revenue of the last 12 months is above the R$ 3.6 million sublimit: ICMS and ISS are paid outside the DAS.');
    if (year >= 2027) warnings.push('From 2027 the DAS also collects CBS (and IBS) with new annex percentages, which this worksheet does not yet apply.');
  } else if (input.regime === 'mei') {
    const wage = BR_MINIMUM_WAGE[year] ?? BR_MINIMUM_WAGE[2026];
    if (!BR_MINIMUM_WAGE[year]) warnings.push(`The minimum wage for ${year} is not configured; the ${2026} figure is used.`);
    const activity = input.meiActivity ?? 'services';
    const inssPart = round2(wage * 0.05);
    const icms = activity === 'services' ? 0 : 1;
    const iss = activity === 'commerce' ? 0 : 5;
    mei = { amount: round2(inssPart + icms + iss), inss: inssPart, icms, iss, dueDate: nextMonthDay(period, 20) };
  } else {
    const line = (code: BrTaxCode, debits: number, credits: number, offsets: number, dueDate: string | null): BrTaxLine => ({
      code,
      debits,
      credits,
      offsets,
      payable: round2(Math.max(0, debits - credits - offsets)),
      dueDate,
    });
    const issDebits = sum(ledger, 'sales', 'iss').tax;
    taxes.push(line('iss', issDebits, 0, withheldByCustomers.iss, nextMonthDay(period, 10)));
    const icmsDebits = round2(sum(ledger, 'sales', 'icms', 'fcp').tax);
    const icmsCredits = sum(ledger, 'purchase', 'icms').tax;
    if (icmsDebits || icmsCredits) taxes.push(line('icms', icmsDebits, icmsCredits, 0, null));
    const ipiDebits = sum(ledger, 'sales', 'ipi').tax;
    const ipiCredits = sum(ledger, 'purchase', 'ipi').tax;
    if (ipiDebits || ipiCredits) taxes.push(line('ipi', ipiDebits, ipiCredits, 0, nextMonthDay(period, 25)));
    if (year < 2027) {
      taxes.push(line('pis', sum(ledger, 'sales', 'pis').tax, sum(ledger, 'purchase', 'pis').tax, withheldByCustomers.pis, nextMonthDay(period, 25)));
      taxes.push(line('cofins', sum(ledger, 'sales', 'cofins').tax, sum(ledger, 'purchase', 'cofins').tax, withheldByCustomers.cofins, nextMonthDay(period, 25)));
    } else {
      const cbs = sum(ledger, 'sales', 'cbs').tax;
      const cbsCredits = sum(ledger, 'purchase', 'cbs').tax;
      if (cbs || cbsCredits) taxes.push(line('cbs', cbs, cbsCredits, 0, nextMonthDay(period, 25)));
      const ibs = sum(ledger, 'sales', 'ibs').tax;
      const ibsCredits = sum(ledger, 'purchase', 'ibs').tax;
      if (ibs || ibsCredits) taxes.push(line('ibs', ibs, ibsCredits, 0, nextMonthDay(period, 25)));
    }
    for (const t of taxes) {
      if (t.debits - t.credits - t.offsets < -0.005) {
        warnings.push(`${t.code.toUpperCase()}: credits and offsets exceed the debits by R$ ${(t.credits + t.offsets - t.debits).toFixed(2)}; the balance carries over to the next month.`);
      }
    }
    if (icmsDebits || icmsCredits) warnings.push('ICMS is due on the date set by the state; ICMS-ST and DIFAL are not included.');
  }

  const quarterly = computeQuarterly(input, withheldByCustomers, warnings);

  const informational = { cbs: sum(ledger, 'sales', 'cbs').tax, ibs: sum(ledger, 'sales', 'ibs').tax };
  if (year !== 2026) {
    informational.cbs = 0;
    informational.ibs = 0;
  }

  const total = round2(
    (simples?.total ?? 0) +
      (mei?.amount ?? 0) +
      taxes.reduce((s, t) => s + t.payable, 0) +
      withholdingsToPay.reduce((s, w) => s + w.amount, 0) +
      (quarterly ? quarterly.irpjPayable + quarterly.csllPayable : 0),
  );

  return {
    period,
    regime: input.regime,
    simples,
    mei,
    taxes,
    withholdingsToPay,
    withheldByCustomers,
    quarterly,
    informational,
    total,
    warnings,
  };
}
