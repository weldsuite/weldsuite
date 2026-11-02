/**
 * WeldReach — the contract between reach-api, app-api (access requests), the
 * admin console and the platform. Zod v3 request schemas, response types and
 * the shared constants (limits, labels, consumer domains, rendering helpers)
 * every side has to agree on.
 *
 * See docs/plans/weldreach.md.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Access (on request only) — app-api `/api/app-catalog/:code/access-request`
// ---------------------------------------------------------------------------

export const WELDREACH_APP_CODE = 'weldreach';

/** Bump when the terms text changes; stored with every request. */
export const WELDREACH_TERMS_VERSION = 'weldreach-2026-10b';

/** Keys of the terms the requester ticks one by one. Labels live in i18n (`reach.access.terms.<key>`). */
export const WELDREACH_TERMS = [
  'b2b_only',
  'comply_with_law',
  'identify_and_opt_out',
  'lawful_lists',
  'suspension',
  'responsible_for_content',
  // Added with the WeldSuite warmup network (docs/plans/weldreach-warmup.md).
  'warmup_network',
] as const;
export type WeldReachTermKey = (typeof WELDREACH_TERMS)[number];

/** Countries where business addresses also need prior consent; the form shows a notice. */
export const WELDREACH_CONSENT_COUNTRIES = ['NL', 'DE'] as const;

export const appAccessStatusSchema = z.enum(['requested', 'approved', 'rejected', 'suspended', 'revoked']);
export type AppAccessStatus = z.infer<typeof appAccessStatusSchema>;

export const listSourceSchema = z.enum(['own_customers', 'own_research', 'bought_list', 'other']);

export const appAccessRequestInputSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  website: z.string().trim().min(1).max(300),
  contactName: z.string().trim().min(1).max(200),
  contactEmail: z.string().trim().email().max(320),
  useCase: z.string().trim().min(10).max(4000),
  expectedDailySends: z.number().int().min(1).max(100_000),
  targetCountries: z.array(z.string().trim().length(2).toUpperCase()).min(1).max(250),
  listSource: listSourceSchema,
  listSourceDetails: z.string().trim().max(2000).optional(),
  termsVersion: z.string().min(1).max(50),
  /** Must contain every key in WELDREACH_TERMS (checked by app-api for weldreach). */
  termsAccepted: z.array(z.string().min(1).max(50)).min(1),
});
export type AppAccessRequestInput = z.infer<typeof appAccessRequestInputSchema>;

/** What the workspace sees about its own access. Staff notes are never included. */
export interface AppAccessView {
  appCode: string;
  status: AppAccessStatus;
  request: (AppAccessRequestInput & { termsAcceptedAt: string; termsAcceptedBy: string }) | null;
  limits: Record<string, unknown>;
  rejectionReason: string | null;
  suspendedReason: string | null;
  requestedAt: string | null;
  reviewedAt: string | null;
}

/** {@link AppAccessView} as a Zod schema, for checking responses. */
export const appAccessViewSchema = z.object({
  appCode: z.string(),
  status: appAccessStatusSchema,
  request: z
    .object({
      companyName: z.string(),
      website: z.string(),
      contactName: z.string(),
      contactEmail: z.string(),
      useCase: z.string(),
      expectedDailySends: z.number(),
      targetCountries: z.array(z.string()),
      listSource: listSourceSchema,
      listSourceDetails: z.string().optional(),
      termsVersion: z.string(),
      termsAccepted: z.array(z.string()),
      termsAcceptedAt: z.string(),
      termsAcceptedBy: z.string(),
    })
    .nullable(),
  limits: z.record(z.unknown()),
  rejectionReason: z.string().nullable(),
  suspendedReason: z.string().nullable(),
  requestedAt: z.string().nullable(),
  reviewedAt: z.string().nullable(),
});

/** GET /:code/access-request: `null` before the workspace asked. */
export const appAccessViewOrNullSchema = appAccessViewSchema.nullable();

// ---------------------------------------------------------------------------
// Limits (set by staff per workspace in the admin console)
// ---------------------------------------------------------------------------

export const weldReachLimitsSchema = z.object({
  maxDomains: z.number().int().min(0).max(1000),
  maxMailboxes: z.number().int().min(0).max(10_000),
  maxDailySends: z.number().int().min(0).max(1_000_000),
  /** Allow free-mail / consumer recipients (gmail.com, outlook.com, …). Off = B2B only. */
  allowConsumerRecipients: z.boolean(),
  /** Domains staff allowed despite existing MX records or a website. */
  forceAllowDomains: z.array(z.string().trim().toLowerCase()).max(1000),
});
export type WeldReachLimits = z.infer<typeof weldReachLimitsSchema>;

export const WELDREACH_DEFAULT_LIMITS: WeldReachLimits = {
  maxDomains: 3,
  maxMailboxes: 10,
  maxDailySends: 300,
  allowConsumerRecipients: false,
  forceAllowDomains: [],
};

/** Read limits stored as loose jsonb, falling back to the defaults per key. */
export function resolveWeldReachLimits(stored: Record<string, unknown> | null | undefined): WeldReachLimits {
  const parsed = weldReachLimitsSchema.partial().safeParse(stored ?? {});
  return { ...WELDREACH_DEFAULT_LIMITS, ...(parsed.success ? parsed.data : {}) };
}

// ---------------------------------------------------------------------------
// Pricing and sending defaults
// ---------------------------------------------------------------------------

/** $5.00 per inbox per month (owner decision 2026-10-12). */
export const WELDREACH_INBOX_PRICE_CENTS = 500;
export const WELDREACH_INBOX_CURRENCY = 'usd';

export const WELDREACH_SENDING_DEFAULTS = {
  /** Days of warmup (WeldSuite warmup network) before a mailbox may join campaigns. */
  warmupDays: 14,
  mailboxDailyCap: 30,
  mailboxDailyCapMax: 50,
  rampStart: 10,
  rampStep: 5,
  minGapMinutes: 8,
  /** Auto-pause thresholds. */
  mailboxHardBouncesPerDay: 5,
  campaignBounceRate: 0.03,
  campaignBounceWindow: 50,
} as const;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const reachMailboxTypeSchema = z.enum(['google', 'shared']);
export type ReachMailboxType = z.infer<typeof reachMailboxTypeSchema>;

export const reachMailboxStatusSchema = z.enum([
  'provisioning',
  'warming',
  'active',
  'paused',
  'suspended',
  'error',
  'deleting',
  'deleted',
]);
export type ReachMailboxStatus = z.infer<typeof reachMailboxStatusSchema>;

export const reachDomainStatusSchema = z.enum(['connecting', 'active', 'error', 'disconnecting']);
export type ReachDomainStatus = z.infer<typeof reachDomainStatusSchema>;

export const reachCampaignStatusSchema = z.enum(['draft', 'active', 'paused', 'completed', 'archived']);
export type ReachCampaignStatus = z.infer<typeof reachCampaignStatusSchema>;

export const reachEnrollmentStatusSchema = z.enum([
  'queued',
  'active',
  'replied',
  'bounced',
  'unsubscribed',
  'completed',
  'paused',
  'failed',
]);
export type ReachEnrollmentStatus = z.infer<typeof reachEnrollmentStatusSchema>;

export const reachReplyLabelSchema = z.enum([
  'interested',
  'meeting_request',
  'not_interested',
  'not_now',
  'out_of_office',
  'wrong_person',
  'unsubscribe',
  'other',
  'unclassified',
]);
export type ReachReplyLabel = z.infer<typeof reachReplyLabelSchema>;

export const reachInboundKindSchema = z.enum(['reply', 'auto_reply', 'bounce']);
export type ReachInboundKind = z.infer<typeof reachInboundKindSchema>;

export const reachProspectValidationSchema = z.enum(['valid', 'role', 'consumer', 'no_mx', 'invalid', 'suppressed']);
export type ReachProspectValidation = z.infer<typeof reachProspectValidationSchema>;

export const reachSuppressionReasonSchema = z.enum([
  'unsubscribed',
  'bounced',
  'complained',
  'manual',
  'negative_reply',
]);
export type ReachSuppressionReason = z.infer<typeof reachSuppressionReasonSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7);

export const updateReachSettingsSchema = z.object({
  senderCompanyName: z.string().trim().min(1).max(200).optional(),
  senderAddress: z.string().trim().min(1).max(1000).optional(),
  optOutText: z.string().trim().min(1).max(500).optional(),
  defaultTimezone: z.string().min(1).max(64).optional(),
  defaultSendDays: weekdays.optional(),
  defaultWindowStart: hhmm.optional(),
  defaultWindowEnd: hhmm.optional(),
  defaultMailboxDailyCap: z.number().int().min(1).max(WELDREACH_SENDING_DEFAULTS.mailboxDailyCapMax).optional(),
  stopOnReplyScope: z.enum(['prospect', 'company']).optional(),
  completeOnboarding: z.boolean().optional(),
});
export type UpdateReachSettingsInput = z.infer<typeof updateReachSettingsSchema>;

export interface ReachSettings {
  id: string;
  senderCompanyName: string | null;
  senderAddress: string | null;
  optOutText: string | null;
  defaultTimezone: string;
  defaultSendDays: number[];
  defaultWindowStart: string;
  defaultWindowEnd: string;
  defaultMailboxDailyCap: number;
  stopOnReplyScope: 'prospect' | 'company';
  onboardingCompletedAt: string | null;
}

/** Access, limits and live usage for the module header and the limit hints. */
export interface ReachAccessSummary {
  status: AppAccessStatus;
  limits: WeldReachLimits;
  usage: { domains: number; mailboxes: number; sendsToday: number };
  sendingEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export interface ReachDnsStatus {
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  mx: boolean;
  checkedAt: string;
}

export interface ReachDomain {
  id: string;
  hostDomainId: string;
  name: string;
  mailpoolDomainId: string | null;
  status: ReachDomainStatus;
  dnsStatus: ReachDnsStatus | null;
  dmarcPolicy: string | null;
  connectedAt: string | null;
  lastError: string | null;
  mailboxCount: number;
  createdAt: string;
}

export const reachDomainIneligibleReasonSchema = z.enum([
  'already_connected',
  'not_active',
  'not_on_cloudflare',
  'has_mx',
  'has_website',
  'limit_reached',
]);
export type ReachDomainIneligibleReason = z.infer<typeof reachDomainIneligibleReasonSchema>;

/** A WeldHost domain of this workspace, and whether it can be connected. */
export interface ReachDomainCandidate {
  hostDomainId: string;
  name: string;
  hostStatus: string;
  eligible: boolean;
  reason: ReachDomainIneligibleReason | null;
}

export const connectReachDomainSchema = z.object({ hostDomainId: z.string().min(1).max(30) });
export type ConnectReachDomainInput = z.infer<typeof connectReachDomainSchema>;

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

/**
 * Why a mailbox is still warming: too few days, too little data, low inbox
 * placement, a login problem, or a pool with mailboxes on fewer than 3 domains.
 */
export const reachWarmupBlockerSchema = z.enum([
  'too_early',
  'not_enough_data',
  'low_inbox_rate',
  'login_error',
  'pool_too_small',
]);
export type ReachWarmupBlocker = z.infer<typeof reachWarmupBlockerSchema>;

export interface ReachMailbox {
  id: string;
  domainId: string;
  domainName: string;
  email: string;
  firstName: string;
  lastName: string;
  signature: string | null;
  type: ReachMailboxType;
  status: ReachMailboxStatus;
  /** Days of warmup sending so far (WeldSuite warmup network). */
  warmupDay: number;
  /** Pool state: waiting | warming | maintaining | paused | error | removed. */
  warmupStatus: string | null;
  /** Inbox placement of this mailbox's warmup mail over 3 days (0..1); null below the minimum sample. */
  warmupInboxRate: number | null;
  /** Warmup emails sent in the last 7 days. */
  warmupSent7d: number;
  /** Warmup emails to this mailbox rescued from spam in the last 7 days. */
  warmupSpamRescues7d: number;
  /** Why a warming mailbox may not join campaigns yet; null when ready or not warming. */
  warmupBlocker: ReachWarmupBlocker | null;
  dailyCap: number;
  rampCurrent: number;
  sentToday: number;
  lastSentAt: string | null;
  pausedReason: string | null;
  lastError: string | null;
  createdAt: string;
}

export const createReachMailboxSchema = z.object({
  domainId: z.string().min(1).max(30),
  localPart: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/, 'Letters, digits, dots, dashes and underscores only'),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  signature: z.string().max(2000).optional(),
  type: reachMailboxTypeSchema,
});
export type CreateReachMailboxInput = z.infer<typeof createReachMailboxSchema>;

export const updateReachMailboxSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  signature: z.string().max(2000).nullish(),
  dailyCap: z.number().int().min(1).max(WELDREACH_SENDING_DEFAULTS.mailboxDailyCapMax).optional(),
});
export type UpdateReachMailboxInput = z.infer<typeof updateReachMailboxSchema>;

// ---------------------------------------------------------------------------
// Billing (inbox subscription, via billing-worker)
// ---------------------------------------------------------------------------

export interface ReachBillingSummary {
  status: 'none' | 'active' | 'past_due' | 'canceled';
  hasPaymentMethod: boolean;
  inboxCount: number;
  unitAmountCents: number;
  currency: string;
  currentPeriodEnd: string | null;
}

export const reachBillingSetupSchema = z.object({
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});
export type ReachBillingSetupInput = z.infer<typeof reachBillingSetupSchema>;

// ---------------------------------------------------------------------------
// Prospects and lists
// ---------------------------------------------------------------------------

export interface ReachProspect {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  companyDomain: string | null;
  title: string | null;
  timezone: string | null;
  customFields: Record<string, string>;
  source: 'csv' | 'crm_list' | 'welddata' | 'manual';
  sourceRef: string | null;
  personId: string | null;
  validation: ReachProspectValidation;
  createdAt: string;
}

const customFields = z.record(z.string().max(64), z.string().max(2000)).refine((v) => Object.keys(v).length <= 50, {
  message: 'At most 50 custom fields',
});

export const reachProspectInputSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  companyName: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  timezone: z.string().max(64).optional(),
  customFields: customFields.optional(),
});
export type ReachProspectInput = z.infer<typeof reachProspectInputSchema>;

export const updateReachProspectSchema = reachProspectInputSchema.partial().omit({ email: true });
export type UpdateReachProspectInput = z.infer<typeof updateReachProspectSchema>;

/** CSV is parsed in the browser; at most this many rows per request. */
export const REACH_IMPORT_MAX_ROWS = 5000;

export const importReachProspectsSchema = z.object({
  rows: z.array(reachProspectInputSchema.extend({ email: z.string().trim().toLowerCase().max(320) })).min(1).max(REACH_IMPORT_MAX_ROWS),
  /** Add to an existing list, or create one with this name. */
  listId: z.string().max(30).optional(),
  listName: z.string().trim().min(1).max(200).optional(),
  sourceRef: z.string().max(255).optional(),
});
export type ImportReachProspectsInput = z.infer<typeof importReachProspectsSchema>;

export const importReachFromCrmListSchema = z.object({
  crmListId: z.string().min(1).max(30),
  listName: z.string().trim().min(1).max(200).optional(),
});
export const importReachFromWeldDataSchema = z.object({
  welddataListId: z.string().min(1).max(30),
  listName: z.string().trim().min(1).max(200).optional(),
});

export interface ReachImportReport {
  listId: string | null;
  created: number;
  updated: number;
  /** Rows not imported, by reason. */
  skipped: Array<{ reason: ReachProspectValidation | 'duplicate' | 'invalid_row'; count: number }>;
}

export interface ReachProspectList {
  id: string;
  name: string;
  description: string | null;
  source: 'csv' | 'crm_list' | 'welddata' | 'manual';
  sourceRef: string | null;
  prospectCount: number;
  createdAt: string;
}

export const createReachListSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});
export const updateReachListSchema = createReachListSchema.partial();
export const reachListMembersSchema = z.object({ prospectIds: z.array(z.string().min(1).max(30)).min(1).max(5000) });

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export interface ReachCampaignStats {
  prospects: number;
  sent: number;
  replied: number;
  interested: number;
  bounced: number;
  unsubscribed: number;
}

export interface ReachCampaignStep {
  id: string;
  order: number;
  delayDays: number;
  delayHours: number;
  subject: string;
  body: string;
  replyInThread: boolean;
}

export interface ReachCampaign {
  id: string;
  name: string;
  status: ReachCampaignStatus;
  timezone: string;
  sendDays: number[];
  windowStart: string;
  windowEnd: string;
  dailyLimit: number;
  minGapMinutes: number;
  stopOnAutoReply: boolean;
  stats: ReachCampaignStats;
  pausedReason: string | null;
  launchedAt: string | null;
  completedAt: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReachCampaignDetail extends ReachCampaign {
  steps: ReachCampaignStep[];
  mailboxIds: string[];
}

const campaignScheduleSchema = z.object({
  timezone: z.string().min(1).max(64),
  sendDays: weekdays,
  windowStart: hhmm,
  windowEnd: hhmm,
  dailyLimit: z.number().int().min(1).max(10_000),
  minGapMinutes: z.number().int().min(1).max(240),
  stopOnAutoReply: z.boolean(),
});

export const createReachCampaignSchema = campaignScheduleSchema
  .partial()
  .extend({ name: z.string().trim().min(1).max(200) });
export type CreateReachCampaignInput = z.infer<typeof createReachCampaignSchema>;

export const updateReachCampaignSchema = campaignScheduleSchema
  .extend({ name: z.string().trim().min(1).max(200), ownerId: z.string().max(255).nullable() })
  .partial();
export type UpdateReachCampaignInput = z.infer<typeof updateReachCampaignSchema>;

export const reachStepInputSchema = z.object({
  delayDays: z.number().int().min(0).max(90),
  delayHours: z.number().int().min(0).max(23),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  replyInThread: z.boolean(),
});
export type ReachStepInput = z.infer<typeof reachStepInputSchema>;

export const replaceReachStepsSchema = z.object({ steps: z.array(reachStepInputSchema).min(1).max(10) });
export const setReachCampaignMailboxesSchema = z.object({ mailboxIds: z.array(z.string().min(1).max(30)).max(500) });

export const addReachCampaignProspectsSchema = z
  .object({
    prospectIds: z.array(z.string().min(1).max(30)).max(10_000).optional(),
    listId: z.string().min(1).max(30).optional(),
  })
  .refine((v) => (v.prospectIds?.length ?? 0) > 0 || !!v.listId, { message: 'prospectIds or listId is required' });
export type AddReachCampaignProspectsInput = z.infer<typeof addReachCampaignProspectsSchema>;

export interface ReachAddProspectsReport {
  added: number;
  skipped: Array<{ reason: 'already_enrolled' | 'suppressed' | 'consumer' | 'invalid' | 'enrolled_elsewhere'; count: number }>;
}

export interface ReachEnrollment {
  id: string;
  campaignId: string;
  prospect: Pick<ReachProspect, 'id' | 'email' | 'firstName' | 'lastName' | 'companyName'>;
  mailboxId: string | null;
  mailboxEmail: string | null;
  status: ReachEnrollmentStatus;
  currentStep: number;
  nextSendAt: string | null;
  stoppedReason: string | null;
  updatedAt: string;
}

export const previewReachStepSchema = z.object({
  stepId: z.string().min(1).max(30).optional(),
  prospectId: z.string().min(1).max(30).optional(),
  /** Preview unsaved text instead of a stored step. */
  subject: z.string().max(300).optional(),
  body: z.string().max(20_000).optional(),
});

export interface ReachRenderedPreview {
  subject: string;
  body: string;
  /** Variables that resolved to nothing and had no fallback; such a prospect is skipped at send time. */
  missingVariables: string[];
}

export interface ReachCampaignStepStats {
  stepId: string;
  order: number;
  sent: number;
  replied: number;
  bounced: number;
}

// ---------------------------------------------------------------------------
// Reply inbox
// ---------------------------------------------------------------------------

export interface ReachMessage {
  id: string;
  direction: 'out' | 'in';
  campaignId: string | null;
  stepId: string | null;
  mailboxId: string;
  prospectId: string | null;
  threadKey: string | null;
  fromEmail: string;
  toEmail: string;
  subject: string | null;
  snippet: string | null;
  /** Outbound: stored text. Inbound: fetched from R2 on the thread read. */
  bodyText: string | null;
  status: 'sending' | 'sent' | 'failed' | 'unknown' | null;
  kind: ReachInboundKind | null;
  label: ReachReplyLabel | null;
  labelSource: 'ai' | 'user' | 'rule' | null;
  readAt: string | null;
  handledAt: string | null;
  sentAt: string | null;
  receivedAt: string | null;
}

export interface ReachThreadSummary {
  threadKey: string;
  prospect: Pick<ReachProspect, 'id' | 'email' | 'firstName' | 'lastName' | 'companyName' | 'personId'> | null;
  campaign: { id: string; name: string } | null;
  mailbox: { id: string; email: string };
  lastInbound: Pick<
    ReachMessage,
    'id' | 'subject' | 'snippet' | 'kind' | 'label' | 'labelSource' | 'receivedAt' | 'readAt' | 'handledAt'
  >;
  messageCount: number;
}

export interface ReachThread {
  threadKey: string;
  summary: ReachThreadSummary;
  messages: ReachMessage[];
}

export const reachInboxFilterSchema = z.object({
  label: reachReplyLabelSchema.optional(),
  kind: reachInboundKindSchema.optional(),
  campaignId: z.string().max(30).optional(),
  mailboxId: z.string().max(30).optional(),
  state: z.enum(['unread', 'open', 'handled', 'all']).optional(),
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ReachInboxFilter = z.infer<typeof reachInboxFilterSchema>;

export const reachReplySchema = z.object({ body: z.string().trim().min(1).max(20_000) });

export const updateReachMessageSchema = z.object({
  label: reachReplyLabelSchema.optional(),
  read: z.boolean().optional(),
  handled: z.boolean().optional(),
});
export type UpdateReachMessageInput = z.infer<typeof updateReachMessageSchema>;

export const reachAddToCrmSchema = z.object({
  opportunity: z
    .object({
      pipelineId: z.string().min(1).max(30),
      stageId: z.string().min(1).max(30),
      name: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
});
export type ReachAddToCrmInput = z.infer<typeof reachAddToCrmSchema>;

// ---------------------------------------------------------------------------
// Suppressions
// ---------------------------------------------------------------------------

export interface ReachSuppression {
  id: string;
  value: string;
  type: 'email' | 'domain';
  reason: ReachSuppressionReason;
  source: string | null;
  createdBy: string | null;
  createdAt: string;
}

export const addReachSuppressionsSchema = z.object({
  values: z.array(z.string().trim().toLowerCase().min(3).max(320)).min(1).max(10_000),
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface ReachOverview {
  sentToday: number;
  sent7d: number;
  replies7d: number;
  interested7d: number;
  bounceRate7d: number;
  replyRate7d: number;
  activeCampaigns: number;
  mailboxes: { active: number; warming: number; paused: number; error: number };
  unreadReplies: number;
  daily: Array<{ date: string; sent: number; replies: number }>;
}

// ---------------------------------------------------------------------------
// Pure helpers shared by reach-api (validation, rendering) and the platform (preview, import)
// ---------------------------------------------------------------------------

/** Free-mail and consumer providers; recipients here are refused unless allowConsumerRecipients is on. */
export const CONSUMER_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.nl', 'hotmail.co.uk', 'live.com',
  'live.nl', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'ymail.com', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'proton.me', 'protonmail.com', 'zoho.com',
  'mail.com', 'yandex.com', 'yandex.ru', 'ziggo.nl', 'kpnmail.nl', 'planet.nl', 'home.nl', 'telenet.be',
  'skynet.be', 'orange.fr', 'free.fr', 'laposte.net', 't-online.de', 'freenet.de', 'libero.it', 'qq.com',
  '163.com', 'naver.com',
]);

/** Shared mailboxes nobody personally reads; excluded by default. */
export const ROLE_EMAIL_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'info', 'sales', 'support', 'admin', 'office', 'contact', 'hello', 'help', 'billing', 'accounts',
  'accounting', 'finance', 'hr', 'jobs', 'careers', 'marketing', 'noreply', 'no-reply', 'postmaster',
  'abuse', 'webmaster', 'team', 'service', 'enquiries', 'inquiries', 'press', 'privacy', 'legal',
]);

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

export function isConsumerEmail(email: string): boolean {
  return CONSUMER_EMAIL_DOMAINS.has(emailDomain(email));
}

export function isRoleEmail(email: string): boolean {
  const at = email.indexOf('@');
  return at > 0 && ROLE_EMAIL_LOCAL_PARTS.has(email.slice(0, at).toLowerCase());
}

/** Variables available in every template besides the prospect's custom fields. */
export const REACH_TEMPLATE_VARIABLES = [
  'firstName',
  'lastName',
  'fullName',
  'email',
  'companyName',
  'title',
  'senderFirstName',
  'senderLastName',
  'senderFullName',
] as const;

const VARIABLE_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|([^}]*))?\}\}/g;

/**
 * Render `{{name}}` / `{{name|fallback}}` placeholders. A variable that is
 * empty and has no fallback is reported in `missing` and left in the text;
 * callers must not send a rendering with missing variables.
 */
export function renderReachTemplate(
  template: string,
  values: Record<string, string | null | undefined>,
): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(VARIABLE_RE, (match, name: string, fallback: string | undefined) => {
    const value = values[name];
    if (value != null && String(value).trim() !== '') return String(value);
    if (fallback !== undefined) return fallback.trim();
    missing.add(name);
    return match;
  });
  return { text, missing: [...missing] };
}
