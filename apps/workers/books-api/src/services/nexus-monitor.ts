/**
 * Economic nexus monitor (docs/plans/weldbooks-us.md §10, phase 6).
 *
 * Sales into each state are read from the tax ledger (every sales row, zero-tax
 * rows of states without a registration and marketplace-facilitated sales
 * included), grouped per document and state so a document is one transaction.
 * Invoices that wrote no ledger rows fall back to their ship-to (else bill-to)
 * state and subtotal. Each state is measured with its own rule (threshold,
 * window and base from `nexus-thresholds`) by the domain's `nexusMonitor`; the
 * "register" button of the UI opens an agency through the agencies route.
 */

import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  getNexusRule,
  nexusMonitoredCodes,
  type NexusRule,
} from '@weldsuite/books-domain/jurisdictions/us/nexus-thresholds';
import {
  nexusMonitor,
  type NexusMonitorRow,
  type NexusSale,
} from '@weldsuite/books-domain/us-compliance/nexus';
import { addMonths, endOfMonth, startOfMonth } from '@weldsuite/books-domain/us-compliance/dates';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  nextDay,
  num,
  round2,
  registeredOn,
  startOfDay,
  stateOfAddress,
  sumMoney,
  todayIn,
  type AgencyRow,
  type EntityRow,
  type TaxLineRow,
} from './sales-tax-returns/common';
import { loadAgencies } from './sales-tax-returns/context';
import { anchorRows, documentKey } from './sales-tax-returns/documents';

/** One document's sales into one state, in the amounts each nexus base needs. */
export interface NexusDocument {
  key: string;
  date: string;
  stateCode: string;
  gross: number;
  /** Sales that are taxable in the state (gross less exempt and non-taxable parts). */
  taxable: number;
  /** Gross less sales for resale. */
  retail: number;
  marketplaceFacilitated: boolean;
}

const tl = schema.taxLines;

/** How far back the measurements can look: last year's calendar year, Connecticut's October to September. */
export function historyStart(asOf: string): string {
  return `${Number(asOf.slice(0, 4)) - 2}-01-01`;
}

export async function loadNexusDocuments(db: Database, entityId: string, asOf: string): Promise<NexusDocument[]> {
  const from = historyStart(asOf);
  const rows = await db
    .select()
    .from(tl)
    .where(and(eq(tl.entityId, entityId), eq(tl.direction, 'sales'), gte(tl.taxDate, from), lte(tl.taxDate, asOf)));

  const docs: NexusDocument[] = [];
  const byDocument = new Map<string, TaxLineRow[]>();
  for (const r of rows) {
    const key = documentKey(r);
    const list = byDocument.get(key);
    if (list) list.push(r);
    else byDocument.set(key, [r]);
  }
  for (const [key, list] of byDocument) {
    const byState = new Map<string, TaxLineRow[]>();
    for (const anchor of anchorRows(list)) {
      const state = (anchor.shipToState || anchor.stateCode || '').trim().toUpperCase();
      if (!state) continue;
      const bucket = byState.get(state);
      if (bucket) bucket.push(anchor);
      else byState.set(state, [anchor]);
    }
    for (const [stateCode, anchors] of byState) {
      const gross = sumMoney(anchors.map((a) => num(a.grossAmount)));
      const exempt = sumMoney(anchors.map((a) => num(a.exemptAmount)));
      const resale = sumMoney(anchors.filter((a) => a.exemptReason === 'resale').map((a) => num(a.exemptAmount)));
      const nonTaxable = sumMoney(anchors.map((a) => num(a.nonTaxableAmount)));
      docs.push({
        key,
        date: anchors[0]!.taxDate,
        stateCode,
        gross,
        taxable: round2(gross - exempt - nonTaxable),
        retail: round2(gross - resale),
        marketplaceFacilitated: anchors.some((a) => a.marketplaceFacilitated),
      });
    }
  }

  // Invoices that wrote no ledger rows: their ship-to (else bill-to) state and subtotal.
  const inv = schema.invoices;
  const bare = await db
    .select({
      id: inv.id,
      type: inv.type,
      issueDate: inv.issueDate,
      subtotal: inv.subtotal,
      shipping: inv.shippingAddress,
      billing: inv.billingAddress,
      marketplace: inv.marketplaceFacilitated,
    })
    .from(inv)
    .where(
      and(
        eq(inv.entityId, entityId),
        isNull(inv.deletedAt),
        inArray(inv.type, ['standard', 'correction', 'credit_note']),
        sql`${inv.journalEntryId} is not null`,
        gte(inv.issueDate, startOfDay(from)),
        lte(inv.issueDate, startOfDay(nextDay(asOf))),
        sql`not exists (select 1 from ${tl} t where t.source_id = ${inv.id} and t.source_type in ('invoice', 'credit_note'))`,
      ),
    );
  for (const i of bare) {
    const stateCode = stateOfAddress(i.shipping) || stateOfAddress(i.billing);
    if (!stateCode) continue;
    const amount = round2(num(i.subtotal) * (i.type === 'credit_note' ? -1 : 1));
    docs.push({
      key: `invoice|${i.id}`,
      date: i.issueDate.toISOString().slice(0, 10),
      stateCode,
      gross: amount,
      taxable: amount,
      retail: amount,
      marketplaceFacilitated: Boolean(i.marketplace),
    });
  }
  return docs;
}

/** The sales a state's rule counts: the amount of its base, one entry per document. */
export function salesForRule(rule: NexusRule, docs: readonly NexusDocument[]): NexusSale[] {
  return docs
    .filter((d) => d.stateCode === rule.stateCode)
    .map((d) => ({
      date: d.date,
      amount: rule.base === 'gross' ? d.gross : rule.base === 'retail' ? d.retail : d.taxable,
      stateCode: d.stateCode,
      marketplaceFacilitated: d.marketplaceFacilitated,
      // The amount is already of the rule's base.
      taxable: true,
      retail: true,
    }));
}

export interface NexusRow extends NexusMonitorRow {
  /** The agency that registers the business in the state, when there is one. */
  agencyId: string | null;
  agencyStatus: string | null;
  base: NexusRule['base'];
  comparison: NexusRule['comparison'];
  test: NexusRule['test'];
  sourceUrl: string;
  ruleNotes: string | null;
}

function agencyFor(agencies: AgencyRow[], stateCode: string): AgencyRow | undefined {
  return (
    agencies.find((a) => a.stateCode.toUpperCase() === stateCode && a.status === 'registered') ??
    agencies.find((a) => a.stateCode.toUpperCase() === stateCode)
  );
}

export interface NexusOverview {
  asOf: string;
  rows: NexusRow[];
  summary: { exceededUnregistered: number; approaching: number; exceededRegistered: number; monitored: number };
}

function measure(code: string, docs: NexusDocument[], asOf: string, agencies: AgencyRow[]): NexusRow | undefined {
  const rule = getNexusRule(code, asOf);
  if (!rule || !rule.hasSalesTax) return undefined;
  const registered = registeredOn(agencies, code, asOf) ? [code] : [];
  const [row] = nexusMonitor([code], salesForRule(rule, docs), asOf, registered);
  if (!row) return undefined;
  const agency = agencyFor(agencies, code);
  return {
    ...row,
    agencyId: agency?.id ?? null,
    agencyStatus: agency?.status ?? null,
    base: rule.base,
    comparison: rule.comparison,
    test: rule.test,
    sourceUrl: rule.sourceUrl,
    ruleNotes: rule.notes ?? null,
  };
}

/** Every state with a sales tax measured against its own rule, nearest to its threshold first. */
export async function nexusOverview(db: Database, entity: EntityRow, asOfInput?: string, now?: Date): Promise<NexusOverview> {
  const asOf = asOfInput ?? todayIn(entity.timezone, now);
  const [docs, agencies] = await Promise.all([loadNexusDocuments(db, entity.id, asOf), loadAgencies(db, entity.id)]);
  const rows = nexusMonitoredCodes()
    .map((code) => measure(code, docs, asOf, agencies))
    .filter((r): r is NexusRow => r !== undefined)
    .sort((a, b) => b.percentOfThreshold - a.percentOfThreshold || a.stateCode.localeCompare(b.stateCode));
  return {
    asOf,
    rows,
    summary: {
      exceededUnregistered: rows.filter((r) => r.alert === 'register').length,
      approaching: rows.filter((r) => r.alert === 'watch').length,
      exceededRegistered: rows.filter((r) => r.alert === 'registered').length,
      monitored: rows.length,
    },
  };
}

export interface NexusMonth {
  month: string;
  /** Sales of the rule's base (negative with credit memos). */
  sales: number;
  gross: number;
  taxable: number;
  transactions: number;
  marketplaceSales: number;
}

export interface NexusDetail extends NexusRow {
  rule: {
    effectiveFrom: string;
    salesThreshold: number | null;
    transactionThreshold: number | null;
    test: NexusRule['test'];
    comparison: NexusRule['comparison'];
    base: NexusRule['base'];
    window: NexusRule['window'];
    marketplaceSalesCount: boolean;
  };
  monthly: NexusMonth[];
}

/** One state: the measurement and the months of sales behind it. */
export async function nexusDetail(
  db: Database,
  entity: EntityRow,
  stateCode: string,
  asOfInput?: string,
  now?: Date,
): Promise<NexusDetail | undefined> {
  const code = stateCode.trim().toUpperCase();
  const asOf = asOfInput ?? todayIn(entity.timezone, now);
  const [docs, agencies] = await Promise.all([loadNexusDocuments(db, entity.id, asOf), loadAgencies(db, entity.id)]);
  const row = measure(code, docs, asOf, agencies);
  const rule = getNexusRule(code, asOf);
  if (!row || !rule) return undefined;

  const stateDocs = docs.filter((d) => d.stateCode === code);
  const starts = row.periods.map((p) => p.from).sort();
  const ends = row.periods.map((p) => p.to).sort();
  const from = starts[0] ?? row.window.from;
  const to = ends[ends.length - 1] ?? row.window.to;
  const monthly: NexusMonth[] = [];
  for (let month = startOfMonth(from); month <= to; month = addMonths(month, 1)) {
    const end = endOfMonth(month);
    const inMonth = stateDocs.filter((d) => d.date >= month && d.date <= end);
    const counted = inMonth.filter((d) => !d.marketplaceFacilitated || rule.marketplaceSalesCount);
    monthly.push({
      month: month.slice(0, 7),
      sales: sumMoney(counted.map((d) => (rule.base === 'gross' ? d.gross : rule.base === 'retail' ? d.retail : d.taxable))),
      gross: sumMoney(inMonth.map((d) => d.gross)),
      taxable: sumMoney(inMonth.map((d) => d.taxable)),
      transactions: counted.filter((d) => (rule.base === 'gross' ? d.gross : rule.base === 'retail' ? d.retail : d.taxable) > 0).length,
      marketplaceSales: sumMoney(inMonth.filter((d) => d.marketplaceFacilitated).map((d) => d.gross)),
    });
  }
  return {
    ...row,
    rule: {
      effectiveFrom: rule.effectiveFrom,
      salesThreshold: rule.salesThreshold,
      transactionThreshold: rule.transactionThreshold,
      test: rule.test,
      comparison: rule.comparison,
      base: rule.base,
      window: rule.window,
      marketplaceSalesCount: rule.marketplaceSalesCount,
    },
    monthly,
  };
}
