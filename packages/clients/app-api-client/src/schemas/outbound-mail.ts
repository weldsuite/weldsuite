/**
 * Outbound mail guard: the contract between the send paths (mail-api,
 * external-api, crm-api, app-api, desk-api, personal-api, calendar-api,
 * meet-api), the admin console and the platform. Zod v3 schemas, response
 * types and the shared constants (limits, thresholds, error codes) every side
 * has to agree on.
 *
 * WeldMail is for one-to-one business mail; cold outreach belongs in WeldReach.
 * See docs/plans/weldmail-outbound-abuse.md.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Trust levels and states
// ---------------------------------------------------------------------------

/**
 * How much a workspace is trusted to send. `new` and `standard` are computed
 * (age + paid plan); staff can pin any level, `trusted` only comes from staff
 * or from a long clean record.
 */
export const OUTBOUND_TRUST_LEVELS = ['new', 'standard', 'trusted'] as const;
export type OutboundTrustLevel = (typeof OUTBOUND_TRUST_LEVELS)[number];

/**
 * Enforcement state. `restricted` and `hold` are set automatically on bad
 * signals (or by staff); `suspended` only by staff. Automatic actions only
 * ever tighten: lifting a state is a staff action.
 */
export const OUTBOUND_STATES = ['active', 'restricted', 'hold', 'suspended'] as const;
export type OutboundState = (typeof OUTBOUND_STATES)[number];

/** `shadow` decides and logs but never blocks; `enforce` blocks; `off` skips the ledger. */
export const OUTBOUND_GUARD_MODES = ['off', 'shadow', 'enforce'] as const;
export type OutboundGuardMode = (typeof OUTBOUND_GUARD_MODES)[number];

/** Where a send came from. Weighs into the risk score and shows in staff cases. */
export const OUTBOUND_SOURCES = [
  'compose',
  'reply',
  'forward',
  'scheduled',
  'api',
  'crm_sequence',
  'workflow',
  'desk',
  'calendar',
  'meet',
  'personal',
  'subscription',
] as const;
export type OutboundSource = (typeof OUTBOUND_SOURCES)[number];

/** `reply` = answering someone who wrote to the mailbox; everything else starts a conversation. */
export const OUTBOUND_KINDS = ['reply', 'new_thread', 'forward'] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

// ---------------------------------------------------------------------------
// Limits (recipients, not messages: Cloudflare counts envelopes)
// ---------------------------------------------------------------------------

export const outboundLimitsSchema = z.object({
  /** Recipients (to + cc + bcc) in one message. */
  recipientsPerMessage: z.number().int().min(1).max(50),
  /** Recipients one sender address may reach in the current clock hour. */
  senderPerHour: z.number().int().min(0).max(100_000),
  /** Recipients one sender address may reach over the last 24 hours. */
  senderPerDay: z.number().int().min(0).max(1_000_000),
  /** Recipients the whole workspace may reach over the last 24 hours. */
  workspacePerDay: z.number().int().min(0).max(10_000_000),
  /** Recipients who never wrote to the workspace, over the last 24 hours. */
  firstContactPerDay: z.number().int().min(0).max(1_000_000),
  /** Reply recipients one sender may always reach per day, even when other windows are full. */
  repliesPerSenderPerDay: z.number().int().min(0).max(1_000_000),
  /** Recipients per calendar month for the workspace; null = no monthly cap. */
  monthlyRecipients: z.number().int().min(0).max(100_000_000).nullable(),
});
export type OutboundLimits = z.infer<typeof outboundLimitsSchema>;

/** Staff overrides stored on the policy row (any subset of the limits). */
export const outboundLimitOverridesSchema = outboundLimitsSchema.partial();
export type OutboundLimitOverrides = z.infer<typeof outboundLimitOverridesSchema>;

/** Defaults per trust level, plus the `restricted` state's own set. */
export const OUTBOUND_DEFAULT_LIMITS: Record<OutboundTrustLevel | 'restricted', OutboundLimits> = {
  new: {
    recipientsPerMessage: 20,
    senderPerHour: 30,
    senderPerDay: 150,
    workspacePerDay: 300,
    firstContactPerDay: 50,
    repliesPerSenderPerDay: 150,
    monthlyRecipients: null,
  },
  standard: {
    recipientsPerMessage: 50,
    senderPerHour: 100,
    senderPerDay: 500,
    workspacePerDay: 2_000,
    firstContactPerDay: 200,
    repliesPerSenderPerDay: 500,
    monthlyRecipients: null,
  },
  trusted: {
    recipientsPerMessage: 50,
    senderPerHour: 400,
    senderPerDay: 2_000,
    workspacePerDay: 10_000,
    firstContactPerDay: 1_000,
    repliesPerSenderPerDay: 2_000,
    monthlyRecipients: null,
  },
  restricted: {
    recipientsPerMessage: 10,
    senderPerHour: 10,
    senderPerDay: 50,
    workspacePerDay: 200,
    firstContactPerDay: 0,
    repliesPerSenderPerDay: 200,
    monthlyRecipients: null,
  },
};

/** Personal WeldMail (personal-api), by its own plans. */
export const OUTBOUND_PERSONAL_LIMITS: Record<'free' | 'pro', OutboundLimits> = {
  free: { ...OUTBOUND_DEFAULT_LIMITS.new, senderPerDay: 50, workspacePerDay: 50, repliesPerSenderPerDay: 50 },
  pro: { ...OUTBOUND_DEFAULT_LIMITS.standard, workspacePerDay: 500 },
};

/** Shared-domain addresses (`*.weldmail.com`) share one reputation: tight first-contact cap. */
export const WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY = 20;

/** Ceiling for a mailbox's own `dailySendLimit` setting (it can lower, never raise, the policy). */
export const MAILBOX_DAILY_SEND_LIMIT_MAX = 2_000;

/**
 * Effective limits: the trust level's defaults (or `restricted`'s while that
 * state is active) with staff overrides on top. A `restricted` state never
 * loosens below its own defaults through an override of the trust level.
 */
export function resolveOutboundLimits(
  trustLevel: OutboundTrustLevel,
  state: OutboundState,
  overrides: Record<string, unknown> | null | undefined,
): OutboundLimits {
  const parsed = outboundLimitOverridesSchema.safeParse(overrides ?? {});
  const extra = parsed.success ? parsed.data : {};
  if (state === 'restricted') return { ...OUTBOUND_DEFAULT_LIMITS.restricted };
  return { ...OUTBOUND_DEFAULT_LIMITS[trustLevel], ...extra };
}

/**
 * Apex zones that host shared WeldMail addresses: production's, and the test
 * environment's own zone (so test mail has its own Email Routing catch-all,
 * docs/plans/weldmail-test-mail-zone.md). Which one new domains are built on
 * is the worker's `WELDMAIL_DOMAIN` var; recognising a shared domain is not
 * environment-dependent.
 */
export const SHARED_WELDMAIL_APEXES = ['weldmail.com', 'weldmail.org'] as const;

/** The apex a worker builds `{slug}.{apex}` on when `WELDMAIL_DOMAIN` is unset. */
export const DEFAULT_WELDMAIL_APEX = 'weldmail.com';

/** True for a shared WeldMail apex and every workspace subdomain of one. */
export function isSharedWeldMailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return SHARED_WELDMAIL_APEXES.some((apex) => d === apex || d.endsWith(`.${apex}`));
}

/** True for a bare shared apex (`weldmail.com`), not a workspace subdomain. */
export function isSharedWeldMailApex(domain: string): boolean {
  return (SHARED_WELDMAIL_APEXES as readonly string[]).includes(domain.toLowerCase());
}

/** A workspace's shared mail domain: `{slug}.{apex}`. */
export function weldMailDomainFor(slug: string, apex: string | undefined): string {
  return `${slug}.${apex || DEFAULT_WELDMAIL_APEX}`;
}

// ---------------------------------------------------------------------------
// Trust computation
// ---------------------------------------------------------------------------

export const OUTBOUND_TRUST_RULES = {
  /** A workspace younger than this stays `new`. */
  newWorkspaceDays: 14,
  /** Paid this long with a clean record → `trusted` automatically. */
  trustedAfterDays: 60,
  trustedMaxHardBounceRate: 0.02,
  trustedMaxComplaintRate: 0.001,
} as const;

/** Subscription states that count as paying. */
const PAID_SUBSCRIPTION_STATES = new Set(['active', 'past_due']);

export interface TrustInput {
  createdAt: Date;
  /** `workspaces.subscriptionStatus`. */
  subscriptionStatus: string | null;
  /** The plan's monthly price (`plans.priceMonthly`) as a number; 0 = free plan. */
  planPriceMonthly: number | null;
  /** A comp (free-of-charge granted) paid plan counts as paid. */
  compGranted: boolean;
  /** Staff override on the policy row. */
  trustOverride: OutboundTrustLevel | null;
  /** Over the last 7 days, from the ledger; null when there is too little data. */
  hardBounceRate7d: number | null;
  complaintRate7d: number | null;
  now?: Date;
}

/**
 * `new` until the workspace is 14 days old AND pays (owner decision
 * 2026-10-13); `trusted` after 60 paid days with a clean record; staff can pin
 * any level.
 */
export function computeTrustLevel(input: TrustInput): OutboundTrustLevel {
  if (input.trustOverride) return input.trustOverride;
  const now = input.now ?? new Date();
  const ageDays = (now.getTime() - input.createdAt.getTime()) / 86_400_000;
  const paid =
    input.compGranted ||
    (PAID_SUBSCRIPTION_STATES.has(input.subscriptionStatus ?? '') && (input.planPriceMonthly ?? 0) > 0);
  if (!paid || ageDays < OUTBOUND_TRUST_RULES.newWorkspaceDays) return 'new';
  const clean =
    input.hardBounceRate7d !== null &&
    input.complaintRate7d !== null &&
    input.hardBounceRate7d <= OUTBOUND_TRUST_RULES.trustedMaxHardBounceRate &&
    input.complaintRate7d <= OUTBOUND_TRUST_RULES.trustedMaxComplaintRate;
  if (ageDays >= OUTBOUND_TRUST_RULES.trustedAfterDays && clean) return 'trusted';
  return 'standard';
}

// ---------------------------------------------------------------------------
// Detection thresholds (tuned in shadow mode)
// ---------------------------------------------------------------------------

export const OUTBOUND_THRESHOLDS = {
  /** A template the AI calls cold outreach may reach this many first-contact recipients a day. */
  coldTemplateFirstContactPerDay: 25,
  /** Queue an AI review once a template reached this many first-contact recipients in a day. */
  reviewFirstContactRecipients: 10,
  /** First-contact sends of a `new` workspace sampled for AI review per day. */
  newWorkspaceReviewSamplesPerDay: 20,
  /** Verdict confidence needed before a cold-outreach verdict caps a template. */
  coldOutreachConfidence: 0.7,
  /** Verdict confidence that puts the workspace on hold for staff. */
  phishingConfidence: 0.8,
  /** Hard bounces over all recipients in 7 days, with a minimum sample. */
  hardBounceRate: 0.05,
  hardBounceMinRecipients: 20,
  /** Complaints in 7 days, or as a share of recipients. */
  complaints7d: 2,
  complaintRate: 0.003,
  /** Risk score → automatic state. */
  riskRestricted: 70,
  riskHold: 90,
  /** Grey zone that triggers an AI review of the day's top template. */
  riskReviewMin: 40,
  /** Share of the Cloudflare account quota customer mail may use before first contact stops. */
  platformBudgetRatio: 0.7,
} as const;

/** Near-duplicate templates: SimHash fingerprints within this Hamming distance match. */
export const FINGERPRINT_MAX_DISTANCE = 3;

// ---------------------------------------------------------------------------
// Denials (shared error codes for every send path and the clients)
// ---------------------------------------------------------------------------

export const OUTBOUND_DENIAL_CODES = [
  /** A volume window (hour, day, month) is full. */
  'SENDING_LIMITED',
  /** The first-contact window, or a cold-outreach template's cap, is full. */
  'FIRST_CONTACT_LIMITED',
  /** New conversations are paused while staff review the workspace; replies still go. */
  'SENDING_ON_HOLD',
  /** Staff suspended sending for the workspace. */
  'SENDING_SUSPENDED',
  /** The From address belongs to another workspace (or no workspace may use it). */
  'SENDER_NOT_OWNED',
  /** Too many recipients in one message for this workspace's level. */
  'TOO_MANY_RECIPIENTS',
  /** A recipient complained about earlier mail from this workspace. */
  'RECIPIENT_SUPPRESSED',
  /** Platform-wide sending budget reached; first-contact mail waits until tomorrow. */
  'PLATFORM_LIMITED',
] as const;
export type OutboundDenialCode = (typeof OUTBOUND_DENIAL_CODES)[number];

export const outboundDenialDetailsSchema = z.object({
  code: z.enum(OUTBOUND_DENIAL_CODES),
  /** Which window was full. */
  window: z.enum(['message', 'hour', 'day', 'month']).optional(),
  limit: z.number().int().optional(),
  used: z.number().int().optional(),
  /** When a retry can succeed (ISO); absent when only staff can lift it. */
  retryAfter: z.string().optional(),
  /** Short machine reason, e.g. `cold_outreach_template`, `weldmail_shared_domain`. */
  reason: z.string().optional(),
  /** Show the "use WeldReach for outreach" notice. */
  suggestWeldReach: z.boolean().optional(),
  /** Recipients the denial is about (suppressed addresses). */
  recipients: z.array(z.string()).optional(),
});
export type OutboundDenialDetails = z.infer<typeof outboundDenialDetailsSchema>;

/** HTTP status each denial maps to. */
export function outboundDenialStatus(code: OutboundDenialCode): 403 | 422 | 429 {
  switch (code) {
    case 'SENDER_NOT_OWNED':
    case 'SENDING_SUSPENDED':
    case 'SENDING_ON_HOLD':
      return 403;
    case 'TOO_MANY_RECIPIENTS':
    case 'RECIPIENT_SUPPRESSED':
      return 422;
    default:
      return 429;
  }
}

// ---------------------------------------------------------------------------
// AI template review
// ---------------------------------------------------------------------------

export const OUTBOUND_CATEGORIES = [
  'personal_1to1',
  'transactional',
  'cold_outreach',
  'marketing_bulk',
  'phishing_or_scam',
  'other',
] as const;
export type OutboundCategory = (typeof OUTBOUND_CATEGORIES)[number];

export const outboundVerdictSchema = z.object({
  category: z.enum(OUTBOUND_CATEGORIES),
  unsolicited: z.boolean(),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.string().max(200)).max(8),
});
export type OutboundVerdict = z.infer<typeof outboundVerdictSchema> & {
  modelId: string;
  reviewedAt: string;
};

// ---------------------------------------------------------------------------
// Customer view — mail-api `GET /api/mail-sending/usage`
// ---------------------------------------------------------------------------

export interface OutboundUsageWindow {
  used: number;
  limit: number;
}

export interface OutboundUsage {
  mode: OutboundGuardMode;
  trustLevel: OutboundTrustLevel;
  state: OutboundState;
  /** Customer-facing reason for a restriction (never staff notes). */
  stateReason: string | null;
  limits: OutboundLimits;
  workspace: {
    hour: number;
    day: OutboundUsageWindow;
    firstContactDay: OutboundUsageWindow;
    month: { used: number; limit: number | null };
  };
  /** Per sender address, last 24 hours. */
  senders: Array<{ email: string; hour: OutboundUsageWindow; day: OutboundUsageWindow }>;
  deliveries7d: {
    delivered: number;
    hardBounces: number;
    softBounces: number;
    complaints: number;
    rejected: number;
  };
  /** A template of this workspace is capped as cold outreach today. */
  coldOutreachCapped: boolean;
}

// ---------------------------------------------------------------------------
// Admin console — policy and case updates
// ---------------------------------------------------------------------------

export const outboundPolicyUpdateSchema = z.object({
  trustOverride: z.enum(OUTBOUND_TRUST_LEVELS).nullable().optional(),
  limits: outboundLimitOverridesSchema.optional(),
  state: z.enum(OUTBOUND_STATES).optional(),
  /** Shown to the customer while a restriction is on. */
  stateReason: z.string().trim().max(500).nullable().optional(),
  allowRepliesWhenSuspended: z.boolean().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
});
export type OutboundPolicyUpdate = z.infer<typeof outboundPolicyUpdateSchema>;

export const OUTBOUND_CASE_TRIGGERS = [
  'cold_outreach_template',
  'phishing',
  'bounce_rate',
  'complaints',
  'risk_score',
  'platform_budget',
  'staff_review',
] as const;
export type OutboundCaseTrigger = (typeof OUTBOUND_CASE_TRIGGERS)[number];

export const OUTBOUND_CASE_SEVERITIES = ['info', 'warning', 'urgent'] as const;
export type OutboundCaseSeverity = (typeof OUTBOUND_CASE_SEVERITIES)[number];

export const OUTBOUND_CASE_STATUSES = ['open', 'confirmed', 'dismissed'] as const;
export type OutboundCaseStatus = (typeof OUTBOUND_CASE_STATUSES)[number];

export const outboundCaseReviewSchema = z.object({
  status: z.enum(['confirmed', 'dismissed']),
  notes: z.string().trim().max(5000).optional(),
});
export type OutboundCaseReview = z.infer<typeof outboundCaseReviewSchema>;
