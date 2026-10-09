/**
 * Yearly 1099-NEC / 1099-MISC computation, cash basis: what each vendor was
 * paid in a calendar year, by box, checked against the thresholds of that year.
 *
 * Rules (docs/plans/weldbooks-us.md section 8):
 * - Only payments dated in the tax year count (cash basis).
 * - Payments by credit card, debit card or a third-party network, and payments
 *   from a credit-card account, are left out: those payees get a 1099-K from
 *   the processor. The exclusion reads the payment method and the account,
 *   never keywords in the reference.
 * - Payments run through a payroll provider are left out (the provider files).
 * - A payment is spread over the lines of the bills it paid, pro rata to each
 *   line's amount including its own sales tax. Sales tax a vendor charges is
 *   part of what was paid to the vendor, so it counts for the 1099 and stays in
 *   the box of the line it belongs to; with one tax rate this equals
 *   weighting by the pre-tax amounts. Cents are split by largest remainder, so
 *   the parts add up to the payment exactly.
 * - A line's box: line override, else the account's default, else the
 *   vendor's default. `omit` at any level leaves the amount out.
 * - Corporations (C or S, also LLCs taxed as one) are left out except for
 *   legal services (NEC 1, MISC 10), medical payments (MISC 6) and tax withheld.
 * - Backup withholding on a payment goes to box 4 of the form of the box the
 *   payment landed in. Withholding on a form waives the threshold for that form.
 *
 * Amounts in and out are dollars; internally everything is whole cents.
 */

import {
  FORM_1099K_PAYMENT_METHODS,
  FORM_1099_OMIT,
  form1099Box,
  form1099Thresholds,
  isAllocatableBox,
  meetsThreshold,
  withholdingBoxFor,
  type Form1099BoxCode,
  type Form1099ThresholdOverrides,
  type Form1099ThresholdSet,
  type Form1099Type,
} from '../jurisdictions/us/form-1099';

export type VendorTinType = 'ein' | 'ssn' | 'itin';

export interface Compute1099Vendor {
  partyId: string;
  name?: string;
  is1099Vendor: boolean;
  defaultForm?: Form1099Type | null;
  /** A box code (`nec_1`), a bare box number together with `defaultForm`, or `omit`. */
  defaultBox?: string | null;
  tinType?: VendorTinType | null;
  /** Present once a TIN is on file (the full TIN is never needed here). */
  tinLast4?: string | null;
  /** W-9 line 3a as stored, e.g. `c_corporation`, `llc`, `individual`. */
  federalTaxClassification?: string | null;
  /** W-9 line 3a LLC letter (`C`, `S`, `P`) when the classification is LLC. */
  llcTaxClassification?: string | null;
  /** Law firms and attorneys keep their NEC 1 / MISC 10 reporting even when incorporated. */
  isAttorney?: boolean;
  addressComplete: boolean;
  backupWithholding?: boolean;
}

export interface Compute1099BillLine {
  id: string;
  /** Amount before tax. */
  amount: number;
  /** Sales tax charged on this line; counts as part of the payment. */
  taxAmount?: number;
  accountId?: string | null;
  /** Box override for this line; `omit` leaves it out. */
  form1099Box?: string | null;
}

export interface Compute1099Bill {
  id: string;
  lines: Compute1099BillLine[];
}

export interface Compute1099Payment {
  id: string;
  partyId: string;
  /** `YYYY-MM-DD` */
  date: string;
  /**
   * Gross amount settled with the vendor: cash paid plus any backup
   * withholding kept back (`backupWithholdingAmount`).
   */
  amount: number;
  /** check | ach | wire | credit_card | debit_card | cash | third_party_network | ... */
  paymentMethod?: string | null;
  /** The money came out of a credit-card account. */
  fromCreditCardAccount?: boolean;
  paidThroughPayroll?: boolean;
  voided?: boolean;
  backupWithholdingAmount?: number | null;
  /** How the payment was spread over bills; the rest is an unapplied payment. */
  allocations?: Array<{ billId: string; amount: number }>;
}

/** A bank line categorized straight to a vendor, without a payment record. */
export interface Compute1099BankTransaction {
  id: string;
  partyId: string;
  date: string;
  /** Money paid out to the vendor, positive. */
  amount: number;
  accountId?: string | null;
  form1099Box?: string | null;
  fromCreditCardAccount?: boolean;
  paymentMethod?: string | null;
  /** Set when a payment was matched to this line; the payment already counts. */
  matchedPaymentId?: string | null;
}

export interface Compute1099Adjustment {
  partyId: string;
  box: string;
  /** Added to the box; negative to reduce. */
  amount: number;
  reason: string;
  by?: string;
}

export interface Compute1099Input {
  taxYear: number;
  vendors: Compute1099Vendor[];
  payments: Compute1099Payment[];
  bills?: Compute1099Bill[];
  bankTransactions?: Compute1099BankTransaction[];
  /** accounts.form1099Box by account id. */
  accountBoxes?: Record<string, string | null | undefined>;
  adjustments?: Compute1099Adjustment[];
  thresholdOverrides?: Form1099ThresholdOverrides;
}

export type Form1099VendorStatus =
  | 'included'
  | 'below_threshold'
  | 'excluded_corporation'
  | 'needs_tin'
  | 'needs_address'
  | 'not_1099_vendor';

export type Form1099BoxSource = 'line' | 'account' | 'vendor' | 'transaction' | 'adjustment' | 'withholding';

export interface Form1099Contribution {
  box: Form1099BoxCode;
  amount: number;
  paymentId?: string;
  bankTransactionId?: string;
  billId?: string;
  billLineId?: string;
  /** Where the box came from. */
  boxSource: Form1099BoxSource;
  /** True for the part of a payment that was not applied to a bill. */
  unapplied?: boolean;
}

export type Form1099ExclusionReason =
  | 'card_or_network_method'
  | 'credit_card_account'
  | 'paid_through_payroll'
  | 'omitted_box';

export interface Form1099Exclusion {
  reason: Form1099ExclusionReason;
  amount: number;
  paymentId?: string;
  bankTransactionId?: string;
  billId?: string;
  billLineId?: string;
  /** The payment method that caused the exclusion. */
  paymentMethod?: string;
}

/** Money paid to a 1099 vendor that no box could be found for. */
export interface Form1099Unmapped {
  amount: number;
  paymentId?: string;
  bankTransactionId?: string;
  billId?: string;
  billLineId?: string;
  reason: 'no_box' | 'invalid_box';
}

export interface Form1099VendorResult {
  partyId: string;
  name?: string;
  status: Form1099VendorStatus;
  reasons: string[];
  /** Forms with at least one reportable box. */
  forms: Form1099Type[];
  /** Every box total before thresholds and corporation rules. */
  totals: Partial<Record<Form1099BoxCode, number>>;
  /** Boxes that go on the form: threshold met, corporation rule applied. Empty unless the vendor is reportable. */
  boxes: Partial<Record<Form1099BoxCode, number>>;
  /** At least one box total reaches its threshold, whatever the vendor's flags say. */
  aboveThreshold: boolean;
  isCorporation: boolean;
  contributions: Form1099Contribution[];
  exclusions: Form1099Exclusion[];
  unmapped: Form1099Unmapped[];
  adjustments: Array<Compute1099Adjustment & { applied: true }>;
  /** Payments and bank transactions behind the boxes, for drill-down. */
  paymentIds: string[];
  bankTransactionIds: string[];
}

export interface Compute1099Result {
  taxYear: number;
  thresholds: Form1099ThresholdSet;
  /** Vendors with activity in the year, in input order. */
  vendors: Form1099VendorResult[];
  warnings: string[];
  summary: Record<Form1099VendorStatus, number>;
}

// Cents arithmetic

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

function floorDiv(a: bigint, b: bigint): bigint {
  let q = a / b;
  if (a % b !== BigInt(0) && (a < BigInt(0)) !== (b < BigInt(0))) q -= BigInt(1);
  return q;
}

/**
 * Splits whole cents over weights, pro rata, so the parts add up to the total
 * exactly (largest remainder, ties to the earlier weight). Weights may be
 * negative (a discount line); returns null when the weights add up to zero.
 */
export function splitProRata(totalCents: number, rawWeights: number[]): number[] | null {
  const rawSum = rawWeights.reduce((acc, weight) => acc + weight, 0);
  if (rawWeights.length === 0 || rawSum === 0) return null;
  // The ratio of each weight to the sum is unchanged by flipping both signs.
  const flip = rawSum < 0 ? -1 : 1;
  const weights = rawWeights.map((weight) => weight * flip);
  const total = BigInt(totalCents);
  const denominator = BigInt(rawSum * flip);
  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  for (const weight of weights) {
    const numerator = total * BigInt(weight);
    const floor = floorDiv(numerator, denominator);
    floors.push(floor);
    remainders.push(numerator - floor * denominator);
  }
  let left = Number(total - floors.reduce((acc, part) => acc + part, BigInt(0)));
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  const parts = floors.map((part) => Number(part));
  for (const entry of order) {
    if (left <= 0) break;
    parts[entry.index] = (parts[entry.index] ?? 0) + 1;
    left -= 1;
  }
  return parts;
}

// Vendor classification

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Whether the W-9 says the vendor is taxed as a corporation. Accepts the
 * labels of W-9 line 3a in any spelling (`C Corporation`, `s_corp`, ...) and
 * LLCs that picked C or S on the LLC line.
 */
export function isCorporationClassification(
  federalTaxClassification: string | null | undefined,
  llcTaxClassification?: string | null,
): boolean {
  const federal = normalize(federalTaxClassification);
  if (!federal) return false;
  if (federal.includes('ccorp') || federal.includes('scorp') || federal === 'corporation' || federal === 'corp') return true;
  if (federal.startsWith('llc')) {
    const llc = normalize(llcTaxClassification) || federal.slice(3);
    return llc === 'c' || llc === 's' || llc.includes('ccorp') || llc.includes('scorp') || llc.startsWith('taxedasc') || llc.startsWith('taxedass');
  }
  return false;
}

/** A box code from a stored value: a full code, or a bare number combined with the vendor's default form. */
function normalizeBox(raw: string | null | undefined, form?: Form1099Type | null): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value === FORM_1099_OMIT) return FORM_1099_OMIT;
  if (/^\d+$/.test(value) && form) return `${form}_${value}`;
  return value;
}

type BoxResolution =
  | { kind: 'box'; code: Form1099BoxCode; source: Form1099BoxSource }
  | { kind: 'omit' }
  | { kind: 'none' }
  | { kind: 'invalid' };

function resolveBox(
  levels: Array<{ raw: string | null | undefined; source: Form1099BoxSource }>,
  defaultForm?: Form1099Type | null,
): BoxResolution {
  for (const level of levels) {
    const code = normalizeBox(level.raw, defaultForm);
    if (!code) continue;
    if (code === FORM_1099_OMIT) return { kind: 'omit' };
    if (!isAllocatableBox(code)) return { kind: 'invalid' };
    return { kind: 'box', code: code as Form1099BoxCode, source: level.source };
  }
  return { kind: 'none' };
}

function vendorDefaultRaw(vendor: Compute1099Vendor): string | null {
  const explicit = (vendor.defaultBox ?? '').trim();
  if (explicit) return explicit;
  // A vendor marked NEC without a box means nonemployee compensation; MISC needs an explicit box.
  return vendor.defaultForm === 'nec' ? 'nec_1' : null;
}

// Accumulators

interface Accumulator {
  vendor: Compute1099Vendor;
  totals: Map<Form1099BoxCode, number>;
  contributions: Form1099Contribution[];
  exclusions: Form1099Exclusion[];
  unmapped: Form1099Unmapped[];
  adjustments: Array<Compute1099Adjustment & { applied: true }>;
  paymentIds: Set<string>;
  bankTransactionIds: Set<string>;
}

function formOf(code: Form1099BoxCode): Form1099Type {
  return code.startsWith('nec_') ? 'nec' : 'misc';
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function addToBox(acc: Accumulator, code: Form1099BoxCode, cents: number): void {
  acc.totals.set(code, (acc.totals.get(code) ?? 0) + cents);
}

interface Part {
  cents: number;
  billId?: string;
  billLineId?: string;
  unapplied?: boolean;
  resolution: BoxResolution;
}

function inYear(date: string, taxYear: number): boolean {
  return date.startsWith(`${taxYear}-`);
}

function exclusionFor(item: {
  paymentMethod?: string | null;
  fromCreditCardAccount?: boolean;
  paidThroughPayroll?: boolean;
}): { reason: Form1099ExclusionReason; paymentMethod?: string } | null {
  const method = (item.paymentMethod ?? '').trim().toLowerCase();
  if (method && FORM_1099K_PAYMENT_METHODS.includes(method)) return { reason: 'card_or_network_method', paymentMethod: method };
  if (item.fromCreditCardAccount) return { reason: 'credit_card_account' };
  if (item.paidThroughPayroll) return { reason: 'paid_through_payroll' };
  return null;
}

/** Computes the yearly 1099 totals per vendor. */
export function compute1099Totals(input: Compute1099Input): Compute1099Result {
  const thresholds = form1099Thresholds(input.taxYear, input.thresholdOverrides);
  const warnings: string[] = [];
  const vendorsById = new Map(input.vendors.map((vendor) => [vendor.partyId, vendor]));
  const billsById = new Map((input.bills ?? []).map((bill) => [bill.id, bill]));
  const accountBoxes = input.accountBoxes ?? {};
  const accumulators = new Map<string, Accumulator>();

  const accumulatorFor = (vendor: Compute1099Vendor): Accumulator => {
    let acc = accumulators.get(vendor.partyId);
    if (!acc) {
      acc = {
        vendor,
        totals: new Map(),
        contributions: [],
        exclusions: [],
        unmapped: [],
        adjustments: [],
        paymentIds: new Set(),
        bankTransactionIds: new Set(),
      };
      accumulators.set(vendor.partyId, acc);
    }
    return acc;
  };

  const lineResolution = (
    vendor: Compute1099Vendor,
    lineBox: string | null | undefined,
    accountId: string | null | undefined,
  ): BoxResolution =>
    resolveBox(
      [
        { raw: lineBox, source: 'line' },
        { raw: accountId ? accountBoxes[accountId] : null, source: 'account' },
        { raw: vendorDefaultRaw(vendor), source: 'vendor' },
      ],
      vendor.defaultForm,
    );

  for (const payment of input.payments) {
    if (!inYear(payment.date, input.taxYear) || payment.voided) continue;
    const vendor = vendorsById.get(payment.partyId);
    if (!vendor) {
      warnings.push(`Payment ${payment.id} is to a party that is not in the vendor list.`);
      continue;
    }
    const acc = accumulatorFor(vendor);
    const gross = toCents(payment.amount);

    const excluded = exclusionFor(payment);
    if (excluded) {
      acc.exclusions.push({ ...excluded, amount: fromCents(gross), paymentId: payment.id });
      continue;
    }

    const parts: Part[] = [];
    let allocated = 0;
    for (const allocation of payment.allocations ?? []) {
      const cents = toCents(allocation.amount);
      allocated += cents;
      const bill = billsById.get(allocation.billId);
      if (!bill || bill.lines.length === 0) {
        warnings.push(`Payment ${payment.id} pays bill ${allocation.billId}, which has no lines; the amount uses the vendor default box.`);
        parts.push({ cents, billId: allocation.billId, unapplied: true, resolution: lineResolution(vendor, null, null) });
        continue;
      }
      const weights = bill.lines.map((line) => toCents(line.amount) + toCents(line.taxAmount ?? 0));
      const shares = splitProRata(cents, weights);
      if (!shares) {
        warnings.push(`Bill ${bill.id} lines add up to zero; payment ${payment.id} uses the vendor default box.`);
        parts.push({ cents, billId: bill.id, unapplied: true, resolution: lineResolution(vendor, null, null) });
        continue;
      }
      bill.lines.forEach((line, index) => {
        const share = shares[index] ?? 0;
        if (share === 0) return;
        parts.push({
          cents: share,
          billId: bill.id,
          billLineId: line.id,
          resolution: lineResolution(vendor, line.form1099Box, line.accountId),
        });
      });
    }
    const rest = gross - allocated;
    if (rest !== 0 && (allocated === 0 || rest > 0)) {
      parts.push({ cents: rest, unapplied: true, resolution: lineResolution(vendor, null, null) });
    }

    // Backup withholding is split over the parts like the payment itself.
    const withheld = toCents(payment.backupWithholdingAmount ?? 0);
    const positiveWeights = parts.map((part) => Math.max(part.cents, 0));
    const withholdingShares = withheld > 0
      ? splitProRata(withheld, positiveWeights.some((weight) => weight > 0) ? positiveWeights : parts.map(() => 1))
      : null;

    parts.forEach((part, index) => {
      const base = {
        paymentId: payment.id,
        billId: part.billId,
        billLineId: part.billLineId,
      };
      const resolution = part.resolution;
      const withholdingShare = withholdingShares?.[index] ?? 0;
      if (resolution.kind === 'omit') {
        acc.exclusions.push({ ...base, reason: 'omitted_box', amount: fromCents(part.cents) });
        if (withholdingShare > 0) warnings.push(`Backup withholding of ${money(withholdingShare)} on payment ${payment.id} was on an amount left out of 1099 reporting.`);
        return;
      }
      if (resolution.kind !== 'box') {
        acc.unmapped.push({ ...base, amount: fromCents(part.cents), reason: resolution.kind === 'invalid' ? 'invalid_box' : 'no_box' });
        if (withholdingShare > 0) warnings.push(`Backup withholding of ${money(withholdingShare)} on payment ${payment.id} could not be assigned to a form.`);
        return;
      }
      acc.paymentIds.add(payment.id);
      addToBox(acc, resolution.code, part.cents);
      acc.contributions.push({
        ...base,
        box: resolution.code,
        amount: fromCents(part.cents),
        boxSource: resolution.source,
        unapplied: part.unapplied,
      });
      if (withholdingShare > 0) {
        const withholdingBox = withholdingBoxFor(formOf(resolution.code));
        addToBox(acc, withholdingBox, withholdingShare);
        acc.contributions.push({ ...base, box: withholdingBox, amount: fromCents(withholdingShare), boxSource: 'withholding' });
      }
    });
  }

  for (const txn of input.bankTransactions ?? []) {
    if (!inYear(txn.date, input.taxYear) || txn.matchedPaymentId) continue;
    const vendor = vendorsById.get(txn.partyId);
    if (!vendor) {
      warnings.push(`Bank transaction ${txn.id} is categorized to a party that is not in the vendor list.`);
      continue;
    }
    const acc = accumulatorFor(vendor);
    const cents = toCents(txn.amount);
    const excluded = exclusionFor(txn);
    if (excluded) {
      acc.exclusions.push({ ...excluded, amount: fromCents(cents), bankTransactionId: txn.id });
      continue;
    }
    const resolution = lineResolution(vendor, txn.form1099Box, txn.accountId);
    if (resolution.kind === 'omit') {
      acc.exclusions.push({ reason: 'omitted_box', amount: fromCents(cents), bankTransactionId: txn.id });
    } else if (resolution.kind !== 'box') {
      acc.unmapped.push({ amount: fromCents(cents), bankTransactionId: txn.id, reason: resolution.kind === 'invalid' ? 'invalid_box' : 'no_box' });
    } else {
      acc.bankTransactionIds.add(txn.id);
      addToBox(acc, resolution.code, cents);
      acc.contributions.push({
        box: resolution.code,
        amount: fromCents(cents),
        bankTransactionId: txn.id,
        boxSource: resolution.source === 'line' ? 'transaction' : resolution.source,
      });
    }
  }

  for (const adjustment of input.adjustments ?? []) {
    const vendor = vendorsById.get(adjustment.partyId);
    const def = form1099Box(adjustment.box);
    if (!vendor) {
      warnings.push(`Adjustment for ${adjustment.partyId} ignored: the party is not in the vendor list.`);
      continue;
    }
    if (!def || def.kind !== 'amount') {
      warnings.push(`Adjustment for ${adjustment.partyId} ignored: ${adjustment.box} is not an amount box.`);
      continue;
    }
    if (!adjustment.reason.trim()) {
      warnings.push(`Adjustment for ${adjustment.partyId} ignored: a reason is required.`);
      continue;
    }
    const acc = accumulatorFor(vendor);
    const cents = toCents(adjustment.amount);
    addToBox(acc, def.code, cents);
    acc.adjustments.push({ ...adjustment, applied: true });
    acc.contributions.push({ box: def.code, amount: fromCents(cents), boxSource: 'adjustment' });
  }

  const results = [...new Set(input.vendors.map((vendor) => vendor.partyId))]
    .map((partyId) => accumulators.get(partyId))
    .filter((acc): acc is Accumulator => acc !== undefined)
    .map((acc) => finish(acc, thresholds));
  const summary: Record<Form1099VendorStatus, number> = {
    included: 0,
    below_threshold: 0,
    excluded_corporation: 0,
    needs_tin: 0,
    needs_address: 0,
    not_1099_vendor: 0,
  };
  for (const result of results) summary[result.status] += 1;
  return { taxYear: input.taxYear, thresholds, vendors: results, warnings, summary };
}

function finish(acc: Accumulator, thresholds: Form1099ThresholdSet): Form1099VendorResult {
  const { vendor } = acc;
  const isCorporation = isCorporationClassification(vendor.federalTaxClassification, vendor.llcTaxClassification);
  const reasons: string[] = [];

  const totals: Partial<Record<Form1099BoxCode, number>> = {};
  for (const [code, cents] of acc.totals) totals[code] = fromCents(cents);

  // Withholding on a form waives the threshold for that form's amounts.
  const withheldForms = new Set<Form1099Type>();
  for (const form of ['nec', 'misc'] as const) {
    if ((acc.totals.get(withholdingBoxFor(form)) ?? 0) > 0) withheldForms.add(form);
  }

  const reportable: Partial<Record<Form1099BoxCode, number>> = {};
  let anyAboveThreshold = false;
  let anyMetBeforeCorporation = false;
  const belowNotes: string[] = [];
  const corpNotes: string[] = [];

  for (const [code, cents] of acc.totals) {
    const def = form1099Box(code);
    if (!def || def.kind !== 'amount' || cents <= 0) continue;
    const threshold = thresholds.boxes[code];
    const meets = meetsThreshold(fromCents(cents), threshold);
    if (meets) anyAboveThreshold = true;
    const waived = !meets && withheldForms.has(def.form) && def.code !== withholdingBoxFor(def.form);
    if (!meets && !waived) {
      if (threshold !== null && threshold !== undefined) {
        belowNotes.push(`${def.form.toUpperCase()} box ${def.number} total ${money(cents)} is below the ${money(toCents(threshold))} threshold for ${thresholds.taxYear}.`);
      }
      continue;
    }
    anyMetBeforeCorporation = true;
    const corporationOk =
      !isCorporation || def.corporation === 'always' || (def.corporation === 'attorney' && Boolean(vendor.isAttorney));
    if (!corporationOk) {
      corpNotes.push(`${def.form.toUpperCase()} box ${def.number} is paid to a corporation and is not reportable.`);
      continue;
    }
    reportable[code] = fromCents(cents);
  }

  const reportableCodes = Object.keys(reportable) as Form1099BoxCode[];
  const forms = (['nec', 'misc'] as const).filter((form) => reportableCodes.some((code) => formOf(code) === form));

  let status: Form1099VendorStatus;
  if (!vendor.is1099Vendor) {
    status = 'not_1099_vendor';
    reasons.push('The vendor is not marked as a 1099 vendor.');
    if (anyAboveThreshold) reasons.push('Payments reach the reporting threshold; mark the vendor as a 1099 vendor if a form is needed.');
  } else if (!anyMetBeforeCorporation) {
    status = 'below_threshold';
    reasons.push(...belowNotes);
    if (belowNotes.length === 0) reasons.push('No payments to report in the year.');
  } else if (reportableCodes.length === 0) {
    status = 'excluded_corporation';
    reasons.push(...corpNotes);
  } else {
    reasons.push(...corpNotes);
    const hasTin = /^\d{4}$/.test(vendor.tinLast4 ?? '');
    if (!hasTin) {
      status = 'needs_tin';
      reasons.push('No TIN on file; collect a W-9.');
      if (!vendor.addressComplete) reasons.push('The address is incomplete.');
    } else if (!vendor.addressComplete) {
      status = 'needs_address';
      reasons.push('The address is incomplete.');
    } else {
      status = 'included';
    }
  }

  if (acc.unmapped.length > 0) {
    const total = acc.unmapped.reduce((sum, item) => sum + toCents(item.amount), 0);
    reasons.push(`${money(total)} paid to this vendor has no 1099 box; set a default box on the vendor, the account or the bill line.`);
  }
  if (vendor.backupWithholding && withheldForms.size === 0 && acc.contributions.length > 0) {
    reasons.push('The vendor is subject to backup withholding but no tax was withheld on its payments.');
  }
  const cardTotal = acc.exclusions
    .filter((item) => item.reason === 'card_or_network_method' || item.reason === 'credit_card_account')
    .reduce((sum, item) => sum + toCents(item.amount), 0);
  if (cardTotal > 0) reasons.push(`${money(cardTotal)} paid by card or third-party network is reported by the processor on Form 1099-K.`);

  const showBoxes = status === 'included' || status === 'needs_tin' || status === 'needs_address';
  return {
    partyId: vendor.partyId,
    name: vendor.name,
    status,
    reasons,
    forms: showBoxes ? forms : [],
    totals,
    boxes: showBoxes ? reportable : {},
    aboveThreshold: anyAboveThreshold,
    isCorporation,
    contributions: acc.contributions,
    exclusions: acc.exclusions,
    unmapped: acc.unmapped,
    adjustments: acc.adjustments,
    paymentIds: [...acc.paymentIds],
    bankTransactionIds: [...acc.bankTransactionIds],
  };
}
