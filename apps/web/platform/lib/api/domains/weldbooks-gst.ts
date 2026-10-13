/**
 * WeldBooks India GST return worksheet (GSTR-1 and GSTR-3B summary).
 *
 * `GET /api/vat-returns/gst-worksheet` works a period out from the tax ledger
 * on demand; nothing is stored and nothing is filed with the GST portal.
 * Mirrors `GstWorksheet` in `@weldsuite/books-domain/jurisdictions/in` (the
 * platform doesn't import the domain package).
 */
import { weldbooksApi } from '../weldbooks-client';

/** Tax per head; SGST includes UTGST. */
export interface GstHeads {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface GstOutwardTotals extends GstHeads {
  taxableValue: number;
}

export interface GstRateLine {
  documentId: string;
  number: string;
  date: string;
  value: number;
  placeOfSupply: string | null;
  slabRate: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
}

export interface GstB2bParty {
  gstin: string;
  name: string;
  lines: GstRateLine[];
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
}

export interface GstB2cSmallLine {
  placeOfSupply: string | null;
  slabRate: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
}

export interface GstNilExemptRow {
  category: 'nil_rated' | 'exempt';
  intraRegistered: number;
  intraUnregistered: number;
  interRegistered: number;
  interUnregistered: number;
}

export interface GstCreditNoteLine extends GstRateLine {
  gstin: string | null;
  originalNumber: string | null;
}

export interface GstHsnRow {
  hsnSac: string | null;
  unit: string | null;
  slabRate: number;
  quantity: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
}

export interface GstItcUtilisation {
  cash: GstHeads;
  carryForward: GstHeads;
  creditUsed: GstHeads;
}

export interface GstWarning {
  code: 'unsplit_tax' | 'missing_hsn' | 'missing_place_of_supply' | 'tax_on_other_documents';
  count: number;
  amount?: number;
}

export interface GstWorksheet {
  periodStart: string;
  periodEnd: string;
  entityStateCode: string | null;
  gstr1: {
    b2b: GstB2bParty[];
    b2cLarge: GstRateLine[];
    b2cSmall: GstB2cSmallLine[];
    exports: Array<{ documentId: string; number: string; date: string; value: number; taxable: number; igst: number }>;
    nilExempt: GstNilExemptRow[];
    creditNotes: GstCreditNoteLine[];
    hsn: GstHsnRow[];
    totals: GstOutwardTotals;
  };
  gstr3b: {
    outwardTaxable: GstOutwardTotals;
    zeroRated: GstOutwardTotals;
    nilExempt: { taxableValue: number };
    reverseCharge: GstOutwardTotals;
    interStateUnregistered: Array<{ placeOfSupply: string | null; taxable: number; igst: number }>;
    itc: { other: GstHeads; reverseCharge: GstHeads; total: GstHeads };
    payment: {
      liability: GstHeads;
      reverseChargeLiability: GstHeads;
      itcUtilisation: GstItcUtilisation;
      netPayable: GstHeads;
      totalNetPayable: number;
    };
  };
  unsplitTax: number;
  warnings: GstWarning[];
}

export const gstReturnApi = {
  /** The GSTR-1 / GSTR-3B summary of a period (YYYY-MM-DD dates, inclusive) for the selected entity. */
  worksheet: (periodStart: string, periodEnd: string) =>
    weldbooksApi.get<{ data: GstWorksheet }>(
      `/vat-returns/gst-worksheet?periodStart=${encodeURIComponent(periodStart)}&periodEnd=${encodeURIComponent(periodEnd)}`,
    ),
};
