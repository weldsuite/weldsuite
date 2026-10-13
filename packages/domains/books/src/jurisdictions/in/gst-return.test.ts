import { describe, it, expect } from 'vitest';
import {
  computeGstWorksheet,
  utiliseItc,
  type GstDocument,
  type GstLedgerEntry,
  type GstInvoiceLine,
} from './gst-return';

const heads = (igst = 0, cgst = 0, sgst = 0) => ({ igst, cgst, sgst, cess: 0 });

describe('utiliseItc', () => {
  it('pays IGST first with IGST credit, then CGST, then SGST', () => {
    const result = utiliseItc(heads(100, 500, 300), heads(1000, 0, 0));
    expect(result.cash).toEqual(heads(0, 0, 0));
    expect(result.carryForward).toEqual(heads(100, 0, 0));
    expect(result.creditUsed.igst).toBe(900);
  });

  it('lets CGST credit pay CGST then IGST, never SGST', () => {
    const result = utiliseItc(heads(300, 100, 50), heads(0, 400, 0));
    expect(result.cash).toEqual(heads(0, 0, 50));
    expect(result.carryForward).toEqual(heads(0, 0, 0));
  });

  it('does not let SGST credit pay CGST', () => {
    const result = utiliseItc(heads(0, 100, 0), heads(0, 0, 100));
    expect(result.cash).toEqual(heads(0, 100, 0));
    expect(result.carryForward).toEqual(heads(0, 0, 100));
  });

  it('applies the credit of a head against its own liability before anything else', () => {
    const result = utiliseItc(heads(900, 900, 900), heads(720, 180, 180));
    expect(result.cash).toEqual(heads(180, 720, 720));
  });
});

const doc = (over: Partial<GstDocument> & Pick<GstDocument, 'id' | 'kind' | 'number'>): GstDocument => ({
  date: '2026-04-10',
  counterpartyName: 'Customer',
  gstin: null,
  placeOfSupply: '27',
  total: 0,
  ...over,
});

const row = (over: Partial<GstLedgerEntry> & Pick<GstLedgerEntry, 'sourceId' | 'component' | 'rate' | 'taxableAmount' | 'taxAmount'>): GstLedgerEntry => ({
  sourceType: 'invoice',
  direction: 'sales',
  taxCategoryCode: 'standard',
  selfAssessed: false,
  ...over,
});

describe('computeGstWorksheet', () => {
  const documents: GstDocument[] = [
    doc({ id: 'inv1', kind: 'invoice', number: 'INV-1', counterpartyName: 'Mumbai Ltd', gstin: '27AAPFU0939F1ZV', placeOfSupply: '27', total: 11800 }),
    doc({ id: 'inv2', kind: 'invoice', number: 'INV-2', counterpartyName: 'Bengaluru Ltd', gstin: '29AABCU9603R1ZJ', placeOfSupply: '29', total: 5900 }),
    doc({ id: 'inv3', kind: 'invoice', number: 'INV-3', placeOfSupply: '29', total: 354000 }),
    doc({ id: 'inv4', kind: 'invoice', number: 'INV-4', placeOfSupply: '27', total: 1180 }),
    doc({ id: 'inv5', kind: 'invoice', number: 'INV-5', counterpartyName: 'ACME Inc', placeOfSupply: '96', total: 2000 }),
    doc({ id: 'cn1', kind: 'credit_note', number: 'CN-1', counterpartyName: 'Mumbai Ltd', gstin: '27AAPFU0939F1ZV', placeOfSupply: '27', total: 1180, originalNumber: 'INV-1' }),
    doc({ id: 'inv6', kind: 'invoice', number: 'INV-6', placeOfSupply: '27', total: 500 }),
  ];

  const entries: GstLedgerEntry[] = [
    // INV-1: intra-state B2B, 18% = CGST 9 + SGST 9
    row({ sourceId: 'inv1', component: 'cgst', rate: 9, taxableAmount: 10000, taxAmount: 900 }),
    row({ sourceId: 'inv1', component: 'sgst', rate: 9, taxableAmount: 10000, taxAmount: 900 }),
    // INV-2: inter-state B2B, IGST 18
    row({ sourceId: 'inv2', component: 'igst', rate: 18, taxableAmount: 5000, taxAmount: 900 }),
    // INV-3: inter-state B2C over 2.5 lakh
    row({ sourceId: 'inv3', component: 'igst', rate: 18, taxableAmount: 300000, taxAmount: 54000 }),
    // INV-4: small intra-state B2C
    row({ sourceId: 'inv4', component: 'cgst', rate: 9, taxableAmount: 1000, taxAmount: 90 }),
    row({ sourceId: 'inv4', component: 'sgst', rate: 9, taxableAmount: 1000, taxAmount: 90 }),
    // INV-5: export
    row({ sourceId: 'inv5', component: 'export', rate: 0, taxableAmount: 2000, taxAmount: 0, taxCategoryCode: 'export_goods' }),
    // INV-6: exempt supply to an unregistered buyer
    row({ sourceId: 'inv6', component: null, rate: 0, taxableAmount: 500, taxAmount: 0, taxCategoryCode: 'exempt' }),
    // CN-1: credit note against INV-1 for 1000
    row({ sourceType: 'credit_note', sourceId: 'cn1', component: 'cgst', rate: 9, taxableAmount: -1000, taxAmount: -90 }),
    row({ sourceType: 'credit_note', sourceId: 'cn1', component: 'sgst', rate: 9, taxableAmount: -1000, taxAmount: -90 }),
    // purchases: IGST bill and an intra-state bill
    row({ sourceType: 'bill', sourceId: 'bill1', direction: 'purchase', component: 'igst', rate: 18, taxableAmount: 4000, taxAmount: 720 }),
    row({ sourceType: 'bill', sourceId: 'bill2', direction: 'purchase', component: 'cgst', rate: 9, taxableAmount: 2000, taxAmount: 180 }),
    row({ sourceType: 'bill', sourceId: 'bill2', direction: 'purchase', component: 'sgst', rate: 9, taxableAmount: 2000, taxAmount: 180 }),
  ];

  const lines: GstInvoiceLine[] = [
    { documentId: 'inv1', sign: 1, hsnSac: '998313', unit: null, quantity: 1, taxableValue: 10000, taxAmount: 1800, slabRate: 18 },
    { documentId: 'inv2', sign: 1, hsnSac: '998313', unit: null, quantity: 2, taxableValue: 5000, taxAmount: 900, slabRate: 18 },
    { documentId: 'inv4', sign: 1, hsnSac: null, unit: 'NOS', quantity: 4, taxableValue: 1000, taxAmount: 180, slabRate: 18 },
    { documentId: 'cn1', sign: -1, hsnSac: '998313', unit: null, quantity: 1, taxableValue: 1000, taxAmount: 180, slabRate: 18 },
  ];

  const sheet = computeGstWorksheet({
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    entityStateCode: '27',
    entries,
    documents,
    lines,
  });

  it('lists registered buyers by GSTIN with the combined slab rate', () => {
    expect(sheet.gstr1.b2b.map((p) => p.gstin)).toEqual(['27AAPFU0939F1ZV', '29AABCU9603R1ZJ']);
    const mumbai = sheet.gstr1.b2b[0];
    expect(mumbai.lines).toHaveLength(1);
    expect(mumbai.lines[0]).toMatchObject({ slabRate: 18, taxable: 10000, cgst: 900, sgst: 900, igst: 0, placeOfSupply: '27' });
    const bengaluru = sheet.gstr1.b2b[1];
    expect(bengaluru.lines[0]).toMatchObject({ slabRate: 18, taxable: 5000, igst: 900, cgst: 0, sgst: 0 });
  });

  it('puts an inter-state B2C invoice above 2.5 lakh in B2C large, the rest in B2C small', () => {
    expect(sheet.gstr1.b2cLarge.map((l) => l.number)).toEqual(['INV-3']);
    expect(sheet.gstr1.b2cSmall).toEqual([
      { placeOfSupply: '27', slabRate: 18, taxable: 1000, igst: 0, cgst: 90, sgst: 90 },
    ]);
  });

  it('reports exports, exempt supplies and credit notes', () => {
    expect(sheet.gstr1.exports).toEqual([
      { documentId: 'inv5', number: 'INV-5', date: '2026-04-10', value: 2000, taxable: 2000, igst: 0 },
    ]);
    expect(sheet.gstr1.nilExempt).toEqual([
      { category: 'exempt', intraRegistered: 0, intraUnregistered: 500, interRegistered: 0, interUnregistered: 0 },
    ]);
    expect(sheet.gstr1.creditNotes).toHaveLength(1);
    expect(sheet.gstr1.creditNotes[0]).toMatchObject({ number: 'CN-1', gstin: '27AAPFU0939F1ZV', originalNumber: 'INV-1', taxable: -1000, cgst: -90, sgst: -90 });
  });

  it('counts the taxable value once although CGST and SGST rows both carry it', () => {
    expect(sheet.gstr3b.outwardTaxable.taxableValue).toBe(315000);
    expect(sheet.gstr3b.outwardTaxable.cgst).toBe(900);
    expect(sheet.gstr3b.outwardTaxable.sgst).toBe(900);
    expect(sheet.gstr3b.outwardTaxable.igst).toBe(54900);
    expect(sheet.gstr3b.zeroRated.taxableValue).toBe(2000);
    expect(sheet.gstr3b.nilExempt.taxableValue).toBe(500);
  });

  it('lists inter-state supplies to unregistered buyers by place of supply', () => {
    expect(sheet.gstr3b.interStateUnregistered).toEqual([{ placeOfSupply: '29', taxable: 300000, igst: 54000 }]);
  });

  it('computes input tax credit per head from the bills', () => {
    expect(sheet.gstr3b.itc.total).toEqual(heads(720, 180, 180));
  });

  it('computes the net payable per head after the ITC utilisation order', () => {
    const { payment } = sheet.gstr3b;
    expect(payment.liability).toEqual(heads(54900, 900, 900));
    expect(payment.netPayable).toEqual(heads(54180, 720, 720));
    expect(payment.totalNetPayable).toBe(55620);
  });

  it('adds the reverse-charge tax in cash on top of the ITC-settled liability', () => {
    const withRcm = computeGstWorksheet({
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      entityStateCode: '27',
      entries: [
        row({ sourceType: 'bill', sourceId: 'b', direction: 'purchase', component: 'igst', rate: 18, taxableAmount: 1000, taxAmount: 180, selfAssessed: true, taxCategoryCode: 'reverse_charge' }),
      ],
      documents: [],
      lines: [],
    });
    expect(withRcm.gstr3b.reverseCharge.igst).toBe(180);
    expect(withRcm.gstr3b.payment.reverseChargeLiability.igst).toBe(180);
    expect(withRcm.gstr3b.payment.netPayable.igst).toBe(180);
  });

  it('summarises HSN/SAC with the CGST/SGST split and flags missing codes', () => {
    const sac = sheet.gstr1.hsn.find((r) => r.hsnSac === '998313')!;
    // INV-1 (intra) + INV-2 (inter) - CN-1 (intra)
    expect(sac.taxable).toBe(14000);
    expect(sac.quantity).toBe(2);
    expect(sac.igst).toBe(900);
    expect(sac.cgst).toBe(810);
    expect(sac.sgst).toBe(810);
    expect(sheet.warnings).toContainEqual({ code: 'missing_hsn', count: 1 });
  });

  it('flags tax booked without a CGST/SGST/IGST split instead of guessing a head', () => {
    const unsplit = computeGstWorksheet({
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      entityStateCode: '27',
      entries: [row({ sourceId: 'x', component: null, rate: 18, taxableAmount: 1000, taxAmount: 180 })],
      documents: [doc({ id: 'x', kind: 'invoice', number: 'INV-X', placeOfSupply: null, total: 1180 })],
      lines: [],
    });
    expect(unsplit.unsplitTax).toBe(180);
    expect(unsplit.gstr3b.outwardTaxable).toMatchObject({ taxableValue: 1000, igst: 0, cgst: 0, sgst: 0 });
    expect(unsplit.warnings).toContainEqual({ code: 'unsplit_tax', count: 1, amount: 180 });
    expect(unsplit.warnings).toContainEqual({ code: 'missing_place_of_supply', count: 1 });
  });

  it('folds UTGST into the SGST head', () => {
    const ut = computeGstWorksheet({
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      entityStateCode: '04',
      entries: [
        row({ sourceId: 'u', component: 'cgst', rate: 9, taxableAmount: 100, taxAmount: 9 }),
        row({ sourceId: 'u', component: 'utgst', rate: 9, taxableAmount: 100, taxAmount: 9 }),
      ],
      documents: [doc({ id: 'u', kind: 'invoice', number: 'INV-U', placeOfSupply: '04', total: 118 })],
      lines: [],
    });
    expect(ut.gstr3b.outwardTaxable).toMatchObject({ taxableValue: 100, cgst: 9, sgst: 9 });
  });
});
