/**
 * The KvK annual report (jaarrekening) of a Dutch entity: the types the
 * `/api/annual-reports` routes answer with, the balance sheet layout and the
 * totals the screen computes (the API stores only the lines).
 *
 * The shapes come from the shared Zod schemas (`@weldsuite/app-api-client`),
 * which the Rust backend's answers are checked against.
 */

import type { z } from 'zod';
import type {
  annualReportFiledSchema,
  annualReportLinesSchema,
  annualReportSchema,
  vatFilingStatusSchema,
  vatReturnFiledSchema,
} from '@weldsuite/app-api-client/schemas/books-tax-responses';

export type AnnualReport = z.infer<typeof annualReportSchema>;
export type AnnualReportLines = z.infer<typeof annualReportLinesSchema>;
export type AnnualReportLineKey = keyof AnnualReportLines;
export type AnnualReportFiled = z.infer<typeof annualReportFiledSchema>;
export type AnnualReportStatus = AnnualReport['status'];
export type AnnualReportDisclosures = AnnualReport['disclosures'];
export type AnnualReportSizeClass = AnnualReport['sizeClass'];

/** `POST /api/vat-returns/:id/file` and `POST /api/icp-declarations/:id/file`. */
export type TaxFiled = z.infer<typeof vatReturnFiledSchema>;
/** What Digipoort says about a delivery (a VAT return, an ICP declaration or an annual report). */
export type FilingStatus = z.infer<typeof vatFilingStatusSchema>;

/** The body of `PATCH /api/annual-reports/:id`: every key is optional. */
export interface AnnualReportPatch {
  sizeClass?: AnnualReportSizeClass;
  figures?: { current?: Partial<AnnualReportLines>; prior?: Partial<AnnualReportLines> | null };
  disclosures?: Partial<AnnualReportDisclosures>;
  adopted?: boolean;
  adoptionDate?: string | null;
  notes?: string | null;
}

export const ASSET_FIXED_LINES = ['intangibleAssets', 'tangibleAssets', 'financialAssets'] as const;
export const ASSET_CURRENT_LINES = ['inventories', 'receivables', 'securities', 'cash'] as const;
export const EQUITY_LINES = [
  'shareCapital',
  'sharePremium',
  'revaluationReserve',
  'legalReserves',
  'statutoryReserves',
  'otherReserves',
  'resultForTheYear',
] as const;

export type TotalKey =
  | 'fixedAssets'
  | 'currentAssets'
  | 'assets'
  | 'equity'
  | 'liabilities'
  | 'equityAndLiabilities';

export type AnnualReportTotals = Record<TotalKey, number> & { provisions: number };

/** Rounds to cents, so sums of cent amounts never show float noise. */
export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function sum(lines: AnnualReportLines, keys: readonly AnnualReportLineKey[]): number {
  return roundCents(keys.reduce((total, key) => total + (Number(lines[key]) || 0), 0));
}

/** The totals of a balance sheet, from its lines. */
export function annualReportTotals(lines: AnnualReportLines): AnnualReportTotals {
  const fixedAssets = sum(lines, ASSET_FIXED_LINES);
  const currentAssets = sum(lines, ASSET_CURRENT_LINES);
  const equity = sum(lines, EQUITY_LINES);
  const liabilities = sum(lines, ['longTermLiabilities', 'currentLiabilities']);
  const provisions = roundCents(Number(lines.provisions) || 0);
  return {
    fixedAssets,
    currentAssets,
    assets: roundCents(fixedAssets + currentAssets),
    equity,
    provisions,
    liabilities,
    equityAndLiabilities: roundCents(equity + provisions + liabilities),
  };
}

/** Assets minus equity and liabilities: zero for a balance sheet that balances. */
export function balanceDifference(lines: AnnualReportLines): number {
  const totals = annualReportTotals(lines);
  return roundCents(totals.assets - totals.equityAndLiabilities);
}

export function isBalanced(lines: AnnualReportLines): boolean {
  return Math.abs(balanceDifference(lines)) < 0.005;
}

/** What a micro company publishes: only these totals (the detail lines are still kept). */
export const MICRO_PUBLISHED_TOTALS = [
  'fixedAssets',
  'currentAssets',
  'equity',
  'provisions',
  'longTermLiabilities',
  'currentLiabilities',
] as const;

/** The ledger accounts behind a line (`figures.accounts[].item` names the line they roll up into). */
export function accountsForLine(report: Pick<AnnualReport, 'figures'>, line: AnnualReportLineKey) {
  return report.figures.accounts.filter((account) => account.item === line);
}

/** An empty set of lines, for a prior year typed in from scratch. */
export function emptyLines(): AnnualReportLines {
  return {
    intangibleAssets: 0,
    tangibleAssets: 0,
    financialAssets: 0,
    inventories: 0,
    receivables: 0,
    securities: 0,
    cash: 0,
    shareCapital: 0,
    sharePremium: 0,
    revaluationReserve: 0,
    legalReserves: 0,
    statutoryReserves: 0,
    otherReserves: 0,
    resultForTheYear: 0,
    provisions: 0,
    longTermLiabilities: 0,
    currentLiabilities: 0,
  };
}

/** Draft and rejected reports are edited, recalculated and deleted; the rest are locked. */
export function isAnnualReportEditable(status: AnnualReportStatus): boolean {
  return status === 'draft' || status === 'rejected';
}

export const canDeleteAnnualReport = isAnnualReportEditable;
export const canRecalculateAnnualReport = isAnnualReportEditable;

/** Sent through Digipoort, waiting for the KvK's answer. */
export function isAnnualReportAwaitingAnswer(status: AnnualReportStatus): boolean {
  return status === 'submitted';
}

/** Which form field each `issues[].field` belongs to; the rest are shown in the banner only. */
export function issueFields(report: Pick<AnnualReport, 'issues'>): ReadonlySet<string> {
  return new Set(report.issues.map((issue) => issue.field));
}

/** The fiscal years offered for a new report: the KvK taxonomy covers 2025 and 2026. */
export const ANNUAL_REPORT_YEARS = [2026, 2025] as const;

/** The year to propose for a new report: last year, kept within the years the taxonomy covers. */
export function defaultAnnualReportYear(now: Date, existingYears: readonly number[] = []): number {
  const lastYear = now.getFullYear() - 1;
  const clamped = Math.min(Math.max(lastYear, ANNUAL_REPORT_YEARS[ANNUAL_REPORT_YEARS.length - 1]), ANNUAL_REPORT_YEARS[0]);
  if (!existingYears.includes(clamped)) return clamped;
  return ANNUAL_REPORT_YEARS.find((year) => !existingYears.includes(year)) ?? clamped;
}

/** Where a delivery was made: a report filed in the test environment is not a real deposit. */
export function isPreprodDelivery(row: { digipoortResponse?: unknown } | null | undefined): boolean {
  const response = row?.digipoortResponse;
  return !!response && typeof response === 'object' && (response as { environment?: unknown }).environment === 'preprod';
}

/** Every key of the balance sheet, in the order the screen lists them. */
export const ALL_LINE_KEYS: readonly AnnualReportLineKey[] = [
  ...ASSET_FIXED_LINES,
  ...ASSET_CURRENT_LINES,
  ...EQUITY_LINES,
  'provisions',
  'longTermLiabilities',
  'currentLiabilities',
];

/**
 * The lines whose amount differs from what the server holds, so a save sends
 * (and marks as hand-edited) only what the person actually changed.
 */
export function changedLines(server: AnnualReportLines | null, edited: AnnualReportLines): Partial<AnnualReportLines> {
  const changes: Partial<AnnualReportLines> = {};
  for (const key of ALL_LINE_KEYS) {
    const next = roundCents(Number(edited[key]) || 0);
    if (!server || roundCents(Number(server[key]) || 0) !== next) changes[key] = next;
  }
  return changes;
}
