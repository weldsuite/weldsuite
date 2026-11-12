/**
 * WeldForms moderation, the pure parts (docs/plans/weldforms.md, "Bot checks
 * and abuse"). The master `form_link_registry` row decides whether a public
 * form answers: forms-api reads `suspended_at` and `held_at` on every public
 * request, so writing them takes effect at once.
 */

export const REPORT_STATUSES = ['open', 'dismissed', 'actioned'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export type ReportFilter = ReportStatus | 'all';

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  open: 'Open',
  dismissed: 'Dismissed',
  actioned: 'Actioned',
};

export const REPORT_REASON_LABELS: Record<string, string> = {
  phishing: 'Phishing',
  spam: 'Spam',
  illegal: 'Illegal content',
  other: 'Other',
};

export const MIN_REASON_LENGTH = 3;

/** Where the respondent portal lives when `FORMS_PORTAL_URL` is not set. */
export const DEFAULT_PORTAL_URL = 'https://forms.weldsuite.org';

export function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === 'string' && (REPORT_STATUSES as readonly string[]).includes(value);
}

/** The status filter from the search params; open when absent or unknown. */
export function readReportFilter(value: unknown): ReportFilter {
  if (value === 'all') return 'all';
  return isReportStatus(value) ? value : 'open';
}

export function reasonLabel(reason: string): string {
  return REPORT_REASON_LABELS[reason] ?? reason;
}

/** Drops every trailing slash with a single scan (a `/\/+$/` regex backtracks quadratically on long runs). */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/** The public link of a published form, without a trailing slash on the portal. */
export function publicFormUrl(portalUrl: string, publicId: string): string {
  return `${stripTrailingSlashes(portalUrl)}/f/${encodeURIComponent(publicId)}`;
}

export type FormState = 'suspended' | 'held' | 'live';

/** What respondents see: suspension wins over a hold. */
export function formState(row: { suspendedAt: unknown; heldAt: unknown }): FormState {
  if (row.suspendedAt) return 'suspended';
  if (row.heldAt) return 'held';
  return 'live';
}

/** A reason typed by staff: trimmed, at least three characters. Null when it is not usable. */
export function cleanReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= MIN_REASON_LENGTH && trimmed.length <= 500 ? trimmed : null;
}

/** Only an open report is resolved. */
export function canResolveReport(from: ReportStatus): boolean {
  return from === 'open';
}

export function weldformsHref(status: ReportFilter): string {
  return status === 'open' ? '/weldforms' : `/weldforms?status=${status}`;
}
