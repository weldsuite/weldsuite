/**
 * India GST helpers of the document forms: the place-of-supply options and
 * the CGST / SGST / IGST rows of a tax breakdown. Nothing here calculates tax:
 * the server splits the slab (see `services/accounting-gst` in books-api) and
 * the forms show what it answers.
 */
import { IN_STATES } from '@/components/address/in-states';
import type { TaxBreakdownRow } from '@/lib/api/domains/weldbooks-sales-tax-preview';

/** Place-of-supply code of a supply outside India (an export). */
export const GST_FOREIGN_COUNTRY_CODE = '96';

/** HSN (goods) or SAC (services): 4 to 8 digits. Blank is allowed. */
export const HSN_SAC_PATTERN = /^(\d{4,8})?$/;

export function isValidHsnSac(value: string | null | undefined): boolean {
  return HSN_SAC_PATTERN.test((value ?? '').trim());
}

/** "Maharashtra (27)" for a place-of-supply code; `foreignLabel` for 96; the code itself when unknown. */
export function placeOfSupplyName(code: string | null | undefined, foreignLabel: string): string {
  if (!code) return '';
  if (code === GST_FOREIGN_COUNTRY_CODE) return foreignLabel;
  const state = IN_STATES.find((s) => s.code === code);
  return state ? `${state.name} (${state.code})` : code;
}

export interface GstSplitRow {
  key: string;
  /** cgst | sgst | utgst | igst | export, or empty for an unsplit slab. */
  component: string;
  /** Percentage of the component (9 for CGST of an 18% slab). */
  rate: number;
  taxableAmount: number;
  taxAmount: number;
}

const COMPONENT_ORDER = ['cgst', 'sgst', 'utgst', 'igst', 'export', ''];

/** The breakdown rows summed per component and rate (CGST 9%, SGST 9%, IGST 18%), in filing order. */
export function gstSplitRows(rows: readonly TaxBreakdownRow[] | null | undefined): GstSplitRow[] {
  const grouped = new Map<string, GstSplitRow>();
  for (const row of rows ?? []) {
    const component = row.component ?? '';
    const key = `${component}|${row.taxRate}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.taxableAmount = Math.round((existing.taxableAmount + row.taxableAmount) * 100) / 100;
      existing.taxAmount = Math.round((existing.taxAmount + row.taxAmount) * 100) / 100;
    } else {
      grouped.set(key, { key, component, rate: row.taxRate, taxableAmount: row.taxableAmount, taxAmount: row.taxAmount });
    }
  }
  return [...grouped.values()].sort(
    (a, b) => COMPONENT_ORDER.indexOf(a.component) - COMPONENT_ORDER.indexOf(b.component) || a.rate - b.rate,
  );
}

/** True when the breakdown carries a CGST/SGST/IGST split (a rate row without one is an unsplit slab). */
export function isGstSplit(rows: readonly TaxBreakdownRow[] | null | undefined): boolean {
  return (rows ?? []).some((row) => row.component === 'cgst' || row.component === 'igst' || row.component === 'sgst');
}
