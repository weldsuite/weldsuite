/**
 * Outbound mail guard. Master DB.
 *
 * Every user-written email leaves through WeldSuite's one Cloudflare account,
 * whose sending quota and standing are shared by all workspaces and by
 * WeldSuite's own system mail. The guard (`@weldsuite/mail-domain/outbound`)
 * limits and screens those sends; these tables hold what staff and the
 * automatic checks decided about each workspace:
 *
 * - `outbound_mail_policies`: one row per workspace (or personal account) that
 *   has anything other than the defaults — a trust override, limit overrides,
 *   or a restriction. No row = computed trust level, default limits, `active`.
 * - `outbound_mail_cases`: detections for staff review (cold-outreach
 *   templates, phishing verdicts, bounce and complaint spikes).
 * - `outbound_mail_events`: the trail of state, trust and limit changes,
 *   automatic and manual.
 *
 * The live counters live in the `OutboundLedger` Durable Object, not here.
 * `workspace_id` is the master `workspaces.id` (no FK, as in app-access.ts).
 * See docs/plans/weldmail-outbound-abuse.md.
 */

import { pgTable, varchar, text, timestamp, jsonb, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const OUTBOUND_POLICY_STATES = ['active', 'restricted', 'hold', 'suspended'] as const;
export type OutboundPolicyState = (typeof OUTBOUND_POLICY_STATES)[number];

export const OUTBOUND_POLICY_TRUST_LEVELS = ['new', 'standard', 'trusted'] as const;
export type OutboundPolicyTrustLevel = (typeof OUTBOUND_POLICY_TRUST_LEVELS)[number];

/** Limit overrides as stored; validated with `outboundLimitOverridesSchema` on write. */
export type OutboundPolicyLimitOverrides = Partial<{
  recipientsPerMessage: number;
  senderPerHour: number;
  senderPerDay: number;
  workspacePerDay: number;
  firstContactPerDay: number;
  repliesPerSenderPerDay: number;
  monthlyRecipients: number | null;
}>;

export const outboundMailPolicies = pgTable(
  'outbound_mail_policies',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    /** Master workspace id; null for a personal account's row. */
    workspaceId: varchar('workspace_id', { length: 255 }),
    personalAccountId: varchar('personal_account_id', { length: 30 }),
    /** Staff-pinned trust level; null = computed from age, plan and record. */
    trustOverride: varchar('trust_override', { length: 20 }).$type<OutboundPolicyTrustLevel>(),
    limits: jsonb('limits').$type<OutboundPolicyLimitOverrides>().notNull().default({}),
    state: varchar('state', { length: 20 }).$type<OutboundPolicyState>().notNull().default('active'),
    /** Customer-facing reason while a restriction is on. */
    stateReason: text('state_reason'),
    /** `system` for automatic changes, otherwise the staff member's email. */
    stateSetBy: varchar('state_set_by', { length: 255 }),
    stateSetAt: timestamp('state_set_at'),
    /** While suspended, still let replies to people who wrote in go out. */
    allowRepliesWhenSuspended: boolean('allow_replies_when_suspended').notNull().default(false),
    /** Last computed risk score (0–100), refreshed by the ledger. */
    riskScore: integer('risk_score').notNull().default(0),
    riskUpdatedAt: timestamp('risk_updated_at'),
    /** Staff notes; never shown to the customer. */
    notes: text('notes'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('outbound_mail_policies_workspace_idx').on(table.workspaceId),
    uniqueIndex('outbound_mail_policies_personal_idx').on(table.personalAccountId),
    index('outbound_mail_policies_state_idx').on(table.state),
    index('outbound_mail_policies_risk_idx').on(table.riskScore),
  ],
);

export type OutboundMailPolicy = typeof outboundMailPolicies.$inferSelect;
export type NewOutboundMailPolicy = typeof outboundMailPolicies.$inferInsert;

export const OUTBOUND_CASE_TRIGGER_VALUES = [
  'cold_outreach_template',
  'phishing',
  'bounce_rate',
  'complaints',
  'risk_score',
  'platform_budget',
  'staff_review',
] as const;
export type OutboundCaseTriggerValue = (typeof OUTBOUND_CASE_TRIGGER_VALUES)[number];

/** The AI verdict as stored on a case. */
export interface OutboundCaseVerdict {
  category: string;
  unsolicited: boolean;
  confidence: number;
  signals: string[];
  modelId: string;
  reviewedAt: string;
}

/** Numbers that explain the case; whatever the trigger had at hand. */
export type OutboundCaseMetrics = Record<string, number | string | boolean | null>;

export const outboundMailCases = pgTable(
  'outbound_mail_cases',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    workspaceId: varchar('workspace_id', { length: 255 }),
    personalAccountId: varchar('personal_account_id', { length: 30 }),
    trigger: varchar('trigger', { length: 40 }).$type<OutboundCaseTriggerValue>().notNull(),
    severity: varchar('severity', { length: 10 }).$type<'info' | 'warning' | 'urgent'>().notNull(),
    /** SimHash of the template (16 hex characters), when the case is about one. */
    fingerprint: varchar('fingerprint', { length: 32 }),
    aiVerdict: jsonb('ai_verdict').$type<OutboundCaseVerdict>(),
    riskScore: integer('risk_score'),
    /** Normalised template text, at most 300 characters; opening it is audited. */
    snippet: text('snippet'),
    subject: varchar('subject', { length: 300 }),
    /** A few recipient domains (never full addresses). */
    sampleDomains: jsonb('sample_domains').$type<string[]>(),
    /** Which send path(s) the template came through. */
    sources: jsonb('sources').$type<string[]>(),
    metrics: jsonb('metrics').$type<OutboundCaseMetrics>().notNull().default({}),
    status: varchar('status', { length: 20 }).$type<'open' | 'confirmed' | 'dismissed'>().notNull().default('open'),
    /** One open case per trigger + subject per day; see openOutboundCase. */
    dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),
    alertedAt: timestamp('alerted_at'),
    reviewedBy: varchar('reviewed_by', { length: 255 }),
    reviewedAt: timestamp('reviewed_at'),
    reviewNotes: text('review_notes'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('outbound_mail_cases_dedupe_idx').on(table.dedupeKey),
    index('outbound_mail_cases_workspace_idx').on(table.workspaceId),
    index('outbound_mail_cases_status_idx').on(table.status, table.createdAt),
  ],
);

export type OutboundMailCase = typeof outboundMailCases.$inferSelect;
export type NewOutboundMailCase = typeof outboundMailCases.$inferInsert;

export const OUTBOUND_EVENT_KINDS = [
  'state_changed',
  'trust_changed',
  'limits_changed',
  'case_opened',
  'case_reviewed',
  'platform_breaker',
] as const;
export type OutboundEventKind = (typeof OUTBOUND_EVENT_KINDS)[number];

export const outboundMailEvents = pgTable(
  'outbound_mail_events',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    workspaceId: varchar('workspace_id', { length: 255 }),
    personalAccountId: varchar('personal_account_id', { length: 30 }),
    kind: varchar('kind', { length: 40 }).$type<OutboundEventKind>().notNull(),
    fromValue: varchar('from_value', { length: 40 }),
    toValue: varchar('to_value', { length: 40 }),
    reason: text('reason'),
    /** `system` or the staff member's email. */
    actor: varchar('actor', { length: 255 }).notNull(),
    details: jsonb('details').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('outbound_mail_events_workspace_idx').on(table.workspaceId, table.createdAt),
    index('outbound_mail_events_created_idx').on(table.createdAt),
  ],
);

export type OutboundMailEvent = typeof outboundMailEvents.$inferSelect;
export type NewOutboundMailEvent = typeof outboundMailEvents.$inferInsert;
