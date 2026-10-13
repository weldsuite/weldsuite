/**
 * WeldReach — cold email outreach on Mailpool infrastructure. Tenant DB.
 *
 * Mailpool provides mailboxes (and warmup) on WeldHost domains connected
 * through its Cloudflare integration; WeldReach runs everything else:
 * campaigns, mailbox rotation, limits, reply detection, the reply inbox and the
 * hand-off to WeldCRM. Sending is SMTP from reach-api over TCP sockets; replies
 * come back through Mailpool's `forwardTo` to `<inboundToken>@reply.weldsuite.org`.
 *
 * Mailbox SMTP/IMAP credentials are stored encrypted (`encryptField` from
 * `@weldsuite/db/lib/crypto`) and listed in SENSITIVE_COLUMNS.
 *
 * See docs/plans/weldreach.md.
 */

import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export const REACH_DOMAIN_STATUSES = ['connecting', 'active', 'error', 'disconnecting'] as const;
export type ReachDomainStatus = (typeof REACH_DOMAIN_STATUSES)[number];

export const REACH_MAILBOX_TYPES = ['google', 'shared'] as const;
export type ReachMailboxType = (typeof REACH_MAILBOX_TYPES)[number];

export const REACH_MAILBOX_STATUSES = [
  'provisioning',
  'warming',
  'active',
  'paused',
  'suspended',
  'error',
  'deleting',
  'deleted',
] as const;
export type ReachMailboxStatus = (typeof REACH_MAILBOX_STATUSES)[number];

export const REACH_CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed', 'archived'] as const;
export type ReachCampaignStatus = (typeof REACH_CAMPAIGN_STATUSES)[number];

export const REACH_ENROLLMENT_STATUSES = [
  'queued',
  'active',
  'replied',
  'bounced',
  'unsubscribed',
  'completed',
  'paused',
  'failed',
] as const;
export type ReachEnrollmentStatus = (typeof REACH_ENROLLMENT_STATUSES)[number];

export const REACH_OUTBOUND_STATUSES = ['sending', 'sent', 'failed', 'unknown'] as const;
export type ReachOutboundStatus = (typeof REACH_OUTBOUND_STATUSES)[number];

export const REACH_INBOUND_KINDS = ['reply', 'auto_reply', 'bounce'] as const;
export type ReachInboundKind = (typeof REACH_INBOUND_KINDS)[number];

export const REACH_REPLY_LABELS = [
  'interested',
  'meeting_request',
  'not_interested',
  'not_now',
  'out_of_office',
  'wrong_person',
  'unsubscribe',
  'other',
  'unclassified',
] as const;
export type ReachReplyLabel = (typeof REACH_REPLY_LABELS)[number];

export const REACH_SUPPRESSION_REASONS = [
  'unsubscribed',
  'bounced',
  'complained',
  'manual',
  'negative_reply',
] as const;
export type ReachSuppressionReason = (typeof REACH_SUPPRESSION_REASONS)[number];

export const REACH_PROSPECT_SOURCES = ['csv', 'crm_list', 'welddata', 'manual'] as const;
export type ReachProspectSource = (typeof REACH_PROSPECT_SOURCES)[number];

export const REACH_PROSPECT_VALIDATIONS = ['valid', 'role', 'consumer', 'no_mx', 'invalid', 'suppressed'] as const;
export type ReachProspectValidation = (typeof REACH_PROSPECT_VALIDATIONS)[number];

/** Encrypted at rest; this is the decrypted shape. */
export interface ReachMailServerCredentials {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
}

export interface ReachDnsStatus {
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  mx: boolean;
  checkedAt: string;
}

/** Denormalised campaign counters, refreshed as messages are sent and received. */
export interface ReachCampaignStats {
  prospects: number;
  sent: number;
  replied: number;
  interested: number;
  bounced: number;
  unsubscribed: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** One row per workspace. */
export const reachSettings = pgTable('reach_settings', {
  id: varchar('id', { length: 30 }).primaryKey(), // rset_

  /** Sender identity for the email footer (legal requirement in the EU). */
  senderCompanyName: varchar('sender_company_name', { length: 200 }),
  senderAddress: text('sender_address'),
  /** Opt-out line appended to every email. */
  optOutText: text('opt_out_text'),

  defaultTimezone: varchar('default_timezone', { length: 64 }).notNull().default('Europe/Amsterdam'),
  /** ISO weekdays 1 (Mon) .. 7 (Sun). */
  defaultSendDays: jsonb('default_send_days').$type<number[]>().notNull().default([1, 2, 3, 4, 5]),
  /** "HH:MM" in the campaign timezone. */
  defaultWindowStart: varchar('default_window_start', { length: 5 }).notNull().default('09:00'),
  defaultWindowEnd: varchar('default_window_end', { length: 5 }).notNull().default('17:00'),
  defaultMailboxDailyCap: integer('default_mailbox_daily_cap').notNull().default(30),
  /** `prospect`: a reply stops that prospect; `company`: everyone at the same company domain. */
  stopOnReplyScope: varchar('stop_on_reply_scope', { length: 20 }).$type<'prospect' | 'company'>().notNull().default('prospect'),

  onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Domains and mailboxes
// ---------------------------------------------------------------------------

/** A WeldHost domain connected to Mailpool. Registration and renewal stay in WeldHost. */
export const reachDomains = pgTable(
  'reach_domains',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rdom_
    /** WeldHost `domains.id`. */
    hostDomainId: varchar('host_domain_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    mailpoolDomainId: varchar('mailpool_domain_id', { length: 50 }),
    status: varchar('status', { length: 20 }).$type<ReachDomainStatus>().notNull().default('connecting'),
    dnsStatus: jsonb('dns_status').$type<ReachDnsStatus>(),
    dmarcPolicy: varchar('dmarc_policy', { length: 20 }),
    /** Staff overrode the "existing MX / website" guard in the admin console. */
    forcedBy: varchar('forced_by', { length: 255 }),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    connectedBy: varchar('connected_by', { length: 255 }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reach_domains_host_domain_idx').on(table.hostDomainId),
    uniqueIndex('reach_domains_name_idx').on(table.name),
    index('reach_domains_mailpool_idx').on(table.mailpoolDomainId),
  ],
);

export const reachMailboxes = pgTable(
  'reach_mailboxes',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rmbx_
    domainId: varchar('domain_id', { length: 30 }).notNull(),
    mailpoolMailboxId: varchar('mailpool_mailbox_id', { length: 50 }),
    email: varchar('email', { length: 320 }).notNull(),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    signature: text('signature'),
    type: varchar('type', { length: 20 }).$type<ReachMailboxType>().notNull(),
    status: varchar('status', { length: 20 }).$type<ReachMailboxStatus>().notNull().default('provisioning'),

    /** `encryptField(JSON.stringify(ReachMailServerCredentials))`. Never returned by the API. */
    smtpCredentials: text('smtp_credentials'),
    /** Kept for a later IMAP fallback; same encryption. */
    imapCredentials: text('imap_credentials'),

    /** Local part of `<token>@reply.weldsuite.org`, the mailbox's `forwardTo`. */
    inboundToken: varchar('inbound_token', { length: 40 }).notNull(),

    warmupStartedAt: timestamp('warmup_started_at', { withTimezone: true }),
    warmupDay: integer('warmup_day').notNull().default(0),
    warmupStatus: varchar('warmup_status', { length: 30 }),
    /** Inbox placement over the last 3 days from the WeldSuite warmup network (0..1); null below the minimum sample. */
    warmupInboxRate: numeric('warmup_inbox_rate', { precision: 5, scale: 4, mode: 'number' }),
    /** Sends per day once fully ramped. */
    dailyCap: integer('daily_cap').notNull().default(30),
    /** Current ramp-up cap; grows towards `dailyCap`. */
    rampCurrent: integer('ramp_current').notNull().default(10),
    rampUpdatedAt: timestamp('ramp_updated_at', { withTimezone: true }),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),

    pausedReason: text('paused_reason'),
    lastError: text('last_error'),
    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('reach_mailboxes_email_idx').on(table.email),
    uniqueIndex('reach_mailboxes_inbound_token_idx').on(table.inboundToken),
    index('reach_mailboxes_domain_idx').on(table.domainId),
    index('reach_mailboxes_status_idx').on(table.status),
    index('reach_mailboxes_mailpool_idx').on(table.mailpoolMailboxId),
  ],
);

// ---------------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------------

export const reachProspects = pgTable(
  'reach_prospects',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rpro_
    /** Lower-cased. */
    email: varchar('email', { length: 320 }).notNull(),
    firstName: varchar('first_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }),
    companyName: varchar('company_name', { length: 200 }),
    /** Lower-cased domain of the email address (stop-on-reply company scope). */
    companyDomain: varchar('company_domain', { length: 255 }),
    title: varchar('title', { length: 200 }),
    timezone: varchar('timezone', { length: 64 }),
    customFields: jsonb('custom_fields').$type<Record<string, string>>().notNull().default({}),
    source: varchar('source', { length: 20 }).$type<ReachProspectSource>().notNull().default('manual'),
    /** CRM list id, WeldData list id or import file name. */
    sourceRef: varchar('source_ref', { length: 255 }),
    /** CRM `people.id`, set once the prospect replies or is added to the CRM. */
    personId: varchar('person_id', { length: 30 }),
    validation: varchar('validation', { length: 20 }).$type<ReachProspectValidation>().notNull().default('valid'),
    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('reach_prospects_email_idx').on(table.email),
    index('reach_prospects_company_domain_idx').on(table.companyDomain),
    index('reach_prospects_person_idx').on(table.personId),
  ],
);

export const reachProspectLists = pgTable('reach_prospect_lists', {
  id: varchar('id', { length: 30 }).primaryKey(), // rpl_
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  source: varchar('source', { length: 20 }).$type<ReachProspectSource>().notNull().default('manual'),
  sourceRef: varchar('source_ref', { length: 255 }),
  prospectCount: integer('prospect_count').notNull().default(0),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const reachProspectListMembers = pgTable(
  'reach_prospect_list_members',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rplm_
    listId: varchar('list_id', { length: 30 }).notNull(),
    prospectId: varchar('prospect_id', { length: 30 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reach_prospect_list_members_unique_idx').on(table.listId, table.prospectId),
    index('reach_prospect_list_members_prospect_idx').on(table.prospectId),
  ],
);

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export const reachCampaigns = pgTable(
  'reach_campaigns',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rcmp_
    name: varchar('name', { length: 200 }).notNull(),
    status: varchar('status', { length: 20 }).$type<ReachCampaignStatus>().notNull().default('draft'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Europe/Amsterdam'),
    /** ISO weekdays 1 (Mon) .. 7 (Sun). */
    sendDays: jsonb('send_days').$type<number[]>().notNull().default([1, 2, 3, 4, 5]),
    windowStart: varchar('window_start', { length: 5 }).notNull().default('09:00'),
    windowEnd: varchar('window_end', { length: 5 }).notNull().default('17:00'),
    /** Max first-touch + follow-up sends per day for this campaign. */
    dailyLimit: integer('daily_limit').notNull().default(100),
    /** Minimum gap between two sends from the same mailbox (random jitter is added). */
    minGapMinutes: integer('min_gap_minutes').notNull().default(8),
    stopOnAutoReply: boolean('stop_on_auto_reply').notNull().default(false),
    stats: jsonb('stats').$type<ReachCampaignStats>().notNull().default({
      prospects: 0,
      sent: 0,
      replied: 0,
      interested: 0,
      bounced: 0,
      unsubscribed: 0,
    }),
    pausedReason: text('paused_reason'),
    launchedAt: timestamp('launched_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ownerId: varchar('owner_id', { length: 255 }),
    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('reach_campaigns_status_idx').on(table.status)],
);

/** Mailboxes that rotate in a campaign. */
export const reachCampaignMailboxes = pgTable(
  'reach_campaign_mailboxes',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rcmb_
    campaignId: varchar('campaign_id', { length: 30 }).notNull(),
    mailboxId: varchar('mailbox_id', { length: 30 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reach_campaign_mailboxes_unique_idx').on(table.campaignId, table.mailboxId),
    index('reach_campaign_mailboxes_mailbox_idx').on(table.mailboxId),
  ],
);

export const reachCampaignSteps = pgTable(
  'reach_campaign_steps',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rstp_
    campaignId: varchar('campaign_id', { length: 30 }).notNull(),
    /** 0-based; step 0 is the first touch. */
    order: integer('order').notNull(),
    /** Wait after the previous step (ignored for step 0). */
    delayDays: integer('delay_days').notNull().default(3),
    delayHours: integer('delay_hours').notNull().default(0),
    subject: varchar('subject', { length: 300 }).notNull(),
    /** Plain text with `{{variable|fallback}}` placeholders. */
    body: text('body').notNull(),
    /** Follow-up sent as a reply in the same thread ("Re: <first subject>"). */
    replyInThread: boolean('reply_in_thread').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('reach_campaign_steps_order_idx').on(table.campaignId, table.order)],
);

export const reachEnrollments = pgTable(
  'reach_enrollments',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // renr_
    campaignId: varchar('campaign_id', { length: 30 }).notNull(),
    prospectId: varchar('prospect_id', { length: 30 }).notNull(),
    /** Sticky sender, chosen at the first send. */
    mailboxId: varchar('mailbox_id', { length: 30 }),
    status: varchar('status', { length: 20 }).$type<ReachEnrollmentStatus>().notNull().default('queued'),
    /** Index of the next step to send. */
    currentStep: integer('current_step').notNull().default(0),
    nextSendAt: timestamp('next_send_at', { withTimezone: true }),
    /** Set while a send consumer holds the row; stale claims expire after 10 minutes. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    lastMessageId: varchar('last_message_id', { length: 30 }),
    /** RFC Message-ID of the first email, for threading follow-ups. */
    threadRootMessageId: varchar('thread_root_message_id', { length: 255 }),
    stoppedReason: varchar('stopped_reason', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reach_enrollments_campaign_prospect_idx').on(table.campaignId, table.prospectId),
    index('reach_enrollments_due_idx').on(table.status, table.nextSendAt),
    index('reach_enrollments_prospect_idx').on(table.prospectId),
    index('reach_enrollments_mailbox_idx').on(table.mailboxId),
  ],
);

// ---------------------------------------------------------------------------
// Messages (sent and received) and suppressions
// ---------------------------------------------------------------------------

export const reachMessages = pgTable(
  'reach_messages',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rmsg_
    direction: varchar('direction', { length: 3 }).$type<'out' | 'in'>().notNull(),
    campaignId: varchar('campaign_id', { length: 30 }),
    enrollmentId: varchar('enrollment_id', { length: 30 }),
    stepId: varchar('step_id', { length: 30 }),
    mailboxId: varchar('mailbox_id', { length: 30 }).notNull(),
    prospectId: varchar('prospect_id', { length: 30 }),
    /** Thread key: the root Message-ID of the conversation. */
    threadKey: varchar('thread_key', { length: 255 }),

    /** RFC 5322 Message-ID, without angle brackets. */
    messageIdHeader: varchar('message_id_header', { length: 255 }).notNull(),
    inReplyTo: varchar('in_reply_to', { length: 255 }),
    references: text('references'),
    fromEmail: varchar('from_email', { length: 320 }).notNull(),
    toEmail: varchar('to_email', { length: 320 }).notNull(),
    subject: varchar('subject', { length: 500 }),
    /** First ~500 chars of the text body. */
    snippet: text('snippet'),
    /** Full text body for outbound; inbound bodies live in R2 (`r2Key`). */
    bodyText: text('body_text'),
    r2Key: text('r2_key'),

    /** Outbound only. */
    status: varchar('status', { length: 20 }).$type<ReachOutboundStatus>(),
    smtpResponse: text('smtp_response'),
    error: text('error'),
    /** Inbound only. */
    kind: varchar('kind', { length: 20 }).$type<ReachInboundKind>(),
    label: varchar('label', { length: 30 }).$type<ReachReplyLabel>(),
    labelSource: varchar('label_source', { length: 10 }).$type<'ai' | 'user' | 'rule'>(),
    classifiedAt: timestamp('classified_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    handledAt: timestamp('handled_at', { withTimezone: true }),
    handledBy: varchar('handled_by', { length: 255 }),
    /** Outbound reply typed in the reply inbox (not a campaign step). */
    sentBy: varchar('sent_by', { length: 255 }),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reach_messages_message_id_idx').on(table.messageIdHeader),
    index('reach_messages_thread_idx').on(table.threadKey),
    index('reach_messages_mailbox_sent_idx').on(table.mailboxId, table.sentAt),
    index('reach_messages_enrollment_idx').on(table.enrollmentId),
    index('reach_messages_inbox_idx').on(table.direction, table.receivedAt),
    index('reach_messages_campaign_idx').on(table.campaignId),
  ],
);

export const reachSuppressions = pgTable(
  'reach_suppressions',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rsup_
    /** Lower-cased email address, or a domain (`@example.com` form is not used: see `type`). */
    value: varchar('value', { length: 320 }).notNull(),
    type: varchar('type', { length: 10 }).$type<'email' | 'domain'>().notNull().default('email'),
    reason: varchar('reason', { length: 20 }).$type<ReachSuppressionReason>().notNull(),
    /** Message, campaign or import that caused it. */
    source: varchar('source', { length: 255 }),
    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('reach_suppressions_value_idx').on(table.value)],
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReachSettings = typeof reachSettings.$inferSelect;
export type NewReachSettings = typeof reachSettings.$inferInsert;
export type ReachDomain = typeof reachDomains.$inferSelect;
export type NewReachDomain = typeof reachDomains.$inferInsert;
export type ReachMailbox = typeof reachMailboxes.$inferSelect;
export type NewReachMailbox = typeof reachMailboxes.$inferInsert;
export type ReachProspect = typeof reachProspects.$inferSelect;
export type NewReachProspect = typeof reachProspects.$inferInsert;
export type ReachProspectList = typeof reachProspectLists.$inferSelect;
export type NewReachProspectList = typeof reachProspectLists.$inferInsert;
export type ReachProspectListMember = typeof reachProspectListMembers.$inferSelect;
export type ReachCampaign = typeof reachCampaigns.$inferSelect;
export type NewReachCampaign = typeof reachCampaigns.$inferInsert;
export type ReachCampaignMailbox = typeof reachCampaignMailboxes.$inferSelect;
export type ReachCampaignStep = typeof reachCampaignSteps.$inferSelect;
export type NewReachCampaignStep = typeof reachCampaignSteps.$inferInsert;
export type ReachEnrollment = typeof reachEnrollments.$inferSelect;
export type NewReachEnrollment = typeof reachEnrollments.$inferInsert;
export type ReachMessage = typeof reachMessages.$inferSelect;
export type NewReachMessage = typeof reachMessages.$inferInsert;
export type ReachSuppression = typeof reachSuppressions.$inferSelect;
export type NewReachSuppression = typeof reachSuppressions.$inferInsert;
