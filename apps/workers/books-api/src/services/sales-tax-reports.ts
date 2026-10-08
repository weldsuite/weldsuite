/**
 * Sales tax reports (docs/plans/weldbooks-us.md §6 and §10): liability by
 * agency and jurisdiction tied to the ledger, taxable and exempt sales,
 * exceptions, expiring and missing exemption certificates, and the
 * reconciliation of provider engines.
 *
 * Every figure reads the tax ledger (`tax_lines`); a document line's gross is
 * counted once, from its highest-level row, however many jurisdictions it was
 * taxed in.
 */

import { and, eq, gte, inArray, isNull, lte, max, sql } from 'drizzle-orm';
import { certificateExpiry, missingCertificateCureDeadline } from '@weldsuite/books-domain/sales-tax/exemptions';
import { toCertificateRef } from '@weldsuite/books-domain/sales-tax/load';
import { addDays } from '@weldsuite/books-domain/us-compliance/dates';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  chunk,
  nextDay,
  num,
  round2,
  startOfDay,
  registeredOn,
  stateOfAddress,
  sumMoney,
  todayIn,
  type AgencyRow,
  type EntityRow,
  type TaxLineRow,
} from './sales-tax-returns/common';
import { loadAgencies } from './sales-tax-returns/context';
import { anchorRows, describeDocuments, documentKey } from './sales-tax-returns/documents';
import { agencyLiability, statusAsOf } from './sales-tax-returns/checks';
import { loadAgencyReturns } from './sales-tax-returns/periods';

const tl = schema.taxLines;

// ---------------------------------------------------------------------------
// Liability
// ---------------------------------------------------------------------------

export interface LiabilityJurisdiction {
  jurisdictionCode: string;
  jurisdictionName: string;
  level: string;
  collected: number;
  filed: number;
  paid: number;
  outstanding: number;
}

export interface AgencyLiabilityRow {
  agencyId: string;
  agencyName: string;
  stateCode: string;
  status: string;
  /** Sales tax charged plus use tax accrued, up to the date. */
  collected: number;
  /** On returns filed by the date (paid ones included). */
  filed: number;
  paid: number;
  /** collected - paid: what the payable account should hold. */
  outstanding: number;
  unfiled: number;
  filedUnpaid: number;
  /** Credit balance of the agency's payable accounts. */
  glBalance: number;
  /** glBalance - outstanding; zero when the ledger ties to the tax ledger. */
  difference: number;
  jurisdictions: LiabilityJurisdiction[];
  warnings: string[];
}

export interface LiabilityReport {
  asOf: string;
  agencies: AgencyLiabilityRow[];
  totals: { collected: number; filed: number; paid: number; outstanding: number; glBalance: number; difference: number };
}

export async function liabilityReport(db: Database, entity: EntityRow, asOf: string): Promise<LiabilityReport> {
  const agencies = await loadAgencies(db, entity.id);
  const rows: AgencyLiabilityRow[] = [];
  for (const agency of agencies) {
    const returns = await loadAgencyReturns(db, entity.id, agency.id);
    const liability = await agencyLiability(db, { entityId: entity.id, agency, asOf, withItems: false, returns });
    const byReturn = new Map(returns.map((r) => [r.id, r]));

    const grouped = await db
      .select({
        code: tl.jurisdictionCode,
        name: tl.jurisdictionName,
        level: tl.jurisdictionLevel,
        taxReturnId: tl.taxReturnId,
        tax: sql<string>`sum(${tl.taxAmount})`,
      })
      .from(tl)
      .where(
        and(
          eq(tl.entityId, entity.id),
          eq(tl.agencyId, agency.id),
          inArray(tl.direction, ['sales', 'use']),
          sql`${tl.taxDate} < ${nextDay(asOf)}`,
        ),
      )
      .groupBy(tl.jurisdictionCode, tl.jurisdictionName, tl.jurisdictionLevel, tl.taxReturnId);
    const jurisdictions = new Map<string, LiabilityJurisdiction>();
    for (const g of grouped) {
      const key = g.code ?? '';
      const entry = jurisdictions.get(key) ?? {
        jurisdictionCode: key,
        jurisdictionName: g.name ?? key,
        level: g.level ?? '',
        collected: 0,
        filed: 0,
        paid: 0,
        outstanding: 0,
      };
      const tax = num(g.tax);
      const stamped = g.taxReturnId ? byReturn.get(g.taxReturnId) : undefined;
      const status = stamped ? statusAsOf(stamped, asOf) : 'unfiled';
      entry.collected = round2(entry.collected + tax);
      if (status === 'filed' || status === 'paid') entry.filed = round2(entry.filed + tax);
      if (status === 'paid') entry.paid = round2(entry.paid + tax);
      entry.outstanding = round2(entry.collected - entry.paid);
      jurisdictions.set(key, entry);
    }

    rows.push({
      agencyId: agency.id,
      agencyName: agency.name,
      stateCode: agency.stateCode,
      status: agency.status,
      collected: liability.collectedTax,
      filed: round2(liability.paidTax + liability.filedUnpaidTax),
      paid: liability.paidTax,
      outstanding: liability.expectedBalance,
      unfiled: liability.unfiledTax,
      filedUnpaid: liability.filedUnpaidTax,
      glBalance: liability.glBalance,
      difference: liability.difference,
      jurisdictions: [...jurisdictions.values()].sort(
        (a, b) => a.level.localeCompare(b.level) || a.jurisdictionName.localeCompare(b.jurisdictionName),
      ),
      warnings: liability.warnings,
    });
  }
  const total = (pick: (r: AgencyLiabilityRow) => number) => sumMoney(rows.map(pick));
  return {
    asOf,
    agencies: rows,
    totals: {
      collected: total((r) => r.collected),
      filed: total((r) => r.filed),
      paid: total((r) => r.paid),
      outstanding: total((r) => r.outstanding),
      glBalance: total((r) => r.glBalance),
      difference: total((r) => r.difference),
    },
  };
}

// ---------------------------------------------------------------------------
// Sales summary
// ---------------------------------------------------------------------------

export type SalesSummaryGroup = 'customer' | 'state' | 'jurisdiction';

export interface SalesSummaryRow {
  key: string;
  label: string;
  /** jurisdiction level for `jurisdiction` rows. */
  level?: string;
  grossSales: number;
  taxableSales: number;
  exemptSales: number;
  exemptByReason: Record<string, number>;
  nonTaxableSales: number;
  /** Gross of sales through a marketplace facilitator (no tax collected). */
  marketplaceSales: number;
  tax: number;
  documents: number;
}

export interface SalesSummary {
  from: string;
  to: string;
  groupBy: SalesSummaryGroup;
  rows: SalesSummaryRow[];
  totals: SalesFigures;
}

interface Acc {
  key: string;
  label: string;
  level?: string;
  gross: number;
  taxable: number;
  exempt: number;
  exemptByReason: Map<string, number>;
  nonTaxable: number;
  marketplace: number;
  tax: number;
  documents: Set<string>;
}

const cents = (v: number) => Math.round(v * 100);

function newAcc(key: string, label: string, level?: string): Acc {
  return { key, label, level, gross: 0, taxable: 0, exempt: 0, exemptByReason: new Map(), nonTaxable: 0, marketplace: 0, tax: 0, documents: new Set() };
}

type SalesFigures = Omit<SalesSummaryRow, 'key' | 'label' | 'level'>;

function figuresOf(a: Acc): SalesFigures {
  return {
    grossSales: a.gross / 100,
    taxableSales: a.taxable / 100,
    exemptSales: a.exempt / 100,
    exemptByReason: Object.fromEntries([...a.exemptByReason].map(([k, v]) => [k, v / 100])),
    nonTaxableSales: a.nonTaxable / 100,
    marketplaceSales: a.marketplace / 100,
    tax: a.tax / 100,
    documents: a.documents.size,
  };
}

function finishAcc(a: Acc): SalesSummaryRow {
  return { key: a.key, label: a.label, ...(a.level !== undefined ? { level: a.level } : {}), ...figuresOf(a) };
}

async function salesRows(db: Database, entityId: string, from: string, to: string): Promise<TaxLineRow[]> {
  return db
    .select()
    .from(tl)
    .where(and(eq(tl.entityId, entityId), eq(tl.direction, 'sales'), gte(tl.taxDate, from), lte(tl.taxDate, to)));
}

async function customerNames(db: Database, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk(ids, 1000)) {
    const rows = await db
      .select({ id: schema.parties.id, name: schema.parties.displayName })
      .from(schema.parties)
      .where(inArray(schema.parties.id, part));
    for (const r of rows) if (r.name) out.set(r.id, r.name);
  }
  return out;
}

export async function salesSummary(
  db: Database,
  entityId: string,
  args: { from: string; to: string; groupBy: SalesSummaryGroup },
): Promise<SalesSummary> {
  const rows = await salesRows(db, entityId, args.from, args.to);
  const docs = await describeDocuments(db, entityId, rows);
  const names = await customerNames(db, [...new Set(rows.map((r) => r.contactId).filter((id): id is string => Boolean(id)))]);
  const groups = new Map<string, Acc>();
  const total = newAcc('total', 'Total');

  const add = (acc: Acc, r: TaxLineRow, parts: { gross?: boolean; tax?: boolean }) => {
    if (parts.gross) {
      acc.gross += cents(num(r.grossAmount));
      acc.taxable += cents(num(r.taxableAmount));
      const exempt = cents(num(r.exemptAmount));
      acc.exempt += exempt;
      if (exempt !== 0) acc.exemptByReason.set(r.exemptReason ?? 'other', (acc.exemptByReason.get(r.exemptReason ?? 'other') ?? 0) + exempt);
      acc.nonTaxable += cents(num(r.nonTaxableAmount));
      if (r.marketplaceFacilitated) acc.marketplace += cents(num(r.grossAmount));
    }
    if (parts.tax) acc.tax += cents(num(r.taxAmount));
    acc.documents.add(documentKey(r));
  };

  const keyOf = (r: TaxLineRow): { key: string; label: string; level?: string } => {
    if (args.groupBy === 'jurisdiction') {
      return { key: r.jurisdictionCode ?? '', label: r.jurisdictionName ?? r.jurisdictionCode ?? 'Unknown', level: r.jurisdictionLevel ?? '' };
    }
    if (args.groupBy === 'state') {
      const state = (r.shipToState || r.stateCode || '').toUpperCase();
      return { key: state, label: state || 'No ship-to state' };
    }
    const info = docs.get(documentKey(r));
    const id = r.contactId ?? info?.contactId ?? '';
    return { key: id, label: (id && names.get(id)) || info?.contactName || id || 'Unknown customer' };
  };

  const group = (r: TaxLineRow): Acc => {
    const k = keyOf(r);
    let acc = groups.get(k.key);
    if (!acc) {
      acc = newAcc(k.key, k.label, k.level);
      groups.set(k.key, acc);
    }
    return acc;
  };

  if (args.groupBy === 'jurisdiction') {
    // Each jurisdiction row carries the line's amounts; they are reported where they were taxed.
    for (const r of rows) {
      add(group(r), r, { gross: true, tax: true });
      add(total, r, { tax: true });
    }
    for (const anchor of anchorRows(rows)) add(total, anchor, { gross: true });
  } else {
    // A line's gross is reported once, where its anchor row sits (ship-to state, customer); its tax goes there too.
    const anchors = new Map<string, TaxLineRow>();
    rows.forEach((r, index) => {
      const lineKey = `${documentKey(r)}|${r.sourceLineId ?? `#${index}`}`;
      const current = anchors.get(lineKey);
      anchors.set(lineKey, current ? (anchorRows([current, r])[0] ?? current) : r);
    });
    rows.forEach((r, index) => {
      const anchor = anchors.get(`${documentKey(r)}|${r.sourceLineId ?? `#${index}`}`) ?? r;
      add(group(anchor), r, { tax: true });
      add(total, r, { tax: true });
    });
    for (const anchor of anchors.values()) {
      add(group(anchor), anchor, { gross: true });
      add(total, anchor, { gross: true });
    }
  }
  const out = [...groups.values()].map(finishAcc).sort((a, b) => b.grossSales - a.grossSales || a.label.localeCompare(b.label));
  return { from: args.from, to: args.to, groupBy: args.groupBy, rows: out, totals: figuresOf(total) };
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export type SalesTaxExceptionKind =
  | 'no_ship_to_state'
  | 'tax_in_unregistered_state'
  | 'taxable_without_tax'
  | 'marketplace_sale'
  | 'tax_override'
  | 'provider_commit_failure'
  | 'tax_warning';

export interface SalesTaxException {
  kind: SalesTaxExceptionKind;
  severity: 'error' | 'warning' | 'info';
  documentType: string;
  documentId: string | null;
  documentNumber: string | null;
  date: string | null;
  contactName: string | null;
  stateCode: string | null;
  amount: number | null;
  taxAmount: number | null;
  message: string;
}

export interface ExceptionsReport {
  from: string;
  to: string;
  counts: Record<SalesTaxExceptionKind, number>;
  exceptions: SalesTaxException[];
}

const KINDS: SalesTaxExceptionKind[] = [
  'no_ship_to_state',
  'tax_in_unregistered_state',
  'taxable_without_tax',
  'marketplace_sale',
  'tax_override',
  'provider_commit_failure',
  'tax_warning',
];

export async function exceptionsReport(db: Database, entityId: string, args: { from: string; to: string }): Promise<ExceptionsReport> {
  const agencies = await loadAgencies(db, entityId);
  const out: SalesTaxException[] = [];
  const inv = schema.invoices;

  const invoices = await db
    .select({
      id: inv.id,
      number: inv.invoiceNumber,
      type: inv.type,
      issueDate: inv.issueDate,
      contactName: inv.contactName,
      shipping: inv.shippingAddress,
      billing: inv.billingAddress,
      taxTotal: inv.taxTotal,
      subtotal: inv.subtotal,
      warnings: inv.taxWarnings,
    })
    .from(inv)
    .where(
      and(
        eq(inv.entityId, entityId),
        isNull(inv.deletedAt),
        inArray(inv.type, ['standard', 'correction', 'credit_note']),
        sql`${inv.journalEntryId} is not null`,
        gte(inv.issueDate, startOfDay(args.from)),
        lte(inv.issueDate, startOfDay(nextDay(args.to))),
      ),
    );
  const docType = (type: string) => (type === 'credit_note' ? 'credit_note' : 'invoice');
  const day = (d: Date) => d.toISOString().slice(0, 10);

  for (const i of invoices) {
    if (stateOfAddress(i.shipping) === '' && stateOfAddress(i.billing) === '') {
      out.push({
        kind: 'no_ship_to_state', severity: 'error', documentType: docType(i.type), documentId: i.id, documentNumber: i.number,
        date: day(i.issueDate), contactName: i.contactName, stateCode: null, amount: num(i.subtotal), taxAmount: num(i.taxTotal),
        message: 'The document has no ship-to or bill-to state, so the tax cannot be sourced.',
      });
    }
    for (const warning of i.warnings ?? []) {
      const commit = /commit/i.test(warning);
      out.push({
        kind: commit ? 'provider_commit_failure' : 'tax_warning', severity: commit ? 'error' : 'warning',
        documentType: docType(i.type), documentId: i.id, documentNumber: i.number, date: day(i.issueDate), contactName: i.contactName,
        stateCode: stateOfAddress(i.shipping) || stateOfAddress(i.billing) || null, amount: num(i.subtotal), taxAmount: num(i.taxTotal),
        message: warning,
      });
    }
  }

  // Overrides: the user set the tax of a line by hand.
  const overrides = await db
    .select({
      invoiceId: schema.invoiceItems.invoiceId,
      description: schema.invoiceItems.description,
      amount: schema.invoiceItems.taxOverrideAmount,
      reason: schema.invoiceItems.taxOverrideReason,
      number: inv.invoiceNumber,
      type: inv.type,
      issueDate: inv.issueDate,
      contactName: inv.contactName,
      shipping: inv.shippingAddress,
      billing: inv.billingAddress,
    })
    .from(schema.invoiceItems)
    .innerJoin(inv, eq(inv.id, schema.invoiceItems.invoiceId))
    .where(
      and(
        eq(inv.entityId, entityId),
        isNull(inv.deletedAt),
        isNull(schema.invoiceItems.deletedAt),
        sql`${schema.invoiceItems.taxOverrideAmount} is not null`,
        sql`${inv.journalEntryId} is not null`,
        gte(inv.issueDate, startOfDay(args.from)),
        lte(inv.issueDate, startOfDay(nextDay(args.to))),
      ),
    );
  for (const o of overrides) {
    out.push({
      kind: 'tax_override', severity: 'warning', documentType: docType(o.type), documentId: o.invoiceId, documentNumber: o.number,
      date: day(o.issueDate), contactName: o.contactName, stateCode: stateOfAddress(o.shipping) || stateOfAddress(o.billing) || null,
      amount: null, taxAmount: num(o.amount),
      message: `Tax set by hand on "${o.description}": ${o.reason?.trim() || 'no reason given'}.`,
    });
  }

  // Ledger rows.
  const rows = await salesRows(db, entityId, args.from, args.to);
  const docs = await describeDocuments(db, entityId, rows);
  const byDocument = new Map<string, TaxLineRow[]>();
  for (const r of rows) {
    const key = documentKey(r);
    const list = byDocument.get(key);
    if (list) list.push(r);
    else byDocument.set(key, [r]);
  }
  for (const [key, list] of byDocument) {
    const info = docs.get(key)!;
    const first = list[0]!;
    const base = {
      documentType: info.type, documentId: info.id, documentNumber: info.number, date: first.taxDate, contactName: info.contactName,
    };
    const state = (first.shipToState || first.stateCode || '').toUpperCase() || null;

    // Tax charged where the business is not registered.
    for (const [stateCode, stateRows] of groupBy(list, (r) => (r.stateCode ?? '').toUpperCase())) {
      const tax = sumMoney(stateRows.map((r) => num(r.taxAmount)));
      if (tax !== 0 && !registeredOn(agencies, stateCode, first.taxDate)) {
        out.push({ ...base, kind: 'tax_in_unregistered_state', severity: 'error', stateCode, amount: null, taxAmount: tax,
          message: `Tax was charged in ${stateCode || 'an unknown state'}, where the business has no registration.` });
      }
    }

    const anchors = anchorRows(list);
    // Taxable sales with no tax, no exemption and no certificate in a registered state.
    for (const anchor of anchors) {
      const lineRows = list.filter((r) => r.sourceLineId === anchor.sourceLineId);
      const lineTax = sumMoney(lineRows.map((r) => num(r.taxAmount)));
      const gross = num(anchor.grossAmount);
      if (
        gross > 0 && lineTax === 0 && num(anchor.exemptAmount) === 0 && num(anchor.nonTaxableAmount) === 0 &&
        !anchor.marketplaceFacilitated && !anchor.certificateId && !anchor.exemptReason &&
        registeredOn(agencies, anchor.stateCode, first.taxDate) && anchor.direction === 'sales'
      ) {
        out.push({ ...base, kind: 'taxable_without_tax', severity: 'error', stateCode: (anchor.stateCode ?? '').toUpperCase() || state,
          amount: gross, taxAmount: 0,
          message: 'A sale in a state where the business is registered carries no tax, no exemption and no certificate.' });
      }
    }
    if (anchors.some((a) => a.marketplaceFacilitated)) {
      out.push({ ...base, kind: 'marketplace_sale', severity: 'info', stateCode: state,
        amount: sumMoney(anchors.filter((a) => a.marketplaceFacilitated).map((a) => num(a.grossAmount))), taxAmount: 0,
        message: 'Sold through a marketplace facilitator that collects the tax; it counts toward nexus only.' });
    }
  }

  out.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.kind.localeCompare(b.kind) || (a.documentNumber ?? '').localeCompare(b.documentNumber ?? ''));
  const counts = Object.fromEntries(KINDS.map((k) => [k, out.filter((e) => e.kind === k).length])) as Record<SalesTaxExceptionKind, number>;
  return { from: args.from, to: args.to, counts, exceptions: out };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

export interface ExpiringCertificate {
  certificateId: string;
  partyId: string;
  customerName: string | null;
  certificateNumber: string | null;
  reason: string;
  form: string;
  blanket: boolean;
  states: string[];
  status: string;
  /** The earliest date the certificate stops covering one of its states. */
  expiresOn: string;
  expiryByState: Array<{ stateCode: string; expiresOn: string | null }>;
  daysLeft: number;
  expired: boolean;
  lastUsedOn: string | null;
}

/** Certificates that stop being valid within `days` of today (and the ones that lapsed in the last year). */
export async function expiringCertificates(
  db: Database,
  entity: EntityRow,
  args: { days: number; now?: Date },
): Promise<{ asOf: string; days: number; certificates: ExpiringCertificate[] }> {
  const today = todayIn(entity.timezone, args.now);
  const until = addDays(today, args.days);
  const earliest = addDays(today, -365);
  const certs = await db
    .select()
    .from(schema.exemptionCertificates)
    .where(
      and(
        eq(schema.exemptionCertificates.entityId, entity.id),
        isNull(schema.exemptionCertificates.deletedAt),
        inArray(schema.exemptionCertificates.status, ['valid', 'expired']),
      ),
    );
  if (certs.length === 0) return { asOf: today, days: args.days, certificates: [] };

  const used = await db
    .select({ certificateId: tl.certificateId, lastUsedOn: max(tl.taxDate) })
    .from(tl)
    .where(and(eq(tl.entityId, entity.id), inArray(tl.certificateId, certs.map((c) => c.id))))
    .groupBy(tl.certificateId);
  const lastUsed = new Map(used.map((u) => [u.certificateId, u.lastUsedOn]));
  const names = await customerNames(db, [...new Set(certs.map((c) => c.partyId))]);

  const out: ExpiringCertificate[] = [];
  for (const cert of certs) {
    const ref = toCertificateRef(cert, lastUsed.get(cert.id) ?? null);
    const byState = (cert.states ?? []).map((s) => ({ stateCode: s.toUpperCase(), expiresOn: certificateExpiry(ref, s) }));
    const dates = byState.map((s) => s.expiresOn).filter((d): d is string => Boolean(d)).sort();
    const expiresOn = dates[0];
    if (!expiresOn || expiresOn > until || expiresOn < earliest) continue;
    out.push({
      certificateId: cert.id,
      partyId: cert.partyId,
      customerName: names.get(cert.partyId) ?? null,
      certificateNumber: cert.certificateNumber,
      reason: cert.reason,
      form: cert.form,
      blanket: cert.blanket,
      states: (cert.states ?? []).map((s) => s.toUpperCase()),
      status: cert.status,
      expiresOn,
      expiryByState: byState,
      daysLeft: Math.round((new Date(`${expiresOn}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000),
      expired: expiresOn < today,
      lastUsedOn: lastUsed.get(cert.id) ?? null,
    });
  }
  out.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.certificateId.localeCompare(b.certificateId));
  return { asOf: today, days: args.days, certificates: out };
}

export interface MissingCertificate {
  documentType: string;
  documentId: string | null;
  documentNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  stateCode: string | null;
  saleDate: string;
  exemptSales: number;
  exemptReason: string | null;
  /** Streamlined Sales Tax: a complete certificate within 90 days of the sale protects the seller. */
  cureDeadline: string;
  pastDeadline: boolean;
  /** Past the deadline the worksheet counts the sale as taxable. */
  daysLeft: number;
}

/** Exempt sales with no certificate on file, with the date by which one has to arrive. */
export async function missingCertificates(
  db: Database,
  entity: EntityRow,
  args: { from?: string; to?: string; now?: Date },
): Promise<{ asOf: string; certificates: MissingCertificate[]; totals: { documents: number; exemptSales: number; pastDeadline: number } }> {
  const today = todayIn(entity.timezone, args.now);
  const conditions = [
    eq(tl.entityId, entity.id),
    eq(tl.direction, 'sales'),
    isNull(tl.certificateId),
    eq(tl.marketplaceFacilitated, false),
    sql`coalesce(${tl.exemptAmount}, 0) > 0`,
  ];
  if (args.from) conditions.push(gte(tl.taxDate, args.from));
  if (args.to) conditions.push(lte(tl.taxDate, args.to));
  const rows = await db.select().from(tl).where(and(...conditions));
  const docs = await describeDocuments(db, entity.id, rows);

  const byDocument = new Map<string, TaxLineRow[]>();
  for (const r of rows) {
    const key = documentKey(r);
    const list = byDocument.get(key);
    if (list) list.push(r);
    else byDocument.set(key, [r]);
  }
  const out: MissingCertificate[] = [];
  for (const [key, list] of byDocument) {
    const info = docs.get(key)!;
    const anchors = anchorRows(list);
    const first = anchors[0]!;
    const cure = missingCertificateCureDeadline(first.taxDate);
    out.push({
      documentType: info.type,
      documentId: info.id,
      documentNumber: info.number,
      customerId: first.contactId ?? info.contactId,
      customerName: info.contactName,
      stateCode: (first.shipToState || first.stateCode || '').toUpperCase() || null,
      saleDate: first.taxDate,
      exemptSales: sumMoney(anchors.map((a) => num(a.exemptAmount))),
      exemptReason: first.exemptReason,
      cureDeadline: cure,
      pastDeadline: cure < today,
      daysLeft: Math.round((new Date(`${cure}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000),
    });
  }
  out.sort((a, b) => a.cureDeadline.localeCompare(b.cureDeadline) || (a.documentNumber ?? '').localeCompare(b.documentNumber ?? ''));
  return {
    asOf: today,
    certificates: out,
    totals: {
      documents: out.length,
      exemptSales: sumMoney(out.map((m) => m.exemptSales)),
      pastDeadline: out.filter((m) => m.pastDeadline).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Provider reconciliation
// ---------------------------------------------------------------------------

export type ReconciliationStatus = 'ok' | 'missing_commit' | 'not_committed' | 'commit_failed' | 'ledger_mismatch' | 'no_ledger';

export interface ReconciliationDocument {
  documentType: string;
  documentId: string;
  documentNumber: string | null;
  date: string;
  engine: string | null;
  engineRef: string | null;
  committedAt: string | null;
  /** Tax the provider calculated for the document (its tax breakdown, else the document's total). */
  providerTax: number;
  ledgerTax: number;
  difference: number;
  status: ReconciliationStatus;
  severity: 'ok' | 'info' | 'error';
  message: string | null;
}

export interface ProviderReconciliation {
  engine: string;
  applicable: boolean;
  from: string;
  to: string;
  periods: Array<{
    period: string;
    documents: number;
    committed: number;
    uncommitted: number;
    providerTax: number;
    ledgerTax: number;
    difference: number;
    problems: number;
  }>;
  documents: ReconciliationDocument[];
  /** Only documents that need attention are listed unless `all` is requested. */
  notes: string[];
}

const PROVIDER_ENGINES = ['stripe_tax', 'avalara'];

/**
 * Compares what the provider engine was told with the tax ledger, per document
 * and per month. The engines expose no listing of their committed
 * transactions, so the provider side is what WeldBooks recorded when it
 * committed: the invoice's engine reference (`tax_engine_ref`), commit time
 * (`tax_committed_at`) and the tax of its breakdown. A document that was never
 * committed, a commit that failed (a warning on the invoice), or a ledger that
 * differs from the provider's tax is reported.
 */
export async function providerReconciliation(
  db: Database,
  entity: EntityRow,
  args: { from: string; to: string; all?: boolean },
): Promise<ProviderReconciliation> {
  const engine = entity.salesTaxEngine ?? 'manual';
  const notes = [
    'The provider API has no transaction listing here, so the provider side is what WeldBooks recorded when it committed each document: its engine reference, commit time and tax breakdown. Differences inside the provider account itself are not visible.',
  ];
  const empty: ProviderReconciliation = { engine, applicable: false, from: args.from, to: args.to, periods: [], documents: [], notes };
  if (!PROVIDER_ENGINES.includes(engine)) {
    return { ...empty, notes: ['This entity uses the manual engine; there is no provider to reconcile with.'] };
  }

  const inv = schema.invoices;
  const invoices = await db
    .select({
      id: inv.id,
      number: inv.invoiceNumber,
      type: inv.type,
      issueDate: inv.issueDate,
      taxEngine: inv.taxEngine,
      taxEngineRef: inv.taxEngineRef,
      committedAt: inv.taxCommittedAt,
      taxTotal: inv.taxTotal,
      breakdown: inv.taxBreakdown,
      warnings: inv.taxWarnings,
    })
    .from(inv)
    .where(
      and(
        eq(inv.entityId, entity.id),
        isNull(inv.deletedAt),
        inArray(inv.type, ['standard', 'correction', 'credit_note']),
        sql`${inv.journalEntryId} is not null`,
        gte(inv.issueDate, startOfDay(args.from)),
        lte(inv.issueDate, startOfDay(nextDay(args.to))),
      ),
    );

  const ledger = new Map<string, number>();
  for (const part of chunk(invoices.map((i) => i.id), 2000)) {
    const sums = await db
      .select({ sourceId: tl.sourceId, tax: sql<string>`sum(${tl.taxAmount})` })
      .from(tl)
      .where(and(eq(tl.entityId, entity.id), inArray(tl.sourceType, ['invoice', 'credit_note']), eq(tl.direction, 'sales'), inArray(tl.sourceId, part)))
      .groupBy(tl.sourceId);
    for (const s of sums) if (s.sourceId) ledger.set(s.sourceId, num(s.tax));
  }

  const documents: ReconciliationDocument[] = [];
  const periods = new Map<string, ProviderReconciliation['periods'][number]>();
  for (const i of invoices) {
    const sign = i.type === 'credit_note' ? -1 : 1;
    const breakdownTax = (i.breakdown ?? []).reduce((sum, r) => sum + (r.taxAmount ?? 0), 0);
    const providerTax = round2((i.breakdown && i.breakdown.length > 0 ? breakdownTax : num(i.taxTotal)) * sign);
    const ledgerTax = round2(ledger.get(i.id) ?? 0);
    const difference = round2(ledgerTax - providerTax);
    const committed = Boolean(i.taxEngineRef && i.committedAt);
    const commitFailed = (i.warnings ?? []).find((w) => /commit/i.test(w));

    let status: ReconciliationStatus = 'ok';
    let severity: ReconciliationDocument['severity'] = 'ok';
    let message: string | null = null;
    if (commitFailed) {
      status = 'commit_failed';
      severity = 'error';
      message = commitFailed;
    } else if (!ledger.has(i.id) && providerTax !== 0) {
      status = 'no_ledger';
      severity = 'error';
      message = 'The provider has tax for this document but the tax ledger has no rows for it.';
    } else if (Math.abs(difference) >= 0.01) {
      status = 'ledger_mismatch';
      severity = 'error';
      message = `The tax ledger (${ledgerTax.toFixed(2)}) differs from the tax the provider calculated (${providerTax.toFixed(2)}).`;
    } else if (!committed) {
      status = engine === 'avalara' ? 'missing_commit' : 'not_committed';
      severity = engine === 'avalara' ? 'error' : 'info';
      message = engine === 'avalara' ? 'The document was never committed to Avalara.' : 'The document was calculated by Stripe Tax but not recorded there.';
    }

    const date = i.issueDate.toISOString().slice(0, 10);
    documents.push({
      documentType: i.type === 'credit_note' ? 'credit_note' : 'invoice',
      documentId: i.id,
      documentNumber: i.number,
      date,
      engine: i.taxEngine,
      engineRef: i.taxEngineRef,
      committedAt: i.committedAt ? i.committedAt.toISOString() : null,
      providerTax,
      ledgerTax,
      difference,
      status,
      severity,
      message,
    });

    const month = date.slice(0, 7);
    const p = periods.get(month) ?? { period: month, documents: 0, committed: 0, uncommitted: 0, providerTax: 0, ledgerTax: 0, difference: 0, problems: 0 };
    p.documents += 1;
    if (committed) p.committed += 1;
    else p.uncommitted += 1;
    p.providerTax = round2(p.providerTax + providerTax);
    p.ledgerTax = round2(p.ledgerTax + ledgerTax);
    p.difference = round2(p.ledgerTax - p.providerTax);
    if (severity === 'error') p.problems += 1;
    periods.set(month, p);
  }
  documents.sort((a, b) => a.date.localeCompare(b.date) || (a.documentNumber ?? '').localeCompare(b.documentNumber ?? ''));
  return {
    engine,
    applicable: true,
    from: args.from,
    to: args.to,
    periods: [...periods.values()].sort((a, b) => a.period.localeCompare(b.period)),
    documents: args.all ? documents : documents.filter((d) => d.status !== 'ok'),
    notes,
  };
}
