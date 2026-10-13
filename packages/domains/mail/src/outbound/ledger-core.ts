/**
 * The outbound ledger's logic, without the Durable Object around it.
 *
 * One ledger per workspace (or personal account) counts the recipients its
 * mail reaches — per sender address and for the whole workspace, hourly
 * buckets kept 8 days — and decides each send against the policy's limits.
 * It also tracks the day's templates (fingerprints), the AI verdicts on them,
 * and Cloudflare delivery events (bounces, complaints), and turns those into
 * a risk score and automatic actions.
 *
 * Everything here is synchronous and deterministic over an injected clock and
 * a small key-value store, so it is tested without the Workers runtime.
 * `OutboundLedger` (ledger.ts) wraps it and does the I/O: policy loading,
 * review queueing, cases and alerts.
 *
 * Counts are recipients, not messages: Cloudflare counts envelopes.
 * See docs/plans/weldmail-outbound-abuse.md.
 */

import {
  OUTBOUND_THRESHOLDS,
  WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY,
  type OutboundCaseSeverity,
  type OutboundCaseTrigger,
  type OutboundDenialDetails,
  type OutboundGuardMode,
  type OutboundKind,
  type OutboundLimits,
  type OutboundSource,
  type OutboundState,
  type OutboundTrustLevel,
  type OutboundUsage,
  type OutboundVerdict,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import { isSameTemplate } from './fingerprint';
import { computeRisk, type RiskResult } from './risk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal key-value store (a Durable Object's `ctx.storage` fits). */
export interface LedgerStore {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number | boolean | void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export type LedgerSubject =
  | { kind: 'workspace'; workspaceId: string; clerkOrgId: string | null }
  | { kind: 'personal'; personalAccountId: string; plan: 'free' | 'pro' };

/** The Durable Object name for a subject. */
export function ledgerKeyFor(subject: LedgerSubject): string {
  return subject.kind === 'workspace' ? `ws:${subject.workspaceId}` : `personal:${subject.personalAccountId}`;
}

/** Everything the ledger needs to know from the master policy, resolved. */
export interface LedgerPolicy {
  mode: OutboundGuardMode;
  trustLevel: OutboundTrustLevel;
  state: OutboundState;
  stateReason: string | null;
  stateSetBy: string | null;
  /** ISO time of the last state change. */
  stateSetAt: string | null;
  allowRepliesWhenSuspended: boolean;
  limits: OutboundLimits;
}

export interface ReserveRequest {
  /** Lower-cased From address; '' for WeldSuite's own address (calendar, meet). */
  sender: string;
  source: OutboundSource;
  kind: OutboundKind;
  /** Lower-cased, de-duplicated to + cc + bcc. */
  recipients: string[];
  /** The recipients (subset) who never wrote to the workspace. */
  firstContact: string[];
  /** Absent for replies and for messages too short to fingerprint. */
  template?: { fingerprint: string; sample: string; subject: string } | null;
  contentScore: number;
  contentFlags?: { coldOutreach: boolean; bulk: boolean; phishing: boolean };
  /** The sender is on `*.weldmail.com` (shared reputation). */
  sharedDomain: boolean;
  /** The mailbox's own daily cap (`mail_accounts.dailySendLimit`); it can only lower the policy's. */
  senderDailyCap?: number | null;
  /**
   * The From address is on the shared weldmail.com domain but registered to
   * nobody. Refused like any other limit (so shadow mode only logs it); an
   * address registered to someone else never gets here, the guard refuses it.
   */
  senderUnregistered?: boolean;
}

export interface ReserveContext {
  policy: LedgerPolicy;
  /** The platform-wide budget is used up for today. */
  platformTripped: boolean;
}

export interface ReserveDecision {
  allow: boolean;
  mode: OutboundGuardMode;
  /** Pass to commit / release; null when nothing was reserved (mode `off`, or denied). */
  reservationId: string | null;
  denial?: OutboundDenialDetails;
  /** Shadow mode: what enforcement would have refused. The send goes ahead. */
  shadowDenial?: OutboundDenialDetails;
}

export interface ReviewRequest {
  fingerprint: string;
  sample: string;
  subject: string;
  reason: 'template_threshold' | 'new_workspace_sample' | 'risk_grey_zone' | 'staff';
  firstContactRecipients: number;
  recipients: number;
  sources: string[];
  domains: string[];
  trustLevel: OutboundTrustLevel;
}

export interface CommitResult {
  review?: ReviewRequest;
}

export type AutomaticAction =
  | {
      kind: 'state';
      toState: 'restricted' | 'hold';
      trigger: OutboundCaseTrigger;
      reason: string;
      severity: OutboundCaseSeverity;
      details: Record<string, number | string | boolean | null>;
      template?: TemplateSummary;
    }
  | {
      kind: 'case';
      trigger: OutboundCaseTrigger;
      severity: OutboundCaseSeverity;
      reason: string;
      details: Record<string, number | string | boolean | null>;
      template?: TemplateSummary;
    };

export interface TemplateSummary {
  fingerprint: string;
  subject: string;
  snippet: string;
  firstContactRecipients: number;
  recipients: number;
  sources: string[];
  domains: string[];
  verdict: StoredVerdict | null;
}

export type DeliveryEventType =
  | 'delivered'
  | 'deferred'
  | 'hard_bounce'
  | 'soft_bounce'
  | 'complained'
  | 'rejected'
  | 'failed';

export type StoredVerdict = OutboundVerdict & { fingerprint: string };

interface Counts {
  /** Recipients. */
  r: number;
  /** First-contact recipients. */
  fc: number;
  /** Messages that started a conversation (not replies). */
  nt: number;
  /** Reply recipients. */
  rp: number;
}

interface HourBucket {
  ws: Counts;
  senders: Record<string, Counts>;
  /** Recipients per source. */
  sources: Record<string, number>;
  sends: number;
  /** Sends whose content screen scored 3 or more. */
  flagged: number;
}

interface DeliveryBucket {
  delivered: number;
  deferred: number;
  hard: number;
  soft: number;
  complaints: number;
  rejected: number;
  failed: number;
}

interface TemplateEntry {
  fp: string;
  firstSeen: number;
  /** Short hashes of distinct recipients (capped). */
  recipients: string[];
  /** First-contact recipients today. */
  fc: number;
  sources: string[];
  domains: string[];
  subject: string;
  /** Normalised text, kept only for the case snippet and a later review. */
  sample: string;
  reviewQueuedAt?: number;
}

interface Reservation {
  id: string;
  request: ReserveRequest;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RESERVATION_TTL = 2 * 60_000;
const KEEP_HOURS = 24 * 8;
const KEEP_VERDICT_MS = 30 * DAY;
const MAX_TEMPLATE_RECIPIENTS = 500;
const MAX_TEMPLATE_DOMAINS = 10;
const STAFF_COOLDOWN_MS = 7 * DAY;
const AUTOMATED_SOURCES = new Set<string>(['api', 'crm_sequence', 'workflow']);
const STATE_ORDER: Record<OutboundState, number> = { active: 0, restricted: 1, hold: 2, suspended: 3 };

const emptyCounts = (): Counts => ({ r: 0, fc: 0, nt: 0, rp: 0 });
const emptyBucket = (): HourBucket => ({ ws: emptyCounts(), senders: {}, sources: {}, sends: 0, flagged: 0 });
const emptyDeliveries = (): DeliveryBucket => ({
  delivered: 0,
  deferred: 0,
  hard: 0,
  soft: 0,
  complaints: 0,
  rejected: 0,
  failed: 0,
});

function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextMonthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isColdVerdict(v: StoredVerdict | null | undefined): boolean {
  return (
    !!v &&
    (v.category === 'cold_outreach' || v.category === 'marketing_bulk') &&
    v.confidence >= OUTBOUND_THRESHOLDS.coldOutreachConfidence
  );
}

function isPhishingVerdict(v: StoredVerdict | null | undefined): boolean {
  return !!v && v.category === 'phishing_or_scam' && v.confidence >= OUTBOUND_THRESHOLDS.phishingConfidence;
}

let reservationCounter = 0;

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export class LedgerCore {
  private hours = new Map<number, HourBucket>();
  private deliveries = new Map<number, DeliveryBucket>();
  private templates = new Map<number, TemplateEntry[]>();
  private verdicts = new Map<string, StoredVerdict>();
  private months = new Map<string, number>();
  private reviewSamples = new Map<number, number>();
  private shadow = new Map<number, Record<string, number>>();
  private reservations = new Map<string, Reservation>();
  private dirty = new Set<string>();

  constructor(
    private readonly store: LedgerStore,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Read the persisted state into memory. Call once before anything else. */
  async load(): Promise<void> {
    const [hours, deliveries, templates, verdicts, months, samples, shadow] = await Promise.all([
      this.store.list<HourBucket>({ prefix: 'h:' }),
      this.store.list<DeliveryBucket>({ prefix: 'd:' }),
      this.store.list<TemplateEntry[]>({ prefix: 't:' }),
      this.store.list<StoredVerdict>({ prefix: 'v:' }),
      this.store.list<number>({ prefix: 'm:' }),
      this.store.list<number>({ prefix: 'rs:' }),
      this.store.list<Record<string, number>>({ prefix: 'sh:' }),
    ]);
    for (const [k, v] of hours) this.hours.set(Number(k.slice(2)), v);
    for (const [k, v] of deliveries) this.deliveries.set(Number(k.slice(2)), v);
    for (const [k, v] of templates) this.templates.set(Number(k.slice(2)), v);
    for (const [k, v] of verdicts) this.verdicts.set(k.slice(2), v);
    for (const [k, v] of months) this.months.set(k.slice(2), v);
    for (const [k, v] of samples) this.reviewSamples.set(Number(k.slice(3)), v);
    for (const [k, v] of shadow) this.shadow.set(Number(k.slice(3)), v);
  }

  /** Persist everything changed since the last flush. */
  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;
    const entries: Record<string, unknown> = {};
    for (const key of this.dirty) {
      const [prefix, raw] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const value =
        prefix === 'h'
          ? this.hours.get(Number(raw))
          : prefix === 'd'
            ? this.deliveries.get(Number(raw))
            : prefix === 't'
              ? this.templates.get(Number(raw))
              : prefix === 'v'
                ? this.verdicts.get(raw)
                : prefix === 'm'
                  ? this.months.get(raw)
                  : prefix === 'rs'
                    ? this.reviewSamples.get(Number(raw))
                    : this.shadow.get(Number(raw));
      if (value !== undefined) entries[key] = value;
    }
    this.dirty.clear();
    await this.store.put(entries);
  }

  private get hour(): number {
    return Math.floor(this.clock() / HOUR);
  }

  private get day(): number {
    return Math.floor(this.clock() / DAY);
  }

  // -------------------------------------------------------------------------
  // Windows
  // -------------------------------------------------------------------------

  private liveReservations(): Reservation[] {
    const now = this.clock();
    const live: Reservation[] = [];
    for (const [id, res] of this.reservations) {
      if (res.expiresAt <= now) this.reservations.delete(id);
      else live.push(res);
    }
    return live;
  }

  /** Sum a metric over the last `hours` buckets (current one included). */
  private sum(hours: number, pick: (b: HourBucket) => number): number {
    let total = 0;
    for (let h = this.hour - hours + 1; h <= this.hour; h++) {
      const bucket = this.hours.get(h);
      if (bucket) total += pick(bucket);
    }
    return total;
  }

  /** When the oldest bucket that counts towards a 24-hour window drops out. */
  private dayWindowRetry(pick: (b: HourBucket) => number): string {
    for (let h = this.hour - 23; h <= this.hour; h++) {
      const bucket = this.hours.get(h);
      if (bucket && pick(bucket) > 0) return iso((h + 24) * HOUR);
    }
    return iso((this.hour + 1) * HOUR);
  }

  private senderCounts(bucket: HourBucket, sender: string): Counts {
    return bucket.senders[sender] ?? emptyCounts();
  }

  private pending(pick: (r: ReserveRequest) => number): number {
    return this.liveReservations().reduce((total, res) => total + pick(res.request), 0);
  }

  private templateEntry(fingerprint: string, day = this.day): TemplateEntry | undefined {
    return (this.templates.get(day) ?? []).find((entry) => isSameTemplate(entry.fp, fingerprint));
  }

  private verdictFor(fingerprint: string): StoredVerdict | null {
    const exact = this.verdicts.get(fingerprint);
    if (exact) return exact;
    for (const verdict of this.verdicts.values()) {
      if (isSameTemplate(verdict.fingerprint, fingerprint)) return verdict;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Reserve / commit / release
  // -------------------------------------------------------------------------

  reserve(ctx: ReserveContext, req: ReserveRequest): ReserveDecision {
    const { policy } = ctx;
    if (policy.mode === 'off') return { allow: true, mode: 'off', reservationId: null };

    const denial = this.decide(ctx, req);
    if (denial && policy.mode === 'enforce') {
      return { allow: false, mode: 'enforce', reservationId: null, denial };
    }
    if (denial) {
      const counts = this.shadow.get(this.day) ?? {};
      counts[denial.code] = (counts[denial.code] ?? 0) + 1;
      this.shadow.set(this.day, counts);
      this.dirty.add(`sh:${this.day}`);
    }

    const id = `r${this.clock().toString(36)}${(reservationCounter++).toString(36)}`;
    this.reservations.set(id, { id, request: req, expiresAt: this.clock() + RESERVATION_TTL });
    return { allow: true, mode: policy.mode, reservationId: id, ...(denial ? { shadowDenial: denial } : {}) };
  }

  /** The first limit this send would break, or null. */
  private decide(ctx: ReserveContext, req: ReserveRequest): OutboundDenialDetails | null {
    const { policy } = ctx;
    const limits = policy.limits;
    const n = req.recipients.length;
    const fc = req.firstContact.length;
    const isReply = req.kind === 'reply';
    // Calendar and WeldMeet invitations come from WeldSuite's own address, one
    // message per attendee: no per-message or per-sender window applies, only
    // the workspace's day, month and first-contact windows.
    const systemSend = req.sender === '';

    if (policy.state === 'suspended' && !(isReply && policy.allowRepliesWhenSuspended)) {
      return { code: 'SENDING_SUSPENDED', reason: 'staff_suspension' };
    }
    if (req.senderUnregistered) {
      return { code: 'SENDER_NOT_OWNED', reason: 'unregistered_shared_address' };
    }
    if (!systemSend && n > limits.recipientsPerMessage) {
      return { code: 'TOO_MANY_RECIPIENTS', window: 'message', limit: limits.recipientsPerMessage, used: n };
    }
    if (policy.state === 'hold' && !isReply) {
      return { code: 'SENDING_ON_HOLD', reason: 'under_review' };
    }
    if (systemSend) return this.decideWorkspaceWindows(ctx, req);

    const sender = req.sender;
    const senderRepliesDay =
      this.sum(24, (b) => this.senderCounts(b, sender).rp) +
      this.pending((r) => (r.sender === sender && r.kind === 'reply' ? r.recipients.length : 0));
    // Answering someone who wrote in keeps working up to the reply floor,
    // whatever the volume windows say (suspension and hold are handled above).
    if (isReply && senderRepliesDay + n <= limits.repliesPerSenderPerDay) return null;

    const pendingSender = this.pending((r) => (r.sender === sender ? r.recipients.length : 0));
    const senderHour = this.senderCounts(this.hours.get(this.hour) ?? emptyBucket(), sender).r + pendingSender;
    if (senderHour + n > limits.senderPerHour) {
      return {
        code: 'SENDING_LIMITED',
        window: 'hour',
        limit: limits.senderPerHour,
        used: senderHour,
        retryAfter: iso((this.hour + 1) * HOUR),
        reason: 'sender_hour',
      };
    }

    const senderPerDay =
      req.senderDailyCap != null && req.senderDailyCap > 0
        ? Math.min(limits.senderPerDay, req.senderDailyCap)
        : limits.senderPerDay;
    const senderDay = this.sum(24, (b) => this.senderCounts(b, sender).r) + pendingSender;
    if (senderDay + n > senderPerDay) {
      return {
        code: 'SENDING_LIMITED',
        window: 'day',
        limit: senderPerDay,
        used: senderDay,
        retryAfter: this.dayWindowRetry((b) => this.senderCounts(b, sender).r),
        reason: 'sender_day',
      };
    }

    if (fc > 0 && req.sharedDomain) {
      const senderFc =
        this.sum(24, (b) => this.senderCounts(b, sender).fc) +
        this.pending((r) => (r.sender === sender ? r.firstContact.length : 0));
      if (senderFc + fc > WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY) {
        return {
          code: 'FIRST_CONTACT_LIMITED',
          window: 'day',
          limit: WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY,
          used: senderFc,
          retryAfter: this.dayWindowRetry((b) => this.senderCounts(b, sender).fc),
          reason: 'weldmail_shared_domain',
          suggestWeldReach: true,
        };
      }
    }

    return this.decideWorkspaceWindows(ctx, req);
  }

  /** The workspace-wide windows: day, month, first contact, cold-outreach templates, platform budget. */
  private decideWorkspaceWindows(ctx: ReserveContext, req: ReserveRequest): OutboundDenialDetails | null {
    const { policy } = ctx;
    const limits = policy.limits;
    const n = req.recipients.length;
    const fc = req.firstContact.length;

    const pendingAll = this.pending((r) => r.recipients.length);
    const wsDay = this.sum(24, (b) => b.ws.r) + pendingAll;
    if (wsDay + n > limits.workspacePerDay) {
      return {
        code: 'SENDING_LIMITED',
        window: 'day',
        limit: limits.workspacePerDay,
        used: wsDay,
        retryAfter: this.dayWindowRetry((b) => b.ws.r),
        reason: 'workspace_day',
      };
    }

    if (limits.monthlyRecipients !== null) {
      const month = (this.months.get(monthKey(this.clock())) ?? 0) + pendingAll;
      if (month + n > limits.monthlyRecipients) {
        return {
          code: 'SENDING_LIMITED',
          window: 'month',
          limit: limits.monthlyRecipients,
          used: month,
          retryAfter: iso(nextMonthStart(this.clock())),
          reason: 'workspace_month',
        };
      }
    }

    if (fc === 0) return null;

    const wsFc = this.sum(24, (b) => b.ws.fc) + this.pending((r) => r.firstContact.length);
    if (wsFc + fc > limits.firstContactPerDay) {
      return {
        code: 'FIRST_CONTACT_LIMITED',
        window: 'day',
        limit: limits.firstContactPerDay,
        used: wsFc,
        ...(limits.firstContactPerDay > 0
          ? { retryAfter: this.dayWindowRetry((b) => b.ws.fc) }
          : {}),
        reason: 'workspace_first_contact',
        suggestWeldReach: true,
      };
    }

    if (req.template) {
      const verdict = this.verdictFor(req.template.fingerprint);
      if (isColdVerdict(verdict)) {
        const entry = this.templateEntry(req.template.fingerprint);
        const used =
          (entry?.fc ?? 0) +
          this.pending((r) =>
            r.template && isSameTemplate(r.template.fingerprint, req.template!.fingerprint) ? r.firstContact.length : 0,
          );
        const cap = OUTBOUND_THRESHOLDS.coldTemplateFirstContactPerDay;
        if (used + fc > cap) {
          return {
            code: 'FIRST_CONTACT_LIMITED',
            window: 'day',
            limit: cap,
            used,
            retryAfter: iso((this.day + 1) * DAY),
            reason: 'cold_outreach_template',
            suggestWeldReach: true,
          };
        }
      }
    }

    if (ctx.platformTripped && policy.trustLevel !== 'trusted') {
      return { code: 'PLATFORM_LIMITED', window: 'day', retryAfter: iso((this.day + 1) * DAY) };
    }
    return null;
  }

  release(reservationId: string): void {
    this.reservations.delete(reservationId);
  }

  /**
   * Count a send that went out. `sentRecipients` narrows it when only some
   * recipients were reached (a partial send); by default all of them were.
   */
  commit(policy: LedgerPolicy, reservationId: string, sentRecipients?: string[]): CommitResult {
    const res = this.reservations.get(reservationId);
    if (!res) return {};
    this.reservations.delete(reservationId);
    const req = res.request;
    const sentSet = sentRecipients ? new Set(sentRecipients.map((r) => r.toLowerCase())) : null;
    const sent = sentSet ? req.recipients.filter((r) => sentSet.has(r)) : req.recipients;
    if (sent.length === 0) return {};
    const fcSent = req.firstContact.filter((r) => !sentSet || sentSet.has(r));
    const n = sent.length;
    const fc = fcSent.length;
    const isReply = req.kind === 'reply';

    const bucket = this.hours.get(this.hour) ?? emptyBucket();
    const add = (counts: Counts) => {
      counts.r += n;
      counts.fc += fc;
      counts.nt += isReply ? 0 : 1;
      counts.rp += isReply ? n : 0;
    };
    add(bucket.ws);
    const senderCounts = bucket.senders[req.sender] ?? emptyCounts();
    add(senderCounts);
    bucket.senders[req.sender] = senderCounts;
    bucket.sources[req.source] = (bucket.sources[req.source] ?? 0) + n;
    bucket.sends += 1;
    if (req.contentScore >= 3) bucket.flagged += 1;
    this.hours.set(this.hour, bucket);
    this.dirty.add(`h:${this.hour}`);

    const mk = monthKey(this.clock());
    this.months.set(mk, (this.months.get(mk) ?? 0) + n);
    this.dirty.add(`m:${mk}`);

    if (!req.template || isReply) return {};
    const entries = this.templates.get(this.day) ?? [];
    let entry = entries.find((e) => isSameTemplate(e.fp, req.template!.fingerprint));
    if (!entry) {
      entry = {
        fp: req.template.fingerprint,
        firstSeen: this.clock(),
        recipients: [],
        fc: 0,
        sources: [],
        domains: [],
        subject: req.template.subject.slice(0, 200),
        sample: req.template.sample,
      };
      entries.push(entry);
    }
    const known = new Set(entry.recipients);
    for (const r of sent) {
      if (entry.recipients.length >= MAX_TEMPLATE_RECIPIENTS) break;
      const h = shortHash(r);
      if (!known.has(h)) {
        known.add(h);
        entry.recipients.push(h);
      }
    }
    entry.fc += fc;
    if (!entry.sources.includes(req.source)) entry.sources.push(req.source);
    for (const r of fcSent) {
      const d = domainOf(r);
      if (entry.domains.length < MAX_TEMPLATE_DOMAINS && !entry.domains.includes(d)) entry.domains.push(d);
    }
    this.templates.set(this.day, entries);
    this.dirty.add(`t:${this.day}`);

    if (entry.reviewQueuedAt || this.verdictFor(entry.fp)) return {};
    let reason: ReviewRequest['reason'] | null = null;
    if (entry.fc >= OUTBOUND_THRESHOLDS.reviewFirstContactRecipients) {
      reason = 'template_threshold';
    } else if (policy.trustLevel === 'new' && fc > 0) {
      const samples = this.reviewSamples.get(this.day) ?? 0;
      if (samples < OUTBOUND_THRESHOLDS.newWorkspaceReviewSamplesPerDay) {
        this.reviewSamples.set(this.day, samples + 1);
        this.dirty.add(`rs:${this.day}`);
        reason = 'new_workspace_sample';
      }
    }
    if (!reason) return {};
    entry.reviewQueuedAt = this.clock();
    return { review: this.reviewFor(entry, reason, policy.trustLevel) };
  }

  private reviewFor(entry: TemplateEntry, reason: ReviewRequest['reason'], trustLevel: OutboundTrustLevel): ReviewRequest {
    return {
      fingerprint: entry.fp,
      sample: entry.sample,
      subject: entry.subject,
      reason,
      firstContactRecipients: entry.fc,
      recipients: entry.recipients.length,
      sources: [...entry.sources],
      domains: [...entry.domains],
      trustLevel,
    };
  }

  /** A staff-requested review of today's biggest template, if any. */
  reviewTopTemplate(policy: LedgerPolicy): ReviewRequest | null {
    const top = this.topTemplate();
    if (!top) return null;
    top.reviewQueuedAt = this.clock();
    this.dirty.add(`t:${this.day}`);
    return this.reviewFor(top, 'staff', policy.trustLevel);
  }

  private topTemplate(): TemplateEntry | null {
    const entries = this.templates.get(this.day) ?? [];
    return entries.reduce<TemplateEntry | null>((top, e) => (!top || e.fc > top.fc ? e : top), null);
  }

  // -------------------------------------------------------------------------
  // Delivery events and verdicts
  // -------------------------------------------------------------------------

  recordDelivery(type: DeliveryEventType, atMs = this.clock()): void {
    const hour = Math.floor(atMs / HOUR);
    const bucket = this.deliveries.get(hour) ?? emptyDeliveries();
    switch (type) {
      case 'delivered':
        bucket.delivered++;
        break;
      case 'deferred':
        bucket.deferred++;
        break;
      case 'hard_bounce':
        bucket.hard++;
        break;
      case 'soft_bounce':
        bucket.soft++;
        break;
      case 'complained':
        bucket.complaints++;
        break;
      case 'rejected':
        bucket.rejected++;
        break;
      case 'failed':
        bucket.failed++;
        break;
    }
    this.deliveries.set(hour, bucket);
    this.dirty.add(`d:${hour}`);
  }

  /**
   * Store an AI verdict and return what it calls for. A review staff asked for
   * always leaves a case, harmless verdicts included, so the answer is visible.
   */
  recordVerdict(verdict: StoredVerdict, opts: { staffRequested?: boolean } = {}): AutomaticAction[] {
    this.verdicts.set(verdict.fingerprint, verdict);
    this.dirty.add(`v:${verdict.fingerprint}`);
    const entry = this.templateEntry(verdict.fingerprint);
    const template = entry ? this.summarize(entry) : undefined;
    const actions = this.verdictActions(verdict, entry, template);
    if (opts.staffRequested && actions.length === 0) {
      actions.push({
        kind: 'case',
        trigger: 'staff_review',
        severity: 'info',
        reason: `Requested review: ${verdict.category.replace(/_/g, ' ')} (${verdict.confidence.toFixed(2)}).`,
        details: { confidence: verdict.confidence },
        template,
      });
    }
    return actions;
  }

  private verdictActions(
    verdict: StoredVerdict,
    entry: TemplateEntry | undefined,
    template: TemplateSummary | undefined,
  ): AutomaticAction[] {
    if (isPhishingVerdict(verdict)) {
      return [
        {
          kind: 'state',
          toState: 'hold',
          trigger: 'phishing',
          severity: 'urgent',
          reason: 'A template was classified as phishing or a scam.',
          details: { confidence: verdict.confidence },
          template,
        },
      ];
    }
    if (isColdVerdict(verdict)) {
      return [
        {
          kind: 'case',
          trigger: 'cold_outreach_template',
          severity: 'warning',
          reason: `A template was classified as ${verdict.category.replace('_', ' ')}.`,
          details: {
            confidence: verdict.confidence,
            firstContactRecipients: entry?.fc ?? 0,
            capPerDay: OUTBOUND_THRESHOLDS.coldTemplateFirstContactPerDay,
          },
          template,
        },
      ];
    }
    return [];
  }

  private summarize(entry: TemplateEntry): TemplateSummary {
    return {
      fingerprint: entry.fp,
      subject: entry.subject,
      snippet: entry.sample.slice(0, 300),
      firstContactRecipients: entry.fc,
      recipients: entry.recipients.length,
      sources: [...entry.sources],
      domains: [...entry.domains],
      verdict: this.verdictFor(entry.fp),
    };
  }

  // -------------------------------------------------------------------------
  // Risk and automatic actions (run by the alarm)
  // -------------------------------------------------------------------------

  private deliveries7d(): DeliveryBucket {
    const total = emptyDeliveries();
    for (let h = this.hour - 24 * 7 + 1; h <= this.hour; h++) {
      const b = this.deliveries.get(h);
      if (!b) continue;
      total.delivered += b.delivered;
      total.deferred += b.deferred;
      total.hard += b.hard;
      total.soft += b.soft;
      total.complaints += b.complaints;
      total.rejected += b.rejected;
      total.failed += b.failed;
    }
    return total;
  }

  risk(policy: LedgerPolicy): RiskResult {
    const entries = this.templates.get(this.day) ?? [];
    const deliveries = this.deliveries7d();
    return computeRisk({
      trustLevel: policy.trustLevel,
      recipientsDay: this.sum(24, (b) => b.ws.r),
      firstContactDay: this.sum(24, (b) => b.ws.fc),
      automatedDay: this.sum(24, (b) =>
        Object.entries(b.sources).reduce((t, [s, v]) => t + (AUTOMATED_SOURCES.has(s) ? v : 0), 0),
      ),
      flaggedSendsDay: this.sum(24, (b) => b.flagged),
      sendsDay: this.sum(24, (b) => b.sends),
      topTemplateFirstContact: entries.reduce((max, e) => Math.max(max, e.fc), 0),
      recipients7d: this.sum(24 * 7, (b) => b.ws.r),
      hardBounces7d: deliveries.hard,
      complaints7d: deliveries.complaints,
      coldTemplates: entries.filter((e) => isColdVerdict(this.verdictFor(e.fp))).length,
      phishingVerdict: entries.some((e) => isPhishingVerdict(this.verdictFor(e.fp))),
    });
  }

  /**
   * Risk score plus the actions it calls for. Actions only tighten, and a state
   * staff set in the last 7 days is left alone (except for phishing), so a
   * lifted restriction doesn't snap back on the same signals.
   */
  evaluate(policy: LedgerPolicy): { risk: RiskResult; actions: AutomaticAction[]; review: ReviewRequest | null } {
    const risk = this.risk(policy);
    const actions: AutomaticAction[] = [];
    const deliveries = this.deliveries7d();
    const recipients7d = this.sum(24 * 7, (b) => b.ws.r);
    const details = {
      riskScore: risk.score,
      hardBounces7d: deliveries.hard,
      complaints7d: deliveries.complaints,
      recipients7d,
      recipientsDay: this.sum(24, (b) => b.ws.r),
      firstContactDay: this.sum(24, (b) => b.ws.fc),
    };

    const staffRecently =
      policy.stateSetBy !== null &&
      policy.stateSetBy !== 'system' &&
      policy.stateSetAt !== null &&
      this.clock() - Date.parse(policy.stateSetAt) < STAFF_COOLDOWN_MS;
    const canTighten = (to: OutboundState, trigger: OutboundCaseTrigger) =>
      STATE_ORDER[to] > STATE_ORDER[policy.state] && (!staffRecently || trigger === 'phishing');

    const entries = this.templates.get(this.day) ?? [];
    const phishing = entries.find((e) => isPhishingVerdict(this.verdictFor(e.fp)));
    if (phishing && canTighten('hold', 'phishing')) {
      actions.push({
        kind: 'state',
        toState: 'hold',
        trigger: 'phishing',
        severity: 'urgent',
        reason: 'A template was classified as phishing or a scam.',
        details,
        template: this.summarize(phishing),
      });
    }

    if (risk.hardBounceRate7d !== null && risk.hardBounceRate7d > OUTBOUND_THRESHOLDS.hardBounceRate) {
      const reason = `Hard bounces at ${(risk.hardBounceRate7d * 100).toFixed(1)}% over 7 days.`;
      actions.push(
        canTighten('restricted', 'bounce_rate')
          ? { kind: 'state', toState: 'restricted', trigger: 'bounce_rate', severity: 'warning', reason, details }
          : { kind: 'case', trigger: 'bounce_rate', severity: 'warning', reason, details },
      );
    }

    const complaintRate = recipients7d > 0 ? deliveries.complaints / recipients7d : 0;
    if (deliveries.complaints >= OUTBOUND_THRESHOLDS.complaints7d || (deliveries.complaints > 0 && complaintRate > OUTBOUND_THRESHOLDS.complaintRate)) {
      const reason = `${deliveries.complaints} spam complaint(s) in 7 days.`;
      actions.push(
        canTighten('restricted', 'complaints')
          ? { kind: 'state', toState: 'restricted', trigger: 'complaints', severity: 'warning', reason, details }
          : { kind: 'case', trigger: 'complaints', severity: 'warning', reason, details },
      );
    }

    const top = this.topTemplate();
    if (risk.score >= OUTBOUND_THRESHOLDS.riskHold && canTighten('hold', 'risk_score')) {
      actions.push({
        kind: 'state',
        toState: 'hold',
        trigger: 'risk_score',
        severity: 'urgent',
        reason: `Risk score ${risk.score}: ${risk.reasons.join(', ')}.`,
        details,
        template: top ? this.summarize(top) : undefined,
      });
    } else if (risk.score >= OUTBOUND_THRESHOLDS.riskRestricted && canTighten('restricted', 'risk_score')) {
      actions.push({
        kind: 'state',
        toState: 'restricted',
        trigger: 'risk_score',
        severity: 'warning',
        reason: `Risk score ${risk.score}: ${risk.reasons.join(', ')}.`,
        details,
        template: top ? this.summarize(top) : undefined,
      });
    }

    let review: ReviewRequest | null = null;
    if (
      risk.score >= OUTBOUND_THRESHOLDS.riskReviewMin &&
      top &&
      !top.reviewQueuedAt &&
      !this.verdictFor(top.fp)
    ) {
      top.reviewQueuedAt = this.clock();
      this.dirty.add(`t:${this.day}`);
      review = this.reviewFor(top, 'risk_grey_zone', policy.trustLevel);
    }

    return { risk, actions, review };
  }

  /** Anything sent or delivered in the last 48 hours (keeps the alarm running). */
  hasRecentActivity(): boolean {
    for (let h = this.hour - 47; h <= this.hour; h++) {
      if (this.hours.has(h) || this.deliveries.has(h)) return true;
    }
    return false;
  }

  /** Recipients since UTC midnight, and the UTC day number, for the platform budget. */
  recipientsToday(): { day: number; recipients: number } {
    let total = 0;
    for (let h = this.day * 24; h <= this.hour; h++) total += this.hours.get(h)?.ws.r ?? 0;
    return { day: this.day, recipients: total };
  }

  /** Drop buckets and verdicts past their retention. Returns the deleted keys. */
  prune(): string[] {
    const deleted: string[] = [];
    const oldestHour = this.hour - KEEP_HOURS;
    for (const h of [...this.hours.keys()]) {
      if (h < oldestHour) {
        this.hours.delete(h);
        deleted.push(`h:${h}`);
      }
    }
    for (const h of [...this.deliveries.keys()]) {
      if (h < oldestHour) {
        this.deliveries.delete(h);
        deleted.push(`d:${h}`);
      }
    }
    for (const d of [...this.templates.keys()]) {
      if (d < this.day - 1) {
        this.templates.delete(d);
        deleted.push(`t:${d}`);
      }
    }
    for (const map of [this.reviewSamples, this.shadow]) {
      for (const d of [...map.keys()]) {
        if (d < this.day - 8) {
          map.delete(d);
          deleted.push(`${map === this.shadow ? 'sh' : 'rs'}:${d}`);
        }
      }
    }
    for (const [fp, verdict] of [...this.verdicts]) {
      if (this.clock() - Date.parse(verdict.reviewedAt) > KEEP_VERDICT_MS) {
        this.verdicts.delete(fp);
        deleted.push(`v:${fp}`);
      }
    }
    const keepMonths = new Set([monthKey(this.clock()), monthKey(this.clock() - 31 * DAY)]);
    for (const mk of [...this.months.keys()]) {
      if (!keepMonths.has(mk)) {
        this.months.delete(mk);
        deleted.push(`m:${mk}`);
      }
    }
    return deleted;
  }

  // -------------------------------------------------------------------------
  // Customer view
  // -------------------------------------------------------------------------

  usage(policy: LedgerPolicy): OutboundUsage {
    const limits = policy.limits;
    const senders = new Set<string>();
    for (let h = this.hour - 23; h <= this.hour; h++) {
      for (const s of Object.keys(this.hours.get(h)?.senders ?? {})) if (s) senders.add(s);
    }
    const current = this.hours.get(this.hour) ?? emptyBucket();
    const deliveries = this.deliveries7d();
    const entries = this.templates.get(this.day) ?? [];
    return {
      mode: policy.mode,
      trustLevel: policy.trustLevel,
      state: policy.state,
      stateReason: policy.stateReason,
      limits,
      workspace: {
        hour: current.ws.r,
        day: { used: this.sum(24, (b) => b.ws.r), limit: limits.workspacePerDay },
        firstContactDay: { used: this.sum(24, (b) => b.ws.fc), limit: limits.firstContactPerDay },
        month: { used: this.months.get(monthKey(this.clock())) ?? 0, limit: limits.monthlyRecipients },
      },
      senders: [...senders].sort().map((email) => ({
        email,
        hour: { used: this.senderCounts(current, email).r, limit: limits.senderPerHour },
        day: { used: this.sum(24, (b) => this.senderCounts(b, email).r), limit: limits.senderPerDay },
      })),
      deliveries7d: {
        delivered: deliveries.delivered,
        hardBounces: deliveries.hard,
        softBounces: deliveries.soft,
        complaints: deliveries.complaints,
        rejected: deliveries.rejected,
      },
      coldOutreachCapped: entries.some(
        (e) =>
          isColdVerdict(this.verdictFor(e.fp)) && e.fc >= OUTBOUND_THRESHOLDS.coldTemplateFirstContactPerDay,
      ),
    };
  }

  /** Shadow-mode would-be denials per code, last 7 days (staff view). */
  shadowCounts(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (let d = this.day - 6; d <= this.day; d++) {
      for (const [code, count] of Object.entries(this.shadow.get(d) ?? {})) totals[code] = (totals[code] ?? 0) + count;
    }
    return totals;
  }
}
