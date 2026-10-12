/**
 * Access to apps that are on request only (WeldReach first): the pure rules
 * the admin console shares between its server actions and its screens, kept
 * free of `server-only` and the database so they can be unit tested.
 *
 *   - which action is allowed from which status, and the update it makes
 *   - the limits form: text fields in, `WeldReachLimits` out
 *   - labels and rates for the request answers and the usage figures
 *
 * Reads and writes live in `lib/app-access-data.ts` and `actions/app-access.ts`.
 * See docs/plans/weldreach.md ("Access and gating").
 */

import {
  WELDREACH_APP_CODE,
  WELDREACH_CONSENT_COUNTRIES,
  WELDREACH_DEFAULT_LIMITS,
  weldReachLimitsSchema,
  resolveWeldReachLimits,
  type AppAccessStatus,
  type WeldReachLimits,
  type WeldReachTermKey,
} from '@weldsuite/app-api-client/schemas/reach';

export { WELDREACH_APP_CODE, WELDREACH_CONSENT_COUNTRIES };

/** The stored limits with the defaults filled in per key. */
export const resolveLimits = resolveWeldReachLimits;
export type { AppAccessStatus, WeldReachLimits };

export const ACCESS_STATUSES: readonly AppAccessStatus[] = ['requested', 'approved', 'rejected', 'suspended', 'revoked'];

export function isAccessStatus(value: unknown): value is AppAccessStatus {
  return typeof value === 'string' && (ACCESS_STATUSES as readonly string[]).includes(value);
}

export const STATUS_LABELS: Record<AppAccessStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  suspended: 'Suspended',
  revoked: 'Revoked',
};

// ---------------------------------------------------------------------------
// Status actions
// ---------------------------------------------------------------------------

export type AccessAction = 'approve' | 'reject' | 'suspend' | 'unsuspend' | 'revoke';

/** A workspace with no row at all is `none`: staff may grant it access without a request. */
type StartStatus = AppAccessStatus | 'none';

const ALLOWED_FROM: Record<AccessAction, readonly StartStatus[]> = {
  // Also from rejected / revoked: staff may change their mind without a new request.
  approve: ['none', 'requested', 'rejected', 'revoked'],
  reject: ['requested'],
  suspend: ['approved'],
  unsuspend: ['suspended'],
  revoke: ['approved', 'suspended'],
};

export const ACTION_TARGET: Record<AccessAction, AppAccessStatus> = {
  approve: 'approved',
  reject: 'rejected',
  suspend: 'suspended',
  unsuspend: 'approved',
  revoke: 'revoked',
};

const ACTION_ORDER: readonly AccessAction[] = ['approve', 'reject', 'unsuspend', 'suspend', 'revoke'];

export function availableActions(status: StartStatus): AccessAction[] {
  return ACTION_ORDER.filter((a) => ALLOWED_FROM[a].includes(status));
}

export const MIN_REASON_LENGTH = 3;

export interface AccessUpdate {
  status: AppAccessStatus;
  reviewedBy: string;
  reviewedAt: Date;
  /** Shown to the workspace while rejected; cleared by every other action. */
  rejectionReason: string | null;
  /** Shown to the workspace while suspended; cleared by every other action. */
  suspendedReason: string | null;
  /** Only set when the limits must change (approval of a row with none). */
  limits?: Record<string, unknown>;
}

export type PlannedUpdate = { ok: true; set: AccessUpdate } | { ok: false; error: string };

/**
 * What an action does to an access row, or why it is refused. Every action
 * needs a reason (it goes in the activity log); reject and suspend also show
 * it to the workspace. Revoking keeps its reason in the log only: the row has
 * no column for it.
 */
export function planAccessUpdate(params: {
  action: AccessAction;
  from: StartStatus;
  appCode: string;
  reason: string;
  reviewer: string;
  currentLimits: Record<string, unknown>;
  now?: Date;
}): PlannedUpdate {
  const { action, from, appCode, reviewer } = params;
  const reason = params.reason.trim();

  if (!ALLOWED_FROM[action].includes(from)) {
    return { ok: false, error: `Cannot ${action} access that is ${from === 'none' ? 'not requested' : from}.` };
  }
  if (reason.length < MIN_REASON_LENGTH) {
    return { ok: false, error: `Give a reason of at least ${MIN_REASON_LENGTH} characters.` };
  }

  const set: AccessUpdate = {
    status: ACTION_TARGET[action],
    reviewedBy: reviewer,
    reviewedAt: params.now ?? new Date(),
    rejectionReason: action === 'reject' ? reason : null,
    suspendedReason: action === 'suspend' ? reason : null,
  };
  if (action === 'approve' && appCode === WELDREACH_APP_CODE && Object.keys(params.currentLimits).length === 0) {
    set.limits = { ...WELDREACH_DEFAULT_LIMITS };
  }
  return { ok: true, set };
}

// ---------------------------------------------------------------------------
// Limits form
// ---------------------------------------------------------------------------

/** The limits as the form edits them: numbers as text, domains one per line. */
export interface LimitsFormValues {
  maxDomains: string;
  maxMailboxes: string;
  maxDailySends: string;
  allowConsumerRecipients: boolean;
  forceAllowDomains: string;
}

export function limitsToFormValues(stored: Record<string, unknown> | null | undefined): LimitsFormValues {
  const limits = resolveWeldReachLimits(stored);
  return {
    maxDomains: String(limits.maxDomains),
    maxMailboxes: String(limits.maxMailboxes),
    maxDailySends: String(limits.maxDailySends),
    allowConsumerRecipients: limits.allowConsumerRecipients,
    forceAllowDomains: limits.forceAllowDomains.join('\n'),
  };
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Splits the textarea on lines, commas and spaces; lowercases, strips a trailing dot, de-duplicates. */
export function parseDomainList(text: string): { domains: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const value = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!value) continue;
    if (!DOMAIN.test(value)) {
      invalid.push(raw.trim());
      continue;
    }
    seen.add(value);
  }
  return { domains: [...seen], invalid };
}

function parseCount(label: string, raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return { ok: false, error: `${label} must be a whole number, 0 or more.` };
  return { ok: true, value: Number(text) };
}

export function parseLimitsForm(
  values: LimitsFormValues,
): { ok: true; limits: WeldReachLimits } | { ok: false; error: string } {
  const domains = parseCount('Max domains', values.maxDomains);
  if (!domains.ok) return domains;
  const mailboxes = parseCount('Max mailboxes', values.maxMailboxes);
  if (!mailboxes.ok) return mailboxes;
  const sends = parseCount('Max daily sends', values.maxDailySends);
  if (!sends.ok) return sends;

  const list = parseDomainList(values.forceAllowDomains);
  if (list.invalid.length > 0) {
    return { ok: false, error: `Not a domain name: ${list.invalid.slice(0, 5).join(', ')}.` };
  }

  const parsed = weldReachLimitsSchema.safeParse({
    maxDomains: domains.value,
    maxMailboxes: mailboxes.value,
    maxDailySends: sends.value,
    allowConsumerRecipients: values.allowConsumerRecipients === true,
    forceAllowDomains: list.domains,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'The limits are not valid.' };
  }
  return { ok: true, limits: parsed.data };
}

// ---------------------------------------------------------------------------
// Request answers
// ---------------------------------------------------------------------------

export const LIST_SOURCE_LABELS: Record<string, string> = {
  own_customers: 'Own customers',
  own_research: 'Own research',
  bought_list: 'Bought list',
  other: 'Other',
};

/** The terms the requester ticks, in the contract's order. The keys come from `WELDREACH_TERMS`. */
export const TERM_LABELS: Record<WeldReachTermKey, string> = {
  b2b_only: 'Business addresses only, never consumers',
  comply_with_law: 'Complies with anti-spam and privacy law in every country emailed',
  identify_and_opt_out: 'Every email identifies the sender and has a working opt-out',
  lawful_lists: 'No bought lists collected without a lawful basis',
  suspension: 'WeldSuite may pause or suspend sending, and share details when required by law',
  responsible_for_content: 'Responsible for the content sent and the people contacted',
};

export function listSourceLabel(source: string): string {
  return LIST_SOURCE_LABELS[source] ?? source;
}

export function isConsentCountry(code: string): boolean {
  return (WELDREACH_CONSENT_COUNTRIES as readonly string[]).includes(code.toUpperCase());
}

/** `NL` → `Netherlands (NL)`; unknown codes are shown as they are. */
export function countryLabel(code: string): string {
  const upper = code.toUpperCase();
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(upper);
    return name && name !== upper ? `${name} (${upper})` : upper;
  } catch {
    return upper;
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** What the workspace has used. A figure is null when it could not be read (tables missing on an old tenant). */
export interface ReachUsage {
  domains: number | null;
  mailboxes: number | null;
  sent24h: number | null;
  sent7d: number | null;
  bounced7d: number | null;
  replies7d: number | null;
}

export const EMPTY_USAGE: ReachUsage = {
  domains: null,
  mailboxes: null,
  sent24h: null,
  sent7d: null,
  bounced7d: null,
  replies7d: null,
};

/** `part / whole` as a fraction, or null when there is nothing to divide by. */
export function rate(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null;
  return part / whole;
}

export function formatRate(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

export function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-GB');
}

/** `12 / 30`, or `12` when there is no limit to compare with, `—` when unknown. */
export function formatAgainstLimit(used: number | null, limit: number | null): string {
  if (used === null) return '—';
  return limit === null ? formatCount(used) : `${formatCount(used)} / ${formatCount(limit)}`;
}
