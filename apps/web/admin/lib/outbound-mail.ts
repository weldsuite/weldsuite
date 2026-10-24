/**
 * Outbound mail guard: the pure rules the admin console shares between its
 * server actions and its screens, kept free of `server-only` and the database
 * so the client components and the unit tests can use them.
 *
 *   - labels for states, trust levels, case triggers, verdicts and events
 *   - the trust level shown for a workspace (staff override or computed)
 *   - the limit overrides form: text fields in, `OutboundLimitOverrides` out
 *   - what a policy change writes: the new row and the trail events
 *
 * Reads live in `lib/outbound-mail-data.ts`, writes in `actions/outbound-mail.ts`,
 * the live view in `lib/mail-api.ts`. See docs/plans/weldmail-outbound-abuse.md
 * ("Staff tooling").
 */

import {
  OUTBOUND_CASE_SEVERITIES,
  OUTBOUND_CASE_STATUSES,
  OUTBOUND_CASE_TRIGGERS,
  OUTBOUND_DEFAULT_LIMITS,
  OUTBOUND_STATES,
  OUTBOUND_THRESHOLDS,
  OUTBOUND_TRUST_LEVELS,
  computeTrustLevel,
  outboundLimitOverridesSchema,
  type OutboundCaseSeverity,
  type OutboundCaseStatus,
  type OutboundCaseTrigger,
  type OutboundGuardMode,
  type OutboundLimitOverrides,
  type OutboundLimits,
  type OutboundPolicyUpdate,
  type OutboundState,
  type OutboundTrustLevel,
  type OutboundUsage,
} from '@weldsuite/app-api-client/schemas/outbound-mail';

export {
  OUTBOUND_CASE_SEVERITIES,
  OUTBOUND_CASE_STATUSES,
  OUTBOUND_CASE_TRIGGERS,
  OUTBOUND_DEFAULT_LIMITS,
  OUTBOUND_STATES,
  OUTBOUND_TRUST_LEVELS,
};
export type {
  OutboundCaseSeverity,
  OutboundCaseStatus,
  OutboundCaseTrigger,
  OutboundLimitOverrides,
  OutboundPolicyUpdate,
  OutboundState,
  OutboundTrustLevel,
};

/** Audit action written before a case snippet (customer mail content) is shown. */
export const SNIPPET_AUDIT_ACTION = 'outbound_mail.view_snippet';

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export const isOutboundState = (value: unknown): value is OutboundState => oneOf(OUTBOUND_STATES, value);
export const isTrustLevel = (value: unknown): value is OutboundTrustLevel => oneOf(OUTBOUND_TRUST_LEVELS, value);
export const isCaseStatus = (value: unknown): value is OutboundCaseStatus => oneOf(OUTBOUND_CASE_STATUSES, value);
export const isCaseTrigger = (value: unknown): value is OutboundCaseTrigger => oneOf(OUTBOUND_CASE_TRIGGERS, value);
export const isCaseSeverity = (value: unknown): value is OutboundCaseSeverity => oneOf(OUTBOUND_CASE_SEVERITIES, value);

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const STATE_LABELS: Record<OutboundState, string> = {
  active: 'Active',
  restricted: 'Restricted',
  hold: 'On hold',
  suspended: 'Suspended',
};

/** What each state does, for the policy form. */
export const STATE_HINTS: Record<OutboundState, string> = {
  active: 'The limits of the trust level apply.',
  restricted: 'Tight limits and no mail to first-contact recipients. Replies still go.',
  hold: 'No new conversations. Replies still go.',
  suspended: 'Nothing goes out, unless replies are allowed below.',
};

export const TRUST_LABELS: Record<OutboundTrustLevel, string> = {
  new: 'New',
  standard: 'Standard',
  trusted: 'Trusted',
};

export const TRIGGER_LABELS: Record<OutboundCaseTrigger, string> = {
  cold_outreach_template: 'Cold outreach template',
  phishing: 'Phishing',
  bounce_rate: 'Bounce rate',
  complaints: 'Complaints',
  risk_score: 'Risk score',
  platform_budget: 'Platform budget',
  staff_review: 'Staff review',
};

export const SEVERITY_LABELS: Record<OutboundCaseSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  urgent: 'Urgent',
};

export const CASE_STATUS_LABELS: Record<OutboundCaseStatus, string> = {
  open: 'Open',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
};

export const GUARD_MODE_LABELS: Record<OutboundGuardMode, string> = {
  off: 'Off',
  shadow: 'Shadow (logs, never blocks)',
  enforce: 'Enforcing',
};

const CATEGORY_LABELS: Record<string, string> = {
  personal_1to1: 'One-to-one',
  transactional: 'Transactional',
  cold_outreach: 'Cold outreach',
  marketing_bulk: 'Bulk marketing',
  phishing_or_scam: 'Phishing or scam',
  other: 'Other',
};

const SOURCE_LABELS: Record<string, string> = {
  compose: 'Compose',
  reply: 'Reply',
  forward: 'Forward',
  scheduled: 'Scheduled send',
  api: 'API',
  crm_sequence: 'CRM sequence',
  workflow: 'WeldConnect workflow',
  desk: 'WeldDesk',
  calendar: 'Calendar',
  meet: 'WeldMeet',
  sign: 'WeldSign',
  personal: 'Personal WeldMail',
  subscription: 'Subscription',
};

const EVENT_KIND_LABELS: Record<string, string> = {
  state_changed: 'State changed',
  trust_changed: 'Trust level changed',
  limits_changed: 'Limits changed',
  case_opened: 'Case opened',
  case_reviewed: 'Case reviewed',
  platform_breaker: 'Platform breaker',
};

const DENIAL_LABELS: Record<string, string> = {
  SENDING_LIMITED: 'Volume limit reached',
  FIRST_CONTACT_LIMITED: 'First-contact limit reached',
  SENDING_ON_HOLD: 'On hold',
  SENDING_SUSPENDED: 'Suspended',
  SENDER_NOT_OWNED: 'Sender not owned',
  TOO_MANY_RECIPIENTS: 'Too many recipients',
  RECIPIENT_SUPPRESSED: 'Recipient suppressed',
  PLATFORM_LIMITED: 'Platform budget reached',
};

export function guardModeLabel(mode: string): string {
  return (GUARD_MODE_LABELS as Record<string, string>)[mode] ?? humanizeKey(mode);
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? humanizeKey(category);
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? humanizeKey(source);
}

export function eventKindLabel(kind: string): string {
  return EVENT_KIND_LABELS[kind] ?? humanizeKey(kind);
}

/** A trail event's from/to value in words: states, trust levels, triggers and case statuses get their labels. */
export function eventValueLabel(kind: string, value: string | null): string {
  if (value === null || value === '') return '—';
  if (kind === 'state_changed' && isOutboundState(value)) return STATE_LABELS[value];
  if (kind === 'trust_changed') return isTrustLevel(value) ? TRUST_LABELS[value] : humanizeKey(value);
  if (kind === 'case_opened' && isCaseTrigger(value)) return TRIGGER_LABELS[value];
  if (kind === 'case_reviewed' && isCaseStatus(value)) return CASE_STATUS_LABELS[value];
  return value;
}

export function denialLabel(code: string): string {
  return DENIAL_LABELS[code] ?? humanizeKey(code.toLowerCase());
}

/** `firstContactRecipients` / `hard_bounce_rate` → "First contact recipients" / "Hard bounce rate". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_\-.:]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

/** The workspace columns the computed trust level depends on. */
export interface WorkspaceTrustFacts {
  createdAt: Date | string;
  subscriptionStatus: string | null;
  /** `plans.priceMonthly` (a numeric column, so it arrives as a string). */
  planPriceMonthly: string | number | null;
  compGrantedAt: Date | string | null;
  billingMode: string | null;
}

/**
 * The trust level the guard computes from the workspace alone, the way
 * `loadLedgerPolicy` in `@weldsuite/mail-domain/outbound` does (comp plans and
 * partner-billed workspaces count as paid). Without the ledger's 7-day bounce
 * and complaint rates it never reaches `trusted` on its own; the live view on
 * the workspace screen shows the level the guard really applies.
 */
export function computedTrustFromWorkspace(facts: WorkspaceTrustFacts, now: Date = new Date()): OutboundTrustLevel {
  const price = facts.planPriceMonthly === null ? null : Number(facts.planPriceMonthly);
  return computeTrustLevel({
    createdAt: new Date(facts.createdAt),
    subscriptionStatus: facts.subscriptionStatus,
    planPriceMonthly: price === null || Number.isNaN(price) ? null : price,
    compGranted: Boolean(facts.compGrantedAt) || facts.billingMode === 'partner',
    trustOverride: null,
    hardBounceRate7d: null,
    complaintRate7d: null,
    now,
  });
}

export interface TrustDisplay {
  level: OutboundTrustLevel;
  /** True when staff pinned the level on the policy. */
  pinned: boolean;
  label: string;
}

/** The staff override when there is one, otherwise the computed level, labelled as such. */
export function trustDisplay(override: string | null | undefined, computed: OutboundTrustLevel): TrustDisplay {
  if (isTrustLevel(override)) {
    return { level: override, pinned: true, label: `${TRUST_LABELS[override]} (set by staff)` };
  }
  return { level: computed, pinned: false, label: `${TRUST_LABELS[computed]} (computed)` };
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export type RiskTone = 'low' | 'review' | 'high' | 'critical';

/** Bands from OUTBOUND_THRESHOLDS: AI review from 40, restricted from 70, hold from 90. */
export function riskTone(score: number | null | undefined): RiskTone {
  const value = score ?? 0;
  if (value >= OUTBOUND_THRESHOLDS.riskHold) return 'critical';
  if (value >= OUTBOUND_THRESHOLDS.riskRestricted) return 'high';
  if (value >= OUTBOUND_THRESHOLDS.riskReviewMin) return 'review';
  return 'low';
}

function percent(value: number, digits = 1): string {
  const factor = 10 ** digits;
  return `${Math.round(value * 100 * factor) / factor}%`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

/**
 * One of the guard's machine risk reasons (`first_contact_share:0.80`,
 * `complaints:2`, …; see `computeRisk` in the mail domain) in plain English.
 * Unknown reasons come back as they are.
 */
export function describeRiskReason(reason: string): string {
  const [key, raw] = reason.split(':', 2);
  const value = raw === undefined ? Number.NaN : Number(raw);
  const has = !Number.isNaN(value);
  switch (key) {
    case 'phishing_verdict':
      return 'The AI called a template phishing or a scam';
    case 'first_contact_share':
      return has ? `${percent(value, 0)} of today's recipients are first contact` : reason;
    case 'template_first_contact':
      return has ? `One template reached ${plural(value, 'first-contact recipient', 'first-contact recipients')} today` : reason;
    case 'hard_bounce_rate':
      return has ? `Hard bounce rate over 7 days is ${percent(value)}` : reason;
    case 'complaints':
      return has ? `${plural(value, 'complaint', 'complaints')} in 7 days` : reason;
    case 'flagged_content':
      return "Over 30% of today's sends tripped the content screen";
    case 'automated_first_contact':
      return 'Mostly automated sends (API, sequences, workflows) to first-contact recipients';
    case 'cold_templates':
      return has ? `${plural(value, 'template', 'templates')} classified as cold outreach today` : reason;
    default:
      return reason;
  }
}

// ---------------------------------------------------------------------------
// Limits form
// ---------------------------------------------------------------------------

export const LIMIT_KEYS = [
  'recipientsPerMessage',
  'senderPerHour',
  'senderPerDay',
  'workspacePerDay',
  'firstContactPerDay',
  'repliesPerSenderPerDay',
  'monthlyRecipients',
] as const satisfies readonly (keyof OutboundLimits)[];
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const LIMIT_FIELDS: Record<LimitKey, { label: string; hint: string }> = {
  recipientsPerMessage: { label: 'Recipients per message', hint: 'To, cc and bcc together. 1 to 50.' },
  senderPerHour: { label: 'Per sender per hour', hint: 'Recipients one address may reach in the clock hour.' },
  senderPerDay: { label: 'Per sender per day', hint: 'Recipients one address may reach in 24 hours.' },
  workspacePerDay: { label: 'Workspace per day', hint: 'Recipients the whole workspace may reach in 24 hours.' },
  firstContactPerDay: { label: 'First contact per day', hint: 'Recipients who never wrote to the workspace.' },
  repliesPerSenderPerDay: { label: 'Reply floor per sender', hint: 'Replies that always go, even when other windows are full.' },
  monthlyRecipients: { label: 'Recipients per month', hint: 'Calendar month, whole workspace. Blank = no monthly cap.' },
};

export type LimitOverrideFormValues = Record<LimitKey, string>;

/** The stored overrides that are still valid, key by key (a bad key is dropped, not the lot). */
export function cleanLimitOverrides(raw: unknown): OutboundLimitOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const clean: OutboundLimitOverrides = {};
  for (const key of LIMIT_KEYS) {
    if (!(key in source)) continue;
    const parsed = outboundLimitOverridesSchema.shape[key].safeParse(source[key]);
    if (parsed.success && parsed.data !== undefined) Object.assign(clean, { [key]: parsed.data });
  }
  return clean;
}

/** Stored overrides as form text; a blank field means "use the default". */
export function limitOverridesToForm(raw: unknown): LimitOverrideFormValues {
  const clean = cleanLimitOverrides(raw);
  const values = {} as LimitOverrideFormValues;
  for (const key of LIMIT_KEYS) {
    const value = clean[key];
    values[key] = value === undefined || value === null ? '' : String(value);
  }
  return values;
}

/** The default a blank field falls back to, for the placeholder. */
export function limitDefault(key: LimitKey, trustLevel: OutboundTrustLevel, state: OutboundState): string {
  const set = state === 'restricted' ? OUTBOUND_DEFAULT_LIMITS.restricted : OUTBOUND_DEFAULT_LIMITS[trustLevel];
  const value = set[key];
  return value === null ? 'No cap' : value.toLocaleString('en-GB');
}

/** Form text in, overrides out. Blank fields are not overridden; everything else must be a whole number in range. */
export function parseLimitOverridesForm(
  values: LimitOverrideFormValues,
): { ok: true; limits: OutboundLimitOverrides } | { ok: false; error: string } {
  const candidate: Record<string, number> = {};
  for (const key of LIMIT_KEYS) {
    // Thousands separators and spaces are fine ("2,000"); a decimal point is not.
    const text = (values[key] ?? '').replace(/[\s,_]/g, '');
    if (text === '') continue;
    if (!/^\d+$/.test(text)) return { ok: false, error: `${LIMIT_FIELDS[key].label} must be a whole number, 0 or more.` };
    candidate[key] = Number(text);
  }
  const parsed = outboundLimitOverridesSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path[0];
    const label = typeof key === 'string' && key in LIMIT_FIELDS ? LIMIT_FIELDS[key as LimitKey].label : 'A limit';
    return { ok: false, error: issue ? `${label}: ${issue.message.toLowerCase()}.` : 'The limits are not valid.' };
  }
  return { ok: true, limits: parsed.data };
}

/** Same keys with the same values (key order does not matter). */
export function sameLimitOverrides(a: OutboundLimitOverrides, b: OutboundLimitOverrides): boolean {
  return LIMIT_KEYS.every((key) => (a[key] ?? undefined) === (b[key] ?? undefined));
}

// ---------------------------------------------------------------------------
// Policy changes
// ---------------------------------------------------------------------------

/** The staff-editable part of a policy row. */
export interface PolicySnapshot {
  trustOverride: OutboundTrustLevel | null;
  limits: OutboundLimitOverrides;
  state: OutboundState;
  stateReason: string | null;
  allowRepliesWhenSuspended: boolean;
  notes: string | null;
}

/** What a workspace without a policy row has. */
export const DEFAULT_POLICY: PolicySnapshot = {
  trustOverride: null,
  limits: {},
  state: 'active',
  stateReason: null,
  allowRepliesWhenSuspended: false,
  notes: null,
};

export type PolicyField = keyof PolicySnapshot;

export interface PlannedOutboundEvent {
  kind: 'state_changed' | 'trust_changed' | 'limits_changed';
  fromValue: string | null;
  toValue: string | null;
  details?: Record<string, unknown>;
}

export type PolicyPlan =
  | { ok: true; next: PolicySnapshot; changed: PolicyField[]; stateChanged: boolean; events: PlannedOutboundEvent[] }
  | { ok: false; error: string };

function blankToNull(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
}

/** Just the staff-editable fields of a policy row (drops the risk score, timestamps and ids). */
export function pickPolicySnapshot(policy: PolicySnapshot): PolicySnapshot {
  return {
    trustOverride: policy.trustOverride,
    limits: policy.limits,
    state: policy.state,
    stateReason: policy.stateReason,
    allowRepliesWhenSuspended: policy.allowRepliesWhenSuspended,
    notes: policy.notes,
  };
}

/** The fields that differ between two policies, in form order. */
export function changedFields(current: PolicySnapshot, next: PolicySnapshot): PolicyField[] {
  const differs: Record<PolicyField, boolean> = {
    trustOverride: next.trustOverride !== current.trustOverride,
    limits: !sameLimitOverrides(next.limits, current.limits),
    state: next.state !== current.state,
    stateReason: next.stateReason !== current.stateReason,
    allowRepliesWhenSuspended: next.allowRepliesWhenSuspended !== current.allowRepliesWhenSuspended,
    notes: next.notes !== current.notes,
  };
  return (Object.keys(differs) as PolicyField[]).filter((field) => differs[field]);
}

/** Who set something, for display: the guard's own changes are recorded as `system`. */
export function actorLabel(actor: string | null | undefined): string | null {
  if (!actor) return null;
  return actor === 'system' ? 'the guard' : actor;
}

/**
 * Apply a validated update to the current policy: the row to store, which
 * fields changed, and the trail events (`state_changed`, `trust_changed`,
 * `limits_changed`). Fields the update leaves out keep their value.
 *
 * Back to `active` clears the customer-facing reason; any other new state needs
 * one, because the customer sees it in WeldMail.
 */
export function planPolicyUpdate(current: PolicySnapshot, update: OutboundPolicyUpdate): PolicyPlan {
  const state = update.state ?? current.state;
  const stateChanged = state !== current.state;
  let stateReason = update.stateReason === undefined ? current.stateReason : blankToNull(update.stateReason);
  if (state === 'active') stateReason = null;
  if (stateChanged && state !== 'active' && (stateReason === null || stateReason.length < 3)) {
    return { ok: false, error: `Give the customer a reason for "${STATE_LABELS[state]}". They see it in WeldMail.` };
  }

  const next: PolicySnapshot = {
    trustOverride: update.trustOverride === undefined ? current.trustOverride : update.trustOverride,
    limits: update.limits === undefined ? current.limits : cleanLimitOverrides(update.limits),
    state,
    stateReason,
    allowRepliesWhenSuspended: update.allowRepliesWhenSuspended ?? current.allowRepliesWhenSuspended,
    notes: update.notes === undefined ? current.notes : blankToNull(update.notes),
  };

  const changed = changedFields(current, next);
  const events: PlannedOutboundEvent[] = [];
  if (stateChanged) {
    events.push({
      kind: 'state_changed',
      fromValue: current.state,
      toValue: next.state,
      details: { customerReason: next.stateReason, allowRepliesWhenSuspended: next.allowRepliesWhenSuspended },
    });
  }
  if (changed.includes('trustOverride')) {
    events.push({
      kind: 'trust_changed',
      fromValue: current.trustOverride ?? 'computed',
      toValue: next.trustOverride ?? 'computed',
    });
  }
  if (changed.includes('limits')) {
    events.push({
      kind: 'limits_changed',
      fromValue: plural(Object.keys(current.limits).length, 'override', 'overrides'),
      toValue: plural(Object.keys(next.limits).length, 'override', 'overrides'),
      details: { before: current.limits, after: next.limits },
    });
  }

  return { ok: true, next, changed, stateChanged, events };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface CaseVerdictView {
  category: string;
  unsolicited: boolean;
  confidence: number;
  signals: string[];
  modelId: string | null;
}

/** "Cold outreach, 82% sure, unsolicited". */
export function verdictLine(verdict: CaseVerdictView): string {
  const parts = [categoryLabel(verdict.category), `${Math.round(verdict.confidence * 100)}% sure`];
  if (verdict.unsolicited) parts.push('unsolicited');
  return parts.join(', ');
}

export interface MetricItem {
  label: string;
  value: string;
}

function metricValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value) ? value.toLocaleString('en-GB') : value.toLocaleString('en-GB', { maximumFractionDigits: 3 });
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * A case's metrics as the screen shows them: the one-sentence `summary` the
 * guard wrote apart, the rest as label/value pairs in their stored order.
 */
export function caseMetrics(metrics: unknown): { summary: string | null; items: MetricItem[] } {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return { summary: null, items: [] };
  const entries = Object.entries(metrics as Record<string, unknown>);
  const summaryValue = (metrics as Record<string, unknown>).summary;
  const summary = typeof summaryValue === 'string' && summaryValue.trim() ? summaryValue.trim() : null;
  const items = entries
    .filter(([key]) => key !== 'summary')
    .map(([key, value]) => ({ label: humanizeKey(key), value: metricValue(value) }));
  return { summary, items };
}

/** Review buttons a case offers: the statuses it is not in (an open case can go either way). */
export function reviewOptions(status: OutboundCaseStatus): Array<'confirmed' | 'dismissed'> {
  if (status === 'confirmed') return ['dismissed'];
  if (status === 'dismissed') return ['confirmed'];
  return ['confirmed', 'dismissed'];
}

// ---------------------------------------------------------------------------
// Live data from mail-api
// ---------------------------------------------------------------------------

export interface PlatformStatus {
  tripped: boolean;
  recipients: number;
  quota: number | null;
  reason: string | null;
}

export function isPlatformStatus(value: unknown): value is PlatformStatus {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.tripped === 'boolean' &&
    typeof v.recipients === 'number' &&
    (v.quota === null || typeof v.quota === 'number') &&
    (v.reason === null || v.reason === undefined || typeof v.reason === 'string')
  );
}

/** mail-api `GET /internal/outbound/inspect`: the ledger's live view of one workspace. */
export interface OutboundInspect {
  usage: OutboundUsage;
  riskScore: number;
  riskReasons: string[];
  /** Would-be denials in shadow mode over the last 7 days, by denial code. */
  shadowDenials7d: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isWindow(value: unknown): boolean {
  return isRecord(value) && typeof value.used === 'number';
}

/** Checks the parts of the answer the screen reads, so a changed contract shows as an error, not a crash. */
export function isOutboundInspect(value: unknown): value is OutboundInspect {
  if (!isRecord(value) || !isRecord(value.usage)) return false;
  const usage = value.usage;
  const workspace = usage.workspace;
  return (
    typeof value.riskScore === 'number' &&
    Array.isArray(value.riskReasons) &&
    isRecord(value.shadowDenials7d) &&
    isTrustLevel(usage.trustLevel) &&
    isOutboundState(usage.state) &&
    typeof usage.mode === 'string' &&
    isRecord(usage.limits) &&
    Array.isArray(usage.senders) &&
    isRecord(usage.deliveries7d) &&
    isRecord(workspace) &&
    typeof workspace.hour === 'number' &&
    isWindow(workspace.day) &&
    isWindow(workspace.firstContactDay) &&
    isWindow(workspace.month)
  );
}

/** Share of the quota used, or null when there is no quota. */
export function quotaShare(used: number, quota: number | null): number | null {
  if (quota === null || quota <= 0) return null;
  return used / quota;
}

/** "1,234 of 50,000 (2.5%)", or just the count without a quota. */
export function formatAgainstQuota(used: number, quota: number | null): string {
  const share = quotaShare(used, quota);
  if (quota === null || share === null) return used.toLocaleString('en-GB');
  return `${used.toLocaleString('en-GB')} of ${quota.toLocaleString('en-GB')} (${percent(share)})`;
}

/** A rate as "2.1%", or a dash when there is nothing to divide by. */
export function formatShare(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return percent(part / whole);
}

// ---------------------------------------------------------------------------
// Screen filters
// ---------------------------------------------------------------------------

export interface OutboundFilters {
  state: OutboundState | 'all';
  status: OutboundCaseStatus | 'all';
  trigger: OutboundCaseTrigger | 'all';
  severity: OutboundCaseSeverity | 'all';
  caseId: string | null;
}

/** Search params in, filters out. Cases default to `open`, everything else to `all`. */
export function readFilters(params: Record<string, string | string[] | undefined>): OutboundFilters {
  const one = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const state = one('state');
  const status = one('status');
  const trigger = one('trigger');
  const severity = one('severity');
  const caseId = one('case')?.trim() ?? '';
  let caseStatus: OutboundCaseStatus | 'all' = 'open';
  if (status === 'all') caseStatus = 'all';
  else if (isCaseStatus(status)) caseStatus = status;
  return {
    state: isOutboundState(state) ? state : 'all',
    status: caseStatus,
    trigger: isCaseTrigger(trigger) ? trigger : 'all',
    severity: isCaseSeverity(severity) ? severity : 'all',
    caseId: caseId && caseId.length <= 30 ? caseId : null,
  };
}

/** `/outbound-mail` with the given filters; defaults are left out of the URL. */
export function outboundHref(filters: OutboundFilters, change: Partial<OutboundFilters> = {}): string {
  const f = { ...filters, ...change };
  const params = new URLSearchParams();
  if (f.state !== 'all') params.set('state', f.state);
  if (f.status !== 'open') params.set('status', f.status);
  if (f.trigger !== 'all') params.set('trigger', f.trigger);
  if (f.severity !== 'all') params.set('severity', f.severity);
  if (f.caseId) params.set('case', f.caseId);
  const qs = params.toString();
  return qs ? `/outbound-mail?${qs}` : '/outbound-mail';
}
