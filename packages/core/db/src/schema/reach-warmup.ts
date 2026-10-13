/**
 * WeldReach warmup network. Master DB.
 *
 * The pool is every WeldReach mailbox across all workspaces: each one sends a
 * slowly growing number of generated emails to other pool mailboxes and
 * engages (over IMAP) with the ones it receives. Where each email landed
 * (inbox or spam) is the inbox-placement signal that gates campaigns.
 *
 * Master DB on purpose: the pool and its messages span workspaces, and the
 * engine (apps/workers/reach-warmup-worker) must never wake tenant databases on
 * a timer. reach-api registers, pauses and removes mailboxes here; the tenant
 * `reach_mailboxes` row stays the source of truth for the customer's view.
 *
 * Mailbox logins are sealed with WELDREACH_WARMUP_KEY (not the tenant
 * DATABASE_ENCRYPTION_KEY) and never leave the warmup worker and reach-api.
 * See docs/plans/weldreach-warmup.md.
 */

import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const REACH_WARMUP_STATUSES = ['waiting', 'warming', 'maintaining', 'paused', 'error', 'removed'] as const;
export type ReachWarmupStatus = (typeof REACH_WARMUP_STATUSES)[number];

export const REACH_WARMUP_MESSAGE_STATUSES = ['scheduled', 'sent', 'failed', 'engaged', 'missing'] as const;
export type ReachWarmupMessageStatus = (typeof REACH_WARMUP_MESSAGE_STATUSES)[number];

export const REACH_WARMUP_PLACEMENTS = ['inbox', 'spam', 'missing'] as const;
export type ReachWarmupPlacement = (typeof REACH_WARMUP_PLACEMENTS)[number];

/** Rolled up by the warmup worker; read by reach-api for the health gate and the UI. */
export interface ReachWarmupStats {
  /** Warmup emails this mailbox sent / received in the last 7 days. */
  sent7d: number;
  received7d: number;
  /** Where this mailbox's own emails landed at the recipient, last 3 and 7 days. */
  inbox3d: number;
  spam3d: number;
  missing3d: number;
  inbox7d: number;
  spam7d: number;
  missing7d: number;
  /** inbox / (inbox + spam + missing) over 3 days; null below the minimum sample. */
  inboxRate3d: number | null;
  inboxRate7d: number | null;
  /** Emails to this mailbox moved out of spam by the engager, last 7 days. */
  spamRescues7d: number;
  rolledUpAt: string;
}

/** What the engager did with one received email. */
export interface ReachWarmupActions {
  movedFromSpam?: boolean;
  seen?: boolean;
  flagged?: boolean;
  replyScheduled?: boolean;
}

export const reachWarmupMailboxes = pgTable(
  'reach_warmup_mailboxes',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rwmb_
    /** Master `workspaces.id`. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    clerkOrgId: varchar('clerk_org_id', { length: 255 }).notNull(),
    /** Tenant `reach_mailboxes.id`. */
    tenantMailboxId: varchar('tenant_mailbox_id', { length: 30 }).notNull(),

    email: varchar('email', { length: 320 }).notNull(),
    /** Lower-cased domain of `email`; pairing never stays within one domain. */
    domain: varchar('domain', { length: 255 }).notNull(),
    /** Mailpool mailbox type (`google` | `shared`). */
    mailboxType: varchar('mailbox_type', { length: 20 }).notNull(),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    /** IANA zone the mailbox "works" in (business hours for sends). */
    timezone: varchar('timezone', { length: 64 }).notNull().default('Europe/Amsterdam'),

    status: varchar('status', { length: 20 }).$type<ReachWarmupStatus>().notNull().default('waiting'),
    /** When it first sent warmup mail (null while `waiting`). */
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** Days of actual warmup sending so far (drives the ramp). */
    rampDay: integer('ramp_day').notNull().default(0),
    rampUpdatedAt: timestamp('ramp_updated_at', { withTimezone: true }),
    /** Today's planned sends (set by the planner). */
    dailyTarget: integer('daily_target').notNull().default(0),
    plannedFor: varchar('planned_for', { length: 10 }),

    /** `sealWarmupCredentials(JSON)` with WELDREACH_WARMUP_KEY. Never returned by any API. */
    smtpCredentials: text('smtp_credentials').notNull(),
    imapCredentials: text('imap_credentials').notNull(),

    stats: jsonb('stats').$type<ReachWarmupStats>(),
    pausedReason: varchar('paused_reason', { length: 100 }),
    lastLoginError: text('last_login_error'),
    lastLoginErrorAt: timestamp('last_login_error_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reach_warmup_mailboxes_tenant_idx').on(table.clerkOrgId, table.tenantMailboxId),
    uniqueIndex('reach_warmup_mailboxes_email_idx').on(table.email),
    index('reach_warmup_mailboxes_status_idx').on(table.status),
    index('reach_warmup_mailboxes_workspace_idx').on(table.workspaceId),
    index('reach_warmup_mailboxes_domain_idx').on(table.domain),
  ],
);

export const reachWarmupMessages = pgTable(
  'reach_warmup_messages',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rwms_
    /** Groups the messages of one generated conversation. */
    threadId: varchar('thread_id', { length: 30 }).notNull(),
    /** 0 = first message, 1+ = replies. */
    step: integer('step').notNull().default(0),
    fromMailboxId: varchar('from_mailbox_id', { length: 30 }).notNull(),
    toMailboxId: varchar('to_mailbox_id', { length: 30 }).notNull(),
    /** Corpus thread the text comes from. */
    corpusThreadId: varchar('corpus_thread_id', { length: 60 }).notNull(),

    /** RFC 5322 Message-ID without angle brackets; how the engager and reach-api's inbound filter find it. */
    messageIdHeader: varchar('message_id_header', { length: 255 }).notNull(),
    inReplyTo: varchar('in_reply_to', { length: 255 }),
    references: text('references'),
    subject: varchar('subject', { length: 300 }).notNull(),

    status: varchar('status', { length: 20 }).$type<ReachWarmupMessageStatus>().notNull().default('scheduled'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    /** Set while a queue consumer holds the row; stale claims expire. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),

    engageAt: timestamp('engage_at', { withTimezone: true }),
    engageAttempts: integer('engage_attempts').notNull().default(0),
    engagedAt: timestamp('engaged_at', { withTimezone: true }),
    placement: varchar('placement', { length: 10 }).$type<ReachWarmupPlacement>(),
    actions: jsonb('actions').$type<ReachWarmupActions>(),
    /** Cleanup deleted the thread from both mailboxes. */
    cleanedAt: timestamp('cleaned_at', { withTimezone: true }),
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reach_warmup_messages_message_id_idx').on(table.messageIdHeader),
    index('reach_warmup_messages_send_due_idx').on(table.status, table.scheduledAt),
    index('reach_warmup_messages_engage_due_idx').on(table.status, table.engageAt),
    index('reach_warmup_messages_from_idx').on(table.fromMailboxId, table.sentAt),
    index('reach_warmup_messages_to_idx').on(table.toMailboxId, table.sentAt),
    index('reach_warmup_messages_thread_idx').on(table.threadId),
  ],
);

export type ReachWarmupMailbox = typeof reachWarmupMailboxes.$inferSelect;
export type NewReachWarmupMailbox = typeof reachWarmupMailboxes.$inferInsert;
export type ReachWarmupMessage = typeof reachWarmupMessages.$inferSelect;
export type NewReachWarmupMessage = typeof reachWarmupMessages.$inferInsert;
