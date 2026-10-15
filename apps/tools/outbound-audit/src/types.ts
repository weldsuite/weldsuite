/**
 * Shapes shared by the audit's pure aggregation code and its database and
 * Cloudflare readers. Every summary type holds counts, domains and truncated,
 * tokenised snippets only: never a full recipient address.
 */

import type { OutboundTrustLevel } from '@weldsuite/app-api-client/schemas/outbound-mail';

export type SendKind = 'new_thread' | 'reply' | 'forward';

export interface AddressEntry {
  /** Lower-cased, trimmed. */
  email: string;
  name: string | null;
}

/** One SENT copy from `mail_messages` (source = 'sent'), as the reader returns it. */
export interface SentMessageRow {
  id: string;
  accountId: string;
  sentAt: Date;
  subject: string | null;
  to: unknown;
  cc: unknown;
  bcc: unknown;
  inReplyTo: string | null;
  isReply: boolean | null;
  isForwarded: boolean | null;
  textBody: string | null;
  htmlBody: string | null;
}

export interface MailboxInfo {
  id: string;
  email: string;
  sendProvider: string | null;
  deleted: boolean;
}

/** What the tenant DB says about who the workspace already knows. */
export interface CorrespondentContext {
  /** Lower-cased address → when it first wrote to the workspace. */
  firstInbound: ReadonlyMap<string, Date>;
  /** The workspace's own mailbox addresses, lower-cased. */
  ownAddresses: ReadonlySet<string>;
  /** The workspace's own custom mail domains (shared `*.weldmail.com` excluded). */
  ownDomains: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// WeldMail sends
// ---------------------------------------------------------------------------

export interface MailboxDayStats {
  day: string;
  mailboxId: string;
  mailbox: string;
  messages: number;
  /** Envelope recipients (to + cc + bcc per message), what Cloudflare counts. */
  recipients: number;
  distinctRecipients: number;
  recipientDomains: number;
  firstContactRecipients: number;
  distinctFirstContact: number;
  newThreads: number;
  replies: number;
  forwards: number;
  bccRecipients: number;
  maxRecipientsPerMessage: number;
  /** Most recipients in one clock hour (UTC) of the day. */
  peakHourRecipients: number;
}

export interface MailboxTotals {
  mailboxId: string;
  mailbox: string;
  sendProvider: string | null;
  deleted: boolean;
  /** `*.weldmail.com`: shares weldmail.com's reputation with every workspace. */
  sharedDomain: boolean;
  messages: number;
  recipients: number;
  distinctRecipients: number;
  distinctDomains: number;
  firstContactRecipients: number;
  distinctFirstContact: number;
  newThreads: number;
  replies: number;
  forwards: number;
  activeDays: number;
  peakDayRecipients: number;
  peakHourRecipients: number;
}

export interface DayTotals {
  day: string;
  messages: number;
  recipients: number;
  firstContactRecipients: number;
  distinctFirstContact: number;
  newThreads: number;
}

export interface DomainCount {
  domain: string;
  recipients: number;
}

export interface TemplateStats {
  fingerprint: string;
  messages: number;
  distinctRecipients: number;
  /** Distinct recipients who had never written to the workspace when it was sent. */
  distinctFirstContact: number;
  /** Most distinct first-contact recipients on one UTC day. */
  peakDayFirstContact: number;
  days: number;
  mailboxes: string[];
  firstSeen: string;
  lastSeen: string;
  /** Subject of the first copy, merge fields and addresses scrubbed, at most 80 characters. */
  subject: string;
  /** Normalised body of the first copy (tokens for names, addresses, links, numbers), at most 120 characters. */
  snippet: string;
  /** Copies whose content screen scored 3 or more. */
  flaggedMessages: number;
}

export interface ContentStats {
  screened: number;
  /** Content screen score 3 or more (the guard's "worth a look"). */
  flagged: number;
  coldOutreach: number;
  bulk: number;
  phishing: number;
  /** Reason key (without its count) → messages. */
  reasons: Record<string, number>;
}

export const RECIPIENT_BUCKETS = [
  { label: '1', min: 1 },
  { label: '2-5', min: 2 },
  { label: '6-10', min: 6 },
  { label: '11-20', min: 11 },
  { label: '21-50', min: 21 },
  { label: '51+', min: 51 },
] as const;

export interface MailTotals {
  messages: number;
  messagesWithoutRecipients: number;
  recipients: number;
  distinctRecipients: number;
  distinctDomains: number;
  firstContactRecipients: number;
  distinctFirstContact: number;
  /** First-contact share of envelope recipients; null without recipients. */
  firstContactShare: number | null;
  /** Distinct first-contact recipients who wrote back after the first send in the window. */
  firstContactRepliedLater: number;
  firstContactReplyRate: number | null;
  newThreads: number;
  replies: number;
  forwards: number;
  bccRecipients: number;
  activeDays: number;
  activeMailboxes: number;
  templatesTracked: number;
  /** Templates that reached 10 / 25 distinct first-contact recipients on one day (the plan's review and cap thresholds). */
  templatesOverReviewThreshold: number;
  templatesOverColdCap: number;
}

export interface MailSummary {
  totals: MailTotals;
  mailboxes: MailboxTotals[];
  mailboxDays: MailboxDayStats[];
  days: DayTotals[];
  topDomains: DomainCount[];
  templates: TemplateStats[];
  content: ContentStats;
  /** Messages per recipient-count bucket ({@link RECIPIENT_BUCKETS} labels). */
  recipientsPerMessage: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Paths that store no SENT copy
// ---------------------------------------------------------------------------

/** A `send_email` step of a CRM sequence run, with the enrolled contact as recipient. */
export interface SequenceStepRow {
  at: Date;
  status: string;
  /** Lower-cased email of the enrolled contact (customer snapshot); null when absent. */
  recipient: string | null;
  sequenceId: string;
}

export interface EnrollmentRow {
  day: string;
  sequenceId: string;
  count: number;
}

export interface AutomationDay {
  day: string;
  sent: number;
  failed: number;
}

export interface SequenceSummary {
  sent: number;
  failed: number;
  otherSteps: number;
  sequences: number;
  /** Completed sends whose recipient is known (the enrolled contact). */
  recipientsKnown: number;
  distinctRecipients: number;
  firstContactRecipients: number;
  distinctFirstContact: number;
  topDomains: DomainCount[];
  days: AutomationDay[];
  enrollments: { total: number; sequences: number; days: { day: string; count: number }[] };
}

/** WeldConnect `send_email` step rows, grouped by the reader. */
export interface WorkflowStepGroup {
  day: string;
  status: string;
  workflowId: string;
  /** `output.runs` of a loop-body row (one row summarises every iteration); null for a single send. */
  runs: number | null;
  /** "X of N" from a loop row's "X of N runs failed" error; null otherwise. */
  runFailure: string | null;
  steps: number;
}

export interface WorkflowSummary {
  sent: number;
  failedSteps: number;
  workflows: number;
  days: AutomationDay[];
}

// ---------------------------------------------------------------------------
// Cloudflare Email Sending analytics
// ---------------------------------------------------------------------------

export interface CfGroupRow {
  count: number;
  date: string;
  sendingDomain: string;
  status: string;
  isSpam: number;
  isLastEvent: number;
  eventType: string;
}

export interface CfDomainSummary {
  domain: string;
  zoneId: string;
  /** All events (an email has several). */
  events: number;
  /** Emails, counted by their last event (all events when Cloudflare marks none as last). */
  emails: number;
  byStatus: Record<string, number>;
  byEventType: Record<string, number>;
  failed: number;
  spam: number;
}

export interface CloudflareSummary {
  days: number;
  domains: CfDomainSummary[];
  emails: number;
  failed: number;
  spam: number;
  bounceShare: number | null;
  spamShare: number | null;
  /** Domains with no zone in this account, or whose query failed. */
  problems: string[];
}

// ---------------------------------------------------------------------------
// Proposed limits, score and the report
// ---------------------------------------------------------------------------

export interface LimitOverruns {
  trustLevel: OutboundTrustLevel;
  limits: {
    recipientsPerMessage: number;
    senderPerHour: number;
    senderPerDay: number;
    workspacePerDay: number;
    firstContactPerDay: number;
    sharedDomainFirstContactPerDay: number;
  };
  workspaceDays: { day: string; value: number }[];
  firstContactDays: { day: string; value: number }[];
  mailboxDays: { day: string; mailbox: string; value: number }[];
  mailboxHours: { day: string; mailbox: string; value: number }[];
  messagesOverRecipientCap: number;
  sharedDomainFirstContactDays: { day: string; mailbox: string; value: number }[];
}

export interface ScoreResult {
  score: number;
  factors: { volume: number; firstContact: number; template: number; content: number; bounce: number };
  /** No recipient was known (WeldConnect only): a first-contact share of 0.5 was assumed. */
  firstContactAssumed: boolean;
}

export interface WorkspaceAudit {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  subscriptionStatus: string | null;
  /** Estimated with no bounce data, so never `trusted`. */
  trustLevel: OutboundTrustLevel;
  volume: number;
  firstContactShare: number | null;
  mail: MailSummary | null;
  sequences: SequenceSummary | null;
  workflows: WorkflowSummary | null;
  cloudflare: CloudflareSummary | null;
  limits: LimitOverruns | null;
  score: ScoreResult;
  notes: string[];
}

export interface AuditReport {
  generatedAt: string;
  env: string | null;
  days: number;
  since: string;
  until: string;
  cloudflareDays: number | null;
  redacted: boolean;
  workspaces: WorkspaceAudit[];
  failed: { workspace: string; error: string }[];
}
