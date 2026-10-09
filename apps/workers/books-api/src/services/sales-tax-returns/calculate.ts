/**
 * Calculating a return: the worksheet from the agency's tax-ledger rows, the
 * vendor discount proposal, and the total due.
 *
 * What a calculation stores on the return (`tax_returns.summary`):
 *   - the worksheet (gross sales, deductions by reason, taxable sales, tax and
 *     use tax due) and the number of ledger rows behind it;
 *   - `salesTaxPayable` / `useTaxPayable`: what this return pays. They equal the
 *     tax due, except on an amended return, which pays only the difference to
 *     what the return it amends already reported (`previouslyReported`);
 *   - `uncuredTaxPayable`: tax on exempt sales that have no certificate after
 *     the 90-day cure period. It is counted as taxable on the worksheet, but it
 *     was never collected, so paying it is an expense, not a liability payment;
 *   - `carriedForward`: rows of an earlier, filed period this return picks up;
 *   - `warnings` for the user to read before filing.
 */

import { and, eq, isNull, lt } from 'drizzle-orm';
import {
  buildUsSalesTaxWorksheet,
  type SalesTaxWorksheet,
} from '@weldsuite/books-domain/jurisdictions/us/sales-tax-return';
import { getUsState, type VendorDiscountRule } from '@weldsuite/books-domain/jurisdictions/us/states';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  ADJUSTMENT_TYPES,
  computeTotalDue,
  num,
  round2,
  sumMoney,
  todayIn,
  type AgencyRow,
  type EntityRow,
  type ReturnAdjustment,
  type ReturnRow,
} from './common';
import { loadWorksheetRows, type LoadedRows } from './rows';

export interface VendorDiscountProposal {
  /** The state has a vendor discount rule. */
  available: boolean;
  /** Dollars the discount would be on the sales tax of the worksheet (positive). */
  amount: number;
  /** The discount only holds when the return is filed and paid by this date. */
  requiresTimelyFilingBy: string | null;
  /** Today is already past the due date: not proposed. */
  late: boolean;
  note: string | null;
}

export interface ReturnSummary {
  reportingBasis: 'accrual' | 'cash';
  method: string;
  grossSales: number;
  deductions: SalesTaxWorksheet['deductions'];
  totalDeductions: number;
  taxableSales: number;
  salesTaxDue: number;
  useTaxDue: number;
  totalTaxDue: number;
  documentCount: number;
  rowCount: number;
  uncuredExempt: SalesTaxWorksheet['uncuredExempt'];
  /** Paid by this return (the whole tax due, or the increase over the return it amends). */
  salesTaxPayable: number;
  useTaxPayable: number;
  uncuredTaxPayable: number;
  carriedForward?: { returnIds: string[]; rowCount: number; taxAmount: number };
  previouslyReported?: { returnId: string; salesTaxDue: number; useTaxDue: number; uncuredTax: number };
  vendorDiscount: VendorDiscountProposal;
  warnings: string[];
  calculatedAt: string;
  /** Ledger rows in foreign currency are reported at their document amounts. */
  foreignCurrencyRows: number;
}

export const CASH_BASIS_NOTE =
  'Cash basis: an invoice counts in the period its payments are dated, in proportion to the payments; credit memos and write-offs count when issued, in proportion to the share of the original invoice paid; other rows count on their tax date.';

/** Dollars of tax retained for timely filing under the state's rule (a positive number). */
export function vendorDiscountFor(rule: VendorDiscountRule | undefined, taxDue: number): number {
  if (!rule || taxDue <= 0) return 0;
  let amount: number;
  if (rule.tiers && rule.tiers.length > 0) {
    let remaining = taxDue;
    let floor = 0;
    amount = 0;
    for (const tier of rule.tiers) {
      const band = tier.upTo === null ? remaining : Math.min(remaining, Math.max(0, tier.upTo - floor));
      amount += (band * tier.percent) / 100;
      remaining -= band;
      if (tier.upTo !== null) floor = tier.upTo;
      if (remaining <= 0) break;
    }
  } else {
    amount = (taxDue * rule.percent) / 100;
  }
  if (rule.capPerReturn !== undefined) amount = Math.min(amount, rule.capPerReturn);
  return round2(amount);
}

export function proposeVendorDiscount(args: {
  stateCode: string;
  salesTaxDue: number;
  dueDate: string | null;
  today: string;
}): VendorDiscountProposal {
  const rule = getUsState(args.stateCode)?.vendorDiscount;
  if (!rule) return { available: false, amount: 0, requiresTimelyFilingBy: null, late: false, note: null };
  const late = Boolean(args.dueDate && args.today > args.dueDate);
  return {
    available: true,
    amount: vendorDiscountFor(rule, args.salesTaxDue),
    requiresTimelyFilingBy: args.dueDate,
    late,
    note: rule.note ?? null,
  };
}

/** The returns of a period an amendment builds on, oldest first: the original and every amendment before it. */
export async function amendmentChain(db: Database, entityId: string, ret: Pick<ReturnRow, 'id' | 'amendsReturnId'>): Promise<ReturnRow[]> {
  const chain: ReturnRow[] = [];
  let cursor: string | null = ret.amendsReturnId;
  const seen = new Set<string>([ret.id]);
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const [prev]: ReturnRow[] = await db
      .select()
      .from(schema.taxReturns)
      .where(and(eq(schema.taxReturns.id, cursor), eq(schema.taxReturns.entityId, entityId)))
      .limit(1);
    if (!prev) break;
    chain.unshift(prev);
    cursor = prev.amendsReturnId;
  }
  return chain;
}

/**
 * Rows of earlier filed periods the user chose to carry into a later return
 * (`exceptions` entries with resolution `carried_forward`, not stamped yet).
 */
export async function carriedForwardRowIds(
  db: Database,
  entityId: string,
  agencyId: string,
  periodStart: string,
): Promise<{ ids: string[]; returnIds: string[] }> {
  const earlier = await db
    .select({ id: schema.taxReturns.id, exceptions: schema.taxReturns.exceptions })
    .from(schema.taxReturns)
    .where(
      and(
        eq(schema.taxReturns.entityId, entityId),
        eq(schema.taxReturns.agencyId, agencyId),
        isNull(schema.taxReturns.deletedAt),
        lt(schema.taxReturns.periodEnd, periodStart),
      ),
    );
  const ids: string[] = [];
  const returnIds = new Set<string>();
  for (const r of earlier) {
    for (const item of r.exceptions ?? []) {
      if (item.type === 'late_entry' && item.resolution === 'carried_forward' && typeof item.taxLineId === 'string') {
        ids.push(item.taxLineId);
        returnIds.add(r.id);
      }
    }
  }
  return { ids, returnIds: [...returnIds] };
}

export interface CalculationInput {
  entity: EntityRow;
  agency: AgencyRow;
  ret: ReturnRow;
  /** `now` for tests. */
  now?: Date;
  /** Leave out ledger rows created after this moment (filing stamps only what it counted). */
  createdNotAfter?: Date;
}

export interface Calculation {
  worksheet: SalesTaxWorksheet;
  rows: LoadedRows;
  summary: ReturnSummary;
  lines: Array<Record<string, unknown>>;
  adjustments: ReturnAdjustment[];
  totalDue: number;
  carriedIds: string[];
}

function uncuredTaxOf(w: Pick<SalesTaxWorksheet, 'uncuredExempt'>): number {
  return w.uncuredExempt.tax;
}

export function summaryOf(ret: Pick<ReturnRow, 'summary'>): Partial<ReturnSummary> | null {
  return (ret.summary ?? null) as Partial<ReturnSummary> | null;
}

export function reportingBasisOf(agency: AgencyRow): 'accrual' | 'cash' {
  return agency.reportingBasis === 'cash' ? 'cash' : 'accrual';
}

/** Builds a return's worksheet from the ledger and works out its adjustments and total. Does not write. */
export async function calculateReturn(db: Database, input: CalculationInput): Promise<Calculation> {
  const { entity, agency, ret } = input;
  const now = input.now ?? new Date();
  const today = todayIn(entity.timezone, now);
  const basis = reportingBasisOf(agency);
  const chain = await amendmentChain(db, ret.entityId, ret);
  const carried = ret.amendsReturnId ? { ids: [], returnIds: [] } : await carriedForwardRowIds(db, ret.entityId, agency.id, ret.periodStart);

  const rows = await loadWorksheetRows(db, {
    entityId: ret.entityId,
    agency,
    periodStart: ret.periodStart,
    periodEnd: ret.periodEnd,
    reportingBasis: basis,
    includeStampedBy: [ret.id, ...chain.map((r) => r.id)],
    carriedIds: carried.ids,
    createdNotAfter: input.createdNotAfter,
  });

  const worksheet = buildUsSalesTaxWorksheet(rows.lines, {
    agencyId: agency.id,
    stateCode: agency.stateCode,
    periodStart: ret.periodStart,
    periodEnd: ret.periodEnd,
    reportingBasis: basis,
    asOf: today,
  });

  const warnings: string[] = [];
  const previous = chain.length > 0 ? chain[chain.length - 1] : undefined;
  const previousSummary = (previous?.summary ?? null) as Partial<ReturnSummary> | null;
  const previouslyReported = previous
    ? {
        returnId: previous.id,
        salesTaxDue: num(previousSummary?.salesTaxDue),
        useTaxDue: num(previousSummary?.useTaxDue),
        uncuredTax: num(previousSummary?.uncuredExempt?.tax),
      }
    : undefined;

  const uncured = uncuredTaxOf(worksheet);
  const salesTaxPayable = round2(worksheet.salesTaxDue - (previouslyReported?.salesTaxDue ?? 0));
  const useTaxPayable = round2(worksheet.useTaxDue - (previouslyReported?.useTaxDue ?? 0));
  const uncuredTaxPayable = round2(uncured - (previouslyReported?.uncuredTax ?? 0));

  if (worksheet.uncuredExempt.lines > 0) {
    warnings.push(
      `${worksheet.uncuredExempt.lines} exempt sale line(s) have no certificate after the 90-day cure period and are counted as taxable.`,
    );
  }
  if (worksheet.totalTaxDue < 0) warnings.push('The return shows a credit (negative tax due).');
  const foreignRows = rows.entries.filter((e) => e.row.currency !== entity.baseCurrency).length;
  if (foreignRows > 0) warnings.push(`${foreignRows} ledger row(s) are in a foreign currency and are reported at their document amounts.`);
  if (rows.carriedIds.length > 0 && carried.ids.length > 0) {
    warnings.push(`${rows.carriedIds.length} row(s) carried forward from an earlier, filed period are included.`);
  }

  const carriedTax = sumMoney(rows.entries.filter((e) => e.carried).map((e) => num(e.row.taxAmount)));
  const vendorDiscount = proposeVendorDiscount({
    stateCode: agency.stateCode,
    // The discount is a share of the tax collected; tax owed on uncertified exempt sales was never collected.
    salesTaxDue: ret.amendsReturnId ? 0 : round2(worksheet.salesTaxDue - uncured),
    dueDate: ret.dueDate,
    today,
  });

  const summary: ReturnSummary = {
    reportingBasis: basis,
    method: basis === 'cash' ? CASH_BASIS_NOTE : 'Accrual basis: every row counts on its tax date.',
    grossSales: worksheet.grossSales,
    deductions: worksheet.deductions,
    totalDeductions: worksheet.totalDeductions,
    taxableSales: worksheet.taxableSales,
    salesTaxDue: worksheet.salesTaxDue,
    useTaxDue: worksheet.useTaxDue,
    totalTaxDue: worksheet.totalTaxDue,
    documentCount: worksheet.documentCount,
    rowCount: rows.entries.length,
    uncuredExempt: worksheet.uncuredExempt,
    salesTaxPayable,
    useTaxPayable,
    uncuredTaxPayable,
    vendorDiscount,
    warnings,
    calculatedAt: now.toISOString(),
    foreignCurrencyRows: foreignRows,
  };
  if (rows.carriedIds.length > 0) {
    summary.carriedForward = { returnIds: carried.returnIds, rowCount: rows.carriedIds.length, taxAmount: carriedTax };
  }
  if (previouslyReported) summary.previouslyReported = previouslyReported;

  const adjustments = refreshAdjustments((ret.adjustments ?? []) as ReturnAdjustment[], summary, ret.amendsReturnId !== null);
  const lines = [
    ...worksheet.byLocation.map((l) => ({ kind: 'sales', ...l })),
    ...worksheet.useTaxByLocation.map((l) => ({ kind: 'use', ...l })),
  ];
  return {
    worksheet,
    rows,
    summary,
    lines,
    adjustments,
    totalDue: computeTotalDue(summary, adjustments),
    carriedIds: rows.carriedIds,
  };
}

/**
 * Keeps the user's adjustments, refreshes an automatic vendor discount, and
 * proposes one when the state has a rule, none is set and the due date has not
 * passed. The discount is only a proposal: it needs timely filing, which the
 * user confirms by keeping it.
 */
export function refreshAdjustments(existing: ReturnAdjustment[], summary: ReturnSummary, amendment: boolean): ReturnAdjustment[] {
  const discount = summary.vendorDiscount;
  const noteFor = (): string =>
    `Proposed vendor discount${discount.note ? ` (${discount.note})` : ''}; only valid if filed and paid by ${discount.requiresTimelyFilingBy ?? 'the due date'}.`;
  const next = existing.map((a) => ({ ...a }));
  const index = next.findIndex((a) => a.type === 'vendor_discount');
  const existingDiscount = index >= 0 ? next[index] : undefined;

  if (existingDiscount?.auto) {
    if (!discount.available || discount.amount <= 0 || discount.late || amendment) next.splice(index, 1);
    else {
      existingDiscount.amount = -discount.amount;
      existingDiscount.note = noteFor();
    }
  } else if (!existingDiscount && !amendment && discount.available && discount.amount > 0 && !discount.late) {
    next.push({ type: 'vendor_discount', amount: -discount.amount, note: noteFor(), auto: true });
  }
  return next;
}

export function validAdjustmentType(type: string): boolean {
  return (ADJUSTMENT_TYPES as readonly string[]).includes(type);
}

/** Is a return's ledger worksheet still what was calculated? Compared when filing. */
export function sameWorksheet(a: Partial<ReturnSummary> | null | undefined, b: ReturnSummary): boolean {
  if (!a) return false;
  return (
    num(a.rowCount) === b.rowCount &&
    round2(num(a.grossSales)) === b.grossSales &&
    round2(num(a.taxableSales)) === b.taxableSales &&
    round2(num(a.salesTaxDue)) === b.salesTaxDue &&
    round2(num(a.useTaxDue)) === b.useTaxDue
  );
}
