import { z } from 'zod';
import {
  appAccessStatusSchema,
  reachCampaignStatusSchema,
  reachDomainIneligibleReasonSchema,
  reachDomainStatusSchema,
  reachEnrollmentStatusSchema,
  reachInboundKindSchema,
  reachMailboxStatusSchema,
  reachMailboxTypeSchema,
  reachProspectValidationSchema,
  reachReplyLabelSchema,
  reachSuppressionReasonSchema,
  reachWarmupBlockerSchema,
} from './reach';

// ============================================================================
// WeldReach (reach-api) response shapes, matching the interfaces of
// `./reach.ts`. The conformance suite validates both backends' answers
// against them. Zod v3.
// ============================================================================

const timestamp = z.string();
const source = z.enum(['csv', 'crm_list', 'welddata', 'manual']);

export const reachSettingsSchema = z.object({
  id: z.string(),
  senderCompanyName: z.string().nullable(),
  senderAddress: z.string().nullable(),
  optOutText: z.string().nullable(),
  defaultTimezone: z.string(),
  defaultSendDays: z.array(z.number()),
  defaultWindowStart: z.string(),
  defaultWindowEnd: z.string(),
  defaultMailboxDailyCap: z.number(),
  stopOnReplyScope: z.enum(['prospect', 'company']),
  onboardingCompletedAt: timestamp.nullable(),
});

export const reachLimitsSchema = z.object({
  maxDomains: z.number(),
  maxMailboxes: z.number(),
  maxDailySends: z.number(),
  allowConsumerRecipients: z.boolean(),
  forceAllowDomains: z.array(z.string()),
});

export const reachAccessSummarySchema = z.object({
  status: appAccessStatusSchema,
  limits: reachLimitsSchema,
  usage: z.object({ domains: z.number(), mailboxes: z.number(), sendsToday: z.number() }),
  sendingEnabled: z.boolean(),
});

export const reachBillingSummarySchema = z.object({
  status: z.enum(['none', 'active', 'past_due', 'canceled']),
  hasPaymentMethod: z.boolean(),
  inboxCount: z.number(),
  unitAmountCents: z.number(),
  currency: z.string(),
  currentPeriodEnd: z.string().nullable(),
});

export const reachBillingSetupResultSchema = z.object({ url: z.string() });

export const reachDnsStatusSchema = z.object({
  spf: z.boolean(),
  dkim: z.boolean(),
  dmarc: z.boolean(),
  mx: z.boolean(),
  checkedAt: z.string(),
});

export const reachDomainSchema = z.object({
  id: z.string(),
  hostDomainId: z.string(),
  name: z.string(),
  mailpoolDomainId: z.string().nullable(),
  status: reachDomainStatusSchema,
  dnsStatus: reachDnsStatusSchema.nullable(),
  dmarcPolicy: z.string().nullable(),
  connectedAt: timestamp.nullable(),
  lastError: z.string().nullable(),
  mailboxCount: z.number(),
  createdAt: timestamp,
});

export const reachDomainCandidateSchema = z.object({
  hostDomainId: z.string(),
  name: z.string(),
  hostStatus: z.string(),
  eligible: z.boolean(),
  reason: reachDomainIneligibleReasonSchema.nullable(),
});

export const reachMailboxSchema = z.object({
  id: z.string(),
  domainId: z.string(),
  domainName: z.string(),
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  signature: z.string().nullable(),
  type: reachMailboxTypeSchema,
  status: reachMailboxStatusSchema,
  warmupDay: z.number(),
  warmupStatus: z.string().nullable(),
  warmupInboxRate: z.number().nullable(),
  warmupSent7d: z.number(),
  warmupSpamRescues7d: z.number(),
  warmupBlocker: reachWarmupBlockerSchema.nullable(),
  dailyCap: z.number(),
  rampCurrent: z.number(),
  sentToday: z.number(),
  lastSentAt: timestamp.nullable(),
  pausedReason: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: timestamp,
});

export const reachProspectSchema = z.object({
  id: z.string(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  companyName: z.string().nullable(),
  companyDomain: z.string().nullable(),
  title: z.string().nullable(),
  timezone: z.string().nullable(),
  customFields: z.record(z.string()),
  source,
  sourceRef: z.string().nullable(),
  personId: z.string().nullable(),
  validation: reachProspectValidationSchema,
  createdAt: timestamp,
});

export const reachImportReportSchema = z.object({
  listId: z.string().nullable(),
  created: z.number(),
  updated: z.number(),
  skipped: z.array(
    z.object({ reason: z.union([reachProspectValidationSchema, z.enum(['duplicate', 'invalid_row'])]), count: z.number() }),
  ),
});

export const reachProspectListSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  source,
  sourceRef: z.string().nullable(),
  prospectCount: z.number(),
  createdAt: timestamp,
});

export const reachListMembersAddedSchema = z.object({ added: z.number() });
export const reachListMembersRemovedSchema = z.object({ removed: z.number() });

export const reachCampaignStatsSchema = z.object({
  prospects: z.number(),
  sent: z.number(),
  replied: z.number(),
  interested: z.number(),
  bounced: z.number(),
  unsubscribed: z.number(),
});

export const reachCampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: reachCampaignStatusSchema,
  timezone: z.string(),
  sendDays: z.array(z.number()),
  windowStart: z.string(),
  windowEnd: z.string(),
  dailyLimit: z.number(),
  minGapMinutes: z.number(),
  stopOnAutoReply: z.boolean(),
  stats: reachCampaignStatsSchema,
  pausedReason: z.string().nullable(),
  launchedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  ownerId: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const reachCampaignStepSchema = z.object({
  id: z.string(),
  order: z.number(),
  delayDays: z.number(),
  delayHours: z.number(),
  subject: z.string(),
  body: z.string(),
  replyInThread: z.boolean(),
});

export const reachCampaignDetailSchema = reachCampaignSchema.extend({
  steps: z.array(reachCampaignStepSchema),
  mailboxIds: z.array(z.string()),
});

export const reachAddProspectsReportSchema = z.object({
  added: z.number(),
  skipped: z.array(
    z.object({
      reason: z.enum(['already_enrolled', 'suppressed', 'consumer', 'invalid', 'enrolled_elsewhere']),
      count: z.number(),
    }),
  ),
});

export const reachEnrollmentSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  prospect: z.object({
    id: z.string(),
    email: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    companyName: z.string().nullable(),
  }),
  mailboxId: z.string().nullable(),
  mailboxEmail: z.string().nullable(),
  status: reachEnrollmentStatusSchema,
  currentStep: z.number(),
  nextSendAt: timestamp.nullable(),
  stoppedReason: z.string().nullable(),
  updatedAt: timestamp,
});

export const reachRenderedPreviewSchema = z.object({
  subject: z.string(),
  body: z.string(),
  missingVariables: z.array(z.string()),
});

export const reachCampaignStepStatsSchema = z.object({
  stepId: z.string(),
  order: z.number(),
  sent: z.number(),
  replied: z.number(),
  bounced: z.number(),
});

export const reachSuppressionSchema = z.object({
  id: z.string(),
  value: z.string(),
  type: z.enum(['email', 'domain']),
  reason: reachSuppressionReasonSchema,
  source: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: timestamp,
});

export const reachSuppressionsAddedSchema = z.object({ added: z.number(), skipped: z.number() });

export const reachOverviewSchema = z.object({
  sentToday: z.number(),
  sent7d: z.number(),
  replies7d: z.number(),
  interested7d: z.number(),
  bounceRate7d: z.number(),
  replyRate7d: z.number(),
  activeCampaigns: z.number(),
  mailboxes: z.object({ active: z.number(), warming: z.number(), paused: z.number(), error: z.number() }),
  unreadReplies: z.number(),
  daily: z.array(z.object({ date: z.string(), sent: z.number(), replies: z.number() })),
});

export const reachMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(['out', 'in']),
  campaignId: z.string().nullable(),
  stepId: z.string().nullable(),
  mailboxId: z.string(),
  prospectId: z.string().nullable(),
  threadKey: z.string().nullable(),
  fromEmail: z.string(),
  toEmail: z.string(),
  subject: z.string().nullable(),
  snippet: z.string().nullable(),
  bodyText: z.string().nullable(),
  status: z.enum(['sending', 'sent', 'failed', 'unknown']).nullable(),
  kind: reachInboundKindSchema.nullable(),
  label: reachReplyLabelSchema.nullable(),
  labelSource: z.enum(['ai', 'user', 'rule']).nullable(),
  readAt: timestamp.nullable(),
  handledAt: timestamp.nullable(),
  sentAt: timestamp.nullable(),
  receivedAt: timestamp.nullable(),
});

export const reachThreadSummarySchema = z.object({
  threadKey: z.string(),
  prospect: z
    .object({
      id: z.string(),
      email: z.string(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      companyName: z.string().nullable(),
      personId: z.string().nullable(),
    })
    .nullable(),
  campaign: z.object({ id: z.string(), name: z.string() }).nullable(),
  mailbox: z.object({ id: z.string(), email: z.string() }),
  lastInbound: z.object({
    id: z.string(),
    subject: z.string().nullable(),
    snippet: z.string().nullable(),
    kind: reachInboundKindSchema,
    label: reachReplyLabelSchema.nullable(),
    labelSource: z.enum(['ai', 'user', 'rule']).nullable(),
    receivedAt: timestamp.nullable(),
    readAt: timestamp.nullable(),
    handledAt: timestamp.nullable(),
  }),
  messageCount: z.number(),
});

export const reachThreadSchema = z.object({
  threadKey: z.string(),
  summary: reachThreadSummarySchema,
  messages: z.array(reachMessageSchema),
});

export const reachUnreadCountSchema = z.object({ count: z.number() });

export const reachAddToCrmResultSchema = z.object({
  personId: z.string(),
  opportunityId: z.string().nullable(),
});

export const reachMailpoolWebhookOutcomeSchema = z.object({
  data: z.union([
    z.object({ handled: z.literal(true), changed: z.boolean() }),
    z.object({ handled: z.literal(false), reason: z.string() }),
  ]),
});
