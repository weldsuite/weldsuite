/**
 * Checks before filing (docs/plans/weldbooks-us.md §5).
 *
 * Pre-file check: the return's net sales against the income posted for the
 * agency's state shipments, with the documents behind any difference.
 * Liability check: the agency's payable account in the general ledger against
 * what the tax ledger says is owed (unfiled rows plus filed, unpaid returns),
 * with the journal entries that explain a difference.
 */

import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { BOOKED_STATUSES, accountForRole, loadEntityAccounts } from '../accounting-posting';
import {
  FILED_STATUSES,
  chunk,
  nextDay,
  num,
  round2,
  startOfDay,
  stateOfAddress,
  sumMoney,
  type AgencyRow,
  type EntityRow,
  type ReturnRow,
} from './common';
import { calculateReturn } from './calculate';
import { anchorRows } from './documents';
import { loadAgencyReturns } from './periods';
import { owedByFiledReturn, settledAgainstPayable } from './payment';

// ---------------------------------------------------------------------------
// Liability check
// ---------------------------------------------------------------------------

export interface LiabilityItem {
  journalEntryId: string;
  entryNumber: string | null;
  date: string;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /** Credit minus debit on the agency's payable accounts. */
  glAmount: number;
  /** What the tax ledger (and a paid return) explains. */
  expectedAmount: number;
  difference: number;
}

export interface AgencyLiability {
  agencyId: string;
  asOf: string;
  accounts: Array<{ id: string; code: string; name: string }>;
  /** The agency has no payable account of its own; the shared account holds other agencies' tax too. */
  sharedAccount: boolean;
  /** Credit balance of the payable accounts in the general ledger. */
  glBalance: number;
  /** Every tax-ledger row of the agency up to the date: sales tax charged and use tax accrued. */
  collectedTax: number;
  /** Tax settled by paid returns. */
  paidTax: number;
  /** Tax owed on filed returns that are not paid yet. */
  filedUnpaidTax: number;
  /** Tax of rows no return has counted yet (collected - paid - filed unpaid). */
  unfiledTax: number;
  /** What the payable should hold: collected - paid. */
  expectedBalance: number;
  difference: number;
  items: LiabilityItem[];
  warnings: string[];
}

function endOfDayExclusive(day: string): Date {
  return startOfDay(nextDay(day));
}

/** Returns that count as filed (and paid) on a date, from their timestamps. */
export function statusAsOf(ret: ReturnRow, asOf: string): 'unfiled' | 'filed' | 'paid' {
  const end = endOfDayExclusive(asOf);
  if (ret.paidAt && ret.paidAt < end && ret.status === 'paid') return 'paid';
  if (ret.filedAt && ret.filedAt < end && FILED_STATUSES.includes(ret.status)) return 'filed';
  return 'unfiled';
}

export async function agencyLiability(
  db: Database,
  args: { entityId: string; agency: AgencyRow; asOf: string; withItems?: boolean; returns?: ReturnRow[] },
): Promise<AgencyLiability> {
  const { entityId, agency, asOf } = args;
  const accounts = await loadEntityAccounts(db, entityId);
  const own = [accounts.byId(agency.liabilityAccountId), accounts.byId(agency.useTaxAccountId)].filter(
    (a): a is NonNullable<typeof a> => Boolean(a),
  );
  const warnings: string[] = [];
  let payable = own;
  let shared = false;
  if (own.length === 0) {
    shared = true;
    payable = [accountForRole(accounts, 'sales_tax_payable', ['2200']), accountForRole(accounts, 'use_tax_payable', ['2210'])].filter(
      (a): a is NonNullable<typeof a> => Boolean(a),
    );
    warnings.push('This agency has no payable account of its own; the check compares the shared sales tax payable account.');
  }
  const accountIds = payable.map((a) => a.id);
  const before = endOfDayExclusive(asOf);

  const je = schema.journalEntries;
  const jl = schema.journalLines;
  const glRows = accountIds.length
    ? await db
        .select({
          journalEntryId: je.id,
          entryNumber: je.entryNumber,
          date: je.date,
          description: je.description,
          sourceType: je.sourceType,
          sourceId: je.sourceId,
          net: sql<string>`sum(coalesce(${jl.credit}, 0) - coalesce(${jl.debit}, 0))`,
        })
        .from(jl)
        .innerJoin(je, eq(je.id, jl.journalEntryId))
        .where(
          and(
            eq(jl.entityId, entityId),
            inArray(jl.accountId, accountIds),
            isNull(jl.deletedAt),
            isNull(je.deletedAt),
            inArray(je.status, BOOKED_STATUSES),
            lt(je.date, before),
          ),
        )
        .groupBy(je.id, je.entryNumber, je.date, je.description, je.sourceType, je.sourceId)
    : [];
  const glBalance = sumMoney(glRows.map((r) => num(r.net)));

  const tl = schema.taxLines;
  const ledgerRows = await db
    .select({
      journalEntryId: tl.journalEntryId,
      tax: sql<string>`sum(${tl.taxAmount})`,
    })
    .from(tl)
    .where(
      and(
        eq(tl.entityId, entityId),
        eq(tl.agencyId, agency.id),
        inArray(tl.direction, ['sales', 'use']),
        sql`${tl.taxDate} < ${nextDay(asOf)}`,
      ),
    )
    .groupBy(tl.journalEntryId);
  const returns = args.returns ?? (await loadAgencyReturns(db, entityId, agency.id));

  const taxByEntry = new Map<string, number>();
  for (const row of ledgerRows) taxByEntry.set(row.journalEntryId, (taxByEntry.get(row.journalEntryId) ?? 0) + num(row.tax));
  const collectedTax = sumMoney(taxByEntry.values());
  const paidTax = sumMoney(returns.filter((r) => statusAsOf(r, asOf) === 'paid').map((r) => settledAgainstPayable(r)));
  const filedUnpaid = sumMoney(returns.filter((r) => statusAsOf(r, asOf) === 'filed').map((r) => owedByFiledReturn({ ...r, status: 'filed' })));
  const expectedBalance = round2(collectedTax - paidTax);

  const items: LiabilityItem[] = [];
  if (args.withItems !== false) {
    const gl = new Map(glRows.map((r) => [r.journalEntryId, r]));
    const settledByPayment = new Map<string, number>();
    for (const r of returns) if (statusAsOf(r, asOf) === 'paid') settledByPayment.set(r.id, settledAgainstPayable(r));
    const entryIds = new Set<string>([...gl.keys(), ...taxByEntry.keys()]);
    for (const id of entryIds) {
      const row = gl.get(id);
      const glAmount = round2(num(row?.net));
      const taxAmount = taxByEntry.get(id) ?? 0;
      const settled = row?.sourceType === 'tax_return' && row.sourceId ? (settledByPayment.get(row.sourceId) ?? 0) : 0;
      const expectedAmount = round2(taxAmount - settled);
      const difference = round2(glAmount - expectedAmount);
      if (Math.abs(difference) < 0.005) continue;
      items.push({
        journalEntryId: id,
        entryNumber: row?.entryNumber ?? null,
        date: row ? row.date.toISOString().slice(0, 10) : '',
        description: row?.description ?? null,
        sourceType: row?.sourceType ?? null,
        sourceId: row?.sourceId ?? null,
        glAmount,
        expectedAmount,
        difference,
      });
    }
    items.sort((a, b) => a.date.localeCompare(b.date) || a.journalEntryId.localeCompare(b.journalEntryId));
    // Entries only the tax ledger knows have no date yet.
    const undated = items.filter((i) => !i.date);
    if (undated.length > 0) {
      const found = await db
        .select({ id: je.id, entryNumber: je.entryNumber, date: je.date, description: je.description, sourceType: je.sourceType, sourceId: je.sourceId })
        .from(je)
        .where(inArray(je.id, undated.map((i) => i.journalEntryId)));
      for (const f of found) {
        const item = items.find((i) => i.journalEntryId === f.id);
        if (item) Object.assign(item, { entryNumber: f.entryNumber, date: f.date.toISOString().slice(0, 10), description: f.description, sourceType: f.sourceType, sourceId: f.sourceId });
      }
    }
  }

  return {
    agencyId: agency.id,
    asOf,
    accounts: payable.map((a) => ({ id: a.id, code: a.code, name: a.name })),
    sharedAccount: shared,
    glBalance,
    collectedTax,
    paidTax,
    filedUnpaidTax: filedUnpaid,
    unfiledTax: round2(expectedBalance - filedUnpaid),
    expectedBalance,
    difference: round2(glBalance - expectedBalance),
    items,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Pre-file check
// ---------------------------------------------------------------------------

export interface FindingDocument {
  documentType: 'invoice' | 'credit_note' | 'journal_entry';
  documentId: string;
  number: string | null;
  date: string;
  contactName: string | null;
  /** Income posted (invoice lines, or the journal entry's revenue). */
  amount: number;
  /** Gross sales the return counts for it. */
  returnAmount?: number;
  reason: string;
}

export interface PreFileFinding {
  code: 'net_sales_difference' | 'income_without_tax_data' | 'missing_ship_to' | 'payable_direct_entries';
  severity: 'error' | 'warning';
  message: string;
  count: number;
  amount: number;
  documents: FindingDocument[];
  /** More documents than `documents` lists. */
  truncated: boolean;
}

export interface PreFileCheck {
  returnId: string;
  agencyId: string;
  stateCode: string;
  periodStart: string;
  periodEnd: string;
  /** Return net sales against the income of invoices shipped to the state (not compared on a cash basis). */
  comparison: { returnNetSales: number; incomeShippedToState: number; difference: number } | null;
  skipped: string[];
  findings: PreFileFinding[];
  ok: boolean;
}

const LIST_LIMIT = 50;

interface InvoiceFacts {
  id: string;
  number: string | null;
  type: string;
  date: string;
  contactName: string | null;
  shipToState: string;
  income: number;
}

async function periodInvoices(db: Database, entityId: string, start: string, end: string): Promise<InvoiceFacts[]> {
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
    })
    .from(inv)
    .where(
      and(
        eq(inv.entityId, entityId),
        isNull(inv.deletedAt),
        inArray(inv.type, ['standard', 'correction', 'credit_note']),
        sql`${inv.journalEntryId} is not null`,
        gte(inv.issueDate, startOfDay(start)),
        lt(inv.issueDate, startOfDay(nextDay(end))),
      ),
    );
  const incomeById = new Map<string, number>();
  for (const part of chunk(
    invoices.map((i) => i.id),
    2000,
  )) {
    const rows = await db
      .select({ invoiceId: schema.invoiceItems.invoiceId, total: sql<string>`sum(coalesce(${schema.invoiceItems.lineTotal}, 0))` })
      .from(schema.invoiceItems)
      .where(and(inArray(schema.invoiceItems.invoiceId, part), isNull(schema.invoiceItems.deletedAt)))
      .groupBy(schema.invoiceItems.invoiceId);
    for (const r of rows) incomeById.set(r.invoiceId, num(r.total));
  }
  return invoices.map((i) => ({
    id: i.id,
    number: i.number,
    type: i.type,
    date: i.issueDate.toISOString().slice(0, 10),
    contactName: i.contactName,
    shipToState: stateOfAddress(i.shipping) || stateOfAddress(i.billing),
    income: round2((incomeById.get(i.id) ?? 0) * (i.type === 'credit_note' ? -1 : 1)),
  }));
}

function finding(
  code: PreFileFinding['code'],
  severity: PreFileFinding['severity'],
  message: string,
  documents: FindingDocument[],
): PreFileFinding {
  return {
    code,
    severity,
    message,
    count: documents.length,
    amount: sumMoney(documents.map((d) => d.amount)),
    documents: documents.slice(0, LIST_LIMIT),
    truncated: documents.length > LIST_LIMIT,
  };
}

export async function preFileCheck(
  db: Database,
  args: { entity: EntityRow; agency: AgencyRow; ret: ReturnRow; now?: Date },
): Promise<PreFileCheck> {
  const { entity, agency, ret } = args;
  const entityId = entity.id;
  const isFiled = FILED_STATUSES.includes(ret.status);

  // The ledger rows behind the return: freshly calculated until it is filed.
  let documentGross = new Map<string, number>();
  let counted = false;
  if (!isFiled) {
    const calc = await calculateReturn(db, { entity, agency, ret, now: args.now });
    const byDoc = new Map<string, typeof calc.rows.entries>();
    for (const e of calc.rows.entries) {
      if (e.carried || ['write_off', 'bad_debt'].includes(e.row.sourceType) || e.row.direction === 'use') continue;
      const key = `${e.row.sourceType === 'credit_note' ? 'credit_note' : 'invoice'}|${e.row.sourceId ?? e.row.journalEntryId}`;
      const list = byDoc.get(key);
      if (list) list.push(e);
      else byDoc.set(key, [e]);
    }
    for (const [key, list] of byDoc) {
      const anchors = anchorRows(list.map((e) => ({ ...e, sourceLineId: e.row.sourceLineId, jurisdictionLevel: e.row.jurisdictionLevel, jurisdictionCode: e.row.jurisdictionCode })));
      documentGross.set(key, sumMoney(anchors.map((a) => a.line.grossAmount ?? 0)));
    }
    counted = true;
  } else {
    documentGross = new Map();
  }

  const skipped: string[] = [];
  const findings: PreFileFinding[] = [];
  const invoices = await periodInvoices(db, entityId, ret.periodStart, ret.periodEnd);
  const toState = invoices.filter((i) => i.shipToState === agency.stateCode.toUpperCase());

  // 1. Net sales on the return against income of the invoices shipped to the state.
  let comparison: PreFileCheck['comparison'] = null;
  if (agency.reportingBasis === 'cash') {
    skipped.push('net_sales_difference: a cash-basis return counts sales when paid, so it does not match income of the period');
  } else if (!counted) {
    skipped.push('net_sales_difference: the return is already filed');
  } else {
    const docs: FindingDocument[] = [];
    let returnNet = 0;
    for (const v of documentGross.values()) returnNet += v;
    const incomeShipped = sumMoney(toState.map((i) => i.income));
    for (const invoice of toState) {
      const key = `${invoice.type === 'credit_note' ? 'credit_note' : 'invoice'}|${invoice.id}`;
      const ledger = documentGross.get(key);
      const difference = round2(invoice.income - (ledger ?? 0));
      if (Math.abs(difference) < 0.01) continue;
      docs.push({
        documentType: invoice.type === 'credit_note' ? 'credit_note' : 'invoice',
        documentId: invoice.id,
        number: invoice.number,
        date: invoice.date,
        contactName: invoice.contactName,
        amount: invoice.income,
        returnAmount: ledger ?? 0,
        reason: ledger === undefined ? 'No tax-ledger rows for this agency: its income is not on the return' : 'Income differs from the sales the return counts',
      });
    }
    comparison = { returnNetSales: round2(returnNet), incomeShippedToState: incomeShipped, difference: round2(incomeShipped - returnNet) };
    if (comparison.difference !== 0 || docs.length > 0) {
      findings.push(
        finding(
          'net_sales_difference',
          'error',
          `Income of invoices shipped to ${agency.stateCode} (${incomeShipped.toFixed(2)}) differs from the net sales on the return (${round2(returnNet).toFixed(2)}).`,
          docs,
        ),
      );
    }
  }

  // 2. Income posted without tax data: revenue entries of the period with no tax-ledger rows at all.
  const je = schema.journalEntries;
  const jl = schema.journalLines;
  const revenue = await db
    .select({
      id: je.id,
      entryNumber: je.entryNumber,
      date: je.date,
      description: je.description,
      sourceType: je.sourceType,
      sourceId: je.sourceId,
      amount: sql<string>`sum(coalesce(${jl.credit}, 0) - coalesce(${jl.debit}, 0))`,
    })
    .from(jl)
    .innerJoin(je, eq(je.id, jl.journalEntryId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, jl.accountId))
    .where(
      and(
        eq(jl.entityId, entityId),
        isNull(jl.deletedAt),
        isNull(je.deletedAt),
        inArray(je.status, BOOKED_STATUSES),
        eq(schema.accounts.type, 'revenue'),
        gte(je.date, startOfDay(ret.periodStart)),
        lt(je.date, startOfDay(nextDay(ret.periodEnd))),
        sql`not exists (select 1 from ${schema.taxLines} t where t.journal_entry_id = ${je.id})`,
      ),
    )
    .groupBy(je.id, je.entryNumber, je.date, je.description, je.sourceType, je.sourceId)
    .having(sql`sum(coalesce(${jl.credit}, 0) - coalesce(${jl.debit}, 0)) <> 0`);
  if (revenue.length > 0) {
    findings.push(
      finding(
        'income_without_tax_data',
        'warning',
        'Income was posted in this period without sales tax data (no tax-ledger rows). It is not on any return.',
        revenue.map((r) => ({
          documentType: r.sourceType === 'invoice' ? 'invoice' : r.sourceType === 'credit_note' ? 'credit_note' : 'journal_entry',
          documentId: r.sourceType === 'invoice' || r.sourceType === 'credit_note' ? (r.sourceId ?? r.id) : r.id,
          number: r.entryNumber,
          date: r.date.toISOString().slice(0, 10),
          contactName: null,
          amount: round2(num(r.amount)),
          reason: r.description ?? 'Income without tax data',
        })),
      ),
    );
  }

  // 3. Invoices of the period with no ship-to (or bill-to) state: the tax cannot be sourced.
  const noState = invoices.filter((i) => i.shipToState === '');
  if (noState.length > 0) {
    findings.push(
      finding(
        'missing_ship_to',
        'warning',
        'Invoices have no ship-to or bill-to state, so their sales cannot be reported to any state.',
        noState.map((i) => ({
          documentType: i.type === 'credit_note' ? 'credit_note' : 'invoice',
          documentId: i.id,
          number: i.number,
          date: i.date,
          contactName: i.contactName,
          amount: i.income,
          reason: 'No ship-to state',
        })),
      ),
    );
  }

  // 4. Journal entries hitting the agency's payable directly (not through a document or a return payment).
  const payableIds = [agency.liabilityAccountId, agency.useTaxAccountId].filter((id): id is string => Boolean(id));
  if (payableIds.length === 0) {
    skipped.push('payable_direct_entries: the agency has no payable account of its own');
  } else {
    const direct = await db
      .select({
        id: je.id,
        entryNumber: je.entryNumber,
        date: je.date,
        description: je.description,
        amount: sql<string>`sum(coalesce(${jl.credit}, 0) - coalesce(${jl.debit}, 0))`,
      })
      .from(jl)
      .innerJoin(je, eq(je.id, jl.journalEntryId))
      .where(
        and(
          eq(jl.entityId, entityId),
          inArray(jl.accountId, payableIds),
          isNull(jl.deletedAt),
          isNull(je.deletedAt),
          inArray(je.status, BOOKED_STATUSES),
          gte(je.date, startOfDay(ret.periodStart)),
          lt(je.date, startOfDay(nextDay(ret.periodEnd))),
          sql`${je.sourceType} is distinct from 'tax_return'`,
          sql`not exists (select 1 from ${schema.taxLines} t where t.journal_entry_id = ${je.id} and t.agency_id = ${agency.id})`,
        ),
      )
      .groupBy(je.id, je.entryNumber, je.date, je.description);
    if (direct.length > 0) {
      findings.push(
        finding(
          'payable_direct_entries',
          'warning',
          'Journal entries moved the agency payable account directly. Their amounts are not on the return.',
          direct.map((r) => ({
            documentType: 'journal_entry' as const,
            documentId: r.id,
            number: r.entryNumber,
            date: r.date.toISOString().slice(0, 10),
            contactName: null,
            amount: round2(num(r.amount)),
            reason: r.description ?? 'Direct entry on the payable account',
          })),
        ),
      );
    }
  }

  return {
    returnId: ret.id,
    agencyId: agency.id,
    stateCode: agency.stateCode,
    periodStart: ret.periodStart,
    periodEnd: ret.periodEnd,
    comparison,
    skipped,
    findings,
    ok: findings.length === 0,
  };
}
