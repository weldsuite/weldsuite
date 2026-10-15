/**
 * How a Brazilian document's taxes sit in its total.
 *
 * books-api tags every `taxBreakdown` row of a BR document with a `treatment`:
 * `added` taxes (IPI, and CBS / IBS once they are charged) go on top of the
 * price, `embedded` ones (ICMS, ISS, PIS, COFINS) are already inside it,
 * `withheld` ones (IRRF, INSS, retained ISS / PIS / COFINS / CSLL) are kept by
 * the customer and come off what is paid, and `informational` rows (CBS / IBS
 * in the test years) change nothing. total = subtotal + added - withheld.
 *
 * Nothing here calculates tax; it groups what the server sent.
 */

import { toNumber } from '@/lib/currency';
import type { TaxBreakdownRow, TaxTreatment } from '@/types/accounting';

/** Top to bottom as the document detail shows them. */
export const TAX_TREATMENT_ORDER: readonly TaxTreatment[] = ['added', 'embedded', 'withheld', 'informational'];

/** One tax (a component, at one rate) summed over the document's lines. */
export interface TreatmentTax {
  key: string;
  name: string;
  component: string | null;
  /** Percentage of the base, e.g. 18. */
  rate: number;
  base: number;
  /** Always positive: a withholding is shown negative by the caller. */
  amount: number;
}

export interface TreatmentGroup {
  treatment: TaxTreatment;
  taxes: TreatmentTax[];
  /** Sum of the taxes' amounts. */
  total: number;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function isTreatment(value: unknown): value is TaxTreatment {
  return typeof value === 'string' && (TAX_TREATMENT_ORDER as readonly string[]).includes(value);
}

/** True when the document's rows carry a treatment, i.e. it is a document of a jurisdiction that itemises them (BR). */
export function hasTreatmentRows(rows: readonly TaxBreakdownRow[] | null | undefined): boolean {
  return (rows ?? []).some((row) => isTreatment(row.treatment));
}

/**
 * The rows grouped by treatment, in display order, each group's taxes summed
 * per component and rate. Rows without a known treatment are left out.
 */
export function groupByTreatment(rows: readonly TaxBreakdownRow[] | null | undefined): TreatmentGroup[] {
  const groups = new Map<TaxTreatment, Map<string, TreatmentTax>>();

  for (const row of rows ?? []) {
    if (!isTreatment(row.treatment)) continue;
    const name = row.taxRateName || row.component?.toUpperCase() || '';
    const rate = toNumber(row.taxRate);
    const key = [row.component ?? name, name, rate].join('|');

    let taxes = groups.get(row.treatment);
    if (!taxes) {
      taxes = new Map();
      groups.set(row.treatment, taxes);
    }
    let tax = taxes.get(key);
    if (!tax) {
      tax = { key, name, component: row.component ?? null, rate, base: 0, amount: 0 };
      taxes.set(key, tax);
    }
    tax.base = money(tax.base + toNumber(row.taxableAmount));
    tax.amount = money(tax.amount + Math.abs(toNumber(row.taxAmount)));
  }

  return TAX_TREATMENT_ORDER.flatMap((treatment) => {
    const taxes = groups.get(treatment);
    if (!taxes) return [];
    const list = [...taxes.values()];
    return [{ treatment, taxes: list, total: money(list.reduce((sum, tax) => sum + tax.amount, 0)) }];
  });
}

/** What the taxes add to the subtotal and what is withheld from it: total = subtotal + added - withheld. */
export function treatmentTotals(rows: readonly TaxBreakdownRow[] | null | undefined): {
  added: number;
  withheld: number;
} {
  const groups = groupByTreatment(rows);
  return {
    added: groups.find((group) => group.treatment === 'added')?.total ?? 0,
    withheld: groups.find((group) => group.treatment === 'withheld')?.total ?? 0,
  };
}
