/**
 * Mailbox warmup: starting it at Mailpool, tracking its progress, and the
 * daily per-workspace pass that moves mailboxes along
 * (`provisioning` -> `warming` -> `active`, ramping the daily cap, and pausing
 * mailboxes whose WeldHost domain lapsed).
 *
 * Mailpool does the warming itself (its warmup network sends and answers
 * mail); WeldReach only starts it and reads its counters. A mailbox may join
 * campaigns after `warmupDays` days of actual warmup sending AND a healthy
 * report. The warmup inbox id is not stored in `reach_mailboxes`, so it is
 * looked up by mailbox id when needed.
 *
 * `processWorkspaceWarmup` is called from `cron/warmup-sweep.ts` for one
 * workspace at a time (due-index kind `reach_warmup`) and returns when the
 * workspace next needs a visit.
 */

import { and, inArray, isNull, eq } from 'drizzle-orm';
import { omitSensitive } from '@weldsuite/db/lib/sensitive-columns';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { WELDREACH_SENDING_DEFAULTS } from '@weldsuite/app-api-client/schemas/reach';
import { sealMailServerCredentials } from '../lib/credentials';
import type { MailpoolClient } from '../lib/mailpool/client';
import { MailpoolError } from '../lib/mailpool/errors';
import { smtpCredentialsOf, imapCredentialsOf } from '../lib/mailpool';
import type { MailpoolMailbox, MailpoolWarmupDetail, MailpoolWarmupInbox } from '../lib/mailpool/types';
import { utcDayStart, utcTomorrow } from './access';

type MailboxRow = typeof schema.reachMailboxes.$inferSelect;

// ---------------------------------------------------------------------------
// Warmup health (from Mailpool's per-day counters)
// ---------------------------------------------------------------------------

/** Days the warmup network looks back at when judging health. */
export const WARMUP_HEALTH_WINDOW_DAYS = 7;
/** Below this many warmup mails in the window the ratios are noise. */
export const WARMUP_MIN_SAMPLE = 10;
export const WARMUP_MAX_SPAM_RATE = 0.2;
export const WARMUP_MAX_BOUNCE_RATE = 0.1;

/** Days on which Mailpool actually sent warmup mail (a paused warmup does not advance). */
export function countWarmupDays(detail: Pick<MailpoolWarmupDetail, 'counters'>): number {
  return Object.values(detail.counters ?? {}).filter((day) => (day?.sent ?? 0) > 0).length;
}

/** Started, and over the last week not too much of it landed in spam or bounced. */
export function isWarmupHealthy(detail: Pick<MailpoolWarmupDetail, 'status' | 'counters'>): boolean {
  if (detail.status !== 'Started') return false;

  const recent = Object.entries(detail.counters ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-WARMUP_HEALTH_WINDOW_DAYS)
    .map(([, day]) => day);
  const sent = recent.reduce((sum, day) => sum + (day?.sent ?? 0), 0);
  if (sent < WARMUP_MIN_SAMPLE) return true;

  const spam = recent.reduce((sum, day) => sum + (day?.landed_in_spam ?? 0), 0);
  const bounced = recent.reduce((sum, day) => sum + (day?.bounced ?? 0) + (day?.lost ?? 0), 0);
  return spam / sent <= WARMUP_MAX_SPAM_RATE && bounced / sent <= WARMUP_MAX_BOUNCE_RATE;
}

/** Where a paused mailbox goes on resume: straight to `active` once its warmup is done. */
export function resumeStatusFor(mailbox: Pick<MailboxRow, 'warmupDay'>): 'active' | 'warming' {
  return mailbox.warmupDay >= WELDREACH_SENDING_DEFAULTS.warmupDays ? 'active' : 'warming';
}

// ---------------------------------------------------------------------------
// Finding and starting a mailbox's warmup at Mailpool
// ---------------------------------------------------------------------------

export interface WarmupLookup {
  find(mailpoolMailboxId: number, email: string): Promise<MailpoolWarmupInbox | null>;
}

/** One search per lookup: for request paths that touch a single mailbox. */
export function searchWarmupLookup(mailpool: MailpoolClient): WarmupLookup {
  return {
    async find(mailpoolMailboxId, email) {
      const { data } = await mailpool.listWarmup({ search: email, limit: 20, offset: 0 });
      return data.find((inbox) => inbox.mailboxId === mailpoolMailboxId) ?? null;
    },
  };
}

const WARMUP_PAGE_SIZE = 100;
const WARMUP_MAX_PAGES = 200;

/** Loads the account's whole warmup list once and answers from memory: for the sweep, which visits many mailboxes. */
export function cachedWarmupLookup(mailpool: MailpoolClient): WarmupLookup {
  let loaded: Promise<Map<number, MailpoolWarmupInbox>> | null = null;

  async function load(): Promise<Map<number, MailpoolWarmupInbox>> {
    const byMailbox = new Map<number, MailpoolWarmupInbox>();
    for (let page = 0; page < WARMUP_MAX_PAGES; page++) {
      const { data, total } = await mailpool.listWarmup({ limit: WARMUP_PAGE_SIZE, offset: page * WARMUP_PAGE_SIZE });
      for (const inbox of data) byMailbox.set(inbox.mailboxId, inbox);
      if (data.length < WARMUP_PAGE_SIZE || byMailbox.size >= total) break;
    }
    return byMailbox;
  }

  return {
    async find(mailpoolMailboxId) {
      // A failed load is not cached: the next mailbox tries again.
      loaded ??= load().catch((err: unknown) => {
        loaded = null;
        throw err;
      });
      return (await loaded).get(mailpoolMailboxId) ?? null;
    },
  };
}

function toMailpoolMailboxNumber(mailpoolMailboxId: string): number {
  const id = Number(mailpoolMailboxId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Mailpool mailbox id "${mailpoolMailboxId}" is not numeric`);
  return id;
}

/**
 * Make sure the mailbox is in Mailpool's warmup and running. Adding is
 * idempotent at Mailpool (a mailbox already in warmup is returned as-is).
 * Returns null when Mailpool skipped it (mailbox not active there yet).
 */
export async function ensureWarmupRunning(
  mailpool: MailpoolClient,
  mailbox: Pick<MailboxRow, 'mailpoolMailboxId' | 'email'>,
  lookup: WarmupLookup = searchWarmupLookup(mailpool),
): Promise<MailpoolWarmupInbox | null> {
  if (!mailbox.mailpoolMailboxId) return null;
  const mailpoolId = toMailpoolMailboxNumber(mailbox.mailpoolMailboxId);

  let inbox = await lookup.find(mailpoolId, mailbox.email);
  if (!inbox) {
    const added = await mailpool.addToWarmup([mailpoolId]);
    inbox = added.find((candidate) => candidate.mailboxId === mailpoolId) ?? null;
  }
  if (!inbox) return null;

  // Pending connects by itself; Paused and Stopped need a nudge.
  if (inbox.status === 'Paused' || inbox.status === 'Stopped') {
    inbox = (await mailpool.startWarmup(inbox.id)) ?? inbox;
  }
  return inbox;
}

/** Take a mailbox out of Mailpool's warmup before deleting it. Best effort. */
export async function removeFromWarmup(
  mailpool: MailpoolClient,
  mailbox: Pick<MailboxRow, 'mailpoolMailboxId' | 'email'>,
): Promise<void> {
  try {
    if (!mailbox.mailpoolMailboxId) return;
    const inbox = await searchWarmupLookup(mailpool).find(toMailpoolMailboxNumber(mailbox.mailpoolMailboxId), mailbox.email);
    if (inbox) await mailpool.removeFromWarmup(inbox.id);
  } catch (err) {
    console.warn(`[reach-warmup] could not remove ${mailbox.email} from warmup:`, err);
  }
}

// ---------------------------------------------------------------------------
// The per-workspace pass
// ---------------------------------------------------------------------------

export interface WarmupPublisher {
  (event: { entityId: string; data: Record<string, unknown> }): Promise<void> | void;
}

export interface WorkspaceWarmupDeps {
  db: Database;
  mailpool: MailpoolClient;
  /** Shared across workspaces within one sweep run. */
  lookup: WarmupLookup;
  env: { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };
  now: Date;
  /** Publishes `reach_mailbox:updated` for a changed mailbox. */
  publish?: WarmupPublisher;
}

/** The mailbox states this pass looks at. */
const LIVE_STATUSES = ['provisioning', 'warming', 'active', 'paused'] as const;

type HostDomainRow = typeof schema.hostDomains.$inferSelect;

/** A WeldHost domain that is no longer usable for sending: gone, not active, or past its expiry. */
function hostLapsed(host: HostDomainRow | undefined, now: Date): boolean {
  if (!host || host.deletedAt) return true;
  if (host.status !== 'active') return true;
  return !!host.expiresAt && host.expiresAt.getTime() <= now.getTime();
}

function isMailpoolNotReady(err: unknown): boolean {
  return err instanceof MailpoolError && err.status === 400;
}

/**
 * One workspace's daily warmup pass. Returns when it next needs a visit, or
 * null when nothing is left to track (the due-index row is then dropped; a
 * create or a WeldHost lapse marks it due again).
 */
export async function processWorkspaceWarmup(deps: WorkspaceWarmupDeps): Promise<Date | null> {
  const { db, now } = deps;

  const mailboxes = await db
    .select()
    .from(schema.reachMailboxes)
    .where(and(isNull(schema.reachMailboxes.deletedAt), inArray(schema.reachMailboxes.status, [...LIVE_STATUSES])));
  if (mailboxes.length === 0) return null;

  const domainIds = [...new Set(mailboxes.map((m) => m.domainId))];
  const domains = await db.select().from(schema.reachDomains).where(inArray(schema.reachDomains.id, domainIds));
  const hostIds = [...new Set(domains.map((d) => d.hostDomainId))];
  const hosts = hostIds.length
    ? await db.select().from(schema.hostDomains).where(inArray(schema.hostDomains.id, hostIds))
    : [];
  const domainById = new Map(domains.map((d) => [d.id, d]));
  const hostById = new Map(hosts.map((h) => [h.id, h]));

  const final: MailboxRow[] = [];
  for (const mailbox of mailboxes) {
    try {
      final.push(await advanceMailbox(deps, mailbox, domainById, hostById));
    } catch (err) {
      // One mailbox's trouble (Mailpool 5xx, a dead warmup) must not stop the rest.
      console.error(`[reach-warmup] mailbox ${mailbox.id} failed:`, err);
      final.push(mailbox);
    }
  }

  return nextVisit(final, domainById, hostById, now);
}

async function advanceMailbox(
  deps: WorkspaceWarmupDeps,
  mailbox: MailboxRow,
  domainById: Map<string, typeof schema.reachDomains.$inferSelect>,
  hostById: Map<string, HostDomainRow>,
): Promise<MailboxRow> {
  const { now } = deps;
  const domain = domainById.get(mailbox.domainId);
  const lapsed = domain ? hostLapsed(hostById.get(domain.hostDomainId), now) : false;

  // WeldHost domain expired or not renewed: stop using its mailboxes.
  if (lapsed && mailbox.status !== 'paused') {
    return save(deps, mailbox, { status: 'paused', pausedReason: 'domain_inactive' });
  }
  if (mailbox.status === 'paused') {
    // Only the pause this pass set resumes by itself, and only once the domain works again.
    if (mailbox.pausedReason !== 'domain_inactive' || lapsed || domain?.status !== 'active') return mailbox;
    return save(deps, mailbox, { status: resumeStatusFor(mailbox), pausedReason: null });
  }

  switch (mailbox.status) {
    case 'provisioning':
      return advanceProvisioning(deps, mailbox);
    case 'warming':
      return advanceWarming(deps, mailbox);
    case 'active':
      return rampMailbox(deps, mailbox);
    default:
      return mailbox;
  }
}

/** Persist a change and tell the platform. */
async function save(
  deps: Pick<WorkspaceWarmupDeps, 'db' | 'now' | 'publish'>,
  mailbox: MailboxRow,
  patch: Partial<typeof schema.reachMailboxes.$inferInsert>,
): Promise<MailboxRow> {
  const [updated] = await deps.db
    .update(schema.reachMailboxes)
    .set({ ...patch, updatedAt: deps.now })
    .where(eq(schema.reachMailboxes.id, mailbox.id))
    .returning();
  const row = updated ?? mailbox;
  const statusChanged = row.status !== mailbox.status;
  if (statusChanged && deps.publish) {
    try {
      await deps.publish({ entityId: row.id, data: omitSensitive('reach_mailboxes', row) });
    } catch (err) {
      console.warn('[reach-warmup] entity event failed:', err);
    }
  }
  return row;
}

/** A mailbox Mailpool was still creating: once it is active there, store its logins and start warming. */
async function advanceProvisioning(deps: WorkspaceWarmupDeps, mailbox: MailboxRow): Promise<MailboxRow> {
  if (!mailbox.mailpoolMailboxId) return mailbox;
  const remote = await deps.mailpool.getMailbox(mailbox.mailpoolMailboxId);

  if (remote.status === 'inactive') {
    return save(deps, mailbox, {
      status: 'error',
      lastError: remote.error?.message ?? 'The mailbox provider disabled this mailbox.',
    });
  }
  if (remote.status !== 'active') return mailbox;
  return beginWarming(deps, mailbox, remote);
}

/**
 * Store missing logins from `remote`, start the warmup at Mailpool and move the
 * mailbox to `warming`. Shared by the sweep and the Mailpool webhook.
 */
export async function beginWarming(
  deps: Pick<WorkspaceWarmupDeps, 'db' | 'env' | 'now' | 'publish' | 'lookup'> & { mailpool: MailpoolClient | null },
  mailbox: MailboxRow,
  remote: MailpoolMailbox | null,
): Promise<MailboxRow> {
  const patch: Partial<typeof schema.reachMailboxes.$inferInsert> = {
    status: 'warming',
    warmupStartedAt: mailbox.warmupStartedAt ?? deps.now,
    pausedReason: null,
    lastError: null,
  };

  if (remote && !mailbox.smtpCredentials) {
    const smtp = smtpCredentialsOf(remote);
    if (smtp) patch.smtpCredentials = await sealMailServerCredentials(deps.env, smtp);
    const imap = imapCredentialsOf(remote);
    if (imap) patch.imapCredentials = await sealMailServerCredentials(deps.env, imap);
  }

  if (deps.mailpool) {
    try {
      const inbox = await ensureWarmupRunning(deps.mailpool, mailbox, deps.lookup);
      if (inbox) patch.warmupStatus = inbox.status;
    } catch (err) {
      // The pass tries again tomorrow; the mailbox is warming from our side regardless.
      console.warn(`[reach-warmup] could not start warmup for ${mailbox.email}:`, err);
    }
  }

  return save(deps, mailbox, patch);
}

async function advanceWarming(deps: WorkspaceWarmupDeps, mailbox: MailboxRow): Promise<MailboxRow> {
  if (!mailbox.mailpoolMailboxId) return mailbox;

  const inbox = await ensureWarmupRunning(deps.mailpool, mailbox, deps.lookup);
  if (!inbox) return mailbox;

  let detail: MailpoolWarmupDetail;
  try {
    detail = await deps.mailpool.getWarmup(inbox.id);
  } catch (err) {
    // 400 = still connecting to the warmup network.
    if (isMailpoolNotReady(err)) return save(deps, mailbox, { warmupStatus: inbox.status });
    throw err;
  }

  const warmupDay = countWarmupDays(detail);
  const done = warmupDay >= WELDREACH_SENDING_DEFAULTS.warmupDays && isWarmupHealthy(detail);
  if (!done) return save(deps, mailbox, { warmupDay, warmupStatus: detail.status });

  return save(deps, mailbox, {
    warmupDay,
    warmupStatus: detail.status,
    status: 'active',
    rampCurrent: Math.min(WELDREACH_SENDING_DEFAULTS.rampStart, mailbox.dailyCap),
    rampUpdatedAt: deps.now,
  });
}

/** Active mailboxes grow their daily cap by `rampStep` once a day, up to `dailyCap`. */
async function rampMailbox(deps: WorkspaceWarmupDeps, mailbox: MailboxRow): Promise<MailboxRow> {
  const cap = mailbox.dailyCap;
  let ramp = mailbox.rampCurrent;

  if (ramp > cap) {
    ramp = cap;
  } else if (ramp < cap && (!mailbox.rampUpdatedAt || mailbox.rampUpdatedAt < utcDayStart(deps.now))) {
    ramp = Math.min(cap, ramp + WELDREACH_SENDING_DEFAULTS.rampStep);
  }
  if (ramp === mailbox.rampCurrent) return mailbox;
  return save(deps, mailbox, { rampCurrent: ramp, rampUpdatedAt: deps.now });
}

/**
 * When this workspace next needs a visit: tomorrow while a mailbox is still
 * warming, ramping, or waiting for its domain to come back; otherwise the
 * earliest expiry of a domain in use, so a lapse is noticed without waking the
 * tenant every day. null when nothing needs watching.
 */
function nextVisit(
  mailboxes: MailboxRow[],
  domainById: Map<string, typeof schema.reachDomains.$inferSelect>,
  hostById: Map<string, HostDomainRow>,
  now: Date,
): Date | null {
  const tomorrow = utcTomorrow(now);
  let next: Date | null = null;
  const consider = (at: Date) => {
    if (!next || at.getTime() < next.getTime()) next = at;
  };

  for (const m of mailboxes) {
    const progressing =
      m.status === 'provisioning' ||
      m.status === 'warming' ||
      (m.status === 'active' && m.rampCurrent < m.dailyCap) ||
      (m.status === 'paused' && m.pausedReason === 'domain_inactive');
    if (progressing) consider(tomorrow);

    if (m.status === 'active' || m.status === 'warming' || m.status === 'provisioning') {
      const domain = domainById.get(m.domainId);
      const expiresAt = domain ? hostById.get(domain.hostDomainId)?.expiresAt : null;
      if (expiresAt && expiresAt.getTime() > now.getTime()) consider(expiresAt);
    }
  }
  return next;
}
