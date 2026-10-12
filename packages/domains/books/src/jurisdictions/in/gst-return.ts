import type { Entity } from '@weldsuite/db/schema';
import type { TaxReturnArtifact, TaxReturnLine } from '../types';

/**
 * India GST return worksheet: a GSTR-1 (outward supplies) and GSTR-3B (summary
 * return) summary computed from the tax ledger. It is a working paper to
 * reconcile against the GST portal, not a GSTN filing: nothing here is in the
 * portal's JSON schema and nothing is submitted.
 *
 * Input rows are the tax-ledger lines (`tax_lines`, base currency, signed:
 * credit notes carry negative amounts) of the period, plus the documents they
 * came from and the invoice lines with their HSN/SAC codes. The computation is
 * pure so it can be tested without a database.
 *
 * Reading the ledger:
 * - a split slab has one row per component (CGST 9%, SGST 9%, or IGST 18%).
 *   Every row repeats the taxable value, so it is counted once, from the CGST,
 *   IGST or unsplit row; the SGST/UTGST row only adds its tax.
 * - the rate reported is the combined slab rate (CGST 9% + SGST 9% = 18%).
 * - rows booked at a slab rate with no component (a supply whose place of
 *   supply was unknown) are kept apart as `unsplitTax` and flagged, never
 *   guessed into a head.
 */

export type GstHead = 'igst' | 'cgst' | 'sgst' | 'cess';

/** Tax per head. SGST includes UTGST (one ledger account until dedicated UTGST roles exist). */
export interface GstHeads {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface GstLedgerEntry {
  /** invoice | credit_note | bill | bill_credit_note | journal | ... */
  sourceType: string;
  sourceId: string | null;
  direction: 'sales' | 'purchase';
  /** cgst | sgst | utgst | igst | export, or null for an unsplit slab, zero-rated, exempt. */
  component: string | null;
  /** The row's own rate: half the slab for CGST/SGST/UTGST. */
  rate: number;
  taxCategoryCode: string | null;
  selfAssessed: boolean;
  /** Signed, base currency. */
  taxableAmount: number;
  taxAmount: number;
}

export interface GstDocument {
  id: string;
  kind: 'invoice' | 'credit_note' | 'bill' | 'bill_credit_note';
  number: string;
  date: string;
  counterpartyName: string;
  /** Buyer's GSTIN on a sale, supplier's on a purchase; null when unregistered. */
  gstin: string | null;
  /** Two-digit state code the supply is made in (96 = outside India). Null when not recorded. */
  placeOfSupply: string | null;
  /** Document total in base currency, positive. */
  total: number;
  /** A credit note: the number of the invoice it credits. */
  originalNumber?: string | null;
}

export interface GstInvoiceLine {
  documentId: string;
  /** 1 on an invoice, -1 on a credit note. */
  sign: 1 | -1;
  hsnSac: string | null;
  unit: string | null;
  quantity: number;
  taxableValue: number;
  taxAmount: number;
  /** Combined slab rate (18, not 9). */
  slabRate: number;
}

export interface GstWorksheetInput {
  periodStart: string;
  periodEnd: string;
  /** The entity's own two-digit state code. */
  entityStateCode: string | null;
  entries: GstLedgerEntry[];
  documents: GstDocument[];
  lines: GstInvoiceLine[];
}

export interface GstRateLine {
  documentId: string;
  number: string;
  date: string;
  /** Invoice value. */
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

export interface GstOutwardTotals extends GstHeads {
  taxableValue: number;
}

export interface GstItcUtilisation {
  /** What the liability per head is after each credit has been applied. */
  cash: GstHeads;
  /** Credit left per head, carried forward. */
  carryForward: GstHeads;
  /** Credit used per head, summed over the heads it paid. */
  creditUsed: GstHeads;
}

export interface GstWarning {
  code: 'unsplit_tax' | 'missing_hsn' | 'missing_place_of_supply' | 'tax_on_other_documents';
  /** How many documents / lines, or the amount for `unsplit_tax`. */
  count: number;
  amount?: number;
}

export interface GstWorksheet {
  periodStart: string;
  periodEnd: string;
  entityStateCode: string | null;
  gstr1: {
    /** Table 4: supplies to registered buyers, by GSTIN. */
    b2b: GstB2bParty[];
    /** Table 5: inter-state supplies to unregistered buyers with an invoice value above 2.5 lakh. */
    b2cLarge: GstRateLine[];
    /** Table 7: the other supplies to unregistered buyers, by place of supply and rate. */
    b2cSmall: GstB2cSmallLine[];
    /** Table 6A: exports (zero-rated). */
    exports: Array<{ documentId: string; number: string; date: string; value: number; taxable: number; igst: number }>;
    /** Table 8: nil-rated and exempt supplies. */
    nilExempt: GstNilExemptRow[];
    /** Table 9B: credit notes issued in the period (negative amounts). */
    creditNotes: GstCreditNoteLine[];
    /** Table 12: HSN/SAC summary. */
    hsn: GstHsnRow[];
    totals: GstOutwardTotals;
  };
  gstr3b: {
    /** 3.1(a): outward taxable supplies other than zero-rated, nil-rated and exempt. */
    outwardTaxable: GstOutwardTotals;
    /** 3.1(b): zero-rated supplies (exports). */
    zeroRated: GstOutwardTotals;
    /** 3.1(c): nil-rated and exempt outward supplies. */
    nilExempt: { taxableValue: number };
    /** 3.1(d): inward supplies liable to reverse charge. */
    reverseCharge: GstOutwardTotals;
    /** 3.2: inter-state supplies to unregistered buyers, by place of supply. */
    interStateUnregistered: Array<{ placeOfSupply: string | null; taxable: number; igst: number }>;
    /** 4: input tax credit. */
    itc: {
      /** 4A(5): all other ITC, net of credit notes received. */
      other: GstHeads;
      /** 4A(3): ITC on inward supplies liable to reverse charge. */
      reverseCharge: GstHeads;
      total: GstHeads;
    };
    /** 6.1: tax payable, ITC utilised, net cash payable per head. */
    payment: {
      /** Tax on outward supplies (3.1(a) and (b)): paid from ITC or cash. */
      liability: GstHeads;
      /** Reverse-charge tax (3.1(d)): payable in cash only. */
      reverseChargeLiability: GstHeads;
      itcUtilisation: GstItcUtilisation;
      /** Cash payable per head: what ITC could not cover, plus the reverse-charge tax. */
      netPayable: GstHeads;
      totalNetPayable: number;
    };
  };
  /** Tax booked at a slab rate without a CGST/SGST/IGST split (place of supply was unknown). */
  unsplitTax: number;
  warnings: GstWarning[];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const zeroHeads = (): GstHeads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });

const addHeads = (a: GstHeads, b: GstHeads): GstHeads => ({
  igst: round2(a.igst + b.igst),
  cgst: round2(a.cgst + b.cgst),
  sgst: round2(a.sgst + b.sgst),
  cess: round2(a.cess + b.cess),
});

const headOf = (component: string | null): GstHead | null => {
  if (component === 'igst') return 'igst';
  if (component === 'cgst') return 'cgst';
  if (component === 'sgst' || component === 'utgst') return 'sgst';
  return null;
};

/** The ledger repeats the taxable value on each component row; count it on one. */
const countsTaxable = (component: string | null): boolean => component !== 'sgst' && component !== 'utgst';

const slabRateOf = (e: GstLedgerEntry): number =>
  e.component === 'cgst' || e.component === 'sgst' || e.component === 'utgst' ? round2(e.rate * 2) : e.rate;

type SupplyKind = 'taxable' | 'export' | 'exempt' | 'nil';

function classify(e: GstLedgerEntry): SupplyKind {
  if (e.component === 'export' || e.taxCategoryCode === 'export_goods') return 'export';
  if (e.taxCategoryCode === 'exempt') return 'exempt';
  if (e.taxCategoryCode === 'zero' || (e.rate === 0 && e.component === null && e.taxCategoryCode !== 'reverse_charge')) {
    return 'nil';
  }
  return 'taxable';
}

/** B2C invoices above this value that are inter-state go in Table 5 (B2C Large). */
const B2C_LARGE_THRESHOLD = 250_000;

/** Tax paid per head from the credit of each head, in the order the CGST Act allows (sections 49A and 49B). */
export function utiliseItc(liabilityIn: GstHeads, creditIn: GstHeads): GstItcUtilisation {
  const liability = {
    igst: Math.max(0, liabilityIn.igst),
    cgst: Math.max(0, liabilityIn.cgst),
    sgst: Math.max(0, liabilityIn.sgst),
  };
  const credit = {
    igst: Math.max(0, creditIn.igst),
    cgst: Math.max(0, creditIn.cgst),
    sgst: Math.max(0, creditIn.sgst),
  };
  const used = { igst: 0, cgst: 0, sgst: 0 };

  const pay = (from: 'igst' | 'cgst' | 'sgst', to: 'igst' | 'cgst' | 'sgst') => {
    const amount = Math.min(credit[from], liability[to]);
    credit[from] = round2(credit[from] - amount);
    liability[to] = round2(liability[to] - amount);
    used[from] = round2(used[from] + amount);
  };

  // IGST credit first against IGST, then CGST, then SGST; CGST credit against CGST, then IGST; SGST against SGST, then IGST.
  pay('igst', 'igst');
  pay('igst', 'cgst');
  pay('igst', 'sgst');
  pay('cgst', 'cgst');
  pay('cgst', 'igst');
  pay('sgst', 'sgst');
  pay('sgst', 'igst');

  return {
    cash: { ...liability, cess: 0 },
    carryForward: { ...credit, cess: 0 },
    creditUsed: { ...used, cess: 0 },
  };
}

interface DocAgg {
  doc: GstDocument | undefined;
  kind: SupplyKind;
  slabRate: number;
  taxable: number;
  heads: GstHeads;
}

function newOutward(): GstOutwardTotals {
  return { taxableValue: 0, ...zeroHeads() };
}

function addToOutward(t: GstOutwardTotals, taxable: number, heads: GstHeads) {
  t.taxableValue = round2(t.taxableValue + taxable);
  t.igst = round2(t.igst + heads.igst);
  t.cgst = round2(t.cgst + heads.cgst);
  t.sgst = round2(t.sgst + heads.sgst);
  t.cess = round2(t.cess + heads.cess);
}

// ---------------------------------------------------------------------------
// the worksheet
// ---------------------------------------------------------------------------

export function computeGstWorksheet(input: GstWorksheetInput): GstWorksheet {
  const { entityStateCode } = input;
  const docs = new Map(input.documents.map((d) => [d.id, d]));
  const isInterState = (pos: string | null | undefined): boolean =>
    Boolean(pos && entityStateCode && pos !== entityStateCode);

  let unsplitTax = 0;

  // ---- sales: aggregate per document, supply kind and slab rate
  const salesAgg = new Map<string, DocAgg>();
  const outwardTaxable = newOutward();
  const zeroRated = newOutward();
  const nilExemptTotal = { taxableValue: 0 };
  let otherDocumentTax = 0;
  let otherDocumentRows = 0;

  // ---- purchases
  const itcOther = zeroHeads();
  const itcReverse = zeroHeads();
  const reverseCharge = newOutward();

  for (const e of input.entries) {
    if (e.direction === 'purchase') {
      const head = headOf(e.component);
      if (e.selfAssessed) {
        if (countsTaxable(e.component)) reverseCharge.taxableValue = round2(reverseCharge.taxableValue + e.taxableAmount);
        if (head) {
          reverseCharge[head] = round2(reverseCharge[head] + e.taxAmount);
          itcReverse[head] = round2(itcReverse[head] + e.taxAmount);
        } else if (e.taxAmount !== 0) {
          unsplitTax = round2(unsplitTax + e.taxAmount);
        }
      } else if (head) {
        itcOther[head] = round2(itcOther[head] + e.taxAmount);
      } else if (e.taxAmount !== 0 && e.component !== 'export') {
        unsplitTax = round2(unsplitTax + e.taxAmount);
      }
      continue;
    }

    // sales
    const kind = classify(e);
    const head = headOf(e.component);
    const heads = zeroHeads();
    if (head) heads[head] = e.taxAmount;
    else if (kind === 'taxable' && e.taxAmount !== 0) unsplitTax = round2(unsplitTax + e.taxAmount);
    const taxable = countsTaxable(e.component) ? e.taxableAmount : 0;

    if (kind === 'taxable') addToOutward(outwardTaxable, taxable, heads);
    else if (kind === 'export') addToOutward(zeroRated, taxable, heads);
    else nilExemptTotal.taxableValue = round2(nilExemptTotal.taxableValue + taxable);

    const isDocument = e.sourceType === 'invoice' || e.sourceType === 'credit_note';
    if (!isDocument || !e.sourceId) {
      otherDocumentRows += 1;
      otherDocumentTax = round2(otherDocumentTax + e.taxAmount);
      continue;
    }
    const slabRate = kind === 'taxable' ? slabRateOf(e) : 0;
    const key = `${e.sourceId}|${kind}|${slabRate}`;
    const agg = salesAgg.get(key) ?? { doc: docs.get(e.sourceId), kind, slabRate, taxable: 0, heads: zeroHeads() };
    agg.taxable = round2(agg.taxable + taxable);
    agg.heads = addHeads(agg.heads, heads);
    salesAgg.set(key, agg);
  }

  // ---- GSTR-1 tables from the per-document aggregates
  const b2bByGstin = new Map<string, GstB2bParty>();
  const b2cLarge: GstRateLine[] = [];
  const b2cSmall = new Map<string, GstB2cSmallLine>();
  const exportsByDoc = new Map<string, { documentId: string; number: string; date: string; value: number; taxable: number; igst: number }>();
  const nilExempt = new Map<'nil_rated' | 'exempt', GstNilExemptRow>();
  const creditNotes: GstCreditNoteLine[] = [];
  let missingPlaceOfSupply = 0;
  const flaggedMissingPos = new Set<string>();

  const rateLine = (agg: DocAgg): GstRateLine => ({
    documentId: agg.doc!.id,
    number: agg.doc!.number,
    date: agg.doc!.date,
    value: agg.doc!.total,
    placeOfSupply: agg.doc!.placeOfSupply,
    slabRate: agg.slabRate,
    taxable: agg.taxable,
    igst: agg.heads.igst,
    cgst: agg.heads.cgst,
    sgst: agg.heads.sgst,
  });

  for (const agg of salesAgg.values()) {
    const doc = agg.doc;
    if (!doc) continue;
    const registered = Boolean(doc.gstin);
    const inter = isInterState(doc.placeOfSupply);

    if (agg.kind === 'taxable' && !doc.placeOfSupply && !flaggedMissingPos.has(doc.id)) {
      flaggedMissingPos.add(doc.id);
      missingPlaceOfSupply += 1;
    }

    if (doc.kind === 'credit_note') {
      if (agg.kind === 'taxable') {
        creditNotes.push({ ...rateLine(agg), gstin: doc.gstin, originalNumber: doc.originalNumber ?? null });
      } else if (agg.kind === 'export') {
        // An export credit note: reported with the exports (negative).
        const row = exportsByDoc.get(doc.id) ?? { documentId: doc.id, number: doc.number, date: doc.date, value: -doc.total, taxable: 0, igst: 0 };
        row.taxable = round2(row.taxable + agg.taxable);
        row.igst = round2(row.igst + agg.heads.igst);
        exportsByDoc.set(doc.id, row);
      } else {
        addNilExempt(nilExempt, agg.kind === 'exempt' ? 'exempt' : 'nil_rated', registered, inter, agg.taxable);
      }
      continue;
    }

    if (agg.kind === 'taxable') {
      if (registered) {
        const party = b2bByGstin.get(doc.gstin!) ?? { gstin: doc.gstin!, name: doc.counterpartyName, lines: [], taxable: 0, igst: 0, cgst: 0, sgst: 0 };
        const line = rateLine(agg);
        party.lines.push(line);
        party.taxable = round2(party.taxable + line.taxable);
        party.igst = round2(party.igst + line.igst);
        party.cgst = round2(party.cgst + line.cgst);
        party.sgst = round2(party.sgst + line.sgst);
        b2bByGstin.set(doc.gstin!, party);
      } else if (inter && doc.total > B2C_LARGE_THRESHOLD) {
        b2cLarge.push(rateLine(agg));
      } else {
        const key = `${doc.placeOfSupply ?? ''}|${agg.slabRate}`;
        const small = b2cSmall.get(key) ?? { placeOfSupply: doc.placeOfSupply, slabRate: agg.slabRate, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
        small.taxable = round2(small.taxable + agg.taxable);
        small.igst = round2(small.igst + agg.heads.igst);
        small.cgst = round2(small.cgst + agg.heads.cgst);
        small.sgst = round2(small.sgst + agg.heads.sgst);
        b2cSmall.set(key, small);
      }
    } else if (agg.kind === 'export') {
      const row = exportsByDoc.get(doc.id) ?? { documentId: doc.id, number: doc.number, date: doc.date, value: doc.total, taxable: 0, igst: 0 };
      row.taxable = round2(row.taxable + agg.taxable);
      row.igst = round2(row.igst + agg.heads.igst);
      exportsByDoc.set(doc.id, row);
    } else {
      addNilExempt(nilExempt, agg.kind === 'exempt' ? 'exempt' : 'nil_rated', registered, inter, agg.taxable);
    }
  }

  // GSTR-3B 3.2: inter-state supplies to unregistered buyers, by place of supply
  const interUnregistered = new Map<string, { placeOfSupply: string | null; taxable: number; igst: number }>();
  for (const agg of salesAgg.values()) {
    const doc = agg.doc;
    if (!doc || agg.kind !== 'taxable' || doc.gstin || !isInterState(doc.placeOfSupply)) continue;
    const key = doc.placeOfSupply ?? '';
    const row = interUnregistered.get(key) ?? { placeOfSupply: doc.placeOfSupply, taxable: 0, igst: 0 };
    row.taxable = round2(row.taxable + agg.taxable);
    row.igst = round2(row.igst + agg.heads.igst);
    interUnregistered.set(key, row);
  }

  // ---- HSN summary (Table 12)
  const supplyOfDoc = new Map<string, 'intra' | 'inter'>();
  for (const e of input.entries) {
    if (e.direction !== 'sales' || !e.sourceId) continue;
    if (e.component === 'igst') supplyOfDoc.set(e.sourceId, 'inter');
    else if ((e.component === 'cgst') && !supplyOfDoc.has(e.sourceId)) supplyOfDoc.set(e.sourceId, 'intra');
  }
  const hsn = new Map<string, GstHsnRow>();
  let missingHsn = 0;
  for (const line of input.lines) {
    const taxable = round2(line.taxableValue * line.sign);
    const tax = round2(line.taxAmount * line.sign);
    const supply = supplyOfDoc.get(line.documentId);
    const key = `${line.hsnSac ?? ''}|${line.unit ?? ''}|${line.slabRate}`;
    const row = hsn.get(key) ?? { hsnSac: line.hsnSac, unit: line.unit, slabRate: line.slabRate, quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    row.quantity = round2(row.quantity + line.quantity * line.sign);
    row.taxable = round2(row.taxable + taxable);
    if (supply === 'inter') row.igst = round2(row.igst + tax);
    else if (supply === 'intra') {
      const cgst = round2((taxable * (line.slabRate / 2)) / 100);
      row.cgst = round2(row.cgst + cgst);
      row.sgst = round2(row.sgst + (tax - cgst));
    }
    hsn.set(key, row);
    if (!line.hsnSac) missingHsn += 1;
  }

  // ---- totals
  const gstr1Totals: GstOutwardTotals = newOutward();
  addToOutward(gstr1Totals, outwardTaxable.taxableValue, outwardTaxable);
  addToOutward(gstr1Totals, zeroRated.taxableValue, zeroRated);
  addToOutward(gstr1Totals, nilExemptTotal.taxableValue, zeroHeads());

  const itcTotal = addHeads(itcOther, itcReverse);
  const liability = addHeads(
    { igst: outwardTaxable.igst, cgst: outwardTaxable.cgst, sgst: outwardTaxable.sgst, cess: outwardTaxable.cess },
    { igst: zeroRated.igst, cgst: zeroRated.cgst, sgst: zeroRated.sgst, cess: zeroRated.cess },
  );
  const reverseLiability: GstHeads = { igst: reverseCharge.igst, cgst: reverseCharge.cgst, sgst: reverseCharge.sgst, cess: reverseCharge.cess };
  // Only the credit on forward-charge supplies pays forward-charge tax; the RCM credit
  // becomes available once the RCM tax is paid in cash, so it counts in the same pool.
  const utilisation = utiliseItc(liability, itcTotal);
  const netPayable = addHeads(utilisation.cash, reverseLiability);

  const warnings: GstWarning[] = [];
  if (unsplitTax !== 0) warnings.push({ code: 'unsplit_tax', count: 1, amount: unsplitTax });
  if (missingHsn > 0) warnings.push({ code: 'missing_hsn', count: missingHsn });
  if (missingPlaceOfSupply > 0) warnings.push({ code: 'missing_place_of_supply', count: missingPlaceOfSupply });
  if (otherDocumentRows > 0) warnings.push({ code: 'tax_on_other_documents', count: otherDocumentRows, amount: otherDocumentTax });

  const byGstin = [...b2bByGstin.values()].sort((a, b) => a.gstin.localeCompare(b.gstin));
  for (const party of byGstin) party.lines.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    entityStateCode,
    gstr1: {
      b2b: byGstin,
      b2cLarge: b2cLarge.sort((a, b) => a.date.localeCompare(b.date)),
      b2cSmall: [...b2cSmall.values()].sort(
        (a, b) => (a.placeOfSupply ?? '').localeCompare(b.placeOfSupply ?? '') || a.slabRate - b.slabRate,
      ),
      exports: [...exportsByDoc.values()].sort((a, b) => a.date.localeCompare(b.date)),
      nilExempt: [...nilExempt.values()],
      creditNotes: creditNotes.sort((a, b) => a.date.localeCompare(b.date)),
      hsn: [...hsn.values()].sort((a, b) => (a.hsnSac ?? '').localeCompare(b.hsnSac ?? '') || a.slabRate - b.slabRate),
      totals: gstr1Totals,
    },
    gstr3b: {
      outwardTaxable,
      zeroRated,
      nilExempt: nilExemptTotal,
      reverseCharge,
      interStateUnregistered: [...interUnregistered.values()].sort((a, b) =>
        (a.placeOfSupply ?? '').localeCompare(b.placeOfSupply ?? ''),
      ),
      itc: { other: itcOther, reverseCharge: itcReverse, total: itcTotal },
      payment: {
        liability,
        reverseChargeLiability: reverseLiability,
        itcUtilisation: utilisation,
        netPayable,
        totalNetPayable: round2(netPayable.igst + netPayable.cgst + netPayable.sgst + netPayable.cess),
      },
    },
    unsplitTax,
    warnings,
  };
}

function addNilExempt(
  table: Map<'nil_rated' | 'exempt', GstNilExemptRow>,
  category: 'nil_rated' | 'exempt',
  registered: boolean,
  inter: boolean,
  taxable: number,
) {
  const row = table.get(category) ?? { category, intraRegistered: 0, intraUnregistered: 0, interRegistered: 0, interUnregistered: 0 };
  const field = `${inter ? 'inter' : 'intra'}${registered ? 'Registered' : 'Unregistered'}` as
    | 'intraRegistered'
    | 'intraUnregistered'
    | 'interRegistered'
    | 'interUnregistered';
  row[field] = round2(row[field] + taxable);
  table.set(category, row);
}

// ---------------------------------------------------------------------------
// adapter hook (JurisdictionAdapter.buildTaxReturn)
// ---------------------------------------------------------------------------

/**
 * JSON summary of a period's tax-ledger lines per GST head, for
 * `JurisdictionAdapter.buildTaxReturn`. The full worksheet (GSTR-1 tables,
 * ITC, net payable) comes from `computeGstWorksheet`; this keeps the adapter
 * contract for callers that only hold ledger lines.
 */
export function buildInGstReturn(
  entity: Entity,
  periodStart: string,
  periodEnd: string,
  lines: TaxReturnLine[],
): Promise<TaxReturnArtifact> {
  const summary = {
    taxableAmount: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    cess: 0,
    totalTax: 0,
  };

  for (const line of lines) {
    if (line.direction === 'purchase') continue;
    const component = line.component ?? (line.jurisdictionMetadata?.gstComponent as string | undefined);
    if (component !== 'sgst' && component !== 'utgst') summary.taxableAmount += line.taxableAmount;
    summary.totalTax += line.taxAmount;
    if (component === 'cgst') summary.cgst += line.taxAmount;
    else if (component === 'sgst' || component === 'utgst') summary.sgst += line.taxAmount;
    else if (component === 'igst') summary.igst += line.taxAmount;
    else if (component === 'cess') summary.cess += line.taxAmount;
  }

  const payload = {
    version: 'summary',
    gstin: entity.taxIdentifiers?.vatNumber ?? '',
    companyName: entity.legalName ?? entity.name,
    periodStart,
    periodEnd,
    lines: lines
      .filter((l) => l.direction !== 'purchase')
      .map((l) => ({
        taxRateId: l.taxRateId,
        taxCategoryCode: l.taxCategoryCode,
        taxableAmount: l.taxableAmount,
        taxAmount: l.taxAmount,
        gstComponent: l.component ?? l.jurisdictionMetadata?.gstComponent ?? null,
        gstSlab: l.jurisdictionMetadata?.gstSlab ?? null,
      })),
    summary,
  };

  return Promise.resolve({
    filename: `gst-summary-${periodStart}-${periodEnd}.json`,
    mimeType: 'application/json',
    content: JSON.stringify(payload, null, 2),
    summary,
  });
}
