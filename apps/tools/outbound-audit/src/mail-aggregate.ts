/**
 * Aggregates a workspace's SENT copies into the audit's mail summary. Pure:
 * the reader streams rows in with {@link MailAccumulator.add}, nothing here
 * touches a database.
 *
 * Recipient addresses only live in memory (to count distinct recipients and
 * first contacts); the summary holds counts, domains and scrubbed snippets.
 */

import { OUTBOUND_THRESHOLDS } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { screenOutboundContent } from '@weldsuite/mail-domain/outbound/content-screen';
import {
  fingerprintTemplate,
  normalizeForFingerprint,
  personalTokensFor,
} from '@weldsuite/mail-domain/outbound/fingerprint';
import { plainTextBody } from '@weldsuite/mail-domain/text';
import {
  classifyKind,
  domainOf,
  isFirstContact,
  isSharedDomainAddress,
  messageRecipients,
  scrubText,
  truncate,
  utcDay,
  utcHour,
} from './recipients';
import { TemplateClusterer } from './templates';
import {
  RECIPIENT_BUCKETS,
  type ContentStats,
  type CorrespondentContext,
  type DayTotals,
  type DomainCount,
  type MailboxDayStats,
  type MailboxInfo,
  type MailboxTotals,
  type MailSummary,
  type SentMessageRow,
  type TemplateStats,
} from './types';

/** Content screen score from which a send counts as flagged (as in the guard's risk score). */
export const FLAGGED_CONTENT_SCORE = 3;
export const SNIPPET_CHARS = 120;
export const SUBJECT_CHARS = 80;

export interface MailAggregateOptions {
  topTemplates: number;
  topDomains: number;
}

interface MailboxDayAcc {
  day: string;
  mailboxId: string;
  messages: number;
  recipients: number;
  distinct: Set<string>;
  domains: Set<string>;
  firstContactRecipients: number;
  distinctFirstContact: Set<string>;
  newThreads: number;
  replies: number;
  forwards: number;
  bccRecipients: number;
  maxRecipientsPerMessage: number;
  hours: Map<string, number>;
}

interface DayAcc {
  day: string;
  messages: number;
  recipients: number;
  firstContactRecipients: number;
  distinctFirstContact: Set<string>;
  newThreads: number;
}

interface TemplateAcc {
  fingerprint: string;
  messages: number;
  recipients: Set<string>;
  firstContact: Set<string>;
  firstContactByDay: Map<string, Set<string>>;
  days: Set<string>;
  mailboxes: Set<string>;
  firstSeen: Date;
  lastSeen: Date;
  subject: string;
  snippet: string;
  flaggedMessages: number;
}

function increment<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function bucketFor(recipients: number): string {
  let label: string = RECIPIENT_BUCKETS[0].label;
  for (const bucket of RECIPIENT_BUCKETS) if (recipients >= bucket.min) label = bucket.label;
  return label;
}

export function topCounts(counts: Map<string, number>, limit: number): DomainCount[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([domain, recipients]) => ({ domain, recipients }));
}

export class MailAccumulator {
  private readonly mailboxDays = new Map<string, MailboxDayAcc>();
  private readonly days = new Map<string, DayAcc>();
  private readonly domainCounts = new Map<string, number>();
  private readonly allRecipients = new Set<string>();
  /** First-contact recipient → their earliest send in the window. */
  private readonly firstContactFirstSend = new Map<string, Date>();
  private readonly templates: TemplateAcc[] = [];
  private readonly clusterer = new TemplateClusterer();
  private readonly buckets = new Map<string, number>();
  private readonly content: ContentStats = { screened: 0, flagged: 0, coldOutreach: 0, bulk: 0, phishing: 0, reasons: {} };
  private messages = 0;
  private messagesWithoutRecipients = 0;
  private recipients = 0;
  private firstContactRecipients = 0;
  private newThreads = 0;
  private replies = 0;
  private forwards = 0;
  private bccRecipients = 0;

  constructor(
    private readonly ctx: CorrespondentContext,
    private readonly mailboxes: ReadonlyMap<string, MailboxInfo>,
    private readonly options: MailAggregateOptions,
  ) {}

  add(row: SentMessageRow): void {
    this.messages++;
    const { all, bcc } = messageRecipients(row.to, row.cc, row.bcc);
    if (all.length === 0) {
      this.messagesWithoutRecipients++;
      return;
    }

    const day = utcDay(row.sentAt);
    const kind = classifyKind(row);
    const firstContact = all.filter((r) => isFirstContact(r.email, row.sentAt, this.ctx));

    this.recipients += all.length;
    this.firstContactRecipients += firstContact.length;
    this.bccRecipients += bcc;
    if (kind === 'new_thread') this.newThreads++;
    else if (kind === 'reply') this.replies++;
    else this.forwards++;
    increment(this.buckets, bucketFor(all.length));

    for (const r of all) {
      this.allRecipients.add(r.email);
      increment(this.domainCounts, domainOf(r.email));
    }
    for (const r of firstContact) {
      const earliest = this.firstContactFirstSend.get(r.email);
      if (!earliest || row.sentAt < earliest) this.firstContactFirstSend.set(r.email, row.sentAt);
    }

    this.addMailboxDay(row, day, kind, all.map((r) => r.email), firstContact.map((r) => r.email), bcc);
    this.addDay(day, kind, all.length, firstContact.map((r) => r.email));

    const flagged = this.screen(row);
    if (kind === 'new_thread') this.addTemplate(row, day, all, firstContact.map((r) => r.email), flagged);
  }

  private addMailboxDay(row: SentMessageRow, day: string, kind: string, emails: string[], firstContact: string[], bcc: number): void {
    const key = `${day}|${row.accountId}`;
    let acc = this.mailboxDays.get(key);
    if (!acc) {
      acc = {
        day,
        mailboxId: row.accountId,
        messages: 0,
        recipients: 0,
        distinct: new Set(),
        domains: new Set(),
        firstContactRecipients: 0,
        distinctFirstContact: new Set(),
        newThreads: 0,
        replies: 0,
        forwards: 0,
        bccRecipients: 0,
        maxRecipientsPerMessage: 0,
        hours: new Map(),
      };
      this.mailboxDays.set(key, acc);
    }
    acc.messages++;
    acc.recipients += emails.length;
    for (const email of emails) {
      acc.distinct.add(email);
      acc.domains.add(domainOf(email));
    }
    acc.firstContactRecipients += firstContact.length;
    for (const email of firstContact) acc.distinctFirstContact.add(email);
    if (kind === 'new_thread') acc.newThreads++;
    else if (kind === 'reply') acc.replies++;
    else acc.forwards++;
    acc.bccRecipients += bcc;
    acc.maxRecipientsPerMessage = Math.max(acc.maxRecipientsPerMessage, emails.length);
    increment(acc.hours, utcHour(row.sentAt), emails.length);
  }

  private addDay(day: string, kind: string, recipients: number, firstContact: string[]): void {
    let acc = this.days.get(day);
    if (!acc) {
      acc = { day, messages: 0, recipients: 0, firstContactRecipients: 0, distinctFirstContact: new Set(), newThreads: 0 };
      this.days.set(day, acc);
    }
    acc.messages++;
    acc.recipients += recipients;
    acc.firstContactRecipients += firstContact.length;
    for (const email of firstContact) acc.distinctFirstContact.add(email);
    if (kind === 'new_thread') acc.newThreads++;
  }

  /** Runs the outbound content screen; true when the send counts as flagged. */
  private screen(row: SentMessageRow): boolean {
    const result = screenOutboundContent({ subject: row.subject, text: row.textBody, html: row.htmlBody });
    this.content.screened++;
    if (result.flags.coldOutreach) this.content.coldOutreach++;
    if (result.flags.bulk) this.content.bulk++;
    if (result.flags.phishing) this.content.phishing++;
    for (const reason of result.reasons) {
      const key = reason.split(':')[0];
      this.content.reasons[key] = (this.content.reasons[key] ?? 0) + 1;
    }
    const flagged = result.score >= FLAGGED_CONTENT_SCORE;
    if (flagged) this.content.flagged++;
    return flagged;
  }

  private addTemplate(
    row: SentMessageRow,
    day: string,
    recipients: { email: string; name: string | null }[],
    firstContact: string[],
    flagged: boolean,
  ): void {
    const emails = recipients.map((r) => r.email);
    const names = recipients.map((r) => r.name).filter((n): n is string => Boolean(n));
    const personalTokens = personalTokensFor(emails, names);
    const text = plainTextBody(row.textBody ?? undefined, row.htmlBody ?? undefined) ?? '';
    const fp = fingerprintTemplate({ subject: row.subject, text, personalTokens });
    if (fp.tooShort) return;

    const index = this.clusterer.assign(fp.fingerprint);
    let acc = this.templates[index];
    if (!acc) {
      acc = {
        fingerprint: this.clusterer.representative(index),
        messages: 0,
        recipients: new Set(),
        firstContact: new Set(),
        firstContactByDay: new Map(),
        days: new Set(),
        mailboxes: new Set(),
        firstSeen: row.sentAt,
        lastSeen: row.sentAt,
        subject: scrubText(row.subject ?? '', personalTokens, SUBJECT_CHARS),
        snippet: truncate(normalizeForFingerprint({ text, personalTokens }), SNIPPET_CHARS),
        flaggedMessages: 0,
      };
      this.templates[index] = acc;
    }
    acc.messages++;
    acc.days.add(day);
    for (const email of emails) acc.recipients.add(email);
    for (const email of firstContact) {
      acc.firstContact.add(email);
      addToSetMap(acc.firstContactByDay, day, email);
    }
    acc.mailboxes.add(row.accountId);
    if (row.sentAt < acc.firstSeen) acc.firstSeen = row.sentAt;
    if (row.sentAt > acc.lastSeen) acc.lastSeen = row.sentAt;
    if (flagged) acc.flaggedMessages++;
  }

  private mailboxLabel(id: string): string {
    return this.mailboxes.get(id)?.email ?? `unknown mailbox ${id}`;
  }

  /** First contacts whose first mail to the workspace came after their first send in the window. */
  private repliedLater(): number {
    let replied = 0;
    for (const [email, firstSend] of this.firstContactFirstSend) {
      const inbound = this.ctx.firstInbound.get(email);
      if (inbound && inbound.getTime() > firstSend.getTime()) replied++;
    }
    return replied;
  }

  private rankedTemplates(all: TemplateStats[]): TemplateStats[] {
    return [...all]
      .sort(
        (a, b) =>
          b.distinctFirstContact - a.distinctFirstContact ||
          b.distinctRecipients - a.distinctRecipients ||
          b.messages - a.messages ||
          a.fingerprint.localeCompare(b.fingerprint),
      )
      .slice(0, this.options.topTemplates);
  }

  finish(): MailSummary {
    const mailboxDays: MailboxDayStats[] = [...this.mailboxDays.values()]
      .map((acc) => ({
        day: acc.day,
        mailboxId: acc.mailboxId,
        mailbox: this.mailboxLabel(acc.mailboxId),
        messages: acc.messages,
        recipients: acc.recipients,
        distinctRecipients: acc.distinct.size,
        recipientDomains: acc.domains.size,
        firstContactRecipients: acc.firstContactRecipients,
        distinctFirstContact: acc.distinctFirstContact.size,
        newThreads: acc.newThreads,
        replies: acc.replies,
        forwards: acc.forwards,
        bccRecipients: acc.bccRecipients,
        maxRecipientsPerMessage: acc.maxRecipientsPerMessage,
        peakHourRecipients: Math.max(0, ...acc.hours.values()),
      }))
      .sort((a, b) => a.day.localeCompare(b.day) || a.mailbox.localeCompare(b.mailbox));

    const mailboxes = this.mailboxTotals();
    const days: DayTotals[] = [...this.days.values()]
      .map((acc) => ({
        day: acc.day,
        messages: acc.messages,
        recipients: acc.recipients,
        firstContactRecipients: acc.firstContactRecipients,
        distinctFirstContact: acc.distinctFirstContact.size,
        newThreads: acc.newThreads,
      }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const allTemplates = this.templates.filter((t): t is TemplateAcc => Boolean(t)).map((t) => this.templateStats(t));
    const repliedLater = this.repliedLater();
    const distinctFirstContact = this.firstContactFirstSend.size;

    const recipientsPerMessage: Record<string, number> = {};
    for (const bucket of RECIPIENT_BUCKETS) recipientsPerMessage[bucket.label] = this.buckets.get(bucket.label) ?? 0;

    return {
      totals: {
        messages: this.messages,
        messagesWithoutRecipients: this.messagesWithoutRecipients,
        recipients: this.recipients,
        distinctRecipients: this.allRecipients.size,
        distinctDomains: this.domainCounts.size,
        firstContactRecipients: this.firstContactRecipients,
        distinctFirstContact,
        firstContactShare: this.recipients > 0 ? this.firstContactRecipients / this.recipients : null,
        firstContactRepliedLater: repliedLater,
        firstContactReplyRate: distinctFirstContact > 0 ? repliedLater / distinctFirstContact : null,
        newThreads: this.newThreads,
        replies: this.replies,
        forwards: this.forwards,
        bccRecipients: this.bccRecipients,
        activeDays: this.days.size,
        activeMailboxes: mailboxes.length,
        templatesTracked: allTemplates.length,
        templatesOverReviewThreshold: allTemplates.filter(
          (t) => t.peakDayFirstContact >= OUTBOUND_THRESHOLDS.reviewFirstContactRecipients,
        ).length,
        templatesOverColdCap: allTemplates.filter(
          (t) => t.peakDayFirstContact >= OUTBOUND_THRESHOLDS.coldTemplateFirstContactPerDay,
        ).length,
      },
      mailboxes,
      mailboxDays,
      days,
      topDomains: topCounts(this.domainCounts, this.options.topDomains),
      templates: this.rankedTemplates(allTemplates),
      content: { ...this.content, reasons: { ...this.content.reasons } },
      recipientsPerMessage,
    };
  }

  private mailboxTotals(): MailboxTotals[] {
    const byMailbox = new Map<string, MailboxDayAcc[]>();
    for (const acc of this.mailboxDays.values()) {
      const list = byMailbox.get(acc.mailboxId);
      if (list) list.push(acc);
      else byMailbox.set(acc.mailboxId, [acc]);
    }
    return [...byMailbox.entries()]
      .map(([mailboxId, list]) => this.mailboxRow(mailboxId, list))
      .sort((a, b) => b.recipients - a.recipients || a.mailbox.localeCompare(b.mailbox));
  }

  /** One mailbox's days rolled up into its totals. */
  private mailboxRow(mailboxId: string, list: MailboxDayAcc[]): MailboxTotals {
    const info = this.mailboxes.get(mailboxId);
    const mailbox = this.mailboxLabel(mailboxId);
    const distinct = new Set<string>();
    const domains = new Set<string>();
    const firstContact = new Set<string>();
    const row: MailboxTotals = {
      mailboxId,
      mailbox,
      sendProvider: info?.sendProvider ?? null,
      deleted: info?.deleted ?? false,
      sharedDomain: isSharedDomainAddress(mailbox),
      messages: 0,
      recipients: 0,
      distinctRecipients: 0,
      distinctDomains: 0,
      firstContactRecipients: 0,
      distinctFirstContact: 0,
      newThreads: 0,
      replies: 0,
      forwards: 0,
      activeDays: list.length,
      peakDayRecipients: 0,
      peakHourRecipients: 0,
    };
    for (const acc of list) {
      row.messages += acc.messages;
      row.recipients += acc.recipients;
      row.firstContactRecipients += acc.firstContactRecipients;
      row.newThreads += acc.newThreads;
      row.replies += acc.replies;
      row.forwards += acc.forwards;
      row.peakDayRecipients = Math.max(row.peakDayRecipients, acc.recipients);
      row.peakHourRecipients = Math.max(row.peakHourRecipients, ...acc.hours.values());
      for (const email of acc.distinct) distinct.add(email);
      for (const domain of acc.domains) domains.add(domain);
      for (const email of acc.distinctFirstContact) firstContact.add(email);
    }
    row.distinctRecipients = distinct.size;
    row.distinctDomains = domains.size;
    row.distinctFirstContact = firstContact.size;
    return row;
  }

  private templateStats(acc: TemplateAcc): TemplateStats {
    let peak = 0;
    for (const set of acc.firstContactByDay.values()) peak = Math.max(peak, set.size);
    return {
      fingerprint: acc.fingerprint,
      messages: acc.messages,
      distinctRecipients: acc.recipients.size,
      distinctFirstContact: acc.firstContact.size,
      peakDayFirstContact: peak,
      days: acc.days.size,
      mailboxes: [...acc.mailboxes].map((id) => this.mailboxLabel(id)).sort(),
      firstSeen: acc.firstSeen.toISOString(),
      lastSeen: acc.lastSeen.toISOString(),
      subject: acc.subject,
      snippet: acc.snippet,
      flaggedMessages: acc.flaggedMessages,
    };
  }
}
