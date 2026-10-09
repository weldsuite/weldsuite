/**
 * Drill-down from a return to the documents behind it: invoices, credit
 * memos, bills (use tax) and journal entries, each with the jurisdiction rows
 * it contributed and the exemption certificates it relied on.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { chunk, num, sumMoney, type TaxLineRow } from './common';
import type { LoadedEntry } from './rows';

const LEVEL_RANK: Record<string, number> = { state: 0, county: 1, city: 2, district: 3 };

export interface DocumentInfo {
  type: string;
  id: string | null;
  number: string | null;
  contactId: string | null;
  contactName: string | null;
  date: string | null;
  status: string | null;
  currency: string | null;
  description: string | null;
}

export function documentKey(row: Pick<TaxLineRow, 'sourceType' | 'sourceId' | 'journalEntryId'>): string {
  return `${row.sourceType}|${row.sourceId ?? row.journalEntryId}`;
}

const INVOICE_SOURCES = ['invoice', 'credit_note', 'write_off', 'bad_debt'];
const BILL_SOURCES = ['bill', 'bill_credit_note'];

function dayOf(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/** Number, counterparty and date of the documents the rows came from. */
export async function describeDocuments(
  db: Database,
  entityId: string,
  rows: Array<Pick<TaxLineRow, 'sourceType' | 'sourceId' | 'journalEntryId'>>,
): Promise<Map<string, DocumentInfo>> {
  const out = new Map<string, DocumentInfo>();
  const invoiceIds = new Set<string>();
  const billIds = new Set<string>();
  const entryIds = new Set<string>();
  for (const row of rows) {
    if (row.sourceId && INVOICE_SOURCES.includes(row.sourceType)) invoiceIds.add(row.sourceId);
    else if (row.sourceId && BILL_SOURCES.includes(row.sourceType)) billIds.add(row.sourceId);
    else entryIds.add(row.journalEntryId);
  }

  const invoices = new Map<string, DocumentInfo>();
  for (const part of chunk([...invoiceIds], 1000)) {
    const found = await db
      .select({
        id: schema.invoices.id,
        number: schema.invoices.invoiceNumber,
        contactId: schema.invoices.contactId,
        contactName: schema.invoices.contactName,
        issueDate: schema.invoices.issueDate,
        status: schema.invoices.status,
        currency: schema.invoices.currency,
        type: schema.invoices.type,
      })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.entityId, entityId), inArray(schema.invoices.id, part)));
    for (const r of found) {
      invoices.set(r.id, {
        type: r.type === 'credit_note' ? 'credit_note' : 'invoice',
        id: r.id,
        number: r.number,
        contactId: r.contactId,
        contactName: r.contactName,
        date: dayOf(r.issueDate),
        status: r.status,
        currency: r.currency,
        description: null,
      });
    }
  }
  const bills = new Map<string, DocumentInfo>();
  for (const part of chunk([...billIds], 1000)) {
    const found = await db
      .select({
        id: schema.bills.id,
        number: schema.bills.billNumber,
        contactId: schema.bills.contactId,
        contactName: schema.bills.contactName,
        issueDate: schema.bills.issueDate,
        status: schema.bills.status,
        currency: schema.bills.currency,
        type: schema.bills.type,
      })
      .from(schema.bills)
      .where(and(eq(schema.bills.entityId, entityId), inArray(schema.bills.id, part)));
    for (const r of found) {
      bills.set(r.id, {
        type: r.type === 'credit_note' ? 'bill_credit_note' : 'bill',
        id: r.id,
        number: r.number,
        contactId: r.contactId,
        contactName: r.contactName,
        date: dayOf(r.issueDate),
        status: r.status,
        currency: r.currency,
        description: null,
      });
    }
  }
  const entries = new Map<string, DocumentInfo>();
  for (const part of chunk([...entryIds], 1000)) {
    const found = await db
      .select({
        id: schema.journalEntries.id,
        number: schema.journalEntries.entryNumber,
        date: schema.journalEntries.date,
        description: schema.journalEntries.description,
        sourceType: schema.journalEntries.sourceType,
        status: schema.journalEntries.status,
      })
      .from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.entityId, entityId), inArray(schema.journalEntries.id, part)));
    for (const r of found) {
      entries.set(r.id, {
        type: 'journal_entry',
        id: r.id,
        number: r.number,
        contactId: null,
        contactName: null,
        date: dayOf(r.date),
        status: r.status,
        currency: null,
        description: r.description,
      });
    }
  }

  for (const row of rows) {
    const key = documentKey(row);
    if (out.has(key)) continue;
    const info =
      (row.sourceId && INVOICE_SOURCES.includes(row.sourceType) ? invoices.get(row.sourceId) : undefined) ??
      (row.sourceId && BILL_SOURCES.includes(row.sourceType) ? bills.get(row.sourceId) : undefined) ??
      entries.get(row.journalEntryId);
    out.set(
      key,
      info ?? {
        type: row.sourceType,
        id: row.sourceId,
        number: null,
        contactId: null,
        contactName: null,
        date: null,
        status: null,
        currency: null,
        description: null,
      },
    );
  }
  return out;
}

export interface DocumentRowDetail {
  taxLineId: string;
  sourceLineId: string | null;
  kind: 'sales' | 'use';
  jurisdictionCode: string | null;
  jurisdictionName: string | null;
  jurisdictionLevel: string | null;
  reportingCode: string | null;
  rate: number;
  grossAmount: number;
  taxableAmount: number;
  exemptAmount: number;
  nonTaxableAmount: number;
  taxAmount: number;
  exemptReason: string | null;
  certificateId: string | null;
  taxCode: string | null;
  shipToState: string | null;
  marketplaceFacilitated: boolean;
  /** Share of the row counted (cash basis). */
  share: number;
  carried: boolean;
}

export interface ReturnDocument {
  key: string;
  document: DocumentInfo;
  taxDate: string;
  grossSales: number;
  taxableSales: number;
  exemptSales: number;
  nonTaxableSales: number;
  tax: number;
  useTax: number;
  carried: boolean;
  certificateIds: string[];
  rows: DocumentRowDetail[];
}

function rank(level: string | null): number {
  return LEVEL_RANK[level ?? ''] ?? 4;
}

/** A document line's gross counts once: from its highest-level row. */
export function anchorRows<T extends { sourceLineId: string | null; jurisdictionLevel: string | null; jurisdictionCode: string | null }>(
  rows: T[],
): T[] {
  const byLine = new Map<string, T>();
  rows.forEach((row, index) => {
    const key = row.sourceLineId ?? `#${index}`;
    const current = byLine.get(key);
    if (
      !current ||
      rank(row.jurisdictionLevel) < rank(current.jurisdictionLevel) ||
      (rank(row.jurisdictionLevel) === rank(current.jurisdictionLevel) &&
        (row.jurisdictionCode ?? '') < (current.jurisdictionCode ?? ''))
    ) {
      byLine.set(key, row);
    }
  });
  return [...byLine.values()];
}

/** The documents behind a worksheet's rows, oldest first. */
export async function returnDocuments(db: Database, entityId: string, entries: LoadedEntry[]): Promise<ReturnDocument[]> {
  const info = await describeDocuments(db, entityId, entries.map((e) => e.row));
  const byDoc = new Map<string, LoadedEntry[]>();
  for (const e of entries) {
    const key = documentKey(e.row);
    const list = byDoc.get(key);
    if (list) list.push(e);
    else byDoc.set(key, [e]);
  }

  const out: ReturnDocument[] = [];
  for (const [key, list] of byDoc) {
    const details: DocumentRowDetail[] = list.map((e) => ({
      taxLineId: e.row.id,
      sourceLineId: e.row.sourceLineId,
      kind: e.row.direction === 'use' ? 'use' : 'sales',
      jurisdictionCode: e.row.jurisdictionCode,
      jurisdictionName: e.row.jurisdictionName,
      jurisdictionLevel: e.row.jurisdictionLevel,
      reportingCode: e.row.reportingCode,
      rate: num(e.row.rate),
      grossAmount: e.line.grossAmount ?? 0,
      taxableAmount: e.line.taxableAmount,
      exemptAmount: e.line.exemptAmount ?? 0,
      nonTaxableAmount: e.line.nonTaxableAmount ?? 0,
      taxAmount: e.line.taxAmount,
      exemptReason: e.row.exemptReason,
      certificateId: e.row.certificateId,
      taxCode: e.row.taxCode,
      shipToState: e.row.shipToState,
      marketplaceFacilitated: e.row.marketplaceFacilitated,
      share: e.scale,
      carried: e.carried,
    }));
    details.sort(
      (a, b) =>
        (a.sourceLineId ?? '').localeCompare(b.sourceLineId ?? '') ||
        rank(a.jurisdictionLevel) - rank(b.jurisdictionLevel) ||
        (a.jurisdictionName ?? '').localeCompare(b.jurisdictionName ?? ''),
    );
    const sales = details.filter((d) => d.kind === 'sales');
    const anchors = anchorRows(sales);
    const first = list[0]!.row;
    out.push({
      key,
      document: info.get(key)!,
      taxDate: first.taxDate,
      grossSales: sumMoney(anchors.map((a) => a.grossAmount)),
      taxableSales: sumMoney(anchors.map((a) => a.taxableAmount)),
      exemptSales: sumMoney(anchors.map((a) => a.exemptAmount)),
      nonTaxableSales: sumMoney(anchors.map((a) => a.nonTaxableAmount)),
      tax: sumMoney(sales.map((d) => d.taxAmount)),
      useTax: sumMoney(details.filter((d) => d.kind === 'use').map((d) => d.taxAmount)),
      carried: list.every((e) => e.carried),
      certificateIds: [...new Set(details.map((d) => d.certificateId).filter((id): id is string => Boolean(id)))],
      rows: details,
    });
  }
  return out.sort(
    (a, b) => a.taxDate.localeCompare(b.taxDate) || (a.document.number ?? a.key).localeCompare(b.document.number ?? b.key),
  );
}

export interface CertificateRef {
  id: string;
  certificateNumber: string | null;
  reason: string;
  states: string[];
  expiresOn: string | null;
  status: string;
}

export async function loadCertificateRefs(db: Database, entityId: string, ids: string[]): Promise<CertificateRef[]> {
  const out: CertificateRef[] = [];
  for (const part of chunk([...new Set(ids)], 1000)) {
    const found = await db
      .select({
        id: schema.exemptionCertificates.id,
        certificateNumber: schema.exemptionCertificates.certificateNumber,
        reason: schema.exemptionCertificates.reason,
        states: schema.exemptionCertificates.states,
        expiresOn: schema.exemptionCertificates.expiresOn,
        status: schema.exemptionCertificates.status,
      })
      .from(schema.exemptionCertificates)
      .where(and(eq(schema.exemptionCertificates.entityId, entityId), inArray(schema.exemptionCertificates.id, part)));
    out.push(...found.map((f) => ({ ...f, states: f.states ?? [] })));
  }
  return out;
}
