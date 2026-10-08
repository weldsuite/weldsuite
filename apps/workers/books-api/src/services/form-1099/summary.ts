/**
 * The yearly 1099 review: per-vendor results with the reasons behind each
 * status, warnings by vendor name, the drill-down to the payments, and the
 * Form 945 view of backup withholding. Only `tin_last4` is ever shown.
 */

import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import {
  form1099Deadlines,
  type Form1099BoxCode,
  type Form1099Type,
} from '@weldsuite/books-domain/jurisdictions/us/form-1099';
import { isTinType } from '@weldsuite/books-domain/jurisdictions/us/identifiers';
import { form945Summary } from '@weldsuite/books-domain/us-compliance/backup-withholding';
import {
  compute1099Totals,
  type Compute1099Adjustment,
  type Compute1099Result,
  type Form1099VendorResult,
  type Form1099VendorStatus,
} from '@weldsuite/books-domain/us-compliance/form-1099-compute';
import { maskTin } from '@weldsuite/books-domain/jurisdictions/us/identifiers';
import type { PartyW9 } from '../vendor-tax-data';
import { isAddressComplete, load1099Input, yearBounds, type Loaded1099, type PartyRow } from './load';

const money = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** IRS TIN Matching results that mean the name and TIN on file do not agree with the IRS. */
export const TIN_MATCH_PROBLEMS: readonly string[] = ['mismatch', 'not_issued', 'invalid'];

export function formOfBox(code: string): Form1099Type {
  return code.startsWith('nec_') ? 'nec' : 'misc';
}

export function boxesOfForm(boxes: Partial<Record<Form1099BoxCode, number>>, form: Form1099Type): Record<string, number> {
  return Object.fromEntries(Object.entries(boxes).filter(([code]) => formOfBox(code) === form)) as Record<string, number>;
}

export interface Form1099VendorRow {
  partyId: string;
  name: string;
  /** W-9 line 1 when received, else the contact name. */
  legalName: string;
  status: Form1099VendorStatus;
  reasons: string[];
  forms: Form1099Type[];
  boxes: Partial<Record<Form1099BoxCode, number>>;
  /** Every box total before thresholds and the corporation rule. */
  totals: Partial<Record<Form1099BoxCode, number>>;
  aboveThreshold: boolean;
  isCorporation: boolean;
  isAttorney: boolean;
  tinType: string | null;
  tinLast4: string | null;
  tinMasked: string | null;
  hasTin: boolean;
  tinMatchStatus: string | null;
  tinMatchedAt: Date | null;
  backupWithholding: boolean;
  /** A TIN match failed and the vendor is not yet on backup withholding. */
  suggestBackupWithholding: boolean;
  addressComplete: boolean;
  address: ReturnType<typeof normalizePostalAddress>;
  hasW9: boolean;
  eDeliveryConsent: boolean;
  excluded: { cardOrNetwork: number; creditCardAccount: number; payroll: number; omittedBox: number };
  unmappedAmount: number;
  adjustmentCount: number;
  paymentCount: number;
  bankTransactionCount: number;
}

function sum(values: number[]): number {
  return Math.round(values.reduce((acc, value) => acc + value, 0) * 100) / 100;
}

export function buildVendorRow(result: Form1099VendorResult, party: PartyRow): Form1099VendorRow {
  const w9 = party.w9 as PartyW9 | null;
  const tinType = isTinType(party.tinType) ? party.tinType : undefined;
  const mismatch = TIN_MATCH_PROBLEMS.includes(party.tinMatchStatus ?? '');
  const reasons = [...result.reasons];
  if (mismatch) {
    reasons.push(
      party.backupWithholding
        ? 'The IRS could not match the name and TIN; backup withholding is on.'
        : 'The IRS could not match the name and TIN. Send a first B notice and ask for a new W-9; turn on backup withholding if none arrives within 30 business days.',
    );
  }
  const exclusionTotal = (reason: string) =>
    sum(result.exclusions.filter((e) => e.reason === reason).map((e) => e.amount));
  return {
    partyId: party.id,
    name: party.displayName ?? '',
    legalName: w9?.legalName?.trim() || party.displayName || '',
    status: result.status,
    reasons,
    forms: result.forms,
    boxes: result.boxes,
    totals: result.totals,
    aboveThreshold: result.aboveThreshold,
    isCorporation: result.isCorporation,
    isAttorney: Boolean(w9?.isAttorney),
    tinType: party.tinType,
    tinLast4: party.tinLast4,
    tinMasked: party.tinLast4 ? maskTin(party.tinLast4, tinType) : null,
    hasTin: Boolean(party.tinLast4),
    tinMatchStatus: party.tinMatchStatus,
    tinMatchedAt: party.tinMatchedAt,
    backupWithholding: Boolean(party.backupWithholding),
    suggestBackupWithholding: mismatch && !party.backupWithholding,
    addressComplete: isAddressComplete(party.billingAddress),
    address: normalizePostalAddress(party.billingAddress),
    hasW9: Boolean(w9?.receivedAt || w9?.legalName),
    eDeliveryConsent: Boolean(party.form1099EDeliveryConsentAt),
    excluded: {
      cardOrNetwork: exclusionTotal('card_or_network_method'),
      creditCardAccount: exclusionTotal('credit_card_account'),
      payroll: exclusionTotal('paid_through_payroll'),
      omittedBox: exclusionTotal('omitted_box'),
    },
    unmappedAmount: sum(result.unmapped.map((u) => u.amount)),
    adjustmentCount: result.adjustments.length,
    paymentCount: result.paymentIds.length,
    bankTransactionCount: result.bankTransactionIds.length,
  };
}

export interface Form1099Summary {
  taxYear: number;
  entityId: string;
  thresholds: {
    /** False when the year is later than the last the IRS has published; the last known amounts are carried forward. */
    published: boolean;
    general: number | null;
    royalty: number | null;
    fixed600: number | null;
    boxes: Partial<Record<Form1099BoxCode, number | null>>;
  };
  deadlines: ReturnType<typeof form1099Deadlines>;
  summary: Record<Form1099VendorStatus, number>;
  totals: { nec: number; misc: number; withheld: number };
  vendors: Form1099VendorRow[];
  warnings: string[];
}

export interface Computed1099 {
  loaded: Loaded1099;
  result: Compute1099Result;
}

export async function compute1099ForEntity(
  db: Database,
  entityId: string,
  taxYear: number,
  options: { partyIds?: string[]; adjustments?: Compute1099Adjustment[] } = {},
): Promise<Computed1099> {
  const loaded = await load1099Input(db, entityId, taxYear, options);
  return { loaded, result: compute1099Totals(loaded.input) };
}

/** Vendor rows worth showing: everyone with a status except non-vendors that stay under the threshold. */
function visibleRows(computed: Computed1099): Form1099VendorRow[] {
  const rows: Form1099VendorRow[] = [];
  for (const vendor of computed.result.vendors) {
    const party = computed.loaded.parties.get(vendor.partyId);
    if (!party) continue;
    if (vendor.status === 'not_1099_vendor' && !vendor.aboveThreshold) continue;
    rows.push(buildVendorRow(vendor, party));
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildSummary(computed: Computed1099): Form1099Summary {
  const { result, loaded } = computed;
  const rows = visibleRows(computed);
  const thresholds = result.thresholds;

  const warnings: string[] = [];
  for (const row of rows) {
    if (row.status === 'not_1099_vendor') {
      warnings.push(`${row.name} was paid ${money(sum(Object.values(row.totals)))} in reportable boxes but is not marked as a 1099 vendor.`);
    }
    if (row.status === 'needs_tin') warnings.push(`${row.name} needs a TIN: collect a W-9 before filing.`);
    if (row.status === 'needs_address') warnings.push(`${row.name} needs a complete mailing address.`);
    if (row.unmappedAmount > 0) {
      warnings.push(`${money(row.unmappedAmount)} paid to ${row.name} has no 1099 box; set a default box on the vendor, the account or the bill line.`);
    }
    if (row.suggestBackupWithholding) {
      warnings.push(`${row.name}: the IRS TIN match failed. Send a B notice and consider backup withholding.`);
    } else if (TIN_MATCH_PROBLEMS.includes(row.tinMatchStatus ?? '')) {
      warnings.push(`${row.name}: the IRS TIN match failed; backup withholding is on.`);
    }
    if (row.backupWithholding && row.status === 'included' && !(row.boxes.nec_4 || row.boxes.misc_4)) {
      warnings.push(`${row.name} is subject to backup withholding but no tax was withheld on the payments.`);
    }
  }
  for (const warning of result.warnings) warnings.push(warning);

  let nec = 0;
  let misc = 0;
  let withheld = 0;
  for (const row of rows) {
    if (row.status !== 'included' && row.status !== 'needs_tin' && row.status !== 'needs_address') continue;
    for (const [code, amount] of Object.entries(row.boxes)) {
      if (code === 'nec_4' || code === 'misc_4') withheld += amount ?? 0;
      else if (formOfBox(code) === 'nec') nec += amount ?? 0;
      else misc += amount ?? 0;
    }
  }

  return {
    taxYear: result.taxYear,
    entityId: loaded.entity.id,
    thresholds: {
      published: thresholds.published,
      general: thresholds.groups.general,
      royalty: thresholds.groups.royalty,
      fixed600: thresholds.groups.fixed_600,
      boxes: thresholds.boxes,
    },
    deadlines: form1099Deadlines(result.taxYear),
    summary: result.summary,
    totals: { nec: sum([nec]), misc: sum([misc]), withheld: sum([withheld]) },
    vendors: rows,
    warnings,
  };
}

export async function summarize1099(db: Database, entityId: string, taxYear: number): Promise<Form1099Summary> {
  return buildSummary(await compute1099ForEntity(db, entityId, taxYear));
}

// ---------------------------------------------------------------------------
// Drill-down
// ---------------------------------------------------------------------------

export async function vendorDrillDown(db: Database, entityId: string, taxYear: number, partyId: string) {
  const computed = await compute1099ForEntity(db, entityId, taxYear, { partyIds: [partyId] });
  const { loaded, result } = computed;
  const vendor = result.vendors.find((v) => v.partyId === partyId);
  const party = loaded.parties.get(partyId);
  if (!party) return null;
  const row = vendor
    ? buildVendorRow(vendor, party)
    : buildVendorRow(
        {
          partyId,
          name: party.displayName ?? undefined,
          status: party.is1099Vendor ? 'below_threshold' : 'not_1099_vendor',
          reasons: ['No payments in the year.'],
          forms: [],
          totals: {},
          boxes: {},
          aboveThreshold: false,
          isCorporation: false,
          contributions: [],
          exclusions: [],
          unmapped: [],
          adjustments: [],
          paymentIds: [],
          bankTransactionIds: [],
        },
        party,
      );

  const { docs } = loaded;
  const accountName = (id: string | null | undefined) => {
    const account = id ? docs.accounts.get(id) : undefined;
    return account ? { id: account.id, code: account.code, name: account.name } : null;
  };
  const describe = (item: {
    paymentId?: string;
    bankTransactionId?: string;
    billId?: string;
    billLineId?: string;
  }) => {
    const payment = item.paymentId ? docs.payments.get(item.paymentId) : undefined;
    const bill = item.billId ? docs.bills.get(item.billId) : undefined;
    const line = item.billLineId ? docs.billLines.get(item.billLineId) : undefined;
    const txn = item.bankTransactionId ? docs.bankTransactions.get(item.bankTransactionId) : undefined;
    return {
      payment: payment
        ? {
            id: payment.id,
            date: payment.date,
            method: payment.paymentMethod,
            checkNumber: payment.checkNumber,
            reference: payment.reference,
            amount: payment.amount,
            backupWithholdingAmount: payment.backupWithholdingAmount,
          }
        : null,
      bill: bill ? { id: bill.id, number: bill.number, issueDate: bill.issueDate, reference: bill.reference } : null,
      billLine: line ? { id: line.id, description: line.description, account: accountName(line.accountId) } : null,
      bankTransaction: txn
        ? {
            id: txn.id,
            date: txn.date,
            description: txn.description,
            counterpartyName: txn.counterpartyName,
            checkNumber: txn.checkNumber,
            amount: txn.amount,
          }
        : null,
    };
  };

  return {
    taxYear,
    vendor: row,
    contributions: (vendor?.contributions ?? []).map((c) => ({
      box: c.box,
      amount: c.amount,
      boxSource: c.boxSource,
      unapplied: Boolean(c.unapplied),
      ...describe(c),
    })),
    exclusions: (vendor?.exclusions ?? []).map((e) => ({
      reason: e.reason,
      amount: e.amount,
      paymentMethod: e.paymentMethod ?? null,
      ...describe(e),
    })),
    unmapped: (vendor?.unmapped ?? []).map((u) => ({ reason: u.reason, amount: u.amount, ...describe(u) })),
    adjustments: vendor?.adjustments ?? [],
    warnings: result.warnings,
  };
}

// ---------------------------------------------------------------------------
// Form 945
// ---------------------------------------------------------------------------

export async function backupWithholdingFor945(db: Database, entityId: string, taxYear: number) {
  const { start, end } = yearBounds(taxYear);
  const rows = await db
    .select({
      id: schema.payments.id,
      partyId: schema.payments.contactId,
      date: schema.payments.date,
      amount: schema.payments.backupWithholdingAmount,
      checkStatus: schema.payments.checkStatus,
    })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.entityId, entityId),
        isNull(schema.payments.deletedAt),
        gte(schema.payments.date, start),
        lt(schema.payments.date, end),
        sql`coalesce(${schema.payments.backupWithholdingAmount}, 0) > 0`,
      ),
    );
  const summary = form945Summary(
    taxYear,
    rows.map((row) => ({
      id: row.id,
      partyId: row.partyId,
      date: row.date.toISOString().slice(0, 10),
      backupWithholdingAmount: Number(row.amount ?? 0),
      voided: row.checkStatus === 'voided',
    })),
  );
  const partyIds = summary.byVendor.map((v) => v.partyId);
  const names = new Map<string, string>();
  if (partyIds.length > 0) {
    const parties = await db
      .select({ id: schema.parties.id, displayName: schema.parties.displayName })
      .from(schema.parties)
      .where(inArray(schema.parties.id, partyIds));
    for (const party of parties) names.set(party.id, party.displayName ?? '');
  }
  return {
    ...summary,
    byVendor: summary.byVendor.map((v) => ({ ...v, name: names.get(v.partyId) ?? null })),
  };
}
