/**
 * CSV export of a return: the domain's worksheet artifact (`buildUsSalesTaxReturn`)
 * followed by the return's adjustments and total due, so the file matches what
 * is filed.
 */

import { buildUsSalesTaxReturn } from '@weldsuite/books-domain/jurisdictions/us/sales-tax-return';
import { addDays, isoDay } from '@weldsuite/books-domain/sales-tax/dates';
import { fromCents, toCents } from '@weldsuite/books-domain/sales-tax/rounding';
import type { TaxReturnArtifact, TaxReturnLine } from '@weldsuite/books-domain/jurisdictions/types';
import type { Database } from '@weldsuite/worker-kit/db';
import { FILED_STATUSES, computeTotalDue, isoDate, num, todayIn, type AgencyRow, type EntityRow, type ReturnAdjustment, type ReturnRow } from './common';
import { calculateReturn, summaryOf } from './calculate';
import { loadFiledRows } from './rows';

function cell(value: string | number): string {
  const text = typeof value === 'number' ? value.toFixed(2) : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const ADJUSTMENT_LABELS: Record<string, string> = {
  vendor_discount: 'Vendor discount',
  prepayment: 'Prepayment credit',
  penalty: 'Penalty',
  interest: 'Interest',
  rounding: 'Rounding',
  other: 'Other',
};

/**
 * Exempt sales with no certificate whose 90-day cure period ended before `asOf`
 * count as taxable on the worksheet; the same rows are turned into taxable ones
 * here, so the artifact (which has no `asOf`) matches the return.
 */
export function applyCureRule(lines: TaxReturnLine[], asOf: string): TaxReturnLine[] {
  return lines.map((line) => {
    const row = line as TaxReturnLine & { certificateId?: string | null };
    const exempt = row.exemptAmount ?? 0;
    if (line.kind === 'use' || exempt <= 0 || row.certificateId || line.marketplaceFacilitated || !line.taxDate) return line;
    if (addDays(isoDay(line.taxDate), 90) >= asOf) return line;
    const extraTax = fromCents(toCents(exempt * ((line.rate ?? 0) / 100)));
    return {
      ...line,
      taxableAmount: fromCents(toCents(line.taxableAmount) + toCents(exempt)),
      taxAmount: fromCents(toCents(line.taxAmount) + toCents(extraTax)),
      exemptAmount: 0,
      exemptReason: null,
    };
  });
}

export async function exportReturn(
  db: Database,
  args: { entity: EntityRow; agency: AgencyRow; ret: ReturnRow },
): Promise<TaxReturnArtifact> {
  const { entity, agency, ret } = args;
  const filed = FILED_STATUSES.includes(ret.status);
  let lines;
  let adjustments = (ret.adjustments ?? []) as ReturnAdjustment[];
  let totalDue = num(ret.totalDue);
  let summary = summaryOf(ret);
  if (filed) {
    const rows = await loadFiledRows(db, {
      entityId: entity.id,
      agency,
      returnId: ret.id,
      periodStart: ret.periodStart,
      periodEnd: ret.periodEnd,
      reportingBasis: agency.reportingBasis === 'cash' ? 'cash' : 'accrual',
      filedAt: ret.filedAt,
    });
    lines = applyCureRule(rows.lines, isoDate(ret.filedAt ?? new Date()));
  } else {
    const calc = await calculateReturn(db, { entity, agency, ret });
    lines = applyCureRule(calc.rows.lines, todayIn(entity.timezone));
    // The stored adjustments, the live worksheet.
    totalDue = computeTotalDue(calc.summary, adjustments);
    summary = calc.summary;
  }

  const artifact = await buildUsSalesTaxReturn(
    { ...entity, accountingMethod: agency.reportingBasis === 'cash' ? 'cash' : 'accrual' },
    ret.periodStart,
    ret.periodEnd,
    lines,
  );

  const extra: string[] = [''];
  if (summary?.uncuredExempt && summary.uncuredExempt.lines > 0) {
    extra.push(
      [cell('Includes exempt sales without a certificate after the 90-day cure period, counted as taxable'), cell(summary.uncuredExempt.sales)].join(','),
      [cell('Tax on those sales'), cell(summary.uncuredExempt.tax)].join(','),
    );
  }
  extra.push(cell('Adjustments'));
  if (adjustments.length === 0) extra.push([cell('None'), cell(0)].join(','));
  for (const adj of adjustments) {
    extra.push([cell(ADJUSTMENT_LABELS[adj.type] ?? adj.type), cell(adj.amount), cell(adj.note ?? '')].join(','));
  }
  if (summary?.previouslyReported) {
    extra.push([cell('Reported on the return this one amends'), cell(-(summary.previouslyReported.salesTaxDue + summary.previouslyReported.useTaxDue))].join(','));
  }
  extra.push([cell('Total due'), cell(totalDue)].join(','));
  return { ...artifact, content: `${artifact.content}\n${extra.join('\n')}` };
}
