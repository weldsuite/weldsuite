/**
 * US sales tax return worksheet per agency and period, from tax-ledger rows
 * (docs/plans/weldbooks-us.md §5).
 *
 * The ledger has one row per document line per jurisdiction, so a line's gross
 * and its exemptions are read once, from the line's highest-level row, while
 * tax and taxable sales per location come from every row. Credit memos and
 * bad-debt write-offs are negative rows: they count as returns and bad debts,
 * and a credit of an exempt or non-taxable sale nets against that deduction.
 *
 *   taxable sales = gross sales - deductions
 *
 * Money is summed in whole cents.
 */

import type { Entity } from '@weldsuite/db/schema';
import { addDays, isoDay } from '../../sales-tax/dates';
import { fromCents, toCents } from '../../sales-tax/rounding';
import type { TaxReturnArtifact, TaxReturnLine } from '../types';

export type WorksheetDeductionKey =
  | 'resale'
  | 'nonprofit'
  | 'government'
  | 'manufacturing'
  | 'agricultural'
  | 'other_exempt'
  | 'non_taxable'
  | 'exempt_freight'
  | 'marketplace'
  | 'returns'
  | 'bad_debts';

export const WORKSHEET_DEDUCTION_KEYS: readonly WorksheetDeductionKey[] = [
  'resale',
  'nonprofit',
  'government',
  'manufacturing',
  'agricultural',
  'other_exempt',
  'non_taxable',
  'exempt_freight',
  'marketplace',
  'returns',
  'bad_debts',
];

const DEDUCTION_LABELS: Record<WorksheetDeductionKey, string> = {
  resale: 'Sales for resale',
  nonprofit: 'Sales to nonprofit organizations',
  government: 'Sales to government',
  manufacturing: 'Sales to manufacturers',
  agricultural: 'Agricultural sales',
  other_exempt: 'Other exempt sales',
  non_taxable: 'Non-taxable sales',
  exempt_freight: 'Exempt freight and delivery',
  marketplace: 'Marketplace-facilitated sales',
  returns: 'Returns and allowances',
  bad_debts: 'Bad debts written off',
};

/** A tax-ledger row as the worksheet reads it: a `TaxReturnLine` plus the document line it belongs to. */
export interface SalesTaxWorksheetLine extends TaxReturnLine {
  /** `tax_lines.source_line_id`; rows of one document line share it, so gross isn't counted per jurisdiction. */
  sourceLineId?: string | null;
  /** `tax_lines.certificate_id`: an exempt row without one has no certificate on file. */
  certificateId?: string | null;
}

export interface SalesTaxWorksheetOptions {
  /** The agency's id; rows without an agency belong to `''`. */
  agencyId: string;
  stateCode: string;
  periodStart: string;
  periodEnd: string;
  reportingBasis: 'accrual' | 'cash';
  /**
   * When set, an exempt sale with no certificate on file whose 90-day cure
   * period (SST) ended before this date is reported as taxable.
   */
  asOf?: string;
}

export interface SalesTaxWorksheetLocation {
  jurisdictionCode: string;
  jurisdictionName: string;
  level: string;
  reportingCode: string;
  /** Percent. */
  rate: number;
  taxableSales: number;
  tax: number;
}

export interface SalesTaxWorksheet {
  agencyId: string;
  stateCode: string;
  periodStart: string;
  periodEnd: string;
  reportingBasis: 'accrual' | 'cash';
  grossSales: number;
  deductions: Record<WorksheetDeductionKey, number>;
  totalDeductions: number;
  taxableSales: number;
  salesTaxDue: number;
  useTaxDue: number;
  totalTaxDue: number;
  byLocation: SalesTaxWorksheetLocation[];
  useTaxByLocation: SalesTaxWorksheetLocation[];
  documentCount: number;
  /** Exempt sales without a certificate past their cure date, counted as taxable (already in the totals). */
  uncuredExempt: { sales: number; tax: number; lines: number };
}

const LEVEL_RANK: Record<string, number> = { state: 0, county: 1, city: 2, district: 3 };
const RETURN_SOURCES = new Set(['credit_note', 'reversal']);
const BAD_DEBT_SOURCES = new Set(['write_off', 'bad_debt']);
const FREIGHT_CODES = new Set(['shipping', 'handling']);
const EXEMPT_KEYS = new Set<string>(['resale', 'nonprofit', 'government', 'manufacturing', 'agricultural']);

function rank(level: string | null | undefined): number {
  return LEVEL_RANK[level ?? ''] ?? 4;
}

function exemptKey(reason: string | null | undefined): WorksheetDeductionKey {
  return reason && EXEMPT_KEYS.has(reason) ? (reason as WorksheetDeductionKey) : 'other_exempt';
}

function cents(value: number | null | undefined): number {
  return toCents(value ?? 0);
}

function rowGrossCents(row: TaxReturnLine): number {
  if (row.grossAmount !== undefined && row.grossAmount !== null) return cents(row.grossAmount);
  return cents(row.taxableAmount) + cents(row.exemptAmount) + cents(row.nonTaxableAmount);
}

function emptyDeductions(): Record<WorksheetDeductionKey, number> {
  return Object.fromEntries(WORKSHEET_DEDUCTION_KEYS.map((k) => [k, 0])) as Record<WorksheetDeductionKey, number>;
}

interface LocationAcc {
  location: Omit<SalesTaxWorksheetLocation, 'taxableSales' | 'tax'>;
  taxableCents: number;
  taxCents: number;
}

function addLocation(map: Map<string, LocationAcc>, row: TaxReturnLine, taxable: number, tax: number) {
  const rate = row.rate ?? 0;
  const key = `${row.jurisdictionCode ?? ''}|${row.reportingCode ?? ''}|${rate}`;
  const acc = map.get(key) ?? {
    location: {
      jurisdictionCode: row.jurisdictionCode ?? '',
      jurisdictionName: row.jurisdictionName ?? row.jurisdictionCode ?? '',
      level: row.jurisdictionLevel ?? '',
      reportingCode: row.reportingCode ?? '',
      rate,
    },
    taxableCents: 0,
    taxCents: 0,
  };
  acc.taxableCents += taxable;
  acc.taxCents += tax;
  map.set(key, acc);
}

function locationsOf(map: Map<string, LocationAcc>): SalesTaxWorksheetLocation[] {
  return [...map.values()]
    .filter((a) => a.taxableCents !== 0 || a.taxCents !== 0)
    .sort(
      (a, b) =>
        rank(a.location.level) - rank(b.location.level) ||
        a.location.jurisdictionName.localeCompare(b.location.jurisdictionName) ||
        a.location.rate - b.location.rate,
    )
    .map((a) => ({ ...a.location, taxableSales: fromCents(a.taxableCents), tax: fromCents(a.taxCents) }));
}

export function buildUsSalesTaxWorksheet(
  lines: SalesTaxWorksheetLine[],
  opts: SalesTaxWorksheetOptions,
): SalesTaxWorksheet {
  const start = isoDay(opts.periodStart);
  const end = isoDay(opts.periodEnd);
  const rows = lines.filter((row) => {
    if ((row.agencyId ?? '') !== opts.agencyId) return false;
    if (row.taxDate) {
      const day = isoDay(row.taxDate);
      if (day < start || day > end) return false;
    }
    return row.kind === 'use' || row.direction !== 'purchase';
  });

  let gross = 0;
  const deductions = emptyDeductions();
  let salesTax = 0;
  let useTax = 0;
  const locations = new Map<string, LocationAcc>();
  const useLocations = new Map<string, LocationAcc>();
  const documents = new Set<string>();
  const uncured = { sales: 0, tax: 0, lines: 0 };

  // Group a document line's rows: gross and exemptions come from its highest-level row.
  const groups = new Map<string, SalesTaxWorksheetLine[]>();
  rows.forEach((row, index) => {
    if (row.kind === 'use') return;
    const key = `${row.sourceType ?? ''}|${row.sourceId ?? ''}|${row.sourceLineId ?? `#${index}`}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  });

  for (const [groupKey, group] of groups) {
    const anchor = [...group].sort(
      (a, b) =>
        rank(a.jurisdictionLevel) - rank(b.jurisdictionLevel) ||
        (a.jurisdictionCode ?? '').localeCompare(b.jurisdictionCode ?? ''),
    )[0];
    const sourceType = anchor.sourceType ?? '';
    const isReturn = RETURN_SOURCES.has(sourceType);
    const isBadDebt = BAD_DEBT_SOURCES.has(sourceType);

    const g = rowGrossCents(anchor);
    documents.add(anchor.sourceId ? `${sourceType}|${anchor.sourceId}` : groupKey);

    if (!isReturn && !isBadDebt) gross += g;
    if (isReturn) deductions.returns -= g;
    if (isBadDebt) deductions.bad_debts -= g;

    if (anchor.marketplaceFacilitated) {
      deductions.marketplace += g;
      continue;
    }
    const exempt = cents(anchor.exemptAmount);
    const nonTaxable = cents(anchor.nonTaxableAmount);

    const cure = anchor.taxDate ? addDays(isoDay(anchor.taxDate), 90) : undefined;
    const isUncured =
      opts.asOf !== undefined &&
      exempt > 0 &&
      !anchor.certificateId &&
      cure !== undefined &&
      cure < isoDay(opts.asOf);

    if (isUncured) {
      uncured.lines += 1;
      uncured.sales += exempt;
      for (const row of group) {
        const rowExempt = cents(row.exemptAmount);
        const extraTax = toCents(fromCents(rowExempt) * ((row.rate ?? 0) / 100));
        uncured.tax += extraTax;
        salesTax += extraTax;
        addLocation(locations, row, rowExempt, extraTax);
      }
    } else if (exempt !== 0) {
      deductions[exemptKey(anchor.exemptReason)] += exempt;
    }
    if (nonTaxable !== 0) {
      deductions[FREIGHT_CODES.has(anchor.taxCode ?? '') ? 'exempt_freight' : 'non_taxable'] += nonTaxable;
    }
  }

  for (const row of rows) {
    if (row.kind === 'use') {
      useTax += cents(row.taxAmount);
      addLocation(useLocations, row, cents(row.taxableAmount), cents(row.taxAmount));
      continue;
    }
    salesTax += cents(row.taxAmount);
    addLocation(locations, row, cents(row.taxableAmount), cents(row.taxAmount));
  }

  const totalDeductions = WORKSHEET_DEDUCTION_KEYS.reduce((sum, key) => sum + deductions[key], 0);
  const out = Object.fromEntries(
    WORKSHEET_DEDUCTION_KEYS.map((key) => [key, fromCents(deductions[key])]),
  ) as Record<WorksheetDeductionKey, number>;

  return {
    agencyId: opts.agencyId,
    stateCode: opts.stateCode,
    periodStart: start,
    periodEnd: end,
    reportingBasis: opts.reportingBasis,
    grossSales: fromCents(gross),
    deductions: out,
    totalDeductions: fromCents(totalDeductions),
    taxableSales: fromCents(gross - totalDeductions),
    salesTaxDue: fromCents(salesTax),
    useTaxDue: fromCents(useTax),
    totalTaxDue: fromCents(salesTax + useTax),
    byLocation: locationsOf(locations),
    useTaxByLocation: locationsOf(useLocations),
    documentCount: documents.size,
    uncuredExempt: { sales: fromCents(uncured.sales), tax: fromCents(uncured.tax), lines: uncured.lines },
  };
}

function csvCell(value: string | number): string {
  const text = typeof value === 'number' ? value.toFixed(2) : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(...cells: Array<string | number>): string {
  return cells.map(csvCell).join(',');
}

function ratePercent(rate: number): string {
  return String(Number(rate.toFixed(4)));
}

function worksheetCsv(ws: SalesTaxWorksheet, entityName: string): string[] {
  const out: string[] = [
    csvRow('Sales tax return worksheet'),
    csvRow('Entity', entityName),
    csvRow('State', ws.stateCode),
    csvRow('Agency', ws.agencyId),
    csvRow('Period start', ws.periodStart),
    csvRow('Period end', ws.periodEnd),
    csvRow('Reporting basis', ws.reportingBasis),
    csvRow('Documents', String(ws.documentCount)),
    '',
    csvRow('Line', 'Amount'),
    csvRow('Gross sales', ws.grossSales),
  ];
  for (const key of WORKSHEET_DEDUCTION_KEYS) {
    if (ws.deductions[key] !== 0) out.push(csvRow(`Less: ${DEDUCTION_LABELS[key]}`, ws.deductions[key]));
  }
  out.push(
    csvRow('Total deductions', ws.totalDeductions),
    csvRow('Taxable sales', ws.taxableSales),
    csvRow('Sales tax due', ws.salesTaxDue),
    csvRow('Use tax due', ws.useTaxDue),
    csvRow('Total tax due', ws.totalTaxDue),
  );
  if (ws.uncuredExempt.lines > 0) {
    out.push(
      csvRow('Exempt sales without a certificate, counted as taxable', ws.uncuredExempt.sales),
      csvRow('Tax on those sales', ws.uncuredExempt.tax),
    );
  }
  const section = (title: string, locations: SalesTaxWorksheetLocation[]) => {
    if (locations.length === 0) return;
    out.push('', csvRow(title), csvRow('Location code', 'Location', 'Level', 'Reporting code', 'Rate (%)', 'Taxable sales', 'Tax'));
    for (const l of locations) {
      out.push(csvRow(l.jurisdictionCode, l.jurisdictionName, l.level, l.reportingCode, ratePercent(l.rate), l.taxableSales, l.tax));
    }
  };
  section('Tax by location', ws.byLocation);
  section('Use tax by location', ws.useTaxByLocation);
  return out;
}

/**
 * The worksheet as a CSV file. `lines` are the ledger rows of the period (one
 * agency's, or several: each agency gets its own section).
 */
export function buildUsSalesTaxReturn(
  entity: Entity,
  periodStart: string,
  periodEnd: string,
  lines: TaxReturnLine[],
): Promise<TaxReturnArtifact> {
  const rows = lines as SalesTaxWorksheetLine[];
  const reportingBasis = entity.accountingMethod === 'cash' ? 'cash' : 'accrual';
  const agencyIds = [...new Set(rows.map((r) => r.agencyId ?? ''))];
  if (agencyIds.length === 0) agencyIds.push('');

  const states = [...new Set(rows.map((r) => r.stateCode).filter((s): s is string => Boolean(s)))];
  const stateCode = states.length === 1 ? states[0] : '';

  const worksheets = agencyIds.map((agencyId) =>
    buildUsSalesTaxWorksheet(rows, {
      agencyId,
      stateCode: rows.find((r) => (r.agencyId ?? '') === agencyId && r.stateCode)?.stateCode ?? stateCode,
      periodStart,
      periodEnd,
      reportingBasis,
    }),
  );

  const content = worksheets
    .map((ws, i) => (i === 0 ? worksheetCsv(ws, entity.name) : ['', ...worksheetCsv(ws, entity.name)]).join('\n'))
    .join('\n');

  const sum = (pick: (ws: SalesTaxWorksheet) => number): number =>
    fromCents(worksheets.reduce((total, ws) => total + toCents(pick(ws)), 0));
  const summary: Record<string, number> = {
    grossSales: sum((ws) => ws.grossSales),
    totalDeductions: sum((ws) => ws.totalDeductions),
    taxableSales: sum((ws) => ws.taxableSales),
    salesTaxDue: sum((ws) => ws.salesTaxDue),
    useTaxDue: sum((ws) => ws.useTaxDue),
    totalTaxDue: sum((ws) => ws.totalTaxDue),
    documentCount: worksheets.reduce((n, ws) => n + ws.documentCount, 0),
  };
  for (const key of WORKSHEET_DEDUCTION_KEYS) summary[`deduction_${key}`] = sum((ws) => ws.deductions[key]);

  const label = stateCode ? stateCode.toLowerCase() : 'all';
  return Promise.resolve({
    filename: `sales-tax-${label}-${isoDay(periodStart)}-${isoDay(periodEnd)}.csv`,
    mimeType: 'text/csv',
    content,
    summary,
  });
}
