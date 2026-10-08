/**
 * Pure helpers of the 1099 Center: how a vendor's review result is grouped and
 * explained, how a filing line's amounts and adjustments are read and typed,
 * and where a filing stands in its life (draft, reviewed, generated, filed).
 */
import type {
  BoxAmounts,
  Form1099Filing,
  Form1099FilingLine,
  Form1099FilingStatus,
  Form1099Summary,
  Form1099VendorRow,
  Form1099VendorStatus,
  LinePatch,
} from '@/lib/api/domains/weldbooks-1099';
import { isForm1099WithholdingBox, type Form1099Type } from '@/lib/weldbooks/form-1099';

export const FORM_TYPES: readonly Form1099Type[] = ['nec', 'misc'];

/** The tabs of the 1099 Center, as they appear in the `tab` search parameter. */
export const FORM_1099_TABS = ['review', 'filings', 'tin-matching', 'form-945'] as const;
export type Form1099Tab = (typeof FORM_1099_TABS)[number];

export function isForm1099Tab(value: unknown): value is Form1099Tab {
  return typeof value === 'string' && (FORM_1099_TABS as readonly string[]).includes(value);
}

const cents = (value: number) => Math.round(value * 100);
const fromCents = (value: number) => value / 100;

/** Sum of box amounts in cents, so 0.1 + 0.2 stays 0.30. */
export function sumAmounts(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += cents(value);
  return fromCents(total);
}

/** Amount of the boxes of one form, leaving out the federal tax withheld box. */
export function reportedAmount(boxes: BoxAmounts | Record<string, number>, withheld = false): number {
  return sumAmounts(
    Object.entries(boxes)
      .filter(([code, amount]) => typeof amount === 'number' && isForm1099WithholdingBox(code) === withheld)
      .map(([, amount]) => amount as number),
  );
}

/** `NEC 1`, `MISC 10`: a box code as people say it. Codes that are not boxes come back unchanged. */
export function boxTag(code: string): string {
  const match = /^(nec|misc)_(\d+)$/.exec(code);
  return match ? `${match[1]!.toUpperCase()} ${match[2]}` : code;
}

/** Box entries with an amount, in the order of their number: NEC 1 before NEC 4, MISC 2 before MISC 10. */
export function boxEntries(boxes: BoxAmounts | Record<string, number>): Array<{ code: string; amount: number }> {
  return Object.entries(boxes)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] !== 0)
    .map(([code, amount]) => ({ code, amount }))
    .sort((a, b) => {
      const formA = a.code.startsWith('nec') ? 0 : 1;
      const formB = b.code.startsWith('nec') ? 0 : 1;
      if (formA !== formB) return formA - formB;
      return Number(a.code.split('_')[1]) - Number(b.code.split('_')[1]);
    });
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export type ReviewFilter = 'all' | 'to_file' | 'attention' | 'below_threshold' | 'corporation' | 'not_vendor';

export const REVIEW_FILTERS: readonly ReviewFilter[] = ['to_file', 'attention', 'below_threshold', 'corporation', 'not_vendor', 'all'];

/** A vendor needs a fix before the form can go out: a missing TIN or address, an amount without a box, a failed TIN match. */
export function needsAttention(row: Form1099VendorRow): boolean {
  if (row.status === 'needs_tin' || row.status === 'needs_address') return true;
  if (row.unmappedAmount > 0) return true;
  if (row.suggestBackupWithholding) return true;
  // Paid enough to report but not flagged: someone has to decide.
  return row.status === 'not_1099_vendor' && row.aboveThreshold;
}

export function matchesReviewFilter(row: Form1099VendorRow, filter: ReviewFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'to_file':
      return row.status === 'included' || row.status === 'needs_tin' || row.status === 'needs_address';
    case 'attention':
      return needsAttention(row);
    case 'below_threshold':
      return row.status === 'below_threshold';
    case 'corporation':
      return row.status === 'excluded_corporation';
    case 'not_vendor':
      return row.status === 'not_1099_vendor';
  }
}

export function reviewFilterCounts(rows: readonly Form1099VendorRow[]): Record<ReviewFilter, number> {
  const counts: Record<ReviewFilter, number> = { all: rows.length, to_file: 0, attention: 0, below_threshold: 0, corporation: 0, not_vendor: 0 };
  for (const row of rows) {
    for (const filter of REVIEW_FILTERS) {
      if (filter !== 'all' && matchesReviewFilter(row, filter)) counts[filter] += 1;
    }
  }
  return counts;
}

/** The fix a vendor row points to: what is missing, so the row can link to the vendor's form. */
export type VendorFix = 'tin' | 'address' | 'mark_vendor' | 'box' | 'backup_withholding';

export function vendorFixes(row: Form1099VendorRow): VendorFix[] {
  const fixes: VendorFix[] = [];
  if (row.status === 'needs_tin') fixes.push('tin');
  if (row.status === 'needs_address') fixes.push('address');
  if (row.status === 'not_1099_vendor' && row.aboveThreshold) fixes.push('mark_vendor');
  if (row.unmappedAmount > 0) fixes.push('box');
  if (row.suggestBackupWithholding) fixes.push('backup_withholding');
  return fixes;
}

export const STATUS_VARIANT: Record<Form1099VendorStatus, 'success' | 'warning' | 'secondary' | 'outline' | 'destructive'> = {
  included: 'success',
  below_threshold: 'secondary',
  excluded_corporation: 'outline',
  needs_tin: 'warning',
  needs_address: 'warning',
  not_1099_vendor: 'outline',
};

/** Vendors that go on a form of this type (reportable boxes of the form, whatever else is missing). */
export function vendorsForForm(summary: Pick<Form1099Summary, 'vendors'>, form: Form1099Type): Form1099VendorRow[] {
  return summary.vendors.filter(
    (row) => (row.status === 'included' || row.status === 'needs_tin' || row.status === 'needs_address') && row.forms.includes(form),
  );
}

// ---------------------------------------------------------------------------
// Filings
// ---------------------------------------------------------------------------

export const FILING_STEPS: readonly Form1099FilingStatus[] = ['draft', 'reviewed', 'generated', 'filed'];

/** Position in draft → reviewed → generated → filed; a corrected filing is past all of them. */
export function filingStepIndex(status: Form1099FilingStatus): number {
  if (status === 'corrected') return FILING_STEPS.length - 1;
  return FILING_STEPS.indexOf(status);
}

/** Lines can be changed while the filing is a draft or reviewed. */
export function isEditableFiling(status: Form1099FilingStatus): boolean {
  return status === 'draft' || status === 'reviewed';
}

/** A filing with files to produce: generated, filed (to download again) or corrected. */
export function hasOutputs(status: Form1099FilingStatus): boolean {
  return status === 'generated' || status === 'filed' || status === 'corrected';
}

/** Lines that are on the form: not excluded, not replaced by a correction. */
export function liveLines(lines: readonly Form1099FilingLine[]): Form1099FilingLine[] {
  return lines.filter((line) => !line.superseded && line.status !== 'excluded');
}

/** Lines shown in the table: every line, with the replaced ones last so the current ones lead. */
export function sortLines(lines: readonly Form1099FilingLine[]): Form1099FilingLine[] {
  const rank = (line: Form1099FilingLine) => (line.superseded ? 2 : line.status === 'excluded' ? 1 : 0);
  return [...lines].sort((a, b) => rank(a) - rank(b));
}

/** What a line contributes to the filing: reported amount and tax withheld. */
export function lineAmounts(line: Pick<Form1099FilingLine, 'boxes'>): { amount: number; withheld: number } {
  return { amount: reportedAmount(line.boxes, false), withheld: reportedAmount(line.boxes, true) };
}

/** Lines of the filing that still block generation. */
export function unresolvedLines(lines: readonly Form1099FilingLine[]): Form1099FilingLine[] {
  return lines.filter((line) => line.status === 'needs_tin' || line.status === 'needs_address');
}

/** The lines a copy or file is made for: on the form, in the order shown. */
export function copyTargets(filing: Pick<Form1099Filing, 'status'>, lines: readonly Form1099FilingLine[]): Form1099FilingLine[] {
  const live = liveLines(lines).filter((line) => line.status === 'included' || line.status === 'filed');
  // A corrected filing prints only the corrections.
  return filing.status === 'corrected' ? live.filter((line) => line.isCorrected && line.status === 'included') : live;
}

// ---------------------------------------------------------------------------
// Typing amounts
// ---------------------------------------------------------------------------

/** `1,234.50` or `-12` as the user types it. `null` for anything that is not an amount with at most two decimals. */
export function parseAmountInput(text: string, options: { allowNegative?: boolean } = {}): number | null {
  const cleaned = text.trim().replaceAll(',', '').replace(/^\$/, '');
  const pattern = options.allowNegative ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/;
  if (!pattern.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export interface AdjustmentDraft {
  box: string;
  amount: string;
  reason: string;
}

export type AdjustmentProblem = 'amount' | 'zero' | 'reason' | 'box';

export interface AdjustmentCheck {
  adjustments: NonNullable<LinePatch['adjustments']>;
  problems: Array<{ index: number; problem: AdjustmentProblem }>;
}

/** Turns the drafts of the line editor into the request body, listing what is wrong with each row. */
export function checkAdjustmentDrafts(drafts: readonly AdjustmentDraft[]): AdjustmentCheck {
  const adjustments: NonNullable<LinePatch['adjustments']> = [];
  const problems: AdjustmentCheck['problems'] = [];
  drafts.forEach((draft, index) => {
    const amount = parseAmountInput(draft.amount, { allowNegative: true });
    if (!draft.box) problems.push({ index, problem: 'box' });
    else if (amount === null) problems.push({ index, problem: 'amount' });
    else if (amount === 0) problems.push({ index, problem: 'zero' });
    else if (!draft.reason.trim()) problems.push({ index, problem: 'reason' });
    else adjustments.push({ box: draft.box, amount, reason: draft.reason.trim() });
  });
  return { adjustments, problems };
}

export function draftsFromLine(line: Pick<Form1099FilingLine, 'adjustments'>): AdjustmentDraft[] {
  return (line.adjustments ?? []).map((adjustment) => ({
    box: adjustment.box,
    amount: String(adjustment.amount),
    reason: adjustment.reason,
  }));
}

/** Boxes of a correction typed by the user, as amounts. Boxes left empty are zero; a bad entry is reported by its box. */
export function parseBoxInputs(
  inputs: Readonly<Record<string, string>>,
): { boxes: Record<string, number>; invalid: string[] } {
  const boxes: Record<string, number> = {};
  const invalid: string[] = [];
  for (const [code, text] of Object.entries(inputs)) {
    if (!text.trim()) continue;
    const value = parseAmountInput(text);
    if (value === null) invalid.push(code);
    else if (value > 0) boxes[code] = value;
  }
  return { boxes, invalid };
}

/** Which of two box sets differ, so a correction that changes nothing can be refused before it is sent. */
export function boxesDiffer(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const codes = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const code of codes) {
    if (cents(a[code] ?? 0) !== cents(b[code] ?? 0)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Years
// ---------------------------------------------------------------------------

/** The tax year to open on: last year until March, then this year (the server's default too). */
export function defaultTaxYear(now = new Date()): number {
  return now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
}

/** Years to offer, newest first: this year down to five years back. */
export function taxYearChoices(now = new Date()): number[] {
  const latest = now.getFullYear();
  return Array.from({ length: 6 }, (_, index) => latest - index);
}

/** `YYYY-MM-DD` deadline from the server: days from `today` (negative when past). */
export function daysUntil(deadline: string, today: Date = new Date()): number {
  const [year, month, day] = deadline.split('-').map(Number);
  if (!year || !month || !day) return Number.NaN;
  const target = Date.UTC(year, month - 1, day);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - start) / 86_400_000);
}
