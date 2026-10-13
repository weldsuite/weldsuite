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

/** What the pass over the ledger entries collects. */
interface LedgerAccumulator {
  unsplitTax: number;
  /** Sales, aggregated per document, supply kind and slab rate. */
  salesAgg: Map<string, DocAgg>;
  outwardTaxable: GstOutwardTotals;
  zeroRated: GstOutwardTotals;
  nilExemptTotal: { taxableValue: number };
  /** Tax on rows that are not an invoice or credit note (journals and the like). */
  otherDocumentTax: number;
  otherDocumentRows: number;
  itcOther: GstHeads;
  itcReverse: GstHeads;
  reverseCharge: GstOutwardTotals;
}

/** A purchase row booked by the buyer (reverse charge): its tax is owed and claimed back as ITC. */
function addReverseChargeEntry(acc: LedgerAccumulator, e: GstLedgerEntry, head: GstHead | null) {
  if (countsTaxable(e.component)) acc.reverseCharge.taxableValue = round2(acc.reverseCharge.taxableValue + e.taxableAmount);
  if (head) {
    acc.reverseCharge[head] = round2(acc.reverseCharge[head] + e.taxAmount);
    acc.itcReverse[head] = round2(acc.itcReverse[head] + e.taxAmount);
  } else if (e.taxAmount !== 0) {
    acc.unsplitTax = round2(acc.unsplitTax + e.taxAmount);
  }
}

function addPurchaseEntry(acc: LedgerAccumulator, e: GstLedgerEntry) {
  const head = headOf(e.component);
  if (e.selfAssessed) {
    addReverseChargeEntry(acc, e, head);
  } else if (head) {
    acc.itcOther[head] = round2(acc.itcOther[head] + e.taxAmount);
  } else if (e.taxAmount !== 0 && e.component !== 'export') {
    acc.unsplitTax = round2(acc.unsplitTax + e.taxAmount);
  }
}

/** The GSTR-1 / 3B outward totals the supply belongs to. */
function addToSupplyTotals(acc: LedgerAccumulator, kind: SupplyKind, taxable: number, heads: GstHeads) {
  if (kind === 'taxable') addToOutward(acc.outwardTaxable, taxable, heads);
  else if (kind === 'export') addToOutward(acc.zeroRated, taxable, heads);
  else acc.nilExemptTotal.taxableValue = round2(acc.nilExemptTotal.taxableValue + taxable);
}

function addSalesEntry(acc: LedgerAccumulator, e: GstLedgerEntry, docs: Map<string, GstDocument>) {
  const kind = classify(e);
  const head = headOf(e.component);
  const heads = zeroHeads();
  if (head) heads[head] = e.taxAmount;
  else if (kind === 'taxable' && e.taxAmount !== 0) acc.unsplitTax = round2(acc.unsplitTax + e.taxAmount);
  const taxable = countsTaxable(e.component) ? e.taxableAmount : 0;

  addToSupplyTotals(acc, kind, taxable, heads);

  const isDocument = e.sourceType === 'invoice' || e.sourceType === 'credit_note';
  if (!isDocument || !e.sourceId) {
    acc.otherDocumentRows += 1;
    acc.otherDocumentTax = round2(acc.otherDocumentTax + e.taxAmount);
    return;
  }
  const slabRate = kind === 'taxable' ? slabRateOf(e) : 0;
  const key = `${e.sourceId}|${kind}|${slabRate}`;
  const agg = acc.salesAgg.get(key) ?? { doc: docs.get(e.sourceId), kind, slabRate, taxable: 0, heads: zeroHeads() };
  agg.taxable = round2(agg.taxable + taxable);
  agg.heads = addHeads(agg.heads, heads);
  acc.salesAgg.set(key, agg);
}

/** Sales: aggregate per document, supply kind and slab rate. Purchases: ITC and reverse charge. */
function aggregateEntries(entries: GstLedgerEntry[], docs: Map<string, GstDocument>): LedgerAccumulator {
  const acc: LedgerAccumulator = {
    unsplitTax: 0,
    salesAgg: new Map<string, DocAgg>(),
    outwardTaxable: newOutward(),
    zeroRated: newOutward(),
    nilExemptTotal: { taxableValue: 0 },
    otherDocumentTax: 0,
    otherDocumentRows: 0,
    itcOther: zeroHeads(),
    itcReverse: zeroHeads(),
    reverseCharge: newOutward(),
  };
  for (const e of entries) {
    if (e.direction === 'purchase') addPurchaseEntry(acc, e);
    else addSalesEntry(acc, e, docs);
  }
  return acc;
}

type GstExportRow = GstWorksheet['gstr1']['exports'][number];

/** The GSTR-1 tables as they are built, before sorting. */
interface Gstr1Tables {
  b2bByGstin: Map<string, GstB2bParty>;
  b2cLarge: GstRateLine[];
  b2cSmall: Map<string, GstB2cSmallLine>;
  exportsByDoc: Map<string, GstExportRow>;
  nilExempt: Map<'nil_rated' | 'exempt', GstNilExemptRow>;
  creditNotes: GstCreditNoteLine[];
  missingPlaceOfSupply: number;
}

/** Who the document is made out to: registered (has a GSTIN) or not, in the entity's state or another. */
interface Buyer {
  registered: boolean;
  inter: boolean;
}

function toRateLine(agg: DocAgg): GstRateLine {
  return {
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
  };
}

const nilExemptCategory = (kind: SupplyKind): 'nil_rated' | 'exempt' => (kind === 'exempt' ? 'exempt' : 'nil_rated');

/** Export value is the document total: positive on an invoice, negative on a credit note. */
function addExportAgg(exportsByDoc: Map<string, GstExportRow>, doc: GstDocument, value: number, agg: DocAgg) {
  const row = exportsByDoc.get(doc.id) ?? { documentId: doc.id, number: doc.number, date: doc.date, value, taxable: 0, igst: 0 };
  row.taxable = round2(row.taxable + agg.taxable);
  row.igst = round2(row.igst + agg.heads.igst);
  exportsByDoc.set(doc.id, row);
}

function addB2bLine(b2bByGstin: Map<string, GstB2bParty>, doc: GstDocument, agg: DocAgg) {
  const party = b2bByGstin.get(doc.gstin!) ?? { gstin: doc.gstin!, name: doc.counterpartyName, lines: [], taxable: 0, igst: 0, cgst: 0, sgst: 0 };
  const line = toRateLine(agg);
  party.lines.push(line);
  party.taxable = round2(party.taxable + line.taxable);
  party.igst = round2(party.igst + line.igst);
  party.cgst = round2(party.cgst + line.cgst);
  party.sgst = round2(party.sgst + line.sgst);
  b2bByGstin.set(doc.gstin!, party);
}

function addB2cSmallLine(b2cSmall: Map<string, GstB2cSmallLine>, doc: GstDocument, agg: DocAgg) {
  const key = `${doc.placeOfSupply ?? ''}|${agg.slabRate}`;
  const small = b2cSmall.get(key) ?? { placeOfSupply: doc.placeOfSupply, slabRate: agg.slabRate, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
  small.taxable = round2(small.taxable + agg.taxable);
  small.igst = round2(small.igst + agg.heads.igst);
  small.cgst = round2(small.cgst + agg.heads.cgst);
  small.sgst = round2(small.sgst + agg.heads.sgst);
  b2cSmall.set(key, small);
}

/** A taxable invoice: B2B by GSTIN, B2C large (inter-state, above the threshold) or B2C small. */
function addTaxableInvoiceAgg(tables: Gstr1Tables, doc: GstDocument, agg: DocAgg, buyer: Buyer) {
  if (buyer.registered) addB2bLine(tables.b2bByGstin, doc, agg);
  else if (buyer.inter && doc.total > B2C_LARGE_THRESHOLD) tables.b2cLarge.push(toRateLine(agg));
  else addB2cSmallLine(tables.b2cSmall, doc, agg);
}

function addInvoiceAgg(tables: Gstr1Tables, doc: GstDocument, agg: DocAgg, buyer: Buyer) {
  if (agg.kind === 'taxable') {
    addTaxableInvoiceAgg(tables, doc, agg, buyer);
  } else if (agg.kind === 'export') {
    addExportAgg(tables.exportsByDoc, doc, doc.total, agg);
  } else {
    addNilExempt(tables.nilExempt, nilExemptCategory(agg.kind), buyer.registered, buyer.inter, agg.taxable);
  }
}

function addCreditNoteAgg(tables: Gstr1Tables, doc: GstDocument, agg: DocAgg, buyer: Buyer) {
  if (agg.kind === 'taxable') {
    tables.creditNotes.push({ ...toRateLine(agg), gstin: doc.gstin, originalNumber: doc.originalNumber ?? null });
  } else if (agg.kind === 'export') {
    // An export credit note: reported with the exports (negative).
    addExportAgg(tables.exportsByDoc, doc, -doc.total, agg);
  } else {
    addNilExempt(tables.nilExempt, nilExemptCategory(agg.kind), buyer.registered, buyer.inter, agg.taxable);
  }
}

/** GSTR-1 tables from the per-document aggregates. */
function buildGstr1Tables(salesAgg: Map<string, DocAgg>, isInterState: (pos: string | null | undefined) => boolean): Gstr1Tables {
  const tables: Gstr1Tables = {
    b2bByGstin: new Map(),
    b2cLarge: [],
    b2cSmall: new Map(),
    exportsByDoc: new Map(),
    nilExempt: new Map(),
    creditNotes: [],
    missingPlaceOfSupply: 0,
  };
  const flaggedMissingPos = new Set<string>();

  for (const agg of salesAgg.values()) {
    const doc = agg.doc;
    if (!doc) continue;
    const buyer: Buyer = { registered: Boolean(doc.gstin), inter: isInterState(doc.placeOfSupply) };

    if (agg.kind === 'taxable' && !doc.placeOfSupply && !flaggedMissingPos.has(doc.id)) {
      flaggedMissingPos.add(doc.id);
      tables.missingPlaceOfSupply += 1;
    }

    if (doc.kind === 'credit_note') addCreditNoteAgg(tables, doc, agg, buyer);
    else addInvoiceAgg(tables, doc, agg, buyer);
  }
  return tables;
}

/** GSTR-3B 3.2: inter-state supplies to unregistered buyers, by place of supply. */
function buildInterStateUnregistered(
  salesAgg: Map<string, DocAgg>,
  isInterState: (pos: string | null | undefined) => boolean,
) {
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
  return interUnregistered;
}

/** Whether each sales document was supplied in the entity's state (CGST) or another (IGST). */
function supplyOfDocuments(entries: GstLedgerEntry[]): Map<string, 'intra' | 'inter'> {
  const supplyOfDoc = new Map<string, 'intra' | 'inter'>();
  for (const e of entries) {
    if (e.direction !== 'sales' || !e.sourceId) continue;
    if (e.component === 'igst') supplyOfDoc.set(e.sourceId, 'inter');
    else if ((e.component === 'cgst') && !supplyOfDoc.has(e.sourceId)) supplyOfDoc.set(e.sourceId, 'intra');
  }
  return supplyOfDoc;
}

/** One invoice line added to its HSN/SAC row, signed (a credit note subtracts). */
function addHsnLine(row: GstHsnRow, line: GstInvoiceLine, supply: 'intra' | 'inter' | undefined) {
  const taxable = round2(line.taxableValue * line.sign);
  const tax = round2(line.taxAmount * line.sign);
  row.quantity = round2(row.quantity + line.quantity * line.sign);
  row.taxable = round2(row.taxable + taxable);
  if (supply === 'inter') row.igst = round2(row.igst + tax);
  else if (supply === 'intra') {
    const cgst = round2((taxable * (line.slabRate / 2)) / 100);
    row.cgst = round2(row.cgst + cgst);
    row.sgst = round2(row.sgst + (tax - cgst));
  }
}

/** HSN summary (Table 12), and how many lines carry no HSN/SAC code. */
function buildHsnSummary(entries: GstLedgerEntry[], lines: GstInvoiceLine[]) {
  const supplyOfDoc = supplyOfDocuments(entries);
  const hsn = new Map<string, GstHsnRow>();
  let missingHsn = 0;
  for (const line of lines) {
    const key = `${line.hsnSac ?? ''}|${line.unit ?? ''}|${line.slabRate}`;
    const row = hsn.get(key) ?? { hsnSac: line.hsnSac, unit: line.unit, slabRate: line.slabRate, quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    addHsnLine(row, line, supplyOfDoc.get(line.documentId));
    hsn.set(key, row);
    if (!line.hsnSac) missingHsn += 1;
  }
  return { hsn, missingHsn };
}

/** GSTR-1 totals, the ITC, the liability and what is payable in cash after utilising the credit. */
function computePayment(acc: LedgerAccumulator) {
  const { outwardTaxable, zeroRated, reverseCharge } = acc;
  const gstr1Totals: GstOutwardTotals = newOutward();
  addToOutward(gstr1Totals, outwardTaxable.taxableValue, outwardTaxable);
  addToOutward(gstr1Totals, zeroRated.taxableValue, zeroRated);
  addToOutward(gstr1Totals, acc.nilExemptTotal.taxableValue, zeroHeads());

  const itcTotal = addHeads(acc.itcOther, acc.itcReverse);
  const liability = addHeads(
    { igst: outwardTaxable.igst, cgst: outwardTaxable.cgst, sgst: outwardTaxable.sgst, cess: outwardTaxable.cess },
    { igst: zeroRated.igst, cgst: zeroRated.cgst, sgst: zeroRated.sgst, cess: zeroRated.cess },
  );
  const reverseLiability: GstHeads = { igst: reverseCharge.igst, cgst: reverseCharge.cgst, sgst: reverseCharge.sgst, cess: reverseCharge.cess };
  // Only the credit on forward-charge supplies pays forward-charge tax; the RCM credit
  // becomes available once the RCM tax is paid in cash, so it counts in the same pool.
  const utilisation = utiliseItc(liability, itcTotal);
  const netPayable = addHeads(utilisation.cash, reverseLiability);
  return { gstr1Totals, itcTotal, liability, reverseLiability, utilisation, netPayable };
}

function buildWarnings(counts: {
  unsplitTax: number;
  missingHsn: number;
  missingPlaceOfSupply: number;
  otherDocumentRows: number;
  otherDocumentTax: number;
}): GstWarning[] {
  const warnings: GstWarning[] = [];
  if (counts.unsplitTax !== 0) warnings.push({ code: 'unsplit_tax', count: 1, amount: counts.unsplitTax });
  if (counts.missingHsn > 0) warnings.push({ code: 'missing_hsn', count: counts.missingHsn });
  if (counts.missingPlaceOfSupply > 0) warnings.push({ code: 'missing_place_of_supply', count: counts.missingPlaceOfSupply });
  if (counts.otherDocumentRows > 0) {
    warnings.push({ code: 'tax_on_other_documents', count: counts.otherDocumentRows, amount: counts.otherDocumentTax });
  }
  return warnings;
}

const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
const byPlaceOfSupply = (a: { placeOfSupply: string | null }, b: { placeOfSupply: string | null }) =>
  (a.placeOfSupply ?? '').localeCompare(b.placeOfSupply ?? '');

/** The GSTR-1 tables, sorted the way the worksheet lists them. */
function sortedGstr1Tables(tables: Gstr1Tables): Omit<GstWorksheet['gstr1'], 'hsn' | 'totals'> {
  const b2b = [...tables.b2bByGstin.values()].sort((a, b) => a.gstin.localeCompare(b.gstin));
  for (const party of b2b) party.lines.sort((a, b) => byDate(a, b) || a.number.localeCompare(b.number));
  return {
    b2b,
    b2cLarge: tables.b2cLarge.sort(byDate),
    b2cSmall: [...tables.b2cSmall.values()].sort((a, b) => byPlaceOfSupply(a, b) || a.slabRate - b.slabRate),
    exports: [...tables.exportsByDoc.values()].sort(byDate),
    nilExempt: [...tables.nilExempt.values()],
    creditNotes: tables.creditNotes.sort(byDate),
  };
}

export function computeGstWorksheet(input: GstWorksheetInput): GstWorksheet {
  const { entityStateCode } = input;
  const docs = new Map(input.documents.map((d) => [d.id, d]));
  const isInterState = (pos: string | null | undefined): boolean =>
    Boolean(pos && entityStateCode && pos !== entityStateCode);

  const acc = aggregateEntries(input.entries, docs);
  const tables = buildGstr1Tables(acc.salesAgg, isInterState);
  const interUnregistered = buildInterStateUnregistered(acc.salesAgg, isInterState);
  const { hsn, missingHsn } = buildHsnSummary(input.entries, input.lines);
  const { gstr1Totals, itcTotal, liability, reverseLiability, utilisation, netPayable } = computePayment(acc);
  const warnings = buildWarnings({
    unsplitTax: acc.unsplitTax,
    missingHsn,
    missingPlaceOfSupply: tables.missingPlaceOfSupply,
    otherDocumentRows: acc.otherDocumentRows,
    otherDocumentTax: acc.otherDocumentTax,
  });

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    entityStateCode,
    gstr1: {
      ...sortedGstr1Tables(tables),
      hsn: [...hsn.values()].sort((a, b) => (a.hsnSac ?? '').localeCompare(b.hsnSac ?? '') || a.slabRate - b.slabRate),
      totals: gstr1Totals,
    },
    gstr3b: {
      outwardTaxable: acc.outwardTaxable,
      zeroRated: acc.zeroRated,
      nilExempt: acc.nilExemptTotal,
      reverseCharge: acc.reverseCharge,
      interStateUnregistered: [...interUnregistered.values()].sort(byPlaceOfSupply),
      itc: { other: acc.itcOther, reverseCharge: acc.itcReverse, total: itcTotal },
      payment: {
        liability,
        reverseChargeLiability: reverseLiability,
        itcUtilisation: utilisation,
        netPayable,
        totalNetPayable: round2(netPayable.igst + netPayable.cgst + netPayable.sgst + netPayable.cess),
      },
    },
    unsplitTax: acc.unsplitTax,
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
